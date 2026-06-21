import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import {
  ForkDialog,
  extractTurns,
  optionWindow,
} from "../src/components/fork-dialog.js";
import type { RunEvent } from "../src/lib/event-type.js";

function ev(type: string, sequence: number, payload?: unknown): RunEvent {
  return { type, sequence, payload };
}

/**
 * The fork picker forks at a host `run.started` sequence but labels the turn
 * with the goal. run.started.payload.goal is empty on some providers, so the
 * goal is paired from the preceding `tui.user` event (synthetic, negative seq).
 */
describe("extractTurns", () => {
  it("pairs each run.started sequence with the preceding tui.user goal", () => {
    const turns = extractTurns([
      ev("tui.user", -1, { goal: "first goal" }),
      ev("run.started", 10, {}),
      ev("tui.user", -2, { goal: "second goal" }),
      ev("run.started", 25, {}),
    ]);
    expect(turns).toEqual([
      { sequence: 10, goal: "first goal" },
      { sequence: 25, goal: "second goal" },
    ]);
  });

  it("prefers run.started.payload.goal when present", () => {
    const turns = extractTurns([
      ev("tui.user", -1, { goal: "from user event" }),
      ev("run.started", 10, { goal: "from run event" }),
    ]);
    expect(turns[0].goal).toBe("from run event");
  });

  it("falls back to (run) when no goal is available", () => {
    const turns = extractTurns([ev("run.started", 5, {})]);
    expect(turns).toEqual([{ sequence: 5, goal: "(run)" }]);
  });

  it("does not reuse a goal across two runs", () => {
    const turns = extractTurns([
      ev("tui.user", -1, { goal: "only goal" }),
      ev("run.started", 10, {}),
      ev("run.started", 20, {}),
    ]);
    expect(turns[0].goal).toBe("only goal");
    expect(turns[1].goal).toBe("(run)");
  });
});

describe("ForkDialog windowing", () => {
  it("centers the visible option window around the cursor", () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    expect(optionWindow(items, 10, 5)).toEqual({
      start: 8,
      visible: [8, 9, 10, 11, 12],
    });
  });

  it("does not render every turn in a small terminal", async () => {
    const events = Array.from({ length: 24 }, (_, index) => [
      ev("tui.user", -index - 1, { goal: `goal ${index}` }),
      ev("run.started", index + 1, {}),
    ]).flat();

    const text = await renderToText(
      React.createElement(ForkDialog, {
        events,
        onCancel: () => {},
        onFork: () => {},
      }),
    );

    expect(text).toContain("fork session");
    expect(text).toContain("Full session");
    expect(text).toContain("goal 0");
    expect(text).toContain("of 25");
    expect(text).not.toContain("goal 20");
  });
});

async function renderToText(element: React.ReactElement): Promise<string> {
  const writes: string[] = [];
  const fakeStdout = {
    columns: 100,
    rows: 12,
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
