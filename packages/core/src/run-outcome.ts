import type { SparkwrightEvent } from "./events.js";
import { isRecord } from "./record-utils.js";

export type ToolFailureCategory =
  | "policy_denial"
  | "approval_denial"
  | "model_arg_error"
  | "tool_runtime_error";

export interface ClassifiedToolFailure {
  toolCallId?: string;
  toolName?: string;
  targetKey?: string;
  code?: string;
  category: ToolFailureCategory;
  recovered: boolean;
  /**
   * True when this failure was recovered specifically because the *same target*
   * had already been mutated successfully earlier in the run (e.g. a destructive
   * `cron remove` succeeded, then later calls returned "not found"). These are
   * expected idempotent fallout, not real failures, but they are worth calling
   * out as a distinct high-signal pattern in diagnostics.
   */
  recoveredByPriorMutation?: boolean;
}

export interface ToolOutcomeSummary {
  failures: ClassifiedToolFailure[];
  unresolvedFailures: ClassifiedToolFailure[];
  recoveredFailures: ClassifiedToolFailure[];
  /**
   * Recovered failures that followed a successful destructive mutation of the
   * same target. Surfaced separately so reports can explain the "succeeded, then
   * same target returned not-found" loop instead of silently dropping it.
   */
  mutationFollowupFailures: ClassifiedToolFailure[];
  /** @reserved Public outcome field consumed by policy / diagnostics UIs. */
  policyDenials: ClassifiedToolFailure[];
}

export interface ClassifiedCommandFailure {
  toolCallId?: string;
  command?: string;
  commandKey?: string;
  exitCode: number | null;
  timedOut: boolean;
  verificationRelevant: boolean;
  sequence?: number;
}

export interface ClassifiedCommandSuccess {
  toolCallId?: string;
  command?: string;
  commandKey?: string;
  verificationRelevant: boolean;
  sequence?: number;
}

export interface CommandOutcomeSummary {
  failures: ClassifiedCommandFailure[];
  successes: ClassifiedCommandSuccess[];
  verificationFailures: ClassifiedCommandFailure[];
  unresolvedVerificationFailures: ClassifiedCommandFailure[];
  byExitCode: Record<string, number>;
}

export interface VerificationProfileResult {
  hookName: string;
  profile?: string;
  id: string;
  status: "passed" | "failed";
  exitCode?: number | null;
  timedOut?: boolean;
}

export interface CompletedRunOutcome {
  kind:
    | "completed_with_issues"
    | "completed_with_tool_failures"
    | "completed_with_recovered_tool_failures"
    | "completed_with_verification_failures"
    | "completed_with_unsupported_final_claims";
  /**
   * Whether the run should be treated as failed (non-zero exit). True only for
   * unresolved tool failures or verification failures. Recovered tool failures
   * and unsupported final-answer claims are annotated but advisory — they do not
   * fail the run. This is the single authoritative source consumed by the CLI
   * exit code and status label.
   */
  failing: boolean;
  toolFailures?: { count: number; codes: string[] };
  commandFailures?: {
    count: number;
    lastCommand?: string;
    lastExitCode?: number | null;
  };
  /** @reserved Public outcome field consumed by trace/diagnostics readers of the serialized run.completed.outcome, not by an in-process TS reader. */
  verificationProfileFailures?: {
    count: number;
    lastId?: string;
    lastExitCode?: number | null;
  };
  unsupportedFinalClaims?: {
    count: number;
    claims: Array<{ kind: "command_success"; command: string }>;
  };
}

