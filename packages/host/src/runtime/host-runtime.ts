import { readdir, stat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  asSessionId,
  createBufferedEmitter,
  createContextItemId,
  createRunId,
  createDefaultPolicy,
  createLayeredPolicy,
  createSessionId,
  createSessionRunStoreFactory,
  loadSessionCompactArtifact,
  loadTraceEventsFile,
  createRun,
  defineTool,
  FileSessionStore,
  EventLog,
  loadCheckpointFromRunDir,
  resumeRunFromCheckpoint,
  sessionCompactArtifactToContextItem,
  sessionTurnToContextItems,
  type InteractionChannel,
  type BackgroundTaskPolicy,
  type ContentPart,
  type ContextItem,
  type EventEmitter,
  type ModelAdapter,
  type NotificationSource,
  type Policy,
  type RunId,
  type RunBudget,
  type RunRecord,
  type RunResult,
  type RuntimeContext,
  type SparkwrightEvent,
  type TaskRevivalSource,
  type SessionTraceFacts,
  type ToolDefinition,
  type ToolRequestPreviewOptions,
  type WorkflowHook,
} from "@sparkwright/core";
import {
  prepareSkillsForRun,
  type SkillUsageRecorder,
} from "@sparkwright/skills";
import {
  createLazyMcpToolsForRun,
  prepareMcpToolsForRun,
  type McpServerConfig,
} from "@sparkwright/mcp-adapter";
import {
  FileTaskNotificationOutbox,
  FileWorkflowNotificationOutbox,
  FileWorkflowControlInbox,
  WorkflowControlCommandProcessor,
  type WorkflowControlCommand,
  type WorkflowControlCommandEnvelope,
  type WorkflowControlSourceIdentity,
  FileWorkflowStore,
  advanceWorkflowState,
  assertSafeWorkflowRunId,
  type WorkflowLeaseBoundWriter,
  TaskManager,
  createAgentTool,
  createAgentProfilePolicy,
  deriveChildAgentProfile,
  findSimilarSuccessfulDelegation,
  notificationFromRecord,
  rememberSuccessfulDelegation,
  readTodoLedger,
  TODO_CONTINUATION_REQUIRED_TOOL,
  spawnSubAgent,
  summarizeDelegationResult,
  withAlreadyCompletedNote,
  type AgentProfile,
  type AgentProfileWorkflowHookConfig,
  type ActorInbox,
  type DelegationLedgerHit,
  type DelegationLedgerKey,
  type DerivedChildAgentProfile,
  type TaskId,
  type TaskNotification,
  type TaskOutputChunk,
  type TaskRecord,
  type TaskRunnerController,
  type TaskStatus,
  type TodoSupervisedRunInput,
  type SpawnedSubAgent,
  type WorkflowDefinition,
  type WorkflowEvidenceRef,
  type WorkflowNodeDefinition,
  type WorkflowNodeVerdictLogEntry,
  type WorkflowRunId,
  type WorkflowRunRecord,
  type WorkflowRunFailure,
  type WorkflowRunStatus,
  type WorkflowRuntimeState,
  workspaceWorkflowRunsDir,
} from "@sparkwright/agent-runtime";
import { defaultCronRoot } from "@sparkwright/cron";
import { RECOMMENDED_FOREGROUND_TIMEOUT_MS } from "@sparkwright/shell-tool";
import {
  InFlightCommandDispatcher,
  type ExecutionHandle,
} from "@sparkwright/server-runtime";
import type { HostExecutionMessage, RuntimeOptions } from "./contracts.js";
import {
  buildCapabilitySnapshot,
  createSkillPreprocessOptions,
  inlineShellCapabilitySummary,
  mergeCapabilitySnapshots,
  modelCapabilitySummary,
  readCronJobsForSnapshot,
  readTasksForSnapshot,
  workflowCapabilitySummary,
} from "./capability-assembly.js";
import {
  IMMEDIATE_NONE,
  compareTaskRecordsNewestFirst,
  isTerminalTaskStatus,
  pendingNotificationFromTask,
  raceWithImmediate,
  taskNotFoundError,
  taskOutputChunkSnapshot,
  taskRecordSnapshot,
} from "./task-projections.js";
export type {
  HostExecutionCoordinatorPort,
  HostExecutionMessage,
  RuntimeOptions,
} from "./contracts.js";
import {
  createWorkspaceMutationAdmission,
  processWorkspaceLeaseCoordinator,
  type WorkspaceLeaseCoordinator,
} from "../workspace-lease-coordinator.js";
import { type ResolvedShellSandboxConfig } from "@sparkwright/shell-sandbox";
import type {
  CapabilityDelegateToolConfig,
  CapabilityEventHookConfig,
  CapabilityHooksConfig,
  CapabilityToolsConfig,
  CapabilityVerificationConfig,
  CapabilityWorkflowHookConfig,
  ShellConfig,
  WriteGuardrailsConfig,
} from "../config-zod-schema.js";
import {
  createSessionFileRunStoreFactory,
  LocalWorkspace,
  MemoryTrace,
} from "@sparkwright/core/internal";
import {
  isTraceLevel,
  type TraceLevel,
  type ProtocolError,
  type CapabilityInspectRequestPayload,
  type RunFailureEnvelope,
  type RunResumeRequestPayload,
  type RunStartRequestPayload,
  type WorkflowListRequestPayload,
  type WorkflowResumeRequestPayload,
  type WorkflowRunSnapshot,
  type RunInputPart,
  type SessionCompactionInspectReport,
  type TaskOutputChunkSnapshot,
  type TaskRecordSnapshot,
  type CapabilitySnapshot,
  type CapabilityAutomationSummary,
} from "@sparkwright/protocol";
import { buildAgentPromptBuilder } from "@sparkwright/project-context";
import { loadHostConfig } from "../config/config-implementation.js";
import type { CapabilityMcpConfig } from "../config/contracts.js";
import {
  resolveAgentProfiles,
  type AgentProfileCollision,
} from "../agent-profiles.js";
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
  forkHostSession,
  inspectHostSession,
  inspectHostSessionCompaction,
  listHostSessions,
  type SessionInspectOptions,
} from "../session-queries.js";
import {
  compactHostSession,
  type SessionCompactResult,
} from "../session-compaction.js";
export { sessionPreviewFromTranscriptLine } from "../session-queries.js";
import { WorkspaceContext } from "../workspace-context.js";
import {
  createModel,
  inspectResolvedModelConfig,
  type ResolvedModelConfig,
} from "../model-factory.js";
import {
  catalogToolDefinitions,
  createConfiguredDelegateChildToolCatalog,
  createDynamicChildToolCatalog,
  createMainHostToolCatalog,
  type HostToolCatalogEntry,
} from "../tool-catalog.js";
import {
  AGENT_READ_ONLY_CHILD_TOOLS,
  AGENT_WORKSPACE_WRITE_CHILD_TOOLS,
  agentWorkspaceWriteGrantApprovalSummaryForPayload,
  agentWorkspaceWriteGrantPolicyForPayload,
  isAgentSpawnRequestConcurrencySafe,
  parseAgentAllowedToolsFromRecord,
  parseAgentWorkspaceWriteGrantFromRecord,
  resolveAgentSpawnToolRequest,
  type AgentWorkspaceWriteGrant,
} from "../agent-spawn-grants.js";
import {
  acpConfigFromAgentProfile,
  createAcpDelegateTool,
} from "../acp-child-agent.js";
import {
  createExternalCommandDelegateTool,
  externalCommandConfigFromAgentProfile,
} from "../external-command-agent.js";
import { createDelegateAgentTool } from "../indexed-delegate-tool.js";
export { createDelegateAgentTool } from "../indexed-delegate-tool.js";
import {
  createSkillUsageRecorder,
  observeSkillUsageEvent,
} from "../skill-usage.js";
import {
  assertSubagentDepthAllowed,
  describeDelegateCapability,
  describeInProcessDelegateCapability,
  deriveDelegatePolicyProfile,
  delegateToolDescription,
  delegateToolName,
  evaluateDelegateRouting,
  filterDirectDelegatesForExposure,
  resolveAgentDelegateTools,
  sanitizeToolSegment,
  type DelegateWorkspaceAccess,
  type DelegateCapabilityDescriptor,
  type DelegateToolCollision,
  type DelegateRoutingEvaluation,
  type DelegateRoutingSummary,
  type DelegatePolicyProfile,
} from "../delegate-capability.js";
import {
  bindConfiguredEventHooks,
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
import {
  loadLayeredWorkflowAssets,
  pinWorkflowAssetPackage,
  verifyWorkflowPackageSnapshot,
} from "../workflows.js";
import {
  createWorkflowProjectionHooks,
  type WorkflowProjectionStateSnapshot,
} from "../workflow-projection.js";
import {
  DISCOVERY_TOOL_NAME,
  WORKSPACE_WRITE_TOOL_NAMES,
  intersectToolUseSelectors,
  resolveSelectorAllowlist,
} from "../tool-selectors.js";
import {
  admitToolsForAgentProfile,
  agentProfileAdmitsTool,
  createScopedToolSearch,
  isWorkflowScopedToolSearch,
  matchesAgentToolName,
  resolveRunToolSurface,
  type ResolvedToolSurface,
} from "../tool-surface.js";

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

interface CompletedConversationTurn {
  runId: RunId;
  goal: string;
  message: string;
  traceFacts?: SessionTraceFacts;
}

type PreparedSkills = Awaited<ReturnType<typeof prepareSkillsForRun>>;
type PreparedMcp = Awaited<ReturnType<typeof prepareMcpToolsForRun>>;

interface PreparedHostRunEnvironment {
  workspaceRoot: string;
  workspace: LocalWorkspace;
  sessionRootDir: string;
  trace: MemoryTrace;
  pendingExtensionEvents: ReturnType<typeof createBufferedEmitter>;
  skillUsageRecorder: SkillUsageRecorder | null;
  runIdHolder: { value: string | null };
  interactionChannel: InteractionChannel;
  model: ModelAdapter;
  modelRef: string;
  resolvedModel: ResolvedModelConfig;
  workflowModelAdapters: Map<
    string,
    { adapter: ModelAdapter; resolved: ResolvedModelConfig }
  >;
  preparedSkills: PreparedSkills | null;
  preparedMcp: PreparedMcp | null;
  mainAgent: AgentProfile;
  toolCatalog: HostToolCatalogEntry[];
  tools: ToolDefinition[];
  workflowHooks: WorkflowHook[];
  workflowProjection?: ReturnType<typeof createWorkflowProjectionHooks>;
  workflowStore?: FileWorkflowStore;
  workflowRecord?: WorkflowRunRecord;
  workflowLease?: WorkflowLeaseBoundWriter;
  eventHookConfig?: CapabilityEventHookConfig[];
  hookSandbox?: ShellConfig["sandbox"];
  hookHttp?: CapabilityHooksConfig["http"];
  hookSkillRoots: string[];
  hookConfigPaths: string[];
  delegateAgentTool?: ToolDefinition;
  sessionStore: FileSessionStore;
  parentRunRef: { current?: ReturnType<typeof createRun> };
  traceLevel: TraceLevel;
  writeGuardrails?: WriteGuardrailsConfig;
  confidentialPaths?: readonly string[];
  confidentialDefaults?: boolean;
  runMetadata: Record<string, unknown>;
  runStoreMetadata: Record<string, unknown>;
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

function defaultSessionRootDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "sessions");
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

function summarizeCapabilitySnapshot(
  snapshot: CapabilitySnapshot | null,
): Record<string, unknown> {
  if (!snapshot) {
    return {
      tools: 0,
      skills: { indexed: 0, loaded: 0 },
      mcp: { servers: 0, tools: 0 },
      agents: { profiles: 0, delegateTools: 0 },
      rules: { workflow: 0, events: 0 },
    };
  }
  return {
    ...(snapshot.model
      ? {
          model: {
            modelRef: snapshot.model.modelRef,
            providerKey: snapshot.model.providerKey,
            modelId: snapshot.model.modelId,
            pricing: snapshot.model.pricing,
          },
        }
      : {}),
    tools: snapshot.tools.length,
    toolNames: snapshot.tools.map((tool) => tool.name),
    skills: {
      indexed: snapshot.skills.indexed.length,
      loaded: snapshot.skills.loaded.length,
      indexedNames: snapshot.skills.indexed.map((skill) => skill.name),
      loadedNames: snapshot.skills.loaded.map((skill) => skill.name),
    },
    mcp: {
      servers: snapshot.mcp.statuses.length,
      tools: snapshot.mcp.statuses.reduce(
        (sum, status) => sum + status.toolNames.length,
        0,
      ),
      statuses: snapshot.mcp.statuses.map((status) => ({
        serverName: status.serverName,
        status: status.status,
        toolNames: status.toolNames,
      })),
    },
    agents: {
      profiles: snapshot.agents.profiles.length,
      profileIds: snapshot.agents.profiles.map((profile) => profile.id),
      delegateTools: snapshot.agents.delegateTools.length,
      delegateToolNames: snapshot.agents.delegateTools.map(
        (delegate) => delegate.toolName,
      ),
    },
    rules: {
      workflow: snapshot.rules?.workflow.length ?? 0,
      workflowNames: snapshot.rules?.workflow.map((rule) => rule.name) ?? [],
      events: snapshot.rules?.events?.length ?? 0,
      eventNames: snapshot.rules?.events?.map((rule) => rule.name) ?? [],
    },
    workflows: {
      assets: snapshot.workflows?.assets.length ?? 0,
      names: snapshot.workflows?.assets.map((asset) => asset.assetName) ?? [],
      errors: snapshot.workflows?.errors?.length ?? 0,
    },
    shell: snapshot.shell,
  };
}

// Todo-supervisor continuation budget for the main agent. Conservative, fixed
// bounds: after MAIN_TODO_MAX_CONTINUATIONS auto-continuations — or a single
// continuation that produced no progress (no external write and no newly
// completed item) — the run chain hands back to the human rather than spinning.
// The stall bound is deliberately tight: once a continuation makes zero
// progress, the model has typically converged on its answer and further rounds
// just re-emit it, so one empty round is enough to stop. Only runs whose model
// left unfinished todos continue at all; a run with an empty/finished ledger
// audits once and stops.
const MAIN_TODO_MAX_CONTINUATIONS = 4;
const MAIN_TODO_MAX_STALLED_CONTINUATIONS = 1;
const MAIN_TODO_CONTINUATION_MAX_STEPS = 8;
const MAIN_TODO_CONTINUATION_MAX_MODEL_CALLS = 8;
const MAIN_TODO_CONTINUATION_MAX_TOOL_CALLS = 12;
const WORKFLOW_LEASE_TTL_MS = 30 * 60 * 1000;

const DELEGATED_AGENT_CONTRACT = [
  "Delegated agent contract:",
  "- Do not ask the user directly. Your parent agent owns all user interaction.",
  "- If a safe read-only next step can make progress, take it instead of asking for confirmation.",
  "- If you are blocked by ambiguity, required approval, or missing capability, return a concise final message with status: needs_clarification, needs_approval, or blocked; include the question or requested action, a reasonable default when one exists, and any safe alternative.",
  "- For clear delegated goals, complete the task and return the result to the parent.",
].join("\n");

/**
 * Compatibility facade over one HostExecution attachment. Production starts,
 * resumes, injection, cancellation, and terminal handoff are admitted by the
 * process HostService and its ExecutionLaneCoordinator before reaching this
 * runtime.
 */
/**
 * @internal Per-run spawn dependencies the registered `agent` task kind needs
 * to drive a read-only background child run. Published by {@link HostRuntime}
 * during run preparation; the registered runner snapshots it at the top of
 * execution while the foreground run is still active, then the started child is
 * self-sustaining. Mirrors the inputs of {@link createDynamicSpawnAgentTool}.
 */
export interface HostAgentTaskRunnerDeps {
  getParent: () => ReturnType<typeof createRun> | undefined;
  model: ModelAdapter;
  modelForSpawn: () => Promise<ModelAdapter>;
  childTools: ToolDefinition[];
  parentRunPolicy: Policy;
  taskManager?: TaskManager;
  backgroundTasks?: BackgroundTaskPolicy;
  foregroundTimeoutMs?: number;
  childRunStoreFactory: (
    childAgentId: string,
  ) => ReturnType<typeof createSessionRunStoreFactory>;
  maxDepth?: number;
  sessionId?: string;
  workspaceRoot?: string;
  workspaceLeaseCoordinator?: WorkspaceLeaseCoordinator;
}

/**
 * @internal Shared implementation for the background `agent` task kind. Kept
 * outside HostRuntime so tests can cover task-owned abort and completion
 * behavior without duplicating the private runner wiring.
 */
export async function runHostAgentTask(
  controller: TaskRunnerController,
  payload: unknown,
  deps: HostAgentTaskRunnerDeps,
): Promise<unknown> {
  const parent = deps.getParent();
  if (!parent) {
    throw Object.assign(
      new Error("Agent task runner requires an active parent run."),
      { code: "AGENT_TASK_PARENT_UNAVAILABLE" },
    );
  }
  if (controller.signal.aborted) {
    throw Object.assign(new Error("Agent task aborted before start."), {
      name: "AbortError",
    });
  }

  controller.report({
    label: "agent_task",
    message: "Starting child agent.",
  });
  const tool = createDynamicSpawnAgentTool({
    getParent: () => parent,
    model: deps.model,
    modelForSpawn: deps.modelForSpawn,
    childTools: deps.childTools,
    parentRunPolicy: deps.parentRunPolicy,
    childRunStoreFactory: deps.childRunStoreFactory,
    maxDepth: deps.maxDepth,
    abortSignal: controller.signal,
    entrypoint: "agent_task",
    delegateToolName: "task_create",
    taskManager: deps.taskManager,
    backgroundTasks: deps.backgroundTasks,
    foregroundTimeoutMs: deps.foregroundTimeoutMs,
    taskId: String(controller.taskId),
    workspaceRoot: deps.workspaceRoot,
    workspaceLeaseCoordinator: deps.workspaceLeaseCoordinator,
  });
  const ctx: RuntimeContext = {
    run: parent.record,
    abortSignal: controller.signal,
    workspace: parent.getWorkspace?.(),
  };
  const output = await tool.execute(payload, ctx);
  controller.report({
    label: "agent_task",
    message: "Child agent completed.",
  });
  controller.emitOutput({
    channel: "event",
    data: JSON.stringify(summarizeAgentTaskOutput(output)),
  });
  return output;
}

export class HostRuntime {
  private opts: RuntimeOptions;
  private readonly taskNotifications: FileTaskNotificationOutbox;
  private readonly workflowNotifications: FileWorkflowNotificationOutbox;
  private readonly workflowControls: FileWorkflowControlInbox;
  private readonly workflowControlDispatcher: InFlightCommandDispatcher;
  private readonly taskManager: TaskManager;
  private currentExecution: HostExecution | null = null;
  // One abort for the complete interactive execution, including assembly and
  // every todo/workflow episode. Core run cancellation remains run-scoped.
  private lastCapabilitySnapshot: CapabilitySnapshot | null = null;

  constructor(opts: RuntimeOptions) {
    this.opts = {
      ...opts,
      workspaceRoot: resolve(opts.workspaceRoot),
      ...(opts.sessionRootDir
        ? { sessionRootDir: resolve(opts.sessionRootDir) }
        : {}),
    };
    const context =
      opts.workspaceContext ??
      new WorkspaceContext(
        {
          workspaceRoot: this.opts.workspaceRoot,
          sessionRootDir:
            this.opts.sessionRootDir ??
            defaultSessionRootDir(this.opts.workspaceRoot),
        },
        opts.workspaceLeaseCoordinator ?? processWorkspaceLeaseCoordinator,
      );
    this.taskNotifications = context.taskNotifications;
    this.workflowNotifications = context.workflowNotifications;
    this.workflowControls = context.workflowControls;
    this.workflowControlDispatcher = context.workflowControlDispatcher;
    this.taskManager = context.taskManager;
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
    return `${
      this.opts.sessionRootDir ?? defaultSessionRootDir(this.opts.workspaceRoot)
    }\0${sessionId}`;
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
        this.injectRunMessageDirect(message.runId, message).ok
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

  private taskRootDir(): string {
    return join(this.opts.workspaceRoot, ".sparkwright", "tasks");
  }

  private workflowNotificationRootDir(): string {
    return join(this.opts.workspaceRoot, ".sparkwright", "workflow-actors");
  }

  private workflowStoreRootDir(): string {
    return workspaceWorkflowRunsDir({ workspaceRoot: this.opts.workspaceRoot });
  }

  private createTaskRevivalBridge(getRunId: () => RunId | undefined): {
    notificationSource: NotificationSource;
    taskRevivalSource: TaskRevivalSource;
  } {
    const matchesRun = (notification: TaskNotification): boolean => {
      const runId = getRunId();
      return runId !== undefined && notification.parentRunId === runId;
    };
    const matchesAwaitedRun = (notification: TaskNotification): boolean => {
      if (!matchesRun(notification)) return false;
      const record = this.taskManager.store.get(notification.taskId);
      return record?.awaited !== false;
    };
    const hasAwaitedPending = (): boolean => {
      const runId = getRunId();
      if (!runId) return false;
      const hasActiveAwaited = this.taskManager.store
        .list({ parentRunId: runId, awaited: true })
        .some((task) => !isTerminalTaskStatus(task.status));
      if (hasActiveAwaited) return true;
      return this.taskNotifications.peek().some(matchesAwaitedRun);
    };

    const notificationSource: NotificationSource = {
      drain: () =>
        this.taskNotifications
          .drain(matchesRun)
          .map((notification) => pendingNotificationFromTask(notification)),
    };
    const taskRevivalSource: TaskRevivalSource = {
      hasAwaitedPending,
      waitUntilAvailable: ({ signal }) =>
        this.taskNotifications.waitUntilAvailable({
          signal,
          predicate: matchesAwaitedRun,
        }),
    };
    return { notificationSource, taskRevivalSource };
  }

  private async finalizeWorkflowRecordAfterRun(
    env: PreparedHostRunEnvironment,
    runId: RunId,
    result: RunResult,
  ): Promise<void> {
    if (!env.workflowLease || !env.workflowRecord) return;
    const latest = (await env.workflowLease.readFresh()) ?? env.workflowRecord;
    if (latest.status === "waiting") {
      this.deliverWorkflowNotification(latest);
      await env.workflowLease?.release();
      env.workflowLease = undefined;
      env.workflowRecord = latest;
      return;
    }
    if (isTerminalWorkflowRunStatus(latest.status)) {
      this.deliverWorkflowNotification(latest);
      await env.workflowLease?.release();
      env.workflowLease = undefined;
      env.workflowRecord = latest;
      return;
    }
    if (result.state === "cancelled") {
      env.workflowRecord = await mutateWorkflowRecord(
        env.workflowLease,
        latest,
        {
          status: "cancelled",
          activeRunId: runId,
          failure: {
            kind: "cancelled",
            code: "workflow.cancelled",
            message: result.stopReason ?? "manual_cancelled",
          },
          metadata: { finalizedFromRunEnd: true },
        },
      );
      this.deliverWorkflowNotification(env.workflowRecord);
      await env.workflowLease?.release();
      env.workflowLease = undefined;
      return;
    }
    if (result.state === "failed") {
      env.workflowRecord = await mutateWorkflowRecord(
        env.workflowLease,
        latest,
        {
          status: "failed",
          activeRunId: runId,
          failure: {
            kind: "runtime",
            code: "workflow.runtime",
            message: result.stopReason
              ? `Run failed before workflow completed: ${result.stopReason}`
              : "Run failed before workflow completed.",
            metadata: {
              stopReason: result.stopReason,
              runFailure: result.failure,
            },
          },
          metadata: { finalizedFromRunEnd: true },
        },
      );
      this.deliverWorkflowNotification(env.workflowRecord);
      await env.workflowLease?.release();
      env.workflowLease = undefined;
      return;
    }
    if (result.state === "completed") {
      env.workflowRecord = await mutateWorkflowRecord(
        env.workflowLease,
        latest,
        {
          status: "failed",
          activeRunId: runId,
          failure: {
            kind: "runtime",
            code: "workflow.runtime",
            message: "Run completed before workflow reached a terminal state.",
          },
          metadata: { finalizedFromRunEnd: true },
        },
      );
      this.deliverWorkflowNotification(env.workflowRecord);
      await env.workflowLease?.release();
      env.workflowLease = undefined;
    }
  }

  private async finalizeWorkflowRecordAfterSupervisorError(
    env: PreparedHostRunEnvironment,
    runId: RunId | undefined,
    cause: unknown,
  ): Promise<void> {
    if (!env.workflowLease || !env.workflowRecord) return;
    const latest = (await env.workflowLease.readFresh()) ?? env.workflowRecord;
    if (latest.status === "waiting") {
      this.deliverWorkflowNotification(latest);
      await env.workflowLease?.release();
      env.workflowLease = undefined;
      env.workflowRecord = latest;
      return;
    }
    if (isTerminalWorkflowRunStatus(latest.status)) {
      this.deliverWorkflowNotification(latest);
      await env.workflowLease?.release();
      env.workflowLease = undefined;
      env.workflowRecord = latest;
      return;
    }
    const message =
      cause instanceof Error
        ? cause.message
        : cause
          ? String(cause)
          : "unknown";
    env.workflowRecord = await mutateWorkflowRecord(env.workflowLease, latest, {
      status: "failed",
      ...(runId ? { activeRunId: runId } : {}),
      failure: {
        kind: "runtime",
        code: "workflow.runtime",
        message: `Run supervisor failed before workflow completed: ${message}`,
        metadata: { supervisorError: message },
      },
      metadata: { finalizedFromSupervisorError: true },
    });
    this.deliverWorkflowNotification(env.workflowRecord);
    await env.workflowLease?.release();
    env.workflowLease = undefined;
  }

  private deliverWorkflowNotification(record: WorkflowRunRecord): void {
    if (
      record.status !== "completed" &&
      record.status !== "failed" &&
      record.status !== "waiting"
    ) {
      return;
    }
    if (record.status === "waiting" && !record.wait) return;
    const wait = record.wait;
    const runId = record.activeRunId ?? record.parentRunId;
    const source = {
      kind: "workflow" as const,
      id: record.id,
      ...(runId ? { runId } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    };
    const routeHint = {
      ...(runId ? { parentRunId: String(runId) } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    };
    if (record.status === "waiting") {
      this.workflowNotifications.asActorSink().deliver({
        source,
        routeHint,
        type: "waiting",
        correlationId: [
          record.id,
          "waiting",
          record.currentNodeId ?? "unknown",
          wait?.id ?? wait?.approvalId ?? wait?.taskId ?? "unspecified",
        ].join(":"),
        payload: {
          workflowId: record.id,
          name: record.assetName,
          summary: `Workflow ${record.assetName} is waiting.`,
          wait: record.wait!,
          metadata: {
            assetName: record.assetName,
            version: record.version,
            contentHash: record.contentHash,
            currentNodeId: record.currentNodeId,
            generation: record.generation ?? 0,
            status: record.status,
          },
        },
      });
      return;
    }
    if (record.status === "completed") {
      this.workflowNotifications.asActorSink().deliver({
        source,
        routeHint,
        type: "completed",
        correlationId: `${record.id}:completed`,
        payload: {
          workflowId: record.id,
          name: record.assetName,
          summary: `Workflow ${record.assetName} completed.`,
          metadata: {
            assetName: record.assetName,
            version: record.version,
            contentHash: record.contentHash,
          },
        },
      });
      return;
    }
    const failure: WorkflowRunFailure = record.failure ?? {
      kind: "runtime",
      code: "workflow.runtime",
      message: "Workflow failed.",
    };
    this.workflowNotifications.asActorSink().deliver({
      source,
      routeHint,
      type: "failed",
      correlationId: `${record.id}:failed`,
      payload: {
        workflowId: record.id,
        name: record.assetName,
        summary: `Workflow ${record.assetName} failed.`,
        error: {
          code: failure.code.startsWith("workflow.")
            ? failure.code
            : `workflow.${failure.kind}`,
          message: failure.message,
          metadata: {
            ...failure.metadata,
            kind: failure.kind,
            nodeId: failure.nodeId,
          },
        },
      },
    });
  }

  private async failOrphanedInProcessTasksForRun(
    parentRunId: RunId,
  ): Promise<void> {
    const orphanable = this.taskManager.store
      .list({ parentRunId })
      .filter(
        (task) =>
          (task.status === "pending" || task.status === "running") &&
          !this.taskManager.hasLiveRunner(task.id),
      );
    for (const task of orphanable) {
      await this.taskManager.fail(task.id, {
        code: "TASK_ORPHANED_IN_PROCESS",
        message:
          "Task was still pending or running when the host resumed this run, " +
          "but in-process task execution cannot survive host exit.",
        metadata: {
          previousStatus: task.status,
          parentRunId,
        },
      });
    }
  }

  listTasks(input: {
    status?: TaskStatus;
    kind?: string;
    parentRunId?: string;
    limit?: number;
  }): { ok: true; tasks: TaskRecordSnapshot[] } {
    const tasks = this.taskManager.store
      .list({
        status: input.status,
        kind: input.kind,
        parentRunId: input.parentRunId as RunId | undefined,
      })
      .sort(compareTaskRecordsNewestFirst)
      .slice(0, input.limit ?? 50)
      .map(taskRecordSnapshot);
    return { ok: true, tasks };
  }

  getTask(
    taskId: string,
  ):
    | { ok: true; task: TaskRecordSnapshot }
    | { ok: false; error: ProtocolError } {
    const id = taskId as unknown as TaskId;
    const task = this.taskManager.store.get(id);
    if (!task) return { ok: false, error: taskNotFoundError(taskId) };
    return { ok: true, task: taskRecordSnapshot(task) };
  }

  async readTaskOutput(input: {
    taskId: string;
    fromSequence?: number;
    maxChunks?: number;
  }): Promise<
    | {
        ok: true;
        taskId: string;
        chunks: TaskOutputChunkSnapshot[];
        nextSequence: number;
        complete: boolean;
        status: TaskStatus;
        error?: TaskRecord["error"];
        lastOutputAt?: string;
        stalled: boolean;
      }
    | { ok: false; error: ProtocolError }
  > {
    const id = input.taskId as unknown as TaskId;
    const initial = this.taskManager.store.get(id);
    if (!initial) return { ok: false, error: taskNotFoundError(input.taskId) };

    const fromSequence = input.fromSequence ?? 0;
    const maxChunks = input.maxChunks ?? 200;
    const chunks: TaskOutputChunk[] = [];
    const outputStream = this.taskManager.store.loadOutput(id, fromSequence);
    const iterator = outputStream[Symbol.asyncIterator]();
    try {
      while (chunks.length < maxChunks) {
        const next = await raceWithImmediate(iterator);
        if (next === IMMEDIATE_NONE || next.done) break;
        chunks.push(next.value);
      }
    } finally {
      await iterator.return?.();
    }

    const latest = this.taskManager.store.get(id) ?? initial;
    const lastSequence =
      chunks.length > 0
        ? chunks[chunks.length - 1]!.sequence
        : fromSequence - 1;
    return {
      ok: true,
      taskId: input.taskId,
      chunks: chunks.map(taskOutputChunkSnapshot),
      nextSequence: lastSequence + 1,
      complete: isTerminalTaskStatus(latest.status),
      status: latest.status,
      ...(latest.error ? { error: latest.error } : {}),
      ...(latest.lastOutputAt ? { lastOutputAt: latest.lastOutputAt } : {}),
      stalled: latest.status === "running" && chunks.length === 0,
    };
  }

  async stopTask(
    taskId: string,
  ): Promise<
    | { ok: true; cancelled: boolean; status?: TaskStatus }
    | { ok: false; error: ProtocolError }
  > {
    const id = taskId as unknown as TaskId;
    const before = this.taskManager.store.get(id);
    if (!before) return { ok: false, error: taskNotFoundError(taskId) };
    if (isTerminalTaskStatus(before.status)) {
      return { ok: true, cancelled: false, status: before.status };
    }
    const handle = this.taskManager.handle(id);
    if (!handle) return { ok: true, cancelled: false, status: before.status };
    await handle.cancel();
    const after = this.taskManager.store.get(id);
    return {
      ok: true,
      cancelled: after?.status === "cancelled",
      ...(after?.status ? { status: after.status } : {}),
    };
  }

  async joinTask(
    taskId: string,
  ): Promise<
    | { ok: true; taskId: string; awaited: boolean; status: TaskStatus }
    | { ok: false; error: ProtocolError }
  > {
    const id = taskId as unknown as TaskId;
    const before = this.taskManager.store.get(id);
    if (!before) return { ok: false, error: taskNotFoundError(taskId) };
    const joined = isTerminalTaskStatus(before.status)
      ? this.taskManager.store.update(id, { awaited: true })
      : this.taskManager.store.update(id, { awaited: true });
    if (
      isTerminalTaskStatus(joined.status) &&
      !this.taskNotifications
        .peek((notification) => notification.taskId === joined.id)
        .some(Boolean)
    ) {
      this.taskNotifications.deliver(notificationFromRecord(joined));
    }
    return {
      ok: true,
      taskId,
      awaited: joined.awaited,
      status: joined.status,
    };
  }

  async promoteTask(taskId: string): Promise<
    | {
        ok: true;
        taskId: string;
        promoted: boolean;
        awaited: boolean;
        status: TaskStatus;
      }
    | { ok: false; error: ProtocolError }
  > {
    const id = taskId as unknown as TaskId;
    if (!this.taskManager.store.get(id)) {
      return { ok: false, error: taskNotFoundError(taskId) };
    }
    const promoted = this.taskManager.requestPromotion(id);
    return {
      ok: true,
      taskId,
      promoted: promoted.interruptedForegroundWait,
      awaited: promoted.record.awaited,
      status: promoted.record.status,
    };
  }

  async inspectCapabilities(
    input: CapabilityInspectRequestPayload & { modelRef?: string } = {},
  ): Promise<
    | { ok: true; snapshot: CapabilitySnapshot }
    | { ok: false; error: ProtocolError }
  > {
    try {
      const access = resolveRunAccessFields(input, {
        defaultAccessMode: this.opts.defaultAccessMode,
        accessModeCeiling: this.opts.accessModeCeiling,
        defaultBackgroundTasks: this.opts.defaultBackgroundTasks,
        backgroundTasksCeiling: this.opts.backgroundTasksCeiling,
      });
      const configured = await this.inspectConfiguredCapabilities({
        modelRef: input.model ?? input.modelRef,
        access,
      });
      return {
        ok: true,
        snapshot: mergeCapabilitySnapshots(
          configured,
          this.lastCapabilitySnapshot,
        ),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
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
    if (this.opts.executionCoordinator) {
      return this.opts.executionCoordinator.startRun(this, payload);
    }
    return this.startRunDirect(payload);
  }

  async startRunDirect(
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
    if (this.opts.executionCoordinator) {
      return this.opts.executionCoordinator.resumeRun(this, payload);
    }
    return this.resumeRunDirect(payload);
  }

  /** @internal Resolve the persisted session before HostService chooses a lane. */
  async resolveResumeSession(
    payload: RunResumeRequestPayload,
  ): Promise<
    { ok: true; sessionId: string } | { ok: false; error: ProtocolError }
  > {
    const located = await this.findRunDir(payload.runId, payload.sessionId);
    if (!located.ok) return located;
    return { ok: true, sessionId: located.sessionId ?? createSessionId() };
  }

  async resumeRunDirect(
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
    let requestedSessionId: string | undefined;
    try {
      requestedSessionId = payload.sessionId
        ? asSessionId(payload.sessionId)
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
    const workflows: WorkflowRunSnapshot[] = [];
    const invalidEntries: Array<{
      path: string;
      code: string;
      reason: string;
    }> = [];
    const seenWorkflowRunIds = new Set<string>();
    const addRecord = (record: WorkflowRunRecord) => {
      if (requestedSessionId && record.sessionId !== requestedSessionId) return;
      if (payload.status && record.status !== payload.status) return;
      const id = String(record.id);
      if (seenWorkflowRunIds.has(id)) return;
      seenWorkflowRunIds.add(id);
      workflows.push(workflowRunSnapshot(record));
    };
    const workspaceStore = new FileWorkflowStore({
      rootDir: this.workflowStoreRootDir(),
      createRoot: false,
    });
    const workspaceListed = workspaceStore.list();
    invalidEntries.push(...workspaceListed.invalidEntries);
    for (const record of workspaceListed.records) {
      addRecord(record);
    }
    workflows.sort((left, right) =>
      (right.updatedAt ?? right.createdAt).localeCompare(
        left.updatedAt ?? left.createdAt,
      ),
    );
    return {
      ok: true,
      workflows:
        payload.limit && payload.limit > 0
          ? workflows.slice(0, payload.limit)
          : workflows,
      ...(invalidEntries.length > 0 ? { invalidEntries } : {}),
    };
  }

  workflowActorInbox(): ActorInbox {
    return this.workflowNotifications.asActorInbox();
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
    const located = await this.findWorkflowRunRecord(
      input.workflowRunId as WorkflowRunId,
      input.sessionId,
    );
    if (!located.ok) return located;
    const { record, store, sessionId } = located;
    const accepted = await this.workflowControls.accept(
      {
        workflowRunId: record.id,
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        source: input.source,
        authorization: {
          workspaceId: this.opts.workspaceRoot,
          sessionId,
          workflowRunId: record.id,
          allowedCommandKinds: [input.command.kind],
        },
        expected: {
          generation:
            input.expected?.generation ?? store.canonicalGeneration(record.id),
          status: input.expected?.status ?? record.status,
          ...(input.expected?.waitId
            ? { waitId: input.expected.waitId }
            : record.wait?.id
              ? { waitId: record.wait.id }
              : {}),
        },
        command: input.command,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      },
      { trustedSystemSource: input.source.kind === "system" },
    );
    if (accepted.status === "conflict") {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow control idempotency conflict: ${accepted.commandId}`,
        },
      };
    }
    return this.processAcceptedWorkflowControl(accepted.envelope);
  }

  async processAcceptedWorkflowControl(
    envelope: WorkflowControlCommandEnvelope,
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
    const located = await this.findWorkflowRunRecord(
      envelope.workflowRunId,
      envelope.authorization.sessionId,
    );
    if (!located.ok) return located;
    const { record, store, sessionId } = located;
    return this.workflowControlDispatcher.dispatch(
      envelope.commandId,
      async () => {
        if (
          this.active?.workflowRunId === record.id &&
          this.active.processWorkflowControls
        ) {
          await this.active.processWorkflowControls();
        }
        const existingOutcome = await this.workflowControls.outcome(
          record.id,
          envelope.commandId,
        );
        if (existingOutcome) {
          return {
            ok: true,
            status: existingOutcome.status,
            commandId: existingOutcome.commandId,
            code: existingOutcome.code,
          };
        }
        const processor = new WorkflowControlCommandProcessor({
          inbox: this.workflowControls,
          store,
          workspaceId: this.opts.workspaceRoot,
          owner: workflowLeaseOwner(),
          leaseTtlMs: WORKFLOW_LEASE_TTL_MS,
        });
        const processed = await processor.processNext(
          record.id,
          envelope.commandId,
        );
        if (processed.status === "dispatch_required") {
          if (this.currentExecution) {
            return {
              ok: true,
              status: "accepted",
              commandId: processed.envelope.commandId,
              code: "dispatch_waiting",
            };
          }
          const execution = this.beginExecution();
          try {
            const resumed = await this.resumeWorkflowRunInner({
              workflowRunId: record.id,
              sessionId,
            });
            await processor.completeDispatch(processed.envelope, {
              applied: resumed.ok,
              code: resumed.ok ? "resume_dispatched" : resumed.error.code,
              ...(!resumed.ok ? { message: resumed.error.message } : {}),
            });
            return resumed.ok
              ? {
                  ok: true,
                  status: "applied",
                  commandId: processed.envelope.commandId,
                  code: "resume_dispatched",
                  runId: resumed.runId,
                }
              : resumed;
          } finally {
            this.releaseUnstartedExecution(execution);
          }
        }
        if (processed.status === "terminal") {
          return {
            ok: true,
            status: processed.outcome.status,
            commandId: processed.outcome.commandId,
            code: processed.outcome.code,
          };
        }
        return {
          ok: true,
          status: processed.status === "busy" ? "accepted" : processed.status,
          commandId: envelope.commandId,
          ...(processed.status === "busy" ? { code: "consumer_busy" } : {}),
        };
      },
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
    const located = await this.findWorkflowRunRecord(
      input.workflowRunId as WorkflowRunId,
      input.sessionId,
    );
    if (!located.ok) return located;
    const envelope = this.workflowControls
      .snapshot(located.record.id)
      .commands.find((candidate) => candidate.commandId === input.commandId);
    if (!envelope) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Durable workflow control command was not found: ${input.commandId}`,
        },
      };
    }
    return this.processAcceptedWorkflowControl(envelope);
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
      return await this.resumeWorkflowRunThroughControl(payload, source);
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
    if (writer.workflowRunId !== payload.workflowRunId) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message:
            "Claimed workflow writer identity does not match the resume request.",
        },
      };
    }
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

  private async resumeWorkflowRunThroughControl(
    payload: WorkflowResumeRequestPayload,
    source: WorkflowControlSourceIdentity,
  ): Promise<
    | { ok: true; runId: string; workflowRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    const located = await this.findWorkflowRunRecord(
      payload.workflowRunId as WorkflowRunId,
      payload.sessionId,
    );
    if (!located.ok) return located;
    const { record, store, sessionId } = located;
    const idempotencyKey =
      typeof payload.metadata?.controlIdempotencyKey === "string"
        ? payload.metadata.controlIdempotencyKey
        : `workflow-resume-${randomUUID()}`;
    const accepted = await this.workflowControls.accept({
      workflowRunId: record.id,
      idempotencyKey,
      source,
      authorization: {
        workspaceId: this.opts.workspaceRoot,
        sessionId,
        workflowRunId: record.id,
        allowedCommandKinds: ["resume_request"],
      },
      expected: {
        generation: store.canonicalGeneration(record.id),
        status: record.status,
        ...(record.wait?.id ? { waitId: record.wait.id } : {}),
      },
      command: {
        kind: "resume_request",
        ...(record.wait?.id ? { waitId: record.wait.id } : {}),
      },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    });
    if (accepted.status === "conflict") {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow control idempotency conflict: ${accepted.commandId}`,
        },
      };
    }
    const processor = new WorkflowControlCommandProcessor({
      inbox: this.workflowControls,
      store,
      workspaceId: this.opts.workspaceRoot,
      owner: workflowLeaseOwner(),
      leaseTtlMs: WORKFLOW_LEASE_TTL_MS,
    });
    const processed = await processor.processNext(
      record.id,
      accepted.envelope.commandId,
    );
    if (processed.status === "terminal") {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message:
            processed.outcome.message ??
            `Workflow control command ${processed.outcome.code}.`,
        },
      };
    }
    if (processed.status !== "dispatch_required") {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: `Workflow control command is ${processed.status}.`,
        },
      };
    }
    const resumed = await this.resumeWorkflowRunInner({
      ...payload,
      workflowRunId: processed.envelope.workflowRunId,
      sessionId,
    });
    await processor.completeDispatch(processed.envelope, {
      applied: resumed.ok,
      code: resumed.ok ? "resume_dispatched" : resumed.error.code,
      ...(!resumed.ok ? { message: resumed.error.message } : {}),
    });
    return resumed;
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
    const workspaceLeaseCoordinator =
      this.opts.workspaceLeaseCoordinator ?? processWorkspaceLeaseCoordinator;
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
      await this.recordCapabilityIndexFailure({
        goal: input.goal,
        sessionId: input.sessionId,
        sessionRootDir,
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
    const profileCollisions: AgentProfileCollision[] = [];
    const resolvedProfiles = await resolveAgentProfiles(
      workspaceRoot,
      agentConfig?.profiles,
      (collision) => profileCollisions.push(collision),
    );
    emitAgentProfileCollisionWarnings(
      pendingExtensionEvents,
      profileCollisions,
    );
    const delegateToolCollisions: DelegateToolCollision[] = [];
    const delegationTargets = resolveAgentDelegateTools(
      resolvedProfiles,
      agentConfig?.delegateTools,
      {
        includeAllChildProfiles: true,
        onCollision: (collision) => delegateToolCollisions.push(collision),
      },
    );
    emitDelegateToolCollisionWarnings(
      pendingExtensionEvents,
      delegateToolCollisions,
    );
    const delegateRouting = evaluateDelegateRouting({
      goal: input.goal,
      delegates: delegationTargets,
      profiles: resolvedProfiles,
    });
    emitDelegateRoutingEvaluated(
      pendingExtensionEvents,
      delegateRouting.evaluations,
    );
    const traceLevel =
      input.traceLevel ?? loadedConfig.config.traceLevel ?? "standard";
    const mainAgent = applyConfiguredRunBudget(
      mainAgentProfile(resolvedProfiles),
      loadedConfig.config.runBudget,
      loadedConfig.config.maxSteps,
    );
    const toolConfig = applyMainAgentToolUse(baseToolConfig, mainAgent);
    const parentRunPolicy = createHostRunPolicy({
      permissionMode: runAccess.permissionMode,
      shouldWrite: runAccess.shouldWrite,
      targetPath: input.targetPath,
      confidentialPaths,
      confidentialDefaults,
      writeGuardrails,
    });
    const dynamicChildToolCatalog = createDynamicChildToolCatalog({
      workspaceRoot,
      toolConfig,
      workspaceLeaseCoordinator,
    });
    const delegateChildToolCatalog = createConfiguredDelegateChildToolCatalog({
      workspaceRoot,
      toolConfig,
      shell: shellConfig,
      skillRoots: skillRoots.map((root) => root.root),
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
      workspaceLeaseCoordinator,
    });
    const derivedAgents = deriveConfiguredAgents(
      mainAgent,
      resolvedProfiles,
      delegateChildToolCatalog,
      pendingExtensionEvents,
    );
    const sessionStore = resources.sessionStore;
    const childRunStoreFactory = (childAgentId: string) =>
      createSessionRunStoreFactory({
        sessionStore,
        sessionId: input.sessionId,
        runStoreFactory: createSessionFileRunStoreFactory({
          sessionRootDir,
          sessionId: input.sessionId,
          agentId: childAgentId,
          traceLevel,
        }),
        metadata: { source: "host" },
      });
    const dynamicChildTools = catalogToolDefinitions(dynamicChildToolCatalog);
    const delegateChildTools = catalogToolDefinitions(delegateChildToolCatalog);
    const dynamicSpawnModel = createLazyModelAdapterResolver({
      modelRef: agentConfig?.spawnModel,
      parentModelRef: model.resolved.modelRef,
      parentModel: model.adapter,
      goal: input.goal,
      workspaceRoot,
      ...(input.targetPath ? { targetPath: input.targetPath } : {}),
      label: "spawn_agent model",
    });
    const delegateModelForProfile = createInProcessDelegateModelResolver({
      delegates: delegateRouting.delegates,
      derivedAgents,
      delegateModelRef: agentConfig?.delegateModel,
      parentModelRef: model.resolved.modelRef,
      parentModel: model.adapter,
      goal: input.goal,
      workspaceRoot,
      ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    });
    const delegateWorkflowHooksForProfile =
      createInProcessDelegateHooksResolver({
        delegates: delegateRouting.delegates,
        derivedAgents,
        workspaceRoot,
        sandbox: shellConfig?.sandbox,
        http: hookConfig?.http,
        skillRoots: skillRoots.map((root) => root.root),
        configPaths: loadedConfig.attempted.map((entry) => entry.path),
      });
    const allDelegateTools = createConfiguredDelegateTools({
      getParent: () => parentRunRef.current,
      delegates: delegateRouting.delegates,
      derivedAgents,
      model: model.adapter,
      modelForProfile: delegateModelForProfile,
      workflowHooksForProfile: delegateWorkflowHooksForProfile,
      childTools: delegateChildTools,
      workspaceRoot,
      parentRunPolicy,
      interactionChannel,
      sandbox: shellConfig?.sandbox,
      skillRoots: skillRoots.map((root) => root.root),
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
      childRunStoreFactory,
      allowReadWriteWorkspaceAccess: runAccess.shouldWrite,
      maxDepth: agentConfig?.maxDepth,
      workspaceLeaseCoordinator,
    });
    const directDelegates = filterDirectDelegatesForExposure(
      delegateRouting.delegates,
      agentConfig,
      resolvedProfiles,
    );
    const directDelegateNames = new Set(
      directDelegates.map((delegate) => delegateToolName(delegate)),
    );
    const delegateTools = allDelegateTools.filter((tool) =>
      directDelegateNames.has(tool.name),
    );
    const delegateAgentTool = createDelegateAgentTool({
      delegates: delegateRouting.delegates,
      derivedAgents,
      delegateTools: allDelegateTools,
    });
    const delegateParallelTool = shouldExposeDelegateParallelTool({
      enabled: agentConfig?.enableParallelDelegates,
      delegates: directDelegates,
      emitter: pendingExtensionEvents,
    })
      ? createDelegateParallelTool({
          getParent: () => parentRunRef.current,
          delegates: delegateRouting.delegates,
          derivedAgents,
          model: model.adapter,
          modelForProfile: delegateModelForProfile,
          workflowHooksForProfile: delegateWorkflowHooksForProfile,
          childTools: delegateChildTools,
          parentRunPolicy,
          interactionChannel,
          childRunStoreFactory,
          allowReadWriteWorkspaceAccess: runAccess.shouldWrite,
          maxDepth: agentConfig?.maxDepth,
          workspaceRoot,
          workspaceLeaseCoordinator,
        })
      : undefined;
    const delegateDescriptors = describeConfiguredDelegateTools({
      delegates: delegateRouting.delegates,
      derivedAgents,
      delegateChildToolCatalog,
      allowReadWriteWorkspaceAccess: runAccess.shouldWrite,
      routingByProfileId: delegateRouting.routingByProfileId,
    });
    const subagentMaxDepth = agentConfig?.maxDepth;
    const dynamicSpawnTool = createDynamicSpawnAgentTool({
      getParent: () => parentRunRef.current,
      model: model.adapter,
      modelForSpawn: dynamicSpawnModel,
      childTools: dynamicChildTools,
      parentRunPolicy,
      childRunStoreFactory,
      maxDepth: subagentMaxDepth,
      foregroundTimeoutMs:
        shellConfig?.foregroundTimeoutMs ?? RECOMMENDED_FOREGROUND_TIMEOUT_MS,
      taskManager: this.taskManager,
      backgroundTasks: runAccess.backgroundTasks,
      workspaceRoot,
      workspaceLeaseCoordinator,
    });
    // This tool bundle captures one immutable execution context. The inline
    // runner is stored on the Task at creation, so a later run preparation
    // cannot replace the model, policy, session, store, or lease dependencies
    // observed by delayed background Agent work.
    const agentTaskDeps: HostAgentTaskRunnerDeps = {
      getParent: () => parentRunRef.current,
      model: model.adapter,
      modelForSpawn: dynamicSpawnModel,
      childTools: dynamicChildTools,
      parentRunPolicy,
      childRunStoreFactory,
      maxDepth: subagentMaxDepth,
      sessionId: input.sessionId,
      workspaceRoot,
      taskManager: this.taskManager,
      backgroundTasks: runAccess.backgroundTasks,
      foregroundTimeoutMs:
        shellConfig?.foregroundTimeoutMs ?? RECOMMENDED_FOREGROUND_TIMEOUT_MS,
      workspaceLeaseCoordinator,
    };
    const baseMainToolCatalog = createMainHostToolCatalog({
      workspaceRoot,
      skillRoots: [...skillRoots],
      toolConfig,
      taskManager: this.taskManager,
      taskRunners: {
        agent: (controller, payload) =>
          runHostAgentTask(controller, payload, agentTaskDeps),
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
    const workflows = await loadLayeredWorkflowAssets(workspaceRoot);
    const selectedWorkflow = input.workflowRecord
      ? undefined
      : input.workflowName
        ? workflows.assets.find(
            (asset) => asset.assetName === input.workflowName,
          )
        : undefined;
    if (!input.workflowRecord && input.workflowName && !selectedWorkflow) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow "${input.workflowName}" was not found.`,
        },
      };
    }
    const pinnedWorkflow = selectedWorkflow
      ? await pinWorkflowAssetPackage({
          asset: selectedWorkflow,
          snapshotRoot: join(this.workflowStoreRootDir(), "package-snapshots"),
        })
      : undefined;
    const workflowDefinition =
      input.workflowRecord?.definitionSnapshot ??
      pinnedWorkflow?.asset.definition;
    if (
      input.workflowRecord &&
      (!workflowDefinition ||
        !input.workflowRecord.packageHash ||
        !input.workflowRecord.packageSnapshotRef)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow run "${input.workflowRecord.id}" does not contain an executable package snapshot.`,
        },
      };
    }
    if (input.workflowRecord && workflowDefinition) {
      try {
        await verifyWorkflowPackageSnapshot({
          packageSnapshotRef: input.workflowRecord.packageSnapshotRef!,
          packageHash: input.workflowRecord.packageHash!,
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "invalid_payload",
            message: `Workflow run "${input.workflowRecord.id}" executable package snapshot is invalid: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        };
      }
      if (
        workflowDefinition.sourceDir !== input.workflowRecord.packageSnapshotRef
      ) {
        return {
          ok: false,
          error: {
            code: "invalid_payload",
            message: `Workflow run "${input.workflowRecord.id}" definition does not execute from its package snapshot.`,
          },
        };
      }
    }
    const workflowModelAdapters = workflowDefinition
      ? await resolveWorkflowModelAdapters({
          definition: workflowDefinition,
          parentModelRef: model.resolved.modelRef,
          goal: input.goal,
          workspaceRoot,
          targetPath: input.targetPath,
        })
      : { ok: true as const, adapters: new Map() };
    if (!workflowModelAdapters.ok) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: workflowModelAdapters.message,
        },
      };
    }
    const workflowStore = workflowDefinition
      ? (input.workflowStore ??
        new FileWorkflowStore({
          rootDir: this.workflowStoreRootDir(),
        }))
      : undefined;
    let workflowRecord = input.workflowRecord;
    let workflowLease = input.workflowLease;
    let acquiredWorkflowLease = false;
    let workflowRollbackRecord: WorkflowRunRecord | undefined;
    let workflowProjection:
      | ReturnType<typeof createWorkflowProjectionHooks>
      | undefined;
    try {
      if (
        workflowStore &&
        workflowRecord?.status === "waiting" &&
        input.workflowWaitingInputMetadata !== undefined
      ) {
        workflowRollbackRecord = workflowRecord;
        workflowRecord = await consumeWorkflowActorWaitingInput(
          workflowLease,
          workflowRecord,
          { metadata: input.workflowWaitingInputMetadata },
        );
        if (isTerminalWorkflowRunStatus(workflowRecord.status)) {
          const terminalStatus = workflowRecord.status;
          const rollbackWorkflowRunId = workflowRollbackRecord.id;
          workflowRecord = await compensateWorkflowRecord(
            workflowLease,
            workflowRecord,
            workflowRollbackRecord,
            "workflow_resume_terminal_after_input",
          );
          workflowRollbackRecord = undefined;
          return {
            ok: false,
            error: {
              code: "invalid_payload",
              message: `Workflow run ${rollbackWorkflowRunId} would reach ${terminalStatus} while consuming waiting input.`,
            },
          };
        }
      }
      workflowProjection = workflowDefinition
        ? createWorkflowProjectionHooks({
            definition: workflowDefinition,
            workflowRunId: input.workflowRecord?.id ?? input.workflowRunId,
            initialState: input.workflowRecord
              ? runtimeStateFromWorkflowRecord(input.workflowRecord)
              : undefined,
            resumeVerificationNodeIds:
              input.workflowRecord?.resume.verifyOnResume === true
                ? completedWorkflowNodeIds(
                    input.workflowRecord,
                    workflowDefinition,
                  )
                : [],
            onStateSnapshot: async (snapshot) => {
              if (!workflowLease || !workflowRecord) return;
              const latestRecord =
                (await workflowLease.readFresh()) ?? workflowRecord;
              workflowRecord = await persistWorkflowProjectionSnapshot(
                workflowLease,
                latestRecord,
                snapshot,
              );
              this.deliverWorkflowNotification(workflowRecord);
            },
            workspaceRoot,
            sandbox: shellConfig?.sandbox,
            http: hookConfig?.http,
            skillRoots: skillRoots.map((root) => root.root),
            configPaths: loadedConfig.attempted.map((entry) => entry.path),
            getRun: () => parentRunRef.current,
            getEvidenceRefs: (nodeId) =>
              (workflowRecord?.evidenceRefs ?? []).filter(
                (ref) => ref.nodeId === nodeId,
              ),
            readTodoLedger: () =>
              readTodoLedger(join(sessionRootDir, input.sessionId, "todo.md")),
            runEndTerminalOwner: "episode_chain",
            allowScriptWrite: runAccess.shouldWrite,
            agentTool: delegateAgentTool,
            delegateParallelTool: tools.find(
              (tool) => tool.name === DELEGATE_PARALLEL_TOOL_NAME,
            ),
            taskTool: tools.find((tool) => tool.name === "task_create"),
            isToolAvailable: (toolName) =>
              parentRunRef.current?.tools.get(toolName) !== undefined,
            isScopedToolSearchAvailable: () =>
              isWorkflowScopedToolSearch(
                parentRunRef.current?.tools.get(DISCOVERY_TOOL_NAME),
              ),
          })
        : undefined;
      if (workflowProjection && workflowDefinition && workflowStore) {
        const projectedState = workflowProjection.getState();
        if (!workflowRecord) {
          const workflowRunId =
            workflowProjection.workflowRunId as WorkflowRunId;
          const acquiredLease = await workflowStore.acquireWriter(
            workflowRunId,
            {
              owner: workflowLeaseOwner(),
              ttlMs: WORKFLOW_LEASE_TTL_MS,
            },
          );
          if (!acquiredLease) {
            return {
              ok: false,
              error: {
                code: "invalid_payload",
                message: `Workflow run ${workflowRunId} is already adopted by another writer.`,
              },
            };
          }
          workflowLease = acquiredLease;
          acquiredWorkflowLease = true;
          workflowRecord = await acquiredLease.create({
            id: workflowRunId,
            assetName: workflowDefinition.assetName,
            ...(pinnedWorkflow?.asset.layer
              ? { layer: pinnedWorkflow.asset.layer }
              : {}),
            ...(workflowDefinition.version
              ? { version: workflowDefinition.version }
              : {}),
            contentHash: workflowDefinition.contentHash,
            ...(workflowDefinition.packageHash
              ? { packageHash: workflowDefinition.packageHash }
              : {}),
            ...(workflowDefinition.packageHashPolicyVersion
              ? {
                  packageHashPolicyVersion:
                    workflowDefinition.packageHashPolicyVersion,
                }
              : {}),
            ...(workflowDefinition.packageSnapshotRef
              ? { packageSnapshotRef: workflowDefinition.packageSnapshotRef }
              : {}),
            sessionId: input.sessionId,
            currentNodeId: projectedState.currentNodeId,
            attempts: projectedState.attempts,
            transitionLog: projectedState.transitionLog,
            authorizationSnapshot: {
              ...(input.targetPath ? { targetPath: input.targetPath } : {}),
              confidentialPaths: [...(confidentialPaths ?? [])],
              confidentialDefaults: confidentialDefaults ?? true,
              accessMode: runAccess.accessMode,
              backgroundTasks: runAccess.backgroundTasks,
            },
            definitionSnapshot: workflowDefinition,
            metadata: {
              goal: input.goal,
              verifyOnResume: true,
              ...(input.workflowRunId &&
              typeof input.runMetadata?.serviceHandoffId === "string"
                ? {
                    serviceHandoffId: input.runMetadata.serviceHandoffId,
                  }
                : {}),
              ...(input.controlSessionId
                ? { controlSessionId: input.controlSessionId }
                : {}),
            },
          });
        }
      }
    } catch (error) {
      if (workflowRollbackRecord && workflowStore) {
        workflowRecord = await compensateWorkflowRecord(
          workflowLease,
          workflowRecord ?? workflowRollbackRecord,
          workflowRollbackRecord,
          "workflow_resume_prepare_failed",
        );
      }
      if (acquiredWorkflowLease) {
        await workflowLease?.release().catch(() => {});
        workflowLease = undefined;
      }
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
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
    this.lastCapabilitySnapshot = buildCapabilitySnapshot({
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
              contentHash: workflowRecord.contentHash,
              ...(workflowRecord.packageHash
                ? { packageHash: workflowRecord.packageHash }
                : {}),
              ...(workflowRecord.packageHashPolicyVersion
                ? {
                    packageHashPolicyVersion:
                      workflowRecord.packageHashPolicyVersion,
                  }
                : {}),
              verifyOnResume: workflowRecord.resume.verifyOnResume,
            },
          }
        : {}),
      resolvedModel: model.resolved,
      capabilitySnapshot: summarizeCapabilitySnapshot(
        this.lastCapabilitySnapshot,
      ),
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
        workflowModelAdapters: workflowModelAdapters.adapters,
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

  private async recordCapabilityIndexFailure(input: {
    goal: string;
    sessionId: string;
    sessionRootDir: string;
    traceLevel: TraceLevel;
    message: string;
    source?: string;
    targetPath?: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const now = nowIso();
    const runId = createRunId();
    const run: RunRecord = {
      id: runId,
      goal: input.goal,
      state: "failed",
      stopReason: "model_completion_failed",
      createdAt: now,
      updatedAt: now,
      metadata: {
        source: "host",
        failurePhase: "capability_index",
        targetPath: input.targetPath ?? "README.md",
        ...input.metadata,
      },
    };
    const result: RunResult = {
      signal: "failed",
      state: "failed",
      stopReason: "model_completion_failed",
      message: input.message,
      failure: {
        category: "runtime",
        code: "SKILL_INDEX_FAILED",
        message: input.message,
        retryable: false,
      },
      metadata: run.metadata,
    };
    const sessionStore = new FileSessionStore({
      rootDir: input.sessionRootDir,
    });
    const store = createSessionRunStoreFactory({
      sessionStore,
      sessionId: input.sessionId,
      runStoreFactory: createSessionFileRunStoreFactory({
        sessionRootDir: input.sessionRootDir,
        sessionId: input.sessionId,
        agentId: MAIN_AGENT_ID,
        traceLevel: input.traceLevel,
      }),
      metadata: { source: "host" },
    })(run);
    const events = new EventLog(runId);
    const append = async (event: SparkwrightEvent) => {
      await store.append(event);
      this.opts.emit({
        envelope: "event",
        id: nextMessageId("evt"),
        kind: "run.event",
        timestamp: nowIso(),
        payload: { runId, event },
      });
    };
    await append(events.emit("run.created", { goal: input.goal }));
    await append(
      events.emit(
        "capability.index.failed",
        {
          kind: "skills",
          source: input.source,
          message: input.message,
          code: "SKILL_INDEX_FAILED",
        },
        {
          source: "host",
          failurePhase: "capability_index",
          agentId: MAIN_AGENT_ID,
        },
      ),
    );
    await append(
      events.emit("run.failed", {
        reason: "capability_index_failed",
        code: "SKILL_INDEX_FAILED",
        message: input.message,
        failure: result.failure,
        metadata: run.metadata,
      }),
    );
    await store.finish(run, result);
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

  // P3 Step 4a: actor-owned episode driver. The workflow/todo actor owns the
  // chain shape through runTodoSupervised -> runWorkflowRunChain; host creates
  // transient core runs and wires session/lease/event glue for each episode.
  private async startWorkflowActorEpisodeChain(input: {
    episodeKind: "run_start" | "run_resume" | "workflow_resume";
    env: PreparedHostRunEnvironment;
    sessionId: string;
    todoPath: string;
    buildRun: (
      supervisedInput: TodoSupervisedRunInput,
    ) => ReturnType<typeof createRun>;
    afterRun?: (
      supervisedInput: TodoSupervisedRunInput,
      run: ReturnType<typeof createRun>,
      result: RunResult,
    ) => void | Promise<void>;
  }): Promise<
    { ok: true; runId: string } | { ok: false; error: ProtocolError }
  > {
    const { env, sessionId, todoPath } = input;
    const execution = this.currentExecution ?? this.beginExecution();
    const executionAbort = execution.abortController;
    execution.bindSession(sessionId);
    const runCleanups: Array<() => void> = [];
    const stopWorkflowLeaseRefresh = startWorkflowLeaseRefresh(
      env.workflowLease,
    );
    execution.addCleanup(async () => {
      stopWorkflowLeaseRefresh();
      await env.workflowLease?.release().catch(() => {});
      env.workflowLease = undefined;
      for (const cleanup of runCleanups.splice(0)) cleanup();
      await env.preparedMcp?.close().catch(() => {});
    });
    if (executionAbort.signal.aborted) {
      await execution.disposeResources();
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: "interactive execution was cancelled during assembly",
        },
      };
    }
    const registerActiveRun = async (
      run: ReturnType<typeof createRun>,
      runId: string,
    ): Promise<SparkwrightEvent[]> => {
      env.parentRunRef.current = run;
      env.runIdHolder.value = runId;
      if (env.workflowLease && env.workflowRecord) {
        const episodeAllowedTools = workflowEpisodeAllowedTools(
          env.workflowRecord,
        );
        const episodeMetadata =
          workflowEpisodeMetadataFromRun(run) ??
          workflowActorEpisodeMetadata(
            workflowActorEpisodePlan(env, { purpose: "main_agent" }),
          );
        env.workflowRecord = await mutateWorkflowRecord(
          env.workflowLease,
          env.workflowRecord,
          {
            activeRunId: runId as RunId,
            appendRunId: runId as RunId,
            parentRunId: env.workflowRecord.parentRunId ?? (runId as RunId),
            evidenceRefs: appendWorkflowEvidenceRef(
              env.workflowRecord.evidenceRefs,
              { kind: "run", ref: runId },
            ),
            metadata: {
              activeRunId: runId,
              resumeRun: env.workflowRecord.runIds.length > 0,
              episodeDriver: "workflow_actor",
              episodeKind: input.episodeKind,
              workflowEpisode: episodeMetadata,
              ...(episodeAllowedTools
                ? { episodeAllowedTools: episodeAllowedTools.normalized }
                : {}),
            },
          },
        );
      }
      const closeEventHooks = bindConfiguredEventHooks({
        hooks: env.eventHookConfig,
        run,
        workspaceRoot: env.workspaceRoot,
        sandbox: env.hookSandbox,
        http: env.hookHttp,
        skillRoots: env.hookSkillRoots,
        configPaths: env.hookConfigPaths,
        getRun: () => env.parentRunRef.current,
        agentTool: env.delegateAgentTool,
      });
      runCleanups.push(closeEventHooks);
      this.active = {
        runId,
        run,
        trace: env.trace,
        sessionId,
        ...(env.workflowRecord
          ? {
              workflowRunId: env.workflowRecord.id,
              processWorkflowControls: async () => {
                if (
                  !env.workflowStore ||
                  !env.workflowLease ||
                  !env.workflowRecord
                )
                  return;
                const processor = new WorkflowControlCommandProcessor({
                  inbox: this.workflowControls,
                  store: env.workflowStore,
                  writer: env.workflowLease,
                  workspaceId: this.opts.workspaceRoot,
                });
                const result = await processor.processNext(
                  env.workflowRecord.id,
                );
                if (
                  result.status === "terminal" &&
                  result.outcome.status === "applied" &&
                  result.outcome.code === "applied" &&
                  env.workflowRecord.status !== "cancelled"
                ) {
                  const fresh = await env.workflowLease.readFresh();
                  if (fresh) env.workflowRecord = fresh;
                }
                if (env.workflowRecord.status === "cancelled") {
                  run.cancel({ reason: "workflow_control_cancel" });
                }
              },
            }
          : {}),
        closeCapabilities: async () => {
          closeEventHooks();
          await env.preparedMcp?.close();
        },
      };
      if (env.workflowRecord) {
        const controlTimer = setInterval(() => {
          void this.active?.processWorkflowControls?.().catch(() => {});
        }, 500);
        controlTimer.unref?.();
        runCleanups.push(() => clearInterval(controlTimer));
      }
      const collected: SparkwrightEvent[] = [];
      run.events.subscribe((event: SparkwrightEvent) => {
        env.trace.append(event);
        collected.push(event);
        this.opts.emit({
          envelope: "event",
          id: nextMessageId("evt"),
          kind: "run.event",
          timestamp: nowIso(),
          payload: { runId, event },
        });
      });
      run.events.subscribe((event: SparkwrightEvent) => {
        observeSkillUsageEvent(env.skillUsageRecorder, event);
      });
      env.pendingExtensionEvents.flush(run.events);
      return collected;
    };

    let resolveFirstRunId!: (id: string) => void;
    let rejectFirstRunId!: (err: unknown) => void;
    const firstRunId = new Promise<string>((resolve, reject) => {
      resolveFirstRunId = resolve;
      rejectFirstRunId = reject;
    });
    let firstRunStarted = false;
    let previousRunId: string | undefined;
    let lastRunId = "";
    let executionTerminalState: "completed" | "failed" | "cancelled" = "failed";

    const supervised = execution.runEpisodeChain({
      todoPath,
      sessionId,
      maxContinuations: MAIN_TODO_MAX_CONTINUATIONS,
      maxStalledContinuations: MAIN_TODO_MAX_STALLED_CONTINUATIONS,
      continuationToolAvailability: (requiredTool) => {
        const plan = workflowActorEpisodePlan(env, {
          fallbackRunBudget: resolveTodoContinuationRunBudget(env.mainAgent),
          purpose: "todo_continuation",
        }).toolSurface;
        const toolName = plan.missingRequiredTools.find(
          (name) => name === requiredTool,
        );
        return toolName
          ? {
              available: false as const,
              toolName,
              reason: "not admitted for this run episode",
            }
          : { available: true as const };
      },
      runOnce: async (supervisedInput) => {
        const run = input.buildRun(supervisedInput);
        const runId = run.record.id;
        lastRunId = runId;
        const collected = await registerActiveRun(run, runId);
        if (!firstRunStarted) {
          firstRunStarted = true;
          resolveFirstRunId(runId);
        } else if (supervisedInput.continuation) {
          this.opts.emit({
            envelope: "event",
            id: nextMessageId("evt"),
            kind: "run.continuation",
            timestamp: nowIso(),
            payload: {
              runId,
              previousRunId: previousRunId ?? runId,
              continuationCount:
                supervisedInput.continuation.metadata.continuationCount,
              reason: supervisedInput.continuation.metadata.reason,
            },
          });
        }
        const result = await run.start();
        previousRunId = runId;
        await input.afterRun?.(supervisedInput, run, result);
        await this.recordWorkflowActorEpisodeUsage(env, run, result);
        if (executionAbort.signal.aborted) {
          return {
            result: {
              ...result,
              state: "cancelled",
              stopReason: "manual_cancelled",
            },
            events: collected,
          };
        }
        return { result, events: collected };
      },
    });

    supervised
      .then(async (outcome) => {
        executionTerminalState =
          outcome.result.state === "cancelled"
            ? "cancelled"
            : outcome.result.state === "failed"
              ? "failed"
              : "completed";
        const handoff =
          !executionAbort.signal.aborted && outcome.decision.kind === "handoff"
            ? {
                reason: outcome.decision.reason,
                message: outcome.decision.message,
              }
            : undefined;
        await this.finalizeWorkflowRecordAfterRun(
          env,
          lastRunId as RunId,
          outcome.result,
        );
        this.opts.emit({
          envelope: "event",
          id: nextMessageId("evt"),
          kind: "run.completed",
          timestamp: nowIso(),
          payload: {
            runId: lastRunId,
            state: outcome.result.state,
            stopReason: outcome.result.stopReason,
            ...(outcome.result.metadata.outcome
              ? { outcome: outcome.result.metadata.outcome }
              : {}),
            ...(outcome.result.failure
              ? { failure: outcome.result.failure }
              : {}),
            ...(handoff ? { todoHandoff: handoff } : {}),
          },
        });
      })
      .catch((err: unknown) => {
        if (!firstRunStarted) rejectFirstRunId(err);
        const message = err instanceof Error ? err.message : String(err);
        const failure: RunFailureEnvelope = {
          category: "runtime",
          code: "internal_error",
          message,
        };
        return this.finalizeWorkflowRecordAfterSupervisorError(
          env,
          lastRunId ? (lastRunId as RunId) : undefined,
          err,
        ).finally(() => {
          this.opts.emit({
            envelope: "event",
            id: nextMessageId("evt"),
            kind: "run.failed",
            timestamp: nowIso(),
            payload: {
              runId: lastRunId,
              failure,
            },
          });
        });
      })
      .finally(async () => {
        await execution.disposeResources();
        this.active = null;
        execution.finish(
          executionAbort.signal.aborted ? "cancelled" : executionTerminalState,
        );
        if (this.currentExecution === execution) {
          this.currentExecution = null;
        }
        execution.denyPendingApprovals();
      });

    try {
      return { ok: true, runId: await firstRunId };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private async recordWorkflowActorEpisodeUsage(
    env: PreparedHostRunEnvironment,
    run: ReturnType<typeof createRun>,
    result: RunResult,
  ): Promise<void> {
    if (!env.workflowLease || !env.workflowRecord) return;
    const latest = await env.workflowLease.readFresh();
    if (!latest) return;
    const episode = workflowEpisodeMetadataFromRun(run);
    const usage = run.usage();
    env.workflowRecord = await mutateWorkflowRecord(env.workflowLease, latest, {
      metadata: appendWorkflowEpisodeUsage(latest.metadata, {
        runId: run.record.id,
        stopReason: result.stopReason,
        state: result.state,
        ...(episode ? { episode } : {}),
        usage,
      }),
    });
  }

  private async resumeRunInner(
    payload: RunResumeRequestPayload,
    resolvedSessionId?: string,
  ): Promise<
    | { ok: true; runId: string; resumedFromRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    const located = await this.findRunDir(payload.runId, payload.sessionId);
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
    await this.failOrphanedInProcessTasksForRun(payload.runId as RunId);

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

    const buildContinuationRun = (
      goal: string,
      extraContext: ContextItem[],
    ) => {
      const episode = workflowActorEpisodePlan(env, {
        fallbackRunBudget: resolveTodoContinuationRunBudget(env.mainAgent),
        purpose: "todo_continuation",
      });
      const runRef: { current?: ReturnType<typeof createRun> } = {};
      const taskBridge = this.createTaskRevivalBridge(
        () => runRef.current?.record.id,
      );
      const run = createRun({
        goal,
        context: [...(env.preparedSkills?.context ?? []), ...extraContext],
        workspace: env.workspace,
        interactionChannel: env.interactionChannel,
        policy: createHostRunPolicy({
          permissionMode,
          shouldWrite,
          targetPath: payload.targetPath,
          confidentialPaths: env.confidentialPaths,
          confidentialDefaults: env.confidentialDefaults,
          writeGuardrails: env.writeGuardrails,
        }),
        promptBuilder: buildAgentPromptBuilder({
          cwd: env.workspaceRoot,
          sessionId: resumeSessionId,
        }),
        tools: episode.toolSurface.tools,
        workflowHooks: env.workflowHooks,
        model: episode.model,
        maxSteps: resolveTodoContinuationMaxSteps(env.mainAgent),
        runBudget: episode.runBudget,
        metadata: workflowActorEpisodeRunMetadata(env.runMetadata, episode),
        notificationSources: [taskBridge.notificationSource],
        taskRevivalSource: taskBridge.taskRevivalSource,
        runStore: createSessionRunStoreFactory({
          sessionStore: env.sessionStore,
          sessionId: resumeSessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: env.sessionRootDir,
            sessionId: resumeSessionId,
            agentId: located.agentId,
            traceLevel: env.traceLevel,
          }),
          metadata: workflowActorEpisodeRunMetadata(
            env.runStoreMetadata,
            episode,
          ),
        }),
      });
      runRef.current = run;
      return run;
    };

    const chainTurns: ContextItem[] = [];
    const chainTurn = (
      role: "user" | "assistant",
      content: string,
      idSuffix: string,
    ): ContextItem => ({
      id: `ctx_resume_chain_${idSuffix}` as ContextItem["id"],
      type: role,
      content: content.trim(),
      metadata: { layer: "conversation", stability: "session" },
    });

    const started = await this.startWorkflowActorEpisodeChain({
      episodeKind: "run_resume",
      env,
      todoPath: join(env.sessionRootDir, resumeSessionId, "todo.md"),
      sessionId: resumeSessionId,
      buildRun: (supervisedInput) =>
        supervisedInput.continuation
          ? buildContinuationRun(supervisedInput.continuation.prompt, [
              ...chainTurns,
              supervisedInput.continuation.context,
            ])
          : (() => {
              const episode = workflowActorEpisodePlan(env, {
                fallbackRunBudget: env.mainAgent.runBudget,
                purpose: "main_agent",
              });
              const runRef: {
                current?: ReturnType<typeof resumeRunFromCheckpoint>;
              } = {};
              const taskBridge = this.createTaskRevivalBridge(
                () => runRef.current?.record.id,
              );
              const run = resumeRunFromCheckpoint(checkpoint, {
                force: payload.force,
                workspace: env.workspace,
                interactionChannel: env.interactionChannel,
                policy: createHostRunPolicy({
                  permissionMode,
                  shouldWrite,
                  targetPath: payload.targetPath,
                  confidentialPaths: env.confidentialPaths,
                  confidentialDefaults: env.confidentialDefaults,
                  writeGuardrails: env.writeGuardrails,
                }),
                promptBuilder: buildAgentPromptBuilder({
                  cwd: env.workspaceRoot,
                  sessionId: resumeSessionId,
                }),
                tools: episode.toolSurface.tools,
                model: episode.model,
                maxSteps: resolveWorkflowEpisodeMaxSteps(
                  env.mainAgent,
                  episode.runBudget,
                ),
                ...(episode.runBudget !== undefined
                  ? { runBudget: episode.runBudget }
                  : {}),
                metadata: workflowActorEpisodeRunMetadata(
                  env.runMetadata,
                  episode,
                ),
                notificationSources: [taskBridge.notificationSource],
                taskRevivalSource: taskBridge.taskRevivalSource,
                runStore: createSessionRunStoreFactory({
                  sessionStore: env.sessionStore,
                  sessionId: resumeSessionId,
                  runStoreFactory: createSessionFileRunStoreFactory({
                    sessionRootDir: env.sessionRootDir,
                    sessionId: resumeSessionId,
                    agentId: located.agentId,
                    traceLevel: env.traceLevel,
                  }),
                  metadata: workflowActorEpisodeRunMetadata(
                    env.runStoreMetadata,
                    episode,
                  ),
                }),
              });
              runRef.current = run;
              return run;
            })(),
      afterRun: (_supervisedInput, run, result) => {
        const runId = run.record.id;
        if (chainTurns.length === 0) {
          chainTurns.push(
            chainTurn("user", checkpoint.run.goal, `${runId}_goal`),
          );
        }
        if (result.message && result.message.trim().length > 0) {
          chainTurns.push(
            chainTurn("assistant", result.message, `${runId}_answer`),
          );
        }
      },
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
    const located = await this.findWorkflowRunRecord(
      payload.workflowRunId as WorkflowRunId,
      payload.sessionId,
    );
    if (!located.ok) return located;
    let { record } = located;
    const { store, sessionId } = located;
    if (isTerminalWorkflowRunStatus(record.status)) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow run ${record.id} is already ${record.status}.`,
        },
      };
    }
    if (
      !record.definitionSnapshot ||
      !record.packageHash ||
      !record.packageSnapshotRef
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow run ${record.id} does not contain an executable package snapshot.`,
        },
      };
    }
    const lease =
      claimedWriter ??
      (await store.acquireWriter(record.id, {
        owner: workflowLeaseOwner(),
        ttlMs: WORKFLOW_LEASE_TTL_MS,
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
          ? workflowWaitingInputMetadata(record, payload.metadata)
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
    const priorContext = await this.loadConversationHistory(
      env.sessionRootDir,
      sessionId,
    );
    const buildRun = (
      goal: string,
      extraContext: ContextItem[],
      todoContinuation = false,
    ) => {
      const episode = workflowActorEpisodePlan(env, {
        fallbackRunBudget: todoContinuation
          ? resolveTodoContinuationRunBudget(env.mainAgent)
          : env.mainAgent.runBudget,
        purpose: todoContinuation ? "todo_continuation" : "main_agent",
      });
      const runRef: { current?: ReturnType<typeof createRun> } = {};
      const taskBridge = this.createTaskRevivalBridge(
        () => runRef.current?.record.id,
      );
      const run = createRun({
        goal,
        context: [
          ...priorContext,
          ...(env.preparedSkills?.context ?? []),
          ...extraContext,
        ],
        workspace: env.workspace,
        interactionChannel: env.interactionChannel,
        policy: createHostRunPolicy({
          permissionMode,
          shouldWrite,
          targetPath: effectiveResumePayload.targetPath,
          confidentialPaths: env.confidentialPaths,
          confidentialDefaults: env.confidentialDefaults,
          writeGuardrails: env.writeGuardrails,
        }),
        promptBuilder: buildAgentPromptBuilder({
          cwd: env.workspaceRoot,
          sessionId,
        }),
        tools: episode.toolSurface.tools,
        workflowHooks: env.workflowHooks,
        model: episode.model,
        maxSteps: resolveWorkflowEpisodeMaxSteps(
          env.mainAgent,
          episode.runBudget,
        ),
        ...(episode.runBudget !== undefined
          ? { runBudget: episode.runBudget }
          : {}),
        metadata: workflowActorEpisodeRunMetadata(env.runMetadata, episode),
        notificationSources: [taskBridge.notificationSource],
        taskRevivalSource: taskBridge.taskRevivalSource,
        runStore: createSessionRunStoreFactory({
          sessionStore: env.sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: env.sessionRootDir,
            sessionId,
            agentId: "main",
            traceLevel: env.traceLevel,
          }),
          metadata: workflowActorEpisodeRunMetadata(
            env.runStoreMetadata,
            episode,
          ),
        }),
      });
      runRef.current = run;
      return run;
    };

    const started = await this.startWorkflowActorEpisodeChain({
      episodeKind: "workflow_resume",
      env,
      todoPath: join(env.sessionRootDir, sessionId, "todo.md"),
      sessionId,
      buildRun: (supervisedInput) =>
        supervisedInput.continuation
          ? buildRun(
              supervisedInput.continuation.prompt,
              [supervisedInput.continuation.context],
              true,
            )
          : buildRun(
              `Resume workflow ${record.assetName} at node ${record.currentNodeId ?? "(unknown)"}.`,
              [],
            ),
    });
    if (!started.ok) {
      if (record.status === "waiting") {
        const current = (await lease.readFresh()) ?? record;
        await compensateWorkflowRecord(
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

  private async findWorkflowRunRecord(
    workflowRunId: WorkflowRunId,
    sessionId?: string,
  ): Promise<
    | {
        ok: true;
        record: WorkflowRunRecord;
        store: FileWorkflowStore;
        sessionId: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    let requestedSessionId: string | undefined;
    try {
      assertSafeWorkflowRunId(workflowRunId);
      requestedSessionId = sessionId ? asSessionId(sessionId) : undefined;
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const workspaceStore = new FileWorkflowStore({
      rootDir: this.workflowStoreRootDir(),
      createRoot: false,
    });
    const workspaceRecord = workspaceStore.get(workflowRunId);
    if (
      !workspaceRecord ||
      (requestedSessionId && workspaceRecord.sessionId !== requestedSessionId)
    ) {
      return {
        ok: false,
        error: {
          code: "run_not_found",
          message: `Workflow run not found: ${workflowRunId}`,
        },
      };
    }
    const locatedSessionId = workspaceRecord.sessionId ?? requestedSessionId;
    if (!locatedSessionId) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow run ${workflowRunId} does not record a sessionId.`,
        },
      };
    }
    return {
      ok: true,
      record: workspaceRecord,
      store: workspaceStore,
      sessionId: locatedSessionId,
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
    const priorContext = await this.loadConversationHistory(
      env.sessionRootDir,
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

    // Build (but do not start) a main-agent run for `goal`, appending
    // `extraContext` after the skills context. Each call mints a fresh runId
    // and run dir; the todo supervisor calls this once per (re)try, so a
    // continuation is a new run that carries the prior run's todo ledger.
    const buildRun = (
      goal: string,
      extraContext: ContextItem[],
      overrides: { maxSteps?: number; runBudget?: RunBudget } = {},
    ) => {
      const episode = workflowActorEpisodePlan(env, {
        fallbackRunBudget: overrides.runBudget ?? env.mainAgent.runBudget,
        purpose: overrides.runBudget ? "todo_continuation" : "main_agent",
      });
      const runRef: { current?: ReturnType<typeof createRun> } = {};
      const taskBridge = this.createTaskRevivalBridge(
        () => runRef.current?.record.id,
      );
      const run = createRun({
        goal,
        context: [
          ...priorContext,
          ...(env.preparedSkills?.context ?? []),
          ...extraContext,
        ],
        workspace: env.workspace,
        interactionChannel: env.interactionChannel,
        policy: createHostRunPolicy({
          permissionMode,
          shouldWrite,
          targetPath: payload.targetPath,
          confidentialPaths: env.confidentialPaths,
          confidentialDefaults: env.confidentialDefaults,
          writeGuardrails: env.writeGuardrails,
        }),
        promptBuilder: buildAgentPromptBuilder({
          cwd: env.workspaceRoot,
          sessionId,
        }),
        tools: episode.toolSurface.tools,
        workflowHooks: env.workflowHooks,
        model: episode.model,
        // Bind the main agent on resources, not a leaked step count of 8: honor
        // the profile's RunBudget when set and derive the step ceiling from it.
        maxSteps:
          overrides.maxSteps ??
          resolveWorkflowEpisodeMaxSteps(env.mainAgent, episode.runBudget),
        ...(episode.runBudget !== undefined
          ? { runBudget: episode.runBudget }
          : {}),
        metadata: workflowActorEpisodeRunMetadata(env.runMetadata, episode),
        notificationSources: [taskBridge.notificationSource],
        taskRevivalSource: taskBridge.taskRevivalSource,
        runStore: createSessionRunStoreFactory({
          sessionStore: env.sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: env.sessionRootDir,
            sessionId,
            agentId: "main",
            traceLevel: env.traceLevel,
          }),
          metadata: workflowActorEpisodeRunMetadata(
            env.runStoreMetadata,
            episode,
          ),
        }),
      });
      runRef.current = run;
      return run;
    };

    // Conversation turns accumulated across this supervised chain. A
    // continuation is an in-context *resume*, not a cold restart: every turn so
    // far rides along as conversation history so the model keeps the scope and
    // findings it already had. Sizing this is the Compactor's concern, not the
    // continuation's — we always pass the full chain forward. See runOnce.
    const chainTurns: ContextItem[] = [];
    const chainTurn = (
      role: "user" | "assistant",
      content: string,
      idSuffix: string,
    ): ContextItem => ({
      id: `ctx_chain_${idSuffix}` as ContextItem["id"],
      type: role,
      content: content.trim(),
      metadata: { layer: "conversation", stability: "session" },
    });

    const started = await this.startWorkflowActorEpisodeChain({
      episodeKind: "run_start",
      env,
      todoPath: join(env.sessionRootDir, sessionId, "todo.md"),
      sessionId,
      buildRun: (supervisedInput) => {
        // The nudge stays the final user turn (current_request via `goal`); the
        // original goal and every prior turn ride along as conversation history
        // (chainTurns), so the continuation resumes with full context instead
        // of re-deriving from only the ledger. The ledger context item still
        // comes last as the durable, compaction-proof backstop.
        const goal = supervisedInput.continuation?.prompt ?? payload.goal;
        const extraContext = supervisedInput.continuation
          ? [
              ...(initialInputContext ? [initialInputContext] : []),
              ...chainTurns,
              supervisedInput.continuation.context,
            ]
          : initialInputContext
            ? [initialInputContext]
            : [];
        if (!supervisedInput.continuation) return buildRun(goal, extraContext);
        return buildRun(goal, extraContext, {
          maxSteps: resolveTodoContinuationMaxSteps(env.mainAgent),
          runBudget: resolveTodoContinuationRunBudget(env.mainAgent),
        });
      },
      afterRun: (_supervisedInput, run, result) => {
        const runId = run.record.id;
        // Accumulate this chain's conversation for the next continuation's
        // resume context: seed the original user goal once as the opening turn,
        // then append each run's final answer as an assistant turn.
        if (chainTurns.length === 0) {
          chainTurns.push(chainTurn("user", payload.goal, `${runId}_goal`));
        }
        if (result.message && result.message.trim().length > 0) {
          chainTurns.push(
            chainTurn("assistant", result.message, `${runId}_answer`),
          );
        }
      },
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

  private async findRunDir(
    runId: string,
    sessionId?: string,
  ): Promise<
    | { ok: true; runDir: string; sessionId?: string; agentId: string }
    | { ok: false; error: ProtocolError }
  > {
    if (!isSafePathSegment(runId)) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message:
            "runId must contain only letters, numbers, dot, underscore, or hyphen",
        },
      };
    }
    const sessionRootDir =
      this.opts.sessionRootDir ??
      defaultSessionRootDir(this.opts.workspaceRoot);
    if (sessionId) {
      let safeSessionId: string;
      try {
        safeSessionId = asSessionId(sessionId);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "invalid_payload",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      const agentsDir = join(sessionRootDir, safeSessionId, "agents");
      try {
        const agents = await readdir(agentsDir, { withFileTypes: true });
        for (const agent of agents) {
          if (!agent.isDirectory() || !isSafePathSegment(agent.name)) continue;
          const runDir = join(agentsDir, agent.name, "runs", runId);
          if (await isDirectory(runDir)) {
            return {
              ok: true,
              runDir,
              sessionId: safeSessionId,
              agentId: agent.name,
            };
          }
        }
      } catch {
        // handled by not-found below
      }
      return {
        ok: false,
        error: {
          code: "run_not_found",
          message: `run not found in session ${safeSessionId}: ${runId}`,
        },
      };
    }

    try {
      const sessions = await readdir(sessionRootDir, { withFileTypes: true });
      for (const session of sessions) {
        if (!session.isDirectory() || !isSafePathSegment(session.name))
          continue;
        const agentsDir = join(sessionRootDir, session.name, "agents");
        let agents;
        try {
          agents = await readdir(agentsDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const agent of agents) {
          if (!agent.isDirectory() || !isSafePathSegment(agent.name)) continue;
          const runDir = join(agentsDir, agent.name, "runs", runId);
          if (await isDirectory(runDir)) {
            return {
              ok: true,
              runDir,
              sessionId: session.name,
              agentId: agent.name,
            };
          }
        }
      }
    } catch {
      // handled by not-found below
    }

    return {
      ok: false,
      error: {
        code: "run_not_found",
        message: `Could not find run directory for ${runId} under ${this.opts.sessionRootDir ?? defaultSessionRootDir(this.opts.workspaceRoot)}.`,
      },
    };
  }

  /**
   * Build conversation-history context items from the prior runs of a session.
   * Each completed prior run contributes a user (goal) + assistant (final
   * message) pair, tagged for the "conversation" layer with session-stable
   * cache policy so the model sees the full multi-turn thread. New sessions
   * (no prior runs) yield an empty array. Missing/unreadable run files are
   * skipped rather than aborting the new run.
   */
  private async loadConversationHistory(
    sessionRootDir: string,
    sessionId: string,
  ): Promise<ContextItem[]> {
    const turns = await this.loadCompletedConversationTurns(
      sessionRootDir,
      sessionId,
    );
    const compact = await loadSessionCompactArtifact({
      sessionRootDir,
      sessionId,
    });
    if (turns.length === 0) {
      return compact
        ? [
            sessionCompactWarningContextItem(
              sessionId,
              `Session compact artifact ignored because no completed turns were available to anchor throughRunId ${compact.throughRunId}.`,
              { throughRunId: compact.throughRunId },
            ),
          ]
        : [];
    }

    const items: ContextItem[] = [];
    let startAt = 0;
    if (compact) {
      const compactedThrough = turns.findIndex(
        (turn) => turn.runId === compact.throughRunId,
      );
      if (compactedThrough >= 0) {
        items.push(sessionCompactArtifactToContextItem(compact));
        startAt = compactedThrough + 1;
      } else {
        items.push(
          sessionCompactWarningContextItem(
            sessionId,
            `Session compact artifact ignored because throughRunId ${compact.throughRunId} was not found in completed session turns.`,
            { throughRunId: compact.throughRunId },
          ),
        );
      }
    }

    for (const turn of turns.slice(startAt)) {
      items.push(...sessionTurnToContextItems(turn));
    }
    return items;
  }

  private async loadCompletedConversationTurns(
    sessionRootDir: string,
    sessionId: string,
  ): Promise<CompletedConversationTurn[]> {
    let runIds: RunId[];
    try {
      const store = new FileSessionStore({ rootDir: sessionRootDir });
      const session = await store.get(sessionId);
      runIds = session?.runIds ?? [];
    } catch {
      return [];
    }
    if (runIds.length === 0) return [];

    const traceFacts = await this.loadSessionTraceFacts(
      sessionRootDir,
      sessionId,
    );
    const runsDir = join(sessionRootDir, sessionId, "agents", "main", "runs");
    const turns: CompletedConversationTurn[] = [];
    for (const runId of runIds) {
      const goal = await this.readJsonField(
        join(runsDir, runId, "run.json"),
        "goal",
      );
      const message = await this.readJsonField(
        join(runsDir, runId, "result.json"),
        "message",
      );
      // A turn only counts toward history once it has both sides of the
      // exchange; a still-running or failed run with no final message is
      // skipped so we never thread a dangling half-turn.
      if (!goal || !message) continue;
      turns.push({ runId, goal, message, traceFacts: traceFacts.get(runId) });
    }
    return turns;
  }

  private async loadSessionTraceFacts(
    sessionRootDir: string,
    sessionId: string,
  ): Promise<Map<RunId, SessionTraceFacts>> {
    let events: SparkwrightEvent[];
    try {
      events = await loadTraceEventsFile(
        join(sessionRootDir, sessionId, "trace.jsonl"),
      );
    } catch {
      return new Map();
    }
    const byRun = new Map<RunId, SessionTraceFacts>();
    for (const event of events) {
      const runId = event.runId;
      if (!runId) continue;
      const facts = byRun.get(runId) ?? {};
      collectSessionTraceFact(facts, event);
      byRun.set(runId, facts);
    }
    return byRun;
  }

  private async inspectConfiguredCapabilities(input: {
    modelRef?: string;
    access: ResolvedRunAccess;
  }): Promise<CapabilitySnapshot> {
    const loadedConfig = await loadHostConfig(this.opts.workspaceRoot);
    const baseToolConfig = loadedConfig.config.tools;
    const shellConfig = loadedConfig.config.shell;
    const skillConfig = loadedConfig.config.capabilities?.skills;
    const mcpConfig = mergeRuntimeMcpConfig(
      loadedConfig.config.capabilities?.mcp,
      this.opts.extraMcpServers,
    );
    const agentConfig = loadedConfig.config.capabilities?.agents;
    const automation = await this.inspectAutomationSummary();
    const workflows = await loadLayeredWorkflowAssets(this.opts.workspaceRoot);
    const model = await inspectResolvedModelConfig({
      modelRef: input.modelRef ?? this.opts.defaultModel,
      workspaceRoot: this.opts.workspaceRoot,
    });
    const resolvedProfiles = await resolveAgentProfiles(
      this.opts.workspaceRoot,
      agentConfig?.profiles,
    );
    const delegationTargets = resolveAgentDelegateTools(
      resolvedProfiles,
      agentConfig?.delegateTools,
      {
        includeAllChildProfiles: true,
      },
    );
    const securityPlan = await prepareHostRunSecurityPlan({
      workspaceRoot: this.opts.workspaceRoot,
      access: input.access,
      loadedConfig,
    });
    const skillRoots = securityPlan.skillRoots;
    const shellSandbox = securityPlan.shellSandboxStatus;
    const mcpShellSandbox = securityPlan.shellSandbox;
    const existingPreparedSkillRoots = await existingSkillRoots(skillRoots);
    const preparedSkills =
      existingPreparedSkillRoots.length > 0
        ? await prepareSkillsForRun({
            goal: "",
            skillRoots: existingPreparedSkillRoots,
            agent: {
              allowedSkills: skillConfig?.allowedSkills,
              deniedSkills: skillConfig?.deniedSkills,
            },
            includeLoaderTool: skillConfig?.includeLoaderTool ?? true,
            loadSelectedSkills: false,
            resourceFileLimit: skillConfig?.resourceFileLimit,
            includeDevSkills: devSkillsEnabled(),
            agentId: MAIN_AGENT_ID,
          })
        : null;
    const preparedMcp = await createRuntimeMcpTools({
      config: mcpConfig,
      workspaceRoot: this.opts.workspaceRoot,
      shellSandbox: mcpShellSandbox,
    });
    try {
      const mainAgent = mainAgentProfile(resolvedProfiles);
      const toolConfig = applyMainAgentToolUse(baseToolConfig, mainAgent);
      const dynamicChildToolCatalog = createDynamicChildToolCatalog({
        workspaceRoot: this.opts.workspaceRoot,
        toolConfig,
      });
      const delegateChildToolCatalog = createConfiguredDelegateChildToolCatalog(
        {
          workspaceRoot: this.opts.workspaceRoot,
          toolConfig,
          shell: shellConfig,
          skillRoots: skillRoots.map((root) => root.root),
          configPaths: loadedConfig.attempted.map((entry) => entry.path),
        },
      );
      const derivedAgents = deriveConfiguredAgents(
        mainAgent,
        resolvedProfiles,
        delegateChildToolCatalog,
      );
      const dynamicChildTools = catalogToolDefinitions(dynamicChildToolCatalog);
      const delegateChildTools = catalogToolDefinitions(
        delegateChildToolCatalog,
      );
      const allDelegateTools = createConfiguredDelegateTools({
        getParent: () => undefined,
        delegates: delegationTargets,
        derivedAgents,
        model: {
          async complete() {
            return { message: "" };
          },
        },
        childTools: delegateChildTools,
        workspaceRoot: this.opts.workspaceRoot,
        parentRunPolicy: createDefaultPolicy(),
        sandbox: shellConfig?.sandbox,
        skillRoots: skillRoots.map((root) => root.root),
        configPaths: loadedConfig.attempted.map((entry) => entry.path),
        allowReadWriteWorkspaceAccess: input.access.shouldWrite,
        maxDepth: agentConfig?.maxDepth,
        // Snapshot only describes the tool; its body never runs here
        // (getParent returns undefined and the tool throws first).
        childRunStoreFactory: snapshotOnlyChildRunStoreFactory,
      });
      const directDelegates = filterDirectDelegatesForExposure(
        delegationTargets,
        agentConfig,
        resolvedProfiles,
      );
      const directDelegateNames = new Set(
        directDelegates.map((delegate) => delegateToolName(delegate)),
      );
      const delegateTools = allDelegateTools.filter((tool) =>
        directDelegateNames.has(tool.name),
      );
      const delegateAgentTool = createDelegateAgentTool({
        delegates: delegationTargets,
        derivedAgents,
        delegateTools: allDelegateTools,
      });
      const delegateParallelTool = shouldExposeDelegateParallelTool({
        enabled: agentConfig?.enableParallelDelegates,
        delegates: directDelegates,
      })
        ? createDelegateParallelTool({
            getParent: () => undefined,
            delegates: delegationTargets,
            derivedAgents,
            model: {
              async complete() {
                return { message: "" };
              },
            },
            childTools: delegateChildTools,
            parentRunPolicy: createDefaultPolicy(),
            childRunStoreFactory: snapshotOnlyChildRunStoreFactory,
            allowReadWriteWorkspaceAccess: input.access.shouldWrite,
            maxDepth: agentConfig?.maxDepth,
            workspaceRoot: this.opts.workspaceRoot,
          })
        : undefined;
      const dynamicSpawnTool = createDynamicSpawnAgentTool({
        getParent: () => undefined,
        model: {
          async complete() {
            return { message: "" };
          },
        },
        childTools: dynamicChildTools,
        parentRunPolicy: createDefaultPolicy(),
        childRunStoreFactory: snapshotOnlyChildRunStoreFactory,
        maxDepth: agentConfig?.maxDepth,
        workspaceRoot: this.opts.workspaceRoot,
      });
      const baseMainToolCatalog = createMainHostToolCatalog({
        workspaceRoot: this.opts.workspaceRoot,
        skillRoots: [...skillRoots],
        toolConfig,
        taskManager: this.taskManager,
        getParentRunId: () => "run_capability_snapshot" as RunId,
        todoPath: join(
          this.opts.sessionRootDir ??
            defaultSessionRootDir(this.opts.workspaceRoot),
          "capability_snapshot",
          "todo.md",
        ),
        preparedSkills,
        preparedMcp,
        delegateTools,
        delegateAgentTool,
        delegateParallelTool,
        dynamicSpawnTool,
        shell: shellConfig,
        backgroundTasks: input.access.backgroundTasks,
        configPaths: loadedConfig.attempted.map((entry) => entry.path),
      });
      const toolCatalog = admitToolsForAgentProfile(
        baseMainToolCatalog,
        mainAgent,
        (entry) => entry.definition,
        (entry, definition) => ({ ...entry, definition }),
      );
      return buildCapabilitySnapshot({
        ...(model.ok ? { model: modelCapabilitySummary(model.resolved) } : {}),
        access: input.access,
        toolCatalog,
        indexedSkills: preparedSkills?.indexedSkills ?? [],
        loadedSkills: [],
        skillInlineShell: inlineShellCapabilitySummary(
          skillConfig?.inlineShell,
          shellSandbox,
        ),
        mcpStatuses:
          preparedMcp?.statuses ??
          Object.fromEntries(
            (mcpConfig?.servers ?? []).map((server) => [
              server.name,
              server.enabled === false
                ? ({ status: "disabled" } as const)
                : ({ status: "configured" } as const),
            ]),
          ),
        mcpToolNameMap: preparedMcp?.toolNameMap ?? [],
        agentProfiles: capabilitySnapshotAgentProfiles(
          mainAgent,
          resolvedProfiles,
        ),
        delegateTools: describeConfiguredDelegateTools({
          delegates: delegationTargets,
          derivedAgents,
          delegateChildToolCatalog,
          allowReadWriteWorkspaceAccess: input.access.shouldWrite,
        }),
        shellSandbox,
        shellForegroundTimeoutMs:
          shellConfig?.foregroundTimeoutMs ?? RECOMMENDED_FOREGROUND_TIMEOUT_MS,
        shellPromotionAvailable: input.access.backgroundTasks === "enabled",
        workflowRules: describeActiveWorkflowRules({
          workflowHooks: loadedConfig.config.capabilities?.hooks?.workflow,
          verification: loadedConfig.config.capabilities?.verification,
        }),
        eventRules: describeActiveEventRules({
          eventHooks: loadedConfig.config.capabilities?.hooks?.events,
        }),
        workflows: workflowCapabilitySummary(workflows),
        automation,
      });
    } finally {
      await preparedMcp?.close();
    }
  }

  private async inspectAutomationSummary(): Promise<CapabilityAutomationSummary> {
    const cronRoot = defaultCronRoot();
    const taskRoot = this.taskRootDir();
    const cronJobs = await readCronJobsForSnapshot(cronRoot);
    const tasks = readTasksForSnapshot(taskRoot);
    return {
      cron: {
        rootDir: cronRoot,
        total: cronJobs.length,
        jobs: cronJobs.slice(0, 8),
      },
      tasks: {
        rootDir: taskRoot,
        total: tasks.length,
        tasks: tasks.slice(0, 8),
      },
    };
  }

  private async readJsonField(
    path: string,
    field: string,
  ): Promise<string | null> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      const value = parsed[field];
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  cancelRun(
    runId: string,
    reason?: string,
  ): { ok: true } | { ok: false; error: ProtocolError } {
    if (this.opts.executionCoordinator) {
      return this.opts.executionCoordinator.cancelRun(this, runId, reason);
    }
    return this.cancelRunDirect(runId, reason);
  }

  cancelRunDirect(
    runId: string,
    reason?: string,
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
    // Stop the whole supervised chain, not just this run: a cancel that races
    // a run's natural completion must still prevent further continuations.
    this.currentExecution.cancel(reason ?? "client requested cancel");
    return { ok: true };
  }

  injectRunMessage(
    runId: string,
    input: {
      content: string;
      parts?: readonly RunInputPart[];
      metadata?: Record<string, unknown>;
    },
  ): { ok: true } | { ok: false; error: ProtocolError } {
    if (this.opts.executionCoordinator) {
      return this.opts.executionCoordinator.injectRunMessage(
        this,
        runId,
        input,
      );
    }
    return this.injectRunMessageDirect(runId, input);
  }

  injectRunMessageDirect(
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
    let safeSessionId: string;
    try {
      safeSessionId = asSessionId(sessionId);
    } catch {
      return await compactHostSession({
        context: this.opts,
        sessionId,
        reason,
        manualLlm: options.llm === true,
        turns: [],
      });
    }
    const sessionRootDir =
      this.opts.sessionRootDir ??
      defaultSessionRootDir(this.opts.workspaceRoot);
    const turns = await this.loadCompletedConversationTurns(
      sessionRootDir,
      safeSessionId,
    );
    return await compactHostSession({
      context: this.opts,
      sessionId,
      reason,
      manualLlm: options.llm === true,
      turns,
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

function mainAgentProfile(profiles: AgentProfile[] | undefined): AgentProfile {
  return (
    profiles?.find(
      (profile) => profile.id === MAIN_AGENT_ID || profile.mode === "primary",
    ) ?? { id: MAIN_AGENT_ID, mode: "primary" }
  );
}

function capabilitySnapshotAgentProfiles(
  mainAgent: AgentProfile,
  profiles: readonly AgentProfile[],
): AgentProfile[] {
  const byId = new Map<string, AgentProfile>();
  byId.set(mainAgent.id, mainAgent);
  for (const profile of profiles) byId.set(profile.id, profile);
  return [...byId.values()];
}

function emitAgentProfileCollisionWarnings(
  emitter: EventEmitter,
  collisions: readonly AgentProfileCollision[],
): void {
  for (const collision of collisions) {
    const message = `Agent profile id collision for "${collision.id}": kept ${collision.keptSource}, dropped ${collision.droppedSource} (fail-closed).`;
    emitter.emit(
      "capability.index.failed",
      {
        kind: "agent_profile",
        source: collision.droppedSource,
        message,
        code: "AGENT_PROFILE_ID_COLLISION",
        severity: "warning",
        profileId: collision.id,
        keptSource: collision.keptSource,
        droppedSource: collision.droppedSource,
      },
      {
        source: "host",
        severity: "warning",
        failurePhase: "agent_profile_discovery",
        agentId: MAIN_AGENT_ID,
        profileId: collision.id,
      },
    );
  }
}

function emitDelegateToolCollisionWarnings(
  emitter: EventEmitter,
  collisions: readonly DelegateToolCollision[],
): void {
  for (const collision of collisions) {
    const message = `Delegate tool name collision for "${collision.toolName}": kept profile ${collision.conflictsWith}, dropped profile ${collision.profileId} (${collision.source}) (fail-closed).`;
    emitter.emit(
      "capability.index.failed",
      {
        kind: "delegate_tool",
        source: collision.source,
        message,
        code: "DELEGATE_TOOL_NAME_COLLISION",
        severity: "warning",
        toolName: collision.toolName,
        profileId: collision.profileId,
        conflictsWith: collision.conflictsWith,
        droppedSource: collision.source,
        keptSource: collision.conflictsWith,
      },
      {
        source: "host",
        severity: "warning",
        failurePhase: "delegate_tool_resolution",
        agentId: MAIN_AGENT_ID,
        profileId: collision.profileId,
        toolName: collision.toolName,
      },
    );
  }
}

function shouldExposeDelegateParallelTool(input: {
  enabled?: boolean;
  delegates: readonly CapabilityDelegateToolConfig[];
  emitter?: EventEmitter;
}): boolean {
  if (input.enabled !== true) return false;
  const conflictingDelegate = input.delegates.find(
    (delegate) => delegateToolName(delegate) === DELEGATE_PARALLEL_TOOL_NAME,
  );
  if (!conflictingDelegate) return true;
  const message = `Delegate tool name collision for "${DELEGATE_PARALLEL_TOOL_NAME}": built-in delegate_parallel was dropped because profile "${conflictingDelegate.profileId}" already owns that tool name (fail-closed).`;
  input.emitter?.emit(
    "capability.index.failed",
    {
      kind: "delegate_tool",
      source: "builtin",
      message,
      code: "DELEGATE_TOOL_NAME_COLLISION",
      severity: "warning",
      toolName: DELEGATE_PARALLEL_TOOL_NAME,
      profileId: conflictingDelegate.profileId,
      conflictsWith: conflictingDelegate.profileId,
      droppedSource: "builtin",
      keptSource: "profile",
    },
    {
      source: "host",
      severity: "warning",
      failurePhase: "delegate_tool_resolution",
      agentId: MAIN_AGENT_ID,
      profileId: conflictingDelegate.profileId,
      toolName: DELEGATE_PARALLEL_TOOL_NAME,
    },
  );
  return false;
}

function emitDelegateRoutingEvaluated(
  emitter: EventEmitter,
  evaluations: readonly DelegateRoutingEvaluation[],
): void {
  if (evaluations.length === 0) return;
  const relevantCount = evaluations.filter(
    (evaluation) => evaluation.relevance === "relevant",
  ).length;
  const lowCount = evaluations.length - relevantCount;
  emitter.emit(
    "agent.routing.evaluated",
    {
      mode: "sort",
      delegateCount: evaluations.length,
      relevantCount,
      lowCount,
      delegates: evaluations.map((evaluation) => ({
        toolName: evaluation.toolName,
        profileId: evaluation.profileId,
        relevance: evaluation.relevance,
        score: evaluation.score,
        matchedKeywords: evaluation.matchedKeywords,
        keywords: evaluation.keywords,
        reason: evaluation.reason,
      })),
    },
    {
      source: "host",
      agentId: MAIN_AGENT_ID,
      mode: "sort",
    },
  );
}

/** Profile `model` is typed `unknown`; accept it only as a non-empty string. */
function profileModelRef(profile: AgentProfile): string | undefined {
  return typeof profile.model === "string" && profile.model.trim().length > 0
    ? profile.model.trim()
    : undefined;
}

/**
 * Build a lazy model resolver for sub-agent scopes. Missing config and refs
 * equal to the parent model return the already-built parent adapter. Configured
 * refs are constructed on first use so a bad child-scope model fails that tool
 * call without preventing unrelated parent runs from starting.
 */
function createLazyModelAdapterResolver(input: {
  modelRef?: string;
  parentModelRef?: string;
  parentModel: ModelAdapter;
  goal: string;
  workspaceRoot: string;
  targetPath?: string;
  label: string;
}): () => Promise<ModelAdapter> {
  if (!input.modelRef || input.modelRef === input.parentModelRef) {
    return async () => input.parentModel;
  }
  const modelRef = input.modelRef;
  let cached: Promise<ModelAdapter> | undefined;
  return () => {
    cached ??= createModel({
      modelRef,
      goal: input.goal,
      workspaceRoot: input.workspaceRoot,
      ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    }).then((built) => {
      if (!built.ok) {
        throw new Error(`${input.label} "${modelRef}": ${built.message}`);
      }
      return built.adapter;
    });
    return cached;
  };
}

/**
 * Resolve configured in-process delegate models on call. Profile `model` wins,
 * then `capabilities.agents.delegateModel`, then the parent adapter. ACP and
 * external-command delegates are process-boundary integrations and never call
 * this parent-process adapter resolver.
 */
/** @internal Exported for focused host regression tests. */
export function createInProcessDelegateModelResolver(input: {
  delegates: readonly CapabilityDelegateToolConfig[];
  derivedAgents: readonly DerivedChildAgentProfile[];
  delegateModelRef?: string;
  parentModelRef?: string;
  parentModel: ModelAdapter;
  goal: string;
  workspaceRoot: string;
  targetPath?: string;
}): (profileId: string) => Promise<ModelAdapter | undefined> {
  const { byProfile, inProcessProfileIds } =
    inProcessDelegateProfileIndex(input);
  const byModelRef = new Map<string, Promise<ModelAdapter>>();
  return async (profileId: string) => {
    if (!inProcessProfileIds.has(profileId)) return undefined;
    const profile = byProfile.get(profileId);
    if (!profile) return undefined;
    const modelRef = profileModelRef(profile) ?? input.delegateModelRef;
    if (!modelRef || modelRef === input.parentModelRef) return undefined;
    let adapter = byModelRef.get(modelRef);
    if (!adapter) {
      adapter = createModel({
        modelRef,
        goal: input.goal,
        workspaceRoot: input.workspaceRoot,
        ...(input.targetPath ? { targetPath: input.targetPath } : {}),
      }).then((built) => {
        if (!built.ok) {
          throw new Error(built.message);
        }
        return built.adapter;
      });
      byModelRef.set(modelRef, adapter);
    }
    try {
      return await adapter;
    } catch (error) {
      throw new Error(
        `agent "${profileId}" model "${modelRef}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}

export type InProcessDelegateWorkflowHooksForProfile = (
  profileId: string,
  getRun: () => ReturnType<typeof createRun> | undefined,
  context?: { goal?: string; shouldWrite?: boolean },
) => WorkflowHook[] | undefined;

/** @internal Exported for focused host regression tests. */
export function createInProcessDelegateHooksResolver(input: {
  delegates: readonly CapabilityDelegateToolConfig[];
  derivedAgents: readonly DerivedChildAgentProfile[];
  workspaceRoot: string;
  sandbox?: ShellConfig["sandbox"];
  http?: CapabilityHooksConfig["http"];
  skillRoots?: readonly string[];
  configPaths?: readonly string[];
}): InProcessDelegateWorkflowHooksForProfile {
  const { byProfile, inProcessProfileIds } =
    inProcessDelegateProfileIndex(input);
  return (profileId, getRun, _context) => {
    if (!inProcessProfileIds.has(profileId)) return undefined;
    const profile = byProfile.get(profileId);
    const workflowHooks = profile?.hooks?.map(
      capabilityWorkflowHookFromAgentProfileHook,
    );
    const hooks = createConfiguredWorkflowHooks({
      hooks: workflowHooks,
      workspaceRoot: input.workspaceRoot,
      sandbox: input.sandbox,
      http: input.http,
      skillRoots: input.skillRoots,
      configPaths: input.configPaths,
      getRun,
    });
    return hooks.length > 0 ? hooks : undefined;
  };
}

function inProcessDelegateProfileIndex(input: {
  delegates: readonly CapabilityDelegateToolConfig[];
  derivedAgents: readonly DerivedChildAgentProfile[];
}): {
  byProfile: Map<string, AgentProfile>;
  inProcessProfileIds: Set<string>;
} {
  const byProfile = new Map(
    input.derivedAgents.map((derived) => [
      derived.effectiveProfile.id,
      derived.effectiveProfile,
    ]),
  );
  const inProcessProfileIds = new Set<string>();
  for (const delegate of input.delegates) {
    const profile = byProfile.get(delegate.profileId);
    if (!profile) continue;
    if (
      acpConfigFromAgentProfile(profile) ||
      externalCommandConfigFromAgentProfile(profile)
    ) {
      continue;
    }
    inProcessProfileIds.add(profile.id);
  }
  return { byProfile, inProcessProfileIds };
}

function capabilityWorkflowHookFromAgentProfileHook(
  hook: AgentProfileWorkflowHookConfig,
): CapabilityWorkflowHookConfig {
  return {
    name: hook.name,
    hook: hook.hook,
    action: hook.action,
    ...(hook.description !== undefined
      ? { description: hook.description }
      : {}),
    ...(hook.enabled !== undefined ? { enabled: hook.enabled } : {}),
    ...(hook.onError !== undefined ? { onError: hook.onError } : {}),
    ...(hook.frequency !== undefined ? { frequency: hook.frequency } : {}),
    ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
  };
}

/**
 * Apply the top-level `run` budget config to the main agent profile. An
 * explicit main agent profile (capabilities.agents) is more specific, so its
 * own `maxSteps`/`runBudget` win; the config values only fill the gaps. The
 * existing budget resolution (`resolveMainAgentMaxSteps`) then picks them up.
 */
function applyConfiguredRunBudget(
  profile: AgentProfile,
  runBudget: RunBudget | undefined,
  maxSteps: number | undefined,
): AgentProfile {
  if (runBudget === undefined && maxSteps === undefined) return profile;
  return {
    ...profile,
    ...(profile.maxSteps === undefined && maxSteps !== undefined
      ? { maxSteps }
      : {}),
    ...(profile.runBudget === undefined && runBudget !== undefined
      ? { runBudget }
      : {}),
  };
}

/**
 * Pure safety floor for the interactive main agent's step count, used only when
 * neither an explicit `maxSteps` nor a model-call budget is configured. It is a
 * backstop against a runaway loop the progress guard misses (the human can also
 * Ctrl-C), NOT a task budget — long-horizon work (auto-research, broad sweeps)
 * must not bind on it. See `docs/adr/0009-step-cap-unfit-for-long-horizon-agents.md`.
 */
const MAIN_AGENT_MAX_STEPS_BACKSTOP = 100;

/**
 * Resolve the main agent's step ceiling. An explicit profile `maxSteps` wins;
 * otherwise it is derived from the resource budget — a step consumes at least
 * one model call, so `runBudget.maxModelCalls` is the tightest natural step
 * bound and `RunBudget` enforces it precisely regardless. Only when neither is
 * configured does the high backstop apply. This keeps the binding limit on the
 * resource axis rather than a leaked step count of 8.
 */
function resolveMainAgentMaxSteps(profile: AgentProfile): number {
  if (profile.maxSteps !== undefined) return profile.maxSteps;
  const modelCallBudget = profile.runBudget?.maxModelCalls;
  if (modelCallBudget !== undefined && modelCallBudget >= 1) {
    return modelCallBudget;
  }
  return MAIN_AGENT_MAX_STEPS_BACKSTOP;
}

function resolveTodoContinuationMaxSteps(profile: AgentProfile): number {
  return Math.min(
    resolveMainAgentMaxSteps(profile),
    MAIN_TODO_CONTINUATION_MAX_STEPS,
  );
}

function resolveTodoContinuationRunBudget(profile: AgentProfile): RunBudget {
  return {
    ...(profile.runBudget ?? {}),
    maxModelCalls: minBudgetValue(
      profile.runBudget?.maxModelCalls,
      MAIN_TODO_CONTINUATION_MAX_MODEL_CALLS,
    ),
    maxToolCalls: minBudgetValue(
      profile.runBudget?.maxToolCalls,
      MAIN_TODO_CONTINUATION_MAX_TOOL_CALLS,
    ),
  };
}

function minBudgetValue(
  configured: number | undefined,
  continuationLimit: number,
): number {
  return configured === undefined
    ? continuationLimit
    : Math.min(configured, continuationLimit);
}

function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function deriveConfiguredAgents(
  parentAgent: AgentProfile,
  profiles: AgentProfile[],
  childToolCatalog: readonly HostToolCatalogEntry[],
  emitter?: EventEmitter,
): DerivedChildAgentProfile[] {
  return profiles
    .filter((profile) => profile.id !== parentAgent.id)
    .filter((profile) => {
      const mode = profile.mode;
      return mode === undefined || mode === "child" || mode === "all";
    })
    .map((childAgent) => {
      const derived = deriveChildAgentProfile({
        parentAgent,
        childAgent,
        emitter,
      });
      const effectiveProfile = applyAgentProfileToolUse(
        derived.effectiveProfile,
        childToolCatalog,
      );
      return {
        ...derived,
        effectiveProfile,
        effectiveToolCount: effectiveProfile.allowedTools?.length,
      };
    });
}

function applyMainAgentToolUse(
  config: CapabilityToolsConfig | undefined,
  profile: AgentProfile,
): CapabilityToolsConfig | undefined {
  if (profile.use === undefined) return config;
  return {
    ...(config ?? {}),
    use: intersectToolUseSelectors(config?.use, profile.use),
  };
}

function applyAgentProfileToolUse(
  profile: AgentProfile,
  childToolCatalog: readonly HostToolCatalogEntry[],
): AgentProfile {
  const selectorAllowed = resolveSelectorAllowlist(
    childToolCatalog,
    profile.use,
  );
  let allowedTools =
    selectorAllowed === undefined
      ? profile.allowedTools
      : intersectToolNameAllowlists(profile.allowedTools, selectorAllowed);
  allowedTools = includeDiscoveryForDeferredAllowedTools(
    allowedTools,
    childToolCatalog,
  );
  if (allowedTools !== undefined && profile.deniedTools?.length) {
    allowedTools = allowedTools.filter(
      (name) => !matchesAgentToolName(name, profile.deniedTools!),
    );
  }
  if (allowedTools === profile.allowedTools) return profile;
  return {
    ...profile,
    allowedTools,
  };
}

function includeDiscoveryForDeferredAllowedTools(
  allowedTools: readonly string[] | undefined,
  childToolCatalog: readonly HostToolCatalogEntry[],
): string[] | undefined {
  if (allowedTools === undefined) return undefined;
  if (allowedTools.includes(DISCOVERY_TOOL_NAME)) return [...allowedTools];
  const allowed = new Set(allowedTools);
  const allowsDeferred = childToolCatalog.some(
    (entry) =>
      entry.definition.name !== DISCOVERY_TOOL_NAME &&
      entry.definition.deferLoading === true &&
      allowed.has(entry.definition.name),
  );
  if (!allowsDeferred) return [...allowedTools];
  const hasDiscovery = childToolCatalog.some(
    (entry) => entry.definition.name === DISCOVERY_TOOL_NAME,
  );
  return hasDiscovery
    ? [...allowedTools, DISCOVERY_TOOL_NAME]
    : [...allowedTools];
}

function intersectToolNameAllowlists(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] | undefined {
  if (left === undefined) return right ? [...right] : undefined;
  if (right === undefined) return [...left];
  const rightSet = new Set(right);
  const out: string[] = [];
  for (const name of left) {
    if (rightSet.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Placeholder `childRunStoreFactory` for the capability-snapshot path, where
 * tools are only described (never invoked). If a snapshot-built spawn tool were
 * ever executed it would throw on missing parent first; this guards the
 * unreachable case loudly rather than silently dropping a child trace.
 */
const snapshotOnlyChildRunStoreFactory = (): ReturnType<
  typeof createSessionRunStoreFactory
> => {
  throw new Error(
    "spawn tool built for a capability snapshot cannot be executed.",
  );
};

const DELEGATE_PARALLEL_TOOL_NAME = "delegate_parallel";
const DELEGATE_PARALLEL_MAX_TASKS = 8;

function withDelegatedAgentContract(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    prompt: withDelegatedAgentPrompt(profile.prompt),
  };
}

function withDelegatedAgentPrompt(prompt?: string): string {
  const trimmed = prompt?.trim();
  return trimmed
    ? [trimmed, DELEGATED_AGENT_CONTRACT].join("\n\n")
    : DELEGATED_AGENT_CONTRACT;
}

interface DelegateParallelSpec {
  delegate: CapabilityDelegateToolConfig;
  profile: AgentProfile;
  childProfile: AgentProfile;
  toolName: string;
  profileChildTools: ToolDefinition[];
}

interface DelegateParallelTask {
  agentId: string;
  goal: string;
  metadata?: Record<string, unknown>;
}

interface DelegateParallelChildSummary {
  index: number;
  toolName: string;
  profileId: string;
  childRunId?: string;
  spanId?: string;
  signal: string;
  stopReason?: string;
  message?: string;
  stepLimitReached?: boolean;
  truncated?: boolean;
  tokens?: number;
  costUsd?: number;
  toolCalls?: number;
  modelCalls?: number;
  alreadyCompleted?: boolean;
  note?: string;
  error?: string;
}

function configuredDelegateLedgerKey(
  profileId: string,
  toolName: string,
): DelegationLedgerKey {
  return {
    kind: "configured_delegate",
    agentProfileId: profileId,
    delegateTool: toolName,
  };
}

function childWorkflowHookSpawnOptions(
  profileId: string,
  workflowHooksForProfile: InProcessDelegateWorkflowHooksForProfile | undefined,
  context?: { goal?: string; shouldWrite?: boolean },
): { workflowHooks?: WorkflowHook[]; createRun?: typeof createRun } {
  const childRunRef: { current?: ReturnType<typeof createRun> } = {};
  const workflowHooks = workflowHooksForProfile?.(
    profileId,
    () => childRunRef.current,
    context,
  );
  if (!workflowHooks?.length) return {};
  return {
    workflowHooks,
    createRun(options) {
      const child = createRun(options);
      childRunRef.current = child;
      return child;
    },
  };
}

export function createConfiguredDelegateTools(input: {
  getParent: () => ReturnType<typeof createRun> | undefined;
  delegates: CapabilityDelegateToolConfig[];
  derivedAgents: DerivedChildAgentProfile[];
  model: ModelAdapter;
  /**
   * Per-profile model override for in-process delegates. When it resolves an
   * adapter for a profile, the child runs on that model (honoring profile
   * `model` and configured defaults); otherwise the child reuses the parent
   * run's `model`.
   */
  modelForProfile?: (
    profileId: string,
  ) => ModelAdapter | Promise<ModelAdapter | undefined> | undefined;
  workflowHooksForProfile?: InProcessDelegateWorkflowHooksForProfile;
  childTools: ToolDefinition[];
  workspaceRoot: string;
  parentRunPolicy: Policy;
  interactionChannel?: InteractionChannel;
  sandbox?: Parameters<typeof createExternalCommandDelegateTool>[0]["sandbox"];
  skillRoots?: readonly string[];
  configPaths?: readonly string[];
  allowReadWriteWorkspaceAccess: boolean;
  maxDepth?: number;
  workspaceLeaseCoordinator?: WorkspaceLeaseCoordinator;
  /** Builds a session-scoped run store for the child, keyed by its agent id. */
  childRunStoreFactory: (
    childAgentId: string,
  ) => ReturnType<typeof createSessionRunStoreFactory>;
}): ToolDefinition[] {
  const byProfile = new Map(
    input.derivedAgents.map((derived) => [
      derived.effectiveProfile.id,
      derived.effectiveProfile,
    ]),
  );
  const tools: ToolDefinition[] = [];
  for (const delegate of input.delegates) {
    const profile = byProfile.get(delegate.profileId);
    if (!profile) continue;
    const toolName = delegateToolName(delegate);
    const acpConfig = acpConfigFromAgentProfile(profile);
    if (acpConfig) {
      tools.push(
        createAcpDelegateTool({
          getParent: input.getParent,
          profile,
          toolName,
          description: delegateToolDescription(delegate, profile),
          workspaceRoot: input.workspaceRoot,
          requiresApproval: delegate.requiresApproval,
          forbidNesting: delegate.forbidNesting ?? true,
          maxDepth: input.maxDepth,
          allowReadWriteWorkspaceAccess: input.allowReadWriteWorkspaceAccess,
          sandbox: input.sandbox,
          skillRoots: input.skillRoots,
          configPaths: input.configPaths,
          workspaceLeaseCoordinator: input.workspaceLeaseCoordinator,
        }),
      );
      continue;
    }
    const externalCommandConfig =
      externalCommandConfigFromAgentProfile(profile);
    if (externalCommandConfig) {
      tools.push(
        createExternalCommandDelegateTool({
          getParent: input.getParent,
          profile,
          toolName,
          description: delegateToolDescription(delegate, profile),
          workspaceRoot: input.workspaceRoot,
          requiresApproval: delegate.requiresApproval,
          forbidNesting: delegate.forbidNesting ?? true,
          maxDepth: input.maxDepth,
          allowReadWriteWorkspaceAccess: input.allowReadWriteWorkspaceAccess,
          sandbox: input.sandbox,
          skillRoots: input.skillRoots,
          configPaths: input.configPaths,
          workspaceLeaseCoordinator: input.workspaceLeaseCoordinator,
        }),
      );
      continue;
    }
    const childProfile = withDelegatedAgentContract(profile);
    const profileChildTools = admitToolsForAgentProfile(
      input.childTools,
      profile,
      (tool) => tool,
    );
    const capabilityFacts = inProcessDelegateCapabilityFacts({
      delegate,
      profile,
      delegateChildTools: input.childTools,
      allowReadWriteWorkspaceAccess: input.allowReadWriteWorkspaceAccess,
    });
    const agentTool = createAgentTool(input.getParent, {
      name: toolName,
      description: delegateToolDescription(delegate, profile),
      policy: capabilityFacts.policyProfile.policy,
      isConcurrencySafe: () =>
        capabilityFacts.workspaceAccess === "none" &&
        capabilityFacts.shellAccess === false &&
        capabilityFacts.policyProfile.policy.risk === "safe" &&
        capabilityFacts.policyProfile.policy.requiresApproval === false,
      forbidNesting: delegate.forbidNesting ?? true,
      delegationLedgerKey: configuredDelegateLedgerKey(profile.id, toolName),
      buildSpawnInput: async (args, parent) => {
        const subagentDepth = assertSubagentDepthAllowed({
          parent,
          maxDepth: input.maxDepth,
          toolName,
        });
        const childModel =
          (await input.modelForProfile?.(profile.id)) ?? input.model;
        return {
          goal: args.goal,
          model: childModel,
          // Configured in-process delegates are stable profile-backed child
          // agents: their tool catalog can include workspace writes selected
          // by profile `use`/`allowedTools`, but every call is still checked
          // against the parent run policy plus the child profile policy.
          tools: profileChildTools,
          childAgentProfile: childProfile,
          policy: createLayeredPolicy([
            input.parentRunPolicy,
            createAgentProfilePolicy(childProfile),
          ]),
          maxSteps: delegate.maxSteps ?? profile.maxSteps,
          runBudget: profile.runBudget,
          admission: createWorkspaceMutationAdmission({
            coordinator: input.workspaceLeaseCoordinator,
            workspaceRoot: input.workspaceRoot,
            mode:
              capabilityFacts.workspaceAccess === "read_write"
                ? "write"
                : "read",
          }),
          ...childWorkflowHookSpawnOptions(
            profile.id,
            input.workflowHooksForProfile,
            {
              goal: args.goal,
              shouldWrite: input.allowReadWriteWorkspaceAccess,
            },
          ),
          interactionChannel: input.interactionChannel,
          // Persist the child's trace under its own agent dir + register it in
          // session.json, and roll its usage up into the parent run's tracker.
          runStore: input.childRunStoreFactory(profile.id),
          parentUsageTracker: parent.getUsageTracker(),
          metadata: {
            ...(args.metadata ?? {}),
            subagentDepth,
            agentId: profile.id,
            agentProfileId: profile.id,
            agentName: profile.name,
            delegateTool: toolName,
            entrypoint: "delegate",
            workspaceAccess:
              capabilityFacts.workspaceAccess === "read_write"
                ? "read_write"
                : "read_only",
            agentConcurrency:
              capabilityFacts.workspaceAccess === "read_write"
                ? "serial"
                : "concurrent",
          },
        };
      },
    });
    // In-process delegate workspace writes are surfaced to the parent run-end
    // summary by rolling up the child's own `workspace.write.completed` events
    // (see `spawnSubAgent` in @sparkwright/agent-runtime), not by re-detecting
    // changes with a parent-side filesystem snapshot. The child catalog has no
    // untracked writer — `shell` rolls back unmanaged file mutations and there
    // is no MCP in the delegate child catalog — so the child's write events are
    // a complete, accurately-attributed record.
    tools.push(agentTool);
  }
  return tools;
}

export function createDelegateParallelTool(input: {
  getParent: () => ReturnType<typeof createRun> | undefined;
  delegates: CapabilityDelegateToolConfig[];
  derivedAgents: DerivedChildAgentProfile[];
  model: ModelAdapter;
  modelForProfile?: (
    profileId: string,
  ) => ModelAdapter | Promise<ModelAdapter | undefined> | undefined;
  workflowHooksForProfile?: InProcessDelegateWorkflowHooksForProfile;
  childTools: ToolDefinition[];
  parentRunPolicy: Policy;
  interactionChannel?: InteractionChannel;
  allowReadWriteWorkspaceAccess: boolean;
  maxDepth?: number;
  workspaceRoot?: string;
  workspaceLeaseCoordinator?: WorkspaceLeaseCoordinator;
  childRunStoreFactory: (
    childAgentId: string,
  ) => ReturnType<typeof createSessionRunStoreFactory>;
}): ToolDefinition {
  const byProfile = new Map(
    input.derivedAgents.map((derived) => [
      derived.effectiveProfile.id,
      derived.effectiveProfile,
    ]),
  );
  const eligibleByAgentId = new Map<string, DelegateParallelSpec>();
  const rejectionByAgentId = new Map<string, string>();

  for (const delegate of input.delegates) {
    const profile = byProfile.get(delegate.profileId);
    if (!profile) continue;
    const toolName = delegateToolName(delegate);
    if (acpConfigFromAgentProfile(profile)) {
      const reason = "protocol acp is not supported by delegate_parallel v1";
      rejectionByAgentId.set(profile.id, reason);
      continue;
    }
    if (externalCommandConfigFromAgentProfile(profile)) {
      const reason =
        "protocol external_command is not supported by delegate_parallel v1";
      rejectionByAgentId.set(profile.id, reason);
      continue;
    }
    const capabilityFacts = inProcessDelegateCapabilityFacts({
      delegate,
      profile,
      delegateChildTools: input.childTools,
      allowReadWriteWorkspaceAccess: input.allowReadWriteWorkspaceAccess,
    });
    if (capabilityFacts.workspaceAccess !== "none") {
      const reason = `workspaceAccess ${capabilityFacts.workspaceAccess} is not allowed; delegate_parallel v1 only accepts workspaceAccess none`;
      rejectionByAgentId.set(profile.id, reason);
      continue;
    }
    if (capabilityFacts.shellAccess) {
      const reason = "shell access is not allowed by delegate_parallel v1";
      rejectionByAgentId.set(profile.id, reason);
      continue;
    }
    const spec = {
      delegate,
      profile,
      childProfile: withDelegatedAgentContract(profile),
      toolName,
      profileChildTools: admitToolsForAgentProfile(
        input.childTools,
        profile,
        (tool) => tool,
      ),
    };
    eligibleByAgentId.set(profile.id, spec);
  }

  const eligibleNames = [...eligibleByAgentId.keys()].map((agentId) => {
    const spec = eligibleByAgentId.get(agentId);
    return spec ? `${agentId} (${spec.toolName})` : agentId;
  });
  const description =
    eligibleNames.length > 0
      ? `Run multiple read-only configured delegates concurrently and return their combined results. Prefer this when a request needs more than one configured agent. Target delegates by agentId. Only delegates with workspaceAccess none are accepted. Eligible delegates: ${eligibleNames.join(", ")}.`
      : "Run multiple read-only configured delegates concurrently. No eligible read-only delegates are currently configured; calls will fail with a diagnostic.";

  return defineTool({
    name: DELEGATE_PARALLEL_TOOL_NAME,
    description,
    inputSchema: {
      type: "object",
      properties: {
        delegates: {
          type: "array",
          minItems: 1,
          maxItems: DELEGATE_PARALLEL_MAX_TASKS,
          description:
            "Delegates to run in foreground parallel. Each entry targets one configured agent by agentId and supplies an isolated goal.",
          items: {
            type: "object",
            properties: {
              agentId: {
                type: "string",
                description:
                  "Configured agent profile id to run, for example reviewer.",
              },
              goal: {
                type: "string",
                description: "Self-contained goal for that delegate.",
              },
              metadata: {
                type: "object",
                description:
                  "Optional structured metadata to attach to that child run.",
              },
            },
            required: ["agentId", "goal"],
          },
        },
      },
      required: ["delegates"],
    },
    policy: { risk: "safe" },
    governance: {
      origin: { kind: "local", name: "sparkwright" },
      sideEffects: ["read"],
      idempotency: "conditional",
    },
    previewArgs(args) {
      const parsed = previewDelegateParallelArgs(args);
      return parsed.length > 0
        ? parsed.map((task) => `${task.agentId}: ${task.goal}`).join(" | ")
        : undefined;
    },
    isReplaySafe: false,
    async execute(args: unknown): Promise<unknown> {
      const parent = input.getParent();
      if (!parent) {
        throw new Error(
          `Tool "${DELEGATE_PARALLEL_TOOL_NAME}" was invoked but no parent RunHandle is available.`,
        );
      }
      const tasks = parseDelegateParallelArgs(args);
      const spawnInputs = tasks.map((task, index) => {
        const spec = eligibleByAgentId.get(task.agentId);
        if (!spec) {
          const reason =
            rejectionByAgentId.get(task.agentId) ??
            `unknown delegate; eligible delegates: ${eligibleNames.join(", ") || "(none)"}`;
          throw new Error(
            `delegate_parallel cannot run "${task.agentId}": ${reason}.`,
          );
        }
        if (
          (spec.delegate.forbidNesting ?? true) &&
          typeof parent.record.metadata?.parentRunId === "string"
        ) {
          throw new Error(
            `delegate_parallel refused to nest "${task.agentId}": parent run is itself a sub-agent.`,
          );
        }
        const ledgerKey = configuredDelegateLedgerKey(
          spec.profile.id,
          spec.toolName,
        );
        const cached = findSimilarSuccessfulDelegation(
          parent,
          ledgerKey,
          task.goal,
        );
        if (cached)
          return { mode: "cached" as const, task, index, spec, cached };
        const subagentDepth = assertSubagentDepthAllowed({
          parent,
          maxDepth: input.maxDepth,
          toolName: DELEGATE_PARALLEL_TOOL_NAME,
        });
        return {
          mode: "spawn" as const,
          task,
          index,
          spec,
          subagentDepth,
          ledgerKey,
        };
      });

      const preparedSpawnInputs = await Promise.all(
        spawnInputs.map(async (spawnInput) => {
          if (spawnInput.mode === "cached") {
            return spawnInput;
          }
          const childModel =
            (await input.modelForProfile?.(spawnInput.spec.profile.id)) ??
            input.model;
          return { ...spawnInput, childModel };
        }),
      );

      const spawned = preparedSpawnInputs.map((spawnInput) => {
        const { task, index, spec } = spawnInput;
        if (spawnInput.mode === "cached") {
          return {
            mode: "cached" as const,
            task,
            index,
            spec,
            cached: summarizeCachedDelegateParallelChild({
              index,
              task,
              spec,
              cached: spawnInput.cached,
            }),
          };
        }
        const { subagentDepth, ledgerKey, childModel } = spawnInput;
        return {
          mode: "spawn" as const,
          task,
          index,
          spec,
          ledgerKey,
          spawned: spawnSubAgent({
            parent,
            goal: task.goal,
            model: childModel,
            tools: spec.profileChildTools,
            childAgentProfile: spec.childProfile,
            policy: createLayeredPolicy([
              input.parentRunPolicy,
              createAgentProfilePolicy(spec.childProfile),
            ]),
            maxSteps: spec.delegate.maxSteps ?? spec.profile.maxSteps,
            runBudget: spec.profile.runBudget,
            ...(input.workspaceRoot
              ? {
                  admission: createWorkspaceMutationAdmission({
                    coordinator: input.workspaceLeaseCoordinator,
                    workspaceRoot: input.workspaceRoot,
                    mode: "read",
                  }),
                }
              : {}),
            ...childWorkflowHookSpawnOptions(
              spec.profile.id,
              input.workflowHooksForProfile,
              {
                goal: task.goal,
                shouldWrite: input.allowReadWriteWorkspaceAccess,
              },
            ),
            interactionChannel: input.interactionChannel,
            runStore: input.childRunStoreFactory(spec.profile.id),
            parentUsageTracker: parent.getUsageTracker(),
            metadata: {
              ...(task.metadata ?? {}),
              subagentDepth,
              agentId: spec.profile.id,
              agentProfileId: spec.profile.id,
              agentName: spec.profile.name,
              delegateTool: spec.toolName,
              entrypoint: "delegate_parallel",
              parallelTool: DELEGATE_PARALLEL_TOOL_NAME,
              parallelIndex: index,
              workspaceAccess: "read_only",
              agentConcurrency: "concurrent",
            },
          }),
        };
      });

      const results = await Promise.all(
        spawned.map(async (item): Promise<DelegateParallelChildSummary> => {
          if (item.mode === "cached") return item.cached;
          const { task, index, spec, spawned: child, ledgerKey } = item;
          try {
            const result = await child.start();
            const usage = child.run.usage();
            const summary = summarizeDelegateParallelChild({
              index,
              task,
              spec,
              childRunId: child.childRunId,
              spanId: child.spanId,
              result,
              usage,
            });
            rememberSuccessfulDelegation(
              parent,
              ledgerKey,
              task.goal,
              summarizeDelegationResult({
                childRunId: child.childRunId,
                spanId: child.spanId,
                result,
                usage,
              }),
            );
            return summary;
          } catch (error) {
            return {
              index,
              toolName: spec.toolName,
              profileId: spec.profile.id,
              signal: "failed",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
      const completed = results.filter(
        (result) => result.signal === "completed",
      ).length;
      const failed = results.length - completed;
      const output = {
        mode: "parallel",
        completed,
        failed,
        results,
        usage: aggregateDelegateParallelUsage(results),
      };
      if (failed > 0) {
        throw Object.assign(
          new Error(
            `delegate_parallel completed ${completed}/${results.length} delegate(s); ${failed} did not complete.`,
          ),
          {
            code: "DELEGATE_PARALLEL_INCOMPLETE",
            metadata: output,
          },
        );
      }
      return output;
    },
  });
}

function describeConfiguredDelegateTools(input: {
  delegates: CapabilityDelegateToolConfig[];
  derivedAgents: DerivedChildAgentProfile[];
  delegateChildToolCatalog: readonly HostToolCatalogEntry[];
  allowReadWriteWorkspaceAccess: boolean;
  routingByProfileId?: ReadonlyMap<string, DelegateRoutingSummary>;
}): DelegateCapabilityDescriptor[] {
  const byProfile = new Map(
    input.derivedAgents.map((derived) => [
      derived.effectiveProfile.id,
      derived.effectiveProfile,
    ]),
  );
  return input.delegates.flatMap((delegate) => {
    const profile = byProfile.get(delegate.profileId);
    if (!profile) return [];
    const acpConfig = acpConfigFromAgentProfile(profile);
    if (acpConfig) {
      return [
        describeDelegateCapability({
          delegate,
          profile,
          protocol: "acp",
          command: acpConfig.command,
          args: acpConfig.args,
          timeoutMs: acpConfig.timeoutMs,
          workspaceAccess: acpConfig.workspaceAccess ?? "none",
          allowReadWriteWorkspaceAccess: input.allowReadWriteWorkspaceAccess,
          routing: input.routingByProfileId?.get(profile.id),
        }),
      ];
    }
    const externalCommandConfig =
      externalCommandConfigFromAgentProfile(profile);
    if (externalCommandConfig) {
      return [
        describeDelegateCapability({
          delegate,
          profile,
          protocol: "external_command",
          command: externalCommandConfig.command,
          args: externalCommandConfig.args,
          timeoutMs: externalCommandConfig.timeoutMs,
          workspaceAccess: externalCommandConfig.workspaceAccess ?? "none",
          allowReadWriteWorkspaceAccess: input.allowReadWriteWorkspaceAccess,
          routing: input.routingByProfileId?.get(profile.id),
          outputLimits: {
            stdoutBytes:
              externalCommandConfig.maxStdoutBytes ??
              externalCommandConfig.maxOutputBytes,
            stderrBytes:
              externalCommandConfig.maxStderrBytes ??
              externalCommandConfig.maxOutputBytes,
          },
        }),
      ];
    }
    const capabilityFacts = inProcessDelegateCapabilityFacts({
      delegate,
      profile,
      delegateChildTools: input.delegateChildToolCatalog.map(
        (entry) => entry.definition,
      ),
      allowReadWriteWorkspaceAccess: input.allowReadWriteWorkspaceAccess,
    });
    return [
      describeInProcessDelegateCapability({
        delegate,
        profile,
        ...capabilityFacts,
        allowReadWriteWorkspaceAccess: input.allowReadWriteWorkspaceAccess,
        routing: input.routingByProfileId?.get(profile.id),
      }),
    ];
  });
}

function inProcessDelegateCapabilityFacts(input: {
  delegate: CapabilityDelegateToolConfig;
  profile: AgentProfile;
  delegateChildTools: readonly Pick<ToolDefinition, "name" | "governance">[];
  allowReadWriteWorkspaceAccess: boolean;
}): {
  workspaceAccess: DelegateWorkspaceAccess;
  shellAccess: boolean;
  gatedByRunWrite: boolean;
  policyProfile: DelegatePolicyProfile;
} {
  const workspaceAccess = inProcessDelegateWorkspaceAccess({
    profile: input.profile,
    delegateChildTools: input.delegateChildTools,
  });
  const shellAccess = inProcessDelegateHasTool(
    input.profile,
    input.delegateChildTools,
    "bash",
  );
  return {
    workspaceAccess,
    shellAccess,
    gatedByRunWrite:
      !input.allowReadWriteWorkspaceAccess &&
      (workspaceAccess === "read_write" || shellAccess),
    policyProfile: deriveDelegatePolicyProfile({
      risk: "safe",
      configuredRequiresApproval: input.delegate.requiresApproval,
      defaultRequiresApproval: false,
      runWriteEnabled: input.allowReadWriteWorkspaceAccess,
    }),
  };
}

function inProcessDelegateWorkspaceAccess(input: {
  profile: AgentProfile;
  delegateChildTools: readonly Pick<ToolDefinition, "name" | "governance">[];
}): DelegateWorkspaceAccess {
  const hasWriteTool = input.delegateChildTools.some(
    (tool) =>
      inProcessDelegateCanUseTool(input.profile, tool) &&
      inProcessDelegateToolCanMutate(tool),
  );
  return hasWriteTool ? "read_write" : "none";
}

function inProcessDelegateToolCanMutate(
  tool: Pick<ToolDefinition, "name" | "governance">,
): boolean {
  if (
    WORKSPACE_WRITE_TOOL_NAMES.includes(
      tool.name as (typeof WORKSPACE_WRITE_TOOL_NAMES)[number],
    )
  ) {
    return true;
  }
  const sideEffects = tool.governance?.sideEffects;
  return Array.isArray(sideEffects)
    ? sideEffects.some((effect) => effect !== "none" && effect !== "read")
    : false;
}

function inProcessDelegateHasTool(
  profile: AgentProfile,
  delegateChildTools: readonly Pick<ToolDefinition, "name">[],
  toolName: string,
): boolean {
  return delegateChildTools.some(
    (tool) =>
      tool.name === toolName && inProcessDelegateCanUseTool(profile, tool),
  );
}

function inProcessDelegateCanUseTool(
  profile: AgentProfile,
  tool: Pick<ToolDefinition, "name">,
): boolean {
  return agentProfileAdmitsTool(tool.name, profile);
}

/**
 * @internal Detect when a spawned/agent-task goal asks the child to *run* a
 * process or *write* to the filesystem — capabilities a read-only child agent
 * (read/glob/grep/list_dir/task_create only) can never satisfy. Returns the
 * kind of unsatisfiable intent, or `null` when the goal is inspection/reasoning
 * that a read-only child can legitimately do.
 *
 * Phrase-based on purpose: bare tokens like `运行`/`run` collide with nouns
 * (`运行日志`, "run log"), so we only match multi-word execution/launch and
 * filesystem-write phrases. "Write code / a program / a script" is deliberately
 * NOT a write signal — that is code *production*, which a read-only child does
 * by returning text.
 */
export function detectReadOnlyChildIntent(
  text: string,
): "execute" | "write" | null {
  const haystack = text.toLowerCase();
  // Execution intent needs an action *verb* (run/execute/launch/start) paired
  // with something runnable or a background framing. Keying on "background"
  // alone is wrong: "inspect the repo in the background" is a legitimate
  // read-only job — the delivery mode is not the work. Likewise the Chinese
  // verbs only count alongside a runnable object/mode, so "运行日志"/"runtime"
  // (noun uses) do not trip.
  const executeVerbs = [
    "run ",
    "runs ",
    "running ",
    "execute",
    "launch",
    "spawn ",
    "start ",
    "starts ",
    "starting ",
    "运行",
    "执行",
    "启动",
    "跑",
  ];
  const runnableObjects = [
    "script",
    "program",
    "command",
    "process",
    "server",
    "daemon",
    "binary",
    "python",
    "node ",
    "脚本",
    "程序",
    "命令",
    "进程",
    "服务",
    "任务",
  ];
  const modeWords = ["后台", "background", "detached", "nohup"];
  const hasExecuteVerb = executeVerbs.some((verb) => haystack.includes(verb));
  const hasRunnable = runnableObjects.some((obj) => haystack.includes(obj));
  const hasMode = modeWords.some((mode) => haystack.includes(mode));
  if (hasExecuteVerb && (hasRunnable || hasMode)) {
    return "execute";
  }
  const writePhrases = [
    "write to a file",
    "write to file",
    "write it to",
    "save to disk",
    "save it to",
    "save the file",
    "create the file",
    "write the file",
    "write to disk",
    "写入文件",
    "写到文件",
    "写入磁盘",
    "保存到",
    "落盘",
    "创建文件",
    "写进文件",
  ];
  if (writePhrases.some((phrase) => haystack.includes(phrase))) {
    return "write";
  }
  return null;
}

/**
 * @internal Fail loud when a read-only child agent is handed a goal it can
 * never fulfill. A read-only child that "completes" an execution/write goal
 * having done nothing produces a false success that the parent then rationalizes
 * (often by hallucinating an error). Throwing here forces the parent to route
 * the work through a grant-capable spawn or an execution-capable tool.
 */
export function assertReadOnlyChildCanSatisfyGoal(input: {
  goal: string;
  prompt: string;
  childTools: readonly Pick<ToolDefinition, "name">[];
  entrypoint: "spawn_agent" | "agent_task";
}): void {
  const childTools = new Set(input.childTools.map((tool) => tool.name));
  const hasExecutor = childTools.has("bash");
  const hasWriter =
    childTools.has("write") ||
    childTools.has("edit") ||
    childTools.has("edit_anchored_text");
  const intent = detectReadOnlyChildIntent(`${input.goal}\n${input.prompt}`);
  if (intent === null) return;
  if (intent === "execute" && hasExecutor) return;
  if (intent === "write" && hasWriter) return;
  const remedy =
    intent === "execute"
      ? "route execution through the parent `bash` tool (pass background:true to launch it as a non-blocking background task) or a configured delegate with shell access"
      : "re-spawn the child with `grant: { workspaceWrite: true }` or include a managed write tool such as `write` in `allowedTools` so the parent can approve the grant before the child starts";
  throw Object.assign(
    new Error(
      `${input.entrypoint} child agents are read-only and cannot ` +
        `${intent === "execute" ? "run processes or shell commands" : "write to the filesystem"}. ` +
        `To satisfy this goal, ${remedy}; do not delegate it to a read-only child.`,
    ),
    { code: "READONLY_CHILD_INTENT_UNSATISFIABLE" },
  );
}

/**
 * @internal Exported for host regression tests that assert the spawn path
 * threads `runStore` + `parentUsageTracker` into the child run. Not part of the
 * public host API.
 */
export function createDynamicSpawnAgentTool(input: {
  getParent: () => ReturnType<typeof createRun> | undefined;
  model: ModelAdapter;
  modelForSpawn?: () => ModelAdapter | Promise<ModelAdapter>;
  childTools: ToolDefinition[];
  parentRunPolicy: Policy;
  maxDepth?: number;
  abortSignal?: AbortSignal;
  entrypoint?: "spawn_agent" | "agent_task";
  delegateToolName?: string;
  taskId?: string;
  workspaceRoot?: string;
  workspaceLeaseCoordinator?: WorkspaceLeaseCoordinator;
  /**
   * When set with `taskManager`, inline spawn_agent runs in foreground up to
   * this budget and then promotes the same child run into an awaited task.
   */
  foregroundTimeoutMs?: number;
  taskManager?: TaskManager;
  backgroundTasks?: BackgroundTaskPolicy;
  /** Builds a session-scoped run store for the child, keyed by its agent id. */
  childRunStoreFactory: (
    childAgentId: string,
  ) => ReturnType<typeof createSessionRunStoreFactory>;
}): ToolDefinition {
  return defineTool({
    name: "spawn_agent",
    description:
      "Spawn a bounded child agent for one focused sub-task. By default the child may inspect files but cannot write, run shell commands, or spawn further agents. With grant.workspaceWrite=true, or by requesting a managed write tool, the child may use managed workspace write tools after parent approval; it still cannot run shell commands. Use this for temporary roles; if the same role becomes useful repeatedly, create a stable profile with create_agent and delegate to it through a delegate_* tool.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "The concrete sub-task the child agent should complete.",
        },
        role: {
          type: "string",
          description: "Short role name for the child agent.",
        },
        prompt: {
          type: "string",
          description:
            "Focused instructions that define the child agent's scope and output.",
        },
        allowedTools: {
          type: "array",
          description:
            "Optional subset of child tools to expose. Supported: read, glob, grep, list_dir, write, edit, edit_anchored_text. Defaults to read, glob, and grep; with grant.workspaceWrite=true and no allowedTools, also exposes write, edit, and edit_anchored_text. Use grep to find a symbol by name (glob only matches paths, not contents).",
          items: {
            type: "string",
            enum: [
              ...AGENT_READ_ONLY_CHILD_TOOLS,
              ...AGENT_WORKSPACE_WRITE_CHILD_TOOLS,
            ],
          },
        },
        grant: {
          type: "object",
          description:
            "Optional capability grant requested at spawn time. Set workspaceWrite=true to let the child use managed workspace write tools after parent approval.",
          properties: {
            workspaceWrite: {
              type: "boolean",
              description:
                "Allow the child to perform managed workspace writes through write/edit tools.",
            },
          },
          additionalProperties: false,
        },
        maxSteps: {
          type: "integer",
          minimum: 1,
          description:
            "Optional child step (model turn) limit; allocate by sub-task complexity. Defaults to the parent run's effective maxSteps when omitted. A multi-step search (glob, read, refine, conclude) typically needs 6+.",
        },
        metadata: {
          type: "object",
          description: "Optional structured metadata for the child run.",
        },
      },
      required: ["goal", "role", "prompt"],
    },
    policy: { risk: "safe" },
    governance: {
      origin: { kind: "local", name: "sparkwright" },
      sideEffects: ["read"],
      idempotency: "conditional",
    },
    policyForArgs(args: unknown) {
      return (
        agentWorkspaceWriteGrantPolicyForPayload(
          args,
          input.entrypoint ?? "spawn_agent",
        ) ?? {}
      );
    },
    isConcurrencySafe(args: unknown) {
      return isAgentSpawnRequestConcurrencySafe(
        args,
        input.entrypoint ?? "spawn_agent",
      );
    },
    approvalSummaryForArgs(args: unknown, options: ToolRequestPreviewOptions) {
      return agentWorkspaceWriteGrantApprovalSummaryForPayload(
        args,
        input.entrypoint ?? "spawn_agent",
        options,
      );
    },
    previewArgs(args) {
      const r = previewRecord(args);
      const role = previewString(r.role);
      const goal = previewString(r.goal);
      const allowedTools = Array.isArray(r.allowedTools)
        ? r.allowedTools.filter(
            (tool): tool is string => typeof tool === "string",
          )
        : [];
      const toolHint =
        allowedTools.length > 0 ? ` · ${allowedTools.join(", ")}` : "";
      if (role && goal) return `${role}: ${goal}${toolHint}`;
      return role || goal || undefined;
    },
    isReplaySafe: false,
    async execute(args: unknown): Promise<unknown> {
      const parent = input.getParent();
      if (!parent) {
        throw new Error(
          'Tool "spawn_agent" was invoked but no parent RunHandle is available.',
        );
      }
      if (typeof parent.record.metadata?.parentRunId === "string") {
        throw new Error(
          'Tool "spawn_agent" refused to nest: parent run is itself a sub-agent.',
        );
      }
      const parsed = parseDynamicSpawnAgentArgs(args);
      const supportedTools = new Set<string>([
        ...AGENT_READ_ONLY_CHILD_TOOLS,
        ...AGENT_WORKSPACE_WRITE_CHILD_TOOLS,
      ]);
      const toolRequest = resolveAgentSpawnToolRequest({
        allowedTools: parsed.allowedTools,
        grant: parsed.grant,
        toolName: input.entrypoint ?? "spawn_agent",
      });
      const requestedTools = toolRequest.requestedTools;
      const availableTools = new Map(
        input.childTools.map((tool) => [tool.name, tool]),
      );
      const invalidTools = requestedTools.filter(
        (name) => !supportedTools.has(name) || !availableTools.has(name),
      );
      if (invalidTools.length > 0) {
        throw new Error(
          `spawn_agent only supports enabled child tools: ${invalidTools.join(
            ", ",
          )}`,
        );
      }
      const childTools = requestedTools
        .map((name) => availableTools.get(name))
        .filter((tool): tool is ToolDefinition => tool !== undefined);
      if (
        childTools.some(
          (tool) =>
            tool.name !== DISCOVERY_TOOL_NAME && tool.deferLoading === true,
        )
      ) {
        const discovery = availableTools.get(DISCOVERY_TOOL_NAME);
        if (
          discovery &&
          !childTools.some((tool) => tool.name === discovery.name)
        ) {
          childTools.push(
            createScopedToolSearch(childTools, {
              kind: "local",
              name: "@sparkwright/host.dynamic-child-scoped-tool-search",
              metadata: { dynamicChildScoped: true },
            }),
          );
        }
      }
      if (childTools.length === 0) {
        throw new Error(
          "spawn_agent requires at least one enabled child tool.",
        );
      }

      assertReadOnlyChildCanSatisfyGoal({
        goal: parsed.goal,
        prompt: parsed.prompt,
        childTools,
        entrypoint: input.entrypoint ?? "spawn_agent",
      });

      // Strip any leading `dynamic_` the role already carries so a re-used
      // agent id (models sometimes pass a prior child's `dynamic_<role>` id
      // back in as the new role) does not compound into `dynamic_dynamic_*`.
      const roleSegment = sanitizeToolSegment(
        parsed.role.toLowerCase(),
      ).replace(/^(?:dynamic_)+/, "");
      const agentId = `dynamic_${roleSegment || "agent"}`;
      const childMaxSteps = parsed.maxSteps ?? parent.maxSteps;
      const profile: AgentProfile = {
        id: agentId,
        name: parsed.role,
        mode: "child",
        allowedTools: childTools.map((tool) => tool.name),
        maxSteps: childMaxSteps,
        prompt: withDelegatedAgentPrompt(parsed.prompt),
        metadata: {
          dynamic: true,
        },
      };
      const ledgerKey = dynamicSpawnLedgerKey({
        role: parsed.role,
        prompt: parsed.prompt,
        allowedTools: childTools.map((tool) => tool.name),
      });
      const cached = findSimilarSuccessfulDelegation(
        parent,
        ledgerKey,
        parsed.goal,
      );
      if (cached) return cachedDynamicSpawnOutput(cached);

      const subagentDepth = assertSubagentDepthAllowed({
        parent,
        maxDepth: input.maxDepth,
        toolName: "spawn_agent",
      });
      const childModel = input.modelForSpawn
        ? await input.modelForSpawn()
        : input.model;

      const childAbort = createLinkedAbortController(input.abortSignal);
      const spawned = spawnSubAgent({
        parent,
        goal: parsed.goal,
        model: childModel,
        tools: childTools,
        childAgentProfile: profile,
        policy: createLayeredPolicy([
          input.parentRunPolicy,
          createAgentProfilePolicy(profile),
        ]),
        interactionChannel: createAgentWorkspaceWriteGrantChannel({
          enabled: toolRequest.workspaceWriteGrant,
          source: input.entrypoint ?? "spawn_agent",
          role: parsed.role,
        }),
        maxSteps: childMaxSteps,
        abortSignal: childAbort.controller.signal,
        ...(input.workspaceRoot
          ? {
              admission: createWorkspaceMutationAdmission({
                coordinator: input.workspaceLeaseCoordinator,
                workspaceRoot: input.workspaceRoot,
                mode: toolRequest.workspaceWriteGrant ? "write" : "read",
              }),
            }
          : {}),
        // Persist the child's own trace/transcript under
        // `sessions/<id>/agents/<agentId>/` and register it in session.json,
        // instead of letting its steps disappear once the tool returns.
        runStore: input.childRunStoreFactory(agentId),
        // Fold the child's tool/model usage into the parent run's tracker so
        // session usage totals (and the live `usage.updated` stream) reflect
        // sub-agent spend rather than under-reporting it.
        parentUsageTracker: parent.getUsageTracker(),
        metadata: {
          ...(parsed.metadata ?? {}),
          dynamic: true,
          subagentDepth,
          agentId,
          agentProfileId: agentId,
          agentName: parsed.role,
          delegateTool: input.delegateToolName ?? "spawn_agent",
          entrypoint: input.entrypoint ?? "spawn_agent",
          ...(input.taskId ? { taskId: input.taskId } : {}),
          allowedTools: childTools.map((tool) => tool.name),
          capabilityGrants: {
            workspaceWrite: toolRequest.workspaceWriteGrant,
          },
          workspaceAccess: toolRequest.workspaceWriteGrant
            ? "read_write"
            : "read_only",
          agentConcurrency: toolRequest.workspaceWriteGrant
            ? "serial"
            : "concurrent",
        },
      });
      const completion = completeDynamicSpawnAgent({
        spawned,
        parent,
        ledgerKey,
        goal: parsed.goal,
        role: parsed.role,
        prompt: parsed.prompt,
        agentId,
        childTools,
        childMaxSteps,
      }).finally(() => {
        childAbort.dispose();
      });
      if (
        input.taskManager &&
        (input.backgroundTasks ?? "enabled") === "enabled" &&
        input.foregroundTimeoutMs !== undefined &&
        input.foregroundTimeoutMs >= 0
      ) {
        const settled = await settleWithin(
          completion,
          input.foregroundTimeoutMs,
        );
        if (settled.settled) {
          if (settled.ok) return settled.value;
          throw settled.cause;
        }
        return promoteDynamicSpawnAgent({
          taskManager: input.taskManager,
          parentRunId: parent.record.id,
          spawned,
          completion,
          abortController: childAbort.controller,
          foregroundTimeoutMs: input.foregroundTimeoutMs,
          role: parsed.role,
          goal: parsed.goal,
          agentId,
        });
      }
      return completion;
    },
  });
}

interface CompleteDynamicSpawnAgentInput {
  spawned: SpawnedSubAgent;
  parent: ReturnType<typeof createRun>;
  ledgerKey: DelegationLedgerKey;
  goal: string;
  role: string;
  prompt: string;
  agentId: string;
  childTools: ToolDefinition[];
  childMaxSteps: number;
}

async function completeDynamicSpawnAgent(
  input: CompleteDynamicSpawnAgentInput,
): Promise<Record<string, unknown>> {
  const {
    spawned,
    parent,
    ledgerKey,
    goal,
    role,
    prompt,
    agentId,
    childTools,
    childMaxSteps,
  } = input;
  const result = await spawned.start();
  const usage = spawned.run.usage();
  // A child that answered on its last allowed step may have wrapped up early
  // under the step budget; tell the parent so it can caveat rather than
  // present a possibly-truncated child answer as exhaustive.
  const stepLimitReached =
    (result.metadata as { stepLimitReached?: unknown } | undefined)
      ?.stepLimitReached === true;
  const childTruncated =
    (result.metadata as { truncated?: unknown } | undefined)?.truncated ===
      true || stepLimitReached;
  const finality =
    result.signal !== "completed" || childTruncated ? "partial" : "complete";
  const resultMessage =
    typeof result.message === "string" ? result.message : undefined;
  const message =
    stepLimitReached && resultMessage
      ? [
          "Warning: this child hit its step budget and wrapped up early; its answer may be incomplete. Do not re-spawn the same scope unless you raise maxSteps or need a different concrete scope; summarize from the partial result when possible.",
          "",
          resultMessage,
        ].join("\n")
      : result.message;
  // A child that failed (doom-loop, step-limit, error) never emitted a final
  // answer, so salvage its most recent successful tool results — otherwise
  // the parent only sees an error string and must re-spawn to rediscover the
  // same data. Success carries the answer in `message`, so skip it there.
  const partialObservations =
    result.signal === "completed"
      ? undefined
      : extractPartialObservations(spawned.run.events.all(), 3);
  const output = {
    childRunId: spawned.childRunId,
    spanId: spawned.spanId,
    agentId,
    role,
    signal: result.signal,
    stopReason: result.stopReason,
    stepLimitReached,
    truncated: childTruncated,
    finality,
    message,
    ...(partialObservations && partialObservations.length > 0
      ? { partialObservations }
      : {}),
    usage,
    promotionHint: {
      action: "create_agent.create",
      reason:
        "If this temporary role is useful repeatedly, create a stable agent profile and delegate tool instead of continuing to spawn it ad hoc.",
      suggestedProfile: {
        id: sanitizeToolSegment(role.toLowerCase()),
        name: role,
        mode: "child",
        prompt,
        allowedTools: childTools.map((tool) => tool.name),
        maxSteps: childMaxSteps,
        delegateToolName: `delegate_${sanitizeToolSegment(role.toLowerCase())}`,
      },
    },
  };
  rememberSuccessfulDelegation(parent, ledgerKey, goal, {
    ...summarizeDelegationResult({
      childRunId: spawned.childRunId,
      spanId: spawned.spanId,
      result,
      usage,
    }),
    output,
  });
  if (result.signal !== "completed") {
    // Surface the failure as a *structured* tool error. The observation
    // formatter truncates `error.message` to 500 chars but passes
    // `error.metadata` through untruncated, so the salvaged data
    // (partialObservations + why it stopped) must live in metadata — a
    // JSON blob stuffed into the message would be cut off before the parent
    // ever saw it. `normalizeExecutionError` preserves an attached
    // `.code`/`.metadata` on the thrown error.
    const childMessage =
      typeof result.message === "string" ? result.message : undefined;
    const failure = Object.assign(
      new Error(
        `spawn_agent child "${role}" did not complete (${
          result.stopReason ?? result.signal
        }).` +
          (partialObservations && partialObservations.length > 0
            ? ` ${partialObservations.length} partial observation(s) salvaged in error.metadata.partialObservations.`
            : ""),
      ),
      {
        code: "SPAWN_AGENT_CHILD_INCOMPLETE",
        metadata: {
          childRunId: spawned.childRunId,
          agentId,
          role,
          signal: result.signal,
          stopReason: result.stopReason,
          stepLimitReached,
          truncated: childTruncated,
          finality,
          ...(childMessage ? { childMessage } : {}),
          ...(partialObservations && partialObservations.length > 0
            ? { partialObservations }
            : {}),
        },
      },
    );
    throw failure;
  }
  return output;
}

type SettledWithin<T> =
  | { settled: false }
  | { settled: true; ok: true; value: T }
  | { settled: true; ok: false; cause: unknown };

function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<SettledWithin<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ settled: true, ok: true, value });
      },
      (cause) => {
        clearTimeout(timer);
        resolve({ settled: true, ok: false, cause });
      },
    );
  });
}

function promoteDynamicSpawnAgent(input: {
  taskManager: TaskManager;
  parentRunId: RunId;
  spawned: SpawnedSubAgent;
  completion: Promise<Record<string, unknown>>;
  abortController: AbortController;
  foregroundTimeoutMs: number;
  role: string;
  goal: string;
  agentId: string;
}): Record<string, unknown> {
  const handle = input.taskManager.adoptRunning({
    parentRunId: input.parentRunId,
    kind: "agent",
    title: `spawn_agent: ${input.role}`,
    awaited: true,
    controller: input.abortController,
    metadata: {
      source: "spawn_agent",
      promoted: true,
      childRunId: input.spawned.childRunId,
      spanId: input.spawned.spanId,
      agentId: input.agentId,
      role: input.role,
      goal: input.goal,
      foregroundTimeoutMs: input.foregroundTimeoutMs,
    },
  });
  input.completion.then(
    (output) => {
      input.taskManager.complete(handle.record.id, output).catch(() => {});
    },
    (cause) => {
      if (input.abortController.signal.aborted) {
        input.taskManager.cancelled(handle.record.id).catch(() => {});
      } else {
        input.taskManager
          .fail(handle.record.id, taskErrorFromCause(cause))
          .catch(() => {});
      }
    },
  );
  return {
    taskId: handle.record.id,
    kind: "agent",
    mode: "foreground",
    promoted: true,
    awaited: true,
    childRunId: input.spawned.childRunId,
    spanId: input.spawned.spanId,
    agentId: input.agentId,
    role: input.role,
    foregroundTimeoutMs: input.foregroundTimeoutMs,
    message:
      "spawn_agent exceeded the foreground budget and is continuing as an awaited background task.",
  };
}

function createLinkedAbortController(parentSignal?: AbortSignal): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (!parentSignal) return { controller, dispose: () => {} };
  if (parentSignal.aborted) {
    controller.abort();
    return { controller, dispose: () => {} };
  }
  const onAbort = () => controller.abort();
  parentSignal.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    dispose: () => parentSignal.removeEventListener("abort", onAbort),
  };
}

function createAgentWorkspaceWriteGrantChannel(input: {
  enabled: boolean;
  source: string;
  role: string;
}): InteractionChannel | undefined {
  if (!input.enabled) return undefined;
  return {
    approve: (request) => {
      if (request.action === "workspace.write") {
        return {
          approvalId: request.id,
          decision: "approved",
          message: `Auto-approved by ${input.source} workspaceWrite grant for ${input.role}.`,
          autoApproved: true,
        };
      }
      return {
        approvalId: request.id,
        decision: "denied",
        message: `Approval request is outside the ${input.source} workspaceWrite grant.`,
      };
    },
  };
}

function taskErrorFromCause(cause: unknown): {
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
} {
  if (cause && typeof cause === "object") {
    const record = cause as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : undefined;
    const message =
      cause instanceof Error
        ? cause.message
        : typeof record.message === "string"
          ? record.message
          : String(cause);
    const metadata =
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : undefined;
    return {
      code: code ?? "TASK_FAILED",
      message,
      ...(metadata ? { metadata } : {}),
    };
  }
  return { code: "TASK_FAILED", message: String(cause) };
}

function parseDelegateParallelArgs(args: unknown): DelegateParallelTask[] {
  if (!args || typeof args !== "object") {
    throw new Error("delegate_parallel expects an object argument.");
  }
  const record = args as Record<string, unknown>;
  if (!Array.isArray(record.delegates)) {
    throw new Error("delegate_parallel delegates must be an array.");
  }
  if (record.delegates.length < 1) {
    throw new Error("delegate_parallel delegates must not be empty.");
  }
  if (record.delegates.length > DELEGATE_PARALLEL_MAX_TASKS) {
    throw new Error(
      `delegate_parallel accepts at most ${DELEGATE_PARALLEL_MAX_TASKS} delegates.`,
    );
  }
  return record.delegates.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `delegate_parallel delegates.${index} must be an object.`,
      );
    }
    const task = entry as Record<string, unknown>;
    const metadata =
      task.metadata === undefined
        ? undefined
        : objectField(task, "metadata", DELEGATE_PARALLEL_TOOL_NAME);
    return {
      agentId: stringField(task, "agentId", DELEGATE_PARALLEL_TOOL_NAME),
      goal: stringField(task, "goal", DELEGATE_PARALLEL_TOOL_NAME),
      ...(metadata ? { metadata } : {}),
    };
  });
}

