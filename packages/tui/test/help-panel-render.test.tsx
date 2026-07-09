import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import { CommandRegistry } from "../src/lib/commands.js";
import { DEFAULTS } from "../src/lib/keybindings.js";
import { HelpPanel } from "../src/components/help-panel.js";

async function renderToText(element: React.ReactElement): Promise<string> {
  const writes: string[] = [];
  const fakeStdout = {
    columns: 90,
    rows: 40,
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

describe("HelpPanel rendering", () => {
  it("shows advanced hidden commands in a discoverable section", async () => {
    const registry = new CommandRegistry();
    registry.register({
      name: "sessions",
      title: "Browse past sessions",
      description: "List, inspect diagnostics, resume.",
      category: "session",
      run: () => {},
    });
    registry.register({
      name: "tools",
      title: "Browse tools",
      description: "Show prepared tools, risk, and origin.",
      category: "view",
      hiddenByDefault: true,
      run: () => {},
    });

    const text = await renderToText(
      <HelpPanel registry={registry} bindings={DEFAULTS} onClose={() => {}} />,
    );

    expect(text).toContain("/sessions");
    expect(text).toContain("more commands");
    expect(text).toContain("/tools");
    expect(text).toContain("search for more");
    expect(text).toContain("global keys");
  });
});
