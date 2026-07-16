// AI maintenance note: derived trace diagnostics only. Do not import the
// trace facade or storage internals from this module.

import { readFile } from "node:fs/promises";
import type { SparkwrightEvent } from "./events.js";
import { evaluateTrajectory } from "./eval.js";
import {
  analyzeLowNetProgress,
  collectRepeatedToolRequests,
  type LowNetProgressInput,
  type RepeatedToolRequest,
} from "./run-health.js";
import {
  analyzeCommandOutcomes,
  analyzeCommandOutcomesFromFactLedger,
  analyzeToolOutcomes,
  isPolicyOrApprovalFailure,
  toolOutcomeSnapshot,
  type CommandOutcomeSummary,
  type ToolOutcomeSnapshot,
} from "./run-outcome.js";
import { isShellToolName, stableDiagnosticJson } from "./fact-classifier.js";
import {
  factLedgerSnapshotFromUnknown,
  type FactLedgerSnapshot,
} from "./fact-ledger.js";
import { serializeEventJsonl } from "./trace-codec.js";

export interface TraceSummary {
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  eventCount: number;
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  runIds: string[];
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  sessionIds: string[];
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  agentIds: string[];
  /** @reserved Public trace-summary field consumed by multi-agent diagnostics UIs. */
  subagentIds: string[];
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  byType: Record<string, number>;
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  terminalStates: Record<string, number>;
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  toolCalls: Record<string, number>;
  /** @reserved Public trace-summary field consumed by diagnostics UIs. */
  toolFailures: {
    total: number;
    byCode: Record<string, number>;
    unresolved: {
      total: number;
      byCode: Record<string, number>;
    };
    recovered: {
      total: number;
      byCode: Record<string, number>;
    };
    /**
     * Failures that followed a successful destructive mutation of the same
     * target ("succeeded, then same target returned not-found"). A subset of
     * `recovered`, surfaced separately for a high-signal report finding.
     */
    mutationFollowups: {
      total: number;
      targets: string[];
    };
  };
  /** @reserved Public trace-summary field consumed by diagnostics UIs. */
  commandFailures: {
    total: number;
    byExitCode: Record<string, number>;
    verification: {
      total: number;
      unresolved: number;
      lastCommand?: string;
      lastExitCode?: number | null;
      lastTimedOut?: boolean;
      lastFailureCommand?: string;
      lastFailureExitCode?: number | null;
      lastFailureTimedOut?: boolean;
      lastSuccessfulVerificationCommand?: string;
    };
  };
  /** @reserved Public trace-summary field consumed by diagnostics UIs. */
  safety: {
    approvals: {
      requested: number;
      resolved: number;
      approved: number;
      denied: number;
      autoApproved: number;
      shell: number;
      workspaceWrite: number;
    };
    workspaceWrites: {
      requested: number;
      completed: number;
      denied: number;
      skipped: number;
      untrackedWriteCapableProcesses: number;
    };
    capabilityMutations: {
      completed: number;
    };
    shell: {
      requested: number;
      approvals: number;
      commandFailures: number;
      untrackedWorkspaceMutations: number;
    };
    confidentialReadsDenied: number;
  };
  /** @reserved Public trace-summary field consumed by diagnostics UIs. */
  workspaceReads: {
    total: number;
    uniquePaths: number;
    duplicatePaths: Record<string, number>;
  };
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  artifactCount: number;
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  errorCount: number;
  /** @reserved Public trace-summary field consumed by diagnostics UIs. */
  errorCodes: Record<string, number>;
  /** @reserved Public trace-summary field consumed by diagnostics UIs. */
  expectedDenialCount: number;
  /** @reserved Public trace-summary field consumed by diagnostics UIs. */
  expectedDenialCodes: Record<string, number>;
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    costStatus?: "estimated" | "unavailable" | "partial";
    costUnavailableReasons?: Record<string, number>;
  };
}

export type TraceReportVerdict = "ok" | "passed_with_issues" | "failed";
export type TraceReportFindingSeverity = "high" | "medium" | "low" | "info";

export interface TraceReportFinding {
  /** @reserved Public trace-report field consumed by diagnostics UIs. */
  severity: TraceReportFindingSeverity;
  /** @reserved Public trace-report field consumed by diagnostics UIs. */
  code: string;
  /** @reserved Public trace-report field consumed by diagnostics UIs. */
  title: string;
  /** @reserved Public trace-report field consumed by diagnostics UIs. */
  evidence: string[];
  /** @reserved Public trace-report field consumed by diagnostics UIs. */
  recommendation: string;
}

export interface TraceReport {
  /** @reserved Public trace-report field consumed by diagnostics UIs. */
  verdict: TraceReportVerdict;
  /** @reserved Public trace-report field consumed by diagnostics UIs. */
  headline: string;
  /** @reserved Public trace-report field consumed by diagnostics UIs. */
  summary: {
    eventCount: number;
    runCount: number;
    sessionCount: number;
    modelCalls: number;
    toolCalls: number;
    totalTokens: number;
    costStatus?: TraceSummary["usage"]["costStatus"];
    workspaceWrites: number;
    approvalsRequested: number;
    unresolvedToolFailures: number;
    recoveredToolFailures: number;
  };
  /** @reserved Public trace-report field consumed by diagnostics UIs. */
  topTools: Record<string, number>;
  /** @reserved Public trace-report field consumed by diagnostics UIs. */
  topDuplicateReads: Record<string, number>;
  /** @reserved Public trace-report field consumed by diagnostics UIs. */
  findings: TraceReportFinding[];
}

export async function summarizeTraceFile(path: string): Promise<TraceSummary> {
  return summarizeTraceJsonl(await readFile(path, "utf8"));
}

export async function buildTraceReportFile(path: string): Promise<TraceReport> {
  return buildTraceReportJsonl(await readFile(path, "utf8"));
}

export function buildTraceReportJsonl(jsonl: string): TraceReport {
  return buildTraceReport(loadTraceEventsJsonl(jsonl));
}

export function buildTraceReport(events: SparkwrightEvent[]): TraceReport {
  const facts = collectTraceReportFacts(events);
  const findings = sortTraceReportFindings(
    TRACE_REPORT_ANALYZERS.flatMap((analyzer) => analyzer({ events, facts })),
  );
  const verdict = traceReportVerdict(findings);
  const { summary } = facts;

  return {
    verdict,
    headline: traceReportHeadline(verdict, findings),
    summary: {
      eventCount: summary.eventCount,
      runCount: summary.runIds.length,
      sessionCount: summary.sessionIds.length,
      modelCalls: facts.modelCalls,
      toolCalls: facts.toolCalls,
      totalTokens: summary.usage.totalTokens,
      costStatus: summary.usage.costStatus,
      workspaceWrites: facts.workspaceWrites,
      approvalsRequested: facts.approvalsRequested,
      unresolvedToolFailures: summary.toolFailures.unresolved.total,
      recoveredToolFailures: summary.toolFailures.recovered.total,
    },
    topTools: facts.topTools,
    topDuplicateReads: facts.topDuplicateReads,
    findings,
  };
}

interface TraceReportFacts {
  summary: TraceSummary;
  modelCalls: number;
  toolCalls: number;
  workspaceReadTotal: number;
  workspaceReadRatio: number;
  workspaceReadAttribution: WorkspaceReadAttribution;
  topDuplicateReads: Record<string, number>;
  topRepeatedReadWindows: Record<string, number>;
  topTools: Record<string, number>;
  repeatedToolRequestRuns: RepeatedToolRequestRunFacts[];
  repeatedTaskCreateLifecycleRuns: RepeatedTaskCreateLifecycleRunFacts[];
  lowNetProgressRuns: LowNetProgressRunFacts[];
  repeatedCommandFailures: Array<{ label: string; count: number }>;
  trajectory: ReturnType<typeof evaluateTrajectory>;
  uniqueWritePaths: string[];
  verificationLag?: { modelCallsAfterLastWrite: number; command: string };
  reportableFailures: ReportableFailureLedger;
  terminalRunAnomalies: TerminalRunAnomaly[];
  incompleteSubagents: IncompleteSubagentTerminal[];
  inFlightDuplicateStorms: Array<{ label: string; count: number }>;
  repeatedApprovalDenials: Array<{ label: string; count: number }>;
  untrackedWriteAccess: UntrackedWriteAccessMarker[];
  largestDuplicateRead: number;
  workspaceWrites: number;
  approvalsRequested: number;
}

interface LowNetProgressRunFacts {
  runId?: string;
  agentId?: string;
  input: LowNetProgressInput;
}

interface RepeatedToolRequestRunFacts {
  runId?: string;
  agentId?: string;
  repeatedToolRequests: RepeatedToolRequest[];
}

interface RepeatedTaskCreateLifecycleRunFacts {
  runId?: string;
  agentId?: string;
  repeats: RepeatedTaskCreateLifecycleRepeat[];
}

interface RepeatedTaskCreateLifecycleRepeat {
  label: string;
  count: number;
  evidence: string[];
}

interface RunEventGroup {
  runId?: string;
  events: SparkwrightEvent[];
}

interface TraceReportContext {
  events: readonly SparkwrightEvent[];
  facts: TraceReportFacts;
}

interface ReportableFailure {
  type: string;
  code: string;
  label: string;
}

interface ReportableFailureLedger {
  failures: ReportableFailure[];
  byCode: Record<string, number>;
}

interface TerminalRunAnomaly {
  runId: string;
  terminalCount: number;
}

interface WorkspaceReadAttribution {
  byTool: Record<string, number>;
  scanByTool: Record<string, number>;
  explicitReadByTool: Record<string, number>;
  unattributed: number;
}

type TraceReportAnalyzer = (
  context: TraceReportContext,
) => TraceReportFinding[];

const TRACE_REPORT_ANALYZERS: TraceReportAnalyzer[] = [
  analyzeTraceStructure,
  analyzeTraceFailures,
  analyzeCommandFailures,
  analyzeMultiAgentAuditability,
  analyzeEfficiency,
  analyzeTaskLifetimeClassification,
  analyzeToolRecovery,
  analyzeCostReporting,
];

const TRACE_REPORT_SEVERITY_RANK: Record<TraceReportFindingSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function collectTraceReportFacts(
  events: readonly SparkwrightEvent[],
): TraceReportFacts {
  const summary = summarizeTraceJsonl(events.map(serializeEventJsonl).join(""));
  const modelCalls = summary.byType["model.completed"] ?? 0;
  const toolCalls = sumRecord(summary.toolCalls);
  const workspaceReadTotal = summary.workspaceReads.total;
  const workspaceReadRatio =
    summary.eventCount > 0 ? workspaceReadTotal / summary.eventCount : 0;
  const workspaceReadAttribution = collectWorkspaceReadAttribution(events);
  const topDuplicateReads = firstEntries(
    summary.workspaceReads.duplicatePaths,
    8,
  );
  const topRepeatedReadWindows = firstEntries(
    collectRepeatedReadWindows(events),
    8,
  );
  const topTools = firstEntries(summary.toolCalls, 8);
  const repeatedToolRequestRuns = collectRepeatedToolRequestRunFacts(events);
  const repeatedTaskCreateLifecycleRuns =
    collectRepeatedTaskCreateLifecycleRunFacts(events);
  const lowNetProgressRuns = collectLowNetProgressRunFacts(events);
  const repeatedCommandFailures = collectRepeatedCommandFailures(events);
  const trajectory = evaluateTrajectory([...events]);
  const uniqueWritePaths = collectUniqueCompletedWritePaths(events);
  const verificationLag = collectVerificationLagAfterLastWrite(events);
  const reportableFailures = collectReportableFailures(events);
  const terminalRunAnomalies = collectTerminalRunAnomalies(events);
  const incompleteSubagents = collectIncompleteSubagentTerminals(events);
  const inFlightDuplicateStorms = collectInFlightDuplicateStorms(events);
  const repeatedApprovalDenials = collectRepeatedApprovalDenials(events);
  const untrackedWriteAccess = collectUntrackedWriteAccessMarkers(events);
  const largestDuplicateRead = Object.values(topDuplicateReads)[0] ?? 0;
  const workspaceWrites = summary.safety.workspaceWrites.completed;
  const approvalsRequested = summary.safety.approvals.requested;

  return {
    summary,
    modelCalls,
    toolCalls,
    workspaceReadTotal,
    workspaceReadRatio,
    workspaceReadAttribution,
    topDuplicateReads,
    topRepeatedReadWindows,
    topTools,
    repeatedToolRequestRuns,
    repeatedTaskCreateLifecycleRuns,
    lowNetProgressRuns,
    repeatedCommandFailures,
    trajectory,
    uniqueWritePaths,
    verificationLag,
    reportableFailures,
    terminalRunAnomalies,
    incompleteSubagents,
    inFlightDuplicateStorms,
    repeatedApprovalDenials,
    untrackedWriteAccess,
    largestDuplicateRead,
    workspaceWrites,
    approvalsRequested,
  };
}

function analyzeTraceStructure({
  facts,
}: TraceReportContext): TraceReportFinding[] {
  const { terminalRunAnomalies } = facts;
  if (terminalRunAnomalies.length === 0) return [];
  return [
    {
      severity: "high",
      code: "TRACE_TERMINAL_EVENT_COUNT_INVALID",
      title: "Trace is missing a valid run terminal",
      evidence: terminalRunAnomalies
        .slice(0, 5)
        .map((item) => `${item.runId}: terminalCount=${item.terminalCount}`),
      recommendation:
        "Inspect the raw trace for an uncaught runtime error or truncated write before trusting derived reports.",
    },
  ];
}

function analyzeTraceFailures({
  facts,
}: TraceReportContext): TraceReportFinding[] {
  const { summary, reportableFailures } = facts;
  const findings: TraceReportFinding[] = [];
  if (summary.toolFailures.unresolved.total > 0) {
    findings.push({
      severity: "high",
      code: "UNRESOLVED_TOOL_FAILURES",
      title: "Unresolved tool failures remain",
      evidence: [
        `${summary.toolFailures.unresolved.total} unresolved tool failure(s)`,
        formatCountRecord(summary.toolFailures.unresolved.byCode),
      ].filter(Boolean),
      recommendation:
        "Inspect the failing tool events before trusting the final answer.",
    });
  }

  if (reportableFailures.failures.length > 0) {
    findings.push({
      severity: "high",
      code: "TRACE_ERRORS",
      title: "Trace contains runtime error events",
      evidence: [
        `${reportableFailures.failures.length} reportable failure event(s)`,
        formatCountRecord(reportableFailures.byCode),
        ...reportableFailures.failures.slice(0, 5).map((item) => item.label),
      ].filter(Boolean),
      recommendation:
        "Use trace events filtered by error type/code to find the failing layer.",
    });
  }

  return findings;
}

