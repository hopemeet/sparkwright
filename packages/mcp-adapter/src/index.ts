import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  CallToolResultSchema,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createContextItemId,
  createDefaultPolicy,
  createDefaultContentPolicy,
  defineTool,
  redactSensitiveText,
  sanitizeToolSchema,
  type ContextItem,
  type ContentPolicy,
  type ContentPolicyVerdict,
  type ToolDefinition,
} from "@sparkwright/core";
import type { EventEmitter, ToolRisk } from "@sparkwright/core";
import type { Policy } from "@sparkwright/core";

const DEFAULT_TIMEOUT_MS = 30_000;
const CLIENT_NAME = "sparkwright";
const CLIENT_VERSION = "0.1.0";

/**
 * Fields shared by every server transport.
 *
 * `supportsParallelToolCalls` opts a server out of the default per-server call
 * serialization: when true, tool calls to this server may run concurrently.
 * Leave it unset for servers that are not known to be concurrency-safe.
 */
interface McpServerConfigBase {
  name: string;
  timeoutMs?: number;
  enabled?: boolean;
  supportsParallelToolCalls?: boolean;
  /**
   * Auto-reconnect on connection-class call failures. When set, a dropped
   * connection is rebuilt with exponential backoff and the failed call is
   * retried once. Omit to disable (a connection error surfaces immediately).
   */
  reconnect?: McpReconnectOptions;
}

export interface McpReconnectOptions {
  /** Maximum reconnection attempts before giving up. Default 5. */
  maxAttempts?: number;
  /** Delay before the first retry, in ms. Default 200. */
  initialDelayMs?: number;
  /** Upper bound on the backoff delay, in ms. Default 5000. */
  maxDelayMs?: number;
}

export type McpServerConfig =
  | (McpServerConfigBase & {
      type: "stdio";
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    })
  | (McpServerConfigBase & {
      type: "http";
      url: string;
      headers?: Record<string, string>;
      /** OAuth provider for remote authorization; the transport drives the flow. */
      authProvider?: OAuthClientProvider;
    })
  | (McpServerConfigBase & {
      type: "sse";
      url: string;
      headers?: Record<string, string>;
      /** OAuth provider for remote authorization; the transport drives the flow. */
      authProvider?: OAuthClientProvider;
    });

export type McpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string };

export interface McpToolNameMapping {
  toolName: string;
  serverName: string;
  mcpToolName: string;
}

export interface PreparedMcpServer {
  name: string;
  status: McpStatus;
  tools: ToolDefinition[];
  toolNameMap: McpToolNameMapping[];
  close(): Promise<void>;
}

export interface PreparedMcpTools {
  tools: ToolDefinition[];
  statuses: Record<string, McpStatus>;
  toolNameMap: McpToolNameMapping[];
  close(): Promise<void>;
}

export interface PrepareMcpToolsForRunOptions {
  servers: McpServerConfig[];
  defaultTimeoutMs?: number;
  namePrefix?: string;
  policy?: McpToolPolicy | ((input: McpToolPolicyInput) => McpToolPolicy);
  serverPolicy?: Policy;
  /**
   * Optional event emitter (typically `run.events`). When provided, emits
   * one `mcp.server.prepared` event per server after preparation.
   */
  emitter?: EventEmitter;
  /** Optional agent id attached to emitted event metadata. */
  agentId?: string;
  /**
   * Optional hook for stderr emitted by stdio MCP child processes. A data
   * listener is installed even when this hook is omitted so child stderr cannot
   * fill its pipe and stall the server.
   */
  onStdioStderr?: (input: McpStdioStderrChunk) => void;
  /**
   * Optional hook for suspicious MCP tool descriptions. Findings are warnings,
   * not blockers, so legitimate servers do not become unavailable because of a
   * broad pattern match.
   */
  onToolDescriptionWarning?: (input: McpToolDescriptionWarning) => void;
  /** Override the content policy used to inspect MCP tool descriptions. */
  descriptionPolicy?: ContentPolicy;
}

type McpClientLike = Pick<Client, "callTool">;
export interface McpToolPolicy {
  risk?: ToolRisk;
  requiresApproval?: boolean;
}

export interface McpToolPolicyInput {
  serverName: string;
  mcpToolName: string;
  toolName: string;
  mcpTool: McpTool;
}

export interface McpStdioStderrChunk {
  serverName: string;
  chunk: string;
}

export interface McpToolDescriptionWarning {
  serverName: string;
  mcpToolName: string;
  toolName: string;
  verdict: ContentPolicyVerdict;
}

