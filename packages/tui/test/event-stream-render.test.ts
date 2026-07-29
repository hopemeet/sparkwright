import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import {
  EventStream,
  taskTerminalTone,
  type TranscriptHeaderInfo,
} from "../src/components/event-stream.js";
import type { RunEvent } from "../src/lib/event-type.js";

/**
 * Render-layer regression tests for the committed transcript. The TUI has no
 * render-layer test infra, so we drive Ink's `render` into a fake stdout and
 * inspect the emitted (ANSI-stripped) text — the same technique ink-testing-
 * library uses, without the dependency.
 *
 * Covers:
 *  - list_dir tool result renders as a compact summary, not raw JSON.
 *  - internal cancel/state-machine events are suppressed (don't leak as
 *    "[seq] type" debug rows); the polished cancel card still shows.
 */
async function renderToText(
  element: React.ReactElement,
  columns = 120,
): Promise<string> {
  const writes: string[] = [];
  const fakeStdout = {
    columns,
    rows: 40,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const fakeStdin = {
    isTTY: true,
    setRawMode() {},
    setEncoding() {},
    on() {},
    off() {},
    removeListener() {},
    read() {
      return null;
    },
    ref() {},
    unref() {},
    resume() {},
    pause() {},
  } as unknown as NodeJS.ReadStream;
  const { unmount } = render(element, {
    stdout: fakeStdout,
    stdin: fakeStdin,
    patchConsole: false,
  });
  await new Promise((r) => setTimeout(r, 60));
  unmount();
  // eslint-disable-next-line no-control-regex
  return writes.join("").replace(/\[[0-9;?]*[a-zA-Z]/g, "");
}

const header: TranscriptHeaderInfo = {
  workspaceRoot: "/repo",
  modelLabel: "deterministic",
  sessionId: "s1",
};

function ev(
  type: string,
  sequence: number,
  payload?: unknown,
  metadata?: Record<string, unknown>,
): RunEvent {
  return { type, sequence, id: String(sequence), payload, metadata };
}

function stream(events: RunEvent[]): React.ReactElement {
  return React.createElement(EventStream, { events, header });
}

describe("EventStream committed rendering", () => {
  it("renders a model switch notice as committed scrollback", async () => {
    const text = await renderToText(
      stream([
        ev("tui.notice", -1, {
          text: "model -> openai/gpt-5.4-mini (next run)",
        }),
      ]),
    );

    expect(text).toContain("model -> openai/gpt-5.4-mini (next run)");
    expect(text).not.toContain("[ -1] tui.notice");
  });

  it("renders transcript export paths as bare committed scrollback lines", async () => {
    const path =
      "/Applications/xgw/projects/AI-native/SparkWright/.sparkwright/exports/session-session_tui_mq4j14hz.md";
    const text = await renderToText(
      stream([
        ev("tui.export.completed", -1, {
          path,
        }),
      ]),
    );
    const lines = text
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);

    expect(text).toContain("transcript exported");
    expect(lines).toContain(path);
    expect(text).not.toContain("│");
    expect(text).not.toContain("[ -1] tui.export.completed");
  });

  it("renders a list_dir result as a summary, not raw JSON", async () => {
    const events = [
      ev("tool.completed", 1, {
        result: {
          path: ".",
          entries: [
            { path: "dist", name: "dist", type: "directory" },
            { path: "a.ts", name: "a.ts", type: "file", size: 10 },
          ],
        },
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("list_dir . → 2 entries");
    expect(text).toContain("dist/");
    expect(text).not.toContain('"entries"');
    expect(text).not.toContain('{"path"');
  });

  it("renders a glob result as a summary, not raw JSON", async () => {
    const events = [
      ev("tool.completed", 1, {
        result: {
          patterns: ["package.json", "pnpm-lock.yaml"],
          paths: ["package.json"],
          truncated: false,
          offset: 0,
          totalPaths: 1,
          hasMore: false,
        },
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("glob → 1 path");
    expect(text).toContain("package.json");
    expect(text).not.toContain('"patterns"');
    expect(text).not.toContain('"totalPaths"');
  });

  it("renders anchored reads as summaries, not raw JSON", async () => {
    const events = [
      ev("workspace.anchored_read", 1, {
        path: "src/cart.js",
        anchorSetId: "anchors_123",
        lineCount: 2,
        content: "1#AAAA| export function subtotal(items) {",
        lines: [{ line: 1, anchor: "1#AAAA", content: "export function" }],
      }),
      ev("tool.completed", 2, {
        output: {
          path: "src/cart.js",
          anchorSetId: "anchors_123",
          lineCount: 2,
          content: "1#AAAA| export function subtotal(items) {",
          lines: [{ line: 1, anchor: "1#AAAA", content: "export function" }],
        },
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("read anchors src/cart.js · 2 lines");
    expect(text).not.toContain("anchorSetId");
    expect(text).not.toContain("1#AAAA");
    expect(text).not.toContain('"lines"');
  });

  it("suppresses artifact and write-tool result JSON after workspace writes", async () => {
    const events = [
      ev("artifact.created", 1, {
        id: "artifact_1",
        type: "diff",
        path: "src/cart.js",
      }),
      ev("workspace.write.completed", 2, {
        path: "src/cart.js",
      }),
      ev("tool.completed", 3, {
        toolName: "edit",
        output: {
          path: "src/cart.js",
          changed: true,
          content: "export function subtotal(items) { return 0; }\n",
          hunksApplied: 1,
        },
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("write src/cart.js");
    expect(text).not.toContain("artifact.created");
    expect(text).not.toContain("artifact_1");
    expect(text).not.toContain('"content"');
    expect(text).not.toContain("hunksApplied");
  });

  it("renders skill mutation tool requests as short summaries", async () => {
    const events = [
      ev("tool.requested", 1, {
        toolName: "update_skill",
        arguments: {
          action: "draft",
          name: "repo-reviewer",
          description:
            "A long proposal description that should not leak raw JSON",
        },
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("update_skill");
    expect(text).toContain("draft repo-reviewer");
    expect(text).not.toContain('"description"');
  });

  it("keeps tool names readable while truncating long argument previews", async () => {
    const events = [
      ev("tool.batch.requested", 1, {
        toolCallCount: 1,
        mode: "serial",
      }),
      ev("tool.requested", 2, {
        toolName: "edit",
        arguments: {
          path: "src/cart.js",
          patch:
            "*** Begin Patch\n*** Update File: src/cart.js\n@@\n- old\n+ new\n*** End Patch",
        },
      }),
    ];
    const text = await renderToText(stream(events), 72);
    expect(text).toContain("⚙ edit");
    expect(text).not.toContain("batch  1 tool");
  });

  it("hides batch plumbing while keeping its child tools readable", async () => {
    const text = await renderToText(
      stream([
        ev("tool.batch.requested", 1, {
          toolCallCount: 2,
          mode: "concurrent",
        }),
        ev("tool.requested", 2, {
          id: "call_a",
          toolName: "read",
          arguments: { path: "a.ts" },
        }),
        ev("tool.requested", 3, {
          id: "call_b",
          toolName: "read",
          arguments: { path: "b.ts" },
        }),
        ev("tool.batch.completed", 4, {}),
      ]),
    );

    expect(text).not.toContain("batch");
    expect(text).toContain("⚙ read  a.ts");
    expect(text).toContain("⚙ read  b.ts");
  });

  it("renders bash tool requests as commands instead of raw JSON", async () => {
    const events = [
      ev("tool.requested", 1, {
        toolName: "bash",
        arguments: {
          command: "npm test",
          timeoutMs: 120000,
          cwd: "/tmp/project",
        },
      }),
    ];
    const text = await renderToText(stream(events), 72);
    expect(text).toContain("⚙ bash  $ npm test");
    expect(text).not.toContain('"command"');
  });

  it("renders common read/search tool requests as short previews", async () => {
    const events = [
      ev("tool.requested", 1, {
        toolName: "list_dir",
        arguments: {
          path: ".",
          recursive: true,
          includeHidden: false,
          maxEntries: 200,
        },
      }),
      ev("tool.requested", 2, {
        toolName: "read",
        arguments: { path: "README.md", offset: 1, limit: 20 },
      }),
      ev("tool.requested", 3, {
        toolName: "glob",
        arguments: { patterns: ["packages/*/package.json"] },
      }),
    ];
    const text = await renderToText(stream(events), 100);
    expect(text).toContain("⚙ list_dir  . recursive");
    expect(text).toContain("⚙ read  README.md:1 +20");
    expect(text).toContain("⚙ glob  packages/*/package.json");
    expect(text).not.toContain('"recursive"');
    expect(text).not.toContain('"maxEntries"');
    expect(text).not.toContain('"patterns"');
  });

  it("uses tool-owned request previews from events", async () => {
    const events = [
      ev("tool.requested", 1, {
        toolName: "review_auth",
        preview: "reviewer: inspect auth flow",
        arguments: {
          role: "reviewer",
          goal: "inspect auth flow",
          context: "Read the implementation and report risks.",
        },
      }),
    ];
    const text = await renderToText(stream(events), 90);
    expect(text).toContain("⚙ review_auth  reviewer: inspect auth flow");
    expect(text).not.toContain('"context"');
  });

  it("renders capability mutations with action and compact path", async () => {
    const events = [
      ev("capability.mutation.completed", 1, {
        action: "write_text",
        path: "/tmp/project/.sparkwright/agents/reviewer/Agent.md",
        reason: "Write agent profile reviewer",
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("capability mutation");
    expect(text).toContain("write_text");
    expect(text).toContain(".sparkwright/agents/reviewer/Agent.md");
    expect(text).toContain("Write agent profile reviewer");
    expect(text).not.toContain('"action"');
  });

  it("folds proposal package mutations into the terminal tool result", async () => {
    const spanId = "span_skill_create";
    const events = [
      {
        ...ev("capability.mutation.completed", 1, {
          action: "ensure_directory",
          path: "/tmp/project/.sparkwright/skill-evolution/proposals/skillprop_123/after/demo",
          reason: "Create proposal package skillprop_123",
        }),
        spanId,
      },
      {
        ...ev("capability.mutation.completed", 2, {
          action: "write_text",
          path: "/tmp/project/.sparkwright/skill-evolution/proposals/skillprop_123/after/demo/SKILL.md",
          reason: "Write proposed Skill demo",
        }),
        spanId,
      },
      {
        ...ev("tool.completed", 3, {
          toolName: "create_skill",
          output: {
            action: "draft",
            changed: true,
            proposalId: "skillprop_123",
            proposalPath:
              "/tmp/project/.sparkwright/skill-evolution/proposals/skillprop_123",
          },
        }),
        spanId,
      },
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("skill proposal skillprop_123");
    expect(text).toContain("2 internal mutations");
    expect(text).not.toContain("capability mutation");
    expect(text).not.toContain("Write proposed Skill demo");
  });

  it("renders skill mutation tool results as compact summaries", async () => {
    const events = [
      ev("tool.completed", 1, {
        result: {
          action: "draft",
          changed: true,
          proposalId: "skillprop_123",
          proposalPath:
            "/tmp/project/.sparkwright/skill-evolution/proposals/skillprop_123",
        },
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("skill proposal");
    expect(text).toContain("skillprop_123");
    expect(text).toContain("draft only; original Skill package unchanged");
    expect(text).not.toContain('"proposalPath"');
  });

  it("renders shell results as compact output summaries", async () => {
    const events = [
      ev("tool.completed", 1, {
        toolName: "bash",
        output: {
          stdout:
            "\n> calc-fixture@0.0.0 test\n> node test/run-tests.mjs\n\ntests passed\n",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("shell exit 0");
    expect(text).toContain("tests passed");
    expect(text).not.toContain('"stdout"');
    expect(text).not.toContain('"exitCode"');
  });

  it("keeps both ends of truncated shell output and marks the omission", async () => {
    const text = await renderToText(
      stream([
        ev("tool.completed", 1, {
          toolName: "bash",
          output: {
            stdout: Array.from(
              { length: 10 },
              (_, index) => `output-line-${index + 1}`,
            ).join("\n"),
            stderr: "",
            exitCode: 1,
            timedOut: false,
          },
        }),
      ]),
    );

    expect(text).toContain("output-line-1");
    expect(text).toContain("output-line-2");
    expect(text).toContain("6 lines omitted");
    expect(text).toContain("output-line-9");
    expect(text).toContain("output-line-10");
    expect(text).not.toContain("output-line-3");
    expect(text).not.toContain("output-line-8");
  });

  it("hides successful internal orchestration and queued Agent lifecycle while keeping failures", async () => {
    const text = await renderToText(
      stream([
        ev("tool.requested", 1, {
          id: "skill_1",
          toolName: "skill_load",
          arguments: { name: "repo-reviewer" },
        }),
        ev("tool.completed", 2, {
          toolCallId: "skill_1",
          output: {
            status: "loaded",
            name: "repo-reviewer",
            content: "instructions",
          },
        }),
        ev("skill.loaded", 3, { name: "repo-reviewer" }),
        ev("tool.requested", 4, {
          id: "skill_resource_1",
          toolName: "skill_load",
          arguments: {
            name: "repo-reviewer",
            resource: "references/checks.md",
          },
        }),
        ev("tool.completed", 5, {
          toolCallId: "skill_resource_1",
          output: {
            status: "resource",
            name: "repo-reviewer",
            resource: "references/checks.md",
            content: "checks",
          },
        }),
        ev("tool.requested", 6, {
          id: "search_1",
          toolName: "tool_search",
          arguments: { query: "review" },
        }),
        ev("tool.failed", 7, {
          toolCallId: "search_1",
          toolName: "tool_search",
          error: { message: "catalog unavailable" },
        }),
        ev("mcp.server.prepared", 8, {
          name: "local",
          status: "prepared",
          toolCount: 4,
        }),
        ev("subagent.requested", 9, {
          childRunId: "run_child",
          goal: "review the patch",
        }),
      ]),
    );

    expect(text).not.toContain("skill_load");
    expect(text).not.toContain("repo-reviewer");
    expect(text).not.toContain("references/checks.md");
    expect(text).not.toContain("mcp local prepared");
    expect(text).toContain("tool_search failed");
    expect(text).not.toContain("run_child");
    expect(text).not.toContain("review the patch");
  });

  it("keeps an unsuccessful skill lookup visible", async () => {
    const text = await renderToText(
      stream([
        ev("tool.requested", 1, {
          id: "skill_missing",
          toolName: "skill_load",
          arguments: { name: "missing-skill" },
        }),
        ev("tool.completed", 2, {
          toolCallId: "skill_missing",
          output: { status: "not_found", requestedName: "missing-skill" },
        }),
      ]),
    );

    expect(text).toContain("skill_load missing-skill -> not found");
  });

  it("renders promoted shell results as background task handoff summaries", async () => {
    const events = [
      ev("tool.completed", 1, {
        toolName: "bash",
        output: {
          stdout: "bg-task-tick 1\n",
          stderr: "",
          exitCode: null,
          timedOut: false,
          promoted: true,
          taskId: "task_mqzd1c1b30yc24hj",
        },
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("shell promoted -> task_mqzd1c1b30yc24hj");
    expect(text).toContain("bg-task-tick 1");
    expect(text).not.toContain("shell exit null");
  });

  it("hides successful spawn receipts from the compact transcript", async () => {
    const events = [
      ev("tool.completed", 1, {
        toolName: "spawn_agent",
        output: {
          taskId: "task_mqzd1c1b30yc24hj",
          kind: "agent",
          mode: "foreground",
          promoted: true,
          awaited: true,
          actualMode: "awaited",
          parentWillWait: true,
          completionObservation: "automatic_once",
          childRunId: "run_mqzd1c1b30yc24hj",
          role: "python worker",
          foregroundTimeoutMs: 30_000,
          nextAction: {
            tool: "task",
            action: "wait",
            taskId: "task_mqzd1c1b30yc24hj",
          },
          duplicateAvoidance: "Do not spawn it again.",
        },
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).not.toContain("spawn_agent");
    expect(text).not.toContain("python worker");
    expect(text).not.toContain("parent will wait");
    expect(text).not.toContain('"parentWillWait"');
    expect(text).not.toContain('"nextAction"');
  });

  it("renders task receipts as lifecycle summaries", async () => {
    const events = [
      ev("tool.completed", 1, {
        toolName: "task_create",
        output: {
          taskId: "task_mqzd1c1b30yc24hj",
          mode: "awaited",
          awaited: true,
          actualMode: "awaited",
          parentWillWait: true,
          completionObservation: "automatic_once",
          duplicateAvoidance: "Do not create it again.",
        },
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("task task_mqzd1c1b30yc24hj · awaited");
    expect(text).not.toContain("parent will wait");
    expect(text).not.toContain('"completionObservation"');
  });

  it("summarizes background task lifecycle without printing every output event", async () => {
    const events = [
      ev("task.started", 1, {
        taskId: "task_mqzd1c1b30yc24hj",
        kind: "shell.background",
        command: "node bg-task.js",
      }),
      ev("task.output", 2, {
        taskId: "task_mqzd1c1b30yc24hj",
        channel: "stdout",
        data: "bg-task-tick 1\n",
      }),
      ev("task.output", 3, {
        taskId: "task_mqzd1c1b30yc24hj",
        channel: "stdout",
        data: "bg-task-tick 2\n",
      }),
      ev(
        "task.completed",
        4,
        {
          taskId: "task_mqzd1c1b30yc24hj",
          kind: "shell.background",
          command: "node bg-task.js",
          result: { exitCode: 0 },
          progressCount: 2,
        },
        { durationMs: 2100 },
      ),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("background task started");
    expect(text).toContain("task_mqzd...yc24hj");
    expect(text).toContain("ctrl+o activity");
    expect(text).toContain("task completed");
    expect(text).toContain("exit 0");
    expect(text).toContain("2 chunks");
    expect(text).not.toContain("[  2] task.output");
    expect(text).not.toContain("bg-task-tick 1");
    expect(text).not.toContain("bg-task-tick 2");
  });

  it("summarizes task tool requests and results instead of raw JSON", async () => {
    const events = [
      ev("tool.requested", 1, {
        toolName: "task",
        arguments: {
          action: "output",
          taskId: "task_mqzd1c1b30yc24hj",
          fromSequence: 0,
          maxChunks: 10,
        },
      }),
      ev("tool.completed", 2, {
        toolName: "task",
        output: {
          chunks: [
            {
              taskId: "task_mqzd1c1b30yc24hj",
              sequence: 0,
              channel: "stdout",
              data: "bg-task-done\n",
            },
          ],
          nextSequence: 1,
          complete: true,
          status: "completed",
          stalled: false,
        },
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("⚙ task  output task_mqzd...yc24hj");
    expect(text).toContain("task output task_mqzd...yc24hj");
    expect(text).toContain("1 chunk · completed");
    expect(text).toContain("bg-task-done");
    expect(text).not.toContain('"chunks"');
    expect(text).not.toContain('"fromSequence"');
  });

  it("renders run facts from committed events after run completion", async () => {
    const events = [
      ev("run.started", 1, {}),
      ev("approval.requested", 2, {
        id: "approval_1",
        runId: "run_fact",
        action: "tool.execute",
        summary: "Run tool bash",
      }),
      ev("approval.resolved", 3, {
        approvalId: "approval_1",
        runId: "run_fact",
        decision: "approved",
      }),
      ev("tool.requested", 4, {
        toolName: "bash",
        arguments: {
          command: "npm test",
        },
      }),
      ev("tool.completed", 5, {
        toolName: "bash",
        output: {
          stdout: "tests passed\n",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      }),
      ev("workspace.write.completed", 6, {
        path: "src/cart.js",
      }),
      ev("run.completed", 7, {
        reason: "final_answer",
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("summary");
    expect(text).toContain("changed 1 file");
    expect(text).toContain("approval approved · Run tool bash");
    expect(text).not.toContain("summary approvals");
    expect(text).toContain("last command: npm test passed");
  });

  it("renders only the Stop-accepted final message", async () => {
    const text = await renderToText(
      stream([
        ev("model.completed", 1, { message: "provisional answer" }),
        ev("workflow_hook.completed", 2, {
          hook: "Stop",
          status: "advanced",
        }),
        ev("model.completed", 3, { message: "accepted answer" }),
        ev("run.completed", 4, {
          reason: "final_answer",
          message: "accepted answer",
        }),
      ]),
    );

    expect(text).not.toContain("provisional answer");
    expect(text.match(/accepted answer/g)).toHaveLength(1);
    expect(text.match(/assistant/g)).toHaveLength(1);
  });

  it("does not call a background handoff a completed command in run facts", async () => {
    const text = await renderToText(
      stream([
        ev("run.started", 1, {}),
        ev("tool.requested", 2, {
          toolName: "bash",
          arguments: { command: "python3 -u print_numbers.py" },
        }),
        ev("tool.completed", 3, {
          toolName: "bash",
          output: {
            stdout: "",
            stderr: "",
            exitCode: null,
            timedOut: false,
            background: true,
            taskId: "task_background",
          },
        }),
        ev("run.completed", 4, { reason: "final_answer" }),
      ]),
    );

    expect(text).not.toContain("summary");
    expect(text).not.toContain("last command:");
    expect(text).not.toContain("print_numbers.py completed");
  });

  it("uses the canonical terminal assessment when live command details are absent", async () => {
    const text = await renderToText(
      stream([
        ev("run.started", 1, {}),
        ev("tool.completed", 2, {
          toolName: "bash",
          output: { exitCode: 1, timedOut: false },
        }),
        ev("run.completed", 3, {
          reason: "final_answer",
          assessment: {
            schemaVersion: "run-assessment.v1",
            health: "failing",
            issues: [
              {
                code: "VERIFICATION_FAILED",
                kind: "verification_failure",
                disposition: "failing",
                count: 1,
                details: {
                  lastCommand: "npm test",
                  lastExitCode: 1,
                },
              },
            ],
            verification: [
              {
                id: "command:npm-test",
                source: "command",
                status: "failed",
                command: "npm test",
                exitCode: 1,
              },
            ],
          },
        }),
      ]),
    );

    expect(text).toContain("last command: npm test failed");
    expect(text).toContain("health failing (VERIFICATION_FAILED)");
  });

  it("renders terminal task updates that arrive during final model generation", async () => {
    const text = await renderToText(
      stream([
        ev("run.started", 1, {}),
        ev("model.requested", 2, { step: 1 }),
        ev(
          "task.completed",
          3,
          {
            taskId: "task_mqzd1c1b30yc24hj",
            result: { exitCode: 0 },
            progressCount: 10,
          },
          { durationMs: 10_000 },
        ),
        ev("model.completed", 4, { message: "Task is running." }),
        ev("run.completed", 5, { reason: "final_answer" }),
      ]),
    );

    expect(text).toContain("runtime update");
    expect(text).toContain("task_mqzd...yc24hj · completed · exit 0");
    expect(text).toContain("10 chunks · 10s");
  });

  it("renders task cancellation updates as warnings rather than errors", async () => {
    const text = await renderToText(
      stream([
        ev("run.started", 1, {}),
        ev("model.requested", 2, { step: 1 }),
        ev("task.cancelled", 3, {
          taskId: "task_cancelled",
          result: { exitCode: null },
        }),
        ev("model.completed", 4, { message: "Stopped." }),
        ev("run.completed", 5, { reason: "final_answer" }),
      ]),
    );

    expect(text).toContain("runtime update");
    expect(taskTerminalTone("cancelled")).toBe("warning");
    expect(taskTerminalTone("failed")).toBe("error");
  });

  it("renders failed run completion messages from canonical failure payloads", async () => {
    const text = await renderToText(
      stream([
        ev("run.completed", 1, {
          state: "failed",
          stopReason: "model_auth_failed",
          failure: {
            category: "model",
            code: "MODEL_COMPLETION_FAILED",
            message: "invalid API key",
          },
        }),
      ]),
    );

    expect(text).toContain("run failed: invalid API key");
    expect(text).not.toContain("MODEL_COMPLETION_FAILED");
  });

  it("renders canonical run.failed failure messages", async () => {
    const text = await renderToText(
      stream([
        ev("run.failed", 1, {
          runId: "run_1",
          failure: {
            code: "internal_error",
            message: "host failed",
          },
        }),
      ]),
    );

    expect(text).toContain("run failed: host failed");
  });

  it("commits one terminal Agent summary and keeps abnormal outcomes visible", async () => {
    const events = [
      ev(
        "subagent.requested",
        1,
        {
          goal: "audit docs",
          childRunId: "run_child_1234567890",
          parentRunId: "run_parent",
        },
        {
          agentName: "reviewer",
          agentId: "reviewer",
          delegateTool: "delegate_review",
          entrypoint: "delegate",
          subagentDepth: 1,
          childRunId: "run_child_1234567890",
          parentRunId: "run_parent",
        },
      ),
      ev(
        "subagent.completed",
        2,
        {
          terminalState: "step_limit",
          stepLimitReached: true,
          childRunId: "run_child_1234567890",
          parentRunId: "run_parent",
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
        {
          agentName: "reviewer",
          agentId: "reviewer",
          delegateTool: "delegate_review",
          entrypoint: "delegate",
          subagentDepth: 1,
          childRunId: "run_child_1234567890",
          parentRunId: "run_parent",
        },
      ),
      ev(
        "subagent.requested",
        3,
        {
          goal: "nested check",
          childRunId: "run_nested",
          parentRunId: "run_child_1234567890",
        },
        {
          agentName: "nested",
          entrypoint: "spawn_agent",
          subagentDepth: 2,
          childRunId: "run_nested",
          parentRunId: "run_child_1234567890",
        },
      ),
    ];

    const text = await renderToText(stream(events), 220);

    expect(text).toContain("└─ Agent · reviewer partial");
    expect(text).toContain("1 tool failure remained unresolved");
    expect(text).not.toContain("UNRESOLVED_TOOL_FAILURE");
    expect(text).toContain("Ctrl+T 查看详情");
    expect(text).not.toContain("reviewer requested");
    expect(text).not.toContain("audit docs");
    expect(text).not.toContain("nested check");
    expect(text).not.toContain("delegate_review");
    expect(text).not.toContain("subagent");
    expect(text).not.toContain('"terminalState"');
  });

  it("does not commit queued CJK Agent lifecycle rows", async () => {
    const text = await renderToText(
      stream([
        ev(
          "subagent.requested",
          1,
          {
            goal: "在当前工作区创建脚本并依次执行编译和运行验证。",
            childRunId: "run_ms04hbysag6t4s",
            parentRunId: "run_ms04hbys1owv1e",
          },
          {
            agentName: "创建并验证定时打印脚本",
            entrypoint: "spawn_agent",
            delegateTool: "spawn_agent",
            subagentDepth: 1,
            childRunId: "run_ms04hbysag6t4s",
            parentRunId: "run_ms04hbys1owv1e",
          },
        ),
      ]),
      80,
    );

    expect(text).not.toContain("创建并验证定时打印脚本");
    expect(text).not.toContain(
      "在当前工作区创建脚本并依次执行编译和运行验证。",
    );
  });

  it("hides profile preparation and intermediate Agent lifecycle rows", async () => {
    const events = [
      ev("agent.profile.derived", 1, {
        parentAgentId: "main",
        childAgentId: "reviewer",
        effectiveToolCount: 4,
      }),
      ev(
        "subagent.requested",
        2,
        { goal: "review the patch" },
        { agentName: "reviewer", subagentDepth: 0 },
      ),
      ev(
        "subagent.started",
        3,
        {},
        { agentName: "reviewer", subagentDepth: 0 },
      ),
      ev(
        "subagent.completed",
        4,
        { terminalState: "completed" },
        { agentName: "reviewer", subagentDepth: 0 },
      ),
    ];

    const text = await renderToText(stream(events));

    expect(text).not.toContain("main → reviewer");
    expect(text).not.toContain("reviewer profile");
    expect(text).not.toContain("4 tools");
    expect(text).not.toContain("reviewer requested");
    expect(text).not.toContain("reviewer started");
    expect(text).toContain("└─ Agent · reviewer completed");
    expect(text).not.toContain("completed · completed");
  });

  it("does not replay a child run final answer into compact scrollback", async () => {
    const events: RunEvent[] = [
      {
        ...ev(
          "subagent.requested",
          1,
          {
            childRunId: "run_child",
            parentRunId: "run_parent",
            goal: "inspect the file",
          },
          {
            childRunId: "run_child",
            parentRunId: "run_parent",
            agentName: "reviewer",
            subagentDepth: 1,
          },
        ),
        runId: "run_parent",
      },
      {
        ...ev("run.completed", 2, {
          state: "completed",
          message: "Full child-only answer.",
        }),
        runId: "run_child",
      },
      {
        ...ev(
          "subagent.completed",
          3,
          {
            childRunId: "run_child",
            parentRunId: "run_parent",
            status: "completed",
            summary: "Child finished.",
            blockers: [],
          },
          {
            childRunId: "run_child",
            parentRunId: "run_parent",
            agentName: "reviewer",
            subagentDepth: 1,
          },
        ),
        runId: "run_parent",
      },
      {
        ...ev("run.completed", 4, {
          state: "completed",
          message: "Main answer.",
        }),
        runId: "run_parent",
      },
    ];

    const text = await renderToText(stream(events));
    expect(text).toContain("└─ Agent · reviewer completed");
    expect(text).toContain("Main answer.");
    expect(text).not.toContain("Full child-only answer.");
  });

  it("renders a sole run.cancelled terminal without leaking state-machine events", async () => {
    const events = [
      ev("run.cancelled", 1, { reason: "user_cancelled" }),
      ev("run.cancel_requested", 2, {}),
      ev("run.state_transition.rejected", 3, {}),
    ];
    const text = await renderToText(stream(events));
    // Internal event names stay hidden while the terminal gets one footer.
    expect(text).not.toContain("run.cancelled");
    expect(text).not.toContain("cancel_requested");
    expect(text).not.toContain("state_transition");
    expect(text.match(/run cancelled/g)).toHaveLength(1);
    expect(text).toContain("user_cancelled");
  });

  it("suppresses internal run budget events", async () => {
    const text = await renderToText(
      stream([
        ev("run.budget.checked", 1, {
          requested: { modelCalls: 1 },
          remaining: { modelCalls: 4 },
        }),
        ev("run.budget.exceeded", 2, {
          source: "revival",
          used: 0,
          limit: 0,
        }),
      ]),
    );
    expect(text).not.toContain("run.budget.checked");
    expect(text).not.toContain("run.budget.exceeded");
    expect(text).not.toContain("modelCalls");
    expect(text).not.toContain("revival");
  });

  it("suppresses successful workflow hook machinery", async () => {
    const events = [
      ev("workflow_hook.started", 1, {
        name: "project-operating-rules",
      }),
      ev("workflow_hook.completed", 2, {
        name: "project-operating-rules",
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).not.toContain("workflow_hook");
    expect(text).not.toContain("project-operating-rules");
  });
});
