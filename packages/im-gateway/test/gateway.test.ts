import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { HostEvent } from "@sparkwright/sdk-node";
import { ImGateway } from "../src/gateway.js";
import { GatewayStore } from "../src/store.js";
import type {
  ApprovalPrompt,
  OutboundMessage,
  OutboundTarget,
  PlatformAdapter,
  PlatformHandlers,
} from "../src/types.js";

class FakeAdapter implements PlatformAdapter {
  readonly platform = "telegram";
  sent: Array<{ target: OutboundTarget; message: OutboundMessage }> = [];
  approvals: Array<{ target: OutboundTarget; approval: ApprovalPrompt }> = [];
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
});
