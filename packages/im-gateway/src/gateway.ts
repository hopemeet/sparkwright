import type { ImDelivery, ImSubjectClaims } from "@sparkwright/sdk-node";
import type {
  AnyActorNotification,
  FileWorkflowChannelStore,
  FileWorkflowControlInbox,
  FileWorkflowNotificationOutbox,
  WorkflowChannelBinding,
  WorkflowRunId,
} from "@sparkwright/agent-runtime";
import { WorkflowChannelCoordinator } from "@sparkwright/server-runtime";
import type { ImControlBridge } from "./sparkwright-bridge.js";
import type {
  ApprovalPrompt,
  GatewayLogger,
  InboundMessage,
  OutboundTarget,
  PlatformAdapter,
  WorkflowChannelResponse,
  WorkflowNotificationPrompt,
} from "./types.js";
import { renderApprovalPrompt, renderHostEvent } from "./renderers.js";
import { GatewayStore } from "./store.js";

export interface ImGatewayOptions {
  adapters: PlatformAdapter[];
  bridge: ImControlBridge;
  store: GatewayStore;
  /** Model reference "provider/model" passed to Host IM dispatch. */
  model?: string;
  logger?: GatewayLogger;
  workflowChannels?: FileWorkflowChannelStore;
  workflowControls?: FileWorkflowControlInbox;
  workspaceId?: string;
  workflowNotifications?: FileWorkflowNotificationOutbox;
  workflowPollIntervalMs?: number;
}

const defaultLogger: GatewayLogger = console;

