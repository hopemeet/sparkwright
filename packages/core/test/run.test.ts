import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createContextItemId,
  createClearToolUsesStage,
  createWorkspaceMutationPolicy,
  createRun,
  createToolSearchTool,
  classifyToolFailure,
  defineTool,
  type ContextItem,
  type ModelAdapter,
  type NotificationSource,
  type PendingNotification,
  type SparkwrightEvent,
  type TaskRevivalSource,
  type WorkflowHook,
} from "../src/index.js";
import { LocalWorkspace } from "../src/workspace.js";

describe("SparkwrightRun", () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  function createRunHealthReadFileTool() {
    return defineTool({
      name: "read_file",
      description: "Read a file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      policy: { risk: "safe" },
      async execute(args, ctx) {
        if (!ctx.workspace) throw new Error("missing workspace");
        const path = (args as { path: string }).path;
        const content = await ctx.workspace.readText(path);
        const lineCount = content.split("\n").length;
        return {
          path,
          content,
          startLine: 1,
          endLine: lineCount,
          totalLines: lineCount,
          hasMore: false,
        };
      },
    });
  }

  it("classifies custom tool argument error codes as model argument errors", () => {
    expect(classifyToolFailure("TASK_ARGUMENTS_INVALID")).toBe(
      "model_arg_error",
    );
    expect(classifyToolFailure("CRON_INPUT_INVALID")).toBe("model_arg_error");
  });

  it("records policy argument normalization errors as tool failures", async () => {
    let modelCalls = 0;
    const tool = defineTool({
      name: "policy_checked",
      description: "Exercise policy argument normalization.",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      policyForArgs() {
        throw new Error("timeoutMs must be a positive integer.");
      },
      execute() {
        throw new Error("should not execute");
      },
    });

    const run = createRun({
      goal: "handle invalid policy args",
      tools: [tool],
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                {
                  toolName: "policy_checked",
                  arguments: { timeoutMs: 0 },
                },
              ],
            };
          }
          return { message: "observed invalid args" };
        },
      },
      maxSteps: 3,
    });

    const result = await run.start();
    const events = run.events.all();

    expect(result.state).toBe("completed");
    expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(
      1,
    );
    expect(
      events.find((event) => event.type === "tool.failed")?.payload,
    ).toMatchObject({
      toolName: "policy_checked",
      status: "failed",
      error: {
        code: "TOOL_ARGUMENTS_INVALID",
        message: "timeoutMs must be a positive integer.",
        metadata: {
          toolName: "policy_checked",
          phase: "policyForArgs",
        },
      },
    });
    expect(
      events.filter(
        (event) =>
          event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled",
      ),
    ).toHaveLength(1);
  });

  it("runs semantic input validation before policy and execution", async () => {
    let executed = false;
    let modelCalls = 0;
    const checked = defineTool({
      name: "semantic_checked",
      description: "Exercise semantic input validation.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      policy: { risk: "risky" },
      validateInput(args) {
        const path = (args as { path: string }).path;
        if (path.endsWith("/")) {
          return {
            ok: false,
            code: "PATH_NOT_FILE",
            message: "path must point to a file",
            metadata: { reason: "trailing_slash" },
          };
        }
        return { ok: true };
      },
      policyForArgs() {
        throw new Error("policyForArgs should not run");
      },
      execute() {
        executed = true;
      },
    });

    const run = createRun({
      goal: "semantic validation",
      tools: [checked],
      approvalResolver(request) {
        throw new Error(
          `Approval should not be requested for ${request.action}`,
        );
      },
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [
                  {
                    toolName: "semantic_checked",
                    arguments: { path: "src/" },
                  },
                ],
              }
            : { message: "observed semantic failure" };
        },
      },
      maxSteps: 3,
    });

    const result = await run.start();
    const events = run.events.all();
    const failed = events.find((event) => event.type === "tool.failed");

    expect(result.signal).toBe("completed");
    expect(executed).toBe(false);
    expect(events.map((event) => event.type)).not.toContain(
      "approval.requested",
    );
    expect(failed?.payload).toMatchObject({
      toolName: "semantic_checked",
      error: {
        code: "PATH_NOT_FILE",
        message: "path must point to a file",
        metadata: {
          toolName: "semantic_checked",
          phase: "validateInput",
          reason: "trailing_slash",
        },
      },
    });
    expect(failed?.metadata).toMatchObject({
      schemaValidationMs: expect.any(Number),
      inputValidationMs: expect.any(Number),
    });
  });

  it("loops model-tool-observation until a final answer", async () => {
    let modelCalls = 0;
    const events: SparkwrightEvent[] = [];

    const echo = defineTool({
      name: "echo",
      description: "Echo text.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
      policy: { risk: "safe" },
      execute(args: unknown) {
        return args;
      },
    });

    const model: ModelAdapter = {
      async complete(input) {
        modelCalls += 1;

        if (modelCalls === 1) {
          expect(input.context).toHaveLength(0);
          return {
            toolCalls: [
              {
                toolName: "echo",
                arguments: { text: "hello" },
              },
            ],
          };
        }

        expect(input.context).toHaveLength(1);
        expect(input.context[0].content).toContain("hello");
        return { message: "done" };
      },
    };

    const run = createRun({
      goal: "test loop",
      model,
      tools: [echo],
      maxSteps: 3,
    });
    run.events.subscribe((event) => events.push(event));

    const result = await run.start();

    expect(run.record.state).toBe("completed");
    expect(result).toMatchObject({
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
      message: "done",
    });
    expect(modelCalls).toBe(2);
    expect(events.map((event) => event.type)).toContain("tool.completed");
    expect(
      events.find((event) => event.type === "tool.completed")?.metadata,
    ).toMatchObject({
      schemaValidationMs: expect.any(Number),
      policyForArgsMs: expect.any(Number),
      policyDecisionMs: expect.any(Number),
      executionMs: expect.any(Number),
      resultValidationMs: expect.any(Number),
    });
    expect(events.map((event) => event.type)).toContain("context.assembled");
    expect(events.map((event) => event.type)).toContain("prompt.built");
    expect(
      events.find((event) => event.type === "prompt.built")?.payload,
    ).toMatchObject({
      messageCount: 8,
      stableMessageCount: 6,
      stablePrefixBlockCount: 1,
      sections: [
        {
          index: 0,
          name: "resident_identity",
          layer: "resident",
          stability: "stable",
          cachePolicy: "stable",
          chars: expect.any(Number),
        },
        {
          index: 1,
          name: "tool_use_contract",
          layer: "resident",
          stability: "stable",
          cachePolicy: "stable",
          chars: expect.any(Number),
        },
        {
          index: 2,
          name: "safety_and_approval_contract",
          layer: "resident",
          stability: "stable",
          cachePolicy: "stable",
          chars: expect.any(Number),
        },
        {
          index: 3,
          name: "context_contract",
          layer: "resident",
          stability: "stable",
          cachePolicy: "stable",
          chars: expect.any(Number),
        },
        {
          index: 4,
          name: "output_contract",
          layer: "resident",
          stability: "stable",
          cachePolicy: "stable",
          chars: expect.any(Number),
        },
        {
          index: 5,
          name: "development_task_contract",
          layer: "resident",
          stability: "stable",
          cachePolicy: "stable",
          chars: expect.any(Number),
        },
        {
          index: 6,
          name: "tool_descriptors",
          layer: "capability",
          stability: "session",
          cachePolicy: "session",
          chars: expect.any(Number),
        },
        {
          index: 7,
          name: "current_request",
          layer: "runtime",
          stability: "turn",
          cachePolicy: "turn",
          chars: expect.any(Number),
        },
      ],
    });
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("records tool-owned request previews on tool.requested events", async () => {
    let modelCalls = 0;
    const previewed = defineTool({
      name: "previewed",
      description: "Preview arguments.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
      policy: { risk: "safe" },
      previewArgs(args) {
        return `open ${(args as { path?: string }).path ?? "?"}`;
      },
      execute() {
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "preview request",
      tools: [previewed],
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [
                  { toolName: "previewed", arguments: { path: "README.md" } },
                ],
              }
            : { message: "done" };
        },
      },
    });

    await run.start();

    const requested = run.events
      .all()
      .find((event) => event.type === "tool.requested");
    expect(requested?.payload).toMatchObject({
      toolName: "previewed",
      preview: "open README.md",
    });
  });

  it("omits deferred tools from provider requests until tool_search loads them", async () => {
    let modelCalls = 0;
    const deferredEcho = defineTool({
      name: "deferred_echo",
      description: "Echo text after deferred discovery.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      deferLoading: true,
      execute(args: unknown) {
        return args;
      },
    });
    const toolSearch = createToolSearchTool({
      source: {
        listDescriptors: () => [
          {
            name: deferredEcho.name,
            description: deferredEcho.description,
            inputSchema: deferredEcho.inputSchema,
            loading: { defer: true },
          },
        ],
      },
    });

    const run = createRun({
      goal: "use deferred tool",
      tools: [deferredEcho, toolSearch],
      maxSteps: 4,
      model: {
        async complete(input) {
          modelCalls += 1;
          const toolNames = input.tools.map((tool) => tool.name);
          if (modelCalls === 1) {
            expect(toolNames).toEqual(["tool_search"]);
            return {
              toolCalls: [
                {
                  toolName: "tool_search",
                  arguments: { query: "select:deferred_echo" },
                },
              ],
            };
          }
          if (modelCalls === 2) {
            expect(toolNames).toEqual(["deferred_echo", "tool_search"]);
            return {
              toolCalls: [
                {
                  toolName: "deferred_echo",
                  arguments: { text: "loaded" },
                },
              ],
            };
          }
          expect(toolNames).toEqual(["deferred_echo", "tool_search"]);
          return { message: "done" };
        },
      },
    });

    const result = await run.start();

    expect(result).toMatchObject({
      signal: "completed",
      message: "done",
    });
    expect(modelCalls).toBe(3);
  });

  it("loads a skill's registered deferred tool dependencies without tool_search", async () => {
    let modelCalls = 0;
    const deferredEcho = defineTool({
      name: "deferred_echo",
      description: "Echo text after loading its skill.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      deferLoading: true,
      execute(args: unknown) {
        return args;
      },
    });
    const skillLoad = defineTool({
      name: "skill_load",
      description: "Load a skill and its declared tool dependencies.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      execute() {
        return {
          status: "loaded",
          name: "echo-builder",
          toolDependencies: ["deferred_echo", "disabled_elsewhere"],
          content: "Use deferred_echo.",
        };
      },
    });

    const run = createRun({
      goal: "load a skill then use its tool",
      tools: [deferredEcho, skillLoad],
      maxSteps: 3,
      model: {
        async complete(input) {
          modelCalls += 1;
          const toolNames = input.tools.map((tool) => tool.name);
          if (modelCalls === 1) {
            expect(toolNames).toEqual(["skill_load"]);
            return {
              toolCalls: [
                {
                  toolName: "skill_load",
                  arguments: { name: "echo-builder" },
                },
              ],
            };
          }
          if (modelCalls === 2) {
            expect(toolNames).toEqual(["deferred_echo", "skill_load"]);
            return {
              toolCalls: [
                {
                  toolName: "deferred_echo",
                  arguments: { text: "loaded by skill" },
                },
              ],
            };
          }
          return { message: "done" };
        },
      },
    });

    const result = await run.start();

    expect(result).toMatchObject({ signal: "completed", message: "done" });
    expect(modelCalls).toBe(3);
    expect(
      run.events
        .all()
        .some(
          (event) =>
            event.type === "tool.requested" &&
            event.payload.toolName === "tool_search",
        ),
    ).toBe(false);
  });

  it("adds recovery metadata when an unloaded deferred tool fails schema validation", async () => {
    let modelCalls = 0;
    let observedToolResults: ContextItem[] = [];
    const deferredEcho = defineTool({
      name: "deferred_echo",
      description: "Echo text after deferred discovery.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      deferLoading: true,
      execute(args: unknown) {
        return args;
      },
    });
    const toolSearch = createToolSearchTool({
      source: {
        listDescriptors: () => [
          {
            name: deferredEcho.name,
            description: deferredEcho.description,
            inputSchema: deferredEcho.inputSchema,
            loading: { defer: true },
          },
        ],
      },
    });

    const run = createRun({
      goal: "recover deferred schema",
      tools: [deferredEcho, toolSearch],
      maxSteps: 3,
      model: {
        async complete(input) {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                {
                  toolName: "deferred_echo",
                  arguments: {},
                },
              ],
            };
          }
          observedToolResults = input.context.filter(
            (item) => item.type === "tool_result",
          );
          return { message: "will load schema next" };
        },
      },
    });

    const result = await run.start();
    const failed = run.events
      .all()
      .find((event) => event.type === "tool.failed");
    const requested = run.events
      .all()
      .find((event) => event.type === "tool.requested");

    expect(result.signal).toBe("completed");
    expect(failed?.payload).toMatchObject({
      toolName: "deferred_echo",
      error: {
        code: "TOOL_ARGUMENTS_INVALID",
        metadata: {
          toolName: "deferred_echo",
          reason: "schema_not_loaded",
          recoveryTool: "tool_search",
          recoveryQuery: "select:deferred_echo",
          deferred: true,
          schemaLoaded: false,
        },
      },
    });
    expect(failed?.metadata).toMatchObject({
      schemaValidationMs: expect.any(Number),
    });
    expect(failed?.spanId).toBe(requested?.spanId);
    const observation = JSON.parse(observedToolResults[0]?.content ?? "{}") as {
      error?: { message?: string; metadata?: unknown };
    };
    expect(observation.error?.message).toContain(
      "First call `tool_search` with query `select:deferred_echo`",
    );
    expect(observation.error?.metadata).toMatchObject({
      reason: "schema_not_loaded",
      recoveryTool: "tool_search",
      recoveryQuery: "select:deferred_echo",
    });
  });

  it("does not mark loaded deferred schema failures as schema-not-loaded", async () => {
    let modelCalls = 0;
    const deferredEcho = defineTool({
      name: "deferred_echo",
      description: "Echo text after deferred discovery.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      deferLoading: true,
      execute(args: unknown) {
        return args;
      },
    });
    const toolSearch = createToolSearchTool({
      source: {
        listDescriptors: () => [
          {
            name: deferredEcho.name,
            description: deferredEcho.description,
            inputSchema: deferredEcho.inputSchema,
            loading: { defer: true },
          },
        ],
      },
    });

    const run = createRun({
      goal: "loaded deferred invalid args",
      tools: [deferredEcho, toolSearch],
      maxSteps: 4,
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                {
                  toolName: "tool_search",
                  arguments: { query: "select:deferred_echo" },
                },
              ],
            };
          }
          return modelCalls === 2
            ? {
                toolCalls: [
                  {
                    toolName: "deferred_echo",
                    arguments: {},
                  },
                ],
              }
            : { message: "saw loaded invalid args" };
        },
      },
    });

    const result = await run.start();
    const failed = run.events
      .all()
      .find((event) => event.type === "tool.failed");
    const metadata = (
      failed?.payload as { error?: { metadata?: Record<string, unknown> } }
    ).error?.metadata;

    expect(result.signal).toBe("completed");
    expect(failed?.payload).toMatchObject({
      toolName: "deferred_echo",
      error: {
        code: "TOOL_ARGUMENTS_INVALID",
        metadata: { toolName: "deferred_echo" },
      },
    });
    expect(metadata?.reason).not.toBe("schema_not_loaded");
    expect(metadata?.schemaLoaded).toBeUndefined();
    expect(failed?.metadata).toMatchObject({
      schemaValidationMs: expect.any(Number),
    });
  });

  it("keeps deferred schema recovery tied to the model-turn snapshot", async () => {
    let modelCalls = 0;
    const deferredEcho = defineTool({
      name: "deferred_echo",
      description: "Echo text after deferred discovery.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      deferLoading: true,
      governance: { sideEffects: ["read"], idempotency: "idempotent" },
      execute(args: unknown) {
        return args;
      },
    });
    const toolSearch = createToolSearchTool({
      source: {
        listDescriptors: () => [
          {
            name: deferredEcho.name,
            description: deferredEcho.description,
            inputSchema: deferredEcho.inputSchema,
            loading: { defer: true },
          },
        ],
      },
    });

    const run = createRun({
      goal: "same-turn deferred schema recovery",
      tools: [deferredEcho, toolSearch],
      maxSteps: 3,
      maxToolConcurrency: 2,
      hooks: [
        {
          name: "delay-deferred-echo",
          async beforeToolCall(input) {
            if (input.toolName === "deferred_echo") {
              await sleep(20);
            }
          },
        },
      ],
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [
                  {
                    toolName: "tool_search",
                    arguments: { query: "select:deferred_echo" },
                  },
                  {
                    toolName: "deferred_echo",
                    arguments: {},
                  },
                ],
              }
            : { message: "saw recovery guidance" };
        },
      },
    });

    const result = await run.start();
    const events = run.events.all();
    const toolSearchCompletedIndex = events.findIndex(
      (event) =>
        event.type === "tool.completed" &&
        (event.payload as { toolName?: string }).toolName === "tool_search",
    );
    const deferredFailedIndex = events.findIndex(
      (event) =>
        event.type === "tool.failed" &&
        (event.payload as { toolName?: string }).toolName === "deferred_echo",
    );
    const failed = events[deferredFailedIndex];

    expect(result.signal).toBe("completed");
    expect(toolSearchCompletedIndex).toBeGreaterThanOrEqual(0);
    expect(deferredFailedIndex).toBeGreaterThan(toolSearchCompletedIndex);
    expect(failed?.payload).toMatchObject({
      toolName: "deferred_echo",
      error: {
        code: "TOOL_ARGUMENTS_INVALID",
        metadata: {
          reason: "schema_not_loaded",
          recoveryTool: "tool_search",
          recoveryQuery: "select:deferred_echo",
          deferred: true,
          schemaLoaded: false,
        },
      },
    });
  });

  it("persists a command-outcome verdict on run.completed", async () => {
    const command =
      'cd /tmp/ws && python -m unittest tests/test_config.py 2>&1; echo "EXIT:$?"';
    const events: SparkwrightEvent[] = [];

    const shell = defineTool({
      name: "shell",
      description: "Run a shell command.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      policy: { risk: "safe" },
      execute() {
        return {
          command,
          exitCode: 0,
          timedOut: false,
          stdout: "python: command not found\nEXIT:127\n",
          stderr: "",
        };
      },
    });

    let modelCalls = 0;
    const model: ModelAdapter = {
      async complete() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return { toolCalls: [{ toolName: "shell", arguments: { command } }] };
        }
        return { message: "verification done" };
      },
    };

    const run = createRun({
      goal: "Run verification",
      model,
      tools: [shell],
      maxSteps: 3,
    });
    run.events.subscribe((event) => events.push(event));
    await run.start();

    const completed = events.find((event) => event.type === "run.completed");
    expect(completed?.payload).toMatchObject({
      factLedger: {
        schemaVersion: "fact-ledger.v1",
        writeEpoch: 0,
        commands: [
          {
            initiator: "model-initiated",
            source: "shell_tool",
            command,
            exitCode: 127,
            timedOut: false,
            stale: false,
          },
        ],
      },
      commandOutcome: {
        total: 1,
        byExitCode: { "127": 1 },
        verification: { total: 1, unresolved: 1, lastExitCode: 127 },
      },
    });
  });

  it("does not persist stale command failures as commandOutcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-run-ledger-"));
    tempDirs.push(root);
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    const command = "npm test";
    const events: SparkwrightEvent[] = [];

    const shell = defineTool({
      name: "shell",
      description: "Run a shell command.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      policy: { risk: "safe" },
      execute() {
        return { exitCode: 1, timedOut: false, stdout: "", stderr: "" };
      },
    });
    const writeReadme = defineTool({
      name: "write_readme",
      description: "Write README.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      policy: { risk: "safe" },
      async execute(_args, ctx) {
        if (!ctx.workspace) throw new Error("missing workspace");
        await ctx.workspace.writeText("README.md", "after\n");
        return { ok: true };
      },
    });

    let modelCalls = 0;
    const model: ModelAdapter = {
      async complete() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return { toolCalls: [{ toolName: "shell", arguments: { command } }] };
        }
        if (modelCalls === 2) {
          return { toolCalls: [{ toolName: "write_readme", arguments: {} }] };
        }
        return { message: "done" };
      },
    };

    const run = createRun({
      goal: "Run verification and edit",
      model,
      tools: [shell, writeReadme],
      workspace: new LocalWorkspace(root),
      approvalResolver(request) {
        expect(request.action).toBe("workspace.write");
        return {
          approvalId: request.id,
          decision: "approved",
        };
      },
      maxSteps: 4,
    });
    run.events.subscribe((event) => events.push(event));
    await run.start();

    const completed = events.find((event) => event.type === "run.completed");
    expect(completed?.payload).toMatchObject({
      factLedger: {
        writeEpoch: 1,
        commands: [
          {
            command,
            exitCode: 1,
            stale: true,
            writeEpoch: 0,
          },
        ],
      },
    });
    expect(completed?.payload).not.toHaveProperty("commandOutcome");
  });

  it("emits tool progress reported through the runtime context", async () => {
    const progressTool = defineTool({
      name: "progress_tool",
      description: "Report progress.",
      inputSchema: { type: "object" },
      execute(_args, ctx) {
        ctx.reportToolProgress?.({
          label: "scan",
          completedUnits: 1,
          totalUnits: 2,
        });
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "progress",
      tools: [progressTool],
      maxSteps: 2,
      model: {
        async complete(input) {
          if (input.step === 1) {
            return {
              toolCalls: [
                {
                  toolName: "progress_tool",
                  arguments: {},
                },
              ],
            };
          }
          return { message: "done" };
        },
      },
    });

    await run.start();

    const event = run.events
      .all()
      .find((item) => item.type === "tool.progress");
    expect(event?.payload).toMatchObject({
      toolName: "progress_tool",
      label: "scan",
      completedUnits: 1,
      totalUnits: 2,
    });
    expect(event?.payload).toHaveProperty("toolCallId");
  });

  it("correlates on-demand skill load failures with the failed tool call", async () => {
    const skillLoad = defineTool({
      name: "skill_load",
      description: "Load a skill.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      },
      policy: { risk: "safe" },
      execute() {
        return {
          status: "not_found",
          requestedName: "missing-skill",
          message: "Skill not found.",
        };
      },
    });
    const run = createRun({
      goal: "load missing skill",
      tools: [skillLoad],
      maxSteps: 2,
      model: {
        async complete(input) {
          if (input.step === 1) {
            return {
              toolCalls: [
                {
                  toolName: "skill_load",
                  arguments: { name: "missing-skill" },
                },
              ],
            };
          }
          return { message: "done" };
        },
      },
    });

    await run.start();

    const toolFailed = run.events
      .all()
      .find((event) => event.type === "tool.failed");
    const skillFailed = run.events
      .all()
      .find((event) => event.type === "skill.failed");
    const toolPayload = toolFailed?.payload as
      | { toolCallId?: string }
      | undefined;
    expect(toolPayload?.toolCallId).toEqual(expect.any(String));
    expect(skillFailed?.payload).toMatchObject({
      toolCallId: toolPayload?.toolCallId,
      name: "missing-skill",
      status: "not_found",
    });
  });

  it("uses a configured context assembler before model calls", async () => {
    const run = createRun({
      goal: "custom context",
      context: [
        {
          id: "ctx_test" as never,
          type: "user",
          content: "raw context",
          metadata: {},
        },
      ],
      contextAssembler: {
        assemble(input) {
          expect(input.priorContext).toHaveLength(1);
          return {
            items: [
              {
                id: "ctx_selected" as never,
                type: "summary",
                content: "selected context",
                metadata: { layer: "working" },
              },
            ],
            omitted: [
              {
                source: "raw context",
                reason: "test_omission",
              },
            ],
            metadata: {
              selectedBy: "test",
            },
          };
        },
      },
      model: {
        async complete(input) {
          expect(input.context).toHaveLength(1);
          expect(input.context[0]?.content).toBe("selected context");
          expect(input.prompt?.at(-1)?.content).toContain("selected context");
          return { message: "done" };
        },
      },
    });

    await run.start();

    const assembled = run.events
      .all()
      .find((event) => event.type === "context.assembled");
    expect(assembled?.payload).toMatchObject({
      selectedCount: 1,
      omittedCount: 1,
    });
    expect(run.record.state).toBe("completed");
  });

  it("emits a compaction request when context budget pressure omits items", async () => {
    const run = createRun({
      goal: "budget pressure",
      context: [userContext("12345"), userContext("67890")],
      contextBudget: {
        maxTotalChars: 6,
      },
      model: {
        async complete() {
          return { message: "done" };
        },
      },
    });

    await run.start();

    const event = run.events
      .all()
      .find((item) => item.type === "context.compaction_requested");
    expect(event?.payload).toMatchObject({
      step: 1,
      selectedCount: 1,
      omittedCount: 1,
      reasons: {
        max_total_chars_exceeded: 1,
      },
    });
  });

  it("applies the default deterministic compaction pipeline under pressure", async () => {
    const huge: ContextItem = {
      id: createContextItemId(),
      type: "tool_result",
      source: { kind: "tool" },
      content: "x".repeat(20_000),
      metadata: { layer: "working", stability: "turn" },
    };
    const run = createRun({
      goal: "default compaction",
      context: [huge],
      // no compactionStages => run loop uses createDefaultCompactionStages()
      model: {
        async complete() {
          return { message: "done" };
        },
      },
    });

    await run.start();

    const completed = run.events
      .all()
      .find(
        (event) =>
          event.type === "context.compaction.completed" &&
          (event.payload as { trigger?: string }).trigger ===
            "tool_result_budget",
      );
    expect(completed).toBeDefined();
    expect(run.record.state).toBe("completed");
  });

  it("disables compaction when an empty stage list is configured", async () => {
    const huge: ContextItem = {
      id: createContextItemId(),
      type: "tool_result",
      source: { kind: "tool" },
      content: "x".repeat(20_000),
      metadata: { layer: "working", stability: "turn" },
    };
    const run = createRun({
      goal: "no compaction",
      context: [huge],
      compactionStages: [],
      model: {
        async complete() {
          return { message: "done" };
        },
      },
    });

    await run.start();

    const started = run.events
      .all()
      .find((event) => event.type === "context.compaction.started");
    expect(started).toBeUndefined();
    expect(run.record.state).toBe("completed");
  });

  it("clears stale tool results with explicit placeholders before model calls", async () => {
    let seenContext: ContextItem[] = [];
    const oldOne = toolResultContext("read_file", "old-one".repeat(500));
    const oldTwo = toolResultContext("grep", "old-two".repeat(500));
    const recent = toolResultContext("shell", "recent result");
    const run = createRun({
      goal: "clear stale tool results",
      context: [oldOne, oldTwo, recent],
      compactionStages: [
        createClearToolUsesStage({ triggerChars: 0, keepRecent: 1 }),
      ],
      model: {
        async complete(input) {
          seenContext = input.context;
          return { message: "done" };
        },
      },
    });

    await run.start();

    expect(seenContext).toHaveLength(3);
    expect(seenContext[0]?.content).toContain(
      "tool result cleared by clear_tool_uses",
    );
    expect(seenContext[0]?.content).toContain("tool=read_file");
    expect(seenContext[0]?.metadata.clearToolUsesCleared).toBe(true);
    expect(seenContext[1]?.content).toContain(
      "tool result cleared by clear_tool_uses",
    );
    expect(seenContext[2]?.content).toBe("recent result");

    const completed = run.events
      .all()
      .find(
        (event) =>
          event.type === "context.compaction.completed" &&
          (event.payload as { trigger?: string }).trigger === "clear_tool_uses",
      );
    expect(completed?.payload).toMatchObject({
      metadata: { replaced: 2, keepRecent: 1 },
    });
  });

  it("skips stale tool-result clearing below clearAtLeastChars", async () => {
    let seenContext: ContextItem[] = [];
    const old = toolResultContext("read_file", "old".repeat(100));
    const recent = toolResultContext("shell", "recent");
    const run = createRun({
      goal: "clear threshold",
      context: [old, recent],
      compactionStages: [
        createClearToolUsesStage({
          triggerChars: 0,
          keepRecent: 1,
          clearAtLeastChars: 10_000,
        }),
      ],
      model: {
        async complete(input) {
          seenContext = input.context;
          return { message: "done" };
        },
      },
    });

    await run.start();

    expect(seenContext[0]?.content).toBe(old.content);
    expect(
      run.events
        .all()
        .some(
          (event) =>
            event.type === "context.compaction.started" &&
            (event.payload as { trigger?: string }).trigger ===
              "clear_tool_uses",
        ),
    ).toBe(false);
  });

  it("wraps up with a best-effort partial when max steps are exceeded", async () => {
    const echo = defineTool({
      name: "echo",
      description: "Echo text.",
      inputSchema: { type: "object" },
      execute(args: unknown) {
        return args;
      },
    });

    // Keeps calling tools until the budget runs out; on the forced wrap-up turn
    // (tools stripped) it hands back a partial summary instead.
    const run = createRun({
      goal: "never finish",
      tools: [echo],
      maxSteps: 2,
      model: {
        async complete(input) {
          if (input.tools.length === 0) {
            return { message: "Partial summary of what I gathered." };
          }
          return {
            toolCalls: [{ toolName: "echo", arguments: { n: input.step } }],
          };
        },
      },
    });

    const result = await run.start();

    expect(run.record.state).toBe("completed");
    expect(result).toMatchObject({
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
      message: "Partial summary of what I gathered.",
      metadata: {
        stepLimitReached: true,
        truncated: true,
        maxSteps: 2,
        stepsUsed: 2,
      },
    });
    const completed = run.events
      .all()
      .find((event) => event.type === "run.completed");
    expect(completed?.payload).toMatchObject({ truncated: true });
    expect(run.events.all().some((event) => event.type === "run.failed")).toBe(
      false,
    );
  });

  it("falls back to max_steps_exceeded when the wrap-up turn cannot produce output", async () => {
    const echo = defineTool({
      name: "echo",
      description: "Echo text.",
      inputSchema: { type: "object" },
      execute(args: unknown) {
        return args;
      },
    });

    // The wrap-up turn (tools stripped) errors, so there is nothing to hand
    // back — the run must surface the original hard failure rather than a
    // spuriously "completed" empty answer.
    const run = createRun({
      goal: "never finish",
      tools: [echo],
      maxSteps: 2,
      model: {
        async complete(input) {
          if (input.tools.length === 0) {
            throw new Error("wrap-up unavailable");
          }
          return {
            toolCalls: [{ toolName: "echo", arguments: { n: input.step } }],
          };
        },
      },
    });

    const result = await run.start();

    expect(run.record.state).toBe("failed");
    expect(result).toMatchObject({
      signal: "failed",
      state: "failed",
      stopReason: "max_steps_exceeded",
      failure: { category: "runtime", code: "MAX_STEPS_EXCEEDED" },
    });
  });

  it("fails early when the model repeats an identical tool call", async () => {
    let executed = 0;

    const echo = defineTool({
      name: "echo",
      description: "Echo text.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
      execute() {
        executed += 1;
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "repeat forever",
      tools: [echo],
      maxSteps: 8,
      model: {
        async complete() {
          return {
            toolCalls: [
              {
                toolName: "echo",
                arguments: { text: "same" },
              },
            ],
          };
        },
      },
    });

    const result = await run.start();

    const failed = run.events
      .all()
      .find((event) => event.type === "run.failed");
    // Only the first call executes: the second identical call (one step before
    // the limit) is replaced by the corrective nudge, and the third trips the
    // hard stop. See "nudges the model one step before the doom-loop stop".
    expect(executed).toBe(1);
    const nudge = run.events
      .all()
      .find(
        (event) =>
          event.type === "tool.failed" &&
          (event.payload as { error?: { code?: string } }).error?.code ===
            "REPEATED_TOOL_CALL_SKIPPED",
      );
    expect(nudge).toBeDefined();
    expect(run.record.state).toBe("failed");
    expect(run.record.stopReason).toBe("tool_doom_loop");
    expect(result).toMatchObject({
      signal: "failed",
      state: "failed",
      stopReason: "tool_doom_loop",
      failure: {
        category: "tool",
        code: "TOOL_DOOM_LOOP",
      },
    });
    expect(failed?.payload).toMatchObject({
      reason: "tool_doom_loop",
      code: "TOOL_DOOM_LOOP",
      failure: {
        category: "tool",
        code: "TOOL_DOOM_LOOP",
      },
      metadata: {
        toolName: "echo",
        arguments: { text: "same" },
        repeatedToolCallCount: 3,
        repeatLimit: 3,
      },
    });
  });

  it("does not doom-loop on an idempotent tool repeated verbatim", async () => {
    let executed = 0;

    // An idempotent tool returns the same result with no side effect, so a
    // verbatim repeat is a harmless no-op, not a doom loop. The generic repeat
    // guard must defer to it: no REPEATED_TOOL_CALL_SKIPPED, no tool_doom_loop,
    // and every call actually executes.
    const ledger = defineTool({
      name: "ledger",
      description: "Idempotent no-op write.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      policy: { risk: "safe" },
      governance: { idempotency: "idempotent" },
      execute() {
        executed += 1;
        return { ok: true };
      },
    });

    let modelCalls = 0;
    const run = createRun({
      goal: "repeat an idempotent call several times",
      tools: [ledger],
      maxSteps: 12,
      model: {
        async complete() {
          modelCalls += 1;
          // Repeat the identical call well past the doom-loop limit (3), then
          // finish cleanly.
          if (modelCalls <= 5) {
            return {
              toolCalls: [{ toolName: "ledger", arguments: { text: "same" } }],
            };
          }
          return { message: "done" };
        },
      },
    });

    const result = await run.start();

    // Every repeat executed — none was skipped by the repeat guard.
    expect(executed).toBe(5);
    const skipped = run.events
      .all()
      .find(
        (event) =>
          event.type === "tool.failed" &&
          (event.payload as { error?: { code?: string } }).error?.code ===
            "REPEATED_TOOL_CALL_SKIPPED",
      );
    expect(skipped).toBeUndefined();
    expect(run.record.stopReason).not.toBe("tool_doom_loop");
    expect(result).toMatchObject({
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
    });
  });

  it("renders tool-owned repeated state observation guidance as a completed skip", async () => {
    let executed = 0;
    const observe = defineTool({
      name: "observe",
      description: "Observe changing state.",
      inputSchema: { type: "object" },
      repeatedCallGuidanceForArgs: () =>
        "Use the blocking wait action instead.",
      execute() {
        executed += 1;
        return { status: "running" };
      },
    });
    let modelCalls = 0;
    const run = createRun({
      goal: "observe once, then recover from a repeated snapshot",
      tools: [observe],
      maxSteps: 8,
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls <= 2) {
            return { toolCalls: [{ toolName: "observe", arguments: {} }] };
          }
          return { message: "done" };
        },
      },
    });

    const result = await run.start();

    expect(executed).toBe(1);
    expect(result.stopReason).toBe("final_answer");
    expect(
      run.events
        .all()
        .some(
          (event) =>
            event.type === "tool.completed" &&
            (event.payload as { output?: { reason?: string; hint?: string } })
              .output?.reason === "repeated_state_observation" &&
            (event.payload as { output?: { hint?: string } }).output?.hint ===
              "Use the blocking wait action instead.",
        ),
    ).toBe(true);
  });

  it("does not let repeated state guidance hide a prior tool failure", async () => {
    let executed = 0;
    const observe = defineTool({
      name: "observe",
      description: "Observe changing state.",
      inputSchema: { type: "object" },
      repeatedCallGuidanceForArgs: () =>
        "Use the blocking wait action instead.",
      execute() {
        executed += 1;
        throw new Error("snapshot target does not exist");
      },
    });
    let modelCalls = 0;
    const run = createRun({
      goal: "repeat one failed state observation",
      tools: [observe],
      maxSteps: 8,
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls <= 2) {
            return { toolCalls: [{ toolName: "observe", arguments: {} }] };
          }
          return { message: "done" };
        },
      },
    });

    await run.start();

    expect(executed).toBe(1);
    const events = run.events.all();
    expect(
      events.some(
        (event) =>
          event.type === "tool.completed" &&
          (event.payload as { output?: { reason?: string } }).output?.reason ===
            "repeated_state_observation",
      ),
    ).toBe(false);
    expect(
      events
        .filter((event) => event.type === "tool.failed")
        .map(
          (event) =>
            (event.payload as { error?: { code?: string } }).error?.code,
        ),
    ).toEqual(["TOOL_EXECUTION_FAILED", "REPEATED_TOOL_CALL_SKIPPED"]);
  });

  it("nudges repeated idempotent no-op tool results without recording a tool failure", async () => {
    let executed = 0;
    const ledger = defineTool({
      name: "ledger",
      description: "Idempotent no-op write.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      policy: { risk: "safe" },
      governance: { idempotency: "idempotent" },
      execute() {
        executed += 1;
        return {
          saved: false,
          hint: "The list is unchanged from your last write — calling this again accomplishes nothing.",
        };
      },
    });

    const run = createRun({
      goal: "repeat an idempotent no-op call",
      tools: [ledger],
      maxSteps: 8,
      model: {
        async complete() {
          return {
            toolCalls: [{ toolName: "ledger", arguments: { text: "same" } }],
          };
        },
      },
    });

    const result = await run.start();

    expect(executed).toBe(1);
    expect(
      run.events
        .all()
        .some(
          (event) =>
            event.type === "tool.failed" &&
            (event.payload as { error?: { code?: string } }).error?.code ===
              "REPEATED_TOOL_CALL_SKIPPED",
        ),
    ).toBe(false);
    expect(
      run.events
        .all()
        .some(
          (event) =>
            event.type === "tool.completed" &&
            (event.payload as { output?: { reason?: string } }).output
              ?.reason === "repeated_idempotent_noop",
        ),
    ).toBe(true);
    expect(result.stopReason).toBe("tool_doom_loop");
  });

  it("lets the model recover from a repeated idempotent no-op nudge", async () => {
    let executed = 0;
    let modelCalls = 0;
    const ledger = defineTool({
      name: "ledger",
      description: "Idempotent no-op write.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      policy: { risk: "safe" },
      governance: { idempotency: "idempotent" },
      execute() {
        executed += 1;
        return {
          saved: false,
          hint: "The list is unchanged from your last write — calling this again accomplishes nothing.",
        };
      },
    });

    const run = createRun({
      goal: "repeat an idempotent no-op once, then recover",
      tools: [ledger],
      maxSteps: 8,
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls <= 2) {
            return {
              toolCalls: [{ toolName: "ledger", arguments: { text: "same" } }],
            };
          }
          return { message: "done after no-op nudge" };
        },
      },
    });

    const result = await run.start();

    expect(result.stopReason).toBe("final_answer");
    expect(run.record.state).toBe("completed");
    expect(executed).toBe(1);
    expect(
      run.events
        .all()
        .some(
          (event) =>
            event.type === "tool.failed" &&
            (event.payload as { error?: { code?: string } }).error?.code ===
              "REPEATED_TOOL_CALL_SKIPPED",
        ),
    ).toBe(false);
    expect(
      run.events
        .all()
        .some(
          (event) =>
            event.type === "tool.completed" &&
            (event.payload as { output?: { reason?: string } }).output
              ?.reason === "repeated_idempotent_noop",
        ),
    ).toBe(true);
  });

  it("feeds back unchanged read_file repeats after an intervening tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-run-workspace-"));
    tempDirs.push(root);
    await writeFile(join(root, "README.md"), "# Demo\nsame text\n", "utf8");
    let modelCalls = 0;
    let healthContextSeen = false;

    const readFileTool = createRunHealthReadFileTool();
    const note = defineTool({
      name: "note",
      description: "Intervening harmless tool.",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      execute() {
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "avoid rereading unchanged files",
      workspace: new LocalWorkspace(root),
      tools: [readFileTool, note],
      maxSteps: 6,
      model: {
        async complete(input) {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                { toolName: "read_file", arguments: { path: "README.md" } },
              ],
            };
          }
          if (modelCalls === 2) {
            return { toolCalls: [{ toolName: "note", arguments: {} }] };
          }
          if (modelCalls === 3) {
            return {
              toolCalls: [
                { toolName: "read_file", arguments: { path: "README.md" } },
              ],
            };
          }

          healthContextSeen = input.context.some(
            (item) =>
              item.source?.uri === "run.health" &&
              item.content.includes("same unchanged content") &&
              item.content.includes("README.md"),
          );
          return { message: "done" };
        },
      },
    });

    const result = await run.start();

    expect(result.stopReason).toBe("final_answer");
    expect(healthContextSeen).toBe(true);
    expect(
      run.events
        .all()
        .filter((event) => event.type === "workspace.read")
        .map((event) => (event.payload as { path?: string }).path),
    ).toEqual(["README.md", "README.md"]);
  });

  it("feeds back the next unread offset when paging backwards", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-run-workspace-"));
    tempDirs.push(root);
    await writeFile(
      join(root, "PROJECT_NOTES.md"),
      ["one", "two", "three", "four", "five", "six"].join("\n"),
      "utf8",
    );
    let modelCalls = 0;
    let healthContext: string | undefined;

    const readFileTool = defineTool({
      name: "read_file",
      description: "Read a paginated file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
      },
      policy: { risk: "safe" },
      async execute(args, ctx) {
        if (!ctx.workspace) throw new Error("missing workspace");
        const input = args as { path: string; offset?: number; limit?: number };
        const content = await ctx.workspace.readText(input.path);
        const lines = content.split("\n");
        const startLine = input.offset ?? 1;
        const limit = input.limit ?? 2;
        const endLine = Math.min(lines.length, startLine + limit - 1);
        return {
          path: input.path,
          content: lines.slice(startLine - 1, endLine).join("\n"),
          startLine,
          endLine,
          totalLines: lines.length,
          hasMore: endLine < lines.length,
          ...(endLine < lines.length ? { nextOffset: endLine + 1 } : {}),
        };
      },
    });

    const run = createRun({
      goal: "read pages without going backwards",
      workspace: new LocalWorkspace(root),
      tools: [readFileTool],
      maxSteps: 6,
      model: {
        async complete(input) {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                {
                  toolName: "read_file",
                  arguments: { path: "PROJECT_NOTES.md", offset: 1, limit: 2 },
                },
              ],
            };
          }
          if (modelCalls === 2) {
            return {
              toolCalls: [
                {
                  toolName: "read_file",
                  arguments: { path: "PROJECT_NOTES.md", offset: 3, limit: 2 },
                },
              ],
            };
          }
          if (modelCalls === 3) {
            return {
              toolCalls: [
                {
                  toolName: "read_file",
                  arguments: { path: "PROJECT_NOTES.md", offset: 1, limit: 2 },
                },
              ],
            };
          }

          healthContext = input.context
            .filter((item) => item.source?.uri === "run.health")
            .map((item) => item.content)
            .find((content) => content.includes("continue from offset 5"));
          return { message: "done" };
        },
      },
    });

    const result = await run.start();

    expect(result.stopReason).toBe("final_answer");
    expect(healthContext).toContain("same unchanged content");
    expect(healthContext).toContain("continue from offset 5");
  });

  it("does not feed back unchanged reads after the file is written", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-run-workspace-"));
    tempDirs.push(root);
    await writeFile(join(root, "README.md"), "# Demo\nsame text\n", "utf8");
    let modelCalls = 0;
    const healthMessages: string[] = [];

    const readFileTool = createRunHealthReadFileTool();
    const rewriteReadme = defineTool({
      name: "rewrite_readme",
      description: "Rewrite README.",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      async execute(_, ctx) {
        if (!ctx.workspace) throw new Error("missing workspace");
        await ctx.workspace.writeText("README.md", "# Demo\nchanged text\n", {
          reason: "test update",
        });
        return { path: "README.md", changed: true };
      },
    });

    const run = createRun({
      goal: "re-read after write",
      workspace: new LocalWorkspace(root),
      tools: [readFileTool, rewriteReadme],
      policy: createWorkspaceMutationPolicy({ allowWorkspaceWrites: true }),
      maxSteps: 6,
      model: {
        async complete(input) {
          healthMessages.push(
            ...input.context
              .filter((item) => item.source?.uri === "run.health")
              .map((item) => item.content),
          );
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                { toolName: "read_file", arguments: { path: "README.md" } },
              ],
            };
          }
          if (modelCalls === 2) {
            return {
              toolCalls: [{ toolName: "rewrite_readme", arguments: {} }],
            };
          }
          if (modelCalls === 3) {
            return {
              toolCalls: [
                { toolName: "read_file", arguments: { path: "README.md" } },
              ],
            };
          }
          return { message: "done" };
        },
      },
    });

    const result = await run.start();

    expect(result.stopReason).toBe("final_answer");
    expect(healthMessages).toEqual([]);
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "# Demo\nchanged text\n",
    );
    expect(
      run.events
        .all()
        .filter((event) => event.type === "workspace.write.completed"),
    ).toHaveLength(1);
  });

  it("uses deep equality for repeated tool call arguments", async () => {
    let executed = 0;

    const echo = defineTool({
      name: "echo",
      description: "Echo text.",
      inputSchema: { type: "object" },
      execute() {
        executed += 1;
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "repeat nested args",
      tools: [echo],
      maxSteps: 8,
      model: {
        async complete() {
          return {
            toolCalls: [
              {
                toolName: "echo",
                arguments: { nested: { value: "same" }, list: [1, 2, 3] },
              },
            ],
          };
        },
      },
    });

    await run.start();

    const failed = run.events
      .all()
      .find((event) => event.type === "run.failed");
    // First call executes; the second is replaced by the corrective nudge.
    expect(executed).toBe(1);
    expect(failed?.payload).toMatchObject({
      code: "TOOL_DOOM_LOOP",
      metadata: {
        arguments: { nested: { value: "same" }, list: [1, 2, 3] },
      },
    });
  });

  it("stops a model retrying the same failing target with varied arguments", async () => {
    let executed = 0;

    // Fails for any call — like reading a path that is actually a directory.
    const read = defineTool({
      name: "read",
      description: "Read a path.",
      inputSchema: { type: "object" },
      execute() {
        executed += 1;
        throw new Error("EISDIR: illegal operation on a directory");
      },
    });

    // Same path, different offset each turn: NOT an exact repeat, so the old
    // arg-equality guard never tripped — the run used to burn every step. The
    // semantic-target guard recognizes the repeated failing target.
    let step = 0;
    const run = createRun({
      goal: "hammer a broken path",
      tools: [read],
      maxSteps: 8,
      model: {
        async complete() {
          step += 1;
          return {
            toolCalls: [
              {
                toolName: "read",
                arguments: { path: "docs/adr", offset: step },
              },
            ],
          };
        },
      },
    });

    const result = await run.start();

    // Stopped on the loop guard well before maxSteps (8), not run to exhaustion.
    expect(run.record.state).toBe("failed");
    expect(result).toMatchObject({
      signal: "failed",
      state: "failed",
      stopReason: "tool_doom_loop",
      failure: { category: "tool", code: "TOOL_DOOM_LOOP" },
    });
    // First attempt executes and fails; the retry (varied offset) is caught as
    // a repeat and replaced by the corrective nudge, so the tool runs only once.
    expect(executed).toBe(1);
    expect(step).toBeLessThan(8);
    // The execute-path `tool.failed` event must carry `toolName` so trace
    // consumers can attribute the failure without correlating back to
    // `tool.requested` by id.
    const toolFailed = run.events
      .all()
      .find((event) => event.type === "tool.failed");
    expect(toolFailed?.payload).toMatchObject({
      toolName: "read",
      status: "failed",
    });
  });

  it("stops repeated shell commands even when timeoutMs varies", async () => {
    let executed = 0;
    let step = 0;

    const shell = defineTool({
      name: "shell",
      description: "Run a shell command.",
      inputSchema: { type: "object" },
      execute() {
        executed += 1;
        throw new Error("command failed");
      },
    });

    const run = createRun({
      goal: "hammer a failing shell command",
      tools: [shell],
      maxSteps: 8,
      model: {
        async complete() {
          step += 1;
          return {
            toolCalls: [
              {
                toolName: "shell",
                arguments: { command: "printf same", timeoutMs: step * 1000 },
              },
            ],
          };
        },
      },
    });

    const result = await run.start();

    expect(result).toMatchObject({
      signal: "failed",
      state: "failed",
      stopReason: "tool_doom_loop",
      failure: { category: "tool", code: "TOOL_DOOM_LOOP" },
    });
    expect(executed).toBe(1);
    expect(step).toBeLessThan(8);
  });

  it("nudges the model one step before the doom-loop stop and lets it recover", async () => {
    let executed = 0;
    let modelCalls = 0;

    const echo = defineTool({
      name: "echo",
      description: "Echo text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute() {
        executed += 1;
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "repeat then recover",
      tools: [echo],
      maxSteps: 8,
      model: {
        async complete() {
          modelCalls += 1;
          // First two turns repeat the identical call. The second one is one
          // step before the limit and comes back as the corrective nudge; a
          // resilient model then changes course and answers directly.
          if (modelCalls <= 2) {
            return {
              toolCalls: [{ toolName: "echo", arguments: { text: "same" } }],
            };
          }
          return { message: "done after the nudge" };
        },
      },
    });

    const result = await run.start();

    // The run completes instead of failing: the nudge replaced the redundant
    // second execution and the model recovered before the hard stop.
    expect(result.stopReason).not.toBe("tool_doom_loop");
    expect(run.record.state).toBe("completed");
    // Only the first identical call actually executed.
    expect(executed).toBe(1);
    // Exactly one corrective nudge was surfaced.
    const nudges = run.events
      .all()
      .filter(
        (event) =>
          event.type === "tool.failed" &&
          (event.payload as { error?: { code?: string } }).error?.code ===
            "REPEATED_TOOL_CALL_SKIPPED",
      );
    expect(nudges).toHaveLength(1);
  });

  it("blocks denied tools before the handler runs", async () => {
    let executed = false;
    let modelCalls = 0;

    const denied = defineTool({
      name: "danger",
      description: "Dangerous tool.",
      inputSchema: { type: "object" },
      policy: { risk: "denied" },
      execute() {
        executed = true;
      },
    });

    const run = createRun({
      goal: "try denied",
      tools: [denied],
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? { toolCalls: [{ toolName: "danger", arguments: {} }] }
            : { message: "saw denial" };
        },
      },
    });

    const result = await run.start();

    const toolFailed = run.events
      .all()
      .find((event) => event.type === "tool.failed");
    expect(executed).toBe(false);
    expect(run.record.state).toBe("completed");
    expect(result.metadata.outcome).toBeUndefined();
    expect(toolFailed?.payload).toMatchObject({
      status: "failed",
      error: { code: "TOOL_DENIED" },
    });
  });

  it("keeps repeated expected denials non-failing and policy-specific", async () => {
    let executed = false;
    let modelCalls = 0;

    const denied = defineTool({
      name: "danger",
      description: "Dangerous tool.",
      inputSchema: { type: "object" },
      policy: { risk: "denied" },
      execute() {
        executed = true;
      },
    });

    const run = createRun({
      goal: "try denied twice",
      tools: [denied],
      maxSteps: 8,
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls <= 2) {
            return { toolCalls: [{ toolName: "danger", arguments: {} }] };
          }
          return { message: "saw denial" };
        },
      },
    });

    const result = await run.start();
    const failures = run.events
      .all()
      .filter((event) => event.type === "tool.failed");
    const repeat = failures.find(
      (event) =>
        (event.payload as { error?: { code?: string } }).error?.code ===
        "REPEATED_TOOL_CALL_SKIPPED",
    );
    const repeatError = (
      repeat?.payload as {
        error?: { message?: string; metadata?: Record<string, unknown> };
      }
    ).error;

    expect(executed).toBe(false);
    expect(result).toMatchObject({
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
    });
    expect(result.metadata.outcome).toBeUndefined();
    expect(
      failures.map(
        (event) => (event.payload as { error?: { code?: string } }).error?.code,
      ),
    ).toEqual(["TOOL_DENIED", "REPEATED_TOOL_CALL_SKIPPED"]);
    expect(repeatError?.metadata).toMatchObject({
      repeatedPriorFailureCode: "TOOL_DENIED",
      repeatedPriorFailureCategory: "policy_denial",
      repeatedPriorFailureExpectedDenial: true,
    });
    expect(repeatError?.message).toContain("expected policy denial");
    expect(repeatError?.message).not.toContain("offset/limit");
    expect(repeatError?.message).not.toContain("listing tool");
  });

  it("reports unknown tools before emitting tool.started", async () => {
    let modelCalls = 0;
    const run = createRun({
      goal: "unknown tool",
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? { toolCalls: [{ toolName: "missing", arguments: {} }] }
            : { message: "saw missing tool" };
        },
      },
    });

    await run.start();

    const eventTypes = run.events.all().map((event) => event.type);
    const toolFailed = run.events
      .all()
      .find((event) => event.type === "tool.failed");
    expect(eventTypes).not.toContain("tool.started");
    expect(toolFailed?.payload).toMatchObject({
      error: { code: "TOOL_NOT_FOUND" },
    });
    expect(run.record.state).toBe("completed");
  });

  it("annotates completed runs that include non-policy tool failures", async () => {
    let modelCalls = 0;
    const run = createRun({
      goal: "unknown tool",
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? { toolCalls: [{ toolName: "missing", arguments: {} }] }
            : { message: "saw missing tool" };
        },
      },
    });

    const result = await run.start();
    const completed = run.events
      .all()
      .find((event) => event.type === "run.completed");

    expect(result).toMatchObject({
      signal: "completed",
      metadata: {
        outcome: {
          kind: "completed_with_tool_failures",
          toolFailures: { count: 1, codes: ["TOOL_NOT_FOUND"] },
        },
      },
    });
    expect(completed?.payload).toMatchObject({
      outcome: {
        kind: "completed_with_tool_failures",
        toolFailures: { count: 1, codes: ["TOOL_NOT_FOUND"] },
      },
    });
  });

  it("annotates completed runs with recovered tool failures separately", async () => {
    let modelCalls = 0;
    const read = defineTool({
      name: "read",
      description: "Read a named item.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute(args) {
        return { path: (args as { path: string }).path };
      },
    });
    const run = createRun({
      goal: "recover invalid args",
      tools: [read],
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                {
                  toolName: "read",
                  arguments: { path: { nested: "README.md" } },
                },
              ],
            };
          }
          if (modelCalls === 2) {
            return {
              toolCalls: [
                { toolName: "read", arguments: { path: "README.md" } },
              ],
            };
          }
          return { message: "recovered" };
        },
      },
    });

    const result = await run.start();
    const completed = run.events
      .all()
      .find((event) => event.type === "run.completed");

    expect(result).toMatchObject({
      signal: "completed",
      metadata: {
        outcome: {
          kind: "completed_with_recovered_tool_failures",
          toolFailures: { count: 1, codes: ["TOOL_ARGUMENTS_INVALID"] },
        },
      },
    });
    expect(completed?.payload).toMatchObject({
      outcome: {
        kind: "completed_with_recovered_tool_failures",
        toolFailures: { count: 1, codes: ["TOOL_ARGUMENTS_INVALID"] },
      },
    });
  });

  it("does not treat a later success on a different target as recovery", async () => {
    let modelCalls = 0;
    const read = defineTool({
      name: "read",
      description: "Read a named item.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute(args) {
        return { path: (args as { path: string }).path };
      },
    });
    const run = createRun({
      goal: "try one target then another",
      tools: [read],
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                {
                  toolName: "read",
                  arguments: { path: { nested: "README.md" } },
                },
              ],
            };
          }
          if (modelCalls === 2) {
            return {
              toolCalls: [
                { toolName: "read", arguments: { path: "package.json" } },
              ],
            };
          }
          return { message: "answered with different target" };
        },
      },
    });

    const result = await run.start();

    expect(result).toMatchObject({
      signal: "completed",
      metadata: {
        outcome: {
          kind: "completed_with_tool_failures",
          toolFailures: { count: 1, codes: ["TOOL_ARGUMENTS_INVALID"] },
        },
      },
    });
  });

  it("does not recover ambiguous object targets by picking one string leaf", async () => {
    let modelCalls = 0;
    const read = defineTool({
      name: "read",
      description: "Read a named item.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute(args) {
        return { path: (args as { path: string }).path };
      },
    });
    const run = createRun({
      goal: "try ambiguous target",
      tools: [read],
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                {
                  toolName: "read",
                  arguments: {
                    path: { old: "README.md", next: "package.json" },
                  },
                },
              ],
            };
          }
          if (modelCalls === 2) {
            return {
              toolCalls: [
                { toolName: "read", arguments: { path: "README.md" } },
              ],
            };
          }
          return { message: "answered with ambiguous prior target" };
        },
      },
    });

    const result = await run.start();

    expect(result).toMatchObject({
      signal: "completed",
      metadata: {
        outcome: {
          kind: "completed_with_tool_failures",
          toolFailures: { count: 1, codes: ["TOOL_ARGUMENTS_INVALID"] },
        },
      },
    });
  });

  it("reports timed out tools through the normal tool failure lifecycle", async () => {
    let modelCalls = 0;

    const slow = defineTool({
      name: "slow",
      description: "Slow tool.",
      inputSchema: { type: "object" },
      async execute() {
        await sleep(30);
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "handle timeout",
      tools: [slow],
      toolTimeoutMs: 5,
      model: {
        async complete(input) {
          modelCalls += 1;

          if (modelCalls === 1) {
            return { toolCalls: [{ toolName: "slow", arguments: {} }] };
          }

          expect(input.context[0]?.content).toContain("TOOL_TIMEOUT");
          return { message: "timeout observed" };
        },
      },
    });

    await run.start();

    const events = run.events.all();
    const eventTypes = events.map((event) => event.type);
    const requestedIndex = eventTypes.indexOf("tool.requested");
    const startedIndex = eventTypes.indexOf("tool.started");
    const failedIndex = eventTypes.indexOf("tool.failed");

    expect(requestedIndex).toBeGreaterThanOrEqual(0);
    expect(startedIndex).toBeGreaterThan(requestedIndex);
    expect(failedIndex).toBeGreaterThan(startedIndex);
    expect(eventTypes).not.toContain("tool.completed");
    expect(events[failedIndex]?.payload).toMatchObject({
      status: "failed",
      error: {
        code: "TOOL_TIMEOUT",
        metadata: {
          toolName: "slow",
          timeoutMs: 5,
        },
      },
    });
    expect(modelCalls).toBe(2);
    expect(run.record.state).toBe("completed");
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("emits tool.replay_risk and annotates result when a non-replay-safe tool times out", async () => {
    let modelCalls = 0;

    const sendPayment = defineTool({
      name: "send_payment",
      description: "Imagine an external POST.",
      inputSchema: { type: "object" },
      isReplaySafe: false,
      async execute() {
        await sleep(30);
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "side-effect tool timeout",
      tools: [sendPayment],
      toolTimeoutMs: 5,
      model: {
        async complete(input) {
          modelCalls += 1;
          if (modelCalls === 1) {
            return { toolCalls: [{ toolName: "send_payment", arguments: {} }] };
          }
          expect(input.context[0]?.content).toContain("replayRisk");
          return { message: "saw replay risk" };
        },
      },
    });

    await run.start();

    const events = run.events.all();
    const types = events.map((e) => e.type);
    const riskIndex = types.indexOf("tool.replay_risk");
    const failedIndex = types.indexOf("tool.failed");

    expect(riskIndex).toBeGreaterThanOrEqual(0);
    expect(failedIndex).toBeGreaterThan(riskIndex); // risk emitted BEFORE failed
    expect(events[riskIndex]?.payload).toMatchObject({
      toolName: "send_payment",
      replayRisk: "side_effect_may_have_landed",
    });
    expect(events[failedIndex]?.payload).toMatchObject({
      error: {
        metadata: { replayRisk: "side_effect_may_have_landed" },
      },
    });
  });

  it("does not emit tool.replay_risk for replay-safe tool failures", async () => {
    let modelCalls = 0;

    const readSomething = defineTool({
      name: "read_something",
      description: "Idempotent read.",
      inputSchema: { type: "object" },
      isReplaySafe: true,
      async execute() {
        await sleep(30);
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "idempotent tool timeout",
      tools: [readSomething],
      toolTimeoutMs: 5,
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [{ toolName: "read_something", arguments: {} }],
            };
          }
          return { message: "moved on" };
        },
      },
    });

    await run.start();

    const types = run.events.all().map((e) => e.type);
    expect(types).not.toContain("tool.replay_risk");
    expect(types).toContain("tool.failed");
  });

  it("turns tool validation failures into observations the model can correct from", async () => {
    let modelCalls = 0;

    const unchecked = defineTool({
      name: "unchecked",
      description: "Return unchecked output.",
      inputSchema: { type: "object" },
      execute() {
        return { text: "bad output" };
      },
    });

    const run = createRun({
      goal: "validate tool result",
      tools: [unchecked],
      validationHooks: [
        {
          name: "tool-output-policy",
          stages: ["tool_result"],
          validate(input) {
            const result = input.subject as { output?: { text?: string } };
            if (result.output?.text === "bad output") {
              return {
                status: "failed",
                findings: [
                  {
                    code: "BAD_TOOL_OUTPUT",
                    message: "Tool output cannot be bad.",
                    severity: "error",
                  },
                ],
              };
            }
          },
        },
      ],
      model: {
        async complete(input) {
          modelCalls += 1;

          if (modelCalls === 1) {
            return { toolCalls: [{ toolName: "unchecked", arguments: {} }] };
          }

          expect(input.context[0]?.content).toContain("VALIDATION_FAILED");
          expect(input.context[0]?.content).toContain("BAD_TOOL_OUTPUT");
          return { message: "corrected" };
        },
      },
    });

    const result = await run.start();
    const eventTypes = run.events.all().map((event) => event.type);

    expect(result).toMatchObject({
      signal: "completed",
      stopReason: "final_answer",
      message: "corrected",
    });
    expect(eventTypes).toEqual(
      expect.arrayContaining(["validation.started", "validation.failed"]),
    );
    expect(eventTypes).not.toContain("tool.completed");
    expect(
      run.events.all().find((event) => event.type === "tool.failed")?.payload,
    ).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        metadata: {
          validation: {
            hookName: "tool-output-policy",
          },
        },
      },
    });
  });

  it("fails the run when final output validation fails", async () => {
    const run = createRun({
      goal: "validate final answer",
      validationHooks: [
        {
          name: "final-answer-policy",
          stages: ["final_output"],
          validate(input) {
            if (input.subject === "ship it") {
              return {
                status: "failed",
                findings: [
                  {
                    code: "FINAL_TOO_LOOSE",
                    message: "Final answer is not specific enough.",
                    severity: "error",
                  },
                ],
              };
            }
          },
        },
      ],
      model: {
        async complete() {
          return { message: "ship it" };
        },
      },
    });

    const result = await run.start();
    const failed = run.events
      .all()
      .find((event) => event.type === "run.failed");

    expect(result).toMatchObject({
      signal: "failed",
      state: "failed",
      stopReason: "validation_failed",
      failure: {
        category: "validation",
        code: "VALIDATION_FAILED",
      },
    });
    expect(failed?.payload).toMatchObject({
      reason: "validation_failed",
      code: "VALIDATION_FAILED",
      metadata: {
        stage: "final_output",
        validation: {
          hookName: "final-answer-policy",
        },
      },
    });
  });

  it("requires approval for risky tools", async () => {
    let executed = false;
    let modelCalls = 0;

    const risky = defineTool({
      name: "risky",
      description: "Risky tool.",
      inputSchema: { type: "object" },
      policy: { risk: "risky" },
      execute() {
        executed = true;
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "approve risky",
      tools: [risky],
      approvalResolver(request) {
        return {
          approvalId: request.id,
          decision: "approved",
        };
      },
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? { toolCalls: [{ toolName: "risky", arguments: {} }] }
            : { message: "approved" };
        },
      },
    });

    await run.start();

    expect(executed).toBe(true);
    expect(run.events.all().map((event) => event.type)).toContain(
      "approval.requested",
    );
    expect(
      run.events.all().find((event) => event.type === "tool.completed")
        ?.metadata,
    ).toMatchObject({
      approvalWaitMs: expect.any(Number),
      executionMs: expect.any(Number),
    });
    expect(run.record.state).toBe("completed");
  });

  it("requires approval when tool policy explicitly requests it", async () => {
    let executed = false;

    const tool = defineTool({
      name: "reviewed",
      description: "Safe but approval-gated tool.",
      inputSchema: { type: "object" },
      policy: { risk: "safe", requiresApproval: true },
      execute() {
        executed = true;
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "approve explicit gate",
      tools: [tool],
      approvalResolver(request) {
        return {
          approvalId: request.id,
          decision: "approved",
        };
      },
      model: {
        async complete(input) {
          return input.step === 1
            ? { toolCalls: [{ toolName: "reviewed", arguments: {} }] }
            : { message: "done" };
        },
      },
    });

    await run.start();

    expect(executed).toBe(true);
    expect(
      run.events.all().find((event) => event.type === "approval.requested")
        ?.payload,
    ).toMatchObject({
      action: "tool.execute",
      details: {
        toolName: "reviewed",
        risk: "safe",
      },
    });
    expect(run.record.state).toBe("completed");
  });

  it("uses tool-owned approval summaries for argument-dependent approvals", async () => {
    const tool = defineTool({
      name: "granting_tool",
      description: "Approval summary test tool.",
      inputSchema: { type: "object" },
      policy: { risk: "safe", requiresApproval: true },
      approvalSummaryForArgs(args: { target?: string }) {
        return `Grant access to ${args.target ?? "unknown"}`;
      },
      execute() {
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "approve custom summary",
      tools: [tool],
      approvalResolver(request) {
        expect(request.summary).toBe("Grant access to workspace");
        return {
          approvalId: request.id,
          decision: "approved",
        };
      },
      model: {
        async complete(input) {
          return input.step === 1
            ? {
                toolCalls: [
                  {
                    toolName: "granting_tool",
                    arguments: { target: "workspace" },
                  },
                ],
              }
            : { message: "done" };
        },
      },
    });

    await run.start();

    expect(
      run.events.all().find((event) => event.type === "approval.requested")
        ?.payload,
    ).toMatchObject({
      summary: "Grant access to workspace",
    });
    expect(run.record.state).toBe("completed");
  });

  it("passes tool governance origin to policy and approval metadata", async () => {
    const seenPolicyMetadata: Record<string, unknown>[] = [];

    const tool = defineTool({
      name: "mcp_demo_echo",
      description: "MCP-backed tool.",
      inputSchema: { type: "object" },
      policy: { risk: "risky" },
      governance: {
        origin: {
          kind: "mcp",
          name: "demo",
          metadata: {
            serverName: "demo",
            mcpToolName: "echo",
          },
        },
        sideEffects: ["external", "network"],
      },
      execute() {
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "approve mcp",
      tools: [tool],
      policy: {
        decide({ action, metadata = {} }) {
          seenPolicyMetadata.push(metadata);
          return {
            action,
            decision: "requires_approval",
            reason: "Review external MCP tool.",
            metadata,
          };
        },
      },
      approvalResolver(request) {
        expect(request.details).toMatchObject({
          toolName: "mcp_demo_echo",
          risk: "risky",
          toolOrigin: {
            kind: "mcp",
            name: "demo",
            metadata: {
              serverName: "demo",
              mcpToolName: "echo",
            },
          },
        });

        return {
          approvalId: request.id,
          decision: "approved",
        };
      },
      model: {
        async complete(input) {
          return input.step === 1
            ? { toolCalls: [{ toolName: "mcp_demo_echo", arguments: {} }] }
            : { message: "done" };
        },
      },
    });

    await run.start();

    expect(seenPolicyMetadata[0]).toMatchObject({
      toolName: "mcp_demo_echo",
      risk: "risky",
      toolOrigin: {
        kind: "mcp",
        name: "demo",
      },
    });
    expect(run.record.state).toBe("completed");
  });

  it("uses per-argument tool governance before read-only workspace gating", async () => {
    let executed = false;
    let modelCalls = 0;
    const tool = defineTool({
      name: "mixed_shell",
      description: "Mixed shell-like tool.",
      inputSchema: {
        type: "object",
        properties: { mode: { type: "string" } },
        required: ["mode"],
      },
      policy: { risk: "risky", requiresApproval: true },
      governance: {
        sideEffects: ["write", "external"],
        origin: { kind: "local", name: "test" },
      },
      policyForArgs(args: { mode: string }) {
        if (args.mode === "read") {
          return {
            policy: { risk: "safe", requiresApproval: false },
            governance: {
              sideEffects: ["read"],
              origin: { kind: "local", name: "test" },
            },
          };
        }
        return {
          policy: { risk: "risky", requiresApproval: true },
          governance: {
            sideEffects: ["write", "external"],
            origin: { kind: "local", name: "test" },
          },
        };
      },
      execute() {
        executed = true;
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "safe per-arg shell",
      tools: [tool],
      policy: createWorkspaceMutationPolicy({ allowWorkspaceWrites: false }),
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [
                  { toolName: "mixed_shell", arguments: { mode: "read" } },
                ],
              }
            : { message: "done" };
        },
      },
    });

    await run.start();

    expect(executed).toBe(true);
    expect(
      run.events.all().some((event) => event.type === "approval.requested"),
    ).toBe(false);
    expect(run.record.state).toBe("completed");
  });

  it("keeps per-argument write-side-effect tools blocked in read-only runs", async () => {
    let executed = false;
    let modelCalls = 0;
    const tool = defineTool({
      name: "mixed_shell",
      description: "Mixed shell-like tool.",
      inputSchema: {
        type: "object",
        properties: { mode: { type: "string" } },
        required: ["mode"],
      },
      policy: { risk: "risky", requiresApproval: true },
      governance: {
        sideEffects: ["write", "external"],
        origin: { kind: "local", name: "test" },
      },
      policyForArgs() {
        return {
          policy: { risk: "risky", requiresApproval: true },
          governance: {
            sideEffects: ["write", "external"],
            origin: { kind: "local", name: "test" },
          },
        };
      },
      execute() {
        executed = true;
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "risky per-arg shell",
      tools: [tool],
      policy: createWorkspaceMutationPolicy({ allowWorkspaceWrites: false }),
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [
                  { toolName: "mixed_shell", arguments: { mode: "write" } },
                ],
              }
            : { message: "blocked" };
        },
      },
    });

    await run.start();

    const toolFailed = run.events
      .all()
      .find((event) => event.type === "tool.failed");
    expect(executed).toBe(false);
    expect(toolFailed?.payload).toMatchObject({
      error: {
        code: "TOOL_DENIED",
        message:
          "Tools with write side effects require an explicit write-enabled run.",
      },
    });
    expect(run.record.state).toBe("completed");
  });

  it("denies per-argument write-side-effect tools in read-only runs before approval", async () => {
    let executed = false;
    let modelCalls = 0;
    const tool = defineTool({
      name: "mixed_shell",
      description: "Mixed shell-like tool.",
      inputSchema: {
        type: "object",
        properties: { mode: { type: "string" } },
        required: ["mode"],
      },
      policy: { risk: "risky", requiresApproval: true },
      governance: {
        sideEffects: ["write", "external"],
        origin: { kind: "local", name: "test" },
      },
      policyForArgs() {
        return {
          policy: { risk: "risky", requiresApproval: true },
          governance: {
            sideEffects: ["write", "external"],
            origin: { kind: "local", name: "test" },
          },
        };
      },
      execute() {
        executed = true;
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "approve risky per-arg shell",
      tools: [tool],
      policy: createWorkspaceMutationPolicy({
        allowWorkspaceWrites: false,
      }),
      approvalResolver() {
        throw new Error("read-only write-side-effect tools must not ask");
      },
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [
                  { toolName: "mixed_shell", arguments: { mode: "write" } },
                ],
              }
            : { message: "approved" };
        },
      },
    });

    await run.start();

    expect(executed).toBe(false);
    expect(
      run.events.all().some((event) => event.type === "approval.requested"),
    ).toBe(false);
    expect(
      run.events.all().some((event) => event.type === "tool.completed"),
    ).toBe(false);
    expect(
      run.events.all().find((event) => event.type === "tool.failed")?.payload,
    ).toMatchObject({
      toolName: "mixed_shell",
      error: {
        code: "TOOL_DENIED",
        message:
          "Tools with write side effects require an explicit write-enabled run.",
      },
    });
    expect(run.record.state).toBe("completed");
  });

  it("can be cancelled before it starts", () => {
    const run = createRun({ goal: "cancel me" });

    const result = run.cancel({
      reason: "User stopped the run.",
      metadata: { source: "test" },
    });

    expect(result).toMatchObject({
      signal: "cancelled",
      state: "cancelled",
      stopReason: "manual_cancelled",
      message: "User stopped the run.",
      metadata: {
        source: "test",
      },
    });
    expect(run.record.state).toBe("cancelled");
    expect(run.record.stopReason).toBe("manual_cancelled");
    expect(run.events.all().map((event) => event.type)).toEqual([
      "run.created",
      "run.cancelled",
    ]);
  });

  it("kicks RunEnd hooks when cancelled", async () => {
    const payloads: unknown[] = [];
    const run = createRun({
      goal: "cancel hook",
      workflowHooks: [
        {
          name: "capture-run-end",
          hook: "RunEnd",
          handle(input) {
            payloads.push(input.payload);
          },
        },
      ],
    });

    run.cancel({
      reason: "User stopped the run.",
      metadata: { source: "test" },
    });

    await waitForCondition(() => payloads.length === 1);

    expect(payloads[0]).toMatchObject({
      state: "cancelled",
      reason: "manual_cancelled",
      result: {
        signal: "cancelled",
        state: "cancelled",
        stopReason: "manual_cancelled",
        message: "User stopped the run.",
        metadata: { source: "test" },
      },
    });
    expect(run.events.all().map((event) => event.type)).toEqual([
      "run.created",
      "run.cancelled",
      "workflow_hook.started",
      "workflow_hook.completed",
    ]);
  });

  it("does not emit a second terminal when a cancel lands as the run completes", async () => {
    // Race: a cancel arrives while the model is producing its final answer. The
    // model cancels mid-completion, then returns — the loop must not emit a
    // run.completed on top of the run.cancelled (which would give the run two
    // terminal events and fail trace verification).
    let runRef: { cancel: () => unknown } | null = null;
    const run = createRun({
      goal: "cancel as it finishes",
      model: {
        async complete() {
          runRef?.cancel();
          return { message: "final answer despite cancel" };
        },
      },
    });
    runRef = run;

    const result = await run.start();

    expect(result.signal).toBe("cancelled");
    const terminals = run.events
      .all()
      .map((event) => event.type)
      .filter(
        (type) =>
          type === "run.completed" ||
          type === "run.failed" ||
          type === "run.cancelled",
      );
    expect(terminals).toEqual(["run.cancelled"]);
  });

  it("does not enter waiting_tasks after cancellation wins the final-output race", async () => {
    const source = new ManualTaskRevivalSource();
    source.pending = true;
    let runRef: { cancel: () => unknown } | null = null;
    const run = createRun({
      goal: "cancel before awaited-task suspension",
      notificationSources: [source],
      taskRevivalSource: source,
      model: {
        async complete() {
          runRef?.cancel();
          return { message: "final answer despite cancel" };
        },
      },
    });
    runRef = run;

    const result = await run.start();

    expect(result.signal).toBe("cancelled");
    expect(run.record.state).toBe("cancelled");
    expect(
      run.events
        .all()
        .filter((event) => event.type === "run.state_transition.rejected"),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ to: "waiting_tasks" }),
        }),
      ]),
    );
  });

  it("does not restart after cancellation", async () => {
    const run = createRun({
      goal: "cancel then start",
      model: {
        async complete() {
          return { message: "should not run" };
        },
      },
    });

    run.cancel();
    const result = await run.start();

    expect(run.record.state).toBe("cancelled");
    expect(result.signal).toBe("cancelled");
    expect(run.events.all().map((event) => event.type)).toEqual([
      "run.created",
      "run.cancelled",
    ]);
  });

  it("does not request approval when risky tool arguments are invalid", async () => {
    let executed = false;
    let modelCalls = 0;

    const risky = defineTool({
      name: "risky",
      description: "Risky tool.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
      policy: { risk: "risky" },
      execute() {
        executed = true;
      },
    });

    const run = createRun({
      goal: "invalid risky",
      tools: [risky],
      approvalResolver(request) {
        throw new Error(
          `Approval should not be requested for ${request.action}`,
        );
      },
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? { toolCalls: [{ toolName: "risky", arguments: {} }] }
            : { message: "saw invalid args" };
        },
      },
    });

    await run.start();

    const eventTypes = run.events.all().map((event) => event.type);
    const toolFailed = run.events
      .all()
      .find((event) => event.type === "tool.failed");
    const failedMetadata = (
      toolFailed?.payload as { error?: { metadata?: Record<string, unknown> } }
    ).error?.metadata;
    expect(executed).toBe(false);
    expect(eventTypes).not.toContain("approval.requested");
    expect(eventTypes).not.toContain("tool.started");
    expect(toolFailed?.payload).toMatchObject({
      toolName: "risky",
      error: {
        code: "TOOL_ARGUMENTS_INVALID",
        metadata: { toolName: "risky" },
      },
    });
    expect(failedMetadata?.reason).not.toBe("schema_not_loaded");
    expect(toolFailed?.metadata).toMatchObject({
      schemaValidationMs: expect.any(Number),
    });
  });

  it("reports approval denial for risky tools", async () => {
    let executed = false;
    let modelCalls = 0;

    const risky = defineTool({
      name: "risky",
      description: "Risky tool.",
      inputSchema: { type: "object" },
      policy: { risk: "risky" },
      execute() {
        executed = true;
      },
    });

    const run = createRun({
      goal: "deny risky",
      tools: [risky],
      approvalResolver(request) {
        expect(run.record.state).toBe("waiting_approval");
        return {
          approvalId: request.id,
          decision: "denied",
        };
      },
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? { toolCalls: [{ toolName: "risky", arguments: {} }] }
            : { message: "denied" };
        },
      },
    });

    await run.start();

    const toolFailed = run.events
      .all()
      .find((event) => event.type === "tool.failed");
    expect(executed).toBe(false);
    expect(run.record.state).toBe("completed");
    expect(toolFailed?.payload).toMatchObject({
      error: { code: "TOOL_APPROVAL_DENIED" },
    });
  });

  it("reports unavailable approval for risky tools without a resolver", async () => {
    let executed = false;
    let modelCalls = 0;

    const risky = defineTool({
      name: "risky",
      description: "Risky tool.",
      inputSchema: { type: "object" },
      policy: { risk: "risky" },
      execute() {
        executed = true;
      },
    });

    const run = createRun({
      goal: "missing resolver",
      tools: [risky],
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? { toolCalls: [{ toolName: "risky", arguments: {} }] }
            : { message: "approval unavailable" };
        },
      },
    });

    await run.start();

    const toolFailed = run.events
      .all()
      .find((event) => event.type === "tool.failed");
    expect(executed).toBe(false);
    expect(toolFailed?.payload).toMatchObject({
      error: { code: "APPROVAL_UNAVAILABLE" },
    });
  });

  it("blocks tools denied by a custom policy", async () => {
    let executed = false;
    let modelCalls = 0;

    const tool = defineTool({
      name: "blocked",
      description: "Blocked tool.",
      inputSchema: { type: "object" },
      execute() {
        executed = true;
      },
    });

    const run = createRun({
      goal: "policy deny",
      tools: [tool],
      policy: {
        decide({ action, metadata = {} }) {
          return {
            action,
            decision: "deny",
            reason: "No tools allowed.",
            metadata,
          };
        },
      },
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? { toolCalls: [{ toolName: "blocked", arguments: {} }] }
            : { message: "blocked" };
        },
      },
    });

    await run.start();

    const eventTypes = run.events.all().map((event) => event.type);
    const toolFailed = run.events
      .all()
      .find((event) => event.type === "tool.failed");
    expect(executed).toBe(false);
    expect(eventTypes).not.toContain("approval.requested");
    expect(eventTypes).not.toContain("tool.started");
    expect(toolFailed?.payload).toMatchObject({
      error: { code: "TOOL_DENIED" },
    });
  });

  it("reports model completion failures", async () => {
    const run = createRun({
      goal: "throwing model",
      model: {
        async complete() {
          throw new Error("provider unavailable");
        },
      },
    });

    await run.start();

    const failed = run.events
      .all()
      .find((event) => event.type === "run.failed");
    expect(run.record.state).toBe("failed");
    expect(failed?.payload).toMatchObject({
      code: "MODEL_COMPLETION_FAILED",
      message: "provider unavailable",
    });
  });

  it("summarizes raw model failure causes before emitting terminal results", async () => {
    const responseBody = `${"x".repeat(2200)} tail`;
    const run = createRun({
      goal: "provider request failure",
      model: {
        async complete() {
          throw Object.assign(new Error("bad request"), {
            code: "invalid_api_key",
            status: 400,
            statusCode: 400,
            requestBodyValues: {
              input: [{ role: "user", content: "secret prompt" }],
              tools: [{ name: "read_file", inputSchema: { type: "object" } }],
            },
            responseHeaders: {
              "x-request-id": "req_sanitized",
              "set-cookie": "session=should-not-persist",
              authorization: "Bearer should-not-persist",
            },
            responseBody,
            data: {
              error: {
                code: "invalid_api_key",
                message: "bad request",
              },
            },
          });
        },
      },
    });

    const result = await run.start();
    const failed = run.events
      .all()
      .find((event) => event.type === "run.failed");
    const payload = failed?.payload as
      | {
          failure?: { metadata?: Record<string, unknown> };
          metadata?: Record<string, unknown>;
        }
      | undefined;
    const serializedFailureEvent = JSON.stringify(failed);
    const topCause = payload?.metadata?.cause as
      | Record<string, unknown>
      | undefined;
    const failureCause = payload?.failure?.metadata?.cause as
      | Record<string, unknown>
      | undefined;
    const resultCause = result.metadata?.cause as
      | Record<string, unknown>
      | undefined;

    expect(topCause).toMatchObject({
      name: "Error",
      message: "bad request",
      code: "invalid_api_key",
      status: 400,
      statusCode: 400,
      requestId: "req_sanitized",
    });
    expect(topCause?.responseBodyPreview).toEqual(`${"x".repeat(2000)}...`);
    expect(failureCause).toEqual(topCause);
    expect(resultCause).toEqual(topCause);
    for (const cause of [topCause!, failureCause!, resultCause!]) {
      expect(cause).not.toHaveProperty("requestBodyValues");
      expect(cause).not.toHaveProperty("input");
      expect(cause).not.toHaveProperty("tools");
      expect(cause).not.toHaveProperty("responseHeaders");
      expect(cause).not.toHaveProperty("data");
    }
    expect(serializedFailureEvent).not.toContain("set-cookie");
    expect(serializedFailureEvent).not.toContain("session=should-not-persist");
    expect(serializedFailureEvent).not.toContain("requestBodyValues");
    expect(serializedFailureEvent).not.toContain("secret prompt");
    expect(payload?.metadata?.modelError).toMatchObject({
      message: "bad request",
      status: 400,
    });
  });

  it("retries retryable model completion failures", async () => {
    let modelCalls = 0;

    const run = createRun({
      goal: "retry model",
      model: {
        async complete() {
          modelCalls += 1;

          if (modelCalls === 1) {
            throw Object.assign(new Error("rate limited"), { status: 429 });
          }

          return { message: "done after retry" };
        },
      },
    });

    await run.start();

    const events = run.events.all();
    const retry = events.find((event) => event.type === "model.retrying");
    expect(modelCalls).toBe(2);
    expect(run.record.state).toBe("completed");
    expect(retry?.payload).toMatchObject({
      step: 1,
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      error: {
        message: "rate limited",
        status: 429,
      },
    });
    expect(
      events
        .map((event) => event.type)
        .filter((type) => type === "model.requested"),
    ).toHaveLength(2);
  });

  it("backs off with the configured delay between retries (jitter none)", async () => {
    let modelCalls = 0;

    const run = createRun({
      goal: "retry with backoff",
      modelRetry: {
        maxAttempts: 3,
        initialDelayMs: 30,
        backoffMultiplier: 2,
        jitter: "none",
      },
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls < 3) {
            throw Object.assign(new Error("rate limited"), { status: 429 });
          }
          return { message: "done after backoff" };
        },
      },
    });

    const startedAt = Date.now();
    await run.start();
    const elapsed = Date.now() - startedAt;

    expect(modelCalls).toBe(3);
    expect(run.record.state).toBe("completed");

    const retries = run.events
      .all()
      .filter((event) => event.type === "model.retrying");
    // Two failures => two retry events with deterministic exponential delays:
    // attempt 1 -> 30ms (30 * 2^0), attempt 2 -> 60ms (30 * 2^1).
    expect(
      retries.map((event) => (event.payload as { delayMs: number }).delayMs),
    ).toEqual([30, 60]);
    // The loop must actually await the cool-downs (30 + 60 = 90ms floor).
    expect(elapsed).toBeGreaterThanOrEqual(85);
  });

  it("honors a provider Retry-After header over computed backoff", async () => {
    let modelCalls = 0;

    const run = createRun({
      goal: "retry after header",
      modelRetry: {
        maxAttempts: 2,
        initialDelayMs: 5,
        jitter: "none",
        respectRetryAfter: true,
      },
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            throw Object.assign(new Error("slow down"), {
              status: 429,
              headers: { "retry-after": "1" },
            });
          }
          return { message: "ok" };
        },
      },
    });

    await run.start();

    const retry = run.events
      .all()
      .find((event) => event.type === "model.retrying");
    // Retry-After "1" second (1000ms) wins over the 5ms computed backoff.
    expect((retry?.payload as { delayMs: number }).delayMs).toBe(1000);
    expect(
      (retry?.payload as { error: { retryAfterMs?: number } }).error
        .retryAfterMs,
    ).toBe(1000);
  });

  it("retries immediately when initialDelayMs is 0 (legacy behavior)", async () => {
    let modelCalls = 0;

    const run = createRun({
      goal: "retry immediately",
      modelRetry: { maxAttempts: 2, initialDelayMs: 0 },
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            throw Object.assign(new Error("transient"), { status: 503 });
          }
          return { message: "ok" };
        },
      },
    });

    await run.start();

    const retry = run.events
      .all()
      .find((event) => event.type === "model.retrying");
    expect((retry?.payload as { delayMs: number }).delayMs).toBe(0);
    expect(run.record.state).toBe("completed");
  });

  it("rejects modelRetry.maxDelayMs below initialDelayMs", () => {
    expect(() =>
      createRun({
        goal: "bad backoff config",
        model: {
          async complete() {
            return { message: "x" };
          },
        },
        modelRetry: { initialDelayMs: 1000, maxDelayMs: 500 },
      }),
    ).toThrow(
      "modelRetry.maxDelayMs must be a finite number >= initialDelayMs",
    );
  });

  it("stops when the run model-call budget is exceeded", async () => {
    let modelCalls = 0;

    const run = createRun({
      goal: "retry within budget",
      runBudget: { maxModelCalls: 1 },
      model: {
        async complete() {
          modelCalls += 1;
          throw Object.assign(new Error("rate limited"), { status: 429 });
        },
      },
    });

    const result = await run.start();

    expect(modelCalls).toBe(1);
    expect(result).toMatchObject({
      signal: "failed",
      stopReason: "max_model_calls_exceeded",
      failure: {
        code: "MAX_MODEL_CALLS_EXCEEDED",
      },
    });
    expect(run.events.all().map((event) => event.type)).toContain(
      "run.budget.checked",
    );
  });

  it("stops before requesting a tool when the tool-call budget is exhausted", async () => {
    const echo = defineTool({
      name: "echo",
      description: "Echo.",
      inputSchema: { type: "object" },
      execute: (args) => args,
    });

    const run = createRun({
      goal: "tool budget",
      tools: [echo],
      runBudget: { maxToolCalls: 1 },
      model: {
        async complete(input) {
          return input.step <= 2
            ? { toolCalls: [{ toolName: "echo", arguments: {} }] }
            : { message: "done" };
        },
      },
    });

    const result = await run.start();

    expect(result).toMatchObject({
      signal: "failed",
      stopReason: "max_tool_calls_exceeded",
      failure: {
        code: "MAX_TOOL_CALLS_EXCEEDED",
      },
    });
    expect(
      run.events.all().filter((event) => event.type === "tool.requested"),
    ).toHaveLength(1);
  });

  it("stops when model usage exceeds token budget", async () => {
    const run = createRun({
      goal: "token budget",
      runBudget: { maxTokens: 5 },
      model: {
        async complete() {
          return {
            message: "done",
            usage: {
              inputTokens: 4,
              outputTokens: 3,
            },
          };
        },
      },
    });

    const result = await run.start();

    expect(result).toMatchObject({
      signal: "failed",
      stopReason: "token_budget_exceeded",
      failure: {
        code: "TOKEN_BUDGET_EXCEEDED",
      },
    });
    expect(
      run.events
        .all()
        .filter((event) => event.type === "run.budget.checked")
        .at(-1)?.payload,
    ).toMatchObject({
      usage: {
        modelCalls: 1,
        tokens: 7,
      },
    });
  });

  it("does not retry non-retryable model completion failures", async () => {
    let modelCalls = 0;

    const run = createRun({
      goal: "bad request",
      model: {
        async complete() {
          modelCalls += 1;
          throw Object.assign(new Error("bad request"), { status: 400 });
        },
      },
    });

    await run.start();

    const events = run.events.all();
    const failed = events.find((event) => event.type === "run.failed");
    expect(modelCalls).toBe(1);
    expect(events.map((event) => event.type)).not.toContain("model.retrying");
    expect(failed?.payload).toMatchObject({
      reason: "model_completion_failed",
      code: "MODEL_COMPLETION_FAILED",
      message: "bad request",
      metadata: {
        attempts: 1,
        maxAttempts: 3,
        retryable: false,
      },
    });
  });

  it("retries nested transient provider failures", async () => {
    let modelCalls = 0;

    const run = createRun({
      goal: "nested retry",
      model: {
        async complete() {
          modelCalls += 1;

          if (modelCalls === 1) {
            throw {
              message: "connect timeout",
              cause: {
                code: "UND_ERR_CONNECT_TIMEOUT",
              },
            };
          }

          return { message: "done after nested retry" };
        },
      },
    });

    await run.start();

    const events = run.events.all();
    const retry = events.find((event) => event.type === "model.retrying");
    expect(modelCalls).toBe(2);
    expect(run.record.state).toBe("completed");
    expect(retry?.payload).toMatchObject({
      step: 1,
      attempt: 1,
      nextAttempt: 2,
      error: {
        message: "connect timeout",
        code: "UND_ERR_CONNECT_TIMEOUT",
        category: "timeout",
        timeoutKind: "connect",
      },
    });
  });

  it("classifies exhausted model timeouts in failure metadata", async () => {
    let modelCalls = 0;

    const run = createRun({
      goal: "timeout exhausted",
      modelRetry: {
        maxAttempts: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        backoffMultiplier: 1,
        jitter: "none",
      },
      model: {
        async complete() {
          modelCalls += 1;
          throw Object.assign(new Error("request timeout"), {
            code: "TIMEOUT",
            timeoutKind: "request",
            configuredTimeoutMs: 100,
            elapsedMs: 101,
          });
        },
      },
    });

    await run.start();

    const failed = run.events
      .all()
      .find((event) => event.type === "run.failed");
    expect(modelCalls).toBe(1);
    expect(run.record.state).toBe("failed");
    expect(failed?.payload).toMatchObject({
      reason: "model_retry_exhausted",
      metadata: {
        retryable: true,
        modelError: {
          category: "timeout",
          timeoutKind: "request",
          configuredTimeoutMs: 100,
          elapsedMs: 101,
        },
      },
    });
  });

  it("emits model.stream.timeout for streaming model timeouts", async () => {
    const run = createRun({
      goal: "stream timeout",
      modelRetry: { maxAttempts: 1 },
      model: {
        async complete() {
          return { message: "unused" };
        },
        async *stream() {
          for (const chunk of [] as Array<{
            type: "text_delta";
            text: string;
          }>) {
            yield chunk;
          }
          throw Object.assign(new Error("stream timed out"), {
            code: "TIMEOUT",
            timeoutKind: "stream",
            configuredTimeoutMs: 50,
            elapsedMs: 51,
          });
        },
      },
    });

    await run.start();

    const timeout = run.events
      .all()
      .find((event) => event.type === "model.stream.timeout");
    const failed = run.events
      .all()
      .find((event) => event.type === "model.stream.failed");
    expect(timeout?.payload).toMatchObject({
      step: 1,
      message: "stream timed out",
      timeoutKind: "stream",
      configuredTimeoutMs: 50,
      elapsedMs: 51,
      retryable: true,
    });
    expect(failed?.payload).toMatchObject({
      error: "stream timed out",
      metadata: {
        category: "timeout",
        timeoutKind: "stream",
      },
    });
  });

  it("does not retry non-recoverable provider quota failures", async () => {
    let modelCalls = 0;

    const run = createRun({
      goal: "quota exhausted",
      model: {
        async complete() {
          modelCalls += 1;
          throw Object.assign(new Error("quota exceeded"), {
            statusCode: 429,
            data: {
              error: {
                code: "insufficient_quota",
              },
            },
          });
        },
      },
    });

    await run.start();

    const events = run.events.all();
    const failed = events.find((event) => event.type === "run.failed");
    expect(modelCalls).toBe(1);
    expect(events.map((event) => event.type)).not.toContain("model.retrying");
    expect(failed?.payload).toMatchObject({
      reason: "model_quota_exhausted",
      metadata: {
        attempts: 1,
        retryable: false,
        modelError: { category: "quota" },
      },
    });
  });

  it("flags missing/invalid API key failures as model_auth_failed", async () => {
    let modelCalls = 0;

    const run = createRun({
      goal: "auth failure",
      model: {
        async complete() {
          modelCalls += 1;
          throw Object.assign(new Error("invalid api key"), {
            status: 401,
            data: { error: { code: "invalid_api_key" } },
          });
        },
      },
    });

    await run.start();

    const events = run.events.all();
    const failed = events.find((event) => event.type === "run.failed");
    expect(modelCalls).toBe(1);
    expect(events.map((event) => event.type)).not.toContain("model.retrying");
    expect(run.record.stopReason).toBe("model_auth_failed");
    expect(failed?.payload).toMatchObject({
      reason: "model_auth_failed",
      metadata: {
        attempts: 1,
        retryable: false,
        modelError: { category: "auth" },
      },
    });
  });

  it("pauses in waiting_credentials and resumes after credentialResolver refreshes auth", async () => {
    let modelCalls = 0;
    const stateChanges: string[] = [];

    const run = createRun({
      goal: "auth refresh path",
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            throw Object.assign(new Error("invalid api key"), {
              status: 401,
              data: { error: { code: "invalid_api_key" } },
            });
          }
          return { message: "after refresh" };
        },
      },
      hooks: [
        {
          name: "credential-observer",
          onEvent: ({ event }) => {
            if (
              event.type === "run.waiting_credentials" ||
              event.type === "run.credentials_refreshed"
            ) {
              stateChanges.push(event.type);
            }
          },
        },
      ],
      credentialResolver: async (req) => {
        expect(req.category).toBe("auth");
        return { refreshed: true, metadata: { method: "test" } };
      },
    });

    const result = await run.start();

    expect(modelCalls).toBe(2);
    expect(result.signal).toBe("completed");
    expect(result.message).toBe("after refresh");
    expect(stateChanges).toEqual([
      "run.waiting_credentials",
      "run.credentials_refreshed",
    ]);
    expect(run.record.state).toBe("completed");
  });

  it("falls through to model_quota_exhausted when the resolver declines refresh", async () => {
    let resolverCalled = 0;
    const run = createRun({
      goal: "quota declined refresh",
      model: {
        async complete() {
          throw Object.assign(new Error("quota exceeded"), {
            statusCode: 429,
            data: { error: { code: "insufficient_quota" } },
          });
        },
      },
      credentialResolver: async () => {
        resolverCalled += 1;
        return { refreshed: false };
      },
    });

    const result = await run.start();

    expect(resolverCalled).toBe(1);
    expect(result.signal).toBe("failed");
    expect(run.record.stopReason).toBe("model_quota_exhausted");
  });

  it("fails with structured metadata after exhausting model retries", async () => {
    let modelCalls = 0;

    const run = createRun({
      goal: "exhaust retries",
      modelRetry: { maxAttempts: 2 },
      model: {
        async complete() {
          modelCalls += 1;
          throw Object.assign(new Error("server unavailable"), {
            code: "ECONNRESET",
          });
        },
      },
    });

    await run.start();

    const events = run.events.all();
    const failed = events.find((event) => event.type === "run.failed");
    expect(modelCalls).toBe(2);
    expect(
      events.filter((event) => event.type === "model.retrying"),
    ).toHaveLength(1);
    expect(run.record.state).toBe("failed");
    expect(run.record.stopReason).toBe("model_retry_exhausted");
    expect(failed?.payload).toMatchObject({
      reason: "model_retry_exhausted",
      code: "MODEL_COMPLETION_FAILED",
      message: "server unavailable",
      metadata: {
        attempts: 2,
        maxAttempts: 2,
        retryable: true,
      },
    });
  });

  it("approval-gates workspace writes made by safe tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-run-workspace-"));
    tempDirs.push(root);
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    let modelCalls = 0;

    const writeReadme = defineTool({
      name: "write_readme",
      description: "Write README.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        required: ["content"],
      },
      policy: { risk: "safe" },
      async execute(args, ctx) {
        if (!ctx.workspace) throw new Error("missing workspace");
        const input = args as { content: string };
        const write = await ctx.workspace.writeText(
          "README.md",
          input.content,
          {
            reason: "test write",
          },
        );
        if (write?.diffArtifact) ctx.reportToolArtifact?.(write.diffArtifact);
        return { ok: true, diffArtifactId: write?.diffArtifactId };
      },
    });

    const run = createRun({
      goal: "write file",
      workspace: new LocalWorkspace(root),
      tools: [writeReadme],
      approvalResolver(request) {
        expect(request.action).toBe("workspace.write");
        return {
          approvalId: request.id,
          decision: "approved",
        };
      },
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [
                  {
                    toolName: "write_readme",
                    arguments: { content: "after\n" },
                  },
                ],
              }
            : { message: "done" };
        },
      },
    });

    await run.start();

    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "after\n",
    );
    expect(run.record.state).toBe("completed");
    expect(run.events.all().map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "workspace.write.requested",
        "artifact.created",
        "approval.requested",
        "approval.resolved",
        "workspace.write.completed",
        "tool.completed",
      ]),
    );
    const toolCompleted = run.events
      .all()
      .find((event) => event.type === "tool.completed");
    expect(toolCompleted?.payload).toMatchObject({
      artifacts: [
        {
          type: "diff",
          metadata: {
            targetPath: "README.md",
          },
        },
      ],
    });
  });

  it("reports tool failure when workspace write approval is denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-run-workspace-"));
    tempDirs.push(root);
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    let modelCalls = 0;

    const writeReadme = defineTool({
      name: "write_readme",
      description: "Write README.",
      inputSchema: { type: "object" },
      policy: { risk: "safe" },
      async execute(_, ctx) {
        if (!ctx.workspace) throw new Error("missing workspace");
        await ctx.workspace.writeText("README.md", "after\n");
      },
    });

    const run = createRun({
      goal: "write denied",
      workspace: new LocalWorkspace(root),
      tools: [writeReadme],
      approvalResolver(request) {
        return {
          approvalId: request.id,
          decision: "denied",
        };
      },
      model: {
        async complete() {
          modelCalls += 1;
          return modelCalls === 1
            ? { toolCalls: [{ toolName: "write_readme", arguments: {} }] }
            : { message: "denied observed" };
        },
      },
    });

    await run.start();

    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "before\n",
    );
    expect(run.record.state).toBe("completed");
    expect(run.events.all().map((event) => event.type)).toContain(
      "workspace.write.denied",
    );
    expect(run.events.all().map((event) => event.type)).not.toContain(
      "artifact.created",
    );
    expect(
      run.events.all().find((event) => event.type === "tool.failed")?.payload,
    ).toMatchObject({
      error: {
        code: "APPROVAL_DENIED",
        metadata: {
          path: "README.md",
        },
      },
    });
  });

  it("rejects non-positive maxSteps", () => {
    expect(() =>
      createRun({
        goal: "bad max steps",
        maxSteps: 0,
      }),
    ).toThrow("maxSteps must be a positive integer");
  });

  it("rejects non-positive toolTimeoutMs", () => {
    expect(() =>
      createRun({
        goal: "bad tool timeout",
        toolTimeoutMs: 0,
      }),
    ).toThrow("toolTimeoutMs must be a positive integer");
  });

  it("rejects non-positive modelRetry.maxAttempts", () => {
    expect(() =>
      createRun({
        goal: "bad retry policy",
        modelRetry: { maxAttempts: 0 },
      }),
    ).toThrow("modelRetry.maxAttempts must be a positive integer");
  });

  it("rejects invalid run budgets", () => {
    expect(() =>
      createRun({
        goal: "bad budget",
        runBudget: { maxToolCalls: 0 },
      }),
    ).toThrow("runBudget.maxToolCalls must be a positive integer");

    expect(() =>
      createRun({
        goal: "bad cost budget",
        runBudget: { maxCostUsd: 0 },
      }),
    ).toThrow("runBudget.maxCostUsd must be a positive number");
  });

  it("reports invalid model output as run failure", async () => {
    const run = createRun({
      goal: "bad model",
      model: {
        async complete() {
          return { toolCalls: "not-an-array" } as never;
        },
      },
    });

    await run.start();

    const failed = run.events
      .all()
      .find((event) => event.type === "run.failed");
    expect(run.record.state).toBe("failed");
    expect(failed?.payload).toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  });

  it("detects doom loop from repeated tool calls within a single step", async () => {
    const echo = defineTool({
      name: "echo",
      description: "Echo text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute() {
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "repeat in one step",
      tools: [echo],
      maxSteps: 2,
      model: {
        async complete() {
          return {
            toolCalls: Array.from({ length: 5 }, () => ({
              toolName: "echo",
              arguments: { text: "same" },
            })),
          };
        },
      },
    });

    const result = await run.start();

    expect(result.stopReason).toBe("tool_doom_loop");
    const failed = run.events
      .all()
      .find((event) => event.type === "run.failed");
    expect(failed?.payload).toMatchObject({
      metadata: {
        toolName: "echo",
        repeatLimit: 3,
      },
    });
    expect(
      (failed?.payload as { metadata: { repeatedToolCallCount: number } })
        .metadata.repeatedToolCallCount,
    ).toBeGreaterThanOrEqual(3);
  });

  it("honors the doomLoopRepeatLimit override", async () => {
    const echo = defineTool({
      name: "echo",
      description: "Echo text.",
      inputSchema: { type: "object" },
      execute() {
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "custom doom limit",
      tools: [echo],
      maxSteps: 2,
      doomLoopRepeatLimit: 5,
      model: {
        async complete() {
          return {
            toolCalls: Array.from({ length: 5 }, () => ({
              toolName: "echo",
              arguments: { text: "same" },
            })),
          };
        },
      },
    });

    const result = await run.start();
    expect(result.stopReason).toBe("tool_doom_loop");
    const failed = run.events
      .all()
      .find((event) => event.type === "run.failed");
    expect(failed?.payload).toMatchObject({
      metadata: { repeatLimit: 5 },
    });
  });

  it("fails with model_output_invalid when streamed tool call arguments are not valid JSON", async () => {
    let modelCalls = 0;

    const echo = defineTool({
      name: "echo",
      description: "Echo text.",
      inputSchema: { type: "object" },
      execute() {
        return { ok: true };
      },
    });

    const model: ModelAdapter = {
      async complete() {
        throw new Error("complete() should not be called when stream() exists");
      },
      async *stream() {
        modelCalls += 1;
        yield {
          type: "tool_call_start" as const,
          toolCallIndex: 0,
          toolName: "echo",
        };
        yield {
          type: "tool_call_delta" as const,
          toolCallIndex: 0,
          argumentsDelta: "{not valid json",
        };
      },
    };

    const run = createRun({
      goal: "bad streaming json",
      tools: [echo],
      model,
      maxSteps: 2,
    });

    const result = await run.start();

    expect(result.signal).toBe("failed");
    expect(result.stopReason).toBe("model_output_invalid");
    expect(modelCalls).toBe(1); // not retried
    const failed = run.events
      .all()
      .find((event) => event.type === "run.failed");
    expect(failed?.payload).toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
      metadata: {
        toolName: "echo",
        retryable: false,
      },
    });
    expect(
      (failed?.payload as { metadata: { rawArgumentsPreview: string } })
        .metadata.rawArgumentsPreview,
    ).toContain("{not valid json");
  });

  it("treats empty streamed tool-call arguments as `{}` instead of failing", async () => {
    let modelCalls = 0;
    let receivedArgs: unknown;

    const ping = defineTool({
      name: "ping",
      description: "Zero-argument tool.",
      inputSchema: { type: "object" },
      execute(args: unknown) {
        receivedArgs = args;
        return { ok: true };
      },
    });

    const model: ModelAdapter = {
      async complete() {
        throw new Error("complete() should not be called when stream() exists");
      },
      async *stream() {
        modelCalls += 1;
        if (modelCalls === 1) {
          // Some models emit start/end for a zero-argument tool without any
          // argumentsDelta in between.
          yield {
            type: "tool_call_start" as const,
            toolCallIndex: 0,
            toolName: "ping",
          };
          yield { type: "tool_call_end" as const, toolCallIndex: 0 };
          return;
        }
        yield { type: "text_delta" as const, text: "done" };
      },
    };

    const run = createRun({
      goal: "zero-argument streamed tool call",
      tools: [ping],
      model,
      maxSteps: 2,
    });

    const result = await run.start();

    expect(result.signal).toBe("completed");
    expect(receivedArgs).toEqual({});
    expect(run.events.all().map((event) => event.type)).toEqual(
      expect.arrayContaining(["tool.completed"]),
    );
    expect(run.events.all().some((event) => event.type === "run.failed")).toBe(
      false,
    );
  });

  it("uses streaming adapter and emits model.stream.started and model.stream.completed events", async () => {
    const events: SparkwrightEvent[] = [];

    const model: ModelAdapter = {
      async complete() {
        throw new Error("complete() should not be called when stream() exists");
      },
      async *stream() {
        yield { type: "text_delta" as const, text: "streamed " };
        yield { type: "text_delta" as const, text: "answer" };
      },
    };

    const run = createRun({
      goal: "streaming test",
      model,
      maxSteps: 2,
    });
    run.events.subscribe((event) => events.push(event));

    const result = await run.start();

    expect(result.signal).toBe("completed");
    expect(result.message).toBe("streamed answer");

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("model.stream.started");
    expect(eventTypes).toContain("model.stream.completed");

    // model.stream.completed is a bare terminal marker (step only); the
    // assembled text rides on the following model.completed.
    const completed = events.find((e) => e.type === "model.stream.completed");
    expect(completed?.payload).not.toHaveProperty("output");
    const modelCompleted = events.find((e) => e.type === "model.completed");
    expect((modelCompleted?.payload as { message?: string }).message).toBe(
      "streamed answer",
    );
    expect(modelCompleted?.payload).toMatchObject({
      trace: {
        attempt: 1,
        maxAttempts: 3,
        retryCount: 0,
        streaming: true,
        toolCallCount: 0,
        messageChars: "streamed answer".length,
      },
    });
  });

  it("streams reasoning chunks without folding them into the final answer", async () => {
    const events: SparkwrightEvent[] = [];
    const model: ModelAdapter = {
      async complete() {
        throw new Error("complete() should not be called when stream() exists");
      },
      async *stream() {
        yield { type: "reasoning_delta" as const, text: "thinking aloud" };
        yield { type: "text_delta" as const, text: "final answer" };
      },
    };

    const run = createRun({
      goal: "stream reasoning",
      model,
      maxSteps: 1,
    });
    run.events.subscribe((event) => events.push(event));

    const result = await run.start();

    expect(result.signal).toBe("completed");
    expect(result.message).toBe("final answer");
    expect(
      events
        .filter((event) => event.type === "model.stream.chunk")
        .map((event) => event.payload),
    ).toEqual([
      { type: "reasoning_delta", text: "thinking aloud" },
      { type: "text_delta", text: "final answer" },
    ]);
    const completed = events.find((event) => event.type === "model.completed");
    expect((completed?.payload as { message?: string }).message).toBe(
      "final answer",
    );
  });

  it("persists events to runStore when provided", async () => {
    const appended: SparkwrightEvent[] = [];
    const finishCalls: Array<{ record: unknown; result: unknown }> = [];
    const model: ModelAdapter = {
      async complete() {
        return { message: "done" };
      },
    };

    const runStore = {
      append(event: SparkwrightEvent) {
        appended.push(event);
      },
      finish(record: unknown, result: unknown) {
        finishCalls.push({ record, result });
      },
    };

    const run = createRun({
      goal: "store wiring",
      model,
      maxSteps: 1,
      runStore,
    });

    const result = await run.start();

    expect(result.signal).toBe("completed");
    expect(appended.length).toBeGreaterThan(0);
    // Backfilled run.created must be present.
    expect(appended.some((e) => e.type === "run.created")).toBe(true);
    expect(appended.some((e) => e.type === "run.completed")).toBe(true);
    expect(finishCalls).toHaveLength(1);
    expect((finishCalls[0].record as { id: string }).id).toBe(run.record.id);
    expect((finishCalls[0].result as { signal: string }).signal).toBe(
      "completed",
    );
  });

  it("waits for async runStore appends before finish", async () => {
    const appended: string[] = [];
    const finishSnapshots: string[][] = [];
    const model: ModelAdapter = {
      async complete() {
        return { message: "done" };
      },
    };

    const run = createRun({
      goal: "async store ordering",
      model,
      maxSteps: 1,
      runStore: {
        async append(event: SparkwrightEvent) {
          await sleep(5);
          appended.push(event.type);
        },
        finish() {
          finishSnapshots.push([...appended]);
        },
      },
    });

    await run.start();

    expect(finishSnapshots).toHaveLength(1);
    expect(finishSnapshots[0]).toEqual(appended);
    expect(finishSnapshots[0]).toContain("run.completed");
  });

  it("tolerates runStore errors without breaking the run", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model: ModelAdapter = {
      async complete() {
        return { message: "done" };
      },
    };

    const runStore = {
      append() {
        throw new Error("store-append-failure");
      },
      finish() {
        throw new Error("store-finish-failure");
      },
    };

    const run = createRun({
      goal: "store error tolerance",
      model,
      maxSteps: 1,
      runStore,
    });

    const result = await run.start();

    expect(result.signal).toBe("completed");
    expect(run.record.state).toBe("completed");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("streams existing and live events before yielding the run result", async () => {
    const run = createRun({
      goal: "stream run",
      model: {
        async complete() {
          return { message: "done" };
        },
      },
    });

    const items = [];
    for await (const item of run.stream()) {
      items.push(item);
    }

    expect(items[0]).toMatchObject({ type: "run.created" });
    expect(items.at(-1)).toMatchObject({
      type: "run.result",
      result: { signal: "completed", message: "done" },
    });
    expect(items.map((item) => item.type)).toEqual(
      expect.arrayContaining(["run.started", "model.completed", "run.result"]),
    );
  });

  it("streams a completed run without executing it again", async () => {
    let modelCalls = 0;
    const run = createRun({
      goal: "stream completed run",
      model: {
        async complete() {
          modelCalls += 1;
          return { message: "done" };
        },
      },
    });

    await run.start();
    const streamed = [];
    for await (const item of run.stream()) streamed.push(item);

    expect(modelCalls).toBe(1);
    expect(streamed[0]).toMatchObject({ type: "run.created" });
    expect(streamed.at(-1)).toMatchObject({ type: "run.result" });
  });

  it("applies queued user messages as turn context", async () => {
    let modelCalls = 0;
    const run = createRun({
      goal: "inject command",
      model: {
        async complete(input) {
          modelCalls += 1;
          expect(input.context.map((item) => item.content)).toContain(
            "please be precise",
          );
          return { message: "done" };
        },
      },
    });
    run.injectUserMessage({ content: "please be precise" });

    const result = await run.start();

    expect(result.signal).toBe("completed");
    expect(modelCalls).toBe(1);
    expect(run.events.all().map((event) => event.type)).toEqual(
      expect.arrayContaining(["run.command.enqueued", "run.command.applied"]),
    );
  });

  it("applies queued cancellation before model dispatch", async () => {
    let modelCalls = 0;
    const run = createRun({
      goal: "cancel command",
      model: {
        async complete() {
          modelCalls += 1;
          return { message: "never" };
        },
      },
    });
    run.enqueueCommand({ type: "cancel", reason: "stop now" });

    const result = await run.start();

    expect(result).toMatchObject({
      signal: "cancelled",
      stopReason: "manual_cancelled",
      message: "stop now",
    });
    expect(modelCalls).toBe(0);
    expect(run.events.all().map((event) => event.type)).toEqual(
      expect.arrayContaining(["run.cancel_requested", "run.cancelled"]),
    );
  });

  it("can continue after final output validation failure", async () => {
    let modelCalls = 0;
    const run = createRun({
      goal: "continue validation",
      finalOutputValidation: "continue",
      maxSteps: 3,
      validationHooks: [
        {
          name: "final-answer-policy",
          stages: ["final_output"],
          validate(input) {
            if (input.subject === "bad final") {
              return {
                status: "failed",
                findings: [
                  {
                    code: "BAD_FINAL",
                    message: "Try again with a better final answer.",
                  },
                ],
              };
            }
          },
        },
      ],
      model: {
        async complete(input) {
          modelCalls += 1;
          if (modelCalls === 1) return { message: "bad final" };
          expect(input.context[0]?.content).toContain("BAD_FINAL");
          return { message: "better final" };
        },
      },
    });

    const result = await run.start();

    expect(result).toMatchObject({
      signal: "completed",
      message: "better final",
    });
    expect(modelCalls).toBe(2);
  });

  it("batches concurrency-safe tools before serial side-effecting tools", async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    let modelCalls = 0;

    const readTool = (name: string) =>
      defineTool({
        name,
        description: "Read-only test tool.",
        inputSchema: { type: "object" },
        governance: { sideEffects: ["read"], idempotency: "idempotent" },
        async execute() {
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          await sleep(20);
          activeReads -= 1;
          return { ok: true, name };
        },
      });
    const writeTool = defineTool({
      name: "write",
      description: "Write test tool.",
      inputSchema: { type: "object" },
      governance: { sideEffects: ["write"], idempotency: "non_idempotent" },
      execute() {
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "batch tools",
      tools: [readTool("read_a"), readTool("read_b"), writeTool],
      maxToolConcurrency: 2,
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                { toolName: "read_a", arguments: {} },
                { toolName: "read_b", arguments: {} },
                { toolName: "write", arguments: {} },
              ],
            };
          }
          return { message: "done" };
        },
      },
    });

    const result = await run.start();
    const batchEvents = run.events
      .all()
      .filter((event) => event.type === "tool.batch.requested");

    expect(result.signal).toBe("completed");
    expect(maxActiveReads).toBe(2);
    expect(batchEvents).toHaveLength(2);
    expect(batchEvents[0]?.payload).toMatchObject({
      mode: "concurrent",
      toolCallCount: 2,
    });
    expect(batchEvents[1]?.payload).toMatchObject({
      mode: "serial",
      toolCallCount: 1,
    });
  });

  it("keeps concurrent tool observations in request order while trace follows completion order", async () => {
    let modelCalls = 0;
    let secondTurnToolResultOrder: string[] = [];

    const readTool = (name: string, delayMs: number) =>
      defineTool({
        name,
        description: "Read-only test tool.",
        inputSchema: { type: "object" },
        governance: { sideEffects: ["read"], idempotency: "idempotent" },
        async execute() {
          await sleep(delayMs);
          return { ok: true, name };
        },
      });

    const run = createRun({
      goal: "stable concurrent observations",
      tools: [readTool("slow_read", 30), readTool("fast_read", 0)],
      maxToolConcurrency: 2,
      model: {
        async complete(input) {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                { toolName: "slow_read", arguments: {} },
                { toolName: "fast_read", arguments: {} },
              ],
            };
          }
          secondTurnToolResultOrder = input.context
            .filter((item) => item.type === "tool_result")
            .map((item) => {
              const parsed = JSON.parse(item.content) as { toolName?: string };
              return parsed.toolName ?? "";
            });
          return { message: "done" };
        },
      },
    });

    const result = await run.start();
    const completionOrder = run.events
      .all()
      .filter((event) => event.type === "tool.completed")
      .map((event) => (event.payload as { toolName?: string }).toolName);

    expect(result.signal).toBe("completed");
    expect(completionOrder).toEqual(["fast_read", "slow_read"]);
    expect(secondTurnToolResultOrder).toEqual(["slow_read", "fast_read"]);
  });

  it("marks duplicate same-batch calls as in-flight duplicates", async () => {
    let executed = 0;
    let modelCalls = 0;
    const read = defineTool({
      name: "read",
      description: "Read-only test tool.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      governance: { sideEffects: ["read"], idempotency: "conditional" },
      async execute() {
        executed += 1;
        await sleep(20);
        return { ok: true };
      },
    });

    const run = createRun({
      goal: "same batch duplicate",
      tools: [read],
      maxToolConcurrency: 2,
      maxSteps: 3,
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                { toolName: "read", arguments: { path: "README.md" } },
                { toolName: "read", arguments: { path: "README.md" } },
              ],
            };
          }
          return { message: "done" };
        },
      },
    });

    const result = await run.start();
    const duplicate = run.events.all().find(
      (event) =>
        event.type === "tool.failed" &&
        (
          event.payload as {
            error?: { metadata?: { duplicateKind?: string } };
          }
        ).error?.metadata?.duplicateKind === "in_flight_duplicate",
    );

    expect(result.signal).toBe("completed");
    expect(executed).toBe(1);
    expect(duplicate).toBeDefined();
    expect(
      (duplicate?.payload as { error?: { message?: string } }).error?.message,
    ).toContain("still running");
    expect(
      (duplicate?.payload as { error?: { message?: string } }).error?.message,
    ).not.toContain("returned the same result");
    expect(
      run.events
        .all()
        .some(
          (event) =>
            event.type === "run.failed" &&
            (event.payload as { code?: string }).code === "TOOL_DOOM_LOOP",
        ),
    ).toBe(false);
  });

  it("nests tool-call spans under the batch span under the run span", async () => {
    let modelCalls = 0;
    const readTool = (name: string) =>
      defineTool({
        name,
        description: "Read-only test tool.",
        inputSchema: { type: "object" },
        governance: { sideEffects: ["read"], idempotency: "idempotent" },
        execute() {
          return { ok: true, name };
        },
      });

    const run = createRun({
      goal: "span nesting",
      tools: [readTool("read_a"), readTool("read_b")],
      maxToolConcurrency: 2,
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              toolCalls: [
                { toolName: "read_a", arguments: {} },
                { toolName: "read_b", arguments: {} },
              ],
            };
          }
          return { message: "done" };
        },
      },
    });

    const result = await run.start();
    expect(result.signal).toBe("completed");

    const events = run.events.all();

    // One trace id for the whole run — a parent-less span would otherwise
    // allocate a fresh trace and fragment the run.
    const traceIds = new Set(events.map((e) => e.traceId));
    expect(traceIds.size).toBe(1);

    // Run span: run.started / run.completed share one span id, no parent.
    const runStarted = events.find((e) => e.type === "run.started");
    const runCompleted = events.find((e) => e.type === "run.completed");
    expect(runStarted?.spanId).toBeDefined();
    expect(runStarted?.parentSpanId).toBeUndefined();
    expect(runCompleted?.spanId).toBe(runStarted?.spanId);
    const runSpanId = runStarted!.spanId;

    // Batch span nests under the run span.
    const batchRequested = events.find(
      (e) => e.type === "tool.batch.requested",
    );
    const batchCompleted = events.find(
      (e) => e.type === "tool.batch.completed",
    );
    expect(batchRequested?.spanId).toBeDefined();
    expect(batchRequested?.parentSpanId).toBe(runSpanId);
    expect(batchCompleted?.spanId).toBe(batchRequested?.spanId);
    const batchSpanId = batchRequested!.spanId;

    // Each tool call: requested/started/completed share a span id whose parent
    // is the batch span. Two concurrent calls → two distinct tool span ids.
    const requested = events.filter((e) => e.type === "tool.requested");
    expect(requested).toHaveLength(2);
    const toolSpanIds = new Set<string | undefined>();
    for (const req of requested) {
      expect(req.parentSpanId).toBe(batchSpanId);
      const toolCallId = (req.payload as { id: string }).id;
      const lifecycle = events.filter(
        (e) =>
          (e.type === "tool.started" || e.type === "tool.completed") &&
          (e.payload as { toolCallId?: string }).toolCallId === toolCallId,
      );
      expect(lifecycle).toHaveLength(2);
      for (const e of lifecycle) expect(e.spanId).toBe(req.spanId);
      toolSpanIds.add(req.spanId);
    }
    expect(toolSpanIds.size).toBe(2);

    // Each turn's model.turn span nests under the run span; its
    // model.requested / model.completed events nest under THAT span. The tool
    // batch is a sibling of model.turn (also parented to run), not a child.
    const modelTurnStarted = events.filter(
      (e) => e.type === "model.turn.started",
    );
    const modelTurnCompleted = events.filter(
      (e) => e.type === "model.turn.completed",
    );
    // Two turns: turn 1 emits tool calls, turn 2 produces the final answer.
    expect(modelTurnStarted).toHaveLength(2);
    expect(modelTurnCompleted).toHaveLength(2);
    for (const started of modelTurnStarted) {
      expect(started.parentSpanId).toBe(runSpanId);
      const step = (started.payload as { step: number }).step;
      const completed = modelTurnCompleted.find(
        (e) => (e.payload as { step: number }).step === step,
      );
      expect(completed?.spanId).toBe(started.spanId);
      // model.requested + model.completed for this step are emitted INSIDE the
      // turn frame, so they share its span id (like tool.started shares the
      // tool span) and inherit its parent — the model phase collapses to one
      // span containing every attempt's events.
      const requestedForStep = events.find(
        (e) =>
          e.type === "model.requested" &&
          (e.payload as { step: number }).step === step,
      );
      const completedForStep = events.find(
        (e) =>
          e.type === "model.completed" &&
          (e.payload as { step: number }).step === step,
      );
      expect(requestedForStep?.spanId).toBe(started.spanId);
      expect(requestedForStep?.parentSpanId).toBe(runSpanId);
      expect(completedForStep?.spanId).toBe(started.spanId);
    }
    // The batch span's parent is the run span, NOT a model.turn span.
    expect(modelTurnStarted.map((e) => e.spanId)).not.toContain(batchSpanId);
    expect(batchRequested?.parentSpanId).toBe(runSpanId);
  });

  it("assembles streamed tool calls and records streamed usage", async () => {
    let modelCalls = 0;
    const echo = defineTool({
      name: "echo",
      description: "Echo text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute(args: unknown) {
        return args;
      },
    });
    const run = createRun({
      goal: "stream tool use",
      tools: [echo],
      runBudget: { maxTokens: 20 },
      model: {
        async complete() {
          throw new Error("complete() should not be called");
        },
        async *stream() {
          modelCalls += 1;
          if (modelCalls === 1) {
            yield {
              type: "tool_call_start" as const,
              toolCallIndex: 0,
              toolName: "echo",
            };
            yield {
              type: "tool_call_delta" as const,
              toolCallIndex: 0,
              argumentsDelta: '{"text":"hi"}',
            };
            yield { type: "tool_call_end" as const, toolCallIndex: 0 };
            yield {
              type: "usage" as const,
              usage: {
                inputTokens: 3,
                outputTokens: 4,
                totalTokens: 7,
                cacheReadTokens: 1,
              },
            };
            return;
          }
          yield { type: "text_delta" as const, text: "done" };
        },
      },
    });

    const result = await run.start();

    expect(result.signal).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(run.events.all().map((event) => event.type)).toEqual(
      expect.arrayContaining(["tool.completed", "model.stream.completed"]),
    );
    const budgetEvent = run.events
      .all()
      .find(
        (event) =>
          event.type === "run.budget.checked" &&
          (event.payload as { stage?: string }).stage ===
            "model_usage_recorded",
      );
    expect(budgetEvent?.payload).toMatchObject({
      usage: { tokens: 7 },
    });
    const modelCompleted = run.events
      .all()
      .find(
        (event) =>
          event.type === "model.completed" &&
          (event.payload as { trace?: { outputTokens?: number } }).trace
            ?.outputTokens === 4,
      );
    expect(modelCompleted?.payload).toMatchObject({
      trace: {
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
        cacheReadTokens: 1,
        cacheHitRatePct: 33.33,
      },
    });
  });

  it("preserves streamed cost-availability status in model.completed usage", async () => {
    const run = createRun({
      goal: "stream usage with unavailable pricing",
      model: {
        async complete() {
          throw new Error("complete() should not be called");
        },
        async *stream() {
          yield { type: "text_delta" as const, text: "done" };
          yield {
            type: "usage" as const,
            usage: {
              inputTokens: 5,
              outputTokens: 6,
              totalTokens: 11,
              costStatus: "unavailable" as const,
              costUnavailableReason: "missing_pricing",
            },
          };
        },
      },
    });

    const result = await run.start();

    expect(result.signal).toBe("completed");
    const modelCompleted = run.events
      .all()
      .find((event) => event.type === "model.completed");
    // The merged streaming usage must keep the adapter's cost signal so the
    // trace can explain why cost is unavailable rather than looking silent.
    expect(modelCompleted?.payload).toMatchObject({
      usage: {
        totalTokens: 11,
        costStatus: "unavailable",
        costUnavailableReason: "missing_pricing",
      },
    });
  });

  it("threads live usage (cost / context-window pressure) into compaction hints", async () => {
    const echo = defineTool({
      name: "echo",
      description: "Echo text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      policy: { risk: "safe" },
      execute(args: unknown) {
        return args;
      },
    });

    let modelCalls = 0;
    const model: ModelAdapter = {
      // Declare a 1000-token window so contextWindowPressure is computable.
      contextHints: { contextWindowTokens: 1000 },
      async complete() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            toolCalls: [{ toolName: "echo", arguments: { text: "hi" } }],
            usage: { inputTokens: 800, outputTokens: 50, totalTokens: 850 },
          };
        }
        return {
          message: "done",
          usage: { inputTokens: 820, outputTokens: 10 },
        };
      },
    };

    const seenUsage: Array<
      import("../src/context.js").ContextUsageHint | undefined
    > = [];
    const captureStage = {
      name: "capture-usage",
      tier: "summarize" as const,
      trigger: "auto" as const,
      shouldRun(input: { hints: { usage?: unknown } }) {
        seenUsage.push(
          input.hints.usage as
            | import("../src/context.js").ContextUsageHint
            | undefined,
        );
        return false; // observe only; never mutate context
      },
      apply(input: { items: ContextItem[] }) {
        return { items: input.items, freedChars: 0 };
      },
    };

    const run = createRun({
      goal: "usage threading",
      model,
      tools: [echo],
      maxSteps: 3,
      compactionStages: [captureStage],
    });

    await run.start();

    // shapeContext runs once per step. Step 1 has no prior model call, so the
    // usage hint is zeroed; step 2 reflects call 1's 800 input tokens against
    // the 1000-token window => 0.8 pressure.
    expect(seenUsage.length).toBeGreaterThanOrEqual(2);
    expect(seenUsage[0]).toMatchObject({ totalTokens: 0, modelCalls: 0 });
    expect(seenUsage[0]?.contextWindowPressure).toBeUndefined();
    expect(seenUsage[1]).toMatchObject({
      totalTokens: 850,
      modelCalls: 1,
      lastInputTokens: 800,
      contextWindowPressure: 0.8,
    });
  });

  it("waits for an awaited task notification and injects it on the canonical path", async () => {
    const source = new ManualTaskRevivalSource();
    source.pending = true;
    let modelCalls = 0;
    const seenContexts: string[][] = [];
    const run = createRun({
      goal: "wait for task",
      notificationSources: [source],
      taskRevivalSource: source,
      model: {
        async complete(input) {
          modelCalls += 1;
          seenContexts.push(input.context.map((item) => item.content));
          return { message: modelCalls === 1 ? "waiting" : "done" };
        },
      },
      maxSteps: 3,
    });

    const resultPromise = run.start();
    await waitForCondition(() => run.record.state === "waiting_tasks");

    source.deliver({
      content: "Task task_1 completed.",
      metadata: { taskId: "task_1" },
    });

    const result = await resultPromise;
    expect(result.state).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(seenContexts[1]).toEqual(
      expect.arrayContaining(["Task task_1 completed."]),
    );
    expect(
      run.events
        .all()
        .filter((event) => event.type === "run.notification.injected"),
    ).toHaveLength(1);
    expect(source.drainCalls).toBeGreaterThanOrEqual(2);
  });

  it("runs Stop workflow hooks before entering waiting_tasks for awaited task revival", async () => {
    const source = new ManualTaskRevivalSource();
    source.pending = true;
    let modelCalls = 0;
    const stopRunStates: string[] = [];
    const run = createRun({
      goal: "task terminal ordering",
      notificationSources: [source],
      taskRevivalSource: source,
      workflowHooks: [
        {
          name: "capture-stop-state",
          hook: "Stop",
          handle(input) {
            stopRunStates.push(input.run.state);
          },
        },
      ],
      model: {
        async complete() {
          modelCalls += 1;
          return { message: modelCalls === 1 ? "waiting" : "done" };
        },
      },
      maxSteps: 3,
    });

    const resultPromise = run.start();
    await waitForCondition(() => run.record.state === "waiting_tasks");

    source.deliver({
      content: "Task task_terminal completed.",
      metadata: { taskId: "task_terminal" },
    });

    const result = await resultPromise;

    expect(result.state).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(stopRunStates).toEqual(["running", "running"]);
    expect(result.metadata).toMatchObject({
      revivalTurnsUsed: 1,
    });
  });

  it("revives awaited task completions after maxSteps is otherwise spent", async () => {
    const source = new ManualTaskRevivalSource();
    source.pending = true;
    let modelCalls = 0;
    const seenContexts: string[][] = [];
    const run = createRun({
      goal: "wait past max steps",
      notificationSources: [source],
      taskRevivalSource: source,
      model: {
        async complete(input) {
          modelCalls += 1;
          seenContexts.push(input.context.map((item) => item.content));
          return { message: modelCalls === 1 ? "waiting" : "done" };
        },
      },
      maxSteps: 1,
    });

    const resultPromise = run.start();
    await waitForCondition(() => run.record.state === "waiting_tasks");

    source.deliver({
      content: "Task task_after_budget completed.",
      metadata: { taskId: "task_after_budget" },
    });

    const result = await resultPromise;
    expect(result.state).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(seenContexts[1]).toEqual(
      expect.arrayContaining(["Task task_after_budget completed."]),
    );
    expect(result.metadata).toMatchObject({
      maxSteps: 1,
      stepLimitReached: false,
      revivalTurnsUsed: 1,
    });
  });

  it("uses per-source forced-continuation budget for revival without changing wake metadata", async () => {
    const source = new ManualTaskRevivalSource();
    source.pending = true;
    let modelCalls = 0;
    const turnTransitions: unknown[] = [];
    const captureTurnStart: WorkflowHook = {
      name: "capture-turn-start",
      hook: "TurnStart",
      handle(input) {
        turnTransitions.push(input.metadata.transition);
      },
    };
    const run = createRun({
      goal: "revival source budget",
      notificationSources: [source],
      taskRevivalSource: source,
      workflowHooks: [captureTurnStart],
      model: {
        async complete() {
          modelCalls += 1;
          return { message: modelCalls === 1 ? "waiting" : "done" };
        },
      },
      maxSteps: 1,
      forcedContinuationBudgets: { revival: 1 },
    });

    const resultPromise = run.start();
    await waitForCondition(() => run.record.state === "waiting_tasks");

    source.deliver({
      content: "Task task_source_budget completed.",
      metadata: { taskId: "task_source_budget" },
    });

    const result = await resultPromise;

    expect(result.state).toBe("completed");
    expect(result.metadata).toMatchObject({
      revivalTurnsUsed: 1,
      forcedContinuationTurnsUsed: { revival: 1 },
    });
    expect(turnTransitions[1]).toMatchObject({
      reason: "next_turn",
      metadata: {
        wake: "waiting_tasks",
        forcedContinuationSource: "revival",
      },
    });
  });

  it("prefers per-source revival budget over legacy maxRevivalTurns", async () => {
    const source = new ManualTaskRevivalSource();
    source.pending = true;
    let modelCalls = 0;
    const run = createRun({
      goal: "per-source budget wins",
      notificationSources: [source],
      taskRevivalSource: source,
      model: {
        async complete() {
          modelCalls += 1;
          return { message: modelCalls === 1 ? "waiting" : "done" };
        },
      },
      maxSteps: 1,
      maxRevivalTurns: 0,
      forcedContinuationBudgets: { revival: 1 },
    });

    const resultPromise = run.start();
    await waitForCondition(() => run.record.state === "waiting_tasks");

    source.deliver({
      content: "Task task_precedence completed.",
      metadata: { taskId: "task_precedence" },
    });

    const result = await resultPromise;

    expect(result.state).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(result.metadata).toMatchObject({
      revivalTurnsUsed: 1,
      forcedContinuationTurnsUsed: { revival: 1 },
    });
    expect(run.events.all().map((event) => event.type)).not.toContain(
      "run.budget.exceeded",
    );
  });

  it("uses workflow source budget for workflow projection continuations", async () => {
    let modelCalls = 0;
    let stopCalls = 0;
    const turnTransitions: unknown[] = [];
    const run = createRun({
      goal: "workflow source budget",
      workflowHooks: [
        {
          name: "capture-turn-start",
          hook: "TurnStart",
          handle(input) {
            turnTransitions.push(input.metadata.transition);
          },
        },
        {
          name: "workflow:test-run",
          hook: "Stop",
          handle() {
            stopCalls += 1;
            if (stopCalls === 1) {
              return {
                status: "advance",
                reason: "workflow retry",
              };
            }
            return { status: "continue" };
          },
        },
      ],
      model: {
        async complete() {
          modelCalls += 1;
          return { message: modelCalls === 1 ? "try again" : "done" };
        },
      },
      maxSteps: 1,
      forcedContinuationBudgets: { workflow: 1 },
    });

    const result = await run.start();

    expect(result.state).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(result.metadata).toMatchObject({
      maxSteps: 1,
      stepLimitReached: false,
      forcedContinuationTurnsUsed: { workflow: 1 },
    });
    expect(turnTransitions[1]).toMatchObject({
      reason: "workflow_hook_advanced",
      metadata: {
        hookName: "workflow:test-run",
        forcedContinuationSource: "workflow",
      },
    });
  });

  it("refuses workflow projection continuations when the source budget is exhausted", async () => {
    let modelCalls = 0;
    const run = createRun({
      goal: "workflow source budget exhausted",
      workflowHooks: [
        {
          name: "workflow:test-run",
          hook: "Stop",
          handle() {
            return {
              status: "advance",
              reason: "workflow retry",
            };
          },
        },
      ],
      model: {
        async complete() {
          modelCalls += 1;
          return { message: "final despite refused workflow continuation" };
        },
      },
      maxSteps: 1,
      forcedContinuationBudgets: { workflow: 0 },
    });

    const result = await run.start();
    const budgetExceeded = run.events
      .all()
      .find((event) => event.type === "run.budget.exceeded");

    expect(result.state).toBe("completed");
    expect(modelCalls).toBe(1);
    expect(result.metadata).not.toHaveProperty("forcedContinuationTurnsUsed");
    expect(result.metadata).not.toHaveProperty("outcome");
    expect(budgetExceeded?.payload).toMatchObject({
      signal: "budget.exceeded",
      family: "forced_continuation",
      source: "workflow",
      used: 0,
      limit: 0,
      reason: "workflow_hook_advanced",
    });
    expect(run.events.all().map((event) => event.type)).not.toContain(
      "workflow.failed",
    );
  });

  it("bounds awaited task revival with maxRevivalTurns", async () => {
    const source = new ManualTaskRevivalSource();
    source.pending = true;
    let modelCalls = 0;
    const run = createRun({
      goal: "bounded revival",
      notificationSources: [source],
      taskRevivalSource: source,
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls === 2) {
            source.pending = true;
          }
          return { message: "done for now" };
        },
      },
      maxSteps: 1,
      maxRevivalTurns: 1,
    });

    const resultPromise = run.start();
    await waitForCondition(() => run.record.state === "waiting_tasks");

    source.deliver({
      content: "Task task_one completed.",
      metadata: { taskId: "task_one" },
    });

    const result = await resultPromise;
    expect(result.state).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(source.waitCalls).toBe(1);
    expect(result.metadata).toMatchObject({ revivalTurnsUsed: 1 });
  });

  it("emits a per-source budget fact when revival is exhausted", async () => {
    const source = new ManualTaskRevivalSource();
    source.pending = true;
    let modelCalls = 0;
    const run = createRun({
      goal: "revival exhausted",
      notificationSources: [source],
      taskRevivalSource: source,
      model: {
        async complete() {
          modelCalls += 1;
          return { message: "done without revival" };
        },
      },
      maxRevivalTurns: 0,
    });

    const result = await run.start();
    const exceeded = run.events
      .all()
      .find((event) => event.type === "run.budget.exceeded");
    const completed = run.events
      .all()
      .find((event) => event.type === "run.completed");

    expect(result.state).toBe("completed");
    expect(result.metadata).not.toHaveProperty("revivalTurnsUsed");
    expect(modelCalls).toBe(1);
    expect(source.waitCalls).toBe(0);
    expect(exceeded?.payload).toMatchObject({
      signal: "budget.exceeded",
      family: "forced_continuation",
      source: "revival",
      used: 0,
      limit: 0,
      step: 1,
      reason: "waiting_tasks",
    });
    expect(completed?.payload).toMatchObject({
      factLedger: {
        budgetExceeded: [
          expect.objectContaining({
            source: "revival",
            used: 0,
            limit: 0,
          }),
        ],
      },
    });
  });

  it("registers the workflow forced-continuation source without consuming it", async () => {
    const run = createRun({
      goal: "plain completion",
      model: {
        async complete() {
          return { message: "done" };
        },
      },
    });

    const result = await run.start();
    const checkpoint = run.checkpoint();

    expect(result.state).toBe("completed");
    expect(run.events.all().map((event) => event.type)).not.toContain(
      "run.budget.exceeded",
    );
    expect(result.metadata).not.toHaveProperty("forcedContinuationTurnsUsed");
    expect(checkpoint.budget.forcedContinuation).toMatchObject({
      configured: { revival: 5, workflow: 5 },
      used: { revival: 0, workflow: 0 },
      exceeded: [],
    });
  });

  it("wakes waiting_tasks from run.command.enqueued without polling the command queue", async () => {
    const source = new ManualTaskRevivalSource();
    source.pending = true;
    let modelCalls = 0;
    const run = createRun({
      goal: "wait for command",
      notificationSources: [source],
      taskRevivalSource: source,
      model: {
        async complete(input) {
          modelCalls += 1;
          if (modelCalls === 2) {
            expect(input.context.map((item) => item.content)).toContain(
              "continue now",
            );
          }
          return { message: "done" };
        },
      },
      maxSteps: 3,
    });

    const resultPromise = run.start();
    await waitForCondition(() => run.record.state === "waiting_tasks");
    source.pending = false;
    run.injectUserMessage({ content: "continue now" });

    const result = await resultPromise;
    expect(result.state).toBe("completed");
    expect(modelCalls).toBe(2);
    expect(run.events.all().map((event) => event.type)).toEqual(
      expect.arrayContaining(["run.command.enqueued", "run.command.applied"]),
    );
  });

  it("wakes waiting_tasks when the run abort signal fires", async () => {
    const source = new ManualTaskRevivalSource();
    source.pending = true;
    const controller = new AbortController();
    const run = createRun({
      goal: "wait then abort",
      notificationSources: [source],
      taskRevivalSource: source,
      abortSignal: controller.signal,
      model: {
        async complete() {
          return { message: "waiting" };
        },
      },
      maxSteps: 3,
    });

    const resultPromise = run.start();
    await waitForCondition(() => run.record.state === "waiting_tasks");
    controller.abort();

    const result = await resultPromise;
    expect(result.state).toBe("failed");
    expect(result.stopReason).toBe("manual_cancelled");
  });

  it("does not block terminal completion when no awaited tasks are pending", async () => {
    const source = new ManualTaskRevivalSource();
    let modelCalls = 0;
    const run = createRun({
      goal: "detached task does not block",
      notificationSources: [source],
      taskRevivalSource: source,
      model: {
        async complete() {
          modelCalls += 1;
          return { message: "done" };
        },
      },
    });

    const result = await run.start();

    expect(result.state).toBe("completed");
    expect(modelCalls).toBe(1);
    expect(source.waitCalls).toBe(0);
  });

  it("reports revival pending-check failures without throwing out of the run", async () => {
    const source: NotificationSource & TaskRevivalSource = {
      drain: () => [],
      hasAwaitedPending: () => {
        throw new Error("pending check failed");
      },
      waitUntilAvailable: () => Promise.resolve(),
    };
    const run = createRun({
      goal: "pending check failure",
      notificationSources: [source],
      taskRevivalSource: source,
      model: {
        async complete() {
          return { message: "done" };
        },
      },
    });

    const result = await run.start();

    expect(result.state).toBe("completed");
    expect(
      run.events
        .all()
        .find((event) => event.type === "run.notification.source_failed")
        ?.payload,
    ).toMatchObject({
      sourceIndex: -1,
      message: "pending check failed",
      phase: "hasAwaitedPending",
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await sleep(5);
  }
}

class ManualTaskRevivalSource implements NotificationSource, TaskRevivalSource {
  pending = false;
  waitCalls = 0;
  drainCalls = 0;
  private readonly queue: PendingNotification[] = [];
  private readonly waiters = new Set<() => void>();

  hasAwaitedPending(): boolean {
    return this.pending || this.queue.length > 0;
  }

  drain(): PendingNotification[] {
    this.drainCalls += 1;
    const items = [...this.queue];
    this.queue.length = 0;
    return items;
  }

  waitUntilAvailable(options: { signal?: AbortSignal }): Promise<void> {
    this.waitCalls += 1;
    if (this.queue.length > 0) return Promise.resolve();
    if (options.signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        this.waiters.delete(finish);
        options.signal?.removeEventListener("abort", finish);
        resolve();
      };
      this.waiters.add(finish);
      options.signal?.addEventListener("abort", finish, { once: true });
    });
  }

  deliver(notification: PendingNotification): void {
    this.pending = false;
    this.queue.push(notification);
    for (const waiter of [...this.waiters]) waiter();
  }
}

