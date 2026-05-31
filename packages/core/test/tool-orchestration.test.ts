import { describe, expect, it } from "vitest";
import {
  runToolBatchUpdates,
  type RequestedToolCall,
  type ToolCallBatch,
} from "../src/index.js";

describe("runToolBatchUpdates", () => {
  it("emits async tool execution updates in serial order", async () => {
    const calls: RequestedToolCall[] = [
      { toolName: "a", arguments: { n: 1 } },
      { toolName: "b", arguments: { n: 2 } },
    ];
    const batch: ToolCallBatch = { mode: "serial", calls };
    const updates: string[] = [];

    const generator = runToolBatchUpdates(
      batch,
      3,
      async (call) => call.toolName.toUpperCase(),
      { maxConcurrency: 2 },
    );

    let final: string[] | undefined;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        final = next.value;
        break;
      }
      updates.push(
        next.value.type === "tool_completed"
          ? `${next.value.type}:${next.value.callIndex}:${next.value.result}`
          : next.value.type,
      );
    }

    expect(updates).toEqual([
      "batch_started",
      "tool_completed:0:A",
      "tool_completed:1:B",
      "batch_completed",
    ]);
    expect(final).toEqual(["A", "B"]);
  });

  it("emits concurrent completions as tools finish while returning ordered results", async () => {
    const calls: RequestedToolCall[] = [
      { toolName: "slow", arguments: {} },
      { toolName: "fast", arguments: {} },
    ];
    const batch: ToolCallBatch = { mode: "concurrent", calls };
    const completed: string[] = [];

    const generator = runToolBatchUpdates(batch, 0, async (call) => {
      if (call.toolName === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return call.toolName;
    });

    let final: string[] | undefined;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        final = next.value;
        break;
      }
      if (next.value.type === "tool_completed") {
        completed.push(`${next.value.callIndex}:${next.value.result}`);
      }
    }

    expect(completed).toEqual(["1:fast", "0:slow"]);
    expect(final).toEqual(["slow", "fast"]);
  });
});
