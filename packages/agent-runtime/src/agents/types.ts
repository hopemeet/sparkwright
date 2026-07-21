import type {
  RunAssessment,
  RunResult,
  UsageSnapshot,
} from "@sparkwright/core";

export interface AgentToolInvocationInput {
  /** The goal forwarded to the child run. */
  goal: string;
  /** Optional free-form metadata supplied by the LLM. */
  metadata?: Record<string, unknown>;
}

export interface AgentToolSummarizeInput {
  childRunId: string;
  spanId: string;
  result: RunResult;
  /** Child's final usage snapshot at termination. */
  usage: UsageSnapshot;
}

export type AgentResultStatus = "completed" | "partial" | "blocked";

export type AgentResultStatusSource = "child" | "runtime" | "adapter";

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
  /** Structured reasons completion is impossible in the current child scope. */
  blockers: AgentBlocker[];
}

export interface AgentToolResult {
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
  /** Authority that produced the semantic status. */
  statusSource: AgentResultStatusSource;
  /** Structured child/runtime summary. */
  summary: string;
  /** Bounded useful work already completed by the child. */
  accomplishments?: string[];
  /** Structured blockers; non-empty whenever status is blocked. */
  blockers: AgentBlocker[];
  /** Whether the child reached a complete terminal answer, independent of health. */
  finality: "complete" | "partial";
  /** Core-owned semantic assessment projected without reinterpretation. */
  assessment: RunAssessment;
  /**
   * True when the child answered on its last allowed step (`stepLimitReached`
   * in the run result metadata). A `final_answer` produced under an exhausted
   * step budget may be truncated; the parent should caveat rather than treat it
   * as exhaustive.
   *
   * @reserved Public delegate-tool output field consumed by parent agents and UIs.
   */
  stepLimitReached?: boolean;
  /** @reserved Public delegate-tool output field consumed by parent agents and UIs. */
  alreadyCompleted?: boolean;
  note?: string;
}

export interface DelegationLedgerKey {
  kind: "agent_tool" | "configured_delegate" | "dynamic_spawn";
  agentProfileId?: string;
  delegateTool?: string;
  role?: string;
  prompt?: string;
  allowedTools?: readonly string[];
}

export interface DelegationLedgerResult extends AgentToolResult {
  truncated?: boolean;
  output?: Record<string, unknown>;
}

export interface DelegationLedgerHit {
  goal: string;
  result: DelegationLedgerResult;
}
