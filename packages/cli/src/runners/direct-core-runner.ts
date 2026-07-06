import {
  createPermissionModePolicy,
  createLayeredPolicy,
  createRun,
  createSessionRunStoreFactory,
  createWorkspaceMutationPolicy,
  createWorkspaceReadScopePolicy,
  resolveRunConfidentialPaths,
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
  buildConfiguredAdapter,
  catalogToolDefinitions,
  createCliDiagnosticToolCatalog,
  createDocumentedCommandWorkflowHooks,
  bindConfiguredEventHooks,
  createConfiguredWorkflowHooks,
  DETERMINISTIC_PROVIDER,
  loadHostConfig,
  resolveSkillRootsForRuntime,
  resolveModelSelection,
} from "@sparkwright/host";
import { buildAgentPromptBuilder } from "@sparkwright/project-context";
import { createCliApprovalResolver } from "../cli-approval.js";
import { createLiveEventFormatter } from "../event-format.js";
import type { CliIO } from "../io.js";
import { writeLine } from "../io.js";
import {
  cliExitCodeForRun,
  completedRunHasCliIssues,
  createCliRunEventSummary,
  summarizeDeniedWorkspaceWrites,
  summarizeDocumentedCommandFailures,
  summarizeRunFailure,
  summarizeUnhandledToolFailures,
  summarizeUnsupportedFinalClaims,
  summarizeVerificationCommandFailures,
  summarizeVerificationProfileResults,
  summarizeWorkspaceMutations,
  updateCliRunEventSummary,
} from "../run-outcome.js";

export interface DirectCoreRunInput {
  goal: string;
  traceLevel: TraceLevel;
  workspaceRoot: string;
  sessionRootDir: string;
  targetPath: string;
  confidentialPaths?: readonly string[];
  confidentialDefaults?: boolean;
  shouldWrite: boolean;
  approveAll: boolean;
  approveEdits?: boolean;
  approveShellSafe?: boolean;
  permissionMode: PermissionMode;
  modelName?: string;
  sessionId: string;
  contextItems?: ContextItem[];
  verbose?: boolean;
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
    confidentialPaths,
    confidentialDefaults,
    shouldWrite,
    approveAll,
    approveEdits,
    approveShellSafe,
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
  const approvalResolver = createCliApprovalResolver({
    approveAll,
    approveEdits,
    approveShellSafe,
    permissionMode,
    io,
  });
  const loadedConfig = await loadHostConfig(workspaceRoot, env);
  // Config write guardrails override the direct-core defaults (single file, no
  // deletions). loadHostConfig has already merged them conservatively.
  const writeGuardrails = loadedConfig.config.write;
  const policy = createLayeredPolicy([
    createPermissionModePolicy({ mode: permissionMode }),
    createWorkspaceMutationPolicy({
      allowWorkspaceWrites: shouldWrite,
      allowedPaths: [targetPath],
      maxWriteFiles: writeGuardrails?.maxFiles ?? 1,
      maxDiffLines: writeGuardrails?.maxDiffLines ?? 200,
      allowDeletions: writeGuardrails?.allowDeletions ?? false,
    }),
    createWorkspaceReadScopePolicy({
      confidentialPaths: resolveRunConfidentialPaths({
        confidentialDefaults,
        confidentialPaths,
      }),
    }),
  ]);
  const tools = await createConfiguredCliTools(workspaceRoot, env);
  const skillRoots = resolveSkillRootsForRuntime(
    workspaceRoot,
    loadedConfig.config.capabilities?.skills?.roots,
    env,
  );
  const documentedCommandHooks = createDocumentedCommandWorkflowHooks({
    workspaceRoot,
    goal,
    shouldWrite,
  });
  const workflowHooks = createConfiguredWorkflowHooks({
    hooks: loadedConfig.config.capabilities?.hooks?.workflow,
    workspaceRoot,
    env,
    sandbox: loadedConfig.config.shell?.sandbox,
    skillRoots: skillRoots.map((root) => root.root),
    configPaths: loadedConfig.attempted.map((entry) => entry.path),
  }).concat(documentedCommandHooks);
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
    workflowHooks,
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

