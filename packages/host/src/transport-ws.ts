import { WebSocketServer, type WebSocket } from "ws";
import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import type { HostMessage } from "@sparkwright/protocol";
import type { Connection } from "./connection.js";
import {
  authenticatedConnection,
  nextConnectionId,
  unauthenticatedConnection,
  type HostConnectionAuthContext,
} from "./connection.js";

export interface WsServerOptions {
  port: number;
  host?: string;
  maxPayloadBytes?: number;
  authToken?: string;
  /** Non-secret server-side identity of the configured bearer credential. */
  authPrincipalId?: string;
  /**
   * Allow non-loopback binds without an `authToken`. Off by default: binding
   * to `0.0.0.0` or a public address without authentication exposes the host
   * runtime to anything on the network. Operators who deliberately run on an
   * isolated network can set this to `true`.
   */
  allowUnauthenticatedNonLoopback?: boolean;
  onConnection: (
    conn: Connection,
    authContext: HostConnectionAuthContext,
  ) => void;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_BEARER_PRINCIPAL_ID = "auth:ws-bearer:default";
const LOOPBACK_HOSTS = new Set([
  undefined,
  "",
  "127.0.0.1",
  "::1",
  "localhost",
]);

/**
 * WebSocket transport: one WS connection = one Connection. The host accepts
 * concurrent clients; each gets its own HostRuntime via serveConnection().
 *
 * v1.0 has optional bearer-token auth. Bind to localhost unless the operator
 * explicitly passes an externally-reachable host and configures network/auth
 * controls appropriate for that environment.
 */
export function startWsServer(opts: WsServerOptions): { close: () => void } {
  if (
    !LOOPBACK_HOSTS.has(opts.host) &&
    !opts.authToken?.trim() &&
    !opts.allowUnauthenticatedNonLoopback
  ) {
    throw new Error(
      `WS host "${opts.host}" is not loopback; authToken is required (or set allowUnauthenticatedNonLoopback to acknowledge the risk).`,
    );
  }
  const wss = new WebSocketServer({
    port: opts.port,
    host: opts.host,
    maxPayload: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });

  wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    if (opts.authToken && !isAuthorizedWsRequest(request, opts.authToken)) {
      ws.close(1008, "unauthorized");
      return;
    }
    opts.onConnection(
      wrapWebSocket(ws),
      opts.authToken?.trim()
        ? authenticatedConnection(
            opts.authPrincipalId ?? DEFAULT_BEARER_PRINCIPAL_ID,
            "ws-bearer",
            "gateway",
          )
        : unauthenticatedConnection("ws-no-auth"),
    );
  });

  return {
    close: () => {
      wss.close();
    },
  };
}

function isAuthorizedWsRequest(
  request: IncomingMessage,
  authToken: string,
): boolean {
  const expected = authToken.trim();
  if (!expected) return true;

  const authorization = request.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (match?.[1] && constantTimeEquals(match[1], expected)) return true;
  }

  const host = request.headers.host ?? "localhost";
  const url = new URL(request.url ?? "/", `ws://${host}`);
  const provided = url.searchParams.get("token");
  return provided !== null && constantTimeEquals(provided, expected);
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function wrapWebSocket(ws: WebSocket): Connection {
  const id = nextConnectionId("ws");
  let onMessage: ((m: HostMessage) => void) | null = null;
  let onClose: ((reason?: string) => void) | null = null;

  ws.on("message", (data) => {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (Buffer.isBuffer(data)) {
      text = data.toString("utf8");
    } else if (Array.isArray(data)) {
      text = Buffer.concat(data).toString("utf8");
    } else {
      text = String(data);
    }
    let parsed: HostMessage;
    try {
      parsed = JSON.parse(text) as HostMessage;
    } catch {
      return;
    }
    onMessage?.(parsed);
  });
  ws.on("close", () => onClose?.("ws closed"));
  ws.on("error", () => onClose?.("ws error"));

  return {
    id,
    send(message) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
      }
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close(_reason) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}
