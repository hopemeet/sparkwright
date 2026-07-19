import {
  analyzeToolOutcomes,
  assessRun,
  createRunId,
  projectFactLedgerSnapshot,
} from "../src/index.js";
import { EventLog } from "../src/internal.js";
import { describe, expect, it } from "vitest";

describe("RunAssessment", () => {
  it("always represents a clean terminal run", () => {
    const log = new EventLog(createRunId());
    const events = [log.emit("run.created", { goal: "Answer honestly" })];

    expect(assessRun(events, { terminal: { state: "completed" } })).toEqual({
      schemaVersion: "run-assessment.v1",
      health: "clean",
      issues: [],
      verification: [],
    });
  });

  it("classifies a same-target recovery as degraded", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("tool.requested", {
        id: "read_bad",
        toolName: "read",
        arguments: { path: "README.md" },
      }),
      log.emit("tool.failed", {
        toolCallId: "read_bad",
        toolName: "read",
        error: { code: "EBUSY", message: "busy" },
      }),
      log.emit("tool.requested", {
        id: "read_ok",
        toolName: "read",
        arguments: { path: "README.md" },
      }),
      log.emit("tool.completed", {
        toolCallId: "read_ok",
        toolName: "read",
        output: { content: "ok" },
      }),
    ];

    expect(analyzeToolOutcomes(events).recoveredFailures).toHaveLength(1);
    expect(assessRun(events)).toMatchObject({
      health: "degraded",
      issues: [
        {
          code: "RECOVERED_TOOL_FAILURE",
          disposition: "degraded",
          count: 1,
        },
      ],
    });
  });

  it("classifies an unresolved tool failure as failing", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("tool.requested", {
        id: "missing",
        toolName: "missing",
        arguments: {},
      }),
      log.emit("tool.failed", {
        toolCallId: "missing",
        toolName: "missing",
        error: { code: "TOOL_NOT_FOUND", message: "missing" },
      }),
    ];

    expect(assessRun(events)).toMatchObject({
      health: "failing",
      issues: [
        {
          code: "UNRESOLVED_TOOL_FAILURE",
          details: { codes: ["TOOL_NOT_FOUND"] },
        },
      ],
    });
  });

  it("records an expected policy denial as degraded", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("tool.requested", {
        id: "denied",
        toolName: "write",
        arguments: { path: "x" },
      }),
      log.emit("tool.failed", {
        toolCallId: "denied",
        toolName: "write",
        error: { code: "POLICY_DENIED", message: "denied" },
      }),
    ];

    expect(assessRun(events)).toMatchObject({
      health: "degraded",
      issues: [{ code: "EXPECTED_DENIAL", disposition: "degraded" }],
    });
  });

  it("tracks failed verification, write staleness, and later recovery", () => {
    const log = new EventLog(createRunId());
    const failed = [
      log.emit("run.created", { goal: "Fix then run npm test" }),
      log.emit("tool.requested", {
        id: "test_fail",
        toolName: "bash",
        arguments: { command: "npm test" },
      }),
      log.emit("tool.completed", {
        toolCallId: "test_fail",
        toolName: "bash",
        output: { exitCode: 1, timedOut: false },
      }),
    ];
    expect(assessRun(failed)).toMatchObject({
      health: "failing",
      issues: [{ code: "VERIFICATION_FAILED" }],
      verification: [{ status: "failed", command: "npm test" }],
    });

    const recovered = [
      ...failed,
      log.emit("workspace.write.completed", { path: "src/fix.ts" }),
      log.emit("tool.requested", {
        id: "test_pass",
        toolName: "bash",
        arguments: { command: "npm test" },
      }),
      log.emit("tool.completed", {
        toolCallId: "test_pass",
        toolName: "bash",
        output: { exitCode: 0, timedOut: false },
      }),
    ];
    const assessment = assessRun(recovered, {
      factLedger: projectFactLedgerSnapshot(recovered),
    });
    expect(assessment.health).toBe("clean");
    expect(assessment.verification.map((result) => result.status)).toEqual([
      "stale",
      "passed",
    ]);
  });

  it("records verifier timeout and workflow failure without prose analysis", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("workflow_hook.completed", {
        hookName: "verify",
        hook: "Stop",
        result: {
          status: "continue",
          metadata: {
            verificationSource: "profile",
            verifierId: "unit",
            command: "npm",
            args: ["test"],
            expect: "zero",
            exitCode: null,
            timedOut: true,
          },
        },
      }),
      log.emit("workflow.failed", {
        reason: "node failed",
        code: "WORKFLOW_NODE_FAILED",
      }),
    ];

    const assessment = assessRun(events);
    expect(assessment.health).toBe("failing");
    expect(assessment.verification).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ verifierId: "unit", status: "timed_out" }),
      ]),
    );
    expect(assessment.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["VERIFICATION_FAILED", "WORKFLOW_FAILED"]),
    );
  });

  it("adds objective terminal failure and cancellation issues", () => {
    const log = new EventLog(createRunId());
    const events = [log.emit("run.created", { goal: "run" })];

    expect(
      assessRun(events, {
        terminal: {
          state: "failed",
          reason: "model_output_invalid",
          failure: { code: "MODEL_OUTPUT_INVALID" },
        },
      }),
    ).toMatchObject({
      health: "failing",
      issues: [{ code: "MODEL_OUTPUT_INVALID", kind: "run_failure" }],
    });
    expect(
      assessRun(events, {
        terminal: { state: "cancelled", reason: "manual_cancelled" },
      }),
    ).toMatchObject({
      health: "failing",
      issues: [{ code: "RUN_CANCELLED", kind: "run_cancelled" }],
    });
  });
});
