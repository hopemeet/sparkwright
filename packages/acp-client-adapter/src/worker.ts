import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type ContentBlock,
  type PermissionOptionId,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  defineTool,
  type RuntimeContext,
  type ToolDefinition,
} from "@sparkwright/core";

export interface ExternalAcpWorkerCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional invocation cleanup (for example a generated OS sandbox profile). */
  cleanup?: () => Promise<void>;
}

export interface ExternalAcpWorkerRunInput {
  goal: string;
  cwd: string;
  metadata?: Record<string, unknown>;
}

export interface ExternalAcpWorkerRunResult {
  sessionId: string;
  stopReason: PromptResponse["stopReason"];
  text: string;
  updates: SessionNotification[];
  toolCallCount: number;
  metadata: Record<string, unknown>;
}

export interface ExternalAcpWorkerOptions extends ExternalAcpWorkerCommand {
  name?: string;
  timeoutMs?: number;
  permission?: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
}

export interface ExternalAcpWorkerToolOptions {
  name?: string;
  description?: string;
  worker: ExternalAcpWorkerOptions;
  cwd?: string | ((ctx: RuntimeContext) => string | undefined);
  timeoutMs?: number;
}

export interface ExternalAcpWorkerToolInput {
  goal: string;
  metadata?: Record<string, unknown>;
}

export class ExternalAcpWorker {
  constructor(private readonly options: ExternalAcpWorkerOptions) {}

  async run(
    input: ExternalAcpWorkerRunInput,
  ): Promise<ExternalAcpWorkerRunResult> {
    const child = spawnWorker(this.options);
    const childFailure = monitorChildFailure(child, this.options.command);
    const updates: SessionNotification[] = [];
    const client: Client = {
      requestPermission: (request) =>
        Promise.resolve(
          this.options.permission?.(request) ?? rejectPermission(request),
        ),
      sessionUpdate(params) {
        updates.push(params);
        return Promise.resolve();
      },
    };
    const connection = new ClientSideConnection(
      () => client,
      ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      ),
    );
    const timeout = createTimeout(this.options.timeoutMs);
    try {
      const run = runWithAbort(timeout.signal, async () => {
        await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "SparkWright", version: "0.1.0" },
        });
        const session = await connection.newSession({
          cwd: input.cwd,
          mcpServers: [],
        });
        const response = await connection.prompt({
          sessionId: session.sessionId,
          prompt: runInputToContent(input),
        });
        await connection
          .closeSession({ sessionId: session.sessionId })
          .catch(() => {});
        return summarizeRun({
          sessionId: session.sessionId,
          response,
          updates,
          metadata: input.metadata ?? {},
        });
      });
      return await Promise.race([run, childFailure]);
    } finally {
      timeout.dispose();
      terminateWorker(child);
      await this.options.cleanup?.();
    }
  }
}

export function createExternalAcpWorkerTool(
  options: ExternalAcpWorkerToolOptions,
): ToolDefinition<ExternalAcpWorkerToolInput, ExternalAcpWorkerRunResult> {
  const name = options.name ?? "external_acp_worker";
  const description =
    options.description ??
    "Delegate a bounded coding task to an external ACP-compatible agent worker.";
  const worker = new ExternalAcpWorker({
    ...options.worker,
    timeoutMs: options.timeoutMs ?? options.worker.timeoutMs,
  });

  return defineTool({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "Sub-task to send to the external ACP worker.",
        },
        metadata: {
          type: "object",
          description: "Optional metadata for audit and worker context.",
        },
      },
      required: ["goal"],
      additionalProperties: false,
    },
    policy: { risk: "risky", requiresApproval: true },
    governance: {
      sideEffects: ["external"],
      idempotency: "non_idempotent",
      origin: {
        kind: "hosted",
        name: options.worker.name ?? options.worker.command,
        metadata: {
          protocol: "acp",
          command: options.worker.command,
          args: options.worker.args ?? [],
        },
      },
    },
    async execute(args, ctx) {
      const cwd = resolveToolCwd(options.cwd, ctx);
      if (!cwd) {
        throw new Error(
          `External ACP worker tool "${name}" requires a workspace cwd.`,
        );
      }
      return worker.run({
        goal: args.goal,
        cwd,
        metadata: args.metadata,
      });
    },
  });
}

function spawnWorker(options: ExternalAcpWorkerCommand): ChildProcess {
  return spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "ignore"],
  });
}

function monitorChildFailure(
  child: ChildProcess,
  command: string,
): Promise<never> {
  return new Promise((_resolve, reject) => {
    child.once("error", (error) => {
      reject(
        new Error(
          `External ACP worker "${command}" failed to start: ${error.message}`,
        ),
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) return;
      reject(
        new Error(
          `External ACP worker "${command}" exited before completing the run (${exitStatus(
            code,
            signal,
          )}).`,
        ),
      );
    });
  });
}

function runInputToContent(input: ExternalAcpWorkerRunInput): ContentBlock[] {
  const metadata =
    input.metadata && Object.keys(input.metadata).length > 0
      ? `\n\nMetadata:\n${JSON.stringify(input.metadata, null, 2)}`
      : "";
  return [{ type: "text", text: `${input.goal}${metadata}` }];
}

function summarizeRun(input: {
  sessionId: string;
  response: PromptResponse;
  updates: SessionNotification[];
  metadata: Record<string, unknown>;
}): ExternalAcpWorkerRunResult {
  return {
    sessionId: input.sessionId,
    stopReason: input.response.stopReason,
    text: collectText(input.updates),
    updates: input.updates,
    toolCallCount: input.updates.filter(
      (update) => update.update.sessionUpdate === "tool_call",
    ).length,
    metadata: input.metadata,
  };
}

function collectText(updates: SessionNotification[]): string {
  return updates
    .flatMap((update) => {
      const payload = update.update;
      if (
        payload.sessionUpdate !== "agent_message_chunk" ||
        payload.content.type !== "text"
      ) {
        return [];
      }
      return [payload.content.text];
    })
    .join("");
}

function rejectPermission(
  request: RequestPermissionRequest,
): RequestPermissionResponse {
  const reject =
    request.options.find((option) => option.kind.startsWith("reject"))
      ?.optionId ?? request.options.at(-1)?.optionId;
  return {
    outcome: reject
      ? { outcome: "selected", optionId: reject as PermissionOptionId }
      : { outcome: "cancelled" },
  };
}

function createTimeout(timeoutMs: number | undefined): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal: controller.signal, dispose() {} };
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
    },
  };
}

async function runWithAbort<T>(
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new Error("External ACP worker timed out.");
  return Promise.race([
    fn(),
    new Promise<T>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("External ACP worker timed out.")),
        { once: true },
      );
    }),
  ]);
}

function terminateWorker(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
}

function exitStatus(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (signal) return `signal ${signal}`;
  return `code ${code ?? "unknown"}`;
}

function resolveToolCwd(
  cwd: ExternalAcpWorkerToolOptions["cwd"],
  ctx: RuntimeContext,
): string | undefined {
  if (typeof cwd === "function") return cwd(ctx);
  if (cwd) return cwd;
  return stringMetadata(ctx.run.metadata.workspaceRoot);
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
