import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunId, RuntimeContext, ToolDefinition } from "@sparkwright/core";
import {
  ActorNotificationCapacityError,
  ActorNotificationValidationError,
  FileTaskNotificationOutbox,
  FileTaskStore,
  InMemoryTaskNotificationQueue,
  InMemoryTaskStore,
  TaskManager,
  TaskWatchdog,
  createTaskTools,
  notificationFromRecord,
  pidTaskHealthProbe,
  recoverRunningTasks,
  type ActorInbox,
  type AnyActorNotification,
  type TaskId,
  type TaskCompletedNotificationInput,
  type TaskNotification,
  type TaskOutputChunk,
  type WorkflowProgressNotificationInput,
} from "../src/index.js";

const PARENT_RUN_ID = "run_test_parent" as unknown as RunId;
const fakeCtx = {} as RuntimeContext;
const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function makeManager(): TaskManager {
  return new TaskManager({ store: new InMemoryTaskStore() });
}

function makeTools(manager: TaskManager) {
  return createTaskTools({
    manager,
    getParentRunId: () => PARENT_RUN_ID,
  });
}

async function exec<T>(tool: ToolDefinition, args: unknown): Promise<T> {
  return (await tool.execute(args, fakeCtx)) as T;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sparkwright-tasks-"));
  tempDirs.push(dir);
  return dir;
}

async function peekActorInbox(
  inbox: ActorInbox,
): Promise<readonly AnyActorNotification[]> {
  return Promise.resolve(inbox.peek());
}

async function drainActorInbox(
  inbox: ActorInbox,
): Promise<AnyActorNotification[]> {
  return Promise.resolve(inbox.drain());
}

function legacyTaskNotification(
  taskId: string,
  overrides: Partial<TaskNotification> = {},
): TaskNotification {
  return {
    taskId: taskId as unknown as TaskNotification["taskId"],
    parentRunId: PARENT_RUN_ID,
    status: "completed",
    kind: "agent",
    summary: `${taskId} completed.`,
    deliveredAt: new Date().toISOString(),
    ...overrides,
  };
}

function taskCompletedActorInput(
  taskId: string,
  overrides: Partial<TaskCompletedNotificationInput> = {},
): TaskCompletedNotificationInput {
  const deliveredAt = "2026-01-01T00:00:00.000Z";
  return {
    source: {
      kind: "task",
      id: taskId,
      runId: PARENT_RUN_ID,
    },
    type: "completed",
    payload: {
      taskId: taskId as unknown as TaskId,
      parentRunId: PARENT_RUN_ID,
      status: "completed",
      kind: "agent",
      summary: `${taskId} completed.`,
      deliveredAt,
      result: "ok",
    },
    ...overrides,
  };
}

function workflowProgressInput(
  workflowId: string,
  overrides: Partial<WorkflowProgressNotificationInput> = {},
): WorkflowProgressNotificationInput {
  return {
    source: {
      kind: "workflow",
      id: workflowId,
      runId: PARENT_RUN_ID,
      sessionId: "session_actor_test",
    },
    type: "progress",
    payload: {
      workflowId,
      summary: `${workflowId} progressed.`,
      progress: { message: "halfway" },
    },
    correlationId: "same-correlation",
    ...overrides,
  };
}

