import { describe, expect, it } from "vitest";
import { EventLog } from "../src/events.js";
import { wrapPromptBuilderWithCacheBreakDetector } from "../src/cache-break.js";
import { createRunId } from "../src/ids.js";
import type {
  PromptBuilder,
  PromptBuildInput,
  PromptMessage,
} from "../src/context.js";
import type { RunRecord } from "../src/types.js";

function makeInput(
  runId: ReturnType<typeof createRunId>,
  step: number,
): PromptBuildInput {
  return {
    run: { id: runId } as RunRecord,
    step,
    tools: [],
    context: [],
  };
}

function builderFor(scripts: PromptMessage[][]): PromptBuilder {
  let cursor = 0;
  return {
    build(): PromptMessage[] {
      const out = scripts[cursor] ?? scripts[scripts.length - 1];
      cursor += 1;
      return out!;
    },
  };
}

describe("wrapPromptBuilderWithCacheBreakDetector", () => {
  it("emits when a stable prefix message changes", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const inner = builderFor([
      [{ role: "system", content: "v1", stability: "stable" }],
      [{ role: "system", content: "v2", stability: "stable" }],
    ]);
    const wrapped = wrapPromptBuilderWithCacheBreakDetector(inner, { events });

    await wrapped.build(makeInput(runId, 0));
    await wrapped.build(makeInput(runId, 1));

    const breaks = events
      .all()
      .filter((entry) => entry.type === "context.cache_break.detected");
    expect(breaks).toHaveLength(1);
    expect((breaks[0]?.payload as { prefixIndex: number }).prefixIndex).toBe(0);
  });

  it("stays silent when the stable prefix is identical across turns", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const inner = builderFor([
      [
        { role: "system", content: "fixed", stability: "stable" },
        { role: "user", content: "turn-1", stability: "turn" },
      ],
      [
        { role: "system", content: "fixed", stability: "stable" },
        { role: "user", content: "turn-2", stability: "turn" },
      ],
    ]);
    const wrapped = wrapPromptBuilderWithCacheBreakDetector(inner, { events });

    await wrapped.build(makeInput(runId, 0));
    await wrapped.build(makeInput(runId, 1));

    expect(
      events
        .all()
        .filter((entry) => entry.type === "context.cache_break.detected"),
    ).toHaveLength(0);
  });

  it("excludes turn and volatile messages from the stable prefix", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const inner = builderFor([
      [
        { role: "system", content: "resident-v1", stability: "stable" },
        { role: "system", content: "tools-v1", stability: "stable" },
        {
          role: "user",
          content: "runtime-v1",
          stability: "turn",
          metadata: { cachePolicy: "volatile" },
        },
        { role: "system", content: "late-stable-v1", stability: "stable" },
      ],
      [
        { role: "system", content: "resident-v1", stability: "stable" },
        { role: "system", content: "tools-v1", stability: "stable" },
        {
          role: "user",
          content: "runtime-v2",
          stability: "turn",
          metadata: { cachePolicy: "volatile" },
        },
        { role: "system", content: "late-stable-v2", stability: "stable" },
      ],
      [
        { role: "system", content: "resident-v2", stability: "stable" },
        { role: "system", content: "tools-v1", stability: "stable" },
        {
          role: "user",
          content: "runtime-v3",
          stability: "turn",
          metadata: { cachePolicy: "volatile" },
        },
      ],
    ]);
    const wrapped = wrapPromptBuilderWithCacheBreakDetector(inner, { events });

    await wrapped.build(makeInput(runId, 0));
    await wrapped.build(makeInput(runId, 1));

    expect(
      events
        .all()
        .filter((entry) => entry.type === "context.cache_break.detected"),
    ).toHaveLength(0);

    await wrapped.build(makeInput(runId, 2));

    const breaks = events
      .all()
      .filter((entry) => entry.type === "context.cache_break.detected");
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.payload).toMatchObject({
      step: 2,
      prefixIndex: 0,
      role: "system",
    });
  });

  it("respects maxReports", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const inner = builderFor([
      [{ role: "system", content: "a", stability: "stable" }],
      [{ role: "system", content: "b", stability: "stable" }],
      [{ role: "system", content: "c", stability: "stable" }],
      [{ role: "system", content: "d", stability: "stable" }],
    ]);
    const wrapped = wrapPromptBuilderWithCacheBreakDetector(inner, {
      events,
      maxReports: 1,
    });
    await wrapped.build(makeInput(runId, 0));
    await wrapped.build(makeInput(runId, 1));
    await wrapped.build(makeInput(runId, 2));
    await wrapped.build(makeInput(runId, 3));

    expect(
      events
        .all()
        .filter((entry) => entry.type === "context.cache_break.detected"),
    ).toHaveLength(1);
  });
});
