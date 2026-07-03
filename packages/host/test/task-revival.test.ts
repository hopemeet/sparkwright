import { describe, expect, it } from "vitest";
import {
  type NotificationSource,
  type PendingNotification,
  type RunId,
  type TaskRevivalSource,
} from "@sparkwright/core";
import { type TaskManager } from "@sparkwright/agent-runtime";
import { HostRuntime } from "../src/runtime.js";

interface RuntimeTaskRevivalInternals {
  taskManager: TaskManager;
  createTaskRevivalBridge(getRunId: () => RunId | undefined): {
    notificationSource: NotificationSource;
    taskRevivalSource: TaskRevivalSource;
  };
}

describe("host task revival bridge", () => {
  it("surfaces detached terminal notifications without keeping the run alive", async () => {
    const runtime = new HostRuntime({
      workspaceRoot: process.cwd(),
      defaultModel: "deterministic",
      emit: () => {},
    });
    const internals = runtime as unknown as RuntimeTaskRevivalInternals;
    const parentRunId = "run_detached_notification" as RunId;
    const bridge = internals.createTaskRevivalBridge(() => parentRunId);

    const handle = internals.taskManager.spawn({
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
    const notifications =
      (await bridge.notificationSource.drain()) as PendingNotification[];

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      source: { kind: "task", uri: `task:${handle.record.id}` },
      metadata: {
        taskId: handle.record.id,
        parentRunId,
        status: "completed",
        kind: "detached-test",
        title: "detached notification",
      },
    });
    await expect(
      Promise.resolve(bridge.taskRevivalSource.hasAwaitedPending()),
    ).resolves.toBe(false);
  });
});
