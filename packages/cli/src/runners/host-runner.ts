import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
  ApprovalResolver,
  PermissionMode,
  SparkwrightEvent,
  TraceLevel,
} from "@sparkwright/core";
import { createClient, type Client } from "@sparkwright/sdk-node";
import { writeHostStartFailureTrace } from "@sparkwright/host";
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
  targetPath?: string;
  confidentialPaths?: readonly string[];
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
  targetPath?: string;
  confidentialPaths?: readonly string[];
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
    confidentialPaths,
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
          ...(confidentialPaths && confidentialPaths.length > 0
            ? { confidentialPaths: [...confidentialPaths] }
            : {}),
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
          ...(confidentialPaths && confidentialPaths.length > 0
            ? { confidentialPaths: [...confidentialPaths] }
            : {}),
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
        goal: "goal" in input ? input.goal : `resume ${input.runId}`.trim(),
        message: failedMessage,
        sessionRootDir: input.sessionRootDir,
        source: "cli",
        sessionId,
        runId,
        traceLevel: input.traceLevel,
        targetPath: input.targetPath,
        shouldWrite: input.shouldWrite,
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
