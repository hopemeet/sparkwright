import { isDeepStrictEqual } from "node:util";
import type {
  RequestedToolCall,
  ToolCallBatch,
} from "../tool-orchestration.js";
import {
  classifyToolFailure,
  stableRefTarget,
  type ToolFailureCategory,
} from "../run-outcome.js";
import { getStringProperty, isRecord } from "../record-utils.js";
import type { RunLoopState, ToolResult } from "../types.js";
import type { ToolDefinition } from "../tools.js";

interface ToolExecutionDiagnostics {
  enabled: boolean;
  startedCalls: RequestedToolCall[];
}

export interface ToolExecutionDiagnostic {
  duplicateKind?: "in_flight_duplicate";
}

export function createToolExecutionDiagnostics(
  batch: ToolCallBatch,
  maxConcurrency: number,
): ToolExecutionDiagnostics {
  return {
    enabled: batch.mode === "concurrent" && maxConcurrency > 1,
    startedCalls: [],
  };
}

export function diagnoseToolExecution(
  diagnostics: ToolExecutionDiagnostics,
  call: RequestedToolCall,
): ToolExecutionDiagnostic | undefined {
  if (!diagnostics.enabled) return undefined;
  const duplicate = diagnostics.startedCalls.some((started) =>
    isRepeatedToolCall(started, call),
  );
  diagnostics.startedCalls.push(call);
  return duplicate ? { duplicateKind: "in_flight_duplicate" } : undefined;
}

export function isInFlightDuplicateToolResult(result: ToolResult): boolean {
  return (
    result.status === "failed" &&
    result.error?.metadata?.duplicateKind === "in_flight_duplicate"
  );
}

export function isRepeatedToolCall(
  previous: { toolName: string; arguments: unknown } | undefined,
  next: { toolName: string; arguments: unknown },
): boolean {
  return (
    previous?.toolName === next.toolName &&
    isDeepStrictEqual(previous.arguments, next.arguments)
  );
}

/**
 * A coarse "what does this call act on" key, used only by the doom-loop guard.
 * This intentionally stays narrower than outcome recovery fingerprinting: a
 * corrected argument shape for the same human-visible target should get a real
 * execution chance instead of being skipped as another repeat.
 */
export function semanticToolTarget(toolName: string, args: unknown): string {
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    // Capability calls (cron/agent/task) act on a stable `ref`; collapse to it
    // so a model varying cosmetic job/patch fields cannot escape the guard.
    const ref = stableRefTarget(record);
    if (ref !== undefined) {
      return `${toolName}::ref::${ref}`;
    }
    if (isShellToolName(toolName) && typeof record.command === "string") {
      const cwd =
        typeof record.cwd === "string" && record.cwd.length > 0
          ? `\u0000cwd:${record.cwd}`
          : "";
      return `${toolName}::command::${record.command}${cwd}`;
    }
    if (typeof record.path === "string") {
      return `${toolName}::path::${record.path}`;
    }
    if (Array.isArray(record.patterns)) {
      return `${toolName}::patterns::${record.patterns.join("\u0000")}`;
    }
    if (typeof record.pattern === "string") {
      return `${toolName}::pattern::${record.pattern}`;
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? String(args);
  } catch {
    serialized = String(args);
  }
  return `${toolName}::args::${serialized}`;
}

