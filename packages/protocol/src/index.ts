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

export const PROTOCOL_VERSION = "1.2" as const;

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
  | "internal_error";

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
  details?: Record<string, unknown>;
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

export interface RunStartRequestPayload {
  goal: string;
  sessionId?: string;
  /** Workspace-relative target path that the run should focus on when applicable. */
  targetPath?: string;
  /** Whether this run is allowed to request workspace writes. */
  shouldWrite?: boolean;
  /** Model reference in "provider/model" form, or the reserved "deterministic". */
  model?: string;
  permissionMode?:
    | "plan"
    | "default"
    | "accept_edits"
    | "dont_ask"
    | "bypass_permissions";
  traceLevel?: "minimal" | "standard" | "debug";
  metadata?: Record<string, unknown>;
}

export interface RunResumeRequestPayload {
  /** Prior run to resume from a persisted checkpoint or reconstructed trace. */
  runId: string;
  /** Optional session scope used to disambiguate where the prior run lives. */
  sessionId?: string;
  /** Workspace-relative target path that the resumed run should focus on when applicable. */
  targetPath?: string;
  /** Whether the resumed run is allowed to request workspace writes. */
  shouldWrite?: boolean;
  /** Reconstruct a best-effort checkpoint from trace.jsonl when checkpoint.json is absent. */
  fromTrace?: boolean;
  /** Allow resuming checkpoints that are terminal or otherwise normally refused. */
  force?: boolean;
  /** Model reference in "provider/model" form, or the reserved "deterministic". */
  model?: string;
  permissionMode?:
    | "plan"
    | "default"
    | "accept_edits"
    | "dont_ask"
    | "bypass_permissions";
  traceLevel?: "minimal" | "standard" | "debug";
  metadata?: Record<string, unknown>;
}

export interface RunCancelRequestPayload {
  runId: string;
  reason?: string;
}

export interface RunInjectMessageRequestPayload {
  runId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalResolveRequestPayload {
  approvalId: string;
  decision: "approved" | "denied";
  message?: string;
}

export interface SessionListRequestPayload {
  limit?: number;
}

export interface SessionInspectRequestPayload {
  sessionId: string;
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

export interface CapabilityInspectRequestPayload {
  /**
   * Reserved for future scoped inspection. Omit to inspect the host/session
   * capability state known to this connection.
   */
  sessionId?: string;
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
  };
  "session.fork": {
    forkedSessionId: string;
    copiedEventCount: number;
    truncatedAtSequence: number | null;
  };
  "capability.inspect": CapabilitySnapshot;
}

export interface CapabilityToolSummary {
  name: string;
  origin?: string;
  risk?: string;
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

export interface CapabilitySnapshot {
  tools: CapabilityToolSummary[];
  skills: {
    indexed: CapabilitySkillSummary[];
    loaded: CapabilitySkillSummary[];
  };
  mcp: {
    statuses: CapabilityMcpStatus[];
  };
  agents: {
    profiles: CapabilityAgentSummary[];
  };
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