  const eventSummary = createCliRunEventSummary();
  const liveEvents = createLiveEventFormatter({ verbose: parsed.verbose });

  function recordEvent(event: SparkwrightEvent) {
    trace.append(event);
    updateCliRunEventSummary(eventSummary, event);
    for (const line of liveEvents.format(event)) writeLine(io.stdout, line);
  }

  for (const event of run.events.all()) {
    recordEvent(event);
  }

  run.events.subscribe(recordEvent);
  const closeEventHooks = bindConfiguredEventHooks({
    hooks: loadedConfig.config.capabilities?.hooks?.events,
    run,
    workspaceRoot,
    env,
    sandbox: loadedConfig.config.shell?.sandbox,
    skillRoots: skillRoots.map((root) => root.root),
    configPaths: loadedConfig.attempted.map((entry) => entry.path),
    getRun: () => run,
  });

  try {
    const result = await run.start();
    for (const line of liveEvents.flush()) writeLine(io.stdout, line);
    const runFailureSummary = summarizeRunFailure(eventSummary, {
      state: result.state,
      stopReason: result.stopReason,
    });
    if (runFailureSummary) writeLine(io.stderr, runFailureSummary);
    const verificationSummary =
      summarizeVerificationCommandFailures(eventSummary);
    if (verificationSummary) writeLine(io.stderr, verificationSummary);
    const documentedCommandSummary =
      summarizeDocumentedCommandFailures(eventSummary);
    if (documentedCommandSummary)
      writeLine(io.stderr, documentedCommandSummary);
    const unsupportedClaimSummary =
      summarizeUnsupportedFinalClaims(eventSummary);
    if (unsupportedClaimSummary) writeLine(io.stderr, unsupportedClaimSummary);
    const deniedWriteSummary = summarizeDeniedWorkspaceWrites(eventSummary);
    if (deniedWriteSummary) writeLine(io.stderr, deniedWriteSummary);
    const failureSummary = summarizeUnhandledToolFailures(eventSummary);
    if (failureSummary) writeLine(io.stderr, failureSummary);
    const exitCode = cliExitCodeForRun({
      runState: result.state,
      events: eventSummary,
    });
    return {
      exitCode,
      tracePath: store?.tracePath,
      sessionId,
      runState: result.state,
      stopReason: result.stopReason,
    };
  } finally {
    closeEventHooks();
    const displayState =
      run.record.state === "completed" && completedRunHasCliIssues(eventSummary)
        ? "completed_with_issues"
        : run.record.state;
    writeLine(
      io.stdout,
      `Run ${displayState}${run.record.stopReason ? ` (${run.record.stopReason})` : ""}`,
    );
    writeLine(
      io.stdout,
      summarizeWorkspaceMutations({
        shouldWrite,
        completed: eventSummary.writeCompleted,
        skipped: eventSummary.writeSkipped,
        denied: eventSummary.writeDenied,
        capabilityMutations: eventSummary.capabilityMutationCompleted,
        mcpWorkspaceCwdServers: eventSummary.mcpWorkspaceCwdServers,
        subagentWrites: eventSummary.subagentWriteCompleted,
        toolReportedChanges: eventSummary.toolReportedChanges,
        untrackedWriteCapableProcesses:
          eventSummary.untrackedWriteCapableProcesses,
      }),
    );
    const verificationProfileSummary =
      summarizeVerificationProfileResults(eventSummary);
    if (verificationProfileSummary)
      writeLine(io.stdout, verificationProfileSummary);
    if (store) writeLine(io.stdout, `Trace written to ${store.tracePath}`);
  }
}

