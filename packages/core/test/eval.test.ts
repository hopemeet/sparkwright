import { describe, expect, it } from "vitest";
import { EventLog } from "../src/events.js";
import { createRunId } from "../src/ids.js";
import { evaluateTrajectory } from "../src/eval.js";

describe("evaluateTrajectory", () => {
  it("passes a simple allowed trajectory and reports metrics", () => {
    const events = new EventLog(createRunId());

    events.emit("run.created", {});
    events.emit("run.started", {});
    events.emit("model.requested", { step: 1, attempt: 1 });
    events.emit("model.completed", {
      toolCalls: [{ toolName: "read_file", arguments: { path: "README.md" } }],
    });
    events.emit("tool.requested", {
      id: "call_1",
      toolName: "read_file",
      arguments: { path: "README.md" },
    });
    events.emit("tool.completed", {
      toolCallId: "call_1",
      status: "completed",
      artifacts: [],
    });
    events.emit("model.requested", { step: 2, attempt: 1 });
    events.emit("model.completed", { message: "done" });
    events.emit("run.completed", { reason: "final_answer", message: "done" });

    expect(
      evaluateTrajectory(events.all(), {
        allowedTools: ["read_file"],
        maxModelCalls: 2,
        maxToolCalls: 1,
      }),
    ).toEqual({
      status: "passed",
      findings: [],
      metrics: {
        modelCalls: 2,
        toolCalls: 1,
        failedToolCalls: 0,
        retryCount: 0,
        budgetCheckCount: 0,
      },
    });
  });

  it("flags unauthorized and repeated tool calls", () => {
    const events = new EventLog(createRunId());

    for (let index = 1; index <= 3; index += 1) {
      events.emit("tool.requested", {
        id: `call_${index}`,
        toolName: "delete_database",
        arguments: { table: "users" },
      });
    }

    const result = evaluateTrajectory(events.all(), {
      allowedTools: ["read_file"],
      repeatedToolCallLimit: 3,
    });

    expect(result.status).toBe("failed");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "UNAUTHORIZED_TOOL",
      "UNAUTHORIZED_TOOL",
      "UNAUTHORIZED_TOOL",
      "REPEATED_TOOL_CALL",
    ]);
  });

  it("flags call limits and budget exhaustion", () => {
    const events = new EventLog(createRunId());

    events.emit("model.requested", { step: 1, attempt: 1 });
    events.emit("model.retrying", { step: 1, attempt: 1 });
    events.emit("model.requested", { step: 1, attempt: 2 });
    events.emit("run.budget.checked", {
      stage: "model_call_reserved",
      usage: { modelCalls: 2, toolCalls: 0 },
    });
    events.emit("run.failed", {
      reason: "max_model_calls_exceeded",
      code: "MAX_MODEL_CALLS_EXCEEDED",
      message: "Too many model calls.",
    });

    const result = evaluateTrajectory(events.all(), {
      maxModelCalls: 1,
    });

    expect(result.status).toBe("failed");
    expect(result.metrics).toMatchObject({
      modelCalls: 2,
      retryCount: 1,
      budgetCheckCount: 1,
    });
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "BUDGET_EXHAUSTED",
      "MODEL_CALL_LIMIT_EXCEEDED",
    ]);
  });
});
