import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { RunId, RuntimeContext, ToolDefinition } from "@sparkwright/core";
import {
  ActorNotificationCapacityError,
  ActorNotificationInvalidError,
  ActorNotificationUnsupportedError,
  ActorNotificationValidationError,
  FileTaskNotificationOutbox,
  FileTaskStore,
  InMemoryActorNotificationQueue,
  InMemoryTaskStore,
  TaskManager,
  TaskWatchdog,
  createTaskId,
  createTaskControl,
  createTaskCreate,
  taskNotificationInputFromRecord,
  pidTaskHealthProbe,
  recoverRunningTasks,
  type ActorInbox,
  type AnyActorNotification,
  type AnyActorNotificationInput,
  type InternalActorKind,
  type TaskId,
  type TaskCompletedNotificationInput,
  type TaskFailedNotificationInput,
  type TaskToolOptions,
  type TaskTerminalActorNotificationInput,
  type TaskOutputChunk,
  type WorkflowProgressNotificationInput,
  type WorkflowWaitingNotificationInput,
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
  return makeTaskToolsFromOptions({
    manager,
    getParentRunId: () => PARENT_RUN_ID,
  });
}

function makeTaskToolsFromOptions(options: TaskToolOptions) {
  return {
    taskCreate: createTaskCreate(options),
    task: createTaskControl(options),
  };
}

async function exec<T>(tool: ToolDefinition, args: unknown): Promise<T> {
  return (await tool.execute(args, fakeCtx)) as T;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sparkwright-tasks-"));
  tempDirs.push(dir);
  return dir;
}

async function waitForTaskRecord(manager: TaskManager): Promise<TaskId> {
  const deadline = Date.now() + 1000;
  for (;;) {
    const task = manager.store.list()[0];
    if (task) return task.id;
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for task record");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

function taskFailedActorInput(
  taskId: string,
  overrides: Partial<TaskFailedNotificationInput> = {},
): TaskFailedNotificationInput {
  return {
    source: {
      kind: "task",
      id: taskId,
      runId: PARENT_RUN_ID,
    },
    type: "failed",
    payload: {
      taskId: taskId as unknown as TaskId,
      parentRunId: PARENT_RUN_ID,
      status: "failed",
      kind: "agent",
      summary: `${taskId} failed.`,
      deliveredAt: "2026-01-01T00:00:00.000Z",
      error: { code: "TASK_FAILED", message: "failed" },
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

function workflowWaitingInput(
  workflowId: string,
  overrides: Partial<WorkflowWaitingNotificationInput> = {},
): WorkflowWaitingNotificationInput {
  return {
    source: {
      kind: "workflow",
      id: workflowId,
      runId: PARENT_RUN_ID,
      sessionId: "session_actor_test",
    },
    type: "waiting",
    payload: {
      workflowId,
      summary: `${workflowId} is waiting.`,
      wait: { kind: "input", reason: "Need user input." },
    },
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
    expect(manager.hasLiveRunner(handle.record.id)).toBe(true);
    const record = await handle.wait();
    expect(record.status).toBe("completed");
    expect(record.result).toBe("ok");
    expect(record.completedAt).toBeDefined();
    expect(manager.hasLiveRunner(handle.record.id)).toBe(false);
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
    const sink = new InMemoryActorNotificationQueue();
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

  it("adopts externally started tasks with cancellation and terminal notification", async () => {
    const sink = new InMemoryActorNotificationQueue();
    const controller = new AbortController();
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: sink,
    });
    const handle = manager.adoptRunning({
      parentRunId: PARENT_RUN_ID,
      kind: "external",
      title: "adopted child",
      awaited: true,
      controller,
      metadata: { source: "test" },
    });

    expect(handle.record.status).toBe("running");
    expect(handle.record.awaited).toBe(true);

    const cancel = handle.cancel();
    expect(controller.signal.aborted).toBe(true);
    await manager.cancelled(handle.record.id);
    await cancel;

    expect(handle.record.status).toBe("cancelled");
    expect(sink.drain()).toMatchObject([
      {
        source: { id: handle.record.id },
        type: "cancelled",
        payload: { title: "adopted child" },
      },
    ]);
  });

  it("waits until notifications are available without consuming them", async () => {
    const sink = new InMemoryActorNotificationQueue();
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: sink,
    });
    const ready = sink.waitUntilAvailable();
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "notify",
      runner: async () => "done",
    });

    await handle.wait();
    await ready;

    expect(sink.peek()).toHaveLength(1);
    expect(sink.drain()).toHaveLength(1);
    expect(sink.peek()).toHaveLength(0);
  });

  it("aborts notification readiness waits without consuming later notifications", async () => {
    const sink = new InMemoryActorNotificationQueue();
    const controller = new AbortController();
    const ready = sink.waitUntilAvailable({ signal: controller.signal });

    controller.abort();

    await expect(ready).rejects.toMatchObject({ name: "AbortError" });
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: sink,
    });
    const handle = manager.spawn({
      parentRunId: PARENT_RUN_ID,
      kind: "notify",
      runner: async () => "done",
    });
    await handle.wait();
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
      id: "task_deleted" as unknown as TaskId,
      parentRunId: PARENT_RUN_ID,
      kind: "external",
      awaited: true,
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
    const notification = taskFailedActorInput("task_notice", {
      payload: {
        taskId: "task_notice" as unknown as TaskId,
        parentRunId: PARENT_RUN_ID,
        status: "failed",
        kind: "shell",
        summary: "Task failed.",
        error: { code: "TASK_PROCESS_MISSING", message: "missing" },
        deliveredAt: new Date(0).toISOString(),
      },
    });

    outbox.deliver(notification);
    const reopened = new FileTaskNotificationOutbox({ rootDir: root });
    expect(reopened.peek()).toHaveLength(1);
    expect(reopened.drain()[0]).toMatchObject({
      source: { id: notification.source.id },
      type: "failed",
    });
    expect(reopened.peek()).toHaveLength(0);
  });

  it("drains matching notifications and waits without consuming", async () => {
    const root = await tempDir();
    const outbox = new FileTaskNotificationOutbox({ rootDir: root });
    const first = taskCompletedActorInput("task_first");
    const otherRun = "run_other" as typeof PARENT_RUN_ID;
    const second = taskFailedActorInput("task_second", {
      source: {
        kind: "task",
        id: "task_second",
        runId: otherRun,
      },
      payload: {
        taskId: "task_second" as unknown as TaskId,
        parentRunId: otherRun,
        status: "failed",
        kind: "agent",
        summary: "Second failed.",
        error: { code: "TASK_FAILED", message: "failed" },
        deliveredAt: new Date(2).toISOString(),
      },
    });

    const ready = outbox.waitUntilAvailable({
      predicate: (notification) =>
        notification.routeHint?.parentRunId === PARENT_RUN_ID,
    });
    outbox.deliver(second);
    await Promise.resolve();
    expect(outbox.peek()).toHaveLength(1);
    outbox.deliver(first);
    await ready;

    expect(outbox.peek()).toHaveLength(2);
    expect(
      outbox.drain(
        (notification) => notification.routeHint?.parentRunId === PARENT_RUN_ID,
      ),
    ).toMatchObject([{ source: { id: first.source.id } }]);
    expect(outbox.peek()).toMatchObject([{ source: { id: second.source.id } }]);
  });
});