export type McpContextDescriptor =
  | McpResourceContextDescriptor
  | McpPromptContextDescriptor;

export interface McpResourceContextDescriptor {
  kind?: "resource";
  serverName: string;
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  text?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface McpPromptContextDescriptor {
  kind: "prompt";
  serverName: string;
  name: string;
  uri?: string;
  title?: string;
  description?: string;
  content?: string;
  messages?: unknown[];
  arguments?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export async function prepareMcpToolsForRun(
  options: PrepareMcpToolsForRunOptions,
): Promise<PreparedMcpTools> {
  const usedNames = new Set<string>();
  const prepared = await Promise.all(
    options.servers.map((server) =>
      prepareMcpServer(server, {
        defaultTimeoutMs: options.defaultTimeoutMs,
        namePrefix: options.namePrefix,
        policy: options.policy,
        serverPolicy: options.serverPolicy,
        usedNames,
      }),
    ),
  );

  if (options.emitter) {
    const baseMeta = {
      experimental: true,
      schemaVersion: "edge-trace.v0.1",
      sourcePackage: "@sparkwright/mcp-adapter",
      ...(options.agentId ? { agentId: options.agentId } : {}),
    };
    for (let i = 0; i < prepared.length; i += 1) {
      const server = prepared[i];
      const config = options.servers[i];
      const status = server.status.status;
      options.emitter.emit(
        "mcp.server.prepared",
        {
          name: server.name,
          status,
          toolCount: server.tools.length,
        },
        {
          ...baseMeta,
          serverType: config?.type,
          toolNameMap: server.toolNameMap,
          ...(server.status.status === "failed"
            ? { error: server.status.error }
            : {}),
        },
      );
    }
  }

  return {
    tools: prepared.flatMap((server) => server.tools),
    statuses: Object.fromEntries(
      prepared.map((server) => [server.name, server.status]),
    ),
    toolNameMap: prepared.flatMap((server) => server.toolNameMap),
    async close() {
      await Promise.all(prepared.map((server) => server.close()));
    },
  };
}

export async function prepareMcpServer(
  config: McpServerConfig,
  options: Omit<PrepareMcpToolsForRunOptions, "servers"> & {
    usedNames?: Set<string>;
  } = {},
): Promise<PreparedMcpServer> {
  const name = validateServerName(config.name);
  const timeoutMs =
    config.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const serverPolicy = options.serverPolicy ?? createDefaultPolicy();

  if (config.enabled === false) {
    return {
      name,
      status: { status: "disabled" },
      tools: [],
      toolNameMap: [],
      close: async () => {},
    };
  }

  let client: Client | undefined;

  try {
    const serverDecision = await serverPolicy.decide({
      action: "mcp.server.prepare",
      resource: resourceForServer(config, name),
      metadata: metadataForServer(config, name),
    });

    if (serverDecision.decision !== "allow") {
      return {
        name,
        status: {
          status: "failed",
          error: `MCP server preparation ${serverDecision.decision}: ${serverDecision.reason}`,
        },
        tools: [],
        toolNameMap: [],
        close: async () => {},
      };
    }

    // Build + connect a fresh client. Reused for the initial connection and,
    // when `reconnect` is configured, for each reconnection attempt.
    const connect = async (): Promise<Client> => {
      const next = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
      const transport = buildMcpTransport(config, name, options.onStdioStderr);
      await next.connect(transport, { timeout: timeoutMs });
      return next;
    };

    client = await connect();
    const listed = await client.listTools(undefined, { timeout: timeoutMs });

    // A reconnecting wrapper owns the live client once enabled, so close() must
    // route through it rather than the initial `client` reference.
    let closeClient: () => Promise<void> = async () => {
      await client?.close();
    };
    let liveClient: McpClientLike = client;
    if (config.reconnect) {
      const reconnecting = createReconnectingMcpClient({
        initial: client,
        reconnect: connect,
        options: config.reconnect,
      });
      liveClient = reconnecting;
      closeClient = () => reconnecting.close();
    }

    // Per-server calls are serialized by default; opt in to concurrency only
    // when the server is declared parallel-safe.
    const callClient = config.supportsParallelToolCalls
      ? liveClient
      : createSerializedMcpClient(liveClient);
    const usedNames = options.usedNames ?? new Set<string>();
    const toolNameMap: McpToolNameMapping[] = [];
    const tools = listed.tools.map((mcpTool) => {
      const tool = mcpToolToToolDefinition({
        serverName: name,
        mcpTool,
        client: callClient,
        timeoutMs,
        namePrefix: options.namePrefix,
        usedNames,
        policy: options.policy,
        descriptionPolicy: options.descriptionPolicy,
        onDescriptionWarning: options.onToolDescriptionWarning,
      });
      toolNameMap.push({
        toolName: tool.name,
        serverName: name,
        mcpToolName: mcpTool.name,
      });
      return tool;
    });

    return {
      name,
      status: { status: "connected" },
      tools,
      toolNameMap,
      close: closeClient,
    };
  } catch (cause) {
    await client?.close().catch(() => {});
    return {
      name,
      status: {
        status: "failed",
        // Connection failures can echo back auth headers / tokens; strip them
        // before the message reaches logs, traces, or the model.
        error: redactSensitiveText(
          cause instanceof Error ? cause.message : String(cause),
        ),
      },
      tools: [],
      toolNameMap: [],
      close: async () => {},
    };
  }
}

export function mcpToolToToolDefinition(input: {
  serverName: string;
  mcpTool: McpTool;
  client: McpClientLike;
  timeoutMs?: number;
  namePrefix?: string;
  usedNames?: Set<string>;
  policy?:
    | {
        risk?: ToolRisk;
        requiresApproval?: boolean;
      }
    | ((input: McpToolPolicyInput) => McpToolPolicy);
  descriptionPolicy?: ContentPolicy;
  onDescriptionWarning?: (input: McpToolDescriptionWarning) => void;
}): ToolDefinition {
  const toolName = makeMcpToolName({
    serverName: input.serverName,
    mcpToolName: input.mcpTool.name,
    namePrefix: input.namePrefix,
    usedNames: input.usedNames,
  });
  const policy =
    typeof input.policy === "function"
      ? input.policy({
          serverName: input.serverName,
          mcpToolName: input.mcpTool.name,
          toolName,
          mcpTool: input.mcpTool,
        })
      : input.policy;
  const descriptionVerdict = inspectMcpToolDescription(
    input.mcpTool.description ?? "",
    input.descriptionPolicy,
  );
  if (descriptionVerdict.warnings.length > 0 || !descriptionVerdict.allowed) {
    input.onDescriptionWarning?.({
      serverName: input.serverName,
      mcpToolName: input.mcpTool.name,
      toolName,
      verdict: descriptionVerdict,
    });
  }

  return defineTool({
    name: toolName,
    description: input.mcpTool.description ?? "",
    inputSchema: sanitizeToolSchema(
      normalizeMcpInputSchema(input.mcpTool.inputSchema),
    ),
    outputSchema: input.mcpTool.outputSchema,
    timeoutMs: input.timeoutMs,
    policy: policy ?? {
      risk: "risky",
      requiresApproval: true,
    },
    governance: {
      origin: {
        kind: "mcp",
        name: input.serverName,
        metadata: {
          serverName: input.serverName,
          mcpToolName: input.mcpTool.name,
          toolName,
          ...(descriptionVerdict.warnings.length > 0 ||
          !descriptionVerdict.allowed
            ? {
                descriptionSafety: {
                  allowed: descriptionVerdict.allowed,
                  blocks: descriptionVerdict.blocks,
                  warnings: descriptionVerdict.warnings,
                },
              }
            : {}),
        },
      },
      sideEffects: ["external", "network"],
      idempotency: "conditional",
      dataSensitivity: "internal",
      audit: {
        level: "metadata",
      },
    },
    async execute(args) {
      try {
        return await input.client.callTool(
          {
            name: input.mcpTool.name,
            arguments: isRecord(args) ? args : {},
          },
          CallToolResultSchema,
          {
            timeout: input.timeoutMs,
            resetTimeoutOnProgress: true,
          },
        );
      } catch (cause) {
        const rawMessage =
          cause instanceof Error ? cause.message : "MCP tool call failed.";
        throw {
          code: "MCP_TOOL_CALL_FAILED",
          message: redactSensitiveText(rawMessage),
          cause,
          metadata: {
            serverName: input.serverName,
            mcpToolName: input.mcpTool.name,
            toolName,
          },
        };
      }
    },
  });
}

function buildMcpTransport(
  config: McpServerConfig,
  name: string,
  onStdioStderr?: (input: McpStdioStderrChunk) => void,
): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
  if (config.type === "stdio") {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      stderr: "pipe",
    });
    drainStdioStderr(transport, name, onStdioStderr);
    return transport;
  }
  if (config.type === "sse") {
    return new SSEClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
      authProvider: config.authProvider,
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
    authProvider: config.authProvider,
  });
}

