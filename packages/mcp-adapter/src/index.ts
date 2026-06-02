import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

export type McpServerConfig =
  | {
      type: "stdio";
      name: string;
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      enabled?: boolean;
    }
  | {
      type: "http";
      name: string;
      url: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      enabled?: boolean;
    };

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

    client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (config.type === "stdio") {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: config.env,
        stderr: "pipe",
      });
      drainStdioStderr(transport, name, options.onStdioStderr);
    } else {
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers
          ? {
              headers: config.headers,
            }
          : undefined,
      });
    }

    await client.connect(transport, { timeout: timeoutMs });
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    const callClient = createSerializedMcpClient(client);
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
      close: async () => {
        await client?.close();
      },
    };
  } catch (cause) {
    await client?.close().catch(() => {});
    return {
      name,
      status: {
        status: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
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
