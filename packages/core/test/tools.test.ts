import { describe, expect, it } from "vitest";
import { createRunId } from "../src/ids.js";
import {
  createToolCall,
  defineTool,
  executeTool,
  ToolRegistry,
  validateToolArguments,
  validateToolOutput,
} from "../src/tools.js";

describe("tools", () => {
  it("rejects duplicate tool names", () => {
    const registry = new ToolRegistry();
    const tool = defineTool({
      name: "echo",
      description: "Echo.",
      inputSchema: {},
      execute: (args) => args,
    });

    registry.register(tool);

    expect(() => registry.register(tool)).toThrow("Tool already registered");
  });

  it("tracks generation and returns stable snapshots", () => {
    const registry = new ToolRegistry();
    const first = defineTool({
      name: "first",
      description: "First.",
      inputSchema: {},
      execute: (args) => args,
    });
    const replacement = defineTool({
      name: "first",
      description: "First replacement.",
      inputSchema: {},
      execute: (args) => args,
    });

    expect(registry.getGeneration()).toBe(0);
    registry.register(first);
    const snapshot = registry.snapshot();
    expect(snapshot.generation).toBe(1);
    expect(snapshot.tools.map((tool) => tool.name)).toEqual(["first"]);

    registry.replace(replacement);
    expect(registry.getGeneration()).toBe(2);
    expect(snapshot.tools[0]?.description).toBe("First.");
    expect(registry.get("first")?.description).toBe("First replacement.");

    expect(registry.unregister("first")).toBe(true);
    expect(registry.unregister("missing")).toBe(false);
    expect(registry.getGeneration()).toBe(3);
  });

  it("validates required object arguments before execution", async () => {
    const registry = new ToolRegistry();
    let executed = false;

    registry.register(
      defineTool({
        name: "echo",
        description: "Echo text.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
          additionalProperties: false,
        },
        execute() {
          executed = true;
          return {};
        },
      }),
    );

    const result = await executeTool(
      registry,
      createToolCall(createRunId(), "echo", { extra: true }),
      {
        run: {
          id: createRunId(),
          goal: "test",
          state: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        },
      },
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("TOOL_ARGUMENTS_INVALID");
    expect(executed).toBe(false);
  });

  it("validates nested arrays and enums", () => {
    const error = validateToolArguments(
      {
        type: "object",
        properties: {
          mode: { enum: ["read", "write"] },
          paths: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["mode", "paths"],
      },
      {
        mode: "delete",
        paths: ["README.md"],
      },
    );

    expect(error?.code).toBe("TOOL_ARGUMENTS_INVALID");
    expect(error?.message).toContain("enum");
  });

  it("includes governance metadata in descriptors", () => {
    const registry = new ToolRegistry();

    registry.register(
      defineTool({
        name: "search_docs",
        description: "Search internal docs.",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: {
            hits: { type: "array", items: { type: "string" } },
          },
          required: ["hits"],
        },
        timeoutMs: 500,
        policy: {
          risk: "safe",
          requiresApproval: true,
        },
        governance: {
          allowedAgents: ["researcher"],
          allowedRoles: ["engineer"],
          rateLimit: {
            maxCalls: 10,
            windowMs: 60_000,
          },
          dataSensitivity: "internal",
          sideEffects: ["read", "network"],
          idempotency: "idempotent",
          audit: {
            level: "metadata",
            retentionDays: 30,
            viewers: ["security"],
          },
          costEstimate: {
            tier: "low",
            estimatedTokens: 100,
            estimatedUsd: 0.01,
          },
        },
        interruptBehavior: "cancel",
        deferLoading: true,
        resultSize: {
          maxChars: 1024,
        },
        execute: () => ({ hits: [] }),
      }),
    );

    expect(registry.listDescriptors()).toMatchObject([
      {
        name: "search_docs",
        outputSchema: {
          required: ["hits"],
        },
        policy: {
          risk: "safe",
          requiresApproval: true,
        },
        governance: {
          allowedAgents: ["researcher"],
          dataSensitivity: "internal",
          sideEffects: ["read", "network"],
          idempotency: "idempotent",
          audit: {
            level: "metadata",
          },
          costEstimate: {
            tier: "low",
          },
        },
        interrupt: {
          behavior: "cancel",
        },
        loading: {
          defer: true,
        },
        resultSize: {
          maxChars: 1024,
        },
      },
    ]);
  });

  it("lets tools report progress through the runtime context", async () => {
    const registry = new ToolRegistry();
    const updates: unknown[] = [];

    registry.register(
      defineTool({
        name: "progress",
        description: "Report progress.",
        inputSchema: { type: "object" },
        execute(_args, ctx) {
          ctx.reportToolProgress?.({
            label: "working",
            completedUnits: 1,
            totalUnits: 2,
          });
          return { ok: true };
        },
      }),
    );

    await executeTool(registry, createToolCall(createRunId(), "progress", {}), {
      run: {
        id: createRunId(),
        goal: "test",
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      },
      reportToolProgress: (update) => updates.push(update),
    });

    expect(updates).toEqual([
      {
        label: "working",
        completedUnits: 1,
        totalUnits: 2,
      },
    ]);
  });

  it("validates tool output against output schemas", async () => {
    const registry = new ToolRegistry();

    registry.register(
      defineTool({
        name: "bad_output",
        description: "Returns bad output.",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
          },
          required: ["ok"],
          additionalProperties: false,
        },
        execute: () => ({ ok: "yes" }),
      }),
    );

    const result = await executeTool(
      registry,
      createToolCall(createRunId(), "bad_output", {}),
      {
        run: {
          id: createRunId(),
          goal: "test",
          state: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        },
      },
    );

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "TOOL_OUTPUT_INVALID",
      },
    });
  });

  it("can validate tool output directly", () => {
    const error = validateToolOutput(
      {
        type: "object",
        properties: {
          count: { type: "integer" },
        },
        required: ["count"],
      },
      { count: 1.5 },
    );

    expect(error?.code).toBe("TOOL_OUTPUT_INVALID");
    expect(error?.message).toContain("expected integer");
  });

  it("normalizes tool timeouts", async () => {
    const registry = new ToolRegistry();

    registry.register(
      defineTool({
        name: "slow",
        description: "Slow tool.",
        inputSchema: { type: "object" },
        timeoutMs: 5,
        async execute() {
          await sleep(30);
          return { ok: true };
        },
      }),
    );

    const result = await executeTool(
      registry,
      createToolCall(createRunId(), "slow", {}),
      {
        run: {
          id: createRunId(),
          goal: "test",
          state: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        },
      },
    );

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "TOOL_TIMEOUT",
        metadata: {
          toolName: "slow",
          timeoutMs: 5,
        },
      },
    });
  });

  it("preserves structured runtime error codes from tool handlers", async () => {
    const registry = new ToolRegistry();

    registry.register(
      defineTool({
        name: "write",
        description: "Write.",
        inputSchema: { type: "object" },
        execute() {
          const error = new Error("Workspace write conflicted.") as Error & {
            code: string;
            metadata: Record<string, unknown>;
          };
          error.code = "WORKSPACE_WRITE_CONFLICT";
          error.metadata = { path: "README.md" };
          throw error;
        },
      }),
    );

    const result = await executeTool(
      registry,
      createToolCall(createRunId(), "write", {}),
      {
        run: {
          id: createRunId(),
          goal: "test",
          state: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        },
      },
    );

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "WORKSPACE_WRITE_CONFLICT",
        message: "Workspace write conflicted.",
        metadata: {
          path: "README.md",
        },
      },
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
