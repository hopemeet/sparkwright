import type { ModelUsage, RunBudget, RunBudgetUsage } from "./types.js";
import { validateRunBudget } from "./run-validation.js";

export type RunBudgetLimit =
  | "maxDurationMs"
  | "maxModelCalls"
  | "maxToolCalls"
  | "maxTokens"
  | "maxCostUsd";

export interface RunBudgetViolation {
  limit: RunBudgetLimit;
  configured: number;
  budget: RunBudget;
  usage: RunBudgetUsage;
}

/**
 * Mutable, synchronous work-budget account. A run owns one local account and
 * may also consume ancestor-owned accounts shared by its sibling subtree.
 *
 * @internal Exposed only so orchestration substrates can pass the opaque
 * account from a parent RunHandle into child CreateRunOptions.
 */
export interface RunBudgetAccount {
  readonly budget?: RunBudget;
  markStarted(): void;
  checkModelCall(): RunBudgetViolation | undefined;
  commitModelCall(): void;
  checkToolCall(): RunBudgetViolation | undefined;
  commitToolCall(): void;
  recordModelUsage(usage: ModelUsage | undefined): void;
  checkUsage(): RunBudgetViolation | undefined;
  snapshot(): RunBudgetUsage;
}

export function createRunBudgetAccount(input: {
  budget?: RunBudget;
  /**
   * Restores consumable counters. `elapsedMs` intentionally starts from zero
   * when `markStarted()` is next called, matching run checkpoint/resume's
   * established active-execution-segment duration semantics.
   */
  initialUsage?: RunBudgetUsage;
  now?: () => number;
}): RunBudgetAccount {
  validateRunBudget(input.budget);
  const budget = input.budget ? { ...input.budget } : undefined;
  const now = input.now ?? Date.now;
  let startedAtMs: number | undefined;
  const usage = {
    modelCalls: input.initialUsage?.modelCalls ?? 0,
    toolCalls: input.initialUsage?.toolCalls ?? 0,
    tokens: input.initialUsage?.tokens ?? 0,
    costUsd: input.initialUsage?.costUsd ?? 0,
  };

  const snapshot = (): RunBudgetUsage => ({
    elapsedMs: startedAtMs === undefined ? 0 : Math.max(0, now() - startedAtMs),
    ...usage,
  });

  return {
    budget,
    markStarted() {
      startedAtMs ??= now();
    },
    checkModelCall() {
      if (
        budget?.maxModelCalls !== undefined &&
        usage.modelCalls >= budget.maxModelCalls
      ) {
        return violation(
          "maxModelCalls",
          budget.maxModelCalls,
          budget,
          snapshot(),
        );
      }
      return undefined;
    },
    commitModelCall() {
      usage.modelCalls += 1;
    },
    checkToolCall() {
      if (
        budget?.maxToolCalls !== undefined &&
        usage.toolCalls >= budget.maxToolCalls
      ) {
        return violation(
          "maxToolCalls",
          budget.maxToolCalls,
          budget,
          snapshot(),
        );
      }
      return undefined;
    },
    commitToolCall() {
      usage.toolCalls += 1;
    },
    recordModelUsage(modelUsage) {
      if (!modelUsage) return;
      usage.tokens +=
        modelUsage.totalTokens ??
        (modelUsage.inputTokens ?? 0) + (modelUsage.outputTokens ?? 0);
      usage.costUsd += modelUsage.costUsd ?? 0;
    },
    checkUsage() {
      if (!budget) return undefined;
      const current = snapshot();
      if (
        budget.maxDurationMs !== undefined &&
        current.elapsedMs > budget.maxDurationMs
      ) {
        return violation(
          "maxDurationMs",
          budget.maxDurationMs,
          budget,
          current,
        );
      }
      if (budget.maxTokens !== undefined && current.tokens > budget.maxTokens) {
        return violation("maxTokens", budget.maxTokens, budget, current);
      }
      if (
        budget.maxCostUsd !== undefined &&
        current.costUsd > budget.maxCostUsd
      ) {
        return violation("maxCostUsd", budget.maxCostUsd, budget, current);
      }
      return undefined;
    },
    snapshot,
  };
}

function violation(
  limit: RunBudgetLimit,
  configured: number,
  budget: RunBudget,
  usage: RunBudgetUsage,
): RunBudgetViolation {
  return { limit, configured, budget, usage };
}
