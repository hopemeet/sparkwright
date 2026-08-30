import React from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import { QueuedMessages } from "../src/components/queued-messages.js";

describe("QueuedMessages", () => {
  it("shows who owns each pending interaction without exposing command ids", async () => {
    const text = await renderToText(
      <QueuedMessages
        items={[
          { goal: "do this next", commandId: "command_secret" },
          {
            goal: "/review src",
            projectCommand: { name: "review", rest: "src" },
          },
          { goal: "retry locally" },
        ]}
      />,
    );

    expect(text).toContain(
      "pending (3) · runs in order after the current goal",
    );
    expect(text).toContain("follow-up  do this next");
    expect(text).toContain("command    /review src");
    expect(text).toContain("next       retry locally");
    expect(text).not.toContain("command_secret");
  });
});

async function renderToText(element: React.ReactElement): Promise<string> {
  const writes: string[] = [];
  const stdout = {
    columns: 100,
    rows: 18,
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
