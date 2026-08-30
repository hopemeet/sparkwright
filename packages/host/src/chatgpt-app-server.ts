import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  ModelAdapter,
  ModelInput,
  ModelOutput,
  PromptMessage,
  ToolDescriptor,
} from "@sparkwright/core";

const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const APP_SERVER_TURN_TIMEOUT_MS = 10 * 60_000;
const APP_SERVER_MAX_LINE_BYTES = 16 * 1024 * 1024;
const APP_SERVER_STDERR_TAIL_BYTES = 8 * 1024;
const CHATGPT_RUNTIME_ID = "openai-app-server.v1";

type JsonRecord = Record<string, unknown>;
type AppServerId = number | string;

export interface ChatGptAppServerNotification {
  method: string;
  params?: unknown;
}

export interface ChatGptAppServerRequest {
  id: AppServerId;
  method: string;
  params?: unknown;
}

export interface ChatGptAppServerSession {
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T>;
  onNotification(
    listener: (notification: ChatGptAppServerNotification) => void,
  ): () => void;
  onRequest(
    listener: (request: ChatGptAppServerRequest) => unknown | Promise<unknown>,
  ): () => void;
  close(): Promise<void>;
}

export type ChatGptAppServerFactory = () => Promise<ChatGptAppServerSession>;

export interface ChatGptModelInfo {
  id: string;
  displayName: string;
  description?: string;
  inputModalities?: string[];
  isDefault?: boolean;
}

export class ChatGptAppServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGptAppServerError";
  }
}

/**
 * Start the version-pinned App Server shipped as a Host dependency. Resolution
 * is package-relative and never consults the user's PATH.
 */
export async function createChatGptAppServerSession(): Promise<ChatGptAppServerSession> {
  let entrypoint: string;
  try {
    entrypoint = createRequire(import.meta.url).resolve(
      "@openai/codex/bin/codex.js",
    );
  } catch {
    throw new ChatGptAppServerError(
      "The bundled ChatGPT login runtime is missing. Reinstall SparkWright and try again.",
    );
  }
  const child = spawn(process.execPath, [entrypoint, "app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: appServerEnvironment(process.env),
    windowsHide: true,
  });
  const client = new StdioAppServerClient(child);
  try {
    await client.initialize();
    return client;
  } catch (error) {
    await client.close();
    if (error instanceof ChatGptAppServerError) throw error;
    throw new ChatGptAppServerError(
      "The bundled ChatGPT login runtime could not be started.",
    );
  }
}

export async function readChatGptAccount(
  factory: ChatGptAppServerFactory = createChatGptAppServerSession,
  refreshToken = false,
): Promise<{ connected: boolean; email?: string; planType?: string }> {
  const session = await factory();
  try {
    const result = await session.request("account/read", { refreshToken });
    const account = recordValue(result, "account");
    if (!account || account.type !== "chatgpt") return { connected: false };
    return {
      connected: true,
      ...(typeof account.email === "string" ? { email: account.email } : {}),
      ...(typeof account.planType === "string"
        ? { planType: account.planType }
        : {}),
    };
  } finally {
    await session.close();
  }
}

export async function logoutChatGptAccount(
  factory: ChatGptAppServerFactory = createChatGptAppServerSession,
): Promise<void> {
  const session = await factory();
  try {
    await session.request("account/logout");
  } finally {
    await session.close();
  }
}

export async function listChatGptModels(
  factory: ChatGptAppServerFactory = createChatGptAppServerSession,
): Promise<ChatGptModelInfo[]> {
  const session = await factory();
  try {
    const models: ChatGptModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const result = await session.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      const page = asRecord(result);
      if (!page || !Array.isArray(page.data)) {
        throw new ChatGptAppServerError(
          "ChatGPT returned an invalid model catalog.",
        );
      }
      for (const candidate of page.data) {
        const model = asRecord(candidate);
        if (!model || typeof model.id !== "string" || !model.id) continue;
        models.push({
          id: model.id,
          displayName:
            typeof model.displayName === "string" && model.displayName
              ? model.displayName
              : model.id,
          ...(typeof model.description === "string" && model.description
            ? { description: model.description }
            : {}),
          ...(Array.isArray(model.inputModalities)
            ? {
                inputModalities: model.inputModalities.filter(
                  (value): value is string => typeof value === "string",
                ),
              }
            : {}),
          ...(typeof model.isDefault === "boolean"
            ? { isDefault: model.isDefault }
            : {}),
        });
      }
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor);
    return models;
  } finally {
    await session.close();
  }
}

