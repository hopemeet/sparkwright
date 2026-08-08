import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorInbox, TaskManager } from "@sparkwright/agent-runtime";
import { createWorkspaceRevision } from "@sparkwright/core";
import type { HostEvent } from "@sparkwright/protocol";
import { createHostService } from "../src/host-service.js";
import type { HostImPrincipal } from "../src/im-control.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("HostService", () => {
  it("runs different session lanes concurrently through one HostService", async () => {
    const workspaces = await Promise.all([
      mkdtemp(join(tmpdir(), "sparkwright-service-lanes-a-")),
      mkdtemp(join(tmpdir(), "sparkwright-service-lanes-b-")),
    ]);
    tempDirs.push(...workspaces);
    await Promise.all(
      workspaces.map((workspace) =>
        writeFile(join(workspace, "README.md"), "# Demo\n", "utf8"),
      ),
    );
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = approvalScript();
    const service = createHostService();
    const approvals = [deferred<void>(), deferred<void>()];
    const eventKinds: string[][] = [[], []];
    const runtimes = approvals.map((approval, index) =>
      service.createRuntime({
        workspaceRoot: workspaces[index]!,
        defaultModel: "scripted",
        approvalTimeoutMs: 5_000,
        emit: (event) => {
          const runEvent =
            event.kind === "run.event" &&
            typeof event.payload.event === "object" &&
            event.payload.event !== null &&
            "type" in event.payload.event
              ? String(event.payload.event.type)
              : undefined;
          eventKinds[index]!.push(runEvent ?? event.kind);
          if (event.kind === "approval.requested") approval.resolve();
        },
      }),
    );
    try {
      const starts = await Promise.all(
        runtimes.map((runtime, index) =>
          runtime.startRun({
            goal: `concurrent ${index}`,
            sessionId: `service_concurrent_${index}`,
            accessMode: "ask",
          }),
        ),
      );
      expect(starts.every((result) => result.ok)).toBe(true);
      await Promise.race([
        Promise.all(approvals.map((approval) => approval.promise)),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `both executions did not reach approval: ${JSON.stringify(eventKinds)}`,
                ),
              ),
            1_000,
          ),
        ),
      ]);
      expect(runtimes.every((runtime) => runtime.executionIdentity())).toBe(
        true,
      );
      for (const [index, result] of starts.entries()) {
        if (result.ok) runtimes[index]!.cancelRun(result.runId, "qa cleanup");
      }
    } finally {
      await service.shutdown();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
    }
  });

  it("serializes two runtime facades targeting the same canonical session lane", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-service-serial-"),
    );
    tempDirs.push(workspace);
    await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
    const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = approvalScript();
    const service = createHostService();
    const firstApproval = deferred<void>();
    const secondApproval = deferred<void>();
    const first = service.createRuntime({
      workspaceRoot: workspace,
      defaultModel: "scripted",
      approvalTimeoutMs: 5_000,
      emit: (event) => {
        if (event.kind === "approval.requested") firstApproval.resolve();
      },
    });
    const second = service.createRuntime({
      workspaceRoot: workspace,
      defaultModel: "scripted",
      approvalTimeoutMs: 5_000,
      emit: (event) => {
        if (event.kind === "approval.requested") secondApproval.resolve();
      },
    });
    try {
      const firstStart = await first.startRun({
        goal: "first serialized turn",
        sessionId: "service_shared_session",
        accessMode: "ask",
      });
      expect(firstStart.ok).toBe(true);
      await firstApproval.promise;

      let secondSettled = false;
      const secondStarting = second
        .startRun({
          goal: "second serialized turn",
          sessionId: "service_shared_session",
          accessMode: "ask",
        })
        .finally(() => {
          secondSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(secondSettled).toBe(false);
      expect(second.executionIdentity()).toBeUndefined();

      if (firstStart.ok)
        first.cancelRun(firstStart.runId, "release first lane owner");
      const secondStart = await secondStarting;
      expect(secondStart.ok).toBe(true);
      await secondApproval.promise;
      if (secondStart.ok) second.cancelRun(secondStart.runId, "qa cleanup");
    } finally {
      await service.shutdown();
      if (previousScript === undefined) {
        delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
      } else {
        process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
      }
    }
  });

  it("shares workspace durable owners without sharing live executions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-service-"));
    tempDirs.push(workspace);
    const service = createHostService();
    const first = service.createRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    });
    const second = service.createRuntime({
      workspaceRoot: join(workspace, "."),
      defaultModel: "deterministic",
      emit: () => {},
    });

    expect(service.workspaceContextCount()).toBe(1);
    expect((first as unknown as { taskManager: unknown }).taskManager).toBe(
      (second as unknown as { taskManager: unknown }).taskManager,
    );

    const firstStarting = first.startRun({
      goal: "first",
      sessionId: "service_first",
    });
    const secondStarting = second.startRun({
      goal: "second",
      sessionId: "service_second",
    });
    const firstIdentity = first.executionIdentity();
    const secondIdentity = second.executionIdentity();
    const [firstStart, secondStart] = await Promise.all([
      firstStarting,
      secondStarting,
    ]);
    expect(firstStart.ok).toBe(true);
    expect(secondStart.ok).toBe(true);
    expect(firstIdentity?.executionId).toBeDefined();
    expect(secondIdentity?.executionId).toBeDefined();
    expect(firstIdentity?.executionId).not.toBe(secondIdentity?.executionId);
    if (firstStart.ok) {
      expect(service.findExecutionByRunId(firstStart.runId)).toBe(first);
    }
    if (secondIdentity) {
      expect(service.findExecutionById(secondIdentity.executionId)).toBe(
        second,
      );
    }

    await service.shutdown();
  });

  it("publishes detached task lifecycle events after the parent run completes without consuming its actor inbox", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-service-task-events-"),
    );
    tempDirs.push(workspace);
    const events: HostEvent[] = [];
    const terminalRun = deferred<void>();
    const service = createHostService();
    const runtime = service.createRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => {
        events.push(event);
        if (event.kind === "run.completed" || event.kind === "run.failed") {
          terminalRun.resolve();
        }
      },
    });

    try {
      const started = await runtime.startRun({
        goal: "establish a completed parent run for task event routing",
        sessionId: "service_task_events",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await terminalRun.promise;
      await waitUntil(() => runtime.executionIdentity() === undefined);
      expect(runtime.executionIdentity()).toBeUndefined();

      const taskRuntime = (
        runtime as unknown as {
          tasks: { manager: TaskManager; notifications: ActorInbox };
        }
      ).tasks;
      const handle = taskRuntime.manager.spawn({
        parentRunId: started.runId as Parameters<
          TaskManager["spawn"]
        >[0]["parentRunId"],
        kind: "agent",
        title: "detached after parent completion",
        completionPolicy: "detached",
        awaited: false,
        runner: async () => ({ summary: "safe result", secret: "hidden" }),
      });
      await handle.wait();

      const updates = events.filter(
        (event): event is HostEvent & { kind: "task.updated" } =>
          event.kind === "task.updated" &&
          event.payload.taskId === handle.record.id,
      );
      expect(
        updates.map((event) => [
          event.payload.transition,
          event.payload.status,
        ]),
      ).toEqual([
        ["created", "pending"],
        ["started", "running"],
        ["terminal", "completed"],
      ]);
      expect(updates.at(-1)?.payload).toMatchObject({
        parentRunId: started.runId,
        sessionId: "service_task_events",
        completionPolicy: "detached",
        awaited: false,
        outputRef: { method: "task.output", taskId: handle.record.id },
      });
      expect(updates.at(-1)?.payload).not.toHaveProperty("result");
      expect(updates.at(-1)?.payload).not.toHaveProperty("metadata");
      expect(await taskRuntime.notifications.peek()).toHaveLength(1);
      expect(runtime.getTask(handle.record.id)).toMatchObject({
        ok: true,
        task: {
          status: "completed",
          completionPolicy: "detached",
          result: { summary: "safe result", secret: "hidden" },
        },
      });
    } finally {
      await service.shutdown();
    }
  });

  it("delivers detached task lifecycle updates to the exact IM binding after the parent run ends", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-service-im-task-events-"),
    );
    tempDirs.push(workspace);
    const parentTerminal = deferred<void>();
    const service = createHostService({
      imControl: { allowSelfBinding: true },
    });
    const runtime = service.createRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: (event) => {
        if (event.kind === "run.completed" || event.kind === "run.failed") {
          parentTerminal.resolve();
        }
      },
    });
    const principal: HostImPrincipal = {
      id: "gateway:task-owner",
      kind: "gateway",
      authenticated: true,
      authenticatedBy: "test-credential",
      clientName: "sparkwright-im-gateway",
    };
    const subject = {
      platform: "telegram",
      chatId: "task_chat",
      userId: "task_user",
    };

    try {
      const bound = service.bindImSession(
        principal,
        {
          subject,
          permissions: ["message", "inspect"],
        },
        runtime,
      );
      expect(bound.ok).toBe(true);
      if (!bound.ok) return;
      expect(
        service.subscribeImSession(principal, {
          bindingId: bound.binding.bindingId,
          subject,
        }),
      ).toMatchObject({ ok: true });

      const started = await service.dispatchImMessage(principal, runtime, {
        bindingId: bound.binding.bindingId,
        subject,
        text: "establish a completed IM parent run",
        metadata: {
          recipient: "model-supplied-recipient-must-not-route",
        },
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await parentTerminal.promise;
      await waitUntil(() => runtime.executionIdentity() === undefined);

      const prior = service.subscribeImSession(principal, {
        bindingId: bound.binding.bindingId,
        subject,
      });
      expect(prior.ok).toBe(true);
      if (!prior.ok) return;
      service.acknowledgeImDeliveries(principal, {
        bindingId: bound.binding.bindingId,
        subject,
        deliveryKeys: prior.deliveries.map((delivery) => delivery.deliveryKey),
      });

      const taskRuntime = (
        runtime as unknown as {
          tasks: { manager: TaskManager; notifications: ActorInbox };
        }
      ).tasks;
      const handle = taskRuntime.manager.spawn({
        parentRunId: started.runId as Parameters<
          TaskManager["spawn"]
        >[0]["parentRunId"],
        kind: "agent",
        title: "detached IM completion",
        completionPolicy: "detached",
        awaited: false,
        runner: async () => ({
          summary: "safe external summary",
          password: "must be redacted",
        }),
      });
      await handle.wait();

      const replay = service.subscribeImSession(principal, {
        bindingId: bound.binding.bindingId,
        subject,
      });
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      const taskDeliveries = replay.deliveries.filter(
        (delivery) =>
          delivery.event.kind === "task.updated" &&
          delivery.event.payload.taskId === handle.record.id,
      );
      expect(
        taskDeliveries.map((delivery) => [
          delivery.event.kind === "task.updated"
            ? delivery.event.payload.transition
            : undefined,
          delivery.event.kind === "task.updated"
            ? delivery.event.payload.status
            : undefined,
        ]),
      ).toEqual([
        ["created", "pending"],
        ["started", "running"],
        ["terminal", "completed"],
      ]);
      expect(taskDeliveries.at(-1)).toMatchObject({
        deliveryKey: `${bound.binding.sessionId}:task:${handle.record.id}:terminal:completed`,
        sessionId: bound.binding.sessionId,
        event: {
          kind: "task.updated",
          payload: {
            sessionId: bound.binding.sessionId,
            parentRunId: started.runId,
            completionPolicy: "detached",
            resultSummary: expect.stringContaining("[REDACTED]"),
          },
        },
      });
      expect(JSON.stringify(taskDeliveries)).not.toContain("must be redacted");

      const otherPrincipal: HostImPrincipal = {
        ...principal,
        id: "gateway:task-observer",
      };
      const otherSubject = { ...subject, userId: "other_user" };
      const other = service.bindImSession(otherPrincipal, {
        subject: otherSubject,
        permissions: ["message", "inspect"],
      });
      expect(other.ok).toBe(true);
      if (!other.ok) return;
      expect(
        service.subscribeImSession(otherPrincipal, {
          bindingId: other.binding.bindingId,
          subject: otherSubject,
        }),
      ).toMatchObject({ ok: true, deliveries: [] });
    } finally {
      await service.shutdown();
    }
  });

  it("owns IM binding, subscription, dispatch, replay, and retention", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-service-im-"));
    tempDirs.push(workspace);
    const service = createHostService({
      imControl: { allowSelfBinding: true },
    });
    const runtime = service.createRuntime({
      workspaceRoot: workspace,
      defaultModel: "deterministic",
      emit: () => {},
    });
    const principal: HostImPrincipal = {
      id: "gateway:trusted",
      kind: "gateway",
      authenticated: true,
      authenticatedBy: "test-credential",
      clientName: "sparkwright-im-gateway",
    };
    const subject = {
      platform: "telegram",
      chatId: "chat_1",
      userId: "user_1",
    };
    const bound = service.bindImSession(
      principal,
      {
        subject,
        permissions: ["message", "inspect", "approve"],
      },
      runtime,
    );
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(
      service.subscribeImSession(principal, {
        bindingId: bound.binding.bindingId,
        subject,
      }).ok,
    ).toBe(true);

    const starting = service.dispatchImMessage(principal, runtime, {
      bindingId: bound.binding.bindingId,
      subject,
      text: "inspect the workspace",
    });
    const identity = runtime.executionIdentity();
    expect(identity?.executionId).toBeDefined();
    service.releaseRuntime(runtime);
    expect(service.findExecutionById(identity!.executionId)).toBe(runtime);
    const started = await starting;
    expect(started).toMatchObject({ ok: true, status: "started" });

    const rebound = service.bindImSession(principal, {
      subject,
      permissions: ["message", "inspect", "approve"],
    });
    expect(rebound).toMatchObject({
      ok: true,
      binding: { bindingId: bound.binding.bindingId },
    });

    const replay = service.subscribeImSession(principal, {
      bindingId: bound.binding.bindingId,
      subject,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.deliveries.length).toBeGreaterThan(0);
      const acknowledged = service.acknowledgeImDeliveries(principal, {
        bindingId: bound.binding.bindingId,
        subject,
        deliveryKeys: replay.deliveries.map((item) => item.deliveryKey),
      });
      expect(acknowledged).toMatchObject({ ok: true });
    }
    await service.shutdown();
  });
});

function approvalScript(): string {
  return JSON.stringify([
    {
      toolCalls: [
        {
          toolName: "edit",
          arguments: {
            path: "README.md",
            expectedRevision: createWorkspaceRevision(true, "# Demo\n"),
            patch: [
              "--- a/README.md",
              "+++ b/README.md",
              "@@ -1 +1,2 @@",
              " # Demo",
              "+lane qa",
              "",
            ].join("\n"),
          },
        },
      ],
    },
  ]);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition did not become true before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
