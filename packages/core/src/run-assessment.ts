import type { SparkwrightEvent } from "./events.js";
import {
  projectFactLedgerSnapshot,
  type FactLedgerSnapshot,
} from "./fact-ledger.js";
import {
  analyzeCommandOutcomesFromFactLedger,
  analyzeToolOutcomes,
} from "./run-outcome.js";
import { isRecord } from "./record-utils.js";
import type { RunState, RunStopReason } from "./types.js";

export type RunAssessmentHealth = "clean" | "degraded" | "failing";
export type RunIssueDisposition = "degraded" | "failing";
export type RunIssueKind =
  | "tool_failure"
  | "tool_recovery"
  | "expected_denial"
  | "verification_failure"
  | "workflow_failure"
  | "run_failure"
  | "run_cancelled"
  | "assessment_unavailable";

export interface RunIssue {
  code: string;
  kind: RunIssueKind;
  disposition: RunIssueDisposition;
  count: number;
  details?: {
    codes?: string[];
    codeCounts?: Record<string, number>;
    toolNames?: string[];
    lastCommand?: string;
    lastVerifierId?: string;
    lastExitCode?: number | null;
    reason?: string;
  };
}

export type VerificationStatus = "passed" | "failed" | "timed_out" | "stale";

export interface VerificationResult {
  id: string;
  source: "command" | "profile" | "documented_command";
  status: VerificationStatus;
  sequence?: number;
  command?: string;
  profile?: string;
  verifierId?: string;
  exitCode?: number | null;
}

export interface RunAssessment {
  schemaVersion: "run-assessment.v1";
  health: RunAssessmentHealth;
  issues: RunIssue[];
  verification: VerificationResult[];
}

export interface AssessRunOptions {
  factLedger?: FactLedgerSnapshot;
  terminal?: {
    state: Extract<RunState, "completed" | "failed" | "cancelled">;
    reason?: RunStopReason;
    failure?: { code?: string };
  };
}

const MAX_ISSUES = 32;
const MAX_VERIFICATION_RESULTS = 48;
const MAX_DETAIL_ITEMS = 8;
const MAX_TEXT = 180;
const RESUMABLE_RUN_FAILURE_REASONS = new Set([
  "max_steps_exceeded",
  "max_duration_exceeded",
  "max_model_calls_exceeded",
  "max_tool_calls_exceeded",
  "token_budget_exceeded",
  "cost_budget_exceeded",
  "stop_hook_prevented",
]);

export function isResumableRunFailureReason(reason: string): boolean {
  return RESUMABLE_RUN_FAILURE_REASONS.has(reason);
}

/** Core's only terminal semantic judgment for one run. */
export function assessRun(
  events: readonly SparkwrightEvent[],
  options: AssessRunOptions = {},
): RunAssessment {
  const factLedger = options.factLedger ?? projectFactLedgerSnapshot(events);
  const toolSummary = analyzeToolOutcomes(events);
  const commandSummary = analyzeCommandOutcomesFromFactLedger(factLedger);
  const verification = verificationResults(factLedger);
  const issues: RunIssue[] = [];

  if (toolSummary.unresolvedFailures.length > 0) {
    issues.push(
      toolIssue(
        "UNRESOLVED_TOOL_FAILURE",
        "tool_failure",
        "failing",
        toolSummary.unresolvedFailures,
      ),
    );
  }
  if (toolSummary.recoveredFailures.length > 0) {
    issues.push(
      toolIssue(
        "RECOVERED_TOOL_FAILURE",
        "tool_recovery",
        "degraded",
        toolSummary.recoveredFailures,
      ),
    );
  }
  if (toolSummary.policyDenials.length > 0) {
    issues.push(
      toolIssue(
        "EXPECTED_DENIAL",
        "expected_denial",
        "degraded",
        toolSummary.policyDenials,
      ),
    );
  }

  const failedVerification = verification.filter(
    (result) => result.status === "failed" || result.status === "timed_out",
  );
  if (failedVerification.length > 0) {
    const last = failedVerification.at(-1);
    const lastCommand = commandSummary.unresolvedVerificationFailures.at(-1);
    issues.push({
      code: "VERIFICATION_FAILED",
      kind: "verification_failure",
      disposition: "failing",
      count: failedVerification.length,
      details: compactDetails({
        ...(lastCommand?.command ? { lastCommand: lastCommand.command } : {}),
        ...(last?.verifierId ? { lastVerifierId: last.verifierId } : {}),
        ...(last?.exitCode !== undefined
          ? { lastExitCode: last.exitCode }
          : {}),
      }),
    });
  }

  const workflowFailures = workflowFailureFacts(events);
  if (workflowFailures.length > 0) {
    const last = workflowFailures.at(-1);
    issues.push({
      code: "WORKFLOW_FAILED",
      kind: "workflow_failure",
      disposition: "failing",
      count: workflowFailures.length,
      details: compactDetails({
        ...(last?.code ? { codes: [last.code] } : {}),
        ...(last?.reason ? { reason: last.reason } : {}),
      }),
    });
  }

  if (options.terminal?.state === "failed") {
    issues.push({
      code: bounded(options.terminal.failure?.code) ?? "RUN_FAILED",
      kind: "run_failure",
      disposition: "failing",
      count: 1,
      details: compactDetails({
        ...(options.terminal.reason ? { reason: options.terminal.reason } : {}),
      }),
    });
  } else if (options.terminal?.state === "cancelled") {
    issues.push({
      code: "RUN_CANCELLED",
      kind: "run_cancelled",
      disposition: "failing",
      count: 1,
      details: compactDetails({
        ...(options.terminal.reason ? { reason: options.terminal.reason } : {}),
      }),
    });
  }

  const boundedIssues = issues.slice(0, MAX_ISSUES);
  return {
    schemaVersion: "run-assessment.v1",
    health: boundedIssues.some((issue) => issue.disposition === "failing")
      ? "failing"
      : boundedIssues.length > 0
        ? "degraded"
        : "clean",
    issues: boundedIssues,
    verification: verification.slice(-MAX_VERIFICATION_RESULTS),
  };
}

