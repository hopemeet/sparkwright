import {
  generateText,
  streamText,
  jsonSchema,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UserContent,
} from "ai";
import {
  sanitizeToolSchema,
  type ContentPart,
  type ModelAdapter,
  type ModelInput,
  type ModelOutput,
  type ModelOutputChunk,
  type ModelPricing,
  type ModelUsage,
  type PromptMessage,
  type ToolDescriptor,
} from "@sparkwright/core";
import type {
  ModelInfo,
  ProviderAdapterFactoryInput,
  ProviderDefinition,
} from "@sparkwright/provider-registry";

type ProviderOptions = NonNullable<
  Parameters<typeof generateText>[0]["providerOptions"]
>;

export interface AiSdkModelAdapterOptions {
  model: LanguageModel;
  maxRetries?: number;
  timeout?: number;
  /** Stable identifier surfaced to UsageTracker so `byModel` is keyed correctly. */
  id?: string;
  /** Per-million-token pricing used to attach `costUsd` to emitted usage. */
  pricing?: ModelPricing;
  /** Request-level AI SDK provider options forwarded to generate/stream calls. */
  providerOptions?: ProviderOptions;
}

export function createAiSdkModelAdapter(
  options: AiSdkModelAdapterOptions,
): ModelAdapter {
  const withCost = (usage: ModelUsage | undefined): ModelUsage | undefined =>
    applyPricing(usage, options.pricing);

  return {
    ...(options.id ? { id: options.id } : {}),
    async complete(input: ModelInput): Promise<ModelOutput> {
      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        result = await generateText({
          model: options.model,
          messages: toModelMessages(input.prompt ?? fallbackPrompt(input)),
          allowSystemInMessages: true,
          tools: toAiSdkTools(input.tools),
          maxRetries: options.maxRetries ?? 0,
          timeout: options.timeout,
          providerOptions: options.providerOptions,
          // Forward the run-scoped abort signal so cancel() aborts the in-flight
          // HTTP request instead of letting it run to completion.
          abortSignal: input.abortSignal,
        });
      } catch (cause) {
        throw annotateTimeoutError(cause, options.timeout, "request");
      }

      const output = {
        message: result.text || undefined,
        toolCalls:
          result.toolCalls.length > 0
            ? result.toolCalls.map((call) => ({
                toolName: String(call.toolName),
                arguments: call.input,
              }))
            : undefined,
        usage: withCost(normalizeUsage(result.usage)),
      };

      return output as ModelOutput;
    },

    async *stream(input: ModelInput): AsyncIterable<ModelOutputChunk> {
      let fullStream: Awaited<ReturnType<typeof streamText>>["fullStream"];
      try {
        ({ fullStream } = streamText({
          model: options.model,
          messages: toModelMessages(input.prompt ?? fallbackPrompt(input)),
          allowSystemInMessages: true,
          tools: toAiSdkTools(input.tools),
          maxRetries: options.maxRetries ?? 0,
          timeout: options.timeout,
          providerOptions: options.providerOptions,
          // Forward the run-scoped abort signal so cancel() tears down the SSE
          // stream mid-flight rather than draining the full response.
          abortSignal: input.abortSignal,
        }));
      } catch (cause) {
        throw annotateTimeoutError(cause, options.timeout, "stream");
      }

      // Track tool-input-start id -> index mapping for stable ordering
      const toolCallIdToIndex = new Map<string, number>();
      let nextToolCallIndex = 0;

      try {
        for await (const chunk of fullStream) {
          if (chunk.type === "error") {
            // The AI SDK reports API/network failures as an `error` chunk on
            // fullStream rather than throwing. Re-throw so the run loop's
            // stream catch emits `model.stream.failed` and the run fails
            // visibly instead of silently completing with empty output.
            const err = (chunk as { error: unknown }).error;
            if (err instanceof Error) throw err;
            throw new Error(
              typeof err === "string" ? err : JSON.stringify(err),
            );
          }
          if (chunk.type === "text-delta") {
            yield { type: "text_delta", text: chunk.text };
          } else if (chunk.type === "reasoning-delta") {
            yield { type: "reasoning_delta", text: chunk.text };
          } else if (chunk.type === "tool-input-start") {
            const index = nextToolCallIndex++;
            toolCallIdToIndex.set(chunk.id, index);
            yield {
              type: "tool_call_start",
              toolName: chunk.toolName,
              toolCallIndex: index,
            };
          } else if (chunk.type === "tool-input-delta") {
            const index = toolCallIdToIndex.get(chunk.id);
            if (index !== undefined) {
              yield {
                type: "tool_call_delta",
                toolCallIndex: index,
                argumentsDelta: chunk.delta,
              };
            }
          } else if (chunk.type === "tool-call") {
            const index = toolCallIdToIndex.get(chunk.toolCallId);
            if (index !== undefined) {
              yield { type: "tool_call_end", toolCallIndex: index };
            }
          } else if (chunk.type === "finish") {
            const usage = withCost(normalizeUsage(chunk.totalUsage));
            if (usage) {
              yield { type: "usage", usage };
            }
          }
        }
      } catch (cause) {
        throw annotateTimeoutError(cause, options.timeout, "stream");
      }
    },
  };
}

