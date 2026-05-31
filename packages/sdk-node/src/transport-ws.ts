import { WebSocket } from "ws";
import type { HostMessage } from "@sparkwright/protocol";
import type { ClientTransport } from "@sparkwright/sdk-core";

export interface WsClientOptions {
  url: string;
  /** Connection-open timeout in ms. Default 15_000. */
  openTimeoutMs?: number;
}

/**
 * Connect to a running host over WebSocket. Resolves once the socket is
 * open; subsequent send()s are flushed immediately.
 */
export async function connectWsTransport(
  opts: WsClientOptions,
): Promise<ClientTransport> {
  const timeoutMs = opts.openTimeoutMs ?? 15_000;
  const ws = new WebSocket(opts.url);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error(`ws connect timeout: ${opts.url}`));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  let onMessage: ((m: HostMessage) => void) | null = null;
  let onClose: ((reason?: string) => void) | null = null;

  ws.on("message", (data) => {
    let text: string;
    if (typeof data === "string") text = data;
    else if (Buffer.isBuffer(data)) text = data.toString("utf8");
    else if (Array.isArray(data)) text = Buffer.concat(data).toString("utf8");
    else text = String(data);
    try {
      onMessage?.(JSON.parse(text) as HostMessage);
    } catch {
      /* malformed; drop */
    }
  });
  ws.on("close", () => onClose?.("ws closed"));
  ws.on("error", (err) => onClose?.(`ws error: ${err.message}`));

  return {
    send(message) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
