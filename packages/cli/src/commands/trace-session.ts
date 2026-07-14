import { join } from "node:path";
import {
  asSessionId,
  buildTraceReportFile,
  buildTraceTimelineFile,
  FileSessionStore,
  loadCheckpointFromRunDir,
  loadTraceEventsFile,
  projectSessionReplayToContextItems,
  repairSessionTraceConsistency,
  resumeRunFromCheckpoint,
  summarizeTraceFile,
  validateSessionTraceConsistency,
  verifyTraceFile,
  type RunRecord,
  type SessionTraceConsistencyReport,
  type SessionTraceRepairReport,
  type TraceReport,
  type TraceSummary,
  type TraceTimeline,
  type TraceVerificationReport,
} from "@sparkwright/core";
import {
  createSessionFileRunStoreFactory,
  FileRunStore,
  LocalWorkspace,
} from "@sparkwright/core/internal";
import type { SessionCompactionInspectReport } from "@sparkwright/protocol";
import {
  createHostRunPolicy,
  loadHostConfig,
  type HostRuntime,
  type HostService,
} from "@sparkwright/host";
import { createCliApprovalResolver } from "../cli-approval.js";
import { createLiveEventFormatter, formatEvent } from "../event-format.js";
import type { CliIO } from "../io.js";
import { writeLine } from "../io.js";
import {
  createCliModel,
  createConfiguredCliTools,
  startDirectCoreRun,
} from "../runners/direct-core-runner.js";
import { resumeHostRun, startHostRun } from "../runners/host-runner.js";
import type { CliRunResult, ParsedArgs } from "./contracts.js";
import {
  parseNonNegativeInteger,
  parsePositiveInteger,
} from "../parser/numbers.js";

export async function handleTraceCommand(
  parsed: ParsedArgs,
  io: CliIO,
): Promise<CliRunResult> {
  if (!parsed.target) {
    writeLine(
      io.stderr,
      "Usage: sparkwright trace <summary|events|timeline|report|verify> <trace.jsonl>",
    );
    return { exitCode: 1 };
  }
  if (parsed.subcommand === "report") {
    const report = await buildTraceReportFile(parsed.target);
    writeLine(
      io.stdout,
      parsed.format === "text"
        ? formatTraceReport(report)
        : JSON.stringify(report, null, 2),
    );
    return { exitCode: 0 };
  }
  if (parsed.subcommand === "verify") {
    const report = await verifyTraceFile(parsed.target);
    writeLine(
      io.stdout,
      parsed.format === "text"
        ? formatTraceVerificationReport(report)
        : JSON.stringify(report, null, 2),
    );
    return { exitCode: report.ok ? 0 : 1 };
  }
  if (parsed.subcommand === "timeline") {
    const timeline = await buildTraceTimelineFile(parsed.target, {
      type: parsed.eventType,
      runId: parsed.runId,
      contains: parsed.contains,
    });
    writeLine(
      io.stdout,
      parsed.format === "text"
        ? formatTraceTimeline(timeline)
        : JSON.stringify(timeline, null, 2),
    );
    return { exitCode: 0 };
  }
  if (parsed.subcommand === "events") {
    const loaded = await loadTraceEventsFile(parsed.target, {
      type: parsed.eventType,
      runId: parsed.runId,
      contains: parsed.contains,
    });
    const events = loaded
      .filter(
        (event) =>
          (parsed.afterSequence === undefined ||
            event.sequence > parsed.afterSequence) &&
          (parsed.beforeSequence === undefined ||
            event.sequence < parsed.beforeSequence),
      )
      .slice(0, parsed.limit);
    writeLine(
      io.stdout,
      parsed.jsonl
        ? events.map((event) => JSON.stringify(event)).join("\n")
        : parsed.format === "text"
          ? events.map(formatEvent).join("\n")
          : JSON.stringify(events, null, 2),
    );
    return { exitCode: 0 };
  }
  const summary = await summarizeTraceFile(parsed.target);
  writeLine(
    io.stdout,
    parsed.format === "text"
      ? formatTraceSummary(summary)
      : JSON.stringify(summary, null, 2),
  );
  return { exitCode: 0 };
}

