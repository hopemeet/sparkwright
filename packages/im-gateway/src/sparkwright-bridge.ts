import {
  createClient,
  type HostEvent,
  type ImDelivery,
  type ImSubjectClaims,
} from "@sparkwright/sdk-node";

export interface SparkwrightBridgeOptions {
  hostUrl?: string;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ImBridgeHandlers {
  onDelivery(input: {
    subject: ImSubjectClaims;
    delivery: ImDelivery;
  }): Promise<void>;
}

export interface ImControlBridge {
  start(handlers: ImBridgeHandlers): Promise<void>;
  stop(): Promise<void>;
  dispatchMessage(input: {
    subject: ImSubjectClaims;
    text: string;
    messageId?: string;
    model?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ sessionId: string; runId: string; status: string }>;
  resolveApproval(input: {
    subject: ImSubjectClaims;
    approvalId: string;
    decision: "approved" | "denied";
    message?: string;
  }): Promise<void>;
}

interface Attachment {
  subject: ImSubjectClaims;
  bindingId: string;
  client: Awaited<ReturnType<typeof createClient>>;
}

export class SparkwrightBridge implements ImControlBridge {
  private readonly attachments = new Map<string, Attachment>();
  private handlers?: ImBridgeHandlers;
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;

  constructor(private readonly options: SparkwrightBridgeOptions = {}) {}

  async start(handlers: ImBridgeHandlers): Promise<void> {
    this.handlers = handlers;
    this.pollTimer = setInterval(() => {
      void this.pollAll().catch(() => undefined);
    }, this.options.pollIntervalMs ?? 250);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const attachment of this.attachments.values()) {
      attachment.client.close();
    }
    this.attachments.clear();
  }

  async dispatchMessage(input: {
    subject: ImSubjectClaims;
    text: string;
    messageId?: string;
    model?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ sessionId: string; runId: string; status: string }> {
    let attachment = await this.attachment(input.subject);
    let result;
    try {
      result = await this.dispatchThroughAttachment(attachment, input);
    } catch {
      attachment = await this.reconnectAttachment(attachment);
      result = await this.dispatchThroughAttachment(attachment, input);
    }
    await this.pollAttachment(attachment);
    return result;
  }

  async resolveApproval(input: {
    subject: ImSubjectClaims;
    approvalId: string;
    decision: "approved" | "denied";
    message?: string;
  }): Promise<void> {
    let attachment = await this.attachment(input.subject);
    try {
      await this.resolveThroughAttachment(attachment, input);
    } catch {
      attachment = await this.reconnectAttachment(attachment);
      await this.resolveThroughAttachment(attachment, input);
    }
  }

  private async attachment(subject: ImSubjectClaims): Promise<Attachment> {
    const key = subjectKey(subject);
    const existing = this.attachments.get(key);
    if (existing) return existing;
    return this.createAttachment(subject);
  }

  private async createAttachment(
    subject: ImSubjectClaims,
  ): Promise<Attachment> {
    const key = subjectKey(subject);
    const client = await createClient({
      url: this.options.hostUrl,
      requestTimeoutMs: this.options.requestTimeoutMs,
      client: { name: "sparkwright-im-gateway", version: "0.1.0" },
      capabilities: ["im-gateway", "im.control"],
    });
    const bound = await client.bindImSession({
      subject,
      permissions: [
        "message",
        "inspect",
        "approve",
        "cancel_execution",
        "cancel_lane",
      ],
    });
    const attachment = {
      subject: { ...subject },
      bindingId: bound.bindingId,
      client,
    };
    this.attachments.set(key, attachment);
    await client.subscribeImSession({
      bindingId: attachment.bindingId,
      subject,
    });
    return attachment;
  }

  private async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.all(
        [...this.attachments.values()].map(async (attachment) => {
          try {
            await this.pollAttachment(attachment);
          } catch {
            const reconnected = await this.reconnectAttachment(attachment);
            await this.pollAttachment(reconnected);
          }
        }),
      );
    } finally {
      this.polling = false;
    }
  }

  private async pollAttachment(attachment: Attachment): Promise<void> {
    const subscribed = await attachment.client.subscribeImSession({
      bindingId: attachment.bindingId,
      subject: attachment.subject,
      limit: 100,
    });
    const acknowledged: string[] = [];
    for (const delivery of subscribed.deliveries) {
      await this.handlers?.onDelivery({
        subject: attachment.subject,
        delivery,
      });
      acknowledged.push(delivery.deliveryKey);
    }
    if (acknowledged.length > 0) {
      await attachment.client.acknowledgeImDeliveries({
        bindingId: attachment.bindingId,
        subject: attachment.subject,
        deliveryKeys: acknowledged,
      });
    }
  }

  private async reconnectAttachment(
    attachment: Attachment,
  ): Promise<Attachment> {
    const key = subjectKey(attachment.subject);
    const current = this.attachments.get(key);
    if (current && current !== attachment) return current;
    this.attachments.delete(key);
    attachment.client.close();
    return this.createAttachment(attachment.subject);
  }

  private dispatchThroughAttachment(
    attachment: Attachment,
    input: {
      subject: ImSubjectClaims;
      text: string;
      messageId?: string;
      model?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    return attachment.client.dispatchImMessage({
      bindingId: attachment.bindingId,
      subject: input.subject,
      text: input.text,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }

  private resolveThroughAttachment(
    attachment: Attachment,
    input: {
      subject: ImSubjectClaims;
      approvalId: string;
      decision: "approved" | "denied";
      message?: string;
    },
  ) {
    return attachment.client.resolveImApproval({
      bindingId: attachment.bindingId,
      subject: input.subject,
      approvalId: input.approvalId,
      decision: input.decision,
      ...(input.message ? { message: input.message } : {}),
    });
  }
}

function subjectKey(subject: ImSubjectClaims): string {
  return [
    subject.platform,
    subject.chatId,
    subject.threadId ?? "",
    subject.userId,
  ].join("\0");
}

export type { HostEvent };
