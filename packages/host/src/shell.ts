import { spawn } from "node:child_process";
import type { TaskManager } from "@sparkwright/agent-runtime";
import { createBufferedEmitter, openSpan } from "@sparkwright/core";
import {
  createShellTool,
  evaluateShellSafety,
  parseCommand,
  RECOMMENDED_FOREGROUND_TIMEOUT_MS,
  type ShellBackgroundHandoffHandler,
  type ShellTaskLifetime,
} from "@sparkwright/shell-tool";
import {
  ShellSandboxExecutor,
  createPlatformShellSandboxRuntime,
  describeShellSandboxStatus,
  resolveShellSandboxConfig,
  type ResolvedShellSandboxConfig,
  type ShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import type {
  BackgroundTaskPolicy,
  EventEmitter,
  ExecutionEnvironment,
  LiveShellHandle,
  ProcessOutputSummary,
  RunId,
  ShellExecutionRequest,
  ShellExecutionResult,
  ShellStreamingResult,
  ToolDefinition,
} from "@sparkwright/core";
import type { ShellToolInput, ShellToolOutput } from "@sparkwright/shell-tool";
import { TracedProcessRunner } from "./traced-process-runner.js";
import {
  diffWorkspaceSnapshots,
  isManagedCapabilityPath,
  rollbackWorkspaceSnapshot,
  snapshotWorkspace,
  type WorkspaceMutationChange,
  type WorkspaceRollbackResult,
} from "./workspace-snapshot.js";

const SHELL_BACKGROUND_KIND = "shell.background";
const LEGACY_PROMOTED_SHELL_KIND = "shell.promoted";

class LiveOutputBuffer {
  private readonly chunks: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  private subscriptions = 0;

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  text(): string {
    return this.chunks.join("");
  }

  async *stream(): AsyncIterable<string> {
    const start = this.subscriptions === 0 ? 0 : this.chunks.length;
    this.subscriptions += 1;
    let index = start;
    while (true) {
      while (index < this.chunks.length) {
        yield this.chunks[index++]!;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

/**
 * Spawn `request` under `bash -c <rawCommand>` so the model gets real shell
 * semantics (pipes, globs, redirects) rather than a single argv exec. The
 * safety classifier in `@sparkwright/shell-tool` has already vetted the
 * command, and core's policy layer gates it behind approval, so this executor
 * stays thin.
 */
function spawnStreaming(request: ShellExecutionRequest): ShellStreamingResult {
  const startedAt = new Date().toISOString();
  const raw =
    typeof request.metadata?.rawCommand === "string"
      ? (request.metadata.rawCommand as string)
      : [request.command, ...(request.args ?? [])].join(" ");
  const stdout = new LiveOutputBuffer();
  const stderr = new LiveOutputBuffer();

  const child = spawn("bash", ["-c", raw], {
    cwd: request.cwd,
    env: shellEnv(request.env),
  });

  let timedOut = false;
  const timeoutMs = request.timeoutMs;
  const timer =
    typeof timeoutMs === "number"
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs)
      : undefined;

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });

  const completed = new Promise<ShellExecutionResult>((resolve) => {
    const finish = (
      status: ShellExecutionResult["status"],
      exitCode: number | null,
      errorStderr = "",
    ): void => {
      if (timer) clearTimeout(timer);
      stdout.close();
      stderr.close();
      resolve({
        status,
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text() || errorStderr,
        startedAt,
        completedAt: new Date().toISOString(),
        metadata: { ...(request.metadata ?? {}), timedOut, pid: child.pid },
      });
    };
    child.on("error", (err) => finish("failed", null, String(err)));
    child.on("close", (code) =>
      finish(code === 0 ? "completed" : "failed", code),
    );
  });

  const handle: LiveShellHandle = {
    stdout: () => stdout.stream(),
    stderr: () => stderr.stream(),
    abort: (reason) => {
      void reason;
      child.kill("SIGTERM");
    },
    metadata: { ...(request.metadata ?? {}), pid: child.pid },
  };

  return { handle, completed };
}

function createHostShellEnvironment(options: {
  workspaceRoot: string;
  sandboxConfig?: ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
}): ExecutionEnvironment {
  const sandboxConfig =
    options.sandboxConfig ??
    resolveShellSandboxConfig({ workspaceRoot: options.workspaceRoot });
  const sandbox = new ShellSandboxExecutor(
    options.sandboxRuntime ?? createPlatformShellSandboxRuntime(),
  );

  return {
    id: "host-local-shell",
    kind: "local-process",
    capabilities: ["shell.execute"],
    describe: () => ({
      id: "host-local-shell",
      kind: "local-process",
      capabilities: ["shell.execute"],
    }),
    // Batch path (required by the interface): drain the streaming handle.
    async executeShell(request) {
      const { handle, completed } = spawnStreaming(request);
      let stdout = "";
      let stderr = "";
      const drain = async (
        it: AsyncIterable<string>,
        push: (c: string) => void,
      ): Promise<void> => {
        for await (const c of it) push(c);
      };
      const co = drain(handle.stdout(), (c) => (stdout += c));
      const ce = drain(handle.stderr(), (c) => (stderr += c));
      const result = await completed;
      await Promise.allSettled([co, ce]);
      return { ...result, stdout, stderr };
    },
    executeShellStreaming: async (request) => {
      const raw =
        typeof request.metadata?.rawCommand === "string"
          ? (request.metadata.rawCommand as string)
          : [request.command, ...(request.args ?? [])].join(" ");
      const cwd = request.cwd ?? options.workspaceRoot;
      if (sandboxConfig.mode === "off") {
        return spawnStreaming({
          ...request,
          cwd,
          metadata: {
            ...(request.metadata ?? {}),
            sandboxed: false,
            sandboxMode: sandboxConfig.mode,
            sandboxNetworkMode: sandboxConfig.network.mode,
            sandboxAvailable: false,
            sandboxEnforced: false,
          },
        });
      }
      const result = await sandbox.execute(
        {
          command: raw,
          cwd,
          env: shellEnv(request.env),
          timeoutMs: request.timeoutMs,
          metadata: {
            ...(request.metadata ?? {}),
            sandboxMode: sandboxConfig.mode,
            sandboxNetworkMode: sandboxConfig.network.mode,
            sandboxAvailable: true,
            sandboxEnforced: sandboxConfig.failIfUnavailable,
          },
        },
        sandboxConfig,
      );
      if (result.status === "started") return result.result;
      if (!sandboxConfig.failIfUnavailable) {
        return spawnStreaming({
          ...request,
          cwd,
          metadata: {
            ...(request.metadata ?? {}),
            sandboxed: false,
            sandboxMode: sandboxConfig.mode,
            sandboxNetworkMode: sandboxConfig.network.mode,
            sandboxUnavailable: result.reason,
            sandboxRuntime: result.runtimeId,
            sandboxAvailable: false,
            sandboxFallbackReason: result.reason,
            sandboxEnforced: false,
          },
        });
      }
      return failedStreamingResult(result.reason, {
        sandboxed: false,
        sandboxMode: sandboxConfig.mode,
        sandboxNetworkMode: sandboxConfig.network.mode,
        sandboxUnavailable: result.reason,
        sandboxRuntime: result.runtimeId,
        sandboxAvailable: false,
        sandboxFallbackReason: result.reason,
        sandboxEnforced: true,
      });
    },
  };
}

function shellEnv(
  requestEnv?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONDONTWRITEBYTECODE:
      requestEnv?.PYTHONDONTWRITEBYTECODE ??
      process.env.PYTHONDONTWRITEBYTECODE ??
      "1",
    ...(requestEnv ?? {}),
  };
}

export interface HostShellToolOptions {
  taskManager?: TaskManager;
  foregroundTimeoutMs?: number;
  defaultTimeoutMs?: number;
  sandbox?: ShellSandboxConfig | ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
  userConfigPath?: string;
  projectConfigPath?: string;
  explicitConfigPath?: string;
  skillRoots?: readonly string[];
  extraForcedDenyWrite?: readonly string[];
  getRunEvents?: () => EventEmitter | undefined;
  backgroundTasks?: BackgroundTaskPolicy;
}

/**
 * Built-in `shell` tool. Risky + approval-gated by core policy, and every
 * command is safety-classified by `@sparkwright/shell-tool` (destructive
 * patterns denied outright). Gives the agent `ls`/`find`/`cat`/etc. so it can
 * actually explore the workspace.
 */
export function createHostShellTool(
  workspaceRoot: string,
  options: HostShellToolOptions = {},
): ToolDefinition<ShellToolInput, ShellToolOutput> {
  const sandboxConfig =
    options.sandbox && "forcedDenyWrite" in options.sandbox
      ? options.sandbox
      : resolveShellSandboxConfig({
          workspaceRoot,
          config: options.sandbox,
          userConfigPath: options.userConfigPath,
          projectConfigPath: options.projectConfigPath,
          explicitConfigPath: options.explicitConfigPath,
          skillRoots: options.skillRoots,
          extraForcedDenyWrite: options.extraForcedDenyWrite,
        });
  const sandboxRuntime =
    options.sandboxRuntime ?? createPlatformShellSandboxRuntime();
  const environment = createHostShellEnvironment({
    workspaceRoot,
    sandboxConfig,
    sandboxRuntime,
  });
  const foregroundTimeoutMs =
    options.foregroundTimeoutMs ?? RECOMMENDED_FOREGROUND_TIMEOUT_MS;
  const descriptor = createShellTool({
    environment,
    workspaceRoot,
    foregroundTimeoutMs,
    promotionAvailable:
      Boolean(options.taskManager) &&
      (options.backgroundTasks ?? "enabled") === "enabled",
    onBackground: createUnavailableBackgroundHandoff(),
  });

  return {
    ...descriptor,
    description:
      `${descriptor.description} Do not use shell to create or update ` +
      "managed capability files under .sparkwright/skills, .sparkwright/agents, " +
      "or .sparkwright/command; use the dedicated " +
      "SparkWright capability tools or CLI subcommands instead.",
    async execute(args, ctx) {
      const readOnlyFastPath = isReadOnlyShellFastPath(args);
      const before = readOnlyFastPath
        ? undefined
        : await snapshotWorkspace(workspaceRoot);
      const shell = createShellTool({
        environment,
        workspaceRoot,
        foregroundTimeoutMs,
        promotionAvailable:
          Boolean(options.taskManager) &&
          (options.backgroundTasks ?? "enabled") === "enabled",
        onBackground:
          options.taskManager &&
          (options.backgroundTasks ?? "enabled") === "enabled"
            ? createTaskBackgroundHandoff({
                manager: options.taskManager,
                parentRunId: ctx.run.id,
                sandboxConfig,
                sandboxRuntime,
                getRunEvents: options.getRunEvents,
              })
            : createUnavailableBackgroundHandoff(),
        findActiveBackgroundTask:
          options.taskManager &&
          (options.backgroundTasks ?? "enabled") === "enabled"
            ? ({ command, cwd, lifetime }) =>
                findActiveShellBackgroundTask(options.taskManager!, {
                  parentRunId: ctx.run.id,
                  command,
                  cwd,
                  lifetime,
                })
            : undefined,
      });
      const output = await shell.execute(args, ctx);
      if (output.background || readOnlyFastPath) return output;
      if (!before) return output;
      const after = await snapshotWorkspace(workspaceRoot);
      const changes = diffWorkspaceSnapshots(before, after);
      if (changes.length > 0) {
        const rollback = await rollbackWorkspaceSnapshot(
          workspaceRoot,
          before,
          after,
        );
        throw new UntrackedWorkspaceMutationError(changes, rollback);
      }
      return output;
    },
  };
}

function isReadOnlyShellFastPath(args: unknown): boolean {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return false;
  }
  const command = (args as { command?: unknown }).command;
  if (typeof command !== "string") return false;
  const parsed = parseCommand(command);
  if (
    parsed.hasRedirect ||
    parsed.hasPipe ||
    parsed.hasSubshell ||
    parsed.hasChain
  ) {
    return false;
  }
  return evaluateShellSafety(command).decision === "allow";
}

