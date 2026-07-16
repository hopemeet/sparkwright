// AI maintenance note: trace/session storage endpoint. This module may import
// trace-codec, but must not import diagnostics or session-consistency modules.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { PromptMessage } from "./context.js";
import type { SparkwrightEvent } from "./events.js";
import { assertSafePathSegment } from "./ids.js";
import type { RunStore, TraceSink } from "./storage.js";
import type {
  Artifact,
  RunCheckpointV1,
  RunRecord,
  RunResult,
} from "./types.js";
import {
  createTraceRedactor,
  filterTraceEvent,
  serializeEventJsonl,
  type TraceLevel,
  type TraceRedactor,
} from "./trace-codec.js";

export class MemoryTrace implements TraceSink {
  private readonly lines: string[] = [];

  append(event: SparkwrightEvent): void {
    this.lines.push(serializeEventJsonl(event));
  }

  /** TraceSink alias for `append`. */
  write(event: SparkwrightEvent): void {
    this.append(event);
  }

  toString(): string {
    return this.lines.join("");
  }
}

export interface FileRunStoreOptions {
  sessionRootDir?: string;
  sessionId: string;
  agentId?: string;
  traceLevel?: TraceLevel;
  redactor?: TraceRedactor;
  redact?: boolean;
  /**
   * When a disk append fails (ENOSPC / EROFS / permissions), keep the event
   * in an in-memory ring buffer instead of throwing. The runtime's own error
   * tolerance (see "tolerates runStore errors without breaking the run") will
   * still log; this buffer additionally lets a future successful append flush
   * the missed events so the on-disk trace is eventually consistent. Set to
   * `0` to disable buffering and propagate append errors.
   *
   * Default: 1000 events.
   */
  degradationBufferLimit?: number;
  /**
   * Invoked when an append fails and the event is buffered (or dropped due
   * to overflow). Embedders can use this to emit a `storage.degraded`
   * notification through their own event channel — the store itself never
   * synthesizes events.
   */
  onAppendError?: (info: {
    error: unknown;
    event: SparkwrightEvent;
    bufferedCount: number;
    droppedCount: number;
  }) => void;
  /**
   * Invoked exactly once each time the in-memory degradation buffer is
   * fully drained back to disk after a prior failure. Pairs with
   * `onAppendError` so embedders can emit a matching `storage.recovered`
   * follow-up to whatever `storage.degraded` they already emitted.
   */
  onDrainSuccess?: (info: {
    flushedCount: number;
    droppedCount: number;
  }) => void;
}

export interface SessionFileRunStoreFactoryOptions extends Omit<
  FileRunStoreOptions,
  "sessionId"
> {
  /**
   * Session identity supplied by the embedder, gateway, or host protocol.
   * This is routing identity, not a trace/span id.
   */
  sessionId: string;
}

/**
 * Create the standard session-scoped file store factory for `createRun`.
 *
 * This keeps product shells from hand-rolling the session trace layout and
 * accidentally diverging on session/run/agent identity rules.
 */
export function createSessionFileRunStoreFactory(
  options: SessionFileRunStoreFactoryOptions,
): (run: RunRecord) => FileRunStore {
  return (run) =>
    new FileRunStore(run, {
      ...options,
      sessionId: options.sessionId,
    });
}

/**
 * Running state for collapsing a contiguous segment of one stream's
 * `model.stream.chunk` events into a `model.stream.text` timing marker. A
 * same-run interleaved event closes the segment, so one model stream may emit
 * multiple markers. Identity (id/sequence/traceId/span) is taken from the FIRST
 * chunk so each merged event sorts in place of that chunk run; timing spans
 * first → last chunk in the segment. The streamed *text* itself is NOT
 * accumulated here — it is already carried by the terminal `model.completed`
 * event, so this marker holds only telemetry (chunk count + TTFT/duration) to
 * avoid serializing the full answer twice.
 */
interface StreamTimingAccumulator {
  chunkCount: number;
  firstEventId: SparkwrightEvent["id"];
  firstSequence: number;
  firstTimestamp: string;
  firstMonotonicUs?: number;
  lastTimestamp: string;
  lastMonotonicUs?: number;
  traceId: SparkwrightEvent["traceId"];
  spanId: SparkwrightEvent["spanId"];
  parentSpanId: SparkwrightEvent["parentSpanId"];
  metadata: Record<string, unknown>;
}

interface ProcessProgressAccumulator {
  count: number;
  head: unknown[];
  tail: unknown[];
}

const PROCESS_PROGRESS_HEAD_LIMIT = 5;
const PROCESS_PROGRESS_TAIL_LIMIT = 5;

/**
 * @internal Reference `RunStore` persisting session-scoped JSONL traces,
 * per-agent traces, per-run state, and artifacts. Prefer the `RunStore`
 * interface when extending.
 */
