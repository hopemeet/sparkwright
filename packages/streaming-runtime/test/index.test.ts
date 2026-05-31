import { describe, expect, it } from "vitest";
import {
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