export function analyzeCommandOutcomes(
  events: readonly SparkwrightEvent[],
): CommandOutcomeSummary {
  const shellCalls = new Map<string, { command?: string }>();
  const verificationGoal = events.some((event) => {
    if (!isRecord(event.payload)) return false;
    if (event.type !== "run.created" && event.type !== "prompt.built") {
      return false;
    }
    return isVerificationGoal(stringValue(event.payload.goal));
  });
  const failures: ClassifiedCommandFailure[] = [];
  const successes: ClassifiedCommandSuccess[] = [];
  const byExitCode: Record<string, number> = {};

  for (const event of events) {
    if (event.type === "tool.requested" && isRecord(event.payload)) {
      const id = stringValue(event.payload.id);
      const toolName = stringValue(event.payload.toolName);
      if (!id || !isShellToolName(toolName)) continue;
      const args = isRecord(event.payload.arguments)
        ? event.payload.arguments
        : undefined;
      shellCalls.set(id, { command: stringValue(args?.command) });
      continue;
    }

    if (event.type !== "tool.completed" || !isRecord(event.payload)) continue;
    const toolCallId = stringValue(event.payload.toolCallId);
    const call = toolCallId ? shellCalls.get(toolCallId) : undefined;
    const toolName = stringValue(event.payload.toolName);
    if (!call && !isShellToolName(toolName)) continue;
    const output = isRecord(event.payload.output)
      ? event.payload.output
      : undefined;
    if (!output) continue;

    const reportedExitCode = numberOrNullValue(output.exitCode);
    const timedOut = booleanValue(output.timedOut) ?? false;
    const command =
      call?.command ??
      stringValue(output.command) ??
      (isRecord(event.payload.arguments)
        ? stringValue(event.payload.arguments.command)
        : undefined);
    const exitCode =
      effectiveShellExitCode(command, output) ?? reportedExitCode;
    const commandKey = commandIdentity(command);
    const verificationRelevant = isVerificationRelevantCommand(command, {
      verificationGoal,
    });

    if (exitCode === 0 && !timedOut) {
      successes.push({
        toolCallId,
        command,
        commandKey,
        verificationRelevant,
        sequence: event.sequence,
      });
      continue;
    }

    if (exitCode !== null || timedOut) {
      const key = timedOut ? "timed_out" : String(exitCode);
      byExitCode[key] = (byExitCode[key] ?? 0) + 1;
      failures.push({
        toolCallId,
        command,
        commandKey,
        exitCode,
        timedOut,
        verificationRelevant,
        sequence: event.sequence,
      });
    }
  }

  const verificationFailures = failures.filter(
    (failure) => failure.verificationRelevant,
  );
  const unresolvedVerificationFailures = verificationFailures.filter(
    (failure) => {
      const failureSequence = failure.sequence ?? 0;
      const laterSuccesses = successes.filter(
        (success) =>
          success.verificationRelevant &&
          (success.sequence ?? 0) > failureSequence,
      );
      if (laterSuccesses.length === 0) return true;
      if (!failure.commandKey) return false;
      return !laterSuccesses.some(
        (success) => success.commandKey === failure.commandKey,
      );
    },
  );

  return {
    failures,
    successes,
    verificationFailures,
    unresolvedVerificationFailures,
    byExitCode,
  };
}

function isShellToolName(value: unknown): boolean {
  return value === "bash" || value === "shell";
}

