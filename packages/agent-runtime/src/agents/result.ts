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
  AgentRuntimeResult,
  DelegationLedgerResult,
  ParentAgentResult,
  ParentAgentWorkspaceEvidence,
} from "./types.js";
import type { AgentActionSummary } from "./action-summary.js";

export const AGENT_RESULT_MARKER = "SPARKWRIGHT_AGENT_RESULT:";
export const AGENT_OUTCOME_SCHEMA_VERSION = "agent-outcome.v1" as const;

export const AGENT_RESULT_PROTOCOL_PROMPT = [
  "When the delegated goal is complete, finish with one natural-language report for the parent.",
  "Use submit_agent_result only when the outcome is partial or blocked and the parent needs structured recovery facts. It must be the sole tool call in that response.",
  'The exceptional envelope is {"status":"partial|blocked","summary":"..."}. accomplishments and structured blockers are optional supporting detail.',
  "The runtime treats a normal natural-language final as completed and never reopens task tools just to obtain a structured envelope.",
  "Report facts only. The legacy SPARKWRIGHT_AGENT_RESULT text marker is accepted only for migration.",
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
  terminalDeclaration?: unknown;
}

export interface ProjectAgentInvocationResultInput {
  childRunId: string;
  spanId: string;
  result: RunResult;
  usage: UsageSnapshot;
  output?: ParentAgentResult;
}

export interface ProjectParentAgentResultInput {
  result: AgentRuntimeResult;
  workspace: ParentAgentWorkspaceEvidence;
  actions?: readonly AgentActionSummary[];
  reused?: boolean;
}

/**
 * Project one semantic outcome from either a valid child declaration or
 * runtime-owned terminal evidence. A clean natural-language final is accepted
 * as an implicit completed outcome; malformed structured declarations remain
 * protocol failures instead of being silently accepted.
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
    const terminalDeclaration = agentResultDeclarationFromUnknown(
      input.terminalDeclaration,
    );
    if (terminalDeclaration) {
      return {
        status: terminalDeclaration.status,
        summary: terminalDeclaration.summary,
        ...(terminalDeclaration.accomplishments
          ? { accomplishments: terminalDeclaration.accomplishments }
          : {}),
        blockers: terminalDeclaration.blockers ?? [],
        ...(message ? { message } : {}),
      };
    }
    const declared = parseAgentResultDeclaration(input.message);
    if (declared) {
      return {
        status: declared.declaration.status,
        summary: declared.declaration.summary,
        ...(declared.declaration.accomplishments
          ? { accomplishments: declared.declaration.accomplishments }
          : {}),
        blockers: declared.declaration.blockers ?? [],
        message: declared.message,
      };
    }
    const markerPresent = input.message?.includes(AGENT_RESULT_MARKER) === true;
    if (!markerPresent) {
      const summary =
        message ?? "Child completed with an implicit natural-language result.";
      return {
        status: "completed",
        summary,
        blockers: [],
        ...(message ? { message } : {}),
      };
    }
    const summary = "Child returned an invalid agent-outcome.v1 declaration.";
    return {
      status: "partial",
      summary,
      blockers: [
        {
          code: "AGENT_RESULT_PROTOCOL_INVALID",
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
    summary: message ?? synthesized.message,
    blockers: [synthesized],
    ...(message ? { message } : {}),
  };
}

/**
 * Canonical child-result projection used by delegate, parallel, dynamic-spawn,
 * task, lifecycle, and cache paths. Semantic outcome and diagnostic health are
 * deliberately orthogonal: a completed child answer may still have issues.
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
    terminalDeclaration: terminalDeclarationFromRunResult(input.result),
  });
  const assessment = childAssessment(input.result);
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
    summary: outcome.summary,
    ...(outcome.accomplishments
      ? { accomplishments: outcome.accomplishments }
      : {}),
    blockers: outcome.blockers,
    assessment,
    ...(stepLimitReached ? { stepLimitReached: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(input.output ? { output: input.output } : {}),
  };
}

/**
 * Project the one compact report that is safe to place in the parent model's
 * tool-result context. Child prose remains explicit in `report`; mutation and
 * completeness facts are supplied by the runtime.
 */
