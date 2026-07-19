import { describe, expect, it } from "vitest";
import { createPlanStepId } from "../src/ids.js";
import { createPlan, reviewPlan } from "../src/plan.js";

describe("plan protocol", () => {
  it("creates declarative plans with pending steps by default", () => {
    const stepId = createPlanStepId();
    const plan = createPlan({
      goal: "inspect repo",
      steps: [
        {
          id: stepId,
          intent: "research",
          suggestedAgent: "researcher",
          toolHints: ["read"],
          input: { question: "What is here?" },
        },
      ],
      metadata: {
        source: "test",
      },
    });

    expect(plan).toMatchObject({
      goal: "inspect repo",
      steps: [
        {
          id: stepId,
          intent: "research",
          status: "pending",
          suggestedAgent: "researcher",
          toolHints: ["read"],
        },
      ],
      metadata: {
        source: "test",
      },
    });
    expect(plan.id).toMatch(/^plan_/);
  });

  it("accepts plans that fit review constraints", () => {
    const plan = createPlan({
      goal: "inspect repo",
      steps: [
        {
          id: createPlanStepId(),
          intent: "research",
          suggestedAgent: "researcher",
          toolHints: ["read"],
          input: {},
          risk: "safe",
        },
      ],
    });

    expect(
      reviewPlan(plan, {
        allowedAgents: ["researcher"],
        allowedTools: ["read"],
        maxSteps: 2,
      }),
    ).toEqual([
      {
        planId: plan.id,
        status: "accepted",
        reason: "Plan accepted.",
        metadata: {
          stepCount: 1,
        },
      },
    ]);
  });

  it("rejects disallowed agents and tools and marks risky steps for approval", () => {
    const stepId = createPlanStepId();
    const plan = createPlan({
      goal: "change database",
      steps: [
        {
          id: stepId,
          intent: "delete rows",
          suggestedAgent: "coder",
          toolHints: ["drop_table"],
          input: {},
          risk: "risky",
        },
      ],
    });

    expect(
      reviewPlan(plan, {
        allowedAgents: ["researcher"],
        allowedTools: ["read"],
      }).map((decision) => decision.status),
    ).toEqual(["rejected", "rejected", "needs_approval"]);
  });
});
