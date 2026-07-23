import type { PendingNotification } from "@sparkwright/core";
import type {
  TaskOutputChunk,
  TaskRecord,
  TaskStatus,
  TaskLifecycleUpdate,
  TaskCompletedActorNotification,
  TaskFailedActorNotification,
  TaskTerminalActorNotification,
} from "@sparkwright/agent-runtime";
import type {
  TaskOutputChunkSnapshot,
  TaskRecordSnapshot,
  TaskUpdatedEventPayload,
} from "@sparkwright/protocol";

export function taskRecordSnapshot(record: TaskRecord): TaskRecordSnapshot {
  return {
    id: record.id,
    parentRunId: record.parentRunId,
    kind: record.kind,
    ...(record.title ? { title: record.title } : {}),
    completionPolicy: taskCompletionPolicy(record),
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

export function taskUpdatedEventPayload(
  update: TaskLifecycleUpdate,
  sessionId?: string,
): TaskUpdatedEventPayload {
  const record = update.record;
  const resultSummary =
    update.transition === "terminal" &&
    record.status === "completed" &&
    record.result !== undefined
      ? summarizeTaskLifecycleResult(record.result)
      : undefined;
  const error =
    update.transition === "terminal" &&
    record.status === "failed" &&
    record.error
      ? {
          code: boundedLifecycleText(record.error.code, 128),
          message: boundedLifecycleText(record.error.message, 1_024),
        }
      : undefined;
  return {
    taskId: record.id,
    parentRunId: record.parentRunId,
    ...(sessionId ? { sessionId } : {}),
    transition: update.transition,
    kind: boundedLifecycleText(record.kind, 128),
    ...(record.title ? { title: boundedLifecycleText(record.title, 200) } : {}),
    completionPolicy: taskCompletionPolicy(record),
    awaited: record.awaited,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(resultSummary ? { resultSummary } : {}),
    ...(error ? { error } : {}),
    outputRef: {
      method: "task.output",
      taskId: record.id,
    },
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

function taskCompletionPolicy(
  record: TaskRecord,
): TaskRecordSnapshot["completionPolicy"] {
  return record.completionPolicy ?? (record.awaited ? "awaited" : "unknown");
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function pendingNotificationFromTaskActor(
  notification: TaskTerminalActorNotification,
): PendingNotification {
  const payload = notification.payload;
  const title = payload.title ?? payload.kind;
  const resultSummary =
    notification.type === "completed" &&
    (notification as TaskCompletedActorNotification).payload.result !==
      undefined
      ? summarizeNotificationValue(
          (notification as TaskCompletedActorNotification).payload.result,
        )
      : undefined;
  const error =
    notification.type === "failed"
      ? (notification as TaskFailedActorNotification).payload.error
      : undefined;
  return {
    content: [
      `Task ${payload.taskId} (${title}) ${notification.type}.`,
      payload.summary,
      resultSummary ? `Result summary: ${resultSummary}` : undefined,
      notification.outputRef
        ? `Output ref: ${notification.outputRef}`
        : undefined,
      error ? `Error: ${error.message}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    source: { kind: "task", uri: `task:${payload.taskId}` },
    metadata: {
      taskId: payload.taskId,
      parentRunId: payload.parentRunId,
      status: notification.type,
      kind: payload.kind,
      ...(payload.title ? { title: payload.title } : {}),
      ...(notification.routeHint?.targetRunId
        ? { targetRunId: notification.routeHint.targetRunId }
        : {}),
      deliveredAt: payload.deliveredAt,
      ...(notification.outputRef ? { outputRef: notification.outputRef } : {}),
      ...(resultSummary !== undefined ? { resultSummary } : {}),
      ...(error
        ? {
            errorCode: error.code,
            errorMessage: error.message,
            ...(error.metadata
              ? {
                  errorSummary: summarizeNotificationValue(error.metadata),
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

function summarizeTaskLifecycleResult(value: unknown): string | undefined {
  try {
    const sanitized = sanitizeTaskLifecycleValue(value, 0, new WeakSet());
    const serialized =
      typeof sanitized === "string"
        ? sanitized
        : (JSON.stringify(sanitized) ?? String(sanitized));
    return boundedLifecycleText(serialized, 1_024);
  } catch {
    return undefined;
  }
}

function sanitizeTaskLifecycleValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return boundedLifecycleText(value, 256);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return String(value);
  if (depth >= 3) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 10)
      .map((item) => sanitizeTaskLifecycleValue(item, depth + 1, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    output[key] = isSensitiveLifecycleKey(key)
      ? "[REDACTED]"
      : sanitizeTaskLifecycleValue(item, depth + 1, seen);
  }
  return output;
}

function boundedLifecycleText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    );
  return redacted.length > maxLength
    ? `${redacted.slice(0, Math.max(0, maxLength - 3))}...`
    : redacted;
}

function isSensitiveLifecycleKey(key: string): boolean {
  return /(?:secret|token|password|passphrase|api.?key|authorization|cookie|credential|private.?key)/i.test(
    key,
  );
}
