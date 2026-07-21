import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink";
import { ApprovalPrompt } from "../src/components/approval-prompt.js";
import type { PendingApproval } from "../src/state/event-store.js";

function pending(
  input: Partial<PendingApproval> &
    Pick<
      PendingApproval,
      "approvalId" | "action" | "kind" | "summary" | "subject"
    >,
): PendingApproval {
  return {
    risk: "medium",
    exactScope: "one exact request",
    executionKind: "main",
    runId: "run_1",
    sessionId: "session_1",
    queuePosition: 1,
    queueDepth: 1,
    resolving: false,
    createdAt: "2026-07-19T00:00:00.000Z",
    ...input,
  };
}

async function renderToText(
  element: React.ReactElement,
  columns = 80,
  inputs: string[] = [],
): Promise<string> {
  const writes: string[] = [];
  const fakeStdout = {
    columns,
    rows: 24,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const fakeStdin = new PassThrough() as NodeJS.ReadStream & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  fakeStdin.isTTY = true;
  fakeStdin.setRawMode = () => {};
  fakeStdin.ref = () => {};
  fakeStdin.unref = () => {};
  const { unmount } = render(element, {
    stdout: fakeStdout,
    stdin: fakeStdin,
    patchConsole: false,
  });
  await new Promise((r) => setTimeout(r, 30));
  for (const input of inputs) {
    fakeStdin.write(input);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 30));
  unmount();
  fakeStdin.destroy();
  // eslint-disable-next-line no-control-regex
  return writes.join("").replace(/\[[0-9;?]*[a-zA-Z]/g, "");
}

describe("ApprovalPrompt rendering", () => {
  it("offers an explicit session shortcut only for stable subjects", async () => {
    const sessionDecision = vi.fn();
    const stable = pending({
      approvalId: "approval_stable",
      action: "tool.execute",
      kind: "shell.execute",
      risk: "high",
      summary: "Run tests",
      subject: {
        kind: "shell_command",
        command: "npm test",
        cwd: "/workspace",
        key: "shell:test",
        label: "Allow this command for this session",
      },
    });
    const stableText = await renderToText(
      <ApprovalPrompt pending={stable} onDecision={sessionDecision} />,
      80,
      ["s"],
    );

    expect(stableText).toContain("s session");
    expect(sessionDecision).toHaveBeenCalledWith("allow-session");

    const oneShotDecision = vi.fn();
    const oneShotText = await renderToText(
      <ApprovalPrompt
        pending={pending({
          approvalId: "approval_once",
          action: "tool.execute",
          kind: "tool.execute",
          summary: "Run an opaque tool",
          subject: { kind: "one_shot", label: "Allow once" },
        })}
        onDecision={oneShotDecision}
      />,
      80,
      ["s"],
    );
    expect(oneShotText).not.toContain("s session");
    expect(oneShotDecision).not.toHaveBeenCalled();
  });

  it("renders the final prepared Skill diff before effect-bound approval", async () => {
    const view = pending({
      approvalId: "approval_skill",
      action: "skill.apply",
      kind: "skill.apply",
      risk: "high",
      summary: "Create Skill repo-review",
      path: ".sparkwright/skills/repo-review",
      diff: [
        "--- /dev/null",
        "+++ b/.sparkwright/skills/repo-review/SKILL.md",
        "+Inspect the diff.",
      ].join("\n"),
      subject: { kind: "one_shot", label: "Allow this Skill effect once" },
      exactScope: "one-shot request",
    });

    const text = await renderToText(
      <ApprovalPrompt pending={view} onDecision={() => {}} />,
    );

    expect(text).toContain("Create Skill repo-review");
    expect(text).toContain(".sparkwright/skills/repo-review");
    expect(text).toContain("final prepared Skill effect");
    expect(text).toContain("Inspect the diff.");
    expect(text).not.toContain("Allow for this session");
  });

  it("renders a workspace-write diff summary and target", async () => {
    const view = pending({
      approvalId: "approval_write",
      action: "workspace.write",
      kind: "workspace.write",
      risk: "medium",
      summary: "Update two workspace files",
      path: "packages/tui",
      diff: [
        "--- a/packages/tui/src/a.ts",
        "+++ b/packages/tui/src/a.ts",
        "-old",
        "+new",
        "--- a/packages/tui/src/b.ts",
        "+++ b/packages/tui/src/b.ts",
        "+added",
      ].join("\n"),
      diffSummary: {
        files: ["packages/tui/src/a.ts", "packages/tui/src/b.ts"],
        additions: 2,
        deletions: 1,
      },
      subject: {
        kind: "workspace_file",
        operation: "write",
        path: "packages/tui",
        key: "write:tui",
        label: "Allow writes to packages/tui for this session",
      },
      exactScope: "write workspace path packages/tui",
    });

    const text = await renderToText(
      <ApprovalPrompt pending={view} onDecision={() => {}} />,
      96,
    );
    expect(text).toContain("workspace write");
    expect(text).toContain("target: packages/tui");
    expect(text).toContain("2 files · +2 -1");
    expect(text).toContain("packages/tui/src/a.ts");
  });

  it("renders shell tool approvals as command details instead of raw JSON", async () => {
    const view = pending({
      approvalId: "approval_1",
      action: "tool.execute",
      kind: "shell.execute",
      risk: "high",
      summary: "Run tool bash",
      toolName: "bash",
      toolArgs: {
        command: "npm test",
        timeoutMs: 120000,
        cwd: "/tmp/sparkwright-tui-coding.fixture",
      },
      subject: {
        kind: "shell_command",
        command: "npm test",
        cwd: "/tmp/sparkwright-tui-coding.fixture",
        key: "shell:test",
        label: "Allow this exact command here for this session",
      },
      policyReason:
        "Tools with write side effects require approval for this run.",
      exactScope: "exact command + cwd /tmp/sparkwright-tui-coding.fixture",
    });
    const text = await renderToText(
      <ApprovalPrompt pending={view} onDecision={() => {}} />,
    );
    expect(text).toContain("$ npm test");
    expect(text).toContain("cwd: /tmp/sparkwright-tui-coding.fixture");
    expect(text).toContain(
      "reason: Tools with write side effects require approval for this run.",
    );
    expect(text).not.toContain('{"command"');
    expect(text).toContain("Allow once");
    expect(text).toContain("Allow this exact command here for this session");
    expect(text).toContain("Deny");
    expect(text).toContain("› Deny");
  });

  it("wraps long shell effects without ellipsis and shows execution origin", async () => {
    const command = `node scripts/release-check.mjs --workspace ${"nested/".repeat(10)}package --verify-protocol --verify-traces`;
    const view = pending({
      approvalId: "approval_long_shell",
      action: "tool.execute",
      kind: "shell.execute",
      risk: "high",
      summary: "Run release verification",
      command,
      cwd: "/workspace/sparkwright/packages/tui",
      executionKind: "workflow",
      workflowId: "workflow_release",
      runId: "run_release",
      sessionId: "session_release",
      queuePosition: 1,
      queueDepth: 3,
      subject: {
        kind: "shell_command",
        command,
        cwd: "/workspace/sparkwright/packages/tui",
        key: "shell:release",
        label: "Allow this exact command here for this session",
      },
    });

    const text = await renderToText(
      <ApprovalPrompt pending={view} onDecision={() => {}} />,
      96,
      ["d", "d"],
    );

    expect(text).toContain("origin: workflow workflow_release");
    expect(text).toContain("run run_release · session session_release");
    expect(text).toContain("1 of 3");
    expect(text).toContain("node scripts/release-check.mjs");
    expect(text).toContain("--verify-protocol --verify-traces");
    expect(text).not.toContain("…");
  });

  it("renders structured non-shell tool arguments", async () => {
    const view = pending({
      approvalId: "approval_tool",
      action: "tool.execute",
      kind: "tool.execute",
      risk: "medium",
      summary: "Post a structured request",
      toolName: "mcp.request",
      toolArgs: {
        server: "issues",
        request: { project: "SparkWright", labels: ["tui", "safety"] },
      },
      subject: {
        kind: "tool_call",
        toolName: "mcp.request",
        key: "tool:structured",
        label: "Allow these exact arguments for this session",
      },
    });

    const text = await renderToText(
      <ApprovalPrompt pending={view} onDecision={() => {}} />,
      96,
      ["d"],
    );
    expect(text).toContain("tool mcp.request arguments");
    expect(text).toContain('"project": "SparkWright"');
    expect(text).toContain('"tui"');
    expect(text).toContain("Allow these exact arguments for this session");
  });

  it("uses up/down for vertical choices and Enter to confirm", async () => {
    const onDecision = vi.fn();
    const view = pending({
      approvalId: "approval_keys",
      action: "tool.execute",
      kind: "shell.execute",
      risk: "low",
      summary: "Run tool bash",
      toolName: "bash",
      toolArgs: { command: "npm test" },
      subject: {
        kind: "shell_command",
        command: "npm test",
        cwd: "/tmp/project",
        key: "shell:keys",
        label: "Allow this exact command here for this session",
      },
    });

    await renderToText(
      <ApprovalPrompt pending={view} onDecision={onDecision} />,
      80,
      ["\u001b[B", "\r"],
    );

    expect(onDecision).toHaveBeenCalledWith("allow-session");
  });

  it("defaults unknown approvals to deny and suppresses duplicate resolving input", async () => {
    const onDecision = vi.fn();
    const unknown = pending({
      approvalId: "approval_unknown",
      action: "future.action",
      kind: "unknown",
      risk: "unknown",
      summary: "Unknown effect",
      subject: { kind: "one_shot", label: "Allow unknown effect once" },
      exactScope: "one-shot request",
    });
    await renderToText(
      <ApprovalPrompt pending={unknown} onDecision={onDecision} />,
      80,
      ["\r"],
    );
    expect(onDecision).toHaveBeenCalledWith("deny");

    onDecision.mockClear();
    await renderToText(
      <ApprovalPrompt pending={unknown} onDecision={onDecision} />,
      80,
      ["\u001b"],
    );
    expect(onDecision).toHaveBeenCalledWith("deny");

    onDecision.mockClear();
    await renderToText(
      <ApprovalPrompt
        pending={{ ...unknown, resolving: true, submittedChoice: "deny" }}
        onDecision={onDecision}
      />,
      80,
      ["y", "\r", "\u001b"],
    );
    expect(onDecision).not.toHaveBeenCalled();
  });
});
