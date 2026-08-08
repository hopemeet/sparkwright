import { describe, expect, it } from "vitest";
import type { RunEvent } from "../src/lib/event-type.js";
import { assembleTranscriptDocument } from "../src/lib/transcript-document.js";
import { projectTranscriptRows } from "../src/lib/transcript-layout.js";

function event(
  type: string,
  sequence: number,
  payload?: unknown,
  options: Partial<RunEvent> = {},
): RunEvent {
  return {
    id: `event_${sequence}`,
    runId: "run_parent",
    type,
    sequence,
    payload,
    ...options,
  };
}

function document(events: RunEvent[]) {
  return assembleTranscriptDocument({
    epoch: "session:0",
    events,
    header: {
      workspaceRoot: "/repo",
      modelLabel: "deterministic",
      sessionId: "session",
    },
  });
}

describe("TranscriptDocument", () => {
  it("returns a deeply frozen semantic snapshot", () => {
    const result = document([event("tui.notice", 1, { text: "immutable" })]);
    const block = result.blocks[0]!;

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.blocks)).toBe(true);
    expect(Object.isFrozen(block)).toBe(true);
    expect(Object.isFrozen(block.summary)).toBe(true);
    expect(Object.isFrozen(block.summary[0])).toBe(true);
    expect(Object.isFrozen(block.details)).toBe(true);
  });

  it("preserves assistant Markdown blank lines between paragraphs and lists", () => {
    const message = [
      "以下是核心能力：",
      "",
      "**1. 文件系统**",
      "* **读取：** 查看文件。",
      "* **编辑：** 修改文件。",
      "",
      "**2. 代码执行**",
      "* **运行：** 执行测试。",
      "",
      "最后一段。",
    ].join("\n");
    const result = document([event("run.completed", 1, { message })]);
    const assistant = result.blocks.find((block) => block.kind === "assistant");

    expect(assistant?.summary[1]?.text).toBe(message);
    expect(
      projectTranscriptRows(result, "compact").map((row) => row.text),
    ).toEqual([
      "SparkWright · type a goal · /capabilities · /help",
      "cwd /repo",
      "model deterministic · session session",
      "",
      "assistant",
      "以下是核心能力：",
      "",
      "1. 文件系统",
      "",
      "• 读取： 查看文件。",
      "• 编辑： 修改文件。",
      "",
      "2. 代码执行",
      "",
      "• 运行： 执行测试。",
      "",
      "最后一段。",
    ]);
  });

  it("uses one stable Agent block for compact summary and details", () => {
    const result = document([
      event("tui.user", 0, { goal: "实现打印脚本" }),
      event("subagent.requested", 1, {
        childRunId: "run_child",
        parentRunId: "run_parent",
        goal: "创建并验证脚本",
      }),
      event(
        "subagent.completed",
        2,
        {
          childRunId: "run_child",
          parentRunId: "run_parent",
          status: "completed",
          summary: "验证通过",
        },
        { metadata: { agentName: "implement-timed-printer" } },
      ),
    ]);

    const agent = result.blocks.find((block) => block.kind === "agent");
    expect(agent?.key).toBe("agent:run_child");
    expect(agent?.summary[0]?.text).toContain(
      "Agent · implement-timed-printer completed",
    );
    expect(agent?.details.map((section) => section.label)).toEqual([
      "task",
      "result",
    ]);
  });

  it("shows a successful skill load once instead of repeating its summary in details", () => {
    const result = document([
      event("tool.requested", 1, {
        id: "call_skill",
        toolName: "skill_load",
        arguments: { name: "py-script-check", resource: "" },
      }),
      event("tool.completed", 2, {
        toolCallId: "call_skill",
        toolName: "skill_load",
        output: {
          status: "loaded",
          name: "py-script-check",
          content: "skill instructions",
        },
      }),
    ]);

    const skill = result.blocks.find(
      (block) =>
        block.kind === "tool" &&
        block.summary[0]?.text.startsWith("⚙ skill_load"),
    );
    expect(skill?.details.map((section) => section.label)).toEqual(["result"]);
    const detailText = projectTranscriptRows(result, "detailed")
      .map((row) => row.text)
      .join("\n");
    expect(
      detailText.match(/skill_load py-script-check -> loaded/gu),
    ).toHaveLength(1);
    expect(detailText).not.toContain("parameters");
  });

  it("shows single-line tool inputs and results once in detailed mode", () => {
    const result = document([
      event("tool.requested", 1, {
        id: "call_bash",
        toolName: "bash",
        arguments: { command: "npm test" },
      }),
      event("tool.completed", 2, {
        toolCallId: "call_bash",
        toolName: "bash",
        output: { exitCode: 0, stdout: "tests passed" },
      }),
      event("tool.requested", 3, {
        id: "call_lookup",
        toolName: "lookup",
        arguments: { query: "status" },
      }),
      event("tool.completed", 4, {
        toolCallId: "call_lookup",
        toolName: "lookup",
        output: "ready",
      }),
    ]);

    const compact = projectTranscriptRows(result, "compact")
      .map((row) => row.text)
      .join("\n");
    const detailed = projectTranscriptRows(result, "detailed")
      .map((row) => row.text)
      .join("\n");

    expect(compact).toContain("$ npm test");
    expect(compact).toContain("ready");
    expect(detailed.match(/\$ npm test/gu)).toHaveLength(1);
    expect(detailed.match(/query=status/gu)).toHaveLength(1);
    expect(detailed.match(/ready/gu)).toHaveLength(1);
  });

  it("shows ask and bypass outcomes once in live receipts and replayed child events", () => {
    const terminalReceipt = event("subagent.completed", 9, {
      childRunId: "run_child",
      parentRunId: "run_parent",
      status: "completed",
      summary: "done",
      actions: [
        {
          toolCallId: "call_create",
          toolName: "create",
          preview: "count_numbers.py",
          status: "completed",
          approval: "approved",
          approvalSummary: "Create count_numbers.py",
        },
        {
          toolCallId: "call_bash",
          toolName: "bash",
          preview: "$ python3 count_numbers.py",
          status: "completed",
          approval: "approved",
          approvalSummary: "Run tool bash",
          approvalAutoApproved: true,
          exitCode: 0,
        },
      ],
    });
    const live = document([terminalReceipt]);
    const replay = document([
      event(
        "tool.requested",
        1,
        {
          id: "call_create",
          toolName: "create",
          arguments: { path: "count_numbers.py" },
        },
        { runId: "run_child", spanId: "span_create" },
      ),
      event(
        "approval.requested",
        2,
        { id: "approval_create", summary: "Create count_numbers.py" },
        { runId: "run_child", spanId: "span_create" },
      ),
      event(
        "approval.resolved",
        3,
        { approvalId: "approval_create", decision: "approved" },
        { runId: "run_child", spanId: "span_create" },
      ),
      event(
        "tool.completed",
        4,
        {
          toolCallId: "call_create",
          toolName: "create",
          output: { changed: true },
        },
        { runId: "run_child", spanId: "span_create" },
      ),
      event(
        "tool.requested",
        5,
        {
          id: "call_bash",
          toolName: "bash",
          arguments: { command: "python3 count_numbers.py" },
        },
        { runId: "run_child", spanId: "span_bash" },
      ),
      event(
        "approval.requested",
        6,
        { id: "approval_bash", summary: "Run tool bash" },
        { runId: "run_child", spanId: "span_bash" },
      ),
      event(
        "approval.resolved",
        7,
        {
          approvalId: "approval_bash",
          decision: "approved",
          autoApproved: true,
        },
        { runId: "run_child", spanId: "span_bash" },
      ),
      event(
        "tool.completed",
        8,
        {
          toolCallId: "call_bash",
          toolName: "bash",
          output: { exitCode: 0 },
        },
        { runId: "run_child", spanId: "span_bash" },
      ),
      terminalReceipt,
    ]);
    for (const result of [live, replay]) {
      const agent = result.blocks.find((block) => block.kind === "agent");
      expect(agent?.details.map((section) => section.label)).toContain(
        "approvals",
      );
      expect(
        result.blocks.filter((block) => block.kind === "approval"),
      ).toHaveLength(0);
      for (const mode of ["compact", "detailed"] as const) {
        expect(
          projectTranscriptRows(result, mode)
            .filter(
              (row) =>
                row.blockKey.startsWith("agent:") &&
                row.text.includes("approval "),
            )
            .map((row) => row.text.trim()),
        ).toEqual([
          "approval approved · Create count_numbers.py",
          "approval auto-approved · Run tool bash",
        ]);
      }
      const actionRows = agent?.details.find(
        (section) => section.label === "actions",
      )?.rows;
      expect(actionRows).toHaveLength(2);
      expect(actionRows?.every((row) => !row.text.includes("approval"))).toBe(
        true,
      );
    }
  });

  it("folds a terminal-receipt child failure into its Agent issue", () => {
    const result = document([
      event("subagent.requested", 1, {
        childRunId: "run_child",
        parentRunId: "run_parent",
        goal: "Create print_numbers.py",
      }),
      event(
        "tool.requested",
        2,
        {
          id: "call_create",
          toolName: "create",
          arguments: { path: "print_numbers.py" },
        },
        { runId: "run_child" },
      ),
      event(
        "tool.failed",
        3,
        {
          toolCallId: "call_create",
          toolName: "create",
          error: {
            code: "WORKSPACE_CREATE_CONFLICT",
            message: "Workspace create target already exists: print_numbers.py",
          },
        },
        { runId: "run_child" },
      ),
      event("subagent.completed", 4, {
        childRunId: "run_child",
        parentRunId: "run_parent",
        status: "completed",
        summary: "Created print_numbers.py.",
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
      }),
    ]);
    const text = result.blocks
      .flatMap((block) => [
        ...block.summary.map((row) => row.text),
        ...block.details.flatMap((section) =>
          section.rows.map((row) => row.text),
        ),
      ])
      .join("\n");

    expect(text).toContain("completed with issues");
    expect(text).toContain("target already exists");
    expect(text).not.toContain("tool.failed");
    expect(text).not.toContain("✗ create failed");
    expect(
      result.blocks.filter((block) => block.kind === "agent"),
    ).toHaveLength(1);
  });

  it("keeps each detail section at 120 source rows plus an omission row", () => {
    const summary = Array.from(
      { length: 200 },
      (_, index) => `result line ${index}`,
    ).join("\n");
    const result = document([
      event("subagent.completed", 1, {
        childRunId: "run_large_child",
        parentRunId: "run_parent",
        status: "completed",
        summary,
      }),
    ]);
    const section = result.blocks
      .find((block) => block.key === "agent:run_large_child")
      ?.details.find((candidate) => candidate.label === "result");

    expect(section?.rows).toHaveLength(121);
    expect(section?.rows.at(-1)?.text).toBe("… 80 lines omitted …");
  });

  it("never groups same-named legacy Agents without a structured id", () => {
    const result = document([
      event(
        "subagent.completed",
        1,
        { status: "completed", summary: "first" },
        { metadata: { agentName: "worker" } },
      ),
      event(
        "subagent.completed",
        2,
        { status: "completed", summary: "second" },
        { metadata: { agentName: "worker" } },
      ),
    ]);

    expect(
      result.blocks.filter((block) => block.kind === "agent"),
    ).toHaveLength(2);
  });

  it("uses ingestion ordinal when legacy events repeat a run-local sequence", () => {
    const result = document([
      event(
        "subagent.completed",
        1,
        { status: "completed", summary: "first" },
        { id: undefined, metadata: { agentName: "worker" } },
      ),
      event(
        "subagent.completed",
        1,
        { status: "completed", summary: "second" },
        { id: undefined, metadata: { agentName: "worker" } },
      ),
      event(
        "tool.requested",
        2,
        { toolName: "legacy", arguments: { value: 1 } },
        { id: undefined },
      ),
      event(
        "tool.completed",
        2,
        { toolName: "legacy", result: "done" },
        { id: undefined },
      ),
    ]);

    const agents = result.blocks.filter((block) => block.kind === "agent");
    const tools = result.blocks.filter(
      (block) =>
        block.kind === "tool" &&
        block.summary.some((row) => row.text.includes("legacy")),
    );
    expect(new Set(agents.map((block) => block.key)).size).toBe(2);
    expect(new Set(tools.map((block) => block.key)).size).toBe(2);
  });

  it("scopes repeated tool-call ids by structured run id", () => {
    const result = document([
      event(
        "tool.requested",
        1,
        { id: "shared_call", toolName: "bash", arguments: { command: "pwd" } },
        { runId: "run_a" },
      ),
      event(
        "tool.completed",
        2,
        { toolCallId: "shared_call", toolName: "bash", result: "a" },
        { runId: "run_a" },
      ),
      event(
        "tool.requested",
        3,
        { id: "shared_call", toolName: "read_file", arguments: { path: "b" } },
        { runId: "run_b" },
      ),
      event(
        "tool.completed",
        4,
        { toolCallId: "shared_call", toolName: "read_file", result: "b" },
        { runId: "run_b" },
      ),
    ]);
    const tools = result.blocks.filter((block) => block.kind === "tool");

    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((block) => block.key)).size).toBe(2);
    expect(tools.map((block) => block.summary[0]?.text)).toEqual([
      "⚙ bash  $ pwd",
      "⚙ read_file  path=b",
    ]);
  });

  it("lets an exact tool span own read and Skill effect events", () => {
    const result = document([
      event(
        "tool.requested",
        1,
        {
          id: "call_read",
          toolName: "read",
          arguments: { path: "print_numbers.py", offset: 1, limit: 100 },
        },
        { spanId: "span_read" },
      ),
      event(
        "workspace.read",
        2,
        { path: "print_numbers.py" },
        { spanId: "span_read" },
      ),
      event(
        "tool.completed",
        3,
        {
          toolCallId: "call_read",
          toolName: "read",
          output: { path: "print_numbers.py", totalLines: 10 },
        },
        { spanId: "span_read" },
      ),
      event(
        "tool.requested",
        4,
        {
          id: "call_skill",
          toolName: "skill_load",
          arguments: { name: "py-script-check" },
        },
        { spanId: "span_skill" },
      ),
      event(
        "tool.completed",
        5,
        {
          toolCallId: "call_skill",
          toolName: "skill_load",
          output: { status: "loaded", name: "py-script-check" },
        },
        { spanId: "span_skill" },
      ),
      event(
        "skill.loaded",
        6,
        { name: "py-script-check" },
        { spanId: "span_skill" },
      ),
    ]);

    expect(
      result.blocks.filter(
        (block) =>
          block.kind === "tool" && block.summary[0]?.text.startsWith("⚙ read"),
      ),
    ).toHaveLength(1);
    expect(
      result.blocks.some((block) =>
        block.summary.some((row) => row.text === "read print_numbers.py"),
      ),
    ).toBe(false);
    expect(
      result.blocks.some((block) =>
        block.summary.some(
          (row) => row.text === "skill py-script-check loaded",
        ),
      ),
    ).toBe(false);
  });

  it("keeps an unowned effect independent and never matches spans across runs", () => {
    const result = document([
      event(
        "tool.requested",
        1,
        {
          id: "call_read",
          toolName: "read",
          arguments: { path: "owned.txt" },
        },
        { runId: "run_a", spanId: "shared_span" },
      ),
      event(
        "workspace.read",
        2,
        { path: "other-run.txt" },
        { runId: "run_b", spanId: "shared_span" },
      ),
      event(
        "workspace.read",
        3,
        { path: "standalone.txt" },
        { runId: "run_a", spanId: "standalone_span" },
      ),
    ]);
    const text = result.blocks
      .flatMap((block) => block.summary)
      .map((row) => row.text);

    expect(text).toContain("read other-run.txt");
    expect(text).toContain("read standalone.txt");
  });

  it("keeps approvals and failures primary", () => {
    const result = document([
      event("approval.requested", 1, { summary: "write file" }),
      event("tool.failed", 2, {
        toolCallId: "tool_failure",
        toolName: "bash",
        error: { code: "EXIT_1", message: "failed" },
      }),
      event("workspace.write.denied", 3, { path: "secret.txt" }),
      event("run.cancelled", 4, { reason: "user" }),
    ]);

    const safety = result.blocks.filter(
      (block) =>
        ["approval", "failure"].includes(block.kind) ||
        block.summary.some((row) => row.tone === "error"),
    );
    expect(safety).toHaveLength(4);
    expect(safety.every((block) => block.level === "primary")).toBe(true);
  });

  it("renders one run-scoped row per approval with its final outcome", () => {
    const result = document([
      event(
        "approval.requested",
        1,
        { id: "approval_shared", summary: "Create count_numbers.py" },
        { runId: "run_a" },
      ),
      event(
        "approval.resolved",
        2,
        { approvalId: "approval_shared", decision: "approved" },
        { runId: "run_a" },
      ),
      event(
        "approval.requested",
        3,
        { id: "approval_shared", summary: "Run tool bash" },
        { runId: "run_b" },
      ),
      event(
        "approval.resolved",
        4,
        { approvalId: "approval_shared", decision: "denied" },
        { runId: "run_b" },
      ),
      event(
        "approval.requested",
        5,
        { id: "approval_pending", summary: "Review pending action" },
        { runId: "run_b" },
      ),
      event("run.completed", 6, { reason: "final_answer" }, { runId: "run_a" }),
    ]);

    const approvals = result.blocks.filter(
      (block) => block.kind === "approval",
    );
    expect(approvals.map((block) => block.key)).toEqual([
      "approval:run_a:approval_shared",
      "approval:run_b:approval_shared",
      "approval:run_b:approval_pending",
    ]);
    expect(
      approvals.flatMap((block) => block.summary.map((row) => row.text)),
    ).toEqual([
      "approval approved · Create count_numbers.py",
      "approval denied · Run tool bash",
      "approval requested · Review pending action",
    ]);
    expect(
      result.blocks
        .flatMap((block) => block.summary)
        .some((row) => row.text.includes("summary approvals")),
    ).toBe(false);
  });

  it("keeps concurrent and nested Agents separate using only run ids", () => {
    const result = document([
      event(
        "subagent.completed",
        1,
        {
          childRunId: "run_child_a",
          parentRunId: "run_parent",
          status: "completed",
          summary: "A done",
        },
        { metadata: { agentName: "worker" } },
      ),
      event(
        "subagent.completed",
        2,
        {
          childRunId: "run_child_b",
          parentRunId: "run_parent",
          status: "blocked",
          blockers: [{ code: "WAITING", message: "needs input" }],
        },
        { metadata: { agentName: "worker" } },
      ),
      event(
        "subagent.failed",
        3,
        {
          childRunId: "run_nested",
          parentRunId: "run_child_a",
          error: { code: "CHILD_FAILED" },
        },
        {
          runId: "run_child_a",
          metadata: {
            agentName: "nested",
            childRunId: "run_nested",
            parentRunId: "run_child_a",
            subagentDepth: 2,
          },
        },
      ),
      event(
        "tool.completed",
        4,
        {
          toolCallId: "nested_sibling_tool",
          toolName: "read_file",
          result: "done",
        },
        { runId: "run_child_a" },
      ),
    ]);

    const agents = result.blocks.filter((block) => block.kind === "agent");
    expect(agents.map((block) => block.key)).toEqual([
      "agent:run_child_a",
      "agent:run_child_b",
      "agent:run_nested",
    ]);
    expect(agents[1]?.summary[0]?.text).toContain("blocked");
    expect(agents[2]?.summary[0]?.text).toContain("failed");
    expect(agents[2]?.parentKey).toBe("agent:run_child_a");
  });

  it("does not re-add successful child tool lifecycles as generic event rows", () => {
    const result = document([
      event(
        "subagent.completed",
        1,
        {
          childRunId: "run_child",
          parentRunId: "run_parent",
          status: "completed",
          summary: "done",
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
        { runId: "run_child", spanId: "span_bash" },
      ),
      event(
        "tool.completed",
        3,
        {
          toolCallId: "call_bash",
          toolName: "bash",
          output: { exitCode: 0 },
        },
        { runId: "run_child", spanId: "span_bash" },
      ),
    ]);
    const text = result.blocks
      .flatMap((block) => block.summary)
      .map((row) => row.text)
      .join("\n");

    expect(text).not.toContain("tool.requested");
    expect(text).not.toContain("tool.completed");
    expect(
      result.blocks.filter(
        (block) => block.kind === "tool" && block.runId === "run_child",
      ),
    ).toHaveLength(0);
  });

  it("keeps interleaved run facts isolated by structured run id", () => {
    const result = document([
      event("run.started", 1, {}, { runId: "run_a" }),
      event("workspace.write.applied", 2, { path: "a.ts" }, { runId: "run_a" }),
      event("run.started", 3, {}, { runId: "run_b" }),
      event("workspace.write.applied", 4, { path: "b.ts" }, { runId: "run_b" }),
      event(
        "workspace.write.applied",
        5,
        { path: "b.test.ts" },
        { runId: "run_b" },
      ),
      event("run.completed", 6, {}, { runId: "run_a" }),
      event("run.completed", 7, {}, { runId: "run_b" }),
    ]);

    const runA = result.blocks.find((block) => block.key === "event_6");
    const runB = result.blocks.find((block) => block.key === "event_7");
    expect(runA?.summary.map((row) => row.text)).toContain(
      "summary changed 1 file",
    );
    expect(runB?.summary.map((row) => row.text)).toContain(
      "summary changed 2 files",
    );
  });

  it("assembles the full replayed session instead of only the latest turn", () => {
    const result = document([
      event("tui.user", 1, { goal: "first turn" }),
      event("run.completed", 2, { message: "first answer" }),
      event("tui.user", 3, { goal: "second turn" }),
      event("run.completed", 4, { message: "second answer" }),
    ]);
    const text = result.blocks
      .flatMap((block) => block.summary)
      .map((row) => row.text)
      .join("\n");
    expect(text).toContain("first turn");
    expect(text).toContain("first answer");
    expect(text).toContain("second turn");
    expect(text).toContain("second answer");
  });
});
