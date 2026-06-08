import {
  createPermissionModePolicy,
  createRun,
  createSessionRunStoreFactory,
  defineTool,
  FileSessionStore,
  type ContextItem,
  type ModelAdapter,
  type PermissionMode,
  type SparkwrightEvent,
  type TraceLevel,
} from "@sparkwright/core";
import {
  createSessionFileRunStoreFactory,
  FileRunStore,
  LocalWorkspace,
  MemoryTrace,
} from "@sparkwright/core/internal";
import {
  applyToolConfig,
  buildConfiguredAdapter,
  DETERMINISTIC_PROVIDER,
  loadHostConfig,
  resolveModelSelection,
} from "@sparkwright/host";
import { buildAgentPromptBuilder } from "@sparkwright/project-context";
import { createCliApprovalResolver } from "../cli-approval.js";
import { formatEvent } from "../event-format.js";
import type { CliIO } from "../io.js";
import { writeLine } from "../io.js";

export interface DirectCoreRunInput {
  goal: string;
  traceLevel: TraceLevel;
  workspaceRoot: string;
  sessionRootDir: string;
  targetPath: string;
  shouldWrite: boolean;
  approveAll: boolean;
  permissionMode: PermissionMode;
  modelName?: string;
  sessionId: string;
  contextItems?: ContextItem[];
}

export interface DirectCoreRunResult {
  exitCode: number;
  tracePath?: string;
  sessionId?: string;
  runState?: string;
  stopReason?: string;
}

