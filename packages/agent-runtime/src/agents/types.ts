import type {
  RunAssessment,
  RunResult,
  UsageSnapshot,
} from "@sparkwright/core";

export interface AgentHandoffPayload {
  /** Self-contained delegated task and expected deliverable. */
  goal: string;
  /** Parent-established facts and constraints at working/user authority. */
  context?: string;
  /** UI/trace-only label; never a prompt or permission input. */
  label?: string;
}

export type AgentToolInvocationInput = AgentHandoffPayload;

export interface AgentToolSummarizeInput {
  childRunId: string;
  spanId: string;
  result: RunResult;
  /** Child's final usage snapshot at termination. */
  usage: UsageSnapshot;
}

export type AgentResultStatus = "completed" | "partial" | "blocked";

export interface AgentBlocker {
  /** Stable machine-readable runtime reason. */
  code: string;
  message: string;
}

/**
 * Runtime-owned completion facts for one in-process child invocation.
 *
 * This shape is used by lifecycle, diagnostics, aggregation, and the
 * delegation ledger. It is deliberately not the model-visible tool result.
 */
export interface AgentRuntimeResult {
  childRunId: string;
  spanId: string;
  signal: RunResult["signal"];
  stopReason: RunResult["stopReason"];
  message?: string;
  tokens: number;
  costUsd: number;
  toolCalls: number;
  modelCalls: number;
  /**
   * Runtime-derived report status. `completed` means the child delivered a
   * non-empty final report; the parent still decides whether the goal was met.
   */
  status: AgentResultStatus;
  /** Structured child/runtime summary. */
  summary: string;
  /** Runtime-owned blocker evidence. */
  blockers: AgentBlocker[];
  /** Core-owned execution health projected without reinterpretation. */
  assessment: RunAssessment;
  /**
   * True only when the child exhausted its allowed actions and the runtime
   * forced a tool-less best-effort wrap-up.
   */
  stepLimitReached?: boolean;
  truncated?: boolean;
}

export interface ParentAgentWorkspaceEvidence {
  /** Runtime-observed managed workspace writes performed by the child. */
  writes: number;
  /** Unique paths from the structured write lifecycle, when available. */
  paths?: string[];
}

/**
 * Compact child report returned to the parent model.
 *
 * `report` is child-authored. `workspace` and `warnings` are runtime-owned
 * evidence that the parent must use when making mutation or completeness
 * claims.
 */
export interface ParentAgentResult {
  childRunId: string;
  status: AgentResultStatus;
  report: string;
  workspace: ParentAgentWorkspaceEvidence;
  warnings?: string[];
  blockers?: AgentBlocker[];
}

export interface DelegationLedgerKey {
  kind: "agent_tool" | "configured_delegate" | "dynamic_spawn";
  agentProfileId?: string;
  delegateTool?: string;
  role?: string;
  /** Explicit task context whose changes must invalidate dynamic-spawn reuse. */
  context?: string;
  allowedTools?: readonly string[];
  modelFingerprint?: string;
  capabilityFingerprint?: string;
  promptFingerprint?: string;
  workspaceEpoch?: number;
  /** External/network-observing child surfaces must not reuse cached results. */
  cacheable?: boolean;
}

export interface DelegationLedgerResult extends AgentRuntimeResult {
  output?: ParentAgentResult;
}

export interface DelegationLedgerHit {
  goal: string;
  result: DelegationLedgerResult;
}
