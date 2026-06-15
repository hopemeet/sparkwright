import { createHash } from "node:crypto";
import { spawn, type IOType } from "node:child_process";
import process from "node:process";
import { PassThrough, type Stream } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
  type CreateMessageRequest,
  type CreateMessageResult,
  type JSONRPCMessage,
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
import {
  createPlatformShellSandboxRuntime,
  prepareSandboxedProcessInvocation,
  type ResolvedShellSandboxConfig,
  type SandboxedProcessInvocation,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";

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
  | { status: "configured" }
  | { status: "connected" }
  | { status: "disabled" }
  | {
      status: "failed";
      error: string;
      errorCode?: McpPrepareErrorCode;
      phase?: McpPreparePhase;
      timeoutMs?: number;
      durationMs?: number;
    };

export type McpPreparePhase = "policy" | "connect" | "list_tools";

export type McpPrepareErrorCode =
  | "MCP_SERVER_PREPARE_DENIED"
  | "MCP_SERVER_SANDBOX_UNAVAILABLE"
  | "MCP_SERVER_COMMAND_NOT_FOUND"
  | "MCP_SERVER_PREPARE_TIMEOUT"
  | "MCP_SERVER_CONNECT_FAILED"
  | "MCP_SERVER_LIST_TOOLS_FAILED"
  | "MCP_SERVER_PREPARE_FAILED";

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
  sandbox?: McpSandboxSummary;
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
  /**
   * Optional OS sandbox config for stdio MCP servers. HTTP/SSE transports are
   * already remote transports and are not wrapped here.
   */
  shellSandbox?: ResolvedShellSandboxConfig;
  /** Injectable runtime, primarily for tests. */
  shellSandboxRuntime?: ShellSandboxRuntime;
  /**
   * Enable server-initiated sampling: the server may request a completion from
   * the host LLM. When provided, the client advertises the sampling capability
   * and routes requests through a guarded handler (rate limit, lifetime cap,
   * model allowlist). Omit to leave sampling disabled.
   */
  sampling?: McpSamplingConfig;
}

export interface LazyMcpServerPrepared {
  name: string;
  status: McpStatus;
  tools: ToolDefinition[];
  toolNameMap: McpToolNameMapping[];
}

export interface CreateLazyMcpToolsForRunOptions extends PrepareMcpToolsForRunOptions {
  /**
   * Called exactly once after an enabled server is explicitly prepared. Hosts
   * can register the discovered concrete MCP tools into the live run registry
   * so subsequent turns expose precise schemas and direct tool names.
   */
  onServerPrepared?: (server: LazyMcpServerPrepared) => void;
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

export interface McpSandboxSummary {
  sandboxed: boolean;
  mode?: string;
  runtime?: string;
  networkMode?: string;
  available?: boolean;
  /** @reserved Public MCP sandbox status consumed by trace and diagnostics UIs. */
  fallbackReason?: string;
  /** @reserved Public MCP sandbox status consumed by trace and diagnostics UIs. */
  enforced?: boolean;
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
        onStdioStderr: options.onStdioStderr,
        onToolDescriptionWarning: options.onToolDescriptionWarning,
        descriptionPolicy: options.descriptionPolicy,
        shellSandbox: options.shellSandbox,
        shellSandboxRuntime: options.shellSandboxRuntime,
        sampling: options.sampling,
        usedNames,
      }),
    ),
  );

  emitMcpServerPreparedEvents(options, prepared);

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

