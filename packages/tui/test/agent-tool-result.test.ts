import { describe, expect, it } from "vitest";
import {
  classifyToolResult,
  isParentAgentResult,
} from "../src/lib/tool-result-summary.js";

describe("isParentAgentResult", () => {
  it("recognises a compact spawn/delegate report", () => {
    expect(
      isParentAgentResult({
        childRunId: "run_mpvwzgt2zxn3rubv",
        status: "completed",
        report: "下面是在工作空间根目录…",
        workspace: { writes: 0 },
      }),
    ).toBe(true);
    expect(
      classifyToolResult({
        childRunId: "run_mpvwzgt2zxn3rubv",
        status: "completed",
        report: "done",
        workspace: { writes: 1, paths: ["result.txt"] },
      }),
    ).toBe("agent");
  });

  it("recognises a partial compact report", () => {
    expect(
      isParentAgentResult({
        childRunId: "run_x",
        status: "partial",
        report: "Child failed",
        workspace: { writes: 0 },
        blockers: [
          {
            code: "AGENT_RUN_INCOMPLETE",
            message: "Child failed",
          },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for non-subagent values", () => {
    expect(isParentAgentResult(undefined)).toBe(false);
    expect(isParentAgentResult(null)).toBe(false);
    expect(isParentAgentResult("just a string")).toBe(false);
    expect(isParentAgentResult(["a", "b"])).toBe(false);
    // Shell-style result, not a sub-agent envelope.
    expect(isParentAgentResult({ stdout: "ok", exitCode: 0 })).toBe(false);
    // Identity without the compact report/evidence contract is not enough.
    expect(
      isParentAgentResult({
        childRunId: "run_x",
        status: "completed",
      }),
    ).toBe(false);
    expect(isParentAgentResult({ childRunId: "run_x" })).toBe(false);
  });
});
