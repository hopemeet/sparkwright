import type {
  RunAssessment,
  RunResult,
  UsageSnapshot,
} from "@sparkwright/core";
import type {
  AgentBlocker,
  AgentResultStatus,
  AgentRuntimeResult,
  DelegationLedgerResult,
  ParentAgentResult,
  ParentAgentWorkspaceEvidence,
} from "./types.js";
import type { AgentActionSummary } from "./action-summary.js";

export interface ProjectedAgentOutcome {
  status: AgentResultStatus;
  summary: string;
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
  output?: ParentAgentResult;
}

export interface ProjectParentAgentResultInput {
  result: AgentRuntimeResult;
  workspace: ParentAgentWorkspaceEvidence;
  actions?: readonly AgentActionSummary[];
  reused?: boolean;
}

/**
 * Project one report outcome from runtime-owned terminal evidence. A non-empty
 * natural final is completed; the parent still decides whether it satisfies the
 * delegated goal. Failure, cancellation, truncation, and limits are incomplete.
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
    if (!message) {
      const summary = "Child run completed without a report.";
      return {
        status: "partial",
        summary,
        blockers: [
          {
            code: "AGENT_REPORT_MISSING",
            message: summary,
          },
        ],
      };
    }
    return {
      status: "completed",
      summary: message,
      blockers: [],
      message,
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
 * task, lifecycle, and cache paths. Report status and diagnostic health are
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
      ? { blockers: input.result.blockers.map((blocker) => ({ ...blocker })) }
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

/** Canonical completed-report check shared by aggregate and cache paths. */
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

function runtimeTerminalBlocker(input: ProjectAgentOutcomeInput): AgentBlocker {
  if (input.stepLimitReached) {
    return {
      code: "AGENT_STEP_LIMIT_REACHED",
      message: "Child reached its configured step limit.",
    };
  }
  if (input.truncated) {
    return {
      code: "AGENT_RESULT_TRUNCATED",
      message: "Child output was truncated.",
    };
  }
  if (input.stopReason === "blocking_limit") {
    return {
      code: "AGENT_BLOCKING_LIMIT_REACHED",
      message: "Child stopped after reaching the runtime blocking limit.",
    };
  }
  if (input.signal === "cancelled") {
    return {
      code: "AGENT_RUN_CANCELLED",
      message: "Child run was cancelled.",
    };
  }
  return {
    code: "AGENT_RUN_INCOMPLETE",
    message: "Child run ended without a complete report.",
  };
}

function humanMessage(message: string | undefined): string | undefined {
  const value = message?.trim();
  return value || undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