export function createLazyMcpToolsForRun(
  options: CreateLazyMcpToolsForRunOptions,
): PreparedMcpTools {
  const usedNames = new Set<string>();
  const statusEntries = options.servers.map((server) => [
    validateServerName(server.name),
    server.enabled === false
      ? ({ status: "disabled" } as const)
      : ({ status: "configured" } as const),
  ]);
  const statuses = Object.fromEntries(statusEntries) as Record<
    string,
    McpStatus
  >;
  const toolNameMap: McpToolNameMapping[] = [];
  const preparedByName = new Map<string, Promise<PreparedMcpServer>>();
  const closeByName = new Map<string, () => Promise<void>>();

  const lazyTools = options.servers.flatMap((server) => {
    const name = validateServerName(server.name);
    if (server.enabled === false) return [];

    const listToolName = makeMcpToolName({
      serverName: name,
      mcpToolName: "list_tools",
      namePrefix: options.namePrefix,
      usedNames,
    });
    const callToolName = makeMcpToolName({
      serverName: name,
      mcpToolName: "call_tool",
      namePrefix: options.namePrefix,
      usedNames,
    });

    return [
      defineTool({
        name: listToolName,
        description:
          `Connect to MCP server "${name}" on demand and list its available tools. ` +
          "Use this before calling MCP tools from that server.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        policy: { risk: "safe", requiresApproval: false },
        governance: {
          origin: {
            kind: "mcp",
            name,
            metadata: { serverName: name, lazy: true, operation: "list_tools" },
          },
          sideEffects: ["read", "external", "network"],
          idempotency: "conditional",
          dataSensitivity: "internal",
          audit: { level: "metadata" },
        },
        isReplaySafe: false,
        async execute() {
          const prepared = await ensureLazyMcpServerPrepared({
            server,
            name,
            options,
            usedNames,
            statuses,
            toolNameMap,
            preparedByName,
            closeByName,
          });
          return lazyListToolsResult(prepared);
        },
      }),
      defineTool({
        name: callToolName,
        description:
          `Call a tool on MCP server "${name}" on demand. Prefer calling ` +
          `${listToolName} first so the exact tool names and schemas are known.`,
        inputSchema: {
          type: "object",
          properties: {
            toolName: {
              type: "string",
              description:
                "MCP tool name to call. Accepts either the raw MCP tool name or the registered SparkWright MCP tool name.",
            },
            arguments: {
              type: "object",
              description: "Arguments to pass to the MCP tool.",
              additionalProperties: true,
            },
          },
          required: ["toolName"],
          additionalProperties: false,
        },
        policy: lazyMcpCallPolicy(options.policy),
        governance: {
          origin: {
            kind: "mcp",
            name,
            metadata: { serverName: name, lazy: true, operation: "call_tool" },
          },
          sideEffects: ["external", "network"],
          idempotency: "conditional",
          dataSensitivity: "internal",
          audit: { level: "metadata" },
        },
        isReplaySafe: false,
        async execute(args, ctx) {
          const prepared = await ensureLazyMcpServerPrepared({
            server,
            name,
            options,
            usedNames,
            statuses,
            toolNameMap,
            preparedByName,
            closeByName,
          });
          if (prepared.status.status !== "connected") {
            return lazyListToolsResult(prepared);
          }
          const parsed = parseLazyMcpCallArgs(args);
          const mapping = prepared.toolNameMap.find(
            (candidate) =>
              candidate.mcpToolName === parsed.toolName ||
              candidate.toolName === parsed.toolName,
          );
          if (!mapping) {
            throw {
              code: "MCP_TOOL_NOT_FOUND",
              message:
                `MCP server "${name}" does not expose tool "${parsed.toolName}". ` +
                `Call ${listToolName} to inspect available tools.`,
              metadata: {
                serverName: name,
                requestedToolName: parsed.toolName,
                availableTools: prepared.toolNameMap.map((tool) => ({
                  toolName: tool.toolName,
                  mcpToolName: tool.mcpToolName,
                })),
              },
            };
          }
          const tool = prepared.tools.find(
            (candidate) => candidate.name === mapping.toolName,
          );
          if (!tool) {
            throw {
              code: "MCP_TOOL_NOT_FOUND",
              message: `Prepared MCP tool not found: ${mapping.toolName}`,
              metadata: {
                serverName: name,
                requestedToolName: parsed.toolName,
                toolName: mapping.toolName,
              },
            };
          }
          return tool.execute(parsed.arguments ?? {}, ctx);
        },
      }),
    ];
  });

  return {
    tools: lazyTools,
    statuses,
    toolNameMap,
    async close() {
      await Promise.all([...closeByName.values()].map((close) => close()));
    },
  };
}