describe("TaskManager", () => {
  it("spawn -> wait completes with result", async () => {
    const manager = makeManager();
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "echo",
      runner: async () => "ok",
    });
    const record = await handle.wait();
    expect(record.status).toBe("completed");
    expect(record.result).toBe("ok");
    expect(record.completedAt).toBeDefined();
  });

  it("spawn -> cancel transitions to cancelled", async () => {
    const manager = makeManager();
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "sleeper",
      runner: (controller) =>
        new Promise((resolve, reject) => {
          const onAbort = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (controller.signal.aborted) onAbort();
          else
            controller.signal.addEventListener("abort", onAbort, {
              once: true,
            });
          // never resolves on its own
          void resolve;
        }),
    });
    await handle.cancel();
    const record = await handle.wait();
    expect(record.status).toBe("cancelled");
  });

  it("records runner failures as failed status", async () => {
    const manager = makeManager();
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "boom",
      runner: async () => {
        throw new Error("nope");
      },
    });
    const record = await handle.wait();
    expect(record.status).toBe("failed");
    expect(record.error?.message).toBe("nope");
  });

  it("lets external adapters fail a running task and notifies once", async () => {
    const sink = new InMemoryTaskNotificationQueue();
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: sink,
    });
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "external",
      runner: () => new Promise((resolve) => setTimeout(resolve, 20)),
    });

    const failed = await manager.fail(handle.record.id, {
      code: "TASK_PROCESS_KILLED",
      message: "Process was killed.",
    });
    expect(failed.status).toBe("failed");
    await expect(handle.wait()).resolves.toMatchObject({
      status: "failed",
      error: { code: "TASK_PROCESS_KILLED" },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.store.get(handle.record.id)?.status).toBe("failed");
    expect(sink.drain()).toHaveLength(1);
  });
});

describe("InMemoryTaskStore output", () => {
  it("appendOutput + loadOutput with fromSequence", async () => {
    const manager = makeManager();
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "noisy",
      runner: async (controller) => {
        controller.emitOutput({ channel: "stdout", data: "a" });
        controller.emitOutput({ channel: "stdout", data: "b" });
        controller.emitOutput({ channel: "stderr", data: "c" });
        return "done";
      },
    });
    await handle.wait();
    const record = manager.store.get(handle.record.id);
    expect(record?.lastOutputAt).toBeDefined();
    expect(record?.outputChunks).toBe(3);
    expect(record?.outputBytes).toBe(3);
    const chunks: TaskOutputChunk[] = [];
    for await (const chunk of manager.store.loadOutput(handle.record.id, 1)) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.data)).toEqual(["b", "c"]);
    expect(chunks[0]!.sequence).toBe(1);
  });
});

describe("FileTaskStore", () => {
  it("persists task records and output across reopen", async () => {
    const root = await tempDir();
    const store = new FileTaskStore({ rootDir: root });
    const manager = new TaskManager({ store });
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "persist",
      metadata: { pid: 123 },
      runner: async (controller) => {
        controller.emitOutput({ channel: "stdout", data: "one\n" });
        controller.emitOutput({ channel: "stderr", data: "two\n" });
        return { ok: true };
      },
    });
    await handle.wait();

    const reopened = new FileTaskStore({ rootDir: root });
    const record = reopened.get(handle.record.id);
    expect(record?.status).toBe("completed");
    expect(record?.metadata.pid).toBe(123);
    expect(record?.outputChunks).toBe(2);

    const chunks: TaskOutputChunk[] = [];
    for await (const chunk of reopened.loadOutput(handle.record.id)) {
      chunks.push(chunk);
    }
    expect(chunks.map((chunk) => chunk.data)).toEqual(["one\n", "two\n"]);
    await expect(
      readFile(
        join(root, "tasks", String(handle.record.id), "record.json"),
        "utf8",
      ),
    ).resolves.toContain('"status": "completed"');
  });

  it("writes tombstones for manually removed running records", async () => {
    const root = await tempDir();
    const store = new FileTaskStore({ rootDir: root });
    const tombstone = store.writeTombstone({
      id: "task_deleted" as unknown as TaskNotification["taskId"],
      parentRunId: PARENT_RUN_ID,
      kind: "external",
      status: "running",
      createdAt: new Date(0).toISOString(),
      startedAt: new Date(0).toISOString(),
      metadata: {},
    });

    expect(tombstone.status).toBe("failed");
    expect(tombstone.error?.code).toBe("TASK_RECORD_DELETED");
    expect(new FileTaskStore({ rootDir: root }).get(tombstone.id)?.status).toBe(
      "failed",
    );
  });
});