export async function handleSessionCommand(
  parsed: ParsedArgs,
  io: CliIO,
  hostService: Pick<HostService, "createRuntime">,
): Promise<CliRunResult> {
  if (!parsed.target) {
    writeLine(
      io.stderr,
      "Usage: sparkwright session <summary|inspect|check|repair|compact|resume> <session-id> [goal] [--workspace path] [--session-root path] [--model provider/model] [--llm] [--compaction]",
    );
    return { exitCode: 1 };
  }
  let sessionId: string;
  try {
    sessionId = asSessionId(parsed.target);
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1, sessionId: parsed.target };
  }

  const sessionDir = join(parsed.sessionRootDir, sessionId);

  if (parsed.subcommand === "summary") {
    const summary = await summarizeTraceFile(join(sessionDir, "trace.jsonl"));
    writeLine(
      io.stdout,
      parsed.format === "text"
        ? formatTraceSummary(summary)
        : JSON.stringify(summary, null, 2),
    );
    return { exitCode: 0, sessionId };
  }

  if (parsed.subcommand === "repair") {
    const report = await repairSessionTraceConsistency({
      sessionDir,
      apply: parsed.apply,
    });
    writeLine(
      io.stdout,
      parsed.format === "text"
        ? formatRepairReport(report)
        : JSON.stringify(report, null, 2),
    );
    return { exitCode: 0, sessionId };
  }

  if (parsed.subcommand === "compact") {
    const runtime = hostService.createRuntime({
      workspaceRoot: parsed.workspaceRoot,
      sessionRootDir: parsed.sessionRootDir,
      defaultModel: parsed.modelName,
      emit: () => {},
    });
    const result = await runtime.compactSession(
      sessionId,
      "cli session compact",
      { llm: parsed.llm },
    );
    if (!result.ok) {
      writeLine(io.stderr, `${result.error.code}: ${result.error.message}`);
      return { exitCode: 1, sessionId };
    }
    writeLine(
      io.stdout,
      parsed.format === "text"
        ? formatSessionCompactResult(result)
        : JSON.stringify(result, null, 2),
    );
    return { exitCode: 0, sessionId };
  }

  if (parsed.subcommand === "inspect") {
    const runtime = hostService.createRuntime({
      workspaceRoot: parsed.workspaceRoot,
      sessionRootDir: parsed.sessionRootDir,
      defaultModel: parsed.modelName,
      emit: () => {},
    });
    if (parsed.compaction) {
      const result = await runtime.inspectSessionCompaction(sessionId);
      if (!result.ok) {
        writeLine(io.stderr, `${result.error.code}: ${result.error.message}`);
        return { exitCode: 1, sessionId };
      }
      writeLine(
        io.stdout,
        parsed.format === "text"
          ? formatSessionCompactionInspectReport(
              result.sessionId,
              result.compaction,
            )
          : JSON.stringify(result, null, 2),
      );
      return { exitCode: 0, sessionId };
    }

    const result = await runtime.inspectSession(sessionId);
    if (!result.ok) {
      writeLine(io.stderr, `${result.error.code}: ${result.error.message}`);
      return { exitCode: 1, sessionId };
    }
    writeLine(
      io.stdout,
      parsed.format === "text"
        ? formatSessionInspectResult(result)
        : JSON.stringify(result, null, 2),
    );
    return { exitCode: 0, sessionId };
  }

  const report = await validateSessionTraceConsistency({ sessionDir });
  writeLine(
    io.stdout,
    parsed.format === "text"
      ? formatConsistencyReport(report)
      : JSON.stringify(report, null, 2),
  );
  return { exitCode: report.ok ? 0 : 1, sessionId };
}

