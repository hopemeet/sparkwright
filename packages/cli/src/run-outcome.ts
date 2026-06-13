import {
  analyzeCommandOutcomes,
  analyzeToolOutcomes,
  analyzeVerificationProfileResults,
  completedRunOutcomeFromEvents,
  type SparkwrightEvent,
  type VerificationProfileResult,
} from "@sparkwright/core";

export type { VerificationProfileResult };

export interface CliRunEventSummary {
  events: SparkwrightEvent[];
  toolFailures: Array<{ code?: string }>;
  writeCompleted: number;
  writeSkipped: number;
  writeDenied: number;
  runFailure?: CliRunFailureSummary;
}

export interface CliRunFailureSummary {
  reason?: string;
  code?: string;
  message?: string;
  failure?: {
    category?: string;
    code?: string;
    message?: string;
    retryable?: boolean;
  };
  metadata?: Record<string, unknown>;
}

export function createCliRunEventSummary(): CliRunEventSummary {
  return {
    events: [],
    toolFailures: [],
    writeCompleted: 0,
    writeSkipped: 0,
    writeDenied: 0,
  };
}

export function updateCliRunEventSummary(
  summary: CliRunEventSummary,
  event: SparkwrightEvent,
): void {
  summary.events.push(event);
  if (event.type === "tool.failed") {
    summary.toolFailures.push({ code: toolFailureCode(event) });
  } else if (event.type === "workspace.write.completed")
    summary.writeCompleted += 1;
  else if (event.type === "workspace.write.skipped") summary.writeSkipped += 1;
  else if (event.type === "workspace.write.denied") summary.writeDenied += 1;
  else if (event.type === "run.failed")
    summary.runFailure = runFailureSummary(event);
}

export function unhandledToolFailureCount(summary: CliRunEventSummary): number {
  return analyzeToolOutcomes(summary.events).unresolvedFailures.length;
}

export function unresolvedVerificationCommandFailureCount(
  summary: CliRunEventSummary,
): number {
  return analyzeCommandOutcomes(summary.events).unresolvedVerificationFailures
    .length;
}

export function completedRunHasCliIssues(
  summary: CliRunEventSummary,
  documentedCommandIssueCount = 0,
): boolean {
  // Unsupported final-answer claims are advisory only (the prose-based detector
  // is unreliable), so they are not part of the run's issue verdict — they are
  // surfaced separately via summarizeUnsupportedFinalClaims.
  return (
    unhandledToolFailureCount(summary) > 0 ||
    unresolvedVerificationCommandFailureCount(summary) > 0 ||
    verificationProfileFailureCount(summary) > 0 ||
    summary.writeDenied > 0 ||
    documentedCommandIssueCount > 0
  );
}

export function cliExitCodeForRun(input: {
  failedMessage?: string;
  runState?: string;
  events: CliRunEventSummary;
}): number {
  // Terminal failures are not represented in the completed-run outcome (which
  // is only produced on `final_answer`), so they stay as explicit checks.
  if (input.failedMessage) return 1;
  if (input.runState === "failed" || input.runState === "cancelled") return 1;
  // Everything else is a projection of the single run outcome's `failing` flag,
  // which core already computed (preferred) or, for callers that did not carry
  // it, the same `completedRunOutcomeFromEvents` core uses — so the two cannot
  // diverge. Recovered tool failures and unsupported claims are non-failing.
  return runOutcomeFailing(input.events) ? 1 : 0;
}

/**
 * Whether the completed run is failing, preferring the `failing` flag core
 * already attached to `run.completed`, falling back to recomputing it from
 * events with the same core function.
 */
function runOutcomeFailing(summary: CliRunEventSummary): boolean {
  const attached = attachedRunOutcomeFailing(summary.events);
  if (attached !== undefined) return attached;
  return (
    completedRunOutcomeFromEvents(
      summary.events,
      finalMessageFromEvents(summary.events),
    )?.failing ?? false
  );
}

