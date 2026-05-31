// AI maintenance note: durable task-notification outbox. This is deliberately
// transport-agnostic: deliver() appends a pending notification to disk; hosts
// call drain()/ack() or map drain() into streaming-runtime NotificationSource.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  TaskNotification,
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

/**
 * Durable {@link TaskNotificationSink} that stores one JSON file per pending
 * notification.
 *
 * @public
 * @stability experimental v0.1
 */
export class FileTaskNotificationOutbox implements TaskNotificationSink {
  readonly rootDir: string;

  constructor(options: FileTaskNotificationOutboxOptions) {
    this.rootDir = resolve(options.rootDir);
    mkdirSync(this.outboxDir(), { recursive: true });
  }

  deliver(notification: TaskNotification): void {
    const entry: FileTaskNotificationEntry = {
      id: createNotificationEntryId(notification),
      notification,
    };
    atomicWriteTextSync(
      this.entryPath(entry.id),
      `${JSON.stringify(entry, null, 2)}\n`,
    );
  }

  list(): FileTaskNotificationEntry[] {
    return readdirSync(this.outboxDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) =>
        parseJson<FileTaskNotificationEntry>(
          readFileSync(join(this.outboxDir(), entry.name), "utf8"),
          join(this.outboxDir(), entry.name),
        ),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  drain(): TaskNotification[] {
    const entries = this.list();
    for (const entry of entries) {
      this.ack(entry.id);
    }
    return entries.map((entry) => entry.notification);
  }

  ack(id: string): void {
    assertSafeEntryId(id);
    rmSync(this.entryPath(id), { force: true });
  }

  private outboxDir(): string {
    return join(this.rootDir, "task-notifications");
  }

  private entryPath(id: string): string {
    return join(this.outboxDir(), `${id}.json`);
  }
}

function createNotificationEntryId(notification: TaskNotification): string {
  const stamp = notification.deliveredAt.replace(/[^0-9A-Za-z]/g, "");
  return `${stamp}-${notification.taskId}-${Math.random().toString(36).slice(2)}`;
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

function parseJson<T>(text: string, path: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "invalid JSON";
    throw new Error(`Invalid task notification JSON at ${path}: ${message}`);
  }
}

function assertSafeEntryId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Unsafe notification entry id: ${id}`);
  }
}
