import { describe, expect, it } from "vitest";
import {
  classifyToolResult,
  isAgentToolResult,
} from "../src/lib/tool-result-summary.js";

describe("isAgentToolResult", () => {
  it("recognises a spawn_agent / delegate result envelope", () => {
    expect(
      isAgentToolResult({
        childRunId: "run_mpvwzgt2zxn3rubv",
        spanId: "spn_mpvwzgt2z4t9osfc",
        agentId: "dynamic_project_scanner",
        role: "project-scanner",
        signal: "completed",
        stopReason: "final_answer",
        status: "completed",
        statusSource: "child",
        summary: "Scan complete",
        blockers: [],
        finality: "complete",
        assessment: { health: "clean" },
        message: "下面是在工作空间根目录…",
        usage: { tokens: 1234 },
      }),
    ).toBe(true);
    expect(
      classifyToolResult({
        childRunId: "run_mpvwzgt2zxn3rubv",
        spanId: "span_x",
        signal: "completed",
        stopReason: "final_answer",
        status: "completed",
        statusSource: "child",
        summary: "Done",
        blockers: [],
        finality: "complete",
        assessment: { health: "clean" },
        message: "done",
      }),
    ).toBe("agent");
  });

  it("recognises a strict result whose stopReason is undefined", () => {
    expect(
      isAgentToolResult({
        childRunId: "run_x",
        spanId: "span_x",
        signal: "failed",
        stopReason: undefined,
        status: "partial",
        statusSource: "runtime",
        summary: "Child failed",
        blockers: [
          {
            code: "AGENT_RUN_INCOMPLETE",
            kind: "unknown",
            owner: "runtime",
            message: "Child failed",
            retry: "immediate",
          },
        ],
        finality: "partial",
        assessment: { health: "failing" },
      }),
    ).toBe(true);
  });

  it("returns false for non-subagent values", () => {
    expect(isAgentToolResult(undefined)).toBe(false);
    expect(isAgentToolResult(null)).toBe(false);
    expect(isAgentToolResult("just a string")).toBe(false);
    expect(isAgentToolResult(["a", "b"])).toBe(false);
    // Shell-style result, not a sub-agent envelope.
    expect(isAgentToolResult({ stdout: "ok", exitCode: 0 })).toBe(false);
    // Removed pre-agent-outcome envelope: identity/transport alone is not enough.
    expect(
      isAgentToolResult({
        childRunId: "run_x",
        signal: "completed",
        stopReason: "final_answer",
      }),
    ).toBe(false);
    // Has childRunId but no signal/stopReason → not a terminal envelope.
    expect(isAgentToolResult({ childRunId: "run_x" })).toBe(false);
  });
});
