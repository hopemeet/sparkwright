import { describe, expect, it } from "vitest";
import {
  createToolSearchTool,
  defineTool,
  type ModelAdapter,
  type ModelInput,
  type ModelOutputChunk,
} from "@sparkwright/core";
import { createStreamingRun } from "../src/index.js";

describe("streaming-runtime", () => {
  it("streams text chunks and completes without tools", async () => {
    const run = createStreamingRun({
      goal: "answer",
      model: streamingModel([
        { type: "text_delta", text: "hel" },
        { type: "text_delta", text: "lo" },
        { type: "stop", stopReason: "completed" },
      ]),
    });

    const result = await run.start();

    expect(result).toMatchObject({
      signal: "completed",
      stopReason: "final_answer",
      message: "hello",
    });
    expect(run.events.all().map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "model.stream.started",
        "model.stream.chunk",
        "model.stream.completed",
        "run.completed",
      ]),
    );
  });

  it("exposes deferred schemas only after tool_search loads them", async () => {
    let deferredExecutions = 0;
    const seenToolNames: string[][] = [];
    const deferredEcho = defineTool({
      name: "deferred_echo",
      description: "Echo text after deferred discovery.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      deferLoading: true,
      execute(args) {
        deferredExecutions += 1;
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
    const run = createStreamingRun({
      goal: "use a deferred tool",
      tools: [deferredEcho, toolSearch],
      maxSteps: 3,
      model: {
        async *stream(input: ModelInput) {
          seenToolNames.push(input.tools.map((tool) => tool.name));
          if (input.step === 1) {
            yield {
              type: "tool_call_start",
              toolName: "tool_search",
              toolCallIndex: 0,
            } as ModelOutputChunk;
            yield {
              type: "tool_call_delta",
              toolCallIndex: 0,
              argumentsDelta: '{"query":"select:deferred_echo"}',
            } as ModelOutputChunk;
            yield {
              type: "tool_call_end",
              toolCallIndex: 0,
            } as ModelOutputChunk;
            return;
          }
          if (input.step === 2) {
            yield {
              type: "tool_call_start",
              toolName: "deferred_echo",
              toolCallIndex: 0,
            } as ModelOutputChunk;
            yield {
              type: "tool_call_delta",
              toolCallIndex: 0,
              argumentsDelta: '{"text":"loaded"}',
            } as ModelOutputChunk;
            yield {
              type: "tool_call_end",
              toolCallIndex: 0,
            } as ModelOutputChunk;
            return;
          }
          yield { type: "text_delta", text: "done" } as ModelOutputChunk;
        },
        async complete() {
          throw new Error("complete should not be called");
        },
      },
    });

    const result = await run.start();

    expect(result).toMatchObject({ signal: "completed", message: "done" });
    expect(seenToolNames).toEqual([
      ["tool_search"],
      ["deferred_echo", "tool_search"],
      ["deferred_echo", "tool_search"],
    ]);
    expect(deferredExecutions).toBe(1);
  });

  it("exposes deferred schemas declared by a loaded skill", async () => {
    const seenToolNames: string[][] = [];
    const deferredEcho = defineTool({
      name: "deferred_echo",
      description: "Echo after its owning skill loads.",
      inputSchema: { type: "object" },
      deferLoading: true,
      execute: () => ({ ok: true }),
    });
    const skillLoad = defineTool({
      name: "skill_load",
      description: "Load a skill.",
      inputSchema: { type: "object" },
      execute: () => ({
        status: "loaded",
        name: "echo-skill",
        toolDependencies: ["deferred_echo"],
      }),
    });
    const run = createStreamingRun({
      goal: "load a skill",
      tools: [deferredEcho, skillLoad],
      maxSteps: 2,
      model: {
        async *stream(input: ModelInput) {
          seenToolNames.push(input.tools.map((tool) => tool.name));
          if (input.step === 1) {
            yield {
              type: "tool_call_start",
              toolName: "skill_load",
              toolCallIndex: 0,
            } as ModelOutputChunk;
            yield {
              type: "tool_call_delta",
              toolCallIndex: 0,
              argumentsDelta: "{}",
            } as ModelOutputChunk;
            yield {
              type: "tool_call_end",
              toolCallIndex: 0,
            } as ModelOutputChunk;
            return;
          }
          yield { type: "text_delta", text: "done" } as ModelOutputChunk;
        },
        async complete() {
          throw new Error("complete should not be called");
        },
      },
    });

    const result = await run.start();

    expect(result).toMatchObject({ signal: "completed", message: "done" });
    expect(seenToolNames).toEqual([
      ["skill_load"],
      ["deferred_echo", "skill_load"],
    ]);
  });

  it("executes tools only after the streamed turn is complete", async () => {
    const order: string[] = [];
    const echo = defineTool({
      name: "echo",
      description: "Echo.",
      inputSchema: { type: "object" },
      execute(args) {
        order.push("tool");
        return args;
      },
    });

    const run = createStreamingRun({
      goal: "use tool",
      tools: [echo],
      maxSteps: 2,
      model: {
        async *stream(input: ModelInput) {
          if (input.step === 1) {
            order.push("stream-start");
            yield { type: "text_delta", text: "working" };
            yield {
              type: "tool_call_start",
              toolName: "echo",
              toolCallIndex: 0,
            };
            yield {
              type: "tool_call_delta",
              toolCallIndex: 0,
              argumentsDelta: '{"text":"hi"}',
            };
            order.push("stream-end");
            yield { type: "tool_call_end", toolCallIndex: 0 };
            return;
          }
          yield { type: "text_delta", text: "done" };
        },
        async complete() {
          throw new Error("complete should not be called");
        },
      },
    });

    const result = await run.start();

    expect(result.signal).toBe("completed");
    expect(order).toEqual(["stream-start", "stream-end", "tool"]);
    expect(run.events.all().map((event) => event.type)).toEqual(
      expect.arrayContaining(["tool.started", "tool.completed"]),
    );
    const assistantText = run.events
      .all()
      .filter((event) => event.type === "model.assistant_text");
    expect(assistantText).toHaveLength(1);
    expect(assistantText[0]?.payload).toMatchObject({
      step: 1,
      message: "working",
    });
    const completedMessages = run.events
      .all()
      .filter((event) => event.type === "run.completed")
      .map((event) => (event.payload as { message?: string }).message);
    expect(completedMessages).toEqual(["done"]);
  });

  it("presents compact agent context while retaining the raw streamed tool result", async () => {
    const report = "streamed-child-report-".repeat(180);
    const delegate = defineTool({
      name: "delegate",
      description: "Return one child result.",
      inputSchema: { type: "object" },
      resultPresentation: { kind: "agent_result" },
      execute: () => ({
        childRunId: "run_streamed_child",
        status: "completed",
        report,
        workspace: { writes: 0 },
        warnings: [],
        blockers: [],
      }),
    });
    const run = createStreamingRun({
      goal: "delegate once",
      tools: [delegate],
      maxSteps: 2,
      model: {
        async *stream(input: ModelInput) {
          if (input.step === 1) {
            yield {
              type: "tool_call_start",
              toolName: "delegate",
              toolCallIndex: 0,
            };
            yield {
              type: "tool_call_delta",
              toolCallIndex: 0,
              argumentsDelta: "{}",
            };
            yield { type: "tool_call_end", toolCallIndex: 0 };
            return;
          }
          const observation = input.context.find(
            (item) => item.type === "tool_result",
          );
          const output = JSON.parse(observation?.content ?? "{}").output;
          expect(typeof output.report).toBe("string");
          expect(output).toMatchObject({
            childRunId: "run_streamed_child",
            reportTruncated: true,
            reportChars: report.length,
          });
          yield { type: "text_delta", text: "done" };
        },
        async complete() {
          throw new Error("complete should not be called");
        },
      },
    });

    await run.start();

    expect(
      (
        run.events.all().find((event) => event.type === "tool.completed")
          ?.payload as {
          output?: { report?: string };
        }
      ).output?.report,
    ).toBe(report);
  });

  it("nests tool-call spans under the batch span under the run span", async () => {
    const echo = defineTool({
      name: "echo",
      description: "Echo.",
      inputSchema: { type: "object" },
      execute(args) {
        return args;
      },
    });

    const run = createStreamingRun({
      goal: "span nesting",
      tools: [echo],
      maxSteps: 2,
      model: {
        async *stream(input: ModelInput) {
          if (input.step === 1) {
            yield {
              type: "tool_call_start",
              toolName: "echo",
              toolCallIndex: 0,
            };
            yield {
              type: "tool_call_delta",
              toolCallIndex: 0,
              argumentsDelta: '{"text":"hi"}',
            };
            yield { type: "tool_call_end", toolCallIndex: 0 };
            return;
          }
          yield { type: "text_delta", text: "done" };
        },
        async complete() {
          throw new Error("complete should not be called");
        },
      },
    });

    const result = await run.start();
    expect(result.signal).toBe("completed");

    const events = run.events.all();

    // One trace id across the whole run.
    expect(new Set(events.map((e) => e.traceId)).size).toBe(1);

    // Run span: started/completed share a parent-less span id.
    const runStarted = events.find((e) => e.type === "run.started");
    const runCompleted = events.find((e) => e.type === "run.completed");
    expect(runStarted?.spanId).toBeDefined();
    expect(runStarted?.parentSpanId).toBeUndefined();
    expect(runCompleted?.spanId).toBe(runStarted?.spanId);

    // Batch span nests under the run span.
    const batchRequested = events.find(
      (e) => e.type === "tool.batch.requested",
    );
    expect(batchRequested?.parentSpanId).toBe(runStarted?.spanId);

    // Tool call: requested/started/completed share a span id whose parent is
    // the batch span.
    const toolRequested = events.find((e) => e.type === "tool.requested");
    expect(toolRequested?.parentSpanId).toBe(batchRequested?.spanId);
    const toolStarted = events.find((e) => e.type === "tool.started");
    const toolCompleted = events.find((e) => e.type === "tool.completed");
    expect(toolStarted?.spanId).toBe(toolRequested?.spanId);
    expect(toolCompleted?.spanId).toBe(toolRequested?.spanId);

    // Each turn's model.turn span nests under the run span; its
    // model.requested / model.stream.* / model.completed events are emitted
    // inside the frame so they share its span id. The tool batch is a sibling
    // of model.turn under the run span, not a child.
    const turnStarted = events.filter((e) => e.type === "model.turn.started");
    const turnCompleted = events.filter(
      (e) => e.type === "model.turn.completed",
    );
    expect(turnStarted).toHaveLength(2);
    expect(turnCompleted).toHaveLength(2);
    const turnSpanIds = new Set<string | undefined>();
    for (const started of turnStarted) {
      expect(started.parentSpanId).toBe(runStarted?.spanId);
      const step = (started.payload as { step: number }).step;
      const completed = turnCompleted.find(
        (e) => (e.payload as { step: number }).step === step,
      );
      expect(completed?.spanId).toBe(started.spanId);
      const requestedForStep = events.find(
        (e) =>
          e.type === "model.requested" &&
          (e.payload as { step: number }).step === step,
      );
      expect(requestedForStep?.spanId).toBe(started.spanId);
      expect(requestedForStep?.parentSpanId).toBe(runStarted?.spanId);
      turnSpanIds.add(started.spanId);
    }
    // The batch span is parented to the run span, never to a model.turn span.
    expect(turnSpanIds).not.toContain(batchRequested?.spanId);
    expect(batchRequested?.parentSpanId).toBe(runStarted?.spanId);
  });

  it("executes eligible tools eagerly when eager tool execution is enabled", async () => {
    const order: string[] = [];
    const echo = defineTool({
      name: "echo",
      description: "Echo.",
      inputSchema: { type: "object" },
      execute(args) {
        order.push("tool");
        return args;
      },
    });

    const run = createStreamingRun({
      goal: "use tool eagerly",
      tools: [echo],
      maxSteps: 2,
      eagerToolExecution: true,
      model: {
        async *stream(input: ModelInput) {
          if (input.step === 1) {
            order.push("stream-start");
            yield {
              type: "tool_call_start",
              toolName: "echo",
              toolCallIndex: 0,
            };
            yield {
              type: "tool_call_end",
              toolCallIndex: 0,
              arguments: { text: "hi" },
            };
            order.push("stream-resumed");
            return;
          }
          yield { type: "text_delta", text: "done" };
        },
        async complete() {
          throw new Error("complete should not be called");
        },
      },
    });

    const result = await run.start();

    expect(result.signal).toBe("completed");
    expect(order).toEqual(["stream-start", "tool", "stream-resumed"]);
    const eventTypes = run.events.all().map((event) => event.type);
    expect(eventTypes.indexOf("tool.completed")).toBeLessThan(
      eventTypes.indexOf("model.stream.completed"),
    );
  });

  it("fails invalid streamed tool argument JSON", async () => {
    const run = createStreamingRun({
      goal: "bad json",
      model: streamingModel([
        { type: "tool_call_start", toolName: "echo", toolCallIndex: 0 },
        {
          type: "tool_call_delta",
          toolCallIndex: 0,
          argumentsDelta: "{not-json",
        },
        { type: "tool_call_end", toolCallIndex: 0 },
      ]),
    });

    await expect(run.start()).resolves.toMatchObject({
      signal: "failed",
      stopReason: "model_completion_failed",
      failure: {
        code: "MODEL_STREAM_FAILED",
      },
    });
    expect(run.events.all().map((event) => event.type)).toContain(
      "model.stream.failed",
    );
  });

  it("times out a stalled stream", async () => {
    const run = createStreamingRun({
      goal: "timeout",
      streamTimeoutMs: 5,
      model: {
        async *stream() {
          await sleep(30);
          yield { type: "text_delta", text: "late" };
        },
        async complete() {
          throw new Error("complete should not be called");
        },
      },
    });

    await expect(run.start()).resolves.toMatchObject({
      signal: "failed",
      stopReason: "aborted_streaming",
      failure: {
        code: "MODEL_STREAM_TIMEOUT",
      },
    });
    const timeoutEvent = run.events
      .all()
      .find((event) => event.type === "model.stream.timeout");
    expect(timeoutEvent?.payload).toMatchObject({
      phase: "pre-first-chunk",
      apiCallCount: 0,
      chunksReceived: 0,
    });
  });

  it("classifies post-first-chunk stalls and applies separate first-chunk threshold", async () => {
    const run = createStreamingRun({
      goal: "post-first-chunk timeout",
      // First chunk: 40ms budget (plenty). Inter-chunk: 5ms (tight).
      streamFirstChunkTimeoutMs: 40,
      streamTimeoutMs: 5,
      model: {
        async *stream() {
          await sleep(20); // within first-chunk budget
          yield { type: "text_delta", text: "hi" };
          await sleep(30); // exceeds inter-chunk budget
          yield { type: "text_delta", text: "late" };
        },
        async complete() {
          throw new Error("complete should not be called");
        },
      },
    });

    await expect(run.start()).resolves.toMatchObject({
      signal: "failed",
      stopReason: "aborted_streaming",
    });
    const timeoutEvent = run.events
      .all()
      .find((event) => event.type === "model.stream.timeout");
    expect(timeoutEvent?.payload).toMatchObject({
      phase: "post-first-chunk",
      apiCallCount: 1,
      chunksReceived: 1,
      timeoutMs: 5,
    });
  });

  it("emits tool progress from after-turn tool execution", async () => {
    const progress = defineTool({
      name: "progress",
      description: "Progress.",
      inputSchema: { type: "object" },
      execute(_args, ctx) {
        ctx.reportToolProgress?.({ label: "working", completedUnits: 1 });
        return { ok: true };
      },
    });
    const run = createStreamingRun({
      goal: "progress",
      tools: [progress],
      maxSteps: 2,
      model: {
        async *stream(input) {
          if (input.step === 1) {
            yield {
              type: "tool_call_start",
              toolName: "progress",
              toolCallIndex: 0,
            };
            yield {
              type: "tool_call_end",
              toolCallIndex: 0,
              arguments: {},
            };
          } else {
            yield { type: "text_delta", text: "done" };
          }
        },
        async complete() {
          throw new Error("complete should not be called");
        },
      },
    });

    await run.start();

    const progressEvent = run.events
      .all()
      .find((event) => event.type === "tool.progress");
    expect(progressEvent?.payload).toMatchObject({
      toolName: "progress",
      label: "working",
      completedUnits: 1,
    });
  });
});

describe("notification sources", () => {
  it("injects drained notifications as user-role context items", async () => {
    const drained: number[] = [];
    let calls = 0;
    const source = {
      drain() {
        calls += 1;
        if (calls === 1) {
          drained.push(1);
          return [
            {
              content:
                "<task-notification>task_42 completed</task-notification>",
              source: { kind: "task-notification", uri: "task_42" },
              metadata: { taskId: "task_42", status: "completed" },
            },
          ];
        }
        return [];
      },
    };
    let observedPromptCount = 0;
    const run = createStreamingRun({
      goal: "see notification",
      notificationSources: [source],
      model: {
        async *stream(input: ModelInput) {
          observedPromptCount = input.context.filter(
            (item) =>
              item.type === "user" && item.source?.kind === "task-notification",
          ).length;
          yield { type: "text_delta", text: "ack" } as ModelOutputChunk;
          yield { type: "stop", stopReason: "completed" } as ModelOutputChunk;
        },
        async complete() {
          throw new Error("complete unused");
        },
      },
    });
    const result = await run.start();
    expect(result.signal).toBe("completed");
    expect(observedPromptCount).toBe(1);
    expect(drained).toEqual([1]);
    const injected = run.events
      .all()
      .filter((event) => event.type === "run.notification.injected");
    expect(injected).toHaveLength(1);
    expect((injected[0]!.payload as { count: number }).count).toBe(1);
  });

  it("emits source_failed and continues when drain throws", async () => {
    const run = createStreamingRun({
      goal: "drain throws",
      notificationSources: [
        {
          drain() {
            throw new Error("queue unavailable");
          },
        },
      ],
      model: {
        async *stream() {
          yield { type: "text_delta", text: "ok" } as ModelOutputChunk;
          yield { type: "stop", stopReason: "completed" } as ModelOutputChunk;
        },
        async complete() {
          throw new Error("complete unused");
        },
      },
    });
    const result = await run.start();
    expect(result.signal).toBe("completed");
    const failed = run.events
      .all()
      .filter((event) => event.type === "run.notification.source_failed");
    expect(failed).toHaveLength(1);
    expect((failed[0]!.payload as { message: string }).message).toMatch(
      /queue unavailable/,
    );
  });
});

describe("awaited task revival", () => {
  it("waits, injects one terminal notification, and resumes beyond maxSteps", async () => {
    let pending = true;
    let notificationReady = false;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let drainCount = 0;
    let observedTaskNotifications = 0;
    const run = createStreamingRun({
      goal: "await a task",
      maxSteps: 1,
      notificationSources: [
        {
          drain() {
            if (!notificationReady || drainCount > 0) return [];
            drainCount += 1;
            return [
              {
                content: "task completed",
                source: { kind: "task", uri: "task:one" },
                metadata: { taskId: "task_one", status: "completed" },
              },
            ];
          },
        },
      ],
      taskRevivalSource: {
        hasAwaitedPending: () => pending,
        waitUntilAvailable: () => ready,
      },
      model: {
        async *stream(input: ModelInput) {
          observedTaskNotifications = input.context.filter(
            (item) => item.source?.kind === "task",
          ).length;
          yield {
            type: "text_delta",
            text: input.step === 1 ? "initial" : "resumed",
          } as ModelOutputChunk;
          yield { type: "stop", stopReason: "completed" } as ModelOutputChunk;
        },
        async complete() {
          throw new Error("complete unused");
        },
      },
    });

    const started = run.start();
    await waitForRunState(run, "waiting_tasks");
    notificationReady = true;
    pending = false;
    release();
    const result = await started;

    expect(result).toMatchObject({
      signal: "completed",
      message: "resumed",
      metadata: {
        revivalTurnsUsed: 1,
        forcedContinuationTurnsUsed: { revival: 1 },
      },
    });
    expect(observedTaskNotifications).toBe(1);
    expect(drainCount).toBe(1);
    expect(
      run.events
        .all()
        .filter((event) => event.type === "run.notification.injected"),
    ).toHaveLength(1);
  });

  it("does not keep the run alive for detached work", async () => {
    let waits = 0;
    const run = createStreamingRun({
      goal: "detached task",
      taskRevivalSource: {
        hasAwaitedPending: () => false,
        waitUntilAvailable: async () => {
          waits += 1;
        },
      },
      model: streamingModel([
        { type: "text_delta", text: "done" },
        { type: "stop", stopReason: "completed" },
      ]),
    });

    await expect(run.start()).resolves.toMatchObject({
      signal: "completed",
      message: "done",
    });
    expect(waits).toBe(0);
  });

  it("wakes waiting_tasks for an injected user command", async () => {
    let pending = true;
    let sawCommand = false;
    const run = createStreamingRun({
      goal: "wait for command",
      taskRevivalSource: {
        hasAwaitedPending: () => pending,
        waitUntilAvailable: () => new Promise<void>(() => {}),
      },
      model: {
        async *stream(input: ModelInput) {
          if (input.step > 1) {
            sawCommand = input.context.some(
              (item) =>
                item.source?.kind === "command" &&
                item.content === "continue now",
            );
            pending = false;
          }
          yield {
            type: "text_delta",
            text: input.step === 1 ? "waiting" : "continued",
          } as ModelOutputChunk;
          yield { type: "stop", stopReason: "completed" } as ModelOutputChunk;
        },
        async complete() {
          throw new Error("complete unused");
        },
      },
    });

    const started = run.start();
    await waitForRunState(run, "waiting_tasks");
    run.enqueueCommand({ type: "user_message", content: "continue now" });
    await expect(started).resolves.toMatchObject({
      signal: "completed",
      message: "continued",
    });
    expect(sawCommand).toBe(true);
  });

  it("cancels while waiting for an awaited task", async () => {
    const run = createStreamingRun({
      goal: "cancel wait",
      taskRevivalSource: {
        hasAwaitedPending: () => true,
        waitUntilAvailable: () => new Promise<void>(() => {}),
      },
      model: streamingModel([
        { type: "text_delta", text: "waiting" },
        { type: "stop", stopReason: "completed" },
      ]),
    });

    const started = run.start();
    await waitForRunState(run, "waiting_tasks");
    run.cancel({ reason: "stop waiting" });
    await expect(started).resolves.toMatchObject({
      signal: "cancelled",
      message: "stop waiting",
    });
  });

  it("bounds revival turns and reports pending work at exhaustion", async () => {
    let waits = 0;
    let readyNotifications = 0;
    let drainedNotifications = 0;
    const run = createStreamingRun({
      goal: "bounded revival",
      maxSteps: 1,
      maxTaskRevivalTurns: 1,
      notificationSources: [
        {
          drain() {
            if (drainedNotifications >= readyNotifications) return [];
            drainedNotifications += 1;
            return [{ content: `task update ${drainedNotifications}` }];
          },
        },
      ],
      taskRevivalSource: {
        hasAwaitedPending: () => true,
        waitUntilAvailable: async () => {
          waits += 1;
          readyNotifications += 1;
        },
      },
      model: {
        async *stream(input: ModelInput) {
          yield {
            type: "text_delta",
            text: `turn ${input.step}`,
          } as ModelOutputChunk;
          yield { type: "stop", stopReason: "completed" } as ModelOutputChunk;
        },
        async complete() {
          throw new Error("complete unused");
        },
      },
    });

    await expect(run.start()).resolves.toMatchObject({
      signal: "completed",
      message: "turn 2",
      metadata: { revivalTurnsUsed: 1 },
    });
    expect(waits).toBe(1);
    expect(
      run.events.all().filter((event) => event.type === "run.budget.exceeded"),
    ).toHaveLength(1);
  });

  it("isolates task readiness source failures", async () => {
    const run = createStreamingRun({
      goal: "source failure",
      taskRevivalSource: {
        hasAwaitedPending() {
          throw new Error("readiness unavailable");
        },
        waitUntilAvailable: async () => {},
      },
      model: streamingModel([
        { type: "text_delta", text: "done" },
        { type: "stop", stopReason: "completed" },
      ]),
    });

    await expect(run.start()).resolves.toMatchObject({
      signal: "completed",
      message: "done",
    });
    expect(
      run.events
        .all()
        .filter((event) => event.type === "run.notification.source_failed"),
    ).toHaveLength(1);
  });
});

describe("streaming-runtime tool argument decoding", () => {
  it("treats empty streamed tool-call arguments as `{}`", async () => {
    const calls: unknown[] = [];
    const noargs = defineTool({
      name: "noargs",
      description: "Zero-argument tool.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute(args) {
        calls.push(args);
        return { ok: true };
      },
    });

    let turn = 0;
    const model: ModelAdapter = {
      async *stream() {
        turn += 1;
        if (turn === 1) {
          // tool_call_start + tool_call_end with no argumentsDelta in between.
          yield {
            type: "tool_call_start",
            toolName: "noargs",
            toolCallIndex: 0,
          } as ModelOutputChunk;
          yield {
            type: "tool_call_end",
            toolCallIndex: 0,
          } as ModelOutputChunk;
          yield { type: "stop", stopReason: "tool_use" } as ModelOutputChunk;
          return;
        }
        yield { type: "text_delta", text: "done" } as ModelOutputChunk;
        yield { type: "stop", stopReason: "completed" } as ModelOutputChunk;
      },
      async complete() {
        throw new Error("complete unused");
      },
    };

    const run = createStreamingRun({ goal: "g", model, tools: [noargs] });
    const result = await run.start();
    expect(result.signal).toBe("completed");
    expect(calls).toEqual([{}]);
  });
});

