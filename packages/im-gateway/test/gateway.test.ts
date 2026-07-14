import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type {
  HostEvent,
  ImDelivery,
  ImSubjectClaims,
} from "@sparkwright/sdk-node";
import {
  FileWorkflowChannelStore,
  FileWorkflowControlInbox,
  FileWorkflowNotificationOutbox,
  type WorkflowRunId,
} from "@sparkwright/agent-runtime";
import { createImWorkflowChannelId, ImGateway } from "../src/gateway.js";
import { GatewayStore } from "../src/store.js";
import type {
  ApprovalPrompt,
  OutboundMessage,
  OutboundTarget,
  PlatformAdapter,
  PlatformHandlers,
  WorkflowNotificationPrompt,
} from "../src/types.js";

class FakeAdapter implements PlatformAdapter {
  readonly platform = "telegram";
  sent: Array<{ target: OutboundTarget; message: OutboundMessage }> = [];
  approvals: Array<{ target: OutboundTarget; approval: ApprovalPrompt }> = [];
  workflowNotifications: Array<{
    target: OutboundTarget;
    prompt: WorkflowNotificationPrompt;
  }> = [];
  handlers?: PlatformHandlers;
  failNextMessage = false;

  async start(handlers: PlatformHandlers): Promise<void> {
    this.handlers = handlers;
  }
  async stop(): Promise<void> {}
  async sendMessage(
    target: OutboundTarget,
    message: OutboundMessage,
  ): Promise<void> {
    if (this.failNextMessage) {
      this.failNextMessage = false;
      throw new Error("transport offline");
    }
    this.sent.push({ target, message });
  }
  async sendApproval(
    target: OutboundTarget,
    approval: ApprovalPrompt,
  ): Promise<void> {
    this.approvals.push({ target, approval });
  }
  async sendWorkflowNotification(
    target: OutboundTarget,
    prompt: WorkflowNotificationPrompt,
  ): Promise<void> {
    this.workflowNotifications.push({ target, prompt });
  }
}

class FakeBridge {
  handlers?: {
    onDelivery(input: {
      subject: ImSubjectClaims;
      delivery: ImDelivery;
    }): Promise<void>;
  };
  dispatches: Array<{ subject: ImSubjectClaims; text: string }> = [];
  approvals: Array<{ subject: ImSubjectClaims; approvalId: string }> = [];

  async start(handlers: NonNullable<FakeBridge["handlers"]>): Promise<void> {
    this.handlers = handlers;
  }
  async stop(): Promise<void> {}
  async dispatchMessage(input: { subject: ImSubjectClaims; text: string }) {
    this.dispatches.push(input);
    return {
      sessionId: "session_im",
      runId: "run_im",
      status: this.dispatches.length === 1 ? "started" : "injected",
    };
  }
  async resolveApproval(input: {
    subject: ImSubjectClaims;
    approvalId: string;
  }): Promise<void> {
    this.approvals.push(input);
  }

  async deliver(subject: ImSubjectClaims, event: HostEvent): Promise<void> {
    await this.handlers!.onDelivery({
      subject,
      delivery: {
        deliveryKey: `delivery_${event.id}`,
        sessionId: "session_im",
        event,
      },
    });
  }
}

