import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
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
} from "@sparkwright/core";

// Per-call wall-clock ceiling. Commands exceeding this are killed and reported
// as timed out. Keeps a stray `cat`/REPL from hanging the run.
const DEFAULT_TIMEOUT_MS = 60_000;

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
export function createHostShellTool(workspaceRoot: string) {
  return createShellTool({
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
}