function analyzeCommandFailures({
  facts,
}: TraceReportContext): TraceReportFinding[] {
  const { summary, repeatedCommandFailures } = facts;
  const findings: TraceReportFinding[] = [];

  if (summary.commandFailures.verification.unresolved > 0) {
    findings.push({
      severity: "high",
      code: "UNRESOLVED_VERIFICATION_FAILURES",
      title: "Verification commands are still failing",
      evidence: [
        `${summary.commandFailures.verification.unresolved} unresolved verification failure(s)`,
        summary.commandFailures.verification.lastCommand
          ? `last command: ${summary.commandFailures.verification.lastCommand}`
          : undefined,
        summary.commandFailures.verification.lastExitCode !== undefined
          ? `last exit code: ${String(summary.commandFailures.verification.lastExitCode)}`
          : undefined,
        summary.commandFailures.verification.lastTimedOut === true
          ? "last command timed out"
          : undefined,
      ].filter((value): value is string => typeof value === "string"),
      recommendation:
        "Do not trust final answers until the verification command passes or the failure is explicitly resolved.",
    });
  } else if (
    summary.commandFailures.total > 0 &&
    !allCommandFailuresAreRecoveredVerification(summary)
  ) {
    findings.push({
      severity: "medium",
      code: "COMMAND_FAILURES",
      title: "Shell commands failed during the run",
      evidence: [
        `${summary.commandFailures.total} command failure(s)`,
        formatCountRecord(summary.commandFailures.byExitCode),
        summary.commandFailures.verification.lastSuccessfulVerificationCommand
          ? `last successful verification: ${summary.commandFailures.verification.lastSuccessfulVerificationCommand}`
          : undefined,
        summary.commandFailures.verification.lastFailureCommand
          ? `last verification failure: ${summary.commandFailures.verification.lastFailureCommand}`
          : undefined,
      ].filter((value): value is string => typeof value === "string"),
      recommendation:
        "Inspect the failed shell command output before treating the run as clean.",
    });
  }

  if (repeatedCommandFailures.length > 0) {
    findings.push({
      severity: "medium",
      code: "REPEATED_COMMAND_FAILURES",
      title: "Same shell commands failed repeatedly",
      evidence: repeatedCommandFailures
        .slice(0, 5)
        .map((item) => `${item.count}x ${item.label}`),
      recommendation:
        "Stop retrying unchanged failing commands; inspect the first failure and change the plan or inputs.",
    });
  }

  return findings;
}

function allCommandFailuresAreRecoveredVerification(
  summary: TraceSummary,
): boolean {
  const verification = summary.commandFailures.verification;
  return (
    summary.commandFailures.total > 0 &&
    verification.total === summary.commandFailures.total &&
    verification.unresolved === 0 &&
    typeof verification.lastSuccessfulVerificationCommand === "string" &&
    verification.lastSuccessfulVerificationCommand.length > 0
  );
}

function analyzeMultiAgentAuditability({
  facts,
}: TraceReportContext): TraceReportFinding[] {
  const {
    incompleteSubagents,
    inFlightDuplicateStorms,
    repeatedApprovalDenials,
    untrackedWriteAccess,
  } = facts;
  const findings: TraceReportFinding[] = [];

  const unverifiedIncompleteSubagents = incompleteSubagents.filter(
    (item) => item.verifiedAfterChildWrite === undefined,
  );
  const verifiedIncompleteSubagents = incompleteSubagents.filter(
    (item) => item.verifiedAfterChildWrite !== undefined,
  );

  if (unverifiedIncompleteSubagents.length > 0) {
    findings.push({
      severity: "high",
      code: "SUBAGENT_INCOMPLETE",
      title: "Sub-agent results may be incomplete",
      evidence: unverifiedIncompleteSubagents
        .slice(0, 5)
        .map((item) => item.label),
      recommendation:
        "Inspect the child run trace before trusting the parent result; rerun with more child steps if the child was truncated or hit its step limit.",
    });
  }

  if (verifiedIncompleteSubagents.length > 0) {
    findings.push({
      severity: "medium",
      code: "SUBAGENT_INCOMPLETE",
      title: "Sub-agent hit a limit but parent verified after child write",
      evidence: verifiedIncompleteSubagents.slice(0, 5).map((item) => {
        const evidence = item.verifiedAfterChildWrite!;
        return `${item.label} · verifiedAfterChildWrite childWriteIndex=${evidence.childWriteIndex} subagentIndex=${evidence.subagentIndex} verificationIndex=${evidence.verificationIndex} command=${evidence.command}`;
      }),
      recommendation:
        "Keep the raw child finality for audit, but treat the parent result as lower risk because a later verification covered the current workspace state.",
    });
  }

  if (repeatedApprovalDenials.length > 0) {
    findings.push({
      severity: "high",
      code: "REPEATED_APPROVAL_DENIALS",
      title: "Approvals were denied repeatedly",
      evidence: repeatedApprovalDenials
        .slice(0, 5)
        .map((item) => `${item.count}x ${item.label}`),
      recommendation:
        "Treat the denied action as a hard constraint; choose a different plan instead of requesting the same approval again.",
    });
  }

  if (inFlightDuplicateStorms.length > 0) {
    findings.push({
      severity: "medium",
      code: "IN_FLIGHT_DUPLICATE_STORM",
      title: "Concurrent duplicate tool calls were skipped",
      evidence: inFlightDuplicateStorms
        .slice(0, 5)
        .map((item) => `${item.count}x ${item.label}`),
      recommendation:
        "Deduplicate same-batch tool requests before dispatch or feed the skipped duplicate diagnostics back into the model prompt.",
    });
  }

  if (untrackedWriteAccess.length > 0) {
    findings.push({
      // The marker means the process can write workspace files outside the
      // managed workspace.write.* API. Filesystem isolation may bound where the
      // process can write, but it does not provide per-file attribution or deny
      // ordinary workspace writes, so the report keeps this at medium.
      severity: "medium",
      code: "UNTRACKED_WRITE_CAPABLE_BOUNDARY",
      title: "A process had untracked workspace write capability",
      evidence: untrackedWriteAccess.slice(0, 5).map((item) => item.label),
      recommendation:
        "Audit the process output and workspace diff separately; the trace records that write-capable access was granted, not per-file writes.",
    });
  }

  return findings;
}

function analyzeEfficiency({
  facts,
}: TraceReportContext): TraceReportFinding[] {
  const {
    modelCalls,
    toolCalls,
    workspaceReadTotal,
    workspaceReadRatio,
    workspaceReadAttribution,
    topDuplicateReads,
    topTools,
    repeatedToolRequestRuns,
    repeatedTaskCreateLifecycleRuns,
    lowNetProgressRuns,
    largestDuplicateRead,
  } = facts;
  const findings: TraceReportFinding[] = [];

  if (toolCalls >= 80) {
    findings.push({
      severity: "medium",
      code: "EXCESSIVE_TOOL_CALLS",
      title: "Tool loop is unusually large",
      evidence: [
        `${toolCalls} tool call(s)`,
        `top tools: ${formatCountRecord(topTools) || "(none)"}`,
      ],
      recommendation:
        "Add duplicate-call diagnostics or model feedback so repeated read/search loops stop earlier.",
    });
  }

  if (modelCalls >= 20) {
    findings.push({
      severity: "medium",
      code: "EXCESSIVE_MODEL_CALLS",
      title: "Model loop is unusually long",
      evidence: [`${modelCalls} model completion(s)`],
      recommendation:
        "Check whether the task should have stopped after enough evidence was gathered.",
    });
  }

  if (workspaceReadTotal >= 1000 || workspaceReadRatio >= 0.5) {
    findings.push({
      severity: "medium",
      code: "WORKSPACE_READ_NOISE",
      title: "Workspace read events dominate the trace",
      evidence: [
        `${workspaceReadTotal} workspace.read event(s)`,
        `${Math.round(workspaceReadRatio * 100)}% of trace events`,
        ...formatWorkspaceReadAttributionEvidence(workspaceReadAttribution),
      ],
      recommendation:
        "Separate scan-level reads from explicit file reads when reviewing trace volume, then tune search scope or read reuse based on the attributed tool.",
    });
  }

  if (largestDuplicateRead >= 10) {
    const scanEvidence = formatCountRecord(workspaceReadAttribution.scanByTool);
    findings.push({
      severity: "medium",
      code: "DUPLICATE_WORKSPACE_READS",
      title: "The same files were read repeatedly",
      evidence: [
        `top duplicate reads: ${formatCountRecord(topDuplicateReads)}`,
        ...(scanEvidence ? [`scan reads by tool: ${scanEvidence}`] : []),
      ],
      recommendation:
        "Check whether duplicates come from scan tools or explicit file reads before adding read-cache hints; surface prior explicit reads when the same targets repeat.",
    });
  }

  for (const runFacts of repeatedToolRequestRuns) {
    if (runFacts.repeatedToolRequests.length === 0) continue;
    findings.push({
      severity: "medium",
      code: "REPEATED_TOOL_REQUESTS",
      title: "Identical tool requests repeated",
      evidence: [
        ...runScopeEvidence(runFacts, repeatedToolRequestRuns.length),
        ...runFacts.repeatedToolRequests
          .slice(0, 5)
          .map((item) => `${item.count}x ${item.label}`),
      ],
      recommendation:
        "Feed duplicate-call evidence back to the model or add cached-result hints before lowering maxSteps.",
    });
  }

  for (const runFacts of repeatedTaskCreateLifecycleRuns) {
    if (runFacts.repeats.length === 0) continue;
    findings.push({
      severity: "medium",
      code: "REPEATED_TASK_CREATE_LIFECYCLE",
      title: "Equivalent tasks were created after prior task results",
      evidence: [
        ...runScopeEvidence(runFacts, repeatedTaskCreateLifecycleRuns.length),
        ...runFacts.repeats.flatMap((item) => [
          `${item.count}x ${item.label}`,
          ...item.evidence.slice(0, 3),
        ]),
      ].slice(0, 8),
      recommendation:
        "Reuse the prior task id with task wait/get or the delivered task notification instead of creating an equivalent task again.",
    });
  }

  for (const runFacts of lowNetProgressRuns) {
    const lowNetProgress = analyzeLowNetProgress(runFacts.input);
    if (!lowNetProgress) continue;
    findings.push({
      severity: "medium",
      code: "LOW_NET_PROGRESS",
      title: "Run spent many cycles for little file progress",
      evidence: [
        ...runScopeEvidence(runFacts, lowNetProgressRuns.length),
        ...lowNetProgress.evidence,
      ],
      recommendation:
        "After a focused edit, run the relevant verification or conclude instead of re-reading unchanged files or repeating equivalent tool calls.",
    });
  }

  return findings;
}

function analyzeTaskLifetimeClassification({
  events,
}: TraceReportContext): TraceReportFinding[] {
  const naturallyCompletedServices = events.flatMap((event, index) => {
    if (event.type !== "task.completed" || !isRecord(event.payload)) return [];
    if (event.payload.lifetime !== "service") return [];
    const result = isRecord(event.payload.result)
      ? event.payload.result
      : undefined;
    return result?.exitCode === 0 ? [{ event, index }] : [];
  });
  if (naturallyCompletedServices.length === 0) return [];

  return [
    {
      severity: "info",
      code: "FINITE_SERVICE_TASK",
      title: "A service-classified task exited naturally",
      evidence: naturallyCompletedServices
        .slice(0, 5)
        .map(({ event, index }) => {
          const payload = event.payload as Record<string, unknown>;
          const taskId = stringValue(payload.taskId, payload.id) ?? "unknown";
          const command = stringValue(payload.command, payload.title);
          return `${taskId}${command ? `: ${truncateDiagnostic(command, 140)}` : ""} at event ${eventOrdinal(event, index)}`;
        }),
      recommendation:
        "Review whether lifetime=job was intended. Use service only for indefinite servers, watchers, or intentional endless loops; finite commands remain jobs even when they run for a long time.",
    },
  ];
}

function collectRepeatedToolRequestRunFacts(
  events: readonly SparkwrightEvent[],
): RepeatedToolRequestRunFacts[] {
  return collectRunEventGroups(events).map((group) => {
    const agentId = dominantAgentId(group.events);
    return {
      ...(group.runId ? { runId: group.runId } : {}),
      ...(agentId ? { agentId } : {}),
      repeatedToolRequests: collectRepeatedToolRequests(group.events),
    };
  });
}

function collectRepeatedTaskCreateLifecycleRunFacts(
  events: readonly SparkwrightEvent[],
): RepeatedTaskCreateLifecycleRunFacts[] {
  return collectRunEventGroups(events).map((group) => {
    const agentId = dominantAgentId(group.events);
    return {
      ...(group.runId ? { runId: group.runId } : {}),
      ...(agentId ? { agentId } : {}),
      repeats: collectRepeatedTaskCreateLifecycleRepeats(group.events),
    };
  });
}

interface TaskCreateRequestFingerprint {
  key: string;
  label: string;
}

interface TaskCreateObservation {
  key: string;
  label: string;
  requestIndex: number;
  completedIndex: number;
  taskId?: string;
  hasNextAction: boolean;
  terminal?: TaskTerminalEvidence;
}

interface PendingTaskCreateRequest {
  fingerprint: TaskCreateRequestFingerprint;
  requestIndex: number;
}

interface TaskTerminalEvidence {
  taskId: string;
  index: number;
  status: string;
  partial: boolean;
  label: string;
}

