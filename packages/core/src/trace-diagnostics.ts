// AI maintenance note: derived trace diagnostics only. Do not import the
// trace facade or storage internals from this module.

import { readFile } from "node:fs/promises";
import type { SparkwrightEvent } from "./events.js";
import { evaluateTrajectory } from "./eval.js";
import {
  analyzeLowNetProgress,
  collectRepeatedToolRequests,
  type RepeatedToolRequest,
} from "./run-health.js";
import {
  analyzeToolOutcomes,
  commandOutcomeSnapshot,
  isPolicyOrApprovalFailure,
  toolOutcomeSnapshot,
  type CommandOutcomeSnapshot,
  type ToolOutcomeSnapshot,
} from "./run-outcome.js";
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
  topDuplicateReads: Record<string, number>;
  topTools: Record<string, number>;
  repeatedToolRequests: RepeatedToolRequest[];
  repeatedCommandFailures: Array<{ label: string; count: number }>;
  trajectory: ReturnType<typeof evaluateTrajectory>;
  uniqueWritePaths: string[];
  verificationLag?: { modelCallsAfterLastWrite: number; command: string };
  reportableFailures: ReportableFailureLedger;
  incompleteSubagents: Array<{ label: string }>;
  inFlightDuplicateStorms: Array<{ label: string; count: number }>;
  repeatedApprovalDenials: Array<{ label: string; count: number }>;
  untrackedWriteAccess: UntrackedWriteAccessMarker[];
  largestDuplicateRead: number;
  workspaceWrites: number;
  approvalsRequested: number;
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

type TraceReportAnalyzer = (
  context: TraceReportContext,
) => TraceReportFinding[];

const TRACE_REPORT_ANALYZERS: TraceReportAnalyzer[] = [
  analyzeTraceFailures,
  analyzeCommandFailures,
  analyzeMultiAgentAuditability,
  analyzeEfficiency,
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
  const topDuplicateReads = firstEntries(
    summary.workspaceReads.duplicatePaths,
    8,
  );
  const topTools = firstEntries(summary.toolCalls, 8);
  const repeatedToolRequests = collectRepeatedToolRequests(events);
  const repeatedCommandFailures = collectRepeatedCommandFailures(events);
  const trajectory = evaluateTrajectory([...events]);
  const uniqueWritePaths = collectUniqueCompletedWritePaths(events);
  const verificationLag = collectVerificationLagAfterLastWrite(events);
  const reportableFailures = collectReportableFailures(events);
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
    topDuplicateReads,
    topTools,
    repeatedToolRequests,
    repeatedCommandFailures,
    trajectory,
    uniqueWritePaths,
    verificationLag,
    reportableFailures,
    incompleteSubagents,
    inFlightDuplicateStorms,
    repeatedApprovalDenials,
    untrackedWriteAccess,
    largestDuplicateRead,
    workspaceWrites,
    approvalsRequested,
  };
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
  } else if (summary.commandFailures.total > 0) {
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

  if (incompleteSubagents.length > 0) {
    findings.push({
      severity: "high",
      code: "SUBAGENT_INCOMPLETE",
      title: "Sub-agent results may be incomplete",
      evidence: incompleteSubagents.slice(0, 5).map((item) => item.label),
      recommendation:
        "Inspect the child run trace before trusting the parent result; rerun with more child steps if the child was truncated or hit its step limit.",
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
    topDuplicateReads,
    topTools,
    repeatedToolRequests,
    trajectory,
    uniqueWritePaths,
    verificationLag,
    largestDuplicateRead,
    workspaceWrites,
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
      ],
      recommendation:
        "Consider aggregating scan-level reads separately from explicit file reads in standard traces.",
    });
  }

  if (largestDuplicateRead >= 10) {
    findings.push({
      severity: "medium",
      code: "DUPLICATE_WORKSPACE_READS",
      title: "The same files were read repeatedly",
      evidence: [
        `top duplicate reads: ${formatCountRecord(topDuplicateReads)}`,
      ],
      recommendation:
        "Surface prior reads to the model or return cached-read hints for duplicate targets.",
    });
  }

  if (repeatedToolRequests.length > 0) {
    findings.push({
      severity: "medium",
      code: "REPEATED_TOOL_REQUESTS",
      title: "Identical tool requests repeated",
      evidence: repeatedToolRequests
        .slice(0, 5)
        .map((item) => `${item.count}x ${item.label}`),
      recommendation:
        "Feed duplicate-call evidence back to the model or add cached-result hints before lowering maxSteps.",
    });
  }

  const lowNetProgress = analyzeLowNetProgress({
    modelCalls: Math.max(modelCalls, trajectory.metrics.modelCalls),
    toolCalls: Math.max(toolCalls, trajectory.metrics.toolCalls),
    budgetCheckCount: trajectory.metrics.budgetCheckCount,
    workspaceWrites,
    uniqueWritePaths: uniqueWritePaths.length,
    topDuplicateReads,
    repeatedToolRequests,
    verificationLag,
  });
  if (lowNetProgress) {
    findings.push({
      severity: "medium",
      code: "LOW_NET_PROGRESS",
      title: "Run spent many cycles for little file progress",
      evidence: lowNetProgress.evidence,
      recommendation:
        "After a focused edit, run the relevant verification or conclude instead of re-reading unchanged files or repeating equivalent tool calls.",
    });
  }

  return findings;
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
    if (sessionId) sessionIds.add(sessionId);
    if (agentId) agentIds.add(agentId);
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
  summary.workspaceReads.uniquePaths = Object.keys(workspaceReadPaths).length;
  summary.workspaceReads.duplicatePaths = Object.fromEntries(
    Object.entries(workspaceReadPaths)
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
  collectClassifiedToolFailures(summary, events);
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
      try {
        return JSON.parse(line) as SparkwrightEvent;
      } catch (cause) {
        throw new Error(
          `Invalid trace event JSON in ${path} at line ${index + 1}`,
          {
            cause,
          },
        );
      }
    });
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
  // Prefer the snapshot the run persisted (computed over the full event
  // stream). This preserves legacy trace compatibility for older traces that
  // may not retain enough tool.requested detail to classify same-target
  // recovery.
  const snapshot = persistedToolOutcome(events) ?? toolOutcomeSnapshot(events);
  if (!snapshot) return;
  summary.toolFailures.unresolved.total = snapshot.unresolved.total;
  summary.toolFailures.unresolved.byCode = { ...snapshot.unresolved.byCode };
  summary.toolFailures.recovered.total = snapshot.recovered.total;
  summary.toolFailures.recovered.byCode = { ...snapshot.recovered.byCode };

  for (const [code, count] of Object.entries(snapshot.unresolved.byCode)) {
    summary.errorCount += count;
    summary.errorCodes[code] = (summary.errorCodes[code] ?? 0) + count;
  }
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

