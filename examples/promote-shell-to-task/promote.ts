// End-to-end demo: shell-tool foreground→background promotion + TaskManager
// + TaskNotificationSink. Run with `npm run -w @sparkwright/example-promote-shell-to-task test`.
//
// The script wires three SparkWright pieces together so the model surface is
// realistic:
//
//   shell-tool ── onBackground ──▶ TaskManager.spawn(handle adoption)
//        ▲                              │
//        │                              ▼
//   short cmd: returns synchronously    long cmd: returns { promoted, taskId },
//                                       then InMemoryTaskNotificationQueue
//                                       delivers the terminal notification the
//                                       agent loop would read on its next turn.
//
// No real shell is spawned — a deterministic in-process streaming environment
// stands in for the host's executor so the example doubles as a smoke test.

import {
  InMemoryTaskNotificationQueue,
  InMemoryTaskStore,
  TaskManager,
  type TaskNotification,
} from "@sparkwright/agent-runtime";
import {
  createRunId,
  type ExecutionEnvironment,
  type LiveShellHandle,
  type RuntimeContext,
  type ShellExecutionRequest,
  type ShellExecutionResult,
  type ShellStreamingResult,
} from "@sparkwright/core";
import {
  RECOMMENDED_FOREGROUND_TIMEOUT_MS,
  createShellTool,
  type ShellBackgroundHandoffHandler,
  type ShellToolOutput,
} from "@sparkwright/shell-tool";

// ---------------------------------------------------------------------------
// 1. A toy streaming environment. Hosts replace this with a real
//    child_process / container / sandbox adapter that fulfils the
//    `executeShellStreaming` contract.
// ---------------------------------------------------------------------------

interface ScriptedCommand {
  stdout: string[];
  stderr?: string[];
  /** Total wall-clock duration before the process exits. */
  durationMs: number;
  exitCode: number;
}

