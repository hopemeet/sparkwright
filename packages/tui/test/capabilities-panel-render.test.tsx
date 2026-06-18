import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink";
import type { CapabilitySnapshot } from "@sparkwright/protocol";
import { CapabilitiesPanel } from "../src/components/capabilities-panel.js";

async function renderToText(
  element: React.ReactElement,
  rows = 16,
): Promise<string> {
  const writes: string[] = [];
  const fakeStdout = {
    columns: 100,
    rows,
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
  await new Promise((r) => setTimeout(r, 60));
  unmount();
  // eslint-disable-next-line no-control-regex
  return writes.join("").replace(/\[[0-9;?]*[a-zA-Z]/g, "");
}

function snapshot(toolCount: number): CapabilitySnapshot {
  return {
    tools: Array.from({ length: toolCount }, (_, index) => ({
      name: `tool_${index.toString().padStart(2, "0")}`,
      origin: "builtin",
      risk: "read",
    })),
    skills: { indexed: [], loaded: [] },
    mcp: { statuses: [] },
    agents: { profiles: [], delegateTools: [] },
  };
}

describe("CapabilitiesPanel rendering", () => {
  it("keeps the title and overview visible for long capability snapshots", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const text = await renderToText(
        <CapabilitiesPanel
          snapshot={snapshot(30)}
          loading={false}
          view="all"
          onClose={() => {}}
        />,
      );

      expect(err).not.toHaveBeenCalled();
      expect(text).toContain("capabilities");
      expect(text).toContain("Available now: 30 tools");
      expect(text).toContain("Tool map:");
      expect(text).toContain("tool_00");
      expect(text).toContain("more");
      expect(text).not.toContain("tool_20");
    } finally {
      err.mockRestore();
    }
  });

  it("explains managed skill mutation tools", async () => {
    const text = await renderToText(
      <CapabilitiesPanel
        snapshot={{
          tools: [
            { name: "list_skills", origin: "local:sparkwright", risk: "safe" },
            {
              name: "create_skill",
              origin: "local:sparkwright",
              risk: "risky",
              deferred: true,
            },
            {
              name: "update_skill",
              origin: "local:sparkwright",
              risk: "risky",
              deferred: true,
            },
            {
              name: "tool_search",
              origin: "local:@sparkwright/core",
              risk: "safe",
            },
          ],
          skills: { indexed: [], loaded: [] },
          mcp: { statuses: [] },
          agents: { profiles: [], delegateTools: [] },
        }}
        loading={false}
        view="tools"
        onClose={() => {}}
      />,
      34,
    );

    expect(text).toContain("ready tools");
    expect(text).toContain("deferred via tool_search");
    expect(text).toContain("approval / high risk");
    expect(text).toContain("tool sources");
    expect(text).toContain("managed Skill package create");
    expect(text).toContain("draft proposal first");
    expect(text).toContain("apply only when requested");
  });
});