describe("streaming-runtime eager tool + final text", () => {
  it("emits model.assistant_text when eager-executed turn also produced commentary", async () => {
    const eager = defineTool({
      name: "eager",
      description: "An eager-safe tool.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      execute() {
        return { ok: true };
      },
    });

    let turn = 0;
    const model: ModelAdapter = {
      async *stream() {
        turn += 1;
        if (turn === 1) {
          yield {
            type: "tool_call_start",
            toolName: "eager",
            toolCallIndex: 0,
          } as ModelOutputChunk;
          yield {
            type: "tool_call_delta",
            toolCallIndex: 0,
            argumentsDelta: "{}",
          } as ModelOutputChunk;
          yield {
            type: "tool_call_end",
            toolCallIndex: 0,
          } as ModelOutputChunk;
          yield {
            type: "text_delta",
            text: "kicking it off",
          } as ModelOutputChunk;
          yield { type: "stop", stopReason: "tool_use" } as ModelOutputChunk;
          return;
        }
        yield { type: "text_delta", text: "all good" } as ModelOutputChunk;
        yield { type: "stop", stopReason: "completed" } as ModelOutputChunk;
      },
      async complete() {
        throw new Error("complete unused");
      },
    };

    const run = createStreamingRun({
      goal: "g",
      model,
      tools: [eager],
      eagerToolExecution: true,
    });
    const result = await run.start();
    expect(result.signal).toBe("completed");
    expect(result.message).toBe("all good");
    const assistantTextEvents = run.events
      .all()
      .filter((e) => e.type === "model.assistant_text");
    expect(assistantTextEvents).toHaveLength(1);
    const payload = assistantTextEvents[0]!.payload as {
      message: string;
      discardedReason: string;
    };
    expect(payload.message).toBe("kicking it off");
    expect(payload.discardedReason).toBe("eager_tool_executed_in_turn");
  });
});

function streamingModel(chunks: ModelOutputChunk[]): ModelAdapter {
  return {
    async *stream() {
      for (const chunk of chunks) yield chunk;
    },
    async complete() {
      throw new Error("complete should not be called");
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunState(
  run: ReturnType<typeof createStreamingRun>,
  state: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (run.record.state !== state) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for run state ${state}; current state is ${run.record.state}.`,
      );
    }
    await sleep(1);
  }
}
