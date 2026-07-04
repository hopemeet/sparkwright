import type {
  WorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowNodeVerdict,
  WorkflowRuntimeState,
  WorkflowTransitionDecision,
  WorkflowTransitionDefinition,
} from "./types.js";

export interface WorkflowRuntimeValidationIssue {
  code:
    | "WORKFLOW_EMPTY"
    | "WORKFLOW_DUPLICATE_NODE"
    | "WORKFLOW_UNSUPPORTED_NODE"
    | "WORKFLOW_UNSUPPORTED_TRANSITION_TARGET"
    | "WORKFLOW_UNKNOWN_TRANSITION_TARGET"
    | "WORKFLOW_INVALID_RETRY";
  message: string;
  nodeId?: string;
  target?: string;
}

export class WorkflowRuntimeDefinitionError extends Error {
  readonly issues: WorkflowRuntimeValidationIssue[];

  constructor(issues: WorkflowRuntimeValidationIssue[]) {
    super(
      issues.length === 1
        ? issues[0]!.message
        : `Workflow definition has ${issues.length} runtime errors.`,
    );
    this.name = "WorkflowRuntimeDefinitionError";
    this.issues = issues;
  }
}

export interface AdvanceWorkflowStateInput {
  definition: WorkflowDefinition;
  state: WorkflowRuntimeState;
  verdict: WorkflowNodeVerdict;
  now?: () => string;
}

export interface AdvanceWorkflowStateResult {
  state: WorkflowRuntimeState;
  decision: WorkflowTransitionDecision;
}

export function validateWorkflowRuntimeDefinition(
  definition: WorkflowDefinition,
): WorkflowRuntimeValidationIssue[] {
  const issues: WorkflowRuntimeValidationIssue[] = [];
  const ids = new Set<string>();
  if (definition.nodes.length === 0) {
    issues.push({
      code: "WORKFLOW_EMPTY",
      message: "Workflow definition must contain at least one node.",
    });
  }
  for (const node of definition.nodes) {
    if (ids.has(node.id)) {
      issues.push({
        code: "WORKFLOW_DUPLICATE_NODE",
        message: `Workflow node "${node.id}" is defined more than once.`,
        nodeId: node.id,
      });
    }
    ids.add(node.id);
    const execute = node.execute as string | undefined;
    if (execute === "human" || execute === "ask_user") {
      issues.push({
        code: "WORKFLOW_UNSUPPORTED_NODE",
        message: `Workflow node "${node.id}" uses unsupported execute kind "${execute}".`,
        nodeId: node.id,
      });
    }
  }

  for (const node of definition.nodes) {
    collectTransitionIssues(node.onPass, node, ids, issues);
    collectTransitionIssues(node.onFail, node, ids, issues);
  }
  return issues;
}

export function assertWorkflowRuntimeDefinition(
  definition: WorkflowDefinition,
): void {
  const issues = validateWorkflowRuntimeDefinition(definition);
  if (issues.length > 0) {
    throw new WorkflowRuntimeDefinitionError(issues);
  }
}

export function createInitialWorkflowRuntimeState(
  definition: WorkflowDefinition,
): WorkflowRuntimeState {
  assertWorkflowRuntimeDefinition(definition);
  const first = definition.nodes[0]!;
  return {
    status: "running",
    currentNodeId: first.id,
    attempts: { [first.id]: 1 },
    transitionLog: [],
  };
}

export function advanceWorkflowState(
  input: AdvanceWorkflowStateInput,
): AdvanceWorkflowStateResult {
  assertWorkflowRuntimeDefinition(input.definition);
  if (input.state.status !== "running" || !input.state.currentNodeId) {
    return {
      state: input.state,
      decision: {
        type: "fail",
        reason: "Workflow state is not running.",
      },
    };
  }

  const node = findNode(input.definition, input.state.currentNodeId);
  if (!node) {
    return failState(input, {
      type: "fail",
      fromNodeId: input.state.currentNodeId,
      reason: `Workflow node "${input.state.currentNodeId}" does not exist.`,
    });
  }

  const decision =
    input.verdict.status === "runtime_error"
      ? ({
          type: "fail",
          fromNodeId: node.id,
          reason: input.verdict.reason,
        } satisfies WorkflowTransitionDecision)
      : resolveNodeTransition(
          input.definition,
          input.state,
          node,
          input.verdict,
        );

  const state = applyDecision(input, decision);
  return { state, decision };
}

function resolveNodeTransition(
  definition: WorkflowDefinition,
  state: WorkflowRuntimeState,
  node: WorkflowNodeDefinition,
  verdict: WorkflowNodeVerdict,
): WorkflowTransitionDecision {
  if (verdict.status === "passed") {
    return resolveTransitionDefinition(definition, node, node.onPass, {
      defaultKind: "next",
      reason: verdict.reason ?? "node_passed",
      state,
    });
  }
  return resolveTransitionDefinition(definition, node, node.onFail, {
    defaultKind: "fail",
    reason: verdict.reason ?? "node_failed",
    state,
  });
}