function collectRepeatedTaskCreateLifecycleRepeats(
  events: readonly SparkwrightEvent[],
): RepeatedTaskCreateLifecycleRepeat[] {
  const requestsByCallId = new Map<string, PendingTaskCreateRequest>();
  const observations: TaskCreateObservation[] = [];
  const terminalEvidence: TaskTerminalEvidence[] = [];

  events.forEach((event, index) => {
    if (!isRecord(event.payload)) return;

    if (event.type === "tool.requested") {
      const toolName = stringValue(event.payload.toolName);
      if (toolName !== "task_create") return;
      const callId = stringValue(event.payload.id, event.payload.toolCallId);
      const args = recordValue(event.payload.arguments);
      const fingerprint = taskCreateRequestFingerprint(args);
      if (!callId || !fingerprint) return;
      requestsByCallId.set(callId, { fingerprint, requestIndex: index });
      return;
    }

    const terminals = taskTerminalEvidenceFromEvent(event, index);
    terminalEvidence.push(...terminals);

    if (event.type !== "tool.completed") return;
    const toolName = stringValue(event.payload.toolName);
    if (toolName !== "task_create") return;
    const callId = stringValue(event.payload.toolCallId, event.payload.id);
    const pending = callId ? requestsByCallId.get(callId) : undefined;
    const fingerprint =
      pending?.fingerprint ??
      taskCreateRequestFingerprint(recordValue(event.payload.arguments));
    if (!fingerprint) return;
    const output = recordValue(event.payload.output);
    const taskId = stringValue(output?.taskId, output?.id);
    observations.push({
      key: fingerprint.key,
      label: fingerprint.label,
      requestIndex: pending?.requestIndex ?? index,
      completedIndex: index,
      ...(taskId ? { taskId } : {}),
      hasNextAction: isRecord(output?.nextAction),
    });
  });

  for (const observation of observations) {
    if (!observation.taskId) continue;
    observation.terminal = terminalEvidence
      .filter(
        (item) =>
          item.taskId === observation.taskId &&
          item.index >= observation.completedIndex &&
          item.status === "completed" &&
          item.partial !== true,
      )
      .sort((a, b) => a.index - b.index)[0];
  }

  const byKey = new Map<string, TaskCreateObservation[]>();
  for (const observation of observations) {
    const list = byKey.get(observation.key);
    if (list) list.push(observation);
    else byKey.set(observation.key, [observation]);
  }

  const repeats: RepeatedTaskCreateLifecycleRepeat[] = [];
  for (const group of byKey.values()) {
    const sorted = group.sort((a, b) => a.requestIndex - b.requestIndex);
    const repeatEvidence: string[] = [];
    let repeatCount = 0;
    let firstPrior: TaskCreateObservation | undefined;
    for (let index = 1; index < sorted.length; index += 1) {
      const current = sorted[index]!;
      const prior = findReusablePriorTaskCreate(sorted, index, current);
      if (!prior) continue;
      firstPrior ??= prior;
      repeatCount += 1;
      repeatEvidence.push(
        `recreated after ${prior.terminal?.label ?? `task ${prior.taskId ?? "unknown"}`} before event ${eventOrdinal(events[current.requestIndex], current.requestIndex)}`,
      );
    }
    if (repeatCount === 0 || !firstPrior) continue;
    const taskSuffix = firstPrior.taskId
      ? ` after task ${firstPrior.taskId}`
      : "";
    repeats.push({
      label: truncateDiagnostic(`${sorted[0]!.label}${taskSuffix}`, 180),
      count: repeatCount,
      evidence: [
        ...(firstPrior.hasNextAction
          ? ["prior task_create returned nextAction"]
          : []),
        ...repeatEvidence,
      ],
    });
  }

  return repeats.sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
}

function findReusablePriorTaskCreate(
  sorted: readonly TaskCreateObservation[],
  beforeIndex: number,
  current: TaskCreateObservation,
): TaskCreateObservation | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const prior = sorted[index]!;
    if (!prior.taskId || !prior.terminal) continue;
    if (prior.terminal.index >= current.requestIndex) continue;
    return prior;
  }
  return undefined;
}

function taskCreateRequestFingerprint(
  args: Record<string, unknown> | undefined,
): TaskCreateRequestFingerprint | undefined {
  if (!args) return undefined;
  const kind = stringValue(args.kind);
  if (!kind) return undefined;
  const payload = "payload" in args ? args.payload : {};
  const payloadFingerprint = stableDiagnosticJson(payload ?? {});
  return {
    key: stableDiagnosticJson({ kind, payload: payload ?? {} }),
    label: truncateDiagnostic(
      `task_create kind=${kind} payload=${payloadFingerprint}`,
      180,
    ),
  };
}

function taskTerminalEvidenceFromEvent(
  event: SparkwrightEvent,
  index: number,
): TaskTerminalEvidence[] {
  if (!isRecord(event.payload)) return [];
  if (event.type === "task.completed" || event.type === "task.failed") {
    const taskId = stringValue(event.payload.taskId, event.payload.id);
    if (!taskId) return [];
    const status =
      event.type === "task.completed"
        ? "completed"
        : (stringValue(event.payload.status) ?? "failed");
    return [
      {
        taskId,
        index,
        status,
        partial: taskTerminalIsPartial(event.payload),
        label: `task ${taskId} ${status} at event ${eventOrdinal(event, index)}`,
      },
    ];
  }

  if (event.type === "subagent.completed" || event.type === "subagent.failed") {
    const taskId = stringValue(event.payload.taskId, event.metadata.taskId);
    if (!taskId) return [];
    const status = event.type === "subagent.completed" ? "completed" : "failed";
    return [
      {
        taskId,
        index,
        status,
        partial: taskTerminalIsPartial(event.payload),
        label: `task ${taskId} ${status} via sub-agent at event ${eventOrdinal(event, index)}`,
      },
    ];
  }

  if (event.type !== "tool.completed") return [];
  const toolName = stringValue(event.payload.toolName, event.payload.name);
  if (!isTaskLifecycleTraceTool(toolName)) return [];
  return collectTerminalTaskRecords(
    recordValue(event.payload.output),
    index,
    event,
  );
}

function isTaskLifecycleTraceTool(toolName: string | undefined): boolean {
  return toolName === "task_create" || toolName === "task";
}

function collectTerminalTaskRecords(
  value: unknown,
  index: number,
  event: SparkwrightEvent,
): TaskTerminalEvidence[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      collectTerminalTaskRecords(item, index, event),
    );
  }
  if (!isRecord(value)) return [];

  const out: TaskTerminalEvidence[] = [];
  const taskId = stringValue(value.taskId, value.id);
  const status = stringValue(value.status);
  if (taskId && status && taskStatusIsTerminal(status)) {
    out.push({
      taskId,
      index,
      status,
      partial: taskTerminalIsPartial(value),
      label: `task ${taskId} ${status} at event ${eventOrdinal(event, index)}`,
    });
  }

  for (const key of [
    "task",
    "tasks",
    "completed",
    "record",
    "records",
    "result",
  ]) {
    if (!(key in value)) continue;
    out.push(...collectTerminalTaskRecords(value[key], index, event));
  }
  return out;
}

function taskStatusIsTerminal(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "canceled"
  );
}

function taskTerminalIsPartial(record: Record<string, unknown>): boolean {
  return (
    record.finality === "partial" ||
    record.stepLimitReached === true ||
    record.truncated === true ||
    record.terminalState === "step_limit" ||
    record.terminalState === "truncated"
  );
}

function eventOrdinal(
  event: SparkwrightEvent | undefined,
  index: number,
): number {
  return typeof event?.sequence === "number" ? event.sequence : index + 1;
}

function collectLowNetProgressRunFacts(
  events: readonly SparkwrightEvent[],
): LowNetProgressRunFacts[] {
  return collectRunEventGroups(events).map((group) => {
    const runEvents = group.events;
    const trajectory = evaluateTrajectory([...runEvents]);
    const modelCalls = runEvents.filter(
      (event) => event.type === "model.completed",
    ).length;
    const toolCalls = runEvents.filter(
      (event) => event.type === "tool.completed",
    ).length;
    const uniqueWritePaths = collectUniqueCompletedWritePaths(runEvents);
    const workspaceWrites = runEvents.filter(
      (event) => event.type === "workspace.write.completed",
    ).length;
    const agentId = dominantAgentId(runEvents);

    return {
      ...(group.runId ? { runId: group.runId } : {}),
      ...(agentId ? { agentId } : {}),
      input: {
        modelCalls: Math.max(modelCalls, trajectory.metrics.modelCalls),
        toolCalls: Math.max(toolCalls, trajectory.metrics.toolCalls),
        budgetCheckCount: trajectory.metrics.budgetCheckCount,
        workspaceWrites,
        uniqueWritePaths: uniqueWritePaths.length,
        topDuplicateReads: firstEntries(
          collectRepeatedReadWindows(runEvents),
          8,
        ),
        repeatedToolRequests: collectRepeatedToolRequests(runEvents),
        verificationLag: collectVerificationLagAfterLastWrite(runEvents),
      },
    };
  });
}

function collectRunEventGroups(
  events: readonly SparkwrightEvent[],
): RunEventGroup[] {
  const eventsByRun = new Map<string, SparkwrightEvent[]>();
  const unscopedEvents: SparkwrightEvent[] = [];
  for (const event of events) {
    if (typeof event.runId !== "string" || event.runId.length === 0) {
      unscopedEvents.push(event);
      continue;
    }
    const runEvents = eventsByRun.get(event.runId);
    if (runEvents) runEvents.push(event);
    else eventsByRun.set(event.runId, [event]);
  }

  const groups: RunEventGroup[] = [...eventsByRun.entries()].map(
    ([runId, runEvents]) => ({ runId, events: runEvents }),
  );
  if (unscopedEvents.length > 0) groups.push({ events: unscopedEvents });
  return groups;
}

function runScopeEvidence(
  facts: { runId?: string; agentId?: string },
  runCount: number,
): string[] {
  if (runCount <= 1) return [];
  return [
    facts.runId ? `run ${facts.runId}` : "run (unscoped)",
    facts.agentId ? `agent ${facts.agentId}` : undefined,
  ].filter((value): value is string => typeof value === "string");
}

function dominantAgentId(
  events: readonly SparkwrightEvent[],
): string | undefined {
  const counts = new Map<string, number>();
  for (const event of events) {
    const agentId = stringValue(event.metadata.agentId);
    if (!agentId) continue;
    counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0]?.[0];
}

function analyzeToolRecovery({
  facts,
}: TraceReportContext): TraceReportFinding[] {
  const { summary } = facts;
  const findings: TraceReportFinding[] = [];

  if (summary.toolFailures.recovered.total > 0) {
    findings.push({
      severity: "low",
      code: "RECOVERED_TOOL_FAILURES",
      title: "Tool failures were recovered",
      evidence: [
        `${summary.toolFailures.recovered.total} recovered tool failure(s)`,
        formatCountRecord(summary.toolFailures.recovered.byCode),
      ].filter(Boolean),
      recommendation:
        "Keep the run but inspect the failed call if recovery cost or retries matter.",
    });
  }

  if (summary.toolFailures.mutationFollowups.total > 0) {
    const targets = summary.toolFailures.mutationFollowups.targets;
    findings.push({
      severity: "medium",
      code: "DESTRUCTIVE_MUTATION_THEN_NOT_FOUND",
      title: "Destructive mutation succeeded, then same target failed",
      evidence: [
        `${summary.toolFailures.mutationFollowups.total} follow-up failure(s) on a target that was already mutated successfully`,
        targets.length > 0 ? `target(s): ${targets.join(", ")}` : "",
      ].filter(Boolean),
      recommendation:
        "The destructive operation already succeeded; the later 'not found' calls are expected fallout. Treat the run as successful and have the model report the first success instead of looping.",
    });
  }

  return findings;
}

function analyzeCostReporting({
  facts,
}: TraceReportContext): TraceReportFinding[] {
  const { summary } = facts;
  if (summary.usage.totalTokens > 0 && !summary.usage.costStatus) {
    return [
      {
        severity: "low",
        code: "COST_UNAVAILABLE",
        title: "Token usage was recorded without cost status",
        evidence: [
          `${summary.usage.totalTokens} token(s)`,
          "cost status missing",
        ],
        recommendation:
          "Populate usage.costStatus/costUnavailableReason so cost reporting distinguishes zero from unknown.",
      },
    ];
  }
  return [];
}

function traceReportVerdict(
  findings: readonly TraceReportFinding[],
): TraceReportVerdict {
  return findings.some((finding) => finding.severity === "high")
    ? "failed"
    : findings.some(
          (finding) =>
            finding.severity === "medium" || finding.severity === "low",
        )
      ? "passed_with_issues"
      : "ok";
}

function sortTraceReportFindings(
  findings: readonly TraceReportFinding[],
): TraceReportFinding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        TRACE_REPORT_SEVERITY_RANK[b.finding.severity] -
          TRACE_REPORT_SEVERITY_RANK[a.finding.severity] ||
        a.finding.code.localeCompare(b.finding.code) ||
        a.index - b.index,
    )
    .map(({ finding }) => finding);
}

export interface TraceEventFilter {
  type?: string;
  runId?: string;
  contains?: string;
}

export type TraceTimelinePhaseCategory =
  | "run"
  | "model"
  | "tool"
  | "approval"
  | "workspace"
  | "validation"
  | "context"
  | "extension"
  | "task"
  | "artifact"
  | "other";

export type TraceTimelinePhaseStatus =
  | "pending"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  | "instant";

export interface TraceTimelinePhase {
  /** @reserved Public timeline field consumed by trace viewers. */
  id: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  runId: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  agentId?: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  category: TraceTimelinePhaseCategory;
  /** @reserved Public timeline field consumed by trace viewers. */
  label: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  status: TraceTimelinePhaseStatus;
  /** @reserved Public timeline field consumed by trace viewers. */
  startedAt: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  endedAt?: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  durationMs?: number;
  /** @reserved Public timeline field consumed by trace viewers. */
  startSequence: number;
  /** @reserved Public timeline field consumed by trace viewers. */
  endSequence?: number;
  /** @reserved Public timeline field consumed by trace viewers. */
  eventTypes: string[];
  /** @reserved Public timeline field consumed by trace viewers. */
  metadata?: Record<string, unknown>;
}

export interface TraceTimeline {
  /** @reserved Public timeline field consumed by trace viewers. */
  eventCount: number;
  /** @reserved Public timeline field consumed by trace viewers. */
  runIds: string[];
  /** @reserved Public timeline field consumed by trace viewers. */
  sessionIds: string[];
  /** @reserved Public timeline field consumed by trace viewers. */
  agentIds: string[];
  /** @reserved Public timeline field consumed by trace viewers. */
  startedAt?: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  endedAt?: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  durationMs?: number;
  /** @reserved Public timeline field consumed by trace viewers. */
  phases: TraceTimelinePhase[];
}

export async function loadTraceEventsFile(
  path: string,
  filter: TraceEventFilter = {},
): Promise<SparkwrightEvent[]> {
  return loadTraceEventsJsonl(await readFile(path, "utf8"), filter);
}

export function loadTraceEventsJsonl(
  jsonl: string,
  filter: TraceEventFilter = {},
): SparkwrightEvent[] {
  return parseTraceJsonl(jsonl, "trace.jsonl").filter((event) =>
    matchesTraceEventFilter(event, filter),
  );
}

export async function buildTraceTimelineFile(
  path: string,
  filter: TraceEventFilter = {},
): Promise<TraceTimeline> {
  return buildTraceTimelineJsonl(await readFile(path, "utf8"), filter);
}