export class FileRunStore implements RunStore {
  readonly runDir: string;
  readonly artifactsDir: string;
  readonly tracePath: string;
  readonly resultPath: string;
  readonly traceLevel: TraceLevel;
  readonly sessionDir: string;
  readonly sessionTracePath: string;
  readonly transcriptPath: string;
  readonly blobsDir: string;
  readonly agentId: string;
  readonly agentDir: string;
  readonly agentTracePath: string;
  readonly agentTranscriptPath: string;
  private readonly redactor?: TraceRedactor;
  private readonly redactArtifacts: boolean;
  private readonly sessionId: string;
  private readonly degradationBufferLimit: number;
  private readonly onAppendError?: FileRunStoreOptions["onAppendError"];
  private readonly onDrainSuccess?: FileRunStoreOptions["onDrainSuccess"];
  private readonly degradedBuffer: SparkwrightEvent[] = [];
  private droppedDuringDegradation = 0;
  private hasBeenDegraded = false;
  // Hashes of leading system prefixes already written in full to the
  // transcript. The system prefix is regenerated identically on every model
  // call (and never read back to rebuild a prompt), so we store it once and
  // let later prompt entries reference it by hash instead of repeating it.
  private readonly seenSystemHashes = new Set<string>();
  // Per-run streaming-timing accumulation. At non-debug trace levels we
  // suppress the high-frequency `model.stream.chunk` events and emit one
  // `model.stream.text` timing marker per contiguous segment instead (see
  // writeEventToDisk).
  // Keyed by runId because a run's steps stream sequentially (started → chunks →
  // completed); a new `model.stream.started` resets the slot.
  private readonly streamAccumulators = new Map<
    string,
    StreamTimingAccumulator
  >();
  private readonly processProgressAccumulators = new Map<
    string,
    ProcessProgressAccumulator
  >();

  constructor(run: RunRecord, options: FileRunStoreOptions) {
    assertSafePathSegment(options.sessionId, "session id");
    const rootDir = options.sessionRootDir ?? ".sparkwright/sessions";
    this.traceLevel = options.traceLevel ?? "standard";
    this.redactor =
      options.redactor ??
      (options.redact === false ? undefined : createTraceRedactor());
    this.redactArtifacts = options.redact !== false;
    this.sessionId = options.sessionId;
    this.degradationBufferLimit = options.degradationBufferLimit ?? 1000;
    this.onAppendError = options.onAppendError;
    this.onDrainSuccess = options.onDrainSuccess;

    const agentId =
      options.agentId ?? stringMetadata(run.metadata, "agentId") ?? "main";
    assertSafePathSegment(agentId, "agent id");
    this.agentId = agentId;
    this.sessionDir = join(rootDir, options.sessionId);
    this.sessionTracePath = join(this.sessionDir, "trace.jsonl");
    this.transcriptPath = join(this.sessionDir, "transcript.jsonl");
    this.blobsDir = join(this.sessionDir, "blobs");
    this.agentDir = join(this.sessionDir, "agents", agentId);
    this.agentTracePath = join(this.agentDir, "trace.jsonl");
    this.agentTranscriptPath = join(this.agentDir, "transcript.jsonl");
    this.runDir = join(this.agentDir, "runs", run.id);
    this.artifactsDir = join(this.sessionDir, "artifacts");
    this.tracePath = this.sessionTracePath;

    this.resultPath = join(this.runDir, "result.json");

    mkdirSync(this.artifactsDir, { recursive: true });
    mkdirSync(this.blobsDir, { recursive: true });
    mkdirSync(this.agentDir, { recursive: true });
    writeIfMissing(this.sessionTracePath, "");
    writeIfMissing(this.transcriptPath, "");
    writeIfMissing(this.agentTracePath, "");
    writeIfMissing(this.agentTranscriptPath, "");
    this.writeSessionRecord(run);
    this.writeAgentRecord(run);
    mkdirSync(this.runDir, { recursive: true });
    this.writeTracePointer(run);
    // Never overwrite an existing run.json: re-opening a `FileRunStore`
    // for replay/loadEvents/SessionRunStore's lazy inner-store path used
    // to clobber a finished `run.json` back to a stale `running` status,
    // leaving result.json and run.json on disk in conflicting states.
    // The state machine still rewrites run.json on `finish()` for the
    // legitimate completion path.
    writeIfMissing(
      join(this.runDir, "run.json"),
      `${JSON.stringify(run, null, 2)}\n`,
    );
  }

  append(event: SparkwrightEvent): void {
    try {
      // Best-effort flush of any events buffered during a prior outage.
      // If the disk is still down this will throw and the new event lands
      // in the buffer alongside them, preserving order.
      this.drainDegradedBufferIfAny();
      this.writeEventToDisk(event);
    } catch (cause) {
      if (this.degradationBufferLimit <= 0) {
        throw cause;
      }
      this.bufferDegradedEvent(event, cause);
      return;
    }

    if (event.type === "artifact.created") {
      this.materializeArtifact(event.payload as Artifact);
    }
  }

  private writeEventToDisk(event: SparkwrightEvent): void {
    const eventsToWrite = this.prepareEventsForPersistence(event);
    if (eventsToWrite.length === 0) return;
    const traceEvents = eventsToWrite.map((item) =>
      this.prepareTraceEvent(item),
    );
    const serialized = traceEvents.map(serializeEventJsonl).join("");
    appendFileSync(this.tracePath, serialized, "utf8");
    appendFileSync(this.agentTracePath, serialized, "utf8");
    this.acknowledgePersistedStreamSegments(eventsToWrite);
    for (const item of eventsToWrite) {
      this.appendTranscriptEvent(this.prepareTranscriptEvent(item));
    }
  }

