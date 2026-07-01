// AI maintenance note: TaskManager owns the runtime side of background work.
// Each spawn allocates a record in the TaskStore and wires an AbortController
// for cancellation. The runner is host-supplied (closure or registered kind)
// so the manager stays transport-agnostic — we never assume bash, HTTP, MCP,
// or any specific runtime.
//
// Status transitions:
//   pending -> running        when the runner first executes
//   running -> completed      runner resolves
//   running -> failed         runner throws
//   pending|running -> cancelled  cancel() called before terminal

import type { RunId } from "@sparkwright/core";
import {
  notificationFromRecord,
  type TaskNotification,
  type TaskNotificationSink,
} from "./notifications.js";
import { InMemoryTaskStore, type TaskStore } from "./store.js";
import {
  createTaskId,
  type TaskError,
  type TaskHandle,
  type TaskId,
  type TaskOutputChunk,
  type TaskProgressUpdate,
  type TaskRecord,
} from "./types.js";

/**
 * Controller object passed to every task runner. Mirrors the surface of a
 * standalone process: an abort signal, an output stream, and a progress hook.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskRunnerController {
  taskId: TaskId;
  signal: AbortSignal;
  /**
   * Emit one output chunk. Sequence is assigned by the store.
   * @reserved Public field consumed by task runners.
   */
  emitOutput(input: {
    channel: TaskOutputChunk["channel"];
    data: string;
  }): void;
  /**
   * Report optional progress. The manager forwards this to subscribers.
   * @reserved Public field consumed by task runners.
   */
  report(progress: TaskProgressUpdate): void;
}

/**
 * Runner signature. Resolved values become `TaskRecord.result`.
 *
 * @public
 * @stability experimental v0.1
 */
export type TaskRunner = (
  controller: TaskRunnerController,
  payload?: unknown,
) => Promise<unknown>;

/**
 * Input accepted by {@link TaskManager.spawn}. Either supply a `runner`
 * closure inline or set `kind` to a name registered via `registerKind`.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SpawnTaskInput {
  parentRunId: RunId;
  kind: string;
  title?: string;
  metadata?: Record<string, unknown>;
  /** Inline runner. When omitted, a runner registered under `kind` is used. */
  runner?: TaskRunner;
  /** Opaque payload forwarded to the runner. */
  payload?: unknown;
}

/**
 * Options for {@link TaskManager}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskManagerOptions {
  store?: TaskStore;
  /** Forwarded progress events. */
  onProgress?(taskId: TaskId, progress: TaskProgressUpdate): void;
  /**
   * Optional sink invoked exactly once per task after the record reaches a
   * terminal status. Hosts wire this to whatever surface delivers the
   * notification back into the agent loop (in-memory queue, websocket, XML
   * tag, etc.).
   */
  notificationSink?: TaskNotificationSink;
  /**
   * Called when {@link TaskManagerOptions.notificationSink}.deliver throws.
   * Defaults to a silent swallow — sinks are best-effort; task state in the
   * store remains authoritative.
   */
  onSinkError?(taskId: TaskId, cause: unknown): void;
}

interface RunnerEntry {
  controller: AbortController;
  promise: Promise<TaskRecord>;
}

/**
 * Orchestrates the background-task lifecycle on top of a {@link TaskStore}.
 *
 * @public
 * @stability experimental v0.1
 */
export class TaskManager {
  readonly store: TaskStore;
  private readonly runners = new Map<TaskId, RunnerEntry>();
  private readonly registry = new Map<string, TaskRunner>();
  private readonly onProgress?: (
    taskId: TaskId,
    progress: TaskProgressUpdate,
  ) => void;
  private readonly notificationSink?: TaskNotificationSink;
  private readonly onSinkError?: (taskId: TaskId, cause: unknown) => void;
  private readonly terminalResolvers = new Map<
    TaskId,
    (record: TaskRecord) => void
  >();
  private readonly notificationOutbox: TaskNotification[] = [];

  constructor(options: TaskManagerOptions = {}) {
    this.store = options.store ?? new InMemoryTaskStore();
    this.onProgress = options.onProgress;
    this.notificationSink = options.notificationSink;
    this.onSinkError = options.onSinkError;
  }

  /**
   * Register a named runner. The `task_create` tool dispatches to these by
   * `kind`, since the model cannot supply a closure.
   */
  registerKind(kind: string, runner: TaskRunner): void {
    if (this.registry.has(kind)) {
      throw new Error(`Task kind already registered: ${kind}`);
    }
    this.registry.set(kind, runner);
  }

  /** Lookup a registered runner by kind. */
  getRunner(kind: string): TaskRunner | undefined {
    return this.registry.get(kind);
  }

  /** List currently registered runner kinds for model-facing diagnostics. */
  registeredKinds(): string[] {
    return [...this.registry.keys()].sort((left, right) =>
      left.localeCompare(right),
    );
  }

  /** Spawn a task. Returns a handle with cancel/wait/output helpers. */
  spawn(input: SpawnTaskInput): TaskHandle {
    const runner = input.runner ?? this.registry.get(input.kind);
    if (!runner) {
      throw new Error(`No runner registered for task kind: ${input.kind}`);
    }
    const id = createTaskId();
    const record = this.store.create({
      id,
      parentRunId: input.parentRunId,
      kind: input.kind,
      title: input.title,
      metadata: input.metadata,
    });
    const controller = new AbortController();
    const promise = new Promise<TaskRecord>((resolve) => {
      this.terminalResolvers.set(id, resolve);
    });
    this.runners.set(id, { controller, promise });
    this.execute(id, runner, controller, input.payload).catch((cause) => {
      this.fail(id, normalizeError(cause)).catch(() => {});
    });

    return this.makeHandle(id, record, controller, promise);
  }

