// AI maintenance note: EventType is the canonical event vocabulary. Adding
// a type here is a protocol change: also update schemas/event.schema.json,
// docs/PROTOCOL.md (event list) and docs/PROTOCOL_CHANGELOG.md (Unreleased).
// Prefer reusing an existing type with new metadata over adding a new one.

import {
  createEventId,
  createTraceId,
  type EventId,
  type RunId,
  type SpanId,
  type TraceId,
} from "./ids.js";
import { performance } from "node:perf_hooks";

import { currentSpanFrame, SPAN_METADATA_KEY } from "./spans.js";

/**
 * High-resolution, process-monotonic microseconds for the event timeline.
 * `timestamp` (ISO) only carries millisecond precision, which collapses fast
 * operations onto the same instant and yields `dur: 0` spans in trace sinks.
 * `performance.now()` shares one origin (`performance.timeOrigin`) across every
 * EventLog in the process, so these values are directly comparable within a
 * trace without being epoch-anchored — exactly what Perfetto's microsecond
 * `ts` axis needs. Not wall-clock: do not use for absolute time (that's
 * `timestamp`).
 */
function monotonicMicros(): number {
  return Math.round(performance.now() * 1000);
}

export type EventType =
  | "run.created"
  | "run.started"
  | "run.resumed"
  | "run.waiting_credentials"
  | "run.credentials_refreshed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.cancel_requested"
  | "run.command.enqueued"
  | "run.command.applied"
  // Out-of-band notifications injected into the next turn by a
  // NotificationSource (e.g. task-completion queue, inbound chat). Owned by
  // the core/shared notification contract. See drainNotificationSources().
  | "run.notification.injected"
  | "run.notification.source_failed"
  | "run.state_transition.rejected"
  | "run.budget.checked"
  | "run.budget.exceeded"
  | "plan.created"
  | "plan.reviewed"
  | "plan.step.started"
  | "plan.step.completed"
  | "plan.step.failed"
  // Span bracket for one turn's model phase (ADR-0008). Wraps every attempt's
  // `model.requested`/`model.retrying`/`model.stream.*` plus the turn's
  // `model.completed` under a single span, so a trace reads as
  // run → model.turn → {attempts}. Carries no model output itself — it is a
  // correlation envelope; the per-attempt and completion events keep the data.
  | "model.turn.started"
  | "model.turn.completed"
  | "model.requested"
  | "model.completed"
  | "model.retrying"
  | "model.stream.started"
  | "model.stream.chunk"
  // Synthesized by the trace sink at non-debug levels: one event per stream
  // collapsing all `model.stream.chunk` text_deltas into the full text plus
  // first/last token timing. Keeps token-level signal (TTFT, stream duration)
  // without persisting one event per token. Never emitted onto the live bus —
  // it exists only in the persisted trace. See FileRunStore.flushStreamText().
  | "model.stream.text"
  | "model.stream.completed"
  | "model.stream.failed"
  | "model.stream.timeout"
  // Assistant text produced by the model but not used as a final answer.
  // Currently emitted by `@sparkwright/streaming-runtime` when an eager tool
  // executed in the same turn and the model already produced commentary —
  // the loop continues to let the model reconcile against the tool result,
  // and this event keeps that commentary visible in the trace.
  | "model.assistant_text"
  | "context.assembled"
  | "context.compaction_requested"
  | "context.compaction.started"
  | "context.compaction.completed"
  | "context.compaction.failed"
  | "skill.indexed"
  | "skill.failed"
  | "skill.loaded"
  | "capability.index.failed"
  | "capability.mutation.completed"
  | "mcp.server.prepared"
  | "agent.profile.derived"
  | "agent.routing.evaluated"
  | "prompt.built"
  | "validation.started"
  | "validation.completed"
  | "validation.failed"
  | "tool.requested"
  | "tool.batch.requested"
  | "tool.batch.completed"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "tool.failed"
  | "tool.replay_risk"
  | "storage.degraded"
  | "storage.recovered"
  | "approval.requested"
  | "approval.resolved"
  | "artifact.created"
  | "workspace.read"
  | "workspace.read.denied"
  | "workspace.anchored_read"
  | "workspace.anchored_edit.requested"
  | "workspace.anchored_edit.verified"
  | "workspace.anchored_edit.rejected"
  | "workspace.write.requested"
  | "workspace.write.denied"
  | "workspace.write.completed"
  | "workspace.write.skipped"
  | "workspace.write.untracked_access_granted"
  | "usage.updated"
  | "hook.failed"
  | "workflow_hook.started"
  | "workflow_hook.completed"
  | "workflow_hook.blocked"
  | "workflow_hook.failed"
  | "workflow.started"
  | "workflow.node.started"
  | "workflow.node.completed"
  | "workflow.waiting"
  | "workflow.interrupted"
  | "workflow.completed"
  | "workflow.failed"
  | "workflow.cancelled"
  | "extension.process.started"
  | "extension.process.progress"
  | "extension.process.completed"
  | "extension.process.failed"
  | "interaction.requested"
  | "interaction.resolved"
  // Prompt-cache integrity. Emitted in dev/debug trace levels when a context
  // item previously marked stable is observed to have changed between turns.
  // Zero-cost in production — invaluable for AI maintainers tracking down
  // silent cache-break regressions. See docs/CONTEXT_PLANE.md.
  | "context.cache_break.detected"
  // Sub-agent lifecycle as seen by the PARENT run. Emitted by
  // `@sparkwright/agent-runtime`'s `spawnSubAgent`. The child's own
  // `run.*` events still flow through its own EventLog; these mirror the
  // tri-state lifecycle (requested → started → completed/failed) on the
  // parent so a single trace tree captures sub-agent fan-out, including
  // children that sit in a queue between `requested` and `started` when
  // an upstream concurrency limit is saturated.
  | "subagent.requested"
  | "subagent.started"
  | "subagent.completed"
  | "subagent.failed"
  // Background-task lifecycle. Owned by `@sparkwright/agent-runtime` Tasks
  // (TaskManager / TaskStore). Tasks are spawned BY a run and live alongside
  // it — they are NOT new runs. See packages/agent-runtime/src/tasks/.
  | "task.created"
  | "task.started"
  | "task.output"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  // User-configurable hooks (settings.json-style shell hooks). Emitted by a
  // host-supplied `UserHookRunner`. Core defines the contract — the runner
  // is injected by the embedder. See hooks.ts for UserHookRunner.
  | "user_hook.invoked"
  | "user_hook.progress"
  | "user_hook.completed"
  | "user_hook.failed";

