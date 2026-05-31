import { Client } from "@sparkwright/sdk-core";
import { connectWsTransport } from "./transport-ws.js";

// Re-export everything from sdk-core so a web app needs only one import.
export * from "@sparkwright/sdk-core";
export type { WsClientOptions } from "./transport-ws.js";

export interface CreateClientOptions {
  /** WebSocket URL of the Sparkwright host. Required in the browser. */
  url: string;
  /** Optional WebSocket subprotocols. */
  protocols?: string | string[];
  /** Connection-open timeout in ms. Default 15_000. */
  openTimeoutMs?: number;
  /**
   * Identifies this client in the handshake. Defaults to
   * { name: 'sparkwright-sdk-browser', version: '0.1.0' }.
   */
  client?: { name: string; version: string };
  /** Optional capability strings advertised to the host. */
  capabilities?: string[];
  /** Per-request timeout in ms. Default 120_000. */
  requestTimeoutMs?: number;
}

/**
 * Connect to a Sparkwright host from the browser. Resolves once the
 * handshake is complete.
 *
 * The browser SDK has only one transport (native WebSocket) — the spawn
 * model that sdk-node supports is impossible in the browser. Hosts must
 * be reachable as a ws:// or wss:// URL.
 *
 * Example:
 *   const client = await createClient({ url: 'ws://localhost:7320' });
 *   client.on('run.event', m => console.log(m.payload));
 *   const { runId } = await client.startRun({ goal: 'explore' });
 */
export async function createClient(opts: CreateClientOptions): Promise<Client> {
  const transport = await connectWsTransport({
    url: opts.url,
    protocols: opts.protocols,
    openTimeoutMs: opts.openTimeoutMs,
  });

  const client = new Client({
    transport,
    client: opts.client ?? {
      name: "sparkwright-sdk-browser",
      version: "0.1.0",
    },
    capabilities: opts.capabilities,
    requestTimeoutMs: opts.requestTimeoutMs,
  });

  await client.handshake();
  return client;
}