function previewDelegateParallelArgs(args: unknown): DelegateParallelTask[] {
  const record = previewRecord(args);
  if (!Array.isArray(record.delegates)) return [];
  return record.delegates
    .map((entry): DelegateParallelTask | undefined => {
      const task = previewRecord(entry);
      const agentId = previewString(task.agentId).trim();
      const goal = previewString(task.goal).trim();
      return goal && agentId ? { agentId, goal } : undefined;
    })
    .filter((task): task is DelegateParallelTask => task !== undefined);
}

function summarizeDelegateParallelChild(input: {
  index: number;
  task: DelegateParallelTask;
  spec: DelegateParallelSpec;
  childRunId: string;
  spanId: string;
  result: RunResult;
  usage: ReturnType<ReturnType<typeof createRun>["usage"]>;
}): DelegateParallelChildSummary {
  const stepLimitReached = delegateParallelStepLimitReached(input.result);
  const truncated = delegateParallelTruncated(input.result) || stepLimitReached;
  return {
    index: input.index,
    toolName: input.spec.toolName,
    profileId: input.spec.profile.id,
    childRunId: input.childRunId,
    spanId: input.spanId,
    signal: input.result.signal,
    stopReason: input.result.stopReason,
    ...(typeof input.result.message === "string"
      ? { message: input.result.message }
      : {}),
    ...(stepLimitReached ? { stepLimitReached: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    tokens: input.usage.tokens.total,
    costUsd: input.usage.costUsd,
    toolCalls: input.usage.toolCalls,
    modelCalls: input.usage.modelCalls,
  };
}

function summarizeCachedDelegateParallelChild(input: {
  index: number;
  task: DelegateParallelTask;
  spec: DelegateParallelSpec;
  cached: DelegationLedgerHit;
}): DelegateParallelChildSummary {
  const result = withAlreadyCompletedNote(input.cached.result);
  return {
    index: input.index,
    toolName: input.spec.toolName,
    profileId: input.spec.profile.id,
    childRunId: result.childRunId,
    spanId: result.spanId,
    signal: result.signal,
    stopReason: result.stopReason,
    ...(typeof result.message === "string" ? { message: result.message } : {}),
    ...(result.stepLimitReached ? { stepLimitReached: true } : {}),
    ...(result.truncated ? { truncated: true } : {}),
    tokens: result.tokens,
    costUsd: result.costUsd,
    toolCalls: result.toolCalls,
    modelCalls: result.modelCalls,
    alreadyCompleted: true,
    note: result.note,
  };
}

function aggregateDelegateParallelUsage(
  results: readonly DelegateParallelChildSummary[],
): {
  tokens: number;
  costUsd: number;
  toolCalls: number;
  modelCalls: number;
} {
  return {
    tokens: sumNumberFields(results, "tokens"),
    costUsd: sumNumberFields(results, "costUsd"),
    toolCalls: sumNumberFields(results, "toolCalls"),
    modelCalls: sumNumberFields(results, "modelCalls"),
  };
}

function sumNumberFields(
  results: readonly DelegateParallelChildSummary[],
  field: "tokens" | "costUsd" | "toolCalls" | "modelCalls",
): number {
  return results.reduce((sum, result) => sum + (result[field] ?? 0), 0);
}

function delegateParallelStepLimitReached(result: RunResult): boolean {
  const metadata = isPlainRecord(result.metadata) ? result.metadata : {};
  return metadata.stepLimitReached === true;
}

function delegateParallelTruncated(result: RunResult): boolean {
  const metadata = isPlainRecord(result.metadata) ? result.metadata : {};
  return metadata.truncated === true;
}

function dynamicSpawnLedgerKey(input: {
  role: string;
  prompt: string;
  allowedTools: readonly string[];
}): DelegationLedgerKey {
  return {
    kind: "dynamic_spawn",
    role: sanitizeToolSegment(input.role.toLowerCase()),
    prompt: input.prompt,
    allowedTools: input.allowedTools,
  };
}

function cachedDynamicSpawnOutput(hit: DelegationLedgerHit): unknown {
  const result = withAlreadyCompletedNote(hit.result);
  if (isPlainRecord(result.output)) {
    return {
      ...result.output,
      alreadyCompleted: true,
      note: result.note,
    };
  }
  return result;
}

function summarizeAgentTaskOutput(output: unknown): Record<string, unknown> {
  if (!isPlainRecord(output)) {
    return { type: "agent.completed" };
  }
  const message =
    typeof output.message === "string"
      ? output.message.slice(0, 4_000)
      : undefined;
  return {
    type: "agent.completed",
    ...(typeof output.childRunId === "string"
      ? { childRunId: output.childRunId }
      : {}),
    ...(typeof output.agentId === "string" ? { agentId: output.agentId } : {}),
    ...(typeof output.role === "string" ? { role: output.role } : {}),
    ...(typeof output.signal === "string" ? { signal: output.signal } : {}),
    ...(typeof output.stopReason === "string"
      ? { stopReason: output.stopReason }
      : {}),
    ...(typeof output.finality === "string"
      ? { finality: output.finality }
      : {}),
    ...(typeof output.truncated === "boolean"
      ? { truncated: output.truncated }
      : {}),
    ...(message ? { message } : {}),
  };
}

function parseDynamicSpawnAgentArgs(args: unknown): {
  goal: string;
  role: string;
  prompt: string;
  allowedTools?: string[];
  grant: AgentWorkspaceWriteGrant;
  maxSteps?: number;
  metadata?: Record<string, unknown>;
} {
  if (!args || typeof args !== "object") {
    throw new Error("spawn_agent expects an object argument.");
  }
  const record = args as Record<string, unknown>;
  const goal = stringField(record, "goal");
  const role = stringField(record, "role");
  const prompt = stringField(record, "prompt");
  const allowedTools = parseAgentAllowedToolsFromRecord(record, "spawn_agent");
  const grant = parseAgentWorkspaceWriteGrantFromRecord(record, "spawn_agent");
  let maxSteps: number | undefined;
  if (record.maxSteps !== undefined) {
    maxSteps = integerField(record, "maxSteps");
    if (maxSteps < 1) {
      throw new Error("spawn_agent maxSteps must be at least 1.");
    }
  }
  const metadata =
    record.metadata === undefined ? undefined : objectField(record, "metadata");
  return {
    goal,
    role,
    prompt,
    allowedTools,
    grant,
    maxSteps,
    metadata,
  };
}

function previewRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function previewString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringField(
  record: Record<string, unknown>,
  field: string,
  toolName = "spawn_agent",
): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${toolName} ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function integerField(
  record: Record<string, unknown>,
  field: string,
  toolName = "spawn_agent",
): number {
  const value = record[field];
  if (!Number.isInteger(value)) {
    throw new Error(`${toolName} ${field} must be an integer.`);
  }
  return value as number;
}

function objectField(
  record: Record<string, unknown>,
  field: string,
  toolName = "spawn_agent",
): Record<string, unknown> {
  const value = record[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${toolName} ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function collectSessionTraceFact(
  facts: SessionTraceFacts,
  event: SparkwrightEvent,
): void {
  if (event.type === "approval.requested") {
    facts.approvals = {
      ...(facts.approvals ?? {}),
      requested: (facts.approvals?.requested ?? 0) + 1,
    };
    return;
  }
  if (event.type === "approval.resolved") {
    const decision = recordString(event.payload, "decision");
    facts.approvals = {
      ...(facts.approvals ?? {}),
      ...(decision === "approved"
        ? { approved: (facts.approvals?.approved ?? 0) + 1 }
        : {}),
      ...(decision === "denied"
        ? { denied: (facts.approvals?.denied ?? 0) + 1 }
        : {}),
    };
    return;
  }

  if (
    event.type === "workspace.write.completed" ||
    event.type === "workspace.write.denied" ||
    event.type === "workspace.write.skipped"
  ) {
    const key =
      event.type === "workspace.write.completed"
        ? "completed"
        : event.type === "workspace.write.denied"
          ? "denied"
          : "skipped";
    const path = recordString(event.payload, "path") ?? "(unknown)";
    const writes = facts.workspaceWrites ?? {};
    const next = new Set(writes[key] ?? []);
    next.add(path);
    facts.workspaceWrites = { ...writes, [key]: [...next] };
    return;
  }

  if (event.type === "subagent.completed" || event.type === "subagent.failed") {
    const childRunId =
      recordString(event.payload, "childRunId") ??
      recordString(event.metadata, "childRunId");
    if (!childRunId) return;
    const finality =
      recordString(event.payload, "finality") ??
      (event.type === "subagent.completed" ? "complete" : "partial");
    addSessionSubagentFact(facts, {
      childRunId,
      finality,
      role: recordString(event.payload, "role"),
    });
    return;
  }

  if (event.type === "tool.completed" || event.type === "tool.failed") {
    const payload = isPlainRecord(event.payload) ? event.payload : undefined;
    const toolName = payload
      ? (recordString(payload, "toolName") ?? recordString(payload, "name"))
      : undefined;
    if (toolName !== "spawn_agent") return;
    const childRunId =
      findNestedString(event.payload, "childRunId") ??
      findNestedString(event.metadata, "childRunId");
    if (!childRunId) return;
    addSessionSubagentFact(facts, {
      childRunId,
      finality: findNestedString(event.payload, "finality"),
      role: findNestedString(event.payload, "role"),
    });
  }
}

function addSessionSubagentFact(
  facts: SessionTraceFacts,
  fact: NonNullable<SessionTraceFacts["subagents"]>[number],
): void {
  const existing = new Map(
    (facts.subagents ?? []).map((entry) => [entry.childRunId, entry]),
  );
  existing.set(fact.childRunId, { ...existing.get(fact.childRunId), ...fact });
  facts.subagents = [...existing.values()];
}

function recordString(value: unknown, key: string): string | undefined {
  return isPlainRecord(value) && typeof value[key] === "string"
    ? (value[key] as string)
    : undefined;
}

function runtimeStateFromWorkflowRecord(
  record: WorkflowRunRecord,
): WorkflowRuntimeState {
  return {
    status:
      record.status === "completed"
        ? "completed"
        : record.status === "failed"
          ? "failed"
          : "running",
    ...(record.currentNodeId ? { currentNodeId: record.currentNodeId } : {}),
    attempts: { ...record.attempts },
    transitionLog: record.transitionLog.map((entry) => ({
      ...entry,
      verdict: cloneJsonLike(entry.verdict),
      decision: cloneJsonLike(entry.decision),
    })),
    ...(record.parallelBranches
      ? { parallelBranches: cloneJsonLike(record.parallelBranches) }
      : {}),
    ...(record.failure
      ? {
          failure: {
            reason: record.failure.message,
            nodeId: record.failure.nodeId,
            metadata: record.failure.metadata,
          },
        }
      : {}),
  };
}

interface WorkflowActorEpisodePlan {
  model: ModelAdapter;
  modelRef: string;
  resolvedModel: ResolvedModelConfig;
  nodeId?: string;
  attempt?: number;
  runBudget?: RunBudget;
  budgetScope: "main_agent" | "todo_continuation";
  toolSurface: ResolvedToolSurface;
}

async function resolveWorkflowModelAdapters(input: {
  definition: WorkflowDefinition;
  parentModelRef: string;
  goal: string;
  workspaceRoot: string;
  targetPath?: string;
}): Promise<
  | {
      ok: true;
      adapters: Map<
        string,
        { adapter: ModelAdapter; resolved: ResolvedModelConfig }
      >;
    }
  | { ok: false; message: string }
> {
  const adapters = new Map<
    string,
    { adapter: ModelAdapter; resolved: ResolvedModelConfig }
  >();
  const refs = new Set<string>();
  for (const node of input.definition.nodes) {
    const modelRef = workflowNodeModelRef(input.definition, node);
    if (modelRef && modelRef !== input.parentModelRef) refs.add(modelRef);
  }
  for (const modelRef of refs) {
    const built = await createModel({
      modelRef,
      goal: input.goal,
      workspaceRoot: input.workspaceRoot,
      ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    });
    if (!built.ok) {
      return {
        ok: false,
        message: `Workflow node model "${modelRef}": ${built.message}`,
      };
    }
    adapters.set(modelRef, {
      adapter: built.adapter,
      resolved: built.resolved,
    });
  }
  return { ok: true, adapters };
}

function workflowActorEpisodePlan(
  env: PreparedHostRunEnvironment,
  options: {
    fallbackRunBudget?: RunBudget;
    purpose: WorkflowActorEpisodePlan["budgetScope"];
  },
): WorkflowActorEpisodePlan {
  const node = currentWorkflowRecordNode(env.workflowRecord);
  const nodeModelRef =
    node && env.workflowRecord?.definitionSnapshot
      ? workflowNodeModelRef(env.workflowRecord.definitionSnapshot, node)
      : undefined;
  const modelRef = nodeModelRef ?? env.modelRef;
  const model =
    nodeModelRef && env.workflowModelAdapters.has(modelRef)
      ? env.workflowModelAdapters.get(modelRef)!
      : { adapter: env.model, resolved: env.resolvedModel };
  const workflowAllowedTools = workflowEpisodeAllowedTools(env.workflowRecord);
  const toolSurface = resolveRunToolSurface({
    tools: env.tools,
    workflowAllowedTools: workflowAllowedTools?.normalized,
    ...(options.purpose === "todo_continuation"
      ? { requiredTools: [TODO_CONTINUATION_REQUIRED_TOOL] }
      : {}),
  });
  const runBudget = narrowRunBudgets(
    options.fallbackRunBudget,
    node?.runBudget,
  );
  return {
    model: model.adapter,
    modelRef,
    resolvedModel: model.resolved,
    ...(node ? { nodeId: node.id } : {}),
    ...(node && env.workflowRecord
      ? { attempt: env.workflowRecord.attempts[node.id] ?? 1 }
      : {}),
    ...(runBudget ? { runBudget } : {}),
    budgetScope: options.purpose,
    toolSurface,
  };
}

function narrowRunBudgets(
  upstream: RunBudget | undefined,
  downstream: RunBudget | undefined,
): RunBudget | undefined {
  if (!upstream) return downstream ? { ...downstream } : undefined;
  if (!downstream) return { ...upstream };
  const minimum = (
    left: number | undefined,
    right: number | undefined,
  ): number | undefined => {
    if (left === undefined) return right;
    if (right === undefined) return left;
    return Math.min(left, right);
  };
  return {
    maxDurationMs: minimum(upstream.maxDurationMs, downstream.maxDurationMs),
    maxModelCalls: minimum(upstream.maxModelCalls, downstream.maxModelCalls),
    maxToolCalls: minimum(upstream.maxToolCalls, downstream.maxToolCalls),
    maxTokens: minimum(upstream.maxTokens, downstream.maxTokens),
    maxCostUsd: minimum(upstream.maxCostUsd, downstream.maxCostUsd),
  };
}

function workflowActorEpisodeRunMetadata(
  base: Record<string, unknown>,
  episode: WorkflowActorEpisodePlan,
): Record<string, unknown> {
  return {
    ...base,
    resolvedModel: episode.resolvedModel,
    workflowEpisode: workflowActorEpisodeMetadata(episode),
  };
}

function workflowActorEpisodeMetadata(
  episode: WorkflowActorEpisodePlan,
): Record<string, unknown> {
  return {
    modelRef: episode.modelRef,
    budgetScope: episode.budgetScope,
    ...(episode.nodeId ? { nodeId: episode.nodeId } : {}),
    ...(episode.attempt !== undefined ? { attempt: episode.attempt } : {}),
    ...(episode.runBudget ? { runBudget: { ...episode.runBudget } } : {}),
  };
}

function workflowEpisodeMetadataFromRun(
  run: ReturnType<typeof createRun>,
): Record<string, unknown> | undefined {
  const raw = run.record.metadata.workflowEpisode;
  return isPlainRecord(raw) ? cloneJsonLike(raw) : undefined;
}

function appendWorkflowEpisodeUsage(
  metadata: Record<string, unknown>,
  entry: {
    runId: RunId;
    state: RunResult["state"];
    stopReason?: RunResult["stopReason"];
    episode?: Record<string, unknown>;
    usage: ReturnType<ReturnType<typeof createRun>["usage"]>;
  },
): Record<string, unknown> {
  const entries = Array.isArray(metadata.workflowEpisodeUsage)
    ? metadata.workflowEpisodeUsage.filter(isPlainRecord).map(cloneJsonLike)
    : [];
  const next = [
    ...entries,
    {
      at: new Date().toISOString(),
      runId: entry.runId,
      state: entry.state,
      ...(entry.stopReason ? { stopReason: entry.stopReason } : {}),
      ...(entry.episode ? { episode: cloneJsonLike(entry.episode) } : {}),
      usage: cloneJsonLike(entry.usage),
    },
  ];
  return {
    ...metadata,
    workflowEpisodeUsage: next,
    workflowUsage: summarizeWorkflowEpisodeUsage(next),
  };
}

function summarizeWorkflowEpisodeUsage(
  entries: readonly Record<string, unknown>[],
): Record<string, unknown> {
  let modelCalls = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  for (const entry of entries) {
    const usage = isPlainRecord(entry.usage) ? entry.usage : {};
    modelCalls += numericField(usage, "modelCalls");
    toolCalls += numericField(usage, "toolCalls");
    costUsd += numericField(usage, "costUsd");
    const tokens = isPlainRecord(usage.tokens) ? usage.tokens : {};
    inputTokens += numericField(tokens, "input");
    outputTokens += numericField(tokens, "output");
    totalTokens += numericField(tokens, "total");
    cachedTokens += numericField(tokens, "cached");
  }
  return {
    episodes: entries.length,
    modelCalls,
    toolCalls,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: totalTokens,
      cached: cachedTokens,
    },
    costUsd,
  };
}

function resolveWorkflowEpisodeMaxSteps(
  profile: AgentProfile,
  runBudget: RunBudget | undefined,
): number {
  const base = resolveMainAgentMaxSteps(profile);
  if (runBudget?.maxModelCalls !== undefined) {
    return Math.min(base, runBudget.maxModelCalls);
  }
  return base;
}

function currentWorkflowRecordNode(
  record: WorkflowRunRecord | undefined,
): WorkflowNodeDefinition | undefined {
  if (!record?.definitionSnapshot || !record.currentNodeId) return undefined;
  return record.definitionSnapshot.nodes.find(
    (candidate) => candidate.id === record.currentNodeId,
  );
}

function workflowNodeModelRef(
  definition: WorkflowDefinition,
  node: WorkflowNodeDefinition,
): string | undefined {
  if (!node.model) return undefined;
  const tiers = workflowModelTiers(definition);
  return tiers[node.model] ?? node.model;
}

function workflowModelTiers(
  definition: WorkflowDefinition,
): Record<string, string> {
  const config = definition.config;
  if (!isPlainRecord(config)) return {};
  const raw = isPlainRecord(config.modelTiers)
    ? config.modelTiers
    : isPlainRecord(config.model_tiers)
      ? config.model_tiers
      : undefined;
  if (!raw) return {};
  return Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) =>
      typeof value === "string" && value.trim() !== ""
        ? [[key, value.trim()]]
        : [],
    ),
  );
}