export async function startDirectCoreRun(
  parsed: DirectCoreRunInput,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<DirectCoreRunResult> {
  const {
    goal,
    traceLevel,
    workspaceRoot,
    sessionRootDir,
    targetPath,
    shouldWrite,
    approveAll,
    permissionMode,
    modelName,
    sessionId,
  } = parsed;
  const model = await createCliModel({
    modelRef: modelName,
    cwd: workspaceRoot,
    env,
    targetPath,
    shouldWrite,
    goal,
  });

  if (!model.ok) {
    writeLine(io.stderr, model.message);
    return { exitCode: 1 };
  }

  const workspace = new LocalWorkspace(workspaceRoot);
  const approvalResolver = createCliApprovalResolver({ approveAll, io });
  const policy = createPermissionModePolicy({ mode: permissionMode });
  const tools = await createConfiguredCliTools(workspaceRoot, env);
  const trace = new MemoryTrace();
  const sessionStore = new FileSessionStore({ rootDir: sessionRootDir });

  // The agent's identity. Edit this string to change who the CLI agent is.
  const appPrompt =
    "You are the SparkWright CLI agent. You help the user accomplish tasks in their current workspace by reading files and making focused edits. Work directly and verify your changes.";

  let store: FileRunStore | undefined;
  const run = createRun({
    goal,
    workspace,
    approvalResolver,
    policy,
    promptBuilder: buildAgentPromptBuilder({
      cwd: workspaceRoot,
      appPrompt,
      platform: process.platform,
    }),
    tools,
    model: model.adapter,
    context: parsed.contextItems ?? [],
    runStore: createSessionRunStoreFactory({
      sessionStore,
      sessionId,
      runStoreFactory: (record) => {
        const factory = createSessionFileRunStoreFactory({
          sessionRootDir,
          sessionId,
          agentId: "main",
          traceLevel,
        });
        store = factory(record);
        return store;
      },
      metadata: {
        source: "cli",
      },
    }),
  });

  let writeCompletedCount = 0;
  let writeSkippedCount = 0;
  let writeDeniedCount = 0;

  function recordEvent(event: SparkwrightEvent) {
    trace.append(event);
    if (event.type === "workspace.write.completed") writeCompletedCount += 1;
    else if (event.type === "workspace.write.skipped") writeSkippedCount += 1;
    else if (event.type === "workspace.write.denied") writeDeniedCount += 1;
    writeLine(io.stdout, formatEvent(event));
  }

  for (const event of run.events.all()) {
    recordEvent(event);
  }

  run.events.subscribe(recordEvent);

  try {
    const result = await run.start();
    return {
      exitCode: 0,
      tracePath: store?.tracePath,
      sessionId,
      runState: result.state,
      stopReason: result.stopReason,
    };
  } finally {
    writeLine(
      io.stdout,
      `Run ${run.record.state}${run.record.stopReason ? ` (${run.record.stopReason})` : ""}`,
    );
    writeLine(
      io.stdout,
      summarizeWorkspaceMutations({
        shouldWrite,
        completed: writeCompletedCount,
        skipped: writeSkippedCount,
        denied: writeDeniedCount,
      }),
    );
    if (store) writeLine(io.stdout, `Trace written to ${store.tracePath}`);
  }
}

export async function createConfiguredCliTools(
  workspaceRoot: string,
  env: Record<string, string | undefined>,
) {
  const cfg = await loadHostConfig(workspaceRoot, env);
  return applyToolConfig(
    [createReadFileTool(), createAppendFileTool()],
    cfg.config.capabilities?.tools,
  );
}

export async function createCliModel(input: {
  modelRef?: string;
  cwd: string;
  env: Record<string, string | undefined>;
  targetPath: string;
  shouldWrite: boolean;
  goal: string;
}): Promise<
  { ok: true; adapter: ModelAdapter } | { ok: false; message: string }
> {
  const ref = input.modelRef ?? DETERMINISTIC_PROVIDER;
  if (ref === DETERMINISTIC_PROVIDER) {
    return {
      ok: true,
      adapter: createDeterministicModel({
        targetPath: input.targetPath,
        shouldWrite: input.shouldWrite,
        goal: input.goal,
      }),
    };
  }

  const cfg = await loadHostConfig(input.cwd, input.env);
  const selection = resolveModelSelection(cfg.config, ref);
  if (selection.kind === "deterministic") {
    return {
      ok: true,
      adapter: createDeterministicModel({
        targetPath: input.targetPath,
        shouldWrite: input.shouldWrite,
        goal: input.goal,
      }),
    };
  }
  if (selection.kind === "error") {
    return { ok: false, message: selection.message };
  }

  const proxyFetch = await createProxyFetch(resolveProxyUrl(input.env));
  return buildConfiguredAdapter({
    selection,
    env: input.env,
    fetch: proxyFetch,
  });
}

function summarizeWorkspaceMutations(input: {
  shouldWrite: boolean;
  completed: number;
  skipped: number;
  denied: number;
}): string {
  const { shouldWrite, completed, skipped, denied } = input;
  if (completed === 0 && skipped === 0 && denied === 0) {
    return shouldWrite
      ? "No workspace changes were made (no write was attempted)."
      : "No workspace changes were made (read-only run).";
  }
  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} applied`);
  if (skipped > 0) parts.push(`${skipped} skipped (no-op)`);
  if (denied > 0) parts.push(`${denied} denied`);
  return `Workspace writes: ${parts.join(", ")}.`;
}

function resolveProxyUrl(
  env: Record<string, string | undefined>,
): string | undefined {
  return env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
}

async function createProxyFetch(
  proxyUrl: string | undefined,
): Promise<typeof fetch | undefined> {
  if (!proxyUrl) return undefined;

  const { fetch: undiciFetch, ProxyAgent } = await import("undici");
  const dispatcher = new ProxyAgent(proxyUrl);
  const proxiedFetch = undiciFetch as unknown as typeof fetch;

  return (url, init) =>
    proxiedFetch(url, {
      ...init,
      dispatcher,
    } as RequestInit & { dispatcher: typeof dispatcher });
}

function createDeterministicModel(input: {
  targetPath: string;
  shouldWrite: boolean;
  goal: string;
}): ModelAdapter {
  let modelCalls = 0;

  return {
    async complete(modelInput) {
      modelCalls += 1;

      if (modelCalls === 1) {
        return {
          message: `Reading ${input.targetPath}.`,
          toolCalls: [
            {
              toolName: "read_file",
              arguments: { path: input.targetPath },
            },
          ],
        };
      }

      if (modelCalls === 2 && input.shouldWrite) {
        return {
          message: `Appending a golden-path section to ${input.targetPath}.`,
          toolCalls: [
            {
              toolName: "append_file",
              arguments: {
                path: input.targetPath,
                heading: "Sparkwright CLI Golden Path",
                body: `This section was added by Sparkwright while running the goal: "${input.goal}".`,
              },
            },
          ],
        };
      }

      return {
        message: input.shouldWrite
          ? formatDeterministicWriteSummary(input.targetPath, modelInput.events)
          : `Read ${input.targetPath}. Re-run with --write to exercise approval-gated workspace mutation.`,
      };
    },
  };
}

function formatDeterministicWriteSummary(
  targetPath: string,
  events: SparkwrightEvent[],
): string {
  if (events.some((event) => event.type === "workspace.write.denied")) {
    return `Write was not applied for ${targetPath} because approval was denied.`;
  }
  if (events.some((event) => event.type === "tool.failed")) {
    return `Write was not applied for ${targetPath} because the write tool failed.`;
  }
  if (events.some((event) => event.type === "workspace.write.skipped")) {
    return `No workspace change was needed for ${targetPath}; the deterministic section was already present.`;
  }
  return `Completed approval-gated write path for ${targetPath}.`;
}

function createReadFileTool() {
  return defineTool({
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    policy: { risk: "safe" },
    async execute(args: unknown, ctx) {
      if (!ctx.workspace) throw new Error("Workspace is not configured.");
      const input = args as { path: string };
      const content = await ctx.workspace.readText(input.path);
      const anchored = await ctx.workspace.readAnchoredText(input.path);
      return {
        path: input.path,
        content,
        anchoredContent: anchored.content,
        anchors: anchored.lines.map((line) => ({
          line: line.line,
          anchor: line.anchor,
        })),
      };
    },
  });
}

function createAppendFileTool() {
  return defineTool({
    name: "append_file",
    description:
      "Append a short generated section to a UTF-8 text file in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        heading: { type: "string" },
        body: { type: "string" },
      },
      required: ["path", "heading", "body"],
    },
    policy: { risk: "safe" },
    async execute(args: unknown, ctx) {
      if (!ctx.workspace) throw new Error("Workspace is not configured.");
      const input = args as { path: string; heading: string; body: string };
      const current = await ctx.workspace.readText(input.path);
      const section = `\n\n## ${input.heading}\n\n${input.body}\n`;
      if (current.includes(`## ${input.heading}`)) {
        ctx.reportWorkspaceWriteSkipped?.({
          path: input.path,
          reason: `Heading "${input.heading}" already present`,
        });
        return {
          path: input.path,
          changed: false,
        };
      }

      const anchored = await ctx.workspace.readAnchoredText(input.path);
      const lastLine = anchored.lines.at(-1);
      if (!lastLine) {
        const write = await ctx.workspace.writeText(
          input.path,
          section.trimStart(),
          {
            reason: `Append ${input.heading}`,
          },
        );
        if (write?.diffArtifact) ctx.reportToolArtifact?.(write.diffArtifact);
        return {
          path: input.path,
          changed: true,
          diffArtifactId: write?.diffArtifactId,
          writeSummary: write?.summary,
        };
      }

      const result = await ctx.workspace.editAnchoredText(
        input.path,
        [
          {
            op: "append",
            anchor: lastLine.anchor,
            lines: ["", `## ${input.heading}`, "", input.body],
          },
        ],
        {
          reason: `Append ${input.heading}`,
        },
      );
      if (result.write?.diffArtifact) {
        ctx.reportToolArtifact?.(result.write.diffArtifact);
      }
      return {
        path: input.path,
        changed: result.content !== current,
        diffArtifactId: result.write?.diffArtifactId,
        writeSummary: result.write?.summary,
        finalLines: result.write?.summary.lastLines,
      };
    },
  });
}