  private prepareEventsForPersistence(
    event: SparkwrightEvent,
  ): SparkwrightEvent[] {
    let eventToWrite = event;
    // Collapse high-frequency stream chunks into synthesized
    // `model.stream.text` segment markers at non-debug levels: buffer each
    // text_delta, suppress the individual chunk, and flush the merged event
    // when the stream terminates. `debug` keeps raw chunks for token-level
    // analysis.
    if (this.traceLevel !== "debug") {
      switch (event.type) {
        case "model.stream.started":
          // A fresh stream for this run — drop any orphaned accumulator (e.g.
          // a prior stream that crashed before terminating) and fall through
          // to persist the `started` event normally.
          this.streamAccumulators.delete(event.runId);
          break;
        case "model.stream.chunk":
          this.accumulateStreamChunk(event);
          return []; // not persisted individually
        case "model.stream.completed":
        case "model.stream.failed":
        case "model.stream.timeout":
          return [...this.flushStreamSegment(event), event];
        case "extension.process.started":
          this.resetProcessProgress(event);
          break;
        case "extension.process.progress":
          this.accumulateProcessProgress(event);
          return []; // not persisted individually at standard level
        case "extension.process.completed":
        case "extension.process.failed":
          eventToWrite = this.withProcessProgressSummary(event);
          break;
        default:
          break;
      }
    }

    if (this.traceLevel !== "debug") {
      // A same-run event can interleave with model chunks (background task
      // output is the common case). Flush the current contiguous chunk segment
      // before that event. One marker cannot represent non-contiguous sequence
      // ranges using only chunkCount, and delaying it until stream terminal
      // would make the JSONL append order move backwards.
      const segment = this.flushStreamSegment(eventToWrite);
      if (segment.length > 0) return [...segment, eventToWrite];
    }
    return [eventToWrite];
  }

  private accumulateStreamChunk(event: SparkwrightEvent): void {
    // We no longer concatenate the streamed text here — the full answer is
    // already carried by the terminal `model.completed`. Every
    // chunk (text-delta, tool-call, usage, stop) still bumps the count and
    // extends the stream's time span so the marker reports TTFT/duration.
    const existing = this.streamAccumulators.get(event.runId);
    if (!existing) {
      this.streamAccumulators.set(event.runId, {
        chunkCount: 1,
        firstEventId: event.id,
        firstSequence: event.sequence,
        firstTimestamp: event.timestamp,
        firstMonotonicUs: event.monotonicUs,
        lastTimestamp: event.timestamp,
        lastMonotonicUs: event.monotonicUs,
        traceId: event.traceId,
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        metadata: event.metadata ?? {},
      });
      return;
    }
    existing.chunkCount += 1;
    existing.lastTimestamp = event.timestamp;
    existing.lastMonotonicUs = event.monotonicUs;
  }

  private flushStreamSegment(reference: SparkwrightEvent): SparkwrightEvent[] {
    const acc = this.streamAccumulators.get(reference.runId);
    if (!acc) return [];
    // Keep the accumulator until the synthesized segment is durably appended.
    // acknowledgePersistedStreamSegments removes the matching firstEventId
    // after the write succeeds, preserving the marker across degraded-buffer
    // replay without emitting it twice. If later chunks arrive while disk is
    // degraded, replay may conservatively fold them into this marker, so the
    // rare failure path preserves sequence order but treats per-segment
    // chunkCount/duration as approximate telemetry.
    const step =
      isRecord(reference.payload) && typeof reference.payload.step === "number"
        ? reference.payload.step
        : undefined;
    const streamDurationUs =
      acc.firstMonotonicUs !== undefined && acc.lastMonotonicUs !== undefined
        ? acc.lastMonotonicUs - acc.firstMonotonicUs
        : undefined;
    const merged: SparkwrightEvent = {
      id: acc.firstEventId,
      runId: reference.runId,
      type: "model.stream.text",
      timestamp: acc.lastTimestamp,
      sequence: acc.firstSequence,
      monotonicUs: acc.lastMonotonicUs,
      traceId: acc.traceId,
      spanId: acc.spanId,
      parentSpanId: acc.parentSpanId,
      payload: {
        step,
        chunkCount: acc.chunkCount,
        firstTokenAt: acc.firstTimestamp,
        lastTokenAt: acc.lastTimestamp,
        firstTokenMonotonicUs: acc.firstMonotonicUs,
        lastTokenMonotonicUs: acc.lastMonotonicUs,
        streamDurationUs,
      },
      metadata: acc.metadata,
    };
    return [merged];
  }

  private acknowledgePersistedStreamSegments(
    events: readonly SparkwrightEvent[],
  ): void {
    for (const event of events) {
      if (event.type !== "model.stream.text") continue;
      const current = this.streamAccumulators.get(event.runId);
      if (current?.firstEventId === event.id) {
        this.streamAccumulators.delete(event.runId);
      }
    }
  }

  private resetProcessProgress(event: SparkwrightEvent): void {
    const key = processInvocationKey(event);
    if (key) this.processProgressAccumulators.delete(key);
  }

