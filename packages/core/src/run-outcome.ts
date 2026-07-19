import type { SparkwrightEvent } from "./events.js";
import {
  factLedgerSnapshotFromUnknown,
  type FactLedgerSnapshot,
} from "./fact-ledger.js";
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

export function analyzeToolOutcomes(
  events: readonly SparkwrightEvent[],
): ToolOutcomeSummary {
  const requested = new Map<
    string,
    {
      toolName?: string;
      targetKey?: string;
      targetPath?: string;
      args?: unknown;
    }
  >();
  const completedByTarget = new Map<string, number[]>();
  const completedWritesByPath = new Map<string, number[]>();
  const completedTaskMonitorCalls: Array<{
    index: number;
    action: string;
    ids: string[];
  }> = [];
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
          args: event.payload.arguments,
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
      const taskMonitor = completedTaskMonitorCall(
        completedToolName,
        argsForCall(requested, toolCallId),
      );
      if (taskMonitor) {
        completedTaskMonitorCalls.push({ index, ...taskMonitor });
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
  const priorFailureByTarget = new Map<string, ClassifiedToolFailure>();
  for (const [index, event] of events.entries()) {
    if (event.type === "tool.completed" && isRecord(event.payload)) {
      const toolCallId = stringValue(event.payload.toolCallId);
      const targetKey = targetKeyForCall(requested, toolCallId);
      if (targetKey) priorFailureByTarget.delete(targetKey);
      continue;
    }
    if (event.type !== "tool.failed" || !isRecord(event.payload)) continue;
    const toolCallId = stringValue(event.payload.toolCallId);
    const code = toolFailureCodeFromPayload(event.payload);
    const toolName =
      stringValue(event.payload.toolName) ??
      toolNameForCall(requested, toolCallId);
    const targetKey = targetKeyForCall(requested, toolCallId);
    const targetPath = targetPathForCall(requested, toolCallId);
    const args = argsForCall(requested, toolCallId);
    const priorFailure = targetKey
      ? priorFailureByTarget.get(targetKey)
      : undefined;
    const category = classifyToolFailureFromPayload(
      code,
      event.payload,
      priorFailure,
    );
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
    const recoveredByTaskPlaceholder =
      isRecoverableTaskPlaceholderFailure(toolName, code, args) &&
      completedTaskMonitorCalls.some(
        (call) =>
          call.index > index &&
          call.action === taskMonitorAction(args) &&
          call.ids.length > 0,
      );
    const failure: ClassifiedToolFailure = {
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
          recoveredByPriorMutation ||
          recoveredByTaskPlaceholder),
      ...(recoveredByPriorMutation ? { recoveredByPriorMutation: true } : {}),
    };
    failures.push(failure);
    if (targetKey) priorFailureByTarget.set(targetKey, failure);
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

export function analyzeCommandOutcomesFromFactLedger(
  snapshot: FactLedgerSnapshot,
): CommandOutcomeSummary {
  const failures: ClassifiedCommandFailure[] = [];
  const successes: ClassifiedCommandSuccess[] = [];
  const byExitCode: Record<string, number> = {};

  for (const fact of snapshot.commands) {
    if (
      fact.stale ||
      (fact.initiator !== "model-initiated" &&
        !(fact.initiator === "verifier-launched" && fact.verificationRelevant))
    ) {
      continue;
    }
    if (fact.exitCode === 0 && !fact.timedOut) {
      successes.push({
        toolCallId: fact.toolCallId,
        command: fact.command,
        commandKey: fact.commandKey,
        verificationRelevant: fact.verificationRelevant,
        sequence: fact.sequence,
      });
      continue;
    }
    if (fact.exitCode !== null || fact.timedOut) {
      const key = fact.timedOut ? "timed_out" : String(fact.exitCode);
      byExitCode[key] = (byExitCode[key] ?? 0) + 1;
      failures.push({
        toolCallId: fact.toolCallId,
        command: fact.command,
        commandKey: fact.commandKey,
        exitCode: fact.exitCode,
        timedOut: fact.timedOut,
        verificationRelevant: fact.verificationRelevant,
        sequence: fact.sequence,
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
  const ledgerResults = verificationProfileResultsFromEventLedgers(events);
  if (ledgerResults) return ledgerResults;
  return analyzeVerificationProfileResultsFromEvents(events);
}

function analyzeVerificationProfileResultsFromEvents(
  events: readonly SparkwrightEvent[],
): VerificationProfileResult[] {
  const latest = new Map<string, VerificationProfileResult>();
  for (const event of events) {
    collectInvariantWorkflowFailureResult(event, "profile", latest);
    if (event.type !== "workflow_hook.completed" || !isRecord(event.payload)) {
      continue;
    }
    const hookName = stringValue(event.payload.hookName);
    if (!hookName) continue;
    const result = isRecord(event.payload.result)
      ? event.payload.result
      : undefined;
    const metadata = isRecord(result?.metadata) ? result.metadata : undefined;
    if (metadata?.verificationSource !== "profile") continue;
    const id = stringValue(metadata.verifierId);
    if (!id) continue;
    const timedOut = booleanValue(metadata.timedOut) ?? false;
    const exitCode = numberOrNullValue(metadata.exitCode);
    const item: VerificationProfileResult = {
      hookName,
      ...(stringValue(metadata.profile)
        ? { profile: stringValue(metadata.profile) }
        : {}),
      id,
      status: exitCode === 0 && !timedOut ? "passed" : "failed",
      exitCode,
      timedOut,
    };
    latest.set(verificationResultKey(item), item);
  }
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function verificationProfileResultsFromEventLedgers(
  events: readonly SparkwrightEvent[],
): VerificationProfileResult[] | undefined {
  const latest = new Map<string, VerificationProfileResult>();
  let sawLedger = false;
  for (const event of events) {
    const snapshot = factLedgerSnapshotFromRunCompleted(event);
    if (!snapshot) continue;
    sawLedger = true;
    for (const result of verificationProfileResultsFromFactLedger(snapshot)) {
      latest.set(verificationResultKey(result), result);
    }
  }
  return sawLedger
    ? [...latest.values()].sort((a, b) => a.id.localeCompare(b.id))
    : undefined;
}

function collectInvariantWorkflowFailureResult(
  event: SparkwrightEvent,
  source: "profile" | "documented_command",
  latest: Map<string, VerificationProfileResult>,
): void {
  if (event.type !== "workflow.failed" || !isRecord(event.payload)) return;
  if (
    event.payload.projectionKind !== "invariant" ||
    event.payload.verificationSource !== source
  ) {
    return;
  }
  const workflowRunId = stringValue(event.payload.workflowRunId);
  if (!workflowRunId || !Array.isArray(event.payload.failures)) return;
  const hookName = `workflow:${workflowRunId}`;
  const failures = event.payload.failures;
  for (const failure of failures) {
    const failureRecord = isRecord(failure) ? failure : {};
    const id = stringValue(failureRecord.verifierId);
    if (!id) continue;
    const item: VerificationProfileResult = {
      hookName,
      ...(source === "profile" && stringValue(event.payload.profile)
        ? { profile: stringValue(event.payload.profile) }
        : {}),
      id,
      status: "failed",
      exitCode: numberOrNullValue(failureRecord.exitCode),
      timedOut: booleanValue(failureRecord.timedOut) ?? false,
    };
    latest.set(verificationResultKey(item), item);
  }
}

export function verificationProfileResultsFromFactLedger(
  snapshot: FactLedgerSnapshot,
): VerificationProfileResult[] {
  return verificationResultsFromFactLedger(snapshot, "profile");
}

function verificationResultsFromFactLedger(
  snapshot: FactLedgerSnapshot,
  source: "profile" | "documented_command",
): VerificationProfileResult[] {
  const latest = new Map<string, VerificationProfileResult>();
  for (const result of snapshot.verificationResults) {
    if (result.verificationSource !== source) continue;
    const hookName = result.hookName;
    if (!hookName) continue;
    const id = result.verifierId;
    const item: VerificationProfileResult = {
      hookName,
      ...(source === "profile" && result.profile
        ? { profile: result.profile }
        : {}),
      id,
      status: result.satisfied && result.stale !== true ? "passed" : "failed",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    };
    latest.set(verificationResultKey(item), item);
  }
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function verificationResultKey(result: VerificationProfileResult): string {
  return `${result.hookName}:${result.id}`;
}

function factLedgerSnapshotFromRunCompleted(
  event: SparkwrightEvent,
): FactLedgerSnapshot | undefined {
  if (event.type !== "run.completed" || !isRecord(event.payload)) {
    return undefined;
  }
  return factLedgerSnapshotFromUnknown(event.payload.factLedger);
}

function toolFailureCodeFromPayload(
  payload: Record<string, unknown>,
): string | undefined {
  return isRecord(payload.error) ? stringValue(payload.error.code) : undefined;
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

function classifyToolFailureFromPayload(
  code: string | undefined,
  payload: Record<string, unknown>,
  priorFailure?: ClassifiedToolFailure,
): ToolFailureCategory {
  const metadata = isRecord(payload.error)
    ? isRecord(payload.error.metadata)
      ? payload.error.metadata
      : undefined
    : undefined;
  if (
    code === "REPEATED_TOOL_CALL_SKIPPED" &&
    metadata?.repeatedPriorFailureExpectedDenial === true
  ) {
    return metadata.repeatedPriorFailureCategory === "approval_denial"
      ? "approval_denial"
      : "policy_denial";
  }
  if (
    code === "REPEATED_TOOL_CALL_SKIPPED" &&
    priorFailure &&
    isExpectedDenialCategory(priorFailure.category)
  ) {
    return priorFailure.category;
  }
  return classifyToolFailure(code);
}

/**
 * Read/discovery tools whose later success signals that the model worked around
 * an earlier not-found probe (for example: `read` of a guessed path fails,
 * then `glob` + `read` of the real path succeed).
 */
function isReadFamilyTool(toolName: string | undefined): boolean {
  return (
    toolName === "read" ||
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

function isExpectedDenialCategory(category: ToolFailureCategory): boolean {
  return category === "policy_denial" || category === "approval_denial";
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

function argsForCall(
  requested: Map<string, { args?: unknown }>,
  toolCallId: string | undefined,
): unknown {
  return toolCallId ? requested.get(toolCallId)?.args : undefined;
}

function taskMonitorAction(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const action = stringValue(args.action);
  return action === "wait" || action === "get" || action === "output"
    ? action
    : undefined;
}

function concreteTaskIds(args: unknown): string[] {
  if (!isRecord(args)) return [];
  const ids: string[] = [];
  const taskId = stringValue(args.taskId);
  if (taskId) ids.push(taskId);
  if (Array.isArray(args.ids)) {
    for (const id of args.ids) {
      const value = stringValue(id);
      if (value) ids.push(value);
    }
  }
  return [...new Set(ids)];
}

function completedTaskMonitorCall(
  toolName: string | undefined,
  args: unknown,
): { action: string; ids: string[] } | undefined {
  if (toolName !== "task") return undefined;
  const action = taskMonitorAction(args);
  if (!action) return undefined;
  const ids = concreteTaskIds(args);
  return ids.length > 0 ? { action, ids } : undefined;
}

function isRecoverableTaskPlaceholderFailure(
  toolName: string | undefined,
  code: string | undefined,
  args: unknown,
): boolean {
  if (toolName !== "task" || !isToolArgumentFailure(code)) return false;
  if (!taskMonitorAction(args)) return false;
  return concreteTaskIds(args).length === 0;
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
    "taskId",
    "ids",
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
