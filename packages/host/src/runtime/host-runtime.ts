import { isAbsolute, join, relative, resolve } from "node:path";
import {
  asSessionId,
  createContextItemId,
  createSessionId,
  createRun,
  type InteractionChannel,
  type ContentPart,
  type ContextItem,
  type EventEmitter,
  type RunId,
  type WorkflowHook,
} from "@sparkwright/core";
import { prepareSkillsForRun } from "@sparkwright/skills";
import {
  createLazyMcpToolsForRun,
  prepareMcpToolsForRun,
  type McpServerConfig,
} from "@sparkwright/mcp-adapter";
import {
  type WorkflowControlCommand,
  type WorkflowControlSourceIdentity,
  FileWorkflowStore,
  type WorkflowLeaseBoundWriter,
  type ActorInbox,
  type WorkflowRunId,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
} from "@sparkwright/agent-runtime";
import { RECOMMENDED_FOREGROUND_TIMEOUT_MS } from "@sparkwright/shell-tool";
import { type ExecutionHandle } from "@sparkwright/server-runtime";
import type { HostExecutionMessage, HostRuntimeOptions } from "./contracts.js";
import {
  capabilitySnapshotAgentProfiles,
  createSkillPreprocessOptions,
  inlineShellCapabilitySummary,
  modelCapabilitySummary,
  workflowCapabilitySummary,
} from "./capability-assembly.js";
import { CapabilityRuntimeOperations } from "./capability-runtime-operations.js";
import {
  TaskRuntimeOperations,
  type JoinRuntimeTaskResult,
  type ListRuntimeTasksInput,
  type PromoteRuntimeTaskResult,
  type ReadRuntimeTaskOutputResult,
  type StopRuntimeTaskResult,
} from "./task-runtime-operations.js";
import {
  WorkflowRuntimeOperations,
  type WorkflowControlExecutionPort,
} from "./workflow-runtime-operations.js";
import {
  WorkflowEpisodeRuntime,
  type WorkflowEpisodeEnvironment,
} from "./workflow-episode-runtime.js";
import { AgentRuntimeAssembly } from "./agent-runtime-assembly.js";
export type { RuntimeOptions } from "./contracts.js";
import { type ResolvedShellSandboxConfig } from "@sparkwright/shell-sandbox";
import type {
  CapabilityVerificationConfig,
  CapabilityWorkflowHookConfig,
} from "../config-zod-schema.js";
import { loadCheckpointFromRunDir } from "@sparkwright/core/internal";
import {
  isTraceLevel,
  type TraceLevel,
  type ProtocolError,
  type CapabilityInspectRequestPayload,
  type RunResumeRequestPayload,
  type RunStartRequestPayload,
  type WorkflowListRequestPayload,
  type WorkflowResumeRequestPayload,
  type WorkflowRunSnapshot,
  type RunInputPart,
  type SessionCompactionInspectReport,
  type TaskRecordSnapshot,
  type CapabilitySnapshot,
} from "@sparkwright/protocol";
import { loadHostConfig } from "../config/config-implementation.js";
import type { CapabilityMcpConfig } from "../config/contracts.js";
import { MAIN_AGENT_ID } from "../agent-constants.js";
import {
  buildAccessMetadata,
  resolveRunAccessFields,
  type ResolvedRunAccess,
} from "../run-access.js";
import { prepareHostRunSecurityPlan } from "../run-security-plan.js";
import { createHostRunPolicy } from "../run-policy.js";
import { existingSkillRoots } from "../skill-roots.js";
import { nextMessageId, nowIso } from "../connection.js";
import {
  HostExecution,
  type HostExecutionActiveRun,
} from "../host-execution.js";
import { resolveExecutionPlan } from "../execution-plan.js";
import { createExecutionResources } from "../execution-resources.js";
import {
  findHostRunDirectory,
  forkHostSession,
  inspectHostSession,
  inspectHostSessionCompaction,
  listHostSessions,
  loadHostSessionConversation,
  sessionRootDirFor,
  type SessionInspectOptions,
} from "../session-queries.js";
import {
  compactHostSession,
  type SessionCompactResult,
} from "../session-compaction.js";
export { sessionPreviewFromTranscriptLine } from "../session-queries.js";
import { createModel } from "../model-factory.js";
import {
  catalogToolDefinitions,
  createMainHostToolCatalog,
  type HostToolCatalogEntry,
} from "../tool-catalog.js";
export { createDelegateAgentTool } from "../indexed-delegate-tool.js";
import { createSkillUsageRecorder } from "../skill-usage.js";
import {
  createConfiguredWorkflowHooks,
  createPartialSubagentFinalityDisclosureHook,
  type CreateConfiguredWorkflowHooksOptions,
} from "../workflow-hooks.js";
import { createVerificationWorkflowHooks } from "../verification.js";
import { createDocumentedCommandWorkflowHooks } from "../documented-command-check.js";
import {
  describeActiveEventRules,
  describeActiveWorkflowRules,
} from "../active-rules.js";
import { loadLayeredWorkflowAssets } from "../workflows.js";
import { createWorkflowProjectionHooks } from "../workflow-projection.js";
import { admitToolsForAgentProfile } from "../tool-surface.js";

/**
 * Skills flagged `metadata.devOnly: true` (test/development fixtures) are kept
 * out of run candidate sets unless `SPARKWRIGHT_DEV_SKILLS` is explicitly
 * enabled. This stops smoke-test skills from mis-triggering in real sessions.
 */
function devSkillsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SPARKWRIGHT_DEV_SKILLS;
  return value === "1" || value === "true";
}

type RuntimeMcpConfig = Omit<CapabilityMcpConfig, "servers"> & {
  servers?: McpServerConfig[];
};

function mergeRuntimeMcpConfig(
  config: CapabilityMcpConfig | undefined,
  extraServers: readonly McpServerConfig[] | undefined,
): RuntimeMcpConfig | undefined {
  const hasExtraServers = (extraServers?.length ?? 0) > 0;
  const servers = [
    ...((config?.servers ?? []) as McpServerConfig[]),
    ...(extraServers ?? []),
  ];
  if (!config && servers.length === 0) return undefined;
  return {
    ...(config ?? {}),
    ...(config?.startup
      ? {}
      : hasExtraServers
        ? { startup: "prepare" as const }
        : {}),
    ...(servers.length > 0 ? { servers } : {}),
  };
}

function mcpStartupMode(
  config: RuntimeMcpConfig | undefined,
): "lazy" | "prepare" | "eager" {
  return config?.startup ?? "lazy";
}

function mcpToolSchemaLoad(
  config: RuntimeMcpConfig,
): NonNullable<RuntimeMcpConfig["toolSchemaLoad"]> {
  return (
    config.toolSchemaLoad ?? (config.startup === "eager" ? "eager" : "defer")
  );
}

async function createRuntimeMcpTools(input: {
  config: RuntimeMcpConfig | undefined;
  workspaceRoot: string;
  emitter?: EventEmitter;
  agentId?: string;
  shellSandbox?: ResolvedShellSandboxConfig;
}): Promise<PreparedMcp | null> {
  const config = input.config;
  if (!config?.servers?.length) return null;
  const common = {
    servers: config.servers,
    defaultTimeoutMs: config.defaultTimeoutMs,
    namePrefix: config.namePrefix,
    toolSchemaLoad: mcpToolSchemaLoad(config),
    policy: config.defaultPolicy,
    emitter: input.emitter,
    agentId: input.agentId,
    shellSandbox: input.shellSandbox,
  };
  const startup = mcpStartupMode(config);
  const prepared =
    startup === "lazy"
      ? createLazyMcpToolsForRun(common)
      : await prepareMcpToolsForRun(common);
  return prepared;
}

