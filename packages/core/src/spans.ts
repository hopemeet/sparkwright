// =============================================================================
// Span correlation (ADR-0008)
//
// SparkWright's event stream is a flat sequence of facts (ADR-0006). Spans
// are an OPTIONAL correlation layer on top: a stable id pair (traceId,
// spanId) that lets sinks rebuild a parent/child tree without pair-matching
// event names. Use `withSpan` to bracket work; child events emitted from
// inside `withSpan` inherit the active frame via AsyncLocalStorage.
//
// AI maintenance note: this module is intentionally tiny. If you find
// yourself adding span-shaped logic to event emitters, extend `withSpan`
// or add a sibling helper here instead of duplicating frame plumbing at
// call sites. See docs/adr/0008-span-correlation-and-trace-sinks.md.
// =============================================================================

import { AsyncLocalStorage } from "node:async_hooks";

// Type-only import — keeps spans.ts free of a runtime dependency on
// events.ts so the events.ts → spans.ts → events.ts cycle is resolved at
// module-load time. Do not change to a value import.
import type { EventEmitter, EventType, SparkwrightEvent } from "./events.js";
import {
  createSpanId,
  createTraceId,
  type SpanId,
  type TraceId,
} from "./ids.js";

/**
 * Private metadata key used by `withSpan` to thread the active span frame
 * from helper code into `EventLog.emit`. `EventLog` strips this key before
 * the event leaves the runtime. Extensions MUST NOT set this key directly —
 * use `withSpan` / `emitInSpan` instead.
 *
 * @internal
 */
export const SPAN_METADATA_KEY = "__span" as const;

export interface SpanFrame {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
}

/**
 * Agent-level semantic annotations for a span. Where `SpanFrame` answers
 * "how is this work correlated" (the mechanical parent/child tree), these
 * fields answer "what kind of work is this, and who/why" — the layer trace
 * viewers and replay tooling need to reason about agent behavior rather than
 * raw LLM/tool mechanics.
 *
 * All fields are optional and free-form; the runtime never branches on them.
 * They are written into the span's start AND end event metadata under the
 * stable keys in {@link SPAN_SEMANTIC_METADATA_KEYS} so any sink (Perfetto,
 * dashboards, audit) can group, color, and filter by them without re-deriving
 * intent from event names.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SpanSemantics {
  /**
   * Which agent / role produced this span — e.g. `"main"`, `"planner"`,
   * `"sub:reviewer"`. Lets multi-agent traces split into per-role lanes.
   */
  agentRole?: string;
  /**
   * Short rationale for why this tool/action was selected. Captures the
   * tool-selection policy decision so a reviewer can audit *why* the agent
   * acted, not just *that* it did.
   */
  toolSelectionReason?: string;
  /**
   * Coarse classification of the work — e.g. `"plan"`, `"act"`, `"observe"`,
   * `"reflect"`, `"delegate"`. Used to group/color spans by decision phase.
   */
  decisionKind?: string;
}

/**
 * Stable event-metadata keys the span semantics are written under. Exposed so
 * sinks and tests can read them without hard-coding the strings.
 *
 * @public
 */
export const SPAN_SEMANTIC_METADATA_KEYS = {
  agentRole: "agent.role",
  toolSelectionReason: "tool.selectionReason",
  decisionKind: "decision.kind",
} as const;

/**
 * Project {@link SpanSemantics} into a flat metadata bag keyed by
 * {@link SPAN_SEMANTIC_METADATA_KEYS}. Omits absent fields so they never
 * clutter the event envelope.
 */
export function semanticsToMetadata(
  semantics: SpanSemantics | undefined,
): Record<string, unknown> {
  if (!semantics) return {};
  const out: Record<string, unknown> = {};
  if (semantics.agentRole !== undefined) {
    out[SPAN_SEMANTIC_METADATA_KEYS.agentRole] = semantics.agentRole;
  }
  if (semantics.toolSelectionReason !== undefined) {
    out[SPAN_SEMANTIC_METADATA_KEYS.toolSelectionReason] =
      semantics.toolSelectionReason;
  }
  if (semantics.decisionKind !== undefined) {
    out[SPAN_SEMANTIC_METADATA_KEYS.decisionKind] = semantics.decisionKind;
  }
  return out;
}

const storage = new AsyncLocalStorage<SpanFrame>();

const SPAN_PHASE_START = "start";
const SPAN_PHASE_END = "end";

/** Return the active span frame, or undefined if no `withSpan` is on the stack. */
export function currentSpan(): SpanFrame | undefined {
  return storage.getStore();
}

/**
 * @internal — used by `EventLog` to read the ALS frame without taking a
 * public dependency on the storage instance.
 */
export function currentSpanFrame(): SpanFrame | undefined {
  return storage.getStore();
}

