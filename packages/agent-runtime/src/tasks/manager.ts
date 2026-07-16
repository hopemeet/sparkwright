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
  isNonRetryableActorNotificationError,
  taskNotificationInputFromRecord,
  type ActorNotificationSink,
  type TaskTerminalActorNotificationInput,
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
  awaited?: boolean;
  metadata?: Record<string, unknown>;
  /** Inline runner. When omitted, a runner registered under `kind` is used. */
  runner?: TaskRunner;
  /** Opaque payload forwarded to the runner. */
  payload?: unknown;
}

/**
 * Input accepted by {@link TaskManager.adoptRunning}. Hosts use this when a
 * runtime they already started elsewhere needs a task ticket for status,
 * cancellation, and terminal notification delivery.
 *
 * @public
 * @stability experimental v0.1
 */
export interface AdoptRunningTaskInput {
  parentRunId: RunId;
  kind: string;
  title?: string;
  awaited?: boolean;
  metadata?: Record<string, unknown>;
  /** Abort controller already wired into the adopted runtime, if any. */
  controller?: AbortController;
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
  notificationSink?: ActorNotificationSink;
  /**
   * Called when {@link TaskManagerOptions.notificationSink}.deliver throws.
   * Defaults to a silent swallow — sinks are best-effort; task state in the
   * store remains authoritative.
   */
  onSinkError?(taskId: TaskId, cause: unknown): void;
}

export interface TaskRetentionOptions {
  olderThanMs?: number;
  maxTerminalTasks?: number;
  now?: Date;
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
  private readonly notificationSink?: ActorNotificationSink;
  private readonly onSinkError?: (taskId: TaskId, cause: unknown) => void;
  private readonly terminalResolvers = new Map<
    TaskId,
    (record: TaskRecord) => void
  >();
  private readonly promotionWaiters = new Map<TaskId, Set<() => void>>();
  private readonly notificationOutbox: TaskTerminalActorNotificationInput[] =
    [];

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
      awaited: input.awaited,
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

  /**
   * Adopt work that has already been started outside the manager. The manager
   * creates a running task record and owns cancellation/notification from this
   * point forward, while the external runtime remains responsible for calling
   * {@link complete}, {@link fail}, or {@link cancelled}.
   */
  adoptRunning(input: AdoptRunningTaskInput): TaskHandle {
    const id = createTaskId();
    this.store.create({
      id,
      parentRunId: input.parentRunId,
      kind: input.kind,
      title: input.title,
      awaited: input.awaited,
      metadata: input.metadata,
    });
    const controller = input.controller ?? new AbortController();
    const promise = new Promise<TaskRecord>((resolve) => {
      this.terminalResolvers.set(id, resolve);
    });
    this.runners.set(id, { controller, promise });
    const running = this.store.update(id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    return this.makeHandle(id, running, controller, promise);
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
  pendingNotifications(): readonly TaskTerminalActorNotificationInput[] {
    return [...this.notificationOutbox];
  }

  /** Drop and return pending notifications without retrying delivery. */
  drainPendingNotifications(): TaskTerminalActorNotificationInput[] {
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
        if (!isNonRetryableActorNotificationError(cause)) {
          this.notificationOutbox.push(notification);
        }
        this.onSinkError?.(notification.payload.taskId, cause);
      }
    }
    return { delivered, pending: this.notificationOutbox.length };
  }

  pruneTerminalTasks(options: TaskRetentionOptions = {}): {
    pruned: number;
    retained: number;
  } {
    if (!this.store.remove) {
      return { pruned: 0, retained: this.store.list().length };
    }
    const nowMs = (options.now ?? new Date()).getTime();
    const terminal = this.store
      .list()
      .filter((task) => isTerminal(task.status))
      .sort((left, right) => terminalTimeMs(right) - terminalTimeMs(left));
    const toRemove = new Set<TaskId>();
    if (options.olderThanMs !== undefined) {
      for (const task of terminal) {
        if (nowMs - terminalTimeMs(task) > options.olderThanMs) {
          toRemove.add(task.id);
        }
      }
    }
    if (
      options.maxTerminalTasks !== undefined &&
      terminal.length > options.maxTerminalTasks
    ) {
      for (const task of terminal.slice(options.maxTerminalTasks)) {
        toRemove.add(task.id);
      }
    }
    for (const taskId of toRemove) {
      this.store.remove(taskId);
    }
    return {
      pruned: toRemove.size,
      retained: this.store.list().length,
    };
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

  /**
   * Whether this manager owns live execution for the task in the current
   * process. Durable stores can contain `pending`/`running` records reopened
   * after a host restart; those records are not live unless they have a runner
   * here.
   */
  hasLiveRunner(id: TaskId): boolean {
    return this.runners.has(id);
  }

  /**
   * Request that an in-flight foreground wait detach into an awaited background
   * task. Hosts/TUIs call this out-of-band; `task_create` foreground waits race
   * this signal alongside their timeout.
   */
  requestPromotion(id: TaskId): {
    record: TaskRecord;
    interruptedForegroundWait: boolean;
  } {
    const current = this.store.get(id);
    if (!current) {
      throw new Error(`Task not found: ${id}`);
    }
    if (isTerminal(current.status)) {
      return { record: current, interruptedForegroundWait: false };
    }
    const updated = this.store.update(id, {
      awaited: true,
      metadata: { manualPromotionRequested: true },
    });
    const waiters = this.promotionWaiters.get(id);
    const interruptedForegroundWait = (waiters?.size ?? 0) > 0;
    if (waiters) {
      this.promotionWaiters.delete(id);
      for (const resolve of waiters) resolve();
    }
    return { record: updated, interruptedForegroundWait };
  }

  waitForPromotion(
    id: TaskId,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const current = this.store.get(id);
    if (!current) {
      return Promise.reject(new Error(`Task not found: ${id}`));
    }
    if (current.metadata.manualPromotionRequested === true) {
      return Promise.resolve();
    }
    if (options.signal?.aborted) return Promise.reject(makeAbortError());
    return new Promise((resolve, reject) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve();
      };
      const abort = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(makeAbortError());
      };
      const cleanup = () => {
        options.signal?.removeEventListener("abort", abort);
        const waiters = this.promotionWaiters.get(id);
        if (!waiters) return;
        waiters.delete(finish);
        if (waiters.size === 0) this.promotionWaiters.delete(id);
      };
      let waiters = this.promotionWaiters.get(id);
      if (!waiters) {
        waiters = new Set();
        this.promotionWaiters.set(id, waiters);
      }
      waiters.add(finish);
      options.signal?.addEventListener("abort", abort, { once: true });
    });
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
    this.promotionWaiters.delete(id);
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
    const notification = taskNotificationInputFromRecord(record);
    try {
      await this.notificationSink.deliver(notification);
    } catch (cause) {
      if (!isNonRetryableActorNotificationError(cause)) {
        this.notificationOutbox.push(notification);
      }
      this.onSinkError?.(record.id, cause);
    }
  }
}

function isTerminal(status: TaskRecord["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function terminalTimeMs(task: TaskRecord): number {
  return Date.parse(
    task.completedAt ??
      task.lastOutputAt ??
      task.lastProgressAt ??
      task.startedAt ??
      task.createdAt,
  );
}

function makeAbortError(): Error {
  const error = new Error("Task promotion wait aborted.");
  error.name = "AbortError";
  return error;
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
