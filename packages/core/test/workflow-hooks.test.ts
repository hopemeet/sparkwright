import { describe, expect, it } from "vitest";
import {
  createRun,
  defineTool,
  EventLog,
  runWorkflowHooks,
  type ModelAdapter,
  type WorkflowHook,
} from "../src/index.js";
import { createRunId } from "../src/ids.js";

describe("runWorkflowHooks", () => {
  it("emits canonical lifecycle payloads", async () => {
    const run = {
      id: createRunId(),
      goal: "g",
      state: "running" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    const events = new EventLog(run.id);
    const hooks: WorkflowHook[] = [
      {
        name: "run-start",
        hook: "RunStart",
        handle: () => ({
          status: "continue",
          metadata: { matched: true },
        }),
      },
    ];

    const result = await runWorkflowHooks({
      hooks,
      hook: "RunStart",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("continued");
    expect(events.all().at(0)?.payload).toMatchObject({
      hook: "RunStart",
    });
    expect(events.all().at(0)?.payload).not.toHaveProperty("configuredHook");
    expect(events.all().map((event) => event.type)).toEqual([
      "workflow_hook.started",
      "workflow_hook.completed",
    ]);
  });

  it("matches hooks, collects context, and returns rewrites in order", async () => {
    const run = {
      id: createRunId(),
      goal: "g",
      state: "running" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    const events = new EventLog(run.id);
    const hooks: WorkflowHook[] = [
      {
        name: "irrelevant",
        hook: "PreToolUse",
        matcher: { toolName: "other" },
        handle: () => ({ status: "block", reason: "no" }),
      },
      {
        name: "rewrite",
        hook: "PreToolUse",
        matcher: { toolName: "shell" },
        handle: () => ({
          status: "rewrite",
          patch: { arguments: { command: "npm test" } },
        }),
      },
    ];

    const result = await runWorkflowHooks({
      hooks,
      hook: "PreToolUse",
      run,
      payload: { toolName: "shell", arguments: { command: "npm t" } },
      events,
    });

    expect(result.status).toBe("continued");
    expect(result.rewrites).toEqual([{ arguments: { command: "npm test" } }]);
    expect(events.all().map((event) => event.type)).toEqual([
      "workflow_hook.started",
      "workflow_hook.completed",
    ]);
  });

  it("can exclude matching paths from a broader path glob", async () => {
    const run = {
      id: createRunId(),
      goal: "g",
      state: "running" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    const events = new EventLog(run.id);
    const hooks: WorkflowHook[] = [
      {
        name: "src-only",
        hook: "PreToolUse",
        matcher: {
          toolName: "write_file",
          pathGlob: "src/**",
          excludePathGlob: "src/generated/**",
        },
        handle: () => ({ status: "block", reason: "blocked" }),
      },
    ];

    const generatedResult = await runWorkflowHooks({
      hooks,
      hook: "PreToolUse",
      run,
      payload: { toolName: "write_file", path: "src/generated/a.ts" },
      events,
    });
    const sourceResult = await runWorkflowHooks({
      hooks,
      hook: "PreToolUse",
      run,
      payload: { toolName: "write_file", path: "src/app.ts" },
      events,
    });

    expect(generatedResult.status).toBe("continued");
    expect(sourceResult.status).toBe("blocked");
  });

  it("can fail closed when a governance hook throws", async () => {
    const run = {
      id: createRunId(),
      goal: "g",
      state: "running" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    const events = new EventLog(run.id);

    const result = await runWorkflowHooks({
      hooks: [
        {
          name: "strict",
          hook: "Stop",
          onError: "block",
          handle: () => {
            throw new Error("validator unavailable");
          },
        },
      ],
      hook: "Stop",
      run,
      payload: {},
      events,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("expected blocked workflow hook result");
    }
    expect(result.block.reason).toBe("validator unavailable");
    expect(events.all().map((event) => event.type)).toEqual([
      "workflow_hook.started",
      "workflow_hook.failed",
    ]);
  });
});

describe("workflowHooks in createRun", () => {
  it("blocks a matching PreToolUse call before execution", async () => {
    let executed = false;
    const write = defineTool({
      name: "write_file",
      description: "write",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute() {
        executed = true;
        return { ok: true };
      },
    });
    let calls = 0;
    const model: ModelAdapter = {
      async complete(input) {
        calls += 1;
        if (calls === 1) {
          return {
            toolCalls: [
              { toolName: "write_file", arguments: { path: "generated/a.ts" } },
            ],
          };
        }
        expect(input.context[0]?.content).toContain(
          "TOOL_BLOCKED_BY_WORKFLOW_HOOK",
        );
        return { message: "blocked" };
      },
    };

    const run = createRun({
      goal: "g",
      model,
      tools: [write],
      workflowHooks: [
        {
          name: "no-generated",
          hook: "PreToolUse",
          matcher: { toolName: "write_file", pathGlob: "generated/**" },
          handle: () => ({
            status: "block",
            reason: "generated files are locked",
          }),
        },
      ],
    });

    const result = await run.start();

    expect(result.signal).toBe("completed");
    expect(executed).toBe(false);
    expect(run.events.all().map((event) => event.type)).toContain(
      "workflow_hook.blocked",
    );
  });

  it("lets Stop hooks prevent termination and feed back context", async () => {
    let calls = 0;
    const model: ModelAdapter = {
      async complete(input) {
        calls += 1;
        if (calls === 1) return { message: "done" };
        expect(input.context[0]?.content).toContain("must mention tests");
        return { message: "done, tests passed" };
      },
    };

    const run = createRun({
      goal: "g",
      model,
      maxSteps: 3,
      workflowHooks: [
        {
          name: "require-tests",
          hook: "Stop",
          handle(input) {
            const message = (input.payload as { message?: string }).message;
            if (message?.includes("tests passed")) return;
            return { status: "block", reason: "must mention tests" };
          },
        },
      ],
    });

    const result = await run.start();

    expect(result.signal).toBe("completed");
    expect(result.message).toBe("done, tests passed");
    expect(calls).toBe(2);
  });

  it("allows RuntimeSignal hooks to stop repeated tool calls before doom-loop failure", async () => {
    const noop = defineTool({
      name: "read_missing",
      description: "always fails",
      inputSchema: { type: "object" },
      execute() {
        throw new Error("missing");
      },
    });
    const model: ModelAdapter = {
      async complete() {
        return { toolCalls: [{ toolName: "read_missing", arguments: {} }] };
      },
    };

    const run = createRun({
      goal: "g",
      model,
      tools: [noop],
      doomLoopRepeatLimit: 4,
      workflowHooks: [
        {
          name: "no-repeat",
          hook: "RuntimeSignal",
          matcher: { signal: "repeated_tool_call" },
          handle: () => ({ status: "block", reason: "change strategy" }),
        },
      ],
    });

    const result = await run.start();

    expect(result.signal).toBe("failed");
    expect(result.stopReason).toBe("hook_stopped");
    expect(result.failure?.code).toBe("WORKFLOW_HOOK_BLOCKED");
  });
});