export interface WithSpanSpec {
  /** The event emitted when the span opens. */
  startType: EventType;
  /** The event emitted when the span closes successfully. */
  endType: EventType;
  /**
   * The event emitted when `fn` throws. Defaults to `endType` so simple
   * lifecycles (e.g. `tool.started` → `tool.completed`/`tool.failed`)
   * can be modelled with two `withSpan` arguments and a separate
   * `failType` only when truly different.
   */
  failType?: EventType;
  /**
   * Payload attached to BOTH start and end events. Pass an object that the
   * sink layer is willing to repeat; if the start and end payloads must
   * differ, use the lower-level `openSpan`/`closeSpan` pair (below).
   */
  payload?: unknown;
  /**
   * Metadata attached to BOTH start and end events. `withSpan` adds
   * `durationMs` to the end event automatically.
   */
  metadata?: Record<string, unknown>;
  /**
   * Agent-level semantic annotations (role / tool-selection reason / decision
   * kind). Written into both start and end event metadata under
   * {@link SPAN_SEMANTIC_METADATA_KEYS}. Explicit keys in `metadata` win on
   * collision.
   */
  semantics?: SpanSemantics;
  /**
   * Optional override for the trace id. When omitted, an active parent's
   * traceId is inherited; with no parent, a fresh trace id is allocated.
   */
  traceId?: TraceId;
}

/**
 * Bracket an async operation with a start / end event pair correlated by
 * a freshly-allocated `spanId`. Child events emitted from inside `fn`
 * (including across `await`, `setImmediate`, MCP callbacks, etc.)
 * automatically inherit the new frame via `AsyncLocalStorage`.
 *
 * Returns whatever `fn` resolves to. On throw, emits `failType` (or
 * `endType` if no `failType` was given) and re-throws — `withSpan` is
 * transparent to errors.
 */
export async function withSpan<T>(
  emitter: EventEmitter,
  spec: WithSpanSpec,
  fn: (frame: SpanFrame) => Promise<T> | T,
): Promise<T> {
  const parent = storage.getStore();
  const frame: SpanFrame = {
    traceId: spec.traceId ?? parent?.traceId ?? createTraceId(),
    spanId: createSpanId(),
    parentSpanId: parent?.spanId,
  };

  const startedAt = Date.now();
  const baseMetadata = {
    ...semanticsToMetadata(spec.semantics),
    ...(spec.metadata ?? {}),
  };
  const spanName = rootSpanName(spec.startType, spec.endType);
  emitter.emit(spec.startType, spec.payload ?? {}, {
    ...baseMetadata,
    spanPhase: SPAN_PHASE_START,
    spanName,
    [SPAN_METADATA_KEY]: frame,
  });

  try {
    const result = await storage.run(frame, () => fn(frame));
    emitter.emit(spec.endType, spec.payload ?? {}, {
      ...baseMetadata,
      durationMs: Date.now() - startedAt,
      spanPhase: SPAN_PHASE_END,
      spanName,
      [SPAN_METADATA_KEY]: frame,
    });
    return result;
  } catch (err) {
    const failType = spec.failType ?? spec.endType;
    const errInfo = errorMetadata(err);
    emitter.emit(failType, spec.payload ?? {}, {
      ...baseMetadata,
      durationMs: Date.now() - startedAt,
      // `error` stays a string for back-compat with v0.1 sinks; the
      // structured form (code/stack/...) is added under `errorDetails`
      // so trace sinks can triage without inflating the payload (which
      // is intentionally reused from the start event verbatim).
      error: errInfo.message,
      errorDetails: errInfo,
      spanPhase: SPAN_PHASE_END,
      spanName,
      [SPAN_METADATA_KEY]: frame,
    });
    throw err;
  }
}

/**
 * Synchronous variant of `withSpan` for pure-CPU bracketed work. Prefer
 * `withSpan` when `fn` performs any I/O — async wrapping carries the ALS
 * frame across continuations correctly, while this variant only covers
 * the synchronous execution of `fn`.
 */
export function withSpanSync<T>(
  emitter: EventEmitter,
  spec: WithSpanSpec,
  fn: (frame: SpanFrame) => T,
): T {
  const parent = storage.getStore();
  const frame: SpanFrame = {
    traceId: spec.traceId ?? parent?.traceId ?? createTraceId(),
    spanId: createSpanId(),
    parentSpanId: parent?.spanId,
  };

  const startedAt = Date.now();
  const baseMetadata = {
    ...semanticsToMetadata(spec.semantics),
    ...(spec.metadata ?? {}),
  };
  const spanName = rootSpanName(spec.startType, spec.endType);
  emitter.emit(spec.startType, spec.payload ?? {}, {
    ...baseMetadata,
    spanPhase: SPAN_PHASE_START,
    spanName,
    [SPAN_METADATA_KEY]: frame,
  });

  try {
    const result = storage.run(frame, () => fn(frame));
    emitter.emit(spec.endType, spec.payload ?? {}, {
      ...baseMetadata,
      durationMs: Date.now() - startedAt,
      spanPhase: SPAN_PHASE_END,
      spanName,
      [SPAN_METADATA_KEY]: frame,
    });
    return result;
  } catch (err) {
    const failType = spec.failType ?? spec.endType;
    const errInfo = errorMetadata(err);
    emitter.emit(failType, spec.payload ?? {}, {
      ...baseMetadata,
      durationMs: Date.now() - startedAt,
      // `error` stays a string for back-compat with v0.1 sinks; the
      // structured form (code/stack/...) is added under `errorDetails`
      // so trace sinks can triage without inflating the payload (which
      // is intentionally reused from the start event verbatim).
      error: errInfo.message,
      errorDetails: errInfo,
      spanPhase: SPAN_PHASE_END,
      spanName,
      [SPAN_METADATA_KEY]: frame,
    });
    throw err;
  }
}

