import { describe, expect, it } from "vitest";
import type { RunEvent } from "../src/lib/event-type.js";
import {
  buildDetailedTranscript,
  collectAgentToolCallIds,
  collectChildRunIds,
  shouldShowInCompactTranscript,
} from "../src/lib/transcript-presentation.js";

function event(
  type: string,
  sequence: number,
  payload?: unknown,
  options: Partial<RunEvent> = {},
): RunEvent {
  return {
    id: `event_${sequence}`,
    runId: "run_parent",
    timestamp: `2026-07-25T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    sequence,
    payload,
    ...options,
  };
}

describe("transcript presentation", () => {
  it("rebuilds Agent details at the lifecycle position from structured ids", () => {
    const events = [
      event("tui.user", -1, { goal: "创建并验证脚本" }),
      event(
        "subagent.requested",
        1,
        {
          goal: "创建 print_numbers.py，并验证运行结果",
          childRunId: "run_child",
          parentRunId: "run_parent",
        },
        {
          metadata: {
            agentName: "创建并验证定时打印脚本",
            childRunId: "run_child",
            parentRunId: "run_parent",
            subagentDepth: 1,
          },
        },
      ),
      event(
        "subagent.started",
        2,
        { childRunId: "run_child", parentRunId: "run_parent" },
        {
          metadata: {
            agentName: "创建并验证定时打印脚本",
            childRunId: "run_child",
            parentRunId: "run_parent",
            subagentDepth: 1,
          },
        },
      ),
      event(
        "tool.requested",
        3,
        {
          id: "call_bash",
          toolName: "bash",
          arguments: { command: "python3 print_numbers.py" },
        },
        { runId: "run_child" },
      ),
      event(
        "tool.completed",
        4,
        {
          toolCallId: "call_bash",
          toolName: "bash",
          output: {
            stdout: "1\n2\n3\n",
            stderr: "",
            exitCode: 0,
            timedOut: false,
          },
        },
        { runId: "run_child" },
      ),
      event(
        "subagent.completed",
        5,
        {
          childRunId: "run_child",
          parentRunId: "run_parent",
          status: "completed",
          summary: "脚本已创建并通过运行验证。",
          toolCalls: 1,
          blockers: [],
        },
        {
          metadata: {
            agentName: "创建并验证定时打印脚本",
            childRunId: "run_child",
            parentRunId: "run_parent",
            subagentDepth: 1,
          },
        },
      ),
    ];

    const projection = buildDetailedTranscript(events);
    const text = projection.lines.map((line) => line.text).join("\n");

    expect(text).toContain(
      "└─ Agent · 创建并验证定时打印脚本 completed · 3.0s · 1 action",
    );
    expect(text).toContain("task");
    expect(text).toContain("创建 print_numbers.py，并验证运行结果");
    expect(text).toContain("actions");
    expect(text).toContain("bash $ python3 print_numbers.py ✓");
    expect(text).toContain("result");
    expect(text).toContain("脚本已创建并通过运行验证。");
    expect(
      projection.blocks.filter((block) => block.kind === "agent"),
    ).toHaveLength(1);
    expect(
      projection.blocks.filter((block) => block.kind === "tool"),
    ).toHaveLength(0);
  });

  it("keeps ordinary tool parameters, exit output, and completed todos in detail", () => {
    const events = [
      event("tui.user", -1, { goal: "run checks" }),
      event("tool.requested", 1, {
        id: "call_bash",
        toolName: "bash",
        arguments: { command: "npm test" },
      }),
      event("tool.completed", 2, {
        toolCallId: "call_bash",
        toolName: "bash",
        output: {
          stdout: "42 tests passed\n",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      }),
    ];
    const projection = buildDetailedTranscript(events, [
      { title: "Implement", status: "completed", depth: 0 },
      { title: "Review output", status: "in_progress", depth: 0 },
    ]);
    const text = projection.lines.map((line) => line.text).join("\n");

    expect(text).toContain("tool bash completed");
    expect(text).toContain("command");
    expect(text).toContain("npm test");
    expect(text).toContain("shell exit 0");
    expect(text).toContain("42 tests passed");
    expect(text).toContain("✓ Implement");
    expect(text).toContain("○ Review output");
  });

  it("renders live Agent actions and write evidence from the terminal receipt", () => {
    const projection = buildDetailedTranscript([
      event("tui.user", -1, { goal: "verify the existing script" }),
      event(
        "subagent.requested",
        1,
        {
          childRunId: "run_child",
          parentRunId: "run_parent",
          goal: "Inspect and verify print_numbers.py",
        },
        {
          metadata: {
            childRunId: "run_child",
            parentRunId: "run_parent",
            agentName: "script-verifier",
            subagentDepth: 1,
          },
        },
      ),
      event(
        "subagent.completed",
        2,
        {
          childRunId: "run_child",
          parentRunId: "run_parent",
          status: "completed",
          summary: "The existing script passed verification.",
          blockers: [],
          workspaceWrites: 0,
          actions: [
            {
              toolCallId: "call_read",
              toolName: "read",
              preview: "print_numbers.py:1 +200",
              status: "completed",
            },
            {
              toolCallId: "call_bash",
              toolName: "bash",
              preview: "$ python3 print_numbers.py",
              status: "completed",
              exitCode: 0,
            },
          ],
        },
        {
          metadata: {
            childRunId: "run_child",
            parentRunId: "run_parent",
            agentName: "script-verifier",
            subagentDepth: 1,
          },
        },
      ),
    ]);
    const text = projection.lines.map((line) => line.text).join("\n");

    expect(text).toContain(
      "Agent · script-verifier completed · 1.0s · 2 actions",
    );
    expect(text).toContain("read print_numbers.py:1 +200 ✓");
    expect(text).toContain("bash $ python3 print_numbers.py exit 0 ✓");
    expect(text).toContain("0 structured workspace writes");
    expect(text).toContain(
      "creation or modification is not proven by structured evidence",
    );
  });

  it("renders non-zero shell exits as failed actions without changing tool transport status", () => {
    const terminalReceipt = buildDetailedTranscript([
      event("subagent.completed", 1, {
        childRunId: "run_receipt_child",
        parentRunId: "run_parent",
        status: "completed",
        summary: "The child recovered after a failed command.",
        actions: [
          {
            toolCallId: "call_bash",
            toolName: "bash",
            preview: "$ python3 broken_check.py",
            status: "completed",
            exitCode: 1,
          },
        ],
      }),
    ]);
    expect(terminalReceipt.lines.map((line) => line.text).join("\n")).toContain(
      "bash $ python3 broken_check.py exit 1 ✗",
    );

    const replayedChildTrace = buildDetailedTranscript([
      event(
        "subagent.started",
        1,
        {
          childRunId: "run_trace_child",
          parentRunId: "run_parent",
          goal: "Run a diagnostic command",
        },
        { metadata: { agentName: "diagnostic child" } },
      ),
      event(
        "tool.requested",
        2,
        {
          id: "call_bash",
          toolName: "bash",
          arguments: { command: "python3 broken_check.py" },
        },
        { runId: "run_trace_child" },
      ),
      event(
        "tool.completed",
        3,
        {
          toolCallId: "call_bash",
          toolName: "bash",
          output: {
            stdout: "",
            stderr: "syntax error",
            exitCode: 1,
            timedOut: false,
          },
        },
        { runId: "run_trace_child" },
      ),
      event(
        "subagent.completed",
        4,
        {
          childRunId: "run_trace_child",
          parentRunId: "run_parent",
          status: "completed",
          summary: "The child recovered after a failed command.",
        },
        { metadata: { agentName: "diagnostic child" } },
      ),
    ]);
    expect(
      replayedChildTrace.lines.map((line) => line.text).join("\n"),
    ).toContain("bash $ python3 broken_check.py exit 1 ✗");
  });

  it("renders a skipped Agent action without a success checkmark", () => {
    const projection = buildDetailedTranscript([
      event("subagent.completed", 1, {
        childRunId: "run_child",
        parentRunId: "run_parent",
        status: "completed",
        summary: "Verification complete.",
        actions: [
          {
            toolCallId: "call_bash",
            toolName: "bash",
            preview: "$ python3 -m py_compile print_numbers.py",
            status: "skipped",
            skipReason: "repeated_idempotent_noop",
          },
        ],
      }),
    ]);
    const action = projection.lines.find((line) =>
      line.text.includes("repeated_idempotent_noop"),
    )?.text;

    expect(action).toContain("skipped");
    expect(action).not.toContain("✓");
  });

  it("uses replayed child tool truth to correct a legacy completed action receipt", () => {
    const projection = buildDetailedTranscript([
      event(
        "subagent.completed",
        1,
        {
          childRunId: "run_child",
          parentRunId: "run_parent",
          status: "completed",
          summary: "Verification complete.",
          actions: [
            {
              toolCallId: "call_bash",
              toolName: "bash",
              preview: "$ python3 check.py",
              status: "completed",
            },
          ],
        },
        { runId: "run_parent" },
      ),
      event(
        "tool.requested",
        2,
        {
          id: "call_bash",
          toolName: "bash",
          arguments: { command: "python3 check.py" },
        },
        { runId: "run_child" },
      ),
      event(
        "tool.completed",
        3,
        {
          toolCallId: "call_bash",
          toolName: "bash",
          output: {
            skipped: true,
            reason: "repeated_idempotent_noop",
          },
        },
        { runId: "run_child" },
      ),
    ]);
    const action = projection.lines.find((line) =>
      line.text.includes("python3 check.py"),
    )?.text;

    expect(action).toContain("repeated_idempotent_noop · skipped");
    expect(action).not.toContain("✓");
  });

  it("suppresses successful Agent transport but never a tool failure", () => {
    const events = [
      event("tool.requested", 1, {
        id: "spawn_1",
        toolName: "spawn_agent",
        arguments: { goal: "inspect" },
      }),
      event("tool.completed", 2, {
        toolCallId: "spawn_1",
        toolName: "spawn_agent",
        output: { childRunId: "run_child" },
      }),
      event("tool.failed", 3, {
        toolCallId: "spawn_2",
        toolName: "spawn_agent",
        error: { code: "DENIED", message: "approval denied" },
      }),
    ];
    const ids = collectAgentToolCallIds(events);

    expect(shouldShowInCompactTranscript(events[0]!, ids)).toBe(false);
    expect(shouldShowInCompactTranscript(events[1]!, ids)).toBe(false);
    expect(shouldShowInCompactTranscript(events[2]!, ids)).toBe(true);
  });

  it("includes the canonical run-completed assistant answer", () => {
    const projection = buildDetailedTranscript([
      event("tui.user", -1, { goal: "answer the question" }),
      event("run.started", 1, {}),
      event("run.completed", 2, {
        state: "completed",
        reason: "final_answer",
        message: "The canonical final answer.",
      }),
    ]);
    const text = projection.lines.map((line) => line.text).join("\n");

    expect(text).toContain("assistant");
    expect(text).toContain("The canonical final answer.");
    expect(projection.scope).toBe("latest run");
  });

  it("summarizes structured tool plumbing without exposing raw JSON", () => {
    const projection = buildDetailedTranscript([
      event("tui.user", -1, { goal: "find a tool" }),
      event("tool.requested", 1, {
        id: "search_1",
        toolName: "tool_search",
        arguments: { query: "select:spawn_agent", maxResults: 1 },
      }),
      event("tool.completed", 2, {
        toolCallId: "search_1",
        toolName: "tool_search",
        output: {
          query: "select:spawn_agent",
          mode: "select",
          matches: [{ name: "spawn_agent", description: "Spawn an agent." }],
        },
      }),
    ]);
    const text = projection.lines.map((line) => line.text).join("\n");

    expect(text).toContain("query=select:spawn_agent");
    expect(text).not.toContain("maxResults=1");
    expect(text).toContain("1 match");
    expect(text).toContain("spawn_agent");
    expect(text).not.toContain('{"query"');
    expect(text).not.toContain('"matches"');
  });

  it("reads bounded persisted tool-search arrays without reporting zero matches", () => {
    const projection = buildDetailedTranscript([
      event("tui.user", -1, { goal: "find a tool" }),
      event("tool.requested", 1, {
        id: "search_1",
        toolName: "tool_search",
        arguments: { query: "select:spawn_agent", maxResults: 1 },
      }),
      event("tool.completed", 2, {
        toolCallId: "search_1",
        toolName: "tool_search",
        output: {
          matches: {
            type: "array",
            length: 1,
            preview: [{ name: "spawn_agent" }],
          },
        },
      }),
    ]);
    const text = projection.lines.map((line) => line.text).join("\n");

    expect(text).toContain("1 match");
    expect(text).toContain("spawn_agent");
    expect(text).not.toContain("0 matches");
  });

  it("shows completed Agent runs with semantic issues before their report", () => {
    const projection = buildDetailedTranscript([
      event("tui.user", -1, { goal: "create and verify the script" }),
      event(
        "subagent.completed",
        1,
        {
          childRunId: "run_child",
          parentRunId: "run_parent",
          status: "completed",
          summary: "Created and verified print_numbers.py.",
          workspaceWrites: 0,
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
        {
          metadata: {
            childRunId: "run_child",
            parentRunId: "run_parent",
            agentName: "script-writer",
          },
        },
      ),
    ]);
    const text = projection.lines.map((line) => line.text).join("\n");

    expect(text).toContain("Agent · script-writer completed with issues");
    expect(text).toContain(
      "create print_numbers.py failed because the target already exists; no successful workspace write proved creation or modification",
    );
    expect(text).toContain("WORKSPACE_CREATE_CONFLICT");
    expect(text.indexOf("issue")).toBeLessThan(text.indexOf("result"));
    expect(text).not.toContain("error\nUNRESOLVED_TOOL_FAILURE");
    expect(
      projection.blocks.filter((block) => block.kind === "tool"),
    ).toHaveLength(0);
  });

  it("folds replayed child answers under the Agent and keeps them out of compact scrollback", () => {
    const events = [
      event("tui.user", -1, { goal: "delegate the review" }),
      event("run.started", 1, {}),
      event(
        "subagent.requested",
        2,
        {
          childRunId: "run_child",
          parentRunId: "run_parent",
          goal: "review the file",
        },
        {
          metadata: {
            childRunId: "run_child",
            parentRunId: "run_parent",
            agentName: "reviewer",
            subagentDepth: 1,
          },
        },
      ),
      event(
        "run.completed",
        3,
        {
          state: "completed",
          message: "Full child Markdown result.",
        },
        { runId: "run_child" },
      ),
      event(
        "subagent.completed",
        4,
        {
          childRunId: "run_child",
          parentRunId: "run_parent",
          status: "completed",
          summary: "Short parent-facing result.",
          blockers: [],
        },
        {
          metadata: {
            childRunId: "run_child",
            parentRunId: "run_parent",
            agentName: "reviewer",
            subagentDepth: 1,
          },
        },
      ),
      event("run.completed", 5, {
        state: "completed",
        message: "Main assistant answer.",
      }),
    ];
    const childRunIds = collectChildRunIds(events);
    const agentToolCallIds = collectAgentToolCallIds(events);
    const childTerminal = events[3]!;
    const projection = buildDetailedTranscript(events);
    const text = projection.lines.map((line) => line.text).join("\n");

    expect(
      shouldShowInCompactTranscript(
        childTerminal,
        agentToolCallIds,
        childRunIds,
      ),
    ).toBe(false);
    expect(text).toContain("Full child Markdown result.");
    expect(text.match(/Full child Markdown result\./g)).toHaveLength(1);
    expect(text).toContain("Main assistant answer.");
    expect(
      projection.blocks.filter((block) => block.kind === "assistant"),
    ).toHaveLength(1);
  });
});