/**
 * Shared process output summary for host-controlled external invocations.
 * Full output may be materialized separately through `artifact.created`;
 * traces should keep only bounded previews inline.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ProcessOutputSummary {
  stdoutPreview?: string;
  stderrPreview?: string;
  /** @reserved Public process-output byte count consumed by trace viewers. */
  stdoutBytes: number;
  /** @reserved Public process-output byte count consumed by trace viewers. */
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  artifactIds?: string[];
}

/**
 * Path-free sandbox summary safe for trace payloads.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SandboxSummary {
  sandboxed: boolean;
  mode?: string;
  runtime?: string;
  networkMode?: string;
  available?: boolean;
  /** @reserved Public sandbox fallback reason consumed by diagnostics UIs. */
  fallbackReason?: string;
  /** @reserved Public sandbox enforcement flag consumed by diagnostics UIs. */
  enforced?: boolean;
}

/**
 * Common invocation identity shared by extension.process.*, task.*, user hook,
 * and sub-agent process summaries.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ProcessInvocationBase {
  invocationId: string;
  name: string;
  kind:
    | "workflow_hook"
    | "skill_script"
    | "user_hook"
    | "external_agent"
    | "task"
    | "custom";
  runtime: "shell" | "python" | "node" | "tsx" | "custom";
  /** @reserved Public process command preview consumed by trace viewers. */
  commandPreview?: string;
  /** @reserved Public process argument preview consumed by trace viewers. */
  argsPreview?: string[];
  cwd?: string;
}