function numericField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function workflowEpisodeAllowedTools(
  record: WorkflowRunRecord | undefined,
): { nodeId: string; normalized: string[] } | undefined {
  if (!record?.definitionSnapshot || !record.currentNodeId) return undefined;
  const node = record.definitionSnapshot.nodes.find(
    (candidate) => candidate.id === record.currentNodeId,
  );
  if (!node || (node.execute !== undefined && node.execute !== "model")) {
    return undefined;
  }
  if (!node.tools || node.tools.length === 0) return undefined;
  return {
    nodeId: node.id,
    normalized: [...new Set(node.tools)],
  };
}

// Actor-owned resume boundary for P3 input waits. The actor consumes the
// external input event before it starts the next transient worker run.
function workflowWaitingInputMetadata(
  record: WorkflowRunRecord,
  fallback: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const staged = record.metadata.pendingWorkflowControlInput;
  if (!isPlainRecord(staged) || typeof staged.value !== "string") {
    return fallback ?? {};
  }
  return {
    ...(fallback ?? {}),
    workflowControlInput: {
      value: staged.value,
      commandId:
        typeof staged.commandId === "string" ? staged.commandId : undefined,
      waitId: typeof staged.waitId === "string" ? staged.waitId : undefined,
      source: isPlainRecord(staged.source) ? staged.source : undefined,
    },
  };
}

