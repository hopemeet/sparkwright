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
  type ContextUsageHint,
  type SessionCompactionMeasurement,
  type SessionCompactionOptions,
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
  runTodoSupervised,
  spawnSubAgent,
  type AgentProfile,
  type DerivedChildAgentProfile,
  type TodoSupervisedRunInput,
} from "@sparkwright/agent-runtime";
import { CronStore, defaultCronRoot } from "@sparkwright/cron";
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
  CapabilityToolsConfig,
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
  type RunResumeRequestPayload,
  type RunStartRequestPayload,
  type RunInputPart,
  type CapabilitySnapshot,
  type CapabilityAutomationSummary,
  type CapabilitySkillInlineShellSummary,
} from "@sparkwright/protocol";
import { buildAgentPromptBuilder } from "@sparkwright/project-context";
import {
  DETERMINISTIC_PROVIDER,
  loadHostConfig,
  type CapabilityMcpConfig,
} from "./config.js";
import { resolveAgentProfiles } from "./agent-profiles.js";
import {
  existingSkillRoots,
  resolveSkillRootsForRuntime,
} from "./skill-roots.js";
import { nextMessageId, nowIso } from "./connection.js";
import { createModel, type ResolvedModelConfig } from "./model-factory.js";
import { createModelSessionSummarizer } from "./session-summarizer.js";
import {
  catalogEntryOrigin,
  catalogToolDefinitions,
  createConfiguredDelegateChildToolCatalog,
  createMainHostToolCatalog,
  createReadOnlyChildToolCatalog,
  type HostToolCatalogEntry,
} from "./tool-catalog.js";
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
  delegateToolName,
  type DelegateWorkspaceAccess,
  type DelegateCapabilityDescriptor,
} from "./delegate-capability.js";
import { createConfiguredWorkflowHooks } from "./workflow-hooks.js";
import { createVerificationWorkflowHooks } from "./verification.js";
import { createDocumentedCommandStopHook } from "./documented-command-check.js";
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

function payloadAllowsWorkspaceWrites(
  payload: RunStartRequestPayload | RunResumeRequestPayload,
  permissionMode: PermissionMode,
  defaultShouldWrite?: boolean,
): boolean {
  if (payload.shouldWrite !== undefined) return payload.shouldWrite;
  if (payload.metadata?.shouldWrite !== undefined) {
    return payload.metadata.shouldWrite === true;
  }
  if (defaultShouldWrite !== undefined) return defaultShouldWrite;
  // Legacy SDK clients may omit shouldWrite. Preserve the old host behavior
  // unless an entrypoint or embedder sets an explicit default.
  if (permissionMode === "plan") return false;
  return true;
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
  sessionStore: FileSessionStore;
  parentRunRef: { current?: ReturnType<typeof createRun> };
  traceLevel: TraceLevel;
  writeGuardrails?: WriteGuardrailsConfig;
  runMetadata: Record<string, unknown>;
  runStoreMetadata: Record<string, unknown>;
}

