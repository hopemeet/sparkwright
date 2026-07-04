import { describe, expect, it } from "vitest";
import {
  advanceWorkflowState,
  createInitialWorkflowRuntimeState,
  validateWorkflowRuntimeDefinition,
  type WorkflowDefinition,
} from "../src/index.js";

function workflow(nodes: WorkflowDefinition["nodes"]): WorkflowDefinition {
  return {
    assetName: "test-workflow",
    contentHash: "hash",
    nodes,
  };
}

describe("workflow runtime state machine", () => {
  it("advances linearly and completes after the final node", () => {
    const definition = workflow([
      { id: "plan", body: "Plan." },
      { id: "implement", body: "Implement." },
    ]);
    const started = createInitialWorkflowRuntimeState(definition);

    const first = advanceWorkflowState({
      definition,
      state: started,
      verdict: { status: "passed" },
      now: () => "t1",
    });

    expect(first.decision).toMatchObject({
      type: "goto",
      fromNodeId: "plan",
      toNodeId: "implement",
    });
    expect(first.state).toMatchObject({
      status: "running",
      currentNodeId: "implement",
      attempts: { plan: 1, implement: 1 },
    });

    const second = advanceWorkflowState({
      definition,
      state: first.state,
      verdict: { status: "passed" },
      now: () => "t2",
    });

    expect(second.decision).toMatchObject({
      type: "complete",
      fromNodeId: "implement",
    });
    expect(second.state.status).toBe("completed");
    expect(second.state.transitionLog.map((entry) => entry.at)).toEqual([
      "t1",
      "t2",
    ]);
  });

  it("honors retry transitions before falling through", () => {
    const definition = workflow([
      {
        id: "verify",
        body: "Verify.",
        onFail: { retry: 1, then: "repair" },
      },
      { id: "repair", body: "Repair." },
    ]);
    const started = createInitialWorkflowRuntimeState(definition);

    const retry = advanceWorkflowState({
      definition,
      state: started,
      verdict: { status: "failed", reason: "check failed" },
    });

    expect(retry.decision).toMatchObject({
      type: "retry",
      nodeId: "verify",
      attempt: 2,
      maxRetries: 1,
    });
    expect(retry.state).toMatchObject({
      status: "running",
      currentNodeId: "verify",
      attempts: { verify: 2 },
    });

    const fallthrough = advanceWorkflowState({
      definition,
      state: retry.state,
      verdict: { status: "failed", reason: "still failing" },
    });

    expect(fallthrough.decision).toMatchObject({
      type: "goto",
      fromNodeId: "verify",
      toNodeId: "repair",
    });
  });

  it("fails on runtime errors", () => {
    const definition = workflow([{ id: "only", body: "Run." }]);
    const started = createInitialWorkflowRuntimeState(definition);

    const result = advanceWorkflowState({
      definition,
      state: started,
      verdict: { status: "runtime_error", reason: "projection exploded" },
    });

    expect(result.decision).toMatchObject({
      type: "fail",
      reason: "projection exploded",
    });
    expect(result.state).toMatchObject({
      status: "failed",
      failure: {
        nodeId: "only",
        reason: "projection exploded",
      },
    });
  });

  it("rejects human and ask_user transition targets", () => {
    const issues = validateWorkflowRuntimeDefinition(
      workflow([
        { id: "start", body: "Start.", onPass: "ask_user" },
        { id: "other", body: "Other.", onFail: { goto: "human" } },
      ]),
    );

    expect(issues).toEqual([
      expect.objectContaining({
        code: "WORKFLOW_UNSUPPORTED_TRANSITION_TARGET",
        nodeId: "start",
        target: "ask_user",
      }),
      expect.objectContaining({
        code: "WORKFLOW_UNSUPPORTED_TRANSITION_TARGET",
        nodeId: "other",
        target: "human",
      }),
    ]);
  });
});