async function ensureLazyMcpServerPrepared(input: {
  server: McpServerConfig;
  name: string;
  options: CreateLazyMcpToolsForRunOptions;
  usedNames: Set<string>;
  statuses: Record<string, McpStatus>;
  toolNameMap: McpToolNameMapping[];
  preparedByName: Map<string, Promise<PreparedMcpServer>>;
  closeByName: Map<string, () => Promise<void>>;
}): Promise<PreparedMcpServer> {
  const existing = input.preparedByName.get(input.name);
  if (existing) return existing;

  const pending = (async () => {
    const prepared = await prepareMcpServer(input.server, {
      defaultTimeoutMs: input.options.defaultTimeoutMs,
      namePrefix: input.options.namePrefix,
      policy: input.options.policy,
      serverPolicy: input.options.serverPolicy,
      onStdioStderr: input.options.onStdioStderr,
      onToolDescriptionWarning: input.options.onToolDescriptionWarning,
      descriptionPolicy: input.options.descriptionPolicy,
      shellSandbox: input.options.shellSandbox,
      shellSandboxRuntime: input.options.shellSandboxRuntime,
      sampling: input.options.sampling,
      usedNames: input.usedNames,
    });
    input.statuses[input.name] = prepared.status;
    input.toolNameMap.push(...prepared.toolNameMap);
    input.closeByName.set(input.name, prepared.close);
    emitMcpServerPreparedEvents(
      {
        ...input.options,
        servers: [input.server],
      },
      [prepared],
    );
    input.options.onServerPrepared?.({
      name: prepared.name,
      status: prepared.status,
      tools: prepared.tools,
      toolNameMap: prepared.toolNameMap,
    });
    return prepared;
  })();
  input.preparedByName.set(input.name, pending);
  return pending;
}

function lazyListToolsResult(
  prepared: PreparedMcpServer,
): Record<string, unknown> {
  return {
    serverName: prepared.name,
    status: prepared.status.status,
    tools: prepared.toolNameMap.map((tool) => {
      const definition = prepared.tools.find(
        (candidate) => candidate.name === tool.toolName,
      );
      return {
        toolName: tool.toolName,
        mcpToolName: tool.mcpToolName,
        description: definition?.description ?? "",
        inputSchema: definition?.inputSchema,
        outputSchema: definition?.outputSchema,
      };
    }),
    ...(prepared.status.status === "failed"
      ? {
          error: {
            code: prepared.status.errorCode,
            message: prepared.status.error,
            phase: prepared.status.phase,
          },
        }
      : {}),
  };
}

function lazyMcpCallPolicy(policy: PrepareMcpToolsForRunOptions["policy"]): {
  risk?: ToolRisk;
  requiresApproval?: boolean;
} {
  if (typeof policy === "function") {
    return { risk: "risky", requiresApproval: true };
  }
  return policy ?? { risk: "risky", requiresApproval: true };
}

function parseLazyMcpCallArgs(args: unknown): {
  toolName: string;
  arguments?: Record<string, unknown>;
} {
  if (!isRecord(args)) {
    throw {
      code: "MCP_TOOL_ARGUMENTS_INVALID",
      message: "Lazy MCP call input must be an object.",
    };
  }
  if (typeof args.toolName !== "string" || args.toolName.trim() === "") {
    throw {
      code: "MCP_TOOL_ARGUMENTS_INVALID",
      message: "Lazy MCP call requires a non-empty toolName.",
    };
  }
  const toolArguments = args.arguments;
  if (
    toolArguments !== undefined &&
    (!isRecord(toolArguments) || Array.isArray(toolArguments))
  ) {
    throw {
      code: "MCP_TOOL_ARGUMENTS_INVALID",
      message: "Lazy MCP call arguments must be an object when provided.",
    };
  }
  return {
    toolName: args.toolName.trim(),
    arguments: toolArguments as Record<string, unknown> | undefined,
  };
}