function createUnavailableBackgroundHandoff(): ShellBackgroundHandoffHandler {
  return () => {
    throw new Error(
      "foreground timeout reached; process killed because promotion unavailable",
    );
  };
}

function findActiveShellBackgroundTask(
  manager: TaskManager,
  input: {
    parentRunId: RunId;
    command: string;
    cwd?: string;
    lifetime: ShellTaskLifetime;
  },
): { taskId: string } | undefined {
  const command = normalizeShellTaskCommand(input.command);
  const cwd = input.cwd ?? "";
  const existing = manager.store
    .list({ parentRunId: input.parentRunId })
    .find((task) => {
      if (
        task.kind !== SHELL_BACKGROUND_KIND &&
        task.kind !== LEGACY_PROMOTED_SHELL_KIND
      ) {
        return false;
      }
      if (
        task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled"
      ) {
        return false;
      }
      return (
        task.metadata.backgroundOrigin === "explicit" &&
        normalizeShellTaskCommand(String(task.metadata.command ?? "")) ===
          command &&
        String(task.metadata.cwd ?? "") === cwd &&
        (task.metadata.lifetime ?? "job") === input.lifetime
      );
    });
  return existing ? { taskId: String(existing.id) } : undefined;
}

function normalizeShellTaskCommand(command: string): string {
  return command.trim().replace(/\r\n?/gu, "\n");
}