export class ImGateway {
  private readonly adapters = new Map<string, PlatformAdapter>();
  private readonly logger: GatewayLogger;
  private workflowCoordinator?: WorkflowChannelCoordinator;
  private workflowTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: ImGatewayOptions) {
    for (const adapter of options.adapters) {
      this.adapters.set(adapter.platform, adapter);
    }
    this.logger = options.logger ?? defaultLogger;
  }

  async start(): Promise<void> {
    await this.options.store.load();
    await this.options.bridge.start({
      onDelivery: (input) => this.handleDelivery(input),
    });
    await Promise.all(
      [...this.adapters.values()].map((adapter) =>
        adapter.start({
          onMessage: (message) => this.handleMessage(message),
          onApprovalDecision: (input) => this.handleApprovalDecision(input),
          onWorkflowResponse: (input) => this.handleWorkflowResponse(input),
        }),
      ),
    );
    this.logger.info(
      "IM gateway started with %d adapter(s)",
      this.adapters.size,
    );
    if (
      this.options.workflowChannels &&
      this.options.workflowNotifications &&
      this.options.workflowControls &&
      this.options.workspaceId
    ) {
      this.workflowCoordinator = new WorkflowChannelCoordinator({
        outbox: this.options.workflowNotifications,
        channels: this.options.workflowChannels,
        adapter: {
          deliver: (input) => this.deliverWorkflowNotification(input),
        },
      });
      await this.deliverPendingWorkflowNotifications();
      this.workflowTimer = setInterval(() => {
        void this.deliverPendingWorkflowNotifications().catch(
          (error: unknown) => {
            this.logger.warn(
              "durable workflow delivery failed: %s",
              errorMessage(error),
            );
          },
        );
      }, this.options.workflowPollIntervalMs ?? 1_000);
    }
  }

  async stop(): Promise<void> {
    if (this.workflowTimer) clearInterval(this.workflowTimer);
    this.workflowTimer = undefined;
    await Promise.all(
      [...this.adapters.values()].map((adapter) => adapter.stop()),
    );
    await this.options.bridge.stop();
  }

  async deliverPendingWorkflowNotifications(): Promise<void> {
    await this.workflowCoordinator?.runOnce();
  }

  async handleMessage(message: InboundMessage): Promise<void> {
    if (!message.text.trim() || !message.userId) return;
    const dedupeKey = message.messageId
      ? `${message.platform}:${message.chatId}:${message.threadId ?? ""}:${message.messageId}`
      : undefined;
    if (
      dedupeKey &&
      (await this.options.store.hasProcessedMessage(dedupeKey))
    ) {
      return;
    }
    if (dedupeKey) await this.options.store.markProcessedMessage(dedupeKey);
    const result = await this.options.bridge.dispatchMessage({
      subject: subjectFromMessage(message),
      text: message.text,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      metadata: {
        platform: message.platform,
        chatId: message.chatId,
        threadId: message.threadId,
        userId: message.userId,
        userName: message.userName,
      },
    });
    await this.sendTo(message.platform, this.targetFromMessage(message), {
      text:
        result.status === "injected"
          ? "Added to the active run."
          : "Accepted by the Host session lane.",
      replyToMessageId: message.messageId,
    });
  }

  async handleApprovalDecision(input: {
    approvalId: string;
    decision: "approved" | "denied";
    message?: string;
    platform: string;
    chatId: string;
    threadId?: string;
    userId: string;
  }): Promise<void> {
    await this.options.bridge.resolveApproval({
      subject: {
        platform: input.platform,
        chatId: input.chatId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        userId: input.userId,
      },
      approvalId: input.approvalId,
      decision: input.decision,
      ...(input.message ? { message: input.message } : {}),
    });
  }

  async handleWorkflowResponse(input: WorkflowChannelResponse): Promise<void> {
    const channels = this.options.workflowChannels;
    const controls = this.options.workflowControls;
    if (!channels || !controls || !this.options.workspaceId) {
      throw new Error("Durable workflow channel control is not configured.");
    }
    if (input.workspaceId !== this.options.workspaceId) {
      throw new Error(
        "Workflow channel workspace does not match this gateway.",
      );
    }
    const workflowRunId = input.workflowRunId as WorkflowRunId;
    const bound = channels.binding(workflowRunId, input.bindingId);
    if (!bound || bound.source.kind !== "im") {
      throw new Error("Durable IM workflow binding was not found.");
    }
    await channels.acceptControl({
      inbox: controls,
      bindingId: input.bindingId,
      workflowRunId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      source: imWorkflowSource(input),
      idempotencyKey: input.messageId,
      expected: input.expected,
      command: input.command,
      expiresAt: input.expiresAt,
    });
  }

  async deliverWorkflowNotification(input: {
    binding: WorkflowChannelBinding;
    notification: AnyActorNotification;
    deliveryKey: string;
  }): Promise<{ transportMessageId?: string }> {
    if (input.binding.source.kind !== "im") {
      throw new Error("IM gateway cannot deliver a non-IM workflow binding.");
    }
    const target = parseImWorkflowChannelId(input.binding.source.channelId);
    const adapter = this.adapters.get(target.platform);
    if (!adapter)
      throw new Error(`IM adapter is unavailable: ${target.platform}`);
    const prompt = workflowNotificationPrompt(input);
    if (adapter.sendWorkflowNotification) {
      await adapter.sendWorkflowNotification(target, prompt);
    } else {
      await adapter.sendMessage(target, {
        text: prompt.summary,
        deliveryKey: input.deliveryKey,
      });
    }
    return {};
  }

  private async handleDelivery(input: {
    subject: ImSubjectClaims;
    delivery: ImDelivery;
  }): Promise<void> {
    const target: OutboundTarget = {
      platform: input.subject.platform,
      chatId: input.subject.chatId,
      ...(input.subject.threadId ? { threadId: input.subject.threadId } : {}),
    };
    try {
      await this.deliverHostEvent(target, input.delivery);
      await this.options.store.recordDeliveryAttempt(
        input.delivery.deliveryKey,
        "delivered",
      );
    } catch (error) {
      await this.options.store.recordDeliveryAttempt(
        input.delivery.deliveryKey,
        "failed",
        errorMessage(error),
      );
      throw error;
    }
  }

  private async deliverHostEvent(
    target: OutboundTarget,
    delivery: ImDelivery,
  ): Promise<void> {
    const event = delivery.event;
    const adapter = this.adapters.get(target.platform);
    if (!adapter)
      throw new Error(`IM adapter is unavailable: ${target.platform}`);
    if (event.kind === "approval.requested") {
      const prompt: ApprovalPrompt = {
        approvalId: event.payload.approvalId,
        runId: event.payload.runId,
        deliveryKey: delivery.deliveryKey,
        action: event.payload.action,
        summary: event.payload.summary,
        details: event.payload.details,
      };
      await adapter
        .sendApproval(target, prompt)
        .catch(async (error: unknown) => {
          this.logger.warn(
            "approval button send failed: %s",
            errorMessage(error),
          );
          await adapter.sendMessage(target, {
            text: renderApprovalPrompt(prompt),
            deliveryKey: delivery.deliveryKey,
          });
        });
      return;
    }
    const text = renderHostEvent(event);
    if (!text) return;
    await adapter.sendMessage(target, {
      text: truncate(text, 3900),
      deliveryKey: delivery.deliveryKey,
    });
  }

  private async sendTo(
    platform: string,
    target: OutboundTarget,
    message: { text: string; replyToMessageId?: string },
  ): Promise<void> {
    const adapter = this.adapters.get(platform);
    if (!adapter) return;
    await adapter.sendMessage(target, message);
  }

  private targetFromMessage(message: InboundMessage): OutboundTarget {
    return {
      platform: message.platform,
      chatId: message.chatId,
      threadId: message.threadId,
      replyToMessageId: message.messageId,
      metadata: message.metadata,
    };
  }
}