async function consumeWorkflowActorWaitingInput(
  writer: WorkflowLeaseBoundWriter | undefined,
  record: WorkflowRunRecord,
  input: { metadata?: Record<string, unknown> },
): Promise<WorkflowRunRecord> {
  if (!writer)
    throw new Error(`Workflow run ${record.id} has no lease-bound writer.`);
  if (record.status !== "waiting") return record;
  if (!record.wait) {
    throw new Error(`Workflow run ${record.id} is waiting without wait state.`);
  }
  if (record.wait.kind !== "input") {
    throw new Error(
      `Workflow run ${record.id} is waiting for ${record.wait.kind}; workflow.resume can only consume input waits in P3 Step 3.`,
    );
  }
  if (!record.definitionSnapshot) {
    throw new Error(
      `Workflow run ${record.id} does not contain a pinned definition snapshot.`,
    );
  }
  if (!record.currentNodeId) {
    throw new Error(
      `Workflow run ${record.id} is waiting without a current node.`,
    );
  }
  const node = record.definitionSnapshot.nodes.find(
    (candidate) => candidate.id === record.currentNodeId,
  );
  if (!node || node.execute !== "human") {
    throw new Error(
      `Workflow run ${record.id} input wait is not positioned on a human node.`,
    );
  }
  const attempt = record.attempts[node.id] ?? 1;
  const verdict = {
    status: "passed" as const,
    reason: "human_input_received",
    metadata: {
      wait: record.wait,
      resumeMetadata: input.metadata ?? {},
    },
  };
  const advanced = advanceWorkflowState({
    definition: record.definitionSnapshot,
    state: runtimeStateFromWorkflowRecord(record),
    verdict,
  });
  const at = new Date().toISOString();
  const evidenceRef = {
    kind: "fact" as const,
    ref: `workflow-input:${record.id}:${at}`,
    nodeId: node.id,
    metadata: {
      wait: record.wait,
      resumeMetadata: input.metadata ?? {},
    },
  };
  const status = workflowStatusFromRuntimeState(advanced.state);
  const patch = {
    status,
    clearWait: true,
    ...(advanced.state.currentNodeId
      ? { currentNodeId: advanced.state.currentNodeId }
      : {}),
    attempts: advanced.state.attempts,
    evidenceRefs: appendWorkflowEvidenceRef(record.evidenceRefs, evidenceRef),
    verdictLog: [
      ...record.verdictLog,
      {
        at,
        nodeId: node.id,
        attempt,
        verdict,
        evidenceRefs: [evidenceRef],
      },
    ],
    transitionLog: advanced.state.transitionLog,
    metadata: {
      resumedFromWait: true,
      consumedWaitKind: record.wait.kind,
      consumedWaitNodeId: node.id,
      pendingWorkflowControlInput: null,
    },
    ...(advanced.state.failure
      ? {
          failure: {
            kind: "verdict" as const,
            code: "workflow.verdict",
            message: advanced.state.failure.reason,
            ...(advanced.state.failure.nodeId
              ? { nodeId: advanced.state.failure.nodeId }
              : {}),
            ...(advanced.state.failure.metadata
              ? { metadata: advanced.state.failure.metadata }
              : {}),
          },
        }
      : {}),
  };
  return writer.mutate({
    expectedRevision: record.recordRevision ?? 0,
    patch,
    event: {
      at,
      type: "input",
      workflowRunId: record.id,
      parentRunId: record.parentRunId,
      status,
      metadata: {
        wait: record.wait,
        nodeId: node.id,
        decision: advanced.decision,
        resumeMetadata: input.metadata ?? {},
      },
    },
  });
}

