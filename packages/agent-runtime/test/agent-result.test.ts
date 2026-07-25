import { createRunId } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import {
  AGENT_RESULT_MARKER,
  isAgentToolResult,
  isCompleteAgentResult,
  isReusableAgentResult,
  parseAgentResultDeclaration,
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

function outcome(value: Record<string, unknown>): string {
  return `${AGENT_RESULT_MARKER} ${JSON.stringify({
    schemaVersion: "agent-outcome.v1",
    accomplishments: [],
    blockers: [],
    ...value,
  })}`;
}

describe("projectAgentInvocationResult", () => {
  it("rejects structurally invalid projected outcomes", () => {
    const base = {
      childRunId: "child",
      spanId: "span",
      signal: "completed",
      stopReason: "final_answer",
      tokens: 3,
      costUsd: 0,
      toolCalls: 1,
      modelCalls: 1,
      status: "completed",
      statusSource: "child",
      summary: "Complete",
      blockers: [],
      finality: "complete",
      assessment: {
        schemaVersion: "run-assessment.v1",
        health: "clean",
        issues: [],
        verification: [],
      },
    };

    expect(isAgentToolResult(base)).toBe(true);
    expect(
      isAgentToolResult({
        ...base,
        status: "blocked",
        blockers: [{ code: "MISSING_FIELDS" }],
      }),
    ).toBe(false);
    expect(
      isAgentToolResult({
        ...base,
        blockers: [
          {
            code: "IMPOSSIBLE_COMPLETION",
            kind: "unknown",
            owner: "runtime",
            message: "Completed results cannot carry blockers.",
            retry: "none",
          },
        ],
      }),
    ).toBe(false);
  });

  it("keeps complete finality orthogonal to failing health and preserves message", () => {
    const result = projectAgentInvocationResult({
      childRunId: "child",
      spanId: "span",
      usage,
      result: {
        signal: "completed",
        state: "completed",
        stopReason: "final_answer",
        message: `useful partial analysis\n${outcome({
          status: "completed",
          summary: "Analysis complete",
        })}`,
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
      status: "completed",
      statusSource: "child",
      summary: "Analysis complete",
      blockers: [],
      finality: "complete",
      message: "useful partial analysis",
      assessment: { health: "failing" },
      note: expect.stringContaining("UNRESOLVED_TOOL_FAILURE"),
    });
  });

  it("projects a declared blocked outcome without treating transport as failure", () => {
    const result = projectAgentInvocationResult({
      childRunId: "child",
      spanId: "span",
      usage,
      result: {
        signal: "completed",
        state: "completed",
        stopReason: "final_answer",
        message: `I prepared the file but cannot execute it.\n${outcome({
          status: "blocked",
          summary: "Needs execution",
          accomplishments: ["Prepared the file"],
          blockers: [
            {
              code: "SHELL_REQUIRED",
              kind: "capability",
              owner: "parent",
              message: "Execution requires the bash tool.",
              requirements: [{ kind: "tool", name: "bash" }],
              retry: "after_capability_change",
            },
          ],
        })}`,
        metadata: {},
        assessment: {
          schemaVersion: "run-assessment.v1",
          health: "clean",
          issues: [],
          verification: [],
        },
      },
    });

    expect(result).toMatchObject({
      signal: "completed",
      status: "blocked",
      statusSource: "child",
      summary: "Needs execution",
      accomplishments: ["Prepared the file"],
      finality: "partial",
      message: "I prepared the file but cannot execute it.",
      blockers: [
        {
          code: "SHELL_REQUIRED",
          kind: "capability",
          owner: "parent",
          requirements: [{ kind: "tool", name: "bash" }],
        },
      ],
    });
    expect(isCompleteAgentResult(result)).toBe(false);
    expect(isReusableAgentResult(result)).toBe(false);
  });

  it("treats malformed declarations as protocol blockers", () => {
    const message = `Useful work\n${AGENT_RESULT_MARKER} {"status":"unknown"}`;
    expect(parseAgentResultDeclaration(message)).toBeUndefined();
    const result = projectAgentInvocationResult({
      childRunId: "child",
      spanId: "span",
      usage,
      result: {
        signal: "completed",
        state: "completed",
        message,
        metadata: {},
        assessment: {
          schemaVersion: "run-assessment.v1",
          health: "clean",
          issues: [],
          verification: [],
        },
      },
    });
    expect(result).toMatchObject({
      status: "partial",
      statusSource: "runtime",
      summary: "Child returned an invalid agent-outcome.v1 declaration.",
      finality: "partial",
      message: "Useful work",
      blockers: [{ code: "AGENT_RESULT_PROTOCOL_INVALID", kind: "protocol" }],
    });
    expect(isCompleteAgentResult(result)).toBe(false);
  });

  it("rejects the removed legacy missingCapabilities contract", () => {
    const legacy =
      `${AGENT_RESULT_MARKER} ` +
      '{"status":"blocked","summary":"Needs shell","missingCapabilities":["shell"]}';
    expect(parseAgentResultDeclaration(legacy)).toBeUndefined();
  });

  it("accepts a clean natural-language final as an implicit completed result", () => {
    const result = projectAgentInvocationResult({
      childRunId: "child",
      spanId: "span",
      usage,
      result: {
        signal: "completed",
        state: "completed",
        message: "Plain final answer",
        metadata: {},
        assessment: {
          schemaVersion: "run-assessment.v1",
          health: "clean",
          issues: [],
          verification: [],
        },
      },
    });
    expect(result).toMatchObject({
      status: "completed",
      statusSource: "runtime",
      summary: "Plain final answer",
      finality: "complete",
      blockers: [],
    });
    expect(isCompleteAgentResult(result)).toBe(true);
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
    expect(result).toMatchObject({
      status: "partial",
      statusSource: "runtime",
      finality: "partial",
      blockers: [{ code: "AGENT_RESULT_TRUNCATED" }],
      truncated: true,
    });
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
        message: outcome({
          status: "completed",
          summary: "Inspection complete",
        }),
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
