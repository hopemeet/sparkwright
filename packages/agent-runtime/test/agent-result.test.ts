import { createRunId } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import {
  isCompleteAgentResult,
  isReusableAgentResult,
  projectAgentInvocationResult,
} from "../src/agents/result.js";

const usage = {
  runId: createRunId(),
  updatedAt: "2026-07-19T00:00:00.000Z",
  wallTimeMs: 1,
  tokens: { input: 1, cached: 0, output: 2, total: 3 },
  contextTokens: 1,
  costUsd: 0,
  toolCalls: 1,
  modelCalls: 1,
  byTool: {},
  byModel: {},
} as const;

describe("projectAgentInvocationResult", () => {
  it("keeps complete finality orthogonal to failing health and preserves message", () => {
    const result = projectAgentInvocationResult({
      childRunId: "child",
      spanId: "span",
      usage,
      result: {
        signal: "completed",
        state: "completed",
        stopReason: "final_answer",
        message: "useful partial analysis",
        metadata: {},
        assessment: {
          schemaVersion: "run-assessment.v1",
          health: "failing",
          issues: [
            {
              code: "UNRESOLVED_TOOL_FAILURE",
              kind: "tool_failure",
              disposition: "failing",
              count: 1,
            },
          ],
          verification: [],
        },
      },
    });

    expect(result).toMatchObject({
      signal: "completed",
      finality: "complete",
      message: "useful partial analysis",
      assessment: { health: "failing" },
      note: expect.stringContaining("UNRESOLVED_TOOL_FAILURE"),
    });
  });

  it("marks truncated completion partial", () => {
    const result = projectAgentInvocationResult({
      childRunId: "child",
      spanId: "span",
      usage,
      result: {
        signal: "completed",
        state: "completed",
        metadata: { truncated: true },
        assessment: {
          schemaVersion: "run-assessment.v1",
          health: "clean",
          issues: [],
          verification: [],
        },
      },
    });
    expect(result).toMatchObject({ finality: "partial", truncated: true });
    expect(isCompleteAgentResult(result)).toBe(false);
    expect(isReusableAgentResult(result)).toBe(false);
  });

  it("reuses only complete and clean results", () => {
    const result = projectAgentInvocationResult({
      childRunId: "child",
      spanId: "span",
      usage,
      result: {
        signal: "completed",
        state: "completed",
        metadata: {},
        assessment: {
          schemaVersion: "run-assessment.v1",
          health: "clean",
          issues: [],
          verification: [],
        },
      },
    });
    expect(isCompleteAgentResult(result)).toBe(true);
    expect(isReusableAgentResult(result)).toBe(true);
  });
});
