import type { SparkwrightEvent } from "./events.js";
import type { ForcedContinuationSource } from "./types.js";
import { isRecord } from "./record-utils.js";

export type CommandExpectation = "zero" | "nonzero";

export interface ShellCommandRequestFact {
  toolCallId: string;
  toolName?: string;
  command?: string;
}

export interface ClassifiedCommandFactInput {
  source: "shell_tool" | "workflow_hook";
  initiator: "model-initiated" | "verifier-launched";
  sequence: number;
  toolCallId?: string;
  toolName?: string;
  hookName?: string;
  hook?: string;
  profile?: string;
  nodeId?: string;
  verifierId?: string;
  verificationSource?: string;
  command?: string;
  args?: string[];
  commandKey?: string;
  exitCode: number | null;
  timedOut: boolean;
  verificationRelevant: boolean;
  expect?: CommandExpectation;
}

export interface WorkspaceWriteFactInput {
  sequence: number;
  path?: string;
}

export interface ForcedContinuationBudgetExceededFactInput {
  sequence: number;
  source: ForcedContinuationSource;
  used: number;
  limit: number;
  step?: number;
  reason?: string;
}

export function shellCommandRequestFromEvent(
  event: SparkwrightEvent,
): ShellCommandRequestFact | undefined {
  if (event.type !== "tool.requested" || !isRecord(event.payload)) {
    return undefined;
  }
  const toolCallId = stringValue(event.payload.id, event.payload.toolCallId);
  const toolName = stringValue(event.payload.toolName);
  if (!toolCallId || !isShellToolName(toolName)) return undefined;
  const args = isRecord(event.payload.arguments)
    ? event.payload.arguments
    : undefined;
  return {
    toolCallId,
    toolName,
    command: stringValue(args?.command),
  };
}

export function shellCommandFactFromToolCompleted(
  event: SparkwrightEvent,
  request: ShellCommandRequestFact | undefined,
  options: { verificationGoal: boolean },
): ClassifiedCommandFactInput | undefined {
  if (event.type !== "tool.completed" || !isRecord(event.payload)) {
    return undefined;
  }
  const toolCallId = stringValue(event.payload.toolCallId, event.payload.id);
  const toolName = stringValue(event.payload.toolName) ?? request?.toolName;
  if (!request && !isShellToolName(toolName)) return undefined;
  const output = isRecord(event.payload.output)
    ? event.payload.output
    : undefined;
  if (!output) return undefined;

  const command =
    request?.command ??
    stringValue(output.command) ??
    (isRecord(event.payload.arguments)
      ? stringValue(event.payload.arguments.command)
      : undefined);
  const reportedExitCode = numberOrNullValue(output.exitCode);
  const timedOut = booleanValue(output.timedOut) ?? false;
  const exitCode = effectiveShellExitCode(command, output) ?? reportedExitCode;
  if (exitCode === null && !timedOut) return undefined;

  return {
    source: "shell_tool",
    initiator: "model-initiated",
    sequence: event.sequence,
    toolCallId,
    toolName,
    command,
    commandKey: commandIdentity(command),
    exitCode,
    timedOut,
    verificationRelevant: isVerificationRelevantCommand(command, options),
  };
}

export function hookCommandFactFromWorkflowHookCompleted(
  event: SparkwrightEvent,
): ClassifiedCommandFactInput | undefined {
  if (event.type !== "workflow_hook.completed" || !isRecord(event.payload)) {
    return undefined;
  }
  const result = isRecord(event.payload.result)
    ? event.payload.result
    : undefined;
  const metadata = isRecord(result?.metadata) ? result.metadata : undefined;
  if (!metadata) return undefined;
  const exitCode = numberOrNullValue(metadata.exitCode);
  const timedOut = booleanValue(metadata.timedOut) ?? false;
  if (exitCode === null && !timedOut) return undefined;

  const hookName = stringValue(event.payload.hookName, metadata.hookName);
  const nodeId = stringValue(metadata.nodeId);
  const verifierId = stringValue(metadata.verifierId);
  const verificationSource = stringValue(metadata.verificationSource);
  const command = stringValue(metadata.command);
  const args = stringArrayValue(metadata.args);
  const expect = commandExpectationValue(metadata.expect);

  return {
    source: "workflow_hook",
    initiator: "verifier-launched",
    sequence: event.sequence,
    hookName,
    hook: stringValue(event.payload.hook, metadata.hook),
    profile: stringValue(metadata.profile),
    nodeId,
    verifierId,
    verificationSource,
    command,
    args,
    commandKey: commandIdentity(commandWithArgs(command, args)),
    exitCode,
    timedOut,
    verificationRelevant: Boolean(verifierId || expect),
    ...(expect ? { expect } : {}),
  };
}