export interface TraceVerificationFinding {
  severity: "error" | "warning";
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface TraceVerificationReport {
  ok: boolean;
  path?: string;
  eventCount: number;
  runIds: string[];
  sessionIds: string[];
  agentIds: string[];
  findings: TraceVerificationFinding[];
}

export async function verifyTraceFile(
  path: string,
): Promise<TraceVerificationReport> {
  return verifyTraceJsonl(await readFile(path, "utf8"), { path });
}

export function verifyTraceJsonl(
  jsonl: string,
  options: { path?: string } = {},
): TraceVerificationReport {
  const findings: TraceVerificationFinding[] = [];
  if (jsonl.length > 0 && !jsonl.endsWith("\n")) {
    findings.push({
      severity: "error",
      code: "TRACE_FINAL_NEWLINE_MISSING",
      message:
        "Trace JSONL does not end with a newline; the final event may be half-written.",
    });
  }

  let events: SparkwrightEvent[] = [];
  try {
    events = parseTraceJsonl(jsonl, options.path ?? "trace.jsonl");
  } catch (error) {
    findings.push({
      severity: "error",
      code: "TRACE_JSON_INVALID",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const runIds = new Set<string>();
  const sessionIds = new Set<string>();
  const agentIds = new Set<string>();
  const sequencesByRun = new Map<string, number>();
  const terminalCountByRun = new Map<string, number>();
  // run.cancelled tracked separately: a run cancelled mid-flight emits BOTH
  // run.cancelled and a finalizing run.completed (state=cancelled), while a run
  // cancelled before it starts emits only run.cancelled. So run.cancelled is a
  // terminal only when no run.completed/run.failed accompanies it.
  const cancelledCountByRun = new Map<string, number>();
  const writeCountsByRun = new Map<
    string,
    { requested: number; completed: number; denied: number; skipped: number }
  >();
  const approvalCountsByRun = new Map<
    string,
    { requested: number; resolved: number }
  >();
  const artifactIds = new Set<string>();
  const previousMonotonicUsByTrace = new Map<string, number>();

  for (const [index, event] of events.entries()) {
    const line = index + 1;
    if (!event || typeof event !== "object") {
      findings.push({
        severity: "error",
        code: "TRACE_EVENT_INVALID",
        message: "Trace line is not an event object.",
        metadata: { line },
      });
      continue;
    }
    if (typeof event.runId !== "string" || event.runId.length === 0) {
      findings.push({
        severity: "error",
        code: "TRACE_RUN_ID_MISSING",
        message: "Trace event is missing runId.",
        metadata: { line },
      });
      continue;
    }
    runIds.add(event.runId);
    const sessionId = stringMetadata(event.metadata, "sessionId");
    const agentId = stringMetadata(event.metadata, "agentId");
    if (sessionId) sessionIds.add(sessionId);
    if (agentId) agentIds.add(agentId);

    if (typeof event.sequence !== "number") {
      findings.push({
        severity: "error",
        code: "TRACE_SEQUENCE_MISSING",
        message: "Trace event is missing numeric sequence.",
        metadata: { line, runId: event.runId },
      });
    } else {
      const expected = (sequencesByRun.get(event.runId) ?? 0) + 1;
      const foldedSkip = foldedSequenceSkipBefore(event);
      if (
        event.sequence !== expected &&
        event.sequence !== expected + foldedSkip
      ) {
        findings.push({
          severity: "error",
          code: "TRACE_SEQUENCE_INVALID",
          message: "Run event sequence must increase by one.",
          metadata: {
            line,
            runId: event.runId,
            expected,
            actual: event.sequence,
          },
        });
      }
      sequencesByRun.set(event.runId, observedSequenceEnd(event));
    }

    if (typeof event.monotonicUs === "number") {
      // monotonicUs comes from a per-agent execution context's clock
      // (e.g. performance.now()). Parent and child/delegate agents share one
      // traceId but run in independent contexts, so their events interleave in
      // file order without sharing a single monotonic timeline. Scope the
      // monotonic invariant per agent within a trace; single-agent traces keep
      // an empty agent suffix and behave exactly as before.
      const traceScope =
        typeof event.traceId === "string" && event.traceId.length > 0
          ? event.traceId
          : event.runId;
      const traceKey = `${traceScope}::${agentId ?? ""}`;
      const previousMonotonicUs = previousMonotonicUsByTrace.get(traceKey);
      if (
        previousMonotonicUs !== undefined &&
        event.monotonicUs < previousMonotonicUs
      ) {
        findings.push({
          severity: "error",
          code: "TRACE_MONOTONIC_ORDER_INVALID",
          message: "monotonicUs moved backward in file order.",
          metadata: {
            line,
            traceId: traceKey,
            previous: previousMonotonicUs,
            actual: event.monotonicUs,
          },
        });
      }
      previousMonotonicUsByTrace.set(traceKey, event.monotonicUs);
    }

    if (isTerminalRunEvent(event)) {
      terminalCountByRun.set(
        event.runId,
        (terminalCountByRun.get(event.runId) ?? 0) + 1,
      );
      if (event.type === "run.cancelled") {
        cancelledCountByRun.set(
          event.runId,
          (cancelledCountByRun.get(event.runId) ?? 0) + 1,
        );
      }
    }
    collectWriteVerificationCounts(writeCountsByRun, event);
    collectApprovalVerificationCounts(approvalCountsByRun, event);
    collectArtifactVerificationFindings(artifactIds, event, findings, line);
  }

  if (sessionIds.size > 1) {
    findings.push({
      severity: "error",
      code: "TRACE_SESSION_ID_CONFLICT",
      message: "Trace contains events for multiple session ids.",
      metadata: { sessionIds: [...sessionIds].sort() },
    });
  }

  for (const runId of runIds) {
    const total = terminalCountByRun.get(runId) ?? 0;
    const cancelled = cancelledCountByRun.get(runId) ?? 0;
    // Collapse a mid-flight cancel's (run.cancelled + run.completed) pair into a
    // single logical terminal: the run.completed is the canonical terminal, and
    // run.cancelled only counts when it is the sole terminal.
    const primary = total - cancelled;
    const terminalCount = primary > 0 ? primary : cancelled;
    if (terminalCount !== 1) {
      findings.push({
        severity: "error",
        code: "TRACE_TERMINAL_EVENT_COUNT_INVALID",
        message:
          "Each run in a completed trace must have exactly one terminal event.",
        metadata: { runId, terminalCount },
      });
    }
  }

  for (const [runId, counts] of writeCountsByRun) {
    const terminalWrites = counts.completed + counts.denied;
    if (terminalWrites > counts.requested) {
      findings.push({
        severity: "error",
        code: "TRACE_WORKSPACE_WRITE_PAIR_INVALID",
        message: "Workspace write terminal events exceed write requests.",
        metadata: { runId, ...counts },
      });
    }
  }

  for (const [runId, counts] of approvalCountsByRun) {
    if (counts.resolved > counts.requested) {
      findings.push({
        severity: "error",
        code: "TRACE_APPROVAL_PAIR_INVALID",
        message: "Approval resolutions exceed approval requests.",
        metadata: { runId, ...counts },
      });
    }
  }

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    path: options.path,
    eventCount: events.length,
    runIds: [...runIds].sort(),
    sessionIds: [...sessionIds].sort(),
    agentIds: [...agentIds].sort(),
    findings,
  };
}

export function buildTraceTimelineJsonl(
  jsonl: string,
  filter: TraceEventFilter = {},
): TraceTimeline {
  return buildTraceTimeline(loadTraceEventsJsonl(jsonl, filter));
}

export function buildTraceTimeline(events: SparkwrightEvent[]): TraceTimeline {
  const sorted = projectTraceEvents(events).map((entry) => entry.event);
  const runIds = new Set<string>();
  const sessionIds = new Set<string>();
  const agentIds = new Set<string>();
  const open = new Map<string, TraceTimelinePhase>();
  const terminalByRun = new Map<string, SparkwrightEvent>();
  const phases: TraceTimelinePhase[] = [];

  for (const event of sorted) {
    runIds.add(event.runId);
    if (isRunTerminalEvent(event)) terminalByRun.set(event.runId, event);
    const sessionId = stringMetadata(event.metadata, "sessionId");
    const agentId = stringMetadata(event.metadata, "agentId");
    if (sessionId) sessionIds.add(sessionId);
    if (agentId) agentIds.add(agentId);
    if (isTimelineDetailEvent(event)) continue;

    const key = timelinePhaseKey(event);
    const terminal = terminalTimelineStatus(event);
    if (key && terminal) {
      const phase = open.get(key);
      if (phase) {
        completeTimelinePhase(phase, event, terminal);
        open.delete(key);
        continue;
      }
    }
    if (terminal && event.type === "model.completed") {
      const fallbackKey = latestOpenModelPhaseKey(open, event.runId);
      if (fallbackKey) {
        const phase = open.get(fallbackKey);
        if (phase) {
          completeTimelinePhase(phase, event, terminal);
          open.delete(fallbackKey);
          continue;
        }
      }
    }

    const existing = key ? open.get(key) : undefined;
    if (existing) {
      existing.eventTypes = [...existing.eventTypes, event.type];
      continue;
    }

    const phase = createTimelinePhase(event, key !== undefined);
    phases.push(phase);
    if (key && phase.status === "pending") open.set(key, phase);
  }

  reconcileOpenPhasesWithRunTerminals(open, terminalByRun);

  const startedAt = sorted.at(0)?.timestamp;
  const endedAt = sorted.at(-1)?.timestamp;
  return {
    eventCount: sorted.length,
    runIds: [...runIds].sort(),
    sessionIds: [...sessionIds].sort(),
    agentIds: [...agentIds].sort(),
    startedAt,
    endedAt,
    durationMs:
      startedAt && endedAt
        ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
        : undefined,
    phases,
  };
}

export function summarizeTraceJsonl(jsonl: string): TraceSummary {
  const runIds = new Set<string>();
  const sessionIds = new Set<string>();
  const agentIds = new Set<string>();
  const subagentIds = new Set<string>();
  const byType: Record<string, number> = {};
  const terminalStates: Record<string, number> = {};
  const toolCalls: Record<string, number> = {};
  const toolFailureCodes: Record<string, number> = {};
  const unresolvedToolFailureCodes: Record<string, number> = {};
  const recoveredToolFailureCodes: Record<string, number> = {};
  const workspaceReadPaths: Record<string, number> = {};
  const errorCodes: Record<string, number> = {};
  const expectedDenialCodes: Record<string, number> = {};
  const latestUsageByRun = new Map<string, Record<string, unknown>>();
  const events: SparkwrightEvent[] = [];
  let modelUsageSeen = false;
  const summary: TraceSummary = {
    eventCount: 0,
    runIds: [],
    sessionIds: [],
    agentIds: [],
    subagentIds: [],
    byType,
    terminalStates,
    toolCalls,
    toolFailures: {
      total: 0,
      byCode: toolFailureCodes,
      unresolved: {
        total: 0,
        byCode: unresolvedToolFailureCodes,
      },
      recovered: {
        total: 0,
        byCode: recoveredToolFailureCodes,
      },
      mutationFollowups: {
        total: 0,
        targets: [],
      },
    },
    commandFailures: {
      total: 0,
      byExitCode: {},
      verification: {
        total: 0,
        unresolved: 0,
      },
    },
    safety: {
      approvals: {
        requested: 0,
        resolved: 0,
        approved: 0,
        denied: 0,
        autoApproved: 0,
        shell: 0,
        workspaceWrite: 0,
      },
      workspaceWrites: {
        requested: 0,
        completed: 0,
        denied: 0,
        skipped: 0,
        untrackedWriteCapableProcesses: 0,
      },
      capabilityMutations: {
        completed: 0,
      },
      shell: {
        requested: 0,
        approvals: 0,
        commandFailures: 0,
        untrackedWorkspaceMutations: 0,
      },
      confidentialReadsDenied: 0,
    },
    workspaceReads: {
      total: 0,
      uniquePaths: 0,
      duplicatePaths: {},
    },
    artifactCount: 0,
    errorCount: 0,
    errorCodes,
    expectedDenialCount: 0,
    expectedDenialCodes,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    },
  };

  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    let event: SparkwrightEvent;
    try {
      event = JSON.parse(line) as SparkwrightEvent;
    } catch (cause) {
      throw new Error(`Invalid trace event JSON at line ${index + 1}`, {
        cause,
      });
    }

    summary.eventCount += 1;
    events.push(event);
    runIds.add(String(event.runId));
    byType[event.type] = (byType[event.type] ?? 0) + 1;

    const sessionId = stringMetadata(event.metadata, "sessionId");
    const agentId = stringMetadata(event.metadata, "agentId");
    const subagentId = subagentIdentity(event);
    if (sessionId) sessionIds.add(sessionId);
    if (agentId) agentIds.add(agentId);
    if (subagentId) subagentIds.add(subagentId);
    if (event.type === "artifact.created") summary.artifactCount += 1;
    if (isExpectedDenialEvent(event)) {
      summary.expectedDenialCount += 1;
      collectExpectedDenialCode(summary, event);
    } else if (event.type !== "tool.failed" && isTraceErrorEvent(event)) {
      summary.errorCount += 1;
      collectErrorCode(summary, event);
    }

    collectTerminalState(summary, event);
    collectToolCall(summary, event);
    collectToolFailure(summary, event);
    collectWorkspaceRead(summary, event, workspaceReadPaths);
    if (event.type === "usage.updated") {
      const usage = usageFromEvent(event);
      if (usage)
        latestUsageByRun.set(String(event.runId), usageToSummary(usage));
    } else {
      modelUsageSeen = collectUsage(summary, event) || modelUsageSeen;
    }
  }

  if (!modelUsageSeen) {
    for (const usage of latestUsageByRun.values()) {
      addUsage(summary, usage);
    }
  }

  summary.runIds = [...runIds].sort();
  summary.sessionIds = [...sessionIds].sort();
  summary.agentIds = [...agentIds].sort();
  summary.subagentIds = [...subagentIds].sort();
  summary.workspaceReads.uniquePaths = Object.keys(workspaceReadPaths).length;
  summary.workspaceReads.duplicatePaths = Object.fromEntries(
    Object.entries(workspaceReadPaths)
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
  collectClassifiedToolFailures(summary, events);
  collectClassifiedExpectedDenials(summary, events);
  collectCommandFailures(summary, events);
  collectSafetySummary(summary, events);
  return summary;
}

function collectTerminalState(
  summary: TraceSummary,
  event: SparkwrightEvent,
): void {
  if (
    event.type !== "run.completed" &&
    event.type !== "run.failed" &&
    event.type !== "run.cancelled"
  ) {
    return;
  }
  const state = isRecord(event.payload)
    ? typeof event.payload.state === "string"
      ? event.payload.state
      : event.type.replace("run.", "")
    : event.type.replace("run.", "");
  summary.terminalStates[state] = (summary.terminalStates[state] ?? 0) + 1;
}

function matchesTraceEventFilter(
  event: SparkwrightEvent,
  filter: TraceEventFilter,
): boolean {
  if (filter.type && event.type !== filter.type) return false;
  if (filter.runId && event.runId !== filter.runId) return false;
  if (filter.contains) {
    const needle = filter.contains.toLowerCase();
    if (!JSON.stringify(event).toLowerCase().includes(needle)) return false;
  }
  return true;
}

export function parseTraceJsonl(
  jsonl: string,
  path: string,
): SparkwrightEvent[] {
  return jsonl
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch (cause) {
        throw new Error(
          `Invalid trace event JSON in ${path} at line ${index + 1}`,
          {
            cause,
          },
        );
      }
      return canonicalTraceEvent(raw, path, index + 1);
    });
}

