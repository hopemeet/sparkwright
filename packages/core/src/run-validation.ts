// Input/output validation and failure-reason selection for the run loop.
// Pure helpers extracted from run.ts: structural validation of a `ModelOutput`,
// `RunBudget` sanity checks, and the policy that maps a model-error category to
// a terminal `RunStopReason`.

import type {
  ModelErrorEnvelope,
  ModelOutput,
  RunBudget,
  RunStopReason,
} from "./types.js";
import { isRecord } from "./record-utils.js";

export function validateModelOutput(output: ModelOutput): string | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return "Model output must be an object.";
  }

  if (output.message !== undefined && typeof output.message !== "string") {
    return "Model output message must be a string when provided.";
  }

  if (output.toolCalls !== undefined) {
    if (!Array.isArray(output.toolCalls))
      return "Model output toolCalls must be an array when provided.";

    for (const [index, toolCall] of output.toolCalls.entries()) {
      if (
        typeof toolCall !== "object" ||
        toolCall === null ||
        Array.isArray(toolCall)
      ) {
        return `Model output toolCalls[${index}] must be an object.`;
      }

      if (
        typeof toolCall.toolName !== "string" ||
        toolCall.toolName.length === 0
      ) {
        return `Model output toolCalls[${index}].toolName must be a non-empty string.`;
      }

      if (!("arguments" in toolCall)) {
        return `Model output toolCalls[${index}].arguments is required.`;
      }
    }
  }

  if (output.usage !== undefined) {
    if (!isRecord(output.usage)) {
      return "Model output usage must be an object when provided.";
    }

    for (const key of [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "costUsd",
    ]) {
      const value = output.usage[key as keyof typeof output.usage];
      if (
        value !== undefined &&
        (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      ) {
        return `Model output usage.${key} must be a non-negative number when provided.`;
      }
    }
  }

  return undefined;
}

export function validateRunBudget(budget: RunBudget | undefined): void {
  if (!budget) return;

  validatePositiveIntegerBudget(budget.maxDurationMs, "maxDurationMs");
  validatePositiveIntegerBudget(budget.maxModelCalls, "maxModelCalls");
  validatePositiveIntegerBudget(budget.maxToolCalls, "maxToolCalls");
  validatePositiveIntegerBudget(budget.maxTokens, "maxTokens");

  if (
    budget.maxCostUsd !== undefined &&
    (typeof budget.maxCostUsd !== "number" ||
      !Number.isFinite(budget.maxCostUsd) ||
      budget.maxCostUsd <= 0)
  ) {
    throw new Error("runBudget.maxCostUsd must be a positive number.");
  }
}

function validatePositiveIntegerBudget(
  value: number | undefined,
  key: keyof Omit<RunBudget, "maxCostUsd">,
): void {
  if (value === undefined) return;

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`runBudget.${key} must be a positive integer.`);
  }
}

/**
 * Decide which RunStopReason to attach when a model completion failed.
 *
 * Policy (most-specific wins):
 *   - category "auth"    -> model_auth_failed       (bad/missing API key, 401/403)
 *   - category "quota"   -> model_quota_exhausted   (insufficient_quota / billing)
 *   - retryable && exhausted retry budget -> model_retry_exhausted
 *   - everything else    -> model_completion_failed
 *
 * Note: provider_unavailable (5xx) and rate_limited (429) are intentionally
 * mapped through the retryable-exhaustion path today, since the loop already
 * retries them. A dedicated `model_provider_unavailable` reason is reserved
 * for future use when a provider signals a terminal outage without retry.
 */
type ModelFailureStopReason = Extract<
  RunStopReason,
  | "model_completion_failed"
  | "model_retry_exhausted"
  | "model_auth_failed"
  | "model_quota_exhausted"
  | "model_provider_unavailable"
>;

export function selectModelFailureStopReason(input: {
  category: ModelErrorEnvelope["category"];
  retryable: boolean;
  exhausted: boolean;
}): ModelFailureStopReason {
  if (input.category === "auth") return "model_auth_failed";
  if (input.category === "quota") return "model_quota_exhausted";
  if (input.retryable && input.exhausted) return "model_retry_exhausted";
  return "model_completion_failed";
}