export function createChatGptModelAdapter(input: {
  modelId: string;
  factory?: ChatGptAppServerFactory;
}): ModelAdapter {
  const factory = input.factory ?? createChatGptAppServerSession;
  return {
    id: `chatgpt/${input.modelId}`,
    complete: (modelInput) =>
      completeChatGptTurn({
        modelId: input.modelId,
        modelInput,
        factory,
      }),
  };
}

async function completeChatGptTurn(input: {
  modelId: string;
  modelInput: ModelInput;
  factory: ChatGptAppServerFactory;
}): Promise<ModelOutput> {
  const session = await input.factory();
  let isolatedCwd: string;
  try {
    isolatedCwd = await mkdtemp(join(tmpdir(), "sparkwright-chatgpt-"));
  } catch (error) {
    await session.close();
    throw error;
  }
  const toolCalls: NonNullable<ModelOutput["toolCalls"]> = [];
  let message = "";
  let threadId: string | undefined;
  let turnId: string | undefined;
  let completedTurn: JsonRecord | undefined;
  let unsafeRuntimeItem: string | undefined;
  let usage: ModelOutput["usage"] | undefined;
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });

  const removeNotificationListener = session.onNotification((notification) => {
    const params = asRecord(notification.params);
    if (!params) return;
    if (notification.method === "item/agentMessage/delta") {
      if (
        matchesTurn(params, threadId, turnId) &&
        typeof params.delta === "string"
      ) {
        message += params.delta;
      }
      return;
    }
    if (notification.method === "rawResponse/completed") {
      if (!matchesTurn(params, threadId, turnId)) return;
      const reported = asRecord(params.usage);
      if (reported) usage = modelUsage(reported);
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      if (!matchesTurn(params, threadId, turnId)) return;
      const reported = recordValue(params, "tokenUsage");
      const last = recordValue(reported, "last");
      if (last) usage = modelUsage(last);
      return;
    }
    if (notification.method === "item/started") {
      const item = asRecord(params.item);
      const itemType = typeof item?.type === "string" ? item.type : undefined;
      if (
        itemType &&
        [
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "collabAgentToolCall",
          "webSearch",
        ].includes(itemType)
      ) {
        unsafeRuntimeItem = itemType;
        if (threadId && turnId) {
          void session
            .request("turn/interrupt", { threadId, turnId })
            .catch(() => undefined);
        }
      }
      return;
    }
    if (notification.method === "turn/completed") {
      if (!matchesTurn(params, threadId, turnId)) return;
      completedTurn = asRecord(params.turn);
      resolveCompleted();
      return;
    }
    if (
      notification.method === "error" &&
      matchesTurn(params, threadId, turnId)
    ) {
      rejectCompleted(
        new ChatGptAppServerError("The ChatGPT model turn failed."),
      );
    }
  });

  const removeRequestListener = session.onRequest(async (request) => {
    if (request.method !== "item/tool/call") {
      unsafeRuntimeItem = request.method;
      if (threadId && turnId) {
        void session
          .request("turn/interrupt", { threadId, turnId })
          .catch(() => undefined);
      }
      throw new ChatGptAppServerError(
        "SparkWright denied an App Server-owned tool request.",
      );
    }
    const params = asRecord(request.params);
    if (!params || typeof params.tool !== "string") {
      throw new ChatGptAppServerError("ChatGPT returned an invalid tool call.");
    }
    toolCalls.push({
      toolName: params.tool,
      arguments: params.arguments,
    });
    const requestedThreadId = stringValue(params.threadId) ?? threadId;
    const requestedTurnId = stringValue(params.turnId) ?? turnId;
    queueMicrotask(() => {
      if (requestedThreadId && requestedTurnId) {
        void session
          .request("turn/interrupt", {
            threadId: requestedThreadId,
            turnId: requestedTurnId,
          })
          .catch(() => undefined);
      }
    });
    return {
      contentItems: [
        {
          type: "inputText",
          text: "Tool execution is delegated to the SparkWright Core runtime.",
        },
      ],
      success: false,
    };
  });

  try {
    const threadResult = asRecord(
      await session.request(
        "thread/start",
        {
          model: input.modelId,
          cwd: isolatedCwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          config: {
            features: {
              apps: false,
              browser_use: false,
              browser_use_external: false,
              code_mode_host: false,
              computer_use: false,
              image_generation: false,
              in_app_browser: false,
              multi_agent: false,
              multi_agent_v2: false,
              plugins: false,
              shell_tool: false,
              unified_exec: false,
              workspace_dependencies: false,
            },
          },
          baseInstructions: baseInstructions(input.modelInput.prompt),
          developerInstructions:
            "You are the language-model transport inside SparkWright. Do not execute commands, edit files, browse the web, call MCP tools, create subagents, or use App Server-owned tools. You may only call the dynamic function tools supplied by SparkWright. Return the answer directly when no tool is needed.",
          dynamicTools: dynamicToolSpecs(input.modelInput.tools),
        },
        { signal: input.modelInput.abortSignal },
      ),
    );
    const thread = recordValue(threadResult, "thread");
    threadId = stringValue(thread?.id);
    if (!threadId) {
      throw new ChatGptAppServerError("ChatGPT did not create a model thread.");
    }
    const turnResult = asRecord(
      await session.request(
        "turn/start",
        {
          threadId,
          input: turnUserInput(input.modelInput.prompt),
          model: input.modelId,
          approvalPolicy: "never",
        },
        { signal: input.modelInput.abortSignal },
      ),
    );
    turnId = stringValue(recordValue(turnResult, "turn")?.id);
    if (!turnId) {
      throw new ChatGptAppServerError("ChatGPT did not start a model turn.");
    }
    await waitWithTimeout(completed, APP_SERVER_TURN_TIMEOUT_MS, () => {
      if (threadId && turnId) {
        void session
          .request("turn/interrupt", { threadId, turnId })
          .catch(() => undefined);
      }
    });
    if (unsafeRuntimeItem) {
      throw new ChatGptAppServerError(
        `SparkWright stopped an unsupported App Server action (${unsafeRuntimeItem}).`,
      );
    }
    if (!message) message = finalAgentMessage(completedTurn) ?? "";
    return {
      ...(message ? { message } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(usage ? { usage } : {}),
      stopReason:
        toolCalls.length > 0 ? "tool_use" : turnStopReason(completedTurn),
    };
  } finally {
    removeRequestListener();
    removeNotificationListener();
    await session.close();
    await rm(isolatedCwd, { recursive: true, force: true });
  }
}

