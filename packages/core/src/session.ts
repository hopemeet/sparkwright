/**
 * Session protocol for grouping multiple runs into a single conversation /
 * working session.
 *
 * Sparkwright v0.1 ships only a small in-memory reference implementation. The
 * harness exposes the shape so embedders can attach their own durable session
 * backend (file-based, sqlite, remote) without forking core.
 *
 * @packageDocumentation
 */

import {
  appendFile,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteText } from "./file-atomic.js";
import {
  asSessionId,
  createId,
  createContextItemId,
  createSessionId,
  type RunId,
  type SessionId,
} from "./ids.js";
import type { SparkwrightEvent } from "./events.js";
import type { RunStore } from "./storage.js";
import type { Artifact, ContextItem, RunRecord, RunResult } from "./types.js";
import { isRecord } from "./record-utils.js";
import { COMPACTION_SAFETY_PREFIX } from "./context-safety.js";

/**
 * A session record aggregating an ordered list of run ids plus arbitrary
 * embedder-defined metadata.
 *
 * @public
 * @stability experimental v0.1
 */
export interface Session {
  id: SessionId;
  createdAt: string;
  updatedAt: string;
  runIds: RunId[];
  metadata?: Record<string, unknown>;
}

/**
 * Durable session record. `eventCount` lets stores expose append-only progress
 * without forcing every caller to load the event stream.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SessionRecord extends Session {
  eventCount: number;
}

/** Stable semantic location used when branching a session. */
export interface SessionForkPoint {
  runId: RunId;
  position: "before" | "after";
}

/** Provenance recorded on a forked session. */
export interface SessionLineage {
  /** @reserved Durable parent identity consumed by session-tree readers. */
  parentSessionId: SessionId;
  forkPoint: SessionForkPoint | null;
}

export type SessionEventType =
  | "session.created"
  | "session.forked"
  | "session.run_appended"
  | "session.event_appended"
  | "session.run.event_replayed"
  | "session.compaction.completed"
  | "session.compaction.skipped";

/**
 * Append-only event attached to a session rather than a single run.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SessionEvent<TPayload = unknown> {
  id: string;
  /**
   * @reserved Public protocol field consumed by session stores and embedders.
   */
  sessionId: SessionId;
  type: SessionEventType;
  timestamp: string;
  sequence: number;
  payload: TPayload;
  metadata: Record<string, unknown>;
}

export interface SessionEventInput<TPayload = unknown> {
  type: SessionEventType;
  payload: TPayload;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export type SessionSeed = Partial<Omit<Session, "id">> & {
  id?: SessionId | string;
};

/**
 * Storage protocol for `Session` records.
 *
 * Durable implementations are expected to live at the edge.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SessionStore {
  /**
   * Create a new session. The store assigns `id`, `createdAt`, and
   * `updatedAt` if they are not provided by `seed`.
   */
  create(seed?: SessionSeed): Promise<Session>;

  /**
   * Look up a session by id. Returns `null` if no such session exists.
   */
  get(id: string): Promise<Session | null>;

  /**
   * Append a run id to the session's `runIds` list, bumping `updatedAt`.
   * Returns the updated session.
   */
  append(id: string, runId: RunId): Promise<Session>;

  /**
   * List sessions in implementation-defined order (typically most recent
   * first). Honors `opts.limit` if provided.
   */
  list(opts?: { limit?: number }): Promise<Session[]>;
}

/**
 * Session store shape for implementations that persist the append-only session
 * event stream alongside the aggregate record.
 *
 * @public
 * @stability experimental v0.1
 */
export interface AppendOnlySessionStore extends SessionStore {
  create(seed?: SessionSeed): Promise<SessionRecord>;
  get(id: string): Promise<SessionRecord | null>;
  append(id: string, runId: RunId): Promise<SessionRecord>;
  list(opts?: { limit?: number }): Promise<SessionRecord[]>;
  appendEvent<TPayload>(
    id: string,
    event: SessionEventInput<TPayload>,
  ): Promise<SessionEvent<TPayload>>;
  loadEvents(id: string): AsyncIterable<SessionEvent>;
}

export interface ForkSessionOptions {
  /** Source session to fork from. */
  sourceSessionId: string;
  /** Omit to clone the complete source session. */
  forkPoint?: SessionForkPoint;
  /** Additional metadata attached to the new session. */
  metadata?: Record<string, unknown>;
}

export interface ForkSessionResult {
  forked: SessionRecord;
  copiedRunCount: number;
  forkPoint: SessionForkPoint | null;
}

/** Store capability required to create a complete, resumable session fork. */
export interface ForkableSessionStore extends AppendOnlySessionStore {
  forkSession(input: ForkSessionOptions): Promise<ForkSessionResult>;
}

export interface ForkSessionInput extends ForkSessionOptions {
  store: ForkableSessionStore;
}

export interface FileSessionStoreOptions {
  rootDir?: string;
}

/**
 * Small reference implementation for tests, demos, and embedders that want a
 * no-dependency starting point before wiring a durable backend.
 *
 * @public
 * @stability experimental v0.1
 */
