import React from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import { TranscriptViewport } from "../src/components/transcript-viewport.js";
import type { TranscriptDocument } from "../src/lib/transcript-document.js";
import { layoutTranscriptDocument } from "../src/lib/transcript-layout.js";
import { ThemeProvider } from "../src/lib/theme-context.js";
import { DARK } from "../src/lib/theme.js";
import { initialTranscriptViewportState } from "../src/state/transcript-viewport-state.js";

async function renderToText(element: React.ReactElement): Promise<string> {
  const writes: string[] = [];
  const stdout = {
    columns: 80,
    rows: 20,
    write: (value: string) => {
      writes.push(value);
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const stdin = {
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
  const app = render(element, { stdout, stdin, patchConsole: false });
  await new Promise((resolve) => setTimeout(resolve, 40));
  app.unmount();
  // eslint-disable-next-line no-control-regex
  return writes.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

function document(): TranscriptDocument {
  return {
    epoch: "e1",
    blocks: Array.from({ length: 8 }, (_, index) => ({
      key: `block:${index}`,
      kind: "notice" as const,
      level: "primary" as const,
      ordinal: index,
      summary: [
        {
          key: `block:${index}:summary`,
          text: `row ${index}`,
          tone: "normal" as const,
        },
      ],
      details: [
        {
          key: `block:${index}:detail`,
          label: "detail",
          tone: "muted" as const,
          rows: [
            {
              key: `block:${index}:detail:0`,
              text: `detail ${index}`,
              tone: "normal" as const,
            },
          ],
        },
      ],
      visibility: "always" as const,
    })),
  };
}

describe("TranscriptViewport rendering", () => {
  it("sends only the visible compact window to Ink", async () => {
    const layout = layoutTranscriptDocument(document(), "compact", 78);
    const text = await renderToText(
      <ThemeProvider theme={DARK}>
        <TranscriptViewport
          layout={layout}
          state={initialTranscriptViewportState("compact")}
          rows={4}
        />
      </ThemeProvider>,
    );
    expect(text).toContain("row 7");
    expect(text).not.toContain("row 0");
  });

  it("shows unseen-line feedback without changing the projection mode", async () => {
    const layout = layoutTranscriptDocument(document(), "detailed", 78);
    const state = {
      ...initialTranscriptViewportState("detailed"),
      unseenRows: 12,
    };
    const text = await renderToText(
      <ThemeProvider theme={DARK}>
        <TranscriptViewport layout={layout} state={state} rows={5} />
      </ThemeProvider>,
    );
    expect(text).toContain("↓ 12 new lines · Ctrl+End");
    expect(state.mode).toBe("detailed");
  });
});
