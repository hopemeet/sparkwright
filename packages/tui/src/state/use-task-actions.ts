import { useEffect, useMemo, useRef, useState } from "react";
import type {
  TaskOutputChunkSnapshot,
  TaskRecordSnapshot,
} from "@sparkwright/protocol";
import type { RunEvent } from "../lib/event-type.js";
import {
  summarizeTaskActivity,
  summarizeUnreadTaskActivity,
  type ActivityTab,
  type TaskActivityItem,
  type UnreadTaskActivitySummary,
} from "../lib/task-activity.js";
import type { HostTaskUpdatedEvent, RunController } from "./run-controller.js";
import type { LayerStack } from "./layer-stack.js";
import type { NotificationStore } from "./notification-store.js";
import { presentationPolicy } from "../lib/ui-signal.js";

type TaskActivitySummary = ReturnType<typeof summarizeTaskActivity>;

/**
 * Background-task activity: the durable task-record/output snapshots, the
 * derived activity summary + unread counts the StatusBar watches, and the
 * handlers that open the drawer, refresh, and stop/join/promote a task. The
 * most entangled group — it feeds the StatusBar, the activity hotkey, and the
 * activity slash commands — so it lives behind one hook that owns all of it.
 */
export interface TaskActions {
  taskRecords: TaskRecordSnapshot[];
  taskOutputs: Record<string, TaskOutputChunkSnapshot[]>;
  loadingTasks: boolean;
  taskActivity: TaskActivitySummary;
  unreadTasks: UnreadTaskActivitySummary;
  refreshTaskSnapshots: () => Promise<void>;
  handleActivityTabChange: (tab: ActivityTab) => void;
  stopActivityTask: (taskId: string) => void;
  joinActivityTask: (taskId: string) => void;
  promoteActivityTask: (taskId: string) => void;
  openActivity: (tab?: ActivityTab) => void;
}

