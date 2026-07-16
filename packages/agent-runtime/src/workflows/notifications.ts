import { mkdirSync, rmSync, statSync } from "node:fs";
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
  type AnyActorNotification,
  type AnyActorNotificationInput,
  type DeliveryResult,
} from "../tasks/notifications.js";

const WORKFLOW_NOTIFICATION_ENTRY_SCHEMA_VERSION =
  "sparkwright-workflow-notification.v1" as const;

export interface FileWorkflowNotificationOutboxOptions {
  /** Root directory for `workflow-notifications/*.json`. */
  rootDir: string;
  /** Create the outbox directory eagerly. Set false for read-mostly hosts. */
  createRoot?: boolean;
}

export interface FileWorkflowNotificationEntry {
  schemaVersion: typeof WORKFLOW_NOTIFICATION_ENTRY_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  input: AnyActorNotificationInput;
}

export interface FileWorkflowNotificationInvalidEntry {
  id?: string;
  path: string;
  code: "read_failed" | "invalid_json" | "invalid_document";
  reason: string;
}

export class FileWorkflowNotificationOutbox
  implements ActorNotificationSink, ActorInbox
{
  readonly rootDir: string;
  private nextActorSequence = 1;
  private readonly actorSequenceByEntryId = new Map<string, number>();
  private readonly actorCreatedAtByEntryId = new Map<string, string>();
  private readonly invalidActorEntryByPath = new Map<
    string,
    FileWorkflowNotificationInvalidEntry
  >();
  private readonly actorReadyWaiters: Array<{
    predicate?: ActorNotificationPredicate;
    resolve: () => void;
    reject: (cause: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(options: FileWorkflowNotificationOutboxOptions) {
    this.rootDir = resolve(options.rootDir);
    if (options.createRoot !== false) {
      mkdirSync(this.outboxDir(), { recursive: true });
    }
  }

  invalidEntries(): readonly FileWorkflowNotificationInvalidEntry[] {
    return [...this.invalidActorEntryByPath.values()].map((entry) => ({
      ...entry,
    }));
  }

  deliver(input: AnyActorNotificationInput): DeliveryResult {
    if (input.source.kind !== "workflow") {
      throw new ActorNotificationUnsupportedError(
        "FileWorkflowNotificationOutbox only supports workflow actor notifications.",
      );
    }
    const createdAt = new Date().toISOString();
    acceptActorNotificationInput(input, {
      id: "pending-file-workflow-notification",
      sequence: 0,
      createdAt,
    });
    const id = createWorkflowNotificationEntryId(input, createdAt);
    const entry: FileWorkflowNotificationEntry = {
      schemaVersion: WORKFLOW_NOTIFICATION_ENTRY_SCHEMA_VERSION,
      id,
      createdAt,
      input: cloneJsonLike(input),
    };
    writeJsonDocumentSync(this.entryPath(id), entry);
    this.actorCreatedAtByEntryId.set(id, createdAt);
    this.resolveActorReadyWaiters();
    return { status: "accepted", acceptedCount: 1 };
  }

  peek(
    predicate?: ActorNotificationPredicate,
  ): readonly AnyActorNotification[] {
    return this.listActorEntries()
      .map(({ notification }) => notification)
      .filter((notification) => !predicate || predicate(notification));
  }

  drain(predicate?: ActorNotificationPredicate): AnyActorNotification[] {
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

  waitUntilAvailable(
    options: {
      signal?: AbortSignal;
      predicate?: ActorNotificationPredicate;
    } = {},
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
        this.removeActorReadyWaiter(waiter);
        reject(makeAbortError());
      };
      options.signal?.addEventListener("abort", waiter.onAbort, {
        once: true,
      });
      this.actorReadyWaiters.push(waiter);
    });
  }

  private hasBuffered(predicate?: ActorNotificationPredicate): boolean {
    return this.peek(predicate).length > 0;
  }

  private resolveActorReadyWaiters(): void {
    for (const waiter of [...this.actorReadyWaiters]) {
      if (!this.hasBuffered(waiter.predicate)) continue;
      this.removeActorReadyWaiter(waiter);
      waiter.resolve();
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

  private listActorEntries(): Array<{
    id: string;
    notification: AnyActorNotification;
  }> {
    const listed = readJsonDocumentDirSync<FileWorkflowNotificationEntry>({
      dir: this.outboxDir(),
      extension: ".json",
      parse: parseWorkflowNotificationEntry,
    });
    this.pruneInvalidActorEntryDiagnostics(
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
      notification: AnyActorNotification;
    }> = [];
    for (const { value, path } of listed.entries) {
      try {
        entries.push({
          id: value.id,
          notification: acceptActorNotificationInput(value.input, {
            id: value.id,
            sequence: this.sequenceForEntryId(value.id),
            createdAt: this.createdAtForEntry(value, path),
          }),
        });
        this.invalidActorEntryByPath.delete(path);
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
    assertSafeWorkflowNotificationEntryId(id);
    rmSync(this.entryPath(id), { force: true });
    this.actorSequenceByEntryId.delete(id);
    this.actorCreatedAtByEntryId.delete(id);
    this.invalidActorEntryByPath.delete(this.entryPath(id));
  }

  private outboxDir(): string {
    return join(this.rootDir, "workflow-notifications");
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

  private createdAtForEntry(
    entry: FileWorkflowNotificationEntry,
    path: string,
  ): string {
    const existing = this.actorCreatedAtByEntryId.get(entry.id);
    if (existing !== undefined) return existing;
    if (entry.createdAt) {
      this.actorCreatedAtByEntryId.set(entry.id, entry.createdAt);
      return entry.createdAt;
    }
    const stats = statSync(path);
    const createdAt = new Date(
      stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs,
    ).toISOString();
    this.actorCreatedAtByEntryId.set(entry.id, createdAt);
    return createdAt;
  }

  private rememberInvalidEntry(
    entry: FileWorkflowNotificationInvalidEntry | JsonDocumentInvalidEntry,
  ): void {
    this.invalidActorEntryByPath.set(entry.path, { ...entry });
  }

  private pruneInvalidActorEntryDiagnostics(paths: ReadonlySet<string>): void {
    for (const path of this.invalidActorEntryByPath.keys()) {
      if (!paths.has(path)) this.invalidActorEntryByPath.delete(path);
    }
  }
}

function parseWorkflowNotificationEntry(
  raw: unknown,
): FileWorkflowNotificationEntry {
  if (!isRecord(raw)) throw new Error("entry must be an object");
  if (raw.schemaVersion !== WORKFLOW_NOTIFICATION_ENTRY_SCHEMA_VERSION) {
    throw new Error("unsupported workflow notification schemaVersion");
  }
  const id = stringField(raw, "id");
  assertSafeWorkflowNotificationEntryId(id);
  const input = raw.input;
  if (!isRecord(input)) throw new Error("workflow notification input missing");
  if (!isRecord(input.source) || input.source.kind !== "workflow") {
    throw new Error("workflow notification input source.kind must be workflow");
  }
  return {
    schemaVersion: WORKFLOW_NOTIFICATION_ENTRY_SCHEMA_VERSION,
    id,
    createdAt: stringField(raw, "createdAt"),
    input: cloneJsonLike(input) as unknown as AnyActorNotificationInput,
  };
}

function createWorkflowNotificationEntryId(
  input: AnyActorNotificationInput,
  createdAt: string,
): string {
  const correlation = input.correlationId
    ? safeWorkflowNotificationSegment(input.correlationId)
    : undefined;
  if (correlation) {
    return [
      safeWorkflowNotificationSegment(input.source.id),
      safeWorkflowNotificationSegment(input.type),
      correlation,
    ]
      .join("-")
      .slice(0, 180);
  }
  const stamp = createdAt.replace(/[^0-9A-Za-z]/g, "");
  return [
    stamp,
    safeWorkflowNotificationSegment(input.source.id),
    safeWorkflowNotificationSegment(input.type),
    Math.random().toString(36).slice(2),
  ]
    .join("-")
    .slice(0, 180);
}

function safeWorkflowNotificationSegment(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]/g, "_").slice(0, 80) || "entry";
}

function assertSafeWorkflowNotificationEntryId(id: string): void {
  if (!/^[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*$/.test(id)) {
    throw new Error(`Unsafe workflow notification entry id: ${id}`);
  }
}

function makeAbortError(): Error {
  const error = new Error("Workflow notification wait aborted.");
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
