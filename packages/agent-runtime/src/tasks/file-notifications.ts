import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  readJsonDocumentDirSync,
  writeJsonDocumentSync,
  type JsonDocumentInvalidEntry,
} from "../doc-store/index.js";
import {
  ActorNotificationUnsupportedError,
  acceptActorNotificationInput,
  type ActorInbox,
  type ActorNotificationPredicate,
  type ActorNotificationSink,
  type AnyActorNotificationInput,
  type DeliveryResult,
  type TaskTerminalActorNotification,
  type TaskTerminalActorNotificationInput,
} from "./notifications.js";

const TASK_NOTIFICATION_ENTRY_SCHEMA_VERSION =
  "sparkwright-task-notification.v1" as const;

/** Options accepted by {@link FileTaskNotificationOutbox}. */
export interface FileTaskNotificationOutboxOptions {
  /** Root directory for `task-notifications/*.json`. */
  rootDir: string;
  /** Create the outbox directory eagerly. Set false for read-mostly hosts. */
  createRoot?: boolean;
}

/** One canonical durable task actor notification input. */
export interface FileTaskNotificationEntry {
  schemaVersion: typeof TASK_NOTIFICATION_ENTRY_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  input: TaskTerminalActorNotificationInput;
}

export interface FileTaskNotificationInvalidEntry {
  id?: string;
  path: string;
  code: "read_failed" | "invalid_json" | "invalid_document";
  reason: string;
}

