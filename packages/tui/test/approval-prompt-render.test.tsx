import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink";
import { ApprovalPrompt } from "../src/components/approval-prompt.js";
import type { PendingApproval } from "../src/state/event-store.js";

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
  it("renders the final prepared Skill diff before effect-bound approval", async () => {
    const pending: PendingApproval = {
      id: "approval_skill",
      action: "skill.apply",
      kind: "skill.apply",
      summary: "Create Skill repo-review",
      path: ".sparkwright/skills/repo-review",
      diff: [
        "--- /dev/null",
        "+++ b/.sparkwright/skills/repo-review/SKILL.md",
        "+Inspect the diff.",
      ].join("\n"),
      subject: { kind: "unknown" },
    };

    const text = await renderToText(
      <ApprovalPrompt pending={pending} onDecision={() => {}} />,
    );

    expect(text).toContain("Create Skill repo-review");
    expect(text).toContain(".sparkwright/skills/repo-review");
    expect(text).toContain("final prepared effect");
    expect(text).toContain("Inspect the diff.");
    expect(text).not.toContain("Allow for this session");
  });

  it("renders shell tool approvals as command details instead of raw JSON", async () => {
    const pending: PendingApproval = {
      id: "approval_1",
      action: "tool.execute",
      kind: "tool.execute",
      summary: "Run tool shell",
      toolName: "shell",
      toolArgs: {
        command: "npm test",
        timeoutMs: 120000,
        cwd: "/tmp/sparkwright-tui-coding.fixture",
      },
      subject: {
        kind: "shell",
        command: "npm test",
        cwd: "/tmp/sparkwright-tui-coding.fixture",
        key: "shell:test",
        rememberLabel: "Allow this exact command here for this session",
      },
      policy: {
        risk: "risky",
        reason: "Tools with write side effects require approval for this run.",
      },
    };
    const text = await renderToText(
      <ApprovalPrompt pending={pending} onDecision={() => {}} />,
    );
    expect(text).toContain("$ npm test");
    expect(text).toContain("cwd: /tmp/sparkwright-tui-coding.fixture");
    expect(text).toContain("timeout: 120000ms");
    expect(text).toContain(
      "reason: Tools with write side effects require approval for this run.",
    );
    expect(text).not.toContain('{"command"');
    expect(text).toContain("Allow once");
    expect(text).toContain("Allow this exact command here for this session");
    expect(text).toContain("Deny");
  });

  it("uses up/down for vertical choices and Enter to confirm", async () => {
    const onDecision = vi.fn();
    const pending: PendingApproval = {
      id: "approval_keys",
      action: "tool.execute",
      kind: "tool.execute",
      summary: "Run tool shell",
      toolName: "shell",
      toolArgs: { command: "npm test" },
      subject: {
        kind: "shell",
        command: "npm test",
        cwd: "/tmp/project",
        key: "shell:keys",
        rememberLabel: "Allow this exact command here for this session",
      },
    };

    await renderToText(
      <ApprovalPrompt pending={pending} onDecision={onDecision} />,
      80,
      ["\u001b[B", "\r"],
    );

    expect(onDecision).toHaveBeenCalledWith("allow-session");
  });
});
