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
}

export interface ToolOutcomeSummary {
  failures: ClassifiedToolFailure[];
  unresolvedFailures: ClassifiedToolFailure[];
  recoveredFailures: ClassifiedToolFailure[];
  /** @reserved Public outcome field consumed by policy / diagnostics UIs. */
  policyDenials: ClassifiedToolFailure[];
}

export interface CompletedRunOutcome {
  kind:
    | "completed_with_tool_failures"
    | "completed_with_recovered_tool_failures";
  toolFailures: { count: number; codes: string[] };
}

export function analyzeToolOutcomes(
  events: readonly SparkwrightEvent[],
): ToolOutcomeSummary {
  const requested = new Map<
    string,
    { toolName?: string; targetKey?: string }
  >();
  const completedByTarget = new Map<string, number[]>();

  for (const [index, event] of events.entries()) {
    if (event.type === "tool.requested" && isRecord(event.payload)) {
      const id = stringValue(event.payload.id);
      const toolName = stringValue(event.payload.toolName);
      if (id) {
        requested.set(id, {
          toolName,
          targetKey: toolName
            ? toolTargetFingerprint(toolName, event.payload.arguments)
            : undefined,
        });
      }
    } else if (event.type === "tool.completed" && isRecord(event.payload)) {
      const targetKey = targetKeyForCall(
        requested,
        stringValue(event.payload.toolCallId),
      );
      if (!targetKey) continue;
      const indexes = completedByTarget.get(targetKey) ?? [];
      indexes.push(index);
      completedByTarget.set(targetKey, indexes);
    }
  }

  const failures: ClassifiedToolFailure[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type !== "tool.failed" || !isRecord(event.payload)) continue;
    const toolCallId = stringValue(event.payload.toolCallId);
    const code = isRecord(event.payload.error)
      ? stringValue(event.payload.error.code)
      : undefined;
    const toolName =
      stringValue(event.payload.toolName) ??
      toolNameForCall(requested, toolCallId);
    const targetKey = targetKeyForCall(requested, toolCallId);
    const category = classifyToolFailure(code);
    const completedIndexes = targetKey
      ? (completedByTarget.get(targetKey) ?? [])
      : [];
    failures.push({
      toolCallId,
      toolName,
      targetKey,
      code,
      category,
      recovered:
        category !== "policy_denial" &&
        category !== "approval_denial" &&
        Boolean(targetKey) &&
        (completedIndexes.some((completedIndex) => completedIndex > index) ||
          (code === "REPEATED_TOOL_CALL_SKIPPED" &&
            completedIndexes.some((completedIndex) => completedIndex < index))),
    });
  }

  const unresolvedFailures = failures.filter(
    (failure) =>
      failure.category !== "policy_denial" &&
      failure.category !== "approval_denial" &&
      !failure.recovered,
  );
  const recoveredFailures = failures.filter((failure) => failure.recovered);
  const policyDenials = failures.filter(
    (failure) =>
      failure.category === "policy_denial" ||
      failure.category === "approval_denial",
  );

  return {
    failures,
    unresolvedFailures,
    recoveredFailures,
    policyDenials,
  };
}

export function completedRunOutcomeFromEvents(
  events: readonly SparkwrightEvent[],
): CompletedRunOutcome | undefined {
  const summary = analyzeToolOutcomes(events);
  const relevant =
    summary.unresolvedFailures.length > 0
      ? summary.unresolvedFailures
      : summary.recoveredFailures;

  if (relevant.length === 0) return undefined;
  return {
    kind:
      summary.unresolvedFailures.length > 0
        ? "completed_with_tool_failures"
        : "completed_with_recovered_tool_failures",
    toolFailures: {
      count: relevant.length,
      codes: uniqueCodes(relevant),
    },
  };
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

function uniqueCodes(failures: readonly ClassifiedToolFailure[]): string[] {
  return [
    ...new Set(
      failures
        .map((failure) => failure.code)
        .filter((code): code is string => Boolean(code)),
    ),
  ];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function targetValue(
  args: unknown,
): { kind: string; value: string } | undefined {
  if (!isRecord(args)) return undefined;

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
