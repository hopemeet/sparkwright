// AI maintenance note: TaskStore is the extension point for task persistence.
// The in-memory reference impl is sufficient for tests and single-process
// hosts; remote/durable hosts (e.g. job queues) replace it. Keep this surface
// small — anything richer (search, pagination, retention) belongs in a
// host-specific adapter, not here.

import type {
  TaskError,
  TaskId,
  TaskOutputChunk,
  TaskRecord,
  TaskStatus,
} from "./types.js";

/**
 * Optional filter accepted by `TaskStore.list`.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskListFilter {
  status?: TaskStatus;
  kind?: string;
  parentRunId?: string;
  awaited?: boolean;
}

/**
 * Patch shape accepted by `TaskStore.update`. Only present keys are written.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskUpdatePatch {
  awaited?: boolean;
  status?: TaskStatus;
  startedAt?: string;
  lastOutputAt?: string;
  lastProgressAt?: string;
  lastHealthCheckAt?: string;
  outputChunks?: number;
  outputBytes?: number;
  completedAt?: string;
  result?: unknown;
  error?: TaskError;
  title?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Initial values required to create a task record.
 *
 * @public
 * @stability experimental v0.1
 */
export interface CreateTaskInput {
  id: TaskId;
  parentRunId: TaskRecord["parentRunId"];
  kind: string;
  title?: string;
  awaited?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Persistence + streaming surface for tasks. Hosts implement this when they
 * want durable or cross-process tasks; otherwise use {@link InMemoryTaskStore}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskStore {
  create(input: CreateTaskInput): TaskRecord;
  get(id: TaskId): TaskRecord | undefined;
  list(filter?: TaskListFilter): TaskRecord[];
  update(id: TaskId, patch: TaskUpdatePatch): TaskRecord;
  remove?(id: TaskId): void;
  appendOutput(
    id: TaskId,
    chunk: Omit<TaskOutputChunk, "sequence">,
  ): TaskOutputChunk;
  /**
   * Yield buffered output chunks for a task. Implementations MAY also yield
   * live chunks until the task reaches a terminal state; the reference impl
   * does so by subscribing internally.
   */
  loadOutput(id: TaskId, fromSequence?: number): AsyncIterable<TaskOutputChunk>;
}

/**
 * In-memory reference implementation. Suitable for tests and single-process
 * hosts. Not safe to share across workers.
 *
 * @public
 * @stability experimental v0.1
 */
export class InMemoryTaskStore implements TaskStore {
  private readonly records = new Map<TaskId, TaskRecord>();
  private readonly outputs = new Map<TaskId, TaskOutputChunk[]>();
  private readonly subscribers = new Map<
    TaskId,
    Set<(chunk: TaskOutputChunk) => void>
  >();
  private readonly terminalWaiters = new Map<TaskId, Set<() => void>>();

  create(input: CreateTaskInput): TaskRecord {
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
    this.records.set(input.id, record);
    this.outputs.set(input.id, []);
    return record;
  }

  get(id: TaskId): TaskRecord | undefined {
    return this.records.get(id);
  }

  list(filter: TaskListFilter = {}): TaskRecord[] {
    const all = [...this.records.values()];
    return all.filter((record) => {
      if (filter.status && record.status !== filter.status) return false;
      if (filter.kind && record.kind !== filter.kind) return false;
      if (filter.awaited !== undefined && record.awaited !== filter.awaited)
        return false;
      if (filter.parentRunId && record.parentRunId !== filter.parentRunId)
        return false;
      return true;
    });
  }

  update(id: TaskId, patch: TaskUpdatePatch): TaskRecord {
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
    if (isTerminal(updated.status)) {
      const waiters = this.terminalWaiters.get(id);
      if (waiters) {
        for (const fn of waiters) fn();
        waiters.clear();
      }
    }
    return updated;
  }

  remove(id: TaskId): void {
    this.records.delete(id);
    this.outputs.delete(id);
    this.subscribers.delete(id);
    this.terminalWaiters.delete(id);
  }

  appendOutput(
    id: TaskId,
    chunk: Omit<TaskOutputChunk, "sequence">,
  ): TaskOutputChunk {
    const buffer = this.outputs.get(id);
    if (!buffer) {
      throw new Error(`Task not found: ${id}`);
    }
    const full: TaskOutputChunk = {
      ...chunk,
      sequence: buffer.length,
    };
    buffer.push(full);
    this.update(id, {
      lastOutputAt: full.timestamp,
      outputChunks: buffer.length,
      outputBytes: (this.records.get(id)?.outputBytes ?? 0) + full.data.length,
    });
    const subs = this.subscribers.get(id);
    if (subs) {
      for (const fn of subs) fn(full);
    }
    return full;
  }

  loadOutput(id: TaskId, fromSequence = 0): AsyncIterable<TaskOutputChunk> {
    const buffer = this.outputs.get(id);
    if (!buffer) {
      throw new Error(`Task not found: ${id}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const store = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<TaskOutputChunk> {
        let nextIndex = fromSequence;
        const pending: Array<TaskOutputChunk> = [];
        let resolveNext:
          | ((value: IteratorResult<TaskOutputChunk>) => void)
          | undefined;
        let closed = false;

        const subscriber = (chunk: TaskOutputChunk) => {
          if (closed) return;
          if (chunk.sequence < nextIndex) return;
          if (resolveNext) {
            const fn = resolveNext;
            resolveNext = undefined;
            nextIndex = chunk.sequence + 1;
            fn({ value: chunk, done: false });
          } else {
            pending.push(chunk);
          }
        };

        const onTerminal = () => {
          if (resolveNext) {
            const fn = resolveNext;
            resolveNext = undefined;
            fn({ value: undefined, done: true });
          }
        };

        let subs = store.subscribers.get(id);
        if (!subs) {
          subs = new Set();
          store.subscribers.set(id, subs);
        }
        subs.add(subscriber);

        const record = store.records.get(id);
        if (record && !isTerminal(record.status)) {
          let waiters = store.terminalWaiters.get(id);
          if (!waiters) {
            waiters = new Set();
            store.terminalWaiters.set(id, waiters);
          }
          waiters.add(onTerminal);
        }

        const cleanup = () => {
          closed = true;
          subs?.delete(subscriber);
          store.terminalWaiters.get(id)?.delete(onTerminal);
        };

        return {
          async next(): Promise<IteratorResult<TaskOutputChunk>> {
            if (closed) return { value: undefined, done: true };

            // Drain buffered history first.
            while (nextIndex < buffer.length) {
              const chunk = buffer[nextIndex];
              nextIndex += 1;
              if (chunk) return { value: chunk, done: false };
            }

            // Then drain any queued live chunks.
            if (pending.length > 0) {
              const chunk = pending.shift();
              if (chunk) {
                nextIndex = chunk.sequence + 1;
                return { value: chunk, done: false };
              }
            }

            // If the task already terminated, end the iterator.
            const current = store.records.get(id);
            if (!current || isTerminal(current.status)) {
              cleanup();
              return { value: undefined, done: true };
            }

            // Otherwise, await the next chunk or terminal transition.
            return new Promise<IteratorResult<TaskOutputChunk>>((resolve) => {
              resolveNext = resolve;
            });
          },
          async return(): Promise<IteratorResult<TaskOutputChunk>> {
            cleanup();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}

function isTerminal(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}