function canonicalTraceEvent(
  value: unknown,
  path: string,
  line: number,
): SparkwrightEvent {
  if (!isRecord(value)) {
    throw invalidTraceEventEnvelope(path, line, "event must be an object");
  }
  for (const field of ["id", "runId", "type", "timestamp"] as const) {
    if (typeof value[field] !== "string") {
      throw invalidTraceEventEnvelope(path, line, `${field} must be a string`);
    }
  }
  if (
    typeof value.sequence !== "number" ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 1
  ) {
    throw invalidTraceEventEnvelope(
      path,
      line,
      "sequence must be a positive integer",
    );
  }
  if (!("payload" in value)) {
    throw invalidTraceEventEnvelope(path, line, "payload is required");
  }
  if (!isRecord(value.metadata)) {
    throw invalidTraceEventEnvelope(path, line, "metadata must be an object");
  }
  if (
    value.monotonicUs !== undefined &&
    (typeof value.monotonicUs !== "number" ||
      !Number.isInteger(value.monotonicUs) ||
      value.monotonicUs < 0)
  ) {
    throw invalidTraceEventEnvelope(
      path,
      line,
      "monotonicUs must be a non-negative integer",
    );
  }
  for (const field of ["traceId", "spanId", "parentSpanId"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw invalidTraceEventEnvelope(path, line, `${field} must be a string`);
    }
  }
  return value as unknown as SparkwrightEvent;
}

function invalidTraceEventEnvelope(
  path: string,
  line: number,
  detail: string,
): Error {
  return new Error(
    `Invalid trace event envelope in ${path} at line ${line}: ${detail}`,
  );
}

/**
 * Number of sequence numbers consumed by events that were folded out of the
 * persisted trace immediately before `event`. At standard level the trace store
 * collapses each `extension.process.progress` event into the terminal
 * `extension.process.completed`/`.failed` event's `progressCount`, dropping the
 * progress events' own sequence numbers. Verify never sees those events, so the
 * terminal event's sequence legitimately jumps forward by the folded count.
 * Mirrors `observedSequenceEnd`'s handling of folded `model.stream.text` chunks.
 *
 * The written terminal event's `progressCount` equals the number of folded
 * progress events: the runner increments it only when a progress event is
 * actually emitted (dropped samples land in `progressDropped`, which never
 * consumes a sequence number). At debug level the progress events are persisted
 * with their own sequences, so the terminal event has no gap and the base
 * `expected` already matches — this skip is only consulted when a gap exists.
 */
export function foldedSequenceSkipBefore(event: SparkwrightEvent): number {
  if (
    (event.type === "extension.process.completed" ||
      event.type === "extension.process.failed") &&
    isRecord(event.payload) &&
    typeof event.payload.progressCount === "number" &&
    Number.isInteger(event.payload.progressCount) &&
    event.payload.progressCount > 0 &&
    hasFoldedProcessProgressSummary(event.payload)
  ) {
    return event.payload.progressCount;
  }
  return 0;
}

function hasFoldedProcessProgressSummary(
  payload: Record<string, unknown>,
): boolean {
  const head = payload.progressHead;
  const tail = payload.progressTail;
  return (
    (Array.isArray(head) && head.length > 0) ||
    (Array.isArray(tail) && tail.length > 0)
  );
}

export function observedSequenceEnd(event: SparkwrightEvent): number {
  if (
    event.type === "model.stream.text" &&
    isRecord(event.payload) &&
    typeof event.payload.chunkCount === "number" &&
    Number.isInteger(event.payload.chunkCount) &&
    event.payload.chunkCount > 1
  ) {
    return event.sequence + event.payload.chunkCount - 1;
  }
  return event.sequence;
}

interface TraceProjectionEntry {
  event: SparkwrightEvent;
  index: number;
}

function projectTraceEvents(
  events: readonly SparkwrightEvent[],
): TraceProjectionEntry[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort(compareTraceProjectionEntries);
}

function compareTraceProjectionEntries(
  a: TraceProjectionEntry,
  b: TraceProjectionEntry,
): number {
  return compareTraceProjectionTime(a.event, b.event) || a.index - b.index;
}

function compareTraceProjectionTime(
  a: SparkwrightEvent,
  b: SparkwrightEvent,
): number {
  if (typeof a.timestamp !== "string" || typeof b.timestamp !== "string") {
    return 0;
  }
  const timestamp = compareTraceTimestamps(a.timestamp, b.timestamp);
  if (timestamp !== 0) return timestamp;

  // `monotonicUs` has one origin per process, not globally. Without a process
  // id, the narrow safe comparison is the same trace/agent scope. Cross-agent
  // events with the same millisecond timestamp keep append order.
  if (traceMonotonicScope(a) === traceMonotonicScope(b)) {
    const aMonotonic = finiteNumber(a.monotonicUs);
    const bMonotonic = finiteNumber(b.monotonicUs);
    if (aMonotonic !== undefined && bMonotonic !== undefined) {
      return aMonotonic - bMonotonic;
    }
  }

  return 0;
}

function compareTraceTimestamps(a: string, b: string): number {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
    return aMs - bMs;
  }
  return a.localeCompare(b);
}

function traceMonotonicScope(event: SparkwrightEvent): string {
  const traceScope =
    typeof event.traceId === "string" && event.traceId.length > 0
      ? event.traceId
      : typeof event.runId === "string"
        ? event.runId
        : "";
  return `${traceScope}::${stringMetadata(event.metadata, "agentId") ?? ""}`;
}

function isTerminalRunEvent(event: SparkwrightEvent): boolean {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  );
}

function collectWriteVerificationCounts(
  countsByRun: Map<
    string,
    { requested: number; completed: number; denied: number; skipped: number }
  >,
  event: SparkwrightEvent,
): void {
  const counts = countsByRun.get(event.runId) ?? {
    requested: 0,
    completed: 0,
    denied: 0,
    skipped: 0,
  };
  if (event.type === "workspace.write.requested") counts.requested += 1;
  else if (event.type === "workspace.write.completed") counts.completed += 1;
  else if (event.type === "workspace.write.denied") counts.denied += 1;
  else if (event.type === "workspace.write.skipped") counts.skipped += 1;
  else return;
  countsByRun.set(event.runId, counts);
}

function collectApprovalVerificationCounts(
  countsByRun: Map<string, { requested: number; resolved: number }>,
  event: SparkwrightEvent,
): void {
  const counts = countsByRun.get(event.runId) ?? {
    requested: 0,
    resolved: 0,
  };
  if (event.type === "approval.requested") counts.requested += 1;
  else if (event.type === "approval.resolved") counts.resolved += 1;
  else return;
  countsByRun.set(event.runId, counts);
}

function collectArtifactVerificationFindings(
  artifactIds: Set<string>,
  event: SparkwrightEvent,
  findings: TraceVerificationFinding[],
  line: number,
): void {
  if (event.type !== "artifact.created") return;
  const payload = event.payload;
  if (!isRecord(payload) || typeof payload.id !== "string") return;
  if (artifactIds.has(payload.id)) {
    findings.push({
      severity: "error",
      code: "TRACE_ARTIFACT_ID_CONFLICT",
      message: "Trace contains duplicate artifact ids.",
      metadata: { line, artifactId: payload.id },
    });
  }
  artifactIds.add(payload.id);
}

function collectToolCall(summary: TraceSummary, event: SparkwrightEvent): void {
  // Count each call once at request time. `tool.started` carries the same
  // toolName, so counting both double-counts every invocation.
  if (event.type !== "tool.requested") return;
  if (!isRecord(event.payload)) return;
  const toolName =
    typeof event.payload.toolName === "string"
      ? event.payload.toolName
      : typeof event.payload.name === "string"
        ? event.payload.name
        : undefined;
  if (!toolName) return;
  summary.toolCalls[toolName] = (summary.toolCalls[toolName] ?? 0) + 1;
}

function collectToolFailure(
  summary: TraceSummary,
  event: SparkwrightEvent,
): void {
  if (event.type !== "tool.failed") return;
  summary.toolFailures.total += 1;
  const code = traceErrorCode(event) ?? "unknown";
  summary.toolFailures.byCode[code] =
    (summary.toolFailures.byCode[code] ?? 0) + 1;
}

function collectReportableFailures(
  events: readonly SparkwrightEvent[],
): ReportableFailureLedger {
  const toolFailureCallIds = new Set(
    analyzeToolOutcomes(events)
      .failures.map((failure) => failure.toolCallId)
      .filter((id): id is string => Boolean(id)),
  );
  const failures: ReportableFailure[] = [];
  const byCode: Record<string, number> = {};

  for (const event of events) {
    if (isExpectedDenialEvent(event)) continue;
    if (!isTraceErrorEvent(event)) continue;
    if (event.type === "tool.failed") continue;
    if (isToolFailureCompanionEvent(event, toolFailureCallIds)) continue;

    const code = traceErrorCode(event) ?? event.type;
    failures.push({
      type: event.type,
      code,
      label: reportableFailureLabel(event, code),
    });
    byCode[code] = (byCode[code] ?? 0) + 1;
  }

  return { failures, byCode };
}

function reportableFailureLabel(event: SparkwrightEvent, code: string): string {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const error = isRecord(payload?.error) ? payload.error : undefined;
  const failure = isRecord(payload?.failure) ? payload.failure : undefined;
  const message = stringValue(
    payload?.message,
    error?.message,
    failure?.message,
  );
  const pieces = [
    event.type,
    code,
    message ? truncateDiagnostic(message, 120) : undefined,
    `run ${event.runId}`,
  ].filter((value): value is string => typeof value === "string");
  return truncateDiagnostic(pieces.join(" · "), 220);
}

function isToolFailureCompanionEvent(
  event: SparkwrightEvent,
  toolFailureCallIds: ReadonlySet<string>,
): boolean {
  const toolCallId = relatedToolCallId(event);
  return Boolean(toolCallId && toolFailureCallIds.has(toolCallId));
}

function collectClassifiedToolFailures(
  summary: TraceSummary,
  events: readonly SparkwrightEvent[],
): void {
  // Recompute from the raw events only when every failed tool call still carries
  // its request arguments — that is exactly the detail same-target recovery (and
  // the destructive-mutation-then-not-found diagnostic) needs, so the recompute
  // is reliable for *all* failures and reflects the current classification even
  // for traces whose persisted snapshot predates a classifier change. Otherwise
  // (older/compacted runs that stripped those arguments, including mixed traces
  // where only some runs retain them) defer to the persisted snapshot so a
  // recorded recovery is not flipped back to an unresolved failure.
  const snapshot = everyFailedToolCallHasRequestArgs(events)
    ? toolOutcomeSnapshot(events)
    : (persistedToolOutcome(events) ?? toolOutcomeSnapshot(events));
  if (!snapshot) return;
  summary.toolFailures.unresolved.total = snapshot.unresolved.total;
  summary.toolFailures.unresolved.byCode = { ...snapshot.unresolved.byCode };
  summary.toolFailures.recovered.total = snapshot.recovered.total;
  summary.toolFailures.recovered.byCode = { ...snapshot.recovered.byCode };
  if (snapshot.mutationFollowups) {
    summary.toolFailures.mutationFollowups.total =
      snapshot.mutationFollowups.count;
    summary.toolFailures.mutationFollowups.targets = [
      ...snapshot.mutationFollowups.targets,
    ];
  }

  for (const [code, count] of Object.entries(snapshot.unresolved.byCode)) {
    summary.errorCount += count;
    summary.errorCodes[code] = (summary.errorCodes[code] ?? 0) + count;
  }
}

function collectClassifiedExpectedDenials(
  summary: TraceSummary,
  events: readonly SparkwrightEvent[],
): void {
  for (const failure of analyzeToolOutcomes(events).policyDenials) {
    const code = failure.code;
    // Raw policy/approval failures were counted during event collection. This
    // catches classifier-derived expected denials whose raw code is diagnostic
    // scaffolding, such as a skipped repeated call after an expected denial.
    if (!code || isPolicyOrApprovalFailure(code)) continue;
    summary.expectedDenialCount += 1;
    summary.expectedDenialCodes[code] =
      (summary.expectedDenialCodes[code] ?? 0) + 1;
  }
}

/**
 * True when the trace has at least one tool failure AND every failed tool call
 * has a matching `tool.requested` that still carries its `arguments`. That is
 * the exact detail a recompute needs to classify same-target recovery, so the
 * recompute is reliable for *all* failures rather than only some of them.
 *
 * A loose "any request has arguments" check would be wrong for mixed traces: a
 * single args-bearing run would force a recompute that then misclassifies an
 * older/compacted run whose failed call lost its request arguments (a persisted
 * `recovered` failure would flip to `unresolved`). When any failed call lacks
 * request arguments we cannot fully reclassify, so we defer to the persisted
 * snapshot instead.
 */
function everyFailedToolCallHasRequestArgs(
  events: readonly SparkwrightEvent[],
): boolean {
  const requestHasArgs = new Map<string, boolean>();
  for (const event of events) {
    if (event.type !== "tool.requested" || !isRecord(event.payload)) continue;
    const id = stringValue(event.payload.id);
    if (id) requestHasArgs.set(id, "arguments" in event.payload);
  }
  let sawFailure = false;
  for (const event of events) {
    if (event.type !== "tool.failed" || !isRecord(event.payload)) continue;
    sawFailure = true;
    const id = stringValue(event.payload.toolCallId);
    if (!id || !requestHasArgs.get(id)) return false;
  }
  return sawFailure;
}

/** The tool-outcome snapshot persisted on `run.completed`, if present. */
function persistedToolOutcome(
  events: readonly SparkwrightEvent[],
): ToolOutcomeSnapshot | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== "run.completed" || !isRecord(event.payload)) continue;
    const raw = event.payload.toolOutcome;
    if (!isRecord(raw)) return undefined;
    return {
      unresolved: tallyFromRaw(raw.unresolved),
      recovered: tallyFromRaw(raw.recovered),
      ...(isRecord(raw.mutationFollowups)
        ? { mutationFollowups: mutationFollowupsFromRaw(raw.mutationFollowups) }
        : {}),
    };
  }
  return undefined;
}

function tallyFromRaw(raw: unknown): {
  total: number;
  byCode: Record<string, number>;
} {
  if (!isRecord(raw)) return { total: 0, byCode: {} };
  const byCode: Record<string, number> = {};
  if (isRecord(raw.byCode)) {
    for (const [code, count] of Object.entries(raw.byCode)) {
      if (typeof count === "number") byCode[code] = count;
    }
  }
  return {
    total: typeof raw.total === "number" ? raw.total : 0,
    byCode,
  };
}

