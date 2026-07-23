import React from "react";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import type {
  TaskCompletionPolicy,
  TaskRecordSnapshot,
} from "@sparkwright/protocol";
import type { RunEvent } from "../src/lib/event-type.js";
import { LayerStack } from "../src/state/layer-stack.js";
import { NotificationStore } from "../src/state/notification-store.js";
import type {
  HostTaskUpdatedEvent,
  RunController,
  TaskHostConnectionState,
} from "../src/state/run-controller.js";
import {
  useTaskActions,
  type TaskActions,
} from "../src/state/use-task-actions.js";

describe("useTaskActions terminal notifications", () => {
  it("seeds replayed run-event terminals quietly and alerts on a later live transition", async () => {
    const toasts = new NotificationStore();
    const layers = new LayerStack();
    const controller = new FakeTaskController();
    const instance = render(
      <Harness
        events={[]}
        controller={controller.asRunController()}
        toasts={toasts}
        layers={layers}
      />,
      { patchConsole: false },
    );
    await settle();

    const historic = taskEvent("task.failed", 1, "task_historic");
    instance.rerender(
      <Harness
        events={[historic]}
        controller={controller.asRunController()}
        toasts={toasts}
        layers={layers}
      />,
    );
    await settle();
    expect(toasts.getSnapshot().history).toHaveLength(0);

    const started = taskEvent("task.started", 2, "task_live");
    instance.rerender(
      <Harness
        events={[historic, started]}
        controller={controller.asRunController()}
        toasts={toasts}
        layers={layers}
      />,
    );
    await settle();
    const failed = taskEvent("task.failed", 3, "task_live");
    instance.rerender(
      <Harness
        events={[historic, started, failed]}
        controller={controller.asRunController()}
        toasts={toasts}
        layers={layers}
      />,
    );
    await settle();

    expect(toasts.getSnapshot().history).toHaveLength(1);
    expect(toasts.getSnapshot().history[0]).toMatchObject({
      scope: "BackgroundTask",
      title: "task failed",
      message: "task_live",
    });
    instance.unmount();
  });

  it("updates and notifies a detached terminal task without opening Activity", async () => {
    const toasts = new NotificationStore();
    const layers = new LayerStack();
    const controller = new FakeTaskController();
    let actions: TaskActions | undefined;
    const instance = render(
      <Harness
        events={[runStarted("run_detached")]}
        controller={controller.asRunController()}
        toasts={toasts}
        layers={layers}
        onRender={(next) => {
          actions = next;
        }}
      />,
      { patchConsole: false },
    );
    await settle();

    controller.emit(
      lifecycleEvent("evt_created", "created", "pending", "detached"),
    );
    controller.emit(
      lifecycleEvent("evt_started", "started", "running", "detached"),
    );
    controller.emit(
      lifecycleEvent("evt_terminal", "terminal", "completed", "detached"),
    );
    await settle();

    expect(layers.has("activity")).toBe(false);
    expect(actions?.taskRecords).toEqual([
      expect.objectContaining({
        id: "task_live",
        status: "completed",
        completionPolicy: "detached",
      }),
    ]);
    expect(actions?.taskActivity).toMatchObject({
      completed: 1,
      running: 0,
    });
    expect(actions?.unreadTasks).toEqual({
      total: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
    });
    expect(toasts.getSnapshot().history).toHaveLength(1);
    expect(toasts.getSnapshot().history[0]).toMatchObject({
      scope: "BackgroundTask",
      kind: "success",
      title: "task completed",
    });
    expect(toasts.getSnapshot().current).toBeNull();
    instance.unmount();
  });

  it("dedupes repeated lifecycle events by event id and terminal task state", async () => {
    const toasts = new NotificationStore();
    const controller = new FakeTaskController();
    const instance = render(
      <Harness
        events={[runStarted("run_dedupe")]}
        controller={controller.asRunController()}
        toasts={toasts}
        layers={new LayerStack()}
      />,
      { patchConsole: false },
    );
    await settle();

    const failed = lifecycleEvent(
      "evt_failed",
      "terminal",
      "failed",
      "detached",
    );
    controller.emit(failed);
    controller.emit(failed);
    controller.emit({ ...failed, id: "evt_failed_replayed" });
    await settle();

    expect(toasts.getSnapshot().history).toHaveLength(1);
    expect(toasts.getSnapshot().current).toMatchObject({
      kind: "error",
      title: "task failed",
    });
    instance.unmount();
  });

  it("keeps inline and awaited completion quiet while prioritizing cancellation", async () => {
    const toasts = new NotificationStore();
    const controller = new FakeTaskController();
    let actions: TaskActions | undefined;
    const instance = render(
      <Harness
        events={[runStarted("run_policy")]}
        controller={controller.asRunController()}
        toasts={toasts}
        layers={new LayerStack()}
        onRender={(next) => {
          actions = next;
        }}
      />,
      { patchConsole: false },
    );
    await settle();

    controller.emit(
      lifecycleEvent("evt_inline", "terminal", "completed", "inline", {
        taskId: "task_inline",
      }),
    );
    controller.emit(
      lifecycleEvent("evt_awaited", "terminal", "completed", "awaited", {
        taskId: "task_awaited",
        awaited: true,
      }),
    );
    await settle();
    expect(toasts.getSnapshot().history).toHaveLength(0);
    expect(
      actions?.taskRecords.map((record) => [record.id, record.status]),
    ).toEqual(
      expect.arrayContaining([
        ["task_awaited", "completed"],
        ["task_inline", "completed"],
      ]),
    );

    controller.emit(
      lifecycleEvent("evt_cancelled", "terminal", "cancelled", "detached", {
        taskId: "task_cancelled",
      }),
    );
    await settle();
    expect(toasts.getSnapshot().current).toMatchObject({
      kind: "warning",
      title: "task cancelled",
    });
    instance.unmount();
  });

  it("reconciles a missed terminal transition on reconnect without replaying it as a new toast", async () => {
    const toasts = new NotificationStore();
    const controller = new FakeTaskController();
    let actions: TaskActions | undefined;
    const instance = render(
      <Harness
        events={[runStarted("run_reconnect")]}
        controller={controller.asRunController()}
        toasts={toasts}
        layers={new LayerStack()}
        onRender={(next) => {
          actions = next;
        }}
      />,
      { patchConsole: false },
    );
    await settle();
    expect(actions?.taskRecords).toEqual([]);

    controller.records = [
      taskRecord({
        id: "task_missed",
        parentRunId: "run_reconnect",
        status: "failed",
        completionPolicy: "detached",
      }),
    ];
    controller.emitConnection("connected");
    await settle();

    expect(actions?.taskRecords).toEqual([
      expect.objectContaining({ id: "task_missed", status: "failed" }),
    ]);
    expect(toasts.getSnapshot().history).toHaveLength(0);
    expect(controller.listTasks).toHaveBeenCalledWith({
      parentRunId: "run_reconnect",
      limit: 50,
    });
    instance.unmount();
  });
});

