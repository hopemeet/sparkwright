import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import { StatusBar } from "../src/components/status-bar.js";
import type { StoreState } from "../src/state/event-store.js";

async function renderToText(element: React.ReactElement): Promise<string> {
  const writes: string[] = [];
  const fakeStdout = {
    columns: 120,
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
        permissionMode="default"
        focused={true}
      />,
    );

    expect(text).toContain("running");
    expect(text).toContain("openai/gpt-5.4-mini");
    expect(text).toContain("default");
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
        permissionMode="default"
        focused={true}
      />,
    );

    // The specific phase carries the one spinner line — no bare "running" word
    // on its own and no second spinner elsewhere.
    expect(text).toContain("running shell");
    expect(text).toContain("openai/gpt-5.4-mini");
  });
});
