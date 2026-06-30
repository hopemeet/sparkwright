/**
 * Sparkwright host wire-protocol types.
 *
 * These types mirror `schemas/host-message.schema.json` and are the canonical
 * import for any client (TUI, browser SDK, third-party clients) or host
 * implementation. They contain NO runtime logic — pure type declarations only.
 *
 * Protocol version is `MAJOR.MINOR`. Within a major, additions are allowed;
 * removals or renames require a major bump. See `docs/HOST_PROTOCOL.md` for
 * the full specification, lifecycle, and error semantics.
 */

export const PROTOCOL_VERSION = "1.3" as const;

export const PERMISSION_MODES = [
  "plan",
  "default",
  "accept_edits",
  "dont_ask",
  "bypass_permissions",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (PERMISSION_MODES as readonly string[]).includes(value)
  );
}

/**
 * High-level run autonomy preset. The single user-facing access knob; the host
 * compiles it to `permissionMode` + `shouldWrite`. Mirrors
 * `@sparkwright/core`'s ACCESS_MODES (kept in sync, like PermissionMode).
 */
export const ACCESS_MODES = [
  "read-only",
  "ask",
  "accept-edits",
  "bypass",
] as const;

export type RunAccessMode = (typeof ACCESS_MODES)[number];

export function isRunAccessMode(value: unknown): value is RunAccessMode {
  return (
    typeof value === "string" &&
    (ACCESS_MODES as readonly string[]).includes(value)
  );
}

export const TRACE_LEVELS = ["standard", "debug"] as const;

export type TraceLevel = (typeof TRACE_LEVELS)[number];

export function isTraceLevel(value: unknown): value is TraceLevel {
  return (
    typeof value === "string" &&
    (TRACE_LEVELS as readonly string[]).includes(value)
  );
}

export const INTERNAL_TRANSCRIPT_EVENT_TYPES = [
  "workflow_hook.started",
  "workflow_hook.completed",
  "run.started",
  "run.created",
  "run.budget.checked",
  "run.cancelled",
  "run.cancel_requested",
  "run.state_transition.rejected",
  "context.assembled",
  "context.cache_break.detected",
  "context.compaction_requested",
  "context.compaction.started",
  "context.compaction.completed",
  "context.compaction.failed",
  "skill.indexed",
  "prompt.built",
  "model.turn.started",
  "model.turn.completed",
  "model.requested",
  "model.retrying",
  "model.stream.failed",
  "model.stream.started",
  "model.stream.chunk",
  "model.stream.completed",
  "tool.batch.completed",
  "tool.started",
  "tool.progress",
  "workspace.write.requested",
  "artifact.created",
  "approval.requested",
  "interaction.requested",
  "interaction.resolved",
  "usage.updated",
] as const;

const INTERNAL_TRANSCRIPT_EVENT_TYPE_SET = new Set<string>(
  INTERNAL_TRANSCRIPT_EVENT_TYPES,
);

export function isInternalTranscriptEventType(type: string): boolean {
  return INTERNAL_TRANSCRIPT_EVENT_TYPE_SET.has(type);
}

export const LIVE_DEBUG_NOISE_EVENT_TYPES = [
  "model.stream.chunk",
  "run.budget.checked",
] as const;

const LIVE_DEBUG_NOISE_EVENT_TYPE_SET = new Set<string>(
  LIVE_DEBUG_NOISE_EVENT_TYPES,
);

export function isLiveDebugNoiseEventType(type: string): boolean {
  return LIVE_DEBUG_NOISE_EVENT_TYPE_SET.has(type);
}

// ---------------------------------------------------------------------------
// Envelope discriminator
// ---------------------------------------------------------------------------

export type HostMessage = HostRequest | HostResponse | HostEvent;

export type HostMessageEnvelope = "request" | "response" | "event";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProtocolErrorCode =
  | "protocol_version_mismatch"
  | "unknown_kind"
  | "invalid_payload"
  | "run_not_found"
  | "approval_not_found"
  | "session_not_found"
  | "task_not_found"
  | "internal_error";