class StdioAppServerClient implements ChatGptAppServerSession {
  private readonly pending = new Map<
    AppServerId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly notificationListeners = new Set<
    (notification: ChatGptAppServerNotification) => void
  >();
  private readonly requestListeners = new Set<
    (request: ChatGptAppServerRequest) => unknown | Promise<unknown>
  >();
  private nextId = 1;
  private closed = false;
  private stderrTail = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.receiveLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(
        -APP_SERVER_STDERR_TAIL_BYTES,
      );
    });
    child.once("error", () =>
      this.failAll("The ChatGPT runtime failed to start."),
    );
    child.once("exit", () => {
      if (!this.closed)
        this.failAll("The ChatGPT runtime stopped unexpectedly.");
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "sparkwright",
        title: "SparkWright",
        version: process.env.npm_package_version ?? "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new ChatGptAppServerError("The ChatGPT runtime is closed."),
      );
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? APP_SERVER_REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ChatGptAppServerError(`ChatGPT request "${method}" timed out.`),
        );
      }, timeoutMs);
      timer.unref?.();
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(
          new ChatGptAppServerError(
            `ChatGPT request "${method}" was cancelled.`,
          ),
        );
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          options.signal?.removeEventListener("abort", abort);
          resolve(value as T);
        },
        reject: (error) => {
          options.signal?.removeEventListener("abort", abort);
          reject(error);
        },
        timer,
      });
      try {
        this.send({ method, id, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new ChatGptAppServerError(
                "Could not write to the ChatGPT runtime.",
              ),
        );
      }
    });
  }

  onNotification(
    listener: (notification: ChatGptAppServerNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(
    listener: (request: ChatGptAppServerRequest) => unknown | Promise<unknown>,
  ): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll("The ChatGPT runtime was closed.");
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
  }

  private receiveLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > APP_SERVER_MAX_LINE_BYTES) {
      this.failAll("The ChatGPT runtime returned an oversized message.");
      void this.close();
      return;
    }
    let message: JsonRecord;
    try {
      const parsed = JSON.parse(line);
      if (!asRecord(parsed)) return;
      message = parsed;
    } catch {
      return;
    }
    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      ("result" in message || "error" in message)
    ) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(
          new ChatGptAppServerError(appServerErrorMessage(message.error)),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    if (typeof message.id === "number" || typeof message.id === "string") {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params }),
      });
      return;
    }
    const notification = {
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
    };
    for (const listener of this.notificationListeners) listener(notification);
  }

  private async handleServerRequest(
    request: ChatGptAppServerRequest,
  ): Promise<void> {
    const listener = [...this.requestListeners].at(-1);
    if (!listener) {
      this.send({
        id: request.id,
        error: {
          code: -32601,
          message: "SparkWright denied this server request.",
        },
      });
      return;
    }
    try {
      const result = await listener(request);
      this.send({ id: request.id, result: result ?? {} });
    } catch {
      this.send({
        id: request.id,
        error: {
          code: -32000,
          message: "SparkWright denied this server request.",
        },
      });
    }
  }

  private send(message: JsonRecord): void {
    if (this.closed || !this.child.stdin.writable) {
      throw new ChatGptAppServerError("The ChatGPT runtime is unavailable.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(message: string): void {
    const detail = this.stderrTail.trim();
    const error = new ChatGptAppServerError(
      detail && /not found|unsupported|invalid|failed/iu.test(detail)
        ? `${message} Check the SparkWright diagnostic log for runtime details.`
        : message,
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function dynamicToolSpecs(tools: readonly ToolDescriptor[]): JsonRecord[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: isJsonSchema(tool.inputSchema)
      ? tool.inputSchema
      : { type: "object", additionalProperties: true },
    ...(tool.loading?.defer ? { deferLoading: true } : {}),
  }));
}

function baseInstructions(
  prompt: readonly PromptMessage[] | undefined,
): string {
  return (prompt ?? [])
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n");
}

function turnUserInput(
  prompt: readonly PromptMessage[] | undefined,
): JsonRecord[] {
  const messages = (prompt ?? []).filter(
    (message) => message.role !== "system",
  );
  const transcript = messages
    .map((message) => `[${message.role}]\n${message.content}`)
    .join("\n\n");
  const final = messages.at(-1);
  const parts: JsonRecord[] = [
    {
      type: "text",
      text: transcript || final?.content || "Continue the task.",
      text_elements: [],
    },
  ];
  for (const part of final?.parts ?? []) {
    if (part.type !== "image") continue;
    const url =
      part.uri ??
      (part.data && part.mediaType
        ? `data:${part.mediaType};base64,${part.data}`
        : undefined);
    if (url) parts.push({ type: "image", url });
  }
  return parts;
}

function finalAgentMessage(turn: JsonRecord | undefined): string | undefined {
  if (!turn || !Array.isArray(turn.items)) return undefined;
  return turn.items
    .map(asRecord)
    .filter((item): item is JsonRecord => item?.type === "agentMessage")
    .map((item) => stringValue(item.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

function turnStopReason(
  turn: JsonRecord | undefined,
): ModelOutput["stopReason"] {
  if (!turn) return "unknown";
  if (turn.status === "completed") return "completed";
  const error = asRecord(turn.error);
  const info = error?.additionalDetails ?? error?.codexErrorInfo;
  return info === "contextWindowExceeded" ? "max_output_tokens" : "error";
}

function matchesTurn(
  params: JsonRecord,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean {
  return (
    (!threadId || params.threadId === threadId) &&
    (!turnId ||
      params.turnId === turnId ||
      recordValue(params, "turn")?.id === turnId)
  );
}

function waitWithTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new ChatGptAppServerError("The ChatGPT model turn timed out."));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function appServerErrorMessage(error: unknown): string {
  const record = asRecord(error);
  const message = stringValue(record?.message);
  if (message && /unauthorized|login|auth/iu.test(message)) {
    return "ChatGPT authentication is required or has expired.";
  }
  if (message && /model/iu.test(message)) {
    return "The selected ChatGPT model is unavailable for this account.";
  }
  return "The ChatGPT runtime rejected the request.";
}

function recordValue(value: unknown, key: string): JsonRecord | undefined {
  return asRecord(asRecord(value)?.[key]);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function modelUsage(reported: JsonRecord): NonNullable<ModelOutput["usage"]> {
  return {
    inputTokens: numberValue(reported.inputTokens),
    outputTokens: numberValue(reported.outputTokens),
    totalTokens: numberValue(reported.totalTokens),
    cacheReadTokens: numberValue(reported.cachedInputTokens),
    cacheCreationTokens: numberValue(reported.cacheWriteInputTokens),
    costStatus: "unavailable",
    costUnavailableReason: "missing_pricing",
  };
}

function appServerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name]) =>
        !/(?:^|_)(?:API_KEY|ACCESS_KEY|AUTH_TOKEN|CREDENTIAL|PASSWORD|SECRET|TOKEN)(?:$|_)/iu.test(
          name,
        ),
    ),
  );
}

function isJsonSchema(value: unknown): value is JsonRecord {
  return asRecord(value) !== undefined;
}

export const CHATGPT_APP_SERVER_RUNTIME_ID = CHATGPT_RUNTIME_ID;