function scriptedEnvironment(
  scripts: Map<string, ScriptedCommand>,
): ExecutionEnvironment {
  return {
    id: "demo-streaming",
    kind: "demo",
    capabilities: ["shell.execute"],
    describe: () => ({ id: "demo-streaming" }),
    executeShell: async () => {
      throw new Error(
        "demo environment: this shell tool only uses executeShellStreaming.",
      );
    },
    executeShellStreaming: async (
      request: ShellExecutionRequest,
    ): Promise<ShellStreamingResult> => {
      const script = scripts.get(request.command);
      if (!script) {
        throw new Error(`no script registered for command: ${request.command}`);
      }
      let aborted = false;
      let resolveCompleted!: (r: ShellExecutionResult) => void;
      const completed = new Promise<ShellExecutionResult>((resolve) => {
        resolveCompleted = resolve;
      });
      const timer = setTimeout(() => {
        resolveCompleted({
          status: "completed",
          exitCode: script.exitCode,
          stdout: script.stdout.join(""),
          stderr: (script.stderr ?? []).join(""),
          startedAt: new Date(0).toISOString(),
          completedAt: new Date().toISOString(),
          metadata: { timedOut: false, aborted },
        });
      }, script.durationMs);

      const handle: LiveShellHandle = {
        metadata: { command: request.command },
        stdout: async function* () {
          for (const chunk of script.stdout) yield chunk;
        },
        stderr: async function* () {
          for (const chunk of script.stderr ?? []) yield chunk;
        },
        abort: () => {
          if (aborted) return;
          aborted = true;
          clearTimeout(timer);
          resolveCompleted({
            status: "failed",
            exitCode: null,
            stdout: "",
            stderr: "",
            startedAt: new Date(0).toISOString(),
            completedAt: new Date().toISOString(),
            metadata: { timedOut: true, aborted: true },
          });
        },
      };
      return { handle, completed };
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Build the promotion bridge: when the foreground deadline fires, hand the
//    live LiveShellHandle to TaskManager.spawn. The runner continues to drain
//    stdout/stderr into the task store so `task_output` can stream it later.
// ---------------------------------------------------------------------------

function makeBackgroundHandoff(
  manager: TaskManager,
  parentRunId: ReturnType<typeof createRunId>,
): ShellBackgroundHandoffHandler {
  return ({
    handle,
    completed,
    request,
    partialStdout,
    partialStderr,
    policy,
  }) => {
    const taskHandle = manager.spawn({
      parentRunId,
      kind: "shell.background",
      title: `shell: ${request.command}`,
      awaited: policy.awaited,
      metadata: {
        command: request.command,
        args: request.args,
        lifetime: policy.lifetime,
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
        await Promise.allSettled([stdoutDrain, stderrDrain]);
        const final = await completed;
        if (final.status !== "completed" || final.exitCode !== 0) {
          const err = new Error(
            `Shell exited with ${final.exitCode === null ? final.status : `exit code ${final.exitCode}`}.`,
          );
          (err as Error & { code?: string }).code = "TASK_PROCESS_EXITED";
          throw err;
        }
        return { command: request.command, exitCode: final.exitCode };
      },
    });
    return { taskId: String(taskHandle.record.id) };
  };
}

// ---------------------------------------------------------------------------
// 3. Drive the demo.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parentRunId = createRunId();
  const notifications = new InMemoryTaskNotificationQueue();
  const manager = new TaskManager({
    store: new InMemoryTaskStore(),
    notificationSink: notifications,
  });

  const scripts = new Map<string, ScriptedCommand>([
    ["echo", { stdout: ["hello\n"], durationMs: 5, exitCode: 0 }],
    [
      "sleep",
      {
        stdout: ["progress 1/3\n", "progress 2/3\n", "progress 3/3\n"],
        durationMs: 120,
        exitCode: 0,
      },
    ],
  ]);
  const environment = scriptedEnvironment(scripts);

  const tool = createShellTool({
    environment,
    // Set a tiny ceiling so `sleep` deterministically promotes. Real hosts
    // pass RECOMMENDED_FOREGROUND_TIMEOUT_MS (10 min) or a configured value.
    foregroundTimeoutMs: 30,
    onBackground: makeBackgroundHandoff(manager, parentRunId),
  });
  void RECOMMENDED_FOREGROUND_TIMEOUT_MS; // referenced for docs/lint visibility

  const ctx = {
    runId: parentRunId,
    agentId: "demo",
  } as unknown as RuntimeContext;

  // --- Case A: short command completes in the foreground -------------------
  const shortResult = (await tool.execute(
    { command: "echo" },
    ctx,
  )) as ShellToolOutput;
  log("short command", shortResult);
  assert(!shortResult.promoted, "short command must NOT promote");
  assert(shortResult.stdout === "hello\n", "short stdout must round-trip");

  // --- Case B: long command exceeds the deadline → promotion --------------
  const longResult = (await tool.execute(
    { command: "sleep" },
    ctx,
  )) as ShellToolOutput;
  log("long command (promoted)", longResult);
  assert(longResult.promoted === true, "long command MUST promote");
  assert(typeof longResult.taskId === "string", "promotion must return taskId");

  // The agent loop would now continue with other work. Here we wait for the
  // background task to finish so the notification can be observed.
  const arrived: TaskNotification[] = await notifications.waitForNext();
  log("notification delivered", arrived[0]);
  assert(arrived.length === 1, "exactly one notification expected");
  assert(arrived[0]!.status === "completed", "task should complete cleanly");
  assert(
    arrived[0]!.taskId === longResult.taskId,
    "notification taskId must match promotion taskId",
  );

  console.log("\n✓ promote-shell-to-task demo finished");
}

function log(label: string, value: unknown): void {
  console.log(`[${label}]`, JSON.stringify(value, null, 2));
}

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error(`✗ assertion failed: ${message}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("demo crashed:", err);
  process.exit(1);
});