function configuredMcpWorkspaceCwdServers(
  config: RuntimeMcpConfig | undefined,
  workspaceRoot: string,
): string[] {
  if (!config?.servers?.length) return [];
  return config.servers
    .filter((server) => {
      if (server.type !== "stdio" || server.enabled === false || !server.cwd) {
        return false;
      }
      const cwd = isAbsolute(server.cwd)
        ? server.cwd
        : resolve(workspaceRoot, server.cwd);
      return isSameOrInsidePath(workspaceRoot, cwd);
    })
    .map((server) => server.name);
}

function isSameOrInsidePath(parent: string, candidate: string): boolean {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  const rel = relative(parentPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function requireActiveRunId(value: string | null): RunId {
  if (!value) {
    throw new Error("Task tool invoked before a run id was assigned.");
  }
  return value as RunId;
}

type PreparedSkills = Awaited<ReturnType<typeof prepareSkillsForRun>>;
type PreparedMcp = Awaited<ReturnType<typeof prepareMcpToolsForRun>>;

interface PreparedHostRunEnvironment extends WorkflowEpisodeEnvironment {
  preparedSkills: PreparedSkills | null;
  preparedMcp: PreparedMcp | null;
  toolCatalog: HostToolCatalogEntry[];
  workflowProjection?: ReturnType<typeof createWorkflowProjectionHooks>;
}

export interface RuntimeWorkflowHookAssemblyOptions extends Omit<
  CreateConfiguredWorkflowHooksOptions,
  "hooks"
> {
  workflowHooks?: CapabilityWorkflowHookConfig[];
  workflowActive?: boolean;
  projectionHooks?: WorkflowHook[];
  verification?: CapabilityVerificationConfig;
  documentedCommand: {
    goal: string;
    shouldWrite: boolean;
  };
}

export function assembleRuntimeWorkflowHooks(
  options: RuntimeWorkflowHookAssemblyOptions,
): WorkflowHook[] {
  const verificationHooks = createVerificationWorkflowHooks({
    ...options,
    verification: options.verification,
  });
  const documentedCommandHooks = createDocumentedCommandWorkflowHooks({
    ...options,
    workspaceRoot: options.workspaceRoot,
    goal: options.documentedCommand.goal,
    shouldWrite: options.documentedCommand.shouldWrite,
  });
  const projectionHooks = options.projectionHooks ?? [];
  const workflowActive =
    options.workflowActive === true || projectionHooks.length > 0;
  return [
    ...createConfiguredWorkflowHooks({
      ...options,
      hooks: options.workflowHooks,
      workflowActive,
    }),
    ...verificationHooks,
    ...documentedCommandHooks,
    ...projectionHooks,
    createPartialSubagentFinalityDisclosureHook(),
  ];
}

/**
 * Strip the decorations the context builder wraps around a user goal: the
 * `<env>…</env>` preamble block and the leading `User request:` label (see
 * `packages/core/src/context.ts`). Collapses whitespace so the result is a clean
 * single-line preview.
 */
function inputPartsFromPayload(
  parts: readonly RunInputPart[] | undefined,
): ContentPart[] {
  if (!parts || parts.length === 0) return [];
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.length > 0) {
        out.push({
          type: "text",
          text: part.text,
          ...(part.metadata ? { metadata: part.metadata } : {}),
        });
      }
      continue;
    }
    if (!part.data && !part.uri) continue;
    out.push({
      type: part.type,
      ...(part.data ? { data: part.data } : {}),
      ...(part.uri ? { uri: part.uri } : {}),
      ...(part.mediaType ? { mediaType: part.mediaType } : {}),
      ...(part.name ? { name: part.name } : {}),
      ...(part.metadata ? { metadata: part.metadata } : {}),
    });
  }
  return out;
}

function userInputContextItem(input: {
  content: string;
  parts: ContentPart[];
  source: "run.start" | "run.inject_message";
  metadata?: Record<string, unknown>;
}): ContextItem | undefined {
  if (input.parts.length === 0) return undefined;
  const imageCount = input.parts.filter((part) => part.type === "image").length;
  return {
    id: createContextItemId(),
    type: "user",
    source: { kind: "user_input", uri: input.source },
    content: input.content,
    parts: input.parts,
    metadata: {
      layer: "runtime",
      stability: "turn",
      multimodal: true,
      attachmentCount: input.parts.length,
      ...(imageCount > 0 ? { imageCount } : {}),
      ...(input.metadata ?? {}),
    },
  };
}

/**
 * Derive a human-readable session-browser preview from the first transcript
 * line. That line is the opening `prompt` event whose `messages` carry the
 * `<env>` preamble (message 0) and the user goal as `User request:\n<goal>`
 * (last user message). We surface the goal. Falls back to a top-level `content`
 * string, then the raw line, for other/legacy shapes.
 */
function extractSkillSourcePath(message: string): string | undefined {
  return message.match(/(?:^|\s)(\/[^\n:]+SKILL\.md)\b/)?.[1];
}

function resolveTraceLevel(input: {
  traceLevel?: TraceLevel;
  metadata?: Record<string, unknown>;
  defaultTraceLevel?: TraceLevel;
}): TraceLevel {
  return (
    input.traceLevel ??
    (isTraceLevel(input.metadata?.traceLevel)
      ? input.metadata.traceLevel
      : (input.defaultTraceLevel ?? "standard"))
  );
}

/** One HostExecution attachment composed by the process HostService. */
export class HostRuntime {
  private opts: HostRuntimeOptions;
  private readonly tasks: TaskRuntimeOperations;
  private readonly workflows: WorkflowRuntimeOperations;
  private readonly workflowEpisodes: WorkflowEpisodeRuntime;
  private readonly agents: AgentRuntimeAssembly;
  private readonly capabilities: CapabilityRuntimeOperations;
  private currentExecution: HostExecution | null = null;
  // One abort for the complete interactive execution, including assembly and
  // every todo/workflow episode. Core run cancellation remains run-scoped.

