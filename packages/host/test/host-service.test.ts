import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
