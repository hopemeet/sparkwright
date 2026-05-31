import type { InboundMessage } from "./types.js";

export interface SessionRoutingOptions {
  groupSessionsPerUser?: boolean;
  threadSessionsPerUser?: boolean;
}

export function buildSessionKey(
  message: InboundMessage,
  options: SessionRoutingOptions = {},
): string {
  const groupSessionsPerUser = options.groupSessionsPerUser ?? false;
  const threadSessionsPerUser = options.threadSessionsPerUser ?? false;
  const chatType = message.chatType ?? "dm";
  const parts = [message.platform, chatType, message.chatId];
  if (message.threadId) parts.push(message.threadId);

  const isDm = chatType === "dm";
  const isThread = Boolean(message.threadId);
  const isolateUser =
    !isDm && (!isThread ? groupSessionsPerUser : threadSessionsPerUser);
  if (isolateUser && message.userId) parts.push(message.userId);
  return parts.map(escapePart).join(":");
}

function escapePart(value: string): string {
  return encodeURIComponent(value);
}