export async function handleSessionResumeCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  if (!parsed.target || !parsed.goal) {
    writeLine(
      io.stderr,
      "Usage: sparkwright session resume <session-id> <goal> [--workspace path] [--session-root path] [--model provider/model]",
    );
    return { exitCode: 1 };
  }
  let sessionId: string;
  try {
    sessionId = asSessionId(parsed.target);
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1, sessionId: parsed.target };
  }

  const sessionRootDir = parsed.sessionRootDir;
  const sessionStore = new FileSessionStore({ rootDir: sessionRootDir });
  const session = await sessionStore.get(sessionId);
  if (!session) {
    writeLine(io.stderr, `Session not found: ${sessionId}`);
    return { exitCode: 1, sessionId };
  }

  const tracePath = join(sessionRootDir, session.id, "trace.jsonl");
  const runStore = {
    async *loadEvents(runId: string) {
      yield* await loadTraceEventsFile(tracePath, { runId });
    },
  };
  const contextItems = await projectSessionReplayToContextItems({
    session,
    runStore,
    title: "Prior session context",
  });

  const runInput = {
    ...parsed,
    sessionId: session.id,
    contextItems,
    policyTargetPath:
      parsed.targetPathSource === "cli" ? parsed.targetPath : undefined,
  };
  return parsed.directCore
    ? startDirectCoreRun(runInput, io, env)
    : startHostRun(
        {
          ...runInput,
          modelName:
            parsed.modelNameSource === "cli" ? parsed.modelName : undefined,
        },
        io,
        env,
      );
}

