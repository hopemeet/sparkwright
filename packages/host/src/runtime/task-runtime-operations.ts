import { join } from "node:path";
import type {
  NotificationSource,
  RunId,
  TaskRevivalSource,
} from "@sparkwright/core";
import {
  taskNotificationInputFromRecord,
  type ActorInbox,
  type ActorNotificationSink,
  type AnyActorNotification,
  type TaskId,
  type TaskManager,
  type TaskOutputChunk,
  type TaskRecord,
  type TaskStatus,
  type TaskTerminalActorNotification,
} from "@sparkwright/agent-runtime";
import type {
  ProtocolError,
  TaskOutputChunkSnapshot,
  TaskRecordSnapshot,
} from "@sparkwright/protocol";
import {
  compareTaskRecordsNewestFirst,
  isTerminalTaskStatus,
  pendingNotificationFromTaskActor,
  taskOutputChunkSnapshot,
  taskRecordSnapshot,
} from "./task-projections.js";

type TaskNotificationChannel = ActorInbox & ActorNotificationSink;

export interface TaskRuntimeOperationsOptions {
  workspaceRoot: string;
  manager: TaskManager;
  notifications: TaskNotificationChannel;
}

export interface ListRuntimeTasksInput {
  status?: TaskStatus;
  kind?: string;
  parentRunId?: string;
  limit?: number;
}

export type ReadRuntimeTaskOutputResult =
  | {
      ok: true;
      taskId: string;
      chunks: TaskOutputChunkSnapshot[];
      nextSequence: number;
      complete: boolean;
      status: TaskStatus;
      error?: TaskRecord["error"];
      lastOutputAt?: string;
      stalled: boolean;
    }
  | { ok: false; error: ProtocolError };

export type StopRuntimeTaskResult =
  | { ok: true; cancelled: boolean; status?: TaskStatus }
  | { ok: false; error: ProtocolError };

export type JoinRuntimeTaskResult =
  | { ok: true; taskId: string; awaited: boolean; status: TaskStatus }
  | { ok: false; error: ProtocolError };

export type PromoteRuntimeTaskResult =
  | {
      ok: true;
      taskId: string;
      promoted: boolean;
      awaited: boolean;
      status: TaskStatus;
    }
  | { ok: false; error: ProtocolError };

/** Host-owned Task protocol, revival, and resume operations. */
export class TaskRuntimeOperations {
  readonly rootDir: string;
  readonly manager: TaskManager;
  private readonly notifications: TaskNotificationChannel;

  constructor(options: TaskRuntimeOperationsOptions) {
    this.rootDir = workspaceTaskRootDir(options.workspaceRoot);
    this.manager = options.manager;
    this.notifications = options.notifications;
  }

  createRevivalBridge(getRunId: () => RunId | undefined): {
    notificationSource: NotificationSource;
    taskRevivalSource: TaskRevivalSource;
  } {
    const matchesRun = (notification: AnyActorNotification): boolean => {
      const runId = getRunId();
      return (
        runId !== undefined &&
        notification.source.kind === "task" &&
        "parentRunId" in notification.payload &&
        notification.payload.parentRunId === runId
      );
    };
    const matchesAwaitedRun = (notification: AnyActorNotification): boolean => {
      if (
        !matchesRun(notification) ||
        !isTaskTerminalActorNotification(notification)
      ) {
        return false;
      }
      if (!("taskId" in notification.payload)) return false;
      const record = this.manager.store.get(notification.payload.taskId);
      return record?.awaited !== false;
    };
    const matchesTerminalRun = (notification: AnyActorNotification): boolean =>
      matchesRun(notification) && isTaskTerminalActorNotification(notification);

    return {
      notificationSource: {
        drain: async () =>
          (await this.notifications.drain(matchesTerminalRun))
            .filter(isTaskTerminalActorNotification)
            .map((notification) =>
              pendingNotificationFromTaskActor(notification),
            ),
      },
      taskRevivalSource: {
        hasAwaitedPending: async () => {
          const runId = getRunId();
          if (!runId) return false;
          const hasActiveAwaited = this.manager.store
            .list({ parentRunId: runId, awaited: true })
            .some((task) => !isTerminalTaskStatus(task.status));
          if (hasActiveAwaited) return true;
          return (await this.notifications.peek()).some(matchesAwaitedRun);
        },
        waitUntilAvailable: ({ signal }) =>
          this.notifications.waitUntilAvailable({
            signal,
            predicate: matchesAwaitedRun,
          }),
      },
    };
  }

  async failOrphanedInProcessTasksForRun(parentRunId: RunId): Promise<void> {
    const orphanable = this.manager.store
      .list({ parentRunId })
      .filter(
        (task) =>
          (task.status === "pending" || task.status === "running") &&
          !this.manager.hasLiveRunner(task.id),
      );
    for (const task of orphanable) {
      await this.manager.fail(task.id, {
        code: "TASK_ORPHANED_IN_PROCESS",
        message:
          "Task was still pending or running when the host resumed this run, " +
          "but in-process task execution cannot survive host exit.",
        metadata: {
          previousStatus: task.status,
          parentRunId,
        },
      });
    }
  }

