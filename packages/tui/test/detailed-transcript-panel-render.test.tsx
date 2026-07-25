import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink";
import { DetailedTranscriptPanel } from "../src/components/detailed-transcript-panel.js";
import { parseChord } from "../src/lib/keybindings.js";
import type { RunEvent } from "../src/lib/event-type.js";

function event(type: string, sequence: number, payload?: unknown): RunEvent {
  return {
    id: `event_${sequence}`,
    runId: "run_1",
    type,
    sequence,
    payload,
  };
}

describe("DetailedTranscriptPanel", () => {
  it("opens at the tail and lets the canonical details chord close it", async () => {
    const writes: string[] = [];
    const stdout = {
      columns: 90,
      rows: 12,
      write: (value: string) => {
        writes.push(value);
        return true;
      },
      on() {},
      off() {},
      removeListener() {},
    } as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as NodeJS.ReadStream & {
      isTTY: boolean;
      setRawMode: () => void;
      ref: () => void;
      unref: () => void;
    };
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    stdin.ref = () => {};
    stdin.unref = () => {};
    const onClose = vi.fn();
    const events = [
      event("tui.user", -1, { goal: "inspect output" }),
      event("run.started", 0, {}),
      ...Array.from({ length: 10 }, (_, index) =>
        event("model.assistant_text", index + 1, {
          message: index === 0 ? "oldest-detail" : `detail-${index + 1}`,
        }),
      ),
    ];
    const instance = render(
      <DetailedTranscriptPanel
        events={events}
        todoItems={[]}
        toggleChords={[parseChord("ctrl+t")!]}
        onClose={onClose}
      />,
      {
        stdout,
        stdin,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write("\x14");
    await new Promise((resolve) => setTimeout(resolve, 40));
    instance.unmount();
    stdin.destroy();

    // eslint-disable-next-line no-control-regex
    const text = writes.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, "");
    expect(text).toContain("details · current run");
    expect(text).toContain("detail-10");
    expect(text).not.toContain("oldest-detail");
    expect(text).toContain("following");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
