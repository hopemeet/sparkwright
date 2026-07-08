import { useMemo, useState } from "react";
import type {
  TaskOutputChunkSnapshot,
  TaskRecordSnapshot,
} from "@sparkwright/protocol";
import type { RunEvent } from "../lib/event-type.js";
import {
  summarizeTaskActivity,
  type ActivityTab,
} from "../lib/task-activity.js";
import type { RunController } from "./run-controller.js";
import type { LayerStack } from "./layer-stack.js";
import type { ToastStore } from "./toast-store.js";

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
  unreadTaskCount: number;
  unreadFailedTaskCount: number;
  refreshTaskSnapshots: () => Promise<void>;
  handleActivityTabChange: (tab: ActivityTab) => void;
  stopActivityTask: (taskId: string) => void;
  joinActivityTask: (taskId: string) => void;
  promoteActivityTask: (taskId: string) => void;
  openActivity: (tab?: ActivityTab) => void;
}

export function useTaskActions(deps: {
  controller: RunController;
  toasts: ToastStore;
  layers: LayerStack;
  events: RunEvent[];
}): TaskActions {
  const { controller, toasts, layers, events } = deps;
  const [taskRecords, setTaskRecords] = useState<TaskRecordSnapshot[]>([]);
  const [taskOutputs, setTaskOutputs] = useState<
    Record<string, TaskOutputChunkSnapshot[]>
  >({});
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [lastActivityTab, setLastActivityTab] = useState<ActivityTab>("tasks");
  const [lastSeenTaskSequence, setLastSeenTaskSequence] = useState(0);

  const taskActivity = useMemo(
    () => summarizeTaskActivity(events, taskRecords, taskOutputs),
    [events, taskRecords, taskOutputs],
  );
  const unreadTaskCount = taskActivity.tasks.filter(
    (task) =>
      task.lastSequence > lastSeenTaskSequence &&
      (task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled"),
  ).length;
  const unreadFailedTaskCount = taskActivity.tasks.filter(
    (task) =>
      task.lastSequence > lastSeenTaskSequence &&
      (task.status === "failed" || task.status === "cancelled"),
  ).length;

  async function loadSessionTaskRecords(): Promise<TaskRecordSnapshot[]> {
    const runIds = runIdsFromEvents(events);
    if (runIds.length === 0) return [];
    const batches = await Promise.all(
      runIds.map((parentRunId) =>
        controller.listTasks({ parentRunId, limit: 50 }),
      ),
    );
    return mergeTaskRecords(batches.flat()).slice(0, 50);
  }

  async function refreshTaskSnapshots(): Promise<void> {
    setLoadingTasks(true);
    try {
      const records = await loadSessionTaskRecords();
      const outputEntries = await Promise.all(
        records
          .slice(0, 12)
          .map(
            async (record): Promise<[string, TaskOutputChunkSnapshot[]]> => [
              record.id,
              await controller.readTaskOutput(record.id, 200),
            ],
          ),
      );
      const outputs: Record<string, TaskOutputChunkSnapshot[]> =
        Object.fromEntries(outputEntries);
      setTaskRecords(records);
      setTaskOutputs(outputs);
    } finally {
      setLoadingTasks(false);
    }
  }

  function handleActivityTabChange(tab: ActivityTab): void {
    setLastActivityTab(tab);
    if (tab === "tasks") void refreshTaskSnapshots();
  }

  function stopActivityTask(taskId: string): void {
    void controller.stopTask(taskId).then((cancelled) => {
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
    unreadTaskCount,
    unreadFailedTaskCount,
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
  for (const record of records) byId.set(record.id, record);
  return [...byId.values()].sort((a, b) =>
    taskRecordSortTime(b).localeCompare(taskRecordSortTime(a)),
  );
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
