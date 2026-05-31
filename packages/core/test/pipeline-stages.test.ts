import { describe, expect, it } from "vitest";
import {
  createToolResultBudgetStage,
  createSnipStage,
  createDefaultCompactionStages,
  gateStageByUsage,
  usageMeetsGate,
  type CompactionStage,
} from "../src/pipeline.js";
import type { ContextUsageHint } from "../src/context.js";
import type { ContextItem } from "../src/types.js";
import { createContextItemId } from "../src/ids.js";

function item(
  type: ContextItem["type"],
  content: string,
  step = 0,
): ContextItem {
  return {
    id: createContextItemId(),
    type,
    source: { kind: type === "tool_result" ? "tool" : "system" },
    content,
    metadata: { layer: "working", stability: "turn", step },
  };
}

describe("createToolResultBudgetStage", () => {
  it("truncates oversize tool_result items", async () => {
    const stage = createToolResultBudgetStage({ maxCharsPerItem: 20 });
    const big = item("tool_result", "x".repeat(200));
    const small = item("tool_result", "ok");
    const memory = item("file", "x".repeat(500));

    const should = await stage.shouldRun({
      items: [big, small, memory],
      hints: {} as never,
      totalChars: 700,
      reactive: false,
    });
    expect(should).toBe(true);

    const result = await stage.apply({
      items: [big, small, memory],
      hints: {} as never,
      totalChars: 700,
      reactive: false,
    });
    const truncated = result.items.find((i) => i.id === big.id);
    expect(truncated?.content.length).toBeLessThan(200);
    expect(truncated?.content).toMatch(/truncated/);
    // small and memory left untouched
    expect(result.items.find((i) => i.id === small.id)?.content).toBe("ok");
    expect(result.items.find((i) => i.id === memory.id)?.content.length).toBe(
      500,
    );
  });

  it("is a no-op when nothing exceeds the budget", async () => {
    const stage = createToolResultBudgetStage({ maxCharsPerItem: 100 });
    const small = item("tool_result", "ok");
    const should = await stage.shouldRun({
      items: [small],
      hints: {} as never,
      totalChars: 2,
      reactive: false,
    });
    expect(should).toBe(false);
  });
});

describe("createSnipStage", () => {
  it("drops the middle when the trigger threshold is crossed", async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      item("file", `block-${i}-${"x".repeat(50)}`, i),
    );
    const stage = createSnipStage({
      triggerChars: 100,
      keepHead: 2,
      keepTail: 2,
    });
    const total = items.reduce((sum, entry) => sum + entry.content.length, 0);
    const should = await stage.shouldRun({
      items,
      hints: {} as never,
      totalChars: total,
      reactive: false,
    });
    expect(should).toBe(true);

    const result = await stage.apply({
      items,
      hints: {} as never,
      totalChars: total,
      reactive: false,
    });
    // 2 head + 1 marker + 2 tail
    expect(result.items).toHaveLength(5);
    expect(result.items[2]?.type).toBe("summary");
    expect(result.items[2]?.content).toMatch(/snipped/);
    expect(result.freedChars).toBeGreaterThan(0);
  });

  it("does not run when there aren't enough items to snip", async () => {
    const stage = createSnipStage({
      triggerChars: 10,
      keepHead: 2,
      keepTail: 2,
    });
    const items = [item("file", "a"), item("file", "b"), item("file", "c")];
    const should = await stage.shouldRun({
      items,
      hints: {} as never,
      totalChars: 3,
      reactive: false,
    });
    expect(should).toBe(false);
  });
});

describe("createDefaultCompactionStages", () => {
  it("layers the tool-result budget before the snip", () => {
    const stages = createDefaultCompactionStages();
    expect(stages.map((s) => s.trigger)).toEqual([
      "tool_result_budget",
      "snip",
    ]);
  });

  it("stays inert on small contexts (cache-stable prefix preserved)", async () => {
    const [budget, snip] = createDefaultCompactionStages();
    const input = {
      items: [item("tool_result", "ok"), item("file", "small")],
      hints: {} as never,
      totalChars: 7,
      reactive: false,
    };
    expect(await budget.shouldRun(input)).toBe(false);
    expect(await snip.shouldRun(input)).toBe(false);
  });

  it("honors custom thresholds", async () => {
    const [budget] = createDefaultCompactionStages({ maxCharsPerItem: 10 });
    const input = {
      items: [item("tool_result", "x".repeat(50))],
      hints: {} as never,
      totalChars: 50,
      reactive: false,
    };
    expect(await budget.shouldRun(input)).toBe(true);
  });
});

describe("usageMeetsGate", () => {
  const usage: ContextUsageHint = {
    inputTokens: 8000,
    outputTokens: 2000,
    totalTokens: 10000,
    costUsd: 0.5,
    modelCalls: 4,
    lastInputTokens: 8000,
    contextWindowPressure: 0.8,
  };

  it("returns false when usage is absent (conservative default)", () => {
    expect(usageMeetsGate(undefined, { minCostUsd: 0.1 })).toBe(false);
  });

  it("opens only when every supplied threshold is met (AND)", () => {
    expect(
      usageMeetsGate(usage, { minCostUsd: 0.4, minContextWindowPressure: 0.7 }),
    ).toBe(true);
    // cost ok but pressure too high a bar => closed
    expect(usageMeetsGate(usage, { minContextWindowPressure: 0.95 })).toBe(
      false,
    );
    // tokens bar not met => closed
    expect(usageMeetsGate(usage, { minTotalTokens: 20000 })).toBe(false);
  });

  it("treats missing contextWindowPressure as 0", () => {
    const noPressure: ContextUsageHint = {
      ...usage,
      contextWindowPressure: undefined,
    };
    expect(usageMeetsGate(noPressure, { minContextWindowPressure: 0.1 })).toBe(
      false,
    );
  });
});

describe("gateStageByUsage", () => {
  function spyStage(): CompactionStage & { ran: () => number } {
    let applyCount = 0;
    const stage: CompactionStage = {
      name: "spy",
      trigger: "auto",
      shouldRun: () => true,
      apply: (input) => {
        applyCount += 1;
        return { items: input.items, freedChars: 0 };
      },
    };
    return Object.assign(stage, { ran: () => applyCount });
  }

  const hint = (pressure: number): ContextUsageHint => ({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    modelCalls: 1,
    contextWindowPressure: pressure,
  });

  it("blocks the wrapped stage until pressure clears the threshold", async () => {
    const inner = spyStage();
    const gated = gateStageByUsage(inner, { minContextWindowPressure: 0.8 });

    const below = await gated.shouldRun({
      items: [],
      hints: { usage: hint(0.5) },
      totalChars: 0,
      reactive: false,
    });
    expect(below).toBe(false);

    const above = await gated.shouldRun({
      items: [],
      hints: { usage: hint(0.9) },
      totalChars: 0,
      reactive: false,
    });
    expect(above).toBe(true);
  });

  it("bypasses the gate under reactive overflow recovery", async () => {
    const inner = spyStage();
    const gated = gateStageByUsage(inner, { minContextWindowPressure: 0.99 });
    const should = await gated.shouldRun({
      items: [],
      hints: { usage: hint(0.1) },
      totalChars: 0,
      reactive: true,
    });
    expect(should).toBe(true);
  });

  it("delegates apply unchanged to the wrapped stage", async () => {
    const inner = spyStage();
    const gated = gateStageByUsage(inner, { minCostUsd: 1 });
    await gated.apply({
      items: [],
      hints: {},
      totalChars: 0,
      reactive: false,
    });
    expect(inner.ran()).toBe(1);
  });
});