describe("RunHandle.addHook / removeHook", () => {
  it("replays past events to a late-added onEvent hook and stops after removal", async () => {
    const model: ModelAdapter = {
      async complete() {
        return { message: "done" };
      },
    };
    const run = createRun({ goal: "g", model });

    const seenA: string[] = [];
    const idA = run.addHook({
      name: "late-a",
      onEvent: (i) => seenA.push(i.event.type),
    });
    expect(seenA).toContain("run.created");

    const result = await run.start();
    expect(result.signal).toBe("completed");
    expect(seenA).toContain("run.completed");

    const before = seenA.length;
    expect(run.removeHook(idA)).toBe(true);
    run.events.emit("hook.failed", { phase: "test", message: "ignored" });
    expect(seenA.length).toBe(before);
    expect(run.removeHook(idA)).toBe(false);
  });

  it("rejects duplicate hook ids", () => {
    const run = createRun({
      goal: "g",
      model: {
        async complete() {
          return { message: "x" };
        },
      },
    });
    run.addHook({ id: "shared", name: "h" });
    expect(() => run.addHook({ id: "shared", name: "h" })).toThrow(
      /already registered/,
    );
  });
});

function userContext(content: string): ContextItem {
  return {
    id: createContextItemId(),
    type: "user",
    content,
    metadata: {},
  };
}

function toolResultContext(toolName: string, content: string): ContextItem {
  return {
    id: createContextItemId(),
    type: "tool_result",
    source: { kind: "tool", uri: toolName },
    content,
    metadata: {
      layer: "working",
      stability: "turn",
      toolName,
      status: "completed",
      toolCallId: `call_${toolName}`,
    },
  };
}
