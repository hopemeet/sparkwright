import { describe, expect, it, vi } from "vitest";
import {
  combineRunHooks,
  createDynamicHookSet,
  type RunHook,
} from "../src/hooks.js";
import { createRunId, createToolCallId } from "../src/ids.js";

const ctx = { runId: createRunId(), step: 1 };

describe("combineRunHooks", () => {
  it("runs hooks in order and short-circuits on first skip decision", async () => {
    const order: string[] = [];
    const a: RunHook = {
      name: "a",
      beforeToolCall: async () => {
        order.push("a");
        return undefined;
      },
    };
    const b: RunHook = {
      name: "b",
      beforeToolCall: async () => {
        order.push("b");
        return { skip: { reason: "denied by b" } };
      },
    };
    const c: RunHook = {
      name: "c",
      beforeToolCall: async () => {
        order.push("c");
        return undefined;
      },
    };

    const combined = combineRunHooks([a, b, c]);
    const decision = await combined.beforeToolCall!({
      ...ctx,
      toolName: "fs.write",
      arguments: {},
    });

    expect(order).toEqual(["a", "b"]);
    expect(decision?.skip?.reason).toBe("denied by b");
  });

  it("swallows and warns when a hook throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad: RunHook = {
      name: "explody",
      afterToolCall: () => {
        throw new Error("boom");
      },
    };
    const combined = combineRunHooks([bad]);

    await combined.afterToolCall!({
      ...ctx,
      toolName: "fs.read",
      arguments: {},
      result: {
        toolCallId: createToolCallId(),
        status: "completed",
        artifacts: [],
      },
    });

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("fans onEvent to every hook synchronously", () => {
    const seen: string[] = [];
    const combined = combineRunHooks([
      { name: "1", onEvent: (i) => seen.push(`1:${i.event.type}`) },
      { name: "2", onEvent: (i) => seen.push(`2:${i.event.type}`) },
    ]);

    combined.onEvent!({
      event: {
        id: "evt_1" as never,
        runId: ctx.runId,
        type: "run.started",
        timestamp: new Date().toISOString(),
        sequence: 1,
        payload: {},
        metadata: {},
      },
    });

    expect(seen).toEqual(["1:run.started", "2:run.started"]);
  });
});

describe("createDynamicHookSet", () => {
  it("re-reads the hook list on every phase so mid-run additions take effect", async () => {
    const order: string[] = [];
    const list: RunHook[] = [];
    const set = createDynamicHookSet(() => list);

    await set.beforeToolCall!({
      ...ctx,
      toolName: "fs.read",
      arguments: {},
    });
    expect(order).toEqual([]);

    list.push({
      name: "added",
      beforeToolCall: () => {
        order.push("added");
        return undefined;
      },
    });

    await set.beforeToolCall!({
      ...ctx,
      toolName: "fs.read",
      arguments: {},
    });
    expect(order).toEqual(["added"]);

    list.length = 0;
    await set.beforeToolCall!({
      ...ctx,
      toolName: "fs.read",
      arguments: {},
    });
    expect(order).toEqual(["added"]);
  });
});