export function workspaceWriteFactFromEvent(
  event: SparkwrightEvent,
): WorkspaceWriteFactInput | undefined {
  if (
    event.type !== "workspace.write.completed" &&
    event.type !== "workspace.write.untracked_access_granted"
  ) {
    return undefined;
  }
  if (!isRecord(event.payload)) {
    return undefined;
  }
  return {
    sequence: event.sequence,
    path: stringValue(event.payload.path),
  };
}

export function forcedContinuationBudgetExceededFromEvent(
  event: SparkwrightEvent,
): ForcedContinuationBudgetExceededFactInput | undefined {
  if (event.type !== "run.budget.exceeded" || !isRecord(event.payload)) {
    return undefined;
  }
  const signal = stringValue(event.payload.signal);
  const family = stringValue(event.payload.family);
  const source = forcedContinuationSourceValue(event.payload.source);
  const used = nonNegativeIntegerValue(event.payload.used);
  const limit = nonNegativeIntegerValue(event.payload.limit);
  if (
    signal !== "budget.exceeded" ||
    family !== "forced_continuation" ||
    !source ||
    used === undefined ||
    limit === undefined
  ) {
    return undefined;
  }
  const step = nonNegativeIntegerValue(event.payload.step);
  return {
    sequence: event.sequence,
    source,
    used,
    limit,
    ...(step !== undefined ? { step } : {}),
    ...(stringValue(event.payload.reason) !== undefined
      ? { reason: stringValue(event.payload.reason) }
      : {}),
  };
}

export function forcedContinuationSourceValue(
  value: unknown,
): ForcedContinuationSource | undefined {
  return value === "revival" || value === "workflow" ? value : undefined;
}

export function commandExpectationValue(
  value: unknown,
): CommandExpectation | undefined {
  if (value === "zero" || value === "nonzero") return value;
  if (value === "exit_zero" || value === "success") return "zero";
  if (value === "exit_nonzero" || value === "failure") return "nonzero";
  return undefined;
}

export function commandExpectationSatisfied(
  expect: CommandExpectation,
  input: { exitCode: number | null; timedOut: boolean },
): boolean {
  if (input.timedOut) return false;
  if (expect === "zero") return input.exitCode === 0;
  return typeof input.exitCode === "number" && input.exitCode !== 0;
}

export function isShellToolName(value: unknown): boolean {
  return value === "bash";
}

export function effectiveShellExitCode(
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

export function commandIdentity(
  command: string | undefined,
): string | undefined {
  if (!command) return undefined;
  let normalized = command.trim();
  normalized = normalized.replace(/\s*2>&1\s*/g, " ");
  normalized = normalized.replace(/\s*;\s*echo\s+['"]?EXIT:\$\?['"]?\s*$/i, "");
  normalized = normalized.replace(/^\(?\s*cd\s+(['"]?)[^&;()]+\1\s*&&\s*/i, "");
  normalized = normalized.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

export function isVerificationGoal(goal: string | undefined): boolean {
  if (!goal) return false;
  const text = goal.toLowerCase();
  return (
    /\b(run|execute)\s+(the\s+)?(tests?|test suite|command|cli)\b/.test(text) ||
    /\b(cargo test|pytest|npm test|pnpm test|yarn test|go test)\b/.test(text) ||
    /\bverify\b/.test(text) ||
    /\btest(s|ing)?\b/.test(text)
  );
}

export function isVerificationRelevantCommand(
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

export function isExplicitVerificationCommand(command: string): boolean {
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

export function stripLeadingEnvAssignments(command: string): string {
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

export function isProbeCommand(command: string): boolean {
  return (
    /^(pwd|ls|find|rg|grep|cat|sed|head|tail|wc|stat)\b/.test(command) ||
    /^(which|command\s+-v)\b/.test(command) ||
    /^node(?:\s+\S+)*\s+-e\b/.test(command) ||
    /\b(--version|-v)\b/.test(command) ||
    /\bpython(?:\d+(?:\.\d+)*)?\s+--version\b/.test(command)
  );
}

export function stableDiagnosticJson(value: unknown): string {
  try {
    return JSON.stringify(stableDiagnosticValue(value));
  } catch {
    return String(value);
  }
}

function stableDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.slice(0, 20).map(stableDiagnosticValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .slice(0, 20)
      .map((key) => [key, stableDiagnosticValue(value[key])]),
  );
}

function commandWithArgs(
  command: string | undefined,
  args: readonly string[] | undefined,
): string | undefined {
  if (!command) return undefined;
  return [command, ...(args ?? [])].join(" ").trim();
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length > 0 ? out : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function numberOrNullValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