  private accumulateProcessProgress(event: SparkwrightEvent): void {
    const key = processInvocationKey(event);
    if (!key) return;
    const existing = this.processProgressAccumulators.get(key) ?? {
      count: 0,
      head: [],
      tail: [],
    };
    const snapshot = processProgressSnapshot(event);
    existing.count += 1;
    if (existing.head.length < PROCESS_PROGRESS_HEAD_LIMIT) {
      existing.head.push(snapshot);
    } else {
      existing.tail.push(snapshot);
      if (existing.tail.length > PROCESS_PROGRESS_TAIL_LIMIT) {
        existing.tail.shift();
      }
    }
    this.processProgressAccumulators.set(key, existing);
  }

  private withProcessProgressSummary(
    event: SparkwrightEvent,
  ): SparkwrightEvent {
    const key = processInvocationKey(event);
    if (!key) return event;
    const acc = this.processProgressAccumulators.get(key);
    if (!acc) return event;
    this.processProgressAccumulators.delete(key);
    if (!isRecord(event.payload)) return event;
    const progressTail =
      acc.tail.length > 0
        ? acc.tail
        : acc.head.slice(PROCESS_PROGRESS_HEAD_LIMIT);
    return {
      ...event,
      payload: {
        ...event.payload,
        progressCount:
          typeof event.payload.progressCount === "number"
            ? event.payload.progressCount
            : acc.count,
        progressDropped:
          typeof event.payload.progressDropped === "number"
            ? event.payload.progressDropped
            : 0,
        progressHead: acc.head,
        progressTail,
      },
    };
  }

  private bufferDegradedEvent(event: SparkwrightEvent, error: unknown): void {
    if (this.degradedBuffer.length >= this.degradationBufferLimit) {
      // Drop the oldest to make room — keep most recent context, which is
      // generally more useful for diagnosing the outage than the earliest
      // queued events.
      this.degradedBuffer.shift();
      this.droppedDuringDegradation += 1;
    }
    this.degradedBuffer.push(event);
    this.hasBeenDegraded = true;
    this.onAppendError?.({
      error,
      event,
      bufferedCount: this.degradedBuffer.length,
      droppedCount: this.droppedDuringDegradation,
    });
  }

  private drainDegradedBufferIfAny(): void {
    if (this.degradedBuffer.length === 0) return;
    // Move events out before writing so a mid-drain failure doesn't infinite-
    // loop us. Anything that fails goes back to the head of the buffer.
    const pending = this.degradedBuffer.splice(0, this.degradedBuffer.length);
    const initialCount = pending.length;
    for (let i = 0; i < pending.length; i += 1) {
      try {
        this.writeEventToDisk(pending[i]);
      } catch (cause) {
        // Re-queue the failed event plus everything after it, preserve order.
        this.degradedBuffer.unshift(...pending.slice(i));
        throw cause;
      }
    }
    // Drain succeeded fully. Notify exactly once per recovery (only if we
    // were previously degraded — first-ever drain of an empty buffer is
    // guarded by the length check at top).
    if (this.hasBeenDegraded) {
      this.hasBeenDegraded = false;
      const droppedCount = this.droppedDuringDegradation;
      this.droppedDuringDegradation = 0;
      this.onDrainSuccess?.({ flushedCount: initialCount, droppedCount });
    }
  }

  /**
   * Number of events currently held in the degradation buffer (i.e. trace
   * appends that failed and have not yet been flushed). Exposed for tests
   * and host diagnostics; production callers usually just consume the
   * `onAppendError` callback.
   */
  get degradedBufferSize(): number {
    return this.degradedBuffer.length;
  }