const MAIN_AGENT_ID = "main";

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
    };
  }
  return {
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
export class HostRuntime {
  private opts: RuntimeOptions;
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
  }

  hasActiveRun(): boolean {
    return this.active !== null;
  }

  private taskRootDir(): string {
    return join(this.opts.workspaceRoot, ".sparkwright", "tasks");
  }

  async inspectCapabilities(): Promise<
    | { ok: true; snapshot: CapabilitySnapshot }
    | { ok: false; error: ProtocolError }
  > {
    try {
      const configured = await this.inspectConfiguredCapabilities();
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
    const resolvedProfiles = await resolveAgentProfiles(
      workspaceRoot,
      agentConfig?.profiles,
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
    const delegateTools = createConfiguredDelegateTools({
      getParent: () => parentRunRef.current,
      delegates: agentConfig?.delegateTools ?? [],
      derivedAgents,
      model: model.adapter,
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
    const delegateDescriptors = describeConfiguredDelegateTools({
      delegates: agentConfig?.delegateTools ?? [],
      derivedAgents,
      delegateChildToolCatalog,
      allowReadWriteWorkspaceAccess: input.shouldWrite,
    });
    const dynamicSpawnTool = createDynamicSpawnAgentTool({
      getParent: () => parentRunRef.current,
      model: model.adapter,
      childTools: readOnlyChildTools,
      parentRunPolicy,
      childRunStoreFactory,
      maxDepth: agentConfig?.maxDepth,
    });
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
        skillRoots: skillRoots.map((root) => root.root),
        configPaths: loadedConfig.attempted.map((entry) => entry.path),
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
    this.lastCapabilitySnapshot = buildCapabilitySnapshot({
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
    const registerActiveRun = (
      run: ReturnType<typeof createRun>,
      runId: string,
    ): SparkwrightEvent[] => {
      env.parentRunRef.current = run;
      env.runIdHolder.value = runId;
      this.active = {
        runId,
        run,
        trace: env.trace,
        sessionId,
        closeCapabilities: env.preparedMcp
          ? () => env.preparedMcp!.close()
          : undefined,
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
        this.opts.emit({
          envelope: "event",
          id: nextMessageId("evt"),
          kind: "run.failed",
          timestamp: nowIso(),
          payload: {
            runId: lastRunId,
            error: {
              code: "internal_error",
              message: err instanceof Error ? err.message : String(err),
            },
          },
        });
      })
      .finally(() => {
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
    const permissionMode =
      payload.permissionMode ?? this.opts.defaultPermissionMode ?? "default";
    const shouldWrite = payloadAllowsWorkspaceWrites(
      payload,
      permissionMode,
      this.opts.defaultShouldWrite,
    );
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
        shouldWrite,
      },
      runStoreMetadata: {
        resumedFromRunId: payload.runId,
        ...(payload.metadata ?? {}),
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
    const permissionMode =
      payload.permissionMode ?? this.opts.defaultPermissionMode ?? "default";
    const shouldWrite = payloadAllowsWorkspaceWrites(
      payload,
      permissionMode,
      this.opts.defaultShouldWrite,
    );
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
        shouldWrite,
      },
      runStoreMetadata: {
        ...(payload.metadata ?? {}),
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

  private async inspectConfiguredCapabilities(): Promise<CapabilitySnapshot> {
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
    const resolvedProfiles = await resolveAgentProfiles(
      this.opts.workspaceRoot,
      agentConfig?.profiles,
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
      const delegateTools = createConfiguredDelegateTools({
        getParent: () => undefined,
        delegates: agentConfig?.delegateTools ?? [],
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
        dynamicSpawnTool,
        shell: shellConfig,
        configPaths: loadedConfig.attempted.map((entry) => entry.path),
      });
      return buildCapabilitySnapshot({
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
          delegates: agentConfig?.delegateTools ?? [],
          derivedAgents,
          delegateChildToolCatalog,
          allowReadWriteWorkspaceAccess: false,
        }),
        shellSandbox,
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

  async inspectSession(sessionId: string): Promise<
    | {
        ok: true;
        sessionId: string;
        summary: Record<string, unknown>;
        consistency: Record<string, unknown>;
        timeline: Record<string, unknown>;
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

    const sessionDir = join(
      this.opts.sessionRootDir ??
        defaultSessionRootDir(this.opts.workspaceRoot),
      safeSessionId,
    );
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
      const [summary, consistency, timeline] = await Promise.all([
        summarizeTraceFile(tracePath),
        validateSessionTraceConsistency({ sessionDir }),
        buildTraceTimelineFile(tracePath),
      ]);
      return {
        ok: true,
        sessionId: safeSessionId,
        summary: summary as unknown as Record<string, unknown>,
        consistency: consistency as unknown as Record<string, unknown>,
        timeline: timeline as unknown as Record<string, unknown>,
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
  toolCatalog: HostToolCatalogEntry[];
  indexedSkills: SkillIndexEntry[];
  loadedSkills: LoadedSkill[];
  skillInlineShell?: CapabilitySkillInlineShellSummary;
  mcpStatuses?: Record<string, McpStatus | { status: "configured" }>;
  mcpToolNameMap?: McpToolNameMapping[];
  agentProfiles?: AgentProfile[];
  delegateTools?: DelegateCapabilityDescriptor[];
  shellSandbox?: ShellSandboxStatus;
  automation?: CapabilityAutomationSummary;
}): CapabilitySnapshot {
  return {
    tools: input.toolCatalog.map((entry) => ({
      name: entry.definition.name,
      origin:
        formatToolOrigin(entry.definition.governance?.origin) ??
        catalogEntryOrigin(entry),
      risk: entry.definition.policy?.risk,
      ...(entry.definition.deferLoading === true ? { deferred: true } : {}),
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
    automation: input.automation,
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
  if (right === undefined) return [...left];
  const rightSet = new Set(right);
  return left.filter((name) => rightSet.has(name));
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

export function createConfiguredDelegateTools(input: {
  getParent: () => ReturnType<typeof createRun> | undefined;
  delegates: CapabilityDelegateToolConfig[];
  derivedAgents: DerivedChildAgentProfile[];
  model: ModelAdapter;
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
          description:
            delegate.description ??
            `Delegate a bounded task to ${profile.name ?? profile.id}.`,
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
          description:
            delegate.description ??
            `Delegate a bounded task to ${profile.name ?? profile.id}.`,
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
    const agentTool = createAgentTool(input.getParent, {
      name: toolName,
      description:
        delegate.description ??
        `Delegate a bounded task to ${profile.name ?? profile.id}.`,
      requiresApproval: delegate.requiresApproval,
      forbidNesting: delegate.forbidNesting ?? true,
      buildSpawnInput: (args, parent) => {
        const subagentDepth = assertSubagentDepthAllowed({
          parent,
          maxDepth: input.maxDepth,
          toolName,
        });
        return {
          goal: args.goal,
          model: input.model,
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

function describeConfiguredDelegateTools(input: {
  delegates: CapabilityDelegateToolConfig[];
  derivedAgents: DerivedChildAgentProfile[];
  delegateChildToolCatalog: readonly HostToolCatalogEntry[];
  allowReadWriteWorkspaceAccess: boolean;
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
    const workspaceAccess = inProcessDelegateWorkspaceAccess({
      profile,
      delegateChildToolCatalog: input.delegateChildToolCatalog,
    });
    const shellAccess = inProcessDelegateHasTool(
      profile,
      input.delegateChildToolCatalog,
      "shell",
    );
    return [
      describeInProcessDelegateCapability({
        delegate,
        profile,
        workspaceAccess,
        shellAccess,
        gatedByRunWrite:
          !input.allowReadWriteWorkspaceAccess &&
          (workspaceAccess === "read_write" || shellAccess),
        allowReadWriteWorkspaceAccess: input.allowReadWriteWorkspaceAccess,
      }),
    ];
  });
}

function inProcessDelegateWorkspaceAccess(input: {
  profile: AgentProfile;
  delegateChildToolCatalog: readonly HostToolCatalogEntry[];
}): DelegateWorkspaceAccess {
  const hasWriteTool = WORKSPACE_WRITE_TOOL_NAMES.some((toolName) =>
    inProcessDelegateHasTool(
      input.profile,
      input.delegateChildToolCatalog,
      toolName,
    ),
  );
  return hasWriteTool ? "read_write" : "none";
}

function inProcessDelegateHasTool(
  profile: AgentProfile,
  delegateChildToolCatalog: readonly HostToolCatalogEntry[],
  toolName: string,
): boolean {
  if (
    !delegateChildToolCatalog.some(
      (entry) => entry.definition.name === toolName,
    )
  ) {
    return false;
  }
  if (profile.allowedTools === undefined) return true;
  return profile.allowedTools.includes(toolName);
}

function childToolsForAgentProfile(
  childTools: readonly ToolDefinition[],
  profile: AgentProfile,
): ToolDefinition[] {
  if (profile.allowedTools === undefined) return [...childTools];
  const allowed = new Set(profile.allowedTools);
  return childTools.filter((tool) => allowed.has(tool.name));
}

/**
 * @internal Exported for host regression tests that assert the spawn path
 * threads `runStore` + `parentUsageTracker` into the child run. Not part of the
 * public host API.
 */
export function createDynamicSpawnAgentTool(input: {
  getParent: () => ReturnType<typeof createRun> | undefined;
  model: ModelAdapter;
  childTools: ToolDefinition[];
  parentRunPolicy: Policy;
  maxDepth?: number;
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
            "Optional subset of read-only tools to expose. Supported: read_file, glob, grep, list_dir. Defaults to all four. Use grep to find a symbol by name (glob only matches paths, not contents).",
          items: {
            type: "string",
            enum: ["read_file", "glob", "grep", "list_dir"],
          },
        },
        maxSteps: {
          type: "integer",
          minimum: 1,
          maximum: 16,
          description:
            "Optional child step (model turn) limit; allocate by sub-task complexity. Defaults to 8 when omitted, capped at 16. A multi-step search (glob, read, refine, conclude) typically needs 6+.",
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
      const subagentDepth = assertSubagentDepthAllowed({
        parent,
        maxDepth: input.maxDepth,
        toolName: "spawn_agent",
      });

      const parsed = parseDynamicSpawnAgentArgs(args);
      const supportedTools = new Set(["read_file", "glob", "grep", "list_dir"]);
      const requestedTools = parsed.allowedTools ?? [
        "read_file",
        "glob",
        "grep",
        "list_dir",
      ];
      const availableTools = new Map(
        input.childTools.map((tool) => [tool.name, tool]),
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
      if (childTools.length === 0) {
        throw new Error(
          "spawn_agent requires at least one enabled child tool.",
        );
      }

      // Strip any leading `dynamic_` the role already carries so a re-used
      // agent id (models sometimes pass a prior child's `dynamic_<role>` id
      // back in as the new role) does not compound into `dynamic_dynamic_*`.
      const roleSegment = sanitizeToolSegment(parsed.role).replace(
        /^(?:dynamic_)+/,
        "",
      );
      const agentId = `dynamic_${roleSegment || "agent"}`;
      const profile: AgentProfile = {
        id: agentId,
        name: parsed.role,
        mode: "child",
        allowedTools: childTools.map((tool) => tool.name),
        maxSteps: parsed.maxSteps,
        prompt: withDelegatedAgentPrompt(parsed.prompt),
        metadata: {
          dynamic: true,
        },
      };
      const spawned = spawnSubAgent({
        parent,
        goal: parsed.goal,
        model: input.model,
        tools: childTools,
        childAgentProfile: profile,
        policy: createLayeredPolicy([
          input.parentRunPolicy,
          createAgentProfilePolicy(profile),
        ]),
        maxSteps: parsed.maxSteps,
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
          delegateTool: "spawn_agent",
          entrypoint: "spawn_agent",
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
            id: sanitizeToolSegment(parsed.role),
            name: parsed.role,
            mode: "child",
            prompt: parsed.prompt,
            allowedTools: childTools.map((tool) => tool.name),
            maxSteps: parsed.maxSteps,
            delegateToolName: `delegate_${sanitizeToolSegment(parsed.role)}`,
          },
        },
      };
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

function parseDynamicSpawnAgentArgs(args: unknown): {
  goal: string;
  role: string;
  prompt: string;
  allowedTools?: string[];
  maxSteps: number;
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
        return value.trim();
      })
    : undefined;
  if (allowedTools && new Set(allowedTools).size !== allowedTools.length) {
    throw new Error("spawn_agent allowedTools must not contain duplicates.");
  }
  const maxSteps =
    record.maxSteps === undefined ? 8 : integerField(record, "maxSteps");
  if (maxSteps < 1) {
    throw new Error("spawn_agent maxSteps must be at least 1.");
  }
  const metadata =
    record.metadata === undefined ? undefined : objectField(record, "metadata");
  return {
    goal,
    role,
    prompt,
    allowedTools,
    maxSteps: Math.min(maxSteps, 16),
    metadata,
  };
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`spawn_agent ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function integerField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isInteger(value)) {
    throw new Error(`spawn_agent ${field} must be an integer.`);
  }
  return value as number;
}

function objectField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = record[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`spawn_agent ${field} must be an object.`);
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

function sanitizeToolSegment(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return clean.replace(/^_+|_+$/g, "") || "agent";
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
