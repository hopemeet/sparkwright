import { describe, expect, it } from "vitest";
import {
  createClearToolUsesStage,
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

describe("createClearToolUsesStage", () => {
  it("replaces older tool results with stable placeholders", async () => {
    const old = {
      ...item("tool_result", "old output".repeat(100)),
      source: { kind: "tool", uri: "read" },
      metadata: {
        layer: "working",
        stability: "turn",
        toolName: "read",
        status: "completed",
        toolCallId: "call_old",
      },
    } satisfies ContextItem;
    const recent = {
      ...item("tool_result", "recent output"),
      source: { kind: "tool", uri: "shell" },
      metadata: {
        layer: "working",
        stability: "turn",
        toolName: "bash",
        status: "completed",
        toolCallId: "call_recent",
      },
    } satisfies ContextItem;
    const stage = createClearToolUsesStage({ triggerChars: 0, keepRecent: 1 });
    const input = {
      items: [old, recent],
      hints: {} as never,
      totalChars: old.content.length + recent.content.length,
      reactive: false,
    };

    expect(await stage.shouldRun(input)).toBe(true);
    const result = await stage.apply(input);

    expect(result.items[0]?.id).toBe(old.id);
    expect(result.items[0]?.content).toContain(
      "tool result cleared by clear_tool_uses",
    );
    expect(result.items[0]?.content).toContain("tool=read");
    expect(result.items[0]?.metadata.clearToolUsesCleared).toBe(true);
    expect(result.items[1]?.content).toBe(recent.content);
    expect(result.freedChars).toBeGreaterThan(0);
  });

  it("honors clearAtLeastChars and excluded tools", async () => {
    const configRead = {
      ...item("tool_result", "config".repeat(200)),
      source: { kind: "tool", uri: "read_config" },
      metadata: {
        layer: "working",
        stability: "turn",
        toolName: "read_config",
      },
    } satisfies ContextItem;
    const old = {
      ...item("tool_result", "old".repeat(100)),
      source: { kind: "tool", uri: "grep" },
      metadata: { layer: "working", stability: "turn", toolName: "grep" },
    } satisfies ContextItem;
    const recent = item("tool_result", "recent");
    const stage = createClearToolUsesStage({
      triggerChars: 0,
      keepRecent: 1,
      clearAtLeastChars: 10_000,
      excludeTools: ["read_config"],
    });
    const input = {
      items: [configRead, old, recent],
      hints: {} as never,
      totalChars: configRead.content.length + old.content.length + 6,
      reactive: false,
    };

    expect(await stage.shouldRun(input)).toBe(false);
    const result = await stage.apply(input);
    expect(result.items).toEqual(input.items);
    expect(result.metadata).toMatchObject({
      skipped: true,
      potentialFreedChars: expect.any(Number),
    });
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
  it("layers deterministic stages from local edits to coarse snip", () => {
    const stages = createDefaultCompactionStages();
    expect(stages.map((s) => s.trigger)).toEqual([
      "tool_result_budget",
      "micro",
      "micro",
      "clear_tool_uses",
      "snip",
    ]);
  });

  it("stays inert on small contexts (cache-stable prefix preserved)", async () => {
    const [budget, fileDedup, observationOneLine, clearToolUses, snip] =
      createDefaultCompactionStages();
    const input = {
      items: [item("tool_result", "ok"), item("file", "small")],
      hints: {} as never,
      totalChars: 7,
      reactive: false,
    };
    expect(await budget.shouldRun(input)).toBe(false);
    expect(await fileDedup.shouldRun(input)).toBe(false);
    expect(await observationOneLine.shouldRun(input)).toBe(false);
    expect(await clearToolUses.shouldRun(input)).toBe(false);
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

  it("can disable deterministic micro stages for strict legacy behavior", () => {
    const stages = createDefaultCompactionStages({
      fileReadDedup: false,
      observationOneLine: false,
      clearToolUses: false,
    });
    expect(stages.map((s) => s.trigger)).toEqual([
      "tool_result_budget",
      "snip",
    ]);
  });

  it("micro-compacts repeated file reads before coarse snip is needed", async () => {
    const [, fileDedup, observationOneLine, clearToolUses, snip] =
      createDefaultCompactionStages({
        triggerChars: 100_000,
        observationKeepRecent: 1,
        observationMinCharsToCollapse: 2_000,
      });
    const firstRead = {
      ...item("tool_result", "a".repeat(500)),
      source: { kind: "tool", path: "README.md" },
      metadata: { layer: "working", stability: "turn", filePath: "README.md" },
    } satisfies ContextItem;
    const latestRead = {
      ...item("tool_result", "b".repeat(500)),
      source: { kind: "tool", path: "README.md" },
      metadata: { layer: "working", stability: "turn", filePath: "README.md" },
    } satisfies ContextItem;
    const input = {
      items: [firstRead, latestRead],
      hints: {} as never,
      totalChars: 1_000,
      reactive: false,
    };

    expect(await fileDedup.shouldRun(input)).toBe(true);
    expect(await observationOneLine.shouldRun(input)).toBe(false);
    expect(await clearToolUses.shouldRun(input)).toBe(false);
    expect(await snip.shouldRun(input)).toBe(false);

    const result = await fileDedup.apply(input);
    expect(result.items[0]?.content).toContain("superseded by later read");
    expect(result.items[1]?.content).toBe(latestRead.content);
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
      tier: "summarize",
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
