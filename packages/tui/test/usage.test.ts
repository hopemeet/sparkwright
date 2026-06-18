import { describe, expect, it } from "vitest";
import { EventStore } from "../src/state/event-store.js";
import type { RunEvent } from "../src/lib/event-type.js";

function ev(type: string, payload: unknown, sequence = 1): RunEvent {
  return { type, payload, sequence, id: `e${sequence}` } as unknown as RunEvent;
}

describe("EventStore usage parsing", () => {
  it("reads the host UsageSnapshot shape (tokens.{input,output,total,cached} + ctx + costUsd)", () => {
    const store = new EventStore();
    store.appendEvent(
      ev("usage.updated", {
        runId: "r1",
        contextTokens: 150,
        tokens: { input: 120, output: 80, total: 200, cached: 90 },
        costUsd: 0.0123,
        modelCalls: 2,
        toolCalls: 3,
      }),
    );
    const u = store.getSnapshot().usage;
    expect(u).toMatchObject({
      contextTokens: 150,
      inputTokens: 120,
      outputTokens: 80,
      totalTokens: 200,
      cachedTokens: 90,
      estimatedCostUsd: 0.0123,
      modelCalls: 2,
      toolCalls: 3,
    });
  });

  it("derives total from input+output when the snapshot omits it", () => {
    const store = new EventStore();
    store.appendEvent(
      ev("usage.updated", { tokens: { input: 10, output: 5 } }),
    );
    expect(store.getSnapshot().usage?.totalTokens).toBe(15);
  });

  it("still accepts the legacy nested {usage:{inputTokens,…}} shape", () => {
    const store = new EventStore();
    store.appendEvent(
      ev("usage.updated", {
        usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.5 },
      }),
    );
    expect(store.getSnapshot().usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      estimatedCostUsd: 0.5,
    });
  });

  it("replaces a run's snapshot with its latest cumulative one (same runId)", () => {
    const store = new EventStore();
    store.appendEvent(
      ev("usage.updated", {
        runId: "r1",
        tokens: { input: 1, output: 1, total: 2 },
        modelCalls: 1,
      }),
    );
    store.appendEvent(
      ev("usage.updated", {
        runId: "r1",
        tokens: { input: 5, output: 5, total: 10 },
        modelCalls: 2,
      }),
    );
    const u = store.getSnapshot().usage;
    // Latest snapshot for the run wins — not summed with the earlier one.
    expect(u?.inputTokens).toBe(5);
    expect(u?.totalTokens).toBe(10);
    expect(u?.modelCalls).toBe(2);
  });

  it("sums across runs/turns and takes ctx from the latest run", () => {
    const store = new EventStore();
    store.appendEvent(
      ev("usage.updated", {
        runId: "r1",
        contextTokens: 1500,
        tokens: { input: 2500, output: 30, total: 2530, cached: 1800 },
        costUsd: 0.01,
        modelCalls: 2,
        toolCalls: 1,
      }),
    );
    store.appendEvent(
      ev("usage.updated", {
        runId: "r2",
        contextTokens: 600,
        tokens: { input: 700, output: 40, total: 740, cached: 500 },
        costUsd: 0.02,
        modelCalls: 1,
        toolCalls: 2,
      }),
    );
    const u = store.getSnapshot().usage;
    expect(u?.inputTokens).toBe(3200); // session sum
    expect(u?.cachedTokens).toBe(2300);
    expect(u?.modelCalls).toBe(3);
    expect(u?.toolCalls).toBe(3);
    expect(u?.contextTokens).toBe(600); // latest run only
    expect(u?.estimatedCostUsd).toBeCloseTo(0.03);
  });

  it("ignores an all-empty usage payload (no phantom zeroed summary)", () => {
    const store = new EventStore();
    store.appendEvent(ev("usage.updated", { runId: "r1" }));
    expect(store.getSnapshot().usage).toBeNull();
  });
});

describe("EventStore reasoning accumulation", () => {
  it("collects reasoning deltas and clears them when the stream completes", () => {
    const store = new EventStore();
    store.appendEvent(ev("model.stream.started", {}, 1));
    store.appendEvent(
      ev("model.stream.chunk", { type: "reasoning", text: "let me " }, 2),
    );
    store.appendEvent(
      ev("model.stream.chunk", { type: "reasoning_delta", text: "think" }, 3),
    );
    expect(store.getSnapshot().reasoningText).toBe("let me think");
    store.appendEvent(
      ev("model.stream.chunk", { type: "text_delta", text: "answer" }, 4),
    );
    expect(store.getSnapshot().streamingText).toBe("answer");
    store.appendEvent(ev("model.stream.completed", {}, 5));
    expect(store.getSnapshot().reasoningText).toBe("");
    expect(store.getSnapshot().streamingText).toBe("");
  });
});

describe("EventStore todo ledger projection", () => {
  it("commits a todo proposal only after todo_write completes successfully", () => {
    const store = new EventStore();
    store.appendEvent(
      ev(
        "tool.requested",
        {
          id: "call_1",
          toolName: "todo_write",
          arguments: {
            items: [
              { title: "Inspect trace", status: "in_progress" },
              { title: "Patch UI", status: "pending" },
            ],
          },
        },
        1,
      ),
    );
    expect(store.getSnapshot().todoItems).toEqual([]);

    store.appendEvent(
      ev(
        "tool.completed",
        {
          toolCallId: "call_1",
          output: { saved: true },
        },
        2,
      ),
    );
    expect(store.getSnapshot().todoItems).toEqual([
      { title: "Inspect trace", status: "in_progress", depth: 0 },
      { title: "Patch UI", status: "pending", depth: 0 },
    ]);
  });

  it("does not replace the displayed ledger when todo_write returns saved:false", () => {
    const store = new EventStore();
    store.appendEvent(
      ev(
        "tool.requested",
        {
          id: "call_1",
          toolName: "todo_write",
          arguments: {
            items: [
              { title: "Discover files", status: "completed" },
              { title: "Extract learning", status: "in_progress" },
            ],
          },
        },
        1,
      ),
    );
    store.appendEvent(
      ev("tool.completed", { toolCallId: "call_1", output: { saved: true } }, 2),
    );

    store.appendEvent(
      ev(
        "tool.requested",
        {
          id: "call_2",
          toolName: "todo_write",
          arguments: {
            items: [
              { title: "Discover files", status: "in_progress" },
              { title: "Extract learning", status: "pending" },
            ],
          },
        },
        3,
      ),
    );
    store.appendEvent(
      ev(
        "tool.completed",
        {
          toolCallId: "call_2",
          output: {
            saved: false,
            hint: "todo_write changed too many times in this run",
          },
        },
        4,
      ),
    );

    expect(store.getSnapshot().todoItems).toEqual([
      { title: "Discover files", status: "completed", depth: 0 },
      { title: "Extract learning", status: "in_progress", depth: 0 },
    ]);
  });

  it("falls back to completed output todos when the request proposal is unavailable", () => {
    const store = new EventStore();
    store.appendEvent(
      ev(
        "tool.completed",
        {
          toolCallId: "call_1",
          output: {
            saved: true,
            todos: {
              type: "array",
              preview: [{ title: "Summarize result", status: "completed" }],
            },
          },
        },
        1,
      ),
    );
    expect(store.getSnapshot().todoItems).toEqual([
      { title: "Summarize result", status: "completed", depth: 0 },
    ]);
  });
});
