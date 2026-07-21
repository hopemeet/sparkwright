import type {
  RunAssessment,
  RunResult,
  UsageSnapshot,
} from "@sparkwright/core";
import type {
  AgentBlocker,
  AgentBlockerKind,
  AgentBlockerOwner,
  AgentBlockerRequirement,
  AgentBlockerRequirementKind,
  AgentBlockerRetry,
  AgentResultDeclaration,
  AgentResultStatus,
  AgentResultStatusSource,
  AgentToolResult,
  DelegationLedgerResult,
} from "./types.js";

export const AGENT_RESULT_MARKER = "SPARKWRIGHT_AGENT_RESULT:";
export const AGENT_OUTCOME_SCHEMA_VERSION = "agent-outcome.v1" as const;

export const AGENT_RESULT_PROTOCOL_PROMPT = [
  "End your final message with exactly one machine-readable result line.",
  "The JSON is strict: use exactly the documented fields and do not add aliases.",
  `${AGENT_RESULT_MARKER} {"schemaVersion":"agent-outcome.v1","status":"completed","summary":"concise outcome for the parent","accomplishments":[],"blockers":[]}`,
  'Status must be exactly "completed", "partial", or "blocked". Completed requires an empty blockers array. Blocked requires at least one blocker. Partial may have blockers when useful work exists but completion still depends on something else.',
  'Each blocker must contain code, kind, owner, message, retry, and optional requirements. kind: "capability" | "permission" | "user_input" | "dependency" | "resource_limit" | "conflict" | "protocol" | "unknown". owner: "parent" | "user" | "runtime" | "external". retry: "none" | "immediate" | "after_input" | "after_approval" | "after_capability_change" | "after_dependency_change" | "after_resource_change". Each requirement is {"kind":"tool"|"approval"|"input"|"dependency"|"resource","name":"exact identifier"}.',
  "Report facts only. A blocker is advisory and never grants a capability or approval by itself. You may put the human-readable result before the final line.",
].join("\n");

const MAX_OUTCOME_ITEMS = 16;
const DECLARATION_KEYS = new Set([
  "schemaVersion",
  "status",
  "summary",
  "accomplishments",
  "blockers",
]);
const BLOCKER_KEYS = new Set([
  "code",
  "kind",
  "owner",
  "message",
  "requirements",
  "retry",
]);
const REQUIREMENT_KEYS = new Set(["kind", "name"]);
const BLOCKER_KINDS = new Set<AgentBlockerKind>([
  "capability",
  "permission",
  "user_input",
  "dependency",
  "resource_limit",
  "conflict",
  "protocol",
  "unknown",
]);
const BLOCKER_OWNERS = new Set<AgentBlockerOwner>([
  "parent",
  "user",
  "runtime",
  "external",
]);
const BLOCKER_RETRIES = new Set<AgentBlockerRetry>([
  "none",
  "immediate",
  "after_input",
  "after_approval",
  "after_capability_change",
  "after_dependency_change",
  "after_resource_change",
]);
const REQUIREMENT_KINDS = new Set<AgentBlockerRequirementKind>([
  "tool",
  "approval",
  "input",
  "dependency",
  "resource",
]);

export interface ParsedAgentResultDeclaration {
  declaration: AgentResultDeclaration;
  /** Human-readable message with the protocol marker removed. */
  message: string;
}

export interface ProjectedAgentOutcome {
  status: AgentResultStatus;
  statusSource: AgentResultStatusSource;
  summary: string;
  accomplishments?: string[];
  blockers: AgentBlocker[];
  message?: string;
}

export interface ProjectAgentOutcomeInput {
  signal: RunResult["signal"];
  stopReason?: RunResult["stopReason"] | string;
  message?: string;
  stepLimitReached?: boolean;
  truncated?: boolean;
}

export interface ProjectAgentInvocationResultInput {
  childRunId: string;
  spanId: string;
  result: RunResult;
  usage: UsageSnapshot;
  output?: Record<string, unknown>;
}

/**
 * Project one strict semantic outcome from either a valid child declaration or
 * runtime-owned terminal evidence. A normally completed child without a valid
 * declaration is partial, never silently upgraded to completed.
 */