  list(input: ListRuntimeTasksInput): {
    ok: true;
    tasks: TaskRecordSnapshot[];
  } {
    const tasks = this.manager.store
      .list({
        status: input.status,
        kind: input.kind,
        parentRunId: input.parentRunId as RunId | undefined,
      })
      .sort(compareTaskRecordsNewestFirst)
      .slice(0, input.limit ?? 50)
      .map(taskRecordSnapshot);
    return { ok: true, tasks };
  }

  get(
    taskId: string,
  ):
    | { ok: true; task: TaskRecordSnapshot }
    | { ok: false; error: ProtocolError } {
    const task = this.manager.store.get(taskId as TaskId);
    if (!task) return { ok: false, error: taskNotFoundError(taskId) };
    return { ok: true, task: taskRecordSnapshot(task) };
  }

  async readOutput(input: {
    taskId: string;
    fromSequence?: number;
    maxChunks?: number;
  }): Promise<ReadRuntimeTaskOutputResult> {
    const id = input.taskId as TaskId;
    const initial = this.manager.store.get(id);
    if (!initial) return { ok: false, error: taskNotFoundError(input.taskId) };

    const fromSequence = input.fromSequence ?? 0;
    const maxChunks = input.maxChunks ?? 200;
    const chunks: TaskOutputChunk[] = [];
    const outputStream = this.manager.store.loadOutput(id, fromSequence);
    const iterator = outputStream[Symbol.asyncIterator]();
    try {
      while (chunks.length < maxChunks) {
        const next = await raceWithImmediate(iterator);
        if (next === IMMEDIATE_NONE || next.done) break;
        chunks.push(next.value);
      }
    } finally {
      await iterator.return?.();
    }

    const latest = this.manager.store.get(id) ?? initial;
    const lastSequence =
      chunks.length > 0
        ? chunks[chunks.length - 1]!.sequence
        : fromSequence - 1;
    return {
      ok: true,
      taskId: input.taskId,
      chunks: chunks.map(taskOutputChunkSnapshot),
      nextSequence: lastSequence + 1,
      complete: isTerminalTaskStatus(latest.status),
      status: latest.status,
      ...(latest.error ? { error: latest.error } : {}),
      ...(latest.lastOutputAt ? { lastOutputAt: latest.lastOutputAt } : {}),
      stalled: latest.status === "running" && chunks.length === 0,
    };
  }

  async stop(taskId: string): Promise<StopRuntimeTaskResult> {
    const id = taskId as TaskId;
    const before = this.manager.store.get(id);
    if (!before) return { ok: false, error: taskNotFoundError(taskId) };
    if (isTerminalTaskStatus(before.status)) {
      return { ok: true, cancelled: false, status: before.status };
    }
    const handle = this.manager.handle(id);
    if (!handle) return { ok: true, cancelled: false, status: before.status };
    await handle.cancel();
    const after = this.manager.store.get(id);
    return {
      ok: true,
      cancelled: after?.status === "cancelled",
      ...(after?.status ? { status: after.status } : {}),
    };
  }

  async join(taskId: string): Promise<JoinRuntimeTaskResult> {
    const id = taskId as TaskId;
    const before = this.manager.store.get(id);
    if (!before) return { ok: false, error: taskNotFoundError(taskId) };
    const joined = this.manager.store.update(id, { awaited: true });
    if (
      isTerminalTaskStatus(joined.status) &&
      !(
        await this.notifications.peek(
          (notification) =>
            notification.source.kind === "task" &&
            "taskId" in notification.payload &&
            notification.payload.taskId === joined.id,
        )
      ).some(Boolean)
    ) {
      await this.notifications.deliver(taskNotificationInputFromRecord(joined));
    }
    return {
      ok: true,
      taskId,
      awaited: joined.awaited,
      status: joined.status,
    };
  }

  async promote(taskId: string): Promise<PromoteRuntimeTaskResult> {
    const id = taskId as TaskId;
    if (!this.manager.store.get(id)) {
      return { ok: false, error: taskNotFoundError(taskId) };
    }
    const promoted = this.manager.requestPromotion(id);
    return {
      ok: true,
      taskId,
      promoted: promoted.interruptedForegroundWait,
      awaited: promoted.record.awaited,
      status: promoted.record.status,
    };
  }
}

export function workspaceTaskRootDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "tasks");
}

function taskNotFoundError(taskId: string): ProtocolError {
  return {
    code: "task_not_found",
    message: `Task not found: ${taskId}`,
  };
}

function isTaskTerminalActorNotification(
  notification: AnyActorNotification,
): notification is TaskTerminalActorNotification {
  return (
    notification.source.kind === "task" &&
    (notification.type === "completed" ||
      notification.type === "failed" ||
      notification.type === "cancelled")
  );
}

const IMMEDIATE_NONE = Symbol("IMMEDIATE_NONE");
type ImmediateNone = typeof IMMEDIATE_NONE;

async function raceWithImmediate<T>(
  iterator: AsyncIterator<T>,
): Promise<IteratorResult<T> | ImmediateNone> {
  let settled = false;
  const next = iterator.next().then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  await Promise.resolve();
  if (settled) return next;
  return IMMEDIATE_NONE;
}
