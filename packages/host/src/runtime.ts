import { readdir, stat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  buildTraceTimelineFile,
  asSessionId,
  createBufferedEmitter,
  createContextItemId,
  createDeterministicSessionSummarizer,
  createRunId,
  createDefaultPolicy,
  createLayeredPolicy,
  DEFAULT_CONFIDENTIAL_PATHS,
  createSessionId,
  createSessionRunStoreFactory,
  loadSessionCompactArtifact,
  loadTraceEventsFile,
  createPermissionModePolicy,
  createRun,
  createWorkspaceMutationPolicy,
  createWorkspaceReadScopePolicy,
  defineTool,
  FileSessionStore,
  EventLog,
  forkSessionFromEvent,
  loadCheckpointFromRunDir,
  resumeRunFromCheckpoint,
  summarizeTraceFile,
  compactSessionTurns,
  sessionCompactArtifactToContextItem,
  sessionTurnToContextItems,
  SESSION_COMPACT_FILENAME,
  SESSION_COMPACT_SCHEMA_VERSION,
  validateSessionTraceConsistency,
  writeSessionCompactArtifact,
  type ApprovalResolver,
  type CompactionWarning,
  type ContentPart,
  type ContextItem,
  type EventEmitter,
  type ModelAdapter,
  type Policy,
  type RunId,
  type RunBudget,
  type RunRecord,
  type RunResult,
  type RuntimeContext,
  type RunAccessMode,
  type ContextUsageHint,
  type SessionCompactArtifact,
  type SessionCompactionMeasurement,
  type SessionCompactionOptions,
  type SessionEvent,
  type SparkwrightEvent,
  type SessionTraceFacts,
  type ToolDefinition,
  type ToolOrigin,
  type WorkflowHook,
} from "@sparkwright/core";
import {
  prepareSkillsForRun,
  type LoadedSkill,
  type SkillIndexEntry,
  type SkillPreprocessOptions,
} from "@sparkwright/skills";
import {
  createLazyMcpToolsForRun,
  prepareMcpToolsForRun,
  type McpServerConfig,
  type McpStatus,
  type McpToolNameMapping,
} from "@sparkwright/mcp-adapter";
import {
  FileTaskStore,
  TaskManager,
  createAgentTool,
  createAgentProfilePolicy,
  deriveChildAgentProfile,
  findSimilarSuccessfulDelegation,
  rememberSuccessfulDelegation,
  runTodoSupervised,
  spawnSubAgent,
  summarizeDelegationResult,
  withAlreadyCompletedNote,
  type AgentProfile,
  type AgentProfileWorkflowHookConfig,
  type DelegationLedgerHit,
  type DelegationLedgerKey,
  type DerivedChildAgentProfile,
  type TaskId,
  type TaskOutputChunk,
  type TaskRecord,
  type TaskRunnerController,
  type TaskStatus,
  type TodoSupervisedRunInput,
} from "@sparkwright/agent-runtime";
import { CronStore, defaultCronRoot } from "@sparkwright/cron";
import { RECOMMENDED_FOREGROUND_TIMEOUT_MS } from "@sparkwright/shell-tool";
import {
  createPlatformShellSandboxRuntime,
  describeShellSandboxStatus,
  resolveShellSandboxConfig,
  type ResolvedShellSandboxConfig,
  type ShellSandboxStatus,
} from "@sparkwright/shell-sandbox";
import type {
  CapabilitySkillsConfig,
  CapabilityDelegateToolConfig,
  CapabilityEventHookConfig,
  CapabilityHooksConfig,
  CapabilityToolsConfig,
  CapabilityWorkflowHookConfig,
  ShellConfig,
  TaskConfig,
  WriteGuardrailsConfig,
} from "./config.js";
import {
  createSessionFileRunStoreFactory,
  LocalWorkspace,
  MemoryTrace,
} from "@sparkwright/core/internal";
import {
  isTraceLevel,
  type PermissionMode,
  type TraceLevel,
  type HostEvent,
  type ProtocolError,
  type RunFailureEnvelope,
  type RunResumeRequestPayload,
  type RunStartRequestPayload,
  type RunInputPart,
  type SessionCompactionInspectArtifact,
  type SessionCompactionInspectEvent,
  type SessionCompactionInspectReport,
  type TaskOutputChunkSnapshot,
  type TaskRecordSnapshot,
  type CapabilitySnapshot,
  type CapabilityAutomationSummary,
  type CapabilityModelSummary,
  type CapabilitySkillInlineShellSummary,
  type CapabilityEventRuleSummary,
  type CapabilityWorkflowRuleSummary,
} from "@sparkwright/protocol";
import { buildAgentPromptBuilder } from "@sparkwright/project-context";
import {
  DETERMINISTIC_PROVIDER,
  loadHostConfig,
  type CapabilityMcpConfig,
} from "./config.js";
import {
  resolveAgentProfiles,
  type AgentProfileCollision,
} from "./agent-profiles.js";
import { MAIN_AGENT_ID } from "./agent-constants.js";
import { buildAccessMetadata, resolveRunAccessFields } from "./run-access.js";
import {
  existingSkillRoots,
  resolveSkillRootsForRuntime,
} from "./skill-roots.js";
import { nextMessageId, nowIso } from "./connection.js";
import {
  createModel,
  inspectResolvedModelConfig,
  type ResolvedModelConfig,
} from "./model-factory.js";
import { createModelSessionSummarizer } from "./session-summarizer.js";
import {
  catalogEntryOrigin,
  catalogToolDefinitions,
  createConfiguredDelegateChildToolCatalog,
  createMainHostToolCatalog,
  createReadOnlyChildToolCatalog,
  type HostToolCatalogEntry,
} from "./tool-catalog.js";
import { canonicalToolName } from "./tool-identities.js";
import {
  acpConfigFromAgentProfile,
  createAcpDelegateTool,
} from "./acp-child-agent.js";
import {
  createExternalCommandDelegateTool,
  externalCommandConfigFromAgentProfile,
} from "./external-command-agent.js";
import { createSkillInlineShellRunner } from "./skill-inline-shell.js";
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
} from "./delegate-capability.js";
import {
  bindConfiguredEventHooks,
  createConfiguredWorkflowHooks,
} from "./workflow-hooks.js";
import { createVerificationWorkflowHooks } from "./verification.js";
import { createDocumentedCommandStopHook } from "./documented-command-check.js";
import {
  describeActiveEventRules,
  describeActiveWorkflowRules,
} from "./active-rules.js";
import {
  DISCOVERY_TOOL_NAME,
  WORKSPACE_WRITE_TOOL_NAMES,
  intersectToolUseSelectors,
  resolveSelectorAllowlist,
} from "./tool-selectors.js";

/**
 * Skills flagged `metadata.devOnly: true` (test/development fixtures) are kept
 * out of run candidate sets unless `SPARKWRIGHT_DEV_SKILLS` is explicitly
 * enabled. This stops smoke-test skills from mis-triggering in real sessions.
 */
function devSkillsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SPARKWRIGHT_DEV_SKILLS;
  return value === "1" || value === "true";
}

