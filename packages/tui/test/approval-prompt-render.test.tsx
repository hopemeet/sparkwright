import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import { ApprovalPrompt } from "../src/components/approval-prompt.js";
import type { PendingApproval } from "../src/state/event-store.js";

async function renderToText(
  element: React.ReactElement,
  columns = 80,
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
  const fakeStdin = {
    isTTY: true,
    setRawMode() {},
    setEncoding() {},
    addListener() {},
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

describe("ApprovalPrompt rendering", () => {
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
  });
});
