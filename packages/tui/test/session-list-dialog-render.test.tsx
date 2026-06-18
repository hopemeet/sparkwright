import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import {
  SessionListDialog,
  sessionWindow,
} from "../src/components/session-list-dialog.js";
import type { SessionSummary } from "../src/lib/sessions.js";

async function renderToText(element: React.ReactElement): Promise<string> {
  const writes: string[] = [];
  const fakeStdout = {
    columns: 80,
    rows: 18,
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
  await new Promise((resolve) => setTimeout(resolve, 60));
  unmount();
  // eslint-disable-next-line no-control-regex
  return writes.join("").replace(/\[[0-9;?]*[a-zA-Z]/g, "");
}

function session(id: string, preview: string, mtimeMs: number): SessionSummary {
  return { id, preview, mtimeMs };
}

describe("SessionListDialog rendering", () => {
  it("renders numbered sessions for fast resume", async () => {
    const text = await renderToText(
      <SessionListDialog
        sessions={[
          session("session_a", "first task", 2000),
          session("session_b", "second task", 1000),
        ]}
        labels={{ session_a: "Alpha" }}
        diagnostics={null}
        loadingDiagnosticsFor={null}
        onCancel={() => {}}
        onInspect={() => {}}
        onPick={() => {}}
        onRename={() => {}}
      />,
    );

    expect(text).toContain("sessions");
    expect(text).toContain("1-9 quick resume");
    expect(text).toContain("› 1 ");
    expect(text).toContain("Alpha");
    expect(text).toContain("second task");
  });

  it("keeps the selected session visible when navigating beyond the first page", () => {
    const sessions = Array.from({ length: 20 }, (_, i) =>
      session(`session_${i + 1}`, `task ${i + 1}`, i),
    );

    const page = sessionWindow(sessions, 15, 8);

    expect(page.start).toBe(11);
    expect(page.visible.map((s) => s.id)).toEqual([
      "session_12",
      "session_13",
      "session_14",
      "session_15",
      "session_16",
      "session_17",
      "session_18",
      "session_19",
    ]);
  });
});