export function projectAgentOutcome(
  input: ProjectAgentOutcomeInput,
): ProjectedAgentOutcome {
  const message = humanMessage(input.message);
  if (
    input.signal === "completed" &&
    input.stepLimitReached !== true &&
    input.truncated !== true
  ) {
    const declared = parseAgentResultDeclaration(input.message);
    if (declared) {
      return {
        status: declared.declaration.status,
        statusSource: "child",
        summary: declared.declaration.summary,
        ...(declared.declaration.accomplishments
          ? { accomplishments: declared.declaration.accomplishments }
          : {}),
        blockers: declared.declaration.blockers,
        message: declared.message,
      };
    }
    const markerPresent = input.message?.includes(AGENT_RESULT_MARKER) === true;
    const summary = markerPresent
      ? "Child returned an invalid agent-outcome.v1 declaration."
      : "Child completed without the required agent-outcome.v1 declaration.";
    return {
      status: "partial",
      statusSource: "runtime",
      summary,
      blockers: [
        {
          code: markerPresent
            ? "AGENT_RESULT_PROTOCOL_INVALID"
            : "AGENT_RESULT_PROTOCOL_MISSING",
          kind: "protocol",
          owner: "runtime",
          message: summary,
          requirements: [
            { kind: "resource", name: AGENT_OUTCOME_SCHEMA_VERSION },
          ],
          retry: "immediate",
        },
      ],
      ...(message ? { message } : {}),
    };
  }

  const synthesized = runtimeTerminalBlocker(input);
  return {
    status: input.stopReason === "blocking_limit" ? "blocked" : "partial",
    statusSource: "runtime",
    summary: message ?? synthesized.message,
    blockers: [synthesized],
    ...(message ? { message } : {}),
  };
}

/**
 * Canonical child-result projection used by delegate, parallel, dynamic-spawn,
 * task, lifecycle, and cache paths. Completion/finality and semantic health are
 * deliberately orthogonal: a complete child answer may still be failing.
 */
export function projectAgentInvocationResult(
  input: ProjectAgentInvocationResultInput,
): DelegationLedgerResult {
  const stepLimitReached = runResultStepLimitReached(input.result);
  const truncated = runResultTruncated(input.result) || stepLimitReached;
  const outcome = projectAgentOutcome({
    signal: input.result.signal,
    stopReason: input.result.stopReason,
    message: input.result.message,
    stepLimitReached,
    truncated,
  });
  const finality =
    input.result.signal === "completed" &&
    !truncated &&
    outcome.status === "completed"
      ? "complete"
      : "partial";
  const assessment = childAssessment(input.result);
  const healthNote = assessmentNote(assessment);
  return {
    childRunId: input.childRunId,
    spanId: input.spanId,
    signal: input.result.signal,
    stopReason: input.result.stopReason,
    ...(outcome.message ? { message: outcome.message } : {}),
    tokens: input.usage.tokens.total,
    costUsd: input.usage.costUsd,
    toolCalls: input.usage.toolCalls,
    modelCalls: input.usage.modelCalls,
    status: outcome.status,
    statusSource: outcome.statusSource,
    summary: outcome.summary,
    ...(outcome.accomplishments
      ? { accomplishments: outcome.accomplishments }
      : {}),
    blockers: outcome.blockers,
    finality,
    assessment,
    ...(stepLimitReached ? { stepLimitReached: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(healthNote ? { note: healthNote } : {}),
    ...(input.output ? { output: input.output } : {}),
  };
}

export function parseAgentResultDeclaration(
  message: string | undefined,
): ParsedAgentResultDeclaration | undefined {
  if (!message) return undefined;
  const markerIndex = message.lastIndexOf(AGENT_RESULT_MARKER);
  if (markerIndex < 0) return undefined;
  const raw = message.slice(markerIndex + AGENT_RESULT_MARKER.length).trim();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, DECLARATION_KEYS)) {
    return undefined;
  }
  if (value.schemaVersion !== AGENT_OUTCOME_SCHEMA_VERSION) return undefined;
  const status = agentResultStatusFromUnknown(value.status);
  if (!status) return undefined;
  const summary = nonEmptyString(value.summary);
  if (!summary) return undefined;
  const accomplishments = normalizedStringArray(value.accomplishments, true);
  if (value.accomplishments !== undefined && !accomplishments) return undefined;
  if (
    !Array.isArray(value.blockers) ||
    value.blockers.length > MAX_OUTCOME_ITEMS
  ) {
    return undefined;
  }
  const blockers = value.blockers.map(parseAgentBlocker);
  if (blockers.some((blocker) => blocker === undefined)) return undefined;
  const normalizedBlockers = blockers as AgentBlocker[];
  if (status === "completed" && normalizedBlockers.length > 0) return undefined;
  if (status === "blocked" && normalizedBlockers.length === 0) return undefined;
  return {
    declaration: {
      schemaVersion: AGENT_OUTCOME_SCHEMA_VERSION,
      status,
      summary,
      ...(accomplishments && accomplishments.length > 0
        ? { accomplishments }
        : {}),
      blockers: normalizedBlockers,
    },
    message: humanMessage(message) ?? summary,
  };
}