function resolveTransitionDefinition(
  definition: WorkflowDefinition,
  node: WorkflowNodeDefinition,
  transition: WorkflowTransitionDefinition | undefined,
  options: {
    defaultKind: "next" | "fail";
    reason: string;
    state: WorkflowRuntimeState;
  },
): WorkflowTransitionDecision {
  if (transition === undefined) {
    if (options.defaultKind === "next") {
      const next = nextNode(definition, node.id);
      if (!next) {
        return {
          type: "complete",
          fromNodeId: node.id,
          reason: options.reason,
        };
      }
      return {
        type: "goto",
        fromNodeId: node.id,
        toNodeId: next.id,
        reason: options.reason,
      };
    }
    return { type: "fail", fromNodeId: node.id, reason: options.reason };
  }

  if (typeof transition === "string") {
    return transitionToTarget(node.id, transition, options.reason);
  }

  if ("goto" in transition) {
    return transitionToTarget(node.id, transition.goto, options.reason);
  }

  if ("fail" in transition) {
    return {
      type: "fail",
      fromNodeId: node.id,
      reason:
        typeof transition.fail === "string" ? transition.fail : options.reason,
    };
  }

  const maxRetries = transition.retry;
  const attempts = options.state.attempts[node.id] ?? 1;
  if (attempts <= maxRetries) {
    return {
      type: "retry",
      nodeId: node.id,
      attempt: attempts + 1,
      maxRetries,
      reason: options.reason,
    };
  }

  if (transition.then !== undefined) {
    return resolveTransitionDefinition(definition, node, transition.then, {
      ...options,
      defaultKind: "fail",
    });
  }
  return {
    type: "fail",
    fromNodeId: node.id,
    reason: `${options.reason}: retry budget exhausted`,
  };
}

function transitionToTarget(
  fromNodeId: string,
  target: string,
  reason: string,
): WorkflowTransitionDecision {
  if (target === "fail") {
    return { type: "fail", fromNodeId, reason };
  }
  return { type: "goto", fromNodeId, toNodeId: target, reason };
}

function applyDecision(
  input: AdvanceWorkflowStateInput,
  decision: WorkflowTransitionDecision,
): WorkflowRuntimeState {
  const logEntry = {
    at: input.now?.() ?? new Date().toISOString(),
    verdict: input.verdict,
    decision,
  };
  switch (decision.type) {
    case "goto":
      return {
        status: "running",
        currentNodeId: decision.toNodeId,
        attempts: bumpAttempt(input.state.attempts, decision.toNodeId),
        transitionLog: [...input.state.transitionLog, logEntry],
      };
    case "retry":
      return {
        status: "running",
        currentNodeId: decision.nodeId,
        attempts: {
          ...input.state.attempts,
          [decision.nodeId]: decision.attempt,
        },
        transitionLog: [...input.state.transitionLog, logEntry],
      };
    case "complete":
      return {
        status: "completed",
        attempts: { ...input.state.attempts },
        transitionLog: [...input.state.transitionLog, logEntry],
      };
    case "fail":
      return {
        status: "failed",
        attempts: { ...input.state.attempts },
        transitionLog: [...input.state.transitionLog, logEntry],
        failure: {
          reason: decision.reason,
          nodeId: decision.fromNodeId,
        },
      };
  }
}

function failState(
  input: AdvanceWorkflowStateInput,
  decision: Extract<WorkflowTransitionDecision, { type: "fail" }>,
): AdvanceWorkflowStateResult {
  return { state: applyDecision(input, decision), decision };
}

function bumpAttempt(
  attempts: Record<string, number>,
  nodeId: string,
): Record<string, number> {
  return {
    ...attempts,
    [nodeId]: (attempts[nodeId] ?? 0) + 1,
  };
}

function collectTransitionIssues(
  transition: WorkflowTransitionDefinition | undefined,
  node: WorkflowNodeDefinition,
  ids: ReadonlySet<string>,
  issues: WorkflowRuntimeValidationIssue[],
): void {
  if (transition === undefined) return;
  if (typeof transition === "string") {
    collectTargetIssue(transition, node, ids, issues);
    return;
  }
  if ("goto" in transition) {
    collectTargetIssue(transition.goto, node, ids, issues);
    return;
  }
  if ("retry" in transition) {
    if (!Number.isInteger(transition.retry) || transition.retry < 0) {
      issues.push({
        code: "WORKFLOW_INVALID_RETRY",
        message: `Workflow node "${node.id}" retry count must be a non-negative integer.`,
        nodeId: node.id,
      });
    }
    collectTransitionIssues(transition.then, node, ids, issues);
  }
}

function collectTargetIssue(
  target: string,
  node: WorkflowNodeDefinition,
  ids: ReadonlySet<string>,
  issues: WorkflowRuntimeValidationIssue[],
): void {
  if (target === "fail") return;
  if (target === "human" || target === "ask_user") {
    issues.push({
      code: "WORKFLOW_UNSUPPORTED_TRANSITION_TARGET",
      message: `Workflow node "${node.id}" references unsupported transition target "${target}".`,
      nodeId: node.id,
      target,
    });
    return;
  }
  if (!ids.has(target)) {
    issues.push({
      code: "WORKFLOW_UNKNOWN_TRANSITION_TARGET",
      message: `Workflow node "${node.id}" references unknown transition target "${target}".`,
      nodeId: node.id,
      target,
    });
  }
}

function findNode(
  definition: WorkflowDefinition,
  nodeId: string,
): WorkflowNodeDefinition | undefined {
  return definition.nodes.find((node) => node.id === nodeId);
}

function nextNode(
  definition: WorkflowDefinition,
  nodeId: string,
): WorkflowNodeDefinition | undefined {
  const index = definition.nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) return undefined;
  return definition.nodes[index + 1];
}
