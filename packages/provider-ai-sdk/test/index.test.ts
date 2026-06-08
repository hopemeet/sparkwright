import { describe, expect, it } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import {
  createRunId,
  type ModelInput,
  type ModelOutputChunk,
  type ToolDescriptor,
} from "@sparkwright/core";
import {
  cacheBreakpointIndexes,
  createAiSdkModelAdapter,
  toAiSdkTools,
  toModelMessages,
} from "../src/index.js";

describe("createAiSdkModelAdapter", () => {
  it("normalizes text output into a Sparkwright ModelOutput", async () => {
    const adapter = createAiSdkModelAdapter({
      model: new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: "text", text: "Done." }],
          finishReason: { unified: "stop", raw: undefined },
          usage: usage(),
          warnings: [],
        }),
      }),
    });

    await expect(adapter.complete(modelInput())).resolves.toEqual({
      message: "Done.",
      toolCalls: undefined,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costStatus: "unavailable",
        costUnavailableReason: "missing_pricing",
      },
    });
  });

  it("normalizes AI SDK tool calls without executing tools", async () => {
    const adapter = createAiSdkModelAdapter({
      model: new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "read_file",
              input: JSON.stringify({ path: "README.md" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: usage(),
          warnings: [],
        }),
      }),
    });

    await expect(
      adapter.complete(
        modelInput({
          tools: [readFileDescriptor()],
        }),
      ),
    ).resolves.toEqual({
      message: undefined,
      toolCalls: [
        {
          toolName: "read_file",
          arguments: { path: "README.md" },
        },
      ],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costStatus: "unavailable",
        costUnavailableReason: "missing_pricing",
      },
    });
  });

  it("marks usage cost as estimated when pricing is configured", async () => {
    const adapter = createAiSdkModelAdapter({
      pricing: {
        inputPerMTokUsd: 1,
        outputPerMTokUsd: 2,
      },
      model: new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: "text", text: "Priced." }],
          finishReason: { unified: "stop", raw: undefined },
          usage: usage(),
          warnings: [],
        }),
      }),
    });

    await expect(adapter.complete(modelInput())).resolves.toMatchObject({
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUsd: 0.000003,
        costStatus: "estimated",
      },
    });
  });

  it("annotates request timeout errors with configured timeout metadata", async () => {
    const adapter = createAiSdkModelAdapter({
      timeout: 123,
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw Object.assign(new Error("request timed out"), {
            code: "TIMEOUT",
          });
        },
      }),
    });

    await expect(adapter.complete(modelInput())).rejects.toMatchObject({
      message: "request timed out",
      code: "TIMEOUT",
      timeoutKind: "request",
      configuredTimeoutMs: 123,
    });
  });
});

describe("createAiSdkModelAdapter streaming", () => {
  it("streams text chunks and assembles final text output", async () => {
    const adapter = createAiSdkModelAdapter({
      model: new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "txt_1" },
              { type: "text-delta", id: "txt_1", delta: "Hello" },
              { type: "text-delta", id: "txt_1", delta: ", world!" },
              { type: "text-end", id: "txt_1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: {
                  inputTokens: {
                    total: 5,
                    noCache: 5,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 3, text: 3, reasoning: undefined },
                },
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        }),
      }),
    });

    const chunks: ModelOutputChunk[] = [];
    for await (const chunk of adapter.stream!(modelInput())) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: ", world!" },
    ]);
    expect(chunks.find((c) => c.type === "usage")).toMatchObject({
      type: "usage",
      usage: { inputTokens: 5, outputTokens: 3 },
    });
  });

  it("forwards the run abort signal into the underlying stream call", async () => {
    let seenSignal: AbortSignal | undefined;
    const adapter = createAiSdkModelAdapter({
      model: new MockLanguageModelV3({
        doStream: async (options) => {
          seenSignal = options.abortSignal;
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "hi" },
                { type: "text-end", id: "t" },
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: undefined },
                  usage: {
                    inputTokens: {
                      total: 1,
                      noCache: 1,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: { total: 1, text: 1, reasoning: undefined },
                  },
                },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          };
        },
      }),
    });

    const controller = new AbortController();
    for await (const _ of adapter.stream!(
      modelInput({ abortSignal: controller.signal }),
    )) {
      // drain
    }

    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("streams tool call chunks and assembles final tool calls", async () => {
    const adapter = createAiSdkModelAdapter({
      model: new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-input-start",
                id: "tc_1",
                toolName: "read_file",
                providerExecuted: false,
              },
              { type: "tool-input-delta", id: "tc_1", delta: '{"pa' },
              {
                type: "tool-input-delta",
                id: "tc_1",
                delta: 'th":"README.md"}',
              },
              { type: "tool-input-end", id: "tc_1" },
              {
                type: "tool-call",
                toolCallId: "tc_1",
                toolName: "read_file",
                input: JSON.stringify({ path: "README.md" }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: {
                  inputTokens: {
                    total: 10,
                    noCache: 10,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 5, text: 5, reasoning: undefined },
                },
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        }),
      }),
    });

    const chunks: ModelOutputChunk[] = [];
    for await (const chunk of adapter.stream!(
      modelInput({ tools: [readFileDescriptor()] }),
    )) {
      chunks.push(chunk);
    }

    expect(chunks.find((c) => c.type === "tool_call_start")).toMatchObject({
      type: "tool_call_start",
      toolName: "read_file",
      toolCallIndex: 0,
    });

    const deltas = chunks.filter((c) => c.type === "tool_call_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({
      type: "tool_call_delta",
      toolCallIndex: 0,
      argumentsDelta: '{"pa',
    });

    expect(chunks.find((c) => c.type === "tool_call_end")).toMatchObject({
      type: "tool_call_end",
      toolCallIndex: 0,
    });
  });
});