export function useTaskActions(deps: {
  controller: RunController;
  toasts: NotificationStore;
  layers: LayerStack;
  events: RunEvent[];
  sessionId: string;
}): TaskActions {
  const { controller, toasts, layers, events, sessionId } = deps;
  const [taskRecords, setTaskRecords] = useState<TaskRecordSnapshot[]>([]);
  const [taskOutputs, setTaskOutputs] = useState<
    Record<string, TaskOutputChunkSnapshot[]>
  >({});
  const [taskRecordSequences, setTaskRecordSequences] = useState<
    Record<string, number>
  >({});
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [lastActivityTab, setLastActivityTab] = useState<ActivityTab>("tasks");
  const [lastSeenTaskSequence, setLastSeenTaskSequence] = useState(0);
  const terminalSignalsInitialized = useRef(false);
  const observedTerminalTaskStates = useRef(new Set<string>());
  const seenHostTaskEventIds = useRef(new Set<string>());
  const nextHostTaskSequence = useRef(0);
  const sessionGeneration = useRef(0);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const taskActivity = useMemo(
    () =>
      summarizeTaskActivity(
        events,
        taskRecords,
        taskOutputs,
        taskRecordSequences,
      ),
    [events, taskRecords, taskOutputs, taskRecordSequences],
  );
  const unreadTasks = summarizeUnreadTaskActivity(
    taskActivity.tasks,
    lastSeenTaskSequence,
  );

  useEffect(() => {
    const terminal = taskActivity.tasks.filter(
      (task) =>
        task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled",
    );
    if (!terminalSignalsInitialized.current) {
      // The hook mounts before an existing session is replayed or its durable
      // task records are loaded. Wait for the first non-empty snapshot so
      // historical terminal tasks seed the baseline instead of looking new.
      if (taskActivity.tasks.length === 0) return;
      terminalSignalsInitialized.current = true;
      for (const task of terminal) {
        observedTerminalTaskStates.current.add(terminalTaskStateKey(task));
      }
      return;
    }
    for (const task of terminal) {
      const terminalKey = terminalTaskStateKey(task);
      if (observedTerminalTaskStates.current.has(terminalKey)) continue;
      observedTerminalTaskStates.current.add(terminalKey);
      publishTerminalTaskSignal(toasts, task);
    }
  }, [taskActivity.tasks, toasts]);

  useEffect(() => {
    sessionGeneration.current += 1;
    terminalSignalsInitialized.current = false;
    observedTerminalTaskStates.current.clear();
    seenHostTaskEventIds.current.clear();
    nextHostTaskSequence.current = maxRunEventSequence(eventsRef.current);
    refreshInFlight.current = null;
    setTaskRecords([]);
    setTaskOutputs({});
    setTaskRecordSequences({});
    setLastSeenTaskSequence(0);
    setLoadingTasks(false);

    const unsubscribeUpdates = controller.subscribeTaskUpdates((event) => {
      if (event.payload.sessionId && event.payload.sessionId !== sessionId) {
        return;
      }
      if (seenHostTaskEventIds.current.has(event.id)) return;
      seenHostTaskEventIds.current.add(event.id);
      const terminalKey =
        event.payload.transition === "terminal"
          ? terminalTaskStateKey({
              id: event.payload.taskId,
              status: event.payload.status,
              completedAt: event.payload.completedAt,
            })
          : undefined;
      if (terminalKey && observedTerminalTaskStates.current.has(terminalKey)) {
        return;
      }
      if (terminalKey) observedTerminalTaskStates.current.add(terminalKey);
      const record = taskRecordFromUpdatedEvent(event);
      const sequence = Math.max(
        nextHostTaskSequence.current + 1,
        maxRunEventSequence(eventsRef.current) + 1,
      );
      nextHostTaskSequence.current = sequence;
      setTaskRecordSequences((current) => ({
        ...current,
        [record.id]: Math.max(current[record.id] ?? 0, sequence),
      }));
      setTaskRecords((current) => mergeTaskRecords([...current, record]));

      if (event.payload.transition !== "terminal") return;
      publishTerminalTaskSignal(toasts, {
        id: record.id,
        status: record.status === "pending" ? "created" : record.status,
        completionPolicy: record.completionPolicy,
        error: event.payload.error?.message,
        resultSummary: event.payload.resultSummary,
        details: event.payload,
      });
    });
    const unsubscribeConnection = controller.subscribeTaskHostConnection(
      (state) => {
        if (state === "connected") void refreshTaskSnapshots();
      },
    );
    return () => {
      unsubscribeUpdates();
      unsubscribeConnection();
      sessionGeneration.current += 1;
      refreshInFlight.current = null;
    };
  }, [controller, sessionId, toasts]);

  const taskRunIdsKey = useMemo(
    () => runIdsFromEvents(events).sort().join("\u0000"),
    [events],
  );
  useEffect(() => {
    if (!taskRunIdsKey) return;
    void refreshTaskSnapshots();
  }, [controller, sessionId, taskRunIdsKey]);

  async function loadSessionTaskRecords(): Promise<TaskRecordSnapshot[]> {
    const runIds = runIdsFromEvents(eventsRef.current);
    if (runIds.length === 0) return [];
    const batches = await Promise.all(
      runIds.map((parentRunId) =>
        controller.listTasks({ parentRunId, limit: 50 }),
      ),
    );
    return mergeTaskRecords(batches.flat()).slice(0, 50);
  }

  function refreshTaskSnapshots(): Promise<void> {
    if (refreshInFlight.current) return refreshInFlight.current;
    const operation = refreshTaskSnapshotsOnce();
    refreshInFlight.current = operation;
    void operation.then(
      () => {
        if (refreshInFlight.current === operation) {
          refreshInFlight.current = null;
        }
      },
      () => {
        if (refreshInFlight.current === operation) {
          refreshInFlight.current = null;
        }
      },
    );
    return operation;
  }

  async function refreshTaskSnapshotsOnce(): Promise<void> {
    const generation = sessionGeneration.current;
    setLoadingTasks(true);
    try {
      const records = await loadSessionTaskRecords();
      if (generation !== sessionGeneration.current) return;
      const outputEntries = await Promise.all(
        records
          .slice(0, 12)
          .map(async (record): Promise<[string, TaskOutputChunkSnapshot[]]> => [
            record.id,
            await controller.readTaskOutput(record.id, 200),
          ]),
      );
      const outputs: Record<string, TaskOutputChunkSnapshot[]> =
        Object.fromEntries(outputEntries);
      if (generation !== sessionGeneration.current) return;
      for (const record of records) {
        if (isTerminalTaskStatus(record.status)) {
          observedTerminalTaskStates.current.add(
            terminalTaskStateKey({
              id: record.id,
              status: record.status,
              completedAt: record.completedAt,
            }),
          );
        }
      }
      setTaskRecords((current) => mergeTaskRecords([...current, ...records]));
      setTaskOutputs(outputs);
    } finally {
      if (generation === sessionGeneration.current) setLoadingTasks(false);
    }
  }

  function handleActivityTabChange(tab: ActivityTab): void {
    setLastActivityTab(tab);
    if (tab === "tasks") void refreshTaskSnapshots();
  }

  function stopActivityTask(taskId: string): void {
    void controller.stopTask(taskId).then((cancelled) => {
      if (cancelled === null) return;
      toasts.push({
        variant: cancelled ? "success" : "warning",
        title: cancelled ? "task stopped" : "task not stopped",
        message: taskId,
      });
      void refreshTaskSnapshots();
    });
  }

  function joinActivityTask(taskId: string): void {
    void controller.joinTask(taskId).then((joined) => {
      if (joined === null) return;
      toasts.push({
        variant: joined ? "success" : "warning",
        title: joined ? "task joined" : "task not joined",
        message: taskId,
      });
      void refreshTaskSnapshots();
    });
  }

  function promoteActivityTask(taskId: string): void {
    void controller.promoteTask(taskId).then((promoted) => {
      if (promoted === null) return;
      toasts.push({
        variant: promoted ? "success" : "info",
        title: promoted ? "task promoted" : "task marked awaited",
        message: taskId,
      });
      void refreshTaskSnapshots();
    });
  }

  function openActivity(tab?: ActivityTab): void {
    if (layers.has("activity") && !tab) {
      layers.pop("activity");
      return;
    }
    const nextTab =
      tab ?? (taskActivity.running > 0 ? "tasks" : lastActivityTab);
    setLastActivityTab(nextTab);
    if (nextTab === "tasks") void refreshTaskSnapshots();
    setLastSeenTaskSequence(
      taskActivity.tasks.reduce(
        (max, task) => Math.max(max, task.lastSequence),
        lastSeenTaskSequence,
      ),
    );
    layers.push("activity", { tab: nextTab });
  }

  return {
    taskRecords,
    taskOutputs,
    loadingTasks,
    taskActivity,
    unreadTasks,
    refreshTaskSnapshots,
    handleActivityTabChange,
    stopActivityTask,
    joinActivityTask,
    promoteActivityTask,
    openActivity,
  };
}