export class InMemorySessionStore implements ForkableSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly events = new Map<string, SessionEvent[]>();

  async create(seed: SessionSeed = {}): Promise<SessionRecord> {
    const id = seed.id ? asSessionId(seed.id) : createSessionId();
    if (seed.id && this.sessions.has(id)) {
      return this.cloneSession(this.mustGet(id));
    }

    const now = new Date().toISOString();
    const session: SessionRecord = {
      id,
      createdAt: seed.createdAt ?? now,
      updatedAt: seed.updatedAt ?? now,
      runIds: [...(seed.runIds ?? [])],
      metadata: seed.metadata ? { ...seed.metadata } : undefined,
      eventCount: 0,
    };

    this.sessions.set(session.id, session);
    this.events.set(session.id, []);
    await this.appendEvent(session.id, {
      type: "session.created",
      timestamp: session.createdAt,
      payload: {
        runIds: session.runIds,
      },
    });
    return this.cloneSession(this.mustGet(session.id));
  }

  async get(id: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(id);
    return session ? this.cloneSession(session) : null;
  }

  async append(id: string, runId: RunId): Promise<SessionRecord> {
    const session = this.mustGet(id);
    if (session.runIds.includes(runId)) return this.cloneSession(session);
    session.runIds = [...session.runIds, runId];
    await this.appendEvent(id, {
      type: "session.run_appended",
      payload: { runId },
    });
    return this.cloneSession(session);
  }

  async list(opts: { limit?: number } = {}): Promise<SessionRecord[]> {
    const sessions = [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => this.cloneSession(session));

    return typeof opts.limit === "number"
      ? sessions.slice(0, opts.limit)
      : sessions;
  }

  async appendEvent<TPayload>(
    id: string,
    input: SessionEventInput<TPayload>,
  ): Promise<SessionEvent<TPayload>> {
    const session = this.mustGet(id);
    const events = this.events.get(id);
    if (!events) throw new Error(`Session events not initialized: ${id}`);

    const timestamp = input.timestamp ?? new Date().toISOString();
    const event: SessionEvent<TPayload> = {
      id: createId("session_evt"),
      sessionId: asSessionId(id),
      type: input.type,
      timestamp,
      sequence: events.length + 1,
      payload: input.payload,
      metadata: input.metadata ? { ...input.metadata } : {},
    };

    events.push(event as SessionEvent);
    session.updatedAt = timestamp;
    session.eventCount = events.length;
    return this.cloneEvent(event);
  }

  async forkSession(input: ForkSessionOptions): Promise<ForkSessionResult> {
    return forkLogicalSession(this, input);
  }

  async *loadEvents(id: string): AsyncIterable<SessionEvent> {
    const events = this.events.get(id);
    if (!events) throw new Error(`Session not found: ${id}`);

    for (const event of events) {
      yield this.cloneEvent(event);
    }
  }

  private mustGet(id: string): SessionRecord {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }

  private cloneSession(session: SessionRecord): SessionRecord {
    return {
      ...session,
      runIds: [...session.runIds],
      metadata: session.metadata ? { ...session.metadata } : undefined,
    };
  }

  private cloneEvent<TPayload>(
    event: SessionEvent<TPayload>,
  ): SessionEvent<TPayload> {
    return {
      ...event,
      metadata: { ...event.metadata },
    };
  }
}

/**
 * File-backed `AppendOnlySessionStore` persisting one directory per session.
 *
 * @public
 * @stability experimental v0.1
 */
export class FileSessionStore implements ForkableSessionStore {
  readonly rootDir: string;
  private readonly mutationQueues = new Map<string, Promise<void>>();

  constructor(options: FileSessionStoreOptions = {}) {
    this.rootDir = options.rootDir ?? ".sparkwright/sessions";
  }

  async create(seed: SessionSeed = {}): Promise<SessionRecord> {
    const id = seed.id ? asSessionId(seed.id) : createSessionId();
    const createNew = async (): Promise<SessionRecord> => {
      const now = new Date().toISOString();
      const session: SessionRecord = {
        id,
        createdAt: seed.createdAt ?? now,
        updatedAt: seed.updatedAt ?? now,
        runIds: [...(seed.runIds ?? [])],
        metadata: seed.metadata ? { ...seed.metadata } : undefined,
        eventCount: 0,
      };

      await mkdir(this.sessionDir(session.id), { recursive: true });
      await writeFile(this.eventsPath(session.id), "", "utf8");
      await this.writeSession(session);
      await this.appendSessionEvent(session, {
        type: "session.created",
        timestamp: session.createdAt,
        payload: {
          runIds: session.runIds,
        },
      });

      return this.mustGet(session.id);
    };

    if (seed.id) {
      return this.withSessionMutation(id, async () => {
        const existing = await this.get(id);
        return existing ?? createNew();
      });
    }

    const now = new Date().toISOString();
    const session: SessionRecord = {
      id,
      createdAt: seed.createdAt ?? now,
      updatedAt: seed.updatedAt ?? now,
      runIds: [...(seed.runIds ?? [])],
      metadata: seed.metadata ? { ...seed.metadata } : undefined,
      eventCount: 0,
    };

    await mkdir(this.sessionDir(session.id), { recursive: true });
    await writeFile(this.eventsPath(session.id), "", "utf8");
    await this.writeSession(session);
    await this.appendEvent(session.id, {
      type: "session.created",
      timestamp: session.createdAt,
      payload: {
        runIds: session.runIds,
      },
    });

    return this.mustGet(session.id);
  }

