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
async function renderToText(element: React.ReactElement): Promise<string> {
  const writes: string[] = [];
  const fakeStdout = {
    columns: 120,
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

function ev(type: string, sequence: number, payload?: unknown): RunEvent {
  return { type, sequence, id: String(sequence), payload };
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
});