export function toAiSdkTools(tools: ToolDescriptor[]): ToolSet | undefined {
  if (tools.length === 0) return undefined;

  return Object.fromEntries(
    tools.map((descriptor) => [
      descriptor.name,
      tool({
        description: descriptor.description,
        inputSchema: jsonSchema(asJsonSchema(descriptor.inputSchema)),
        metadata: {
          risk: descriptor.policy?.risk ?? "safe",
        },
      }),
    ]),
  );
}

/**
 * Read the section's cache policy off prompt metadata, falling back to the
 * coarser `stability` flag (and finally "turn") for messages built outside the
 * sectioned builder, e.g. `fallbackPrompt`.
 */
function cachePolicyOf(message: PromptMessage): string {
  const fromMeta = message.metadata?.["cachePolicy"];
  if (typeof fromMeta === "string") return fromMeta;
  return message.stability ?? "turn";
}

/**
 * Choose where to drop Anthropic prompt-cache breakpoints. A breakpoint caches
 * the whole prefix up to and including the marked message, so we want them at
 * the boundaries of our cache tiers — and Anthropic allows at most 4, so we
 * stay well under by emitting at most three:
 *
 *   1. end of the contiguous `stable` system prefix  (identity + contracts)
 *   2. end of the `session` tier                     (tool descriptors)
 *   3. the last `turn` message                       (append-only selected_context)
 *
 * (3) is the rolling tail: because selected_context is append-only and the
 * volatile per-step counter now trails it, the bytes up to (3) are identical
 * across steps on the normal path, so this breakpoint is a cache READ every
 * step after the first. The trailing volatile block stays uncached and tiny.
 */
export function cacheBreakpointIndexes(prompt: PromptMessage[]): Set<number> {
  const marks = new Set<number>();

  // 1. contiguous stable prefix from the start
  let stableEnd = -1;
  for (let i = 0; i < prompt.length; i += 1) {
    if (cachePolicyOf(prompt[i]!) === "stable") stableEnd = i;
    else break;
  }
  if (stableEnd >= 0) marks.add(stableEnd);

  // 2. last session-tier message
  let sessionEnd = -1;
  // 3. last turn-tier message (the append-only context tail)
  let turnEnd = -1;
  for (let i = 0; i < prompt.length; i += 1) {
    const policy = cachePolicyOf(prompt[i]!);
    if (policy === "session") sessionEnd = i;
    else if (policy === "turn") turnEnd = i;
  }
  if (sessionEnd >= 0) marks.add(sessionEnd);
  if (turnEnd >= 0) marks.add(turnEnd);

  return marks;
}

