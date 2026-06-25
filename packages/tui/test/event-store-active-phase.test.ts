import { describe, expect, it } from "vitest";
import { EventStore } from "../src/state/event-store.js";
import type { RunEvent } from "../src/lib/event-type.js";

function ev(
  type: string,
  sequence: number,
  payload: unknown = {},
  extra: Record<string, unknown> = {},
): RunEvent {
  return {
    type,
    sequence,
    id: `e${sequence}`,
    payload,
    ...extra,
  } as unknown as RunEvent;
}

describe("EventStore active phase projection", () => {
  it("shows and clears the model thinking phase", () => {
    const store = new EventStore();

    store.appendEvent(
      ev("model.turn.started", 1, {}, { runId: "r1", spanId: "m1" }),
    );

    expect(store.getSnapshot().activePhase).toMatchObject({
      kind: "model",
      message: "thinking",
    });

    store.appendEvent(
      ev("model.completed", 2, {}, { runId: "r1", spanId: "m1" }),
    );

    expect(store.getSnapshot().activePhase).toBeNull();
  });

  it("keeps thinking through stream start until the model terminal event", () => {
    const store = new EventStore();

    store.appendEvent(
      ev("model.turn.started", 1, {}, { runId: "r1", spanId: "m1" }),
    );
    store.appendEvent(
      ev("model.stream.started", 2, {}, { runId: "r1", spanId: "m1" }),
    );

    expect(store.getSnapshot().activePhase?.message).toBe("thinking");

    store.appendEvent(
      ev("model.completed", 3, {}, { runId: "r1", spanId: "m1" }),
    );

    expect(store.getSnapshot().activePhase).toBeNull();
  });

  it("keeps another concurrent tool active when the newest tool completes", () => {
    const store = new EventStore();

    store.appendEvent(
      ev("tool.requested", 1, { id: "call_a", toolName: "read_file" }),
    );
    store.appendEvent(
      ev("tool.requested", 2, { id: "call_b", toolName: "shell" }),
    );

    expect(store.getSnapshot().activePhase?.message).toBe("running shell");

    store.appendEvent(ev("tool.completed", 3, { toolCallId: "call_b" }));

    expect(store.getSnapshot().activePhase?.message).toBe("running read_file");

    store.appendEvent(ev("tool.completed", 4, { toolCallId: "call_a" }));

    expect(store.getSnapshot().activePhase).toBeNull();
  });

  it("clears all tool phases on batch completion", () => {
    const store = new EventStore();

    store.appendEvent(
      ev("tool.requested", 1, { id: "call_a", toolName: "read_file" }),
    );
    store.appendEvent(
      ev("tool.requested", 2, { id: "call_b", toolName: "shell" }),
    );
    store.appendEvent(ev("tool.batch.completed", 3));

    expect(store.getSnapshot().activePhase).toBeNull();
  });

  it("tracks subagent queued and running phases by child run id", () => {
    const store = new EventStore();

    store.appendEvent(
      ev(
        "subagent.requested",
        1,
        { childRunId: "run_child" },
        { metadata: { agentName: "reviewer", childRunId: "run_child" } },
      ),
    );

    expect(store.getSnapshot().activePhase).toMatchObject({
      kind: "agent",
      message: "agent reviewer queued",
    });

    store.appendEvent(
      ev(
        "subagent.started",
        2,
        { childRunId: "run_child" },
        { metadata: { agentName: "reviewer", childRunId: "run_child" } },
      ),
    );

    expect(store.getSnapshot().activePhase?.message).toBe("agent reviewer");

    store.appendEvent(ev("subagent.completed", 3, { childRunId: "run_child" }));

    expect(store.getSnapshot().activePhase).toBeNull();
  });

  it("shows validation above a quiet model phase", () => {
    const store = new EventStore();

    store.appendEvent(
      ev("model.turn.started", 1, {}, { runId: "r1", spanId: "m1" }),
    );
    store.appendEvent(
      ev("validation.started", 2, {}, { runId: "r1", spanId: "v1" }),
    );

    expect(store.getSnapshot().activePhase).toMatchObject({
      kind: "validation",
      message: "validating",
    });

    store.appendEvent(
      ev("validation.completed", 3, {}, { runId: "r1", spanId: "v1" }),
    );

    expect(store.getSnapshot().activePhase?.message).toBe("thinking");
  });

  it("shows the running subagent over the delegate tool that launched it", () => {
    const store = new EventStore();

    // A delegate tool call brackets the whole child run: streaming-runtime emits
    // tool.requested now and tool.completed only after the awaited execute()
    // resolves — i.e. after subagent.completed. The agent must win meanwhile, or
    // the launcher tool name masks the running agent for its entire lifetime.
    store.appendEvent(
      ev("tool.requested", 1, {
        id: "call_delegate",
        toolName: "delegate_reviewer",
      }),
    );
    store.appendEvent(
      ev(
        "subagent.started",
        2,
        { childRunId: "run_child" },
        { metadata: { agentName: "reviewer", childRunId: "run_child" } },
      ),
    );

    expect(store.getSnapshot().activePhase).toMatchObject({
      kind: "agent",
      message: "agent reviewer",
    });

    // Child finished but the delegate tool span is still open — it resurfaces
    // until its own tool.completed arrives.
    store.appendEvent(ev("subagent.completed", 3, { childRunId: "run_child" }));

    expect(store.getSnapshot().activePhase?.message).toBe(
      "running delegate_reviewer",
    );

    store.appendEvent(ev("tool.completed", 4, { toolCallId: "call_delegate" }));

    expect(store.getSnapshot().activePhase).toBeNull();
  });

  it("shows compaction above a model call it may spawn", () => {
    const store = new EventStore();

    store.appendEvent(
      ev("context.compaction.started", 1, {}, { runId: "r1", spanId: "c1" }),
    );
    // Compaction may summarize via an inner model call — it must not mask the
    // "compacting" headline.
    store.appendEvent(
      ev("model.turn.started", 2, {}, { runId: "r1", spanId: "m1" }),
    );

    expect(store.getSnapshot().activePhase).toMatchObject({
      kind: "compaction",
      message: "compacting context",
    });

    store.appendEvent(
      ev("context.compaction.completed", 3, {}, { runId: "r1", spanId: "c1" }),
    );

    expect(store.getSnapshot().activePhase?.message).toBe("thinking");
  });

  it("reads retrying after a stream failure and resets on completion", () => {
    const store = new EventStore();

    store.appendEvent(
      ev("model.turn.started", 1, {}, { runId: "r1", spanId: "m1" }),
    );
    expect(store.getSnapshot().activePhase?.message).toBe("thinking");

    store.appendEvent(
      ev("model.stream.failed", 2, {}, { runId: "r1", spanId: "m1" }),
    );
    store.appendEvent(ev("model.retrying", 3, {}, { runId: "r1" }));
    expect(store.getSnapshot().activePhase?.message).toBe(
      "retrying (attempt 2)",
    );

    // The retry attempt's own model.requested keeps the retry framing.
    store.appendEvent(
      ev("model.requested", 4, {}, { runId: "r1", spanId: "m2" }),
    );
    expect(store.getSnapshot().activePhase?.message).toBe(
      "retrying (attempt 2)",
    );

    store.appendEvent(
      ev("model.completed", 5, {}, { runId: "r1", spanId: "m2" }),
    );
    expect(store.getSnapshot().activePhase).toBeNull();

    // A fresh turn on the same run starts back at a plain "thinking".
    store.appendEvent(
      ev("model.turn.started", 6, {}, { runId: "r1", spanId: "m3" }),
    );
    expect(store.getSnapshot().activePhase?.message).toBe("thinking");
  });

  it("clears active phases on terminal run events, clear, and reset", () => {
    const store = new EventStore();

    store.appendEvent(
      ev("tool.requested", 1, { id: "call_a", toolName: "shell" }),
    );
    store.appendEvent(ev("run.completed", 2, { state: "completed" }));
    expect(store.getSnapshot().activePhase).toBeNull();

    store.appendEvent(
      ev("tool.requested", 3, { id: "call_b", toolName: "shell" }),
    );
    store.clearEvents();
    expect(store.getSnapshot().activePhase).toBeNull();

    store.appendEvent(
      ev("tool.requested", 4, { id: "call_c", toolName: "shell" }),
    );
    store.reset();
    expect(store.getSnapshot().activePhase).toBeNull();
  });
});
