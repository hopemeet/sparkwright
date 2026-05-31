import { Client } from "@sparkwright/sdk-core";
import {
  spawnHostTransport,
  type SpawnHostOptions,
} from "./transport-spawn.js";
import { connectWsTransport } from "./transport-ws.js";

// Re-export everything from sdk-core so callers only need one import.
export * from "@sparkwright/sdk-core";
export type { SpawnHostOptions } from "./transport-spawn.js";

export interface CreateClientOptions {
  /**
   * Explicit WebSocket URL. When omitted, the SDK checks
   * SPARKWRIGHT_HOST_URL; if that's also unset, a child host process is
   * spawned and stdio is used.
   */
  url?: string;

  /**
   * Options for spawning a child host when neither `url` nor
   * SPARKWRIGHT_HOST_URL is set. Ignored otherwise.
   */
  spawn?: SpawnHostOptions;

  /**
   * Identifies this client in the handshake.
   * Defaults to { name: 'sparkwright-sdk-node', version: '0.1.0' }.
   */
  client?: { name: string; version: string };

  /** Optional capability strings advertised to the host. */
  capabilities?: string[];

  /** Per-request timeout in ms. Default 120_000. */
  requestTimeoutMs?: number;
}

/**
 * Connect to a Sparkwright host. Resolves once the handshake is complete.
 *
 * Resolution order:
 *   1. options.url → ws connect
 *   2. process.env.SPARKWRIGHT_HOST_URL → ws connect
 *   3. spawn `sparkwright-host --stdio` (or whatever options.spawn.command
 *      points at) and pipe stdio.
 */
export async function createClient(
  options: CreateClientOptions = {},
): Promise<Client> {
  const url = options.url ?? process.env.SPARKWRIGHT_HOST_URL;
  const transport = url
    ? await connectWsTransport({ url })
    : spawnHostTransport(options.spawn).transport;

  const client = new Client({
    transport,
    client: options.client ?? {
      name: "sparkwright-sdk-node",
      version: "0.1.0",
    },
    capabilities: options.capabilities,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  await client.handshake();
  return client;
}
