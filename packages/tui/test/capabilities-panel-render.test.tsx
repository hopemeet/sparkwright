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

  it("surfaces missing model pricing in the overview", async () => {
    const text = await renderToText(
      <CapabilitiesPanel
        snapshot={{
          ...snapshot(1),
          model: {
            modelRef: "openai/gpt-5.4-mini",
            providerKey: "openai",
            modelId: "gpt-5.4-mini",
            adapterId: "openai:gpt-5.4-mini",
            pricing: {
              source: "unavailable",
              costStatus: "unavailable",
              costUnavailableReason: "missing_pricing",
            },
          },
        }}
        loading={false}
        view="all"
        onClose={() => {}}
      />,
      18,
    );

    expect(text).toContain("Model: openai/gpt-5.4-mini");
    expect(text).toContain("pricing unavailable (missing_pricing)");
  });

  it("counts risky public tools as public with a high-risk overlay", async () => {
    const text = await renderToText(
      <CapabilitiesPanel
        snapshot={{
          tools: [
            {
              name: "read",
              origin: "local:@sparkwright/coding-tools",
              risk: "safe",
              defaultExposureTier: "public",
            },
            {
              name: "bash",
              origin: "local:@sparkwright/shell-tool",
              risk: "risky",
              defaultExposureTier: "public",
            },
          ],
          skills: { indexed: [], loaded: [] },
          mcp: { statuses: [] },
          agents: { profiles: [], delegateTools: [] },
        }}
        loading={false}
        view="all"
        onClose={() => {}}
      />,
      20,
    );

    expect(text).toContain("Tool map: 2 public");
    expect(text).toContain("1 approval/high-risk");
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

    expect(text).toContain("public tools");
    expect(text).toContain("deferred via tool_search");
    expect(text).toContain("approval / high risk");
    expect(text).toContain("tool sources");
    expect(text).toContain("draft create proposal first");
    expect(text).toContain("draft proposal first");
    expect(text).toContain("apply only when requested");
  });

  it("displays indexed Skill source paths through workspace-relative projection", async () => {
    const text = await renderToText(
      <CapabilitiesPanel
        snapshot={{
          tools: [],
          skills: {
            indexed: [
              {
                name: "demo-skill",
                description: "Demo skill.",
                sourcePath: "/tmp/work/.sparkwright/skills/demo-skill/SKILL.md",
              },
            ],
            loaded: [],
          },
          mcp: { statuses: [] },
          agents: { profiles: [], delegateTools: [] },
        }}
        loading={false}
        view="skills"
        workspaceRoot="/tmp/work"
        onClose={() => {}}
      />,
      24,
    );

    expect(text).toContain(".sparkwright/skills/demo-skill/SKILL.md");
    expect(text).not.toContain("/tmp/work/.sparkwright");
  });

  it("renders configured in-process delegates from the snapshot", async () => {
    const text = await renderToText(
      <CapabilitiesPanel
        snapshot={{
          tools: [
            {
              name: "delegate_writer",
              origin: "in_process:writer",
              risk: "safe",
            },
          ],
          skills: { indexed: [], loaded: [] },
          mcp: { statuses: [] },
          agents: {
            profiles: [{ id: "writer", name: "Writer", mode: "child" }],
            delegateTools: [
              {
                toolName: "delegate_writer",
                profileId: "writer",
                profileName: "Writer",
                protocol: "in_process",
                model: "anthropic/claude",
                risk: "safe",
                requiresApproval: false,
                forbidNesting: true,
                sideEffects: ["model", "workspace"],
                workspaceAccess: "read_write",
                shellAccess: false,
                processSpawn: false,
                gatedByRunWrite: true,
                routing: {
                  keywords: ["write", "patch"],
                  mode: "sort",
                  relevance: "relevant",
                  score: 2,
                  matchedKeywords: ["write"],
                  reason: "matched write",
                },
              },
            ],
          },
        }}
        loading={false}
        view="agents"
        onClose={() => {}}
      />,
      24,
    );

    expect(text).toContain("1 delegates");
    expect(text).toContain("delegate_writer");
    expect(text).toContain("in_process");
    expect(text).toContain("anthropic/claude");
    expect(text).toContain("relevant");
    expect(text).toContain("workspace read_write");
    expect(text).toContain("requires write access");
  });

  it("does not count the built-in primary main profile as a configured agent", async () => {
    const text = await renderToText(
      <CapabilitiesPanel
        snapshot={{
          tools: [],
          skills: { indexed: [], loaded: [] },
          mcp: { statuses: [] },
          agents: {
            profiles: [
              { id: "main", name: "SparkWright", mode: "primary" },
              { id: "writer", name: "Writer", mode: "child" },
            ],
            delegateTools: [],
          },
        }}
        loading={false}
        view="agents"
        onClose={() => {}}
      />,
      24,
    );

    expect(text).toContain("Available now: 0 tools, 0 loaded Skills, 1 agents");
    expect(text).toContain("agents (1 / 0 delegates)");
    expect(text).toContain("Writer");
    expect(text).not.toContain("SparkWright");
  });

  it("renders workflow rule summaries from the snapshot", async () => {
    const text = await renderToText(
      <CapabilitiesPanel
        snapshot={{
          ...snapshot(0),
          rules: {
            workflow: [
              {
                name: "documented-command-check",
                source: "builtin",
                lifecycle: "Stop",
                matcher: "write-enabled goals about verification",
                action: "block final answer when README commands are stale",
                blockingPotential: true,
                enabled: true,
                active: false,
                status: "available",
                configurationHint:
                  "Activated by the current goal and write access.",
              },
            ],
            events: [
              {
                name: "record-tool",
                source: "config",
                trigger: "tool.completed",
                matcher: "toolName=bash",
                action: "command: node; injectOutput=always",
                blockingPotential: false,
                enabled: true,
                active: true,
                status: "active",
                configurationHint: "Configured in capabilities.hooks.events.",
              },
            ],
          },
        }}
        loading={false}
        view="all"
        onClose={() => {}}
      />,
      44,
    );

    expect(text).toContain("workflow rules");
    expect(text).toContain("workflow rules (1)");
    expect(text).toContain("documented-command-check");
    expect(text).toContain("builtin");
    expect(text).toContain("Stop");
    expect(text).toContain("available");
    expect(text).toContain("can block");
    expect(text).toContain("matcher write-enabled goals about verification");
    expect(text).toContain("event rules (1)");
    expect(text).toContain("record-tool");
    expect(text).toContain("tool.completed");
    expect(text).toContain("non-blocking");
  });
});