function runIdsFromEvents(events: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const event of events) {
    const id = runIdFromEvent(event);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function runIdFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const record = event as Record<string, unknown>;
  if (typeof record.runId === "string") return record.runId;
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const payloadRecord = payload as Record<string, unknown>;
  return typeof payloadRecord.runId === "string"
    ? payloadRecord.runId
    : undefined;
}

function mergeTaskRecords(
  records: readonly TaskRecordSnapshot[],
): TaskRecordSnapshot[] {
  const byId = new Map<string, TaskRecordSnapshot>();
  for (const record of records) {
    const current = byId.get(record.id);
    byId.set(record.id, current ? mergeTaskRecord(current, record) : record);
  }
  return [...byId.values()].sort((a, b) =>
    taskRecordSortTime(b).localeCompare(taskRecordSortTime(a)),
  );
}

function mergeTaskRecord(
  current: TaskRecordSnapshot,
  incoming: TaskRecordSnapshot,
): TaskRecordSnapshot {
  const currentRank = taskStatusRank(current.status);
  const incomingRank = taskStatusRank(incoming.status);
  if (incomingRank < currentRank) return current;
  if (
    currentRank === incomingRank &&
    taskRecordSortTime(incoming) < taskRecordSortTime(current)
  ) {
    return current;
  }
  return {
    ...current,
    ...incoming,
    metadata:
      Object.keys(incoming.metadata).length > 0
        ? incoming.metadata
        : current.metadata,
  };
}

function taskRecordSortTime(task: TaskRecordSnapshot): string {
  return (
    task.completedAt ??
    task.lastOutputAt ??
    task.startedAt ??
    task.createdAt ??
    ""
  );
}

function taskRecordFromUpdatedEvent(
  event: HostTaskUpdatedEvent,
): TaskRecordSnapshot {
  const payload = event.payload;
  return {
    id: payload.taskId,
    parentRunId: payload.parentRunId,
    kind: payload.kind,
    ...(payload.title ? { title: payload.title } : {}),
    completionPolicy: payload.completionPolicy,
    awaited: payload.awaited,
    status: payload.status,
    createdAt: payload.createdAt,
    ...(payload.startedAt ? { startedAt: payload.startedAt } : {}),
    ...(payload.completedAt ? { completedAt: payload.completedAt } : {}),
    ...(payload.error ? { error: payload.error } : {}),
    metadata: {},
  };
}

function publishTerminalTaskSignal(
  toasts: NotificationStore,
  task:
    | TaskActivityItem
    | {
        id: string;
        status: TaskActivityItem["status"];
        completionPolicy: TaskRecordSnapshot["completionPolicy"];
        error?: string;
        resultSummary?: string;
        details?: unknown;
      },
): void {
  if (
    task.status === "completed" &&
    (task.completionPolicy === "inline" || task.completionPolicy === "awaited")
  ) {
    return;
  }
  const kind =
    task.status === "failed"
      ? "error"
      : task.status === "cancelled"
        ? "warning"
        : "success";
  const scope = "BackgroundTask" as const;
  const messageDetail =
    task.error ?? ("resultSummary" in task ? task.resultSummary : undefined);
  const policy =
    task.status === "cancelled"
      ? {
          persistence: "until-seen" as const,
          attention: "blurred" as const,
          presentation: ["status", "toast", "history"] as const,
          durationMs: 7_000,
        }
      : presentationPolicy({ kind, scope });
  toasts.publish({
    kind,
    scope,
    source: "tui.task",
    title: `task ${task.status}`,
    message: messageDetail ? `${task.id}: ${messageDetail}` : task.id,
    details: "details" in task ? task.details : task,
    dedupeKey: `task:${task.id}:${task.status}`,
    ...policy,
  });
}

function isTerminalTaskStatus(status: TaskRecordSnapshot["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function taskStatusRank(status: TaskRecordSnapshot["status"]): number {
  if (isTerminalTaskStatus(status)) return 2;
  return status === "running" ? 1 : 0;
}

function maxRunEventSequence(events: readonly RunEvent[]): number {
  return events.reduce(
    (max, event) =>
      typeof event.sequence === "number" ? Math.max(max, event.sequence) : max,
    0,
  );
}

function terminalTaskStateKey(task: {
  id: string;
  status: string;
  completedAt?: string;
}): string {
  return `${task.id}:${task.status}:${task.completedAt ?? "terminal"}`;
}
