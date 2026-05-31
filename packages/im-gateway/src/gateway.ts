import type { HostEvent } from "@sparkwright/sdk-node";
import {
  buildSessionKey,
  type SessionRoutingOptions,
} from "./session-router.js";
import type {
  ActiveBridgeRun,
  SparkwrightBridge,
} from "./sparkwright-bridge.js";
import type {
  ApprovalPrompt,
  GatewayLogger,
  InboundMessage,
  OutboundTarget,
  PlatformAdapter,
} from "./types.js";
import { renderApprovalPrompt, renderHostEvent } from "./renderers.js";
import { GatewayStore } from "./store.js";

export interface ImGatewayOptions {
  adapters: PlatformAdapter[];
  bridge: Pick<SparkwrightBridge, "startRun">;
  store: GatewayStore;
  sessionRouting?: SessionRoutingOptions;
  /** Model reference "provider/model" passed to the host on run.start. */
  model?: string;
  logger?: GatewayLogger;
}

interface ActiveSession {
  run: ActiveBridgeRun;
  target: OutboundTarget;
}

const defaultLogger: GatewayLogger = console;

export class ImGateway {
  private readonly adapters = new Map<string, PlatformAdapter>();
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly activeRuns = new Map<string, ActiveBridgeRun>();
  private readonly queuedMessages = new Map<string, InboundMessage[]>();
  private readonly responseBuffers = new Map<string, string[]>();
  private readonly logger: GatewayLogger;

  constructor(private readonly options: ImGatewayOptions) {
    for (const adapter of options.adapters) {
      this.adapters.set(adapter.platform, adapter);
    }
    this.logger = options.logger ?? defaultLogger;
  }

  async start(): Promise<void> {
    await this.options.store.load();
    await Promise.all(
      [...this.adapters.values()].map((adapter) =>
        adapter.start({
          onMessage: (message) => this.handleMessage(message),
          onApprovalDecision: (input) => this.handleApprovalDecision(input),
        }),
      ),
    );
    this.logger.info(
      "IM gateway started with %d adapter(s)",
      this.adapters.size,
    );
  }

  async stop(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((a) => a.stop()));
    for (const active of this.activeRuns.values()) active.close();
    this.activeRuns.clear();
    this.activeSessions.clear();
  }

  async handleMessage(message: InboundMessage): Promise<void> {
    if (!message.text.trim()) return;
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

    const sessionKey = buildSessionKey(message, this.options.sessionRouting);
    const active = this.activeSessions.get(sessionKey);
    if (active) {
      try {
        await active.run.injectMessage({
          content: message.text,
          metadata: {
            imGateway: true,
            platform: message.platform,
            chatId: message.chatId,
            threadId: message.threadId,
            userId: message.userId,
            userName: message.userName,
            messageId: message.messageId,
            sessionKey,
          },
        });
        await this.sendTo(message.platform, this.targetFromMessage(message), {
          text: "Added to the active run.",
          replyToMessageId: message.messageId,
        });
      } catch (err) {
        this.logger.warn(
          "run.inject_message failed, queueing: %s",
          errorMessage(err),
        );
        this.enqueue(sessionKey, message);
        await this.sendTo(message.platform, this.targetFromMessage(message), {
          text: "Run is still active. I queued this for the next turn.",
          replyToMessageId: message.messageId,
        });
      }
      return;
    }

    await this.startMessageRun(sessionKey, message);
  }

  async handleApprovalDecision(input: {
    approvalId: string;
    decision: "approved" | "denied";
    message?: string;
  }): Promise<void> {
    const runId = await this.options.store.runForApproval(input.approvalId);
    if (!runId) {
      this.logger.warn(
        "approval decision for unknown approval %s",
        input.approvalId,
      );
      return;
    }
    const run = this.activeRuns.get(runId);
    if (!run) {
      this.logger.warn("approval decision for inactive run %s", runId);
      return;
    }
    await run.resolveApproval(input);
  }

  private async startMessageRun(
    sessionKey: string,
    message: InboundMessage,
  ): Promise<void> {
    const sessionId = await this.options.store.getOrCreateSessionId(sessionKey);
    const target = this.targetFromMessage(message);
    const run = await this.options.bridge.startRun(
      {
        goal: message.text,
        sessionId,
        model: this.options.model,
        metadata: {
          imGateway: true,
          platform: message.platform,
          chatId: message.chatId,
          threadId: message.threadId,
          userId: message.userId,
          userName: message.userName,
          sessionKey,
        },
      },
      {
        onEvent: (event) => this.handleRunEvent(event),
        onTerminal: (event) => this.handleTerminalEvent(sessionKey, event),
      },
    );

    this.activeSessions.set(sessionKey, { run, target });
    this.activeRuns.set(run.runId, run);
    await this.options.store.rememberRun(run.runId, sessionKey, target);
  }

  private async handleRunEvent(event: HostEvent): Promise<void> {
    if (event.kind === "approval.requested") {
      const target = await this.options.store.targetForRun(event.payload.runId);
      if (!target) return;
      await this.options.store.rememberApproval(
        event.payload.approvalId,
        event.payload.runId,
      );
      const prompt: ApprovalPrompt = {
        approvalId: event.payload.approvalId,
        runId: event.payload.runId,
        action: event.payload.action,
        summary: event.payload.summary,
        details: event.payload.details,
      };
      await this.sendApproval(target, prompt);
      return;
    }

    if (event.kind === "run.event") {
      const chunk = renderHostEvent(event);
      if (chunk) {
        const list = this.responseBuffers.get(event.payload.runId) ?? [];
        list.push(chunk);
        this.responseBuffers.set(event.payload.runId, list);
      }
    }
  }

  private async handleTerminalEvent(
    sessionKey: string,
    event: HostEvent,
  ): Promise<void> {
    const runId =
      event.kind === "run.completed" || event.kind === "run.failed"
        ? event.payload.runId
        : undefined;
    if (!runId) return;
    const active = this.activeSessions.get(sessionKey);
    const target = await this.options.store.targetForRun(runId);
    const buffer = this.responseBuffers.get(runId) ?? [];
    this.responseBuffers.delete(runId);
    this.activeRuns.delete(runId);
    this.activeSessions.delete(sessionKey);
    active?.run.close();

    const terminalText = renderHostEvent(event);
    const text = [...buffer, terminalText].filter(Boolean).join("\n").trim();
    if (target && text) {
      await this.sendTo(target.platform, target, {
        text: truncate(text, 3900),
      });
    }

    const next = this.dequeue(sessionKey);
    if (next) await this.startMessageRun(sessionKey, next);
  }

  private async sendApproval(
    target: OutboundTarget,
    prompt: ApprovalPrompt,
  ): Promise<void> {
    const adapter = this.adapters.get(target.platform);
    if (!adapter) return;
    await adapter.sendApproval(target, prompt).catch(async (err: unknown) => {
      this.logger.warn("approval button send failed: %s", errorMessage(err));
      await adapter.sendMessage(target, { text: renderApprovalPrompt(prompt) });
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

  private enqueue(sessionKey: string, message: InboundMessage): void {
    const queue = this.queuedMessages.get(sessionKey) ?? [];
    queue.push(message);
    this.queuedMessages.set(sessionKey, queue);
  }

  private dequeue(sessionKey: string): InboundMessage | undefined {
    const queue = this.queuedMessages.get(sessionKey);
    if (!queue?.length) return undefined;
    const next = queue.shift();
    if (queue.length === 0) this.queuedMessages.delete(sessionKey);
    return next;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n[truncated]`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
