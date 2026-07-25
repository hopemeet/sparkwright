import { createRunId } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import { normalizeAgentHandoffPayload } from "../src/agents/handoff.js";
import { projectAgentInvocationResult } from "../src/agents/result.js";
import { createSubmitAgentResultTool } from "../src/agents/submit-result.js";

describe("agent execution control handoff", () => {
  it("keeps only goal/context/label and reduces legacy role to a label", () => {
    expect(
      normalizeAgentHandoffPayload({
        goal: "Inspect the resolver",
        context: "Focus on Host.",
        role: "reviewer",
        allowedTools: ["bash"],
        grant: { workspaceWrite: true },
        maxSteps: 999,
        metadata: { authority: "ignored" },
      }),
    ).toEqual({
      goal: "Inspect the resolver",
      context: "Focus on Host.",
      label: "reviewer",
    });
  });

  it("accepts the minimal terminal envelope and validates optional detail", async () => {
    const tool = createSubmitAgentResultTool();
    expect(
      await tool.validateInput?.(
        { status: "completed", summary: "Done" },
        {} as never,
      ),
    ).toEqual({ ok: true });
    expect(
      await tool.validateInput?.(
        {
          status: "blocked",
          summary: "Cannot continue",
        },
        {} as never,
      ),
    ).toEqual({ ok: true });
    expect(
      await tool.validateInput?.(
        {
          status: "completed",
          summary: "Done",
          blockers: [
            {
              code: "CONTRADICTION",
              kind: "unknown",
              owner: "runtime",
              message: "Completed cannot carry a blocker.",
              retry: "none",
            },
          ],
        },
        {} as never,
      ),
    ).toMatchObject({ ok: false, code: "AGENT_RESULT_PROTOCOL_INVALID" });
    expect(tool.terminal).toMatchObject({ kind: "agent_result" });
  });

  it("projects a terminal tool declaration before the legacy text marker", () => {
    const result = projectAgentInvocationResult({
      childRunId: "child",
      spanId: "span",
      usage: {
        runId: createRunId(),
        updatedAt: "2026-07-24T00:00:00.000Z",
        wallTimeMs: 1,
        tokens: { input: 1, cached: 0, output: 1, total: 2 },
        contextTokens: 1,
        costUsd: 0,
        toolCalls: 1,
        modelCalls: 1,
        byTool: {},
        byModel: {},
      },
      result: {
        signal: "completed",
        state: "completed",
        stopReason: "final_answer",
        message: "Bound child answer",
        metadata: {
          terminalResult: {
            kind: "agent_result",
            toolName: "submit_agent_result",
            output: {
              schemaVersion: "agent-outcome.v1",
              status: "completed",
              summary: "Structured completion",
              accomplishments: ["Verified the resolver"],
              blockers: [],
            },
          },
        },
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
      statusSource: "child",
      summary: "Structured completion",
      accomplishments: ["Verified the resolver"],
      message: "Bound child answer",
      finality: "complete",
    });
  });
});