export function analyzeToolOutcomes(
  events: readonly SparkwrightEvent[],
): ToolOutcomeSummary {
  const requested = new Map<
    string,
    { toolName?: string; targetKey?: string; targetPath?: string }
  >();
  const completedByTarget = new Map<string, number[]>();
  const completedWritesByPath = new Map<string, number[]>();
  // Indexes of successful read/discovery completions, used to recognize that a
  // model recovered from a not-found probe by reading a *different* file.
  const completedReadIndexes: number[] = [];
  // Event indexes at which a target completed a state-changing mutation
  // (`changed: true`). A runtime failure on such a target is expected idempotent
  // fallout (the target is already gone) only when the mutation happened
  // *before* the failure — order matters, so we keep the indexes, not just a
  // set membership.
  const mutatedByTarget = new Map<string, number[]>();

  for (const [index, event] of events.entries()) {
    if (event.type === "tool.requested" && isRecord(event.payload)) {
      const id = stringValue(event.payload.id);
      const toolName = stringValue(event.payload.toolName);
      if (id) {
        const target = targetValue(event.payload.arguments);
        requested.set(id, {
          toolName,
          targetKey: toolName
            ? target
              ? `${toolName}::${target.kind}::${target.value}`
              : toolTargetFingerprint(toolName, event.payload.arguments)
            : undefined,
          targetPath: target?.kind === "path" ? target.value : undefined,
        });
      }
    } else if (event.type === "tool.completed" && isRecord(event.payload)) {
      const toolCallId = stringValue(event.payload.toolCallId);
      const completedToolName =
        stringValue(event.payload.toolName) ??
        toolNameForCall(requested, toolCallId);
      if (isReadFamilyTool(completedToolName)) {
        completedReadIndexes.push(index);
      }
      const targetKey = targetKeyForCall(requested, toolCallId);
      if (!targetKey) continue;
      const indexes = completedByTarget.get(targetKey) ?? [];
      indexes.push(index);
      completedByTarget.set(targetKey, indexes);
      if (
        isRecord(event.payload.output) &&
        event.payload.output.changed === true
      ) {
        const mutationIndexes = mutatedByTarget.get(targetKey) ?? [];
        mutationIndexes.push(index);
        mutatedByTarget.set(targetKey, mutationIndexes);
      }
    } else if (
      event.type === "workspace.write.completed" &&
      isRecord(event.payload)
    ) {
      const path = stringValue(event.payload.path);
      if (!path) continue;
      const indexes = completedWritesByPath.get(path) ?? [];
      indexes.push(index);
      completedWritesByPath.set(path, indexes);
    }
  }

  const failures: ClassifiedToolFailure[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type !== "tool.failed" || !isRecord(event.payload)) continue;
    const toolCallId = stringValue(event.payload.toolCallId);
    const code = toolFailureCodeFromPayload(event.payload);
    const toolName =
      stringValue(event.payload.toolName) ??
      toolNameForCall(requested, toolCallId);
    const targetKey = targetKeyForCall(requested, toolCallId);
    const targetPath = targetPathForCall(requested, toolCallId);
    const category = classifyToolFailure(code);
    const completedIndexes = targetKey
      ? (completedByTarget.get(targetKey) ?? [])
      : [];
    const completedWriteIndexes = targetPath
      ? (completedWritesByPath.get(targetPath) ?? [])
      : [];
    const recoveredBySameTarget =
      Boolean(targetKey) &&
      (completedIndexes.some((completedIndex) => completedIndex > index) ||
        completedWriteIndexes.some(
          (completedIndex) => completedIndex > index,
        ) ||
        (code === "REPEATED_TOOL_CALL_SKIPPED" &&
          completedIndexes.some((completedIndex) => completedIndex < index)));
    // A not-found probe (model guessed a path that does not exist) is recovered
    // when the model subsequently completes a read/discovery of a *different*
    // target, rather than only when it retries the same path.
    const recoveredByLaterRead =
      isReadFamilyTool(toolName) &&
      isNotFoundCode(code) &&
      completedReadIndexes.some((completedIndex) => completedIndex > index);
    // A runtime failure on a target that already completed a successful mutation
    // earlier in the run is expected idempotent fallout (the destructive op
    // already took effect; the target is gone). The "not found" lives only in
    // the message, so the generic TOOL_EXECUTION_FAILED code cannot be matched
    // by isNotFoundCode — key on the prior mutation instead. Scoped to runtime
    // errors so it never masks an arg/policy mistake.
    const recoveredByPriorMutation =
      category === "tool_runtime_error" &&
      Boolean(targetKey) &&
      (mutatedByTarget.get(targetKey as string) ?? []).some(
        (mutationIndex) => mutationIndex < index,
      );
    failures.push({
      toolCallId,
      toolName,
      targetKey,
      code,
      category,
      recovered:
        category !== "policy_denial" &&
        category !== "approval_denial" &&
        (recoveredBySameTarget ||
          recoveredByLaterRead ||
          recoveredByPriorMutation),
      ...(recoveredByPriorMutation ? { recoveredByPriorMutation: true } : {}),
    });
  }

  const unresolvedFailures = failures.filter(
    (failure) =>
      failure.category !== "policy_denial" &&
      failure.category !== "approval_denial" &&
      !failure.recovered,
  );
  const recoveredFailures = failures.filter((failure) => failure.recovered);
  const mutationFollowupFailures = failures.filter(
    (failure) => failure.recoveredByPriorMutation,
  );
  const policyDenials = failures.filter(
    (failure) =>
      failure.category === "policy_denial" ||
      failure.category === "approval_denial",
  );

  return {
    failures,
    unresolvedFailures,
    recoveredFailures,
    mutationFollowupFailures,
    policyDenials,
  };
}

/**
 * Configured verification-profile results, keyed by hook name (latest wins).
 * A non-zero exit code or a timeout marks the profile as failed. Stop-gate and
 * suggest-only hooks are advisory and excluded.
 *
 * This is the single source for profile results: the CLI exit-code path and the
 * run `outcome` both read it, so the two cannot disagree on whether a profile
 * failed.
 */
