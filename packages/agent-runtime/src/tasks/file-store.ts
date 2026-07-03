// AI maintenance note: FileTaskStore is the local durable TaskStore adapter.
// TaskStore is intentionally synchronous today, so this adapter uses sync fs
// operations internally while preserving atomic replace for records and append
// only JSONL for output. Hosts that need high-concurrency multi-process safety
// should wrap calls in their own process lock.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  CreateTaskInput,
  TaskListFilter,
  TaskStore,
  TaskUpdatePatch,
} from "./store.js";
import type { TaskId, TaskOutputChunk, TaskRecord } from "./types.js";

/**
 * Options accepted by {@link FileTaskStore}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface FileTaskStoreOptions {
  /** Root directory for `tasks/<taskId>/record.json` and `output.jsonl`. */
  rootDir: string;
  /** Create the root eagerly. Set false for read-only inspection commands. */
  createRoot?: boolean;
}

/**
 * File-backed implementation of {@link TaskStore}.
 *
 * Layout:
 *
 * ```text
 * <rootDir>/tasks/<taskId>/record.json
 * <rootDir>/tasks/<taskId>/output.jsonl
 * ```
 *
 * @public
 * @stability experimental v0.1
 */
export class FileTaskStore implements TaskStore {
  readonly rootDir: string;
  private readonly records = new Map<TaskId, TaskRecord>();

  constructor(options: FileTaskStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    if (options.createRoot !== false) {
      mkdirSync(this.tasksDir(), { recursive: true });
    }
    this.loadExistingRecords();
  }

  create(input: CreateTaskInput): TaskRecord {
    assertSafeTaskId(input.id);
    if (this.records.has(input.id)) {
      throw new Error(`Task already exists: ${input.id}`);
    }
    const record: TaskRecord = {
      id: input.id,
      parentRunId: input.parentRunId,
      kind: input.kind,
      title: input.title,
      awaited: input.awaited ?? true,
      status: "pending",
      createdAt: new Date().toISOString(),
      metadata: { ...(input.metadata ?? {}) },
    };
    mkdirSync(this.taskDir(input.id), { recursive: true });
    this.records.set(input.id, record);
    this.writeRecord(record);
    if (!existsSync(this.outputPath(input.id))) {
      writeFileSync(this.outputPath(input.id), "", "utf8");
    }
    return cloneRecord(record);
  }