export function createImWorkflowChannelId(input: {
  platform: string;
  chatId: string;
  threadId?: string;
}): string {
  return [input.platform, input.chatId, input.threadId ?? ""]
    .map((value) => encodeURIComponent(value))
    .join("|");
}

function subjectFromMessage(message: InboundMessage): ImSubjectClaims {
  return {
    platform: message.platform,
    chatId: message.chatId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    userId: message.userId!,
  };
}

function parseImWorkflowChannelId(channelId: string): OutboundTarget {
  const [platform, chatId, threadId] = channelId
    .split("|")
    .map((value) => decodeURIComponent(value));
  if (!platform || !chatId) throw new Error("Invalid durable IM channel id.");
  return { platform, chatId, ...(threadId ? { threadId } : {}) };
}

function imWorkflowSource(
  input: WorkflowChannelResponse,
): WorkflowChannelBinding["source"] {
  return {
    kind: "im",
    principalId: input.userId,
    authenticatedBy: input.authenticatedBy,
    channelId: createImWorkflowChannelId(input),
  };
}

function renderWorkflowNotification(
  notification: AnyActorNotification,
): string {
  if (notification.source.kind !== "workflow") {
    throw new Error("Expected a workflow notification.");
  }
  const payload = notification.payload as {
    workflowId?: string;
    name?: string;
    summary?: string;
    wait?: { kind?: string; reason?: string };
  };
  const title = payload.name ?? payload.workflowId ?? notification.source.id;
  const detail = payload.summary ?? `Workflow ${notification.type}.`;
  const wait = payload.wait
    ? `\nWaiting for ${payload.wait.kind ?? "input"}${payload.wait.reason ? `: ${payload.wait.reason}` : ""}`
    : "";
  return `[Workflow ${title}] ${detail}${wait}`;
}

function workflowNotificationPrompt(input: {
  binding: WorkflowChannelBinding;
  notification: AnyActorNotification;
  deliveryKey: string;
}): WorkflowNotificationPrompt {
  if (input.notification.source.kind !== "workflow") {
    throw new Error("Expected a workflow notification.");
  }
  const payload = input.notification.payload as {
    wait?: WorkflowNotificationPrompt["wait"];
    metadata?: {
      generation?: number;
      status?: WorkflowNotificationPrompt["expected"]["status"];
    };
  };
  return {
    bindingId: input.binding.bindingId,
    workflowRunId: input.binding.workflowRunId,
    workspaceId: input.binding.workspaceId,
    ...(input.binding.sessionId ? { sessionId: input.binding.sessionId } : {}),
    deliveryKey: input.deliveryKey,
    summary: renderWorkflowNotification(input.notification),
    expected: {
      generation: payload.metadata?.generation ?? 0,
      status: payload.metadata?.status ?? "waiting",
      ...(payload.wait?.id ? { waitId: payload.wait.id } : {}),
    },
    ...(payload.wait ? { wait: payload.wait } : {}),
    expiresAt: input.binding.expiresAt,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n[truncated]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
