import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import { StatusBar } from "../src/components/status-bar.js";
import type { StoreState } from "../src/state/event-store.js";

async function renderToText(
  element: React.ReactElement,
  columns = 120,
): Promise<string> {
  const writes: string[] = [];
  const fakeStdout = {
    columns,
    rows: 10,
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
  await new Promise((resolve) => setTimeout(resolve, 30));
  unmount();
  return writes
    .join("")
    .replace(
      new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g"),
      "",
    );
}

function state(partial: Partial<StoreState>): StoreState {
  return {
    status: "idle",
    events: [],
    pendingApproval: null,
    lastError: null,
    stopReason: null,
    streamingText: "",
    reasoningText: "",
    sessionId: null,
    runStartedAt: null,
    runEndedAt: null,
    modifiedFiles: [],
    todoItems: [],
    usage: null,
    activePhase: null,
    clearGeneration: 0,
    ...partial,
  };
}

describe("StatusBar", () => {
  it("does not repeat the static SparkWright header brand", async () => {
    const text = await renderToText(
      <StatusBar
        state={state({ status: "running", runStartedAt: Date.now() })}
        modelLabel="openai/gpt-5.4-mini"
        permissionMode="ask"
        focused={true}
      />,
    );

    expect(text).toContain("running");
    expect(text).toContain("openai/gpt-5.4-mini");
    expect(text).toContain("ask");
    expect(text).not.toContain("SparkWright");
  });

  it("shows the active phase in place of the generic running label", async () => {
    const text = await renderToText(
      <StatusBar
        state={state({
          status: "running",
          runStartedAt: Date.now(),
          activePhase: {
            kind: "tool",
            message: "running shell",
            key: "tool:call_a",
            priority: 40,
            depth: 0,
            startedSeq: 1,
          },
        })}
        modelLabel="openai/gpt-5.4-mini"
        permissionMode="accept-edits"
        focused={true}
      />,
    );

    // The specific phase carries the one spinner line — no bare "running" word
    // on its own and no second spinner elsewhere.
    expect(text).toContain("running shell");
    expect(text).toContain("openai/gpt-5.4-mini");
    expect(text).toContain("accept-edits");
  });

  it("surfaces running background tasks with the activity shortcut", async () => {
    const text = await renderToText(
      <StatusBar
        state={state({
          status: "done",
          events: [
            {
              type: "task.started",
              sequence: 1,
              payload: {
                taskId: "task_mqzd1c1b30yc24hj",
                kind: "shell.promoted",
              },
            },
            {
              type: "workspace.write.untracked_access_granted",
              sequence: 2,
              payload: {
                taskId: "task_mqzd1c1b30yc24hj",
                protocol: "promoted_shell",
              },
            },
          ],
        })}
        modelLabel="openai/gpt-5.4-mini"
        permissionMode="ask"
        focused={true}
      />,
    );

    expect(text).toContain("tasks: 1 running");
    expect(text).toContain("untracked writes possible");
    expect(text).toContain("ctrl+o");
  });

  it("surfaces unread completed and failed task notifications", async () => {
    const text = await renderToText(
      <StatusBar
        state={state({ status: "done" })}
        modelLabel="openai/gpt-5.4-mini"
        permissionMode="ask"
        focused={true}
        unreadCompletedTasks={2}
        unreadFailedTasks={1}
      />,
    );

    expect(text).toContain("tasks: 1 failed unread, 2 completed unread");
    expect(text).toContain("ctrl+o");
  });

  it("does not present a cancelled task as failed", async () => {
    const text = await renderToText(
      <StatusBar
        state={state({ status: "done" })}
        modelLabel="openai/gpt-5.4-mini"
        permissionMode="ask"
        focused={true}
        unreadCancelledTasks={1}
      />,
    );

    expect(text).toContain("tasks: 1 cancelled unread");
    expect(text).not.toContain("failed unread");
  });

  it("uses deliberate status and task rows on narrow terminals", async () => {
    const text = await renderToText(
      <StatusBar
        state={state({
          status: "done",
          stopReason: "final_answer",
          usage: {
            totalTokens: 153_600,
            inputTokens: 150_000,
            outputTokens: 3_600,
            modelCalls: 17,
            toolCalls: 18,
          },
        })}
        modelLabel="anthropic/claude-sonnet-4-6"
        permissionMode="read-only"
        focused={true}
        unreadCancelledTasks={1}
      />,
      80,
    );

    const lines = text.split("\n");
    expect(lines.some((line) => line.includes("● done"))).toBe(true);
    expect(lines.some((line) => line.includes("claude-sonnet-4-6"))).toBe(true);
    expect(
      lines.some((line) => line.includes("tasks: 1 cancelled unread")),
    ).toBe(true);
    expect(text).not.toContain("final_answer");
    expect(text).not.toContain("153.6k");
  });
});
