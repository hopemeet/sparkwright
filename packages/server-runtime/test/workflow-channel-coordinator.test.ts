import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FileWorkflowChannelStore,
  FileWorkflowNotificationOutbox,
  type WorkflowRunId,
} from "@sparkwright/agent-runtime";
import { WorkflowChannelCoordinator } from "../src/workflow-channel-coordinator.js";

const workflowRunId = "workflow_channel_delivery" as WorkflowRunId;

function emitWaiting(outbox: FileWorkflowNotificationOutbox): void {
  outbox.deliver({
    source: {
      kind: "workflow",
      id: workflowRunId,
      sessionId: "session_workflow_channel",
    },
    type: "waiting",
    correlationId: "wait-1",
    payload: {
      workflowId: workflowRunId,
      name: "demo",
      summary: "Waiting for input.",
      wait: { id: "wait-1", kind: "input", reason: "Choose." },
    },
  });
}

describe("WorkflowChannelCoordinator", () => {
  it("delivers once per binding and suppresses terminal receipt duplicates", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sw-channel-delivery-"));
    const now = new Date("2026-07-11T00:00:00.000Z");
    const outbox = new FileWorkflowNotificationOutbox({ rootDir });
    const channels = new FileWorkflowChannelStore({ rootDir, now: () => now });
    await channels.bind({
      bindingId: "workflow_binding_delivery",
      workspaceId: "/workspace",
      workflowRunId,
      sessionId: "session_workflow_channel",
      source: {
        kind: "im",
        principalId: "user:1",
        authenticatedBy: "telegram:webhook",
        channelId: "telegram:chat:1",
      },
      allowedCommandKinds: ["provide_input"],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    emitWaiting(outbox);
    const deliver = vi.fn(async ({ deliveryKey }: { deliveryKey: string }) => ({
      transportMessageId: `transport:${deliveryKey}`,
    }));
    const coordinator = new WorkflowChannelCoordinator({
      outbox,
      channels,
      adapter: { deliver },
      now: () => now,
    });
    const first = await coordinator.runOnce();
    expect(first.delivered).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    const second = await coordinator.runOnce();
    expect(second.skipped).toEqual(first.delivered);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("retries send-before-receipt crashes with the same delivery key", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sw-channel-delivery-"));
    let now = new Date("2026-07-11T00:00:00.000Z");
    const outbox = new FileWorkflowNotificationOutbox({ rootDir });
    const channels = new FileWorkflowChannelStore({ rootDir, now: () => now });
    await channels.bind({
      bindingId: "workflow_binding_retry",
      workspaceId: "/workspace",
      workflowRunId,
      source: {
        kind: "api",
        principalId: "api:1",
        authenticatedBy: "oauth",
        channelId: "webhook:1",
      },
      allowedCommandKinds: ["cancel"],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    emitWaiting(outbox);
    const keys: string[] = [];
    let attempt = 0;
    const coordinator = new WorkflowChannelCoordinator({
      outbox,
      channels,
      now: () => now,
      adapter: {
        deliver: async ({ deliveryKey }) => {
          keys.push(deliveryKey);
          attempt += 1;
          if (attempt === 1) throw new Error("crash after transport send");
          return { transportMessageId: "stable-message" };
        },
      },
    });
    expect((await coordinator.runOnce()).failed).toHaveLength(1);
    now = new Date(now.getTime() + 1);
    expect((await coordinator.runOnce()).delivered).toHaveLength(1);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(
      channels.snapshot(workflowRunId).deliveries.map((entry) => entry.status),
    ).toEqual(expect.arrayContaining(["failed", "delivered"]));
  });

  it("records expired and revoked bindings without invoking transport", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sw-channel-delivery-"));
    const now = new Date("2026-07-11T00:00:01.000Z");
    const outbox = new FileWorkflowNotificationOutbox({ rootDir });
    const channels = new FileWorkflowChannelStore({ rootDir, now: () => now });
    await channels.bind({
      bindingId: "workflow_binding_expired_delivery",
      workspaceId: "/workspace",
      workflowRunId,
      source: {
        kind: "cli",
        principalId: "cli:1",
        authenticatedBy: "local-user",
        channelId: "terminal:1",
      },
      allowedCommandKinds: ["provide_input"],
      createdAt: "2026-07-11T00:00:00.000Z",
      expiresAt: "2026-07-11T00:00:00.500Z",
    });
    const revoked = await channels.bind({
      bindingId: "workflow_binding_revoked_delivery",
      workspaceId: "/workspace",
      workflowRunId,
      source: {
        kind: "im",
        principalId: "user:2",
        authenticatedBy: "telegram:webhook",
        channelId: "telegram:2",
      },
      allowedCommandKinds: ["provide_input"],
      createdAt: "2026-07-11T00:00:00.000Z",
      expiresAt: "2026-07-11T00:01:00.000Z",
    });
    await channels.revoke({ workflowRunId, bindingId: revoked.bindingId });
    emitWaiting(outbox);
    const deliver = vi.fn();
    const report = await new WorkflowChannelCoordinator({
      outbox,
      channels,
      adapter: { deliver },
      now: () => now,
    }).runOnce();
    expect(report.skipped).toHaveLength(2);
    expect(deliver).not.toHaveBeenCalled();
    expect(
      channels
        .snapshot(workflowRunId)
        .deliveries.map((entry) => entry.status)
        .sort(),
    ).toEqual(["expired", "revoked"]);
  });
});
