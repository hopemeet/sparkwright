import { describe, expect, it } from "vitest";
import {
  type NotificationSource,
  type PendingNotification,
  type RunId,
  type TaskRevivalSource,
} from "@sparkwright/core";
import {
  InMemoryActorNotificationQueue,
  InMemoryTaskStore,
  TaskManager,
} from "@sparkwright/agent-runtime";
import { TaskRuntimeOperations } from "../src/runtime/task-runtime-operations.js";

describe("host task revival bridge", () => {
  it("surfaces detached terminal notifications without keeping the run alive", async () => {
    const notifications = new InMemoryActorNotificationQueue();
    const taskManager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: notifications,
    });
    const operations = new TaskRuntimeOperations({
      workspaceRoot: process.cwd(),
      manager: taskManager,
      notifications,
    });
    const parentRunId = "run_detached_notification" as RunId;
    const bridge: {
      notificationSource: NotificationSource;
      taskRevivalSource: TaskRevivalSource;
    } = operations.createRevivalBridge(() => parentRunId);

    const handle = taskManager.spawn({
      parentRunId,
      kind: "detached-test",
      title: "detached notification",
      awaited: false,
      runner: async () => ({ ok: true }),
    });
    await handle.wait();

    await expect(
      Promise.resolve(bridge.taskRevivalSource.hasAwaitedPending()),
    ).resolves.toBe(false);
    const deliveredNotifications =
      (await bridge.notificationSource.drain()) as PendingNotification[];

    expect(deliveredNotifications).toHaveLength(1);
    expect(deliveredNotifications[0]?.content).toContain(
      'Result summary: {"ok":true}',
    );
    expect(deliveredNotifications[0]).toMatchObject({
      source: { kind: "task", uri: `task:${handle.record.id}` },
      metadata: {
        taskId: handle.record.id,
        parentRunId,
        status: "completed",
        kind: "detached-test",
        title: "detached notification",
        resultSummary: '{"ok":true}',
      },
    });
    await expect(
      Promise.resolve(bridge.taskRevivalSource.hasAwaitedPending()),
    ).resolves.toBe(false);
  });
});