export function runAssessmentFromUnknown(
  value: unknown,
): RunAssessment | undefined {
  if (!isRecord(value) || value.schemaVersion !== "run-assessment.v1") {
    return undefined;
  }
  const health =
    value.health === "clean" ||
    value.health === "degraded" ||
    value.health === "failing"
      ? value.health
      : undefined;
  if (!health) return undefined;
  return {
    schemaVersion: "run-assessment.v1",
    health,
    issues: Array.isArray(value.issues)
      ? value.issues
          .map(runIssueFromUnknown)
          .filter((issue): issue is RunIssue => Boolean(issue))
          .slice(0, MAX_ISSUES)
      : [],
    verification: Array.isArray(value.verification)
      ? value.verification
          .map(verificationResultFromUnknown)
          .filter((result): result is VerificationResult => Boolean(result))
          .slice(-MAX_VERIFICATION_RESULTS)
      : [],
  };
}

function verificationResults(
  snapshot: FactLedgerSnapshot,
): VerificationResult[] {
  const commandResults: VerificationResult[] = snapshot.commands
    .filter(
      (fact) =>
        fact.initiator === "model-initiated" && fact.verificationRelevant,
    )
    .map((fact) => ({
      id: fact.id,
      source: "command" as const,
      status: fact.stale
        ? "stale"
        : fact.timedOut
          ? "timed_out"
          : fact.exitCode === 0
            ? "passed"
            : "failed",
      sequence: fact.sequence,
      ...(fact.command ? { command: bounded(fact.command) } : {}),
      exitCode: fact.exitCode,
    }));
  const verifierResults: VerificationResult[] =
    snapshot.verificationResults.map((fact) => ({
      id: fact.id,
      source:
        fact.verificationSource === "documented_command"
          ? ("documented_command" as const)
          : ("profile" as const),
      status: fact.stale
        ? "stale"
        : fact.timedOut
          ? "timed_out"
          : fact.satisfied
            ? "passed"
            : "failed",
      sequence: fact.sequence,
      ...(fact.profile ? { profile: bounded(fact.profile) } : {}),
      verifierId: bounded(fact.verifierId),
      exitCode: fact.exitCode,
    }));
  return [...commandResults, ...verifierResults].sort(
    (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0),
  );
}

function toolIssue(
  code: string,
  kind: Extract<
    RunIssueKind,
    "tool_failure" | "tool_recovery" | "expected_denial"
  >,
  disposition: RunIssueDisposition,
  failures: ReadonlyArray<{ code?: string; toolName?: string }>,
): RunIssue {
  return {
    code,
    kind,
    disposition,
    count: failures.length,
    details: compactDetails({
      codes: uniqueBounded(failures.map((failure) => failure.code)),
      codeCounts: tallyCodes(failures),
      toolNames: uniqueBounded(failures.map((failure) => failure.toolName)),
    }),
  };
}

function workflowFailureFacts(
  events: readonly SparkwrightEvent[],
): Array<{ reason?: string; code?: string }> {
  return events.flatMap((event) => {
    if (event.type !== "workflow.failed" || !isRecord(event.payload)) return [];
    if (event.payload.projectionKind === "invariant") return [];
    const failure = isRecord(event.payload.failure)
      ? event.payload.failure
      : undefined;
    const reason =
      stringValue(event.payload.reason) ?? stringValue(failure?.reason);
    const code = stringValue(event.payload.code) ?? stringValue(failure?.code);
    return [
      {
        ...(reason ? { reason: bounded(reason) } : {}),
        ...(code ? { code: bounded(code) } : {}),
      },
    ];
  });
}