describe("FileTaskNotificationOutbox", () => {
  it("persists notifications until drained", async () => {
    const root = await tempDir();
    const outbox = new FileTaskNotificationOutbox({ rootDir: root });
    const notification: TaskNotification = {
      taskId: "task_notice" as unknown as TaskNotification["taskId"],
      parentRunId: PARENT_RUN_ID,
      status: "failed",
      kind: "shell",
      summary: "Task failed.",
      error: { code: "TASK_PROCESS_MISSING", message: "missing" },
      deliveredAt: new Date(0).toISOString(),
    };

    outbox.deliver(notification);
    const reopened = new FileTaskNotificationOutbox({ rootDir: root });
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.drain()[0]).toMatchObject({
      taskId: notification.taskId,
      status: "failed",
    });
    expect(reopened.list()).toHaveLength(0);
  });
});

describe("ActorNotificationSink and ActorInbox adapters", () => {
  it("accepts task actor notifications with normalized routes and legacy task compatibility", async () => {
    const queue = new InMemoryTaskNotificationQueue();
    const deliveredAt = "2026-01-01T00:00:00.000Z";

    const result = queue.asActorSink().deliver({
      ...taskCompletedActorInput("task_actor", {
        source: {
          kind: "task",
          id: "task_actor",
          runId: PARENT_RUN_ID,
          sessionId: "session_actor_test",
        },
        payload: {
          taskId: "task_actor" as unknown as TaskId,
          parentRunId: PARENT_RUN_ID,
          status: "completed",
          kind: "agent",
          summary: "actor task completed.",
          deliveredAt,
          result: "done",
        },
      }),
      qos: "lossy",
    } as TaskCompletedNotificationInput & { qos: "lossy" });

    expect(result).toEqual({ status: "accepted", acceptedCount: 1 });
    expect("sequence" in result).toBe(false);
    const [actor] = await peekActorInbox(queue.asActorInbox());
    expect(actor).toMatchObject({
      source: {
        kind: "task",
        id: "task_actor",
        runId: PARENT_RUN_ID,
        sessionId: "session_actor_test",
      },
      routeHint: {
        parentRunId: PARENT_RUN_ID,
        sessionId: "session_actor_test",
      },
      type: "completed",
      qos: "reliable",
      sequence: 1,
      payload: {
        deliveredAt,
        result: "done",
      },
    });
    expect(actor?.createdAt).not.toBe(deliveredAt);
    expect(queue.peek()).toMatchObject([
      {
        taskId: "task_actor",
        parentRunId: PARENT_RUN_ID,
        status: "completed",
        deliveredAt,
      },
    ]);
  });

  it("uses workflow notification inputs as the extraction probe", async () => {
    const queue = new InMemoryTaskNotificationQueue();

    const first = queue
      .asActorSink()
      .deliver(workflowProgressInput("workflow_probe"));
    const second = queue
      .asActorSink()
      .deliver(workflowProgressInput("workflow_probe"));

    expect(first).toEqual({ status: "accepted", acceptedCount: 1 });
    expect(second).toEqual({ status: "accepted", acceptedCount: 1 });
    const actors = await peekActorInbox(queue.asActorInbox());
    expect(actors).toHaveLength(2);
    expect(new Set(actors.map((actor) => actor.id)).size).toBe(2);
    expect(actors[0]).toMatchObject({
      source: {
        kind: "workflow",
        id: "workflow_probe",
        runId: PARENT_RUN_ID,
        sessionId: "session_actor_test",
      },
      routeHint: {
        parentRunId: PARENT_RUN_ID,
        sessionId: "session_actor_test",
      },
      type: "progress",
      qos: "lossy",
      correlationId: "same-correlation",
    });
    expect(queue.peek()).toHaveLength(0);
  });

  it("rejects invalid source routes but allows targetRunId to differ", async () => {
    const queue = new InMemoryTaskNotificationQueue();

    expect(() =>
      queue.asActorSink().deliver(
        taskCompletedActorInput("task_bad_route", {
          routeHint: {
            parentRunId: "run_other",
          },
        }),
      ),
    ).toThrow(ActorNotificationValidationError);

    expect(() =>
      queue.asActorSink().deliver(
        taskCompletedActorInput("task_empty_route", {
          routeHint: {
            parentRunId: "",
          },
        }),
      ),
    ).toThrow(ActorNotificationValidationError);

    const result = queue.asActorSink().deliver(
      taskCompletedActorInput("task_targeted", {
        routeHint: {
          targetRunId: "run_child_target",
        },
      }),
    );
    expect(result).toEqual({ status: "accepted", acceptedCount: 1 });
    expect((await peekActorInbox(queue.asActorInbox()))[0]).toMatchObject({
      routeHint: {
        parentRunId: PARENT_RUN_ID,
        targetRunId: "run_child_target",
      },
    });
  });

  it("keeps reliable notifications out of drop-oldest capacity loss", async () => {
    const reliable = new InMemoryTaskNotificationQueue({
      maxBufferedNotifications: 1,
    });
    reliable.deliver(legacyTaskNotification("task_reliable_one"));

    expect(() =>
      reliable.deliver(legacyTaskNotification("task_reliable_two")),
    ).toThrow(ActorNotificationCapacityError);
    expect(reliable.drain()).toMatchObject([{ taskId: "task_reliable_one" }]);

    const lossy = new InMemoryTaskNotificationQueue({
      maxBufferedNotifications: 1,
    });
    expect(
      lossy.asActorSink().deliver(workflowProgressInput("workflow_lossy_one")),
    ).toEqual({ status: "accepted", acceptedCount: 1 });
    expect(
      lossy.asActorSink().deliver(workflowProgressInput("workflow_lossy_two")),
    ).toEqual({
      status: "accepted",
      acceptedCount: 1,
      droppedCount: 1,
    });
    expect(await peekActorInbox(lossy.asActorInbox())).toMatchObject([
      { source: { id: "workflow_lossy_two" } },
    ]);

    const mixed = new InMemoryTaskNotificationQueue({
      maxBufferedNotifications: 1,
    });
    mixed.deliver(legacyTaskNotification("task_kept"));
    expect(
      mixed.asActorSink().deliver(workflowProgressInput("workflow_dropped")),
    ).toEqual({
      status: "dropped",
      reason: "capacity",
      droppedCount: 1,
    });
    expect(await peekActorInbox(mixed.asActorInbox())).toMatchObject([
      { source: { id: "task_kept" } },
    ]);

    const lossyThenReliable = new InMemoryTaskNotificationQueue({
      maxBufferedNotifications: 1,
    });
    lossyThenReliable
      .asActorSink()
      .deliver(workflowProgressInput("workflow_replaceable"));
    lossyThenReliable.deliver(legacyTaskNotification("task_reliable_wins"));
    expect(
      await peekActorInbox(lossyThenReliable.asActorInbox()),
    ).toMatchObject([
      { source: { id: "task_reliable_wins" }, qos: "reliable" },
    ]);
    expect(lossyThenReliable.drain()).toMatchObject([
      { taskId: "task_reliable_wins" },
    ]);
  });

  it("derives file-backed actor sequence without changing notification file format", async () => {
    const root = await tempDir();
    const outbox = new FileTaskNotificationOutbox({ rootDir: root });
    outbox.deliver(
      legacyTaskNotification("task_later", {
        deliveredAt: "2026-01-02T00:00:00.000Z",
      }),
    );

    const firstPeek = await peekActorInbox(outbox.asActorInbox());
    expect(firstPeek).toMatchObject([{ sequence: 1 }]);

    outbox.deliver(
      legacyTaskNotification("task_earlier", {
        deliveredAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const secondPeek = await peekActorInbox(outbox.asActorInbox());
    expect(secondPeek.map((notification) => notification.sequence)).toEqual([
      1, 2,
    ]);
    expect(secondPeek.map((notification) => notification.source.id)).toEqual([
      "task_later",
      "task_earlier",
    ]);
    expect(secondPeek[0]?.createdAt).toBeDefined();
    expect(secondPeek[0]?.payload).toMatchObject({
      deliveredAt: "2026-01-02T00:00:00.000Z",
    });

    const files = await readdir(join(root, "task-notifications"));
    const raw = JSON.parse(
      await readFile(join(root, "task-notifications", files[0]!), "utf8"),
    ) as {
      sequence?: unknown;
      createdAt?: unknown;
      qos?: unknown;
      notification?: Record<string, unknown>;
    };
    expect(raw.sequence).toBeUndefined();
    expect(raw.createdAt).toBeUndefined();
    expect(raw.qos).toBeUndefined();
    expect(raw.notification?.sequence).toBeUndefined();
    expect(raw.notification?.createdAt).toBeUndefined();
    expect(raw.notification?.qos).toBeUndefined();
  });

  it("waits for actor notifications without consuming file-backed entries", async () => {
    const root = await tempDir();
    const outbox = new FileTaskNotificationOutbox({ rootDir: root });
    const inbox = outbox.asActorInbox();
    const ready = inbox.waitUntilAvailable({
      predicate: (notification) =>
        notification.routeHint?.parentRunId === PARENT_RUN_ID,
    });

    outbox.deliver(legacyTaskNotification("task_ready"));
    await ready;

    expect(await peekActorInbox(inbox)).toHaveLength(1);
    expect(await drainActorInbox(inbox)).toHaveLength(1);
    expect(await peekActorInbox(inbox)).toHaveLength(0);
  });
});

describe("task tools", () => {
  it("task_create rejects unregistered kinds", async () => {
    const manager = makeManager();
    const tools = makeTools(manager);
    await expect(
      exec(tools.taskCreate, { kind: "unregistered" }),
    ).rejects.toMatchObject({ code: "TASK_KIND_UNREGISTERED" });
  });

  it("task_create can describe registered kinds and kind-specific payloads", () => {
    const manager = makeManager();
    manager.registerKind("hello", async () => "hi");
    const tools = createTaskTools({
      manager,
      getParentRunId: () => PARENT_RUN_ID,
      taskCreateKinds: [
        {
          kind: "hello",
          description: "greet in the background",
          payloadDescription: "requires a name",
          payloadSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
          requiresPayload: true,
        },
      ],
    });

    expect(tools.taskCreate.description).toContain("hello");
    const schema = tools.taskCreate.inputSchema as {
      properties: {
        kind: { enum?: string[] };
        payload: { required?: string[] };
      };
      required?: string[];
    };
    expect(schema.properties.kind.enum).toEqual(["hello"]);
    expect(schema.required).toEqual(["kind", "payload"]);
    expect(schema.properties.payload.required).toEqual(["name"]);
  });

  it("task_create + task_list returns the created task", async () => {
    const manager = makeManager();
    manager.registerKind("hello", async () => "hi");
    const tools = makeTools(manager);
    const created = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "hello",
      title: "greet",
    });
    expect(created.taskId).toMatch(/^task_/);
    const listed = await exec<{ tasks: Array<{ id: string; kind: string }> }>(
      tools.taskList,
      { kind: "hello" },
    );
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]!.id).toBe(created.taskId);
    expect(listed.tasks[0]!.kind).toBe("hello");
  });

  it("task action wrapper delegates list/get/output/stop", async () => {
    const manager = makeManager();
    manager.registerKind("emitter", async (controller) => {
      controller.emitOutput({ channel: "stdout", data: "ready" });
      return "ok";
    });
    const tools = makeTools(manager);
    const { taskId } = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "emitter",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const listed = await exec<{ tasks: Array<{ id: string }> }>(tools.task, {
      action: "list",
      kind: "emitter",
    });
    const got = await exec<{ id: string; status: string }>(tools.task, {
      action: "get",
      taskId,
    });
    const output = await exec<{ chunks: TaskOutputChunk[] }>(tools.task, {
      action: "output",
      taskId,
    });
    const stopped = await exec<{ cancelled: boolean }>(tools.task, {
      action: "stop",
      taskId,
    });

    expect(listed.tasks[0]?.id).toBe(taskId);
    expect(got.id).toBe(taskId);
    expect(output.chunks.map((chunk) => chunk.data)).toEqual(["ready"]);
    expect(stopped.cancelled).toBe(false);
  });

  it("task_get returns the record; task_stop cancels", async () => {
    const manager = makeManager();
    manager.registerKind(
      "long",
      (controller) =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        }),
    );
    const tools = makeTools(manager);
    const { taskId } = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "long",
    });
    const got = await exec<{ id: string; status: string }>(tools.taskGet, {
      taskId,
    });
    expect(got.id).toBe(taskId);
    expect(["pending", "running"]).toContain(got.status);

    const stopped = await exec<{ cancelled: boolean }>(tools.taskStop, {
      taskId,
    });
    expect(stopped.cancelled).toBe(true);

    // Second stop is a no-op.
    const stoppedAgain = await exec<{ cancelled: boolean }>(tools.taskStop, {
      taskId,
    });
    expect(stoppedAgain.cancelled).toBe(false);
  });

  it("task_output drains buffered chunks", async () => {
    const manager = makeManager();
    manager.registerKind("emitter", async (controller) => {
      controller.emitOutput({ channel: "stdout", data: "x" });
      controller.emitOutput({ channel: "stdout", data: "y" });
      return null;
    });
    const tools = makeTools(manager);
    const { taskId } = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "emitter",
    });
    // Allow the runner microtasks to flush.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const drained = await exec<{
      chunks: TaskOutputChunk[];
      nextSequence: number;
      complete: boolean;
      status: string;
    }>(tools.taskOutput, { taskId });
    expect(drained.chunks.map((c) => c.data)).toEqual(["x", "y"]);
    expect(drained.nextSequence).toBe(2);
    expect(drained.complete).toBe(true);
    expect(drained.status).toBe("completed");
  });
});

