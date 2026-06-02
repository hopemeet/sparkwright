import { describe, expect, it } from "vitest";
import { isAgentToolResult } from "../src/components/event-stream.js";

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
        message: "下面是在工作空间根目录…",
        usage: { tokens: 1234 },
      }),
    ).toBe(true);
  });

  it("recognises an envelope whose stopReason is undefined", () => {
    // The field is present (the run terminated) even when its value is null/
    // undefined, so the `in` check — not a truthiness check — is what matters.
    expect(
      isAgentToolResult({
        childRunId: "run_x",
        signal: "failed",
        stopReason: undefined,
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
    // Has childRunId but no signal/stopReason → not a terminal envelope.
    expect(isAgentToolResult({ childRunId: "run_x" })).toBe(false);
  });
});
