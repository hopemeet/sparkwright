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
  skillFailures: CliSkillFailureSummary[];
  writeCompleted: number;
  writeSkipped: number;
  writeDenied: number;
  capabilityMutationCompleted: number;
  mcpWorkspaceCwdServers: string[];
  subagentWriteCompleted: number;
  toolReportedChanges: number;
  untrackedWriteCapableProcesses: number;
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

export interface CliSkillFailureSummary {
  name?: string;
  source?: string;
  message?: string;
  status?: string;
  resource?: string;
  errorCode?: string;
  exitCode?: number;
  timedOut?: boolean;
}

export function createCliRunEventSummary(): CliRunEventSummary {
  return {
    events: [],
    toolFailures: [],
    skillFailures: [],
    writeCompleted: 0,
    writeSkipped: 0,
    writeDenied: 0,
    capabilityMutationCompleted: 0,
    mcpWorkspaceCwdServers: [],
    subagentWriteCompleted: 0,
    toolReportedChanges: 0,
    untrackedWriteCapableProcesses: 0,
  };
}

export function updateCliRunEventSummary(
  summary: CliRunEventSummary,
  event: SparkwrightEvent,
): void {
  summary.events.push(event);
  if (event.type === "tool.failed") {
    summary.toolFailures.push({ code: toolFailureCode(event) });
  } else if (event.type === "skill.failed") {
    summary.skillFailures.push(skillFailureDetail(event));
  } else if (event.type === "tool.completed") {
    if (toolCompletedChanged(event)) summary.toolReportedChanges += 1;
  } else if (event.type === "capability.mutation.completed") {
    summary.capabilityMutationCompleted += 1;
  } else if (event.type === "run.started") {
    mergeMcpWorkspaceCwdServers(summary, event);
  } else if (
    event.type === "subagent.completed" ||
    event.type === "subagent.failed"
  ) {
    summary.subagentWriteCompleted += subagentWorkspaceWriteCount(event);
  } else if (event.type === "workspace.write.completed")
    summary.writeCompleted += 1;
  else if (event.type === "workspace.write.skipped") summary.writeSkipped += 1;
  else if (event.type === "workspace.write.denied") summary.writeDenied += 1;
  else if (event.type === "workspace.write.untracked_access_granted")
    summary.untrackedWriteCapableProcesses += 1;
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

export function completedRunHasCliIssues(summary: CliRunEventSummary): boolean {
  // The status label projects the same failing verdict as the exit code, so the
  // two cannot diverge. Expected-by-policy outcomes are not failures and are
  // surfaced separately instead: denied workspace writes via
  // summarizeDeniedWorkspaceWrites, unsupported final-answer claims (the
  // prose-based detector is unreliable) via summarizeUnsupportedFinalClaims.
  return runOutcomeFailing(summary);
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
  const outcome = completedRunOutcome(summary);
  return isRecord(outcome) && outcome.failing === true;
}

function completedRunOutcome(summary: CliRunEventSummary): unknown {
  return (
    attachedRunOutcome(summary.events) ??
    completedRunOutcomeFromEvents(
      summary.events,
      finalMessageFromEvents(summary.events),
    )
  );
}

function attachedRunOutcome(
  events: readonly SparkwrightEvent[],
): Record<string, unknown> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== "run.completed" || !isRecord(event.payload)) continue;
    const outcome = isRecord(event.payload.outcome)
      ? event.payload.outcome
      : undefined;
    return outcome;
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
  capabilityMutations?: number;
  mcpWorkspaceCwdServers?: readonly string[];
  subagentWrites?: number;
  toolReportedChanges?: number;
  untrackedWriteCapableProcesses?: number;
}): string {
  const { shouldWrite, completed, skipped, denied } = input;
  const capabilityMutations = input.capabilityMutations ?? 0;
  const mcpWorkspaceCwdServers = input.mcpWorkspaceCwdServers ?? [];
  const subagentWrites = input.subagentWrites ?? 0;
  const toolReportedChanges = input.toolReportedChanges ?? 0;
  const untrackedWriteCapableProcesses =
    input.untrackedWriteCapableProcesses ?? 0;
  let summary: string;
  if (completed === 0 && skipped === 0 && denied === 0) {
    if (capabilityMutations > 0) {
      summary = `Capability mutations: ${capabilityMutations} completed; no managed workspace write was applied.`;
    } else if (subagentWrites > 0) {
      summary = `Workspace changes applied by sub-agent(s): ${subagentWrites} write${subagentWrites === 1 ? "" : "s"}.`;
    } else if (toolReportedChanges > 0) {
      summary = `Capability changes: ${toolReportedChanges} tool-reported; no managed workspace write was applied.`;
    } else if (untrackedWriteCapableProcesses > 0) {
      summary = "No managed workspace writes were applied.";
    } else {
      summary = shouldWrite
        ? "No workspace changes were made (no workspace write was applied)."
        : "No workspace changes were made (read-only run).";
    }
  } else {
    const parts: string[] = [];
    if (completed > 0) parts.push(`${completed} applied`);
    if (skipped > 0) parts.push(`${skipped} skipped (no-op)`);
    if (denied > 0) parts.push(`${denied} denied`);
    if (subagentWrites > 0) parts.push(`${subagentWrites} by sub-agent`);
    summary = `Workspace writes: ${parts.join(", ")}.`;
  }
  summary = withUntrackedWriteCapabilityDisclosure(
    summary,
    untrackedWriteCapableProcesses,
  );
  return withMcpWorkspaceCwdDisclosure(summary, mcpWorkspaceCwdServers);
}

