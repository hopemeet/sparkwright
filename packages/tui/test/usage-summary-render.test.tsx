import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import { UsageSummaryLine } from "../src/components/sidebar.js";

async function renderToText(element: React.ReactElement): Promise<string> {
  const writes: string[] = [];
  const fakeStdout = {
    columns: 120,
    rows: 30,
    write: (text: string) => {
      writes.push(text);
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

describe("UsageSummaryLine", () => {
  it("separates current context from the session total", async () => {
    const text = await renderToText(
      <UsageSummaryLine
        usage={{
          contextTokens: 6746,
          inputTokens: 48_589,
          cachedTokens: 25_793,
          outputTokens: 1575,
          totalTokens: 50_164,
          modelCalls: 10,
          toolCalls: 8,
          estimatedCostUsd: 0.1234,
        }}
      />,
    );

    expect(text).toContain(
      "usage  context 6.7k · session 50.2k · calls 10 model / 8 tool",
    );
    expect(text).not.toContain("cached");
    expect(text).not.toContain("input");
    expect(text).not.toContain("output");
    expect(text).not.toContain("$0.1234");
  });

  it("derives the session total when totalTokens is unavailable", async () => {
    const text = await renderToText(
      <UsageSummaryLine
        usage={{
          inputTokens: 900,
          outputTokens: 100,
        }}
      />,
    );

    expect(text).toContain("usage  session 1.0k");
  });
});
