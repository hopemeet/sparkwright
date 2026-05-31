import { describe, expect, it } from "vitest";
import {
  EventLog,
  createRunId,
  withSpan,
  emitInSpan,
  type SparkwrightEvent,
} from "@sparkwright/core";
import { PerfettoTrace, attachPerfettoSink } from "../src/index.js";

describe("PerfettoTrace", () => {
  it("pairs withSpan start/end into a single complete event (ph: X) with duration", async () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    const unsubscribe = log.subscribe((e) => trace.ingest(e));

    await withSpan(
      log,
      { startType: "tool.started", endType: "tool.completed" },
      async () => undefined,
    );

    unsubscribe();
    const doc = trace.toJSON();
    const completeEvents = doc.traceEvents.filter((e) => e.ph === "X");
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0]!.name).toBe("tool");
    expect(completeEvents[0]!.dur).toBeGreaterThanOrEqual(0);
  });

  it("pairs explicitly phased withSpan events without lifecycle suffixes", async () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    await withSpan(
      log,
      { startType: "model.requested", endType: "model.completed" },
      async () => undefined,
    );

    const completeEvents = trace
      .toJSON()
      .traceEvents.filter((e) => e.ph === "X");
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0]!.name).toBe("model");
  });

  it("adds model TTFT and sampling phase events when model trace metadata exists", async () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    await withSpan(
      log,
      {
        startType: "model.requested",
        endType: "model.completed",
        payload: {
          trace: {
            ttftMs: 1,
            outputTokens: 4,
            outputTokensPerSecond: 40,
          },
        },
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 3));
      },
    );

    const events = trace.toJSON().traceEvents;
    expect(events.some((e) => e.name === "First Token")).toBe(true);
    expect(events.some((e) => e.name === "Sampling")).toBe(true);
  });

  it("uses heuristic pairing for un-spanned start/end pairs", () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    log.emit("plan.step.started", { step: 1 });
    log.emit("plan.step.completed", { step: 1 });

    const completes = trace.toJSON().traceEvents.filter((e) => e.ph === "X");
    expect(completes).toHaveLength(1);
    expect(completes[0]!.args?.heuristicPair).toBe(true);
  });

  it("emits instant markers for events that don't pair", () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    log.emit("usage.updated", { tokens: 100 });

    const instants = trace.toJSON().traceEvents.filter((e) => e.ph === "i");
    expect(instants).toHaveLength(1);
    expect(instants[0]!.name).toBe("usage.updated");
  });

  it("converts pending starts into instant markers on finalize()", async () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    log.emit("tool.started", {}); // no matching end
    trace.finalize();

    const events = trace.toJSON().traceEvents;
    expect(events.some((e) => e.ph === "i" && e.name === "tool.started")).toBe(
      true,
    );
  });

  it("places sub-agent events on a distinct tid lane based on agent.name", async () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    await withSpan(
      log,
      {
        startType: "task.started",
        endType: "task.completed",
        metadata: { "agent.name": "researcher" },
      },
      async () => undefined,
    );

    const completes = trace.toJSON().traceEvents.filter((e) => e.ph === "X");
    expect(completes).toHaveLength(1);
    expect(completes[0]!.tid).not.toBe(1);
  });

  it("surfaces span semantics into args and folds decisionKind into cat", async () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    await withSpan(
      log,
      {
        startType: "tool.started",
        endType: "tool.completed",
        semantics: {
          agentRole: "planner",
          toolSelectionReason: "cheapest read tool",
          decisionKind: "plan",
        },
      },
      async () => undefined,
    );

    const complete = trace.toJSON().traceEvents.find((e) => e.ph === "X")!;
    expect(complete.args?.semantics).toMatchObject({
      "agent.role": "planner",
      "tool.selectionReason": "cheapest read tool",
      "decision.kind": "plan",
    });
    // base prefix "tool" + decision kind "plan"
    expect(complete.cat).toBe("tool,plan");
  });

  it("splits sub-agent spans onto their own lane via the agentName metadata key", async () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    // `spawnSubAgent` stamps `agentName` (camelCase), not the dotted
    // `agent.name`/`agent.role` the sink primarily keys on.
    await withSpan(
      log,
      {
        startType: "task.started",
        endType: "task.completed",
        metadata: { agentName: "researcher" },
      },
      async () => undefined,
    );

    const complete = trace.toJSON().traceEvents.find((e) => e.ph === "X")!;
    expect(complete.tid).not.toBe(1);
  });

  it("splits spans onto per-role lanes via semantics agentRole", async () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    await withSpan(
      log,
      {
        startType: "task.started",
        endType: "task.completed",
        semantics: { agentRole: "sub:reviewer" },
      },
      async () => undefined,
    );

    const complete = trace.toJSON().traceEvents.find((e) => e.ph === "X")!;
    expect(complete.tid).not.toBe(1);
  });

  it("keeps the main role on tid=1 and omits empty semantics from args", async () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    await withSpan(
      log,
      {
        startType: "tool.started",
        endType: "tool.completed",
        semantics: { agentRole: "main" },
      },
      async () => undefined,
    );

    const complete = trace.toJSON().traceEvents.find((e) => e.ph === "X")!;
    expect(complete.tid).toBe(1);
    // agentRole "main" is still recorded in args.semantics for audit, but the
    // span carries no decisionKind so cat stays the bare prefix.
    expect(complete.cat).toBe("tool");
  });

  it("attaches instant emissions inside a span to that span's lane", async () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    await withSpan(
      log,
      { startType: "model.requested", endType: "model.completed" },
      async () => {
        emitInSpan(log, "usage.updated", { tokens: 1 });
      },
    );

    const events = trace.toJSON().traceEvents;
    const usage = events.find((e) => e.name === "usage.updated");
    expect(usage).toBeDefined();
    expect(usage!.ph).toBe("i");
  });

  it("keeps an instant emitted inside a sub-agent span on the span's lane", async () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    await withSpan(
      log,
      {
        startType: "task.started",
        endType: "task.completed",
        metadata: { "agent.name": "researcher" },
      },
      async () => {
        emitInSpan(log, "usage.updated", { tokens: 1 });
      },
    );

    const events = trace.toJSON().traceEvents;
    const span = events.find((e) => e.ph === "X")!;
    const usage = events.find((e) => e.name === "usage.updated")!;
    expect(span.tid).not.toBe(1);
    // The instant carries the span's spanId but not its agent.name metadata;
    // it must still land on the sub-agent lane, not main (tid=1).
    expect(usage.tid).toBe(span.tid);
  });

  it("derives span duration from monotonicUs when present (sub-ms precision)", () => {
    const trace = new PerfettoTrace();
    // Same millisecond timestamp on both events — ISO-only timing would yield
    // dur:0. monotonicUs carries the sub-ms delta (1500 - 1000 = 500us).
    const iso = "2026-05-29T00:00:00.000Z";
    const base = {
      runId: "run_x",
      payload: {},
      traceId: "trc_x",
      spanId: "spn_x",
    };
    trace.ingest({
      ...base,
      id: "evt_1",
      type: "tool.started",
      timestamp: iso,
      monotonicUs: 1000,
      sequence: 1,
      metadata: {},
    } as unknown as SparkwrightEvent);
    trace.ingest({
      ...base,
      id: "evt_2",
      type: "tool.completed",
      timestamp: iso,
      monotonicUs: 1500,
      sequence: 2,
      metadata: {},
    } as unknown as SparkwrightEvent);

    const complete = trace.toJSON().traceEvents.find((e) => e.ph === "X")!;
    expect(complete.dur).toBe(500);
  });

  it("falls back to the ISO timestamp when monotonicUs is absent", () => {
    const trace = new PerfettoTrace();
    const base = {
      runId: "run_y",
      payload: {},
      traceId: "trc_y",
      spanId: "spn_y",
    };
    trace.ingest({
      ...base,
      id: "evt_1",
      type: "tool.started",
      timestamp: "2026-05-29T00:00:00.000Z",
      sequence: 1,
      metadata: {},
    } as unknown as SparkwrightEvent);
    trace.ingest({
      ...base,
      id: "evt_2",
      type: "tool.completed",
      timestamp: "2026-05-29T00:00:00.002Z",
      sequence: 2,
      metadata: {},
    } as unknown as SparkwrightEvent);

    const complete = trace.toJSON().traceEvents.find((e) => e.ph === "X")!;
    expect(complete.dur).toBe(2000);
  });

  it("renders open spans without consuming them so flush is non-destructive", () => {
    const log = new EventLog(createRunId());
    const trace = new PerfettoTrace();
    log.subscribe((e) => trace.ingest(e));

    log.emit("tool.started", {});

    // Mid-run snapshot renders the open span as an instant marker...
    const midRun = trace.toJSON().traceEvents;
    expect(midRun.some((e) => e.ph === "i" && e.name === "tool.started")).toBe(
      true,
    );

    // ...but the span is still pending, so its end event completes it into a
    // proper ph:"X" event rather than being orphaned.
    log.emit("tool.completed", {});
    const final = trace.toJSON().traceEvents;
    expect(final.filter((e) => e.ph === "X")).toHaveLength(1);
  });
});

describe("attachPerfettoSink", () => {
  it("subscribes to the source and unsubscribes on close()", async () => {
    const log = new EventLog(createRunId());
    const sink = attachPerfettoSink({ source: log, flushOnExit: false });
    log.emit("run.created", {});
    expect(sink.trace.size()).toBe(1);
    sink.close();
    log.emit("run.started", {});
    expect(sink.trace.size()).toBe(1);
  });

  it("flush() is a no-op without an outPath", () => {
    const log = new EventLog(createRunId());
    const sink = attachPerfettoSink({ source: log, flushOnExit: false });
    expect(() => sink.flush()).not.toThrow();
    sink.close();
  });
});