export async function createConfiguredCliTools(
  workspaceRoot: string,
  env: Record<string, string | undefined>,
) {
  const cfg = await loadHostConfig(workspaceRoot, env);
  return catalogToolDefinitions(
    createCliDiagnosticToolCatalog({
      workspaceRoot,
      toolConfig: cfg.config.tools,
    }),
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
  const heading = "Sparkwright CLI Golden Path";
  const body = `This section was added by Sparkwright while running the goal: "${input.goal}".`;

  return {
    async complete(modelInput) {
      modelCalls += 1;

      if (modelCalls === 1) {
        return {
          message: `Reading ${input.targetPath}.`,
          toolCalls: [
            {
              toolName: "read",
              arguments: { path: input.targetPath },
            },
          ],
        };
      }

      if (modelCalls === 2 && input.shouldWrite) {
        if (hasDeterministicSection(modelInput.events, heading)) {
          return {
            message: formatDeterministicWriteSummary(
              input.targetPath,
              modelInput.events,
            ),
          };
        }

        return {
          message: `Reading anchors for ${input.targetPath}.`,
          toolCalls: [
            {
              toolName: "read_anchored_text",
              arguments: { path: input.targetPath },
            },
          ],
        };
      }

      if (modelCalls === 3 && input.shouldWrite) {
        const lastLine = latestAnchoredLine(modelInput.events);
        return {
          message: `Appending a golden-path section to ${input.targetPath}.`,
          toolCalls: [
            lastLine
              ? {
                  toolName: "edit_anchored_text",
                  arguments: {
                    path: input.targetPath,
                    edits: [
                      {
                        op: "append",
                        anchor: lastLine.anchor,
                        lines: ["", `## ${heading}`, "", body],
                      },
                    ],
                    reason: `Append ${heading}`,
                  },
                }
              : {
                  toolName: "write",
                  arguments: {
                    path: input.targetPath,
                    content: `## ${heading}\n\n${body}\n`,
                    reason: `Create ${heading}`,
                  },
                },
          ],
        };
      }

      return {
        message: input.shouldWrite
          ? formatDeterministicWriteSummary(input.targetPath, modelInput.events)
          : formatDeterministicReadSummary(input.targetPath, modelInput.events),
      };
    },
  };
}

function formatDeterministicReadSummary(
  targetPath: string,
  events: SparkwrightEvent[],
): string {
  const failure = [...events]
    .reverse()
    .find((event) => event.type === "tool.failed");
  if (failure) {
    return `Could not read ${targetPath}: ${formatToolFailure(failure)}.`;
  }
  return `Read ${targetPath}. Re-run with --write to exercise approval-gated workspace mutation.`;
}

function formatDeterministicWriteSummary(
  targetPath: string,
  events: SparkwrightEvent[],
): string {
  if (events.some((event) => event.type === "workspace.write.denied")) {
    return `Write was not applied for ${targetPath} because approval was denied.`;
  }
  if (events.some((event) => event.type === "tool.failed")) {
    const failure = [...events]
      .reverse()
      .find((event) => event.type === "tool.failed");
    return `Write was not applied for ${targetPath} because the write tool failed: ${failure ? formatToolFailure(failure) : "unknown error"}.`;
  }
  if (events.some((event) => event.type === "workspace.write.skipped")) {
    return `No workspace change was needed for ${targetPath}; the deterministic section was already present.`;
  }
  if (hasDeterministicSection(events, "Sparkwright CLI Golden Path")) {
    return `No workspace change was needed for ${targetPath}; the deterministic section was already present.`;
  }
  return `Completed approval-gated write path for ${targetPath}.`;
}

function formatToolFailure(event: SparkwrightEvent): string {
  const payload = event.payload as {
    error?: { code?: string; message?: string };
  };
  const code = payload.error?.code;
  const message = payload.error?.message;
  if (code && message) return `${code}: ${message}`;
  return message ?? code ?? "tool failed";
}

function latestToolOutput<T>(
  events: SparkwrightEvent[],
  toolName: string,
): T | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "tool.completed") continue;
    const payload = event.payload as {
      toolName?: string;
      output?: unknown;
    };
    if (payload.toolName === toolName) return payload.output as T;
  }
  return undefined;
}

function hasDeterministicSection(
  events: SparkwrightEvent[],
  heading: string,
): boolean {
  const read = latestToolOutput<{ content?: string }>(events, "read");
  return typeof read?.content === "string" && read.content.includes(heading);
}

function latestAnchoredLine(
  events: SparkwrightEvent[],
): { anchor: string } | undefined {
  const anchored = latestToolOutput<{
    lines?: Array<{ anchor?: string }>;
  }>(events, "read_anchored_text");
  const last = anchored?.lines?.at(-1);
  return typeof last?.anchor === "string" ? { anchor: last.anchor } : undefined;
}
