import { describe, expect, it } from "vitest";
import {
  defineTool,
  type RuntimeContext,
  type ToolDefinition,
} from "@sparkwright/core";
import {
  isWorkflowScopedToolSearch,
  resolveRunToolPlan,
} from "../src/run-tool-plan.js";

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

describe("resolveRunToolPlan", () => {
  it.each([
    {
      label: "main keeps an admitted deferred tool discoverable",
      purpose: "main_agent" as const,
      tools: [tool("todo_write", { deferred: true }), tool("tool_search")],
      allowed: undefined,
      requiredTools: undefined,
      expected: { visibility: "deferred_discoverable" },
    },
    {
      label: "continuation promotes only an admitted deferred todo_write",
      purpose: "todo_continuation" as const,
      tools: [tool("todo_write", { deferred: true }), tool("tool_search")],
      allowed: undefined,
      requiredTools: ["todo_write"],
      expected: { visibility: "exposed", reason: "prompt_required" },
    },
    {
      label: "workflow narrowing removes an admitted todo_write",
      purpose: "todo_continuation" as const,
      tools: [tool("read"), tool("todo_write", { deferred: true })],
      allowed: ["read"],
      requiredTools: ["todo_write"],
      expected: { visibility: "omitted", reason: "workflow_narrowed" },
    },
  ])("$label", ({ purpose, tools, allowed, requiredTools, expected }) => {
    const plan = resolveRunToolPlan({
      tools,
      workflowAllowedTools: allowed,
      purpose,
      requiredTools,
    });
    expect(
      plan.decisions.find((item) => item.name === "todo_write"),
    ).toMatchObject(expected);
    expect(plan.missingRequiredTools).toEqual(
      expected.visibility === "omitted" ? ["todo_write"] : [],
    );
  });

  it("never restores an upstream-disabled tool_search", () => {
    const plan = resolveRunToolPlan({
      tools: [tool("read"), tool("mcp__notes", { deferred: true })],
      workflowAllowedTools: ["mcp__notes"],
      purpose: "main_agent",
    });

    expect(plan.tools.map((item) => item.name)).toEqual(["mcp__notes"]);
    expect(
      plan.decisions.find((item) => item.name === "mcp__notes"),
    ).toMatchObject({
      visibility: "deferred_undiscoverable",
      reason: "discovery_unavailable",
    });
  });

  it("replaces parent discovery with workflow-scoped discovery", async () => {
    const plan = resolveRunToolPlan({
      tools: [
        tool("secret_tool", { deferred: true }),
        tool("mcp__notes", { deferred: true }),
        tool("tool_search"),
      ],
      workflowAllowedTools: ["mcp__notes"],
      purpose: "main_agent",
    });
    const search = plan.tools.find((item) => item.name === "tool_search");
    expect(isWorkflowScopedToolSearch(search)).toBe(true);

    const found = (await search!.execute(
      { query: "select:secret_tool,mcp__notes" },
      {} as RuntimeContext,
    )) as { matches: Array<{ name: string }> };
    expect(found.matches.map((item) => item.name)).toEqual(["mcp__notes"]);
  });

  it("canonicalizes workflow aliases before narrowing", () => {
    const plan = resolveRunToolPlan({
      tools: [tool("read", { legacyNames: ["read_file"] }), tool("write")],
      workflowAllowedTools: ["read_file"],
      purpose: "main_agent",
    });

    expect(plan.tools.map((item) => item.name)).toEqual(["read"]);
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "read", visibility: "exposed" }),
        expect.objectContaining({
          name: "write",
          visibility: "omitted",
          reason: "workflow_narrowed",
        }),
      ]),
    );
  });

  it("does not claim call-time execution or approval outcomes", () => {
    const read = tool("read");
    const write = {
      ...tool("write"),
      governance: { sideEffects: ["write" as const] },
    };
    const plan = resolveRunToolPlan({
      tools: [read, write],
      purpose: "main_agent",
    });

    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "read",
          visibility: "exposed",
        }),
        expect.objectContaining({
          name: "write",
          visibility: "exposed",
        }),
      ]),
    );
    expect(JSON.stringify(plan.decisions)).not.toMatch(
      /executable|requiresApproval/,
    );
  });
});