  /** @internal Construct through HostService.createRuntime(). */
  constructor(opts: HostRuntimeOptions) {
    this.opts = {
      ...opts,
      workspaceRoot: resolve(opts.workspaceRoot),
      ...(opts.sessionRootDir
        ? { sessionRootDir: resolve(opts.sessionRootDir) }
        : {}),
    };
    const context = opts.workspaceContext;
    this.tasks = new TaskRuntimeOperations({
      workspaceRoot: this.opts.workspaceRoot,
      manager: context.taskManager,
      notifications: context.taskNotifications,
    });
    this.workflows = new WorkflowRuntimeOperations({
      workspaceRoot: this.opts.workspaceRoot,
      notifications: context.workflowNotifications,
      controls: context.workflowControls,
      dispatcher: context.workflowControlDispatcher,
    });
    this.workflowEpisodes = new WorkflowEpisodeRuntime({
      workflows: this.workflows,
      tasks: this.tasks,
      emit: this.opts.emit,
      releaseExecution: (execution) => {
        if (this.currentExecution === execution) this.currentExecution = null;
      },
    });
    this.agents = new AgentRuntimeAssembly({
      taskManager: this.tasks.manager,
      workspaceLeaseCoordinator: this.opts.workspaceLeaseCoordinator,
    });
    this.capabilities = new CapabilityRuntimeOperations({
      workspaceRoot: this.opts.workspaceRoot,
      sessionRootDir: sessionRootDirFor(this.opts),
      taskManager: this.tasks.manager,
      taskRootDir: this.tasks.rootDir,
      defaultModel: this.opts.defaultModel,
      defaultAccessMode: this.opts.defaultAccessMode,
      accessModeCeiling: this.opts.accessModeCeiling,
      defaultBackgroundTasks: this.opts.defaultBackgroundTasks,
      backgroundTasksCeiling: this.opts.backgroundTasksCeiling,
      emit: this.opts.emit,
      includeDevSkills: devSkillsEnabled,
      prepareMcp: async ({ config, shellSandbox }) => {
        const runtimeConfig = mergeRuntimeMcpConfig(
          config,
          this.opts.extraMcpServers,
        );
        return {
          servers: runtimeConfig?.servers ?? [],
          prepared: await createRuntimeMcpTools({
            config: runtimeConfig,
            workspaceRoot: this.opts.workspaceRoot,
            shellSandbox,
          }),
        };
      },
    });
  }

  hasActiveRun(): boolean {
    return this.currentExecution?.activeRun != null;
  }

  /** @internal HostService lookup without mirroring execution truth. */
  executionIdentity():
    | {
        executionId: string;
        sessionId?: string;
        currentRunId?: string;
        runIds: readonly string[];
      }
    | undefined {
    const execution = this.currentExecution;
    return execution
      ? {
          executionId: execution.executionId,
          ...(execution.sessionId ? { sessionId: execution.sessionId } : {}),
          ...(execution.currentRunId()
            ? { currentRunId: execution.currentRunId() }
            : {}),
          runIds: execution.runIdAliases(),
        }
      : undefined;
  }

  /** @internal Canonical lane scope used by the process HostService. */
  executionLaneKey(sessionId: string): string {
    return `${sessionRootDirFor(this.opts)}\0${sessionId}`;
  }

  executionDriverHandle(
    executionId: string,
  ): ExecutionHandle<HostExecutionMessage, unknown> | undefined {
    const execution = this.currentExecution;
    if (
      !execution ||
      execution.executionId !== executionId ||
      !execution.rootRunId
    ) {
      return undefined;
    }
    return {
      rootRunId: execution.rootRunId,
      currentRunId: () => execution.currentRunId() ?? execution.rootRunId!,
      tryInject: (message) =>
        this.acceptExecutionMessage(message.runId, message).ok
          ? "accepted"
          : "closed",
      cancel: (reason) => {
        execution.cancel(reason);
      },
      completion: execution.completion,
    };
  }

  private get active(): HostExecutionActiveRun | null {
    return this.currentExecution?.activeRun ?? null;
  }

  private set active(value: HostExecutionActiveRun | null) {
    if (value) {
      if (!this.currentExecution) this.currentExecution = new HostExecution();
      this.currentExecution.attachRun(value);
    } else {
      this.currentExecution?.detachRun();
    }
  }

  private beginExecution(
    abortController?: AbortController,
    executionId?: string,
  ): HostExecution {
    const execution = new HostExecution({ abortController, executionId });
    this.currentExecution = execution;
    return execution;
  }

  private releaseUnstartedExecution(execution: HostExecution): void {
    if (this.currentExecution !== execution || execution.activeRun) return;
    execution.finish(
      execution.abortController.signal.aborted ? "cancelled" : "failed",
    );
    this.currentExecution = null;
  }

  listTasks(input: ListRuntimeTasksInput): {
    ok: true;
    tasks: TaskRecordSnapshot[];
  } {
    return this.tasks.list(input);
  }

  getTask(
    taskId: string,
  ):
    | { ok: true; task: TaskRecordSnapshot }
    | { ok: false; error: ProtocolError } {
    return this.tasks.get(taskId);
  }

  async readTaskOutput(input: {
    taskId: string;
    fromSequence?: number;
    maxChunks?: number;
  }): Promise<ReadRuntimeTaskOutputResult> {
    return await this.tasks.readOutput(input);
  }

  async stopTask(taskId: string): Promise<StopRuntimeTaskResult> {
    return await this.tasks.stop(taskId);
  }

  async joinTask(taskId: string): Promise<JoinRuntimeTaskResult> {
    return await this.tasks.join(taskId);
  }

  async promoteTask(taskId: string): Promise<PromoteRuntimeTaskResult> {
    return await this.tasks.promote(taskId);
  }

  async inspectCapabilities(
    input: CapabilityInspectRequestPayload & { modelRef?: string } = {},
  ): Promise<
    | { ok: true; snapshot: CapabilitySnapshot }
    | { ok: false; error: ProtocolError }
  > {
    return await this.capabilities.inspect(input);
  }

  /**
   * Start a new run. Returns the runId synchronously (after createRun
   * resolves) and continues streaming events asynchronously.
   */
  async startRun(payload: RunStartRequestPayload): Promise<
    | {
        ok: true;
        runId: string;
        sessionId: string;
        workflowRunId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    return this.opts.executionCoordinator.startRun(this, payload);
  }

