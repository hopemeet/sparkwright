import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { HostEvent } from "@sparkwright/sdk-node";
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

  async start(handlers: PlatformHandlers): Promise<void> {
    this.handlers = handlers;
  }
  async stop(): Promise<void> {}
  async sendMessage(
    target: OutboundTarget,
    message: OutboundMessage,
  ): Promise<void> {
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
  starts: Array<{ goal: string; sessionId?: string }> = [];
  runs = new Map<
    string,
    {
      onEvent(event: HostEvent): Promise<void> | void;
      onTerminal(event: HostEvent): Promise<void> | void;
      approvals: string[];
      injected: string[];
      closed: boolean;
    }
  >();

  async startRun(
    payload: { goal: string; sessionId?: string },
    handlers: {
      onEvent(event: HostEvent): Promise<void> | void;
      onTerminal(event: HostEvent): Promise<void> | void;
    },
  ) {
    const runId = `run_${this.starts.length + 1}`;
    this.starts.push(payload);
    this.runs.set(runId, {
      ...handlers,
      approvals: [],
      injected: [],
      closed: false,
    });
    return {
      runId,
      injectMessage: async (input: { content: string }) => {
        this.runs.get(runId)?.injected.push(input.content);
      },
      resolveApproval: async (input: { approvalId: string }) => {
        this.runs.get(runId)?.approvals.push(input.approvalId);
      },
      cancel: async () => undefined,
      close: () => {
        const run = this.runs.get(runId);
        if (run) run.closed = true;
      },
    };
  }
}

describe("ImGateway", () => {
  it("persists a stable session id for the same gateway session key", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sparkwright-im-gateway-"));
    try {
      const path = join(tmp, "state.json");
      const first = new GatewayStore(path);
      const sessionA = await first.getOrCreateSessionId("telegram:dm:1");
      const second = new GatewayStore(path);
      const sessionB = await second.getOrCreateSessionId("telegram:dm:1");
      const sessionC = await second.getOrCreateSessionId("telegram:dm:2");

      expect(sessionA).toBe(sessionB);
      expect(sessionA).toMatch(/^im_/);
      expect(sessionC).not.toBe(sessionA);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("injects a second message into the active Telegram session", async () => {
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
        chatType: "dm",
        messageId: "m1",
      });
      await adapter.handlers!.onMessage({
        platform: "telegram",
        chatId: "1",
        text: "second",
        chatType: "dm",
        messageId: "m2",
      });

      expect(bridge.starts.map((start) => start.goal)).toEqual(["first"]);
      expect(bridge.runs.get("run_1")!.injected).toEqual(["second"]);
      expect(adapter.sent.at(-1)?.message.text).toContain("active run");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("routes approval decisions back to the active run", async () => {
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
        chatType: "dm",
        messageId: "m1",
      });
      await bridge.runs.get("run_1")!.onEvent({
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
      });
      expect(bridge.runs.get("run_1")!.approvals).toEqual(["approval_1"]);
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