export async function handleRunResumeCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  if (!parsed.runId) {
    writeLine(
      io.stderr,
      "Usage: sparkwright run resume <run-id> [--session <session-id>] [--workspace path] [--session-root path] [--force] [--from-trace]",
    );
    return { exitCode: 1 };
  }

  if (!parsed.directCore) {
    return resumeHostRun(
      {
        runId: parsed.runId,
        workspaceRoot: parsed.workspaceRoot,
        sessionRootDir: parsed.sessionRootDir,
        runAccess: parsed.runAccess,
        approvalOptions: parsed.approvalOptions,
        modelName:
          parsed.modelNameSource === "cli" ? parsed.modelName : undefined,
        sessionId: parsed.sessionId,
        targetPath:
          parsed.targetPathSource === "cli" ? parsed.targetPath : undefined,
        confidentialPaths: parsed.confidentialPaths,
        confidentialDefaults: parsed.confidentialDefaults,
        traceLevel: parsed.traceLevel,
        fromTrace: parsed.fromTrace,
        force: parsed.force,
        verbose: parsed.verbose,
      },
      io,
      env,
    );
  }

  // Locate the run directory. Two layouts are supported:
  //   - session-scoped: <workspace>/.sparkwright/sessions/<sid>/agents/main/runs/<rid>/
  //   - legacy:        <workspace>/.sparkwright/runs/<rid>/
  const sessionsRoot = parsed.sessionRootDir;
  const legacyRunDir = join(
    parsed.workspaceRoot,
    ".sparkwright",
    "runs",
    parsed.runId,
  );
  let runDir: string | undefined;
  let resolvedSessionId: string | undefined;

  if (parsed.sessionId) {
    runDir = join(
      sessionsRoot,
      parsed.sessionId,
      "agents",
      "main",
      "runs",
      parsed.runId,
    );
    resolvedSessionId = parsed.sessionId;
  } else {
    // Scan sessions/*/agents/*/runs/<runId>/ for a match.
    const { readdir } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    if (existsSync(sessionsRoot)) {
      const sessions = await readdir(sessionsRoot, { withFileTypes: true });
      for (const sessionEntry of sessions) {
        if (!sessionEntry.isDirectory()) continue;
        const agentsDir = join(sessionsRoot, sessionEntry.name, "agents");
        if (!existsSync(agentsDir)) continue;
        const agents = await readdir(agentsDir, { withFileTypes: true });
        for (const agentEntry of agents) {
          if (!agentEntry.isDirectory()) continue;
          const candidate = join(
            agentsDir,
            agentEntry.name,
            "runs",
            parsed.runId,
          );
          if (existsSync(candidate)) {
            runDir = candidate;
            resolvedSessionId = sessionEntry.name;
            break;
          }
        }
        if (runDir) break;
      }
    }
    if (!runDir && existsSync(legacyRunDir)) {
      runDir = legacyRunDir;
    }
  }

  if (!runDir) {
    writeLine(
      io.stderr,
      `Could not find run directory for ${parsed.runId} under ${parsed.sessionRootDir} or ${parsed.workspaceRoot}/.sparkwright/runs. ` +
        `Pass --session <session-id> to disambiguate.`,
    );
    return { exitCode: 1 };
  }

  const checkpoint = loadCheckpointFromRunDir(runDir, {
    fallbackFromTrace: parsed.fromTrace,
  });
  if (!checkpoint) {
    writeLine(
      io.stderr,
      `No checkpoint.json under ${runDir}. ` +
        `Re-run with --from-trace to reconstruct one from the trace (best-effort, requires --force).`,
    );
    return { exitCode: 1 };
  }
  if (!checkpoint.resumability.complete && !parsed.force) {
    writeLine(
      io.stderr,
      `Checkpoint is not fully resumable (reasons: ${checkpoint.resumability.reasons.join(", ") || "unspecified"}). ` +
        `Re-run with --force to attempt a best-effort resume.`,
    );
    return { exitCode: 1, sessionId: resolvedSessionId };
  }

  const model = await createCliModel({
    modelRef: parsed.modelName,
    cwd: parsed.workspaceRoot,
    env,
    targetPath: parsed.targetPath,
    shouldWrite: parsed.runAccess.shouldWrite,
    goal: checkpoint.run.goal,
  });
  if (!model.ok) {
    writeLine(io.stderr, model.message);
    return { exitCode: 1 };
  }

  const workspace = new LocalWorkspace(parsed.workspaceRoot);
  const approvalResolver = createCliApprovalResolver({
    approveAll: parsed.approvalOptions.approveAll,
    approveEdits: parsed.approvalOptions.approveEdits,
    approveShellSafe: parsed.approvalOptions.approveShellSafe,
    permissionMode: parsed.runAccess.permissionMode,
    io,
  });
  const loadedConfig = await loadHostConfig(parsed.workspaceRoot, env);
  const policy = createHostRunPolicy({
    permissionMode: parsed.runAccess.permissionMode,
    shouldWrite: parsed.runAccess.shouldWrite,
    targetPath:
      parsed.targetPathSource === "cli" ? parsed.targetPath : undefined,
    writeGuardrails: loadedConfig.config.write,
    confidentialDefaults: parsed.confidentialDefaults,
    confidentialPaths: parsed.confidentialPaths,
  });
  const tools = await createConfiguredCliTools(parsed.workspaceRoot, env);

  // Wire a FileRunStore pointing at the same run dir so the resumed run's
  // new events append to the existing trace (keeps replay/inspection coherent).
  let store: FileRunStore | undefined;
  const runStoreFactory =
    resolvedSessionId !== undefined
      ? createSessionFileRunStoreFactory({
          sessionRootDir: sessionsRoot,
          sessionId: resolvedSessionId,
          agentId: "main",
          traceLevel: parsed.traceLevel,
        })
      : (record: RunRecord) =>
          new FileRunStore(record, {
            rootDir: join(parsed.workspaceRoot, ".sparkwright", "runs"),
            traceLevel: parsed.traceLevel,
          });

  let run;
  try {
    run = resumeRunFromCheckpoint(checkpoint, {
      force: parsed.force,
      workspace,
      approvalResolver,
      policy,
      tools,
      model: model.adapter,
      runStore: (record) => {
        store = runStoreFactory(record);
        return store;
      },
    });
  } catch (err) {
    writeLine(io.stderr, err instanceof Error ? err.message : String(err));
    return { exitCode: 1, sessionId: resolvedSessionId };
  }

  const liveEvents = createLiveEventFormatter({ verbose: parsed.verbose });
  for (const event of run.events.all()) {
    for (const line of liveEvents.format(event)) writeLine(io.stdout, line);
  }
  run.events.subscribe((event) => {
    for (const line of liveEvents.format(event)) writeLine(io.stdout, line);
  });

  try {
    const result = await run.start();
    return {
      exitCode: result.signal === "completed" ? 0 : 1,
      tracePath: store?.tracePath,
      sessionId: resolvedSessionId,
      runState: result.state,
      stopReason: result.stopReason,
    };
  } finally {
    for (const line of liveEvents.flush()) writeLine(io.stdout, line);
    writeLine(
      io.stdout,
      `Resumed run ${run.record.state}${run.record.stopReason ? ` (${run.record.stopReason})` : ""}`,
    );
  }
}