function emitMcpServerPreparedEvents(
  options: Pick<PrepareMcpToolsForRunOptions, "emitter" | "agentId"> & {
    servers: readonly McpServerConfig[];
  },
  prepared: readonly PreparedMcpServer[],
): void {
  if (!options.emitter) return;
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
    const failure =
      server.status.status === "failed" ? server.status : undefined;
    options.emitter.emit(
      "mcp.server.prepared",
      {
        name: server.name,
        status,
        toolCount: server.tools.length,
        ...(failure
          ? {
              errorCode: failure.errorCode,
              errorPhase: failure.phase,
              error: {
                code: failure.errorCode,
                message: failure.error,
                phase: failure.phase,
              },
            }
          : {}),
        ...(server.sandbox ? { sandbox: server.sandbox } : {}),
      },
      {
        ...baseMeta,
        serverType: config?.type,
        toolNameMap: server.toolNameMap,
        ...(server.sandbox ? { sandbox: server.sandbox } : {}),
        ...(server.status.status === "failed"
          ? {
              error: server.status.error,
              errorCode: server.status.errorCode,
              errorPhase: server.status.phase,
              timeoutMs: server.status.timeoutMs,
              durationMs: server.status.durationMs,
            }
          : {}),
      },
    );
  }
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
      sandbox: disabledMcpSandboxSummary(config, options.shellSandbox),
      close: async () => {},
    };
  }

  let client: Client | undefined;
  let phase: McpPreparePhase = "policy";
  let sandbox: McpSandboxSummary | undefined;
  const startedAt = Date.now();

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
          errorCode: "MCP_SERVER_PREPARE_DENIED",
          phase,
          timeoutMs,
          durationMs: Date.now() - startedAt,
        },
        tools: [],
        toolNameMap: [],
        sandbox,
        close: async () => {},
      };
    }

    // One sampling handler instance, shared across reconnects so rate-limit and
    // request-cap counters persist for the life of the prepared server.
    const samplingHandler = options.sampling
      ? createMcpSamplingHandler(name, options.sampling)
      : undefined;

    // Build + connect a fresh client. Reused for the initial connection and,
    // when `reconnect` is configured, for each reconnection attempt.
    const connect = async (): Promise<Client> => {
      const next = new Client(
        { name: CLIENT_NAME, version: CLIENT_VERSION },
        samplingHandler ? { capabilities: { sampling: {} } } : undefined,
      );
      if (samplingHandler) {
        next.setRequestHandler(CreateMessageRequestSchema, (request) =>
          samplingHandler(request.params),
        );
      }
      phase = "connect";
      const preparedTransport = await buildMcpTransport(
        config,
        name,
        options.onStdioStderr,
        options.shellSandbox,
        options.shellSandboxRuntime,
      );
      sandbox = preparedTransport.sandbox;
      await next.connect(preparedTransport.transport, { timeout: timeoutMs });
      return next;
    };

    client = await connect();
    phase = "list_tools";
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
      sandbox,
      close: closeClient,
    };
  } catch (cause) {
    await client?.close().catch(() => {});
    const error = classifyMcpPrepareFailure(cause, phase);
    const causeSandbox =
      cause instanceof McpSandboxUnavailableError ? cause.sandbox : undefined;
    return {
      name,
      status: {
        status: "failed",
        // Connection failures can echo back auth headers / tokens; strip them
        // before the message reaches logs, traces, or the model.
        error: error.message,
        errorCode: error.code,
        phase,
        timeoutMs,
        durationMs: Date.now() - startedAt,
      },
      tools: [],
      toolNameMap: [],
      sandbox: sandbox ?? causeSandbox,
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
            errorPhase: "call_tool",
          },
        };
      }
    },
  });
}