  async get(id: string): Promise<SessionRecord | null> {
    try {
      return this.cloneSession(
        JSON.parse(
          await readFile(this.sessionPath(id), "utf8"),
        ) as SessionRecord,
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async append(id: string, runId: RunId): Promise<SessionRecord> {
    return this.withSessionMutation(id, async () => {
      const session = await this.mustGet(id);
      // Membership is "exactly once": dedupe at the store edge so callers
      // that bypass `ensureSessionRunMembership` cannot grow `runIds` to
      // ["run_x", "run_x", ...] under retry or replay.
      if (session.runIds.includes(runId)) return session;
      session.runIds = [...session.runIds, runId];
      await this.appendSessionEvent(session, {
        type: "session.run_appended",
        payload: { runId },
      });
      return this.mustGet(id);
    });
  }

  async list(opts: { limit?: number } = {}): Promise<SessionRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const sessions = (
      await Promise.all(entries.map((entry) => this.get(entry)))
    ).filter((session): session is SessionRecord => session !== null);

    const sorted = sessions.sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    return typeof opts.limit === "number"
      ? sorted.slice(0, opts.limit)
      : sorted;
  }

  async appendEvent<TPayload>(
    id: string,
    input: SessionEventInput<TPayload>,
  ): Promise<SessionEvent<TPayload>> {
    return this.withSessionMutation(id, async () => {
      const session = await this.mustGet(id);
      return this.appendSessionEvent(session, input);
    });
  }

  async forkSession(input: ForkSessionOptions): Promise<ForkSessionResult> {
    return forkFileSession(this, input);
  }

  private async appendSessionEvent<TPayload>(
    session: SessionRecord,
    input: SessionEventInput<TPayload>,
  ): Promise<SessionEvent<TPayload>> {
    const id = session.id;
    const sequence = session.eventCount + 1;
    const timestamp = input.timestamp ?? new Date().toISOString();
    const event: SessionEvent<TPayload> = {
      id: createId("session_evt"),
      sessionId: asSessionId(id),
      type: input.type,
      timestamp,
      sequence,
      payload: input.payload,
      metadata: input.metadata ? { ...input.metadata } : {},
    };

    await appendFile(this.eventsPath(id), `${JSON.stringify(event)}\n`, "utf8");
    session.updatedAt = timestamp;
    session.eventCount = sequence;
    await this.writeSession(session);
    return this.cloneEvent(event);
  }

  async *loadEvents(id: string): AsyncIterable<SessionEvent> {
    if (!(await this.get(id))) throw new Error(`Session not found: ${id}`);

    const jsonl = await readFile(this.eventsPath(id), "utf8");
    for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
      if (line.trim() === "") continue;

      try {
        yield this.cloneEvent(JSON.parse(line) as SessionEvent);
      } catch (cause) {
        throw new Error(
          `Invalid session event JSON in ${id} at line ${index + 1}`,
          { cause },
        );
      }
    }
  }

  private async mustGet(id: string): Promise<SessionRecord> {
    const session = await this.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }

  private async writeSession(session: SessionRecord): Promise<void> {
    await mkdir(this.sessionDir(session.id), { recursive: true });
    await atomicWriteText(
      this.sessionPath(session.id),
      `${JSON.stringify(session, null, 2)}\n`,
    );
  }

  private async withSessionMutation<T>(
    id: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.mutationQueues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(
      () => current,
      () => current,
    );
    this.mutationQueues.set(id, queued);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.mutationQueues.get(id) === queued) {
        this.mutationQueues.delete(id);
      }
    }
  }

  private sessionDir(id: string): string {
    return join(this.rootDir, id);
  }

  private sessionPath(id: string): string {
    return join(this.sessionDir(id), "session.json");
  }

  private eventsPath(id: string): string {
    return join(this.sessionDir(id), "events.jsonl");
  }

  private cloneSession(session: SessionRecord): SessionRecord {
    return {
      ...session,
      runIds: [...session.runIds],
      metadata: session.metadata ? { ...session.metadata } : undefined,
    };
  }

  private cloneEvent<TPayload>(
    event: SessionEvent<TPayload>,
  ): SessionEvent<TPayload> {
    return {
      ...event,
      metadata: { ...event.metadata },
    };
  }
}

export interface RunStoreReplayPayload {
  runId: RunId;
  event: SparkwrightEvent;
}

export interface EnsureSessionRunMembershipOptions {
  sessionStore: SessionStore;
  sessionId: SessionId | string;
  run: Pick<RunRecord, "id" | "createdAt" | "metadata">;
  metadata?: Record<string, unknown>;
}

/**
 * Ensure a session exists and contains the run id exactly once.
 *
 * This helper is the small bridge between session membership state and
 * per-run persistence. It intentionally does not write trace events itself.
 */
export async function ensureSessionRunMembership({
  sessionStore,
  sessionId,
  run,
  metadata = {},
}: EnsureSessionRunMembershipOptions): Promise<Session> {
  const id = asSessionId(sessionId);
  let session = await sessionStore.get(id);
  if (!session) {
    session = await sessionStore.create({
      id,
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
      metadata: {
        ...metadata,
        ...(run.metadata.sessionKey
          ? { sessionKey: run.metadata.sessionKey }
          : {}),
      },
    });
  }

  if (session.runIds.includes(run.id)) return session;
  return sessionStore.append(id, run.id);
}