function withUntrackedWriteCapabilityDisclosure(
  summary: string,
  count: number,
): string {
  if (count === 0) return summary;
  return `${summary} Untracked write-capable boundaries: ${count} (not counted as managed workspace writes).`;
}

function mergeMcpWorkspaceCwdServers(
  summary: CliRunEventSummary,
  event: SparkwrightEvent,
): void {
  if (!isRecord(event.payload)) return;
  const servers = Array.isArray(event.payload.mcpWorkspaceCwdServers)
    ? event.payload.mcpWorkspaceCwdServers.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  for (const server of servers) {
    if (!summary.mcpWorkspaceCwdServers.includes(server)) {
      summary.mcpWorkspaceCwdServers.push(server);
    }
  }
}

function withMcpWorkspaceCwdDisclosure(
  summary: string,
  servers: readonly string[],
): string {
  if (servers.length === 0) return summary;
  const names = servers.join(", ");
  return `${summary} MCP servers configured with workspace cwd (${names}) are not counted as managed workspace writes.`;
}

function subagentWorkspaceWriteCount(event: SparkwrightEvent): number {
  if (!isRecord(event.payload)) return 0;
  return typeof event.payload.workspaceWrites === "number" &&
    Number.isFinite(event.payload.workspaceWrites)
    ? event.payload.workspaceWrites
    : 0;
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
  return `Run completed with verification failures; exiting 1 (${failures.length} unresolved command failure${failures.length === 1 ? "" : "s"}, ${status}).${command}`;
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

export function summarizeDocumentedCommandFailures(
  summary: CliRunEventSummary,
): string | undefined {
  const outcome = completedRunOutcome(summary);
  const failures =
    isRecord(outcome) && isRecord(outcome.documentedCommandFailures)
      ? outcome.documentedCommandFailures
      : undefined;
  const count =
    typeof failures?.count === "number" && Number.isFinite(failures.count)
      ? failures.count
      : 0;
  if (count === 0) return undefined;
  const lastId = stringValue(failures?.lastId);
  const lastExitCode =
    typeof failures?.lastExitCode === "number" ||
    failures?.lastExitCode === null
      ? failures.lastExitCode
      : undefined;
  const status =
    lastExitCode !== undefined ? `, last exitCode=${lastExitCode}` : "";
  const last = lastId ? ` Last failed check: ${lastId}.` : "";
  return `Run completed with documented-command verification failures; exiting 1 (${count} failed check${count === 1 ? "" : "s"}${status}).${last}`;
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

export function summarizeSkillLoadFailures(
  summary: CliRunEventSummary,
): string | undefined {
  const failures = summary.skillFailures;
  if (failures.length === 0) return undefined;
  const first = failures[0] ? formatSkillFailure(failures[0]) : undefined;
  const detail = first ? ` First: ${first}.` : "";
  return `Run completed with ${failures.length} skill load/preparation failure${failures.length === 1 ? "" : "s"}; affected skills may be missing or degraded for this run.${detail}`;
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

function skillFailureDetail(event: SparkwrightEvent): CliSkillFailureSummary {
  if (!isRecord(event.payload)) return {};
  return {
    name: stringValue(event.payload.name),
    source: stringValue(event.payload.source),
    message: stringValue(event.payload.message),
    status: stringValue(event.payload.status),
    resource: stringValue(event.payload.resource),
    errorCode: stringValue(event.payload.errorCode),
    exitCode: numberValue(event.payload.exitCode),
    timedOut: booleanValue(event.payload.timedOut),
  };
}

function formatSkillFailure(failure: CliSkillFailureSummary): string {
  const subject =
    failure.name ?? skillNameFromSource(failure.source) ?? "unknown skill";
  const status = failure.status ?? "failed";
  const resource = failure.resource ? ` resource=${failure.resource}` : "";
  if (status === "inline_shell_failed") {
    const code = failure.errorCode ? ` ${failure.errorCode}` : "";
    const exit =
      failure.exitCode !== undefined ? ` exitCode=${failure.exitCode}` : "";
    const timeout = failure.timedOut ? " timed out" : "";
    return `${subject} inline shell failed${code}${exit}${timeout}`.trim();
  }
  const message = previewSingleLine(redactSkillPaths(failure.message));
  return `${subject} ${status}${resource}${message ? ` - ${message}` : ""}`;
}

function skillNameFromSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const parts = source.split(/[\\/]+/u).filter(Boolean);
  if (parts.length === 0) return undefined;
  const leaf = parts.at(-1);
  if (leaf === "SKILL.md" && parts.length >= 2) return parts.at(-2);
  return leaf;
}

function previewSingleLine(value: string | undefined, max = 180): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max
    ? `${normalized.slice(0, Math.max(0, max - 3))}...`
    : normalized;
}

function redactSkillPaths(value: string | undefined): string | undefined {
  return value?.replace(
    /(?:[A-Za-z]:)?[\\/](?:[^\s'"`]+[\\/])*SKILL\.md/gu,
    "<skill path>",
  );
}

function toolCompletedChanged(event: SparkwrightEvent): boolean {
  if (!isRecord(event.payload)) return false;
  const output = isRecord(event.payload.output)
    ? event.payload.output
    : undefined;
  return output?.changed === true;
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
