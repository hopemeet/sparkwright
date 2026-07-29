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

export type AgentBlockerKind =
  | "capability"
  | "permission"
  | "user_input"
  | "dependency"
  | "resource_limit"
  | "conflict"
  | "protocol"
  | "unknown";

export type AgentBlockerOwner = "parent" | "user" | "runtime" | "external";

export type AgentBlockerRetry =
  | "none"
  | "immediate"
  | "after_input"
  | "after_approval"
  | "after_capability_change"
  | "after_dependency_change"
  | "after_resource_change";

export type AgentBlockerRequirementKind =
  "tool" | "approval" | "input" | "dependency" | "resource";

export interface AgentBlockerRequirement {
  kind: AgentBlockerRequirementKind;
  name: string;
}

export interface AgentBlocker {
  /** Stable machine-readable reason within the blocker kind. */
  code: string;
  kind: AgentBlockerKind;
  /** Actor that can satisfy or adjudicate the blocker. */
  owner: AgentBlockerOwner;
  message: string;
  requirements?: AgentBlockerRequirement[];
  retry: AgentBlockerRetry;
}

export interface AgentResultDeclaration {
  schemaVersion: "agent-outcome.v1";
  /** Child-declared semantic outcome, independent of process/run transport. */
  status: AgentResultStatus;
  /** Concise explanation suitable for the parent agent. */
  summary: string;
  /** Bounded useful work already completed by the child. */
  accomplishments?: string[];
  /** Optional structured detail; status + summary form the complete envelope. */
  blockers?: AgentBlocker[];
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
  /** Semantic child outcome. A completed run may still report blocked/partial. */
  status: AgentResultStatus;
  /** Structured child/runtime summary. */
  summary: string;
  /** Bounded useful work already completed by the child. */
  accomplishments?: string[];
  /** Canonical runtime projection; empty when the child supplied no detail. */
  blockers: AgentBlocker[];
  /** Core-owned semantic assessment projected without reinterpretation. */
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