  /** @internal Driven only after HostService lane admission. */
  async startExecution(
    payload: RunStartRequestPayload,
    executionId?: string,
  ): Promise<
    | {
        ok: true;
        runId: string;
        sessionId: string;
        workflowRunId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    if (this.currentExecution) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: "another run is already active on this connection",
        },
      };
    }
    const executionAbort = new AbortController();
    const execution = this.beginExecution(executionAbort, executionId);
    try {
      return await this.startRunInner(payload);
    } finally {
      this.releaseUnstartedExecution(execution);
    }
  }

  /**
   * Service-owned fresh workflow start with a caller-fixed durable identity.
   * This is not exposed by the Host protocol: Package F derives the id from an
   * immutable handoff so crash recovery and competing carriers cannot create
   * two workflow records for one accepted request.
   */
  async startDetachedWorkflowRun(
    payload: RunStartRequestPayload,
    workflowRunId: WorkflowRunId,
  ): Promise<
    | {
        ok: true;
        runId: string;
        sessionId: string;
        workflowRunId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    if (!payload.workflow) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: "detached service start requires a workflow asset",
        },
      };
    }
    if (this.currentExecution) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: "another run is already active on this service adapter",
        },
      };
    }
    const execution = this.beginExecution();
    try {
      return await this.startRunInner(payload, workflowRunId);
    } finally {
      this.releaseUnstartedExecution(execution);
    }
  }

  async resumeRun(
    payload: RunResumeRequestPayload,
  ): Promise<
    | { ok: true; runId: string; resumedFromRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    return this.opts.executionCoordinator.resumeRun(this, payload);
  }

  /** @internal Resolve the persisted session before HostService chooses a lane. */
  async resolveResumeSession(
    payload: RunResumeRequestPayload,
  ): Promise<
    { ok: true; sessionId: string } | { ok: false; error: ProtocolError }
  > {
    const located = await findHostRunDirectory(
      this.opts,
      payload.runId,
      payload.sessionId,
    );
    if (!located.ok) return located;
    return { ok: true, sessionId: located.sessionId ?? createSessionId() };
  }

  /** @internal Driven only after HostService lane admission. */
  async resumeExecution(
    payload: RunResumeRequestPayload,
    executionId?: string,
    resolvedSessionId?: string,
  ): Promise<
    | { ok: true; runId: string; resumedFromRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    if (this.currentExecution) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: "another run is already active on this connection",
        },
      };
    }
    const executionAbort = new AbortController();
    const execution = this.beginExecution(executionAbort, executionId);
    try {
      return await this.resumeRunInner(payload, resolvedSessionId);
    } finally {
      this.releaseUnstartedExecution(execution);
    }
  }

  async listWorkflowRuns(payload: WorkflowListRequestPayload = {}): Promise<
    | {
        ok: true;
        workflows: WorkflowRunSnapshot[];
        invalidEntries?: Array<{ path: string; code: string; reason: string }>;
      }
    | { ok: false; error: ProtocolError }
  > {
    return this.workflows.list(payload);
  }

  private workflowControlExecutionPort(): WorkflowControlExecutionPort {
    return {
      hasExecution: () => this.currentExecution !== null,
      processActiveControls: async (workflowRunId) => {
        const active = this.currentExecution?.activeRun;
        if (
          active?.workflowRunId === workflowRunId &&
          active.processWorkflowControls
        ) {
          await active.processWorkflowControls();
        }
      },
      resume: async (payload) => {
        if (this.currentExecution) {
          return {
            ok: false,
            error: {
              code: "internal_error",
              message: "another run is already active on this connection",
            },
          };
        }
        const execution = this.beginExecution();
        try {
          return await this.resumeWorkflowRunInner(payload);
        } finally {
          this.releaseUnstartedExecution(execution);
        }
      },
    };
  }

  workflowActorInbox(): ActorInbox {
    return this.workflows.actorInbox();
  }

  async controlWorkflow(input: {
    workflowRunId: string;
    sessionId?: string;
    commandId?: string;
    idempotencyKey: string;
    source: WorkflowControlSourceIdentity;
    expected?: {
      generation?: number;
      status?: WorkflowRunStatus;
      waitId?: string;
    };
    command: WorkflowControlCommand;
  }): Promise<
    | {
        ok: true;
        status: string;
        commandId: string;
        code?: string;
        runId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    return this.workflows.control(input, this.workflowControlExecutionPort());
  }

  async processAcceptedWorkflowControl(
    envelope: Parameters<
      WorkflowRuntimeOperations["processAcceptedControl"]
    >[0],
  ): Promise<
    | {
        ok: true;
        status: string;
        commandId: string;
        code?: string;
        runId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    return this.workflows.processAcceptedControl(
      envelope,
      this.workflowControlExecutionPort(),
    );
  }

  async processWorkflowControlCommand(input: {
    workflowRunId: string;
    sessionId?: string;
    commandId: string;
  }): Promise<
    | {
        ok: true;
        status: string;
        commandId: string;
        code?: string;
        runId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    return this.workflows.processControlCommand(
      input,
      this.workflowControlExecutionPort(),
    );
  }

  async resumeWorkflowRun(
    payload: WorkflowResumeRequestPayload,
    source: WorkflowControlSourceIdentity,
  ): Promise<
    | { ok: true; runId: string; workflowRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    if (this.currentExecution) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: "another run is already active on this connection",
        },
      };
    }
    const execution = this.beginExecution();
    try {
      return await this.workflows.resumeThroughControl(
        payload,
        source,
        (resumePayload) => this.resumeWorkflowRunInner(resumePayload),
      );
    } finally {
      this.releaseUnstartedExecution(execution);
    }
  }

  async resumeClaimedWorkflowRun(
    payload: WorkflowResumeRequestPayload,
    writer: WorkflowLeaseBoundWriter,
  ): Promise<
    | { ok: true; runId: string; workflowRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    const claimed = this.workflows.validateClaimedWriter(payload, writer);
    if (!claimed.ok) return claimed;
    if (this.currentExecution) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: "another run is already active on this connection",
        },
      };
    }
    const execution = this.beginExecution();
    try {
      return await this.resumeWorkflowRunInner(payload, writer);
    } finally {
      this.releaseUnstartedExecution(execution);
    }
  }

  private async prepareHostRunEnvironment(input: {
    goal: string;
    modelRef?: string;
    access: ResolvedRunAccess;
    sessionId: string;
    targetPath?: string;
    confidentialPaths?: readonly string[];
    confidentialDefaults?: boolean;
    traceLevel?: TraceLevel;
    workflowName?: string;
    workflowRunId?: WorkflowRunId;
    controlSessionId?: string;
    workflowStore?: FileWorkflowStore;
    workflowRecord?: WorkflowRunRecord;
    workflowLease?: WorkflowLeaseBoundWriter;
    workflowWaitingInputMetadata?: Record<string, unknown>;
    runMetadata?: Record<string, unknown>;
    runStoreMetadata?: Record<string, unknown>;
  }): Promise<
    | { ok: true; env: PreparedHostRunEnvironment }
    | { ok: false; error: ProtocolError }
  > {
    const plan = resolveExecutionPlan({
      workspaceRoot: this.opts.workspaceRoot,
      sessionRootDir: this.opts.sessionRootDir,
      sessionId: input.sessionId,
      goal: input.goal,
      modelRef: input.modelRef,
      targetPath: input.targetPath,
      traceLevel: input.traceLevel,
      access: input.access,
    });
    const model = await createModel({
      modelRef: plan.modelRef,
      goal: plan.goal,
      workspaceRoot: plan.workspaceRoot,
      targetPath: plan.targetPath,
    });
    if (!model.ok) {
      return {
        ok: false,
        error: { code: "invalid_payload", message: model.message },
      };
    }

    const workspaceRoot = plan.workspaceRoot;
    const workspaceLeaseCoordinator = this.opts.workspaceLeaseCoordinator;
    const resources = createExecutionResources(plan);
    const { workspace, trace, pendingExtensionEvents } = resources;
    const sessionRootDir = plan.sessionRootDir;
    const skillUsageRecorder = createSkillUsageRecorder(workspaceRoot);
    const runIdHolder: { value: string | null } = { value: null };
    const interactionChannel = this.createInteractionChannel(runIdHolder);
    const loadedConfig = await loadHostConfig(workspaceRoot);
    const baseToolConfig = loadedConfig.config.tools;
    const shellConfig = loadedConfig.config.shell;
    const hookConfig = loadedConfig.config.capabilities?.hooks;
    const skillConfig = loadedConfig.config.capabilities?.skills;
    const mcpConfig = mergeRuntimeMcpConfig(
      loadedConfig.config.capabilities?.mcp,
      this.opts.extraMcpServers,
    );
    const agentConfig = loadedConfig.config.capabilities?.agents;
    const writeGuardrails = loadedConfig.config.write;
    const securityPlan = await prepareHostRunSecurityPlan({
      workspaceRoot,
      access: input.access,
      loadedConfig,
      requestConfidentialPaths: input.confidentialPaths,
      requestConfidentialDefaults: input.confidentialDefaults,
    });
    const runAccess = securityPlan.access;
    const confidentialPaths = securityPlan.confidentialPaths;
    const confidentialDefaults = securityPlan.confidentialDefaults;
    const skillRoots = securityPlan.skillRoots;
    const shellSandbox = securityPlan.shellSandboxStatus;
    const mcpShellSandbox = securityPlan.shellSandbox;
    const skillPreprocess = createSkillPreprocessOptions({
      skillConfig,
      emitter: pendingExtensionEvents,
      sandbox: mcpShellSandbox,
      workspaceRoot,
    });
    const existingPreparedSkillRoots = await existingSkillRoots(skillRoots);
    let preparedSkills: PreparedSkills | null = null;
    try {
      preparedSkills = existingPreparedSkillRoots.length
        ? await prepareSkillsForRun({
            goal: input.goal,
            skillRoots: existingPreparedSkillRoots,
            agent: {
              allowedSkills: skillConfig?.allowedSkills,
              deniedSkills: skillConfig?.deniedSkills,
            },
            // Default to on-demand loading: expose the skill_load tool and let
            // the model pull bodies it judges relevant, rather than auto-residing
            // matcher-selected skills (which both pollutes context and double-
            // injects when the loader tool is also on). A config can opt back into
            // auto-resident by setting loadSelectedSkills: true.
            includeLoaderTool: skillConfig?.includeLoaderTool ?? true,
            loadSelectedSkills: skillConfig?.loadSelectedSkills ?? false,
            maxSelectedSkills: skillConfig?.maxSelectedSkills,
            resourceFileLimit: skillConfig?.resourceFileLimit,
            includeDevSkills: devSkillsEnabled(),
            emitter: pendingExtensionEvents,
            agentId: MAIN_AGENT_ID,
            preprocess: skillPreprocess,
          })
        : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.capabilities.recordIndexFailure({
        goal: input.goal,
        sessionId: input.sessionId,
        traceLevel: input.traceLevel ?? "standard",
        message,
        source: extractSkillSourcePath(message),
        targetPath: input.targetPath,
        metadata: input.runStoreMetadata ?? input.runMetadata ?? {},
      });
      return {
        ok: false,
        error: { code: "internal_error", message },
      };
    }
    const parentRunRef: { current?: ReturnType<typeof createRun> } = {};
    const mcpEventEmitter: EventEmitter = {
      emit<TPayload>(
        type: Parameters<EventEmitter["emit"]>[0],
        payload: TPayload,
        metadata?: Record<string, unknown>,
      ) {
        return (parentRunRef.current?.events ?? pendingExtensionEvents).emit(
          type,
          payload,
          metadata,
        );
      },
    };
    const preparedMcp = await createRuntimeMcpTools({
      config: mcpConfig,
      workspaceRoot,
      emitter: mcpEventEmitter,
      agentId: MAIN_AGENT_ID,
      shellSandbox: mcpShellSandbox,
    });
    const traceLevel =
      input.traceLevel ?? loadedConfig.config.traceLevel ?? "standard";
    const parentRunPolicy = createHostRunPolicy({
      permissionMode: runAccess.permissionMode,
      shouldWrite: runAccess.shouldWrite,
      targetPath: input.targetPath,
      confidentialPaths,
      confidentialDefaults,
      writeGuardrails,
    });
    const sessionStore = resources.sessionStore;
    const agentRuntime = await this.agents.prepareRun({
      goal: input.goal,
      workspaceRoot,
      ...(input.targetPath ? { targetPath: input.targetPath } : {}),
      sessionId: input.sessionId,
      sessionRootDir,
      sessionStore,
      traceLevel,
      baseToolConfig,
      ...(agentConfig ? { agentConfig } : {}),
      ...(loadedConfig.config.runBudget
        ? { runBudget: loadedConfig.config.runBudget }
        : {}),
      ...(loadedConfig.config.maxSteps !== undefined
        ? { maxSteps: loadedConfig.config.maxSteps }
        : {}),
      ...(shellConfig ? { shell: shellConfig } : {}),
      ...(hookConfig?.http ? { hookHttp: hookConfig.http } : {}),
      skillRoots: skillRoots.map((root) => root.root),
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
      pendingEvents: pendingExtensionEvents,
      parentRunRef,
      parentModel: model.adapter,
      parentModelRef: model.resolved.modelRef,
      parentRunPolicy,
      interactionChannel,
      allowReadWriteWorkspaceAccess: runAccess.shouldWrite,
      backgroundTasks: runAccess.backgroundTasks,
    });
    const {
      mainAgent,
      derivedAgents,
      toolConfig,
      delegateTools,
      delegateAgentTool,
      delegateParallelTool,
      dynamicSpawnTool,
    } = agentRuntime;
    const resolvedProfiles = agentRuntime.resolvedProfiles;
    const delegateDescriptors = agentRuntime.delegateDescriptors;
    const baseMainToolCatalog = createMainHostToolCatalog({
      workspaceRoot,
      skillRoots: [...skillRoots],
      toolConfig,
      taskManager: this.tasks.manager,
      taskRunners: {
        agent: agentRuntime.taskRunner,
      },
      getParentRunId: () => requireActiveRunId(runIdHolder.value),
      getRunEvents: () => parentRunRef.current?.events,
      todoPath: join(sessionRootDir, input.sessionId, "todo.md"),
      preparedSkills,
      preparedMcp,
      delegateTools,
      delegateAgentTool,
      delegateParallelTool,
      dynamicSpawnTool,
      shell: shellConfig,
      backgroundTasks: runAccess.backgroundTasks,
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
      workspaceLeaseCoordinator,
    });
    const toolCatalog = admitToolsForAgentProfile(
      baseMainToolCatalog,
      mainAgent,
      (entry) => entry.definition,
      (entry, definition) => ({ ...entry, definition }),
    );
    const tools = catalogToolDefinitions(toolCatalog);
    const admittedDelegateParallelTool = delegateParallelTool
      ? tools.find((tool) => tool.name === delegateParallelTool.name)
      : undefined;
    const workflows = await loadLayeredWorkflowAssets(workspaceRoot);
    const workflowEpisode = await this.workflowEpisodes.prepare({
      goal: input.goal,
      sessionId: input.sessionId,
      sessionRootDir,
      workspaceRoot,
      workflows,
      parentModelRef: model.resolved.modelRef,
      ...(input.workflowName ? { workflowName: input.workflowName } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.controlSessionId
        ? { controlSessionId: input.controlSessionId }
        : {}),
      ...(input.workflowStore ? { workflowStore: input.workflowStore } : {}),
      ...(input.workflowRecord ? { workflowRecord: input.workflowRecord } : {}),
      ...(input.workflowLease ? { workflowLease: input.workflowLease } : {}),
      ...(input.workflowWaitingInputMetadata !== undefined
        ? { workflowWaitingInputMetadata: input.workflowWaitingInputMetadata }
        : {}),
      ...(input.targetPath ? { targetPath: input.targetPath } : {}),
      ...(confidentialPaths ? { confidentialPaths } : {}),
      ...(confidentialDefaults !== undefined ? { confidentialDefaults } : {}),
      access: runAccess,
      ...(input.runMetadata ? { runMetadata: input.runMetadata } : {}),
      ...(shellConfig?.sandbox ? { shellSandbox: shellConfig.sandbox } : {}),
      ...(hookConfig?.http ? { hookHttp: hookConfig.http } : {}),
      skillRoots: skillRoots.map((root) => root.root),
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
      parentRunRef,
      tools,
      ...(delegateAgentTool ? { delegateAgentTool } : {}),
      ...(admittedDelegateParallelTool
        ? { delegateParallelTool: admittedDelegateParallelTool }
        : {}),
    });
    if (!workflowEpisode.ok) return workflowEpisode;
    const workflowModelAdapters =
      workflowEpisode.prepared.workflowModelAdapters;
    const workflowProjection = workflowEpisode.prepared.workflowProjection;
    const workflowStore = workflowEpisode.prepared.workflowStore;
    const workflowRecord = workflowEpisode.prepared.workflowRecord;
    const workflowLease = workflowEpisode.prepared.workflowLease;
    const workflowHooks = assembleRuntimeWorkflowHooks({
      workflowHooks: hookConfig?.workflow,
      workflowActive: workflowProjection !== undefined,
      projectionHooks: workflowProjection?.hooks,
      verification: loadedConfig.config.capabilities?.verification,
      workspaceRoot,
      sandbox: shellConfig?.sandbox,
      http: hookConfig?.http,
      skillRoots: skillRoots.map((root) => root.root),
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
      getRun: () => parentRunRef.current,
      agentTool: delegateAgentTool,
      documentedCommand: {
        goal: input.goal,
        shouldWrite: runAccess.shouldWrite,
      },
    });
    const workflowRules = describeActiveWorkflowRules({
      workflowHooks: hookConfig?.workflow,
      verification: loadedConfig.config.capabilities?.verification,
      documentedCommand: {
        goal: input.goal,
        shouldWrite: runAccess.shouldWrite,
      },
    });
    const eventRules = describeActiveEventRules({
      eventHooks: hookConfig?.events,
    });
    const capabilitySnapshot = this.capabilities.captureRunSnapshot({
      model: modelCapabilitySummary(model.resolved),
      access: input.access,
      toolCatalog,
      indexedSkills: preparedSkills?.indexedSkills ?? [],
      loadedSkills: preparedSkills?.loadedSkills ?? [],
      skillInlineShell: inlineShellCapabilitySummary(
        skillConfig?.inlineShell,
        shellSandbox,
      ),
      mcpStatuses: preparedMcp?.statuses ?? {},
      mcpToolNameMap: preparedMcp?.toolNameMap ?? [],
      agentProfiles: capabilitySnapshotAgentProfiles(
        mainAgent,
        resolvedProfiles,
      ),
      delegateTools: delegateDescriptors,
      shellSandbox,
      shellForegroundTimeoutMs:
        shellConfig?.foregroundTimeoutMs ?? RECOMMENDED_FOREGROUND_TIMEOUT_MS,
      shellPromotionAvailable: runAccess.backgroundTasks === "enabled",
      workflowRules,
      eventRules,
      workflows: workflowCapabilitySummary(workflows),
    });

    const mcpWorkspaceCwdServers = configuredMcpWorkspaceCwdServers(
      mcpConfig,
      workspaceRoot,
    );
    const runMetadata: Record<string, unknown> = {
      source: "host",
      ...(input.runMetadata ?? {}),
      sessionId: input.sessionId,
      workspaceRoot,
      permissionMode: runAccess.permissionMode,
      traceLevel,
      ...(mcpWorkspaceCwdServers.length > 0 ? { mcpWorkspaceCwdServers } : {}),
      ...(input.modelRef ? { requestedModel: input.modelRef } : {}),
      ...(workflowRecord && workflowProjection
        ? {
            workflow: {
              workflowRunId: workflowRecord.id,
              assetName: workflowRecord.assetName,
              version: workflowRecord.version,
              packageHash: workflowRecord.packageHash,
              packageHashPolicyVersion: workflowRecord.packageHashPolicyVersion,
              verifyOnResume: workflowRecord.resume.verifyOnResume,
            },
          }
        : {}),
      resolvedModel: model.resolved,
      capabilitySnapshot: this.capabilities.summarize(capabilitySnapshot),
    };
    const runStoreMetadata: Record<string, unknown> = {
      ...runMetadata,
      ...(input.runStoreMetadata ?? {}),
      ...(preparedSkills
        ? {
            indexedSkills: preparedSkills.indexedSkills,
            loadedSkills: preparedSkills.loadedSkills,
          }
        : {}),
      ...(preparedMcp
        ? {
            mcpStatuses: preparedMcp.statuses,
            mcpToolNameMap: preparedMcp.toolNameMap,
          }
        : {}),
      ...(resolvedProfiles.length
        ? {
            agentProfiles: [
              mainAgent,
              ...derivedAgents.map((agent) => agent.effectiveProfile),
            ],
          }
        : {}),
    };
    runStoreMetadata.traceLevel = traceLevel;

    return {
      ok: true,
      env: {
        workspaceRoot,
        workspace,
        sessionRootDir,
        trace,
        pendingExtensionEvents,
        skillUsageRecorder,
        runIdHolder,
        interactionChannel,
        model: model.adapter,
        modelRef: model.resolved.modelRef,
        resolvedModel: model.resolved,
        workflowModelAdapters,
        preparedSkills,
        preparedMcp,
        mainAgent,
        toolCatalog,
        tools,
        workflowHooks,
        workflowProjection,
        workflowStore,
        workflowRecord,
        workflowLease,
        eventHookConfig: hookConfig?.events,
        hookSandbox: shellConfig?.sandbox,
        hookHttp: hookConfig?.http,
        hookSkillRoots: skillRoots.map((root) => root.root),
        hookConfigPaths: loadedConfig.attempted.map((entry) => entry.path),
        delegateAgentTool,
        sessionStore,
        parentRunRef,
        traceLevel,
        writeGuardrails,
        confidentialPaths,
        confidentialDefaults,
        runMetadata,
        runStoreMetadata,
      },
    };
  }

  private createInteractionChannel(runIdHolder: {
    value: string | null;
  }): InteractionChannel {
    return {
      approve: (request) =>
        new Promise((resolve) => {
          const approvalId = request.id;
          const currentRunId = runIdHolder.value;
          if (!currentRunId) {
            // Approval requested before runId was populated — should not happen
            // because createRun returns synchronously, but guard rather than
            // crash on `null!`.
            resolve({ approvalId, decision: "denied" });
            return;
          }
          const execution = this.currentExecution;
          if (!execution) {
            resolve({ approvalId, decision: "denied" });
            return;
          }
          const timeout = setTimeout(() => {
            execution.resolveApproval(approvalId, {
              decision: "denied",
              message: "Approval timed out.",
            });
          }, this.opts.approvalTimeoutMs ?? 300_000);
          timeout.unref?.();
          execution.addApproval({
            approvalId,
            runId: currentRunId,
            resolve: (response) => {
              clearTimeout(timeout);
              resolve({ approvalId, ...response });
            },
          });
          const details = request.details as { path?: unknown } | undefined;
          this.opts.emit({
            envelope: "event",
            id: nextMessageId("evt"),
            kind: "approval.requested",
            timestamp: nowIso(),
            payload: {
              runId: currentRunId,
              approvalId,
              action: request.action,
              summary: request.summary,
              details: {
                ...(typeof details?.path === "string"
                  ? { path: details.path }
                  : {}),
                ...(request.details ?? {}),
              },
            },
          });
        }),
    };
  }

  private async resumeRunInner(
    payload: RunResumeRequestPayload,
    resolvedSessionId?: string,
  ): Promise<
    | { ok: true; runId: string; resumedFromRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    const located = await findHostRunDirectory(
      this.opts,
      payload.runId,
      payload.sessionId,
    );
    if (!located.ok) return located;

    let checkpoint: ReturnType<typeof loadCheckpointFromRunDir>;
    try {
      checkpoint = loadCheckpointFromRunDir(located.runDir, {
        fallbackFromTrace: payload.fromTrace,
      });
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (!checkpoint) {
      return {
        ok: false,
        error: {
          code: "run_not_found",
          message:
            `No checkpoint.json under ${located.runDir}. ` +
            `Retry with fromTrace=true to reconstruct one from the trace.`,
        },
      };
    }
    if (!checkpoint.resumability.complete && payload.force !== true) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message:
            `Checkpoint is not fully resumable (reasons: ${checkpoint.resumability.reasons.join(", ") || "unspecified"}). ` +
            `Retry with force=true (CLI: --force) to attempt a best-effort resume.`,
        },
      };
    }
    await this.tasks.failOrphanedInProcessTasksForRun(payload.runId as RunId);

    const modelRef = payload.model ?? this.opts.defaultModel;
    const access = resolveRunAccessFields(
      payload as unknown as RunStartRequestPayload,
      {
        defaultAccessMode: this.opts.defaultAccessMode,
        accessModeCeiling: this.opts.accessModeCeiling,
        defaultBackgroundTasks: this.opts.defaultBackgroundTasks,
        backgroundTasksCeiling: this.opts.backgroundTasksCeiling,
      },
    );
    const { permissionMode, shouldWrite } = access;
    const accessMetadata = buildAccessMetadata(access);
    const resumeSessionId =
      located.sessionId ?? resolvedSessionId ?? createSessionId();
    const prepared = await this.prepareHostRunEnvironment({
      goal: checkpoint.run.goal,
      modelRef,
      access,
      sessionId: resumeSessionId,
      targetPath: payload.targetPath,
      confidentialPaths: payload.confidentialPaths,
      confidentialDefaults: payload.confidentialDefaults,
      traceLevel: resolveTraceLevel({
        ...payload,
        defaultTraceLevel: this.opts.defaultTraceLevel,
      }),
      runMetadata: {
        resumedFromRunId: payload.runId,
        ...(payload.metadata ?? {}),
        ...accessMetadata,
      },
      runStoreMetadata: {
        resumedFromRunId: payload.runId,
        ...(payload.metadata ?? {}),
        ...accessMetadata,
        ...(payload.metadata ? { resumeMetadata: payload.metadata } : {}),
      },
    });
    if (!prepared.ok) return prepared;
    const env = prepared.env;

    const execution = this.currentExecution ?? this.beginExecution();
    const started = await this.workflowEpisodes.resumeCheckpoint({
      execution,
      env,
      payload,
      checkpoint,
      sessionId: resumeSessionId,
      agentId: located.agentId,
      permissionMode,
      shouldWrite,
    });
    if (!started.ok) return started;

    return {
      ok: true,
      runId: started.runId,
      resumedFromRunId: payload.runId,
      sessionId: resumeSessionId,
    };
  }

  private async resumeWorkflowRunInner(
    payload: WorkflowResumeRequestPayload,
    claimedWriter?: WorkflowLeaseBoundWriter,
  ): Promise<
    | { ok: true; runId: string; workflowRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    const located = await this.workflows.findRecord(
      payload.workflowRunId as WorkflowRunId,
      payload.sessionId,
    );
    if (!located.ok) return located;
    let { record } = located.location;
    const { store, sessionId } = located.location;
    if (this.workflows.isTerminalStatus(record.status)) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow run ${record.id} is already ${record.status}.`,
        },
      };
    }
    const lease =
      claimedWriter ??
      (await store.acquireWriter(record.id, {
        owner: this.workflows.leaseOwner(),
        ttlMs: this.workflows.leaseTtlMs(),
      }));
    if (!lease) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow run ${record.id} is already adopted by another writer.`,
        },
      };
    }
    record = (await lease.readFresh()) ?? record;
    const authorizationSnapshot = record.authorizationSnapshot;
    const effectiveResumePayload: WorkflowResumeRequestPayload = {
      ...payload,
      targetPath: payload.targetPath ?? authorizationSnapshot?.targetPath,
      confidentialPaths:
        payload.confidentialPaths ?? authorizationSnapshot?.confidentialPaths,
      confidentialDefaults:
        payload.confidentialDefaults ??
        authorizationSnapshot?.confidentialDefaults,
      accessMode: payload.accessMode ?? authorizationSnapshot?.accessMode,
      backgroundTasks:
        payload.backgroundTasks ?? authorizationSnapshot?.backgroundTasks,
    };
    const access = resolveRunAccessFields(
      effectiveResumePayload as unknown as RunStartRequestPayload,
      {
        defaultAccessMode: this.opts.defaultAccessMode,
        accessModeCeiling: this.opts.accessModeCeiling,
        defaultBackgroundTasks: this.opts.defaultBackgroundTasks,
        backgroundTasksCeiling: this.opts.backgroundTasksCeiling,
      },
    );
    const { permissionMode, shouldWrite } = access;
    const accessMetadata = buildAccessMetadata(access);
    const prepared = await this.prepareHostRunEnvironment({
      goal:
        typeof record.metadata.goal === "string"
          ? record.metadata.goal
          : `Resume workflow ${record.assetName}`,
      modelRef: payload.model ?? this.opts.defaultModel,
      access,
      sessionId,
      targetPath: effectiveResumePayload.targetPath,
      confidentialPaths: effectiveResumePayload.confidentialPaths,
      confidentialDefaults: effectiveResumePayload.confidentialDefaults,
      traceLevel: resolveTraceLevel({
        ...effectiveResumePayload,
        defaultTraceLevel: this.opts.defaultTraceLevel,
      }),
      workflowStore: store,
      workflowRecord: record,
      workflowLease: lease,
      workflowWaitingInputMetadata:
        record.status === "waiting"
          ? this.workflows.waitingInputMetadata(record, payload.metadata)
          : undefined,
      runMetadata: {
        resumedWorkflowRunId: record.id,
        verifyOnResume: record.resume.verifyOnResume,
        ...(payload.metadata ?? {}),
        ...accessMetadata,
      },
      runStoreMetadata: {
        resumedWorkflowRunId: record.id,
        verifyOnResume: record.resume.verifyOnResume,
        ...(payload.metadata ?? {}),
        ...accessMetadata,
      },
    });
    if (!prepared.ok) {
      await lease.release();
      return prepared;
    }
    const env = prepared.env;
    const priorContext = await loadHostSessionConversation(
      { workspaceRoot: env.workspaceRoot, sessionRootDir: env.sessionRootDir },
      sessionId,
    );
    const execution = this.currentExecution ?? this.beginExecution();
    const started = await this.workflowEpisodes.resumeWorkflow({
      execution,
      env,
      record,
      payload: effectiveResumePayload,
      sessionId,
      permissionMode,
      shouldWrite,
      priorContext,
    });
    if (!started.ok) {
      if (record.status === "waiting") {
        const current = (await lease.readFresh()) ?? record;
        await this.workflows.compensate(
          lease,
          current,
          record,
          "workflow_resume_start_failed",
        );
      }
      await lease.release();
      return started;
    }
    return {
      ok: true,
      runId: started.runId,
      workflowRunId: record.id,
      sessionId,
    };
  }

  private async startRunInner(
    payload: RunStartRequestPayload,
    workflowRunId?: WorkflowRunId,
  ): Promise<
    | {
        ok: true;
        runId: string;
        sessionId: string;
        workflowRunId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    const modelRef = payload.model ?? this.opts.defaultModel;
    const access = resolveRunAccessFields(payload, {
      defaultAccessMode: this.opts.defaultAccessMode,
      accessModeCeiling: this.opts.accessModeCeiling,
      defaultBackgroundTasks: this.opts.defaultBackgroundTasks,
      backgroundTasksCeiling: this.opts.backgroundTasksCeiling,
    });
    const { permissionMode, shouldWrite } = access;
    const accessMetadata = buildAccessMetadata(access);
    let sessionId: string;
    let controlSessionId: string | undefined;
    try {
      sessionId = payload.sessionId
        ? asSessionId(payload.sessionId)
        : createSessionId();
      controlSessionId = payload.controlSessionId
        ? asSessionId(payload.controlSessionId)
        : undefined;
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (controlSessionId && !payload.workflow) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message:
            "controlSessionId is only valid when starting a workflow job",
        },
      };
    }
    if (controlSessionId === sessionId) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: "workflow job sessionId must differ from controlSessionId",
        },
      };
    }
    const prepared = await this.prepareHostRunEnvironment({
      goal: payload.goal,
      modelRef,
      access,
      sessionId,
      targetPath: payload.targetPath,
      confidentialPaths: payload.confidentialPaths,
      confidentialDefaults: payload.confidentialDefaults,
      traceLevel: resolveTraceLevel({
        ...payload,
        defaultTraceLevel: this.opts.defaultTraceLevel,
      }),
      workflowName: payload.workflow,
      workflowRunId,
      controlSessionId,
      runMetadata: {
        ...(payload.metadata ?? {}),
        ...accessMetadata,
      },
      runStoreMetadata: {
        ...(payload.metadata ?? {}),
        ...accessMetadata,
      },
    });
    if (!prepared.ok) return prepared;
    const env = prepared.env;

    // Thread prior turns of this session into context so the model can see
    // the conversation history. Each completed prior run contributes a
    // user (goal) + assistant (final message) pair, tagged for the
    // "conversation" layer with session-stable cache policy.
    const priorContext = await loadHostSessionConversation(
      { workspaceRoot: env.workspaceRoot, sessionRootDir: env.sessionRootDir },
      sessionId,
    );
    const initialInputParts = inputPartsFromPayload(payload.input?.parts);
    const initialInputContext = userInputContextItem({
      content:
        initialInputParts.length > 0
          ? `User request attachments for: ${payload.goal}`
          : payload.goal,
      parts: initialInputParts,
      source: "run.start",
      metadata: payload.input?.metadata,
    });

    const execution = this.currentExecution ?? this.beginExecution();
    const started = await this.workflowEpisodes.startFresh({
      execution,
      env,
      payload,
      sessionId,
      permissionMode,
      shouldWrite,
      priorContext,
      ...(initialInputContext ? { initialInputContext } : {}),
    });
    if (!started.ok) return started;
    return {
      ...started,
      sessionId,
      ...(env.workflowRecord
        ? { workflowRunId: String(env.workflowRecord.id) }
        : {}),
    };
  }

  cancelRun(
    runId: string,
    reason?: string,
  ): { ok: true } | { ok: false; error: ProtocolError } {
    return this.opts.executionCoordinator.cancelRun(this, runId, reason);
  }

  injectRunMessage(
    runId: string,
    input: {
      content: string;
      parts?: readonly RunInputPart[];
      metadata?: Record<string, unknown>;
    },
  ): { ok: true } | { ok: false; error: ProtocolError } {
    return this.opts.executionCoordinator.injectRunMessage(this, runId, input);
  }

  private acceptExecutionMessage(
    runId: string,
    input: {
      content: string;
      parts?: readonly RunInputPart[];
      metadata?: Record<string, unknown>;
    },
  ): { ok: true } | { ok: false; error: ProtocolError } {
    if (!this.currentExecution?.ownsRun(runId)) {
      return {
        ok: false,
        error: {
          code: "run_not_found",
          message: `no active run with id ${runId}`,
        },
      };
    }
    if (!input.content.trim()) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: "content must not be empty",
        },
      };
    }
    const parts = inputPartsFromPayload(input.parts);
    const acceptance = this.currentExecution.tryInject(runId, {
      content: input.content,
      parts,
      metadata: input.metadata,
    });
    if (acceptance !== "accepted") {
      return {
        ok: false,
        error: {
          code: "run_not_found",
          message: `run ${runId} is no longer accepting messages (${acceptance})`,
        },
      };
    }
    return { ok: true };
  }

  resolveApproval(
    approvalId: string,
    decision: "approved" | "denied",
    message?: string,
    autoApproved?: boolean,
  ): { ok: true } | { ok: false; error: ProtocolError } {
    const resolved = this.currentExecution?.resolveApproval(approvalId, {
      decision,
      ...(message !== undefined ? { message } : {}),
      ...(autoApproved !== undefined ? { autoApproved } : {}),
    });
    if (!resolved) {
      return {
        ok: false,
        error: {
          code: "approval_not_found",
          message: `no pending approval with id ${approvalId}`,
        },
      };
    }
    return { ok: true };
  }

  /**
   * Called on disconnect: cancel active run + deny outstanding approvals so
   * core does not leak file handles or hang on never-arriving decisions.
   */
  cleanup(): void {
    this.currentExecution?.cleanup("client_disconnected");
  }

  async drain(): Promise<void> {
    const execution = this.currentExecution;
    if (!execution) return;
    execution.cleanup("host_service_drain");
    await execution.completion;
    await execution.disposeResources();
  }

  async listSessions(
    limit = 20,
  ): Promise<Array<{ id: string; mtimeMs: number; preview: string }>> {
    return await listHostSessions(this.opts, limit);
  }

  async inspectSession(
    sessionId: string,
    options: SessionInspectOptions = {},
  ): Promise<
    | {
        ok: true;
        sessionId: string;
        summary: Record<string, unknown>;
        consistency: Record<string, unknown>;
        timeline: Record<string, unknown>;
        compaction?: SessionCompactionInspectReport;
      }
    | { ok: false; error: ProtocolError }
  > {
    return await inspectHostSession(this.opts, sessionId, options);
  }

  async inspectSessionCompaction(sessionId: string): Promise<
    | {
        ok: true;
        sessionId: string;
        compaction: SessionCompactionInspectReport;
      }
    | { ok: false; error: ProtocolError }
  > {
    return await inspectHostSessionCompaction(this.opts, sessionId);
  }

  async compactSession(
    sessionId: string,
    reason?: string,
    options: {
      llm?: boolean;
    } = {},
  ): Promise<SessionCompactResult> {
    return await compactHostSession({
      context: this.opts,
      sessionId,
      reason,
      manualLlm: options.llm === true,
    });
  }

  /**
   * Fork a session at an optional event sequence into a brand-new session,
   * using core's forkSessionFromEvent over the file-backed session store.
   * The new session's run references are copied; subsequent runs extend the
   * fork rather than the original.
   */
  async forkSession(
    sourceSessionId: string,
    forkAtSequence?: number,
  ): Promise<
    | {
        ok: true;
        forkedSessionId: string;
        copiedEventCount: number;
        truncatedAtSequence: number | null;
      }
    | { ok: false; error: ProtocolError }
  > {
    return await forkHostSession(this.opts, sourceSessionId, forkAtSequence);
  }
}