function Harness(props: {
  events: RunEvent[];
  controller: RunController;
  toasts: NotificationStore;
  layers: LayerStack;
  onRender?: (actions: TaskActions) => void;
}): null {
  const actions = useTaskActions({
    ...props,
    sessionId: "session_test",
  });
  props.onRender?.(actions);
  return null;
}

class FakeTaskController {
  records: TaskRecordSnapshot[] = [];
  private updateListeners = new Set<(event: HostTaskUpdatedEvent) => void>();
  private connectionListeners = new Set<
    (state: TaskHostConnectionState) => void
  >();

  listTasks = vi.fn(
    async (_input: {
      parentRunId?: string;
      limit?: number;
    }): Promise<TaskRecordSnapshot[]> => this.records,
  );

  readTaskOutput = vi.fn(async () => []);

  subscribeTaskUpdates(
    listener: (event: HostTaskUpdatedEvent) => void,
  ): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  subscribeTaskHostConnection(
    listener: (state: TaskHostConnectionState) => void,
  ): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  emit(event: HostTaskUpdatedEvent): void {
    for (const listener of this.updateListeners) listener(event);
  }

  emitConnection(state: TaskHostConnectionState): void {
    for (const listener of this.connectionListeners) listener(state);
  }

  asRunController(): RunController {
    return this as unknown as RunController;
  }
}

function lifecycleEvent(
  id: string,
  transition: HostTaskUpdatedEvent["payload"]["transition"],
  status: HostTaskUpdatedEvent["payload"]["status"],
  completionPolicy: TaskCompletionPolicy,
  overrides: Partial<HostTaskUpdatedEvent["payload"]> = {},
): HostTaskUpdatedEvent {
  const taskId = overrides.taskId ?? "task_live";
  return {
    envelope: "event",
    id,
    kind: "task.updated",
    timestamp: "2026-07-23T00:00:03.000Z",
    payload: {
      taskId,
      parentRunId: "run_test",
      sessionId: "session_test",
      transition,
      kind: "agent",
      title: "background agent",
      completionPolicy,
      awaited: false,
      status,
      createdAt: "2026-07-23T00:00:00.000Z",
      ...(transition !== "created"
        ? { startedAt: "2026-07-23T00:00:01.000Z" }
        : {}),
      ...(transition === "terminal"
        ? {
            completedAt: "2026-07-23T00:00:02.000Z",
            resultSummary: "done",
          }
        : {}),
      outputRef: { method: "task.output", taskId },
      ...overrides,
    },
  };
}

function taskRecord(
  overrides: Partial<TaskRecordSnapshot> = {},
): TaskRecordSnapshot {
  return {
    id: "task_snapshot",
    parentRunId: "run_test",
    kind: "agent",
    completionPolicy: "detached",
    awaited: false,
    status: "completed",
    createdAt: "2026-07-23T00:00:00.000Z",
    completedAt: "2026-07-23T00:00:02.000Z",
    metadata: {},
    ...overrides,
  };
}

function taskEvent(
  type: "task.started" | "task.failed",
  sequence: number,
  taskId: string,
): RunEvent {
  return { type, sequence, payload: { taskId } } as RunEvent;
}

function runStarted(runId: string): RunEvent {
  return {
    type: "run.started",
    runId,
    sequence: 1,
    payload: {},
  } as RunEvent;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}
