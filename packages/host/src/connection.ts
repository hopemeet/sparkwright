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

export type HostConnectionPrincipalKind = "host_client" | "gateway";
export type HostConnectionAuthority =
  | "provider_catalog.read"
  | "provider_connection.manage"
  | "provider_secret.submit"
  | "provider_auth.manage"
  | "project_trust.manage";
export type HostConnectionTransport = "local" | "remote" | "embedded";

export type HostConnectionAuthContext =
  | {
      state: "authenticated";
      principalId: string;
      principalKind: HostConnectionPrincipalKind;
      authenticatedBy: string;
      transport: HostConnectionTransport;
      authorities: readonly HostConnectionAuthority[];
    }
  | {
      state: "unauthenticated";
      authenticatedBy: string;
      transport: HostConnectionTransport;
      authorities: readonly HostConnectionAuthority[];
    };

export function authenticatedConnection(
  principalId: string,
  authenticatedBy: string,
  principalKind: HostConnectionPrincipalKind = "host_client",
  authorities: readonly HostConnectionAuthority[] = [],
  transport: HostConnectionTransport = "embedded",
): HostConnectionAuthContext {
  return {
    state: "authenticated",
    principalId,
    principalKind,
    authenticatedBy,
    transport,
    authorities: [...authorities],
  };
}

export function unauthenticatedConnection(
  authenticatedBy: string,
  authorities: readonly HostConnectionAuthority[] = [],
  transport: HostConnectionTransport = "embedded",
): HostConnectionAuthContext {
  return {
    state: "unauthenticated",
    authenticatedBy,
    transport,
    authorities: [...authorities],
  };
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