function collectCommandFailures(
  summary: TraceSummary,
  events: readonly SparkwrightEvent[],
): void {
  // Prefer the snapshot the run persisted (computed over the full event
  // stream). This preserves legacy trace compatibility for older traces that
  // may not retain command exit evidence in tool.completed output.
  const snapshot =
    persistedCommandOutcome(events) ?? commandOutcomeSnapshot(events);
  if (!snapshot) return;
  summary.commandFailures.total = snapshot.total;
  summary.commandFailures.byExitCode = snapshot.byExitCode;
  summary.commandFailures.verification = snapshot.verification;
}

/** The command-outcome snapshot persisted on `run.completed`, if present. */
function persistedCommandOutcome(
  events: readonly SparkwrightEvent[],
): CommandOutcomeSnapshot | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== "run.completed" || !isRecord(event.payload)) continue;
    const raw = event.payload.commandOutcome;
    if (!isRecord(raw) || typeof raw.total !== "number") return undefined;
    const verification = isRecord(raw.verification) ? raw.verification : {};
    return {
      total: raw.total,
      byExitCode: isRecord(raw.byExitCode)
        ? (raw.byExitCode as Record<string, number>)
        : {},
      verification: {
        total: typeof verification.total === "number" ? verification.total : 0,
        unresolved:
          typeof verification.unresolved === "number"
            ? verification.unresolved
            : 0,
        ...(typeof verification.lastCommand === "string"
          ? { lastCommand: verification.lastCommand }
          : {}),
        ...("lastExitCode" in verification
          ? {
              lastExitCode: verification.lastExitCode as number | null,
            }
          : {}),
        ...(typeof verification.lastTimedOut === "boolean"
          ? { lastTimedOut: verification.lastTimedOut }
          : {}),
        ...(typeof verification.lastFailureCommand === "string"
          ? { lastFailureCommand: verification.lastFailureCommand }
          : {}),
        ...("lastFailureExitCode" in verification
          ? {
              lastFailureExitCode: verification.lastFailureExitCode as
                | number
                | null,
            }
          : {}),
        ...(typeof verification.lastFailureTimedOut === "boolean"
          ? { lastFailureTimedOut: verification.lastFailureTimedOut }
          : {}),
        ...(typeof verification.lastSuccessfulVerificationCommand === "string"
          ? {
              lastSuccessfulVerificationCommand:
                verification.lastSuccessfulVerificationCommand,
            }
          : {}),
      },
    };
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
      if (toolName === "shell") {
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
      if (event.payload.toolName === "shell") {
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
      if (toolName === "shell" && callId && command) {
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
    if (toolName !== "shell" || !callId) continue;
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
      if (toolName === "shell" && callId && command) {
        commandByCallId.set(callId, command);
      }
      continue;
    }

    if (event.type !== "tool.completed") continue;
    const toolName = stringValue(event.payload.toolName);
    const callId = stringValue(event.payload.toolCallId, event.payload.id);
    if (toolName !== "shell" || !callId) continue;
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

function collectIncompleteSubagentTerminals(
  events: readonly SparkwrightEvent[],
): Array<{ label: string }> {
  const out: Array<{ label: string }> = [];

  for (const event of events) {
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
      event.metadata.agentId,
      event.metadata.agentProfileId,
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
    out.push({ label: truncateDiagnostic(pieces.join(" · "), 220) });
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