const ANTHROPIC_CACHE_OPTION = {
  anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

export function toModelMessages(prompt: PromptMessage[]): ModelMessage[] {
  const marks = cacheBreakpointIndexes(prompt);
  return prompt.map((message, index): ModelMessage => {
    // Anthropic reads message-level cacheControl; the AI SDK forwards
    // `providerOptions` verbatim and other providers ignore the anthropic key,
    // so marking here is safe across providers.
    const providerOptions = marks.has(index)
      ? ANTHROPIC_CACHE_OPTION
      : undefined;

    if (message.role === "tool") {
      return {
        role: "user",
        content: userContentFromPromptMessage(message, "Tool observation:\n"),
        ...(providerOptions ? { providerOptions } : {}),
      };
    }

    if (message.role === "user") {
      return {
        role: "user",
        content: userContentFromPromptMessage(message),
        ...(providerOptions ? { providerOptions } : {}),
      };
    }

    return {
      role: message.role,
      content: message.content,
      ...(providerOptions ? { providerOptions } : {}),
    };
  });
}

function fallbackPrompt(input: ModelInput): PromptMessage[] {
  return [
    {
      role: "system",
      content: "You are running inside the Sparkwright harness.",
      stability: "stable",
    },
    {
      role: "user",
      content: [
        `Goal: ${input.run.goal}`,
        `Step: ${input.step}`,
        "Context:",
        ...input.context.map((item, index) => `${index + 1}. ${item.content}`),
      ].join("\n"),
      parts: input.context.flatMap((item) => item.parts ?? []),
      stability: "turn",
    },
  ];
}

function userContentFromPromptMessage(
  message: PromptMessage,
  prefix = "",
): UserContent {
  const text = `${prefix}${message.content}`;
  const parts = (message.parts ?? [])
    .map(toAiSdkContentPart)
    .filter((part): part is UserContentPart => part !== undefined);
  if (parts.length === 0) return text;
  return [{ type: "text", text }, ...parts];
}

type UserContentPart = Exclude<UserContent, string>[number];

function toAiSdkContentPart(part: ContentPart): UserContentPart | undefined {
  if (part.type === "text") return { type: "text", text: part.text };

  const payload = partData(part);
  if (!payload) {
    return {
      type: "text",
      text: `[${part.type} attachment omitted: missing data or uri]`,
    };
  }

  if (part.type === "image") {
    return {
      type: "image",
      image: payload,
      ...(part.mediaType ? { mediaType: part.mediaType } : {}),
    };
  }

  return {
    type: "file",
    data: payload,
    mediaType: part.mediaType ?? "application/octet-stream",
    ...(part.name ? { filename: part.name } : {}),
  };
}

function partData(
  part: Extract<ContentPart, { type: "image" | "file" | "audio" }>,
) {
  if (part.data) return part.data;
  if (!part.uri) return undefined;
  try {
    return new URL(part.uri);
  } catch {
    return undefined;
  }
}

function asJsonSchema(schema: unknown): Parameters<typeof jsonSchema>[0] {
  // Sanitize before forwarding so a single tool schema is accepted by both
  // cloud providers and strict local grammar backends.
  const sanitized = sanitizeToolSchema(schema);
  if (
    typeof sanitized === "object" &&
    sanitized !== null &&
    !Array.isArray(sanitized)
  ) {
    return sanitized as Parameters<typeof jsonSchema>[0];
  }

  return {};
}

type NormalizedUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

function normalizeUsage(usage: unknown): NormalizedUsage | undefined {
  if (!isRecord(usage)) return undefined;

  const inputTokens = tokenTotal(usage.inputTokens);
  const outputTokens = tokenTotal(usage.outputTokens);
  const totalTokens = numericValue(usage.totalTokens);
  const inputTokenDetails = isRecord(usage.inputTokensDetails)
    ? usage.inputTokensDetails
    : undefined;
  const cacheReadTokens =
    tokenTotal(usage.cacheReadTokens) ??
    tokenTotal(usage.cachedInputTokens) ??
    tokenTotal(inputTokenDetails?.cachedTokens);
  const cacheCreationTokens =
    tokenTotal(usage.cacheCreationTokens) ??
    tokenTotal(inputTokenDetails?.cacheCreationTokens);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    cacheReadTokens,
    cacheCreationTokens,
  };
}

