import type { HostEvent } from "@sparkwright/sdk-node";

export interface InboundMessage {
  platform: string;
  chatId: string;
  text: string;
  messageId?: string;
  threadId?: string;
  userId?: string;
  userName?: string;
  chatType?: "dm" | "group" | "channel" | "thread";
  metadata?: Record<string, unknown>;
}

export interface OutboundTarget {
  platform: string;
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  text: string;
  /** @reserved Public adapter hint consumed by rich-text capable platforms. */
  parseMode?: "plain" | "markdown";
  replyToMessageId?: string;
}

export interface ApprovalPrompt {
  approvalId: string;
  runId: string;
  summary: string;
  action: string;
  details?: Record<string, unknown>;
}

export interface PlatformHandlers {
  onMessage(message: InboundMessage): Promise<void>;
  onApprovalDecision(input: {
    approvalId: string;
    decision: "approved" | "denied";
    message?: string;
  }): Promise<void>;
}

export interface PlatformAdapter {
  readonly platform: string;
  start(handlers: PlatformHandlers): Promise<void>;
  stop(): Promise<void>;
  sendMessage(target: OutboundTarget, message: OutboundMessage): Promise<void>;
  sendApproval(target: OutboundTarget, approval: ApprovalPrompt): Promise<void>;
  /** @reserved Public adapter capability map consumed by gateway UIs. */
  supports?: {
    buttons?: boolean;
    threads?: boolean;
    edits?: boolean;
    reactions?: boolean;
  };
}

export interface GatewayRunTerminalEvent {
  kind: "completed" | "failed";
  runId: string;
  event: HostEvent;
}

export interface GatewayLogger {
  /** @reserved Public logger method consumed by gateway diagnostics. */
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
