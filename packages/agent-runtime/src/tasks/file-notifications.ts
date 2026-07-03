// AI maintenance note: durable task-notification outbox. This is deliberately
// transport-agnostic: deliver() appends a pending notification to disk; hosts
// call drain()/ack() or map drain() into streaming-runtime NotificationSource.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ActorNotificationUnsupportedError,
  acceptActorNotificationInput,
  actorNotificationInputFromTaskNotification,
  taskNotificationFromActorNotification,
} from "./notifications.js";
import type {
  ActorInbox,
  ActorNotificationPredicate,
  ActorNotificationSink,
  AnyActorNotification,
  AnyActorNotificationInput,
  DeliveryResult,
  TaskNotification,
  TaskNotificationReadyWaitOptions,
  TaskNotificationSink,
} from "./notifications.js";

/**
 * Options accepted by {@link FileTaskNotificationOutbox}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface FileTaskNotificationOutboxOptions {
  /** Root directory for `task-notifications/*.json`. */
  rootDir: string;
  /** Create the outbox directory eagerly. Set false for read-mostly hosts. */
  createRoot?: boolean;
}

/**
 * One durable notification entry.
 *
 * @public
 * @stability experimental v0.1
 */
export interface FileTaskNotificationEntry {
  id: string;
  notification: TaskNotification;
}

export interface FileTaskNotificationInvalidActorEntry {
  /** Entry id when the JSON envelope could be parsed far enough to read it. */
  id?: string;
  /** Absolute path to the invalid notification file. */
  path: string;
  /** Human-readable parse or actor-acceptance failure reason. */
  reason: string;
}

/**
 * Durable {@link TaskNotificationSink} that stores one JSON file per pending
 * notification.
 *
 * @public
 * @stability experimental v0.1
 */