/**
 * Run a function with an explicit span frame as the active context. Useful
 * for adapters bridging external frames (OTel `traceparent`, distributed
 * agent hand-offs) into the SparkWright event stream. Does not emit any
 * events — callers do that themselves with `emitInSpan` if needed.
 */
export function runWithSpan<T>(frame: SpanFrame, fn: () => T): T {
  return storage.run(frame, fn);
}

/**
 * Emit an instant event correlated with the currently active span. If no
 * span is on the stack, the event is emitted with no correlation — the
 * sink will treat it as a top-level fact. This is the canonical helper
 * for events that don't bracket work (e.g. `usage.updated`,
 * `context.cache_break.detected`, `tool.progress`).
 */
export function emitInSpan<TPayload>(
  emitter: EventEmitter,
  type: EventType,
  payload: TPayload,
  metadata: Record<string, unknown> = {},
): SparkwrightEvent<TPayload> {
  const frame = storage.getStore();
  if (frame) {
    return emitter.emit(type, payload, {
      ...metadata,
      [SPAN_METADATA_KEY]: frame,
    });
  }
  return emitter.emit(type, payload, metadata);
}

/**
 * Open a span manually without enclosing a function. Returns the new frame
 * and a `close()` continuation that emits the matching end event. Prefer
 * `withSpan` when possible — manual lifecycles bypass the ALS guarantee
 * that children inherit the parent, so the caller is responsible for
 * threading the frame via `runWithSpan` or passing it explicitly.
 *
 * Intended for long-lived spans whose start and end are necessarily in
 * different scopes (background `Task` lifecycles, streaming model
 * requests where the response handler is detached).
 */
export function openSpan(
  emitter: EventEmitter,
  spec: {
    startType: EventType;
    payload?: unknown;
    metadata?: Record<string, unknown>;
    semantics?: SpanSemantics;
    traceId?: TraceId;
  },
): {
  frame: SpanFrame;
  close: (
    endType: EventType,
    payload?: unknown,
    metadata?: Record<string, unknown>,
  ) => void;
} {
  const parent = storage.getStore();
  const frame: SpanFrame = {
    traceId: spec.traceId ?? parent?.traceId ?? createTraceId(),
    spanId: createSpanId(),
    parentSpanId: parent?.spanId,
  };
  const startedAt = Date.now();
  const baseMetadata = {
    ...semanticsToMetadata(spec.semantics),
    ...(spec.metadata ?? {}),
  };
  const spanName = rootSpanName(spec.startType);
  emitter.emit(spec.startType, spec.payload ?? {}, {
    ...baseMetadata,
    spanPhase: SPAN_PHASE_START,
    spanName,
    [SPAN_METADATA_KEY]: frame,
  });
  let closed = false;
  return {
    frame,
    close(endType, payload, metadata) {
      if (closed) return;
      closed = true;
      // Merge: open-time metadata is the base; close-time overrides win
      // per-key. Earlier code used `metadata ?? baseMetadata`, which
      // silently dropped every open-time key whenever the caller passed
      // any close metadata at all — breaking `withSpan`'s symmetry.
      emitter.emit(endType, payload ?? spec.payload ?? {}, {
        ...baseMetadata,
        ...(metadata ?? {}),
        durationMs: Date.now() - startedAt,
        spanPhase: SPAN_PHASE_END,
        spanName: rootSpanName(spec.startType, endType),
        [SPAN_METADATA_KEY]: frame,
      });
    },
  };
}

function errorMetadata(err: unknown): {
  message: string;
  code?: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const codeValue = (err as { code?: unknown }).code;
    const code = typeof codeValue === "string" ? codeValue : undefined;
    return {
      message: err.message,
      ...(code ? { code } : {}),
      ...(typeof err.stack === "string"
        ? { stack: err.stack.split("\n").slice(0, 5).join("\n") }
        : {}),
    };
  }
  return { message: String(err) };
}

function rootSpanName(startType: EventType, endType?: EventType): string {
  const startRoot = stripLifecycleSuffix(startType);
  if (!endType) return startRoot;
  const endRoot = stripLifecycleSuffix(endType);
  return startRoot === endRoot ? startRoot : `${startType} -> ${endType}`;
}

function stripLifecycleSuffix(type: EventType): string {
  for (const suffix of [
    ".requested",
    ".started",
    ".completed",
    ".failed",
    ".cancelled",
  ]) {
    if (type.endsWith(suffix)) return type.slice(0, -suffix.length);
  }
  return type;
}