  finish(run: RunRecord, result: RunResult): void {
    atomicWriteFileSync(
      join(this.runDir, "run.json"),
      `${JSON.stringify(run, null, 2)}\n`,
    );
    atomicWriteFileSync(
      this.resultPath,
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }

  /**
   * Path to the latest persisted checkpoint, if any. Pair with
   * {@link loadCheckpointFromRunDir} to read back from disk.
   */
  get checkpointPath(): string {
    return join(this.runDir, "checkpoint.json");
  }

  /**
   * Atomically persist a {@link RunCheckpointV1} alongside the run's
   * trace/result. Called by the runtime through `RunHandle.persistCheckpoint`
   * (and the optional auto-checkpoint loop), but is safe to call directly
   * from host code as well — overwrites the previous snapshot.
   */
  saveCheckpoint(checkpoint: RunCheckpointV1): void {
    atomicWriteFileSync(
      this.checkpointPath,
      `${JSON.stringify(checkpoint, null, 2)}\n`,
    );
  }

  async *loadEvents(runId: RunRecord["id"]): AsyncIterable<SparkwrightEvent> {
    const trace = await readFile(this.sessionTracePath, "utf8");

    for (const [index, line] of trace.split(/\r?\n/).entries()) {
      if (line.trim() === "") continue;

      try {
        const event = JSON.parse(line) as SparkwrightEvent;
        if (event.runId === runId) yield event;
      } catch (cause) {
        throw new Error(
          `Invalid trace event JSON in ${runId} at line ${index + 1}`,
          { cause },
        );
      }
    }
  }

  private prepareTraceEvent(event: SparkwrightEvent): SparkwrightEvent {
    const eventWithIdentity = this.addStoreIdentity(event);
    const filtered = filterTraceEvent(eventWithIdentity, this.traceLevel);
    return this.redactor ? this.redactor(filtered) : filtered;
  }

  private prepareTranscriptEvent(event: SparkwrightEvent): SparkwrightEvent {
    const eventWithIdentity = this.addStoreIdentity(event);
    return this.redactor ? this.redactor(eventWithIdentity) : eventWithIdentity;
  }

  private addStoreIdentity(event: SparkwrightEvent): SparkwrightEvent {
    return {
      ...event,
      metadata: {
        ...event.metadata,
        sessionId: this.sessionId,
        agentId: this.agentId,
      },
    };
  }

  private writeTracePointer(run: RunRecord): void {
    writeIfMissing(
      join(this.runDir, "trace-pointer.json"),
      `${JSON.stringify(
        {
          schemaVersion: "trace-pointer.v1",
          runId: run.id,
          sessionId: this.sessionId,
          agentId: this.agentId,
          tracePath: relativeJsonPath(this.runDir, this.sessionTracePath),
          agentTracePath: relativeJsonPath(this.runDir, this.agentTracePath),
          note: "This run directory stores per-run state; trace events are aggregated in the listed trace files.",
        },
        null,
        2,
      )}\n`,
    );
  }

  private materializeArtifact(artifact: Artifact): void {
    assertSafePathSegment(artifact.id, "artifact id");
    const prepared = this.redactArtifacts ? redactArtifact(artifact) : artifact;
    const extension = extensionForArtifact(artifact);
    const artifactPath = join(this.artifactsDir, `${artifact.id}${extension}`);
    const metadataPath = join(this.artifactsDir, `${artifact.id}.json`);

    atomicWriteFileSync(
      artifactPath,
      serializeArtifactContent(prepared.content),
    );
    atomicWriteFileSync(metadataPath, `${JSON.stringify(prepared, null, 2)}\n`);
  }

  private writeSessionRecord(run: RunRecord): void {
    const sessionPath = join(this.sessionDir, "session.json");
    const now = new Date().toISOString();
    const existing = readJsonIfExists<Record<string, unknown>>(sessionPath);
    const existingRunIds = Array.isArray(existing?.runIds)
      ? existing.runIds.filter((id): id is string => typeof id === "string")
      : [];
    const existingAgents = Array.isArray(existing?.agents)
      ? existing.agents.filter((id): id is string => typeof id === "string")
      : [];
    const runIds = new Set(existingRunIds);
    runIds.add(run.id);
    const agents = new Set(existingAgents);
    agents.add(this.agentId);

    // Spread `existing` first so unknown fields owned by another writer
    // (e.g. `FileSessionStore` maintaining `eventCount` + custom
    // metadata) survive a `FileRunStore` re-open. Only override the
    // fields this store actually owns. This is best-effort under
    // concurrent writers; truly safe coordination would need locking.
    const merged: Record<string, unknown> = {
      ...(existing ?? {}),
      id: this.sessionId,
      createdAt:
        typeof existing?.createdAt === "string"
          ? existing.createdAt
          : run.createdAt,
      updatedAt: now,
      runIds: [...runIds],
      agents: [...agents],
      metadata:
        existing?.metadata !== undefined ? existing.metadata : run.metadata,
    };
    atomicWriteFileSync(sessionPath, `${JSON.stringify(merged, null, 2)}\n`);
  }

  private writeAgentRecord(run: RunRecord): void {
    const agentPath = join(this.agentDir, "agent.json");
    const existing = readJsonIfExists<{
      id: string;
      sessionId?: string;
      createdAt: string;
      updatedAt: string;
      runIds: string[];
      metadata?: Record<string, unknown>;
    }>(agentPath);
    const runIds = new Set(existing?.runIds ?? []);
    runIds.add(run.id);
    atomicWriteFileSync(
      agentPath,
      `${JSON.stringify(
        {
          id: this.agentId,
          sessionId: this.sessionId,
          createdAt: existing?.createdAt ?? run.createdAt,
          updatedAt: new Date().toISOString(),
          runIds: [...runIds],
          metadata: existing?.metadata ?? run.metadata,
        },
        null,
        2,
      )}\n`,
    );
  }

  private appendTranscriptEvent(event: SparkwrightEvent): void {
    let line = transcriptEntryForEvent(event, {
      sessionId: this.sessionId,
      agentId: this.agentId,
    });
    if (!line) return;
    if (line.type === "prompt") {
      line = this.dedupPromptSystemPrefix(line);
    }
    appendFileSync(this.transcriptPath, `${JSON.stringify(line)}\n`, "utf8");
    appendFileSync(
      this.agentTranscriptPath,
      `${JSON.stringify(line)}\n`,
      "utf8",
    );
  }

  /**
   * Collapse the leading `system` prefix of a transcript `prompt` entry into a
   * `systemRef`. The prefix itself is written once to `blobs/<hash>.json` and
   * every entry — including the first occurrence — only carries the reference,
   * so a prefix that repeats across runs, agents, and process restarts is
   * stored exactly once per session. Rehydrate with
   * {@link restoreTranscriptPrompts} passing the session `blobs/` dir.
   */
  private dedupPromptSystemPrefix(
    line: Record<string, unknown>,
  ): Record<string, unknown> {
    // Without a blob store there is nowhere to rehydrate a stripped prefix
    // from, so leave the entry self-contained.
    if (!this.blobsDir) return line;
    const messages = line.messages;
    if (!Array.isArray(messages) || messages.length === 0) return line;
    const prefix = leadingSystemPrefix(messages as PromptMessage[]);
    if (prefix.length === 0) return line;
    const hash = hashSystemPrefix(prefix);
    this.ensureSystemPrefixBlob(hash, prefix);
    return {
      ...line,
      systemRef: hash,
      systemPrefixLength: prefix.length,
      messages: (messages as PromptMessage[]).slice(prefix.length),
    };
  }

  /**
   * Persist a system prefix to `blobs/<hash>.json` if it isn't there yet. The
   * blob file's existence — not in-memory state — is the dedup signal, so this
   * stays correct across the per-run `FileRunStore` instances a session
   * creates. `seenSystemHashes` only memoizes the existence check to avoid a
   * repeated `stat` on every step within one instance.
   */
  private ensureSystemPrefixBlob(hash: string, prefix: PromptMessage[]): void {
    if (this.seenSystemHashes.has(hash)) return;
    const blobPath = join(this.blobsDir!, `${hash}.json`);
    if (!existsSync(blobPath)) {
      atomicWriteFileSync(blobPath, `${JSON.stringify(prefix, null, 2)}\n`);
    }
    this.seenSystemHashes.add(hash);
  }
}

/** The contiguous run of leading `system` messages at the head of a prompt. */
function leadingSystemPrefix(messages: PromptMessage[]): PromptMessage[] {
  const prefix: PromptMessage[] = [];
  for (const message of messages) {
    if (message.role !== "system") break;
    prefix.push(message);
  }
  return prefix;
}

function hashSystemPrefix(prefix: PromptMessage[]): string {
  return createHash("sha256")
    .update(JSON.stringify(prefix))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Read a system-prefix blob written by {@link FileRunStore.ensureSystemPrefixBlob}.
 * Returns `undefined` (not a throw) when the blob is absent or malformed so
 * rehydration degrades to "prefix unknown" rather than failing the whole load.
 */
function readSystemPrefixBlob(
  blobsDir: string,
  hash: string,
): PromptMessage[] | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(blobsDir, `${hash}.json`), "utf8"),
    );
    return Array.isArray(parsed) ? (parsed as PromptMessage[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rehydrate transcript entries produced by {@link FileRunStore}: any `prompt`
 * entry carrying a `systemRef` gets its system prefix prepended back onto
 * `messages`. The prefix is resolved (in order of preference) from an earlier
 * inline `systemHash` entry in the same list — the legacy self-contained form —
 * or from `blobs/<hash>.json` under `options.blobsDir`, which is where current
 * transcripts store every prefix. Entries are returned in input order; non
 * `prompt` entries pass through untouched.
 */
export function restoreTranscriptPrompts(
  entries: Record<string, unknown>[],
  options: { blobsDir?: string } = {},
): Record<string, unknown>[] {
  const prefixes = new Map<string, PromptMessage[]>();
  const resolvePrefix = (ref: string): PromptMessage[] => {
    const cached = prefixes.get(ref);
    if (cached) return cached;
    const prefix =
      (options.blobsDir
        ? readSystemPrefixBlob(options.blobsDir, ref)
        : undefined) ?? [];
    prefixes.set(ref, prefix);
    return prefix;
  };
  return entries.map((entry) => {
    if (entry.type !== "prompt") return entry;
    // Legacy self-contained form: the first occurrence stored the prefix inline
    // alongside its `systemHash`. Newer transcripts never do this.
    if (typeof entry.systemHash === "string" && Array.isArray(entry.messages)) {
      prefixes.set(
        entry.systemHash,
        leadingSystemPrefix(entry.messages as PromptMessage[]),
      );
      return entry;
    }
    if (typeof entry.systemRef === "string") {
      const prefix = resolvePrefix(entry.systemRef);
      const rest = Array.isArray(entry.messages)
        ? (entry.messages as PromptMessage[])
        : [];
      return { ...entry, messages: [...prefix, ...rest] };
    }
    return entry;
  });
}

function transcriptEntryForEvent(
  event: SparkwrightEvent,
  identity: { sessionId?: string; agentId?: string },
): Record<string, unknown> | undefined {
  if (!isRecord(event.payload)) return undefined;

  if (event.type === "prompt.built" && Array.isArray(event.payload.messages)) {
    return {
      type: "prompt",
      sessionId: identity.sessionId,
      agentId: identity.agentId ?? "main",
      runId: event.runId,
      step: event.payload.step,
      timestamp: event.timestamp,
      messages: event.payload.messages,
    };
  }

  if (event.type === "model.completed") {
    return {
      type: "assistant",
      sessionId: identity.sessionId,
      agentId: identity.agentId ?? "main",
      runId: event.runId,
      step: event.payload.step,
      timestamp: event.timestamp,
      message: event.payload.message,
      toolCalls: event.payload.toolCalls,
      usage: event.payload.usage,
      stopReason: event.payload.stopReason,
    };
  }

  if (event.type === "tool.completed" || event.type === "tool.failed") {
    return {
      type: "tool_result",
      sessionId: identity.sessionId,
      agentId: identity.agentId ?? "main",
      runId: event.runId,
      timestamp: event.timestamp,
      toolCallId: event.payload.toolCallId,
      toolName: event.payload.toolName,
      status: event.payload.status,
      output: event.payload.output,
      error: event.payload.error,
      artifacts: event.payload.artifacts,
    };
  }

  return undefined;
}

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) atomicWriteFileSync(path, content);
}