export interface CreateSessionRunStoreFactoryOptions {
  sessionStore: SessionStore;
  sessionId: SessionId | string;
  runStoreFactory: (run: RunRecord) => RunStore;
  metadata?: Record<string, unknown>;
}

/**
 * Wrap a run-store factory so the selected session records run membership
 * before the first event/result is persisted. This composes session state with
 * run trace persistence without making either store depend on the other.
 */
export function createSessionRunStoreFactory({
  sessionStore,
  sessionId,
  runStoreFactory,
  metadata = {},
}: CreateSessionRunStoreFactoryOptions): (run: RunRecord) => RunStore {
  const id = asSessionId(sessionId);
  return (run) =>
    new SessionRunStore({
      sessionStore,
      sessionId: id,
      run,
      runStoreFactory,
      metadata,
    });
}

class SessionRunStore implements RunStore {
  private membership?: Promise<void>;
  private inner?: RunStore;

  constructor(
    private readonly options: {
      sessionStore: SessionStore;
      sessionId: SessionId;
      run: RunRecord;
      runStoreFactory: (run: RunRecord) => RunStore;
      metadata: Record<string, unknown>;
    },
  ) {}

  async append(event: SparkwrightEvent): Promise<void> {
    await this.ensureMembership();
    await this.getInner().append(event);
  }

  async finish(run: RunRecord, result: RunResult): Promise<void> {
    await this.ensureMembership();
    await this.getInner().finish(run, result);
  }

  async *loadEvents(runId: RunRecord["id"]): AsyncIterable<SparkwrightEvent> {
    // Pure read: do NOT call `getInner()` here. Lazily constructing the
    // inner store has write side effects (writes session.json/agent.json,
    // bumps updatedAt timestamps) which corrupt the session record when
    // replay/diagnostics open the store just to enumerate events.
    if (!this.inner) return;
    if (!this.inner.loadEvents) return;
    yield* this.inner.loadEvents(runId);
  }

  async writeArtifact(artifact: Artifact): Promise<void> {
    await this.ensureMembership();
    const inner = this.getInner();
    if (inner.writeArtifact) {
      await inner.writeArtifact(artifact);
    }
  }

  private ensureMembership(): Promise<void> {
    this.membership ??= ensureSessionRunMembership({
      sessionStore: this.options.sessionStore,
      sessionId: this.options.sessionId,
      run: this.options.run,
      metadata: this.options.metadata,
    }).then(() => undefined);
    return this.membership;
  }

