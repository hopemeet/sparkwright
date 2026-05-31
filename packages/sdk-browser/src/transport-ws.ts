import type { ClientTransport, HostMessage } from "@sparkwright/sdk-core";

export interface WsClientOptions {
  url: string;
  /** Connection-open timeout in ms. Default 15_000. */
  openTimeoutMs?: number;
  /**
   * Optional WebSocket subprotocols passed to the constructor. v1.0 does
   * not standardize a subprotocol; this is here for future negotiation.
   */
  protocols?: string | string[];
}

/**
 * Connect to a host via the browser's native WebSocket. Resolves once the
 * socket is open. Subsequent send() calls are flushed immediately.
 *
 * Uses globalThis.WebSocket — no polyfill — so this module works as-is in
 * any modern browser, deno, bun, and Node 22+ (which exposes WebSocket
 * globally). In Node < 22, prefer @sparkwright/sdk-node which uses the
 * `ws` package.
 */
export async function connectWsTransport(
  opts: WsClientOptions,
): Promise<ClientTransport> {
  const WS = globalThis.WebSocket;
  if (typeof WS !== "function") {
    throw new Error(
      "globalThis.WebSocket is not available. Use @sparkwright/sdk-node in a Node < 22 environment.",
    );
  }

  const timeoutMs = opts.openTimeoutMs ?? 15_000;
  const ws = new WS(opts.url, opts.protocols);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error(`ws connect timeout: ${opts.url}`));
    }, timeoutMs);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error(`ws error connecting to ${opts.url}`));
      },
      { once: true },
    );
  });

  let onMessage: ((m: HostMessage) => void) | null = null;
  let onClose: ((reason?: string) => void) | null = null;

  ws.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (data instanceof Blob) {
      // Blobs are async; drop with a synthetic log so the user sees something.
      void data.text().then((t) => {
        try {
          onMessage?.(JSON.parse(t) as HostMessage);
        } catch {
          /* drop */
        }
      });
      return;
    } else {
      text = String(data);
    }
    try {
      onMessage?.(JSON.parse(text) as HostMessage);
    } catch {
      /* drop */
    }
  });
  ws.addEventListener("close", (e: CloseEvent) =>
    onClose?.(`ws closed code=${e.code} reason=${e.reason}`),
  );
  ws.addEventListener("error", () => onClose?.("ws error"));

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
