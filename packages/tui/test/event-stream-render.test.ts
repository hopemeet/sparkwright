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
