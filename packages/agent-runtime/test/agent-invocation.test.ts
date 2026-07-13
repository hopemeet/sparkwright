import { describe, expect, it } from "vitest";
import {
  agentInvocationEventBase,
  agentInvocationEntrypointFromArgs,
  agentInvocationMetadata,
  markAgentInvocationEntrypoint,
  prepareAgentInvocation,
} from "../src/agents/invocation.js";

describe("PreparedAgentInvocation", () => {
  it("prepares one pure-data identity for lifecycle payload and metadata", () => {
    const governance = {
      workspaceAccess: "read_write" as const,
      concurrency: "serial" as const,
      approval: "required" as const,
    };
    const invocation = prepareAgentInvocation({
      goal: "Review the change",
      protocol: "external_command",
      sessionId: "session_1",
      parentRunId: "run_parent",
      childRunId: "run_child",
      spanId: "span_child",
      taskId: "task_1",
      agentId: "main",
      childAgentId: "reviewer",
      agentProfileId: "reviewer",
      agentName: "Reviewer",
      delegateTool: "delegate_reviewer",
      subagentDepth: 2,
      entrypoint: "delegates_run",
      governance,
    });

    expect(invocation).toEqual({
      schemaVersion: "prepared-agent-invocation.v1",
      admissionState: "admission_pending",
      goal: "Review the change",
      protocol: "external_command",
      sessionId: "session_1",
      parentRunId: "run_parent",
      childRunId: "run_child",
      spanId: "span_child",
      taskId: "task_1",
      agentId: "main",
      childAgentId: "reviewer",
      agentProfileId: "reviewer",
      agentName: "Reviewer",
      delegateTool: "delegate_reviewer",
      subagentDepth: 2,
      entrypoint: "delegates_run",
      governance,
    });
    expect(invocation.governance).not.toBe(governance);
    expect(agentInvocationEventBase(invocation)).toEqual({
      childRunId: "run_child",
      parentRunId: "run_parent",
      spanId: "span_child",
      goal: "Review the change",
      taskId: "task_1",
    });
    expect(agentInvocationMetadata(invocation)).toEqual({
      sessionId: "session_1",
      agentId: "main",
      taskId: "task_1",
      childAgentId: "reviewer",
      agentProfileId: "reviewer",
      agentName: "Reviewer",
      delegateTool: "delegate_reviewer",
      subagentDepth: 2,
      entrypoint: "delegates_run",
      protocol: "external_command",
      workspaceAccess: "read_write",
      agentConcurrency: "serial",
      agentApproval: "required",
      childRunId: "run_child",
      parentRunId: "run_parent",
    });
  });

  it("omits unknown optional facts from lifecycle projections", () => {
    const invocation = prepareAgentInvocation({
      goal: "Inspect",
      protocol: "in_process",
      parentRunId: "run_parent",
      childRunId: "run_child",
      spanId: "span_child",
      subagentDepth: 1,
      entrypoint: "spawn_agent",
    });

    expect(agentInvocationMetadata(invocation)).toEqual({
      subagentDepth: 1,
      entrypoint: "spawn_agent",
      protocol: "in_process",
      childRunId: "run_child",
      parentRunId: "run_parent",
    });
  });

  it("carries internal indexed-entrypoint attribution outside model JSON", () => {
    const args = markAgentInvocationEntrypoint(
      { goal: "Inspect", entrypoint: "spoofed" },
      "delegate_agent",
    );
    expect(agentInvocationEntrypointFromArgs(args)).toBe("delegate_agent");
    expect(JSON.parse(JSON.stringify(args))).toEqual({
      goal: "Inspect",
      entrypoint: "spoofed",
    });
    expect(
      agentInvocationEntrypointFromArgs(
        { goal: "Inspect", entrypoint: "delegate_agent" },
        "delegate",
      ),
    ).toBe("delegate");
  });

  it.each([
    { field: "goal", override: { goal: " " } },
    { field: "parentRunId", override: { parentRunId: "" } },
    { field: "childRunId", override: { childRunId: "" } },
    { field: "spanId", override: { spanId: "" } },
  ])("rejects an empty $field", ({ override }) => {
    expect(() =>
      prepareAgentInvocation({
        goal: "Inspect",
        protocol: "in_process",
        parentRunId: "run_parent",
        childRunId: "run_child",
        spanId: "span_child",
        subagentDepth: 1,
        entrypoint: "run",
        ...override,
      }),
    ).toThrow("must be non-empty");
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid subagent depth %s",
    (subagentDepth) => {
      expect(() =>
        prepareAgentInvocation({
          goal: "Inspect",
          protocol: "in_process",
          parentRunId: "run_parent",
          childRunId: "run_child",
          spanId: "span_child",
          subagentDepth,
          entrypoint: "run",
        }),
      ).toThrow("positive integer");
    },
  );
});
