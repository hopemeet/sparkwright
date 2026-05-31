// =============================================================================
// @sparkwright/trace-perfetto
//
// Subscribes to a SparkWright event stream and translates it to Chrome
// Trace Event format JSON (a.k.a. "Perfetto" format). The output is loadable
// at https://ui.perfetto.dev — drag-and-drop produces a flamegraph of the
// run with spans nested by parent/child and instant events as markers.
//
// Format reference: https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU
//
// Pairing strategy (in order of precedence):
//   1. spanId envelope field (ADR-0008). Start and end events with the same
//      spanId become one `ph: "X"` complete event with duration.
//   2. Event-type suffix heuristic for pre-0.2 traces / emitters that haven't
//      adopted withSpan: matched pairs like `tool.started` ↔ `tool.completed`
//      keyed by an inferred correlation id (the most recent unmatched
//      `<prefix>.started` per runId).
//   3. Unmatched events become instant markers (`ph: "i"`).
//
// AI maintenance note: this sink is intentionally side-effect-free in the
// constructor — `attach()` subscribes, `flush()`/`close()` writes. Do not
// open files at module load; doing so breaks the "import is free" contract
// the rest of the monorepo relies on for tests.
// =============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  SPAN_SEMANTIC_METADATA_KEYS,
  type SparkwrightEvent,
} from "@sparkwright/core";

export interface PerfettoEvent {
  name: string;
  cat: string;
  ph: "X" | "i" | "M";
  ts: number; // microseconds since epoch
  pid: number;
  tid: number;
  dur?: number; // microseconds (only for ph: "X")
  args?: Record<string, unknown>;
}

export interface PerfettoTraceDocument {
  traceEvents: PerfettoEvent[];
  displayTimeUnit: "ns" | "ms";
}

interface EventSource {
  subscribe(listener: (event: SparkwrightEvent) => void): () => void;
}

// Suffix lists used for the heuristic pairing fallback only. spanId-based
// pairing is the primary path and works for any event types. Keep these
// conservative so unrelated instant events (`run.created`, `tool.requested`,
// `artifact.created`) are not mistaken for span starts. The strict
// `.started` ↔ `.completed/.failed/.cancelled` pairing covers the
// pre-spanId events the runtime emits today.
const SPAN_END_SUFFIXES = [".completed", ".failed", ".cancelled"] as const;
const SPAN_START_SUFFIXES = [".started"] as const;

function suffixOf(type: string, suffixes: readonly string[]): string | null {
  for (const s of suffixes) if (type.endsWith(s)) return s;
  return null;
}

function rootOf(type: string): string {
  const end = suffixOf(type, SPAN_END_SUFFIXES);
  if (end) return type.slice(0, -end.length);
  const start = suffixOf(type, SPAN_START_SUFFIXES);
  if (start) return type.slice(0, -start.length);
  return type;
}

function catWithDecision(
  type: string,
  semantics: Record<string, string> | undefined,
): string {
  const base = type.split(".")[0] ?? "span";
  const decisionKind = semantics?.[SPAN_SEMANTIC_METADATA_KEYS.decisionKind];
  return decisionKind ? `${base},${decisionKind}` : base;
}

function tsMicrosOf(event: SparkwrightEvent): number {
  // Prefer the process-monotonic microsecond clock (ADR-0008): it carries the
  // sub-millisecond resolution Perfetto's `ts` axis needs, so fast spans get a
  // real non-zero `dur` instead of collapsing onto the same millisecond.
  // `performance.now()` shares one origin across every EventLog in the
  // process, so monotonicUs values are mutually comparable within a trace
  // without being epoch-anchored. Fall back to the ISO timestamp (ms only) for
  // events from pre-v0.2 emitters that don't carry monotonicUs.
  const monotonic = (event as { monotonicUs?: unknown }).monotonicUs;
  if (typeof monotonic === "number" && Number.isFinite(monotonic)) {
    return monotonic;
  }
  return Date.parse(event.timestamp) * 1000;
}

function hashTid(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++)
    h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  // Reserve tid=1 for the main thread; offset hashes above that.
  return 2 + (Math.abs(h) % 1_000_000);
}

interface PendingSpan {
  startedUs: number;
  startEvent: SparkwrightEvent;
}