/** Durable task-terminal implementation of the canonical actor sink/inbox. */
export class FileTaskNotificationOutbox
  implements ActorNotificationSink, ActorInbox
{
  readonly rootDir: string;
  private nextActorSequence = 1;
  private readonly actorSequenceByEntryId = new Map<string, number>();
  private readonly invalidEntryByPath = new Map<
    string,
    FileTaskNotificationInvalidEntry
  >();
  private readonly readyWaiters: Array<{
    predicate?: ActorNotificationPredicate;
    resolve: () => void;
    reject: (cause: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(options: FileTaskNotificationOutboxOptions) {
    this.rootDir = resolve(options.rootDir);
    if (options.createRoot !== false) {
      mkdirSync(this.outboxDir(), { recursive: true });
    }
  }

  invalidEntries(): readonly FileTaskNotificationInvalidEntry[] {
    return [...this.invalidEntryByPath.values()].map((entry) => ({ ...entry }));
  }

  deliver(input: AnyActorNotificationInput): DeliveryResult {
    assertTerminalTaskInput(input);
    const createdAt = new Date().toISOString();
    acceptActorNotificationInput(input, {
      id: "pending-file-task-notification",
      sequence: 0,
      createdAt,
    });
    const id = createTaskNotificationEntryId(input, createdAt);
    const entry: FileTaskNotificationEntry = {
      schemaVersion: TASK_NOTIFICATION_ENTRY_SCHEMA_VERSION,
      id,
      createdAt,
      input: cloneJsonLike(input),
    };
    writeJsonDocumentSync(this.entryPath(id), entry);
    this.resolveReadyWaiters();
    return { status: "accepted", acceptedCount: 1 };
  }

  peek(
    predicate?: ActorNotificationPredicate,
  ): readonly TaskTerminalActorNotification[] {
    return this.listActorEntries()
      .map(({ notification }) => notification)
      .filter((notification) => !predicate || predicate(notification));
  }

  drain(
    predicate?: ActorNotificationPredicate,
  ): TaskTerminalActorNotification[] {
    const matched: Array<{
      id: string;
      notification: TaskTerminalActorNotification;
    }> = [];
    for (const entry of this.listActorEntries()) {
      if (predicate && !predicate(entry.notification)) continue;
      this.ack(entry.id);
      matched.push(entry);
    }
    return matched.map((entry) => entry.notification);
  }

  waitUntilAvailable(
    options: {
      signal?: AbortSignal;
      predicate?: ActorNotificationPredicate;
    } = {},
  ): Promise<void> {
    if (this.hasBuffered(options.predicate)) return Promise.resolve();
    if (options.signal?.aborted) return Promise.reject(makeAbortError());

    return new Promise((resolveWait, reject) => {
      const waiter = {
        predicate: options.predicate,
        resolve: resolveWait,
        reject,
        signal: options.signal,
        onAbort: undefined as (() => void) | undefined,
      };
      waiter.onAbort = () => {
        this.removeReadyWaiter(waiter);
        reject(makeAbortError());
      };
      options.signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.readyWaiters.push(waiter);
    });
  }

  private hasBuffered(predicate?: ActorNotificationPredicate): boolean {
    return this.peek(predicate).length > 0;
  }

  private resolveReadyWaiters(): void {
    for (const waiter of [...this.readyWaiters]) {
      if (!this.hasBuffered(waiter.predicate)) continue;
      this.removeReadyWaiter(waiter);
      waiter.resolve();
    }
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

  private listActorEntries(): Array<{
    id: string;
    notification: TaskTerminalActorNotification;
  }> {
    const listed = readJsonDocumentDirSync<FileTaskNotificationEntry>({
      dir: this.outboxDir(),
      extension: ".json",
      parse: parseTaskNotificationEntry,
    });
    this.pruneInvalidEntryDiagnostics(
      new Set([
        ...listed.entries.map((entry) => entry.path),
        ...listed.invalidEntries.map((entry) => entry.path),
      ]),
    );
    for (const invalid of listed.invalidEntries) {
      this.rememberInvalidEntry(invalid);
    }

    const entries: Array<{
      id: string;
      notification: TaskTerminalActorNotification;
    }> = [];
    for (const { value, path } of listed.entries) {
      try {
        entries.push({
          id: value.id,
          notification: acceptActorNotificationInput(value.input, {
            id: value.id,
            sequence: this.sequenceForEntryId(value.id),
            createdAt: value.createdAt,
          }) as TaskTerminalActorNotification,
        });
        this.invalidEntryByPath.delete(path);
      } catch (cause) {
        this.rememberInvalidEntry({
          id: value.id,
          path,
          code: "invalid_document",
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return entries.sort(
      (left, right) => left.notification.sequence - right.notification.sequence,
    );
  }

  private ack(id: string): void {
    assertSafeTaskNotificationEntryId(id);
    rmSync(this.entryPath(id), { force: true });
    this.actorSequenceByEntryId.delete(id);
    this.invalidEntryByPath.delete(this.entryPath(id));
  }

  private outboxDir(): string {
    return join(this.rootDir, "task-notifications");
  }

  private entryPath(id: string): string {
    return join(this.outboxDir(), `${id}.json`);
  }

  private sequenceForEntryId(id: string): number {
    const existing = this.actorSequenceByEntryId.get(id);
    if (existing !== undefined) return existing;
    const sequence = this.nextActorSequence;
    this.nextActorSequence += 1;
    this.actorSequenceByEntryId.set(id, sequence);
    return sequence;
  }

  private rememberInvalidEntry(
    entry: FileTaskNotificationInvalidEntry | JsonDocumentInvalidEntry,
  ): void {
    this.invalidEntryByPath.set(entry.path, { ...entry });
  }

  private pruneInvalidEntryDiagnostics(paths: ReadonlySet<string>): void {
    for (const path of this.invalidEntryByPath.keys()) {
      if (!paths.has(path)) this.invalidEntryByPath.delete(path);
    }
  }
}

function parseTaskNotificationEntry(raw: unknown): FileTaskNotificationEntry {
  if (!isRecord(raw)) throw new Error("entry must be an object");
  if (raw.schemaVersion !== TASK_NOTIFICATION_ENTRY_SCHEMA_VERSION) {
    throw new Error("unsupported task notification schemaVersion");
  }
  const id = stringField(raw, "id");
  assertSafeTaskNotificationEntryId(id);
  const createdAt = stringField(raw, "createdAt");
  const input = raw.input;
  if (!isRecord(input)) throw new Error("task notification input missing");
  assertTerminalTaskInput(input as unknown as AnyActorNotificationInput);
  return {
    schemaVersion: TASK_NOTIFICATION_ENTRY_SCHEMA_VERSION,
    id,
    createdAt,
    input: cloneJsonLike(
      input as unknown as TaskTerminalActorNotificationInput,
    ),
  };
}

function assertTerminalTaskInput(
  input: AnyActorNotificationInput,
): asserts input is TaskTerminalActorNotificationInput {
  if (input.source?.kind !== "task") {
    throw new ActorNotificationUnsupportedError(
      "FileTaskNotificationOutbox only supports task actor notifications.",
    );
  }
  if (
    input.type !== "completed" &&
    input.type !== "failed" &&
    input.type !== "cancelled"
  ) {
    throw new ActorNotificationUnsupportedError(
      "FileTaskNotificationOutbox only supports terminal task actor notifications.",
    );
  }
}

function createTaskNotificationEntryId(
  input: TaskTerminalActorNotificationInput,
  createdAt: string,
): string {
  const stamp = createdAt.replace(/[^0-9A-Za-z]/g, "");
  return [
    stamp,
    safeTaskNotificationSegment(input.source.id),
    safeTaskNotificationSegment(input.type),
    Math.random().toString(36).slice(2),
  ]
    .join("-")
    .slice(0, 180);
}

function safeTaskNotificationSegment(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]/g, "_").slice(0, 80) || "entry";
}

function assertSafeTaskNotificationEntryId(id: string): void {
  if (!/^[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*$/.test(id)) {
    throw new Error(`Unsafe task notification entry id: ${id}`);
  }
}

function makeAbortError(): Error {
  const error = new Error("Task actor notification wait aborted.");
  error.name = "AbortError";
  return error;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function cloneJsonLike<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
