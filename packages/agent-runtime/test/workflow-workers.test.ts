import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileWorkflowWorkerRegistry } from "../src/index.js";

describe("FileWorkflowWorkerRegistry", () => {
  it("persists heartbeat, drain, stop, and expiry without reusing instance identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-workers-"));
    let now = new Date("2026-07-11T00:00:00.000Z");
    const registry = new FileWorkflowWorkerRegistry({
      rootDir: root,
      now: () => now,
    });
    const worker = await registry.register({
      workerId: "worker_a",
      instanceId: "instance_a",
      workspaceId: "workspace",
      ttlMs: 100,
    });
    now = new Date("2026-07-11T00:00:00.050Z");
    expect(await worker.heartbeat()).toBe(true);
    expect(registry.isLive(worker.record())).toBe(true);
    expect(await worker.drain()).toBe(true);
    expect(await worker.heartbeat()).toBe(false);
    expect(await worker.stop()).toBe(true);
    expect(registry.isLive(worker.record())).toBe(false);
    expect(
      await new FileWorkflowWorkerRegistry({
        rootDir: root,
        createRoot: false,
      }).list(),
    ).toEqual([
      expect.objectContaining({ workerId: "worker_a", state: "stopped" }),
    ]);
    await expect(
      registry.register({
        workerId: "worker_a",
        instanceId: "instance_a",
        workspaceId: "workspace",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("marks a missed heartbeat expired using a controllable clock", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-workers-"));
    let now = new Date("2026-07-11T00:00:00.000Z");
    const registry = new FileWorkflowWorkerRegistry({
      rootDir: root,
      now: () => now,
    });
    const worker = await registry.register({
      workerId: "worker_a",
      workspaceId: "workspace",
      ttlMs: 10,
    });
    now = new Date("2026-07-11T00:00:00.011Z");
    expect(registry.isLive(worker.record())).toBe(false);
    expect(await worker.heartbeat()).toBe(false);
  });
});