function relativeJsonPath(fromDir: string, toPath: string): string {
  return relative(fromDir, toPath).split("\\").join("/");
}

function atomicWriteFileSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function readJsonIfExists<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export interface LoadCheckpointFromRunDirOptions {
  /**
   * When `checkpoint.json` is missing, attempt to reconstruct a minimal
   * `RunCheckpointV1` from `run.json` + `trace.jsonl`. The reconstructed
   * checkpoint is marked `resumability.complete = false` with a single
   * reason (`"reconstructed_from_trace"`) so {@link resumeRunFromCheckpoint}
   * refuses to use it unless the caller opts in with `force: true`.
   *
   * Tradeoff: trace replay only recovers append-only counters (model calls,
   * tool calls, tokens, cost) and a coarse step number. In-loop context is
   * lost; the resumed run starts with empty context. Use this as a
   * last-resort recovery path after a hard crash where no checkpoint was
   * persisted before the failure.
   */
  fallbackFromTrace?: boolean;
}

/**
 * Read back a previously-saved checkpoint from a run directory written by
 * {@link FileRunStore.saveCheckpoint}. Returns `undefined` when no checkpoint
 * file exists at that path (rather than throwing) so callers can fall back to
 * a cold start.
 *
 * With `{ fallbackFromTrace: true }`, missing `checkpoint.json` triggers a
 * best-effort reconstruction from `run.json` + `trace.jsonl`. The returned
 * checkpoint is marked non-fully-resumable; the caller must pass
 * `{ force: true }` to {@link resumeRunFromCheckpoint}.
 *
 * `runDir` accepts either an absolute or workspace-relative canonical
 * `.sparkwright/sessions/<sid>/agents/<aid>/runs/<id>/` directory.
 */