function mutationFollowupsFromRaw(raw: Record<string, unknown>): {
  count: number;
  targets: string[];
} {
  const targets = Array.isArray(raw.targets)
    ? raw.targets.filter((value): value is string => typeof value === "string")
    : [];
  return {
    count: typeof raw.count === "number" ? raw.count : 0,
    targets,
  };
}

function collectCommandFailures(
  summary: TraceSummary,
  events: readonly SparkwrightEvent[],
): void {
  const projection = commandFailureProjectionForTrace(events);
  if (!projection) return;
  summary.commandFailures = projection;
}

type CommandFailureProjection = TraceSummary["commandFailures"];

function commandFailureProjectionForTrace(
  events: readonly SparkwrightEvent[],
): CommandFailureProjection | undefined {
  const runEvents = eventsGroupedByRun(events);
  if (runEvents.length <= 1) {
    return commandFailureProjectionForRun(events);
  }
  return mergeCommandFailureProjections(
    runEvents.map((group) => commandFailureProjectionForRun(group)),
  );
}

function commandFailureProjectionForRun(
  events: readonly SparkwrightEvent[],
): CommandFailureProjection | undefined {
  const ledger = persistedFactLedger(events);
  if (ledger) {
    return commandFailureProjectionFromSummary(
      analyzeCommandOutcomesFromFactLedger(ledger),
    );
  }
  if (events.some((event) => event.type === "run.completed")) return undefined;
  return commandFailureProjectionFromSummary(analyzeCommandOutcomes(events));
}

function eventsGroupedByRun(
  events: readonly SparkwrightEvent[],
): SparkwrightEvent[][] {
  const groups = new Map<string, SparkwrightEvent[]>();
  for (const event of events) {
    const runId = typeof event.runId === "string" ? event.runId : "__unknown__";
    const group = groups.get(runId);
    if (group) group.push(event);
    else groups.set(runId, [event]);
  }
  return [...groups.values()];
}

function commandFailureProjectionFromSummary(
  outcomes: CommandOutcomeSummary,
): CommandFailureProjection | undefined {
  if (outcomes.failures.length === 0) return undefined;
  const lastFailure = outcomes.verificationFailures.at(-1);
  const lastUnresolved = outcomes.unresolvedVerificationFailures.at(-1);
  const lastVerificationSuccess = outcomes.successes
    .filter((success) => success.verificationRelevant)
    .at(-1);
  return {
    total: outcomes.failures.length,
    byExitCode: outcomes.byExitCode,
    verification: {
      total: outcomes.verificationFailures.length,
      unresolved: outcomes.unresolvedVerificationFailures.length,
      ...(lastUnresolved?.command
        ? { lastCommand: lastUnresolved.command }
        : {}),
      ...(lastUnresolved
        ? {
            lastExitCode: lastUnresolved.exitCode,
            lastTimedOut: lastUnresolved.timedOut,
          }
        : {}),
      ...(lastFailure?.command
        ? { lastFailureCommand: lastFailure.command }
        : {}),
      ...(lastFailure
        ? {
            lastFailureExitCode: lastFailure.exitCode,
            lastFailureTimedOut: lastFailure.timedOut,
          }
        : {}),
      ...(lastVerificationSuccess?.command
        ? {
            lastSuccessfulVerificationCommand: lastVerificationSuccess.command,
          }
        : {}),
    },
  };
}

function mergeCommandFailureProjections(
  projections: readonly (CommandFailureProjection | undefined)[],
): CommandFailureProjection | undefined {
  const present = projections.filter(
    (projection): projection is CommandFailureProjection => Boolean(projection),
  );
  if (present.length === 0) return undefined;
  const byExitCode: Record<string, number> = {};
  const verification: CommandFailureProjection["verification"] = {
    total: 0,
    unresolved: 0,
  };
  let total = 0;
  for (const snapshot of present) {
    total += snapshot.total;
    for (const [exitCode, count] of Object.entries(snapshot.byExitCode)) {
      byExitCode[exitCode] = (byExitCode[exitCode] ?? 0) + count;
    }
    verification.total += snapshot.verification.total;
    verification.unresolved += snapshot.verification.unresolved;
    if (snapshot.verification.lastCommand !== undefined) {
      verification.lastCommand = snapshot.verification.lastCommand;
    }
    if ("lastExitCode" in snapshot.verification) {
      verification.lastExitCode = snapshot.verification.lastExitCode;
    }
    if ("lastTimedOut" in snapshot.verification) {
      verification.lastTimedOut = snapshot.verification.lastTimedOut;
    }
    if (snapshot.verification.lastFailureCommand !== undefined) {
      verification.lastFailureCommand =
        snapshot.verification.lastFailureCommand;
    }
    if ("lastFailureExitCode" in snapshot.verification) {
      verification.lastFailureExitCode =
        snapshot.verification.lastFailureExitCode;
    }
    if ("lastFailureTimedOut" in snapshot.verification) {
      verification.lastFailureTimedOut =
        snapshot.verification.lastFailureTimedOut;
    }
    if (snapshot.verification.lastSuccessfulVerificationCommand !== undefined) {
      verification.lastSuccessfulVerificationCommand =
        snapshot.verification.lastSuccessfulVerificationCommand;
    }
  }
  return { total, byExitCode, verification };
}

function persistedFactLedger(
  events: readonly SparkwrightEvent[],
): FactLedgerSnapshot | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== "run.completed" || !isRecord(event.payload)) continue;
    return factLedgerSnapshotFromUnknown(event.payload.factLedger);
  }
  return undefined;
}

function collectSafetySummary(
  summary: TraceSummary,
  events: readonly SparkwrightEvent[],
): void {
  const approvals = new Map<
    string,
    { action?: string; toolName?: string; summary?: string }
  >();

  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    if (event.type === "approval.requested") {
      const id = stringValue(event.payload.id, event.payload.approvalId);
      const action = stringValue(event.payload.action);
      const details = isRecord(event.payload.details)
        ? event.payload.details
        : undefined;
      const toolName = stringValue(details?.toolName);
      if (id) {
        approvals.set(id, {
          action,
          toolName,
          summary: stringValue(event.payload.summary),
        });
      }
      summary.safety.approvals.requested += 1;
      if (action === "workspace.write") {
        summary.safety.approvals.workspaceWrite += 1;
      }
      if (isShellToolName(toolName)) {
        summary.safety.approvals.shell += 1;
        summary.safety.shell.approvals += 1;
      }
      continue;
    }

    if (event.type === "approval.resolved") {
      const decision = stringValue(
        event.payload.decision,
        isRecord(event.payload.response)
          ? event.payload.response.decision
          : undefined,
      );
      const message = stringValue(
        event.payload.message,
        isRecord(event.payload.response)
          ? event.payload.response.message
          : undefined,
      );
      const autoApproved = booleanValue(
        event.payload.autoApproved,
        isRecord(event.payload.response)
          ? event.payload.response.autoApproved
          : undefined,
      );
      summary.safety.approvals.resolved += 1;
      if (decision === "approved") summary.safety.approvals.approved += 1;
      if (decision === "denied") summary.safety.approvals.denied += 1;
      if (
        autoApproved === true ||
        (autoApproved === undefined &&
          message?.toLowerCase().includes("auto-approved"))
      ) {
        summary.safety.approvals.autoApproved += 1;
      }
      continue;
    }

    if (event.type === "workspace.write.requested") {
      summary.safety.workspaceWrites.requested += 1;
      continue;
    }
    if (event.type === "workspace.write.completed") {
      summary.safety.workspaceWrites.completed += 1;
      continue;
    }
    if (event.type === "workspace.write.denied") {
      summary.safety.workspaceWrites.denied += 1;
      continue;
    }
    if (event.type === "workspace.write.skipped") {
      summary.safety.workspaceWrites.skipped += 1;
      continue;
    }
    if (event.type === "workspace.write.untracked_access_granted") {
      summary.safety.workspaceWrites.untrackedWriteCapableProcesses += 1;
      continue;
    }
    if (event.type === "capability.mutation.completed") {
      summary.safety.capabilityMutations.completed += 1;
      continue;
    }
    if (event.type === "workspace.read.denied") {
      summary.safety.confidentialReadsDenied += 1;
      continue;
    }
    if (event.type === "tool.requested") {
      if (isShellToolName(event.payload.toolName)) {
        summary.safety.shell.requested += 1;
      }
      continue;
    }
    if (event.type === "tool.failed") {
      // traceErrorCode reads legacy compact `errorCode` shapes too, so this
      // safety counter stays trace-level invariant.
      if (traceErrorCode(event) === "UNTRACKED_WORKSPACE_MUTATION") {
        summary.safety.shell.untrackedWorkspaceMutations += 1;
      }
    }
  }

  summary.safety.shell.commandFailures = summary.commandFailures.total;
}

function collectWorkspaceRead(
  summary: TraceSummary,
  event: SparkwrightEvent,
  workspaceReadPaths: Record<string, number>,
): void {
  if (event.type !== "workspace.read") return;
  summary.workspaceReads.total += 1;
  if (!isRecord(event.payload)) return;
  const path = stringValue(event.payload.path);
  if (!path) return;
  workspaceReadPaths[path] = (workspaceReadPaths[path] ?? 0) + 1;
}

function collectWorkspaceReadAttribution(
  events: readonly SparkwrightEvent[],
): WorkspaceReadAttribution {
  const toolBySpanId = new Map<string, string>();
  for (const event of events) {
    if (!isToolLifecycleEvent(event)) continue;
    const toolName = traceToolName(event);
    if (toolName && event.spanId) toolBySpanId.set(event.spanId, toolName);
  }

  const byTool: Record<string, number> = {};
  const scanByTool: Record<string, number> = {};
  const explicitReadByTool: Record<string, number> = {};
  let unattributed = 0;

  for (const event of events) {
    if (event.type !== "workspace.read") continue;
    const toolName =
      (event.spanId ? toolBySpanId.get(event.spanId) : undefined) ??
      (event.parentSpanId ? toolBySpanId.get(event.parentSpanId) : undefined);
    if (!toolName) {
      unattributed += 1;
      continue;
    }

    incrementCount(byTool, toolName);
    if (isSearchScanTraceTool(toolName)) incrementCount(scanByTool, toolName);
    if (isFileReadLikeTraceTool(toolName)) {
      incrementCount(explicitReadByTool, toolName);
    }
  }

  return {
    byTool: firstEntries(byTool, 8),
    scanByTool: firstEntries(scanByTool, 8),
    explicitReadByTool: firstEntries(explicitReadByTool, 8),
    unattributed,
  };
}

function isToolLifecycleEvent(event: SparkwrightEvent): boolean {
  return (
    event.type === "tool.requested" ||
    event.type === "tool.started" ||
    event.type === "tool.completed" ||
    event.type === "tool.failed"
  );
}

function traceToolName(event: SparkwrightEvent): string | undefined {
  if (!isRecord(event.payload)) return undefined;
  return stringValue(event.payload.toolName, event.payload.name);
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function formatWorkspaceReadAttributionEvidence(
  attribution: WorkspaceReadAttribution,
): string[] {
  const evidence: string[] = [];
  const byTool = formatCountRecord(attribution.byTool);
  if (byTool) evidence.push(`workspace reads by tool: ${byTool}`);
  const scanByTool = formatCountRecord(attribution.scanByTool);
  if (scanByTool) evidence.push(`scan reads by tool: ${scanByTool}`);
  const explicitReadByTool = formatCountRecord(attribution.explicitReadByTool);
  if (explicitReadByTool) {
    evidence.push(`explicit file reads by tool: ${explicitReadByTool}`);
  }
  if (attribution.unattributed > 0) {
    evidence.push(
      `${attribution.unattributed} unattributed workspace.read event(s)`,
    );
  }
  return evidence.slice(0, 4);
}

function collectRepeatedReadWindows(
  events: readonly SparkwrightEvent[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== "tool.completed") continue;
    if (!isRecord(event.payload)) continue;
    const toolName = stringValue(event.payload.toolName);
    if (!toolName || !isFileReadLikeTraceTool(toolName)) continue;
    const output = recordValue(event.payload.output);
    if (!output) continue;
    const path = stringValue(output.path, output.filePath);
    if (!path) continue;
    const key = readWindowDiagnosticKey(path, output);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).filter(([, count]) => count > 1),
  );
}

function readWindowDiagnosticKey(
  path: string,
  output: Record<string, unknown>,
): string {
  const startLine = optionalNumberValue(output.startLine);
  const endLine = optionalNumberValue(output.endLine);
  if (startLine !== undefined && endLine !== undefined) {
    return `${path}:lines ${startLine}-${endLine}`;
  }
  return path;
}

function isFileReadLikeTraceTool(toolName: string): boolean {
  return (
    toolName === "read" ||
    toolName === "read_text" ||
    toolName === "read_anchored_text"
  );
}

function isSearchScanTraceTool(toolName: string): boolean {
  return (
    toolName === "grep" ||
    toolName === "grep_text" ||
    toolName === "rg" ||
    toolName === "ripgrep" ||
    toolName === "search"
  );
}

function traceReportHeadline(
  verdict: TraceReportVerdict,
  findings: readonly TraceReportFinding[],
): string {
  if (verdict === "ok") return "Trace completed without diagnostic findings.";
  const top = findings[0];
  if (!top) return "Trace has diagnostic findings.";
  return `${top.title}${findings.length > 1 ? ` (+${findings.length - 1} more)` : ""}.`;
}

function collectUniqueCompletedWritePaths(
  events: readonly SparkwrightEvent[],
): string[] {
  const paths = new Set<string>();
  for (const event of events) {
    if (event.type !== "workspace.write.completed") continue;
    if (!isRecord(event.payload)) continue;
    const path = stringValue(event.payload.path);
    if (path) paths.add(path);
  }
  return [...paths].sort();
}