function workflowStatusFromRuntimeState(
  state: WorkflowRuntimeState,
): WorkflowRunStatus {
  if (state.status === "completed") return "completed";
  if (state.status === "failed") return "failed";
  return "running";
}

async function mutateWorkflowRecord(
  writer: WorkflowLeaseBoundWriter | undefined,
  record: WorkflowRunRecord,
  patch: Parameters<WorkflowLeaseBoundWriter["mutate"]>[0]["patch"],
  eventType?: Parameters<
    WorkflowLeaseBoundWriter["mutate"]
  >[0]["event"]["type"],
): Promise<WorkflowRunRecord> {
  if (!writer)
    throw new Error(`Workflow run ${record.id} has no lease-bound writer.`);
  const status = patch.status ?? record.status;
  const type =
    eventType ??
    (status === "completed"
      ? "completed"
      : status === "failed"
        ? "failed"
        : status === "cancelled"
          ? "cancelled"
          : status === "waiting"
            ? "waiting"
            : "updated");
  return writer.mutate({
    expectedRevision: record.recordRevision ?? 0,
    patch,
    event: {
      at: patch.now?.() ?? new Date().toISOString(),
      type,
      workflowRunId: record.id,
      parentRunId: record.parentRunId,
      status,
      metadata: {
        currentNodeId: patch.currentNodeId,
        wait: patch.wait,
        failure: patch.failure,
      },
    },
  });
}

