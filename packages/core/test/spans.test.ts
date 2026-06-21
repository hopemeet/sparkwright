import { describe, expect, it } from "vitest";
import { EventLog } from "../src/events.js";
import { createRunId } from "../src/ids.js";
import {
  currentSpan,
  emitInSpan,
  openSpan,
  runWithSpan,
  semanticsToMetadata,
  SPAN_SEMANTIC_METADATA_KEYS,
  withSpan,
  withSpanSync,
} from "../src/spans.js";

describe("withSpan", () => {
  it("emits paired start/end events with the same spanId and a duration", async () => {
    const log = new EventLog(createRunId());

    await withSpan(
      log,
      { startType: "tool.started", endType: "tool.completed" },
      async () => 42,
    );

    const events = log.all();
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("tool.started");
    expect(events[1]!.type).toBe("tool.completed");
    expect(events[0]!.spanId).toBeDefined();
    expect(events[0]!.spanId).toBe(events[1]!.spanId);
    expect(events[0]!.traceId).toBe(events[1]!.traceId);
    expect(events[1]!.metadata.durationMs).toBeTypeOf("number");
  });

  it("nests parentSpanId from the enclosing withSpan via AsyncLocalStorage", async () => {
    const log = new EventLog(createRunId());

    await withSpan(
      log,
      { startType: "run.started", endType: "run.completed" },
      async () => {
        await withSpan(
          log,
          { startType: "tool.started", endType: "tool.completed" },
          async () => "inner",
        );
      },
    );

    const events = log.all();
    const outerStart = events.find((e) => e.type === "run.started")!;
    const innerStart = events.find((e) => e.type === "tool.started")!;
    expect(innerStart.parentSpanId).toBe(outerStart.spanId);
    expect(innerStart.traceId).toBe(outerStart.traceId);
  });

  it("emits failType on throw and re-throws transparently", async () => {
    const log = new EventLog(createRunId());

    await expect(
      withSpan(
        log,
        {
          startType: "tool.started",
          endType: "tool.completed",
          failType: "tool.failed",
        },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    const events = log.all();
    expect(events.map((e) => e.type)).toEqual(["tool.started", "tool.failed"]);
    expect(events[1]!.metadata.error).toBe("boom");
    // errorDetails carries the structured form for trace sinks that want
    // more than just the message. `error` stays a string for back-compat.
    expect(events[1]!.metadata.errorDetails).toMatchObject({ message: "boom" });
    expect(events[0]!.spanId).toBe(events[1]!.spanId);
  });

  it("propagates the active frame to child emits via currentSpan/emitInSpan", async () => {
    const log = new EventLog(createRunId());

    await withSpan(
      log,
      { startType: "tool.started", endType: "tool.completed" },
      async (frame) => {
        expect(currentSpan()?.spanId).toBe(frame.spanId);
        emitInSpan(log, "tool.progress", { pct: 0.5 });
      },
    );

    const progress = log.all().find((e) => e.type === "tool.progress")!;
    expect(progress.spanId).toBeDefined();
    // tool.progress is an instant event — its spanId is the enclosing span's id.
    const start = log.all().find((e) => e.type === "tool.started")!;
    expect(progress.spanId).toBe(start.spanId);
    expect(progress.parentSpanId).toBe(start.parentSpanId);
  });

  it("does not leak the private __span key onto emitted events", async () => {
    const log = new EventLog(createRunId());
    await withSpan(
      log,
      { startType: "tool.started", endType: "tool.completed" },
      async () => undefined,
    );
    for (const event of log.all()) {
      expect(Object.keys(event.metadata)).not.toContain("__span");
    }
  });
});

describe("withSpanSync", () => {
  it("brackets a synchronous function and emits both events", () => {
    const log = new EventLog(createRunId());
    const result = withSpanSync(
      log,
      { startType: "validation.started", endType: "validation.completed" },
      () => 7,
    );
    expect(result).toBe(7);
    expect(log.all().map((e) => e.type)).toEqual([
      "validation.started",
      "validation.completed",
    ]);
  });
});

describe("openSpan", () => {
  it("emits a start immediately and an end when close() is called", () => {
    const log = new EventLog(createRunId());
    const span = openSpan(log, { startType: "task.started" });
    expect(log.all()).toHaveLength(1);
    span.close("task.completed");
    expect(log.all().map((e) => e.type)).toEqual([
      "task.started",
      "task.completed",
    ]);
    expect(log.all()[0]!.spanId).toBe(log.all()[1]!.spanId);
  });

  it("ignores duplicate close() calls", () => {
    const log = new EventLog(createRunId());
    const span = openSpan(log, { startType: "task.started" });
    span.close("task.completed");
    span.close("task.failed");
    expect(log.all()).toHaveLength(2);
    expect(log.all()[1]!.type).toBe("task.completed");
  });

  it("treats cancelled as a lifecycle suffix for span names", () => {
    const log = new EventLog(createRunId());
    const span = openSpan(log, { startType: "task.started" });
    span.close("task.cancelled");
    expect(log.all()[1]).toMatchObject({
      type: "task.cancelled",
      metadata: { spanName: "task" },
    });
  });
});

describe("runWithSpan", () => {
  it("installs an explicit frame as the active context for fn", () => {
    const log = new EventLog(createRunId());
    const frame = {
      traceId: "trc_explicit" as ReturnType<typeof currentSpan> extends infer F
        ? F extends { traceId: infer T }
          ? T
          : never
        : never,
      spanId: "spn_explicit" as ReturnType<typeof currentSpan> extends infer F
        ? F extends { spanId: infer S }
          ? S
          : never
        : never,
    };
    runWithSpan(frame as never, () => {
      emitInSpan(log, "usage.updated", {});
    });
    const evt = log.all()[0]!;
    expect(evt.spanId).toBe(frame.spanId);
    expect(evt.traceId).toBe(frame.traceId);
  });
});

describe("openSpan", () => {
  // Regression: open-time metadata used to be silently dropped whenever
  // the caller passed any close-time metadata at all.
  it("merges open-time and close-time metadata", () => {
    const log = new EventLog(createRunId());
    const span = openSpan(log, {
      startType: "tool.requested",
      metadata: { tag: "open", caller: "test" },
    });
    span.close("tool.completed", undefined, { extra: "close" });

    const events = log.all();
    expect(events[1]!.metadata).toMatchObject({
      tag: "open",
      caller: "test",
      extra: "close",
    });
  });

  it("close() without metadata still keeps open-time metadata", () => {
    const log = new EventLog(createRunId());
    const span = openSpan(log, {
      startType: "tool.requested",
      metadata: { tag: "open-only" },
    });
    span.close("tool.completed");
    expect(log.all()[1]!.metadata.tag).toBe("open-only");
  });
});

describe("span semantics", () => {
  it("semanticsToMetadata maps fields to stable keys and omits absent ones", () => {
    expect(semanticsToMetadata(undefined)).toEqual({});
    expect(
      semanticsToMetadata({ agentRole: "planner", decisionKind: "plan" }),
    ).toEqual({
      "agent.role": "planner",
      "decision.kind": "plan",
    });
  });

  it("withSpan writes semantics into BOTH start and end event metadata", async () => {
    const log = new EventLog(createRunId());

    await withSpan(
      log,
      {
        startType: "tool.started",
        endType: "tool.completed",
        semantics: {
          agentRole: "reviewer",
          toolSelectionReason: "needs file read before edit",
          decisionKind: "observe",
        },
      },
      async () => undefined,
    );

    const [start, end] = log.all();
    for (const event of [start!, end!]) {
      expect(event.metadata[SPAN_SEMANTIC_METADATA_KEYS.agentRole]).toBe(
        "reviewer",
      );
      expect(
        event.metadata[SPAN_SEMANTIC_METADATA_KEYS.toolSelectionReason],
      ).toBe("needs file read before edit");
      expect(event.metadata[SPAN_SEMANTIC_METADATA_KEYS.decisionKind]).toBe(
        "observe",
      );
    }
  });

  it("explicit metadata wins over semantics on key collision", async () => {
    const log = new EventLog(createRunId());
    await withSpan(
      log,
      {
        startType: "tool.started",
        endType: "tool.completed",
        semantics: { agentRole: "from-semantics" },
        metadata: { [SPAN_SEMANTIC_METADATA_KEYS.agentRole]: "from-metadata" },
      },
      async () => undefined,
    );
    expect(log.all()[0]!.metadata[SPAN_SEMANTIC_METADATA_KEYS.agentRole]).toBe(
      "from-metadata",
    );
  });

  it("openSpan threads semantics through to both events", () => {
    const log = new EventLog(createRunId());
    const span = openSpan(log, {
      startType: "tool.started",
      semantics: { decisionKind: "act" },
    });
    span.close("tool.completed");
    const [start, end] = log.all();
    expect(start!.metadata[SPAN_SEMANTIC_METADATA_KEYS.decisionKind]).toBe(
      "act",
    );
    expect(end!.metadata[SPAN_SEMANTIC_METADATA_KEYS.decisionKind]).toBe("act");
  });
});

describe("EventLog default traceId", () => {
  it("assigns a stable defaultTraceId when no withSpan frame is active", () => {
    const log = new EventLog(createRunId());
    const a = log.emit("run.created", {});
    const b = log.emit("run.started", {});
    expect(a.traceId).toBeDefined();
    expect(a.traceId).toBe(b.traceId);
    expect(a.spanId).toBeUndefined();
  });
});