function runIssueFromUnknown(value: unknown): RunIssue | undefined {
  if (!isRecord(value)) return undefined;
  const kinds: RunIssueKind[] = [
    "tool_failure",
    "tool_recovery",
    "expected_denial",
    "verification_failure",
    "workflow_failure",
    "run_failure",
    "run_cancelled",
    "assessment_unavailable",
  ];
  const kind = kinds.find((candidate) => candidate === value.kind);
  const disposition =
    value.disposition === "degraded" || value.disposition === "failing"
      ? value.disposition
      : undefined;
  const code = stringValue(value.code);
  const count = numberValue(value.count);
  if (!kind || !disposition || !code || count === undefined) return undefined;
  const rawDetails = isRecord(value.details) ? value.details : undefined;
  const codes = stringArrayValue(rawDetails?.codes);
  const toolNames = stringArrayValue(rawDetails?.toolNames);
  const codeCounts = numberRecordValue(rawDetails?.codeCounts);
  const lastCommand = stringValue(rawDetails?.lastCommand);
  const lastVerifierId = stringValue(rawDetails?.lastVerifierId);
  const lastExitCode =
    typeof rawDetails?.lastExitCode === "number" ||
    rawDetails?.lastExitCode === null
      ? rawDetails.lastExitCode
      : undefined;
  const reason = stringValue(rawDetails?.reason);
  return {
    code: bounded(code)!,
    kind,
    disposition,
    count,
    details: compactDetails({
      ...(codes ? { codes } : {}),
      ...(codeCounts ? { codeCounts } : {}),
      ...(toolNames ? { toolNames } : {}),
      ...(lastCommand ? { lastCommand } : {}),
      ...(lastVerifierId ? { lastVerifierId } : {}),
      ...(lastExitCode !== undefined ? { lastExitCode } : {}),
      ...(reason ? { reason } : {}),
    }),
  };
}

function verificationResultFromUnknown(
  value: unknown,
): VerificationResult | undefined {
  if (!isRecord(value)) return undefined;
  const source =
    value.source === "command" ||
    value.source === "profile" ||
    value.source === "documented_command"
      ? value.source
      : undefined;
  const status =
    value.status === "passed" ||
    value.status === "failed" ||
    value.status === "timed_out" ||
    value.status === "stale"
      ? value.status
      : undefined;
  const id = stringValue(value.id);
  if (!source || !status || !id) return undefined;
  return {
    id: bounded(id)!,
    source,
    status,
    ...(numberValue(value.sequence) !== undefined
      ? { sequence: numberValue(value.sequence) }
      : {}),
    ...(stringValue(value.command)
      ? { command: bounded(stringValue(value.command)!) }
      : {}),
    ...(stringValue(value.profile)
      ? { profile: bounded(stringValue(value.profile)!) }
      : {}),
    ...(stringValue(value.verifierId)
      ? { verifierId: bounded(stringValue(value.verifierId)!) }
      : {}),
    ...(typeof value.exitCode === "number" || value.exitCode === null
      ? { exitCode: value.exitCode as number | null }
      : {}),
  };
}

function compactDetails(
  details: NonNullable<RunIssue["details"]>,
): RunIssue["details"] | undefined {
  const compact = {
    ...(details.codes && details.codes.length > 0
      ? { codes: details.codes.slice(0, MAX_DETAIL_ITEMS) }
      : {}),
    ...(details.codeCounts && Object.keys(details.codeCounts).length > 0
      ? {
          codeCounts: Object.fromEntries(
            Object.entries(details.codeCounts).slice(0, MAX_DETAIL_ITEMS),
          ),
        }
      : {}),
    ...(details.toolNames && details.toolNames.length > 0
      ? { toolNames: details.toolNames.slice(0, MAX_DETAIL_ITEMS) }
      : {}),
    ...(details.lastCommand
      ? { lastCommand: bounded(details.lastCommand) }
      : {}),
    ...(details.lastVerifierId
      ? { lastVerifierId: bounded(details.lastVerifierId) }
      : {}),
    ...(details.lastExitCode !== undefined
      ? { lastExitCode: details.lastExitCode }
      : {}),
    ...(details.reason ? { reason: bounded(details.reason) } : {}),
  };
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function uniqueBounded(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => Boolean(value))
        .map((value) => bounded(value)!),
    ),
  ].slice(0, MAX_DETAIL_ITEMS);
}

function tallyCodes(
  failures: ReadonlyArray<{ code?: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const failure of failures) {
    const code = bounded(failure.code) ?? "unknown";
    if (!(code in counts) && Object.keys(counts).length >= MAX_DETAIL_ITEMS) {
      counts.other = (counts.other ?? 0) + 1;
      continue;
    }
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => bounded(item)!)
    .slice(0, MAX_DETAIL_ITEMS);
}

function numberRecordValue(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
    )
    .slice(0, MAX_DETAIL_ITEMS);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function bounded(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length <= MAX_TEXT
    ? singleLine
    : `${singleLine.slice(0, MAX_TEXT - 1)}…`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