export function projectParentAgentResult(
  input: ProjectParentAgentResultInput,
): ParentAgentResult {
  const warnings = [
    ...parentActionableAssessmentWarnings(
      input.result.assessment,
      input.workspace,
      input.actions ?? [],
    ),
    ...(input.result.stepLimitReached || input.result.truncated
      ? ["The child stopped at its action limit; its report may be incomplete."]
      : []),
    ...(input.reused
      ? ["The runtime reused this completed child result; no new child ran."]
      : []),
  ];
  return {
    childRunId: input.result.childRunId,
    status: input.result.status,
    report:
      nonEmptyString(input.result.message) ??
      nonEmptyString(input.result.summary) ??
      "Child returned no report.",
    workspace: {
      writes: input.workspace.writes,
      ...(input.workspace.paths && input.workspace.paths.length > 0
        ? { paths: [...input.workspace.paths] }
        : {}),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(input.result.blockers.length > 0
      ? { blockers: input.result.blockers.map(cloneAgentBlocker) }
      : {}),
  };
}

function parentActionableAssessmentWarnings(
  assessment: RunAssessment,
  workspace: ParentAgentWorkspaceEvidence,
  actions: readonly AgentActionSummary[],
): string[] {
  const warnings: string[] = [];
  for (const issue of assessment.issues) {
    if (issue.code === "UNRESOLVED_TOOL_FAILURE") {
      const failedActions = actions.filter(
        (action) => action.status === "failed",
      );
      const failure =
        failedActions.length > 0
          ? failedActions.slice(0, 3).map(describeUnresolvedAction).join("; ")
          : describeUnresolvedIssue(issue);
      const failedMutation = failedActions.some((action) =>
        isWorkspaceMutationTool(action.toolName),
      );
      warnings.push(
        [
          `The child completed with unresolved tool work: ${failure}.`,
          failedMutation && workspace.writes === 0
            ? "No structured workspace write succeeded, so creation or modification is not proven."
            : "Resolve the failure before relying on the affected completion claims.",
        ].join(" "),
      );
      continue;
    }
    if (issue.code === "VERIFICATION_FAILED") {
      const command = issue.details?.lastCommand;
      warnings.push(
        `Child verification failed${command ? ` for ${command}` : ""}; do not present the affected result as verified.`,
      );
      continue;
    }
    if (
      issue.kind === "workflow_failure" ||
      issue.kind === "run_failure" ||
      issue.kind === "run_cancelled" ||
      issue.kind === "assessment_unavailable"
    ) {
      warnings.push(
        `The child completed with a runtime assessment issue (${issue.code}); treat its report as incomplete until the issue is resolved.`,
      );
    }
  }
  return uniqueStrings(warnings);
}

function describeUnresolvedAction(action: AgentActionSummary): string {
  const subject = [action.toolName, action.preview].filter(Boolean).join(" ");
  if (action.errorCode === "WORKSPACE_CREATE_CONFLICT") {
    return `${subject} failed because the target already exists (${action.errorCode})`;
  }
  if (action.errorCode === "WORKSPACE_REPLACE_CONFLICT") {
    return `${subject} failed because the target does not exist (${action.errorCode})`;
  }
  if (action.errorMessage) {
    return `${subject} failed: ${action.errorMessage}${
      action.errorCode ? ` (${action.errorCode})` : ""
    }`;
  }
  return `${subject} failed and was not recovered${
    action.errorCode ? ` (${action.errorCode})` : ""
  }`;
}

function describeUnresolvedIssue(
  issue: RunAssessment["issues"][number],
): string {
  const count = Math.max(1, issue.count);
  const tools = issue.details?.toolNames?.slice(0, 3).join(", ");
  const codes = issue.details?.codes?.slice(0, 3).join(", ");
  return `${count} tool failure${count === 1 ? "" : "s"} remained unresolved${
    tools ? ` in ${tools}` : ""
  }${codes ? ` (${codes})` : ""}`;
}

function isWorkspaceMutationTool(toolName: string): boolean {
  return (
    toolName === "create" ||
    toolName === "write" ||
    toolName === "edit" ||
    toolName === "edit_anchored_text"
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return values.filter(
    (value, index, all) => value.length > 0 && all.indexOf(value) === index,
  );
}

export function agentWorkspaceEvidence(
  events: readonly { type: string; payload?: unknown }[],
): ParentAgentWorkspaceEvidence {
  let writes = 0;
  const paths: string[] = [];
  for (const event of events) {
    if (event.type !== "workspace.write.completed") continue;
    writes += 1;
    if (!isRecord(event.payload)) continue;
    const path = nonEmptyString(event.payload.path);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return {
    writes,
    ...(paths.length > 0 ? { paths } : {}),
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
  const declaration = agentResultDeclarationFromUnknown(value);
  if (!declaration) return undefined;
  return {
    declaration,
    message: humanMessage(message) ?? declaration.summary,
  };
}

export function agentResultDeclarationFromUnknown(
  value: unknown,
): AgentResultDeclaration | undefined {
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
    value.blockers !== undefined &&
    (!Array.isArray(value.blockers) ||
      value.blockers.length > MAX_OUTCOME_ITEMS)
  ) {
    return undefined;
  }
  const blockers = Array.isArray(value.blockers)
    ? value.blockers.map(parseAgentBlocker)
    : [];
  if (blockers.some((blocker) => blocker === undefined)) return undefined;
  const normalizedBlockers = blockers as AgentBlocker[];
  if (status === "completed" && normalizedBlockers.length > 0) return undefined;
  return {
    schemaVersion: AGENT_OUTCOME_SCHEMA_VERSION,
    status,
    summary,
    ...(accomplishments && accomplishments.length > 0
      ? { accomplishments }
      : {}),
    ...(normalizedBlockers.length > 0 ? { blockers: normalizedBlockers } : {}),
  };
}

export function childAssessment(result: RunResult): RunAssessment {
  return result.assessment;
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

export function terminalDeclarationFromRunResult(result: RunResult): unknown {
  const terminalResult = isRecord(result.metadata?.terminalResult)
    ? result.metadata.terminalResult
    : undefined;
  return terminalResult?.kind === "agent_result"
    ? terminalResult.output
    : undefined;
}

/** Canonical semantic-completion check shared by aggregate and cache paths. */
export function isCompleteAgentResult(result: {
  signal: string;
  status?: string;
  stepLimitReached?: boolean;
  truncated?: boolean;
}): boolean {
  return (
    result.signal === "completed" &&
    result.status === "completed" &&
    result.stepLimitReached !== true &&
    result.truncated !== true
  );
}

/** Complete and clean is the only successful-result reuse state. */
export function isReusableAgentResult(
  result: Pick<
    DelegationLedgerResult,
    "signal" | "status" | "stepLimitReached" | "truncated" | "assessment"
  >,
): boolean {
  return isCompleteAgentResult(result) && result.assessment.health === "clean";
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

function cloneAgentBlocker(blocker: AgentBlocker): AgentBlocker {
  return {
    ...blocker,
    ...(blocker.requirements
      ? {
          requirements: blocker.requirements.map((requirement) => ({
            ...requirement,
          })),
        }
      : {}),
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
