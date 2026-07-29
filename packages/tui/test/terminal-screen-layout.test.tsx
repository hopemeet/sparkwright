import React from "react";
import { Box, Text, render } from "ink";
import { describe, expect, it } from "vitest";
import { inkScreenRows } from "../src/lib/terminal-screen-layout.js";

const INK_FULL_CLEAR = "\x1b[2J\x1b[3J\x1b[H";

describe("terminal screen layout", () => {
  it.each([
    [24, 23],
    [32, 31],
    [1, 1],
  ])("reserves Ink's bottom row for a %i-row terminal", (rows, expected) => {
    expect(inkScreenRows(rows)).toBe(expected);
  });

  it("keeps changed renders off Ink's full-terminal clear path", async () => {
    const writes: string[] = [];
    const stdout = {
      columns: 80,
      rows: 24,
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
    const screen = (tick: number): React.ReactElement => (
      <Box height={inkScreenRows(stdout.rows)}>
        <Text>tick {tick}</Text>
      </Box>
    );

    const app = render(screen(0), { stdout, stdin, patchConsole: false });
    await settle();
    app.rerender(screen(1));
    await settle();
    app.unmount();

    expect(writes.join("")).not.toContain(INK_FULL_CLEAR);
  });
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