describe("TaskWatchdog", () => {
  it("fails tasks that exceed wall timeout", async () => {
    const sink = new InMemoryTaskNotificationQueue();
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: sink,
    });
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "long",
      runner: () => new Promise(() => {}),
    });
    manager.store.update(handle.record.id, {
      startedAt: new Date(0).toISOString(),
    });

    const watchdog = new TaskWatchdog({
      manager,
      wallTimeoutMs: 1000,
      now: () => new Date(2000),
    });
    const result = await watchdog.sweep();

    expect(result.failed).toBe(1);
    expect(manager.store.get(handle.record.id)?.error?.code).toBe(
      "TASK_WALL_TIMEOUT",
    );
    expect(sink.drain()[0]?.status).toBe("failed");
  });

  it("probes idle tasks and fails only on failed probe", async () => {
    const manager = makeManager();
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "remote",
      runner: () => new Promise(() => {}),
    });
    manager.store.update(handle.record.id, {
      startedAt: new Date(0).toISOString(),
      lastOutputAt: new Date(0).toISOString(),
    });

    const watchdog = new TaskWatchdog({
      manager,
      idleTimeoutMs: 100,
      now: () => new Date(200),
      probe: () => ({
        ok: false,
        error: {
          code: "TASK_PROCESS_MISSING",
          message: "Process no longer exists.",
        },
      }),
    });
    const result = await watchdog.sweep();

    expect(result.probed).toBe(1);
    expect(result.failed).toBe(1);
    expect(manager.store.get(handle.record.id)?.error?.code).toBe(
      "TASK_PROCESS_MISSING",
    );
  });

  it("does not fail idle tasks without hard evidence", async () => {
    const manager = makeManager();
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "quiet",
      runner: () => new Promise(() => {}),
    });
    manager.store.update(handle.record.id, {
      startedAt: new Date(0).toISOString(),
      lastOutputAt: new Date(0).toISOString(),
    });

    const watchdog = new TaskWatchdog({
      manager,
      idleTimeoutMs: 100,
      now: () => new Date(200),
    });
    const result = await watchdog.sweep();

    expect(result.probed).toBe(0);
    expect(result.failed).toBe(0);
    expect(manager.store.get(handle.record.id)?.status).toBe("running");
    expect(manager.store.get(handle.record.id)?.lastHealthCheckAt).toBe(
      new Date(200).toISOString(),
    );
  });

  it("runs on an interval until stopped", async () => {
    vi.useFakeTimers();
    const manager = makeManager();
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "long",
      runner: () => new Promise(() => {}),
    });
    manager.store.update(handle.record.id, {
      startedAt: new Date(0).toISOString(),
    });
    let now = new Date(0);
    const sweeps: number[] = [];
    const watchdog = new TaskWatchdog({
      manager,
      wallTimeoutMs: 1000,
      intervalMs: 50,
      now: () => now,
    });

    const running = watchdog.start({
      onSweep: (result) => sweeps.push(result.checked),
    });
    await vi.advanceTimersByTimeAsync(50);
    now = new Date(2000);
    await vi.advanceTimersByTimeAsync(50);
    running.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(sweeps).toEqual([1, 1]);
    expect(manager.store.get(handle.record.id)?.status).toBe("failed");
  });

  it("recovers running tasks by probing every reopened record", async () => {
    const manager = makeManager();
    const alive = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "alive",
      runner: () => new Promise(() => {}),
    });
    const missing = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "missing",
      runner: () => new Promise(() => {}),
    });

    const result = await recoverRunningTasks({
      manager,
      probe: (task) =>
        task.id === alive.record.id
          ? { ok: true }
          : {
              ok: false,
              error: {
                code: "TASK_PROCESS_MISSING",
                message: "Process no longer exists.",
              },
            },
    });

    expect(result.checked).toBe(2);
    expect(result.failed).toBe(1);
    expect(manager.store.get(alive.record.id)?.status).toBe("running");
    expect(manager.store.get(missing.record.id)?.status).toBe("failed");
  });

  it("checks pid liveness from task metadata", () => {
    expect(
      pidTaskHealthProbe({
        id: "task_pid" as unknown as TaskNotification["taskId"],
        parentRunId: PARENT_RUN_ID,
        kind: "pid",
        status: "running",
        createdAt: new Date().toISOString(),
        metadata: { pid: process.pid },
      }),
    ).toMatchObject({ ok: true });
    expect(
      pidTaskHealthProbe({
        id: "task_pid_missing" as unknown as TaskNotification["taskId"],
        parentRunId: PARENT_RUN_ID,
        kind: "pid",
        status: "running",
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "TASK_PROCESS_MISSING" },
    });
  });
});