export function loadCheckpointFromRunDir(
  runDir: string,
  options: LoadCheckpointFromRunDirOptions = {},
): RunCheckpointV1 | undefined {
  const checkpointPath = join(runDir, "checkpoint.json");
  if (existsSync(checkpointPath)) {
    const raw = readFileSync(checkpointPath, "utf8");
    const parsed = JSON.parse(raw) as RunCheckpointV1;
    if (parsed.schemaVersion !== "run-checkpoint.v1") {
      throw new Error(
        `Unsupported checkpoint schema in ${checkpointPath}: ${(parsed as { schemaVersion?: string }).schemaVersion}`,
      );
    }
    return parsed;
  }
  if (!options.fallbackFromTrace) return undefined;
  return reconstructCheckpointFromTrace(runDir);
}

function reconstructCheckpointFromTrace(
  runDir: string,
): RunCheckpointV1 | undefined {
  const runJsonPath = join(runDir, "run.json");
  if (!existsSync(runJsonPath)) return undefined;
  const run = JSON.parse(readFileSync(runJsonPath, "utf8")) as RunRecord;

  // Session-scoped traces aggregate multiple runs; filter by runId. The trace
  // lives at the agent or session level.
  const candidateTracePaths = [
    join(runDir, "..", "..", "trace.jsonl"), // agent-level
    join(runDir, "..", "..", "..", "..", "trace.jsonl"), // session-level
  ];
  const tracePath = candidateTracePaths.find((p) => existsSync(p));

  let stepSeen = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let tokens = 0;
  let costUsd = 0;
  let lastTimestampMs: number | undefined;
  let firstTimestampMs: number | undefined;
  let eventSequence = 0;

  if (tracePath) {
    const lines = readFileSync(tracePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (line.trim() === "") continue;
      let event: SparkwrightEvent;
      try {
        event = JSON.parse(line) as SparkwrightEvent;
      } catch {
        continue; // skip corrupt lines — best-effort
      }
      if (event.runId !== run.id) continue;
      if (typeof event.sequence === "number") {
        eventSequence = Math.max(eventSequence, observedSequenceEnd(event));
      }
      const ts = Date.parse(event.timestamp);
      if (!Number.isNaN(ts)) {
        firstTimestampMs ??= ts;
        lastTimestampMs = ts;
      }
      const payload = (event.payload ?? {}) as {
        step?: number;
        usage?: { tokens?: number; costUsd?: number };
      };
      if (typeof payload.step === "number" && payload.step > stepSeen) {
        stepSeen = payload.step;
      }
      if (event.type === "model.completed") modelCalls += 1;
      if (event.type === "tool.completed" || event.type === "tool.failed") {
        toolCalls += 1;
      }
      if (event.type === "usage.updated" && payload.usage) {
        if (typeof payload.usage.tokens === "number")
          tokens = payload.usage.tokens;
        if (typeof payload.usage.costUsd === "number")
          costUsd = payload.usage.costUsd;
      }
    }
  }

  const elapsedMs =
    firstTimestampMs !== undefined && lastTimestampMs !== undefined
      ? lastTimestampMs - firstTimestampMs
      : 0;

  return {
    schemaVersion: "run-checkpoint.v1",
    run,
    loop: {
      // Resume on the step *after* the last one we saw evidence of, since
      // the loop iteration that emitted those events presumably completed.
      // When stepSeen is 0 (no model.completed found) start at 1.
      step: Math.max(1, stepSeen + 1),
      turnCount: stepSeen,
      context: [],
      repeatedToolCallCount: 0,
      transition: { reason: "next_turn" },
    },
    eventSequence,
    model: { activeIndex: 0, fallbackCount: 0 },
    recovery: { outputRecoveriesUsed: 0, maxOutputRecoveries: 3 },
    budget: {
      configured: undefined,
      usage: { elapsedMs, modelCalls, toolCalls, tokens, costUsd },
    },
    queues: {
      commandCount: 0,
      pendingPrefetch: false,
      pendingSummary: false,
    },
    resumability: {
      complete: false,
      reasons: ["reconstructed_from_trace"],
    },
    createdAt: new Date().toISOString(),
    metadata: {
      source: "reconstructed_from_trace",
      tracePath: tracePath ?? null,
      runJsonPath,
    },
  };
}

