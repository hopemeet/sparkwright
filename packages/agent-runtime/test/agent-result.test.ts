import { createRunId } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import {
  agentWorkspaceEvidence,
  isCompleteAgentResult,
  isReusableAgentResult,
  projectAgentInvocationResult,
  projectParentAgentResult,
} from "../src/agents/result.js";
import type { AgentRuntimeResult } from "../src/agents/types.js";

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
  it("projects one compact parent report with runtime workspace evidence", () => {
    const base = {
      childRunId: "child",
      spanId: "span",
      signal: "completed" as const,
      stopReason: "final_answer" as const,
      tokens: 3,
      costUsd: 0,
      toolCalls: 1,
      modelCalls: 1,
      status: "completed",
      summary: "Complete",
      blockers: [],
      assessment: {
        schemaVersion: "run-assessment.v1",
        health: "clean",
        issues: [],
        verification: [],
      },
    } satisfies AgentRuntimeResult;

    expect(
      projectParentAgentResult({
        result: base,
        workspace: { writes: 0 },
      }),
    ).toEqual({
      childRunId: "child",
      status: "completed",
      report: "Complete",
      workspace: { writes: 0 },
    });
    expect(
      agentWorkspaceEvidence([
        {
          type: "workspace.write.completed",
          payload: { path: "src/a.ts" },
        },
        {
          type: "workspace.write.completed",
          payload: { path: "src/a.ts" },
        },
      ]),
    ).toEqual({ writes: 2, paths: ["src/a.ts"] });
  });

  it("keeps completed outcome orthogonal to failing health and gives the parent an actionable warning", () => {
    const result = projectAgentInvocationResult({
      childRunId: "child",
      spanId: "span",
      usage,
      result: {
        signal: "completed",
        state: "completed",
        stopReason: "final_answer",
        message: "Analysis complete",
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
              details: {
                codes: ["WORKSPACE_CREATE_CONFLICT"],
                toolNames: ["create"],
              },
            },
          ],
          verification: [],
        },
      },
    });

    expect(result).toMatchObject({
      signal: "completed",
      status: "completed",
      summary: "Analysis complete",
      blockers: [],
      message: "Analysis complete",
      assessment: { health: "failing" },
    });
    expect(
      projectParentAgentResult({
        result,
        workspace: { writes: 0 },
        actions: [
          {
            toolCallId: "call_create",
            toolName: "create",
            preview: "print_numbers.py",
            status: "failed",
            errorCode: "WORKSPACE_CREATE_CONFLICT",
            errorMessage:
              "Workspace create target already exists: print_numbers.py",
          },
        ],
      }),
    ).toEqual({
      childRunId: "child",
      status: "completed",
      report: "Analysis complete",
      workspace: { writes: 0 },
      warnings: [
        "The child completed with unresolved tool work: create print_numbers.py failed because the target already exists (WORKSPACE_CREATE_CONFLICT). No structured workspace write succeeded, so creation or modification is not proven.",
      ],
    });
  });

  it("marks a completed child without a natural report as partial and non-reusable", () => {
    const result = projectAgentInvocationResult({
      childRunId: "child",
      spanId: "span",
      usage,
      result: {
        signal: "completed",
        state: "completed",
        stopReason: "final_answer",
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
      status: "partial",
      summary: "Child run completed without a report.",
      blockers: [{ code: "AGENT_REPORT_MISSING" }],
    });
    expect(isCompleteAgentResult(result)).toBe(false);
    expect(isReusableAgentResult(result)).toBe(false);
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
      summary: "Plain final answer",
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
        message: "Inspection complete",
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