async function compensateWorkflowRecord(
  writer: WorkflowLeaseBoundWriter | undefined,
  current: WorkflowRunRecord,
  prior: WorkflowRunRecord,
  reason: string,
): Promise<WorkflowRunRecord> {
  if (!writer)
    throw new Error(`Workflow run ${prior.id} has no lease-bound writer.`);
  const at = new Date().toISOString();
  return writer.compensate({
    expectedRevision: current.recordRevision ?? 0,
    patch: {
      status: prior.status,
      ...(prior.currentNodeId ? { currentNodeId: prior.currentNodeId } : {}),
      ...(prior.wait ? { wait: prior.wait } : { clearWait: true }),
      attempts: prior.attempts,
      parallelBranches: prior.parallelBranches,
      evidenceRefs: prior.evidenceRefs,
      verdictLog: prior.verdictLog,
      transitionLog: prior.transitionLog,
      ...(prior.failure ? { failure: prior.failure } : { clearFailure: true }),
      metadata: {
        compensationReason: reason,
        compensatesRevision: current.recordRevision,
      },
      now: () => at,
    },
    event: {
      at,
      type: prior.status === "waiting" ? "waiting" : "updated",
      workflowRunId: prior.id,
      parentRunId: prior.parentRunId,
      status: prior.status,
      metadata: {
        compensation: true,
        reason,
        compensatesRevision: current.recordRevision,
      },
    },
  });
}