type ReconnectableClient = McpClientLike & { close?: () => Promise<void> };

export interface CreateReconnectingMcpClientInput {
  /** The already-connected client to use until the first connection failure. */
  initial: ReconnectableClient;
  /** Builds and connects a fresh client; invoked once per reconnection attempt. */
  reconnect: () => Promise<ReconnectableClient>;
  options?: McpReconnectOptions;
  /**
   * Classifies whether a thrown error is a connection-class failure worth
   * reconnecting for (vs. a tool-level error that should surface as-is).
   */
  isConnectionError?: (cause: unknown) => boolean;
  /** Observed on each reconnection attempt (for status/trace surfaces). */
  onReconnect?: (info: { attempt: number; error: unknown }) => void;
  /** Injectable delay, primarily for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RECONNECT_MAX_ATTEMPTS = 5;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 200;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5_000;

/**
 * Wrap a client so connection-class call failures trigger a rebuild with
 * exponential backoff, after which the failed call is retried once. Tool-level
 * errors pass through untouched. Concurrent reconnects collapse onto a single
 * attempt.
 */
export function createReconnectingMcpClient(
  input: CreateReconnectingMcpClientInput,
): McpClientLike & { close: () => Promise<void> } {
  const maxAttempts =
    input.options?.maxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS;
  const initialDelayMs =
    input.options?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
  const maxDelayMs =
    input.options?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  const isConnectionError = input.isConnectionError ?? defaultIsConnectionError;
  const sleep = input.sleep ?? defaultSleep;

  let current = input.initial;
  let reconnecting: Promise<void> | undefined;

  const reestablish = async (cause: unknown): Promise<void> => {
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      let lastError = cause;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const delay = Math.min(
          maxDelayMs,
          initialDelayMs * 2 ** (attempt - 1),
        );
        await sleep(delay);
        input.onReconnect?.({ attempt, error: lastError });
        try {
          const previous = current;
          current = await input.reconnect();
          await previous.close?.().catch(() => {});
          return;
        } catch (retryCause) {
          lastError = retryCause;
        }
      }
      throw lastError;
    })();
    try {
      await reconnecting;
    } finally {
      reconnecting = undefined;
    }
  };

  return {
    async callTool(...args: Parameters<McpClientLike["callTool"]>) {
      try {
        return await current.callTool(...args);
      } catch (cause) {
        if (!isConnectionError(cause)) throw cause;
        await reestablish(cause);
        return current.callTool(...args);
      }
    },
    async close() {
      await current.close?.();
    },
  };
}