export function analyzeVerificationProfileResults(
  events: readonly SparkwrightEvent[],
): VerificationProfileResult[] {
  const latest = new Map<string, VerificationProfileResult>();
  for (const event of events) {
    if (event.type !== "workflow_hook.completed" || !isRecord(event.payload)) {
      continue;
    }
    const hookName = stringValue(event.payload.hookName);
    const parsed = parseVerificationHookName(hookName);
    if (!hookName || !parsed) continue;
    const result = isRecord(event.payload.result)
      ? event.payload.result
      : undefined;
    const metadata = isRecord(result?.metadata) ? result.metadata : undefined;
    if (!metadata) continue;
    const timedOut = booleanValue(metadata.timedOut) ?? false;
    const exitCode = numberOrNullValue(metadata.exitCode);
    latest.set(hookName, {
      hookName,
      profile: parsed.profile,
      id: parsed.id,
      status: exitCode === 0 && !timedOut ? "passed" : "failed",
      exitCode,
      timedOut,
    });
  }
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function parseVerificationHookName(
  hookName: string | undefined,
): { profile: string; id: string } | undefined {
  if (!hookName?.startsWith("verification:")) return undefined;
  const [, profile, ...idParts] = hookName.split(":");
  const id = idParts.join(":");
  if (!profile || !id) return undefined;
  if (id === "stop-gate" || profile === "suggest") return undefined;
  return { profile, id };
}

export interface CommandOutcomeSnapshot {
  total: number;
  byExitCode: Record<string, number>;
  verification: {
    total: number;
    unresolved: number;
    /** Legacy field: last unresolved verification failure, if any. */
    lastCommand?: string;
    lastExitCode?: number | null;
    lastTimedOut?: boolean;
    /** Last verification failure observed, even if a later success recovered it. */
    lastFailureCommand?: string;
    lastFailureExitCode?: number | null;
    lastFailureTimedOut?: boolean;
    /** Last successful verification command observed after/among failures. */
    lastSuccessfulVerificationCommand?: string;
  };
}

/**
 * A persistable snapshot of command outcomes, computed once at run time over the
 * full event stream. Trace summaries prefer this over recomputing from a
 * persisted (and possibly lossy) trace, where `tool.completed` output
 * is stripped and command failures can no longer be derived. Returns `undefined`
 * when no command failed, so clean runs carry nothing extra.
 */
export function commandOutcomeSnapshot(
  events: readonly SparkwrightEvent[],
): CommandOutcomeSnapshot | undefined {
  const outcomes = analyzeCommandOutcomes(events);
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

export interface ToolOutcomeSnapshot {
  unresolved: { total: number; byCode: Record<string, number> };
  recovered: { total: number; byCode: Record<string, number> };
  /**
   * High-signal diagnostic: failures that followed a successful destructive
   * mutation of the same target ("succeeded, then same target returned
   * not-found"). Counted within `recovered`; surfaced separately so reports can
   * name the pattern. Omitted when none occurred.
   */
  mutationFollowups?: { count: number; targets: string[] };
}

/**
 * A persistable snapshot of classified tool failures (unresolved vs recovered),
 * computed once at run time over the full event stream. Trace summaries prefer
 * this over recomputing from a persisted (possibly lossy) trace, where
 * `tool.requested` arguments are stripped and same-target recovery can no
 * longer be detected. Returns `undefined` when no tool failed.
 */
export function toolOutcomeSnapshot(
  events: readonly SparkwrightEvent[],
): ToolOutcomeSnapshot | undefined {
  const outcomes = analyzeToolOutcomes(events);
  if (
    outcomes.unresolvedFailures.length === 0 &&
    outcomes.recoveredFailures.length === 0
  ) {
    return undefined;
  }
  const tallyByCode = (failures: readonly ClassifiedToolFailure[]) => {
    const byCode: Record<string, number> = {};
    for (const failure of failures) {
      const code = failure.code ?? "unknown";
      byCode[code] = (byCode[code] ?? 0) + 1;
    }
    return byCode;
  };
  const mutationFollowupTargets = [
    ...new Set(
      outcomes.mutationFollowupFailures
        .map((failure) => failure.targetKey)
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  return {
    unresolved: {
      total: outcomes.unresolvedFailures.length,
      byCode: tallyByCode(outcomes.unresolvedFailures),
    },
    recovered: {
      total: outcomes.recoveredFailures.length,
      byCode: tallyByCode(outcomes.recoveredFailures),
    },
    ...(outcomes.mutationFollowupFailures.length > 0
      ? {
          mutationFollowups: {
            count: outcomes.mutationFollowupFailures.length,
            targets: mutationFollowupTargets,
          },
        }
      : {}),
  };
}

export function completedRunOutcomeFromEvents(
  events: readonly SparkwrightEvent[],
  finalMessage?: string,
): CompletedRunOutcome | undefined {
  const toolSummary = analyzeToolOutcomes(events);
  const commandSummary = analyzeCommandOutcomes(events);
  const unsupportedFinalClaims = analyzeUnsupportedFinalAnswerClaims(
    finalMessage,
    commandSummary,
  );
  const profileFailures = analyzeVerificationProfileResults(events).filter(
    (result) => result.status === "failed",
  );
  // Command-verification and profile-verification are a single "verification"
  // issue category for outcome-kind purposes.
  const hasVerificationFailures =
    commandSummary.unresolvedVerificationFailures.length > 0 ||
    profileFailures.length > 0;
  const issueKinds = [
    toolSummary.unresolvedFailures.length > 0 ||
      toolSummary.recoveredFailures.length > 0,
    hasVerificationFailures,
    unsupportedFinalClaims.length > 0,
  ].filter(Boolean).length;
  const relevant =
    toolSummary.unresolvedFailures.length > 0
      ? toolSummary.unresolvedFailures
      : toolSummary.recoveredFailures;

  if (
    relevant.length === 0 &&
    !hasVerificationFailures &&
    unsupportedFinalClaims.length === 0
  ) {
    return undefined;
  }

  const lastCommandFailure =
    commandSummary.unresolvedVerificationFailures.at(-1);
  const lastProfileFailure = profileFailures.at(-1);
  return {
    kind: completedRunOutcomeKind({
      issueKinds,
      hasUnresolvedToolFailures: toolSummary.unresolvedFailures.length > 0,
      hasRecoveredToolFailures:
        toolSummary.unresolvedFailures.length === 0 &&
        toolSummary.recoveredFailures.length > 0,
      hasCommandFailures: hasVerificationFailures,
      hasUnsupportedFinalClaims: unsupportedFinalClaims.length > 0,
    }),
    failing:
      toolSummary.unresolvedFailures.length > 0 || hasVerificationFailures,
    ...(relevant.length > 0
      ? {
          toolFailures: {
            count: relevant.length,
            codes: uniqueCodes(relevant),
          },
        }
      : {}),
    ...(commandSummary.unresolvedVerificationFailures.length > 0
      ? {
          commandFailures: {
            count: commandSummary.unresolvedVerificationFailures.length,
            ...(lastCommandFailure?.command
              ? { lastCommand: lastCommandFailure.command }
              : {}),
            ...(lastCommandFailure
              ? { lastExitCode: lastCommandFailure.exitCode }
              : {}),
          },
        }
      : {}),
    ...(profileFailures.length > 0
      ? {
          verificationProfileFailures: {
            count: profileFailures.length,
            ...(lastProfileFailure?.id
              ? { lastId: lastProfileFailure.id }
              : {}),
            ...(lastProfileFailure
              ? { lastExitCode: lastProfileFailure.exitCode }
              : {}),
          },
        }
      : {}),
    ...(unsupportedFinalClaims.length > 0
      ? {
          unsupportedFinalClaims: {
            count: unsupportedFinalClaims.length,
            claims: unsupportedFinalClaims,
          },
        }
      : {}),
  };
}

function completedRunOutcomeKind(input: {
  issueKinds: number;
  hasUnresolvedToolFailures: boolean;
  hasRecoveredToolFailures: boolean;
  hasCommandFailures: boolean;
  hasUnsupportedFinalClaims: boolean;
}): CompletedRunOutcome["kind"] {
  if (input.issueKinds > 1) return "completed_with_issues";
  if (input.hasUnresolvedToolFailures) return "completed_with_tool_failures";
  if (input.hasRecoveredToolFailures)
    return "completed_with_recovered_tool_failures";
  if (input.hasCommandFailures) return "completed_with_verification_failures";
  return "completed_with_unsupported_final_claims";
}

/**
 * Read a tool.failed code regardless of trace shape. Standard/debug traces
 * carry the nested `error.code`; legacy compact traces may flatten it to
 * `errorCode`. Reading both keeps failure classification — and therefore the
 * run verdict — trace-level invariant.
 */
function toolFailureCodeFromPayload(
  payload: Record<string, unknown>,
): string | undefined {
  if (isRecord(payload.error)) {
    const nested = stringValue(payload.error.code);
    if (nested) return nested;
  }
  return stringValue(payload.errorCode);
}

export function classifyToolFailure(
  code: string | undefined,
): ToolFailureCategory {
  if (isPolicyOrApprovalFailure(code)) {
    return code?.toLowerCase().includes("approval")
      ? "approval_denial"
      : "policy_denial";
  }
  if (isToolArgumentFailure(code)) {
    return "model_arg_error";
  }
  return "tool_runtime_error";
}

/**
 * Read/discovery tools whose later success signals that the model worked around
 * an earlier not-found probe (for example: `read_file` of a guessed path fails,
 * then `glob` + `read_file` of the real path succeed).
 */
function isReadFamilyTool(toolName: string | undefined): boolean {
  return (
    toolName === "read_file" ||
    toolName === "read_anchored_text" ||
    toolName === "glob" ||
    toolName === "grep"
  );
}

function isNotFoundCode(code: string | undefined): boolean {
  if (!code) return false;
  const normalized = code.toUpperCase();
  return (
    normalized === "ENOENT" ||
    normalized === "NOT_FOUND" ||
    normalized === "FILE_NOT_FOUND" ||
    normalized.endsWith("_NOT_FOUND")
  );
}

function isToolArgumentFailure(code: string | undefined): boolean {
  return (
    code === "TOOL_ARGS_INVALID" ||
    code === "TOOL_ARGUMENTS_INVALID" ||
    code === "TOOL_INPUT_INVALID" ||
    code === "TOOL_OUTPUT_INVALID" ||
    code === "REPEATED_TOOL_CALL_SKIPPED" ||
    Boolean(
      code &&
      (code.endsWith("_ARGS_INVALID") ||
        code.endsWith("_ARGUMENTS_INVALID") ||
        code.endsWith("_INPUT_INVALID")),
    )
  );
}

export function toolTargetFingerprint(toolName: string, args: unknown): string {
  const target = targetValue(args);
  if (target) return `${toolName}::${target.kind}::${target.value}`;

  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? String(args);
  } catch {
    serialized = String(args);
  }
  return `${toolName}::args::${serialized}`;
}

export function isPolicyOrApprovalFailure(code: string | undefined): boolean {
  if (!code) return false;
  const normalized = code.toLowerCase();
  return (
    normalized === "tool_denied" ||
    normalized === "tool_blocked_by_workflow_hook" ||
    normalized === "approval_denied" ||
    normalized === "tool_approval_denied" ||
    normalized === "untracked_workspace_mutation" ||
    normalized.endsWith("_denied") ||
    normalized.includes("safety")
  );
}

function toolNameForCall(
  requested: Map<string, { toolName?: string }>,
  toolCallId: string | undefined,
): string | undefined {
  return toolCallId ? requested.get(toolCallId)?.toolName : undefined;
}

function targetKeyForCall(
  requested: Map<string, { targetKey?: string }>,
  toolCallId: string | undefined,
): string | undefined {
  return toolCallId ? requested.get(toolCallId)?.targetKey : undefined;
}

function targetPathForCall(
  requested: Map<string, { targetPath?: string }>,
  toolCallId: string | undefined,
): string | undefined {
  return toolCallId ? requested.get(toolCallId)?.targetPath : undefined;
}

function uniqueCodes(failures: readonly ClassifiedToolFailure[]): string[] {
  return [
    ...new Set(
      failures
        .map((failure) => failure.code)
        .filter((code): code is string => Boolean(code)),
    ),
  ];
}

function analyzeUnsupportedFinalAnswerClaims(
  finalMessage: string | undefined,
  commandSummary: CommandOutcomeSummary,
): Array<{ kind: "command_success"; command: string }> {
  if (!finalMessage) return [];
  const successfulCommandKeys = new Set(
    commandSummary.successes
      .map((success) => success.commandKey)
      .filter((key): key is string => Boolean(key)),
  );
  const claims: Array<{ kind: "command_success"; command: string }> = [];
  const seen = new Set<string>();

  for (const command of extractClaimedSuccessfulCommands(finalMessage)) {
    const key = commandIdentity(command);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!successfulCommandKeys.has(key)) {
      claims.push({ kind: "command_success", command });
    }
  }

  return claims;
}

function extractClaimedSuccessfulCommands(message: string): string[] {
  const commands: string[] = [];
  const commandPattern = /`([^`\n]+)`/g;
  for (const line of message.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    if (!isSuccessClaimContext(lower)) continue;
    if (isFailureClaimContext(lower)) continue;
    commandPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = commandPattern.exec(line)) !== null) {
      const command = match[1]?.trim();
      if (!command) continue;
      if (!looksLikeCommandSnippet(command)) continue;
      if (isVerificationRelevantCommand(command, { verificationGoal: true })) {
        commands.push(command);
      }
    }
    const unquotedLine = line.replace(/`[^`\n]*`/g, " ");
    for (const command of extractInlineVerificationCommandClaims(
      unquotedLine,
    )) {
      commands.push(command);
    }
  }
  return commands;
}

