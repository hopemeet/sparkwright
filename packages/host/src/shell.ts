import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TaskManager } from "@sparkwright/agent-runtime";
import {
  createShellTool,
  evaluateShellSafety,
  parseCommand,
  RECOMMENDED_FOREGROUND_TIMEOUT_MS,
  type ShellPromotionHandler,
} from "@sparkwright/shell-tool";
import {
  ShellSandboxExecutor,
  createPlatformShellSandboxRuntime,
  resolveShellSandboxConfig,
  type ResolvedShellSandboxConfig,
  type ShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import type {
  ExecutionEnvironment,
  LiveShellHandle,
  RunId,
  ShellExecutionRequest,
  ShellExecutionResult,
  ShellStreamingResult,
  ToolDefinition,
} from "@sparkwright/core";
import type { ShellToolInput, ShellToolOutput } from "@sparkwright/shell-tool";

const PROMOTED_SHELL_KIND = "shell.promoted";
const FALLBACK_TIMEOUT_WITHOUT_TASK_MANAGER_MS = 60_000;
const SNAPSHOT_FILE_CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_CAPTURE_LIMIT_BYTES = 25 * 1024 * 1024;
const AUDIT_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
]);
const AUDIT_EXCLUDED_PATHS = new Set([".sparkwright/sessions"]);
const MANAGED_CAPABILITY_PREFIXES = [
  ".sparkwright/skills/",
  ".sparkwright/agents/",
  ".sparkwright/command/",
  ".sparkwright/cron/",
];

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
  const environment = createHostShellEnvironment({
    workspaceRoot,
    sandboxConfig,
    sandboxRuntime: options.sandboxRuntime,
  });
  const foregroundTimeoutMs =
    options.foregroundTimeoutMs ?? RECOMMENDED_FOREGROUND_TIMEOUT_MS;
  const defaultTimeoutMs =
    options.defaultTimeoutMs ??
    (options.taskManager
      ? undefined
      : FALLBACK_TIMEOUT_WITHOUT_TASK_MANAGER_MS);
  const descriptor = createShellTool({
    environment,
    workspaceRoot,
    defaultTimeoutMs,
    foregroundTimeoutMs,
    onPromote: createUnavailablePromotionHandler(),
  });

  return {
    ...descriptor,
    description:
      `${descriptor.description} Do not use shell to create or update ` +
      "managed capability files under .sparkwright/skills, .sparkwright/agents, " +
      ".sparkwright/command, or .sparkwright/cron; use the dedicated " +
      "SparkWright capability tools or CLI subcommands instead.",
    async execute(args, ctx) {
      const readOnlyFastPath = isReadOnlyShellFastPath(args);
      const before = readOnlyFastPath
        ? undefined
        : await snapshotWorkspace(workspaceRoot);
      const shell = createShellTool({
        environment,
        workspaceRoot,
        defaultTimeoutMs,
        foregroundTimeoutMs,
        onPromote: options.taskManager
          ? createTaskPromotionHandler({
              manager: options.taskManager,
              parentRunId: ctx.run.id,
              workspaceRoot,
              before,
            })
          : createUnavailablePromotionHandler(),
      });
      const output = await shell.execute(args, ctx);
      if (output.promoted || readOnlyFastPath) return output;
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

function createUnavailablePromotionHandler(): ShellPromotionHandler {
  return () => {
    throw new Error(
      "host: background promotion is not supported; long-running shells time out.",
    );
  };
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

function createTaskPromotionHandler(input: {
  manager: TaskManager;
  parentRunId: RunId;
  workspaceRoot: string;
  before?: WorkspaceSnapshot;
}): ShellPromotionHandler {
  return ({ handle, completed, request, partialStdout, partialStderr }) => {
    const rawCommand =
      typeof request.metadata?.rawCommand === "string"
        ? request.metadata.rawCommand
        : [request.command, ...(request.args ?? [])].join(" ");
    const task = input.manager.spawn({
      parentRunId: input.parentRunId,
      kind: PROMOTED_SHELL_KIND,
      title: `shell: ${rawCommand}`,
      metadata: {
        command: rawCommand,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
      },
      runner: async (ctrl) => {
        if (partialStdout) {
          ctrl.emitOutput({ channel: "stdout", data: partialStdout });
        }
        if (partialStderr) {
          ctrl.emitOutput({ channel: "stderr", data: partialStderr });
        }

        const stdoutDrain = (async () => {
          for await (const chunk of handle.stdout()) {
            ctrl.emitOutput({ channel: "stdout", data: chunk });
          }
        })();
        const stderrDrain = (async () => {
          for await (const chunk of handle.stderr()) {
            ctrl.emitOutput({ channel: "stderr", data: chunk });
          }
        })();
        ctrl.signal.addEventListener(
          "abort",
          () => handle.abort("task cancelled"),
          { once: true },
        );

        const final = await completed;
        await Promise.allSettled([stdoutDrain, stderrDrain]);
        if (input.before) {
          const after = await snapshotWorkspace(input.workspaceRoot);
          const changes = diffWorkspaceSnapshots(input.before, after);
          if (changes.length > 0) {
            const rollback = await rollbackWorkspaceSnapshot(
              input.workspaceRoot,
              input.before,
              after,
            );
            throw new UntrackedWorkspaceMutationError(changes, rollback);
          }
        }

        if (final.status !== "completed" || final.exitCode !== 0) {
          throw new ShellTaskExitError(final);
        }

        return {
          command: rawCommand,
          exitCode: final.exitCode,
          completedAt: final.completedAt,
        };
      },
    });

    return { taskId: String(task.record.id) };
  };
}

class ShellTaskExitError extends Error {
  readonly code = "SHELL_TASK_EXITED";

  constructor(result: ShellExecutionResult) {
    super(
      `Promoted shell command exited with ${
        result.exitCode === null
          ? result.status
          : `exit code ${result.exitCode}`
      }.`,
    );
    this.name = "ShellTaskExitError";
  }
}

interface WorkspaceSnapshotEntry {
  hash: string;
  content?: Buffer;
}

type WorkspaceSnapshot = Map<string, WorkspaceSnapshotEntry>;

interface WorkspaceMutationChange {
  path: string;
  kind: "created" | "modified" | "deleted";
}

interface WorkspaceRollbackResult {
  restored: string[];
  removed: string[];
  failed: Array<{ path: string; error: string }>;
  incomplete: string[];
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

async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();
  let capturedBytes = 0;

  async function visit(relativeDir: string): Promise<void> {
    const absoluteDir = relativeDir ? join(root, relativeDir) : root;
    const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(
      () => [],
    );

    for (const entry of entries) {
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (shouldSkipAuditDirectory(relativePath, entry.name)) continue;
        await visit(relativePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const absolutePath = join(root, relativePath);
      const stat = await lstat(absolutePath).catch(() => undefined);
      if (!stat?.isFile()) continue;
      const content = await readFile(absolutePath).catch(() => undefined);
      if (content === undefined) continue;

      const canCapture =
        content.byteLength <= SNAPSHOT_FILE_CAPTURE_LIMIT_BYTES &&
        capturedBytes + content.byteLength <=
          SNAPSHOT_TOTAL_CAPTURE_LIMIT_BYTES;
      if (canCapture) capturedBytes += content.byteLength;
      snapshot.set(relativePath, {
        hash: hashBuffer(content),
        ...(canCapture ? { content } : {}),
      });
    }
  }

  await visit("");
  return snapshot;
}

function shouldSkipAuditDirectory(
  relativePath: string,
  name: string,
): boolean {
  return AUDIT_EXCLUDED_DIRS.has(name) || AUDIT_EXCLUDED_PATHS.has(relativePath);
}

function isManagedCapabilityPath(path: string): boolean {
  return MANAGED_CAPABILITY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): WorkspaceMutationChange[] {
  const changes: WorkspaceMutationChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const prior = before.get(path);
    const next = after.get(path);
    if (!prior && next) changes.push({ path, kind: "created" });
    else if (prior && !next) changes.push({ path, kind: "deleted" });
    else if (prior && next && prior.hash !== next.hash) {
      changes.push({ path, kind: "modified" });
    }
  }
  return changes;
}

async function rollbackWorkspaceSnapshot(
  root: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): Promise<WorkspaceRollbackResult> {
  const restored: string[] = [];
  const removed: string[] = [];
  const failed: WorkspaceRollbackResult["failed"] = [];
  const incomplete: string[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);

  for (const path of [...paths].sort()) {
    const prior = before.get(path);
    const next = after.get(path);
    if (!prior && next) {
      try {
        await rm(join(root, path), { force: true });
        removed.push(path);
      } catch (error) {
        failed.push({ path, error: formatError(error) });
      }
      continue;
    }
    if (!prior) continue;
    if (next && next.hash === prior.hash) continue;
    if (!prior.content) {
      incomplete.push(path);
      continue;
    }
    try {
      const absolutePath = join(root, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, prior.content);
      restored.push(path);
    } catch (error) {
      failed.push({ path, error: formatError(error) });
    }
  }

  return { restored, removed, failed, incomplete };
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
