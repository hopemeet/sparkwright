import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
  ApprovalResolver,
  PermissionMode,
  RunRecord,
  RunResult,
  SparkwrightEvent,
  TraceLevel,
} from "@sparkwright/core";
import {
  createRunId,
  createSessionId,
  createSessionFileRunStoreFactory,
  createSessionRunStoreFactory,
  EventLog,
  FileSessionStore,
} from "@sparkwright/core";
import { createClient, type Client } from "@sparkwright/sdk-node";
import { createCliApprovalResolver } from "../cli-approval.js";
import { formatEvent } from "../event-format.js";
import type { CliIO } from "../io.js";
import { writeLine } from "../io.js";
import {
  cliExitCodeForRun,
  createCliRunEventSummary,
  summarizeRunFailure,
  summarizeTerminalRunFailure,
  summarizeUnhandledToolFailures,
  summarizeWorkspaceMutations,
  updateCliRunEventSummary,
} from "../run-outcome.js";

const require = createRequire(import.meta.url);

export interface HostRunInput {
  goal: string;
  workspaceRoot: string;
  sessionRootDir: string;
  shouldWrite: boolean;
  approveAll: boolean;
  permissionMode: PermissionMode;
  modelName?: string;
  sessionId: string;
  targetPath: string;
  traceLevel: TraceLevel;
}

export interface HostResumeInput {
  runId: string;
  workspaceRoot: string;
  sessionRootDir: string;
  shouldWrite: boolean;
  approveAll: boolean;
  permissionMode: PermissionMode;
  modelName?: string;
  sessionId?: string;
  targetPath: string;
  traceLevel: TraceLevel;
  fromTrace: boolean;
  force: boolean;
}

export interface HostRunResult {
  exitCode: number;
  tracePath?: string;
  sessionId?: string;
  runState?: string;
  stopReason?: string;
}

