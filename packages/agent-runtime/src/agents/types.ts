import type { RunResult, UsageSnapshot } from "@sparkwright/core";

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
