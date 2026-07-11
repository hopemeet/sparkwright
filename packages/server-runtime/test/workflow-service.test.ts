import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FileWorkflowServiceStore,
  WorkflowServiceCarrier,
} from "../src/workflow-service.js";

function handoff(now: Date, overrides: Record<string, unknown> = {}) {
  return {
    handoffId: "handoff_1",
    idempotencyKey: "idem_1",
    workspaceId: "workspace_1",
    workflowName: "demo",
    goal: "do durable work",
    jobSessionId: "session_workflow_1",
    permissionMode: "default" as const,
    shouldWrite: false,
    traceLevel: "standard" as const,
    source: { kind: "cli" as const, principalId: "cli:test" },
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("workflow service", () => {
  it("publishes idempotent durable handoffs and rejects conflicts", async () => {
    const now = new Date("2026-07-11T00:00:00.000Z");
    const store = new FileWorkflowServiceStore({
      rootDir: await mkdtemp(join(tmpdir(), "sw-service-")),
      now: () => now,
    });
    const first = await store.publishHandoff(handoff(now));
    expect((await store.publishHandoff(handoff(now))).handoffId).toBe(
      first.handoffId,
    );
    await expect(
      store.publishHandoff(handoff(now, { goal: "different" })),
    ).rejects.toThrow("handoff conflict");
  });

  it("allows only one live carrier and recovers after expiry", async () => {
    let now = new Date("2026-07-11T00:00:00.000Z");
    const store = new FileWorkflowServiceStore({
      rootDir: await mkdtemp(join(tmpdir(), "sw-service-")),
      now: () => now,
    });
    expect(
      await store.acquireInstance({
        workspaceId: "workspace_1",
        instanceId: "a",
        ttlMs: 10,
      }),
    ).toBeDefined();
    expect(
      await store.acquireInstance({
        workspaceId: "workspace_1",
        instanceId: "b",
        ttlMs: 10,
      }),
    ).toBeUndefined();
    now = new Date(now.getTime() + 11);
    expect(
      await store.acquireInstance({
        workspaceId: "workspace_1",
        instanceId: "b",
        ttlMs: 10,
      }),
    ).toBeDefined();
  });

  it("scopes durable drain requests to the current service instance", async () => {
    const store = new FileWorkflowServiceStore({
      rootDir: await mkdtemp(join(tmpdir(), "sw-service-")),
    });
    await store.requestDrain("instance_a");
    expect(store.drainRequested("instance_a")).toBe(true);
    expect(store.drainRequested("instance_b")).toBe(false);
  });

  it("recovers record-created handoffs and never calls accept twice", async () => {
    const now = new Date("2026-07-11T00:00:00.000Z");
    const store = new FileWorkflowServiceStore({
      rootDir: await mkdtemp(join(tmpdir(), "sw-service-")),
      now: () => now,
    });
    await store.publishHandoff(handoff(now));
    const instance = await store.acquireInstance({
      workspaceId: "workspace_1",
    });
    if (!instance) throw new Error("missing instance");
    const accept = vi.fn();
    const carrier = new WorkflowServiceCarrier({
      store,
      instance,
      now: () => now,
      adapter: {
        recover: async () => ({
          workflowRunId: "workflow_1",
          sessionId: "session_workflow_1",
        }),
        accept,
      },
    });
    expect(await carrier.start()).toBe(true);
    expect(accept).not.toHaveBeenCalled();
    expect(store.readOutcome("handoff_1")).toMatchObject({
      status: "accepted",
      workflowRunId: "workflow_1",
    });
    expect(await carrier.runOnce()).toEqual({ accepted: [], rejected: [] });
  });

  it("rejects expired and cross-workspace handoffs and drain stops accepts", async () => {
    const now = new Date("2026-07-11T00:00:00.000Z");
    const store = new FileWorkflowServiceStore({
      rootDir: await mkdtemp(join(tmpdir(), "sw-service-")),
      now: () => now,
    });
    await store.publishHandoff(
      handoff(now, { workspaceId: "other", expiresAt: now.toISOString() }),
    );
    const instance = await store.acquireInstance({
      workspaceId: "workspace_1",
    });
    if (!instance) throw new Error("missing instance");
    const accept = vi.fn();
    const carrier = new WorkflowServiceCarrier({
      store,
      instance,
      adapter: { accept },
      now: () => now,
    });
    expect(await carrier.runOnce()).toEqual({
      accepted: [],
      rejected: ["handoff_1"],
    });
    expect(accept).not.toHaveBeenCalled();
    expect(await carrier.drain()).toEqual({ drained: true, active: 0 });
    expect(await carrier.runOnce()).toEqual({ accepted: [], rejected: [] });
  });

  it("fences a revived carrier without rejecting the successor handoff", async () => {
    let now = new Date("2026-07-11T00:00:00.000Z");
    const store = new FileWorkflowServiceStore({
      rootDir: await mkdtemp(join(tmpdir(), "sw-service-")),
      now: () => now,
    });
    const oldInstance = await store.acquireInstance({
      workspaceId: "workspace_1",
      instanceId: "old",
      ttlMs: 10,
    });
    if (!oldInstance) throw new Error("missing old instance");
    expect(await oldInstance.ready()).toBe(true);
    const oldAccept = vi.fn();
    const oldCarrier = new WorkflowServiceCarrier({
      store,
      instance: oldInstance,
      adapter: { accept: oldAccept },
      now: () => now,
    });
    now = new Date(now.getTime() + 11);
    const successor = await store.acquireInstance({
      workspaceId: "workspace_1",
      instanceId: "successor",
      ttlMs: 10,
    });
    if (!successor) throw new Error("missing successor instance");
    expect(await successor.ready()).toBe(true);
    await store.publishHandoff(handoff(now));
    expect(await oldCarrier.runOnce()).toEqual({ accepted: [], rejected: [] });
    expect(oldAccept).not.toHaveBeenCalled();
    expect(store.readOutcome("handoff_1")).toBeUndefined();

    const nextCarrier = new WorkflowServiceCarrier({
      store,
      instance: successor,
      adapter: {
        accept: async () => ({
          workflowRunId: "workflow_successor",
          sessionId: "session_workflow_1",
        }),
      },
      now: () => now,
    });
    expect(await nextCarrier.runOnce()).toEqual({
      accepted: ["handoff_1"],
      rejected: [],
    });
  });
});