describe("ActorNotificationSink and ActorInbox", () => {
  it("accepts task actor notifications with normalized routes", async () => {
    const queue = new InMemoryActorNotificationQueue();
    const deliveredAt = "2026-01-01T00:00:00.000Z";

    const result = queue.deliver({
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
    const [actor] = await peekActorInbox(queue);
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
        source: { id: "task_actor" },
        type: "completed",
        payload: { parentRunId: PARENT_RUN_ID, deliveredAt },
      },
    ]);
  });

  it("uses workflow notification inputs as the extraction probe", async () => {
    const queue = new InMemoryActorNotificationQueue();

    const first = queue.deliver(workflowProgressInput("workflow_probe"));
    const second = queue.deliver(workflowProgressInput("workflow_probe"));

    expect(first).toEqual({ status: "accepted", acceptedCount: 1 });
    expect(second).toEqual({ status: "accepted", acceptedCount: 1 });
    const actors = await peekActorInbox(queue);
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
    expect(queue.peek()).toHaveLength(2);
  });

  it("accepts reliable workflow waiting notifications with wait kind", async () => {
    const queue = new InMemoryActorNotificationQueue();

    const result = queue.deliver(workflowWaitingInput("workflow_waiting"));

    expect(result).toEqual({ status: "accepted", acceptedCount: 1 });
    expect(await peekActorInbox(queue)).toMatchObject([
      {
        source: {
          kind: "workflow",
          id: "workflow_waiting",
        },
        type: "waiting",
        qos: "reliable",
        payload: {
          workflowId: "workflow_waiting",
          wait: { kind: "input" },
        },
      },
    ]);
  });

  it("rejects invalid source routes but allows targetRunId to differ", async () => {
    const queue = new InMemoryActorNotificationQueue();

    expect(() =>
      queue.deliver(
        taskCompletedActorInput("task_bad_route", {
          routeHint: {
            parentRunId: "run_other",
          },
        }),
      ),
    ).toThrow(ActorNotificationValidationError);

    expect(() =>
      queue.deliver(
        taskCompletedActorInput("task_empty_route", {
          routeHint: {
            parentRunId: "",
          },
        }),
      ),
    ).toThrow(ActorNotificationValidationError);

    const result = queue.deliver(
      taskCompletedActorInput("task_targeted", {
        routeHint: {
          targetRunId: "run_child_target",
        },
      }),
    );
    expect(result).toEqual({ status: "accepted", acceptedCount: 1 });
    expect((await peekActorInbox(queue))[0]).toMatchObject({
      routeHint: {
        parentRunId: PARENT_RUN_ID,
        targetRunId: "run_child_target",
      },
    });
  });

  it("rejects task actor notifications whose source and payload identities split", async () => {
    const queue = new InMemoryActorNotificationQueue();

    expect(() =>
      queue.deliver(
        taskCompletedActorInput("task_source", {
          payload: {
            taskId: "task_payload" as unknown as TaskId,
            parentRunId: PARENT_RUN_ID,
            status: "completed",
            kind: "agent",
            summary: "split task completed.",
            deliveredAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    ).toThrow(ActorNotificationInvalidError);

    expect(() =>
      queue.deliver(
        taskCompletedActorInput("task_bad_parent", {
          payload: {
            taskId: "task_bad_parent" as unknown as TaskId,
            parentRunId: "run_payload_parent" as unknown as RunId,
            status: "completed",
            kind: "agent",
            summary: "bad parent completed.",
            deliveredAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    ).toThrow(ActorNotificationInvalidError);

    expect(await peekActorInbox(queue)).toHaveLength(0);
    expect(queue.peek()).toHaveLength(0);
  });

  it("exposes only implemented actor kinds and rejects forged future kinds", () => {
    expectTypeOf<InternalActorKind>().toEqualTypeOf<"task" | "workflow">();
    const forged = {
      ...taskCompletedActorInput("task_forged_kind"),
      source: {
        kind: "agent",
        id: "task_forged_kind",
        runId: PARENT_RUN_ID,
      },
    } as unknown as AnyActorNotificationInput;

    expect(() => new InMemoryActorNotificationQueue().deliver(forged)).toThrow(
      ActorNotificationInvalidError,
    );
  });

  it("keeps reliable notifications out of drop-oldest capacity loss", async () => {
    const reliable = new InMemoryActorNotificationQueue({
      maxBufferedNotifications: 1,
    });
    reliable.deliver(taskCompletedActorInput("task_reliable_one"));

    expect(() =>
      reliable.deliver(taskCompletedActorInput("task_reliable_two")),
    ).toThrow(ActorNotificationCapacityError);
    expect(reliable.drain()).toMatchObject([
      { source: { id: "task_reliable_one" } },
    ]);

    const lossy = new InMemoryActorNotificationQueue({
      maxBufferedNotifications: 1,
    });
    expect(lossy.deliver(workflowProgressInput("workflow_lossy_one"))).toEqual({
      status: "accepted",
      acceptedCount: 1,
    });
    expect(lossy.deliver(workflowProgressInput("workflow_lossy_two"))).toEqual({
      status: "accepted",
      acceptedCount: 1,
      droppedCount: 1,
    });
    expect(await peekActorInbox(lossy)).toMatchObject([
      { source: { id: "workflow_lossy_two" } },
    ]);

    const mixed = new InMemoryActorNotificationQueue({
      maxBufferedNotifications: 1,
    });
    mixed.deliver(taskCompletedActorInput("task_kept"));
    expect(mixed.deliver(workflowProgressInput("workflow_dropped"))).toEqual({
      status: "dropped",
      reason: "capacity",
      droppedCount: 1,
    });
    expect(await peekActorInbox(mixed)).toMatchObject([
      { source: { id: "task_kept" } },
    ]);

    const lossyThenReliable = new InMemoryActorNotificationQueue({
      maxBufferedNotifications: 1,
    });
    lossyThenReliable.deliver(workflowProgressInput("workflow_replaceable"));
    lossyThenReliable.deliver(taskCompletedActorInput("task_reliable_wins"));
    expect(await peekActorInbox(lossyThenReliable)).toMatchObject([
      { source: { id: "task_reliable_wins" }, qos: "reliable" },
    ]);
    expect(lossyThenReliable.drain()).toMatchObject([
      { source: { id: "task_reliable_wins" } },
    ]);
  });

  it("derives file-backed actor sequence from canonical durable inputs", async () => {
    const root = await tempDir();
    const outbox = new FileTaskNotificationOutbox({ rootDir: root });
    outbox.deliver(
      taskCompletedActorInput("task_later", {
        payload: {
          ...taskCompletedActorInput("task_later").payload,
          deliveredAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    );

    const firstPeek = await peekActorInbox(outbox);
    expect(firstPeek).toMatchObject([{ sequence: 1 }]);

    outbox.deliver(
      taskCompletedActorInput("task_earlier", {
        payload: {
          ...taskCompletedActorInput("task_earlier").payload,
          deliveredAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    const secondPeek = await peekActorInbox(outbox);
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
      input?: Record<string, unknown>;
    };
    expect(raw.sequence).toBeUndefined();
    expect(raw.createdAt).toEqual(expect.any(String));
    expect(raw.qos).toBeUndefined();
    expect(raw.input?.sequence).toBeUndefined();
    expect(raw.input?.createdAt).toBeUndefined();
    expect(raw.input?.qos).toBeUndefined();
  });

  it("persists complete terminal task actor inputs", async () => {
    const root = await tempDir();
    const outbox = new FileTaskNotificationOutbox({ rootDir: root });

    expect(
      outbox.deliver(
        taskCompletedActorInput("task_file_actor", {
          routeHint: {
            targetRunId: "run_child_target",
          },
          outputRef: "task-output://task_file_actor",
        }),
      ),
    ).toEqual({ status: "accepted", acceptedCount: 1 });

    const [actor] = await peekActorInbox(outbox);
    expect(actor).toMatchObject({
      source: {
        kind: "task",
        id: "task_file_actor",
        runId: PARENT_RUN_ID,
      },
      routeHint: {
        parentRunId: PARENT_RUN_ID,
        targetRunId: "run_child_target",
      },
      type: "completed",
      outputRef: "task-output://task_file_actor",
      payload: {
        taskId: "task_file_actor",
        parentRunId: PARENT_RUN_ID,
        deliveredAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(outbox.peek()).toMatchObject([
      {
        source: { id: "task_file_actor" },
        routeHint: {
          parentRunId: PARENT_RUN_ID,
          targetRunId: "run_child_target",
        },
        outputRef: "task-output://task_file_actor",
      },
    ]);
  });

  it("rejects non-task actor inputs but preserves actor-only task fields", async () => {
    const root = await tempDir();
    const outbox = new FileTaskNotificationOutbox({ rootDir: root });

    expect(() =>
      outbox.deliver(workflowProgressInput("workflow_file")),
    ).toThrow(ActorNotificationUnsupportedError);

    outbox.deliver(
      taskCompletedActorInput("task_actor_only", {
        source: {
          kind: "task",
          id: "task_actor_only",
          runId: PARENT_RUN_ID,
          sessionId: "session_actor_test",
        },
        correlationId: "correlation_actor_only",
        suggestedContext: true,
      }),
    );
    expect(outbox.peek()).toMatchObject([
      {
        source: { sessionId: "session_actor_test" },
        routeHint: { sessionId: "session_actor_test" },
        correlationId: "correlation_actor_only",
        suggestedContext: true,
      },
    ]);
  });

  it("waits for actor notifications without consuming file-backed entries", async () => {
    const root = await tempDir();
    const outbox = new FileTaskNotificationOutbox({ rootDir: root });
    const inbox = outbox;
    const ready = inbox.waitUntilAvailable({
      predicate: (notification) =>
        notification.routeHint?.parentRunId === PARENT_RUN_ID,
    });

    outbox.deliver(taskCompletedActorInput("task_ready"));
    await ready;

    expect(await peekActorInbox(inbox)).toHaveLength(1);
    expect(await drainActorInbox(inbox)).toHaveLength(1);
    expect(await peekActorInbox(inbox)).toHaveLength(0);
  });

  it("skips invalid file-backed actor entries without wedging the actor inbox", async () => {
    const root = await tempDir();
    const outbox = new FileTaskNotificationOutbox({ rootDir: root });
    outbox.deliver(taskCompletedActorInput("task_valid_actor_file"));

    const outboxDir = join(root, "task-notifications");
    await mkdir(outboxDir, { recursive: true });
    await writeFile(
      join(outboxDir, "bad-empty-parent.json"),
      `${JSON.stringify(
        {
          schemaVersion: "sparkwright-task-notification.v1",
          id: "bad-empty-parent",
          createdAt: "2026-01-01T00:00:00.000Z",
          input: {
            source: {
              kind: "task",
              id: "task_bad_empty_parent",
              runId: "",
            },
            type: "completed",
            payload: {
              taskId: "task_bad_empty_parent",
              parentRunId: "",
              status: "completed",
              kind: "agent",
              summary: "Bad actor notification.",
              deliveredAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(outboxDir, "bad-json.json"), "{", "utf8");

    const actors = await peekActorInbox(outbox);
    expect(actors).toMatchObject([
      {
        source: { id: "task_valid_actor_file" },
        routeHint: { parentRunId: PARENT_RUN_ID },
      },
    ]);
    expect(outbox.invalidEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "bad-empty-parent",
          path: expect.stringContaining("bad-empty-parent.json"),
        }),
        expect.objectContaining({
          path: expect.stringContaining("bad-json.json"),
        }),
      ]),
    );
    expect(outbox.invalidEntries()).toHaveLength(2);

    expect(await drainActorInbox(outbox)).toMatchObject([
      { source: { id: "task_valid_actor_file" } },
    ]);
    expect(await peekActorInbox(outbox)).toHaveLength(0);

    expect(outbox.invalidEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("bad-empty-parent.json"),
        }),
        expect.objectContaining({
          path: expect.stringContaining("bad-json.json"),
        }),
      ]),
    );
  });

  it("derives resumed file-backed actor sequence from stable id order, not readdir order", async () => {
    const root = await tempDir();
    const seed = new FileTaskNotificationOutbox({ rootDir: root });
    vi.useFakeTimers();
    // Persist the later entry first so directory insertion order disagrees
    // with entry-id (timestamp) order.
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    seed.deliver(
      taskCompletedActorInput("task_b_later", {
        correlationId: "b",
      }),
    );
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    seed.deliver(
      taskCompletedActorInput("task_a_earlier", {
        correlationId: "a",
      }),
    );

    // A fresh instance (resume replay) has no cached sequences; lazy
    // derivation must follow sorted storage ids.
    const resumed = new FileTaskNotificationOutbox({ rootDir: root });
    const actors = await peekActorInbox(resumed);
    expect(actors.map((notification) => notification.source.id)).toEqual([
      "task_a_earlier",
      "task_b_later",
    ]);
    expect(actors.map((notification) => notification.sequence)).toEqual([1, 2]);
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
    const tools = makeTaskToolsFromOptions({
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
        mode: { enum?: string[] };
        payload: { required?: string[] };
      };
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.properties.kind.enum).toEqual(["hello"]);
    expect(schema.properties.mode.enum).toEqual([
      "foreground",
      "awaited",
      "background",
    ]);
    expect(schema.required).toEqual(["kind", "payload"]);
    expect(schema.properties.payload.required).toEqual(["name"]);
    expect(schema).not.toHaveProperty("properties.awaited");
    expect(schema.additionalProperties).toBe(false);
  });

  it("task_create defaults to foreground and returns inline results", async () => {
    const manager = makeManager();
    manager.registerKind("hello", async () => "hi");
    const tools = makeTools(manager);
    const created = await exec<{
      taskId: string;
      mode: string;
      promoted: boolean;
      status: string;
      result: string;
    }>(tools.taskCreate, {
      kind: "hello",
      title: "greet",
    });
    expect(created.taskId).toMatch(/^task_/);
    expect(created).toMatchObject({
      mode: "foreground",
      promoted: false,
      status: "completed",
      result: "hi",
    });
    const listed = await exec<{ tasks: Array<{ id: string; kind: string }> }>(
      tools.task,
      { action: "list", kind: "hello" },
    );
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]!.id).toBe(created.taskId);
    expect(listed.tasks[0]!.kind).toBe("hello");
    expect(manager.store.get(created.taskId as TaskId)?.awaited).toBe(false);
  });

  it("task_create keeps the execution-scoped runner captured by its tool bundle", async () => {
    const manager = makeManager();
    manager.registerKind("agent", async () => "workspace-default");
    const firstExecutionTools = makeTaskToolsFromOptions({
      manager,
      getParentRunId: () => PARENT_RUN_ID,
      taskRunners: { agent: async () => "first-execution" },
      taskCreateKinds: [{ kind: "agent" }],
    });

    // Simulate a later execution preparing a different bundle before the
    // earlier tool is invoked. Its immutable runner must still win.
    makeTaskToolsFromOptions({
      manager,
      getParentRunId: () => PARENT_RUN_ID,
      taskRunners: { agent: async () => "later-execution" },
      taskCreateKinds: [{ kind: "agent" }],
    });
    const created = await exec<{ result: string }>(
      firstExecutionTools.taskCreate,
      { kind: "agent" },
    );

    expect(created.result).toBe("first-execution");
  });

  it("task_create mode=background starts detached fire-and-forget work", async () => {
    const manager = makeManager();
    manager.registerKind("hello", async () => "hi");
    const tools = makeTools(manager);
    const created = await exec<{
      taskId: string;
      nextAction: {
        action: string;
        taskId: string;
        instruction: string;
        duplicateAvoidance: string;
      };
    }>(tools.taskCreate, {
      kind: "hello",
      mode: "background",
    });
    expect(created.nextAction).toMatchObject({
      action: "wait",
      taskId: created.taskId,
    });
    expect(created.nextAction.instruction).toContain('action="get"');
    expect(created.nextAction.duplicateAvoidance).toContain("task_create");
    await manager.handle(created.taskId as TaskId)?.wait();
    expect(manager.store.get(created.taskId as TaskId)?.awaited).toBe(false);
  });

  it("task_create mode=awaited starts detached and awaited", async () => {
    const manager = makeManager();
    manager.registerKind("hello", async () => "hi");
    const tools = makeTools(manager);
    const created = await exec<{
      taskId: string;
      mode: string;
      awaited: boolean;
      nextAction: {
        action: string;
        taskId: string;
        instruction: string;
        outputInstruction: string;
        duplicateAvoidance: string;
      };
    }>(tools.taskCreate, {
      kind: "hello",
      mode: "awaited",
    });
    expect(created).toMatchObject({ mode: "awaited", awaited: true });
    expect(created.nextAction).toMatchObject({
      action: "wait",
      taskId: created.taskId,
    });
    expect(created.nextAction.instruction).toContain(created.taskId);
    expect(created.nextAction.outputInstruction).toContain('action="output"');
    expect(created.nextAction.duplicateAvoidance).toContain("same goal");
    await manager.handle(created.taskId as TaskId)?.wait();
    expect(manager.store.get(created.taskId as TaskId)?.awaited).toBe(true);
  });

  it("task_create rejects the removed awaited input field", async () => {
    const manager = makeManager();
    manager.registerKind("hello", async () => "hi");
    const tools = makeTools(manager);

    await expect(
      exec(tools.taskCreate, {
        kind: "hello",
        awaited: true,
      }),
    ).rejects.toMatchObject({
      code: "TASK_ARGUMENTS_INVALID",
      message: expect.stringContaining(
        "unsupported argument field(s): awaited",
      ),
    });
  });

  it("task_create promotes foreground tasks when the budget elapses", async () => {
    const manager = makeManager();
    manager.registerKind(
      "slow",
      () => new Promise((resolve) => setTimeout(() => resolve("done"), 20)),
    );
    const tools = makeTaskToolsFromOptions({
      manager,
      getParentRunId: () => PARENT_RUN_ID,
      foregroundTimeoutMs: 1,
    });
    const created = await exec<{
      taskId: string;
      mode: string;
      promoted: boolean;
      awaited: boolean;
      nextAction: {
        action: string;
        taskId: string;
        duplicateAvoidance: string;
      };
    }>(tools.taskCreate, { kind: "slow" });
    expect(created).toMatchObject({
      mode: "foreground",
      promoted: true,
      awaited: true,
    });
    expect(created.nextAction).toMatchObject({
      action: "wait",
      taskId: created.taskId,
    });
    expect(created.nextAction.duplicateAvoidance).toContain("task_create");
    const terminal = await manager.handle(created.taskId as TaskId)?.wait();
    expect(terminal?.status).toBe("completed");
    expect(manager.store.get(created.taskId as TaskId)?.awaited).toBe(true);
  });

  it("task_create foreground wait can be manually promoted", async () => {
    const manager = makeManager();
    let finish!: (value: string) => void;
    manager.registerKind(
      "slow",
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const tools = makeTaskToolsFromOptions({
      manager,
      getParentRunId: () => PARENT_RUN_ID,
      foregroundTimeoutMs: 1000,
    });

    const createdPromise = exec<{
      taskId: string;
      promoted: boolean;
      awaited: boolean;
    }>(tools.taskCreate, { kind: "slow" });
    const taskId = await waitForTaskRecord(manager);

    const promotion = manager.requestPromotion(taskId);
    expect(promotion.interruptedForegroundWait).toBe(true);

    const created = await createdPromise;
    expect(created).toMatchObject({
      taskId,
      promoted: true,
      awaited: true,
    });
    finish("done");
    await manager.handle(taskId)?.wait();
  });

  it("task_create rejects new work when background tasks are disabled", async () => {
    const manager = makeManager();
    manager.registerKind("slow", async () => "done");
    const tools = makeTaskToolsFromOptions({
      manager,
      getParentRunId: () => PARENT_RUN_ID,
      backgroundTasks: "disabled",
    });

    await expect(
      exec(tools.taskCreate, { kind: "slow", mode: "foreground" }),
    ).rejects.toMatchObject({ code: "BACKGROUND_TASKS_DISABLED" });
  });

  it("task_create foreground-only policy waits inline instead of promoting", async () => {
    const manager = makeManager();
    manager.registerKind("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "done";
    });
    const tools = makeTaskToolsFromOptions({
      manager,
      getParentRunId: () => PARENT_RUN_ID,
      foregroundTimeoutMs: 1,
      backgroundTasks: "foreground-only",
    });

    const result = await exec<{
      promoted: boolean;
      awaited: boolean;
      result: string;
    }>(tools.taskCreate, { kind: "slow", mode: "background" });

    expect(result).toMatchObject({
      promoted: false,
      awaited: false,
      result: "done",
    });
  });

  it("rejects concurrent agent tasks over the default agent=1 cap", async () => {
    const manager = makeManager();
    manager.registerKind(
      "agent",
      (controller) =>
        new Promise((resolve) => {
          controller.signal.addEventListener(
            "abort",
            () => resolve("cancelled"),
            { once: true },
          );
        }),
    );
    const tools = makeTools(manager);
    expect(tools.taskCreate.description).toContain(
      "Active task concurrency limit",
    );
    expect(tools.taskCreate.description).toContain("per-kind agent=1");
    const created = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "agent",
      mode: "awaited",
    });

    await expect(
      exec(tools.taskCreate, { kind: "agent", mode: "awaited" }),
    ).rejects.toMatchObject({
      code: "TASK_CONCURRENCY_LIMIT",
    });

    await manager.handle(created.taskId as TaskId)?.cancel();
  });

  it("task list defaults to current run and can list all durable tasks", async () => {
    const manager = makeManager();
    manager.registerKind("hello", async () => "hi");
    const currentTools = makeTools(manager);
    const otherTools = makeTaskToolsFromOptions({
      manager,
      getParentRunId: () => "run_other" as unknown as RunId,
    });

    const current = await exec<{ taskId: string }>(currentTools.taskCreate, {
      kind: "hello",
    });
    const other = await exec<{ taskId: string }>(otherTools.taskCreate, {
      kind: "hello",
    });

    const runOnly = await exec<{ tasks: Array<{ id: string }> }>(
      currentTools.task,
      {
        action: "list",
        kind: "hello",
      },
    );
    const all = await exec<{ tasks: Array<{ id: string }> }>(
      currentTools.task,
      {
        action: "list",
        kind: "hello",
        scope: "all",
      },
    );
    expect(runOnly.tasks.map((task) => task.id)).toEqual([current.taskId]);
    expect(all.tasks.map((task) => task.id).sort()).toEqual(
      [current.taskId, other.taskId].sort(),
    );
    await expect(
      exec(currentTools.task, { action: "list", scope: "session" }),
    ).rejects.toMatchObject({
      code: "TASK_ARGUMENTS_INVALID",
      message: "task list scope must be run or all.",
    });
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

  it("task action wrapper exposes action-specific id schema", () => {
    const manager = makeManager();
    const tools = makeTools(manager);
    const schema = tools.task.inputSchema as {
      properties: Record<string, unknown>;
      oneOf?: unknown[];
      anyOf?: unknown[];
      allOf?: unknown[];
    };

    expect(schema.properties.taskId).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(schema.properties.ids).toMatchObject({
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    });
    expect(schema.properties.scope).toMatchObject({
      type: "string",
      enum: ["run", "all"],
    });
    expect(schema.oneOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
    expect(schema.allOf).toBeUndefined();
  });

  it("guides repeated task get snapshots toward wait or output", () => {
    const manager = makeManager();
    const tools = makeTools(manager);
    const guidance = tools.task.repeatedCallGuidanceForArgs?.({
      action: "get",
      taskId: "task_running",
    });

    expect(guidance).toContain('action="wait"');
    expect(guidance).toContain('action="output"');
    expect(
      tools.task.repeatedCallGuidanceForArgs?.({
        action: "wait",
        taskId: "task_running",
      }),
    ).toBeUndefined();
  });

  it("task action wrapper rejects empty placeholder task ids", async () => {
    const manager = makeManager();
    manager.registerKind("emitter", async (controller) => {
      controller.emitOutput({ channel: "stdout", data: "ready" });
      return "ok";
    });
    const tools = makeTools(manager);
    const { taskId } = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "emitter",
    });
    await manager.handle(taskId as TaskId)?.wait();

    await expect(
      exec(tools.task, { action: "wait", taskId: "" }),
    ).rejects.toMatchObject({
      code: "TASK_ARGUMENTS_INVALID",
      message: "task wait requires at least one task id.",
    });
    await expect(
      exec(tools.task, { action: "wait", taskId: "", ids: [taskId] }),
    ).resolves.toMatchObject({ mode: "any" });
    await expect(
      exec(tools.task, { action: "wait", ids: [] }),
    ).rejects.toMatchObject({
      code: "TASK_ARGUMENTS_INVALID",
      message: "task wait requires at least one task id.",
    });
    await expect(
      exec(tools.task, { action: "output", taskId: "" }),
    ).rejects.toMatchObject({
      code: "TASK_ARGUMENTS_INVALID",
      message: "taskId must be a non-empty string.",
    });
  });

  it("normalizes irrelevant flat task fields before execution", async () => {
    const manager = makeManager();
    manager.registerKind("emitter", async (controller) => {
      controller.emitOutput({ channel: "stdout", data: "ready" });
      return "ok";
    });
    const tools = makeTools(manager);
    const { taskId } = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "emitter",
    });

    const got = await exec<{ id: string }>(tools.task, {
      action: "get",
      taskId,
      ids: [taskId],
      mode: "all",
      status: "",
      kind: "",
      scope: "run",
      fromSequence: 0,
      maxChunks: 1,
    });

    expect(got.id).toBe(taskId);
    await expect(
      exec(tools.task, {
        action: "wait",
        taskId,
        ids: ["task_different"],
      }),
    ).rejects.toMatchObject({
      code: "TASK_ARGUMENTS_INVALID",
      message: expect.stringContaining("must not combine taskId"),
    });
  });

  it("task action semantic validation rejects placeholders before policy", async () => {
    const manager = makeManager();
    const tools = makeTools(manager);

    await expect(
      Promise.resolve(
        tools.task.validateInput?.(
          { action: "wait", taskId: "", ids: ["task_valid"] },
          fakeCtx,
        ),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      Promise.resolve(
        tools.task.validateInput?.({ action: "wait", ids: [] }, fakeCtx),
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "TASK_ARGUMENTS_INVALID",
      message: "task wait requires at least one task id.",
    });
    await expect(
      Promise.resolve(
        tools.task.validateInput?.({ action: "output", taskId: "" }, fakeCtx),
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "TASK_ARGUMENTS_INVALID",
      message: "taskId must be a non-empty string.",
    });
    await expect(
      Promise.resolve(
        tools.task.validateInput?.(
          { action: "wait", ids: ["task_valid"] },
          fakeCtx,
        ),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("task get returns the record and task stop cancels", async () => {
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
      mode: "awaited",
    });
    const got = await exec<{ id: string; status: string }>(tools.task, {
      action: "get",
      taskId,
    });
    expect(got.id).toBe(taskId);
    expect(["pending", "running"]).toContain(got.status);

    const stopped = await exec<{ cancelled: boolean }>(tools.task, {
      action: "stop",
      taskId,
    });
    expect(stopped.cancelled).toBe(true);

    // Second stop is a no-op.
    const stoppedAgain = await exec<{ cancelled: boolean }>(tools.task, {
      action: "stop",
      taskId,
    });
    expect(stoppedAgain.cancelled).toBe(false);
  });

  it("task action wait mode=all joins every task and clears awaited after partial failure", async () => {
    const manager = makeManager();
    manager.registerKind(
      "ok",
      () => new Promise((resolve) => setTimeout(() => resolve("ok"), 5)),
    );
    manager.registerKind("fail", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("boom");
    });
    const tools = makeTools(manager);
    const ok = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "ok",
      mode: "awaited",
    });
    const fail = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "fail",
      mode: "awaited",
    });

    const waited = await exec<{
      mode: string;
      complete: boolean;
      terminalTaskIds: string[];
      completed: number;
      failed: number;
      tasks: Array<{ status: string }>;
    }>(tools.task, {
      action: "wait",
      ids: [ok.taskId, fail.taskId],
      mode: "all",
    });

    expect(waited).toMatchObject({
      mode: "all",
      complete: true,
      completed: 1,
      failed: 1,
    });
    expect(waited.terminalTaskIds).toHaveLength(2);
    expect(waited.tasks.map((task) => task.status).sort()).toEqual([
      "completed",
      "failed",
    ]);
    expect(manager.store.get(ok.taskId as TaskId)?.awaited).toBe(false);
    expect(manager.store.get(fail.taskId as TaskId)?.awaited).toBe(false);
  });

  it("task action wait mode=any returns after the first terminal task", async () => {
    const manager = makeManager();
    manager.registerKind("first", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "first";
    });
    manager.registerKind("second", async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return "second";
    });
    const tools = makeTools(manager);
    const first = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "first",
      mode: "awaited",
    });
    const second = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "second",
      mode: "awaited",
    });

    const waited = await exec<{
      mode: string;
      complete: boolean;
      terminalTaskIds: string[];
    }>(tools.task, {
      action: "wait",
      ids: [first.taskId, second.taskId],
      mode: "any",
    });

    expect(waited).toMatchObject({ mode: "any", complete: true });
    expect(waited.terminalTaskIds).toEqual([first.taskId]);
    expect(manager.store.get(first.taskId as TaskId)?.awaited).toBe(false);
    expect(manager.store.get(second.taskId as TaskId)?.awaited).toBe(true);
    await manager.handle(second.taskId as TaskId)?.wait();
  });

  it("task action wait defaults to complete for one terminal task", async () => {
    const manager = makeManager();
    manager.registerKind("done", async () => "done");
    const tools = makeTools(manager);
    const task = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "done",
      mode: "awaited",
    });
    await manager.handle(task.taskId as TaskId)?.wait();

    const waited = await exec<{
      mode: string;
      complete: boolean;
      terminalTaskIds: string[];
      completed: number;
    }>(tools.task, {
      action: "wait",
      taskId: task.taskId,
    });

    expect(waited).toMatchObject({
      mode: "any",
      complete: true,
      completed: 1,
    });
    expect(waited.terminalTaskIds).toEqual([task.taskId]);
    expect(manager.store.get(task.taskId as TaskId)?.awaited).toBe(false);
  });

  it("task action wait does not mark orphaned non-terminal records complete", async () => {
    const manager = makeManager();
    const orphan = manager.store.create({
      id: createTaskId(),
      parentRunId: PARENT_RUN_ID,
      kind: "orphan",
      awaited: true,
    });
    manager.store.update(orphan.id, { status: "running" });
    const tools = makeTools(manager);

    const waited = await exec<{
      mode: string;
      complete: boolean;
      terminalTaskIds: string[];
      completed: number;
      failed: number;
      cancelled: number;
    }>(tools.task, {
      action: "wait",
      taskId: orphan.id,
    });

    expect(waited).toMatchObject({
      mode: "any",
      complete: false,
      terminalTaskIds: [],
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
    expect(manager.store.get(orphan.id)?.awaited).toBe(true);
  });

  it("task output drains buffered chunks", async () => {
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
    }>(tools.task, { action: "output", taskId });
    expect(drained.chunks.map((c) => c.data)).toEqual(["x", "y"]);
    expect(drained.nextSequence).toBe(2);
    expect(drained.complete).toBe(true);
    expect(drained.status).toBe("completed");
  });

  it("task_create dedups a duplicate active background task by kind+title (F3)", async () => {
    const manager = makeManager();
    let release!: () => void;
    manager.registerKind(
      "runner",
      () => new Promise<string>((resolve) => (release = () => resolve("done"))),
    );
    const tools = makeTools(manager);

    const first = await exec<{ taskId: string; deduplicated?: true }>(
      tools.taskCreate,
      {
        kind: "runner",
        mode: "background",
        title: "后台执行：打印数字1-20的python任务",
      },
    );
    expect(first.deduplicated).toBeUndefined();

    // Same goal, title differs only in case — the model re-issuing.
    const second = await exec<{ taskId: string; deduplicated?: true }>(
      tools.taskCreate,
      {
        kind: "runner",
        mode: "background",
        title: "后台执行：打印数字1-20的Python任务",
      },
    );
    expect(second.deduplicated).toBe(true);
    expect(second.taskId).toBe(first.taskId);
    expect(manager.store.list({ parentRunId: PARENT_RUN_ID })).toHaveLength(1);

    // Once the first task is terminal, the same title may start a fresh task.
    release();
    await manager.handle(first.taskId as TaskId)?.wait();
    const third = await exec<{ taskId: string; deduplicated?: true }>(
      tools.taskCreate,
      {
        kind: "runner",
        mode: "background",
        title: "后台执行：打印数字1-20的python任务",
      },
    );
    expect(third.deduplicated).toBeUndefined();
    expect(third.taskId).not.toBe(first.taskId);
  });

  it("task_create does not dedup across different kinds or titles (F3)", async () => {
    const manager = makeManager();
    manager.registerKind("runner", () => new Promise<string>(() => {}));
    manager.registerKind("other", () => new Promise<string>(() => {}));
    const tools = makeTools(manager);

    const a = await exec<{ taskId: string }>(tools.taskCreate, {
      kind: "runner",
      mode: "background",
      title: "task one",
    });
    const differentTitle = await exec<{ taskId: string; deduplicated?: true }>(
      tools.taskCreate,
      { kind: "runner", mode: "background", title: "task two" },
    );
    const differentKind = await exec<{ taskId: string; deduplicated?: true }>(
      tools.taskCreate,
      { kind: "other", mode: "background", title: "task one" },
    );
    expect(differentTitle.deduplicated).toBeUndefined();
    expect(differentKind.deduplicated).toBeUndefined();
    expect(
      new Set([a.taskId, differentTitle.taskId, differentKind.taskId]).size,
    ).toBe(3);
  });
});

describe("TaskManager retention", () => {
  it("prunes old terminal tasks by count", async () => {
    const manager = makeManager();
    for (const label of ["one", "two", "three"]) {
      const handle = manager.spawn({
        parentRunId: PARENT_RUN_ID,
        kind: label,
        runner: async () => label,
      });
      await handle.wait();
    }

    const result = manager.pruneTerminalTasks({ maxTerminalTasks: 1 });

    expect(result.pruned).toBe(2);
    expect(manager.store.list()).toHaveLength(1);
  });
});

describe("TaskWatchdog", () => {
  it("fails tasks that exceed wall timeout", async () => {
    const sink = new InMemoryActorNotificationQueue();
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
    expect(sink.drain()[0]?.type).toBe("failed");
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
        id: "task_pid" as unknown as TaskId,
        parentRunId: PARENT_RUN_ID,
        kind: "pid",
        status: "running",
        awaited: false,
        createdAt: new Date().toISOString(),
        metadata: { pid: process.pid },
      }),
    ).toMatchObject({ ok: true });
    expect(
      pidTaskHealthProbe({
        id: "task_pid_missing" as unknown as TaskId,
        parentRunId: PARENT_RUN_ID,
        kind: "pid",
        status: "running",
        awaited: false,
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "TASK_PROCESS_MISSING" },
    });
  });
});

describe("TaskManager actor notification delivery", () => {
  it("delivers a completion notification when the task succeeds", async () => {
    const sink = new InMemoryActorNotificationQueue();
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
    expect(drained[0]!.type).toBe("completed");
    expect(drained[0]!.source.id).toBe(handle.record.id);
    expect(drained[0]!.payload).toMatchObject({
      taskId: handle.record.id,
      result: "done",
      summary: expect.stringContaining("completed"),
    });
  });

  it("delivers a failure notification with error payload", async () => {
    const sink = new InMemoryActorNotificationQueue();
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
    expect(notification?.type).toBe("failed");
    expect(notification?.payload).toMatchObject({
      error: { message: "boom" },
      summary: expect.stringContaining("boom"),
    });
  });

  it("delivers a cancellation notification", async () => {
    const sink = new InMemoryActorNotificationQueue();
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
    expect(notification?.type).toBe("cancelled");
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

  it("does not enqueue typed non-retryable unsupported actor notification errors", async () => {
    const errors: Array<{ taskId: string; cause: unknown }> = [];
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: {
        deliver: () => {
          throw new ActorNotificationUnsupportedError(
            "FileTaskNotificationOutbox only supports terminal task actor notifications.",
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
      code: "UNSUPPORTED_ACTOR_NOTIFICATION",
      retryable: false,
    });
    expect(manager.pendingNotifications()).toHaveLength(0);
  });

  it("retries pending notifications after sink failures", async () => {
    let fail = true;
    const delivered: TaskTerminalActorNotificationInput[] = [];
    const manager = new TaskManager({
      store: new InMemoryTaskStore(),
      notificationSink: {
        deliver: (notification) => {
          if (fail) throw new Error("queue unavailable");
          delivered.push(notification as TaskTerminalActorNotificationInput);
          return { status: "accepted", acceptedCount: 1 };
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
    expect(delivered[0]?.payload.taskId).toBe(handle.record.id);
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
    expect(drained[0]?.payload.taskId).toBe(handle.record.id);
    expect(manager.pendingNotifications()).toHaveLength(0);
  });

  it("taskNotificationInputFromRecord rejects non-terminal records", () => {
    expect(() =>
      taskNotificationInputFromRecord({
        id: "task_x" as unknown as TaskId,
        parentRunId: PARENT_RUN_ID,
        kind: "k",
        status: "running",
        awaited: false,
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
    ).toThrow(/terminal/);
  });
});
