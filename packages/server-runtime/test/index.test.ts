import { describe, expect, it } from "vitest";
import { InFlightCommandDispatcher, WorkflowSupervisor } from "../src/index.js";
import {
  FileWorkflowStore,
  FileWorkflowWorkerRegistry,
  type WorkflowRunId,
} from "@sparkwright/agent-runtime";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function workflowPin(id: WorkflowRunId) {
  const packageSnapshotRef = `/snapshots/${id}`;
  const packageHash = `sha256:${id}`;
  return {
    assetName: "test",
    layer: "project" as const,
    packageHash,
    packageHashPolicyVersion: 2 as const,
    packageSnapshotRef,
    definitionSnapshot: {
      assetName: "test",
      sourceDir: packageSnapshotRef,
      layer: "project" as const,
      packageHash,
      packageHashPolicyVersion: 2 as const,
      packageSnapshotRef,
      nodes: [{ id: "main", body: "Test." }],
    },
  };
}

describe("server-runtime", () => {
  it("coalesces concurrent in-flight consumption without claiming durability", async () => {
    const dispatcher = new InFlightCommandDispatcher();
    let calls = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consume = () =>
      dispatcher.dispatch("workflow_command_one", async () => {
        calls += 1;
        await barrier;
        return "applied";
      });
    const first = consume();
    const duplicate = consume();
    expect(dispatcher.isInFlight("workflow_command_one")).toBe(true);
    release();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      "applied",
      "applied",
    ]);
    expect(calls).toBe(1);
    expect(dispatcher.isInFlight("workflow_command_one")).toBe(false);
  });

  it("lets only one supervisor invoke the adapter for a workflow claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-supervisor-"));
    const store = new FileWorkflowStore({ rootDir: root });
    const workflowRunId = "workflow_supervised" as WorkflowRunId;
    const creator = await store.acquireWriter(workflowRunId, {
      owner: "creator",
    });
    await creator!.create({
      id: workflowRunId,
      ...workflowPin(workflowRunId),
    });
    await creator!.release();
    const registry = new FileWorkflowWorkerRegistry({
      rootDir: join(root, "workers"),
    });
    const workerA = await registry.register({
      workerId: "a",
      workspaceId: "workspace",
    });
    const workerB = await registry.register({
      workerId: "b",
      workspaceId: "workspace",
    });
    let calls = 0;
    let entered!: () => void;
    const adapterEntered = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const adapter = {
      async runClaimed() {
        calls += 1;
        entered();
        await barrier;
        return "interrupted" as const;
      },
    };
    const supervisorA = new WorkflowSupervisor({
      store,
      worker: workerA,
      adapter,
    });
    const supervisorB = new WorkflowSupervisor({
      store: new FileWorkflowStore({ rootDir: root }),
      worker: workerB,
      adapter,
    });
    const first = supervisorA.runOnce();
    await adapterEntered;
    const second = await supervisorB.runOnce();
    release();
    const firstReport = await first;
    expect(calls).toBe(1);
    expect(firstReport.claimed).toEqual([workflowRunId]);
    expect(second.busy).toEqual([workflowRunId]);
  });

  it("drain prevents new claims and reports an active claimed workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-supervisor-"));
    const store = new FileWorkflowStore({ rootDir: root });
    const workflowRunId = "workflow_drain" as WorkflowRunId;
    const creator = await store.acquireWriter(workflowRunId, {
      owner: "creator",
    });
    await creator!.create({
      id: workflowRunId,
      ...workflowPin(workflowRunId),
    });
    await creator!.release();
    const registry = new FileWorkflowWorkerRegistry({
      rootDir: join(root, "workers"),
    });
    const worker = await registry.register({
      workerId: "a",
      workspaceId: "workspace",
    });
    let entered!: () => void;
    const adapterEntered = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const supervisor = new WorkflowSupervisor({
      store,
      worker,
      adapter: {
        async runClaimed() {
          entered();
          await barrier;
          return "interrupted";
        },
      },
    });
    const running = supervisor.runOnce();
    await adapterEntered;
    expect(await supervisor.drain()).toEqual({
      drained: false,
      remainingWorkflowRunIds: [workflowRunId],
    });
    release();
    await running;
    expect((await supervisor.runOnce()).claimed).toEqual([]);
  });

  it("rebuilds inventory after restart and skips waiting and terminal workflows", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-supervisor-"));
    const store = new FileWorkflowStore({ rootDir: root });
    const runningId = "workflow_restart" as WorkflowRunId;
    const waitingId = "workflow_waiting" as WorkflowRunId;
    const terminalId = "workflow_terminal" as WorkflowRunId;
    for (const [id, status] of [
      [runningId, "running"],
      [waitingId, "waiting"],
      [terminalId, "completed"],
    ] as const) {
      const writer = await store.acquireWriter(id, { owner: "creator" });
      const created = await writer!.create({
        id,
        ...workflowPin(id),
      });
      if (status !== "running") {
        await writer!.mutate({
          expectedRevision: created.recordRevision!,
          patch:
            status === "waiting"
              ? { status, wait: { kind: "input" } }
              : { status },
          event: {
            at: new Date().toISOString(),
            type: "updated",
            workflowRunId: id,
            status,
          },
        });
      }
      await writer!.release();
    }
    const registry = new FileWorkflowWorkerRegistry({
      rootDir: join(root, "workers"),
    });
    const worker = await registry.register({
      workerId: "restart",
      workspaceId: "workspace",
    });
    const invoked: string[] = [];
    const restarted = new WorkflowSupervisor({
      store: new FileWorkflowStore({ rootDir: root, createRoot: false }),
      worker,
      adapter: {
        async runClaimed({ record }) {
          invoked.push(record.id);
          return "interrupted";
        },
      },
      maxClaims: 2,
    });

    const report = await restarted.runOnce();

    expect(report.scanned).toBe(2);
    expect(report.skipped).toEqual([waitingId]);
    expect(invoked).toEqual([runningId]);
  });

  it("does not claim work after the durable worker heartbeat expires", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-supervisor-"));
    let now = new Date("2026-07-11T00:00:00.000Z");
    const store = new FileWorkflowStore({ rootDir: root });
    const workflowRunId = "workflow_expired_worker" as WorkflowRunId;
    const creator = await store.acquireWriter(workflowRunId, {
      owner: "creator",
    });
    await creator!.create({
      id: workflowRunId,
      ...workflowPin(workflowRunId),
    });
    await creator!.release();
    const registry = new FileWorkflowWorkerRegistry({
      rootDir: join(root, "workers"),
      now: () => now,
    });
    const worker = await registry.register({
      workerId: "expired",
      workspaceId: "workspace",
      ttlMs: 10,
    });
    now = new Date("2026-07-11T00:00:00.011Z");
    let invoked = false;
    const supervisor = new WorkflowSupervisor({
      store,
      worker,
      now: () => now,
      adapter: {
        async runClaimed() {
          invoked = true;
          return "interrupted";
        },
      },
    });

    expect((await supervisor.runOnce()).claimed).toEqual([]);
    expect(invoked).toBe(false);
  });

  it("takes over an expired writer and fences the revived worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-supervisor-"));
    let now = new Date("2026-07-11T00:00:00.000Z");
    const storeA = new FileWorkflowStore({ rootDir: root });
    const workflowRunId = "workflow_takeover" as WorkflowRunId;
    const creator = await storeA.acquireWriter(workflowRunId, {
      owner: "creator",
      now: () => now,
    });
    await creator!.create({
      id: workflowRunId,
      ...workflowPin(workflowRunId),
    });
    await creator!.release();
    const frozenA = await storeA.acquireWriter(workflowRunId, {
      owner: "worker:a",
      ttlMs: 10,
      now: () => now,
    });
    const staleRecord = await frozenA!.readFresh();
    now = new Date("2026-07-11T00:00:00.011Z");
    const registry = new FileWorkflowWorkerRegistry({
      rootDir: join(root, "workers"),
      now: () => now,
    });
    const workerB = await registry.register({
      workerId: "b",
      workspaceId: "workspace",
    });
    let successorGeneration = 0;
    const supervisorB = new WorkflowSupervisor({
      store: new FileWorkflowStore({ rootDir: root }),
      worker: workerB,
      leaseTtlMs: 10,
      now: () => now,
      leaseNow: () => now,
      adapter: {
        async runClaimed({ record, writer }) {
          successorGeneration = writer.generation;
          await writer.mutate({
            expectedRevision: record.recordRevision!,
            patch: { metadata: { successor: true } },
            event: {
              at: now.toISOString(),
              type: "updated",
              workflowRunId,
              status: record.status,
            },
          });
          return "interrupted";
        },
      },
    });

    const takeover = await supervisorB.runOnce();
    expect(takeover).toMatchObject({ claimed: [workflowRunId] });
    expect(successorGeneration).toBeGreaterThan(frozenA!.generation);
    await expect(
      frozenA!.mutate({
        expectedRevision: staleRecord!.recordRevision!,
        patch: { metadata: { stale: true } },
        event: {
          at: now.toISOString(),
          type: "updated",
          workflowRunId,
          status: "running",
        },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_STALE_WRITE" });
    expect(await frozenA!.release()).toBe(false);
    expect(
      new FileWorkflowStore({ rootDir: root, createRoot: false }).get(
        workflowRunId,
      ),
    ).toMatchObject({
      generation: successorGeneration,
      metadata: { successor: true },
    });
  });
});