export function safelyRepeatedCallGuidance(
  tool: ToolDefinition | undefined,
  args: unknown,
): string | undefined {
  if (!tool?.repeatedCallGuidanceForArgs) return undefined;
  try {
    const guidance = tool.repeatedCallGuidanceForArgs(args);
    return typeof guidance === "string" && guidance.trim().length > 0
      ? guidance.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export function safelyManagesRepeatedCalls(
  tool: ToolDefinition | undefined,
  args: unknown,
): boolean {
  if (!tool?.managesRepeatedCalls) return false;
  try {
    return tool.managesRepeatedCalls(args) === true;
  } catch {
    return false;
  }
}

export function toolFailureContext(result: ToolResult): {
  category: ToolFailureCategory;
  retryScope: "arguments" | "target";
  expectedDenial?: boolean;
} {
  const metadata = isRecord(result.error?.metadata)
    ? result.error.metadata
    : undefined;
  const repeatedCategory = parseToolFailureCategory(
    metadata?.repeatedPriorFailureCategory,
  );
  const category =
    repeatedCategory ??
    classifyToolFailure(result.error?.code ?? "TOOL_FAILED");
  const expectedDenial =
    metadata?.repeatedPriorFailureExpectedDenial === true ||
    isExpectedDenialCategory(category);
  const retryScope =
    parseRetryScope(metadata?.repeatedPriorFailureRetryScope) ??
    parseRetryScope(metadata?.retryScope) ??
    classifyFailureRetryScope(result, category, expectedDenial);
  return {
    category,
    retryScope,
    ...(expectedDenial ? { expectedDenial: true } : {}),
  };
}

export function repeatedToolCallNudgeMessage(
  toolName: string,
  priorFailure: RunLoopState["lastFailedToolTarget"] | undefined,
): string {
  if (!priorFailure) {
    return (
      `Skipped: \`${toolName}\` was already called with identical arguments ` +
      `and returned the same result. Repeating it cannot produce new ` +
      `information. Choose a different action or set of arguments, or stop ` +
      `calling tools and answer the user directly. Repeating this exact call ` +
      `again will end the run.`
    );
  }

  const failureSummary = `${priorFailure.code}: ${priorFailure.message}`;
  if (priorFailure.expectedDenial) {
    const denialKind =
      priorFailure.category === "approval_denial" ? "approval" : "policy";
    return (
      `Skipped: \`${toolName}\` already hit an expected ${denialKind} ` +
      `denial on this target (${failureSummary}). Repeating the same denied ` +
      `action in the same run cannot change the permission boundary. Choose a ` +
      `permitted alternative, change the run access/approval posture, or answer ` +
      `the user with the denial. Repeating this will end the run.`
    );
  }

  if (priorFailure.retryScope === "arguments") {
    return (
      `Skipped: \`${toolName}\` already failed with these same arguments ` +
      `(${failureSummary}). Correct the reported argument error or choose a ` +
      `different action before retrying. Repeating this exact call will end ` +
      `the run.`
    );
  }

  if (isPathLikeSemanticTarget(priorFailure.key)) {
    return (
      `Skipped: \`${toolName}\` already hit a target-level failure on this ` +
      `path (${failureSummary}). Inspect the enclosing scope or choose a ` +
      `different path before retrying. Repeating this target will end the run.`
    );
  }

  return (
    `Skipped: \`${toolName}\` already hit a target-level failure ` +
    `(${failureSummary}). Choose a different concrete action, fix the cause, ` +
    `or answer the user directly if the failure is the result. Repeating this ` +
    `target will end the run.`
  );
}

export function repeatedToolCallNudgeMetadata(
  priorFailure: NonNullable<RunLoopState["lastFailedToolTarget"]>,
): Record<string, unknown> {
  return {
    repeatedPriorFailureCode: priorFailure.code,
    repeatedPriorFailureCategory: priorFailure.category ?? "tool_runtime_error",
    repeatedPriorFailureRetryScope: priorFailure.retryScope,
    repeatedPriorFailureExpectedDenial: priorFailure.expectedDenial === true,
  };
}

function parseRetryScope(value: unknown): "arguments" | "target" | undefined {
  return value === "arguments" || value === "target" ? value : undefined;
}

function classifyFailureRetryScope(
  result: ToolResult,
  category: ToolFailureCategory,
  expectedDenial: boolean,
): "arguments" | "target" {
  if (expectedDenial) return "target";
  if (category === "model_arg_error") return "arguments";
  const code = result.error?.code ?? "TOOL_FAILED";
  if (code === "TOOL_TIMEOUT") return "arguments";
  const failureText = `${code} ${result.error?.message ?? ""}`;
  if (
    /(?:ARGUMENT|SCHEMA|VALIDATION|OFFSET|LIMIT|RANGE|ANCHOR|PATCH|CURSOR|POSITION)/i.test(
      failureText,
    )
  ) {
    return "arguments";
  }
  if (
    /(?:^|\W)(?:EISDIR|ENOTDIR|ENOENT)(?:$|\W)/i.test(failureText) ||
    /(?:NOT[_ -]?FOUND|NO SUCH FILE)/i.test(failureText)
  ) {
    return "target";
  }
  return "target";
}

function parseToolFailureCategory(
  value: unknown,
): ToolFailureCategory | undefined {
  return value === "policy_denial" ||
    value === "approval_denial" ||
    value === "model_arg_error" ||
    value === "tool_runtime_error"
    ? value
    : undefined;
}

function isExpectedDenialCategory(category: ToolFailureCategory): boolean {
  return category === "policy_denial" || category === "approval_denial";
}

function isPathLikeSemanticTarget(key: string): boolean {
  return key.includes("::path::");
}

function isShellToolName(toolName: string): boolean {
  return toolName === "bash";
}

export function isIdempotentNoopToolResult(result: ToolResult): boolean {
  if (result.status !== "completed" || !isRecord(result.output)) return false;
  const output = result.output;
  const saved = output.saved;
  const changed = output.changed;
  const hint = getStringProperty(output, "hint");
  return (
    (saved === false || changed === false) &&
    Boolean(hint && /unchanged|no[- ]?op|nothing|do not|again/i.test(hint))
  );
}

export function shouldRequestContextCompaction(
  omitted: Array<{ reason: string }>,
): boolean {
  // Deterministic per-item truncation is cache-safe and must NOT request
  // compaction. Only cache-breaking drops (window/budget overflow) do.
  return omitted.some(
    (item) =>
      item.reason === "max_items_exceeded" ||
      item.reason === "max_total_chars_exceeded",
  );
}