describe("TaskNotificationSink", () => {
  it("delivers a completion notification when the task succeeds", async () => {
    const sink = new InMemoryTaskNotificationQueue();
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: sink,
    });
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "echo",
      runner: async () => "done",
    });
    await handle.wait();
    const drained = sink.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.status).toBe("completed");
    expect(drained[0]!.taskId).toBe(handle.record.id);
    expect(drained[0]!.result).toBe("done");
    expect(drained[0]!.summary).toContain("completed");
  });

  it("delivers a failure notification with error payload", async () => {
    const sink = new InMemoryTaskNotificationQueue();
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: sink,
    });
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "bad",
      runner: async () => {
        throw new Error("boom");
      },
    });
    await handle.wait();
    const [notification] = sink.drain();
    expect(notification?.status).toBe("failed");
    expect(notification?.error?.message).toBe("boom");
    expect(notification?.summary).toContain("boom");
  });

  it("delivers a cancellation notification", async () => {
    const sink = new InMemoryTaskNotificationQueue();
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: sink,
    });
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "slow",
      runner: (ctrl) =>
        new Promise((resolve) => {
          ctrl.signal.addEventListener("abort", () => resolve("aborted"), {
            once: true,
          });
        }),
    });
    await handle.cancel();
    const [notification] = sink.drain();
    expect(notification?.status).toBe("cancelled");
  });

  it("swallows sink errors via onSinkError hook", async () => {
    const errors: Array<{ taskId: string; cause: unknown }> = [];
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: {
        deliver: () => {
          throw new Error("sink unavailable");
        },
      },
      onSinkError: (taskId, cause) => errors.push({ taskId, cause }),
    });
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "ok",
      runner: async () => 1,
    });
    const record = await handle.wait();
    expect(record.status).toBe("completed");
    expect(errors).toHaveLength(1);
    expect((errors[0]?.cause as Error).message).toBe("sink unavailable");
    expect(manager.pendingNotifications()).toHaveLength(1);
  });

  it("does not enqueue typed non-retryable sink validation errors", async () => {
    const errors: Array<{ taskId: string; cause: unknown }> = [];
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: {
        deliver: () => {
          throw new ActorNotificationValidationError(
            "routeHint.parentRunId must match source.runId when both are set.",
          );
        },
      },
      onSinkError: (taskId, cause) => errors.push({ taskId, cause }),
    });
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "ok",
      runner: async () => 1,
    });
    const record = await handle.wait();

    expect(record.status).toBe("completed");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.cause).toMatchObject({
      code: "INVALID_ROUTE",
      retryable: false,
    });
    expect(manager.pendingNotifications()).toHaveLength(0);
  });

  it("retries pending notifications after sink failures", async () => {
    let fail = true;
    const delivered: TaskNotification[] = [];
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: {
        deliver: (notification) => {
          if (fail) throw new Error("queue unavailable");
          delivered.push(notification);
        },
      },
    });
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "ok",
      runner: async () => 1,
    });
    await handle.wait();
    expect(manager.pendingNotifications()).toHaveLength(1);

    fail = false;
    await expect(manager.retryPendingNotifications()).resolves.toEqual({
      delivered: 1,
      pending: 0,
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.taskId).toBe(handle.record.id);
    expect(manager.pendingNotifications()).toHaveLength(0);
  });

  it("can drain pending notifications for a durable host outbox", async () => {
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: {
        deliver: () => {
          throw new Error("sink unavailable");
        },
      },
    });
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "ok",
      runner: async () => 1,
    });
    await handle.wait();

    const drained = manager.drainPendingNotifications();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.taskId).toBe(handle.record.id);
    expect(manager.pendingNotifications()).toHaveLength(0);
  });

  it("waitForNext resolves once a delivery arrives", async () => {
    const sink = new InMemoryTaskNotificationQueue();
    const waiter = sink.waitForNext();
    sink.deliver({
      taskId: "task_x" as unknown as TaskNotification["taskId"],
      parentRunId: PARENT_RUN_ID,
      status: "completed",
      kind: "k",
      summary: "s",
      deliveredAt: new Date().toISOString(),
    });
    const got = await waiter;
    expect(got).toHaveLength(1);
    expect(sink.peek()).toHaveLength(0);
  });

  it("notificationFromRecord rejects non-terminal records", () => {
    expect(() =>
      notificationFromRecord({
        id: "task_x" as unknown as TaskNotification["taskId"],
        parentRunId: PARENT_RUN_ID,
        kind: "k",
        status: "running",
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
    ).toThrow(/terminal/);
  });
});