function failedStreamingResult(
  stderr: string,
  metadata: Record<string, unknown>,
): ShellStreamingResult {
  const now = new Date().toISOString();
  const completed: Promise<ShellExecutionResult> = Promise.resolve({
    status: "failed",
    exitCode: null,
    stdout: "",
    stderr,
    startedAt: now,
    completedAt: now,
    metadata,
  });
  const handle: LiveShellHandle = {
    stdout: async function* stdout() {},
    stderr: async function* stderrStream() {
      yield stderr;
    },
    abort: () => undefined,
    metadata,
  };
  return { handle, completed };
}

/**
 * Emit the `untracked-write-capable` boundary marker for a background shell.
 *
 * Handoff turns a shell into a background task that runs
 * concurrently with the rest of the session, so the foreground snapshot/diff/
 * rollback audit no longer composes (its `before` snapshot goes stale and a
 * whole-tree diff would attribute — and roll back — concurrent writes by other
 * tools). We therefore do not roll back background-task writes; instead we
 * disclose the boundary, mirroring the external-command delegate's
 * `workspace.write.untracked_access_granted` marker.
 *
 * The marker is emitted on every handoff: no sandbox mode prevents a shell
 * from writing ordinary workspace files (workspaceRoot is always in allowWrite),
 * so the untracked-write-capable boundary always exists. The sandbox status
 * rides in the payload so trace diagnostics can grade severity by the effective
 * filesystem isolation (bind-allowlist vs deny-list-guard) rather than guessing.
 */
