import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import { SkillsPanel } from "../src/components/skills-panel.js";
import type {
  TuiSkillBrowserEntry,
  TuiSkillsBrowserSnapshot,
} from "../src/lib/skills-browser.js";

describe("SkillsPanel", () => {
  it("shows a compact inventory without the capability overview", async () => {
    const panel = await renderPanel(
      <SkillsPanel
        snapshot={snapshot()}
        loading={false}
        workspaceRoot="/work"
        onClose={() => {}}
      />,
    );
    panel.unmount();
    const text = panel.text();

    expect(text).toContain("Skills · 3 available · 12 sessions scanned");
    expect(text).toContain("py-script-check");
    expect(text).toContain("23 loads");
    expect(text).toContain("2 drafts");
    expect(text).toContain("sparkwright-manual");
    expect(text).not.toContain("Available now:");
    expect(text).not.toContain("Model:");
    expect(text).not.toContain("Tool map:");
    expect(text).not.toContain("Cron support");
    expect(text).not.toContain("/work/.sparkwright");
  });

  it("opens details with Enter and treats Esc as back before close", async () => {
    const onClose = vi.fn();
    const panel = await renderPanel(
      <SkillsPanel
        snapshot={snapshot()}
        loading={false}
        workspaceRoot="/work"
        onClose={onClose}
      />,
    );

    await panel.input("\r");
    await panel.input("\u001b");
    expect(onClose).not.toHaveBeenCalled();
    await panel.input("\u001b");
    panel.unmount();
    const text = panel.text();

    expect(text).toContain("explicit 23 · resident 0");
    expect(text).toContain("21 completed · 0 failed · 2 cancelled");
    expect(text).toContain("3 unresolved · 14 total");
    expect(text).toContain(".sparkwright/skills/py-script-check/SKILL.md");
    expect(text).toContain("signals, not proof that the Skill");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

function snapshot(): TuiSkillsBrowserSnapshot {
  return {
    sessionsScanned: 12,
    sessionLimit: 20,
    computedAt: "2026-08-01T00:00:00.000Z",
    inventoryIssueCount: 0,
    traceIssueCount: 0,
    skills: [
      skill({
        name: "py-script-check",
        layer: "project",
        sourcePath: "/work/.sparkwright/skills/py-script-check/SKILL.md",
        loadedCount: 23,
        explicitLoadCount: 23,
        residentLoadCount: 0,
        draftCount: 2,
        associatedRuns: { completed: 21, failed: 0, cancelled: 2 },
        relatedToolFailures: { total: 14, unresolved: 3 },
      }),
      skill({ name: "sparkwright-capability-builder", layer: "builtin" }),
      skill({
        name: "sparkwright-manual",
        layer: "builtin",
        loadedCount: 1,
        explicitLoadCount: 1,
      }),
    ],
  };
}

function skill(
  overrides: Partial<TuiSkillBrowserEntry> & Pick<TuiSkillBrowserEntry, "name">,
): TuiSkillBrowserEntry {
  return {
    name: overrides.name,
    description: "Reusable Skill instructions.",
    layer: "project",
    packageHash: `sha256:${overrides.name}`,
    loadedCount: 0,
    explicitLoadCount: 0,
    residentLoadCount: 0,
    loadFailureCount: 0,
    associatedRuns: { completed: 0, failed: 0, cancelled: 0 },
    relatedToolFailures: { total: 0, unresolved: 0 },
    draftCount: 0,
    ...overrides,
  };
}

async function renderPanel(element: React.ReactElement): Promise<{
  input: (value: string) => Promise<void>;
  text: () => string;
  unmount: () => void;
}> {
  const writes: string[] = [];
  const fakeStdout = {
    columns: 100,
    rows: 30,
    isTTY: true,
    write: (value: string) => {
      writes.push(value);
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
  const instance = render(element, {
    stdout: fakeStdout,
    stdin: fakeStdin,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await delay(60);
  return {
    input: async (value: string) => {
      fakeStdin.write(value);
      await delay(40);
    },
    text: () => stripAnsi(writes.join("")),
    unmount: () => {
      instance.unmount();
      fakeStdin.destroy();
    },
  };
}

function stripAnsi(text: string): string {
  return text.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g"),
    "",
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
