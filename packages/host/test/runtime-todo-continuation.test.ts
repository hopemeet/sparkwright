import { describe, expect, it } from "vitest";
import { defineTool, type ToolDefinition } from "@sparkwright/core";
import { resolveRunToolPlan } from "../src/run-tool-plan.js";

function tool(name: string, deferLoading = false): ToolDefinition {
  return defineTool({
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    deferLoading,
    execute: async () => ({ ok: true }),
  });
}

describe("todo continuation tool loading", () => {
  it("makes an admitted deferred todo_write schema immediately callable", () => {
    const todo = tool("todo_write", true);
    const read = tool("read");

    const plan = resolveRunToolPlan({
      tools: [read, todo],
      purpose: "todo_continuation",
      requiredTools: ["todo_write"],
    });

    expect(plan.tools).toHaveLength(2);
    expect(plan.tools[0]).toBe(read);
    expect(plan.tools[1]).toMatchObject({
      name: "todo_write",
      deferLoading: true,
      alwaysLoad: true,
    });
    expect(plan.tools[1]).not.toBe(todo);
    expect(todo.alwaysLoad).toBeUndefined();
  });

  it("does not widen an already narrowed or denied tool catalog", () => {
    const task = tool("task", true);

    const plan = resolveRunToolPlan({
      tools: [task],
      purpose: "todo_continuation",
      requiredTools: ["todo_write"],
    });

    expect(plan.tools).toEqual([task]);
    expect(plan.tools[0]?.alwaysLoad).toBeUndefined();
    expect(plan.missingRequiredTools).toEqual(["todo_write"]);
  });
});