function collectVerificationLagAfterLastWrite(
  events: readonly SparkwrightEvent[],
): { modelCallsAfterLastWrite: number; command: string } | undefined {
  let lastWriteSequence: number | undefined;
  for (const event of events) {
    if (event.type === "workspace.write.completed") {
      lastWriteSequence = event.sequence;
    }
  }
  if (lastWriteSequence === undefined) return undefined;

  const commandByCallId = new Map<string, string>();
  let modelCallsAfterLastWrite = 0;

  for (const event of events) {
    if (!isRecord(event.payload)) continue;

    if (event.type === "tool.requested") {
      const toolName = stringValue(event.payload.toolName);
      const callId = stringValue(event.payload.id, event.payload.toolCallId);
      const args = recordValue(event.payload.arguments);
      const command = stringValue(args?.command);
      if (isShellToolName(toolName) && callId && command) {
        commandByCallId.set(callId, command);
      }
      continue;
    }

    if (event.sequence <= lastWriteSequence) continue;
    if (event.type === "model.completed") {
      modelCallsAfterLastWrite += 1;
      continue;
    }

    if (event.type !== "tool.completed") continue;
    const toolName = stringValue(event.payload.toolName);
    const callId = stringValue(event.payload.toolCallId, event.payload.id);
    if (!isShellToolName(toolName) || !callId) continue;
    const command =
      commandByCallId.get(callId) ??
      stringValue(recordValue(event.payload.output)?.command);
    if (!command || !isLikelyVerificationCommand(command)) continue;
    const output = recordValue(event.payload.output);
    const exitCode = optionalNumberValue(output?.exitCode);
    const timedOut = output?.timedOut === true;
    if (timedOut || exitCode !== 0) continue;
    return { modelCallsAfterLastWrite, command };
  }

  return undefined;
}

function isLikelyVerificationCommand(command: string): boolean {
  const normalized = command.trim();
  return (
    /\b(npm|pnpm|yarn|bun|deno)\s+(run\s+)?(test|verify|check|lint)\b/.test(
      normalized,
    ) ||
    /\b(vitest|jest|mocha|pytest|ruff|mypy|rspec|phpunit)\b/.test(normalized) ||
    /\b(go test|cargo test|cargo check|dotnet test|bazel test|ctest)\b/.test(
      normalized,
    ) ||
    /\b(make|rake)\s+(test|check|verify|lint)\b/.test(normalized) ||
    /(?:^|[\s/])(gradlew|tox)\b/.test(normalized) ||
    /\brails\s+test\b/.test(normalized)
  );
}

function collectRepeatedCommandFailures(
  events: readonly SparkwrightEvent[],
): Array<{ label: string; count: number }> {
  const commandByCallId = new Map<string, string>();
  const counts = new Map<string, { label: string; count: number }>();

  for (const event of events) {
    if (!isRecord(event.payload)) continue;

    if (event.type === "tool.requested") {
      const toolName = stringValue(event.payload.toolName);
      const callId = stringValue(event.payload.id, event.payload.toolCallId);
      const args = recordValue(event.payload.arguments);
      const command = stringValue(args?.command);
      if (isShellToolName(toolName) && callId && command) {
        commandByCallId.set(callId, command);
      }
      continue;
    }

    if (event.type !== "tool.completed") continue;
    const toolName = stringValue(event.payload.toolName);
    const callId = stringValue(event.payload.toolCallId, event.payload.id);
    if (!isShellToolName(toolName) || !callId) continue;
    const command = commandByCallId.get(callId);
    if (!command) continue;
    const output = recordValue(event.payload.output);
    const exitCode = optionalNumberValue(output?.exitCode);
    const timedOut = output?.timedOut === true;
    if (!timedOut && (exitCode === undefined || exitCode === 0)) continue;

    const outcome = timedOut ? "timeout" : `exit ${exitCode}`;
    const key = `${command}:${outcome}`;
    const label = `${truncateDiagnostic(command, 140)} (${outcome})`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { label, count: 1 });
  }

  return [...counts.values()]
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function collectTerminalRunAnomalies(
  events: readonly SparkwrightEvent[],
): TerminalRunAnomaly[] {
  // Only audit runs that actually began in this trace. Child/subagent steps are
  // tagged with the child runId (e.g. a child `workspace.write.completed`) but
  // their start/terminal live in the child's own trace and surface here as a
  // `subagent.completed`, not a `run.*` terminal. Scoping to runIds that emitted
  // `run.created` keeps the missing-terminal signal without flagging those.
  const startedRunIds = new Set<string>();
  const terminalCountByRun = new Map<string, number>();
  const cancelledCountByRun = new Map<string, number>();

  for (const event of events) {
    if (typeof event.runId !== "string" || event.runId.length === 0) continue;
    if (event.type === "run.created") startedRunIds.add(event.runId);
    if (!isRunTerminalEvent(event)) continue;
    terminalCountByRun.set(
      event.runId,
      (terminalCountByRun.get(event.runId) ?? 0) + 1,
    );
    if (event.type === "run.cancelled") {
      cancelledCountByRun.set(
        event.runId,
        (cancelledCountByRun.get(event.runId) ?? 0) + 1,
      );
    }
  }

  return [...startedRunIds]
    .map((runId) => {
      const total = terminalCountByRun.get(runId) ?? 0;
      const cancelled = cancelledCountByRun.get(runId) ?? 0;
      const primary = total - cancelled;
      const terminalCount = primary > 0 ? primary : cancelled;
      return { runId, terminalCount };
    })
    .filter((item) => item.terminalCount !== 1)
    .sort((a, b) => a.runId.localeCompare(b.runId));
}

interface IncompleteSubagentTerminal {
  label: string;
  verifiedAfterChildWrite?: VerifiedAfterChildWriteEvidence;
}

interface VerifiedAfterChildWriteEvidence {
  childWriteIndex: number;
  subagentIndex: number;
  verificationIndex: number;
  command: string;
}

function collectIncompleteSubagentTerminals(
  events: readonly SparkwrightEvent[],
): IncompleteSubagentTerminal[] {
  const out: IncompleteSubagentTerminal[] = [];

  for (const [index, event] of events.entries()) {
    if (
      event.type !== "subagent.completed" &&
      event.type !== "subagent.failed"
    ) {
      continue;
    }
    if (!isRecord(event.payload)) continue;
    const state = stringValue(event.payload.terminalState);
    const stepLimitReached = booleanValue(event.payload.stepLimitReached);
    const truncated = booleanValue(event.payload.truncated);
    if (
      state !== "step_limit" &&
      state !== "truncated" &&
      stepLimitReached !== true &&
      truncated !== true
    ) {
      continue;
    }

    const name = stringValue(
      event.metadata.agentName,
      event.metadata.childAgentId,
      event.metadata.agentProfileId,
      event.metadata.agentId,
      event.payload.childRunId,
      "subagent",
    )!;
    const childRunId = stringValue(
      event.metadata.childRunId,
      event.payload.childRunId,
    );
    const terminal =
      state === "truncated" || state === "step_limit"
        ? state
        : truncated
          ? "truncated"
          : "step_limit";
    const depth = optionalNumberValue(event.metadata.subagentDepth);
    const pieces = [
      `${name} ${terminal}`,
      childRunId ? `child ${childRunId}` : undefined,
      depth !== undefined ? `depth ${depth}` : undefined,
    ].filter((value): value is string => typeof value === "string");
    const verifiedAfterChildWrite = collectVerifiedAfterChildWriteEvidence(
      events,
      event,
      index,
      childRunId,
    );
    out.push({
      label: truncateDiagnostic(pieces.join(" · "), 220),
      ...(verifiedAfterChildWrite ? { verifiedAfterChildWrite } : {}),
    });
  }

  return out;
}

function collectVerifiedAfterChildWriteEvidence(
  events: readonly SparkwrightEvent[],
  subagentEvent: SparkwrightEvent,
  subagentIndex: number,
  childRunId: string | undefined,
): VerifiedAfterChildWriteEvidence | undefined {
  if (!isRecord(subagentEvent.payload)) return undefined;
  const workspaceWrites = optionalNumberValue(
    subagentEvent.payload.workspaceWrites,
  );
  if (workspaceWrites === undefined || workspaceWrites <= 0) return undefined;
  if (!childRunId) return undefined;

  let childWriteIndex: number | undefined;
  let lastWorkspaceWriteIndex: number | undefined;
  for (const [index, event] of events.entries()) {
    if (event.type !== "workspace.write.completed") continue;
    lastWorkspaceWriteIndex = index;
    if (index < subagentIndex && eventMatchesChildRun(event, childRunId)) {
      childWriteIndex = index;
    }
  }
  if (childWriteIndex === undefined) return undefined;

  const verification = collectSuccessfulVerificationEvents(events).find(
    (item) =>
      item.index > subagentIndex &&
      item.index > childWriteIndex! &&
      (lastWorkspaceWriteIndex === undefined ||
        item.index > lastWorkspaceWriteIndex),
  );
  if (!verification) return undefined;

  return {
    childWriteIndex,
    subagentIndex,
    verificationIndex: verification.index,
    command: verification.command,
  };
}

function eventMatchesChildRun(
  event: SparkwrightEvent,
  childRunId: string,
): boolean {
  if (event.runId === childRunId) return true;
  const payload = isRecord(event.payload) ? event.payload : undefined;
  return (
    stringValue(event.metadata.childRunId, payload?.childRunId) === childRunId
  );
}

function collectSuccessfulVerificationEvents(
  events: readonly SparkwrightEvent[],
): Array<{ index: number; command: string }> {
  const commandByCallId = new Map<string, string>();
  const out: Array<{ index: number; command: string }> = [];

  for (const [index, event] of events.entries()) {
    if (!isRecord(event.payload)) continue;

    if (event.type === "tool.requested") {
      const toolName = stringValue(event.payload.toolName);
      const callId = stringValue(event.payload.id, event.payload.toolCallId);
      const args = recordValue(event.payload.arguments);
      const command = stringValue(args?.command);
      if (isShellToolName(toolName) && callId && command) {
        commandByCallId.set(callId, command);
      }
      continue;
    }

    if (event.type === "tool.completed") {
      const toolName = stringValue(event.payload.toolName);
      const callId = stringValue(event.payload.toolCallId, event.payload.id);
      if (!isShellToolName(toolName) || !callId) continue;
      const command =
        commandByCallId.get(callId) ??
        stringValue(recordValue(event.payload.output)?.command);
      if (!command || !isLikelyVerificationCommand(command)) continue;
      const output = recordValue(event.payload.output);
      if (output?.timedOut === true) continue;
      if (optionalNumberValue(output?.exitCode) !== 0) continue;
      out.push({ index, command });
      continue;
    }

    if (event.type !== "workflow_hook.completed") continue;
    const hookName = stringValue(event.payload.hookName);
    if (!hookName?.startsWith("verification:")) continue;
    const result = recordValue(event.payload.result);
    const metadata = recordValue(result?.metadata);
    const exitCode = optionalNumberValue(metadata?.exitCode);
    const timedOut = metadata?.timedOut === true;
    if (timedOut || exitCode !== 0) continue;
    out.push({ index, command: hookName });
  }

  return out;
}

function collectInFlightDuplicateStorms(
  events: readonly SparkwrightEvent[],
): Array<{ label: string; count: number }> {
  const counts = new Map<string, { label: string; count: number }>();

  for (const event of events) {
    if (event.type !== "tool.failed" || !isRecord(event.payload)) continue;
    const error = recordValue(event.payload.error);
    const metadata = recordValue(error?.metadata);
    if (metadata?.duplicateKind !== "in_flight_duplicate") continue;
    const toolName = stringValue(event.payload.toolName) ?? "tool";
    const key = toolName;
    const label = truncateDiagnostic(`${toolName} in-flight duplicate`, 180);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { label, count: 1 });
  }

  return [...counts.values()]
    .filter((item) => item.count >= 3)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function collectRepeatedApprovalDenials(
  events: readonly SparkwrightEvent[],
): Array<{ label: string; count: number }> {
  const requested = new Map<string, string>();
  const counts = new Map<string, { label: string; count: number }>();

  for (const event of events) {
    if (!isRecord(event.payload)) continue;

    if (event.type === "approval.requested") {
      const id = stringValue(event.payload.id, event.payload.approvalId);
      if (!id) continue;
      const details = recordValue(event.payload.details);
      const toolName = stringValue(details?.toolName);
      const action = stringValue(event.payload.action);
      const fallbackLabel =
        [action, toolName ? `tool ${toolName}` : undefined]
          .filter((value): value is string => typeof value === "string")
          .join(" · ") || "approval";
      const label = stringValue(event.payload.summary) ?? fallbackLabel;
      requested.set(id, truncateDiagnostic(label, 180));
      continue;
    }

    if (event.type !== "approval.resolved") continue;
    const decision = stringValue(
      event.payload.decision,
      recordValue(event.payload.response)?.decision,
    );
    if (decision !== "denied") continue;
    const id = stringValue(event.payload.approvalId, event.payload.id);
    const label = (id ? requested.get(id) : undefined) ?? "approval denied";
    const existing = counts.get(label);
    if (existing) existing.count += 1;
    else counts.set(label, { label, count: 1 });
  }

  const deniedTotal = [...counts.values()].reduce(
    (sum, item) => sum + item.count,
    0,
  );
  if (deniedTotal < 2) return [];
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
}

interface UntrackedWriteAccessMarker {
  label: string;
}

function collectUntrackedWriteAccessMarkers(
  events: readonly SparkwrightEvent[],
): UntrackedWriteAccessMarker[] {
  const out: UntrackedWriteAccessMarker[] = [];

  for (const event of events) {
    if (
      event.type !== "workspace.write.untracked_access_granted" ||
      !isRecord(event.payload)
    ) {
      continue;
    }
    const toolName = stringValue(
      event.payload.toolName,
      event.metadata.delegateTool,
      "external process",
    )!;
    const protocol = stringValue(event.payload.protocol);
    const agent = stringValue(
      event.payload.agentProfileId,
      event.metadata.childAgentId,
      event.metadata.agentProfileId,
      event.metadata.agentId,
    );
    const childRunId = stringValue(
      event.payload.childRunId,
      event.metadata.childRunId,
    );
    const taskId = stringValue(event.payload.taskId);
    const isolation = stringValue(event.payload.filesystemIsolation);
    const mode = stringValue(event.payload.sandboxMode);
    const sandboxAvailable =
      typeof event.payload.sandboxAvailable === "boolean"
        ? event.payload.sandboxAvailable
        : undefined;
    const pieces = [
      toolName,
      protocol ? `protocol ${protocol}` : undefined,
      agent ? `agent ${agent}` : undefined,
      childRunId ? `child ${childRunId}` : undefined,
      taskId ? `task ${taskId}` : undefined,
      mode ? `sandbox ${mode}` : undefined,
      isolation ? `fs ${isolation}` : undefined,
      sandboxAvailable !== undefined
        ? `sandbox ${sandboxAvailable ? "available" : "unavailable"}`
        : undefined,
      "access granted",
    ].filter((value): value is string => typeof value === "string");
    out.push({
      label: truncateDiagnostic(pieces.join(" · "), 220),
    });
  }

  return out;
}

function firstEntries(
  counts: Record<string, number>,
  limit: number,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit),
  );
}