  /** Mark a task completed from an external adapter or watchdog. */
  async complete(id: TaskId, result?: unknown): Promise<TaskRecord> {
    return this.transitionTerminal(id, {
      status: "completed",
      result,
    });
  }

  /** Mark a task failed from an external adapter or watchdog. */
  async fail(id: TaskId, error: TaskError): Promise<TaskRecord> {
    return this.transitionTerminal(id, {
      status: "failed",
      error,
    });
  }

  /** Mark a task cancelled from an external adapter or watchdog. */
  async cancelled(id: TaskId): Promise<TaskRecord> {
    return this.transitionTerminal(id, {
      status: "cancelled",
    });
  }

  /** Snapshot notifications that failed delivery and are waiting for retry. */
  pendingNotifications(): readonly TaskNotification[] {
    return [...this.notificationOutbox];
  }

  /** Drop and return pending notifications without retrying delivery. */
  drainPendingNotifications(): TaskNotification[] {
    const items = [...this.notificationOutbox];
    this.notificationOutbox.length = 0;
    return items;
  }

  /**
   * Retry delivery of notifications whose sink failed earlier.
   *
   * Returns the number delivered in this call and the number still pending.
   */
  async retryPendingNotifications(): Promise<{
    delivered: number;
    pending: number;
  }> {
    if (!this.notificationSink || this.notificationOutbox.length === 0) {
      return { delivered: 0, pending: this.notificationOutbox.length };
    }
    const pending = this.drainPendingNotifications();
    let delivered = 0;
    for (const notification of pending) {
      try {
        await this.notificationSink.deliver(notification);
        delivered += 1;
      } catch (cause) {
        this.notificationOutbox.push(notification);
        this.onSinkError?.(notification.taskId, cause);
      }
    }
    return { delivered, pending: this.notificationOutbox.length };
  }

  /** Convenience for hosts that already hold a TaskId. */
  handle(id: TaskId): TaskHandle | undefined {
    const record = this.store.get(id);
    if (!record) return undefined;
    const entry = this.runners.get(id);
    const controller = entry?.controller ?? new AbortController();
    const promise = entry?.promise ?? Promise.resolve(record);
    return this.makeHandle(id, record, controller, promise);
  }

  private makeHandle(
    id: TaskId,
    record: TaskRecord,
    controller: AbortController,
    promise: Promise<TaskRecord>,
  ): TaskHandle {
    const store = this.store;
    return {
      get record(): TaskRecord {
        return store.get(id) ?? record;
      },
      cancel: async (): Promise<void> => {
        const current = store.get(id);
        if (current && isTerminal(current.status)) return;
        controller.abort();
        await promise;
      },
      wait: (): Promise<TaskRecord> => promise,
      output: (): AsyncIterable<TaskOutputChunk> => store.loadOutput(id),
    };
  }

  private async execute(
    id: TaskId,
    runner: TaskRunner,
    controller: AbortController,
    payload: unknown,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    this.store.update(id, { status: "running", startedAt });

    const runnerController: TaskRunnerController = {
      taskId: id,
      signal: controller.signal,
      emitOutput: (input) => {
        this.store.appendOutput(id, {
          taskId: id,
          timestamp: new Date().toISOString(),
          channel: input.channel,
          data: input.data,
        });
      },
      report: (progress) => {
        this.store.update(id, { lastProgressAt: new Date().toISOString() });
        this.onProgress?.(id, progress);
      },
    };

    try {
      const result = await runner(runnerController, payload);
      if (controller.signal.aborted) {
        await this.cancelled(id);
      } else {
        await this.complete(id, result);
      }
    } catch (cause) {
      if (controller.signal.aborted) {
        await this.cancelled(id);
      } else {
        const error: TaskError = normalizeError(cause);
        await this.fail(id, error);
      }
    }
  }

  private async transitionTerminal(
    id: TaskId,
    patch: {
      status: "completed" | "failed" | "cancelled";
      result?: unknown;
      error?: TaskError;
    },
  ): Promise<TaskRecord> {
    const current = this.store.get(id);
    if (!current) {
      throw new Error(`Task not found: ${id}`);
    }
    if (isTerminal(current.status)) return current;

    const terminal = this.store.update(id, {
      ...patch,
      completedAt: new Date().toISOString(),
    });
    this.runners.delete(id);
    const resolve = this.terminalResolvers.get(id);
    if (resolve) {
      this.terminalResolvers.delete(id);
      resolve(terminal);
    }
    await this.notify(terminal);
    return terminal;
  }

  private async notify(record: TaskRecord): Promise<void> {
    if (!this.notificationSink) return;
    const notification = notificationFromRecord(record);
    try {
      await this.notificationSink.deliver(notification);
    } catch (cause) {
      this.notificationOutbox.push(notification);
      this.onSinkError?.(record.id, cause);
    }
  }
}

function isTerminal(status: TaskRecord["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function normalizeError(cause: unknown): TaskError {
  if (cause && typeof cause === "object") {
    const record = cause as Record<string, unknown>;
    const code =
      typeof record.code === "string" ? record.code : "TASK_RUNNER_FAILED";
    const message =
      typeof record.message === "string"
        ? record.message
        : "Task runner threw a non-Error value.";
    return { code, message };
  }
  return {
    code: "TASK_RUNNER_FAILED",
    message: typeof cause === "string" ? cause : "Task runner failed.",
  };
}
