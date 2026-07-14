import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostService } from "../src/host-service.js";

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
});
