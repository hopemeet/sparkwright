import React from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import {
  resolveStreamingAnswerRows,
  StreamingMessage,
} from "../src/components/streaming-message.js";

describe("streaming answer layout", () => {
  it.each([
    [8, 2],
    [12, 3],
    [17, 4],
    [18, 6],
    [24, 8],
    [32, 10],
    [48, 12],
  ])("uses a bounded answer budget for %i screen rows", (rows, expected) => {
    expect(resolveStreamingAnswerRows(rows)).toBe(expected);
  });

  it("keeps reasoning to three single-line tails", async () => {
    const text = await renderToText(
      <StreamingMessage
        text="answer"
        reasoning={[
          "old reasoning",
          "first visible reasoning that is deliberately very long",
          "second visible reasoning that is deliberately very long",
          "third visible reasoning that is deliberately very long",
        ].join("\n")}
        maxRows={6}
        columns={24}
      />,
      24,
    );

    expect(text).toContain("thinking…");
    expect(text).not.toContain("old reasoning");
    expect(text).toContain("first visible reasoni…");
    expect(text).toContain("second visible reason…");
    expect(text).toContain("third visible reasoni…");
  });

  it("shows a generic fold hint and keeps the answer tail visible", async () => {
    const answer = Array.from({ length: 12 }, (_, i) => `- line ${i + 1}`).join(
      "\n",
    );
    const text = await renderToText(
      <StreamingMessage text={answer} maxRows={6} columns={40} />,
      40,
    );

    expect(text).toContain("earlier content temporarily folded");
    expect(text).toContain("line 12");
    expect(text).not.toContain("line 1\n");
    expect(text.trimEnd().split("\n")).toHaveLength(8);
  });

  it("does not claim folding when Markdown soft lines fit after wrapping", async () => {
    const answer = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const text = await renderToText(
      <StreamingMessage text={answer} maxRows={6} columns={40} />,
      40,
    );

    expect(text).not.toContain("temporarily folded");
    expect(text).toContain("line 1 line 2");
    expect(text).toContain("line 12");
  });

  it("uses plain bounded tail rendering after the character guard", async () => {
    const text = await renderToText(
      <StreamingMessage
        text={`\`\`\`ts\n${"x".repeat(4_200)}\n\`\`\`\nTAIL`}
        maxRows={6}
        columns={80}
      />,
      80,
    );

    expect(text).toContain("earlier content temporarily folded");
    expect(text).toContain("TAIL");
  });
});

async function renderToText(
  element: React.ReactElement,
  columns: number,
): Promise<string> {
  const writes: string[] = [];
  const stdout = {
    columns,
    rows: 32,
    write(value: string) {
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
  return writes
    .join("")
    .replace(
      new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g"),
      "",
    );
}
