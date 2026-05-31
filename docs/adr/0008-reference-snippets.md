# ADR 0008 — Reference Snippets

Companion to [0008-span-correlation-and-trace-sinks.md](./0008-span-correlation-and-trace-sinks.md).
These are illustrative sketches, not committed source. They show the intended
shape of the implementation so reviewers can evaluate the ADR concretely.

## `packages/core/src/spans.ts` (sketch)

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { ulid } from "./ids.js"; // or whatever id helper core already exposes
import type { EventEmitter, EventType } from "./events.js";

export type SpanId = string & { __brand: "SpanId" };
export type TraceId = string & { __brand: "TraceId" };

interface SpanFrame {
  traceId: TraceId;
  spanId: SpanId;
  parentSpanId?: SpanId;
}

const als = new AsyncLocalStorage<SpanFrame>();

export function currentSpan(): SpanFrame | undefined {
  return als.getStore();
}

export interface WithSpanSpec {
  startType: EventType;
  endType: EventType;
  failType?: EventType;
  payload?: unknown;
  metadata?: Record<string, unknown>;
}

export async function withSpan<T>(
  emitter: EventEmitter,
  spec: WithSpanSpec,
  fn: (frame: SpanFrame) => Promise<T> | T,
): Promise<T> {
  const parent = als.getStore();
  const frame: SpanFrame = {
    traceId: parent?.traceId ?? (ulid() as TraceId),
    spanId: ulid() as SpanId,
    parentSpanId: parent?.spanId,
  };

  const startedAt = Date.now();
  emit(emitter, spec.startType, spec.payload, spec.metadata, frame);

  try {
    const result = await als.run(frame, () => fn(frame));
    emit(
      emitter,
      spec.endType,
      spec.payload,
      { ...spec.metadata, durationMs: Date.now() - startedAt },
      frame,
    );
    return result;
  } catch (err) {
    const failType = spec.failType ?? spec.endType;
    emit(
      emitter,
      failType,
      spec.payload,
      {
        ...spec.metadata,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
      frame,
    );
    throw err;
  }
}

function emit(
  emitter: EventEmitter,
  type: EventType,
  payload: unknown,
  metadata: Record<string, unknown> | undefined,
  frame: SpanFrame,
) {
  // EventEmitter.emit is extended in v0.2 to accept span fields on the
  // metadata or as a fourth argument; the exact API is decided in
  // implementation review. Pseudocode here:
  emitter.emit(type, payload ?? {}, {
    ...(metadata ?? {}),
    __span: frame, // EventLog lifts these onto the envelope
  });
}
```

Key points:

- `__span` on metadata is a private channel between `withSpan` and
  `EventLog`. `EventLog` reads it, strips it from metadata, and assigns
  the three envelope fields. This avoids changing the `EventEmitter`
  signature (`emit(type, payload, metadata)`) and keeps the
  `BufferedEmitter` contract intact.
- Children emitted via plain `emit` from inside `fn` do not automatically
  get correlated. To attach them, callers either pass through `withSpan`
  or read `currentSpan()` and merge into metadata. A follow-up helper
  `emitInSpan(emitter, type, payload, metadata?)` may be added for the
  instant-event case.

## `packages/trace-perfetto/src/sink.ts` (sketch)

```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventLog, SparkwrightEvent } from "@sparkwright/core";

interface PerfettoEvent {
  name: string;
  cat: string;
  ph: "X" | "i";
  ts: number; // microseconds
  dur?: number; // microseconds
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

const SPAN_END_SUFFIXES = [".completed", ".failed", ".cancelled"];

export function attachPerfettoSink(opts: {
  eventLog: EventLog;
  outPath: string;
}): () => void {
  const open = new Map<string, { startedUs: number; ev: SparkwrightEvent }>();
  const events: PerfettoEvent[] = [];

  const unsubscribe = opts.eventLog.subscribe((ev) => {
    const ts = Date.parse(ev.timestamp) * 1000;
    const spanId = ev.spanId;

    if (spanId && ev.type.endsWith(".started")) {
      open.set(spanId, { startedUs: ts, ev });
      return;
    }

    if (spanId && SPAN_END_SUFFIXES.some((s) => ev.type.endsWith(s))) {
      const start = open.get(spanId);
      if (start) {
        open.delete(spanId);
        events.push({
          name: start.ev.type.replace(/\.started$/, ""),
          cat: start.ev.type.split(".")[0] ?? "span",
          ph: "X",
          ts: start.startedUs,
          dur: ts - start.startedUs,
          pid: 1,
          tid: hashTid(ev.metadata?.["agent.name"] ?? "main"),
          args: { ...(start.ev.payload as object), end: ev.payload },
        });
      }
      return;
    }

    // Instant event
    events.push({
      name: ev.type,
      cat: ev.type.split(".")[0] ?? "instant",
      ph: "i",
      ts,
      pid: 1,
      tid: hashTid(ev.metadata?.["agent.name"] ?? "main"),
      args: { payload: ev.payload, metadata: ev.metadata },
    });
  });

  // Write on process exit / Run completion
  const flush = () => {
    writeFileSync(opts.outPath, JSON.stringify({ traceEvents: events }));
  };
  process.once("beforeExit", flush);

  return () => {
    unsubscribe();
    process.removeListener("beforeExit", flush);
    flush();
  };
}

function hashTid(name: unknown): number {
  const s = String(name);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 1_000_000;
}
```

Notes for the implementation PR:

- Sub-agent rendering uses `pid` = parent agent identity. Skipped in this
  sketch; landed alongside the `task.*` migration to `withSpan` so the
  `agent.name` / `agent.parentId` metadata is consistently populated.
- The sink degrades gracefully for events without `spanId`: they become
  instant (`ph: "i"`) markers instead of being dropped.
- Output format matches the Chrome Trace Event spec consumed by
  `ui.perfetto.dev`; no schema of our own.
