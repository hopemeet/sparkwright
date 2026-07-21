import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../src/lib/commands.js";
import {
  InputBox,
  type InputBoxHandle,
  inputBoxWidth,
  inputLineViewport,
  inputMaxVisibleLines,
  inputVisualLines,
  suggestionWindow,
} from "../src/components/input-box.js";
import type { StashFile } from "../src/lib/stash.js";

function stripAnsi(text: string): string {
  return text.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g"),
    "",
  );
}

async function renderInputBox(
  props: Partial<React.ComponentProps<typeof InputBox>> = {},
  fixtureFiles: Record<string, string> = {},
): Promise<{
  text: () => string;
  input: (value: string) => Promise<void>;
  unmount: () => void;
}> {
  const writes: string[] = [];
  const fakeStdout = {
    columns: 90,
    rows: 24,
    isTTY: true,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const fakeStdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean;
  };
  fakeStdin.isTTY = true;
  fakeStdin.setRawMode = () => fakeStdin;
  fakeStdin.ref = () => fakeStdin;
  fakeStdin.unref = () => fakeStdin;
  const registry = new CommandRegistry();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "sparkwright-input-"));
  await Promise.all(
    Object.entries(fixtureFiles).map(([name, content]) =>
      writeFile(join(workspaceRoot, name), content, "utf8"),
    ),
  );
  const stashRef: { current: StashFile } = {
    current: { current: null, list: [] },
  };
  const instance = render(
    React.createElement(InputBox, {
      disabled: false,
      workspaceRoot,
      registry,
      onSubmit: () => {},
      onCommand: () => {},
      stashRef,
      onStashChange: (next) => {
        stashRef.current = next;
      },
      ...props,
    }),
    {
      stdout: fakeStdout,
      stdin: fakeStdin,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  return {
    text: () => stripAnsi(writes.join("")),
    input: async (value: string) => {
      fakeStdin.write(value);
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
    unmount: () => {
      instance.unmount();
      fakeStdin.destroy();
      void rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

describe("inputBoxWidth", () => {
  it("fits inside the terminal with a small margin", () => {
    expect(inputBoxWidth(60)).toBe(58);
    expect(inputBoxWidth(120)).toBe(118);
  });

  it("keeps a minimum usable width", () => {
    expect(inputBoxWidth(10)).toBe(20);
  });
});

describe("inputMaxVisibleLines", () => {
  it("caps normal terminals at eight lines", () => {
    expect(inputMaxVisibleLines(40)).toBe(8);
  });

  it("keeps a usable smaller window on short terminals", () => {
    expect(inputMaxVisibleLines(20)).toBe(8);
    expect(inputMaxVisibleLines(16)).toBe(7);
    expect(inputMaxVisibleLines(12)).toBe(5);
  });
});

describe("inputLineViewport", () => {
  it("shows all lines when content fits", () => {
    expect(inputLineViewport(3, 1, 8)).toEqual({
      start: 0,
      end: 3,
      hiddenBefore: 0,
      hiddenAfter: 0,
    });
  });

  it("centers the window around the caret when content is longer", () => {
    expect(inputLineViewport(20, 10, 8)).toEqual({
      start: 6,
      end: 14,
      hiddenBefore: 6,
      hiddenAfter: 6,
    });
  });

  it("clamps near the beginning and end", () => {
    expect(inputLineViewport(20, 1, 8)).toMatchObject({
      start: 0,
      end: 8,
      hiddenBefore: 0,
      hiddenAfter: 12,
    });
    expect(inputLineViewport(20, 19, 8)).toMatchObject({
      start: 12,
      end: 20,
      hiddenBefore: 12,
      hiddenAfter: 0,
    });
  });
});

describe("inputVisualLines", () => {
  it("wraps long pasted text to the terminal-column budget", () => {
    expect(inputVisualLines(["abcdef"], 3)).toEqual([
      { logicalLine: 0, startCol: 0, endCol: 3 },
      { logicalLine: 0, startCol: 3, endCol: 6 },
    ]);
  });

  it("counts CJK text as two columns and never splits a glyph", () => {
    expect(inputVisualLines(["这是测试文本"], 6)).toEqual([
      { logicalLine: 0, startCol: 0, endCol: 3 },
      { logicalLine: 0, startCol: 3, endCol: 6 },
    ]);
  });

  it("keeps explicit blank lines visible", () => {
    expect(inputVisualLines(["one", "", "two"], 20)).toEqual([
      { logicalLine: 0, startCol: 0, endCol: 3 },
      { logicalLine: 1, startCol: 0, endCol: 0 },
      { logicalLine: 2, startCol: 0, endCol: 3 },
    ]);
  });
});

describe("suggestionWindow", () => {
  it("keeps the selected item visible after moving past the first page", () => {
    const items = Array.from({ length: 12 }, (_, i) => `cmd-${i + 1}`);

    const page = suggestionWindow(items, 6, 6);

    expect(page.start).toBe(3);
    expect(page.visible).toEqual([
      "cmd-4",
      "cmd-5",
      "cmd-6",
      "cmd-7",
      "cmd-8",
      "cmd-9",
    ]);
  });

  it("clamps the window near the end of the list", () => {
    const items = Array.from({ length: 12 }, (_, i) => `cmd-${i + 1}`);

    const page = suggestionWindow(items, 11, 6);

    expect(page.start).toBe(6);
    expect(page.visible).toEqual([
      "cmd-7",
      "cmd-8",
      "cmd-9",
      "cmd-10",
      "cmd-11",
      "cmd-12",
    ]);
  });
});

describe("InputBox draft restore", () => {
  it("restores a short in-memory draft after remount", async () => {
    let draft = "";
    const handleRef: React.MutableRefObject<InputBoxHandle | null> = {
      current: null,
    };

    const first = await renderInputBox({
      handleRef,
      onDraftChange: (next) => {
        draft = next;
      },
    });

    handleRef.current?.setValue("hi");
    await new Promise((resolve) => setTimeout(resolve, 30));
    first.unmount();

    expect(draft).toBe("hi");

    const secondHandleRef: React.MutableRefObject<InputBoxHandle | null> = {
      current: null,
    };
    const second = await renderInputBox({
      handleRef: secondHandleRef,
      initialDraft: draft,
    });

    expect(secondHandleRef.current?.getValue()).toBe("hi");
    second.unmount();
  });

  it("can ignore an empty-draft printable global hotkey", async () => {
    let draft = "";
    const rendered = await renderInputBox({
      onDraftChange: (next) => {
        draft = next;
      },
      onGlobalInput: (input) => input === "?",
    });

    await rendered.input("?");

    expect(draft).toBe("");
    expect(rendered.text()).not.toContain("?");
    rendered.unmount();
  });

  it("gives editor Escape and Ctrl+C explicit callbacks", async () => {
    const onEscape = vi.fn();
    const onQuit = vi.fn();
    const rendered = await renderInputBox({ onEscape, onQuit });

    await rendered.input("\u001b");
    await rendered.input("\x03");

    expect(onEscape).toHaveBeenCalledOnce();
    expect(onQuit).toHaveBeenCalledWith(1);
    rendered.unmount();
  });

  it("dispatches a resolved slash suggestion without submitting it as a goal", async () => {
    const registry = new CommandRegistry();
    registry.register({
      name: "help",
      title: "Help",
      description: "Show help",
      category: "view",
      run: () => {},
    });
    const onCommand = vi.fn();
    const onSubmit = vi.fn();
    const rendered = await renderInputBox({
      registry,
      onCommand,
      onSubmit,
    });

    await rendered.input("/help");
    await rendered.input("\r");

    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "help" }),
      "",
    );
    expect(onSubmit).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it("keeps submitted prompt history reachable through reverse search", async () => {
    const rendered = await renderInputBox();
    await rendered.input("remember this prompt");
    await rendered.input("\r");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rendered.input("\x12");

    expect(rendered.text()).toContain("reverse-i-search");
    expect(rendered.text()).toContain("remember this prompt");
    rendered.unmount();
  });

  it("keeps file mention suggestions and Enter selection", async () => {
    let draft = "";
    const rendered = await renderInputBox(
      {
        onDraftChange: (value) => {
          draft = value;
        },
      },
      { "README.md": "fixture" },
    );
    await rendered.input("@READ");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(rendered.text()).toContain("README.md");
    await rendered.input("\r");
    expect(draft).toContain("@README.md");
    rendered.unmount();
  });
});
