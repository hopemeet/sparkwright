import type { HostMessage } from "@sparkwright/protocol";

/**
 * Transport-agnostic bidirectional channel.
 *
 * One Connection = one client. Stdio transport produces exactly one
 * Connection over the process's stdin/stdout. WebSocket transport produces
 * one Connection per accepted socket.
 */
export interface Connection {
  /** Unique within the host process. Used in logs only. */
  readonly id: string;
  /** Send one message to the client. Best-effort; may throw on closed sockets. */
  send(message: HostMessage): void;
  /** Register a handler for inbound messages. Replaces any prior handler. */
  onMessage(handler: (message: HostMessage) => void): void;
  /** Register a handler for the close event. */
  onClose(handler: (reason?: string) => void): void;
  /** Close the connection from the host side. */
  close(reason?: string): void;
}

let counter = 0;
export function nextConnectionId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

let messageCounter = 0;
export function nextMessageId(prefix: string): string {
  messageCounter += 1;
  return `${prefix}_${messageCounter}_${Date.now().toString(36)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
