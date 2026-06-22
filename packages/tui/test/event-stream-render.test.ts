import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import {
  EventStream,
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
        toolName: "apply_patch",
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
        toolName: "apply_patch",
        arguments: {
          path: "src/cart.js",
          patch:
            "*** Begin Patch\n*** Update File: src/cart.js\n@@\n- old\n+ new\n*** End Patch",
        },
      }),
    ];
    const text = await renderToText(stream(events), 72);
    expect(text).toContain("› apply_patch");
    expect(text).not.toContain("›apply_patc");
  });

  it("renders shell tool requests as commands instead of raw JSON", async () => {
    const events = [
      ev("tool.requested", 1, {
        toolName: "shell",
        arguments: {
          command: "npm test",
          timeoutMs: 120000,
          cwd: "/tmp/project",
        },
      }),
    ];
    const text = await renderToText(stream(events), 72);
    expect(text).toContain("⚙ shell  $ npm test");
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
        toolName: "read_file",
        arguments: { path: "README.md", offset: 1, limit: 20 },
      }),
      ev("tool.requested", 3, {
        toolName: "glob",
        arguments: { patterns: ["packages/*/package.json"] },
      }),
    ];
    const text = await renderToText(stream(events), 100);
    expect(text).toContain("⚙ list_dir  . recursive");
    expect(text).toContain("⚙ read_file  README.md:1 +20");
    expect(text).toContain("⚙ glob  packages/*/package.json");
    expect(text).not.toContain('"recursive"');
    expect(text).not.toContain('"maxEntries"');
    expect(text).not.toContain('"patterns"');
  });

  it("renders capability mutations with action and compact path", async () => {
    const events = [
      ev("capability.mutation.completed", 1, {
        action: "write_text",
        path: "/tmp/project/.sparkwright/skill-evolution/proposals/p1/proposal.md",
        reason: "Write proposal markdown p1",
      }),
    ];
    const text = await renderToText(stream(events));
    expect(text).toContain("capability mutation");
    expect(text).toContain("write_text");
    expect(text).toContain(
      ".sparkwright/skill-evolution/proposals/p1/proposal.md",
    );
    expect(text).toContain("Write proposal markdown p1");
    expect(text).not.toContain('"action"');
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
        toolName: "shell",
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

  it("renders run facts from committed events after run completion", async () => {
    const events = [
      ev("run.started", 1, {}),
      ev("approval.requested", 2, {
        id: "approval_1",
        action: "tool.execute",
      }),
      ev("approval.resolved", 3, {
        approvalId: "approval_1",
        decision: "approved",
      }),
      ev("tool.requested", 4, {
        toolName: "shell",
        arguments: {
          command: "npm test",
        },
      }),
      ev("tool.completed", 5, {
        toolName: "shell",
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
    expect(text).toContain("run facts");
    expect(text).toContain("changed 1 file");
    expect(text).toContain("approvals 1/1");
    expect(text).toContain("tools 1");
    expect(text).toContain("last command: npm test passed");
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

  it("renders run.failed messages from legacy error projections", async () => {
    const text = await renderToText(
      stream([
        ev("run.failed", 1, {
          runId: "run_1",
          error: {
            code: "internal_error",
            message: "host failed",
          },
        }),
      ]),
    );

    expect(text).toContain("run failed: host failed");
  });

  it("renders subagent lifecycle as a depth-aware tree", async () => {
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

    const text = await renderToText(stream(events));

    expect(text).toContain("└─ reviewer requested");
    expect(text).toContain("depth 1");
    expect(text).toContain("via delegate_review");
    expect(text).toContain("audit docs");
    expect(text).toContain("reviewer completed · step_limit");
    expect(text).toContain("└─ nested requested");
    expect(text).toContain("depth 2");
    expect(text).toContain("spawn_agent");
    expect(text).not.toContain("subagent");
    expect(text).not.toContain('"terminalState"');
  });

  it("suppresses internal cancel/state-machine events but keeps the cancel card", async () => {
    const events = [
      ev("run.cancelled", 1, {}),
      ev("run.cancel_requested", 2, {}),
      ev("run.state_transition.rejected", 3, {}),
      ev("run.completed", 4, { state: "cancelled", reason: "user_cancelled" }),
    ];
    const text = await renderToText(stream(events));
    // none of the internal events leak as raw "[seq] type" debug rows
    expect(text).not.toContain("run.cancelled");
    expect(text).not.toContain("cancel_requested");
    expect(text).not.toContain("state_transition");
    // but the user-facing cancel card from run.completed is still shown
    expect(text).toContain("run cancelled");
  });

  it("suppresses internal run budget checks", async () => {
    const text = await renderToText(
      stream([
        ev("run.budget.checked", 1, {
          requested: { modelCalls: 1 },
          remaining: { modelCalls: 4 },
        }),
      ]),
    );
    expect(text).not.toContain("run.budget.checked");
    expect(text).not.toContain("modelCalls");
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