function extractInlineVerificationCommandClaims(line: string): string[] {
  const commands: string[] = [];
  const successLookahead = String.raw`(?=\s+(?:passed?|passes|success(?:ful|fully)?|succeeded|ok|green)\b|[.!?)]|$)`;
  const patterns = [
    new RegExp(
      String.raw`\b((?:python\d*(?:\.\d+)*)\s+-m\s+(?:unittest|pytest)(?:\s+[^\s` +
        "`" +
        String.raw`,;:()]+)*)` +
        successLookahead,
      "gi",
    ),
    new RegExp(
      String.raw`\b((?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|verify|check|lint)(?:\s+[^\s` +
        "`" +
        String.raw`,;:()]+)*)` +
        successLookahead,
      "gi",
    ),
    new RegExp(
      String.raw`\b((?:cargo\s+(?:nextest\s+run|test)|go\s+test)(?:\s+[^\s` +
        "`" +
        String.raw`,;:()]+)*)` +
        successLookahead,
      "gi",
    ),
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const command = commandIdentity(stripInlineSuccessSuffix(match[1]));
      if (
        command &&
        isVerificationRelevantCommand(command, { verificationGoal: true })
      ) {
        commands.push(command);
      }
    }
  }
  return commands;
}

function stripInlineSuccessSuffix(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  return value
    .trim()
    .replace(
      /\s+(?:passed?|passes|success(?:ful|fully)?|succeeded|ok|green)\b\.?$/i,
      "",
    )
    .replace(/[.!?)]$/u, "")
    .trim();
}