interface ModelTraceArgs extends Record<string, unknown> {
  ttftMs?: number;
  outputTokens?: number;
  inputTokens?: number;
  inputTokensPerSecond?: number;
  outputTokensPerSecond?: number;
  cacheHitRatePct?: number;
}

export interface PerfettoTraceOptions {
  /**
   * Map a SparkwrightEvent to (pid, tid). Default uses runId for pid and
   * the `agent.name` metadata field (if present) for tid; the main agent
   * always lands on tid=1 so it shows up first in Perfetto's UI.
   */
  laneFor?: (event: SparkwrightEvent) => { pid: number; tid: number };
}

function eventPayloadRecord(event: SparkwrightEvent): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function metadataString(
  event: SparkwrightEvent,
  key: string,
): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Pull the agent-level semantic annotations off a span's start/end events
 * (end takes precedence; start fills gaps). Returns `undefined` when the span
 * carries no semantics so we never inflate `args` with empty objects.
 */
function extractSemantics(
  start: SparkwrightEvent,
  end?: SparkwrightEvent,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const key of Object.values(SPAN_SEMANTIC_METADATA_KEYS)) {
    const value =
      (end && metadataString(end, key)) ?? metadataString(start, key);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * In-memory accumulator. Useful in tests and in any host that wants to
 * serialize the trace itself (e.g. ship it over an IPC channel rather than
 * a file).
 */
export class PerfettoTrace {
  private readonly events: PerfettoEvent[] = [];
  private readonly pendingBySpanId = new Map<string, PendingSpan>();
  private readonly pendingByHeuristic = new Map<string, PendingSpan[]>();
  private readonly pidByRunId = new Map<string, number>();
  // Lane (tid) recorded at span open, keyed by spanId. Instant events emitted
  // inside a span carry that span's spanId (via emitInSpan) but NOT its
  // agent.name/agent.role metadata, so without this they'd fall back to tid=1
  // and detach from their parent span in the UI.
  private readonly tidBySpanId = new Map<string, number>();
  private nextPid = 1;
  private readonly laneFor: NonNullable<PerfettoTraceOptions["laneFor"]>;

  constructor(options: PerfettoTraceOptions = {}) {
    this.laneFor =
      options.laneFor ??
      ((event) => ({
        pid: this.pidFor(event.runId as unknown as string),
        tid: this.tidFor(event),
      }));
  }

  ingest(event: SparkwrightEvent): void {
    const ts = tsMicrosOf(event);
    const { pid, tid } = this.laneFor(event);

    // 1. spanId-based pairing (preferred path).
    if (event.spanId) {
      const spanPhase = metadataString(event, "spanPhase");
      const isExplicitStart = spanPhase === "start";
      const isExplicitEnd = spanPhase === "end";
      if (isExplicitStart || suffixOf(event.type, SPAN_START_SUFFIXES)) {
        this.pendingBySpanId.set(event.spanId, {
          startedUs: ts,
          startEvent: event,
        });
        this.tidBySpanId.set(event.spanId, tid);
        return;
      }
      if (isExplicitEnd || suffixOf(event.type, SPAN_END_SUFFIXES)) {
        const pending = this.pendingBySpanId.get(event.spanId);
        if (pending) {
          this.pendingBySpanId.delete(event.spanId);
          this.tidBySpanId.delete(event.spanId);
          const spanName =
            metadataString(event, "spanName") ??
            metadataString(pending.startEvent, "spanName") ??
            rootOf(event.type);
          const semantics = extractSemantics(pending.startEvent, event);
          const completeEvent: PerfettoEvent = {
            name: spanName,
            // Fold the decision kind into `cat` so Perfetto groups/colors
            // spans by agent decision phase (plan/act/observe/...) on top of
            // the mechanical event prefix.
            cat: catWithDecision(event.type, semantics),
            ph: "X",
            ts: pending.startedUs,
            dur: Math.max(0, ts - pending.startedUs),
            pid,
            tid,
            args: {
              startPayload: pending.startEvent.payload,
              endPayload: event.payload,
              endType: event.type,
              spanId: event.spanId,
              parentSpanId: event.parentSpanId,
              traceId: event.traceId,
              ...(semantics ? { semantics } : {}),
            },
          };
          this.events.push({
            ...completeEvent,
          });
          this.addModelPhaseEvents(completeEvent, event);
          return;
        }
        // End without a start — emit as instant so it's not silently dropped.
        this.events.push(this.instantOf(event, pid, tid));
        return;
      }
      // Instant event correlated with an enclosing span — keep it on the
      // span's lane rather than re-deriving tid from the (semantics-free)
      // instant event's own metadata.
      const enclosingTid = this.tidBySpanId.get(event.spanId) ?? tid;
      this.events.push(this.instantOf(event, pid, enclosingTid));
      return;
    }

    // 2. Heuristic pairing for un-spanned events.
    const startSuffix = suffixOf(event.type, SPAN_START_SUFFIXES);
    if (startSuffix) {
      const key = `${event.runId} ${rootOf(event.type)}`;
      const queue = this.pendingByHeuristic.get(key) ?? [];
      queue.push({ startedUs: ts, startEvent: event });
      this.pendingByHeuristic.set(key, queue);
      return;
    }
    const endSuffix = suffixOf(event.type, SPAN_END_SUFFIXES);
    if (endSuffix) {
      const key = `${event.runId} ${rootOf(event.type)}`;
      const queue = this.pendingByHeuristic.get(key);
      const pending = queue?.shift();
      if (pending) {
        this.events.push({
          name: rootOf(event.type),
          cat: event.type.split(".")[0] ?? "span",
          ph: "X",
          ts: pending.startedUs,
          dur: Math.max(0, ts - pending.startedUs),
          pid,
          tid,
          args: {
            startPayload: pending.startEvent.payload,
            endPayload: event.payload,
            endType: event.type,
            heuristicPair: true,
          },
        });
        return;
      }
    }

    // 3. Anything else is an instant marker.
    this.events.push(this.instantOf(event, pid, tid));
  }

  /**
   * No-op retained for API back-compat. Spans that never ended (aborted runs,
   * uncaught errors) are now rendered as instant markers on demand by
   * {@link toJSON}, derived from the live pending maps without mutating them.
   * This makes intermediate `flush()` calls non-destructive: a span still open
   * when the trace is written stays pending and can still complete into a
   * proper `ph: "X"` event once its end event arrives.
   */
  finalize(): void {
    // Intentionally empty — see toJSON()/renderOrphans().
  }

  toJSON(): PerfettoTraceDocument {
    const traceEvents = [...this.events, ...this.renderOrphans()].sort(
      (a, b) => a.ts - b.ts,
    );
    return {
      traceEvents,
      displayTimeUnit: "ms",
    };
  }

  /**
   * Render still-pending spans as instant markers without consuming them.
   * Pure and idempotent: called fresh on every {@link toJSON} so repeated
   * writes never duplicate or drop in-progress spans.
   */
  private renderOrphans(): PerfettoEvent[] {
    const orphans: PerfettoEvent[] = [];
    for (const [, pending] of this.pendingBySpanId) {
      orphans.push(
        this.instantOf(
          pending.startEvent,
          ...this.laneAsTuple(pending.startEvent),
        ),
      );
    }
    for (const [, queue] of this.pendingByHeuristic) {
      for (const pending of queue) {
        orphans.push(
          this.instantOf(
            pending.startEvent,
            ...this.laneAsTuple(pending.startEvent),
          ),
        );
      }
    }
    return orphans;
  }

  size(): number {
    return this.events.length;
  }

  private instantOf(
    event: SparkwrightEvent,
    pid: number,
    tid: number,
  ): PerfettoEvent {
    return {
      name: event.type,
      cat: event.type.split(".")[0] ?? "instant",
      ph: "i",
      ts: tsMicrosOf(event),
      pid,
      tid,
      args: {
        payload: event.payload,
        metadata: event.metadata,
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        traceId: event.traceId,
      },
    };
  }

  private laneAsTuple(event: SparkwrightEvent): [number, number] {
    const lane = this.laneFor(event);
    return [lane.pid, lane.tid];
  }

  private pidFor(runId: string): number {
    let pid = this.pidByRunId.get(runId);
    if (pid === undefined) {
      pid = this.nextPid++;
      this.pidByRunId.set(runId, pid);
    }
    return pid;
  }

  private tidFor(event: SparkwrightEvent): number {
    // `agent.name` (explicit sub-agent identity) takes precedence; fall back
    // to the semantic `agent.role` so spans annotated via SpanSemantics still
    // split into per-role lanes. `agentName` (camelCase) is the key
    // `@sparkwright/agent-runtime`'s `spawnSubAgent` stamps on child runs, so
    // accept it last to keep sub-agents on their own lane without forcing that
    // package to also write the dotted `agent.name`. The main agent always
    // lands on tid=1 so it sorts first in Perfetto's UI.
    const lane =
      event.metadata?.["agent.name"] ??
      event.metadata?.[SPAN_SEMANTIC_METADATA_KEYS.agentRole] ??
      event.metadata?.["agentName"];
    if (typeof lane === "string" && lane.length > 0 && lane !== "main") {
      return hashTid(lane);
    }
    return 1;
  }

  private addModelPhaseEvents(
    parent: PerfettoEvent,
    endEvent: SparkwrightEvent,
  ) {
    if (parent.name !== "model" || parent.dur === undefined) return;
    const trace = eventPayloadRecord(endEvent).trace;
    if (!isRecord(trace)) return;

    const args = modelTraceArgs(trace);
    const ttftMs = numberValue(trace.ttftMs);
    if (ttftMs === undefined || ttftMs < 0) return;

    const firstTokenDur = Math.min(parent.dur, ttftMs * 1000);
    this.events.push({
      name: "First Token",
      cat: "model,ttft",
      ph: "X",
      ts: parent.ts,
      dur: firstTokenDur,
      pid: parent.pid,
      tid: parent.tid,
      args,
    });

    const samplingDur = Math.max(0, parent.dur - firstTokenDur);
    if (samplingDur > 0) {
      this.events.push({
        name: "Sampling",
        cat: "model,sampling",
        ph: "X",
        ts: parent.ts + firstTokenDur,
        dur: samplingDur,
        pid: parent.pid,
        tid: parent.tid,
        args,
      });
    }
  }
}

function modelTraceArgs(trace: Record<string, unknown>): ModelTraceArgs {
  return compactArgs({
    ttftMs: numberValue(trace.ttftMs),
    inputTokens: numberValue(trace.inputTokens),
    outputTokens: numberValue(trace.outputTokens),
    inputTokensPerSecond: numberValue(trace.inputTokensPerSecond),
    outputTokensPerSecond: numberValue(trace.outputTokensPerSecond),
    cacheHitRatePct: numberValue(trace.cacheHitRatePct),
  });
}

function compactArgs<T extends Record<string, unknown>>(args: T): T {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined),
  ) as T;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AttachPerfettoSinkOptions extends PerfettoTraceOptions {
  source: EventSource;
  /**
   * Where to write the trace JSON. If omitted, the sink only accumulates
   * in memory — call `result.flush(path)` manually.
   */
  outPath?: string;
  /**
   * Write the file on the Node `beforeExit` lifecycle. Defaults to `true`
   * when `outPath` is set. Disable for tests or when you want exact control
   * over when bytes hit disk.
   */
  flushOnExit?: boolean;
}

