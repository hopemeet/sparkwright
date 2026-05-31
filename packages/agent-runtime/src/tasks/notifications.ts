// AI maintenance note: TaskNotificationSink is the bridge that turns a
// background task's terminal transition into something the *agent loop* can
// observe on its next turn. The runtime intentionally does not couple this to
// any specific transport — hosts wire the sink to whatever they use to inject
// "user-role" content (e.g. message-queue attachment in streaming-runtime,
// XML-tag injection in a CLI-style frontend).
//
// Lifecycle: TaskManager calls sink.deliver(...) exactly once per task, AFTER
// the record has been moved to a terminal status. Deliveries are best-effort;
// if the sink throws, TaskManager logs to its `onSinkError` hook (if set) and
// continues — task state is the source of truth, the sink is just a hint.

import type { TaskError, TaskId, TaskRecord, TaskStatus } from "./types.js";

/**
 * Terminal task statuses delivered to a sink. `pending` and `running` are
 * intentionally excluded — notifications fire only on terminal transitions.
 *
 * @public
 * @stability experimental v0.1
 */
export type TaskTerminalStatus = "completed" | "failed" | "cancelled";

/**
 * Payload handed to {@link TaskNotificationSink.deliver}. Everything the agent
 * needs to construct a follow-up turn without re-fetching the record.
 *
 * `outputRef` is intentionally string-typed and opaque — hosts that spill
 * output to disk pass a file path; hosts that keep output in memory pass a
 * `taskId` the agent will hand to `task_output`.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskNotification {
  taskId: TaskId;
  parentRunId: TaskRecord["parentRunId"];
  /**
   * Optional routing hint for sub-agent fan-out: when set, the notification
   * is targeted at a specific child run / agent loop rather than the parent.
   */
  targetRunId?: string;
  status: TaskTerminalStatus;
  kind: string;
  title?: string;
  /** Human-readable one-line summary suitable for embedding in a turn. */
  summary: string;
  /** Final result, present when status === "completed". */
  result?: unknown;
  /** Error descriptor, present when status === "failed". */
  error?: TaskError;
  /** Opaque pointer to buffered output (file path, taskId, URL — host's choice). */
  outputRef?: string;
  /** ISO-8601 timestamp of the terminal transition. */
  deliveredAt: string;
}

/**
 * Delivery surface for terminal task notifications. Implementations decide
 * how to surface the notification to the agent loop — queue it for the next
 * turn, render as XML, push over a websocket, etc.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskNotificationSink {
  deliver(notification: TaskNotification): void | Promise<void>;
}

/**
 * Options for {@link InMemoryTaskNotificationQueue}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface InMemoryTaskNotificationQueueOptions {
  /**
   * Optional bounded capacity. When set, deliveries past the cap drop the
   * OLDEST entry so the most recent terminal states are preserved. Default
   * is unbounded.
   */
  maxBufferedNotifications?: number;
}

/**
 * Default sink implementation: buffers notifications in memory until a
 * consumer (the agent loop) calls {@link InMemoryTaskNotificationQueue.drain}.
 * Suitable for single-process hosts. Multi-process / distributed hosts should
 * implement their own {@link TaskNotificationSink}.
 *
 * @public
 * @stability experimental v0.1
 */
export class InMemoryTaskNotificationQueue implements TaskNotificationSink {
  private readonly buffer: TaskNotification[] = [];
  private readonly waiters: Array<(items: TaskNotification[]) => void> = [];
  private readonly cap?: number;

  constructor(options: InMemoryTaskNotificationQueueOptions = {}) {
    if (options.maxBufferedNotifications !== undefined) {
      if (
        !Number.isInteger(options.maxBufferedNotifications) ||
        options.maxBufferedNotifications <= 0
      ) {
        throw new Error(
          "maxBufferedNotifications must be a positive integer when set.",
        );
      }
      this.cap = options.maxBufferedNotifications;
    }
  }

  deliver(notification: TaskNotification): void {
    this.buffer.push(notification);
    if (this.cap !== undefined && this.buffer.length > this.cap) {
      this.buffer.splice(0, this.buffer.length - this.cap);
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(this.drainAll());
  }

  /** Snapshot of currently-buffered notifications without consuming them. */
  peek(): readonly TaskNotification[] {
    return [...this.buffer];
  }

  /** Atomically remove and return every buffered notification. */
  drain(): TaskNotification[] {
    return this.drainAll();
  }

  /**
   * Resolve as soon as at least one notification is buffered. Used by agent
   * loops that block between turns waiting for background work.
   */
  waitForNext(): Promise<TaskNotification[]> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.drainAll());
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private drainAll(): TaskNotification[] {
    const items = [...this.buffer];
    this.buffer.length = 0;
    return items;
  }
}

/**
 * Build a {@link TaskNotification} from a terminal {@link TaskRecord}. The
 * runtime uses this helper internally; it is exported so custom sinks can
 * reconstruct the payload from stored records during replay.
 *
 * @public
 * @stability experimental v0.1
 */
export function notificationFromRecord(
  record: TaskRecord,
  options: { targetRunId?: string; outputRef?: string } = {},
): TaskNotification {
  if (!isTerminalStatus(record.status)) {
    throw new Error(
      `notificationFromRecord: record is not terminal (status=${record.status}).`,
    );
  }
  return {
    taskId: record.id,
    parentRunId: record.parentRunId,
    targetRunId: options.targetRunId,
    status: record.status,
    kind: record.kind,
    title: record.title,
    summary: summarize(record),
    result: record.result,
    error: record.error,
    outputRef: options.outputRef,
    deliveredAt: new Date().toISOString(),
  };
}

function summarize(record: TaskRecord): string {
  const label = record.title ?? record.kind;
  switch (record.status) {
    case "completed":
      return `Task ${label} completed.`;
    case "failed":
      return `Task ${label} failed: ${record.error?.message ?? "unknown error"}`;
    case "cancelled":
      return `Task ${label} cancelled.`;
    default:
      // Unreachable — guarded by isTerminalStatus above.
      return `Task ${label} reached status ${record.status as TaskStatus}.`;
  }
}

function isTerminalStatus(status: TaskStatus): status is TaskTerminalStatus {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}
