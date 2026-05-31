import { randomUUID } from "node:crypto";
import type {
  ApprovalPrompt,
  InboundMessage,
  OutboundMessage,
  OutboundTarget,
  PlatformAdapter,
  PlatformHandlers,
} from "../types.js";
import { renderApprovalPrompt } from "../renderers.js";

export interface TelegramAdapterOptions {
  token: string;
  allowedChatIds?: string[];
  allowedUserIds?: string[];
  pollingTimeoutSeconds?: number;
  fetch?: typeof fetch;
}

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  chat: TelegramChat;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = "telegram";
  readonly supports = { buttons: true, threads: true };

  private handlers?: PlatformHandlers;
  private stopped = true;
  private offset = 0;
  private loop?: Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly approvalTokens = new Map<string, string>();

  constructor(private readonly options: TelegramAdapterOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async start(handlers: PlatformHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop?.catch(() => undefined);
  }

  async sendMessage(
    target: OutboundTarget,
    message: OutboundMessage,
  ): Promise<void> {
    for (const chunk of splitTelegramText(message.text)) {
      await this.api("sendMessage", {
        chat_id: target.chatId,
        text: chunk,
        message_thread_id: target.threadId,
        reply_to_message_id:
          message.replyToMessageId ?? target.replyToMessageId,
        disable_web_page_preview: true,
      });
    }
  }

  async sendApproval(
    target: OutboundTarget,
    approval: ApprovalPrompt,
  ): Promise<void> {
    const token = randomUUID().slice(0, 12);
    this.approvalTokens.set(token, approval.approvalId);
    await this.api("sendMessage", {
      chat_id: target.chatId,
      text: renderApprovalPrompt(approval),
      message_thread_id: target.threadId,
      reply_to_message_id: target.replyToMessageId,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Approve",
              callback_data: `sw:${token}:approved`,
            },
            {
              text: "Deny",
              callback_data: `sw:${token}:denied`,
            },
          ],
        ],
      },
      disable_web_page_preview: true,
    });
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.api<TelegramUpdate[]>("getUpdates", {
          offset: this.offset || undefined,
          timeout: this.options.pollingTimeoutSeconds ?? 30,
          allowed_updates: ["message", "edited_message", "callback_query"],
        });
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.stopped) {
          console.warn(
            "[sparkwright-im-gateway] telegram polling failed:",
            err,
          );
          await sleep(1500);
        }
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const msg = update.message ?? update.edited_message;
    if (!msg) return;
    const inbound = this.toInbound(msg);
    if (!inbound || !this.isAllowed(inbound)) return;
    await this.handlers?.onMessage(inbound);
  }

  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    if (!query.data?.startsWith("sw:")) return;
    const [, token, decision] = query.data.split(":");
    if (decision !== "approved" && decision !== "denied") return;
    const approvalId = this.approvalTokens.get(token);
    if (!approvalId) {
      await this.api("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Approval expired or already handled.",
      });
      return;
    }
    const inbound = query.message ? this.toInbound(query.message) : undefined;
    if (
      inbound &&
      !this.isAllowed({ ...inbound, userId: String(query.from.id) })
    ) {
      await this.api("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Not allowed.",
        show_alert: true,
      });
      return;
    }
    this.approvalTokens.delete(token);
    await this.handlers?.onApprovalDecision({ approvalId, decision });
    await this.api("answerCallbackQuery", {
      callback_query_id: query.id,
      text: decision === "approved" ? "Approved" : "Denied",
    });
  }

  private toInbound(msg: TelegramMessage): InboundMessage | undefined {
    const text = msg.text ?? msg.caption;
    if (!text?.trim()) return undefined;
    const chatId = String(msg.chat.id);
    const userId = msg.from ? String(msg.from.id) : undefined;
    return {
      platform: this.platform,
      chatId,
      threadId: msg.message_thread_id
        ? String(msg.message_thread_id)
        : undefined,
      userId,
      userName: displayName(msg.from),
      chatType: msg.chat.type === "private" ? "dm" : "group",
      messageId: String(msg.message_id),
      text,
      metadata: {
        telegramChatType: msg.chat.type,
      },
    };
  }

  private isAllowed(message: InboundMessage): boolean {
    const allowedChats = this.options.allowedChatIds ?? [];
    const allowedUsers = this.options.allowedUserIds ?? [];
    if (allowedChats.length === 0 && allowedUsers.length === 0) return true;
    if (allowedChats.includes(message.chatId)) return true;
    if (message.userId && allowedUsers.includes(message.userId)) return true;
    return false;
  }

  private async api<T = unknown>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.options.token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stripUndefined(body)),
      },
    );
    const parsed = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !parsed.ok) {
      throw new Error(parsed.description ?? `Telegram ${method} failed`);
    }
    return parsed.result as T;
  }
}

function displayName(user: TelegramUser | undefined): string | undefined {
  if (!user) return undefined;
  if (user.username) return `@${user.username}`;
  return (
    [user.first_name, user.last_name].filter(Boolean).join(" ") || undefined
  );
}

function stripUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function splitTelegramText(text: string): string[] {
  const max = 3900;
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
