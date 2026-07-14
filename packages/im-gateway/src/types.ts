import type { HostEvent } from "@sparkwright/sdk-node";
import type {
  WorkflowControlCommand,
  WorkflowRunStatus,
} from "@sparkwright/agent-runtime";

export interface InboundMessage {
  platform: string;
  chatId: string;
  text: string;
  messageId?: string;
  threadId?: string;
  userId?: string;
  userName?: string;
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
  /** @reserved Stable workflow delivery key consumed by idempotent channel adapters. */
  deliveryKey?: string;
  /** @reserved Public adapter hint consumed by rich-text capable platforms. */
  parseMode?: "plain" | "markdown";
  replyToMessageId?: string;
}

export interface ApprovalPrompt {
  approvalId: string;
  runId: string;
  deliveryKey?: string;
  summary: string;
  action: string;
  details?: Record<string, unknown>;
}

export interface WorkflowNotificationPrompt {
  bindingId: string;
  workflowRunId: string;
  workspaceId: string;
  sessionId?: string;
  deliveryKey: string;
  summary: string;
  expected: {
    generation: number;
    status: WorkflowRunStatus;
    waitId?: string;
  };
  wait?: {
    kind: "input" | "task" | "approval";
    id?: string;
    approvalId?: string;
    reason?: string;
  };
  expiresAt: string;
}

export interface PlatformHandlers {
  onMessage(message: InboundMessage): Promise<void>;
  onApprovalDecision(input: {
    approvalId: string;
    decision: "approved" | "denied";
    message?: string;
    platform: string;
    chatId: string;
    threadId?: string;
    userId: string;
  }): Promise<void>;
  onWorkflowResponse(input: WorkflowChannelResponse): Promise<void>;
}

export interface WorkflowChannelResponse {
  bindingId: string;
  workflowRunId: string;
  workspaceId: string;
  sessionId?: string;
  platform: string;
  chatId: string;
  threadId?: string;
  userId: string;
  authenticatedBy: string;
  messageId: string;
  expected: {
    generation: number;
    status?: WorkflowRunStatus;
    waitId?: string;
  };
  command: WorkflowControlCommand;
  expiresAt: string;
}

export interface PlatformAdapter {
  readonly platform: string;
  start(handlers: PlatformHandlers): Promise<void>;
  stop(): Promise<void>;
  sendMessage(target: OutboundTarget, message: OutboundMessage): Promise<void>;
  sendApproval(target: OutboundTarget, approval: ApprovalPrompt): Promise<void>;
  sendWorkflowNotification?(
    target: OutboundTarget,
    prompt: WorkflowNotificationPrompt,
  ): Promise<void>;
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
