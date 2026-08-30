import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import {
  SessionListDialog,
  sessionWindow,
} from "../src/components/session-list-dialog.js";
import type {
  SessionDiagnostics,
  SessionSummary,
} from "../src/lib/sessions.js";

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

  it("renders the effective session root in the empty state", async () => {
    const text = await renderToText(
      <SessionListDialog
        sessions={[]}
        sessionRootLabel="/tmp/sparkwright-tui-sessions"
        labels={{}}
        diagnostics={null}
        loadingDiagnosticsFor={null}
        onCancel={() => {}}
        onInspect={() => {}}
        onPick={() => {}}
        onRename={() => {}}
      />,
    );

    expect(text).toContain("none found in /tmp/sparkwright-tui-sessions");
    expect(text).not.toContain(".sparkwright/sessions");
  });

  it("renders compaction diagnostics when inspection includes them", async () => {
    const diagnostics: SessionDiagnostics = {
      sessionId: "session_a",
      summary: {
        eventCount: 12,
        runIds: ["run_a"],
        agentIds: ["main"],
        subagentIds: [],
        errorCount: 0,
        artifactCount: 1,
        usage: { totalTokens: 42 },
      },
      consistency: { ok: true, findings: [] },
      timeline: { durationMs: 25, phases: [] },
      compaction: {
        status: "compacted",
        artifact: {
          path: "/workspace/.sparkwright/sessions/session_a/compact.json",
          schemaVersion: "session-compact.v2",
          createdAt: "2026-06-22T00:00:00.000Z",
          throughRunId: "run_a",
          compactedRunCount: 1,
          sourceRunIds: ["run_a"],
          originalCharCount: 1000,
          summaryCharCount: 250,
          freedChars: 750,
          measurement: {
            sourceRunCount: 1,
            originalCharCount: 1000,
            summaryCharCount: 250,
            freedChars: 750,
            savingsRatio: 0.75,
            freedByTier: { summarize: 750 },
            regime: "density_bound",
            signalCount: 2,
          },
          warningCodes: ["SESSION_SUMMARIZER_DETERMINISTIC_PREVIEW"],
        },
        events: [],
        latestEvent: {
          sequence: 3,
          timestamp: "2026-06-22T00:00:01.000Z",
          type: "session.compaction.completed",
          compactedRunCount: 1,
          throughRunId: "run_a",
          originalCharCount: 1000,
          summaryCharCount: 250,
          freedChars: 750,
          artifactPath:
            "/workspace/.sparkwright/sessions/session_a/compact.json",
          warningCodes: ["SESSION_SUMMARIZER_DETERMINISTIC_PREVIEW"],
        },
        consistency: {
          ok: true,
          artifactMatchesLatestCompletedEvent: true,
          findings: [],
        },
      },
    };

    const text = await renderToText(
      <SessionListDialog
        sessions={[session("session_a", "first task", 2000)]}
        labels={{}}
        diagnostics={diagnostics}
        loadingDiagnosticsFor={null}
        onCancel={() => {}}
        onInspect={() => {}}
        onPick={() => {}}
        onRename={() => {}}
      />,
    );

    expect(text).toContain("compaction compacted consistency ok");
    expect(text).toContain("compact 1 run(s), freed 750 chars");
    expect(text).toContain("regime density_bound savings 75%");
    expect(text).toContain("latest completed #3");
    expect(text).toContain("warnings SESSION_SUMMARIZER_DETERMINISTIC_PREVIEW");
    expect(text).not.toContain("Session deterministic-summary preview.");
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
