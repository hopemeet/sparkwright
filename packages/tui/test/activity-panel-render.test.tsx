import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import { ActivityPanel } from "../src/components/activity-panel.js";
import type { RunEvent } from "../src/lib/event-type.js";
import type {
  TaskOutputChunkSnapshot,
  TaskRecordSnapshot,
} from "@sparkwright/protocol";

async function renderToText(element: React.ReactElement): Promise<string> {
  const writes: string[] = [];
  const fakeStdout = {
    columns: 120,
    rows: 30,
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
  await new Promise((resolve) => setTimeout(resolve, 30));
  unmount();
  return writes
    .join("")
    .replace(
      new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g"),
      "",
    );
}

function ev(type: string, sequence: number, payload?: unknown): RunEvent {
  return { type, sequence, id: String(sequence), payload };
}

describe("ActivityPanel", () => {
  it("renders background task status and output tail", async () => {
    const events = [
      ev("task.started", 1, {
        taskId: "task_mqzd1c1b30yc24hj",
        kind: "shell.promoted",
        command: "node bg-task.js",
        cwd: "/repo",
      }),
      ev("task.output", 2, {
        taskId: "task_mqzd1c1b30yc24hj",
        channel: "stdout",
        data: "bg-task-tick 1\n",
      }),
    ];

    const text = await renderToText(
      <ActivityPanel
        events={events}
        initialTab="tasks"
        onClose={() => {}}
        onJoinTask={() => {}}
        onPromoteTask={() => {}}
      />,
    );

    expect(text).toContain("activity");
    expect(text).toContain("[tasks]");
    expect(text).toContain("session tasks");
    expect(text).toContain("task_mqzd...yc24hj");
    expect(text).toContain("running");
    expect(text).toContain("awaited");
    expect(text).toContain("w join");
    expect(text).toContain("p promote");
    expect(text).toContain("node bg-task.js");
    expect(text).toContain("bg-task-tick 1");
    expect(text).not.toContain('"taskId"');
  });

  it("renders durable task snapshots without raw protocol JSON", async () => {
    const taskRecords: TaskRecordSnapshot[] = [
      {
        id: "task_durable123456789",
        parentRunId: "run_1",
        kind: "shell.promoted",
        status: "completed",
        awaited: false,
        createdAt: "2026-06-30T00:00:00.000Z",
        outputChunks: 12,
        outputBytes: 111,
        metadata: { command: "node durable.js", cwd: "/repo" },
      },
    ];
    const chunks: TaskOutputChunkSnapshot[] = Array.from(
      { length: 12 },
      (_, index) => ({
        taskId: "task_durable123456789",
        sequence: index,
        timestamp: `2026-06-30T00:00:${String(index).padStart(2, "0")}.000Z`,
        channel: "stdout",
        data: `durable-row-${String(index + 1).padStart(2, "0")}\n`,
      }),
    );

    const text = await renderToText(
      <ActivityPanel
        events={[]}
        taskRecords={taskRecords}
        taskOutputs={{ task_durable123456789: chunks }}
        initialTab="tasks"
        onClose={() => {}}
      />,
    );

    expect(text).toContain("task_dura...456789");
    expect(text).toContain("completed");
    expect(text).toContain("detached");
    expect(text).toContain("node durable.js");
    expect(text).toContain("durable-row-12");
    expect(text).not.toContain("durable-row-01");
    expect(text).not.toContain('"chunks"');
  });

  it("bounds event browsing to the latest event window", async () => {
    const events = Array.from({ length: 505 }, (_, index) =>
      ev("tool.requested", index + 1, {
        toolName: "read",
        preview: `event-${index + 1}`,
      }),
    );

    const text = await renderToText(
      <ActivityPanel events={events} initialTab="events" onClose={() => {}} />,
    );

    expect(text).toContain("latest 500");
    expect(text).toContain("[  6]");
    expect(text).not.toContain("[  1]");
  });
});
