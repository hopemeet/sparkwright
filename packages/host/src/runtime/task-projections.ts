import type { PendingNotification } from "@sparkwright/core";
import type {
  TaskNotification,
  TaskOutputChunk,
  TaskRecord,
  TaskStatus,
} from "@sparkwright/agent-runtime";
import type {
  ProtocolError,
  TaskOutputChunkSnapshot,
  TaskRecordSnapshot,
} from "@sparkwright/protocol";

export function taskRecordSnapshot(record: TaskRecord): TaskRecordSnapshot {
  return {
    id: record.id,
    parentRunId: record.parentRunId,
    kind: record.kind,
    ...(record.title ? { title: record.title } : {}),
    awaited: record.awaited,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.lastOutputAt ? { lastOutputAt: record.lastOutputAt } : {}),
    ...(record.lastProgressAt ? { lastProgressAt: record.lastProgressAt } : {}),
    ...(record.lastHealthCheckAt
      ? { lastHealthCheckAt: record.lastHealthCheckAt }
      : {}),
    ...(record.outputChunks !== undefined
      ? { outputChunks: record.outputChunks }
      : {}),
    ...(record.outputBytes !== undefined
      ? { outputBytes: record.outputBytes }
      : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error ? { error: record.error } : {}),
    metadata:
      typeof record.metadata === "object" &&
      record.metadata !== null &&
      !Array.isArray(record.metadata)
        ? record.metadata
        : {},
  };
}

export function taskOutputChunkSnapshot(
  chunk: TaskOutputChunk,
): TaskOutputChunkSnapshot {
  return {
    taskId: chunk.taskId,
    sequence: chunk.sequence,
    timestamp: chunk.timestamp,
    channel: chunk.channel,
    data: chunk.data,
  };
}

export function compareTaskRecordsNewestFirst(
  a: TaskRecord,
  b: TaskRecord,
): number {
  return taskSortTime(b).localeCompare(taskSortTime(a));
}

function taskSortTime(task: TaskRecord): string {
  return (
    task.completedAt ?? task.lastOutputAt ?? task.startedAt ?? task.createdAt
  );
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function pendingNotificationFromTask(
  notification: TaskNotification,
): PendingNotification {
  const title = notification.title ?? notification.kind;
  const resultSummary =
    notification.result !== undefined
      ? summarizeNotificationValue(notification.result)
      : undefined;
  return {
    content: [
      `Task ${notification.taskId} (${title}) ${notification.status}.`,
      notification.summary,
      resultSummary ? `Result summary: ${resultSummary}` : undefined,
      notification.outputRef
        ? `Output ref: ${notification.outputRef}`
        : undefined,
      notification.error ? `Error: ${notification.error.message}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    source: { kind: "task", uri: `task:${notification.taskId}` },
    metadata: {
      taskId: notification.taskId,
      parentRunId: notification.parentRunId,
      status: notification.status,
      kind: notification.kind,
      ...(notification.title ? { title: notification.title } : {}),
      ...(notification.targetRunId
        ? { targetRunId: notification.targetRunId }
        : {}),
      deliveredAt: notification.deliveredAt,
      ...(notification.outputRef ? { outputRef: notification.outputRef } : {}),
      ...(resultSummary !== undefined ? { resultSummary } : {}),
      ...(notification.error
        ? {
            errorCode: notification.error.code,
            errorMessage: notification.error.message,
            ...(notification.error.metadata
              ? {
                  errorSummary: summarizeNotificationValue(
                    notification.error.metadata,
                  ),
                }
              : {}),
          }
        : {}),
    },
  };
}

function summarizeNotificationValue(value: unknown): string {
  let serialized: string;
  try {
    serialized =
      typeof value === "string"
        ? value
        : (JSON.stringify(value) ?? String(value));
  } catch {
    serialized = String(value);
  }
  return serialized.length > 500
    ? `${serialized.slice(0, 500)}...`
    : serialized;
}

export function taskNotFoundError(taskId: string): ProtocolError {
  return {
    code: "task_not_found",
    message: `Task not found: ${taskId}`,
  };
}

export const IMMEDIATE_NONE = Symbol("IMMEDIATE_NONE");
type ImmediateNone = typeof IMMEDIATE_NONE;

export async function raceWithImmediate<T>(
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