function createHostRunPolicy(input: {
  permissionMode: PermissionMode;
  shouldWrite: boolean;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  writeGuardrails?: WriteGuardrailsConfig;
}): Policy {
  // Config write guardrails override the built-in defaults when present. The
  // defaults: explicit --target runs stay bounded to that single file, while
  // untargeted write runs get a small multi-file budget so real code+test
  // changes can complete. In-place edits (edit_anchored_text / apply_patch)
  // need to remove the lines they replace, so deletions default to permitted.
  return createLayeredPolicy([
    createPermissionModePolicy({ mode: input.permissionMode }),
    createWorkspaceMutationPolicy({
      allowWorkspaceWrites: input.shouldWrite,
      allowedPaths: input.targetPath ? [input.targetPath] : undefined,
      maxWriteFiles:
        input.writeGuardrails?.maxFiles ?? (input.targetPath ? 1 : 4),
      maxDiffLines: input.writeGuardrails?.maxDiffLines ?? 200,
      allowDeletions: input.writeGuardrails?.allowDeletions ?? true,
    }),
    // Opt-in read-confidentiality. Empty list is a no-op, so default runs are
    // unaffected; when set, reads of matching files are denied at the tool layer.
    createWorkspaceReadScopePolicy({
      confidentialPaths: [
        ...DEFAULT_CONFIDENTIAL_PATHS,
        ...(input.confidentialPaths ?? []),
      ],
    }),
  ]);
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
  shellSandbox?: ReturnType<typeof resolveShellSandboxConfig>;
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

export interface RuntimeOptions {
  /** Workspace root for all runs spawned through this runtime. */
  workspaceRoot: string;
  /** Session/trace storage root. Defaults to <workspaceRoot>/.sparkwright/sessions. */
  sessionRootDir?: string;
  /** Default model reference ("provider/model") when run.start omits one. */
  defaultModel?: string;
  /** Default high-level access mode when run.start does not specify one. */
  defaultAccessMode?: RunAccessMode;
  /** Project/runtime ceiling for requested high-level access modes. */
  accessModeCeiling?: RunAccessMode;
  /** Default permission mode when run.start does not specify one. */
  defaultPermissionMode?: PermissionMode;
  /** Default trace level when run.start does not specify one. */
  defaultTraceLevel?: TraceLevel;
  /** Default workspace-write permission when run.start does not specify one. */
  defaultShouldWrite?: boolean;
  /** Session-scoped MCP servers supplied by an embedding protocol (for example ACP). */
  extraMcpServers?: readonly McpServerConfig[];
  /** Called to deliver host events to the client. */
  emit: (event: HostEvent) => void;
}

interface PendingApproval {
  approvalId: string;
  runId: string;
  resolve: (response: {
    decision: "approved" | "denied";
    message?: string;
    autoApproved?: boolean;
  }) => void;
}

interface ActiveRun {
  runId: string;
  run: ReturnType<typeof createRun>;
  trace: MemoryTrace;
  sessionId: string;
  closeCapabilities?: () => Promise<void>;
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
  runIdHolder: { value: string | null };
  approvalResolver: ApprovalResolver;
  model: ModelAdapter;
  preparedSkills: PreparedSkills | null;
  preparedMcp: PreparedMcp | null;
  mainAgent: AgentProfile;
  toolCatalog: HostToolCatalogEntry[];
  tools: ToolDefinition[];
  workflowHooks: WorkflowHook[];
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
  runMetadata: Record<string, unknown>;
  runStoreMetadata: Record<string, unknown>;
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
function stripGoalDecorations(content: string): string {
  return content
    .replace(/<env>[\s\S]*?<\/env>/g, "")
    .replace(/^\s*User request:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
export function sessionPreviewFromTranscriptLine(firstLine: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return firstLine;
  }
  const obj = parsed as {
    content?: unknown;
    messages?: Array<{ role?: unknown; content?: unknown }>;
  };
  if (Array.isArray(obj.messages)) {
    for (let i = obj.messages.length - 1; i >= 0; i--) {
      const m = obj.messages[i];
      if (!m || m.role !== "user" || typeof m.content !== "string") continue;
      const goal = stripGoalDecorations(m.content);
      if (goal) return goal;
    }
  }
  if (typeof obj.content === "string" && obj.content.trim()) {
    return stripGoalDecorations(obj.content);
  }
  return firstLine;
}

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

const DELEGATED_AGENT_CONTRACT = [
  "Delegated agent contract:",
  "- Do not ask the user directly. Your parent agent owns all user interaction.",
  "- If a safe read-only next step can make progress, take it instead of asking for confirmation.",
  "- If you are blocked by ambiguity, required approval, or missing capability, return a concise final message with status: needs_clarification, needs_approval, or blocked; include the question or requested action, a reasonable default when one exists, and any safe alternative.",
  "- For clear delegated goals, complete the task and return the result to the parent.",
].join("\n");

type SessionInspectOptions = {
  compaction?: boolean;
};

type SessionCompactSuccessResult = {
  ok: true;
  sessionId: string;
  compactedRunCount: number;
  throughRunId: string | null;
  originalCharCount: number;
  summaryCharCount: number;
  freedChars: number;
  measurement: SessionCompactionMeasurement;
  skippedReason?: string;
  warnings?: CompactionWarning[];
  artifactPath: string | null;
};

type SessionCompactResult =
  | SessionCompactSuccessResult
  | { ok: false; error: ProtocolError };

/**
 * Per-connection runtime. Maps protocol verbs onto core.createRun(),
 * threading events back out through `emit` as host events.
 *
 * A single connection runs at most one run at a time. Concurrent run.start
 * requests while another run is active reject with internal_error
 * (`run_already_active`); promoting to multiple parallel runs per
 * connection would be a v1.1 addition.
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
  childRunStoreFactory: (
    childAgentId: string,
  ) => ReturnType<typeof createSessionRunStoreFactory>;
  maxDepth?: number;
  sessionId?: string;
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
  // Latest per-run spawn deps for the registered `agent` background task kind.
  // Overwritten each run; the runner reads it once at execution start.
  private agentSpawnDeps: HostAgentTaskRunnerDeps | null = null;
  private readonly taskManager: TaskManager;
  private active: ActiveRun | null = null;
  // Synchronously-set reservation so two concurrent startRun() calls cannot
  // both pass the "is a run active?" guard before `this.active` is populated
  // (which only happens after `await createModel(...)`).
  private startingRun = false;
  // Set when the client cancels the current turn. Unlike run.cancel (which
  // targets one run and can lose a race against natural completion), this
  // aborts the whole todo-supervised chain so a single cancel stops every
  // continuation. Reset at the start of each new turn.
  private runChainCancelled = false;
  private pendingApprovals = new Map<string, PendingApproval>();
  private lastCapabilitySnapshot: CapabilitySnapshot | null = null;

  constructor(opts: RuntimeOptions) {
    this.opts = {
      ...opts,
      workspaceRoot: resolve(opts.workspaceRoot),
      ...(opts.sessionRootDir
        ? { sessionRootDir: resolve(opts.sessionRootDir) }
        : {}),
    };
    this.taskManager = new TaskManager({
      store: new FileTaskStore({
        rootDir: this.taskRootDir(),
        createRoot: false,
      }),
    });
    // Background agent jobs are a task `kind` whose runner drives a read-only
    // child run. Registered once; the runner reads the latest per-run spawn
    // deps published by prepareRun. See runAgentTask.
    this.taskManager.registerKind("agent", (controller, payload) =>
      this.runAgentTask(controller, payload),
    );
  }

  hasActiveRun(): boolean {
    return this.active !== null;
  }

  private taskRootDir(): string {
    return join(this.opts.workspaceRoot, ".sparkwright", "tasks");
  }

  private async runAgentTask(
    controller: TaskRunnerController,
    payload: unknown,
  ): Promise<unknown> {
    const deps = this.agentSpawnDeps;
    if (!deps) {
      throw Object.assign(
        new Error(
          "Agent task runner is not available until a run has prepared agent dependencies.",
        ),
        { code: "AGENT_TASK_UNAVAILABLE" },
      );
    }
    return runHostAgentTask(controller, payload, deps);
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

  async inspectCapabilities(
    input: { modelRef?: string } = {},
  ): Promise<
    | { ok: true; snapshot: CapabilitySnapshot }
    | { ok: false; error: ProtocolError }
  > {
    try {
      const configured = await this.inspectConfiguredCapabilities(input);
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
  async startRun(
    payload: RunStartRequestPayload,
  ): Promise<
    { ok: true; runId: string } | { ok: false; error: ProtocolError }
  > {
    if (this.active || this.startingRun) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: "another run is already active on this connection",
        },
      };
    }
    this.startingRun = true;
    try {
      return await this.startRunInner(payload);
    } finally {
      this.startingRun = false;
    }
  }

  async resumeRun(
    payload: RunResumeRequestPayload,
  ): Promise<
    | { ok: true; runId: string; resumedFromRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    if (this.active || this.startingRun) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: "another run is already active on this connection",
        },
      };
    }
    this.startingRun = true;
    try {
      return await this.resumeRunInner(payload);
    } finally {
      this.startingRun = false;
    }
  }

  private async prepareHostRunEnvironment(input: {
    goal: string;
    modelRef?: string;
    permissionMode: PermissionMode;
    shouldWrite: boolean;
    sessionId: string;
    targetPath?: string;
    confidentialPaths?: readonly string[];
    traceLevel?: TraceLevel;
    runMetadata?: Record<string, unknown>;
    runStoreMetadata?: Record<string, unknown>;
  }): Promise<
    | { ok: true; env: PreparedHostRunEnvironment }
    | { ok: false; error: ProtocolError }
  > {
    const model = await createModel({
      modelRef: input.modelRef,
      goal: input.goal,
      workspaceRoot: this.opts.workspaceRoot,
      targetPath: input.targetPath,
    });
    if (!model.ok) {
      return {
        ok: false,
        error: { code: "invalid_payload", message: model.message },
      };
    }

    const workspaceRoot = this.opts.workspaceRoot;
    const workspace = new LocalWorkspace(workspaceRoot);
    const sessionRootDir =
      this.opts.sessionRootDir ?? defaultSessionRootDir(workspaceRoot);
    const trace = new MemoryTrace();
    const pendingExtensionEvents = createBufferedEmitter();
    const runIdHolder: { value: string | null } = { value: null };
    const approvalResolver = this.createApprovalResolver(runIdHolder);
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
    const skillRoots = resolveSkillRootsForRuntime(
      workspaceRoot,
      skillConfig?.roots,
    );
    const shellSandbox = await inspectShellSandboxStatus({
      workspaceRoot,
      shellConfig,
      skillRoots: skillRoots.map((root) => root.root),
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
    });
    const mcpShellSandbox = resolveShellSandboxConfig({
      workspaceRoot,
      config: shellConfig?.sandbox,
      skillRoots: skillRoots.map((root) => root.root),
      extraForcedDenyWrite: loadedConfig.attempted.map((entry) => entry.path),
    });
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
      permissionMode: input.permissionMode,
      shouldWrite: input.shouldWrite,
      targetPath: input.targetPath,
      confidentialPaths: input.confidentialPaths,
      writeGuardrails,
    });
    const readOnlyChildToolCatalog = createReadOnlyChildToolCatalog({
      workspaceRoot,
      toolConfig,
    });
    const delegateChildToolCatalog = createConfiguredDelegateChildToolCatalog({
      workspaceRoot,
      toolConfig,
      shell: shellConfig,
      skillRoots: skillRoots.map((root) => root.root),
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
    });
    const derivedAgents = deriveConfiguredAgents(
      mainAgent,
      resolvedProfiles,
      delegateChildToolCatalog,
      pendingExtensionEvents,
    );
    const sessionStore = new FileSessionStore({ rootDir: sessionRootDir });
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
    const readOnlyChildTools = catalogToolDefinitions(readOnlyChildToolCatalog);
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
      approvalResolver,
      sandbox: shellConfig?.sandbox,
      skillRoots: skillRoots.map((root) => root.root),
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
      childRunStoreFactory,
      allowReadWriteWorkspaceAccess: input.shouldWrite,
      maxDepth: agentConfig?.maxDepth,
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
          approvalResolver,
          childRunStoreFactory,
          allowReadWriteWorkspaceAccess: input.shouldWrite,
          maxDepth: agentConfig?.maxDepth,
        })
      : undefined;
    const delegateDescriptors = describeConfiguredDelegateTools({
      delegates: delegateRouting.delegates,
      derivedAgents,
      delegateChildToolCatalog,
      allowReadWriteWorkspaceAccess: input.shouldWrite,
      routingByProfileId: delegateRouting.routingByProfileId,
    });
    const dynamicSpawnTool = createDynamicSpawnAgentTool({
      getParent: () => parentRunRef.current,
      model: model.adapter,
      modelForSpawn: dynamicSpawnModel,
      childTools: readOnlyChildTools,
      parentRunPolicy,
      childRunStoreFactory,
      maxDepth: agentConfig?.maxDepth,
    });
    // Publish spawn deps for the registered `agent` background task kind so a
    // `task_create(kind:"agent")` call can drive a read-only child run that the
    // task — not the foreground turn — owns the lifecycle of.
    this.agentSpawnDeps = {
      getParent: () => parentRunRef.current,
      model: model.adapter,
      modelForSpawn: dynamicSpawnModel,
      childTools: readOnlyChildTools,
      parentRunPolicy,
      childRunStoreFactory,
      maxDepth: agentConfig?.maxDepth,
      sessionId: input.sessionId,
    };
    const toolCatalog = createMainHostToolCatalog({
      workspaceRoot,
      skillRoots,
      toolConfig,
      taskManager: this.taskManager,
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
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
    });
    const tools = catalogToolDefinitions(toolCatalog);
    const workflowHooks = [
      ...createConfiguredWorkflowHooks({
        hooks: hookConfig?.workflow,
        workspaceRoot,
        sandbox: shellConfig?.sandbox,
        http: hookConfig?.http,
        skillRoots: skillRoots.map((root) => root.root),
        configPaths: loadedConfig.attempted.map((entry) => entry.path),
        getRun: () => parentRunRef.current,
        agentTool: delegateAgentTool,
      }),
      ...createVerificationWorkflowHooks({
        verification: loadedConfig.config.capabilities?.verification,
        workspaceRoot,
        sandbox: shellConfig?.sandbox,
        skillRoots: skillRoots.map((root) => root.root),
        configPaths: loadedConfig.attempted.map((entry) => entry.path),
      }),
      ...createDocumentedCommandStopHook({
        workspaceRoot,
        goal: input.goal,
        shouldWrite: input.shouldWrite,
      }),
    ];
    const workflowRules = describeActiveWorkflowRules({
      workflowHooks: hookConfig?.workflow,
      verification: loadedConfig.config.capabilities?.verification,
      documentedCommand: {
        goal: input.goal,
        shouldWrite: input.shouldWrite,
      },
    });
    const eventRules = describeActiveEventRules({
      eventHooks: hookConfig?.events,
    });
    this.lastCapabilitySnapshot = buildCapabilitySnapshot({
      model: modelCapabilitySummary(model.resolved),
      toolCatalog,
      indexedSkills: preparedSkills?.indexedSkills ?? [],
      loadedSkills: preparedSkills?.loadedSkills ?? [],
      skillInlineShell: inlineShellCapabilitySummary(
        skillConfig?.inlineShell,
        shellSandbox,
      ),
      mcpStatuses: preparedMcp?.statuses ?? {},
      mcpToolNameMap: preparedMcp?.toolNameMap ?? [],
      agentProfiles: [
        mainAgent,
        ...derivedAgents.map((agent) => agent.effectiveProfile),
      ],
      delegateTools: delegateDescriptors,
      shellSandbox,
      shellForegroundTimeoutMs:
        shellConfig?.foregroundTimeoutMs ?? RECOMMENDED_FOREGROUND_TIMEOUT_MS,
      shellPromotionAvailable: true,
      workflowRules,
      eventRules,
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
      permissionMode: input.permissionMode,
      traceLevel,
      ...(mcpWorkspaceCwdServers.length > 0 ? { mcpWorkspaceCwdServers } : {}),
      ...(input.modelRef ? { requestedModel: input.modelRef } : {}),
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
        runIdHolder,
        approvalResolver,
        model: model.adapter,
        preparedSkills,
        preparedMcp,
        mainAgent,
        toolCatalog,
        tools,
        workflowHooks,
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

  private createApprovalResolver(runIdHolder: {
    value: string | null;
  }): ApprovalResolver {
    return (request) =>
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
        this.pendingApprovals.set(approvalId, {
          approvalId,
          runId: currentRunId,
          resolve: (response) => resolve({ approvalId, ...response }),
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
      });
  }

  private async startSupervisedRunChain(input: {
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
    const runCleanups: Array<() => void> = [];
    const registerActiveRun = (
      run: ReturnType<typeof createRun>,
      runId: string,
    ): SparkwrightEvent[] => {
      env.parentRunRef.current = run;
      env.runIdHolder.value = runId;
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
        closeCapabilities: async () => {
          closeEventHooks();
          await env.preparedMcp?.close();
        },
      };
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
    this.runChainCancelled = false;

    const supervised = runTodoSupervised({
      todoPath,
      sessionId,
      maxContinuations: MAIN_TODO_MAX_CONTINUATIONS,
      maxStalledContinuations: MAIN_TODO_MAX_STALLED_CONTINUATIONS,
      runOnce: async (supervisedInput) => {
        const run = input.buildRun(supervisedInput);
        const runId = run.record.id;
        lastRunId = runId;
        const collected = registerActiveRun(run, runId);
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
        if (this.runChainCancelled) {
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
      .then((outcome) => {
        const handoff =
          !this.runChainCancelled && outcome.decision.kind === "handoff"
            ? {
                reason: outcome.decision.reason,
                message: outcome.decision.message,
              }
            : undefined;
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
        this.opts.emit({
          envelope: "event",
          id: nextMessageId("evt"),
          kind: "run.failed",
          timestamp: nowIso(),
          payload: {
            runId: lastRunId,
            failure,
            error: {
              code: "internal_error",
              message,
            },
          },
        });
      })
      .finally(() => {
        for (const cleanup of runCleanups.splice(0)) cleanup();
        void env.preparedMcp?.close().catch(() => {});
        this.active = null;
        for (const [id, p] of this.pendingApprovals) {
          p.resolve({ decision: "denied" });
          this.pendingApprovals.delete(id);
        }
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

  private async resumeRunInner(
    payload: RunResumeRequestPayload,
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

    const modelRef = payload.model ?? this.opts.defaultModel;
    const access = resolveRunAccessFields(payload, {
      defaultAccessMode: this.opts.defaultAccessMode,
      accessModeCeiling: this.opts.accessModeCeiling,
      defaultPermissionMode: this.opts.defaultPermissionMode,
      defaultShouldWrite: this.opts.defaultShouldWrite,
    });
    const { permissionMode, shouldWrite } = access;
    const accessMetadata = buildAccessMetadata(access);
    const resumeSessionId = located.sessionId ?? createSessionId();
    const prepared = await this.prepareHostRunEnvironment({
      goal: checkpoint.run.goal,
      modelRef,
      permissionMode,
      shouldWrite,
      sessionId: resumeSessionId,
      targetPath: payload.targetPath,
      confidentialPaths: payload.confidentialPaths,
      traceLevel: resolveTraceLevel({
        ...payload,
        defaultTraceLevel: this.opts.defaultTraceLevel,
      }),
      runMetadata: {
        resumedFromRunId: payload.runId,
        ...(payload.metadata ?? {}),
        ...accessMetadata,
        shouldWrite,
      },
      runStoreMetadata: {
        resumedFromRunId: payload.runId,
        ...(payload.metadata ?? {}),
        ...accessMetadata,
        shouldWrite,
        ...(payload.metadata ? { resumeMetadata: payload.metadata } : {}),
      },
    });
    if (!prepared.ok) return prepared;
    const env = prepared.env;

    const buildContinuationRun = (goal: string, extraContext: ContextItem[]) =>
      createRun({
        goal,
        context: [...(env.preparedSkills?.context ?? []), ...extraContext],
        workspace: env.workspace,
        approvalResolver: env.approvalResolver,
        policy: createHostRunPolicy({
          permissionMode,
          shouldWrite,
          targetPath: payload.targetPath,
          confidentialPaths: payload.confidentialPaths,
          writeGuardrails: env.writeGuardrails,
        }),
        promptBuilder: buildAgentPromptBuilder({
          cwd: env.workspaceRoot,
          sessionId: resumeSessionId,
        }),
        tools: env.tools,
        workflowHooks: env.workflowHooks,
        model: env.model,
        maxSteps: resolveTodoContinuationMaxSteps(env.mainAgent),
        runBudget: resolveTodoContinuationRunBudget(env.mainAgent),
        metadata: env.runMetadata,
        runStore: createSessionRunStoreFactory({
          sessionStore: env.sessionStore,
          sessionId: resumeSessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: env.sessionRootDir,
            sessionId: resumeSessionId,
            agentId: located.agentId,
            traceLevel: env.traceLevel,
          }),
          metadata: env.runStoreMetadata,
        }),
      });

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

    const started = await this.startSupervisedRunChain({
      env,
      todoPath: join(env.sessionRootDir, resumeSessionId, "todo.md"),
      sessionId: resumeSessionId,
      buildRun: (supervisedInput) =>
        supervisedInput.continuation
          ? buildContinuationRun(supervisedInput.continuation.prompt, [
              ...chainTurns,
              supervisedInput.continuation.context,
            ])
          : resumeRunFromCheckpoint(checkpoint, {
              force: payload.force,
              workspace: env.workspace,
              approvalResolver: env.approvalResolver,
              policy: createHostRunPolicy({
                permissionMode,
                shouldWrite,
                targetPath: payload.targetPath,
                confidentialPaths: payload.confidentialPaths,
                writeGuardrails: env.writeGuardrails,
              }),
              promptBuilder: buildAgentPromptBuilder({
                cwd: env.workspaceRoot,
                sessionId: resumeSessionId,
              }),
              tools: env.tools,
              model: env.model,
              maxSteps: resolveMainAgentMaxSteps(env.mainAgent),
              ...(env.mainAgent.runBudget !== undefined
                ? { runBudget: env.mainAgent.runBudget }
                : {}),
              metadata: env.runMetadata,
              runStore: createSessionRunStoreFactory({
                sessionStore: env.sessionStore,
                sessionId: resumeSessionId,
                runStoreFactory: createSessionFileRunStoreFactory({
                  sessionRootDir: env.sessionRootDir,
                  sessionId: resumeSessionId,
                  agentId: located.agentId,
                  traceLevel: env.traceLevel,
                }),
                metadata: env.runStoreMetadata,
              }),
            }),
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

  private async startRunInner(
    payload: RunStartRequestPayload,
  ): Promise<
    { ok: true; runId: string } | { ok: false; error: ProtocolError }
  > {
    const modelRef = payload.model ?? this.opts.defaultModel;
    const access = resolveRunAccessFields(payload, {
      defaultAccessMode: this.opts.defaultAccessMode,
      accessModeCeiling: this.opts.accessModeCeiling,
      defaultPermissionMode: this.opts.defaultPermissionMode,
      defaultShouldWrite: this.opts.defaultShouldWrite,
    });
    const { permissionMode, shouldWrite } = access;
    const accessMetadata = buildAccessMetadata(access);
    let sessionId: string;
    try {
      sessionId = payload.sessionId
        ? asSessionId(payload.sessionId)
        : createSessionId();
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const prepared = await this.prepareHostRunEnvironment({
      goal: payload.goal,
      modelRef,
      permissionMode,
      shouldWrite,
      sessionId,
      targetPath: payload.targetPath,
      confidentialPaths: payload.confidentialPaths,
      traceLevel: resolveTraceLevel({
        ...payload,
        defaultTraceLevel: this.opts.defaultTraceLevel,
      }),
      runMetadata: {
        ...(payload.metadata ?? {}),
        ...accessMetadata,
        shouldWrite,
      },
      runStoreMetadata: {
        ...(payload.metadata ?? {}),
        ...accessMetadata,
        shouldWrite,
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
    ) =>
      createRun({
        goal,
        context: [
          ...priorContext,
          ...(env.preparedSkills?.context ?? []),
          ...extraContext,
        ],
        workspace: env.workspace,
        approvalResolver: env.approvalResolver,
        policy: createHostRunPolicy({
          permissionMode,
          shouldWrite,
          targetPath: payload.targetPath,
          confidentialPaths: payload.confidentialPaths,
          writeGuardrails: env.writeGuardrails,
        }),
        promptBuilder: buildAgentPromptBuilder({
          cwd: env.workspaceRoot,
          sessionId,
        }),
        tools: env.tools,
        workflowHooks: env.workflowHooks,
        model: env.model,
        // Bind the main agent on resources, not a leaked step count of 8: honor
        // the profile's RunBudget when set and derive the step ceiling from it.
        maxSteps: overrides.maxSteps ?? resolveMainAgentMaxSteps(env.mainAgent),
        ...(overrides.runBudget !== undefined
          ? { runBudget: overrides.runBudget }
          : env.mainAgent.runBudget !== undefined
            ? { runBudget: env.mainAgent.runBudget }
            : {}),
        metadata: env.runMetadata,
        runStore: createSessionRunStoreFactory({
          sessionStore: env.sessionStore,
          sessionId,
          runStoreFactory: createSessionFileRunStoreFactory({
            sessionRootDir: env.sessionRootDir,
            sessionId,
            agentId: "main",
            traceLevel: env.traceLevel,
          }),
          metadata: env.runStoreMetadata,
        }),
      });

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

    return this.startSupervisedRunChain({
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
      // Fall through to legacy layout and then not-found.
    }

    const legacyRunDir = join(
      this.opts.workspaceRoot,
      ".sparkwright",
      "runs",
      runId,
    );
    if (await isDirectory(legacyRunDir)) {
      return { ok: true, runDir: legacyRunDir, agentId: MAIN_AGENT_ID };
    }

    return {
      ok: false,
      error: {
        code: "run_not_found",
        message:
          `Could not find run directory for ${runId} under ` +
          `${this.opts.sessionRootDir ?? defaultSessionRootDir(this.opts.workspaceRoot)} ` +
          `or ${this.opts.workspaceRoot}/.sparkwright/runs.`,
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
    const skillRoots = resolveSkillRootsForRuntime(
      this.opts.workspaceRoot,
      skillConfig?.roots,
    );
    const shellSandbox = await inspectShellSandboxStatus({
      workspaceRoot: this.opts.workspaceRoot,
      shellConfig,
      skillRoots: skillRoots.map((root) => root.root),
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
    });
    const mcpShellSandbox = resolveShellSandboxConfig({
      workspaceRoot: this.opts.workspaceRoot,
      config: shellConfig?.sandbox,
      skillRoots: skillRoots.map((root) => root.root),
      extraForcedDenyWrite: loadedConfig.attempted.map((entry) => entry.path),
    });
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
      const readOnlyChildToolCatalog = createReadOnlyChildToolCatalog({
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
      const readOnlyChildTools = catalogToolDefinitions(
        readOnlyChildToolCatalog,
      );
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
        allowReadWriteWorkspaceAccess: false,
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
            allowReadWriteWorkspaceAccess: false,
            maxDepth: agentConfig?.maxDepth,
          })
        : undefined;
      const dynamicSpawnTool = createDynamicSpawnAgentTool({
        getParent: () => undefined,
        model: {
          async complete() {
            return { message: "" };
          },
        },
        childTools: readOnlyChildTools,
        parentRunPolicy: createDefaultPolicy(),
        childRunStoreFactory: snapshotOnlyChildRunStoreFactory,
        maxDepth: agentConfig?.maxDepth,
      });
      const toolCatalog = createMainHostToolCatalog({
        workspaceRoot: this.opts.workspaceRoot,
        skillRoots,
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
        configPaths: loadedConfig.attempted.map((entry) => entry.path),
      });
      return buildCapabilitySnapshot({
        ...(model.ok ? { model: modelCapabilitySummary(model.resolved) } : {}),
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
        agentProfiles: [
          mainAgent,
          ...derivedAgents.map((agent) => agent.effectiveProfile),
        ],
        delegateTools: describeConfiguredDelegateTools({
          delegates: delegationTargets,
          derivedAgents,
          delegateChildToolCatalog,
          allowReadWriteWorkspaceAccess: false,
        }),
        shellSandbox,
        shellForegroundTimeoutMs:
          shellConfig?.foregroundTimeoutMs ?? RECOMMENDED_FOREGROUND_TIMEOUT_MS,
        shellPromotionAvailable: true,
        workflowRules: describeActiveWorkflowRules({
          workflowHooks: loadedConfig.config.capabilities?.hooks?.workflow,
          verification: loadedConfig.config.capabilities?.verification,
        }),
        eventRules: describeActiveEventRules({
          eventHooks: loadedConfig.config.capabilities?.hooks?.events,
        }),
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
    if (!this.active || this.active.runId !== runId) {
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
    this.runChainCancelled = true;
    this.active.run.cancel({ reason: reason ?? "client requested cancel" });
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
    if (!this.active || this.active.runId !== runId) {
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
    this.active.run.injectUserMessage({
      content: input.content,
      parts,
      metadata: input.metadata,
    });
    return { ok: true };
  }

  resolveApproval(
    approvalId: string,
    decision: "approved" | "denied",
    message?: string,
    autoApproved?: boolean,
  ): { ok: true } | { ok: false; error: ProtocolError } {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return {
        ok: false,
        error: {
          code: "approval_not_found",
          message: `no pending approval with id ${approvalId}`,
        },
      };
    }
    this.pendingApprovals.delete(approvalId);
    pending.resolve({
      decision,
      ...(message !== undefined ? { message } : {}),
      ...(autoApproved !== undefined ? { autoApproved } : {}),
    });
    return { ok: true };
  }

  /**
   * Called on disconnect: cancel active run + deny outstanding approvals so
   * core does not leak file handles or hang on never-arriving decisions.
   */
  cleanup(): void {
    for (const p of this.pendingApprovals.values()) {
      p.resolve({ decision: "denied" });
    }
    this.pendingApprovals.clear();
    if (this.active) {
      try {
        this.active.run.cancel({ reason: "client_disconnected" });
        void this.active.closeCapabilities?.().catch(() => {});
      } catch {
        // already cancelled
      }
      this.active = null;
    }
  }

  async listSessions(
    limit = 20,
  ): Promise<Array<{ id: string; mtimeMs: number; preview: string }>> {
    const root =
      this.opts.sessionRootDir ??
      defaultSessionRootDir(this.opts.workspaceRoot);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }
    const results = await Promise.all(
      entries.map(async (id) => {
        const dir = join(root, id);
        try {
          const st = await stat(dir);
          if (!st.isDirectory()) return null;
          let preview = "";
          try {
            const transcript = await readFile(
              join(dir, "transcript.jsonl"),
              "utf8",
            );
            const firstLine = transcript.split("\n").find((l) => l.trim());
            if (firstLine) {
              preview = sessionPreviewFromTranscriptLine(firstLine);
            }
          } catch {
            // no transcript yet
          }
          return {
            id,
            mtimeMs: st.mtimeMs,
            preview: preview.slice(0, 80),
          };
        } catch {
          return null;
        }
      }),
    );
    return results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
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
    let safeSessionId: ReturnType<typeof asSessionId>;
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

    const sessionRootDir =
      this.opts.sessionRootDir ??
      defaultSessionRootDir(this.opts.workspaceRoot);
    const sessionDir = join(sessionRootDir, safeSessionId);
    try {
      const st = await stat(sessionDir);
      if (!st.isDirectory()) {
        return {
          ok: false,
          error: {
            code: "session_not_found",
            message: `session not found: ${sessionId}`,
          },
        };
      }
    } catch {
      return {
        ok: false,
        error: {
          code: "session_not_found",
          message: `session not found: ${sessionId}`,
        },
      };
    }

    try {
      const tracePath = join(sessionDir, "trace.jsonl");
      const [summary, consistency, timeline, compaction] = await Promise.all([
        summarizeTraceFile(tracePath),
        validateSessionTraceConsistency({ sessionDir }),
        buildTraceTimelineFile(tracePath),
        options.compaction
          ? this.buildSessionCompactionInspectReport(
              sessionRootDir,
              safeSessionId,
            )
          : Promise.resolve(undefined),
      ]);
      return {
        ok: true,
        sessionId: safeSessionId,
        summary: summary as unknown as Record<string, unknown>,
        consistency: consistency as unknown as Record<string, unknown>,
        timeline: timeline as unknown as Record<string, unknown>,
        ...(compaction ? { compaction } : {}),
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

  async inspectSessionCompaction(sessionId: string): Promise<
    | {
        ok: true;
        sessionId: string;
        compaction: SessionCompactionInspectReport;
      }
    | { ok: false; error: ProtocolError }
  > {
    let safeSessionId: ReturnType<typeof asSessionId>;
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

    const sessionRootDir =
      this.opts.sessionRootDir ??
      defaultSessionRootDir(this.opts.workspaceRoot);
    const sessionDir = join(sessionRootDir, safeSessionId);
    try {
      const st = await stat(sessionDir);
      if (!st.isDirectory()) {
        return {
          ok: false,
          error: {
            code: "session_not_found",
            message: `session not found: ${sessionId}`,
          },
        };
      }
    } catch {
      return {
        ok: false,
        error: {
          code: "session_not_found",
          message: `session not found: ${sessionId}`,
        },
      };
    }

    return {
      ok: true,
      sessionId: safeSessionId,
      compaction: await this.buildSessionCompactionInspectReport(
        sessionRootDir,
        safeSessionId,
      ),
    };
  }

  private async buildSessionCompactionInspectReport(
    sessionRootDir: string,
    sessionId: string,
  ): Promise<SessionCompactionInspectReport> {
    const store = new FileSessionStore({ rootDir: sessionRootDir });
    const artifactPath = join(
      sessionRootDir,
      sessionId,
      SESSION_COMPACT_FILENAME,
    );
    const [artifact, events] = await Promise.all([
      loadSessionCompactArtifact({ sessionRootDir, sessionId }),
      loadSessionCompactionEvents(store, sessionId),
    ]);
    const artifactSummary = artifact
      ? sessionCompactionArtifactInspectSummary(artifact, artifactPath)
      : null;
    const latestEvent = events.at(-1) ?? null;
    const latestCompleted =
      [...events]
        .reverse()
        .find((event) => event.type === "session.compaction.completed") ?? null;
    const findings: string[] = [];
    const artifactMatchesLatestCompletedEvent =
      artifactSummary && latestCompleted
        ? sessionCompactionArtifactMatchesEvent(
            artifactSummary,
            latestCompleted,
          )
        : null;

    if (
      artifactSummary &&
      latestCompleted &&
      !artifactMatchesLatestCompletedEvent
    ) {
      findings.push(
        "compact.json does not match the latest completed session compaction event",
      );
    }
    if (artifactSummary && latestEvent?.type === "session.compaction.skipped") {
      findings.push(
        "latest compaction attempt was skipped; compact.json is from an earlier completed attempt",
      );
    }
    if (!artifactSummary && latestCompleted) {
      findings.push(
        "latest completed session compaction event references an artifact that is missing or invalid",
      );
    }

    return {
      status: sessionCompactionInspectStatus({
        artifact: artifactSummary,
        latestEvent,
        latestCompleted,
        artifactMatchesLatestCompletedEvent,
      }),
      artifact: artifactSummary,
      events,
      latestEvent,
      consistency: {
        ok:
          artifactMatchesLatestCompletedEvent !== false &&
          !(latestCompleted && !artifactSummary),
        artifactMatchesLatestCompletedEvent,
        findings,
      },
    };
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
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const sessionRootDir =
      this.opts.sessionRootDir ??
      defaultSessionRootDir(this.opts.workspaceRoot);
    const sessionDir = join(sessionRootDir, safeSessionId);
    try {
      const st = await stat(sessionDir);
      if (!st.isDirectory()) {
        return {
          ok: false,
          error: {
            code: "session_not_found",
            message: `session not found: ${sessionId}`,
          },
        };
      }
    } catch {
      return {
        ok: false,
        error: {
          code: "session_not_found",
          message: `session not found: ${sessionId}`,
        },
      };
    }

    const turns = await this.loadCompletedConversationTurns(
      sessionRootDir,
      safeSessionId,
    );
    const taskConfig = await this.loadTaskConfig("compaction");
    const preparedCompaction = await this.sessionCompactionOptionsForTask({
      reason,
      taskConfig,
      manualLlm: options.llm === true,
    });
    const sessionCompactionOptions = preparedCompaction.options;

    let compacted: Awaited<ReturnType<typeof compactSessionTurns>>;
    try {
      compacted = await compactSessionTurns(turns, sessionCompactionOptions);
    } catch (error) {
      const warnings = mergeCompactionWarnings(preparedCompaction.warnings, [
        {
          code: "SESSION_COMPACTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      ]);
      const originalCharCount = turns.reduce(
        (sum, turn) => sum + turn.goal.length + turn.message.length,
        0,
      );
      return await this.recordSessionCompactionEvent(sessionRootDir, reason, {
        ok: true,
        sessionId: safeSessionId,
        compactedRunCount: 0,
        throughRunId: null,
        originalCharCount,
        summaryCharCount: originalCharCount,
        freedChars: 0,
        measurement: emptySessionCompactionMeasurement({
          sourceRunCount: turns.length,
          originalCharCount,
        }),
        artifactPath: null,
        skippedReason: "compaction_failed",
        warnings,
      });
    }

    const warnings = mergeCompactionWarnings(
      preparedCompaction.warnings,
      compacted.warnings,
    );

    if (compacted.skippedReason !== undefined) {
      return await this.recordSessionCompactionEvent(sessionRootDir, reason, {
        ok: true,
        sessionId: safeSessionId,
        compactedRunCount: compacted.compactedRunCount,
        throughRunId: compacted.throughRunId,
        originalCharCount: compacted.originalCharCount,
        summaryCharCount: compacted.summaryCharCount,
        freedChars: compacted.freedChars,
        measurement: compacted.measurement,
        artifactPath: null,
        skippedReason: compacted.skippedReason,
        warnings,
      });
    }

    const throughRunId = compacted.throughRunId;
    try {
      const artifactPath = await writeSessionCompactArtifact({
        sessionRootDir,
        artifact: {
          schemaVersion: SESSION_COMPACT_SCHEMA_VERSION,
          sessionId: asSessionId(safeSessionId),
          createdAt: new Date().toISOString(),
          throughRunId,
          compactedRunCount: compacted.compactedRunCount,
          sourceRunIds: compacted.sourceRunIds,
          content: compacted.content,
          originalCharCount: compacted.originalCharCount,
          summaryCharCount: compacted.summaryCharCount,
          freedChars: compacted.freedChars,
          metadata: sessionCompactArtifactMetadata({
            compacted,
            warnings,
            reason,
          }),
        },
      });
      return await this.recordSessionCompactionEvent(sessionRootDir, reason, {
        ok: true,
        sessionId: safeSessionId,
        compactedRunCount: compacted.compactedRunCount,
        throughRunId,
        originalCharCount: compacted.originalCharCount,
        summaryCharCount: compacted.summaryCharCount,
        freedChars: compacted.freedChars,
        measurement: compacted.measurement,
        artifactPath,
        warnings,
      });
    } catch (error) {
      return await this.recordSessionCompactionEvent(sessionRootDir, reason, {
        ok: true,
        sessionId: safeSessionId,
        compactedRunCount: 0,
        throughRunId: null,
        originalCharCount: compacted.originalCharCount,
        summaryCharCount: compacted.originalCharCount,
        freedChars: 0,
        measurement: {
          ...compacted.measurement,
          summaryCharCount: compacted.originalCharCount,
          freedChars: 0,
          savingsRatio: 0,
          regime: "no_savings",
        },
        artifactPath: null,
        skippedReason: "artifact_write_failed",
        warnings: [
          ...(warnings ?? []),
          {
            code: "SESSION_COMPACT_ARTIFACT_WRITE_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  }

  private async recordSessionCompactionEvent(
    sessionRootDir: string,
    reason: string | undefined,
    result: SessionCompactSuccessResult,
  ): Promise<SessionCompactSuccessResult> {
    const eventType = result.skippedReason
      ? "session.compaction.skipped"
      : "session.compaction.completed";
    const store = new FileSessionStore({ rootDir: sessionRootDir });
    try {
      await store.appendEvent(result.sessionId, {
        type: eventType,
        payload: {
          compactedRunCount: result.compactedRunCount,
          throughRunId: result.throughRunId,
          originalCharCount: result.originalCharCount,
          summaryCharCount: result.summaryCharCount,
          freedChars: result.freedChars,
          measurement: result.measurement,
          artifactPath: result.artifactPath,
          ...(result.skippedReason
            ? { skippedReason: result.skippedReason }
            : {}),
          ...(result.warnings
            ? { warningCodes: result.warnings.map((warning) => warning.code) }
            : {}),
        },
        metadata: {
          source: "host",
          ...(reason ? { reason } : {}),
        },
      });
      return result;
    } catch (error) {
      return {
        ...result,
        warnings: mergeCompactionWarnings(result.warnings, [
          {
            code: "SESSION_COMPACTION_EVENT_WRITE_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        ]),
      };
    }
  }

  private async loadTaskConfig(name: string): Promise<TaskConfig | undefined> {
    const loaded = await loadHostConfig(this.opts.workspaceRoot);
    return loaded.config.tasks?.[name];
  }

  private async sessionCompactionOptionsForTask(input: {
    reason?: string;
    taskConfig?: TaskConfig;
    manualLlm: boolean;
  }): Promise<{
    options: SessionCompactionOptions;
    warnings?: CompactionWarning[];
  }> {
    const enabled = input.manualLlm || input.taskConfig?.enabled === true;
    const options: SessionCompactionOptions = { reason: input.reason };
    if (!enabled) return { options };

    const modelRef = input.taskConfig?.model ?? this.opts.defaultModel;
    const model = await createModel({
      modelRef,
      goal: "Summarize completed session history for future context.",
      workspaceRoot: this.opts.workspaceRoot,
    });
    if (!model.ok) {
      return {
        options,
        warnings: [
          {
            code: "SESSION_SUMMARIZER_MODEL_UNAVAILABLE",
            message: model.message,
          },
        ],
      };
    }

    const modelId = model.resolved.modelRef;
    const deterministicPreview =
      model.resolved.providerKey === DETERMINISTIC_PROVIDER;
    return {
      options: {
        ...options,
        summarizer: deterministicPreview
          ? createDeterministicSessionSummarizer()
          : createModelSessionSummarizer({
              model: model.adapter,
              modelId,
            }),
        summarizerTrigger: input.manualLlm ? "manual" : "auto",
        summarizerBudget: input.taskConfig?.budget,
        summarizerUsage: sessionSummarizerUsageHint(model.resolved),
        summarizerModelId: modelId,
      },
      warnings:
        deterministicPreview && input.manualLlm
          ? [
              {
                code: "SESSION_SUMMARIZER_DETERMINISTIC_PREVIEW",
                message:
                  "Session compaction used the deterministic summarizer preview because the resolved compaction model is deterministic.",
              },
            ]
          : undefined,
    };
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
    let safeSource: string;
    try {
      safeSource = asSessionId(sourceSessionId);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const sessionRootDir =
      this.opts.sessionRootDir ??
      defaultSessionRootDir(this.opts.workspaceRoot);
    try {
      const store = new FileSessionStore({ rootDir: sessionRootDir });
      const result = await forkSessionFromEvent({
        sourceSessionId: safeSource,
        forkAtSequence,
        store,
        metadata: { forkedVia: "tui" },
      });
      return {
        ok: true,
        forkedSessionId: result.forked.id,
        copiedEventCount: result.copiedEventCount,
        truncatedAtSequence: result.truncatedAtSequence,
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
}

function buildCapabilitySnapshot(input: {
  model?: CapabilityModelSummary;
  toolCatalog: HostToolCatalogEntry[];
  indexedSkills: SkillIndexEntry[];
  loadedSkills: LoadedSkill[];
  skillInlineShell?: CapabilitySkillInlineShellSummary;
  mcpStatuses?: Record<string, McpStatus | { status: "configured" }>;
  mcpToolNameMap?: McpToolNameMapping[];
  agentProfiles?: AgentProfile[];
  delegateTools?: DelegateCapabilityDescriptor[];
  shellSandbox?: ShellSandboxStatus;
  shellForegroundTimeoutMs?: number;
  shellPromotionAvailable?: boolean;
  workflowRules?: CapabilityWorkflowRuleSummary[];
  eventRules?: CapabilityEventRuleSummary[];
  automation?: CapabilityAutomationSummary;
}): CapabilitySnapshot {
  return {
    ...(input.model ? { model: input.model } : {}),
    tools: input.toolCatalog.map((entry) => ({
      name: entry.definition.name,
      canonicalName: entry.definition.canonicalName ?? entry.definition.name,
      ...(entry.definition.legacyNames &&
      entry.definition.legacyNames.length > 0
        ? { legacyNames: entry.definition.legacyNames }
        : {}),
      ...(entry.definition.defaultExposureTier
        ? { defaultExposureTier: entry.definition.defaultExposureTier }
        : {}),
      source: entry.source,
      origin:
        formatToolOrigin(entry.definition.governance?.origin) ??
        catalogEntryOrigin(entry),
      risk: entry.definition.policy?.risk,
      ...(entry.definition.governance
        ? { governance: entry.definition.governance }
        : {}),
      effectiveLoading:
        entry.definition.deferLoading === true ? "deferred" : "eager",
      ...(entry.definition.deferLoading === true ? { deferred: true } : {}),
      ...(entry.definition.relatedTools &&
      entry.definition.relatedTools.length > 0
        ? { relatedTools: entry.definition.relatedTools }
        : {}),
      ...(entry.definition.requiresTool &&
      entry.definition.requiresTool.length > 0
        ? { requiresTool: entry.definition.requiresTool }
        : {}),
    })),
    skills: {
      indexed: input.indexedSkills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        sourcePath: skill.sourcePath,
        contentHash: skill.contentHash,
        version: skill.version,
      })),
      loaded: input.loadedSkills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        sourcePath: skill.sourcePath,
        contentHash: skill.contentHash,
        version: skill.version,
        selectionReason: skill.selectionReason,
      })),
      ...(input.skillInlineShell
        ? { inlineShell: input.skillInlineShell }
        : {}),
    },
    mcp: {
      statuses: Object.entries(input.mcpStatuses ?? {}).map(
        ([serverName, status]) => ({
          serverName,
          status: status.status,
          toolNames: (input.mcpToolNameMap ?? [])
            .filter((mapping) => mapping.serverName === serverName)
            .map((mapping) => mapping.toolName),
          ...(status.status === "failed"
            ? {
                errorCode: status.errorCode,
                errorPhase: status.phase,
                errorMessage: status.error,
              }
            : {}),
        }),
      ),
    },
    agents: {
      profiles: (
        input.agentProfiles ?? [{ id: MAIN_AGENT_ID, mode: "primary" }]
      ).map((profile) => ({
        id: profile.id,
        name: profile.name,
        mode: profile.mode,
      })),
      delegateTools: input.delegateTools ?? [],
    },
    ...(input.shellSandbox
      ? {
          shell: {
            foregroundTimeoutMs:
              input.shellForegroundTimeoutMs ??
              RECOMMENDED_FOREGROUND_TIMEOUT_MS,
            promotionAvailable: input.shellPromotionAvailable ?? true,
            sandbox: {
              mode: input.shellSandbox.mode,
              failIfUnavailable: input.shellSandbox.failIfUnavailable,
              runtimeId: input.shellSandbox.runtimeId,
              platform: input.shellSandbox.platform,
              available: input.shellSandbox.available,
              networkMode: input.shellSandbox.networkMode,
              filesystemIsolation: input.shellSandbox.filesystemIsolation,
            },
          },
        }
      : {}),
    ...(input.workflowRules || input.eventRules
      ? {
          rules: {
            workflow: input.workflowRules ?? [],
            ...(input.eventRules ? { events: input.eventRules } : {}),
          },
        }
      : {}),
    automation: input.automation,
  };
}

function modelCapabilitySummary(
  resolved: ResolvedModelConfig,
): CapabilityModelSummary {
  return {
    modelRef: resolved.modelRef,
    providerKey: resolved.providerKey,
    modelId: resolved.modelId,
    adapterId: resolved.adapterId,
    pricing: resolved.pricing ?? {
      source: resolved.pricingSource ?? "not_applicable",
      costStatus:
        resolved.pricingSource === "unavailable"
          ? "unavailable"
          : resolved.pricingSource === "not_applicable"
            ? "not_applicable"
            : "estimated",
      ...(resolved.pricingSource === "unavailable"
        ? { costUnavailableReason: "missing_pricing" }
        : {}),
    },
  };
}

function inlineShellCapabilitySummary(
  inlineShell: CapabilitySkillsConfig["inlineShell"] | undefined,
  shellSandbox: ShellSandboxStatus | undefined,
): CapabilitySkillInlineShellSummary {
  const enabled = inlineShell?.enabled === true;
  return {
    enabled,
    ...(inlineShell?.timeoutMs !== undefined
      ? { timeoutMs: inlineShell.timeoutMs }
      : {}),
    ...(inlineShell?.maxOutputChars !== undefined
      ? { maxOutputChars: inlineShell.maxOutputChars }
      : {}),
    sandboxMode: enabled ? "enforce" : (shellSandbox?.mode ?? "disabled"),
    writePolicy: enabled ? "no-write" : "disabled",
    failClosed: enabled,
  };
}

async function inspectShellSandboxStatus(input: {
  workspaceRoot: string;
  shellConfig?: ShellConfig;
  skillRoots: readonly string[];
  configPaths: readonly string[];
}): Promise<ShellSandboxStatus> {
  const config = resolveShellSandboxConfig({
    workspaceRoot: input.workspaceRoot,
    config: input.shellConfig?.sandbox,
    skillRoots: input.skillRoots,
    extraForcedDenyWrite: input.configPaths,
  });
  return describeShellSandboxStatus(
    config,
    createPlatformShellSandboxRuntime(),
  );
}

function createSkillPreprocessOptions(input: {
  skillConfig?: CapabilitySkillsConfig;
  emitter: EventEmitter;
  sandbox: ResolvedShellSandboxConfig;
  workspaceRoot: string;
}): SkillPreprocessOptions | undefined {
  const inlineShell = input.skillConfig?.inlineShell;
  if (inlineShell?.enabled !== true) return undefined;
  return {
    inlineShell: true,
    inlineShellTimeoutMs: inlineShell.timeoutMs,
    maxOutputChars: inlineShell.maxOutputChars,
    inlineShellRunner: createSkillInlineShellRunner({
      emitter: input.emitter,
      sandbox: input.sandbox,
      workspaceRoot: input.workspaceRoot,
    }),
  };
}

async function readCronJobsForSnapshot(
  rootDir: string,
): Promise<CapabilityAutomationSummary["cron"]["jobs"]> {
  try {
    const store = new CronStore({
      rootDir,
    });
    const jobs = await store.listJobs();
    return jobs
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((job) => ({
        id: job.id,
        name: job.name,
        enabled: job.enabled,
        state: job.state,
        schedule: job.scheduleDisplay,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus,
        lastError: job.lastError,
        lastTracePath: job.lastTracePath ?? null,
      }));
  } catch {
    return [];
  }
}

function taskRecordSnapshot(record: TaskRecord): TaskRecordSnapshot {
  return {
    id: record.id,
    parentRunId: record.parentRunId,
    kind: record.kind,
    ...(record.title ? { title: record.title } : {}),
    status: record.status,
    createdAt: record.createdAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.lastOutputAt ? { lastOutputAt: record.lastOutputAt } : {}),
    ...(record.lastProgressAt ? { lastProgressAt: record.lastProgressAt } : {}),
    ...(record.lastHealthCheckAt
      ? { lastHealthCheckAt: record.lastHealthCheckAt }
      : {}),
    ...(record.outputChunks !== undefined
      ? { outputChunks: record.outputChunks }
      : {}),
    ...(record.outputBytes !== undefined
      ? { outputBytes: record.outputBytes }
      : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error ? { error: record.error } : {}),
    metadata:
      typeof record.metadata === "object" &&
      record.metadata !== null &&
      !Array.isArray(record.metadata)
        ? record.metadata
        : {},
  };
}

function taskOutputChunkSnapshot(
  chunk: TaskOutputChunk,
): TaskOutputChunkSnapshot {
  return {
    taskId: chunk.taskId,
    sequence: chunk.sequence,
    timestamp: chunk.timestamp,
    channel: chunk.channel,
    data: chunk.data,
  };
}

function compareTaskRecordsNewestFirst(a: TaskRecord, b: TaskRecord): number {
  return taskSortTime(b).localeCompare(taskSortTime(a));
}

function taskSortTime(task: TaskRecord): string {
  return (
    task.completedAt ?? task.lastOutputAt ?? task.startedAt ?? task.createdAt
  );
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function taskNotFoundError(taskId: string): ProtocolError {
  return {
    code: "task_not_found",
    message: `Task not found: ${taskId}`,
  };
}

const IMMEDIATE_NONE = Symbol("IMMEDIATE_NONE");
type ImmediateNone = typeof IMMEDIATE_NONE;

async function raceWithImmediate<T>(
  iterator: AsyncIterator<T>,
): Promise<IteratorResult<T> | ImmediateNone> {
  let settled = false;
  const next = iterator.next().then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  await Promise.resolve();
  if (settled) return next;
  return IMMEDIATE_NONE;
}

function readTasksForSnapshot(
  rootDir: string,
): CapabilityAutomationSummary["tasks"]["tasks"] {
  try {
    const store = new FileTaskStore({ rootDir, createRoot: false });
    return store
      .list()
      .sort((a, b) => {
        const aTime = a.completedAt ?? a.lastOutputAt ?? a.createdAt;
        const bTime = b.completedAt ?? b.lastOutputAt ?? b.createdAt;
        return bTime.localeCompare(aTime);
      })
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        status: task.status,
        title: task.title,
        parentRunId: task.parentRunId,
        createdAt: task.createdAt,
        completedAt: task.completedAt,
        outputChunks: task.outputChunks,
        lastOutputAt: task.lastOutputAt,
        error: task.error
          ? { code: task.error.code, message: task.error.message }
          : undefined,
      }));
  } catch {
    return [];
  }
}

function mainAgentProfile(profiles: AgentProfile[] | undefined): AgentProfile {
  return (
    profiles?.find(
      (profile) => profile.id === MAIN_AGENT_ID || profile.mode === "primary",
    ) ?? { id: MAIN_AGENT_ID, mode: "primary" }
  );
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
  return (profileId, getRun) => {
    if (!inProcessProfileIds.has(profileId)) return undefined;
    const profile = byProfile.get(profileId);
    if (!profile?.hooks?.length) return undefined;
    return createConfiguredWorkflowHooks({
      hooks: profile.hooks.map(capabilityWorkflowHookFromAgentProfileHook),
      workspaceRoot: input.workspaceRoot,
      sandbox: input.sandbox,
      http: input.http,
      skillRoots: input.skillRoots,
      configPaths: input.configPaths,
      getRun,
    });
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
  if (right === undefined) return left.map(canonicalToolName);
  const rightByCanonical = new Map(
    right.map((name) => [canonicalToolName(name), name]),
  );
  const out: string[] = [];
  for (const name of left) {
    const matched = rightByCanonical.get(canonicalToolName(name));
    if (matched && !out.includes(matched)) out.push(matched);
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
const DELEGATE_AGENT_TOOL_NAME = "delegate_agent";
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
  toolName?: string;
  agentId?: string;
  goal: string;
  metadata?: Record<string, unknown>;
}

interface DelegateAgentTask {
  toolName?: string;
  agentId?: string;
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
): { workflowHooks?: WorkflowHook[]; createRun?: typeof createRun } {
  const childRunRef: { current?: ReturnType<typeof createRun> } = {};
  const workflowHooks = workflowHooksForProfile?.(
    profileId,
    () => childRunRef.current,
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

function delegateTaskTargetName(task: {
  agentId?: string;
  toolName?: string;
}): string {
  return task.agentId ?? task.toolName ?? "(missing)";
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
  approvalResolver?: ApprovalResolver;
  sandbox?: Parameters<typeof createExternalCommandDelegateTool>[0]["sandbox"];
  skillRoots?: readonly string[];
  configPaths?: readonly string[];
  allowReadWriteWorkspaceAccess: boolean;
  maxDepth?: number;
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
        }),
      );
      continue;
    }
    const childProfile = withDelegatedAgentContract(profile);
    const profileChildTools = childToolsForAgentProfile(
      input.childTools,
      profile,
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
      requiresApproval: delegate.requiresApproval,
      policy: capabilityFacts.policyProfile.policy,
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
          ...childWorkflowHookSpawnOptions(
            profile.id,
            input.workflowHooksForProfile,
          ),
          interactionChannel: null,
          approvalResolver: input.approvalResolver,
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

export function createDelegateAgentTool(input: {
  delegates: CapabilityDelegateToolConfig[];
  derivedAgents: DerivedChildAgentProfile[];
  delegateTools: ToolDefinition[];
}): ToolDefinition {
  const byProfile = new Map(
    input.derivedAgents.map((derived) => [
      derived.effectiveProfile.id,
      derived.effectiveProfile,
    ]),
  );
  const toolByName = new Map(
    input.delegateTools.map((tool) => [tool.name, tool]),
  );
  const targetByToolName = new Map<
    string,
    {
      delegate: CapabilityDelegateToolConfig;
      profile: AgentProfile;
      toolName: string;
      tool: ToolDefinition;
    }
  >();
  const targetByAgentId = new Map<
    string,
    {
      delegate: CapabilityDelegateToolConfig;
      profile: AgentProfile;
      toolName: string;
      tool: ToolDefinition;
    }
  >();
  for (const delegate of input.delegates) {
    const profile = byProfile.get(delegate.profileId);
    if (!profile) continue;
    const toolName = delegateToolName(delegate);
    const tool = toolByName.get(toolName);
    if (!tool) continue;
    const target = { delegate, profile, toolName, tool };
    targetByToolName.set(toolName, target);
    targetByAgentId.set(profile.id, target);
  }
  const availableAgentIds = [...targetByAgentId.keys()];
  const availableToolNames = [...targetByToolName.keys()];
  const availableHint =
    availableAgentIds.length > 0
      ? availableAgentIds
          .map((agentId) => {
            const target = targetByAgentId.get(agentId);
            return target ? `${agentId} (${target.toolName})` : agentId;
          })
          .join(", ")
      : "(none)";

  const resolveTarget = (task: DelegateAgentTask) => {
    const target = task.agentId
      ? targetByAgentId.get(task.agentId)
      : task.toolName
        ? targetByToolName.get(task.toolName)
        : undefined;
    if (target) return target;
    const targetName = task.agentId ?? task.toolName ?? "(missing)";
    throw new Error(
      `${DELEGATE_AGENT_TOOL_NAME} cannot find delegate target "${targetName}". Available agentId targets: ${availableHint}. Available toolName targets: ${availableToolNames.join(", ") || "(none)"}.`,
    );
  };

  return defineTool({
    name: DELEGATE_AGENT_TOOL_NAME,
    description:
      availableAgentIds.length > 0
        ? `Delegate one bounded sub-task to a configured agent by agentId. Use delegate_parallel instead when multiple read-only agents should run together. Available agents: ${availableHint}.`
        : "Delegate one bounded sub-task to a configured agent by agentId. No configured child agents are currently available.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description:
            "Configured agent profile id to run, for example reviewer. Prefer this and leave toolName unset.",
        },
        toolName: {
          type: "string",
          description:
            "Legacy delegate tool name to run. Prefer agentId unless the target is only known by tool name.",
        },
        goal: {
          type: "string",
          description: "Self-contained goal for that agent.",
        },
        metadata: {
          type: "object",
          description:
            "Optional structured metadata to attach to the child run.",
        },
      },
      required: ["goal"],
    },
    policy: { risk: "safe" },
    governance: {
      origin: { kind: "local", name: "sparkwright" },
      sideEffects: ["read"],
      idempotency: "conditional",
    },
    previewArgs(args) {
      const task = previewDelegateAgentArgs(args);
      if (!task) return undefined;
      const target = task.agentId ?? task.toolName;
      return target && task.goal ? `${target}: ${task.goal}` : undefined;
    },
    policyForArgs(args) {
      const task = parseDelegateAgentArgs(args);
      const target = resolveTarget(task);
      const delegatedArgs = delegateAgentToolArgs(task);
      const perTarget = target.tool.policyForArgs?.(delegatedArgs);
      return {
        policy: perTarget?.policy ?? target.tool.policy,
        governance: perTarget?.governance ?? target.tool.governance,
      };
    },
    isReplaySafe: false,
    async execute(args: unknown, ctx): Promise<unknown> {
      const task = parseDelegateAgentArgs(args);
      const target = resolveTarget(task);
      return target.tool.execute(delegateAgentToolArgs(task), ctx);
    },
  });
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
  approvalResolver?: ApprovalResolver;
  allowReadWriteWorkspaceAccess: boolean;
  maxDepth?: number;
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
  const eligibleByToolName = new Map<string, DelegateParallelSpec>();
  const eligibleByAgentId = new Map<string, DelegateParallelSpec>();
  const rejectionByToolName = new Map<string, string>();
  const rejectionByAgentId = new Map<string, string>();

  for (const delegate of input.delegates) {
    const profile = byProfile.get(delegate.profileId);
    if (!profile) continue;
    const toolName = delegateToolName(delegate);
    if (acpConfigFromAgentProfile(profile)) {
      const reason = "protocol acp is not supported by delegate_parallel v1";
      rejectionByToolName.set(toolName, reason);
      rejectionByAgentId.set(profile.id, reason);
      continue;
    }
    if (externalCommandConfigFromAgentProfile(profile)) {
      const reason =
        "protocol external_command is not supported by delegate_parallel v1";
      rejectionByToolName.set(toolName, reason);
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
      rejectionByToolName.set(toolName, reason);
      rejectionByAgentId.set(profile.id, reason);
      continue;
    }
    if (capabilityFacts.shellAccess) {
      const reason = "shell access is not allowed by delegate_parallel v1";
      rejectionByToolName.set(toolName, reason);
      rejectionByAgentId.set(profile.id, reason);
      continue;
    }
    const spec = {
      delegate,
      profile,
      childProfile: withDelegatedAgentContract(profile),
      toolName,
      profileChildTools: childToolsForAgentProfile(input.childTools, profile),
    };
    eligibleByToolName.set(toolName, spec);
    eligibleByAgentId.set(profile.id, spec);
  }

  const eligibleNames = [...eligibleByAgentId.keys()].map((agentId) => {
    const spec = eligibleByAgentId.get(agentId);
    return spec ? `${agentId} (${spec.toolName})` : agentId;
  });
  const description =
    eligibleNames.length > 0
      ? `Run multiple read-only configured delegates concurrently and return their combined results. Prefer this when a request needs more than one configured agent. Target delegates by agentId; legacy toolName also works. Only delegates with workspaceAccess none are accepted. Eligible delegates: ${eligibleNames.join(", ")}.`
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
            "Delegates to run in foreground parallel. Each entry targets one configured agent by agentId (preferred) or one legacy delegate tool by toolName and supplies an isolated goal.",
          items: {
            type: "object",
            properties: {
              agentId: {
                type: "string",
                description:
                  "Configured agent profile id to run, for example reviewer. Prefer this and leave toolName unset.",
              },
              toolName: {
                type: "string",
                description:
                  "Legacy configured delegate tool name to run, for example delegate_review.",
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
            required: ["goal"],
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
        ? parsed
            .map((task) => `${delegateTaskTargetName(task)}: ${task.goal}`)
            .join(" | ")
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
        const spec = task.agentId
          ? eligibleByAgentId.get(task.agentId)
          : task.toolName
            ? eligibleByToolName.get(task.toolName)
            : undefined;
        if (!spec) {
          const reason =
            (task.agentId
              ? rejectionByAgentId.get(task.agentId)
              : task.toolName
                ? rejectionByToolName.get(task.toolName)
                : undefined) ??
            `unknown delegate; eligible delegates: ${eligibleNames.join(", ") || "(none)"}`;
          throw new Error(
            `delegate_parallel cannot run "${delegateTaskTargetName(task)}": ${reason}.`,
          );
        }
        if (
          (spec.delegate.forbidNesting ?? true) &&
          typeof parent.record.metadata?.parentRunId === "string"
        ) {
          throw new Error(
            `delegate_parallel refused to nest "${delegateTaskTargetName(task)}": parent run is itself a sub-agent.`,
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
            ...childWorkflowHookSpawnOptions(
              spec.profile.id,
              input.workflowHooksForProfile,
            ),
            interactionChannel: null,
            approvalResolver: input.approvalResolver,
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
            },
          }),
        };
      });

      const results = await Promise.all(
        spawned.map(async (item): Promise<DelegateParallelChildSummary> => {
          if (item.mode === "cached") return item.cached;
          const { task, index, spec, spawned: child, ledgerKey } = item;
          try {
            const result = await child.run.start();
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
      canonicalToolName(tool.name) === canonicalToolName(toolName) &&
      inProcessDelegateCanUseTool(profile, tool),
  );
}

function inProcessDelegateCanUseTool(
  profile: AgentProfile,
  tool: Pick<ToolDefinition, "name">,
): boolean {
  return (
    profile.allowedTools === undefined ||
    profile.allowedTools.some(
      (name) => canonicalToolName(name) === canonicalToolName(tool.name),
    )
  );
}

function childToolsForAgentProfile(
  childTools: readonly ToolDefinition[],
  profile: AgentProfile,
): ToolDefinition[] {
  if (profile.allowedTools === undefined) return [...childTools];
  const allowed = new Set(profile.allowedTools.map(canonicalToolName));
  return childTools.filter((tool) => allowed.has(canonicalToolName(tool.name)));
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
  /** Builds a session-scoped run store for the child, keyed by its agent id. */
  childRunStoreFactory: (
    childAgentId: string,
  ) => ReturnType<typeof createSessionRunStoreFactory>;
}): ToolDefinition {
  return defineTool({
    name: "spawn_agent",
    description:
      "Spawn a bounded, read-only child agent for one focused sub-task. The child may inspect files but cannot write, run shell commands, or spawn further agents. Use this for temporary roles; if the same role becomes useful repeatedly, create a stable profile with create_agent and delegate to it through a delegate_* tool.",
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
            "Optional subset of read-only tools to expose. Supported: read, glob, grep, list_dir. Defaults to read, glob, and grep. Use grep to find a symbol by name (glob only matches paths, not contents).",
          items: {
            type: "string",
            enum: ["read", "glob", "grep", "list_dir"],
          },
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
      const supportedTools = new Set(["read", "glob", "grep", "list_dir"]);
      const requestedTools = (
        parsed.allowedTools ?? ["read", "glob", "grep"]
      ).map(canonicalToolName);
      const availableTools = new Map(
        input.childTools.map((tool) => [canonicalToolName(tool.name), tool]),
      );
      const invalidTools = requestedTools.filter(
        (name) => !supportedTools.has(name) || !availableTools.has(name),
      );
      if (invalidTools.length > 0) {
        throw new Error(
          `spawn_agent only supports enabled read-only child tools: ${invalidTools.join(
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
          childTools.push(discovery);
        }
      }
      if (childTools.length === 0) {
        throw new Error(
          "spawn_agent requires at least one enabled child tool.",
        );
      }

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
        maxSteps: childMaxSteps,
        abortSignal: input.abortSignal,
        interactionChannel: null,
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
          allowedTools: childTools.map((tool) => tool.name),
        },
      });
      const result = await spawned.run.start();
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
        result.signal !== "completed" || childTruncated
          ? "partial"
          : "complete";
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
        role: parsed.role,
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
            id: sanitizeToolSegment(parsed.role.toLowerCase()),
            name: parsed.role,
            mode: "child",
            prompt: parsed.prompt,
            allowedTools: childTools.map((tool) => tool.name),
            maxSteps: childMaxSteps,
            delegateToolName: `delegate_${sanitizeToolSegment(parsed.role.toLowerCase())}`,
          },
        },
      };
      rememberSuccessfulDelegation(parent, ledgerKey, parsed.goal, {
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
            `spawn_agent child "${parsed.role}" did not complete (${
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
              role: parsed.role,
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
    },
  });
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
    const toolName = optionalTargetStringField(
      task,
      "toolName",
      DELEGATE_PARALLEL_TOOL_NAME,
    );
    const agentId = optionalTargetStringField(
      task,
      "agentId",
      DELEGATE_PARALLEL_TOOL_NAME,
    );
    if (!toolName && !agentId) {
      throw new Error(
        `delegate_parallel delegates.${index} requires agentId or toolName.`,
      );
    }
    return {
      ...(toolName ? { toolName } : {}),
      ...(agentId ? { agentId } : {}),
      goal: stringField(task, "goal", DELEGATE_PARALLEL_TOOL_NAME),
      ...(metadata ? { metadata } : {}),
    };
  });
}

function parseDelegateAgentArgs(args: unknown): DelegateAgentTask {
  if (!args || typeof args !== "object") {
    throw new Error(`${DELEGATE_AGENT_TOOL_NAME} expects an object argument.`);
  }
  const record = args as Record<string, unknown>;
  const agentId = optionalTargetStringField(
    record,
    "agentId",
    DELEGATE_AGENT_TOOL_NAME,
  );
  const toolName = optionalTargetStringField(
    record,
    "toolName",
    DELEGATE_AGENT_TOOL_NAME,
  );
  if (!agentId && !toolName) {
    throw new Error(
      `${DELEGATE_AGENT_TOOL_NAME} requires agentId or toolName.`,
    );
  }
  const metadata =
    record.metadata === undefined
      ? undefined
      : objectField(record, "metadata", DELEGATE_AGENT_TOOL_NAME);
  return {
    ...(agentId ? { agentId } : {}),
    ...(toolName ? { toolName } : {}),
    goal: stringField(record, "goal", DELEGATE_AGENT_TOOL_NAME),
    ...(metadata ? { metadata } : {}),
  };
}

function previewDelegateAgentArgs(
  args: unknown,
): Pick<DelegateAgentTask, "agentId" | "toolName" | "goal"> | undefined {
  const record = previewRecord(args);
  const agentId = previewString(record.agentId).trim();
  const toolName = previewString(record.toolName).trim();
  const goal = previewString(record.goal).trim();
  return goal && (agentId || toolName)
    ? {
        ...(agentId ? { agentId } : {}),
        ...(toolName ? { toolName } : {}),
        goal,
      }
    : undefined;
}

function delegateAgentToolArgs(task: DelegateAgentTask): {
  goal: string;
  metadata?: Record<string, unknown>;
} {
  return {
    goal: task.goal,
    ...(task.metadata ? { metadata: task.metadata } : {}),
  };
}

function optionalTargetStringField(
  record: Record<string, unknown>,
  field: string,
  toolName: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${toolName} ${field} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function previewDelegateParallelArgs(args: unknown): DelegateParallelTask[] {
  const record = previewRecord(args);
  if (!Array.isArray(record.delegates)) return [];
  return record.delegates
    .map((entry): DelegateParallelTask | undefined => {
      const task = previewRecord(entry);
      const toolName = previewString(task.toolName).trim();
      const agentId = previewString(task.agentId).trim();
      const goal = previewString(task.goal).trim();
      return goal && (toolName || agentId)
        ? {
            ...(toolName ? { toolName } : {}),
            ...(agentId ? { agentId } : {}),
            goal,
          }
        : undefined;
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
  const allowedTools = Array.isArray(record.allowedTools)
    ? record.allowedTools.map((value) => {
        if (typeof value !== "string" || !value.trim()) {
          throw new Error("spawn_agent allowedTools must contain strings.");
        }
        return canonicalToolName(value.trim());
      })
    : undefined;
  if (allowedTools && new Set(allowedTools).size !== allowedTools.length) {
    throw new Error("spawn_agent allowedTools must not contain duplicates.");
  }
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

function mergeCompactionWarnings(
  ...groups: Array<CompactionWarning[] | undefined>
): CompactionWarning[] | undefined {
  const warnings = groups.flatMap((group) => group ?? []);
  return warnings.length > 0 ? warnings : undefined;
}

async function loadSessionCompactionEvents(
  store: FileSessionStore,
  sessionId: string,
): Promise<SessionCompactionInspectEvent[]> {
  const events: SessionCompactionInspectEvent[] = [];
  for await (const event of store.loadEvents(sessionId)) {
    const projected = sessionCompactionInspectEvent(event);
    if (projected) events.push(projected);
  }
  return events;
}

function sessionCompactionInspectEvent(
  event: SessionEvent,
): SessionCompactionInspectEvent | null {
  if (
    event.type !== "session.compaction.completed" &&
    event.type !== "session.compaction.skipped"
  ) {
    return null;
  }
  const payload = isPlainRecord(event.payload) ? event.payload : {};
  return {
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: event.type,
    compactedRunCount: recordNumber(payload, "compactedRunCount") ?? 0,
    throughRunId: recordNullableString(payload, "throughRunId"),
    originalCharCount: recordNumber(payload, "originalCharCount") ?? 0,
    summaryCharCount: recordNumber(payload, "summaryCharCount") ?? 0,
    freedChars: recordNumber(payload, "freedChars") ?? 0,
    ...(sessionCompactionMeasurementFromUnknown(payload.measurement)
      ? {
          measurement: sessionCompactionMeasurementFromUnknown(
            payload.measurement,
          ),
        }
      : {}),
    artifactPath: recordNullableString(payload, "artifactPath"),
    ...(recordString(payload, "skippedReason")
      ? { skippedReason: recordString(payload, "skippedReason") }
      : {}),
    ...(recordStringArray(payload, "warningCodes")
      ? { warningCodes: recordStringArray(payload, "warningCodes") }
      : {}),
    ...(recordString(event.metadata, "reason")
      ? { reason: recordString(event.metadata, "reason") }
      : {}),
    ...(recordString(event.metadata, "source")
      ? { source: recordString(event.metadata, "source") }
      : {}),
  };
}

function sessionCompactionArtifactInspectSummary(
  artifact: SessionCompactArtifact,
  path: string,
): SessionCompactionInspectArtifact {
  const metadata = artifact.metadata ?? {};
  return {
    path,
    schemaVersion: artifact.schemaVersion,
    createdAt: artifact.createdAt,
    throughRunId: artifact.throughRunId,
    compactedRunCount: artifact.compactedRunCount,
    sourceRunIds: [...artifact.sourceRunIds],
    originalCharCount: artifact.originalCharCount,
    summaryCharCount: artifact.summaryCharCount,
    freedChars: artifact.freedChars,
    ...(sessionCompactionMeasurementFromUnknown(metadata.measurement)
      ? {
          measurement: sessionCompactionMeasurementFromUnknown(
            metadata.measurement,
          ),
        }
      : {}),
    ...(recordString(metadata, "mode")
      ? { mode: recordString(metadata, "mode") }
      : {}),
    ...(recordString(metadata, "reason")
      ? { reason: recordString(metadata, "reason") }
      : {}),
    ...(sessionCompactionWarningCodes(metadata)
      ? { warningCodes: sessionCompactionWarningCodes(metadata) }
      : {}),
    ...(isPlainRecord(metadata.summaryFingerprint)
      ? { summaryFingerprint: { ...metadata.summaryFingerprint } }
      : {}),
  };
}

function sessionCompactionArtifactMatchesEvent(
  artifact: SessionCompactionInspectArtifact,
  event: SessionCompactionInspectEvent,
): boolean {
  return (
    event.type === "session.compaction.completed" &&
    artifact.path === event.artifactPath &&
    artifact.throughRunId === event.throughRunId &&
    artifact.compactedRunCount === event.compactedRunCount &&
    artifact.originalCharCount === event.originalCharCount &&
    artifact.summaryCharCount === event.summaryCharCount &&
    artifact.freedChars === event.freedChars
  );
}

function sessionCompactionInspectStatus(input: {
  artifact: SessionCompactionInspectArtifact | null;
  latestEvent: SessionCompactionInspectEvent | null;
  latestCompleted: SessionCompactionInspectEvent | null;
  artifactMatchesLatestCompletedEvent: boolean | null;
}): SessionCompactionInspectReport["status"] {
  if (!input.artifact && !input.latestEvent) return "not_compacted";
  if (input.latestEvent?.type === "session.compaction.skipped") {
    return "skipped";
  }
  if (input.artifact && input.latestCompleted) {
    return input.artifactMatchesLatestCompletedEvent === false
      ? "stale_artifact"
      : "compacted";
  }
  if (input.artifact) return "artifact_only";
  return "event_only";
}

function sessionCompactionWarningCodes(
  metadata: Record<string, unknown>,
): string[] | undefined {
  const warnings = metadata.warnings;
  if (!Array.isArray(warnings)) return undefined;
  const codes = warnings
    .map((warning) => recordString(warning, "code"))
    .filter((code): code is string => Boolean(code));
  return codes.length > 0 ? codes : undefined;
}

function sessionCompactionMeasurementFromUnknown(
  value: unknown,
): SessionCompactionMeasurement | undefined {
  if (!isPlainRecord(value)) return undefined;
  return value as unknown as SessionCompactionMeasurement;
}

function sessionSummarizerUsageHint(
  resolved: ResolvedModelConfig,
): ContextUsageHint {
  const costUnavailable = resolved.pricingSource === "unavailable";
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    modelCalls: 0,
    costStatus: costUnavailable ? "unavailable" : "estimated",
    ...(costUnavailable
      ? { costUnavailableReasons: { missing_pricing: 1 } }
      : {}),
  };
}

function sessionCompactArtifactMetadata(input: {
  compacted: {
    appliedStages: Array<{
      tier: string;
      metadata?: Record<string, unknown>;
    }>;
    skippedStages: Array<Record<string, unknown>>;
    measurement: SessionCompactionMeasurement;
  };
  warnings?: CompactionWarning[];
  reason?: string;
}): Record<string, unknown> {
  const summarizeMetadata = input.compacted.appliedStages.find(
    (stage) => stage.tier === "summarize",
  )?.metadata;
  const mode =
    recordString(summarizeMetadata, "mode") === "llm"
      ? "llm"
      : "deterministic-v2";
  const summaryFingerprint = isPlainRecord(
    summarizeMetadata?.summaryFingerprint,
  )
    ? { ...summarizeMetadata.summaryFingerprint }
    : undefined;
  return {
    source: "host",
    mode,
    appliedStages: input.compacted.appliedStages,
    skippedStages: input.compacted.skippedStages,
    measurement: input.compacted.measurement,
    ...(summaryFingerprint ? { summaryFingerprint } : {}),
    ...(input.warnings ? { warnings: input.warnings } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function emptySessionCompactionMeasurement(input: {
  sourceRunCount: number;
  originalCharCount: number;
}): SessionCompactionMeasurement {
  return {
    sourceRunCount: input.sourceRunCount,
    originalCharCount: input.originalCharCount,
    summaryCharCount: input.originalCharCount,
    freedChars: 0,
    savingsRatio: 0,
    freedByTier: {
      dedup: 0,
      extract: 0,
      evict: 0,
      summarize: 0,
    },
    regime: "no_savings",
    signalCount: 0,
  };
}

function recordString(value: unknown, key: string): string | undefined {
  return isPlainRecord(value) && typeof value[key] === "string"
    ? (value[key] as string)
    : undefined;
}

function recordNumber(value: unknown, key: string): number | undefined {
  return isPlainRecord(value) && typeof value[key] === "number"
    ? (value[key] as number)
    : undefined;
}

function recordNullableString(value: unknown, key: string): string | null {
  if (!isPlainRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function recordStringArray(value: unknown, key: string): string[] | undefined {
  if (!isPlainRecord(value) || !Array.isArray(value[key])) return undefined;
  const strings = value[key].filter((item): item is string => {
    return typeof item === "string";
  });
  return strings.length > 0 ? strings : undefined;
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

function mergeCapabilitySnapshots(
  configured: CapabilitySnapshot,
  last: CapabilitySnapshot | null,
): CapabilitySnapshot {
  if (!last) return configured;
  return {
    model: configured.model ?? last.model,
    tools: mergeByName(configured.tools, last.tools),
    skills: {
      indexed: mergeByName(configured.skills.indexed, last.skills.indexed),
      loaded: last.skills.loaded,
      inlineShell: last.skills.inlineShell ?? configured.skills.inlineShell,
    },
    mcp: {
      statuses: last.mcp.statuses.length
        ? last.mcp.statuses
        : configured.mcp.statuses,
    },
    agents: {
      profiles: mergeById(configured.agents.profiles, last.agents.profiles),
      delegateTools: mergeByToolName(
        configured.agents.delegateTools,
        last.agents.delegateTools,
      ),
    },
    shell: configured.shell ?? last.shell,
    rules: {
      workflow: mergeWorkflowRules(
        configured.rules?.workflow ?? [],
        last.rules?.workflow ?? [],
      ),
      events: mergeEventRules(
        configured.rules?.events ?? [],
        last.rules?.events ?? [],
      ),
    },
    automation: configured.automation ?? last.automation,
  };
}

function formatToolOrigin(origin: ToolOrigin | undefined): string | undefined {
  if (!origin) return undefined;
  const { kind, name } = origin;
  return typeof name === "string" && name ? `${kind}:${name}` : kind;
}

function mergeByName<T extends { name: string }>(base: T[], next: T[]): T[] {
  const byName = new Map<string, T>();
  for (const entry of base) byName.set(entry.name, entry);
  for (const entry of next) byName.set(entry.name, entry);
  return [...byName.values()];
}

function mergeById<T extends { id: string }>(base: T[], next: T[]): T[] {
  const byId = new Map<string, T>();
  for (const entry of base) byId.set(entry.id, entry);
  for (const entry of next) byId.set(entry.id, entry);
  return [...byId.values()];
}

function mergeByToolName<T extends { toolName: string }>(
  base: T[],
  next: T[],
): T[] {
  const byName = new Map<string, T>();
  for (const entry of base) byName.set(entry.toolName, entry);
  for (const entry of next) byName.set(entry.toolName, entry);
  return [...byName.values()];
}

function mergeWorkflowRules(
  base: CapabilityWorkflowRuleSummary[],
  next: CapabilityWorkflowRuleSummary[],
): CapabilityWorkflowRuleSummary[] {
  const byKey = new Map<string, CapabilityWorkflowRuleSummary>();
  for (const entry of base) byKey.set(workflowRuleKey(entry), entry);
  for (const entry of next) byKey.set(workflowRuleKey(entry), entry);
  return [...byKey.values()];
}

function workflowRuleKey(rule: CapabilityWorkflowRuleSummary): string {
  return `${rule.source}:${rule.lifecycle}:${rule.name}`;
}

function mergeEventRules(
  base: CapabilityEventRuleSummary[],
  next: CapabilityEventRuleSummary[],
): CapabilityEventRuleSummary[] {
  const byKey = new Map<string, CapabilityEventRuleSummary>();
  for (const entry of base) byKey.set(eventRuleKey(entry), entry);
  for (const entry of next) byKey.set(eventRuleKey(entry), entry);
  return [...byKey.values()];
}

function eventRuleKey(rule: CapabilityEventRuleSummary): string {
  return `${rule.source}:${rule.trigger}:${rule.name}`;
}
