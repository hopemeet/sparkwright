import { existsSync } from "node:fs";
import type { ApprovalResolver, SparkwrightEvent } from "@sparkwright/core";
import type {
  BackgroundTaskPolicy,
  PermissionMode,
  RunInputPayload,
  RunAccessMode,
  TraceLevel,
} from "@sparkwright/protocol";
import { getRunFailure, runFailureMessage } from "@sparkwright/protocol";
import { createClient, type Client } from "@sparkwright/sdk-node";
import {
  createHostClientRunMetadata,
  createHostResumeRunRequest,
  createHostStartRunRequest,
  recordHostClientStartFailure,
  resolveHostStdioSpawn,
  tracePathForSession,
} from "@sparkwright/host";
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
  summarizeSkillLoadFailures,
  summarizeTerminalRunFailure,
  summarizeUnhandledToolFailures,
  summarizeUnsupportedFinalClaims,
  summarizeVerificationCommandFailures,
  summarizeVerificationProfileResults,
  summarizeWorkspaceMutations,
  updateCliRunEventSummary,
} from "../run-outcome.js";

export interface HostRunInput {
  goal: string;
  workspaceRoot: string;
  sessionRootDir: string;
  shouldWrite: boolean;
  approveAll: boolean;
  approveEdits?: boolean;
  approveShellSafe?: boolean;
  accessMode?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  permissionMode: PermissionMode;
  modelName?: string;
  workflowName?: string;
  sessionId: string;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  traceLevel: TraceLevel;
  input?: RunInputPayload;
  verbose?: boolean;
}

export interface HostResumeInput {
  runId: string;
  workspaceRoot: string;
  sessionRootDir: string;
  shouldWrite: boolean;
  approveAll: boolean;
  approveEdits?: boolean;
  approveShellSafe?: boolean;
  accessMode?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  permissionMode: PermissionMode;
  modelName?: string;
  workflowName?: string;
  sessionId?: string;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  traceLevel: TraceLevel;
  fromTrace: boolean;
  force: boolean;
  verbose?: boolean;
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
    approveEdits,
    approveShellSafe,
    accessMode,
    backgroundTasks,
    permissionMode,
    modelName,
    workflowName,
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
  const liveEvents = createLiveEventFormatter({ verbose: input.verbose });

  let tracePath = tracePathForSession({ sessionRootDir, sessionId });

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
          ...resolveHostStdioSpawn({
            workspaceRoot,
            sessionRootDir,
            permissionMode,
            modelName,
            env,
          }),
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
        for (const line of liveEvents.format(event)) writeLine(io.stdout, line);
      });

      client.on("approval.requested", (msg) => {
        const resolver = createCliApprovalResolver({
          approveAll,
          approveEdits,
          approveShellSafe,
          permissionMode,
          io,
        });
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
              autoApproved: decision.autoApproved,
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
        for (const line of liveEvents.flush()) writeLine(io.stdout, line);
        runId = msg.payload.runId;
        runState = msg.payload.state;
        stopReason = msg.payload.stopReason;
        if (runState !== "completed") {
          const failure = getRunFailure(msg.payload);
          failedMessage =
            summarizeRunFailure(eventSummary, {
              state: runState,
              stopReason,
            }) ??
            summarizeTerminalRunFailure({
              state: runState,
              stopReason,
              failure,
            }) ??
            failedMessage ??
            (failure ? runFailureMessage(msg.payload) : undefined) ??
            `Run finished with state ${runState}${stopReason ? ` (${stopReason})` : ""}`;
          if (!terminalFailurePrinted) {
            writeLine(io.stderr, failedMessage);
            terminalFailurePrinted = true;
          }
        }
        resolveOnce();
      });

      client.on("run.failed", (msg) => {
        for (const line of liveEvents.flush()) writeLine(io.stdout, line);
        runId = msg.payload.runId || runId;
        const failure = getRunFailure(msg.payload);
        failedMessage =
          summarizeTerminalRunFailure({
            state: "failed",
            stopReason: failure?.code ?? msg.payload.error.code,
            failure,
          }) ?? runFailureMessage(msg.payload);
        runState = "failed";
        stopReason = failure?.code ?? msg.payload.error.code;
        writeLine(io.stderr, failedMessage);
        terminalFailurePrinted = true;
        resolveOnce();
      });

      client.on("disconnect", (reason) => {
        if (!runState && !failedMessage) {
          for (const line of liveEvents.flush()) writeLine(io.stdout, line);
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
        const metadata = {
          ...createHostClientRunMetadata({
            source: "cli",
            targetPath,
            shouldWrite,
            accessMode,
            backgroundTasks,
            traceLevel,
            workflowName,
          }),
          ...inputMetadataSummary(input.input),
        };
        const started = await client.startRun(
          createHostStartRunRequest({
            goal: input.goal,
            sessionId,
            accessMode,
            backgroundTasks,
            permissionMode,
            targetPath,
            traceLevel,
            modelName,
            modelNameSource: "request",
            workflowName,
            confidentialPaths,
            shouldWrite,
            metadata,
            input: input.input,
          }),
        );
        runId = started.runId;
      } else {
        const metadata = createHostClientRunMetadata({
          source: "cli",
          targetPath,
          shouldWrite,
          accessMode,
          backgroundTasks,
          traceLevel,
        });
        const resumed = await client.resumeRun(
          createHostResumeRunRequest({
            runId: input.runId,
            sessionId,
            fromTrace: input.fromTrace,
            force: input.force,
            accessMode,
            backgroundTasks,
            permissionMode,
            targetPath,
            traceLevel,
            modelName,
            modelNameSource: "request",
            confidentialPaths,
            shouldWrite,
            metadata,
          }),
        );
        runId = resumed.runId;
        if (resumed.sessionId) {
          sessionId = resumed.sessionId;
          tracePath = tracePathForSession({ sessionRootDir, sessionId });
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
      const failureTrace = await recordHostClientStartFailure({
        goal: "goal" in input ? input.goal : undefined,
        resumeRunId: "runId" in input ? input.runId : undefined,
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
    const skillLoadFailureSummary = summarizeSkillLoadFailures(eventSummary);
    if (skillLoadFailureSummary) writeLine(io.stderr, skillLoadFailureSummary);
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
      failedMessage,
      runState,
      events: eventSummary,
    });
    return {
      exitCode,
      tracePath,
      sessionId,
      runState,
      stopReason,
    };
  } finally {
    const displayState =
      runState === "completed" && completedRunHasCliIssues(eventSummary)
        ? "completed_with_issues"
        : (runState ?? "unknown");
    writeLine(
      io.stdout,
      `Run ${displayState}${stopReason ? ` (${stopReason})` : ""}`,
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

function inputMetadataSummary(
  input: RunInputPayload | undefined,
): Record<string, unknown> {
  const parts = input?.parts ?? [];
  if (parts.length === 0) return {};
  const imageCount = parts.filter((part) => part.type === "image").length;
  return {
    input: {
      attachmentCount: parts.length,
      ...(imageCount > 0 ? { imageCount } : {}),
    },
  };
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