function looksLikeCommandSnippet(command: string): boolean {
  const normalized = stripLeadingEnvAssignments(
    commandIdentity(command) ?? command,
  ).toLowerCase();
  return (
    isExplicitVerificationCommand(normalized) ||
    /^(?:\.{0,2}\/|~\/)/.test(normalized) ||
    /^(?:node|npx|bun|deno|make|cmake|gradle|mvn|bazel|ruby|bundle|rspec|swift|xcodebuild)\b/.test(
      normalized,
    ) ||
    /\s(?:&&|\|\||;)\s/.test(normalized)
  );
}

function isSuccessClaimContext(text: string): boolean {
  return (
    text.includes("✅") ||
    /\b(exit\s*0|passed?|passes|success(?:ful|fully)?|succeeded|ok|green)\b/.test(
      text,
    )
  );
}

function isFailureClaimContext(text: string): boolean {
  return /\b(fail(?:ed|s|ure)?|error|blocked|not\s+(?:run|executed|available|found)|skipped)\b/.test(
    text,
  );
}

function effectiveShellExitCode(
  command: string | undefined,
  output: Record<string, unknown>,
): number | null {
  if (!command || !/\bEXIT:\$?/.test(command)) return null;
  const combined = `${stringValue(output.stdout) ?? ""}\n${stringValue(output.stderr) ?? ""}`;
  const matches = [...combined.matchAll(/(?:^|\n)EXIT:(\d+)(?:\r?\n|$)/g)];
  const last = matches.at(-1)?.[1];
  if (!last) return null;
  const parsed = Number(last);
  return Number.isInteger(parsed) ? parsed : null;
}