function completedWorkflowNodeIds(
  record: WorkflowRunRecord,
  definition: WorkflowDefinition,
): string[] {
  const currentNodeId = record.currentNodeId;
  const verifierNodeIds = new Set(
    definition.nodes
      .filter((node) => (node.verify?.length ?? 0) > 0)
      .map((node) => node.id),
  );
  const latestVerifierVerdicts = new Map<string, WorkflowNodeVerdictLogEntry>();
  for (const entry of record.verdictLog) {
    if (entry.nodeId === currentNodeId) continue;
    if (!verifierNodeIds.has(entry.nodeId)) continue;
    latestVerifierVerdicts.set(entry.nodeId, entry);
  }
  return definition.nodes
    .map((node) => node.id)
    .filter(
      (nodeId) =>
        latestVerifierVerdicts.get(nodeId)?.verdict.status === "passed",
    );
}

function appendWorkflowEvidenceRef(
  refs: readonly WorkflowEvidenceRef[],
  ref: WorkflowEvidenceRef,
): WorkflowEvidenceRef[] {
  if (
    refs.some(
      (existing) =>
        existing.kind === ref.kind &&
        existing.ref === ref.ref &&
        existing.nodeId === ref.nodeId &&
        existing.verifierId === ref.verifierId,
    )
  ) {
    return refs.map((existing) => ({ ...existing }));
  }
  return [...refs.map((existing) => ({ ...existing })), { ...ref }];
}