export interface PerfettoSinkHandle {
  trace: PerfettoTrace;
  /** Detach the subscription. Idempotent. */
  close(): void;
  /** Write the current trace to disk. Safe to call multiple times. */
  flush(outPath?: string): void;
}

/**
 * Subscribe to an event source and accumulate a Perfetto-formatted trace.
 * The returned handle exposes the in-memory `PerfettoTrace` and a `close()`
 * that detaches plus flushes (when an `outPath` is configured).
 */
export function attachPerfettoSink(
  options: AttachPerfettoSinkOptions,
): PerfettoSinkHandle {
  const trace = new PerfettoTrace(options);
  const unsubscribe = options.source.subscribe((event) => trace.ingest(event));

  let closed = false;
  const flush = (overridePath?: string): void => {
    const path = overridePath ?? options.outPath;
    if (!path) return;
    // toJSON() renders still-open spans as instant markers without consuming
    // them, so flushing mid-run is non-destructive and safe to repeat.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(trace.toJSON()));
  };

  const flushOnExit = options.flushOnExit ?? options.outPath !== undefined;
  const exitHandler = (): void => {
    if (closed) return;
    try {
      flush();
    } catch {
      // beforeExit handlers must not throw — the trace is best-effort.
    }
  };
  if (flushOnExit) process.once("beforeExit", exitHandler);

  return {
    trace,
    close(): void {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (flushOnExit) process.removeListener("beforeExit", exitHandler);
      flush();
    },
    flush(overridePath?: string): void {
      flush(overridePath);
    },
  };
}