export function childAssessment(result: RunResult): RunAssessment {
  return result.assessment;
}

export function assessmentNote(assessment: RunAssessment): string | undefined {
  if (assessment.health === "clean") return undefined;
  const codes = assessment.issues
    .map((issue) => issue.code)
    .filter((code, index, all) => all.indexOf(code) === index)
    .slice(0, 4);
  return `Child run completed with ${assessment.health} health${
    codes.length > 0 ? ` (${codes.join(", ")})` : ""
  }; preserve this caveat when using its result.`;
}

export function runResultStepLimitReached(result: RunResult): boolean {
  return (
    (result.metadata as { stepLimitReached?: unknown } | undefined)
      ?.stepLimitReached === true
  );
}

export function runResultTruncated(result: RunResult): boolean {
  return (
    (result.metadata as { truncated?: unknown } | undefined)?.truncated === true
  );
}

/** Canonical execution-finality check shared by aggregate and cache paths. */
export function isCompleteAgentResult(result: {
  signal: string;
  status?: string;
  finality?: string;
  stepLimitReached?: boolean;
  truncated?: boolean;
}): boolean {
  return (
    result.signal === "completed" &&
    result.status === "completed" &&
    result.finality === "complete" &&
    result.stepLimitReached !== true &&
    result.truncated !== true
  );
}

/** Complete and clean is the only successful-result reuse state. */
export function isReusableAgentResult(
  result: Pick<
    DelegationLedgerResult,
    | "signal"
    | "status"
    | "finality"
    | "stepLimitReached"
    | "truncated"
    | "assessment"
  >,
): boolean {
  return isCompleteAgentResult(result) && result.assessment.health === "clean";
}

export function isAgentToolResult(value: unknown): value is AgentToolResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<AgentToolResult>;
  const blockers = Array.isArray(result.blockers)
    ? result.blockers.filter(isAgentBlocker)
    : [];
  return (
    typeof result.childRunId === "string" &&
    typeof result.spanId === "string" &&
    typeof result.signal === "string" &&
    (result.stopReason === undefined ||
      typeof result.stopReason === "string") &&
    typeof result.tokens === "number" &&
    typeof result.costUsd === "number" &&
    typeof result.toolCalls === "number" &&
    typeof result.modelCalls === "number" &&
    (result.status === "completed" ||
      result.status === "partial" ||
      result.status === "blocked") &&
    (result.statusSource === "child" ||
      result.statusSource === "runtime" ||
      result.statusSource === "adapter") &&
    nonEmptyString(result.summary) !== undefined &&
    (result.accomplishments === undefined ||
      normalizedStringArray(result.accomplishments, false) !== undefined) &&
    Array.isArray(result.blockers) &&
    blockers.length === result.blockers.length &&
    (result.status !== "completed" || blockers.length === 0) &&
    (result.status !== "blocked" || blockers.length > 0) &&
    (result.finality === "complete" || result.finality === "partial") &&
    typeof result.assessment === "object" &&
    result.assessment !== null
  );
}