async function emitBackgroundShellUntrackedMarker(input: {
  emitter: EventEmitter;
  parentRunId: RunId;
  taskId: string;
  command: string;
  backgroundOrigin: "explicit" | "promoted";
  sandboxConfig: ResolvedShellSandboxConfig;
  sandboxRuntime: ShellSandboxRuntime;
}): Promise<void> {
  try {
    const status = await describeShellSandboxStatus(
      input.sandboxConfig,
      input.sandboxRuntime,
    );
    input.emitter.emit("workspace.write.untracked_access_granted", {
      taskId: input.taskId,
      parentRunId: input.parentRunId,
      toolName: "bash",
      protocol: "background_shell",
      marker: "untracked-write-capable",
      access: "granted",
      command: input.command,
      backgroundOrigin: input.backgroundOrigin,
      sandboxMode: status.mode,
      filesystemIsolation: status.filesystemIsolation,
      sandboxAvailable: status.available,
    });
  } catch {
    // Disclosure is best-effort: never fail the background task because the
    // sandbox status probe threw.
  }
}

function createTaskBackgroundHandoff(input: {
  manager: TaskManager;
  parentRunId: RunId;
  sandboxConfig: ResolvedShellSandboxConfig;
  sandboxRuntime: ShellSandboxRuntime;
  getRunEvents?: () => EventEmitter | undefined;
}): ShellBackgroundHandoffHandler {
  return ({
    handle,
    completed,
    request,
    partialStdout,
    partialStderr,
    startedAt,
    origin,
    policy,
  }) => {
    const rawCommand =
      typeof request.metadata?.rawCommand === "string"
        ? request.metadata.rawCommand
        : [request.command, ...(request.args ?? [])].join(" ");
    const task = input.manager.spawn({
      parentRunId: input.parentRunId,
      kind: SHELL_BACKGROUND_KIND,
      title: `shell: ${rawCommand}`,
      awaited: policy.awaited,
      metadata: {
        command: rawCommand,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        backgroundOrigin: origin,
        lifetime: policy.lifetime,
      },
      runner: async (ctrl) => {
        const emitter = input.getRunEvents?.() ?? createBufferedEmitter();
        const taskPayload = {
          taskId: ctrl.taskId,
          parentRunId: input.parentRunId,
          kind: SHELL_BACKGROUND_KIND,
          title: `shell: ${rawCommand}`,
          command: rawCommand,
          cwd: request.cwd,
          timeoutMs: request.timeoutMs,
          backgroundOrigin: origin,
          lifetime: policy.lifetime,
        };
        emitter.emit("task.created", taskPayload);
        const taskSpan = openSpan(emitter, {
          startType: "task.started",
          payload: taskPayload,
        });
        await emitBackgroundShellUntrackedMarker({
          emitter,
          parentRunId: input.parentRunId,
          taskId: String(ctrl.taskId),
          command: rawCommand,
          backgroundOrigin: origin,
          sandboxConfig: input.sandboxConfig,
          sandboxRuntime: input.sandboxRuntime,
        });
        const runner = new TracedProcessRunner();
        let observed:
          | Awaited<ReturnType<TracedProcessRunner["observeStreaming"]>>
          | undefined;
        try {
          observed = await runner.observeStreaming({
            emitter,
            runId: input.parentRunId,
            name: rawCommand,
            kind: "task",
            runtime: "shell",
            command: "bash",
            args: ["-c", rawCommand],
            cwd: request.cwd,
            streaming: { handle, completed },
            startedAt,
            initialStdout: partialStdout,
            initialStderr: partialStderr,
            spanFrame: taskSpan.frame,
            abortSignal: ctrl.signal,
            onOutput: (chunk) => {
              ctrl.emitOutput(chunk);
            },
            onProgress: (chunk, context) => {
              if (!chunk.message || chunk.channel === "event") return;
              context.emit("task.output", {
                taskId: ctrl.taskId,
                channel: chunk.channel,
                data: chunk.message,
              });
            },
          });

          if (ctrl.signal.aborted) {
            const result = backgroundShellTaskResult(
              rawCommand,
              observed.exitCode,
              observed.output,
            );
            taskSpan.close("task.cancelled", {
              ...taskPayload,
              result,
              output: observed.output,
            });
            return result;
          }

          if (observed.error || observed.exitCode !== 0) {
            throw new ShellTaskExitError(shellResultFromObserved(observed));
          }

          const result = backgroundShellTaskResult(
            rawCommand,
            observed.exitCode,
            observed.output,
          );
          taskSpan.close("task.completed", {
            ...taskPayload,
            result,
            output: observed.output,
            progressCount: observed.progressCount,
            progressDropped: observed.progressDropped,
          });
          return result;
        } catch (cause) {
          taskSpan.close("task.failed", {
            ...taskPayload,
            errorCode: errorCodeFromCause(cause),
            error: cause instanceof Error ? cause.message : String(cause),
            ...(observed
              ? {
                  output: observed.output,
                  progressCount: observed.progressCount,
                  progressDropped: observed.progressDropped,
                }
              : {}),
          });
          throw cause;
        }
      },
    });

    return { taskId: String(task.record.id) };
  };
}

