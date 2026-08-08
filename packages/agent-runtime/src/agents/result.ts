import type {
  RunAssessment,
  RunResult,
  UsageSnapshot,
} from "@sparkwright/core";
import type { AgentToolResult, DelegationLedgerResult } from "./types.js";

export interface ProjectAgentInvocationResultInput {
  childRunId: string;
  spanId: string;
  result: RunResult;
  usage: UsageSnapshot;
  output?: Record<string, unknown>;
}

/**
 * Canonical child-result projection used by delegate, parallel, dynamic-spawn,
 * task, lifecycle, and cache paths. Completion/finality and semantic health are
 * deliberately orthogonal: a complete child answer may still be failing.
 */
export function projectAgentInvocationResult(
  input: ProjectAgentInvocationResultInput,
): DelegationLedgerResult {
  const stepLimitReached = runResultStepLimitReached(input.result);
  const truncated = runResultTruncated(input.result) || stepLimitReached;
  const finality =
    input.result.signal === "completed" && !truncated ? "complete" : "partial";
  const assessment = childAssessment(input.result);
  const healthNote = assessmentNote(assessment);
  return {
    childRunId: input.childRunId,
    spanId: input.spanId,
    signal: input.result.signal,
    stopReason: input.result.stopReason,
    message: input.result.message,
    tokens: input.usage.tokens.total,
    costUsd: input.usage.costUsd,
    toolCalls: input.usage.toolCalls,
    modelCalls: input.usage.modelCalls,
    finality,
    assessment,
    ...(stepLimitReached ? { stepLimitReached: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(healthNote ? { note: healthNote } : {}),
    ...(input.output ? { output: input.output } : {}),
  };
}

export function childAssessment(result: RunResult): RunAssessment {
  return result.assessment;
}

export function assessmentNote(assessment: RunAssessment): string | undefined {
  if (assessment.health === "clean") return undefined;
  const codes = assessment.issues
    .map((issue) => issue.code)
    .filter((code, index, all) => all.indexOf(code) === index)
    .slice(0, 4);
  return `Child run completed with ${assessment.health} health${
    codes.length > 0 ? ` (${codes.join(", ")})` : ""
  }; preserve this caveat when using its result.`;
}

export function runResultStepLimitReached(result: RunResult): boolean {
  return (
    (result.metadata as { stepLimitReached?: unknown } | undefined)
      ?.stepLimitReached === true
  );
}

export function runResultTruncated(result: RunResult): boolean {
  return (
    (result.metadata as { truncated?: unknown } | undefined)?.truncated === true
  );
}

/** Canonical execution-finality check shared by aggregate and cache paths. */
export function isCompleteAgentResult(result: {
  signal: string;
  finality?: string;
  stepLimitReached?: boolean;
  truncated?: boolean;
}): boolean {
  return (
    result.signal === "completed" &&
    result.finality === "complete" &&
    result.stepLimitReached !== true &&
    result.truncated !== true
  );
}

/** Complete and clean is the only successful-result reuse state. */
export function isReusableAgentResult(
  result: Pick<
    DelegationLedgerResult,
    "signal" | "finality" | "stepLimitReached" | "truncated" | "assessment"
  >,
): boolean {
  return isCompleteAgentResult(result) && result.assessment.health === "clean";
}

export function isAgentToolResult(value: unknown): value is AgentToolResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<AgentToolResult>;
  return (
    typeof result.childRunId === "string" &&
    typeof result.spanId === "string" &&
    typeof result.signal === "string" &&
    (result.finality === "complete" || result.finality === "partial") &&
    typeof result.assessment === "object" &&
    result.assessment !== null
  );
}