function formatTraceSummary(summary: TraceSummary): string {
  const topTypes = Object.entries(summary.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, count]) => `${type}:${count}`)
    .join(", ");
  const topErrors = Object.entries(summary.errorCodes ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => `${code}:${count}`)
    .join(", ");
  const topDenials = Object.entries(summary.expectedDenialCodes ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => `${code}:${count}`)
    .join(", ");
  const topToolCalls = formatTopCounts(summary.toolCalls, 8);
  const topToolFailures = formatTopCounts(summary.toolFailures?.byCode, 5);
  const topCommandFailures = formatTopCounts(
    summary.commandFailures?.byExitCode,
    5,
  );
  const unresolvedToolFailures = formatTopCounts(
    summary.toolFailures?.unresolved?.byCode,
    5,
  );
  const recoveredToolFailures = formatTopCounts(
    summary.toolFailures?.recovered?.byCode,
    5,
  );
  const duplicateReads = formatTopCounts(
    summary.workspaceReads?.duplicatePaths,
    8,
  );
  return [
    `events: ${summary.eventCount}`,
    `runs: ${summary.runIds.length}`,
    `sessions: ${summary.sessionIds.join(", ") || "(none)"}`,
    `agents: ${summary.agentIds.join(", ") || "(none)"}`,
    `subagents: ${summary.subagentIds?.join(", ") || "(none)"}`,
    `artifacts: ${summary.artifactCount}`,
    `errors: ${summary.errorCount}`,
    `top errors: ${topErrors || "(none)"}`,
    `expected denials: ${summary.expectedDenialCount ?? 0}`,
    `top expected denials: ${topDenials || "(none)"}`,
    `tokens: ${summary.usage.totalTokens}`,
    formatTraceCost(summary.usage),
    `tool calls: ${sumCounts(summary.toolCalls)} total${topToolCalls ? ` (${topToolCalls})` : ""}`,
    `tool failures: ${summary.toolFailures?.total ?? 0} total${topToolFailures ? ` (${topToolFailures})` : ""}`,
    `unresolved tool failures: ${summary.toolFailures?.unresolved?.total ?? 0} total${unresolvedToolFailures ? ` (${unresolvedToolFailures})` : ""}`,
    `recovered tool failures: ${summary.toolFailures?.recovered?.total ?? 0} total${recoveredToolFailures ? ` (${recoveredToolFailures})` : ""}`,
    `command failures: ${summary.commandFailures?.total ?? 0} total${topCommandFailures ? ` (${topCommandFailures})` : ""}`,
    `verification failures: ${summary.commandFailures?.verification?.total ?? 0} total, ${summary.commandFailures?.verification?.unresolved ?? 0} unresolved${summary.commandFailures?.verification?.lastCommand ? `, last unresolved ${summary.commandFailures.verification.lastCommand}` : ""}${summary.commandFailures?.verification?.lastSuccessfulVerificationCommand ? `, last success ${summary.commandFailures.verification.lastSuccessfulVerificationCommand}` : ""}`,
    `approvals: ${summary.safety?.approvals?.requested ?? 0} requested, ${summary.safety?.approvals?.approved ?? 0} approved, ${summary.safety?.approvals?.denied ?? 0} denied, ${summary.safety?.approvals?.autoApproved ?? 0} auto-approved`,
    `safety: shell approvals ${summary.safety?.shell?.approvals ?? 0}, shell mutations ${summary.safety?.shell?.untrackedWorkspaceMutations ?? 0}, confidential reads denied ${summary.safety?.confidentialReadsDenied ?? 0}, managed workspace writes ${summary.safety?.workspaceWrites?.completed ?? 0} applied/${summary.safety?.workspaceWrites?.denied ?? 0} denied/${summary.safety?.workspaceWrites?.skipped ?? 0} skipped, untracked write-capable boundaries ${summary.safety?.workspaceWrites?.untrackedWriteCapableProcesses ?? 0}, capability mutations ${summary.safety?.capabilityMutations?.completed ?? 0} completed`,
    `workspace reads: ${summary.workspaceReads?.total ?? 0} total, ${summary.workspaceReads?.uniquePaths ?? 0} unique${duplicateReads ? `, duplicates ${duplicateReads}` : ""}`,
    `top event types: ${topTypes || "(none)"}`,
  ].join("\n");
}