function commandIdentity(command: string | undefined): string | undefined {
  if (!command) return undefined;
  let normalized = command.trim();
  normalized = normalized.replace(/\s*2>&1\s*/g, " ");
  normalized = normalized.replace(/\s*;\s*echo\s+['"]?EXIT:\$\?['"]?\s*$/i, "");
  normalized = normalized.replace(/^\(?\s*cd\s+(['"]?)[^&;()]+\1\s*&&\s*/i, "");
  normalized = normalized.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOrNullValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isVerificationGoal(goal: string | undefined): boolean {
  if (!goal) return false;
  const text = goal.toLowerCase();
  return (
    /\b(run|execute)\s+(the\s+)?(tests?|test suite|command|cli)\b/.test(text) ||
    /\b(cargo test|pytest|npm test|pnpm test|yarn test|go test)\b/.test(text) ||
    /\bverify\b/.test(text) ||
    /\btest(s|ing)?\b/.test(text)
  );
}

function isVerificationRelevantCommand(
  command: string | undefined,
  options: { verificationGoal: boolean },
): boolean {
  if (!command) return false;
  const normalized = stripLeadingEnvAssignments(
    commandIdentity(command) ?? command,
  ).toLowerCase();
  if (isExplicitVerificationCommand(normalized)) return true;
  if (!options.verificationGoal) return false;
  return !isProbeCommand(normalized);
}

function isExplicitVerificationCommand(command: string): boolean {
  return (
    /\b(cargo\s+(nextest\s+run|test)|go\s+test|pytest|py\.test)\b/.test(
      command,
    ) ||
    /\b(npm|pnpm|yarn)\s+(run\s+)?(test|verify|check|lint)\b/.test(command) ||
    /\b(vitest|jest|mocha)\b/.test(command) ||
    /\bpython(?:\d+(?:\.\d+)*)?\s+-m\s+(unittest|pytest|[^;\s]+\.cli)\b/.test(
      command,
    )
  );
}

function stripLeadingEnvAssignments(command: string): string {
  let rest = command.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) {
    const match = rest.match(
      /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s*/,
    );
    if (!match) break;
    rest = rest.slice(match[0].length).trimStart();
  }
  return rest;
}

function isProbeCommand(command: string): boolean {
  return (
    /^(pwd|ls|find|rg|grep|cat|sed|head|tail|wc|stat)\b/.test(command) ||
    /^(which|command\s+-v)\b/.test(command) ||
    /^node(?:\s+\S+)*\s+-e\b/.test(command) ||
    /\b(--version|-v)\b/.test(command) ||
    /\bpython(?:\d+(?:\.\d+)*)?\s+--version\b/.test(command)
  );
}

/**
 * The stable identity of a capability call (cron/agent/task) is its top-level
 * `ref` (a job id or exact name). The nested `job`/`patch` fields are cosmetic
 * and a looping model can vary them while hammering the same target, so both the
 * doom-loop guard (`semanticToolTarget` in run.ts) and outcome recovery key on
 * `ref` first when it is present.
 */
export function stableRefTarget(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const ref = args.ref;
  return typeof ref === "string" && ref.length > 0 ? ref : undefined;
}

function targetValue(
  args: unknown,
): { kind: string; value: string } | undefined {
  if (!isRecord(args)) return undefined;

  const ref = stableRefTarget(args);
  if (ref !== undefined) return { kind: "ref", value: ref };

  const fields = [
    "path",
    "targetPath",
    "file",
    "uri",
    "url",
    "id",
    "name",
    "command",
    "query",
    "pattern",
    "patterns",
  ];

  for (const field of fields) {
    if (!(field in args)) continue;
    const value = normalizeTargetValue(args[field]);
    if (value !== undefined) return { kind: field, value };
  }

  return undefined;
}

function normalizeTargetValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = parseSingleStringArray(value);
    return parsed ?? value;
  }
  if (Array.isArray(value)) {
    const normalized = value
      .map(normalizeTargetValue)
      .filter((item): item is string => item !== undefined);
    return normalized.length > 0 ? normalized.join("\u0000") : undefined;
  }
  if (isRecord(value)) {
    const leaves = stringLeaves(value);
    return leaves.length === 1
      ? normalizeTargetValue(leaves[0])
      : stableStringify(value);
  }
  return undefined;
}

function parseSingleStringArray(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) &&
      parsed.length === 1 &&
      typeof parsed[0] === "string"
      ? parsed[0]
      : undefined;
  } catch {
    return undefined;
  }
}

function stringLeaves(value: Record<string, unknown>): string[] {
  const leaves: string[] = [];
  for (const item of Object.values(value)) {
    if (typeof item === "string") leaves.push(item);
    if (isRecord(item)) {
      leaves.push(...stringLeaves(item));
    }
  }
  return leaves;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortJson(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