function attachedRunOutcomeFailing(
  events: readonly SparkwrightEvent[],
): boolean | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== "run.completed" || !isRecord(event.payload)) continue;
    const outcome = isRecord(event.payload.outcome)
      ? event.payload.outcome
      : undefined;
    return typeof outcome?.failing === "boolean" ? outcome.failing : undefined;
  }
  return undefined;
}

function finalMessageFromEvents(
  events: readonly SparkwrightEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== "run.completed" || !isRecord(event.payload)) continue;
    return stringValue(event.payload.message);
  }
  return undefined;
}

export function summarizeWorkspaceMutations(input: {
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

export function summarizeUnhandledToolFailures(
  summary: CliRunEventSummary,
): string | undefined {
  const count = unhandledToolFailureCount(summary);
  if (count === 0) return undefined;
  return `Run completed with ${count} unhandled tool failure${count === 1 ? "" : "s"}; see trace for details.`;
}

export function summarizeVerificationCommandFailures(
  summary: CliRunEventSummary,
): string | undefined {
  const failures = analyzeCommandOutcomes(
    summary.events,
  ).unresolvedVerificationFailures;
  if (failures.length === 0) return undefined;
  const last = failures.at(-1);
  const command = last?.command ? ` Last failed command: ${last.command}.` : "";
  const status = last?.timedOut
    ? "timed out"
    : last
      ? `exitCode=${last.exitCode}`
      : "failed";
  return `Run completed with failed verification (${failures.length} unresolved command failure${failures.length === 1 ? "" : "s"}, ${status}).${command}`;
}

export function summarizeVerificationProfileResults(
  summary: CliRunEventSummary,
): string | undefined {
  const results = verificationProfileResults(summary);
  if (results.length === 0) return undefined;
  const passed = results.filter((result) => result.status === "passed");
  const failed = results.filter((result) => result.status === "failed");
  const parts: string[] = [];
  if (passed.length > 0) {
    parts.push(
      `${passed.length} passed (${passed.map((result) => result.id).join(", ")})`,
    );
  }
  if (failed.length > 0) {
    parts.push(
      `${failed.length} failed (${failed.map(formatVerificationFailure).join(", ")})`,
    );
  }
  return `Verification: ${parts.join("; ")}.`;
}

export function summarizeUnsupportedFinalClaims(
  summary: CliRunEventSummary,
): string | undefined {
  const claims = unsupportedFinalClaims(summary);
  if (claims.length === 0) return undefined;
  const first = claims[0];
  const command = first?.command
    ? ` First unsupported command: ${first.command}.`
    : "";
  return `Run completed with ${claims.length} unsupported final-answer claim${claims.length === 1 ? "" : "s"}; see trace outcome for evidence details.${command}`;
}

export function summarizeDeniedWorkspaceWrites(
  summary: CliRunEventSummary,
): string | undefined {
  if (summary.writeDenied === 0) return undefined;
  return `Run completed with ${summary.writeDenied} denied workspace write${summary.writeDenied === 1 ? "" : "s"}; requested mutation was not applied.`;
}

export function summarizeRunFailure(
  summary: CliRunEventSummary,
  fallback?: { state?: string; stopReason?: string },
): string | undefined {
  const failed = summary.runFailure;
  if (!failed) {
    if (fallback?.state === "failed") {
      return `Run failed${fallback.stopReason ? ` (${fallback.stopReason})` : ""}.`;
    }
    return undefined;
  }

  return summarizeCliRunFailureSummary(failed, fallback);
}

export function summarizeTerminalRunFailure(input: {
  state?: string;
  stopReason?: string;
  failure?: unknown;
}): string | undefined {
  const failure = isRecord(input.failure) ? input.failure : undefined;
  if (!failure) {
    return summarizeRunFailure(createCliRunEventSummary(), {
      state: input.state,
      stopReason: input.stopReason,
    });
  }

  return summarizeCliRunFailureSummary(
    {
      reason: input.stopReason,
      code: stringValue(failure.code),
      message: stringValue(failure.message),
      failure: {
        category: stringValue(failure.category),
        code: stringValue(failure.code),
        message: stringValue(failure.message),
        retryable: booleanValue(failure.retryable),
      },
      metadata: isRecord(failure.metadata) ? failure.metadata : undefined,
    },
    { state: input.state, stopReason: input.stopReason },
  );
}

function summarizeCliRunFailureSummary(
  failed: CliRunFailureSummary,
  fallback?: { state?: string; stopReason?: string },
): string | undefined {
  const message =
    failed.message ??
    failed.failure?.message ??
    (fallback?.state === "failed" ? "Run failed." : undefined);
  if (!message) return undefined;

  const modelError = isRecord(failed.metadata?.modelError)
    ? failed.metadata.modelError
    : undefined;
  const category = stringValue(failed.failure?.category);
  const modelCategory = stringValue(modelError?.category);
  const status = numberValue(modelError?.status);
  const retryable =
    typeof failed.failure?.retryable === "boolean"
      ? failed.failure.retryable
      : booleanValue(modelError?.retryable);
  const code = failed.code ?? failed.failure?.code;

  const details = [
    failed.reason ? `reason=${failed.reason}` : "",
    code ? `code=${code}` : "",
    category ? `category=${category}` : "",
    modelCategory ? `model=${modelCategory}` : "",
    status !== undefined ? `status=${status}` : "",
    retryable !== undefined ? `retryable=${retryable}` : "",
  ].filter(Boolean);

  const prefix =
    category === "model" || modelCategory ? "Model failed" : "Run failed";
  return `${prefix}: ${message}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

function verificationProfileFailureCount(summary: CliRunEventSummary): number {
  return verificationProfileResults(summary).filter(
    (result) => result.status === "failed",
  ).length;
}

function verificationProfileResults(
  summary: CliRunEventSummary,
): VerificationProfileResult[] {
  // Delegate to the single core parser so the CLI exit-code path and the run
  // `outcome` can never disagree on whether a verification profile failed.
  return analyzeVerificationProfileResults(summary.events);
}

function formatVerificationFailure(result: VerificationProfileResult): string {
  const status = result.timedOut
    ? "timed out"
    : result.exitCode !== undefined
      ? `exitCode=${result.exitCode}`
      : "failed";
  return `${result.id} ${status}`;
}

function toolFailureCode(event: SparkwrightEvent): string | undefined {
  const payload = event.payload as {
    error?: { code?: string };
  };
  return payload.error?.code;
}

function runFailureSummary(event: SparkwrightEvent): CliRunFailureSummary {
  const payload = event.payload as Record<string, unknown>;
  const failure = isRecord(payload.failure) ? payload.failure : undefined;
  return {
    reason: stringValue(payload.reason),
    code: stringValue(payload.code),
    message: stringValue(payload.message),
    ...(failure
      ? {
          failure: {
            category: stringValue(failure.category),
            code: stringValue(failure.code),
            message: stringValue(failure.message),
            retryable: booleanValue(failure.retryable),
          },
        }
      : {}),
    metadata: isRecord(payload.metadata) ? payload.metadata : undefined,
  };
}

function unsupportedFinalClaims(
  summary: CliRunEventSummary,
): Array<{ command?: string }> {
  const claims: Array<{ command?: string }> = [];
  for (const event of summary.events) {
    if (event.type !== "run.completed" || !isRecord(event.payload)) continue;
    const outcome = isRecord(event.payload.outcome)
      ? event.payload.outcome
      : undefined;
    const unsupported = isRecord(outcome?.unsupportedFinalClaims)
      ? outcome.unsupportedFinalClaims
      : undefined;
    const rawClaims = Array.isArray(unsupported?.claims)
      ? unsupported.claims
      : [];
    for (const raw of rawClaims) {
      if (!isRecord(raw)) continue;
      claims.push({ command: stringValue(raw.command) });
    }
  }
  return claims;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
