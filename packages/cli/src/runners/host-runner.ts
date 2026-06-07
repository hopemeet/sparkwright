import { createRequire } from "node:module";
import { join } from "node:path";
import type {
  ApprovalResolver,
  PermissionMode,
  SparkwrightEvent,
  TraceLevel,
} from "@sparkwright/core";
import { createClient, type Client } from "@sparkwright/sdk-node";
import { createCliApprovalResolver } from "../cli-approval.js";
import { formatEvent } from "../event-format.js";
import type { CliIO } from "../io.js";
import { writeLine } from "../io.js";

const require = createRequire(import.meta.url);

export interface HostRunInput {
  goal: string;
  workspaceRoot: string;
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
  let writeCompletedCount = 0;
  let writeSkippedCount = 0;
  let writeDeniedCount = 0;

  let tracePath = sessionId
    ? join(workspaceRoot, ".sparkwright", "sessions", sessionId, "trace.jsonl")
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
          command: process.execPath,
          args: [
            resolveHostBin(),
            "--stdio",
            "--workspace",
            workspaceRoot,
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
        if (line) writeLine(io.stderr, line);
      });

      client.on("run.event", (msg) => {
        const event = msg.payload.event as SparkwrightEvent;
        if (event.type === "workspace.write.completed")
          writeCompletedCount += 1;
        else if (event.type === "workspace.write.skipped")
          writeSkippedCount += 1;
        else if (event.type === "workspace.write.denied") writeDeniedCount += 1;
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
        resolveOnce();
      });

      client.on("run.failed", (msg) => {
        runId = msg.payload.runId || runId;
        failedMessage = msg.payload.error.message;
        runState = "failed";
        stopReason = msg.payload.error.code;
        writeLine(io.stderr, failedMessage);
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
          resolveOnce();
        }
      });

      if ("goal" in input) {
        const started = await client.startRun({
          goal: input.goal,
          sessionId,
          model: modelName,
          permissionMode,
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
          tracePath = join(
            workspaceRoot,
            ".sparkwright",
            "sessions",
            sessionId,
            "trace.jsonl",
          );
        }
      }
    })().catch((error: unknown) => {
      failedMessage = formatHostError(error);
      runState = "failed";
      stopReason = "host_start_failed";
      writeLine(io.stderr, failedMessage);
      resolveOnce();
    });
  });

  try {
    await terminal;
    return {
      exitCode: failedMessage ? 1 : 0,
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
        completed: writeCompletedCount,
        skipped: writeSkippedCount,
        denied: writeDeniedCount,
      }),
    );
    if (tracePath) writeLine(io.stdout, `Trace written to ${tracePath}`);
    client?.close();
  }
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

function resolveHostBin(): string {
  return require.resolve("@sparkwright/host/dist/bin.js");
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