function sumRecord(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function formatCountRecord(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key}:${count}`)
    .join(", ");
}

function truncateDiagnostic(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function latestOpenModelPhaseKey(
  open: Map<string, TraceTimelinePhase>,
  runId: string,
): string | undefined {
  const prefix = `${runId}:model:`;
  return [...open.keys()].reverse().find((key) => key.startsWith(prefix));
}

function reconcileOpenPhasesWithRunTerminals(
  open: Map<string, TraceTimelinePhase>,
  terminalByRun: Map<string, SparkwrightEvent>,
): void {
  for (const [key, phase] of [...open.entries()]) {
    const terminal = terminalByRun.get(phase.runId);
    if (!terminal) continue;
    if (terminal.sequence < phase.startSequence) continue;
    const status = terminalTimelineStatus(terminal);
    if (!status) continue;
    completeTimelinePhase(phase, terminal, status);
    open.delete(key);
  }
}

function collectErrorCode(
  summary: TraceSummary,
  event: SparkwrightEvent,
): void {
  const code = traceErrorCode(event);
  if (!code) return;
  summary.errorCodes[code] = (summary.errorCodes[code] ?? 0) + 1;
}

function traceErrorCode(event: SparkwrightEvent): string | undefined {
  if (!isRecord(event.payload)) return undefined;
  return stringValue(
    event.payload.errorCode,
    isRecord(event.payload.error) ? event.payload.error.code : undefined,
    // run.failed carries its code at the payload root (e.g. a target-boundary
    // rejection's TARGET_OUTSIDE_WORKSPACE), not under `error`.
    event.type === "run.failed" ? event.payload.code : undefined,
    // validation.failed (pre-flight rejections) carries codes on its findings.
    event.type === "validation.failed"
      ? validationFailureCode(event.payload)
      : undefined,
    event.type === "mcp.server.prepared" && event.payload.status === "failed"
      ? "MCP_SERVER_PREPARE_FAILED"
      : undefined,
    event.type.endsWith(".denied") ? event.type : undefined,
  );
}

function relatedToolCallId(event: SparkwrightEvent): string | undefined {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  return stringValue(
    payload?.toolCallId,
    payload?.relatedToolCallId,
    event.metadata.toolCallId,
    event.metadata.relatedToolCallId,
  );
}

function validationFailureCode(
  payload: Record<string, unknown>,
): string | undefined {
  const result = isRecord(payload.result) ? payload.result : undefined;
  const findings =
    result && Array.isArray(result.findings) ? result.findings : [];
  const errorFinding =
    findings.find(
      (finding) => isRecord(finding) && finding.severity === "error",
    ) ?? findings.find((finding) => isRecord(finding));
  return isRecord(errorFinding) ? stringValue(errorFinding.code) : undefined;
}

function collectExpectedDenialCode(
  summary: TraceSummary,
  event: SparkwrightEvent,
): void {
  if (!isRecord(event.payload)) return;
  const code = traceErrorCode(event);
  if (!code) return;
  summary.expectedDenialCodes[code] =
    (summary.expectedDenialCodes[code] ?? 0) + 1;
}

function isExpectedDenialEvent(event: SparkwrightEvent): boolean {
  if (event.type.endsWith(".denied")) return true;
  // Use traceErrorCode so this reads legacy compact `errorCode` shapes too,
  // keeping the expected-denial count trace-level invariant.
  return isPolicyOrApprovalFailure(traceErrorCode(event));
}

function isTraceErrorEvent(event: SparkwrightEvent): boolean {
  if (event.type.endsWith(".failed") || event.type.endsWith(".denied")) {
    return true;
  }
  return (
    event.type === "mcp.server.prepared" &&
    isRecord(event.payload) &&
    event.payload.status === "failed"
  );
}

function isTimelineDetailEvent(event: SparkwrightEvent): boolean {
  return (
    event.type === "model.turn.started" ||
    event.type === "model.turn.completed" ||
    event.type === "model.stream.chunk" ||
    event.type.startsWith("model.stream.") ||
    event.type === "extension.process.progress"
  );
}

function createTimelinePhase(
  event: SparkwrightEvent,
  hasPhaseKey: boolean,
): TraceTimelinePhase {
  const payload = isRecord(event.payload) ? event.payload : {};
  const category = timelineCategory(event.type);
  const status = initialTimelineStatus(event, hasPhaseKey);
  const metadata = timelinePhaseMetadata(event);
  return {
    id: timelinePhaseKey(event) ?? `${event.runId}:${event.sequence}`,
    runId: event.runId,
    agentId: stringMetadata(event.metadata, "agentId"),
    category,
    label: timelineLabel(event, payload, category),
    status,
    startedAt: event.timestamp,
    ...(status !== "pending"
      ? { endedAt: event.timestamp, durationMs: 0 }
      : {}),
    startSequence: event.sequence,
    ...(status !== "pending" ? { endSequence: event.sequence } : {}),
    eventTypes: [event.type],
    ...(metadata ? { metadata } : {}),
  };
}

function completeTimelinePhase(
  phase: TraceTimelinePhase,
  event: SparkwrightEvent,
  status: TraceTimelinePhaseStatus,
): void {
  phase.status = status;
  phase.endedAt = event.timestamp;
  phase.endSequence = event.sequence;
  phase.durationMs = Math.max(
    0,
    Date.parse(event.timestamp) - Date.parse(phase.startedAt),
  );
  phase.eventTypes = [...phase.eventTypes, event.type];
}

function timelinePhaseKey(event: SparkwrightEvent): string | undefined {
  const payload = isRecord(event.payload) ? event.payload : {};
  const toolCallId = stringValue(payload.toolCallId, payload.id);
  if (
    event.type === "tool.requested" ||
    event.type === "tool.started" ||
    event.type === "tool.completed" ||
    event.type === "tool.failed"
  ) {
    return toolCallId ? `${event.runId}:tool:${toolCallId}` : undefined;
  }

  const approvalId = stringValue(payload.approvalId, payload.id);
  if (
    event.type === "approval.requested" ||
    event.type === "approval.resolved"
  ) {
    return approvalId ? `${event.runId}:approval:${approvalId}` : undefined;
  }

  if (
    event.type === "interaction.requested" ||
    event.type === "interaction.resolved"
  ) {
    const kind = stringValue(payload.kind) ?? "interaction";
    const request = recordValue(payload.request);
    const response = recordValue(payload.response);
    const notification = recordValue(payload.notification);
    const interactionId = stringValue(
      request?.id,
      response?.approvalId,
      response?.id,
      notification?.id,
    );
    return interactionId
      ? `${event.runId}:interaction:${kind}:${interactionId}`
      : undefined;
  }

  const writeId = stringValue(payload.proposalId, payload.id);
  if (event.type.startsWith("workspace.write.")) {
    return writeId ? `${event.runId}:workspace.write:${writeId}` : undefined;
  }

  if (
    event.type === "model.requested" ||
    event.type === "model.completed" ||
    event.type === "model.retrying"
  ) {
    const step = stringValue(payload.step) ?? String(numberValue(payload.step));
    return `${event.runId}:model:${step}`;
  }

  if (
    event.type === "run.created" ||
    event.type === "run.started" ||
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  ) {
    return `${event.runId}:run`;
  }

  if (
    event.type === "extension.process.started" ||
    event.type === "extension.process.completed" ||
    event.type === "extension.process.failed"
  ) {
    const invocationId = stringValue(payload.invocationId);
    return invocationId
      ? `${event.runId}:extension.process:${invocationId}`
      : undefined;
  }

  if (
    event.type === "subagent.requested" ||
    event.type === "subagent.started" ||
    event.type === "subagent.completed" ||
    event.type === "subagent.failed"
  ) {
    const childRunId = stringValue(
      payload.childRunId,
      stringMetadata(event.metadata, "childRunId"),
    );
    return childRunId ? `${event.runId}:subagent:${childRunId}` : undefined;
  }

  if (event.spanId) return `span:${event.spanId}`;

  return undefined;
}

function initialTimelineStatus(
  event: SparkwrightEvent,
  hasPhaseKey: boolean,
): TraceTimelinePhaseStatus {
  if (terminalTimelineStatus(event)) return terminalTimelineStatus(event)!;
  if (!hasPhaseKey) return "instant";
  if (
    event.type.endsWith(".requested") ||
    event.type.endsWith(".started") ||
    event.type === "run.created" ||
    event.type === "model.requested"
  ) {
    return "pending";
  }
  return "instant";
}

function terminalTimelineStatus(
  event: SparkwrightEvent,
): TraceTimelinePhaseStatus | undefined {
  if (
    event.type.endsWith(".completed") ||
    event.type.endsWith(".verified") ||
    event.type.endsWith(".skipped") ||
    event.type === "approval.resolved" ||
    event.type === "interaction.resolved"
  ) {
    return "completed";
  }
  if (event.type.endsWith(".failed") || event.type.endsWith(".rejected")) {
    return "failed";
  }
  if (event.type.endsWith(".denied")) return "denied";
  if (event.type.endsWith(".cancelled")) return "cancelled";
  return undefined;
}

function isRunTerminalEvent(event: SparkwrightEvent): boolean {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  );
}

function timelineCategory(
  type: SparkwrightEvent["type"],
): TraceTimelinePhaseCategory {
  if (type.startsWith("run.")) return "run";
  if (type.startsWith("model.") || type === "prompt.built") return "model";
  if (type.startsWith("tool.")) return "tool";
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("workspace.")) return "workspace";
  if (type.startsWith("validation.")) return "validation";
  if (type.startsWith("context.")) return "context";
  if (type.startsWith("extension.")) return "extension";
  if (type.startsWith("task.")) return "task";
  if (type.startsWith("artifact.")) return "artifact";
  return "other";
}

function timelineLabel(
  event: SparkwrightEvent,
  payload: Record<string, unknown>,
  category: TraceTimelinePhaseCategory,
): string {
  if (category === "tool") {
    return `tool ${String(payload.toolName ?? payload.name ?? event.type)}`;
  }
  if (category === "approval") {
    return `approval ${String(payload.summary ?? payload.action ?? event.type)}`;
  }
  if (category === "workspace") {
    return `workspace ${String(payload.path ?? event.type)}`;
  }
  if (category === "model") {
    return `model step ${String(payload.step ?? "?")}`;
  }
  if (category === "extension") {
    const kind = String(payload.kind ?? "process");
    const name = String(payload.name ?? payload.invocationId ?? event.type);
    return `extension ${kind}:${name}`;
  }
  if (category === "run") return "run";
  return event.type;
}

function timelinePhaseMetadata(
  event: SparkwrightEvent,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (event.traceId) metadata.traceId = event.traceId;
  if (event.spanId) metadata.spanId = event.spanId;
  if (event.parentSpanId) metadata.parentSpanId = event.parentSpanId;
  const sessionId = stringMetadata(event.metadata, "sessionId");
  if (sessionId) metadata.sessionId = sessionId;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function booleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function collectUsage(summary: TraceSummary, event: SparkwrightEvent): boolean {
  if (event.type !== "model.completed") return false;
  const usage = usageFromEvent(event);
  if (!usage) return false;
  addUsage(summary, usage);
  return true;
}

function usageFromEvent(
  event: SparkwrightEvent,
): Record<string, unknown> | undefined {
  if (!isRecord(event.payload)) return;
  if (isRecord(event.payload.usage)) return event.payload.usage;
  if (event.type === "usage.updated") return event.payload;
  if (event.type === "model.completed" && "totalTokens" in event.payload) {
    return { totalTokens: event.payload.totalTokens };
  }
  return undefined;
}

function addUsage(summary: TraceSummary, usage: Record<string, unknown>): void {
  summary.usage.inputTokens += numberValue(
    usage.inputTokens,
    usage.promptTokens,
  );
  summary.usage.outputTokens += numberValue(
    usage.outputTokens,
    usage.completionTokens,
  );
  summary.usage.cacheReadTokens += numberValue(usage.cacheReadTokens);
  summary.usage.cacheWriteTokens += numberValue(usage.cacheWriteTokens);
  summary.usage.reasoningTokens += numberValue(usage.reasoningTokens);
  summary.usage.totalTokens += numberValue(usage.totalTokens, usage.tokens);
  summary.usage.estimatedCostUsd += numberValue(
    usage.estimatedCostUsd,
    usage.costUsd,
  );
  addCostStatus(summary.usage, usage);
}

function usageToSummary(usage: Record<string, unknown>): TraceSummary["usage"] {
  const out: TraceSummary["usage"] = {
    inputTokens: numberValue(usage.inputTokens, usage.promptTokens),
    outputTokens: numberValue(usage.outputTokens, usage.completionTokens),
    cacheReadTokens: numberValue(usage.cacheReadTokens),
    cacheWriteTokens: numberValue(usage.cacheWriteTokens),
    reasoningTokens: numberValue(usage.reasoningTokens),
    totalTokens: numberValue(usage.totalTokens, usage.tokens),
    estimatedCostUsd: numberValue(usage.estimatedCostUsd, usage.costUsd),
  };
  addCostStatus(out, usage);
  return out;
}

function addCostStatus(
  target: TraceSummary["usage"],
  usage: Record<string, unknown>,
): void {
  const status = stringValue(usage.costStatus);
  if (
    status === "estimated" ||
    status === "unavailable" ||
    status === "partial"
  ) {
    target.costStatus = mergeCostStatus(target.costStatus, status);
  } else if (
    (positiveNumber(usage.estimatedCostUsd) || positiveNumber(usage.costUsd)) &&
    target.costStatus !== "partial" &&
    target.costStatus !== "unavailable"
  ) {
    target.costStatus = "estimated";
  }

  const reasons = isRecord(usage.costUnavailableReasons)
    ? usage.costUnavailableReasons
    : stringValue(usage.costUnavailableReason)
      ? { [stringValue(usage.costUnavailableReason)!]: 1 }
      : undefined;
  if (!reasons) return;

  const targetReasons = (target.costUnavailableReasons ??= {});
  for (const [reason, count] of Object.entries(reasons)) {
    const n = typeof count === "number" && Number.isFinite(count) ? count : 1;
    targetReasons[reason] = (targetReasons[reason] ?? 0) + n;
  }
  target.costStatus = mergeCostStatus(target.costStatus, "unavailable");
}

function mergeCostStatus(
  current: TraceSummary["usage"]["costStatus"],
  next: NonNullable<TraceSummary["usage"]["costStatus"]>,
): NonNullable<TraceSummary["usage"]["costStatus"]> {
  if (!current) return next;
  if (current === next) return current;
  return "partial";
}

function numberValue(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function subagentIdentity(event: SparkwrightEvent): string | undefined {
  if (
    event.type !== "subagent.requested" &&
    event.type !== "subagent.started" &&
    event.type !== "subagent.completed" &&
    event.type !== "subagent.failed"
  ) {
    return undefined;
  }
  const fromMetadata =
    stringMetadata(event.metadata, "childAgentId") ??
    stringMetadata(event.metadata, "agentProfileId");
  if (fromMetadata) return fromMetadata;
  return isRecord(event.payload)
    ? stringValue(event.payload.agentProfileId, event.payload.childRunId)
    : undefined;
}
