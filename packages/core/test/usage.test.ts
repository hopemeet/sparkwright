import { describe, expect, it } from "vitest";
import {
  createUsageTracker,
  createSessionUsageAccumulator,
} from "../src/usage.js";
import { EventLog } from "../src/events.js";
import { createRunId } from "../src/ids.js";

describe("UsageTracker", () => {
  it("aggregates tokens, model calls, and tool calls", () => {
    const tracker = createUsageTracker({
      runId: createRunId(),
      now: createFakeClock([0, 100, 200, 300]),
    });
    tracker.markStarted();
    tracker.recordModelUsage({
      adapterId: "provider:model-a",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 80,
        costUsd: 0.01,
      },
    });
    tracker.recordToolUsage({ toolName: "fs.read", status: "completed" });
    tracker.recordToolUsage({ toolName: "fs.read", status: "failed" });

    const snap = tracker.snapshot();
    expect(snap.modelCalls).toBe(1);
    expect(snap.toolCalls).toBe(2);
    expect(snap.tokens).toEqual({
      input: 100,
      output: 50,
      total: 150,
      cached: 80,
    });
    expect(snap.contextTokens).toBe(100);
    expect(snap.costUsd).toBeCloseTo(0.01);
    expect(snap.byTool["fs.read"]).toEqual({ calls: 2, failures: 1 });
    expect(snap.byModel["provider:model-a"]?.calls).toBe(1);
    expect(snap.wallTimeMs).toBeGreaterThan(0);
  });

  it("tracks contextTokens as the latest call's input, not the sum", () => {
    const tracker = createUsageTracker({ runId: createRunId() });
    tracker.markStarted();
    tracker.recordModelUsage({
      usage: { inputTokens: 1000, outputTokens: 10 },
    });
    tracker.recordModelUsage({
      usage: { inputTokens: 1500, outputTokens: 20 },
    });

    const snap = tracker.snapshot();
    expect(snap.tokens.input).toBe(2500); // summed (billed)
    expect(snap.contextTokens).toBe(1500); // latest call only (live context)
  });

  it("tracks unavailable and partial model cost status", () => {
    const tracker = createUsageTracker({ runId: createRunId() });
    tracker.recordModelUsage({
      adapterId: "provider:unknown",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        costStatus: "unavailable",
        costUnavailableReason: "missing_pricing",
      },
    });

    let snap = tracker.snapshot();
    expect(snap.costUsd).toBe(0);
    expect(snap.costStatus).toBe("unavailable");
    expect(snap.costUnavailableReasons).toEqual({ missing_pricing: 1 });
    expect(snap.byModel["provider:unknown"]).toMatchObject({
      costStatus: "unavailable",
      costUnavailableReasons: { missing_pricing: 1 },
    });

    tracker.recordModelUsage({
      adapterId: "provider:priced",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0.01,
        costStatus: "estimated",
      },
    });

    snap = tracker.snapshot();
    expect(snap.costUsd).toBeCloseTo(0.01);
    expect(snap.costStatus).toBe("partial");
    expect(snap.costUnavailableReasons).toEqual({ missing_pricing: 1 });
    expect(snap.byModel["provider:priced"]).toMatchObject({
      costStatus: "estimated",
    });
  });

  it("explains unavailable cost when the provider returns no usage", () => {
    const tracker = createUsageTracker({ runId: createRunId() });

    tracker.recordModelUsage({
      adapterId: "provider:no-usage",
      usage: undefined,
    });

    const snap = tracker.snapshot();
    expect(snap.modelCalls).toBe(1);
    expect(snap.tokens.total).toBe(0);
    expect(snap.costStatus).toBe("unavailable");
    expect(snap.costUnavailableReasons).toEqual({ usage_not_reported: 1 });
    expect(snap.byModel["provider:no-usage"]).toMatchObject({
      calls: 1,
      costStatus: "unavailable",
      costUnavailableReasons: { usage_not_reported: 1 },
    });
  });

  it("emits usage.updated events through the supplied emitter", () => {
    const emitter = new EventLog(createRunId());
    const seen: string[] = [];
    emitter.subscribe((e) => seen.push(e.type));
    const tracker = createUsageTracker({
      runId: createRunId(),
      emitter,
    });

    tracker.markStarted();
    tracker.recordModelUsage({
      adapterId: "x",
      usage: { totalTokens: 10 },
    });

    const usageEvents = seen.filter((t) => t === "usage.updated");
    expect(usageEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("notifies subscribers and supports unsubscribe", () => {
    const tracker = createUsageTracker({ runId: createRunId() });
    let count = 0;
    const off = tracker.subscribe(() => {
      count += 1;
    });
    tracker.markStarted();
    tracker.recordToolUsage({ toolName: "t", status: "completed" });
    off();
    tracker.recordToolUsage({ toolName: "t", status: "completed" });

    expect(count).toBe(2);
  });
});

describe("createSessionUsageAccumulator", () => {
  it("sums tokens/calls/cost across runs without double-counting a run's snapshots", () => {
    const acc = createSessionUsageAccumulator();
    const runA = createRunId();

    // Run A emits two snapshots (running totals); only the latest counts.
    acc.fold({
      ...baseSnap(runA),
      modelCalls: 1,
      toolCalls: 1,
      tokens: t(1000, 10, 800),
    });
    const afterA = acc.fold({
      ...baseSnap(runA),
      modelCalls: 2,
      toolCalls: 1,
      contextTokens: 1500,
      tokens: t(2500, 30, 1800),
    });
    expect(afterA.runCount).toBe(1);
    expect(afterA.tokens.input).toBe(2500);
    expect(afterA.modelCalls).toBe(2);
    expect(afterA.contextTokens).toBe(1500);

    // Run B (a second turn) adds to the session totals.
    const runB = createRunId();
    const afterB = acc.fold({
      ...baseSnap(runB),
      modelCalls: 1,
      toolCalls: 2,
      contextTokens: 600,
      tokens: t(700, 40, 500),
      costUsd: 0.02,
    });
    expect(afterB.runCount).toBe(2);
    expect(afterB.tokens.input).toBe(3200);
    expect(afterB.tokens.cached).toBe(2300);
    expect(afterB.modelCalls).toBe(3);
    expect(afterB.toolCalls).toBe(3);
    expect(afterB.contextTokens).toBe(600); // latest run's live context
    expect(afterB.costUsd).toBeCloseTo(0.02);
  });
});

function baseSnap(runId: ReturnType<typeof createRunId>) {
  return {
    runId,
    updatedAt: new Date(0).toISOString(),
    wallTimeMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    contextTokens: 0,
    tokens: t(0, 0, 0),
    costUsd: 0,
    byTool: {},
    byModel: {},
  };
}

function t(input: number, output: number, cached: number) {
  return { input, output, total: input + output, cached };
}

function createFakeClock(values: number[]): () => number {
  let idx = 0;
  return () => {
    const v = values[Math.min(idx, values.length - 1)]!;
    idx += 1;
    return v;
  };
}