/**
 * Compose the two FileRunStore degradation callbacks into a pair of
 * `storage.degraded` / `storage.recovered` events on the supplied EventLog.
 *
 * Design notes:
 *  - `storage.degraded` is emitted at most once per degradation cycle (the
 *    first append failure after a clean state). Subsequent failures within
 *    the same cycle still call `onAppendError` directly but do NOT re-emit
 *    the event — that would flood the trace with the same signal.
 *  - The emitted event payload carries running `bufferedCount` / `droppedCount`
 *    so the host can render a progress indicator without subscribing to the
 *    raw callback.
 *  - `storage.recovered` is emitted exactly once per cycle when the buffer
 *    is fully flushed back to disk.
 *
 * Caller wires it like:
 *   const hooks = bindStorageDegradationEvents({ events: run.events });
 *   const store = new FileRunStore(run, {
 *     sessionId: "session_...",
 *     ...hooks,
 *   });
 */
export function bindStorageDegradationEvents(input: {
  events: {
    emit: (type: SparkwrightEvent["type"], payload: unknown) => unknown;
  };
}): Pick<FileRunStoreOptions, "onAppendError" | "onDrainSuccess"> {
  let inDegradedCycle = false;
  let cycleStartedAtMs = 0;
  return {
    onAppendError: (info) => {
      if (!inDegradedCycle) {
        inDegradedCycle = true;
        cycleStartedAtMs = Date.now();
        input.events.emit("storage.degraded", {
          reason:
            info.error instanceof Error
              ? info.error.message
              : String(info.error),
          errorCode:
            info.error && typeof info.error === "object"
              ? (info.error as { code?: string }).code
              : undefined,
          bufferedCount: info.bufferedCount,
          droppedCount: info.droppedCount,
          firstFailedEventType: info.event.type,
        });
      }
    },
    onDrainSuccess: (info) => {
      if (inDegradedCycle) {
        inDegradedCycle = false;
        input.events.emit("storage.recovered", {
          flushedCount: info.flushedCount,
          droppedCount: info.droppedCount,
          degradedForMs: Date.now() - cycleStartedAtMs,
        });
      }
    },
  };
}

function processInvocationKey(event: SparkwrightEvent): string | undefined {
  const payload = isRecord(event.payload) ? event.payload : {};
  return stringValue(payload.invocationId, event.spanId);
}

function processProgressSnapshot(event: SparkwrightEvent): unknown {
  if (!isRecord(event.payload)) return summarizeValue(event.payload);
  const out: Record<string, unknown> = {
    sequence: event.sequence,
    timestamp: event.timestamp,
    monotonicUs: event.monotonicUs,
  };
  for (const key of ["invocationId", "message", "channel", "data"]) {
    if (key in event.payload) out[key] = summarizeValue(event.payload[key]);
  }
  return out;
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") return truncateString(value, 500);
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      preview: value.slice(0, 5).map(summarizeValue),
    };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return Object.fromEntries(
      entries
        .slice(0, 20)
        .map(([key, nested]) => [key, summarizeValue(nested)]),
    );
  }
  return value;
}

function truncateString(value: unknown, maxLength: number): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= maxLength) return value;
  return {
    type: "string",
    length: value.length,
    preview: value.slice(0, maxLength),
  };
}

function observedSequenceEnd(event: SparkwrightEvent): number {
  if (
    event.type === "model.stream.text" &&
    isRecord(event.payload) &&
    typeof event.payload.chunkCount === "number" &&
    Number.isInteger(event.payload.chunkCount) &&
    event.payload.chunkCount > 1
  ) {
    return event.sequence + event.payload.chunkCount - 1;
  }
  return event.sequence;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function extensionForArtifact(artifact: Artifact): string {
  switch (artifact.type) {
    case "diff":
    case "patch":
      return ".diff";
    case "json":
      return ".json";
    case "log":
      return ".log";
    case "file":
      return ".txt";
    case "text":
    default:
      return ".txt";
  }
}

function serializeArtifactContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined) return "";
  return `${JSON.stringify(content, null, 2)}\n`;
}

const DEFAULT_ARTIFACT_REDACTOR = createTraceRedactor();

function redactArtifact(artifact: Artifact): Artifact {
  const event = DEFAULT_ARTIFACT_REDACTOR({
    id: "" as SparkwrightEvent["id"],
    runId: artifact.runId,
    type: "artifact.created",
    timestamp: "",
    sequence: 0,
    payload: artifact,
    metadata: {},
  });
  return event.payload as Artifact;
}
