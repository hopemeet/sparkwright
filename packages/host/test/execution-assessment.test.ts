import type { RunAssessment } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import { aggregateExecutionAssessment } from "../src/execution-assessment.js";

describe("aggregateExecutionAssessment", () => {
  it("lets later verification of the same identity supersede an earlier failure", () => {
    const assessment = aggregateExecutionAssessment({
      episodes: [
        {
          runId: "run_1",
          assessment: runAssessment({
            health: "failing",
            issues: [verificationIssue()],
            verification: [
              {
                id: "verify_1",
                source: "command",
                status: "failed",
                command: "npm   test",
                exitCode: 1,
              },
            ],
          }),
        },
        {
          runId: "run_2",
          assessment: runAssessment({
            verification: [
              {
                id: "verify_2",
                source: "command",
                status: "passed",
                command: "npm test",
                exitCode: 0,
              },
            ],
          }),
        },
      ],
    });

    expect(assessment).toMatchObject({
      health: "clean",
      episodeCount: 2,
      rootRunId: "run_1",
      finalRunId: "run_2",
      issues: [],
      verification: [expect.objectContaining({ status: "passed" })],
    });
  });

  it("omits only superseded resumable episode failures", () => {
    const assessment = aggregateExecutionAssessment({
      episodes: [
        {
          runId: "run_budget",
          assessment: runAssessment({
            health: "failing",
            issues: [
              {
                code: "MAX_STEPS_EXCEEDED",
                kind: "run_failure",
                disposition: "failing",
                count: 1,
                details: { reason: "max_steps_exceeded" },
              },
            ],
          }),
        },
        { runId: "run_final", assessment: runAssessment() },
      ],
    });

    expect(assessment.health).toBe("clean");
    expect(assessment.issues).toEqual([]);
  });

  it("preserves host failures even when every episode is clean", () => {
    const assessment = aggregateExecutionAssessment({
      episodes: [{ runId: "run_1", assessment: runAssessment() }],
      hostIssues: [
        {
          code: "WORKFLOW_EXECUTION_FAILED",
          kind: "workflow_failure",
          disposition: "failing",
          count: 1,
        },
      ],
    });

    expect(assessment).toMatchObject({
      health: "failing",
      issues: [expect.objectContaining({ code: "WORKFLOW_EXECUTION_FAILED" })],
    });
  });
});

function runAssessment(
  overrides: Partial<Omit<RunAssessment, "schemaVersion">> = {},
): RunAssessment {
  return {
    schemaVersion: "run-assessment.v1",
    health: "clean",
    issues: [],
    verification: [],
    ...overrides,
  };
}

function verificationIssue(): RunAssessment["issues"][number] {
  return {
    code: "VERIFICATION_FAILED",
    kind: "verification_failure",
    disposition: "failing",
    count: 1,
  };
}