function defaultIsConnectionError(cause: unknown): boolean {
  const message = (
    cause instanceof Error ? cause.message : String(cause)
  ).toLowerCase();
  return /not connected|connection (closed|error|reset)|closed|econnreset|econnrefused|socket hang up|transport|terminated|disconnect/.test(
    message,
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSerializedMcpClient(
  client: McpClientLike,
): McpClientLike {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    callTool(...args: Parameters<McpClientLike["callTool"]>) {
      const run = tail
        .catch(() => undefined)
        .then(() => client.callTool(...args));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

export function inspectMcpToolDescription(
  description: string,
  policy: ContentPolicy = createDefaultContentPolicy(),
): ContentPolicyVerdict {
  return policy.evaluate(description, "tool_result");
}

function drainStdioStderr(
  transport: StdioClientTransport,
  serverName: string,
  onChunk?: (input: McpStdioStderrChunk) => void,
): void {
  const stream = transport.stderr;
  if (!stream) return;

  stream.on("data", (chunk: Buffer | string) => {
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk);
    onChunk?.({ serverName, chunk: redactSensitiveText(text) });
  });
}

export function normalizeMcpContextDescriptors(
  descriptors: McpContextDescriptor[],
): ContextItem[] {
  return descriptors.map((descriptor) =>
    normalizeMcpContextDescriptor(descriptor),
  );
}

export function normalizeMcpContextDescriptor(
  descriptor: McpContextDescriptor,
): ContextItem {
  const serverName = validateServerName(descriptor.serverName);
  if (descriptor.kind === "prompt") {
    return normalizeMcpPromptContextDescriptor(descriptor, serverName);
  }

  return normalizeMcpResourceContextDescriptor(descriptor, serverName);
}

function normalizeMcpResourceContextDescriptor(
  descriptor: McpResourceContextDescriptor,
  serverName: string,
): ContextItem {
  const sourceUri = descriptor.uri;
  const content = contentForResourceDescriptor(descriptor);
  const contentHash = sha256(content);

  return {
    id: createContextItemId(),
    type: "system",
    source: {
      kind: "mcp",
      uri: sourceUri,
    },
    content,
    metadata: {
      layer: "runtime",
      stability: "session",
      priority: 70,
      ...(descriptor.metadata ?? {}),
      origin: `mcp:${serverName}`,
      serverName,
      mcpKind: "resource",
      sourceUri,
      contentHash,
      name: descriptor.name,
      title: descriptor.title,
      description: descriptor.description,
      mimeType: descriptor.mimeType,
    },
  };
}

function normalizeMcpPromptContextDescriptor(
  descriptor: McpPromptContextDescriptor,
  serverName: string,
): ContextItem {
  const sourceUri =
    descriptor.uri ?? `mcp-prompt://${serverName}/${descriptor.name}`;
  const content = contentForPromptDescriptor(descriptor);
  const contentHash = sha256(content);

  return {
    id: createContextItemId(),
    type: "system",
    source: {
      kind: "mcp",
      uri: sourceUri,
    },
    content,
    metadata: {
      layer: "runtime",
      stability: "session",
      priority: 70,
      ...(descriptor.metadata ?? {}),
      origin: `mcp:${serverName}`,
      serverName,
      mcpKind: "prompt",
      sourceUri,
      contentHash,
      name: descriptor.name,
      title: descriptor.title,
      description: descriptor.description,
    },
  };
}

export function normalizeMcpInputSchema(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
  }

  return {
    ...schema,
    type: "object",
    properties: isRecord(schema.properties) ? schema.properties : {},
    additionalProperties: schema.additionalProperties ?? false,
  };
}

export function makeMcpToolName(input: {
  serverName: string;
  mcpToolName: string;
  namePrefix?: string;
  usedNames?: Set<string>;
}): string {
  const prefix = input.namePrefix ?? "mcp";
  const base = [
    sanitizeToolNamePart(prefix),
    sanitizeToolNamePart(input.serverName),
    sanitizeToolNamePart(input.mcpToolName),
  ]
    .filter(Boolean)
    .join("_");
  const usedNames = input.usedNames;

  if (!usedNames) return base;
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }

  const suffix = shortHash(`${input.serverName}:${input.mcpToolName}`);
  const hashed = `${base}_${suffix}`;
  if (!usedNames.has(hashed)) {
    usedNames.add(hashed);
    return hashed;
  }

  let index = 2;
  while (usedNames.has(`${hashed}_${index}`)) index += 1;
  const unique = `${hashed}_${index}`;
  usedNames.add(unique);
  return unique;
}

function validateServerName(name: string): string {
  if (name.trim() === "") {
    throw new Error("MCP server name must be a non-empty string.");
  }
  return name;
}

function resourceForServer(config: McpServerConfig, name: string) {
  if (config.type === "stdio") {
    return {
      kind: "mcp.server",
      id: name,
      name,
      uri: `stdio:${config.command}`,
    };
  }

  return {
    kind: "mcp.server",
    id: name,
    name,
    uri: config.url,
  };
}

function metadataForServer(
  config: McpServerConfig,
  name: string,
): Record<string, unknown> {
  if (config.type === "stdio") {
    return {
      serverName: name,
      serverType: config.type,
      command: config.command,
      cwd: config.cwd,
      argCount: config.args?.length ?? 0,
      envKeys: config.env ? Object.keys(config.env).sort() : [],
    };
  }

  return {
    serverName: name,
    serverType: config.type,
    url: config.url,
    headerKeys: config.headers ? Object.keys(config.headers).sort() : [],
  };
}

function sanitizeToolNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 8);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function contentForResourceDescriptor(
  descriptor: McpResourceContextDescriptor,
): string {
  if (typeof descriptor.text === "string") return descriptor.text;
  if (typeof descriptor.content === "string") return descriptor.content;

  return JSON.stringify(
    {
      uri: descriptor.uri,
      name: descriptor.name,
      title: descriptor.title,
      description: descriptor.description,
      mimeType: descriptor.mimeType,
    },
    null,
    2,
  );
}

function contentForPromptDescriptor(
  descriptor: McpPromptContextDescriptor,
): string {
  if (typeof descriptor.content === "string") return descriptor.content;

  return JSON.stringify(
    {
      name: descriptor.name,
      title: descriptor.title,
      description: descriptor.description,
      arguments: descriptor.arguments,
      messages: descriptor.messages ?? [],
    },
    null,
    2,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