  private getInner(): RunStore {
    this.inner ??= this.options.runStoreFactory(this.options.run);
    return this.inner;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export interface ReplaySessionEventsInput {
  session: Pick<SessionRecord, "id" | "runIds">;
  runStore: Pick<RunStore, "loadEvents">;
  metadata?: Record<string, unknown>;
}

/**
 * Project run-level trace events into a session-level replay stream. The
 * generated sequence is session-local and follows the session's `runIds` order.
 *
 * @public
 * @stability experimental v0.1
 */
export async function* replaySessionEventsFromRunStore({
  session,
  runStore,
  metadata = {},
}: ReplaySessionEventsInput): AsyncIterable<
  SessionEvent<RunStoreReplayPayload>
> {
  if (!runStore.loadEvents) {
    throw new Error("RunStore.loadEvents is required to replay session events");
  }

  let sequence = 0;
  for (const runId of session.runIds) {
    for await (const event of runStore.loadEvents(runId)) {
      yield {
        id: createId("session_evt"),
        sessionId: session.id,
        type: "session.run.event_replayed",
        timestamp: event.timestamp,
        sequence: ++sequence,
        payload: {
          runId,
          event,
        },
        metadata: { ...metadata },
      };
    }
  }
}

export interface ProjectSessionReplayToContextOptions extends ReplaySessionEventsInput {
  /** @reserved Public replay-projection limit consumed by resume UIs. */
  maxEvents?: number;
  title?: string;
}

export interface SessionTranscriptEntry {
  timestamp: string;
  runId: RunId;
  eventType: SparkwrightEvent["type"];
  role: "user" | "assistant" | "tool" | "system";
  text: string;
}

export interface SessionTranscript {
  sessionId: SessionId;
  entries: SessionTranscriptEntry[];
  text: string;
  truncated: boolean;
}

export interface ProjectSessionReplayToTranscriptOptions extends ReplaySessionEventsInput {
  /** @reserved Public replay-projection limit consumed by resume UIs. */
  maxEvents?: number;
}

export const SESSION_COMPACT_FILENAME = "compact.json" as const;
export const SESSION_COMPACT_SCHEMA_VERSION = "session-compact.v2" as const;

export interface SessionCompactArtifact {
  schemaVersion: typeof SESSION_COMPACT_SCHEMA_VERSION;
  sessionId: SessionId;
  createdAt: string;
  throughRunId: RunId;
  compactedRunCount: number;
  sourceRunIds: RunId[];
  content: string;
  originalCharCount: number;
  summaryCharCount: number;
  freedChars: number;
  metadata?: Record<string, unknown>;
}

export interface WriteSessionCompactArtifactInput {
  sessionRootDir: string;
  /** @reserved Public compact artifact payload consumed by session stores. */
  artifact: SessionCompactArtifact;
}

export interface LoadSessionCompactArtifactInput {
  sessionRootDir: string;
  sessionId: string;
}

export async function writeSessionCompactArtifact({
  sessionRootDir,
  artifact,
}: WriteSessionCompactArtifactInput): Promise<string> {
  const sessionId = asSessionId(artifact.sessionId);
  const path = join(sessionRootDir, sessionId, SESSION_COMPACT_FILENAME);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return path;
}

export async function loadSessionCompactArtifact({
  sessionRootDir,
  sessionId,
}: LoadSessionCompactArtifactInput): Promise<SessionCompactArtifact | null> {
  const safeSessionId = asSessionId(sessionId);
  const path = join(sessionRootDir, safeSessionId, SESSION_COMPACT_FILENAME);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  return parseSessionCompactArtifact(raw, safeSessionId);
}

export function sessionCompactArtifactToContextItem(
  artifact: SessionCompactArtifact,
): ContextItem {
  const content = artifact.content.startsWith(COMPACTION_SAFETY_PREFIX)
    ? artifact.content
    : `${COMPACTION_SAFETY_PREFIX}\n\n${artifact.content}`;
  return {
    id: createContextItemId(),
    type: "summary",
    source: {
      kind: "session_compact",
      uri: artifact.sessionId,
    },
    content,
    metadata: {
      layer: "conversation",
      stability: "session",
      sessionId: artifact.sessionId,
      throughRunId: artifact.throughRunId,
      compactedRunCount: artifact.compactedRunCount,
      sourceRunIds: artifact.sourceRunIds,
      originalCharCount: artifact.originalCharCount,
      summaryCharCount: artifact.summaryCharCount,
      freedChars: artifact.freedChars,
      compactionSafetyPrefix: true,
    },
  };
}

function parseSessionCompactArtifact(
  value: unknown,
  sessionId: SessionId,
): SessionCompactArtifact | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SESSION_COMPACT_SCHEMA_VERSION) return null;
  if (value.sessionId !== sessionId) return null;
  if (typeof value.createdAt !== "string") return null;
  if (typeof value.throughRunId !== "string") return null;
  if (typeof value.compactedRunCount !== "number") return null;
  if (!Array.isArray(value.sourceRunIds)) return null;
  if (typeof value.content !== "string" || !value.content.trim()) return null;
  if (typeof value.originalCharCount !== "number") return null;
  if (typeof value.summaryCharCount !== "number") return null;
  if (typeof value.freedChars !== "number") return null;
  const sourceRunIds: RunId[] = [];
  for (const runId of value.sourceRunIds) {
    if (typeof runId !== "string") return null;
    sourceRunIds.push(runId as RunId);
  }
  if (!sourceRunIds.includes(value.throughRunId as RunId)) return null;
  return {
    schemaVersion: SESSION_COMPACT_SCHEMA_VERSION,
    sessionId,
    createdAt: value.createdAt,
    throughRunId: value.throughRunId as RunId,
    compactedRunCount: value.compactedRunCount,
    sourceRunIds,
    content: value.content,
    originalCharCount: value.originalCharCount,
    summaryCharCount: value.summaryCharCount,
    freedChars: value.freedChars,
    metadata: isRecord(value.metadata) ? { ...value.metadata } : undefined,
  };
}

/**
 * Project persisted run events into a compact context item for a follow-up run.
 * This is not full resume; it is a replay-derived summary that lets embedders
 * seed a new run without hiding the fact that the source is prior trace data.
 */
export async function projectSessionReplayToContextItems({
  maxEvents = 200,
  title = "Prior session replay",
  ...input
}: ProjectSessionReplayToContextOptions): Promise<ContextItem[]> {
  const lines: string[] = [title, `sessionId: ${input.session.id}`];
  let count = 0;
  for await (const item of replaySessionEventsFromRunStore(input)) {
    if (count >= maxEvents) break;
    lines.push(formatReplayContextLine(item));
    count += 1;
  }
  if (count === 0) return [];
  return [
    {
      id: createContextItemId(),
      type: "summary",
      source: { kind: "session_replay", uri: input.session.id },
      content: lines.join("\n"),
      metadata: {
        layer: "runtime",
        stability: "session",
        sessionId: input.session.id,
        eventCount: count,
        truncated: count >= maxEvents,
      },
    },
  ];
}

export async function projectSessionReplayToTranscript({
  maxEvents = 200,
  ...input
}: ProjectSessionReplayToTranscriptOptions): Promise<SessionTranscript> {
  const entries: SessionTranscriptEntry[] = [];
  let seen = 0;
  for await (const item of replaySessionEventsFromRunStore(input)) {
    if (seen >= maxEvents) break;
    const entry = transcriptEntryFromReplay(item);
    if (entry) entries.push(entry);
    seen += 1;
  }
  return {
    sessionId: input.session.id,
    entries,
    text: entries
      .map(
        (entry) =>
          `[${entry.timestamp}] ${entry.role.toUpperCase()} ${entry.runId}: ${entry.text}`,
      )
      .join("\n"),
    truncated: seen >= maxEvents,
  };
}

/**
 * Create a complete session fork using the storage implementation's native
 * snapshot semantics. Fork points are anchored to run identity rather than a
 * run-local event counter, so they remain stable across replay and providers.
 *
 * @public
 * @stability experimental v0.1
 */