export interface SparkwrightEvent<TPayload = unknown> {
  id: EventId;
  runId: RunId;
  type: EventType;
  timestamp: string;
  sequence: number;
  payload: TPayload;
  metadata: Record<string, unknown>;
  /**
   * Optional process-monotonic microseconds (from `performance.now()`), used
   * by trace sinks for sub-millisecond ordering and span durations that the
   * millisecond-precision `timestamp` cannot express. Shares one origin across
   * all EventLogs in the process; NOT wall-clock. Absent on events from
   * pre-v0.2 emitters — sinks must fall back to `timestamp`.
   */
  monotonicUs?: number;
  /**
   * Optional run-level trace id. Sinks may synthesize from `runId` when
   * absent. Added by ADR-0008 (protocol v0.2).
   */
  traceId?: TraceId;
  /**
   * Optional id for the bracketed unit of work. Paired `*.started` and
   * `*.completed` / `*.failed` events for the same operation share the same
   * `spanId`. Instant events carry the enclosing span's id.
   */
  spanId?: SpanId;
  /** Optional parent in the trace tree, captured from AsyncLocalStorage. */
  parentSpanId?: SpanId;
}

/**
 * Minimal emit surface that extension packages can consume without taking
 * a hard dependency on the full `EventLog`. `EventLog` itself satisfies this
 * shape; product shells may also provide a wrapped, scoped emitter.
 */
export interface EventEmitter {
  emit<TPayload>(
    type: EventType,
    payload: TPayload,
    metadata?: Record<string, unknown>,
  ): SparkwrightEvent<TPayload>;
}

/**
 * Strip the private `__span` channel (set by `withSpan`) from a caller-supplied
 * metadata bag. The frame, if present, is returned alongside the cleaned
 * metadata so callers can populate envelope fields.
 *
 * Exported as `@internal` for the `EventLog` and `BufferedEmitter` to share
 * one implementation; extensions should not read this key directly.
 */
function extractSpanFrame(metadata: Record<string, unknown>): {
  frame: SpanFrameSnapshot | undefined;
  cleanedMetadata: Record<string, unknown>;
} {
  if (!(SPAN_METADATA_KEY in metadata)) {
    return { frame: undefined, cleanedMetadata: metadata };
  }
  const frame = metadata[SPAN_METADATA_KEY] as SpanFrameSnapshot | undefined;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key !== SPAN_METADATA_KEY) cleaned[key] = value;
  }
  return { frame, cleanedMetadata: cleaned };
}

interface SpanFrameSnapshot {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
}

/**
 * @internal Reference `EventEmitter` implementation. Public API is the
 * `EventEmitter` / `BufferedEmitter` interface plus `createBufferedEmitter`.
 */
export class EventLog implements EventEmitter {
  private sequence = 0;
  private readonly events: SparkwrightEvent[] = [];
  private readonly listeners = new Set<(event: SparkwrightEvent) => void>();
  private readonly defaultTraceId: TraceId;

  constructor(
    private readonly runId: RunId,
    options: { sequence?: number } = {},
  ) {
    if (options.sequence !== undefined) {
      if (!Number.isInteger(options.sequence) || options.sequence < 0) {
        throw new Error("EventLog sequence must be a non-negative integer.");
      }
      this.sequence = options.sequence;
    }
    this.defaultTraceId = createTraceId();
  }

  /**
   * The run-level trace id stamped onto every event that lacks an explicit
   * span frame. Exposed so the run loop can anchor a root span on the SAME
   * trace id — otherwise a `withSpan` opened with no parent would allocate a
   * fresh trace id and fragment the run across multiple traces. Read-only.
   */
  get traceId(): TraceId {
    return this.defaultTraceId;
  }

  get lastSequence(): number {
    return this.sequence;
  }

