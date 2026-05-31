import type { HostMessage } from "@sparkwright/protocol";

/**
 * Client-side transport. Mirrors the host's Connection interface from the
 * client's perspective. Implemented by sdk-node (spawn/ws) and sdk-browser
 * (browser WebSocket).
 */
export interface ClientTransport {
  send(message: HostMessage): void;
  onMessage(handler: (message: HostMessage) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(): void;
}