function tokenTotal(value: unknown): number | undefined {
  if (isRecord(value)) return numericValue(value.total);
  return numericValue(value);
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function annotateTimeoutError(
  cause: unknown,
  configuredTimeoutMs: number | undefined,
  timeoutKind: "request" | "stream",
): unknown {
  if (!looksLikeTimeout(cause)) return cause;
  const metadata = {
    timeoutKind,
    ...(configuredTimeoutMs !== undefined ? { configuredTimeoutMs } : {}),
  };
  if (cause instanceof Error) {
    return Object.assign(cause, metadata);
  }
  if (isRecord(cause)) {
    return { ...cause, ...metadata };
  }
  return Object.assign(new Error(String(cause)), metadata);
}

function looksLikeTimeout(cause: unknown): boolean {
  if (isRecord(cause)) {
    const code = stringValue(cause.code)?.toUpperCase();
    if (code && (code.includes("TIMEOUT") || code === "ETIMEDOUT")) {
      return true;
    }
    const name = stringValue(cause.name)?.toLowerCase();
    if (name?.includes("timeout")) return true;
  }
  const message =
    cause instanceof Error
      ? cause.message
      : isRecord(cause)
        ? stringValue(cause.message)
        : typeof cause === "string"
          ? cause
          : undefined;
  return message !== undefined && /\b(time[- ]?out|timed out)\b/i.test(message);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyPricing(
  usage: ModelUsage | undefined,
  pricing: ModelPricing | undefined,
): ModelUsage | undefined {
  if (!usage) return usage;
  if (!pricing) {
    return {
      ...usage,
      costStatus: "unavailable",
      costUnavailableReason: "missing_pricing",
    };
  }

  const nonCachedInput =
    (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0);
  const cost =
    Math.max(0, nonCachedInput) * (pricing.inputPerMTokUsd ?? 0) +
    (usage.outputTokens ?? 0) * (pricing.outputPerMTokUsd ?? 0) +
    (usage.cacheReadTokens ?? 0) * (pricing.cacheReadPerMTokUsd ?? 0) +
    (usage.cacheCreationTokens ?? 0) * (pricing.cacheCreationPerMTokUsd ?? 0);

  return { ...usage, costUsd: cost / 1_000_000, costStatus: "estimated" };
}

/**
 * Curated OpenAI pricing table (USD per million tokens). Values reflect
 * publicly listed prices at the time of writing — update as OpenAI publishes
 * new tiers. Callers that need to override a model's pricing should pass an
 * explicit `models` list to {@link createOpenAiProvider}.
 */
export const OPENAI_MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o-mini": {
    inputPerMTokUsd: 0.15,
    outputPerMTokUsd: 0.6,
    cacheReadPerMTokUsd: 0.075,
  },
  "gpt-4o": {
    inputPerMTokUsd: 2.5,
    outputPerMTokUsd: 10,
    cacheReadPerMTokUsd: 1.25,
  },
  "gpt-4.1": {
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 8,
    cacheReadPerMTokUsd: 0.5,
  },
  "gpt-4.1-mini": {
    inputPerMTokUsd: 0.4,
    outputPerMTokUsd: 1.6,
    cacheReadPerMTokUsd: 0.1,
  },
  "gpt-4.1-nano": {
    inputPerMTokUsd: 0.1,
    outputPerMTokUsd: 0.4,
    cacheReadPerMTokUsd: 0.025,
  },
};

export interface CreateOpenAiProviderOptions {
  /**
   * AI SDK `createOpenAI(...)` result — the function that maps a model id to
   * a `LanguageModel`. Caller owns the `@ai-sdk/openai` import so this package
   * stays provider-package-agnostic.
   */
  openai: (modelId: string) => LanguageModel;
  /** Provider id used when resolving model references. Defaults to `"openai"`. */
  id?: string;
  displayName?: string;
  /**
   * Models exposed by this provider. Defaults to the keys of
   * {@link OPENAI_MODEL_PRICING}, each with its built-in pricing. Supply a
   * custom list (with or without pricing) to override.
   */
  models?: ModelInfo[];
  defaultModelId?: string;
  /** Optional adapter knobs forwarded to {@link createAiSdkModelAdapter}. */
  adapter?: Pick<AiSdkModelAdapterOptions, "maxRetries" | "timeout">;
}

/**
 * Build a {@link ProviderDefinition} for OpenAI (or any OpenAI-compatible
 * endpoint) that wires `id` + `pricing` into the resulting adapter
 * automatically. Caller passes the configured `createOpenAI(...)` callable so
 * this package does not depend on `@ai-sdk/openai`.
 */
export function createOpenAiProvider(
  options: CreateOpenAiProviderOptions,
): ProviderDefinition {
  const providerId = options.id ?? "openai";
  const models =
    options.models ??
    Object.entries(OPENAI_MODEL_PRICING).map(([id, pricing]) => ({
      id,
      providerId,
      pricing,
    }));

  return {
    id: providerId,
    displayName: options.displayName,
    defaultModelId: options.defaultModelId,
    models,
    createAdapter: (input: ProviderAdapterFactoryInput) =>
      createAiSdkModelAdapter({
        model: options.openai(input.model.id),
        id: `${providerId}:${input.model.id}`,
        pricing: input.model.pricing,
        maxRetries: options.adapter?.maxRetries ?? 0,
        timeout: options.adapter?.timeout,
        providerOptions: providerOptionsFromMetadata(input.model.metadata),
      }),
  };
}

function providerOptionsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): ProviderOptions | undefined {
  const providerOptions = metadata?.["providerOptions"];
  if (!isProviderOptions(providerOptions)) return undefined;
  return providerOptions;
}

function isProviderOptions(value: unknown): value is ProviderOptions {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isRecord);
}
