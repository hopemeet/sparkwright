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
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
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

export type SessionEventType =
  | "session.created"
  | "session.run_appended"
  | "session.event_appended"
  | "session.run.event_replayed";

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
export class InMemorySessionStore implements AppendOnlySessionStore {
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
export class FileSessionStore implements AppendOnlySessionStore {
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

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  await writeFile(tmp, content, "utf8");
  // POSIX rename-over-existing is atomic, but Windows transiently rejects it
  // with EPERM/EACCES when another handle briefly holds the destination (a
  // concurrent reader, antivirus, or an overlapping append from the same run).
  // Retry with small backoff before giving up, and clean up the temp file on
  // final failure so we don't leak `.tmp-*` droppings.
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EEXIST") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  await rm(tmp, { force: true }).catch(() => {});
  throw lastError;
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

// ---------------------------------------------------------------------------
// Session forking. Inspired by the "rewind" pattern seen in agent-CLI prior art, pared down
// to a minimal AI-debugging primitive: take a source session, replay its
// events up to (and including) a chosen `forkAtSequence`, and write the
// resulting trimmed history into a brand-new session. The new session's
// `runIds` are the subset of runs whose first event lies on or before the
// fork point. Subsequent `createRun({ sessionStore, sessionId: forked.id })`
// calls extend the fork instead of the original.
//
// We keep this off the SessionStore interface so existing stores don't have
// to opt in; the helper relies only on `loadEvents` + `create` + `append`.
// ---------------------------------------------------------------------------

export interface ForkSessionInput {
  /** Source session to fork from. */
  sourceSessionId: string;
  /**
   * Last sequence number (inclusive) to retain in the fork. If omitted the
   * fork takes the full source history (a simple clone).
   */
  forkAtSequence?: number;
  store: AppendOnlySessionStore;
  /** Optional metadata to attach to the fork. Merged with provenance. */
  metadata?: Record<string, unknown>;
}

export interface ForkSessionResult {
  /** @reserved Public field consumed by session-fork UIs and debugging tools. */
  forked: SessionRecord;
  /** @reserved Public field consumed by session-fork UIs and debugging tools. */
  copiedEventCount: number;
  /** @reserved Public field consumed by session-fork UIs and debugging tools. */
  truncatedAtSequence: number | null;
}

/**
 * Fork a session at a specific event sequence. The new session is created
 * via `store.create`, then events up to `forkAtSequence` (inclusive) are
 * appended verbatim (preserving their `type`, `payload`, and `metadata` — but
 * with new `id`, `sessionId`, and re-numbered `sequence`). For
 * `session.run_appended` events the corresponding `runId` is also threaded
 * into the forked session's `runIds`.
 *
 * @public
 * @stability experimental v0.1
 */
export async function forkSessionFromEvent(
  input: ForkSessionInput,
): Promise<ForkSessionResult> {
  const source = await input.store.get(input.sourceSessionId);
  if (!source) {
    throw new Error(
      `Source session not found for fork: ${input.sourceSessionId}`,
    );
  }

  const forked = await input.store.create({
    metadata: {
      forkedFrom: source.id,
      forkedAtSequence: input.forkAtSequence ?? null,
      ...(input.metadata ?? {}),
    },
  });

  let copied = 0;
  let lastSequence: number | null = null;
  for await (const event of input.store.loadEvents(source.id)) {
    if (
      input.forkAtSequence !== undefined &&
      event.sequence > input.forkAtSequence
    ) {
      break;
    }
    if (event.type === "session.created") {
      // Skip — the new session already emitted its own `session.created`
      // during `store.create`.
      continue;
    }
    if (event.type === "session.run_appended") {
      const runId = isRecord(event.payload)
        ? (event.payload as { runId?: RunId }).runId
        : undefined;
      if (runId) {
        await input.store.append(forked.id, runId);
        copied += 1;
        lastSequence = event.sequence;
        continue;
      }
    }
    await input.store.appendEvent(forked.id, {
      type: event.type,
      timestamp: event.timestamp,
      payload: event.payload,
      metadata: {
        ...(event.metadata ?? {}),
        forkedFromSequence: event.sequence,
      },
    });
    copied += 1;
    lastSequence = event.sequence;
  }

  const refreshed = await input.store.get(forked.id);
  return {
    forked: refreshed ?? forked,
    copiedEventCount: copied,
    truncatedAtSequence: lastSequence,
  };
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