function classifyMcpPrepareFailure(
  cause: unknown,
  phase: McpPreparePhase,
): { code: McpPrepareErrorCode; message: string } {
  const rawMessage = cause instanceof Error ? cause.message : String(cause);
  const message = redactSensitiveText(rawMessage);
  const nodeCode = isRecord(cause) ? cause.code : undefined;
  if (nodeCode === "MCP_SERVER_SANDBOX_UNAVAILABLE") {
    return { code: "MCP_SERVER_SANDBOX_UNAVAILABLE", message };
  }
  if (nodeCode === "ENOENT" || /\bENOENT\b/u.test(rawMessage)) {
    return { code: "MCP_SERVER_COMMAND_NOT_FOUND", message };
  }
  if (/timed out|timeout|Request timed out/i.test(rawMessage)) {
    return { code: "MCP_SERVER_PREPARE_TIMEOUT", message };
  }
  if (phase === "list_tools") {
    return { code: "MCP_SERVER_LIST_TOOLS_FAILED", message };
  }
  if (phase === "connect") {
    return { code: "MCP_SERVER_CONNECT_FAILED", message };
  }
  return { code: "MCP_SERVER_PREPARE_FAILED", message };
}

function disabledMcpSandboxSummary(
  config: McpServerConfig,
  shellSandbox: ResolvedShellSandboxConfig | undefined,
): McpSandboxSummary | undefined {
  if (config.type !== "stdio" || !shellSandbox) return undefined;
  return {
    sandboxed: false,
    mode: shellSandbox.mode,
    networkMode: shellSandbox.network.mode,
    available: false,
    enforced: shellSandbox.failIfUnavailable,
  };
}

async function buildMcpTransport(
  config: McpServerConfig,
  name: string,
  onStdioStderr?: (input: McpStdioStderrChunk) => void,
  shellSandbox?: ResolvedShellSandboxConfig,
  shellSandboxRuntime?: ShellSandboxRuntime,
): Promise<{ transport: Transport; sandbox?: McpSandboxSummary }> {
  if (config.type === "stdio") {
    if (shellSandbox && shellSandbox.mode !== "off") {
      const runtime =
        shellSandboxRuntime ?? createPlatformShellSandboxRuntime();
      const available = await runtime.isAvailable();
      if (available) {
        const invocation = await prepareSandboxedProcessInvocation(
          runtime,
          {
            command: config.command,
            args: config.args,
            cwd: config.cwd ?? process.cwd(),
            env: config.env,
            metadata: {
              sandboxed: true,
              sandboxRuntime: runtime.id,
              mcpServerName: name,
            },
          },
          shellSandbox,
        );
        const transport = new SandboxedStdioClientTransport({
          invocation,
          stderr: "pipe",
        });
        drainStdioStderr(transport, name, onStdioStderr);
        return {
          transport,
          sandbox: {
            sandboxed: true,
            mode: shellSandbox.mode,
            runtime: runtime.id,
            networkMode: shellSandbox.network.mode,
            available: true,
            enforced: shellSandbox.failIfUnavailable,
          },
        };
      }
      const reason = `MCP stdio sandbox runtime "${runtime.id}" is unavailable on ${runtime.platform}.`;
      if (shellSandbox.failIfUnavailable) {
        throw new McpSandboxUnavailableError(reason, {
          sandboxed: false,
          mode: shellSandbox.mode,
          runtime: runtime.id,
          networkMode: shellSandbox.network.mode,
          available: false,
          fallbackReason: reason,
          enforced: true,
        });
      }
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: config.env,
        stderr: "pipe",
      });
      drainStdioStderr(transport, name, onStdioStderr);
      return {
        transport,
        sandbox: {
          sandboxed: false,
          mode: shellSandbox.mode,
          runtime: runtime.id,
          networkMode: shellSandbox.network.mode,
          available: false,
          fallbackReason: reason,
          enforced: false,
        },
      };
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      stderr: "pipe",
    });
    drainStdioStderr(transport, name, onStdioStderr);
    return {
      transport,
      sandbox: shellSandbox
        ? {
            sandboxed: false,
            mode: shellSandbox.mode,
            networkMode: shellSandbox.network.mode,
            available: false,
            enforced: false,
          }
        : undefined,
    };
  }
  if (config.type === "sse") {
    return {
      transport: new SSEClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
        authProvider: config.authProvider,
      }),
    };
  }
  return {
    transport: new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
      authProvider: config.authProvider,
    }),
  };
}

