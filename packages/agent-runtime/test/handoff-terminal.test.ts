import { createRunId } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import {
  normalizeAgentHandoffPayload,
  parseAgentHandoffPayload,
} from "../src/agents/handoff.js";
import { projectAgentInvocationResult } from "../src/agents/result.js";

describe("agent execution control handoff", () => {
  it("extracts goal/context/label without restoring legacy authority", () => {
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

  it("rejects noncanonical fields at the live model boundary", () => {
    expect(() =>
      parseAgentHandoffPayload({
        goal: "Inspect the workspace.",
        role: "reviewer",
        allowedTools: ["bash"],
      }),
    ).toThrow(/accepts only goal, context, and label/);
  });

  it("uses the natural report and ignores retired terminal declarations", () => {
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
        toolCalls: 0,
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
            output: { status: "blocked", summary: "Retired declaration" },
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
      summary: "Bound child answer",
      blockers: [],
      message: "Bound child answer",
    });
  });
});