function formatTopCounts(
  counts: Record<string, number> | undefined,
  limit: number,
): string {
  if (!counts) return "";
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => `${key}:${count}`)
    .join(", ");
}

function sumCounts(counts: Record<string, number> | undefined): number {
  if (!counts) return 0;
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function formatTraceCost(summary: TraceSummary["usage"]): string {
  const status = summary.costStatus;
  const cost = summary.estimatedCostUsd;
  if (status === "estimated") return `cost: $${cost.toFixed(6)} estimated`;
  if (status === "partial") {
    return `cost: $${cost.toFixed(6)} partial${formatCostReasons(summary.costUnavailableReasons)}`;
  }
  if (status === "unavailable") {
    return `cost: unavailable${formatCostReasons(summary.costUnavailableReasons)}`;
  }
  return "cost: unavailable (not reported)";
}

function formatTraceReport(report: TraceReport): string {
  const lines = [
    `verdict: ${report.verdict}`,
    `headline: ${report.headline}`,
    `runs: ${report.summary.runCount}, sessions: ${report.summary.sessionCount}, events: ${report.summary.eventCount}`,
    `model/tool: ${report.summary.modelCalls} model calls, ${report.summary.toolCalls} tool calls`,
    `tokens: ${report.summary.totalTokens}`,
    `safety: ${report.summary.workspaceWrites} workspace writes, ${report.summary.approvalsRequested} approvals requested`,
  ];

  const topTools = formatTopCounts(report.topTools, 5);
  if (topTools) lines.push(`top tools: ${topTools}`);

  const duplicateReads = formatTopCounts(report.topDuplicateReads, 5);
  if (duplicateReads) lines.push(`top duplicate reads: ${duplicateReads}`);

  if (report.findings.length === 0) {
    lines.push("findings: none");
    return lines.join("\n");
  }

  lines.push("findings:");
  for (const finding of report.findings) {
    lines.push(
      `- [${finding.severity}] ${finding.code}: ${finding.title}`,
      `  evidence: ${finding.evidence.join("; ") || "(none)"}`,
      `  recommendation: ${finding.recommendation}`,
    );
  }
  return lines.join("\n");
}

function formatCostReasons(
  reasons: Record<string, number> | undefined,
): string {
  if (!reasons || Object.keys(reasons).length === 0) return "";
  return ` (${Object.entries(reasons)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason}:${count}`)
    .join(", ")})`;
}

function formatTraceTimeline(timeline: TraceTimeline): string {
  const showRunIds = timeline.runIds.length > 1;
  const lines = [
    `events: ${timeline.eventCount}`,
    `runs: ${timeline.runIds.length}`,
    `durationMs: ${timeline.durationMs ?? 0}`,
    `phases: ${timeline.phases.length}`,
  ];
  for (const phase of timeline.phases.slice(0, 80)) {
    const duration =
      phase.durationMs === undefined ? "pending" : `${phase.durationMs}ms`;
    const runPrefix = showRunIds ? `${shortTraceRunId(phase.runId)} ` : "";
    lines.push(
      `${runPrefix}[${phase.startSequence}${phase.endSequence ? `-${phase.endSequence}` : ""}] ${phase.status} ${phase.category} ${phase.label} (${duration})`,
    );
  }
  if (timeline.phases.length > 80) {
    lines.push(`... ${timeline.phases.length - 80} more phase(s)`);
  }
  return lines.join("\n");
}

function shortTraceRunId(runId: string): string {
  return runId.length > 14 ? `${runId.slice(0, 8)}..${runId.slice(-4)}` : runId;
}

function formatConsistencyReport(
  report: SessionTraceConsistencyReport,
): string {
  const warningCount = report.findings.filter(
    (finding) => finding.severity === "warning",
  ).length;
  const status = report.ok
    ? warningCount > 0
      ? "ok_with_warnings"
      : "ok"
    : "failed";
  const lines = [
    `status: ${status}`,
    `session: ${report.sessionId ?? "(unknown)"}`,
    `runs: ${report.runIds.length}`,
    `findings: ${report.findings.length}`,
  ];
  for (const finding of report.findings) {
    lines.push(`${finding.severity} ${finding.code}: ${finding.message}`);
  }
  return lines.join("\n");
}

type SessionCompactCliResult = Extract<
  Awaited<ReturnType<HostRuntime["compactSession"]>>,
  { ok: true }
>;

type SessionInspectCliResult = Extract<
  Awaited<ReturnType<HostRuntime["inspectSession"]>>,
  { ok: true }
>;

function formatSessionInspectResult(result: SessionInspectCliResult): string {
  const summary = result.summary;
  const consistency = result.consistency;
  const timeline = result.timeline;
  return [
    `session: ${result.sessionId}`,
    `events: ${numberField(summary, "eventCount") ?? 0}`,
    `runs: ${arrayLength(summary, "runIds") ?? 0}`,
    `consistency: ${booleanField(consistency, "ok") === false ? "failed" : "ok"}`,
    `findings: ${arrayLength(consistency, "findings") ?? 0}`,
    `phases: ${arrayLength(timeline, "phases") ?? 0}`,
  ].join("\n");
}

function formatSessionCompactionInspectReport(
  sessionId: string,
  report: SessionCompactionInspectReport,
): string {
  const lines = [
    `session: ${sessionId}`,
    `status: ${report.status}`,
    `artifact: ${report.artifact?.path ?? "(none)"}`,
    `events: ${report.events.length}`,
    `latestEvent: ${report.latestEvent?.type ?? "(none)"}`,
    `consistency: ${report.consistency.ok ? "ok" : "failed"}`,
  ];
  if (report.artifact) {
    lines.push(
      `throughRunId: ${report.artifact.throughRunId}`,
      `compactedRunCount: ${report.artifact.compactedRunCount}`,
      `sourceRunIds: ${report.artifact.sourceRunIds.join(", ") || "(none)"}`,
      `originalCharCount: ${report.artifact.originalCharCount}`,
      `summaryCharCount: ${report.artifact.summaryCharCount}`,
      `freedChars: ${report.artifact.freedChars}`,
    );
    if (report.artifact.measurement) {
      lines.push(
        `regime: ${report.artifact.measurement.regime}`,
        `savingsRatio: ${report.artifact.measurement.savingsRatio.toFixed(4)}`,
      );
    }
    if (report.artifact.mode) lines.push(`mode: ${report.artifact.mode}`);
    if (report.artifact.reason) {
      lines.push(`reason: ${report.artifact.reason}`);
    }
    if (report.artifact.warningCodes?.length) {
      lines.push(`warnings: ${report.artifact.warningCodes.join(", ")}`);
    }
    if (report.artifact.summaryFingerprint) {
      const modelId = stringField(
        report.artifact.summaryFingerprint,
        "modelId",
      );
      const inputHash = stringField(
        report.artifact.summaryFingerprint,
        "inputHash",
      );
      lines.push(
        `fingerprint: model=${modelId ?? "(unknown)"}, inputHash=${inputHash ?? "(unknown)"}`,
      );
    }
  }
  for (const event of report.events.slice(-5)) {
    lines.push(
      `event ${event.sequence}: ${event.type} freedChars=${event.freedChars} artifact=${event.artifactPath ?? "(none)"}${event.skippedReason ? ` skippedReason=${event.skippedReason}` : ""}`,
    );
  }
  for (const finding of report.consistency.findings) {
    lines.push(`finding: ${finding}`);
  }
  return lines.join("\n");
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  return typeof value[key] === "number" ? value[key] : undefined;
}

function booleanField(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  return typeof value[key] === "boolean" ? value[key] : undefined;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function arrayLength(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  return Array.isArray(value[key]) ? value[key].length : undefined;
}

function formatSessionCompactResult(result: SessionCompactCliResult): string {
  const lines = [
    `status: ${result.skippedReason ? `skipped (${result.skippedReason})` : "compacted"}`,
    `session: ${result.sessionId}`,
    `compactedRunCount: ${result.compactedRunCount}`,
    `throughRunId: ${result.throughRunId ?? "(none)"}`,
    `originalCharCount: ${result.originalCharCount}`,
    `summaryCharCount: ${result.summaryCharCount}`,
    `freedChars: ${result.freedChars}`,
    `regime: ${result.measurement.regime}`,
    `savingsRatio: ${result.measurement.savingsRatio.toFixed(4)}`,
    `artifactPath: ${result.artifactPath ?? "(none)"}`,
  ];
  for (const warning of result.warnings ?? []) {
    lines.push(`warning ${warning.code}: ${warning.message}`);
  }
  return lines.join("\n");
}

function formatTraceVerificationReport(
  report: TraceVerificationReport,
): string {
  const lines = [
    `status: ${report.ok ? "ok" : "failed"}`,
    `events: ${report.eventCount}`,
    `runs: ${report.runIds.length}`,
    `sessions: ${report.sessionIds.join(", ") || "(none)"}`,
    `agents: ${report.agentIds.join(", ") || "(none)"}`,
    `findings: ${report.findings.length}`,
  ];
  for (const finding of report.findings) {
    lines.push(`${finding.severity} ${finding.code}: ${finding.message}`);
  }
  return lines.join("\n");
}

function formatRepairReport(report: SessionTraceRepairReport): string {
  const lines = [
    `mode: ${report.applied ? "applied" : "dry-run"}`,
    `actions: ${report.actions.length}`,
  ];
  for (const action of report.actions) {
    lines.push(`${action.kind} ${action.path}: ${action.reason}`);
  }
  if (report.after) {
    lines.push(`after: ${report.after.ok ? "ok" : "failed"}`);
  }
  return lines.join("\n");
}

// NOTE: init templates emit the preferred grouped form
// (identity/policy/run/ui) as commented YAML. Existing JSON configs keep
// working, and write commands preserve whichever format already exists.