class McpSandboxUnavailableError extends Error {
  readonly code = "MCP_SERVER_SANDBOX_UNAVAILABLE";

  constructor(
    message: string,
    readonly sandbox: McpSandboxSummary,
  ) {
    super(message);
  }
}

class SandboxedStdioClientTransport implements Transport {
  private process?: ReturnType<typeof spawn>;
  private readonly readBuffer = new ReadBuffer();
  private readonly stderrStream: PassThrough | null;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly params: {
      invocation: SandboxedProcessInvocation;
      stderr?: IOType | Stream | number;
    },
  ) {
    this.stderrStream =
      params.stderr === "pipe" || params.stderr === "overlapped"
        ? new PassThrough()
        : null;
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error("SandboxedStdioClientTransport already started.");
    }

    await new Promise<void>((resolveStart, rejectStart) => {
      const invocation = this.params.invocation;
      this.process = spawn(invocation.command, [...invocation.args], {
        env: {
          ...getDefaultEnvironment(),
          ...invocation.env,
        },
        stdio: ["pipe", "pipe", this.params.stderr ?? "inherit"],
        shell: false,
        windowsHide: process.platform === "win32",
        cwd: invocation.cwd,
      });

      this.process.on("error", (error) => {
        rejectStart(error);
        this.onerror?.(error);
        void invocation.cleanup?.();
      });
      this.process.on("spawn", () => resolveStart());
      this.process.on("close", () => {
        this.process = undefined;
        this.onclose?.();
        void invocation.cleanup?.();
      });
      this.process.stdin?.on("error", (error) => {
        this.onerror?.(error);
      });
      this.process.stdout?.on("data", (chunk: Buffer | string) => {
        this.readBuffer.append(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
        );
        this.processReadBuffer();
      });
      this.process.stdout?.on("error", (error) => {
        this.onerror?.(error);
      });
      if (this.stderrStream && this.process.stderr) {
        this.process.stderr.pipe(this.stderrStream);
      }
    });
  }

  get stderr(): Stream | null {
    if (this.stderrStream) return this.stderrStream;
    return this.process?.stderr ?? null;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  async close(): Promise<void> {
    if (this.process) {
      const processToClose = this.process;
      this.process = undefined;
      const closePromise = new Promise<void>((resolveClose) => {
        processToClose.once("close", () => resolveClose());
      });
      try {
        processToClose.stdin?.end();
      } catch {
        // ignore
      }
      await Promise.race([
        closePromise,
        new Promise<void>((resolveTimeout) =>
          setTimeout(resolveTimeout, 2000).unref(),
        ),
      ]);
      if (processToClose.exitCode === null) {
        try {
          processToClose.kill("SIGTERM");
        } catch {
          // ignore
        }
        await Promise.race([
          closePromise,
          new Promise<void>((resolveTimeout) =>
            setTimeout(resolveTimeout, 2000).unref(),
          ),
        ]);
      }
      if (processToClose.exitCode === null) {
        try {
          processToClose.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      await this.params.invocation.cleanup?.();
    }
    this.readBuffer.clear();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await new Promise<void>((resolveSend) => {
      if (!this.process?.stdin) {
        throw new Error("Not connected");
      }
      const json = serializeMessage(message);
      if (this.process.stdin.write(json)) {
        resolveSend();
      } else {
        this.process.stdin.once("drain", resolveSend);
      }
    });
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) break;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }
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
        const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
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

// --- MCP sampling (server -> host LLM completion) ----------------------------

export interface McpSamplingMessage {
  role: "user" | "assistant";
  /** Concatenated text content; non-text blocks are dropped. */
  text: string;
}

export interface McpSamplingRequest {
  serverName: string;
  messages: McpSamplingMessage[];
  systemPrompt?: string;
  maxTokens?: number;
}

export interface McpSamplingResponse {
  /** The model that produced the completion; checked against `allowedModels`. */
  model: string;
  text: string;
  stopReason?: string;
}

export interface McpSamplingConfig {
  /**
   * Performs a completion for a server-initiated sampling request. The host
   * wires its own model adapter here; the adapter never picks a model itself.
   */
  complete: (request: McpSamplingRequest) => Promise<McpSamplingResponse>;
  /**
   * If set, the model named in the completion response must appear here, or the
   * request is rejected. Use to stop a server from steering the host onto an
   * unapproved (e.g. more expensive) model.
   */
  allowedModels?: string[];
  /** Maximum sampling requests accepted per rolling minute. Default unlimited. */
  maxRequestsPerMinute?: number;
  /** Maximum sampling requests accepted over the server's lifetime. Default unlimited. */
  maxRequests?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class McpSamplingError extends Error {
  constructor(
    message: string,
    readonly code: "rate_limited" | "request_cap" | "model_not_allowed",
  ) {
    super(message);
    this.name = "McpSamplingError";
  }
}

/**
 * Build a `sampling/createMessage` request handler that enforces a rate limit,
 * a lifetime request cap, and a model allowlist before and after delegating to
 * the host's completion function. State (counters) persists across reconnects
 * because one handler instance is shared by every client the server uses.
 */
/** Concatenate the text blocks of a sampling message's content. */
function extractSamplingText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

export function createMcpSamplingHandler(
  serverName: string,
  config: McpSamplingConfig,
): (params: CreateMessageRequest["params"]) => Promise<CreateMessageResult> {
  const now = config.now ?? Date.now;
  const recent: number[] = [];
  let total = 0;

  return async (params) => {
    const at = now();

    if (config.maxRequestsPerMinute !== undefined) {
      while (recent.length > 0 && recent[0] <= at - 60_000) recent.shift();
      if (recent.length >= config.maxRequestsPerMinute) {
        throw new McpSamplingError(
          `MCP sampling rate limit exceeded for server "${serverName}".`,
          "rate_limited",
        );
      }
    }
    if (config.maxRequests !== undefined && total >= config.maxRequests) {
      throw new McpSamplingError(
        `MCP sampling request cap reached for server "${serverName}".`,
        "request_cap",
      );
    }

    recent.push(at);
    total += 1;

    const response = await config.complete({
      serverName,
      messages: params.messages.map((message) => ({
        role: message.role,
        text: extractSamplingText(message.content),
      })),
      systemPrompt: params.systemPrompt,
      maxTokens: params.maxTokens,
    });

    if (
      config.allowedModels !== undefined &&
      !config.allowedModels.includes(response.model)
    ) {
      throw new McpSamplingError(
        `MCP sampling model "${response.model}" is not allowed for server "${serverName}".`,
        "model_not_allowed",
      );
    }

    return {
      model: response.model,
      role: "assistant",
      content: { type: "text", text: response.text },
      ...(response.stopReason ? { stopReason: response.stopReason } : {}),
    };
  };
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
  transport: { stderr: Stream | null },
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
