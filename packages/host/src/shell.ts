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
import type { Readable } from "node:stream";
import { dirname, join } from "node:path";
import {
  createShellTool,
  RECOMMENDED_FOREGROUND_TIMEOUT_MS,
} from "@sparkwright/shell-tool";
import type {
  ExecutionEnvironment,
  LiveShellHandle,
  ShellExecutionRequest,
  ShellExecutionResult,
  ShellStreamingResult,
  ToolDefinition,
} from "@sparkwright/core";
import type { ShellToolInput, ShellToolOutput } from "@sparkwright/shell-tool";

// Per-call wall-clock ceiling. Commands exceeding this are killed and reported
// as timed out. Keeps a stray `cat`/REPL from hanging the run.
const DEFAULT_TIMEOUT_MS = 60_000;
const SNAPSHOT_FILE_CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_CAPTURE_LIMIT_BYTES = 25 * 1024 * 1024;
const AUDIT_EXCLUDED_DIRS = new Set([".git", ".sparkwright", "node_modules"]);

async function* streamToStrings(
  stream: Readable | null,
): AsyncIterable<string> {
  if (!stream) return;
  for await (const chunk of stream) {
    yield typeof chunk === "string"
      ? chunk
      : (chunk as Buffer).toString("utf8");
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

  const child = spawn("bash", ["-c", raw], {
    cwd: request.cwd,
    env: process.env,
  });

  let timedOut = false;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  const completed = new Promise<ShellExecutionResult>((resolve) => {
    const finish = (
      status: ShellExecutionResult["status"],
      exitCode: number | null,
      stderr = "",
    ): void => {
      clearTimeout(timer);
      resolve({
        status,
        exitCode,
        stdout: "",
        stderr,
        startedAt,
        completedAt: new Date().toISOString(),
        metadata: { timedOut, pid: child.pid },
      });
    };
    child.on("error", (err) => finish("failed", null, String(err)));
    child.on("close", (code) =>
      finish(code === 0 ? "completed" : "failed", code),
    );
  });

  const handle: LiveShellHandle = {
    stdout: () => streamToStrings(child.stdout),
    stderr: () => streamToStrings(child.stderr),
    abort: (reason) => {
      void reason;
      child.kill("SIGTERM");
    },
    metadata: { pid: child.pid },
  };

  return { handle, completed };
}

function createHostShellEnvironment(): ExecutionEnvironment {
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
    executeShellStreaming: async (request) => spawnStreaming(request),
  };
}

/**
 * Built-in `shell` tool. Risky + approval-gated by core policy, and every
 * command is safety-classified by `@sparkwright/shell-tool` (destructive
 * patterns denied outright). Gives the agent `ls`/`find`/`cat`/etc. so it can
 * actually explore the workspace.
 */
export function createHostShellTool(
  workspaceRoot: string,
): ToolDefinition<ShellToolInput, ShellToolOutput> {
  const shell = createShellTool({
    environment: createHostShellEnvironment(),
    workspaceRoot,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    foregroundTimeoutMs: RECOMMENDED_FOREGROUND_TIMEOUT_MS,
    // This demo host has no background TaskManager, so a command that outlives
    // the foreground deadline can't be adopted — throwing makes the shell tool
    // abort it and report `timedOut` rather than claiming a phantom background
    // task. Wire to a TaskManager here to support long-running shells.
    onPromote: () => {
      throw new Error(
        "host: background promotion is not supported; long-running shells time out.",
      );
    },
  });

  return {
    ...shell,
    async execute(args, ctx) {
      const before = await snapshotWorkspace(workspaceRoot);
      const output = await shell.execute(args, ctx);
      const after = await snapshotWorkspace(workspaceRoot);
      const changes = diffWorkspaceSnapshots(before, after);
      if (changes.length > 0) {
        const rollback = await rollbackWorkspaceSnapshot(workspaceRoot, before, after);
        throw new UntrackedWorkspaceMutationError(changes, rollback);
      }
      return output;
    },
  };
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
    super(
      `Shell command changed workspace files outside the controlled write path: ${changes
        .map((change) => change.path)
        .join(", ")}`,
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
        if (AUDIT_EXCLUDED_DIRS.has(entry.name)) continue;
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
        capturedBytes + content.byteLength <= SNAPSHOT_TOTAL_CAPTURE_LIMIT_BYTES;
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
