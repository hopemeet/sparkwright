import { createPlanId, type PlanId, type PlanStepId } from "./ids.js";
import type { ToolRisk } from "./tools.js";

export type PlanStepStatus =
  | "pending"
  | "ready"
  | "blocked"
  | "skipped"
  | "completed"
  | "failed";
export type PlanDecisionStatus =
  | "accepted"
  | "rejected"
  | "needs_approval"
  | "deferred";

export interface Plan {
  id: PlanId;
  goal: string;
  steps: PlanStep[];
  constraints?: PlanConstraints;
  metadata: Record<string, unknown>;
}

export interface PlanStep {
  id: PlanStepId;
  intent: string;
  input: unknown;
  suggestedAgent?: string;
  toolHints?: string[];
  dependsOn?: PlanStepId[];
  expectedOutput?: string;
  risk?: ToolRisk;
  budgetEstimate?: PlanStepBudgetEstimate;
  status?: PlanStepStatus;
  metadata?: Record<string, unknown>;
}

export interface PlanConstraints {
  maxSteps?: number;
  maxDurationMs?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  allowedAgents?: string[];
  allowedTools?: string[];
}

export interface PlanStepBudgetEstimate {
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  costUsd?: number;
}

export interface PlanDecision {
  planId: PlanId;
  stepId?: PlanStepId;
  status: PlanDecisionStatus;
  reason: string;
  metadata: Record<string, unknown>;
}

export interface CreatePlanInput {
  goal: string;
  steps: Array<Omit<PlanStep, "status"> & { status?: PlanStepStatus }>;
  constraints?: PlanConstraints;
  metadata?: Record<string, unknown>;
}

export interface ReviewPlanOptions {
  allowedAgents?: string[];
  allowedTools?: string[];
  maxSteps?: number;
}

export function createPlan(input: CreatePlanInput): Plan {
  return {
    id: createPlanId(),
    goal: input.goal,
    steps: input.steps.map((step) => ({
      ...step,
      status: step.status ?? "pending",
      dependsOn: step.dependsOn ? [...step.dependsOn] : undefined,
      toolHints: step.toolHints ? [...step.toolHints] : undefined,
      metadata: step.metadata ? { ...step.metadata } : undefined,
    })),
    constraints: input.constraints ? { ...input.constraints } : undefined,
    metadata: input.metadata ?? {},
  };
}

export function reviewPlan(
  plan: Plan,
  options: ReviewPlanOptions = {},
): PlanDecision[] {
  const decisions: PlanDecision[] = [];
  const allowedAgents = options.allowedAgents
    ? new Set(options.allowedAgents)
    : undefined;
  const allowedTools = options.allowedTools
    ? new Set(options.allowedTools)
    : undefined;
  const maxSteps = options.maxSteps ?? plan.constraints?.maxSteps;

  if (maxSteps !== undefined && plan.steps.length > maxSteps) {
    decisions.push({
      planId: plan.id,
      status: "rejected",
      reason: `Plan has ${plan.steps.length} steps, above the limit of ${maxSteps}.`,
      metadata: {
        stepCount: plan.steps.length,
        maxSteps,
      },
    });
  }

  for (const step of plan.steps) {
    if (
      allowedAgents !== undefined &&
      step.suggestedAgent !== undefined &&
      !allowedAgents.has(step.suggestedAgent)
    ) {
      decisions.push({
        planId: plan.id,
        stepId: step.id,
        status: "rejected",
        reason: `Suggested agent is not allowed: ${step.suggestedAgent}`,
        metadata: {
          suggestedAgent: step.suggestedAgent,
          allowedAgents: [...allowedAgents],
        },
      });
    }

    for (const toolName of step.toolHints ?? []) {
      if (allowedTools !== undefined && !allowedTools.has(toolName)) {
        decisions.push({
          planId: plan.id,
          stepId: step.id,
          status: "rejected",
          reason: `Tool hint is not allowed: ${toolName}`,
          metadata: {
            toolName,
            allowedTools: [...allowedTools],
          },
        });
      }
    }

    if (step.risk === "risky") {
      decisions.push({
        planId: plan.id,
        stepId: step.id,
        status: "needs_approval",
        reason: `Plan step is risky: ${step.intent}`,
        metadata: {
          risk: step.risk,
          intent: step.intent,
        },
      });
    }
  }

  if (decisions.length === 0) {
    decisions.push({
      planId: plan.id,
      status: "accepted",
      reason: "Plan accepted.",
      metadata: {
        stepCount: plan.steps.length,
      },
    });
  }

  return decisions;
}