const PROTOCOL_ERROR_CODES: readonly ProtocolErrorCode[] = [
  "protocol_version_mismatch",
  "unknown_kind",
  "invalid_payload",
  "run_not_found",
  "approval_not_found",
  "session_not_found",
  "task_not_found",
  "internal_error",
];

export function isProtocolErrorCode(
  value: unknown,
): value is ProtocolErrorCode {
  return (
    typeof value === "string" &&
    (PROTOCOL_ERROR_CODES as readonly string[]).includes(value)
  );
}

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface CompactionWarning {
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface SessionCompactionSummarizerMeasurement {
  applied: boolean;
  skippedReason?: string;
  mode?: string;
  modelId?: string;
  promptVersion?: string;
  /** @reserved Public oracle version consumed by artifact and diagnostics readers. */
  oracleVersion?: string;
  /** @reserved Public summary input fingerprint consumed by artifact reuse diagnostics. */
  inputHash?: string;
  /** @reserved Public reproducibility flag consumed by compact artifact readers. */
  nonDeterministic?: boolean;
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface SessionCompactionMeasurement {
  sourceRunCount: number;
  originalCharCount: number;
  summaryCharCount: number;
  freedChars: number;
  savingsRatio: number;
  freedByTier: Record<string, number>;
  regime: "no_savings" | "redundancy_bound" | "density_bound" | "mixed";
  signalCount: number;
  summarizer?: SessionCompactionSummarizerMeasurement;
}

export interface RunFailureEnvelope {
  category?: string;
  code: string;
  message: string;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type RequestKind =
  | "handshake"
  | "run.start"
  | "run.resume"
  | "run.inject_message"
  | "run.cancel"
  | "approval.resolve"
  | "session.list"
  | "session.inspect"
  | "session.fork"
  | "session.compact"
  | "task.list"
  | "task.get"
  | "task.output"
  | "task.stop"
  | "capability.inspect";

export interface HostRequestBase<TKind extends RequestKind, TPayload> {
  envelope: "request";
  id: string;
  kind: TKind;
  timestamp: string;
  payload: TPayload;
}

export interface HandshakeRequestPayload {
  protocolVersion: string;
  client: { name: string; version: string };
  capabilities?: string[];
}

export interface RunTextInputPart {
  type: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RunMediaInputPart {
  type: "image" | "file" | "audio";
  /** Base64-encoded bytes for local client-provided content. */
  data?: string;
  /** URL/URI reference for provider- or host-resolvable content. */
  uri?: string;
  mediaType?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export type RunInputPart = RunTextInputPart | RunMediaInputPart;

export interface RunInputPayload {
  /**
   * Extensible input content parts. Text-only clients can keep using
   * `goal`/`content`; media-capable clients add parts here.
   */
  parts?: RunInputPart[];
  metadata?: Record<string, unknown>;
}

export interface RunStartRequestPayload {
  goal: string;
  input?: RunInputPayload;
  sessionId?: string;
  /** Workspace-relative target path that the run should focus on when applicable. */
  targetPath?: string;
  /** Workspace-relative paths/globs whose contents this run must not read. */
  confidentialPaths?: string[];
  /** Whether this run is allowed to request workspace writes. */
  shouldWrite?: boolean;
  /** Model reference in "provider/model" form, or the reserved "deterministic". */
  model?: string;
  /**
   * High-level run autonomy preset. When present, the host compiles it to
   * `permissionMode` + `shouldWrite` and a conflicting legacy `permissionMode`
   * is ignored (with a diagnostic). Preferred over `permissionMode`.
   */
  accessMode?: RunAccessMode;
  permissionMode?: PermissionMode;
  traceLevel?: TraceLevel;
  metadata?: Record<string, unknown>;
}

export interface RunResumeRequestPayload {
  /** Prior run to resume from a persisted checkpoint or reconstructed trace. */
  runId: string;
  /** Optional session scope used to disambiguate where the prior run lives. */
  sessionId?: string;
  /** Workspace-relative target path that the resumed run should focus on when applicable. */
  targetPath?: string;
  /** Workspace-relative paths/globs whose contents this run must not read. */
  confidentialPaths?: string[];
  /** Whether the resumed run is allowed to request workspace writes. */
  shouldWrite?: boolean;
  /** Reconstruct a best-effort checkpoint from trace.jsonl when checkpoint.json is absent. */
  fromTrace?: boolean;
  /** Allow resuming checkpoints that are terminal or otherwise normally refused. */
  force?: boolean;
  /** Model reference in "provider/model" form, or the reserved "deterministic". */
  model?: string;
  /**
   * High-level run autonomy preset. When present, the host compiles it to
   * `permissionMode` + `shouldWrite` and a conflicting legacy `permissionMode`
   * is ignored (with a diagnostic). Preferred over `permissionMode`.
   */
  accessMode?: RunAccessMode;
  permissionMode?: PermissionMode;
  traceLevel?: TraceLevel;
  metadata?: Record<string, unknown>;
}

export interface RunCancelRequestPayload {
  runId: string;
  reason?: string;
}

export interface RunInjectMessageRequestPayload {
  runId: string;
  content: string;
  input?: RunInputPayload;
  metadata?: Record<string, unknown>;
}

export interface ApprovalResolveRequestPayload {
  approvalId: string;
  decision: "approved" | "denied";
  message?: string;
  autoApproved?: boolean;
}

export interface SessionListRequestPayload {
  limit?: number;
}

export interface SessionInspectRequestPayload {
  sessionId: string;
  /**
   * Include a session-compaction audit view derived from compact.json and
   * session-local compaction events. The compacted summary body is not
   * returned.
   */
  compaction?: boolean;
}

export interface SessionCompactionInspectArtifact {
  path: string;
  schemaVersion: string;
  createdAt: string;
  throughRunId: string;
  compactedRunCount: number;
  sourceRunIds: string[];
  originalCharCount: number;
  summaryCharCount: number;
  freedChars: number;
  measurement?: SessionCompactionMeasurement;
  mode?: string;
  reason?: string;
  warningCodes?: string[];
  summaryFingerprint?: Record<string, unknown>;
}

export interface SessionCompactionInspectEvent {
  sequence: number;
  timestamp: string;
  type: "session.compaction.completed" | "session.compaction.skipped";
  compactedRunCount: number;
  throughRunId: string | null;
  originalCharCount: number;
  summaryCharCount: number;
  freedChars: number;
  measurement?: SessionCompactionMeasurement;
  artifactPath: string | null;
  skippedReason?: string;
  warningCodes?: string[];
  reason?: string;
  source?: string;
}

export interface SessionCompactionInspectReport {
  status:
    | "not_compacted"
    | "compacted"
    | "skipped"
    | "artifact_only"
    | "event_only"
    | "stale_artifact";
  artifact: SessionCompactionInspectArtifact | null;
  events: SessionCompactionInspectEvent[];
  latestEvent: SessionCompactionInspectEvent | null;
  consistency: {
    ok: boolean;
    artifactMatchesLatestCompletedEvent: boolean | null;
    findings: string[];
  };
}

export interface SessionForkRequestPayload {
  /** Source session to fork from. */
  sourceSessionId: string;
  /**
   * Last event sequence (inclusive) to retain in the fork. Omit to clone the
   * full source history.
   */
  forkAtSequence?: number;
}

export interface SessionCompactRequestPayload {
  /** Session whose completed prior turns should be compacted. */
  sessionId: string;
  /**
   * Optional caller label recorded in the artifact metadata for diagnostics.
   *
   * @reserved Public session-compaction field consumed by host diagnostics.
   */
  reason?: string;
  /**
   * Explicitly request the Tier-3 session summarizer path. Provider/scripted
   * model refs use model-backed summarization; deterministic refs use the
   * preview path and return a warning.
   */
  llm?: boolean;
}

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export const TASK_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export interface TaskError {
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface TaskRecordSnapshot {
  id: string;
  parentRunId: string;
  kind: string;
  title?: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  lastOutputAt?: string;
  lastProgressAt?: string;
  lastHealthCheckAt?: string;
  outputChunks?: number;
  outputBytes?: number;
  completedAt?: string;
  result?: unknown;
  error?: TaskError;
  metadata: Record<string, unknown>;
}

export interface TaskOutputChunkSnapshot {
  taskId: string;
  sequence: number;
  timestamp: string;
  channel: "stdout" | "stderr" | "event";
  data: string;
}

export interface TaskListRequestPayload {
  status?: TaskStatus;
  kind?: string;
  parentRunId?: string;
  limit?: number;
}

export interface TaskGetRequestPayload {
  taskId: string;
}

export interface TaskOutputRequestPayload {
  taskId: string;
  fromSequence?: number;
  maxChunks?: number;
}

export interface TaskStopRequestPayload {
  taskId: string;
}

export interface CapabilityInspectRequestPayload {
  /**
   * Reserved for future scoped inspection. Omit to inspect the host/session
   * capability state known to this connection.
   */
  sessionId?: string;
  /** Model reference in "provider/model" form, or the reserved "deterministic". */
  model?: string;
}

export type HostRequest =
  | HostRequestBase<"handshake", HandshakeRequestPayload>
  | HostRequestBase<"run.start", RunStartRequestPayload>
  | HostRequestBase<"run.resume", RunResumeRequestPayload>
  | HostRequestBase<"run.inject_message", RunInjectMessageRequestPayload>
  | HostRequestBase<"run.cancel", RunCancelRequestPayload>
  | HostRequestBase<"approval.resolve", ApprovalResolveRequestPayload>
  | HostRequestBase<"session.list", SessionListRequestPayload>
  | HostRequestBase<"session.inspect", SessionInspectRequestPayload>
  | HostRequestBase<"session.fork", SessionForkRequestPayload>
  | HostRequestBase<"session.compact", SessionCompactRequestPayload>
  | HostRequestBase<"task.list", TaskListRequestPayload>
  | HostRequestBase<"task.get", TaskGetRequestPayload>
  | HostRequestBase<"task.output", TaskOutputRequestPayload>
  | HostRequestBase<"task.stop", TaskStopRequestPayload>
  | HostRequestBase<"capability.inspect", CapabilityInspectRequestPayload>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

interface HostResponseBase {
  envelope: "response";
  id: string;
  timestamp: string;
}

export interface HostResponseOk extends HostResponseBase {
  ok: true;
  result: Record<string, unknown>;
}

export interface HostResponseError extends HostResponseBase {
  ok: false;
  error: ProtocolError;
}

export type HostResponse = HostResponseOk | HostResponseError;

/** Concrete result shapes for ok responses, by originating request kind. */
export interface ResponseResults {
  handshake: Record<string, never>;
  "run.start": { runId: string };
  "run.resume": {
    runId: string;
    resumedFromRunId: string;
    sessionId?: string;
  };
  "run.inject_message": Record<string, never>;
  "run.cancel": Record<string, never>;
  "approval.resolve": Record<string, never>;
  "session.list": {
    sessions: Array<{ id: string; mtimeMs: number; preview: string }>;
  };
  "session.inspect": {
    sessionId: string;
    summary: Record<string, unknown>;
    consistency: Record<string, unknown>;
    timeline: Record<string, unknown>;
    compaction?: SessionCompactionInspectReport;
  };
  "session.fork": {
    forkedSessionId: string;
    copiedEventCount: number;
    truncatedAtSequence: number | null;
  };
  "session.compact": {
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
  "task.list": {
    tasks: TaskRecordSnapshot[];
  };
  "task.get": TaskRecordSnapshot;
  "task.output": {
    taskId: string;
    chunks: TaskOutputChunkSnapshot[];
    nextSequence: number;
    complete: boolean;
    status: TaskStatus;
    error?: TaskError;
    lastOutputAt?: string;
    stalled: boolean;
  };
  "task.stop": {
    cancelled: boolean;
    status?: TaskStatus;
  };
  "capability.inspect": CapabilitySnapshot;
}

export interface CapabilityToolSummary {
  name: string;
  canonicalName?: string;
  legacyNames?: string[];
  defaultExposureTier?:
    | "public"
    | "advanced"
    | "infrastructure"
    | "internal"
    | "legacy";
  source?: string;
  origin?: string;
  risk?: string;
  governance?: unknown;
  effectiveLoading?: "eager" | "deferred";
  /** True when the full tool schema is loaded through tool_search on demand. */
  deferred?: boolean;
  disabled?: boolean;
  relatedTools?: string[];
  requiresTool?: string[];
}

export interface CapabilityModelPricingSummary {
  source: "configured" | "builtin" | "unavailable" | "not_applicable";
  costStatus: "estimated" | "unavailable" | "not_applicable";
  costUnavailableReason?: "missing_pricing" | string;
  warning?: string;
}

export interface CapabilityModelSummary {
  modelRef: string;
  providerKey: string;
  modelId: string;
  adapterId: string;
  pricing: CapabilityModelPricingSummary;
}

export interface CapabilitySkillSummary {
  name: string;
  description?: string;
  sourcePath?: string;
  contentHash?: string;
  version?: string;
  selectionReason?: string;
}

export interface CapabilityMcpStatus {
  serverName: string;
  status: string;
  toolNames: string[];
  errorCode?: string;
  /** @reserved Public capability-status field consumed by diagnostics UIs. */
  errorPhase?: string;
  /** @reserved Public capability-status field consumed by diagnostics UIs. */
  errorMessage?: string;
}

export interface CapabilityAgentSummary {
  id: string;
  name?: string;
  mode?: string;
}

export interface CapabilityDelegateToolSummary {
  toolName: string;
  profileId: string;
  /** @reserved Public capability-inspection field consumed by host protocol clients. */
  profileName?: string;
  protocol: "acp" | "external_command" | "in_process";
  /**
   * Preferred model ("provider/model") this delegate runs on, when the profile
   * declares one. Omitted when the delegate inherits the parent run's model.
   *
   * @reserved Public capability-inspection field consumed by routing/inspect UIs.
   */
  model?: string;
  risk: "safe" | "risky" | "denied";
  /** Legacy config echo. Prefer approvalRequiredUnderCurrentRun for diagnostics. */
  requiresApproval: boolean;
  /** @reserved Public capability-inspection field consumed by permission UIs. */
  approvalRequiredUnderCurrentRun?: boolean;
  /** @reserved Public capability-inspection field consumed by permission UIs. */
  approvalReasons?: string[];
  /** @reserved Public capability-inspection field consumed by permission UIs. */
  approvalRunOptions?: {
    shouldWrite?: boolean;
  };
  forbidNesting: boolean;
  sideEffects: string[];
  workspaceAccess: "none" | "read_write";
  /** @reserved Public capability-inspection field consumed by permission UIs. */
  shellAccess: boolean;
  /** @reserved Public capability-inspection field consumed by permission UIs. */
  processSpawn: boolean;
  /** @reserved Public capability-inspection field consumed by permission UIs. */
  gatedByRunWrite?: boolean;
  /**
   * Optional deterministic routing hint/evaluation. Present when a profile
   * declares routing keywords; relevance is present after a goal has been
   * evaluated. Sorting hints do not hide delegates.
   *
   * @reserved Public capability-inspection field consumed by routing/inspect UIs.
   */
  routing?: CapabilityDelegateRoutingSummary;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  outputLimits?: {
    stdoutBytes?: number;
    stderrBytes?: number;
  };
}

export interface CapabilityDelegateRoutingSummary {
  keywords: string[];
  mode?: "sort";
  relevance?: "relevant" | "low";
  score?: number;
  matchedKeywords?: string[];
  reason?: string;
}

export interface CapabilityCronJobSummary {
  id: string;
  name: string;
  enabled: boolean;
  state: string;
  schedule: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastTracePath?: string | null;
}

export interface CapabilityTaskSummary {
  id: string;
  kind: string;
  status: string;
  title?: string;
  parentRunId: string;
  createdAt: string;
  completedAt?: string;
  outputChunks?: number;
  lastOutputAt?: string;
  error?: { code: string; message: string };
}

export interface CapabilityAutomationSummary {
  cron: {
    rootDir: string;
    jobs: CapabilityCronJobSummary[];
    total: number;
  };
  tasks: {
    rootDir: string;
    tasks: CapabilityTaskSummary[];
    total: number;
  };
}

export type CapabilityWorkflowRuleSource =
  | "config"
  | "verification"
  | "builtin";

export type CapabilityWorkflowRuleStatus =
  | "active"
  | "available"
  | "inactive"
  | "disabled";

export interface CapabilityWorkflowRuleSummary {
  name: string;
  source: CapabilityWorkflowRuleSource;
  lifecycle: string;
  matcher: string;
  action: string;
  blockingPotential: boolean;
  enabled: boolean;
  active: boolean;
  status: CapabilityWorkflowRuleStatus;
  description?: string;
  disableHint?: string;
  configurationHint?: string;
}

export interface CapabilityEventRuleSummary {
  name: string;
  source: CapabilityWorkflowRuleSource;
  trigger: string;
  matcher: string;
  action: string;
  blockingPotential: false;
  enabled: boolean;
  active: boolean;
  status: CapabilityWorkflowRuleStatus;
  description?: string;
  disableHint?: string;
  configurationHint?: string;
}

export interface CapabilitySnapshot {
  model?: CapabilityModelSummary;
  tools: CapabilityToolSummary[];
  skills: {
    indexed: CapabilitySkillSummary[];
    loaded: CapabilitySkillSummary[];
    inlineShell?: CapabilitySkillInlineShellSummary;
  };
  mcp: {
    statuses: CapabilityMcpStatus[];
  };
  agents: {
    profiles: CapabilityAgentSummary[];
    delegateTools: CapabilityDelegateToolSummary[];
  };
  shell?: {
    foregroundTimeoutMs?: number;
    promotionAvailable?: boolean;
    sandbox: CapabilityShellSandboxSummary;
  };
  rules?: {
    workflow: CapabilityWorkflowRuleSummary[];
    events?: CapabilityEventRuleSummary[];
  };
  automation?: CapabilityAutomationSummary;
}

export interface CapabilitySkillInlineShellSummary {
  enabled: boolean;
  timeoutMs?: number;
  maxOutputChars?: number;
  sandboxMode: string;
  writePolicy: "disabled" | "no-write";
  failClosed: boolean;
}

export interface CapabilityShellSandboxSummary {
  mode: string;
  failIfUnavailable: boolean;
  runtimeId: string;
  platform: string;
  available: boolean;
  networkMode: string;
  filesystemIsolation: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventKind =
  | "host.ready"
  | "host.log"
  | "run.event"
  | "approval.requested"
  | "run.continuation"
  | "run.completed"
  | "run.failed";

export interface HostEventBase<TKind extends EventKind, TPayload> {
  envelope: "event";
  id: string;
  kind: TKind;
  timestamp: string;
  payload: TPayload;
}

export interface HostReadyEventPayload {
  protocolVersion: string;
  host: { name: string; version: string };
  capabilities?: string[];
}

export interface HostLogEventPayload {
  level: "stdout" | "stderr" | "info" | "warn" | "error";
  line: string;
  source?: string;
}

/**
 * Wraps a SparkwrightEvent from `schemas/event.schema.json`. Typed as
 * `unknown` here because the protocol package intentionally does NOT depend
 * on @sparkwright/core. Clients that want strong types can cast after
 * importing the event type from core (host implementations always do).
 */
export interface RunEventPayload {
  runId: string;
  event: unknown;
}

export interface ApprovalRequestedEventPayload {
  runId: string;
  approvalId: string;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
}

/**
 * Emitted when a todo-aware supervisor auto-continues an unfinished run: the
 * previous run reached a resumable terminal state with todos still open, so a
 * fresh run is started to carry on. The logical turn is still in progress — a
 * client should keep showing "running" (re-pointing at `runId`) rather than
 * treating the previous run's terminal as the end of the turn. No `run.completed`
 * is emitted for the superseded run; only the final run of the chain completes.
 */
export interface RunContinuationEventPayload {
  /** The new run carrying the continuation. */
  runId: string;
  /**
   * The run that just reached terminal and is being continued. Lets a client
   * correlate / collapse the superseded run's card with its continuation.
   *
   * @reserved Public protocol field consumed by downstream clients (the TUI
   * banner currently keys off `runId`/`continuationCount`); kept for run-chain
   * correlation.
   */
  previousRunId: string;
  /** 1 for the first continuation, incrementing thereafter. */
  continuationCount: number;
  /** Audit reason, currently always "unfinished_todo". */
  reason: string;
}

export interface RunCompletedEventPayload {
  runId: string;
  state: string;
  stopReason?: string;
  /** Final answer text when the run ended by producing one. */
  message?: string;
  /** Present when the run completed with a non-clean outcome summary. */
  outcome?: object;
  /** Present when `state` is `failed` or `cancelled` and a structured cause is available. */
  failure?: RunFailureEnvelope;
  /**
   * Present when the run chain ended by handing back to the human while todos
   * were still unfinished (continuation limit reached, stalled without
   * external progress, or a non-resumable stop). Clients should surface this
   * distinctly from a clean completion.
   */
  todoHandoff?: { reason: string; message: string };
}

export interface RunFailedEventPayload {
  runId: string;
  /** Canonical terminal failure. Prefer this over the legacy `error` projection. */
  failure: RunFailureEnvelope;
  /** @deprecated Use `failure`; kept for older protocol clients. */
  error: ProtocolError;
}

export type HostEvent =
  | HostEventBase<"host.ready", HostReadyEventPayload>
  | HostEventBase<"host.log", HostLogEventPayload>
  | HostEventBase<"run.event", RunEventPayload>
  | HostEventBase<"approval.requested", ApprovalRequestedEventPayload>
  | HostEventBase<"run.continuation", RunContinuationEventPayload>
  | HostEventBase<"run.completed", RunCompletedEventPayload>
  | HostEventBase<"run.failed", RunFailedEventPayload>;

// ---------------------------------------------------------------------------
// Narrowing helpers (zero-cost, type-only at runtime).
// ---------------------------------------------------------------------------

export function isRequest(msg: HostMessage): msg is HostRequest {
  return msg.envelope === "request";
}
export function isResponse(msg: HostMessage): msg is HostResponse {
  return msg.envelope === "response";
}
export function isEvent(msg: HostMessage): msg is HostEvent {
  return msg.envelope === "event";
}

export function protocolErrorToRunFailure(
  error: ProtocolError,
): RunFailureEnvelope {
  return {
    code: error.code,
    message: error.message,
    ...(error.details ? { metadata: error.details } : {}),
  };
}

export function getRunFailure(
  payload: unknown,
): RunFailureEnvelope | undefined {
  const record = isRecord(payload) ? payload : undefined;
  if (!record) return undefined;

  const failure = runFailureEnvelope(record.failure);
  if (failure) return failure;

  const error = protocolError(record.error);
  if (error) return protocolErrorToRunFailure(error);

  const state = stringValue(record.state);
  if (state !== "failed" && state !== "cancelled") return undefined;

  const message =
    stringValue(record.message) ??
    stringValue(record.reason) ??
    stringValue(record.stopReason);
  if (!message) return undefined;

  return {
    code:
      stringValue(record.code) ??
      stringValue(record.reason) ??
      stringValue(record.stopReason) ??
      state,
    message,
  };
}

export function runFailureMessage(
  payload: unknown,
  fallback = "run failed",
): string {
  const failure = getRunFailure(payload);
  if (failure?.message) return failure.message;
  const record = isRecord(payload) ? payload : undefined;
  return (
    stringValue(record?.message) ??
    stringValue(record?.reason) ??
    stringValue(record?.stopReason) ??
    fallback
  );
}

function protocolError(value: unknown): ProtocolError | undefined {
  const record = isRecord(value) ? value : undefined;
  const code = stringValue(record?.code);
  const message = stringValue(record?.message);
  if (!code || !message || !isProtocolErrorCode(code)) return undefined;
  return {
    code,
    message,
    ...(isRecord(record?.details) ? { details: record.details } : {}),
  };
}

function runFailureEnvelope(value: unknown): RunFailureEnvelope | undefined {
  const record = isRecord(value) ? value : undefined;
  const code = stringValue(record?.code);
  const message = stringValue(record?.message);
  if (!code || !message) return undefined;
  return {
    ...(stringValue(record?.category)
      ? { category: stringValue(record?.category) }
      : {}),
    code,
    message,
    ...(typeof record?.retryable === "boolean"
      ? { retryable: record.retryable }
      : {}),
    ...(isRecord(record?.metadata) ? { metadata: record.metadata } : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
