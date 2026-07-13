import { describe, expect, it } from "vitest";
import { createRunBudgetAccount } from "../src/run-budget.js";

describe("RunBudgetAccount", () => {
  it("reserves model and tool calls without oversubscribing", () => {
    const account = createRunBudgetAccount({
      budget: { maxModelCalls: 1, maxToolCalls: 1 },
    });

    expect(account.checkModelCall()).toBeUndefined();
    account.commitModelCall();
    expect(account.checkModelCall()).toMatchObject({
      limit: "maxModelCalls",
      configured: 1,
      usage: { modelCalls: 1 },
    });
    expect(account.checkToolCall()).toBeUndefined();
    account.commitToolCall();
    expect(account.checkToolCall()).toMatchObject({
      limit: "maxToolCalls",
      configured: 1,
      usage: { toolCalls: 1 },
    });
  });

  it("accumulates provider usage and preserves seeded consumable counters", () => {
    const account = createRunBudgetAccount({
      budget: { maxTokens: 5, maxCostUsd: 0.5 },
      initialUsage: {
        elapsedMs: 100,
        modelCalls: 1,
        toolCalls: 2,
        tokens: 3,
        costUsd: 0.2,
      },
    });
    account.recordModelUsage({
      inputTokens: 2,
      outputTokens: 1,
      costUsd: 0.4,
    });

    const violation = account.checkUsage();
    expect(violation).toMatchObject({
      limit: "maxTokens",
      configured: 5,
      usage: {
        modelCalls: 1,
        toolCalls: 2,
        tokens: 6,
      },
    });
    expect(violation?.usage.costUsd).toBeCloseTo(0.6);
    expect(violation?.usage.elapsedMs).toBe(0);
  });

  it("starts shared duration once and reports elapsed violations", () => {
    let now = 1_000;
    const account = createRunBudgetAccount({
      budget: { maxDurationMs: 10 },
      now: () => now,
    });
    account.markStarted();
    now = 1_005;
    account.markStarted();
    now = 1_011;

    expect(account.checkUsage()).toMatchObject({
      limit: "maxDurationMs",
      usage: { elapsedMs: 11 },
    });
  });
});