function workflowRunSnapshot(record: WorkflowRunRecord): WorkflowRunSnapshot {
  return {
    id: record.id,
    ...(record.generation !== undefined
      ? { generation: record.generation }
      : {}),
    ...(record.recordRevision !== undefined
      ? { recordRevision: record.recordRevision }
      : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    status: record.status,
    assetName: record.assetName,
    ...(record.version ? { version: record.version } : {}),
    contentHash: record.contentHash,
    ...(record.activeRunId ? { activeRunId: record.activeRunId } : {}),
    runIds: record.runIds.map(String),
    ...(record.currentNodeId ? { currentNodeId: record.currentNodeId } : {}),
    attempts: { ...record.attempts },
    ...(record.verdictLog.length > 0
      ? {
          latestVerdict: (() => {
            const latest = record.verdictLog[record.verdictLog.length - 1]!;
            return {
              nodeId: latest.nodeId,
              attempt: latest.attempt,
              verdict: cloneJsonLike(latest.verdict) as Record<string, unknown>,
              ...(latest.at ? { at: latest.at } : {}),
            };
          })(),
        }
      : {}),
    ...(record.wait
      ? {
          wait: {
            ...record.wait,
            metadata: record.wait.metadata
              ? { ...record.wait.metadata }
              : undefined,
          },
        }
      : {}),
    ...(record.failure
      ? {
          failure: {
            ...record.failure,
            metadata: record.failure.metadata
              ? { ...record.failure.metadata }
              : undefined,
          },
        }
      : {}),
    resume: { ...record.resume },
    ...(record.authorizationSnapshot
      ? {
          // Project only the presence + policy summary. The confidential path
          // list and target path stay server-side (re-applied from the record
          // on resume) so they are not broadcast in every list row.
          authorizationSnapshot: {
            hasTargetPath: Boolean(record.authorizationSnapshot.targetPath),
            hasConfidentialPaths:
              record.authorizationSnapshot.confidentialPaths.length > 0,
            confidentialDefaults:
              record.authorizationSnapshot.confidentialDefaults,
            accessMode: record.authorizationSnapshot.accessMode,
            backgroundTasks: record.authorizationSnapshot.backgroundTasks,
          },
        }
      : {}),
    createdAt: record.createdAt,
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    metadata: { ...record.metadata },
  };
}

async function persistWorkflowProjectionSnapshot(
  writer: WorkflowLeaseBoundWriter,
  record: WorkflowRunRecord,
  snapshot: WorkflowProjectionStateSnapshot,
): Promise<WorkflowRunRecord> {
  if (isTerminalWorkflowRunStatus(record.status)) return record;
  const state = snapshot.state;
  const verdictLog =
    snapshot.verdict && snapshot.nodeId && snapshot.attempt !== undefined
      ? [
          ...record.verdictLog,
          {
            at: new Date().toISOString(),
            nodeId: snapshot.nodeId,
            attempt: snapshot.attempt,
            verdict: cloneJsonLike(snapshot.verdict),
            evidenceRefs: snapshot.evidenceRefs?.map((ref) => ({
              ...ref,
              metadata: ref.metadata ? { ...ref.metadata } : undefined,
            })),
          },
        ]
      : record.verdictLog;
  const evidenceRefs =
    snapshot.evidenceRefs && snapshot.evidenceRefs.length > 0
      ? snapshot.evidenceRefs.reduce(
          (refs, ref) => appendWorkflowEvidenceRef(refs, ref),
          record.evidenceRefs,
        )
      : record.evidenceRefs;
  const status =
    snapshot.phase === "waiting"
      ? "waiting"
      : (snapshot.terminalStatus ??
        (state.status === "completed"
          ? "completed"
          : state.status === "failed"
            ? "failed"
            : "running"));
  const failure = snapshot.failure
    ? ({
        kind: snapshot.failure.kind,
        code: snapshot.failure.code,
        message: snapshot.failure.message,
        nodeId: snapshot.nodeId,
        metadata: snapshot.failure.metadata,
      } satisfies WorkflowRunFailure)
    : undefined;
  const projectionEpisodeMetadata = workflowProjectionEpisodeMetadata(
    record,
    snapshot,
  );
  const projectionAllowedTools = workflowProjectionAllowedTools(snapshot);
  return mutateWorkflowRecord(writer, record, {
    status,
    currentNodeId: state.currentNodeId,
    ...(snapshot.phase === "waiting" && snapshot.wait
      ? { wait: snapshot.wait }
      : record.wait
        ? { clearWait: true }
        : {}),
    attempts: state.attempts,
    ...(state.parallelBranches
      ? { parallelBranches: cloneJsonLike(state.parallelBranches) }
      : {}),
    evidenceRefs,
    verdictLog,
    transitionLog: state.transitionLog,
    ...(failure ? { failure } : {}),
    metadata: {
      lastProjectionPhase: snapshot.phase,
      ...(projectionEpisodeMetadata
        ? { workflowEpisode: projectionEpisodeMetadata }
        : {}),
      ...(projectionAllowedTools
        ? { episodeAllowedTools: projectionAllowedTools.normalized }
        : {}),
      ...(snapshot.metadata ? { projectionMetadata: snapshot.metadata } : {}),
    },
  });
}

function workflowProjectionEpisodeMetadata(
  record: WorkflowRunRecord,
  snapshot: WorkflowProjectionStateSnapshot,
): Record<string, unknown> | undefined {
  const node = workflowProjectionModelNode(snapshot);
  if (!node) return undefined;
  const previous = isPlainRecord(record.metadata.workflowEpisode)
    ? cloneJsonLike(record.metadata.workflowEpisode)
    : {};
  const nodeModelRef = workflowNodeModelRef(snapshot.definition, node);
  return {
    ...previous,
    ...(nodeModelRef ? { modelRef: nodeModelRef } : {}),
    nodeId: node.id,
    attempt: snapshot.attempt ?? snapshot.state.attempts[node.id] ?? 1,
    ...(node.runBudget ? { runBudget: { ...node.runBudget } } : {}),
  };
}

function workflowProjectionAllowedTools(
  snapshot: WorkflowProjectionStateSnapshot,
): { nodeId: string; normalized: string[] } | undefined {
  const node = workflowProjectionModelNode(snapshot);
  if (!node?.tools || node.tools.length === 0) return undefined;
  return {
    nodeId: node.id,
    normalized: [...new Set(node.tools)],
  };
}

function workflowProjectionModelNode(
  snapshot: WorkflowProjectionStateSnapshot,
): WorkflowNodeDefinition | undefined {
  if (snapshot.phase !== "node_started" || !snapshot.nodeId) return undefined;
  const node = snapshot.definition.nodes.find(
    (candidate) => candidate.id === snapshot.nodeId,
  );
  if (!node || (node.execute !== undefined && node.execute !== "model")) {
    return undefined;
  }
  return node;
}

function isTerminalWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function workflowLeaseOwner(): string {
  return `host:${process.pid}`;
}

function cloneJsonLike<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findNestedString(value: unknown, key: string): string | undefined {
  if (!isPlainRecord(value)) return undefined;
  const direct = recordString(value, key);
  if (direct) return direct;
  for (const nested of Object.values(value)) {
    const found = findNestedString(nested, key);
    if (found) return found;
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionCompactWarningContextItem(
  sessionId: string,
  message: string,
  metadata: Record<string, unknown> = {},
): ContextItem {
  return {
    id: createContextItemId(),
    type: "summary",
    source: { kind: "session_compact_warning", uri: sessionId },
    content: message,
    metadata: {
      layer: "conversation",
      stability: "session",
      sessionId,
      compactionWarning: true,
      ...metadata,
    },
  };
}

/** A summarized successful tool result salvaged from a child run's events. */
interface PartialObservation {
  toolName: string;
  output: string;
}

const PARTIAL_OBSERVATION_OUTPUT_CHAR_LIMIT = 600;

/**
 * Salvage the child's most recent successful tool results from its event log so
 * a parent can still use the work even when the child run *failed* (doom-loop,
 * step-limit, error) without ever emitting a final answer. Without this, a child
 * that discovered everything it needed but tripped a guard on the last step
 * returns only an error string, forcing the parent to re-spawn and rediscover
 * the same data from scratch.
 *
 * Pairs `tool.requested` (carries `toolName`) with `tool.completed` (carries the
 * `output`, keyed by `toolCallId`) and returns the last `maxObservations`
 * successful results, each truncated so a large listing cannot blow up the
 * parent's context.
 */
function extractPartialObservations(
  events: readonly SparkwrightEvent[],
  maxObservations: number,
): PartialObservation[] {
  const toolNameByCallId = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "tool.requested") continue;
    const payload = event.payload as
      | { id?: unknown; toolName?: unknown }
      | undefined;
    if (
      typeof payload?.id === "string" &&
      typeof payload.toolName === "string"
    ) {
      toolNameByCallId.set(payload.id, payload.toolName);
    }
  }

  const observations: PartialObservation[] = [];
  for (const event of events) {
    if (event.type !== "tool.completed") continue;
    const payload = event.payload as
      | { toolCallId?: unknown; output?: unknown }
      | undefined;
    if (payload?.output === undefined) continue;
    const toolName =
      (typeof payload.toolCallId === "string"
        ? toolNameByCallId.get(payload.toolCallId)
        : undefined) ?? "tool";
    let serialized: string;
    try {
      serialized = JSON.stringify(payload.output);
    } catch {
      serialized = String(payload.output);
    }
    if (serialized.length > PARTIAL_OBSERVATION_OUTPUT_CHAR_LIMIT) {
      serialized = `${serialized.slice(
        0,
        PARTIAL_OBSERVATION_OUTPUT_CHAR_LIMIT,
      )}… (truncated)`;
    }
    observations.push({ toolName, output: serialized });
  }

  return observations.slice(-maxObservations);
}

function startWorkflowLeaseRefresh(
  lease: WorkflowLeaseBoundWriter | undefined,
): () => void {
  if (!lease) return () => {};
  const refreshMs = Math.max(1_000, Math.floor(WORKFLOW_LEASE_TTL_MS / 2));
  const timer = setInterval(() => {
    void lease.refresh(WORKFLOW_LEASE_TTL_MS).catch(() => {});
  }, refreshMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