  emit<TPayload>(
    type: EventType,
    payload: TPayload,
    metadata: Record<string, unknown> = {},
  ): SparkwrightEvent<TPayload> {
    // Span correlation (ADR-0008): prefer an explicit frame injected via the
    // private `__span` metadata channel by `withSpan`; otherwise fall back to
    // the current AsyncLocalStorage frame. Strip the private key before the
    // event leaves the runtime.
    const { frame, cleanedMetadata } = extractSpanFrame(metadata);
    const effective = frame ?? currentSpanFrame();

    const event: SparkwrightEvent<TPayload> = {
      id: createEventId(),
      runId: this.runId,
      type,
      timestamp: new Date().toISOString(),
      monotonicUs: monotonicMicros(),
      sequence: ++this.sequence,
      payload,
      metadata: cleanedMetadata,
      traceId: effective?.traceId ?? this.defaultTraceId,
      spanId: effective?.spanId,
      parentSpanId: effective?.parentSpanId,
    };

    this.events.push(event as SparkwrightEvent);
    for (const listener of this.listeners) listener(event as SparkwrightEvent);
    return event;
  }

  all(): SparkwrightEvent[] {
    return [...this.events];
  }

  subscribe(listener: (event: SparkwrightEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe with synchronous replay of all events emitted so far. Used by
   * late-attached observers (user-hook runners, host bridges) that would
   * otherwise miss early lifecycle events such as `run.created` / `run.started`
   * because they wired up after the run began emitting. Replay is synchronous
   * and runs in original sequence order before the listener is added.
   */
  subscribeWithReplay(listener: (event: SparkwrightEvent) => void): () => void {
    for (const event of this.events) {
      try {
        listener(event);
      } catch {
        /* listener errors are the listener's problem; do not break replay */
      }
    }
    return this.subscribe(listener);
  }
}

/**
 * Buffering emitter for the pre-run extension preparation phase. Extension
 * helpers (skills, mcp-adapter, agent-runtime) typically run before
 * `createRun`, when no `EventLog` exists yet. The buffered emitter records
 * emits and can later `flush(eventLog)` them onto the run's real event log.
 */
export interface BufferedEmitter extends EventEmitter {
  flush(target: EventEmitter): void;
  drain(): Array<{
    type: EventType;
    payload: unknown;
    metadata: Record<string, unknown>;
  }>;
}

export function createBufferedEmitter(): BufferedEmitter {
  const buffer: Array<{
    type: EventType;
    payload: unknown;
    metadata: Record<string, unknown>;
  }> = [];

  return {
    emit<TPayload>(
      type: EventType,
      payload: TPayload,
      metadata: Record<string, unknown> = {},
    ): SparkwrightEvent<TPayload> {
      // Capture the span frame at emit time so the buffered entry is correctly
      // attributed even though flush() runs later, outside the original ALS
      // context. The `__span` key (if any) is preserved on the buffered
      // metadata; otherwise we snapshot from ALS.
      const buffered =
        SPAN_METADATA_KEY in metadata
          ? metadata
          : (() => {
              const frame = currentSpanFrame();
              return frame
                ? { ...metadata, [SPAN_METADATA_KEY]: frame }
                : metadata;
            })();
      buffer.push({ type, payload, metadata: buffered });
      const { frame, cleanedMetadata } = extractSpanFrame(buffered);
      return {
        id: "evt_buffered" as SparkwrightEvent["id"],
        runId: "" as SparkwrightEvent["runId"],
        type,
        timestamp: new Date().toISOString(),
        sequence: 0,
        payload,
        metadata: cleanedMetadata,
        traceId: frame?.traceId,
        spanId: frame?.spanId,
        parentSpanId: frame?.parentSpanId,
      };
    },
    flush(target: EventEmitter): void {
      while (buffer.length > 0) {
        const entry = buffer.shift()!;
        target.emit(entry.type, entry.payload, entry.metadata);
      }
    },
    drain() {
      const copy = buffer.slice();
      buffer.length = 0;
      return copy;
    },
  };
}