  get(id: TaskId): TaskRecord | undefined {
    assertSafeTaskId(id);
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  list(filter: TaskListFilter = {}): TaskRecord[] {
    return [...this.records.values()]
      .filter((record) => {
        if (filter.status && record.status !== filter.status) return false;
        if (filter.kind && record.kind !== filter.kind) return false;
        if (filter.awaited !== undefined && record.awaited !== filter.awaited)
          return false;
        if (filter.parentRunId && record.parentRunId !== filter.parentRunId) {
          return false;
        }
        return true;
      })
      .map(cloneRecord);
  }

  update(id: TaskId, patch: TaskUpdatePatch): TaskRecord {
    assertSafeTaskId(id);
    const existing = this.records.get(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }
    const updated: TaskRecord = {
      ...existing,
      ...("status" in patch && patch.status !== undefined
        ? { status: patch.status }
        : {}),
      ...("awaited" in patch && patch.awaited !== undefined
        ? { awaited: patch.awaited }
        : {}),
      ...("startedAt" in patch && patch.startedAt !== undefined
        ? { startedAt: patch.startedAt }
        : {}),
      ...("lastOutputAt" in patch && patch.lastOutputAt !== undefined
        ? { lastOutputAt: patch.lastOutputAt }
        : {}),
      ...("lastProgressAt" in patch && patch.lastProgressAt !== undefined
        ? { lastProgressAt: patch.lastProgressAt }
        : {}),
      ...("lastHealthCheckAt" in patch && patch.lastHealthCheckAt !== undefined
        ? { lastHealthCheckAt: patch.lastHealthCheckAt }
        : {}),
      ...("outputChunks" in patch && patch.outputChunks !== undefined
        ? { outputChunks: patch.outputChunks }
        : {}),
      ...("outputBytes" in patch && patch.outputBytes !== undefined
        ? { outputBytes: patch.outputBytes }
        : {}),
      ...("completedAt" in patch && patch.completedAt !== undefined
        ? { completedAt: patch.completedAt }
        : {}),
      ...("result" in patch ? { result: patch.result } : {}),
      ...("error" in patch && patch.error !== undefined
        ? { error: patch.error }
        : {}),
      ...("title" in patch && patch.title !== undefined
        ? { title: patch.title }
        : {}),
      ...(patch.metadata
        ? { metadata: { ...existing.metadata, ...patch.metadata } }
        : {}),
    };
    this.records.set(id, updated);
    this.writeRecord(updated);
    return cloneRecord(updated);
  }

  appendOutput(
    id: TaskId,
    chunk: Omit<TaskOutputChunk, "sequence">,
  ): TaskOutputChunk {
    assertSafeTaskId(id);
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Task not found: ${id}`);
    }
    const sequence =
      record.outputChunks ?? countOutputChunks(this.outputPath(id));
    const full: TaskOutputChunk = { ...chunk, sequence };
    mkdirSync(this.taskDir(id), { recursive: true });
    appendFileSync(this.outputPath(id), `${JSON.stringify(full)}\n`, "utf8");
    this.update(id, {
      lastOutputAt: full.timestamp,
      outputChunks: sequence + 1,
      outputBytes: (record.outputBytes ?? 0) + full.data.length,
    });
    return full;
  }

  async *loadOutput(
    id: TaskId,
    fromSequence = 0,
  ): AsyncIterable<TaskOutputChunk> {
    assertSafeTaskId(id);
    if (!this.records.has(id)) {
      throw new Error(`Task not found: ${id}`);
    }
    const lines = readLinesIfExists(this.outputPath(id));
    for (const line of lines) {
      const chunk = parseJson<TaskOutputChunk>(line, this.outputPath(id));
      if (chunk.sequence >= fromSequence) {
        yield chunk;
      }
    }
  }

  /**
   * Mark a missing running task as failed. Useful when a host detects that a
   * task directory was removed manually but still has an external task id.
   */
  writeTombstone(record: TaskRecord): TaskRecord {
    assertSafeTaskId(record.id);
    const failed: TaskRecord = {
      ...record,
      status: "failed",
      completedAt: record.completedAt ?? new Date().toISOString(),
      error: record.error ?? {
        code: "TASK_RECORD_DELETED",
        message: "Task record was removed while the task was running.",
      },
    };
    mkdirSync(this.taskDir(record.id), { recursive: true });
    this.records.set(record.id, failed);
    this.writeRecord(failed);
    return cloneRecord(failed);
  }

  remove(id: TaskId): void {
    assertSafeTaskId(id);
    this.records.delete(id);
    rmSync(this.taskDir(id), { recursive: true, force: true });
  }

  private loadExistingRecords(): void {
    if (!existsSync(this.tasksDir())) return;
    for (const entry of readdirSync(this.tasksDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = entry.name as unknown as TaskId;
      if (!isSafeTaskId(id)) continue;
      const path = this.recordPath(id);
      if (!existsSync(path)) continue;
      const record = parseJson<TaskRecord>(readFileSync(path, "utf8"), path);
      this.records.set(id, { ...record, awaited: record.awaited ?? true });
    }
  }

  private tasksDir(): string {
    return join(this.rootDir, "tasks");
  }

  private taskDir(id: TaskId): string {
    return join(this.tasksDir(), String(id));
  }

  private recordPath(id: TaskId): string {
    return join(this.taskDir(id), "record.json");
  }

  private outputPath(id: TaskId): string {
    return join(this.taskDir(id), "output.jsonl");
  }

  private writeRecord(record: TaskRecord): void {
    atomicWriteTextSync(
      this.recordPath(record.id),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }
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

function readLinesIfExists(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function countOutputChunks(path: string): number {
  return readLinesIfExists(path).length;
}

function parseJson<T>(text: string, path: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "invalid JSON";
    throw new Error(`Invalid task store JSON at ${path}: ${message}`);
  }
}

function cloneRecord(record: TaskRecord): TaskRecord {
  return {
    ...record,
    metadata: { ...record.metadata },
    error: record.error ? { ...record.error } : undefined,
  };
}

function assertSafeTaskId(id: TaskId): void {
  if (!isSafeTaskId(id)) {
    throw new Error(`Unsafe task id: ${id}`);
  }
}

function isSafeTaskId(id: TaskId): boolean {
  return /^task_[A-Za-z0-9_-]+$/.test(String(id));
}