export class FileTaskNotificationOutbox implements TaskNotificationSink {
  readonly rootDir: string;
  private nextActorSequence = 1;
  private readonly actorSequenceByEntryId = new Map<string, number>();
  private readonly actorCreatedAtByEntryId = new Map<string, string>();
  private readonly invalidActorEntryByPath = new Map<
    string,
    FileTaskNotificationInvalidActorEntry
  >();
  private readonly readyWaiters: Array<{
    predicate?: (notification: TaskNotification) => boolean;
    resolve: () => void;
    reject: (cause: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private readonly actorReadyWaiters: Array<{
    predicate?: ActorNotificationPredicate;
    resolve: () => void;
    reject: (cause: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private readonly actorSink: ActorNotificationSink = {
    deliver: (input) => this.deliverActor(input),
  };
  private readonly actorInbox: ActorInbox = {
    peek: (predicate) => this.peekActor(predicate),
    drain: (predicate) => this.drainActor(predicate),
    waitUntilAvailable: (options = {}) => this.waitUntilActorAvailable(options),
  };

  constructor(options: FileTaskNotificationOutboxOptions) {
    this.rootDir = resolve(options.rootDir);
    if (options.createRoot !== false) {
      mkdirSync(this.outboxDir(), { recursive: true });
    }
  }

  asActorSink(): ActorNotificationSink {
    return this.actorSink;
  }

  asActorInbox(): ActorInbox {
    return this.actorInbox;
  }

  /**
   * Diagnostics from the most recent outbox scan. Parse-stage failures
   * (unreadable/unparsable JSON, unsafe entry id) are skipped by BOTH the
   * legacy and actor views; actor-acceptance failures remain visible to the
   * legacy view and are skipped by the actor view only.
   */
  invalidActorEntries(): readonly FileTaskNotificationInvalidActorEntry[] {
    return [...this.invalidActorEntryByPath.values()].map((entry) => ({
      ...entry,
    }));
  }

  deliver(notification: TaskNotification): void {
    const accepted = acceptActorNotificationInput(
      actorNotificationInputFromTaskNotification(notification),
      {
        id: "pending-file-task-notification",
        sequence: 0,
      },
    );
    this.writeNotification(notification, accepted.createdAt);
  }

  private writeNotification(
    notification: TaskNotification,
    createdAt: string,
  ): FileTaskNotificationEntry {
    const entry: FileTaskNotificationEntry = {
      id: createNotificationEntryId(notification),
      notification,
    };
    atomicWriteTextSync(
      this.entryPath(entry.id),
      `${JSON.stringify(entry, null, 2)}\n`,
    );
    this.actorCreatedAtByEntryId.set(entry.id, createdAt);
    this.resolveAllReadyWaiters();
    return entry;
  }

  list(): FileTaskNotificationEntry[] {
    return this.listWithPaths().map(({ entry }) => entry);
  }

  /** Snapshot pending notifications without consuming them. */
  peek(
    predicate?: (notification: TaskNotification) => boolean,
  ): TaskNotification[] {
    return this.list()
      .map((entry) => entry.notification)
      .filter((notification) => !predicate || predicate(notification));
  }

  drain(
    predicate?: (notification: TaskNotification) => boolean,
  ): TaskNotification[] {
    const entries = this.list();
    const matched: TaskNotification[] = [];
    for (const entry of entries) {
      if (predicate && !predicate(entry.notification)) continue;
      this.ack(entry.id);
      matched.push(entry.notification);
    }
    return matched;
  }

  ack(id: string): void {
    assertSafeEntryId(id);
    rmSync(this.entryPath(id), { force: true });
    this.actorSequenceByEntryId.delete(id);
    this.actorCreatedAtByEntryId.delete(id);
    this.invalidActorEntryByPath.delete(this.entryPath(id));
  }

  /**
   * Resolve when at least one matching durable notification is available,
   * without consuming it. Cross-process producers should use polling or a
   * host-specific watcher; this wait covers same-process task completions and
   * already-persisted resume replay.
   */
  waitUntilAvailable(
    options: TaskNotificationReadyWaitOptions = {},
  ): Promise<void> {
    if (this.hasBuffered(options.predicate)) return Promise.resolve();
    if (options.signal?.aborted) return Promise.reject(makeAbortError());

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: options.predicate,
        resolve,
        reject,
        signal: options.signal,
        onAbort: undefined as (() => void) | undefined,
      };
      waiter.onAbort = () => {
        this.removeReadyWaiter(waiter);
        reject(makeAbortError());
      };
      options.signal?.addEventListener("abort", waiter.onAbort, {
        once: true,
      });
      this.readyWaiters.push(waiter);
    });
  }

  private outboxDir(): string {
    return join(this.rootDir, "task-notifications");
  }

  private entryPath(id: string): string {
    return join(this.outboxDir(), `${id}.json`);
  }

  private hasBuffered(
    predicate?: (notification: TaskNotification) => boolean,
  ): boolean {
    return this.peek(predicate).length > 0;
  }

  private deliverActor(input: AnyActorNotificationInput): DeliveryResult {
    const accepted = acceptActorNotificationInput(input, {
      id: "pending-file-task-notification",
      sequence: 0,
    });
    const taskNotification = taskNotificationFromActorNotification(accepted);
    if (!taskNotification) {
      throw new ActorNotificationUnsupportedError(
        "FileTaskNotificationOutbox only supports terminal task actor notifications.",
      );
    }
    assertPersistableLegacyTaskActorNotification(accepted);
    this.writeNotification(taskNotification, accepted.createdAt);
    return { status: "accepted", acceptedCount: 1 };
  }

  private peekActor(
    predicate?: ActorNotificationPredicate,
  ): readonly AnyActorNotification[] {
    return this.listActorEntries()
      .map(({ notification }) => notification)
      .filter((notification) => !predicate || predicate(notification));
  }

  private drainActor(
    predicate?: ActorNotificationPredicate,
  ): AnyActorNotification[] {
    const matched: Array<{
      id: string;
      notification: AnyActorNotification;
    }> = [];
    for (const entry of this.listActorEntries()) {
      if (predicate && !predicate(entry.notification)) continue;
      this.ack(entry.id);
      matched.push(entry);
    }
    return matched.map((entry) => entry.notification);
  }

  private waitUntilActorAvailable(
    options: {
      signal?: AbortSignal;
      predicate?: ActorNotificationPredicate;
    } = {},
  ): Promise<void> {
    if (this.hasActorBuffered(options.predicate)) return Promise.resolve();
    if (options.signal?.aborted) return Promise.reject(makeAbortError());

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: options.predicate,
        resolve,
        reject,
        signal: options.signal,
        onAbort: undefined as (() => void) | undefined,
      };
      waiter.onAbort = () => {
        this.removeActorReadyWaiter(waiter);
        reject(makeAbortError());
      };
      options.signal?.addEventListener("abort", waiter.onAbort, {
        once: true,
      });
      this.actorReadyWaiters.push(waiter);
    });
  }

  private hasActorBuffered(predicate?: ActorNotificationPredicate): boolean {
    return this.peekActor(predicate).length > 0;
  }

  private resolveReadyWaiters(): void {
    for (const waiter of [...this.readyWaiters]) {
      if (!this.hasBuffered(waiter.predicate)) continue;
      this.removeReadyWaiter(waiter);
      waiter.resolve();
    }
  }

  private resolveActorReadyWaiters(): void {
    for (const waiter of [...this.actorReadyWaiters]) {
      if (!this.hasActorBuffered(waiter.predicate)) continue;
      this.removeActorReadyWaiter(waiter);
      waiter.resolve();
    }
  }

  private resolveAllReadyWaiters(): void {
    this.resolveReadyWaiters();
    this.resolveActorReadyWaiters();
  }

  private removeReadyWaiter(waiter: {
    signal?: AbortSignal;
    onAbort?: () => void;
  }): void {
    const index = this.readyWaiters.indexOf(
      waiter as (typeof this.readyWaiters)[number],
    );
    if (index >= 0) this.readyWaiters.splice(index, 1);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  private removeActorReadyWaiter(waiter: {
    signal?: AbortSignal;
    onAbort?: () => void;
  }): void {
    const index = this.actorReadyWaiters.indexOf(
      waiter as (typeof this.actorReadyWaiters)[number],
    );
    if (index >= 0) this.actorReadyWaiters.splice(index, 1);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  private listWithPaths(): Array<{
    entry: FileTaskNotificationEntry;
    path: string;
  }> {
    const paths = this.listEntryPaths();
    this.pruneInvalidActorEntryDiagnostics(paths);
    return this.parseEntries(paths);
  }

  private listActorEntries(): Array<{
    id: string;
    notification: AnyActorNotification;
  }> {
    const paths = this.listEntryPaths();
    this.pruneInvalidActorEntryDiagnostics(paths);
    const entries: Array<{
      id: string;
      notification: AnyActorNotification;
    }> = [];
    for (const { entry, path } of this.parseEntries(paths)) {
      try {
        entries.push({
          id: entry.id,
          notification: this.actorNotificationForEntry(entry, path),
        });
        this.invalidActorEntryByPath.delete(path);
      } catch (cause) {
        this.rememberInvalidActorEntry({ id: entry.id, path, cause });
      }
    }
    return entries.sort(
      (a, b) => a.notification.sequence - b.notification.sequence,
    );
  }

  /**
   * Parse and id-sort entry files, skipping (and remembering) unreadable,
   * unparsable, or id-less files instead of wedging every consumer view.
   * Sorting by entry id BEFORE lazy sequence assignment keeps derived actor
   * sequences aligned with stable storage order rather than readdir order.
   */
  private parseEntries(
    paths: readonly string[],
  ): Array<{ entry: FileTaskNotificationEntry; path: string }> {
    const parsed: Array<{ entry: FileTaskNotificationEntry; path: string }> =
      [];
    for (const path of paths) {
      try {
        const entry = parseJson<FileTaskNotificationEntry>(
          readFileSync(path, "utf8"),
          path,
        );
        if (typeof entry.id !== "string" || !isSafeEntryId(entry.id)) {
          throw new Error(
            `Invalid task notification entry id at ${path}: expected a safe non-empty string.`,
          );
        }
        parsed.push({ entry, path });
        if (this.invalidActorEntryByPath.get(path)?.id === undefined) {
          this.invalidActorEntryByPath.delete(path);
        }
      } catch (cause) {
        this.rememberInvalidActorEntry({ path, cause });
      }
    }
    return parsed.sort((a, b) => a.entry.id.localeCompare(b.entry.id));
  }

  private actorNotificationForEntry(
    entry: FileTaskNotificationEntry,
    path: string,
  ): AnyActorNotification {
    return acceptActorNotificationInput(
      actorNotificationInputFromTaskNotification(entry.notification),
      {
        id: entry.id,
        sequence: this.sequenceForEntryId(entry.id),
        createdAt: this.createdAtForEntryId(entry.id, path),
      },
    );
  }

  private sequenceForEntryId(id: string): number {
    // File-backed actor peek/drain assign sequence lazily. The map is the
    // high-water mark that prevents later older filenames from going backwards.
    const existing = this.actorSequenceByEntryId.get(id);
    if (existing !== undefined) return existing;
    const sequence = this.nextActorSequence;
    this.nextActorSequence += 1;
    this.actorSequenceByEntryId.set(id, sequence);
    return sequence;
  }

  private createdAtForEntryId(id: string, path: string): string {
    const existing = this.actorCreatedAtByEntryId.get(id);
    if (existing !== undefined) return existing;
    const stats = statSync(path);
    const createdAt = new Date(
      stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs,
    ).toISOString();
    this.actorCreatedAtByEntryId.set(id, createdAt);
    return createdAt;
  }

  private listEntryPaths(): string[] {
    if (!existsSync(this.outboxDir())) return [];
    return readdirSync(this.outboxDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(this.outboxDir(), entry.name));
  }

  private rememberInvalidActorEntry(input: {
    id?: string;
    path: string;
    cause: unknown;
  }): void {
    const reason =
      input.cause instanceof Error ? input.cause.message : String(input.cause);
    const diagnostic: FileTaskNotificationInvalidActorEntry = {
      path: input.path,
      reason,
    };
    if (input.id !== undefined) diagnostic.id = input.id;
    this.invalidActorEntryByPath.set(input.path, diagnostic);
  }

  private pruneInvalidActorEntryDiagnostics(paths: readonly string[]): void {
    const currentPaths = new Set(paths);
    for (const path of this.invalidActorEntryByPath.keys()) {
      if (!currentPaths.has(path)) {
        this.invalidActorEntryByPath.delete(path);
      }
    }
  }
}

function createNotificationEntryId(notification: TaskNotification): string {
  const stamp = notification.deliveredAt.replace(/[^0-9A-Za-z]/g, "");
  return `${stamp}-${notification.taskId}-${Math.random().toString(36).slice(2)}`;
}

function assertPersistableLegacyTaskActorNotification(
  notification: AnyActorNotification,
): void {
  const unsupportedFields: string[] = [];
  if (notification.source.sessionId !== undefined) {
    unsupportedFields.push("source.sessionId");
  }
  if (notification.routeHint?.sessionId !== undefined) {
    unsupportedFields.push("routeHint.sessionId");
  }
  if (notification.correlationId !== undefined) {
    unsupportedFields.push("correlationId");
  }
  if (notification.suggestedContext !== undefined) {
    unsupportedFields.push("suggestedContext");
  }
  if (unsupportedFields.length === 0) return;
  throw new ActorNotificationUnsupportedError(
    `FileTaskNotificationOutbox cannot persist actor-only fields without changing the task notification file format: ${unsupportedFields.join(
      ", ",
    )}.`,
  );
}

function atomicWriteTextSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function makeAbortError(): Error {
  const error = new Error("Task notification wait aborted.");
  error.name = "AbortError";
  return error;
}

function parseJson<T>(text: string, path: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "invalid JSON";
    throw new Error(`Invalid task notification JSON at ${path}: ${message}`);
  }
}

function isSafeEntryId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function assertSafeEntryId(id: string): void {
  if (!isSafeEntryId(id)) {
    throw new Error(`Unsafe notification entry id: ${id}`);
  }
}