export async function startHostRun(
  input: HostRunInput,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<HostRunResult> {
  return runHostLifecycle(input, io, env);
}

export async function resumeHostRun(
  input: HostResumeInput,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<HostRunResult> {
  return runHostLifecycle(input, io, env);
}

async function runHostLifecycle(
  input: HostRunInput | HostResumeInput,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<HostRunResult> {
  const {
    workspaceRoot,
    sessionRootDir,
    shouldWrite,
    approveAll,
    permissionMode,
    modelName,
    targetPath,
    traceLevel,
  } = input;

  let client: Client | undefined;
  let runId: string | undefined;
  let sessionId = input.sessionId;
  let runState: string | undefined;
  let stopReason: string | undefined;
  let failedMessage: string | undefined;
  let terminalFailurePrinted = false;
  const eventSummary = createCliRunEventSummary();
  const forwardHostLogs = shouldForwardHostLogs(env);

  let tracePath = sessionId
    ? join(sessionRootDir, sessionId, "trace.jsonl")
    : undefined;

  const terminal = new Promise<void>((resolveTerminal) => {
    const resolveOnce = (() => {
      let resolved = false;
      return () => {
        if (resolved) return;
        resolved = true;
        resolveTerminal();
      };
    })();

    void (async () => {
      client = await createClient({
        spawn: {
          command: resolveHostCommand(env),
          args: [
            ...resolveHostArgs(env),
            "--stdio",
            "--workspace",
            workspaceRoot,
            "--session-root",
            sessionRootDir,
            "--permission-mode",
            permissionMode,
            ...(modelName ? ["--model", modelName] : []),
          ],
          env: { ...process.env, ...env },
        },
        client: { name: "sparkwright-cli", version: "0.1.0" },
      });

      client.on("host.log", (msg) => {
        const line = msg.payload.line;
        if (line && forwardHostLogs) writeLine(io.stderr, line);
      });

      client.on("run.event", (msg) => {
        const event = msg.payload.event as SparkwrightEvent;
        updateCliRunEventSummary(eventSummary, event);
        writeLine(io.stdout, formatEvent(event));
      });

      client.on("approval.requested", (msg) => {
        const resolver = createCliApprovalResolver({ approveAll, io });
        const request: Parameters<ApprovalResolver>[0] = {
          id: msg.payload.approvalId as Parameters<ApprovalResolver>[0]["id"],
          runId: msg.payload.runId as Parameters<ApprovalResolver>[0]["runId"],
          action: msg.payload.action,
          summary: msg.payload.summary,
          details: msg.payload.details ?? {},
          createdAt: msg.timestamp,
          status: "pending",
        };
        void Promise.resolve(resolver(request)).then((decision) =>
          client
            ?.resolveApproval({
              approvalId: msg.payload.approvalId,
              decision: decision.decision,
              message: decision.message,
            })
            .catch((error: unknown) => {
              writeLine(
                io.stderr,
                error instanceof Error ? error.message : String(error),
              );
            }),
        );
      });

      client.on("run.completed", (msg) => {
        runId = msg.payload.runId;
        runState = msg.payload.state;
        stopReason = msg.payload.stopReason;
        if (runState !== "completed") {
          failedMessage =
            summarizeRunFailure(eventSummary, {
              state: runState,
              stopReason,
            }) ??
            summarizeTerminalRunFailure({
              state: runState,
              stopReason,
              failure: msg.payload.failure,
            }) ??
            failedMessage ??
            `Run finished with state ${runState}${stopReason ? ` (${stopReason})` : ""}`;
          if (!terminalFailurePrinted) {
            writeLine(io.stderr, failedMessage);
            terminalFailurePrinted = true;
          }
        }
        resolveOnce();
      });

      client.on("run.failed", (msg) => {
        runId = msg.payload.runId || runId;
        failedMessage = msg.payload.error.message;
        runState = "failed";
        stopReason = msg.payload.error.code;
        writeLine(io.stderr, failedMessage);
        terminalFailurePrinted = true;
        resolveOnce();
      });

      client.on("disconnect", (reason) => {
        if (!runState && !failedMessage) {
          failedMessage = reason
            ? `host disconnected: ${reason}`
            : "host disconnected";
          runState = "failed";
          stopReason = "host_disconnected";
          writeLine(io.stderr, failedMessage);
          terminalFailurePrinted = true;
          resolveOnce();
        }
      });

      if ("goal" in input) {
        const started = await client.startRun({
          goal: input.goal,
          sessionId,
          model: modelName,
          permissionMode,
          traceLevel,
          targetPath,
          shouldWrite,
          metadata: {
            source: "cli",
            targetPath,
            shouldWrite,
            traceLevel,
          },
        });
        runId = started.runId;
      } else {
        const resumed = await client.resumeRun({
          runId: input.runId,
          ...(sessionId ? { sessionId } : {}),
          fromTrace: input.fromTrace,
          force: input.force,
          model: modelName,
          permissionMode,
          traceLevel,
          targetPath,
          shouldWrite,
          metadata: {
            source: "cli",
            targetPath,
            shouldWrite,
            traceLevel,
          },
        });
        runId = resumed.runId;
        if (resumed.sessionId) {
          sessionId = resumed.sessionId;
          tracePath = join(sessionRootDir, sessionId, "trace.jsonl");
        }
      }
    })().catch(async (error: unknown) => {
      failedMessage = formatHostError(error);
      runState = "failed";
      stopReason = "host_start_failed";
      writeLine(io.stderr, failedMessage);
      terminalFailurePrinted = true;
      if (tracePath && existsSync(tracePath)) {
        resolveOnce();
        return;
      }
      const failureTrace = await writeHostStartFailureTrace({
        input,
        message: failedMessage,
        sessionId,
        runId,
      });
      sessionId = failureTrace.sessionId;
      runId = failureTrace.runId;
      tracePath = failureTrace.tracePath;
      resolveOnce();
    });
  });

  try {
    await terminal;
    const failureSummary = summarizeUnhandledToolFailures(eventSummary);
    if (failureSummary) writeLine(io.stderr, failureSummary);
    return {
      exitCode: cliExitCodeForRun({
        failedMessage,
        runState,
        events: eventSummary,
      }),
      tracePath,
      sessionId,
      runState,
      stopReason,
    };
  } finally {
    writeLine(
      io.stdout,
      `Run ${runState ?? "unknown"}${stopReason ? ` (${stopReason})` : ""}`,
    );
    writeLine(
      io.stdout,
      summarizeWorkspaceMutations({
        shouldWrite,
        completed: eventSummary.writeCompleted,
        skipped: eventSummary.writeSkipped,
        denied: eventSummary.writeDenied,
      }),
    );
    if (tracePath && existsSync(tracePath))
      writeLine(io.stdout, `Trace written to ${tracePath}`);
    await closeClient(client);
  }
}

function shouldForwardHostLogs(
  env: Record<string, string | undefined>,
): boolean {
  const value = env.SPARKWRIGHT_CLI_HOST_LOGS?.trim().toLowerCase();
  return (
    value === "1" || value === "true" || value === "yes" || value === "debug"
  );
}

async function closeClient(client: Client | undefined): Promise<void> {
  if (!client) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.off("disconnect", finish);
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    client.on("disconnect", finish);
    client.close();
  });
}

async function writeHostStartFailureTrace(input: {
  input: HostRunInput | HostResumeInput;
  message: string;
  sessionId?: string;
  runId?: string;
}): Promise<{ tracePath?: string; sessionId?: string; runId?: string }> {
  const sessionId = input.sessionId ?? createSessionId();
  const runId = (input.runId ?? createRunId()) as RunRecord["id"];
  const now = new Date().toISOString();
  const goal =
    "goal" in input.input
      ? input.input.goal
      : `resume ${input.input.runId}`.trim();
  const run: RunRecord = {
    id: runId,
    goal,
    state: "failed",
    stopReason: "model_completion_failed",
    createdAt: now,
    updatedAt: now,
    metadata: {
      source: "cli",
      failurePhase: "host_start",
      targetPath: input.input.targetPath,
      shouldWrite: input.input.shouldWrite,
      traceLevel: input.input.traceLevel,
    },
  };
  const result: RunResult = {
    signal: "failed",
    state: "failed",
    stopReason: "model_completion_failed",
    message: input.message,
    failure: {
      category: "runtime",
      code: "HOST_START_FAILED",
      message: input.message,
      retryable: false,
    },
    metadata: run.metadata,
  };

  try {
    const sessionRootDir = input.input.sessionRootDir;
    const sessionStore = new FileSessionStore({ rootDir: sessionRootDir });
    const store = createSessionRunStoreFactory({
      sessionStore,
      sessionId,
      runStoreFactory: createSessionFileRunStoreFactory({
        sessionRootDir,
        sessionId,
        agentId: "main",
        traceLevel: input.input.traceLevel,
      }),
      metadata: { source: "cli" },
    })(run);
    const events = new EventLog(runId);
    await store.append(events.emit("run.created", { goal: run.goal }));
    const capabilityFailure = inferCapabilityIndexFailure(input.message);
    if (capabilityFailure) {
      await store.append(
        events.emit(
          "capability.index.failed",
          {
            kind: capabilityFailure.kind,
            source: capabilityFailure.source,
            message: input.message,
            code: capabilityFailure.code,
          },
          {
            source: "cli",
            failurePhase: "host_start",
          },
        ),
      );
    }
    await store.append(
      events.emit("run.failed", {
        reason: "host_start_failed",
        code: "HOST_START_FAILED",
        message: input.message,
        failure: {
          category: "runtime",
          code: "HOST_START_FAILED",
          message: input.message,
          retryable: false,
        },
        metadata: run.metadata,
      }),
    );
    await store.finish(run, result);
    return {
      tracePath: join(sessionRootDir, sessionId, "trace.jsonl"),
      sessionId,
      runId,
    };
  } catch {
    return { sessionId: input.sessionId, runId: input.runId };
  }
}

function inferCapabilityIndexFailure(message: string):
  | {
      kind: "skills";
      code: "SKILL_INDEX_FAILED";
      source?: string;
    }
  | undefined {
  if (!/\bskill\b/i.test(message)) return undefined;
  const source = message.match(/(?:^|\s)(\/[^\n:]+SKILL\.md)\b/)?.[1];
  return {
    kind: "skills",
    code: "SKILL_INDEX_FAILED",
    ...(source ? { source } : {}),
  };
}

function formatHostError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function resolveHostCommand(env: Record<string, string | undefined>): string {
  return env.SPARKWRIGHT_HOST_COMMAND ?? process.execPath;
}

function resolveHostArgs(env: Record<string, string | undefined>): string[] {
  if (env.SPARKWRIGHT_HOST_BIN) return [env.SPARKWRIGHT_HOST_BIN];
  if (env.SPARKWRIGHT_HOST_SOURCE === "1") {
    return [require.resolve("tsx/cli"), resolveHostSourceBin()];
  }
  return [resolveHostBin()];
}

function resolveHostBin(): string {
  return require.resolve("@sparkwright/host/dist/bin.js");
}

function resolveHostSourceBin(): string {
  return join(dirname(dirname(resolveHostBin())), "src", "bin.ts");
}