const EPHEMERAL = {
  anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

describe("toModelMessages", () => {
  it("maps neutral prompt messages to AI SDK model messages with cache breakpoints", () => {
    // No metadata.cachePolicy here, so policy falls back to `stability`:
    // the lone stable system message is the stable-prefix breakpoint, and the
    // last turn message (the tool observation) is the rolling tail breakpoint.
    expect(
      toModelMessages([
        { role: "system", content: "Stable rules.", stability: "stable" },
        { role: "user", content: "Goal.", stability: "turn" },
        { role: "assistant", content: "Previous answer.", stability: "turn" },
        { role: "tool", content: "Observation.", stability: "turn" },
      ]),
    ).toEqual([
      { role: "system", content: "Stable rules.", providerOptions: EPHEMERAL },
      { role: "user", content: "Goal." },
      { role: "assistant", content: "Previous answer." },
      {
        role: "user",
        content: "Tool observation:\nObservation.",
        providerOptions: EPHEMERAL,
      },
    ]);
  });
});

describe("cacheBreakpointIndexes", () => {
  const policy = (cachePolicy: string, content = cachePolicy) => ({
    role: "user" as const,
    content,
    metadata: { cachePolicy },
  });

  it("marks the stable-prefix end, session end, and append-only turn tail", () => {
    const prompt = [
      {
        role: "system" as const,
        content: "id",
        metadata: { cachePolicy: "stable" },
      },
      {
        role: "system" as const,
        content: "contract",
        metadata: { cachePolicy: "stable" },
      },
      policy("session", "tools"),
      policy("turn", "runtime_state"),
      policy("turn", "selected_context"),
      policy("volatile", "Step: 3"),
    ];
    // stable prefix ends at index 1, session at 2, last turn (selected_context)
    // at 4; the trailing volatile step counter is intentionally NOT cached.
    expect([...cacheBreakpointIndexes(prompt)].sort((a, b) => a - b)).toEqual([
      1, 2, 4,
    ]);
  });

  it("emits no breakpoint for an all-volatile prompt", () => {
    expect(
      cacheBreakpointIndexes([policy("volatile"), policy("volatile")]).size,
    ).toBe(0);
  });
});

describe("toAiSdkTools", () => {
  it("converts tool descriptors to AI SDK tool definitions", () => {
    const tools = toAiSdkTools([readFileDescriptor()]);

    expect(Object.keys(tools ?? {})).toEqual(["read_file"]);
    expect(tools?.read_file).toMatchObject({
      description: "Read a file.",
      metadata: {
        risk: "safe",
      },
    });
  });

  it("returns undefined when there are no tools", () => {
    expect(toAiSdkTools([])).toBeUndefined();
  });
});

function modelInput(overrides: Partial<ModelInput> = {}): ModelInput {
  const now = new Date().toISOString();

  return {
    run: {
      id: createRunId(),
      goal: "inspect repo",
      state: "running",
      createdAt: now,
      updatedAt: now,
      metadata: {},
    },
    context: [],
    prompt: [{ role: "user", content: "Inspect repo.", stability: "turn" }],
    tools: [],
    events: [],
    step: 1,
    ...overrides,
  };
}

function readFileDescriptor(): ToolDescriptor {
  return {
    name: "read_file",
    description: "Read a file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    policy: {
      risk: "safe",
    },
  };
}

function usage() {
  return {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: 1,
      text: 1,
      reasoning: undefined,
    },
  };
}