describe("ImGateway", () => {
  it("persists transport dedupe and delivery attempt facts only", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sparkwright-im-gateway-"));
    try {
      const path = join(tmp, "state.json");
      const store = new GatewayStore(path);
      await store.markProcessedMessage("telegram:1:m1");
      await store.recordDeliveryAttempt("delivery_1", "failed", "offline");
      const reloaded = new GatewayStore(path);
      expect(await reloaded.hasProcessedMessage("telegram:1:m1")).toBe(true);
      expect(await reloaded.deliveryAttempts("delivery_1")).toMatchObject([
        { status: "failed", error: "offline" },
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("submits every non-duplicate message to the Host control plane", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sparkwright-im-gateway-"));
    try {
      const adapter = new FakeAdapter();
      const bridge = new FakeBridge();
      const gateway = new ImGateway({
        adapters: [adapter],
        bridge,
        store: new GatewayStore(join(tmp, "state.json")),
      });
      await gateway.start();

      await adapter.handlers!.onMessage({
        platform: "telegram",
        chatId: "1",
        text: "first",
        messageId: "m1",
        userId: "user_1",
      });
      await adapter.handlers!.onMessage({
        platform: "telegram",
        chatId: "1",
        text: "second",
        messageId: "m2",
        userId: "user_1",
      });
      await adapter.handlers!.onMessage({
        platform: "telegram",
        chatId: "1",
        text: "second duplicate",
        messageId: "m2",
        userId: "user_1",
      });

      expect(bridge.dispatches.map((dispatch) => dispatch.text)).toEqual([
        "first",
        "second",
      ]);
      expect(adapter.sent.at(-1)?.message.text).toContain("active run");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps delivery failure independent and records a replayable attempt", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sparkwright-im-gateway-"));
    try {
      const adapter = new FakeAdapter();
      const bridge = new FakeBridge();
      const store = new GatewayStore(join(tmp, "state.json"));
      const gateway = new ImGateway({ adapters: [adapter], bridge, store });
      await gateway.start();
      const subject = {
        platform: "telegram",
        chatId: "1",
        userId: "user_1",
      };
      const event: HostEvent = {
        envelope: "event",
        id: "delivery_retry",
        kind: "run.completed",
        timestamp: new Date().toISOString(),
        payload: {
          runId: "run_delivery_retry",
          state: "completed",
          message: "hello",
        },
      };
      adapter.failNextMessage = true;
      await expect(bridge.deliver(subject, event)).rejects.toThrow(
        "transport offline",
      );
      await bridge.deliver(subject, event);
      expect(
        await store.deliveryAttempts("delivery_delivery_retry"),
      ).toMatchObject([{ status: "failed" }, { status: "delivered" }]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("routes approval through exact Host-bound platform claims", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sparkwright-im-gateway-"));
    try {
      const adapter = new FakeAdapter();
      const bridge = new FakeBridge();
      const gateway = new ImGateway({
        adapters: [adapter],
        bridge,
        store: new GatewayStore(join(tmp, "state.json")),
      });
      await gateway.start();

      await adapter.handlers!.onMessage({
        platform: "telegram",
        chatId: "1",
        text: "needs approval",
        messageId: "m1",
        userId: "user_1",
      });
      const subject = {
        platform: "telegram",
        chatId: "1",
        userId: "user_1",
      };
      await bridge.deliver(subject, {
        envelope: "event",
        id: "a1",
        kind: "approval.requested",
        timestamp: new Date().toISOString(),
        payload: {
          runId: "run_1",
          approvalId: "approval_1",
          action: "write",
          summary: "Write README",
        },
      });

      expect(adapter.approvals).toHaveLength(1);
      await adapter.handlers!.onApprovalDecision({
        approvalId: "approval_1",
        decision: "approved",
        ...subject,
      });
      expect(bridge.approvals).toEqual([
        { subject, approvalId: "approval_1", decision: "approved" },
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("delivers durable workflow notifications through an IM binding", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sparkwright-im-workflow-"));
    try {
      const workflowRunId = "workflow_im_delivery" as WorkflowRunId;
      const adapter = new FakeAdapter();
      const gateway = new ImGateway({
        adapters: [adapter],
        bridge: new FakeBridge(),
        store: new GatewayStore(join(tmp, "gateway.json")),
      });
      await gateway.start();
      const channels = new FileWorkflowChannelStore({ rootDir: tmp });
      const bound = await channels.bind({
        bindingId: "workflow_binding_im_delivery",
        workspaceId: "/workspace",
        workflowRunId,
        source: {
          kind: "im",
          principalId: "user:1",
          authenticatedBy: "telegram:webhook",
          channelId: createImWorkflowChannelId({
            platform: "telegram",
            chatId: "1",
          }),
        },
        allowedCommandKinds: ["provide_input"],
        createdAt: "2026-07-11T00:00:00.000Z",
        expiresAt: "2026-07-11T01:00:00.000Z",
      });
      const outbox = new FileWorkflowNotificationOutbox({ rootDir: tmp });
      outbox.asActorSink().deliver({
        source: { kind: "workflow", id: workflowRunId },
        type: "waiting",
        correlationId: "wait-1",
        payload: {
          workflowId: workflowRunId,
          name: "demo",
          summary: "Workflow is waiting.",
          wait: { id: "wait-1", kind: "input", reason: "Choose." },
          metadata: { generation: 3, status: "waiting" },
        },
      });
      const notification = (await outbox.asActorInbox().peek())[0]!;
      await gateway.deliverWorkflowNotification({
        binding: bound,
        notification,
        deliveryKey: `${bound.bindingId}:${notification.id}`,
      });
      expect(adapter.workflowNotifications.at(-1)).toMatchObject({
        target: { platform: "telegram", chatId: "1" },
        prompt: {
          deliveryKey: `${bound.bindingId}:${notification.id}`,
          summary: expect.stringContaining("Workflow is waiting"),
          expected: {
            generation: 3,
            status: "waiting",
            waitId: "wait-1",
          },
        },
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("maps authenticated IM responses into scoped durable workflow commands", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sparkwright-im-workflow-"));
    try {
      const workflowRunId = "workflow_im_response" as WorkflowRunId;
      const adapter = new FakeAdapter();
      const channels = new FileWorkflowChannelStore({ rootDir: tmp });
      const controls = new FileWorkflowControlInbox({ rootDir: tmp });
      const bound = await channels.bind({
        bindingId: "workflow_binding_im_response",
        workspaceId: "/workspace",
        workflowRunId,
        sessionId: "session_workflow_im",
        source: {
          kind: "im",
          principalId: "user:1",
          authenticatedBy: "telegram:webhook",
          channelId: createImWorkflowChannelId({
            platform: "telegram",
            chatId: "1",
          }),
        },
        allowedCommandKinds: ["provide_input"],
        createdAt: "2026-07-11T00:00:00.000Z",
        expiresAt: "2027-07-11T01:00:00.000Z",
      });
      const gateway = new ImGateway({
        adapters: [adapter],
        bridge: new FakeBridge(),
        store: new GatewayStore(join(tmp, "gateway.json")),
        workflowChannels: channels,
        workflowControls: controls,
        workspaceId: "/workspace",
      });
      await gateway.start();
      const response = {
        bindingId: bound.bindingId,
        workflowRunId,
        workspaceId: "/workspace",
        sessionId: "session_workflow_im",
        platform: "telegram",
        chatId: "1",
        userId: "user:1",
        authenticatedBy: "telegram:webhook",
        messageId: "message-1",
        expected: {
          generation: 2,
          status: "waiting" as const,
          waitId: "wait-1",
        },
        command: {
          kind: "provide_input" as const,
          waitId: "wait-1",
          value: "yes",
        },
        expiresAt: "2027-07-11T00:30:00.000Z",
      };
      await adapter.handlers!.onWorkflowResponse(response);
      await adapter.handlers!.onWorkflowResponse(response);
      expect(controls.pending(workflowRunId)).toHaveLength(1);
      await expect(
        adapter.handlers!.onWorkflowResponse({
          ...response,
          messageId: "message-2",
          command: { kind: "cancel" },
        }),
      ).rejects.toThrow("command kind is not authorized");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