class ShellTaskExitError extends Error {
  readonly code = "SHELL_TASK_EXITED";

  constructor(result: ShellExecutionResult) {
    super(
      `Background shell command exited with ${
        result.exitCode === null
          ? result.status
          : `exit code ${result.exitCode}`
      }.`,
    );
    this.name = "ShellTaskExitError";
  }
}

interface BackgroundShellTaskResult {
  command: string;
  exitCode: number | null;
  completedAt: string;
  output: ProcessOutputSummary;
}

function backgroundShellTaskResult(
  command: string,
  exitCode: number | null,
  output: ProcessOutputSummary,
): BackgroundShellTaskResult {
  return {
    command,
    exitCode,
    completedAt: new Date().toISOString(),
    output,
  };
}

function shellResultFromObserved(
  observed: Awaited<ReturnType<TracedProcessRunner["observeStreaming"]>>,
): ShellExecutionResult {
  const completedAt = new Date().toISOString();
  return {
    status: observed.exitCode === 0 && !observed.error ? "completed" : "failed",
    exitCode: observed.exitCode,
    stdout: observed.output.stdoutPreview ?? "",
    stderr: observed.output.stderrPreview ?? observed.error?.message ?? "",
    startedAt: new Date(Date.now() - observed.durationMs).toISOString(),
    completedAt,
    metadata: {
      timedOut: observed.timedOut,
      ...(observed.sandbox
        ? {
            sandboxed: observed.sandbox.sandboxed,
            sandboxMode: observed.sandbox.mode,
            sandboxRuntime: observed.sandbox.runtime,
            sandboxNetworkMode: observed.sandbox.networkMode,
            sandboxAvailable: observed.sandbox.available,
            sandboxFallbackReason: observed.sandbox.fallbackReason,
            sandboxEnforced: observed.sandbox.enforced,
          }
        : {}),
    },
  };
}

function errorCodeFromCause(cause: unknown): string {
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "TASK_RUNNER_FAILED";
}

class UntrackedWorkspaceMutationError extends Error {
  readonly code = "UNTRACKED_WORKSPACE_MUTATION";
  readonly metadata: Record<string, unknown>;

  constructor(
    changes: WorkspaceMutationChange[],
    rollback: WorkspaceRollbackResult,
  ) {
    const capabilityGuidance = changes.some((change) =>
      isManagedCapabilityPath(change.path),
    )
      ? " Use dedicated SparkWright capability tools or CLI subcommands for .sparkwright capability packages."
      : "";
    super(
      `Shell command changed workspace files outside the controlled write path: ${changes
        .map((change) => change.path)
        .join(", ")}.${capabilityGuidance}`,
    );
    this.name = "UntrackedWorkspaceMutationError";
    this.metadata = { changes, rollback };
  }
}
