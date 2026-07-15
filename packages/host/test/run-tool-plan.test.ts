import { describe, expect, it } from "vitest";
import {
  defineTool,
  type RuntimeContext,
  type ToolDefinition,
} from "@sparkwright/core";
import {
  isWorkflowScopedToolSearch,
  resolveRunToolSurface,
} from "../src/tool-surface.js";

function tool(
  name: string,
  options: { deferred?: boolean; legacyNames?: string[] } = {},
): ToolDefinition {
  return defineTool({
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", additionalProperties: false },
    deferLoading: options.deferred,
    legacyNames: options.legacyNames,
    execute: async () => ({ ok: true }),
  });
}

describe("resolveRunToolSurface", () => {
  it.each([
    {
      label: "main keeps an admitted deferred tool discoverable",
      tools: [tool("todo_write", { deferred: true }), tool("tool_search")],
      allowed: undefined,
      requiredTools: undefined,
      expectedTools: ["todo_write", "tool_search"],
      expectedMissing: [],
      todoAlwaysLoaded: false,
    },
    {
      label: "continuation promotes only an admitted deferred todo_write",
      tools: [tool("todo_write", { deferred: true }), tool("tool_search")],
      allowed: undefined,
      requiredTools: ["todo_write"],
      expectedTools: ["todo_write", "tool_search"],
      expectedMissing: [],
      todoAlwaysLoaded: true,
    },
    {
      label: "workflow narrowing removes an admitted todo_write",
      tools: [tool("read"), tool("todo_write", { deferred: true })],
      allowed: ["read"],
      requiredTools: ["todo_write"],
      expectedTools: ["read"],
      expectedMissing: ["todo_write"],
      todoAlwaysLoaded: false,
    },
  ])(
    "$label",
    ({
      tools,
      allowed,
      requiredTools,
      expectedTools,
      expectedMissing,
      todoAlwaysLoaded,
    }) => {
      const surface = resolveRunToolSurface({
        tools,
        workflowAllowedTools: allowed,
        requiredTools,
      });
      expect(surface.tools.map((item) => item.name)).toEqual(expectedTools);
      expect(surface.missingRequiredTools).toEqual(expectedMissing);
      expect(
        surface.tools.find((item) => item.name === "todo_write")?.alwaysLoad ===
          true,
      ).toBe(todoAlwaysLoaded);
    },
  );

  it("never restores an upstream-disabled tool_search", () => {
    const surface = resolveRunToolSurface({
      tools: [tool("read"), tool("mcp__notes", { deferred: true })],
      workflowAllowedTools: ["mcp__notes"],
    });

    expect(surface.tools.map((item) => item.name)).toEqual(["mcp__notes"]);
  });

  it("replaces parent discovery with workflow-scoped discovery", async () => {
    const surface = resolveRunToolSurface({
      tools: [
        tool("secret_tool", { deferred: true }),
        tool("mcp__notes", { deferred: true }),
        tool("tool_search"),
      ],
      workflowAllowedTools: ["mcp__notes"],
    });
    const search = surface.tools.find((item) => item.name === "tool_search");
    expect(isWorkflowScopedToolSearch(search)).toBe(true);

    const found = (await search!.execute(
      { query: "select:secret_tool,mcp__notes" },
      {} as RuntimeContext,
    )) as { matches: Array<{ name: string }> };
    expect(found.matches.map((item) => item.name)).toEqual(["mcp__notes"]);
  });

  it("canonicalizes workflow aliases before narrowing", () => {
    const surface = resolveRunToolSurface({
      tools: [tool("read", { legacyNames: ["read_file"] }), tool("write")],
      workflowAllowedTools: ["read_file"],
    });

    expect(surface.tools.map((item) => item.name)).toEqual(["read"]);
  });
});