function isAgentBlocker(value: unknown): value is AgentBlocker {
  return parseAgentBlocker(value) !== undefined;
}

function parseAgentBlocker(value: unknown): AgentBlocker | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, BLOCKER_KEYS)) return undefined;
  const code = nonEmptyString(value.code);
  const message = nonEmptyString(value.message);
  if (!code || !message) return undefined;
  if (!isSetMember(BLOCKER_KINDS, value.kind)) return undefined;
  if (!isSetMember(BLOCKER_OWNERS, value.owner)) return undefined;
  if (!isSetMember(BLOCKER_RETRIES, value.retry)) return undefined;
  let requirements: AgentBlockerRequirement[] | undefined;
  if (value.requirements !== undefined) {
    if (
      !Array.isArray(value.requirements) ||
      value.requirements.length > MAX_OUTCOME_ITEMS
    ) {
      return undefined;
    }
    const parsed = value.requirements.map(parseAgentBlockerRequirement);
    if (parsed.some((requirement) => requirement === undefined))
      return undefined;
    requirements = parsed as AgentBlockerRequirement[];
  }
  return {
    code,
    kind: value.kind,
    owner: value.owner,
    message,
    ...(requirements && requirements.length > 0 ? { requirements } : {}),
    retry: value.retry,
  };
}

function parseAgentBlockerRequirement(
  value: unknown,
): AgentBlockerRequirement | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, REQUIREMENT_KEYS)) {
    return undefined;
  }
  const name = nonEmptyString(value.name);
  if (!name || !isSetMember(REQUIREMENT_KINDS, value.kind)) return undefined;
  return { kind: value.kind, name };
}

function runtimeTerminalBlocker(input: ProjectAgentOutcomeInput): AgentBlocker {
  if (input.stepLimitReached) {
    return {
      code: "AGENT_STEP_LIMIT_REACHED",
      kind: "resource_limit",
      owner: "parent",
      message: "Child reached its configured step limit.",
      requirements: [{ kind: "resource", name: "maxSteps" }],
      retry: "after_resource_change",
    };
  }
  if (input.truncated) {
    return {
      code: "AGENT_RESULT_TRUNCATED",
      kind: "resource_limit",
      owner: "runtime",
      message: "Child output was truncated.",
      requirements: [{ kind: "resource", name: "output_limit" }],
      retry: "after_resource_change",
    };
  }
  if (input.stopReason === "blocking_limit") {
    return {
      code: "AGENT_BLOCKING_LIMIT_REACHED",
      kind: "resource_limit",
      owner: "runtime",
      message: "Child stopped after reaching the runtime blocking limit.",
      requirements: [{ kind: "resource", name: "blocking_limit" }],
      retry: "after_resource_change",
    };
  }
  if (input.signal === "cancelled") {
    return {
      code: "AGENT_RUN_CANCELLED",
      kind: "unknown",
      owner: "parent",
      message: "Child run was cancelled.",
      retry: "none",
    };
  }
  return {
    code: "AGENT_RUN_INCOMPLETE",
    kind: "unknown",
    owner: "runtime",
    message: "Child run ended without a complete semantic result.",
    retry: "immediate",
  };
}

function agentResultStatusFromUnknown(
  value: unknown,
): AgentResultStatus | undefined {
  return value === "completed" || value === "partial" || value === "blocked"
    ? value
    : undefined;
}

function humanMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const markerIndex = message.lastIndexOf(AGENT_RESULT_MARKER);
  const value = (
    markerIndex < 0 ? message : message.slice(0, markerIndex)
  ).trim();
  return value || undefined;
}

function normalizedStringArray(
  value: unknown,
  optional: boolean,
): string[] | undefined {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || value.length > MAX_OUTCOME_ITEMS)
    return undefined;
  const strings = value.map(nonEmptyString);
  if (strings.some((item) => item === undefined)) return undefined;
  return [...new Set(strings as string[])];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function isSetMember<T extends string>(
  values: ReadonlySet<T>,
  value: unknown,
): value is T {
  return typeof value === "string" && values.has(value as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
