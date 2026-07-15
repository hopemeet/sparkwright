import { describe, expect, it } from "vitest";
import {
  createToolSearchTool,
  defineTool,
  type RuntimeContext,
  type ToolDefinition,
} from "@sparkwright/core";
import type { AgentProfile } from "@sparkwright/agent-runtime";
import { admitToolsForAgentProfile } from "../src/tool-surface.js";
import type { HostToolCatalogEntry } from "../src/tool-catalog.js";

function tool(
  name: string,
  options: { deferred?: boolean; legacyNames?: string[] } = {},
): ToolDefinition {
  return defineTool({
    name,
    legacyNames: options.legacyNames,
    description: name,
    inputSchema: { type: "object" },
    deferLoading: options.deferred,
    execute: () => ({ ok: true }),
  });
}

function profile(input: Partial<AgentProfile>): AgentProfile {
  return { id: "agent", name: "Agent", prompt: "Test", ...input };
}

describe("agent profile physical tool admission", () => {
  it("applies deny after allow and canonicalizes legacy built-in names", () => {
    const tools = [
      tool("read", { legacyNames: ["read_file"] }),
      tool("write", { legacyNames: ["write_file"] }),
    ];
    const admitted = admitToolsForAgentProfile(
      tools,
      profile({
        allowedTools: ["read_file", "write_file"],
        deniedTools: ["read"],
      }),
      (item) => item,
    );
    expect(admitted.map((item) => item.name)).toEqual(["write"]);
  });

  it("supports MCP wildcard narrowing without exposing denied matches", () => {
    const admitted = admitToolsForAgentProfile(
      [tool("mcp__notes__read"), tool("mcp__notes__write"), tool("bash")],
      profile({
        allowedTools: ["mcp__notes__*"],
        deniedTools: ["mcp__notes__write"],
      }),
      (item) => item,
    );
    expect(admitted.map((item) => item.name)).toEqual(["mcp__notes__read"]);
  });

  it("keeps derived discovery only when it was upstream-admitted", () => {
    const deferred = tool("mcp__notes__read", { deferred: true });
    const search = tool("tool_search");
    const catalog = (definitions: ToolDefinition[]): HostToolCatalogEntry[] =>
      definitions.map((definition) => ({ definition, source: "mcp" }));
    const agent = profile({ allowedTools: ["mcp__notes__read"] });

    expect(
      admitToolsForAgentProfile(
        catalog([deferred, search]),
        agent,
        (entry) => entry.definition,
        (entry, definition) => ({ ...entry, definition }),
      ).map((entry) => entry.definition.name),
    ).toEqual(["mcp__notes__read", "tool_search"]);
    expect(
      admitToolsForAgentProfile(
        catalog([deferred]),
        agent,
        (entry) => entry.definition,
        (entry, definition) => ({ ...entry, definition }),
      ).map((entry) => entry.definition.name),
    ).toEqual(["mcp__notes__read"]);
  });

  it("keeps configured-child discovery when an admitted deferred tool needs it", () => {
    const admitted = admitToolsForAgentProfile(
      [tool("mcp__notes__read", { deferred: true }), tool("tool_search")],
      profile({ allowedTools: ["mcp__notes__read"] }),
      (item) => item,
    );

    expect(admitted.map((item) => item.name)).toEqual([
      "mcp__notes__read",
      "tool_search",
    ]);
  });

  it("does not let retained discovery describe a profile-denied tool", async () => {
    const visible = tool("mcp__notes__read", { deferred: true });
    const denied = tool("mcp__notes__write", { deferred: true });
    const search = createToolSearchTool({
      source: {
        listDescriptors: () =>
          [visible, denied].map((definition) => ({
            name: definition.name,
            description: definition.description,
            inputSchema: definition.inputSchema,
            loading: { defer: definition.deferLoading },
          })),
      },
    });
    const admitted = admitToolsForAgentProfile(
      [visible, denied, search],
      profile({ deniedTools: ["mcp__notes__write"] }),
      (item) => item,
    );
    const admittedSearch = admitted.find((item) => item.name === "tool_search");
    const found = (await admittedSearch!.execute(
      { query: "select:mcp__notes__read,mcp__notes__write" },
      {} as RuntimeContext,
    )) as { matches: Array<{ name: string }> };

    expect(found.matches.map((item) => item.name)).toEqual([
      "mcp__notes__read",
    ]);
  });

  it("lets an explicit profile deny remove discovery infrastructure", () => {
    const admitted = admitToolsForAgentProfile(
      [tool("mcp__notes__read", { deferred: true }), tool("tool_search")].map(
        (definition) => ({ definition, source: "mcp" as const }),
      ),
      profile({ deniedTools: ["tool_search"] }),
      (entry) => entry.definition,
      (entry, definition) => ({ ...entry, definition }),
    );
    expect(admitted.map((entry) => entry.definition.name)).toEqual([
      "mcp__notes__read",
    ]);
  });
});