export async function forkSession(
  input: ForkSessionInput,
): Promise<ForkSessionResult> {
  return input.store.forkSession({
    sourceSessionId: input.sourceSessionId,
    ...(input.forkPoint ? { forkPoint: input.forkPoint } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

async function forkLogicalSession(
  store: AppendOnlySessionStore,
  input: ForkSessionOptions,
): Promise<ForkSessionResult> {
  const source = await store.get(input.sourceSessionId);
  if (!source) {
    throw new Error(
      `Source session not found for fork: ${input.sourceSessionId}`,
    );
  }
  const retainedRunIds = retainedForkRunIds(source, input.forkPoint);
  return materializeLogicalFork(store, source, retainedRunIds, input);
}

async function materializeLogicalFork(
  store: AppendOnlySessionStore,
  source: SessionRecord,
  retainedRunIds: readonly RunId[],
  input: ForkSessionOptions,
): Promise<ForkSessionResult> {
  const forkPoint = input.forkPoint ? { ...input.forkPoint } : null;
  const lineage: SessionLineage = {
    parentSessionId: source.id,
    forkPoint,
  };
  const forked = await store.create({
    metadata: {
      ...(input.metadata ?? {}),
      lineage,
    },
  });
  await store.appendEvent(forked.id, {
    type: "session.forked",
    payload: {
      lineage,
      copiedRunCount: retainedRunIds.length,
    },
  });
  for (const runId of retainedRunIds) {
    await store.append(forked.id, runId);
  }
  const refreshed = await store.get(forked.id);
  return {
    forked: refreshed ?? forked,
    copiedRunCount: retainedRunIds.length,
    forkPoint,
  };
}

function retainedForkRunIds(
  source: SessionRecord,
  forkPoint?: SessionForkPoint,
): RunId[] {
  if (!forkPoint) return [...source.runIds];
  const index = source.runIds.indexOf(forkPoint.runId);
  if (index < 0) {
    throw new Error(
      `Fork point run ${forkPoint.runId} is not part of session ${source.id}`,
    );
  }
  const end = forkPoint.position === "after" ? index + 1 : index;
  return source.runIds.slice(0, end);
}

async function forkFileSession(
  store: FileSessionStore,
  input: ForkSessionOptions,
): Promise<ForkSessionResult> {
  const source = await store.get(input.sourceSessionId);
  if (!source) {
    throw new Error(
      `Source session not found for fork: ${input.sourceSessionId}`,
    );
  }
  const sourceDir = join(store.rootDir, source.id);
  const retainedRunIds = await retainedFileForkRunIds(
    source,
    sourceDir,
    input.forkPoint,
  );
  await mkdir(store.rootDir, { recursive: true });
  const stagingRoot = await mkdtemp(join(store.rootDir, ".fork-"));
  try {
    const stagingStore = new FileSessionStore({ rootDir: stagingRoot });
    const logical = await materializeLogicalFork(
      stagingStore,
      source,
      retainedRunIds,
      input,
    );
    await materializeForkSnapshot({
      sourceDir,
      targetDir: join(stagingRoot, logical.forked.id),
      targetSessionId: logical.forked.id,
      retainedRunIds,
    });
    await rename(
      join(stagingRoot, logical.forked.id),
      join(store.rootDir, logical.forked.id),
    );
    const forked = await store.get(logical.forked.id);
    if (!forked) {
      throw new Error(`Forked session disappeared: ${logical.forked.id}`);
    }
    return { ...logical, forked };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function retainedFileForkRunIds(
  source: SessionRecord,
  sourceDir: string,
  forkPoint?: SessionForkPoint,
): Promise<RunId[]> {
  const retained = retainedForkRunIds(source, forkPoint);
  if (!forkPoint || forkPoint.position !== "after") return retained;
  const runAgents = await loadSessionRunAgents(sourceDir);
  if (runAgents.get(forkPoint.runId) !== "main") return retained;
  const selectedIndex = source.runIds.indexOf(forkPoint.runId);
  let end = selectedIndex + 1;
  while (
    end < source.runIds.length &&
    runAgents.get(source.runIds[end]) !== "main"
  ) {
    end += 1;
  }
  return source.runIds.slice(0, end);
}

async function loadSessionRunAgents(
  sessionDir: string,
): Promise<Map<string, string>> {
  const agents = new Map<string, string>();
  let agentEntries;
  try {
    agentEntries = await readdir(join(sessionDir, "agents"), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return agents;
    throw error;
  }
  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    let runEntries;
    try {
      runEntries = await readdir(
        join(sessionDir, "agents", agentEntry.name, "runs"),
        { withFileTypes: true },
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    for (const runEntry of runEntries) {
      if (runEntry.isDirectory()) agents.set(runEntry.name, agentEntry.name);
    }
  }
  return agents;
}

interface MaterializeForkSnapshotInput {
  sourceDir: string;
  targetDir: string;
  targetSessionId: SessionId;
  retainedRunIds: readonly RunId[];
}

async function materializeForkSnapshot(
  input: MaterializeForkSnapshotInput,
): Promise<void> {
  const retained = new Set<string>(input.retainedRunIds);
  const traceEvents = (
    await readJsonLinesIfPresent(join(input.sourceDir, "trace.jsonl"))
  )
    .filter((event) => retained.has(stringField(event, "runId") ?? ""))
    .map((event) => withForkSessionIdentity(event, input.targetSessionId));
  await writeJsonLines(join(input.targetDir, "trace.jsonl"), traceEvents);

  const transcripts = (
    await readJsonLinesIfPresent(join(input.sourceDir, "transcript.jsonl"))
  )
    .filter((entry) => retained.has(stringField(entry, "runId") ?? ""))
    .map((entry) => ({ ...entry, sessionId: input.targetSessionId }));
  await writeJsonLines(join(input.targetDir, "transcript.jsonl"), transcripts);

  const agents = await copyForkRunDirectories(input, retained);
  const traceByAgent = groupByAgent(traceEvents);
  const transcriptByAgent = groupByAgent(transcripts);
  for (const agentId of agents) {
    const agentDir = join(input.targetDir, "agents", agentId);
    await mkdir(agentDir, { recursive: true });
    await writeJsonLines(
      join(agentDir, "trace.jsonl"),
      traceByAgent.get(agentId) ?? [],
    );
    await writeJsonLines(
      join(agentDir, "transcript.jsonl"),
      transcriptByAgent.get(agentId) ?? [],
    );
  }
  await mkdir(join(input.targetDir, "agents"), { recursive: true });
  await updateForkSessionAgents(input.targetDir, agents);
  await copyReferencedTranscriptBlobs(input, transcripts);
  await copyReferencedArtifacts(input, traceEvents);
}

async function copyForkRunDirectories(
  input: MaterializeForkSnapshotInput,
  retained: ReadonlySet<string>,
): Promise<Set<string>> {
  const agents = new Set<string>();
  const sourceAgentsDir = join(input.sourceDir, "agents");
  let entries;
  try {
    entries = await readdir(sourceAgentsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return agents;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceAgentDir = join(sourceAgentsDir, entry.name);
    const sourceRunsDir = join(sourceAgentDir, "runs");
    let runEntries;
    try {
      runEntries = await readdir(sourceRunsDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    const runIds = runEntries
      .filter(
        (runEntry) => runEntry.isDirectory() && retained.has(runEntry.name),
      )
      .map((runEntry) => runEntry.name);
    if (runIds.length === 0) continue;
    agents.add(entry.name);
    const targetAgentDir = join(input.targetDir, "agents", entry.name);
    await mkdir(join(targetAgentDir, "runs"), { recursive: true });
    for (const runId of runIds) {
      const targetRunDir = join(targetAgentDir, "runs", runId);
      await cp(join(sourceRunsDir, runId), targetRunDir, { recursive: true });
      await rewriteForkRunIdentity(targetRunDir, input.targetSessionId);
    }
    await writeForkAgentRecord({
      sourcePath: join(sourceAgentDir, "agent.json"),
      targetPath: join(targetAgentDir, "agent.json"),
      agentId: entry.name,
      sessionId: input.targetSessionId,
      runIds,
    });
  }
  return agents;
}

async function rewriteForkRunIdentity(
  runDir: string,
  sessionId: SessionId,
): Promise<void> {
  await rewriteJsonFileIfPresent(join(runDir, "run.json"), (record) => ({
    ...record,
    metadata: {
      ...(isRecord(record.metadata) ? record.metadata : {}),
      sessionId,
    },
  }));
  await rewriteJsonFileIfPresent(join(runDir, "checkpoint.json"), (record) => ({
    ...record,
    ...(isRecord(record.run)
      ? {
          run: {
            ...record.run,
            metadata: {
              ...(isRecord(record.run.metadata) ? record.run.metadata : {}),
              sessionId,
            },
          },
        }
      : {}),
  }));
  await rewriteJsonFileIfPresent(
    join(runDir, "trace-pointer.json"),
    (record) => ({ ...record, sessionId }),
  );
}

async function writeForkAgentRecord(input: {
  sourcePath: string;
  targetPath: string;
  agentId: string;
  sessionId: SessionId;
  runIds: string[];
}): Promise<void> {
  const source = await readJsonIfPresent(input.sourcePath);
  const now = new Date().toISOString();
  await writeFile(
    input.targetPath,
    `${JSON.stringify(
      {
        ...(source ?? {}),
        id: input.agentId,
        sessionId: input.sessionId,
        createdAt: stringField(source, "createdAt") ?? now,
        updatedAt: now,
        runIds: input.runIds,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function updateForkSessionAgents(
  targetDir: string,
  agents: ReadonlySet<string>,
): Promise<void> {
  const path = join(targetDir, "session.json");
  const session = await readJsonIfPresent(path);
  if (!session) throw new Error(`Fork session record missing: ${path}`);
  await writeFile(
    path,
    `${JSON.stringify({ ...session, agents: [...agents] }, null, 2)}\n`,
    "utf8",
  );
}

async function copyReferencedTranscriptBlobs(
  input: MaterializeForkSnapshotInput,
  transcripts: readonly Record<string, unknown>[],
): Promise<void> {
  const refs = new Set(
    transcripts
      .map((entry) => stringField(entry, "systemRef"))
      .filter((ref): ref is string => Boolean(ref)),
  );
  if (refs.size === 0) return;
  const sourceDir = join(input.sourceDir, "blobs");
  const targetDir = join(input.targetDir, "blobs");
  await mkdir(targetDir, { recursive: true });
  for (const ref of refs) {
    try {
      await copyFile(
        join(sourceDir, `${ref}.json`),
        join(targetDir, `${ref}.json`),
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
}

async function copyReferencedArtifacts(
  input: MaterializeForkSnapshotInput,
  traceEvents: readonly Record<string, unknown>[],
): Promise<void> {
  const artifactIds = new Set<string>();
  for (const event of traceEvents) {
    if (stringField(event, "type") !== "artifact.created") continue;
    if (!isRecord(event.payload)) continue;
    const id = stringField(event.payload, "id");
    if (id) artifactIds.add(id);
  }
  const targetDir = join(input.targetDir, "artifacts");
  await mkdir(targetDir, { recursive: true });
  if (artifactIds.size === 0) return;
  const sourceDir = join(input.sourceDir, "artifacts");
  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (![...artifactIds].some((id) => entry.startsWith(`${id}.`))) continue;
    await copyFile(join(sourceDir, entry), join(targetDir, entry));
  }
}

function groupByAgent(
  records: readonly Record<string, unknown>[],
): Map<string, Record<string, unknown>[]> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const record of records) {
    const metadata = isRecord(record.metadata) ? record.metadata : undefined;
    const agentId =
      stringField(record, "agentId") ??
      stringField(metadata, "agentId") ??
      "main";
    const items = grouped.get(agentId) ?? [];
    items.push(record);
    grouped.set(agentId, items);
  }
  return grouped;
}

function withForkSessionIdentity(
  event: Record<string, unknown>,
  sessionId: SessionId,
): Record<string, unknown> {
  return {
    ...event,
    metadata: {
      ...(isRecord(event.metadata) ? event.metadata : {}),
      sessionId,
    },
  };
}

async function readJsonLinesIfPresent(
  path: string,
): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const records: Record<string, unknown>[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error("JSON value is not an object");
      records.push(parsed);
    } catch (cause) {
      throw new Error(`Invalid JSONL in ${path} at line ${index + 1}`, {
        cause,
      });
    }
  }
  return records;
}

async function writeJsonLines(
  path: string,
  records: readonly Record<string, unknown>[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(path, content ? `${content}\n` : "", "utf8");
}

async function readJsonIfPresent(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function rewriteJsonFileIfPresent(
  path: string,
  transform: (record: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const record = await readJsonIfPresent(path);
  if (!record) return;
  await writeFile(
    path,
    `${JSON.stringify(transform(record), null, 2)}\n`,
    "utf8",
  );
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" ? value : undefined;
}

function formatReplayContextLine(
  event: SessionEvent<RunStoreReplayPayload>,
): string {
  const payload = event.payload.event.payload;
  const summary = isRecord(payload)
    ? JSON.stringify(pickReplayPayload(payload))
    : JSON.stringify(payload);
  return `[${event.timestamp}] ${event.payload.runId} ${event.payload.event.type} ${summary}`;
}

function transcriptEntryFromReplay(
  event: SessionEvent<RunStoreReplayPayload>,
): SessionTranscriptEntry | null {
  const replayed = event.payload.event;
  const payload = replayed.payload;
  const record = isRecord(payload) ? payload : {};
  if (replayed.type === "run.created") {
    return {
      timestamp: replayed.timestamp,
      runId: event.payload.runId,
      eventType: replayed.type,
      role: "user",
      text: String(record.goal ?? "Run started."),
    };
  }
  if (replayed.type === "model.completed") {
    return {
      timestamp: replayed.timestamp,
      runId: event.payload.runId,
      eventType: replayed.type,
      role: "assistant",
      text: String(record.message ?? record.text ?? "Model turn completed."),
    };
  }
  if (
    replayed.type === "tool.requested" ||
    replayed.type === "tool.completed" ||
    replayed.type === "tool.failed"
  ) {
    return {
      timestamp: replayed.timestamp,
      runId: event.payload.runId,
      eventType: replayed.type,
      role: "tool",
      text: `${String(record.toolName ?? "tool")} ${replayed.type.replace("tool.", "")}`,
    };
  }
  if (
    replayed.type === "run.completed" ||
    replayed.type === "run.failed" ||
    replayed.type === "run.cancelled"
  ) {
    return {
      timestamp: replayed.timestamp,
      runId: event.payload.runId,
      eventType: replayed.type,
      role: "system",
      text: String(record.stopReason ?? record.state ?? replayed.type),
    };
  }
  return null;
}

function pickReplayPayload(payload: Record<string, unknown>): unknown {
  const keys = [
    "goal",
    "state",
    "stopReason",
    "message",
    "toolName",
    "status",
    "path",
    "summary",
  ];
  const picked = Object.fromEntries(
    keys.filter((key) => key in payload).map((key) => [key, payload[key]]),
  );
  return Object.keys(picked).length > 0
    ? picked
    : summarizeReplayPayload(payload);
}

function summarizeReplayPayload(payload: Record<string, unknown>): unknown {
  return Object.fromEntries(
    Object.entries(payload)
      .slice(0, 8)
      .map(([key, value]) => [
        key,
        typeof value === "string" && value.length > 200
          ? `${value.slice(0, 200)}...`
          : value,
      ]),
  );
}
