import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createContextItemId,
  createRun,
  defineTool,
  type ContextItem,
  type ModelAdapter,
  type SparkwrightEvent,
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
    expect(events.map((event) => event.type)).toContain("context.assembled");
    expect(events.map((event) => event.type)).toContain("prompt.built");
    expect(
      events.find((event) => event.type === "prompt.built")?.payload,
    ).toMatchObject({
      messageCount: 7,
      stableMessageCount: 5,
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
          name: "tool_descriptors",
          layer: "capability",
          stability: "session",
          cachePolicy: "session",
          chars: expect.any(Number),
        },
        {
          index: 6,
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
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
