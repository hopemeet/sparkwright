// Model-output trace assembly for the run loop. Pure helpers that fold a
// `ModelOutput` plus request timing into the compact `ModelOutputTrace` the
// loop records per turn (token rates, cache-hit ratio, TTFT/TTLT). Extracted
// from run.ts; the loop imports `buildModelOutputTrace` / `mergeModelUsage`.

import type { ModelOutput, ModelOutputTrace } from "./types.js";

export interface StreamTraceTiming {
  firstChunkAtMs?: number;
}

export function mergeModelUsage(
  current: ModelOutput["usage"],
  next: ModelOutput["usage"],
): ModelOutput["usage"] {
  if (!next) return current;
  return {
    inputTokens: next.inputTokens ?? current?.inputTokens,
    outputTokens: next.outputTokens ?? current?.outputTokens,
    totalTokens: next.totalTokens ?? current?.totalTokens,
    cacheReadTokens: next.cacheReadTokens ?? current?.cacheReadTokens,
    cacheCreationTokens:
      next.cacheCreationTokens ?? current?.cacheCreationTokens,
    costUsd: next.costUsd ?? current?.costUsd,
    // Carry the cost-availability signal through streaming accumulation;
    // dropping it here erases the adapter's "unavailable"/"missing_pricing"
    // status so the merged usage on `model.completed` looks merely silent.
    costStatus: next.costStatus ?? current?.costStatus,
    costUnavailableReason:
      next.costUnavailableReason ?? current?.costUnavailableReason,
  };
}

export function buildModelOutputTrace(input: {
  output: ModelOutput;
  attempt: number;
  maxAttempts: number;
  adapterId?: string;
  streaming: boolean;
  requestStartedAtMs: number;
  requestCompletedAtMs: number;
  streamTiming?: StreamTraceTiming;
}): ModelOutputTrace {
  const durationMs = Math.max(
    0,
    input.requestCompletedAtMs - input.requestStartedAtMs,
  );
  const usage = input.output.usage;
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  const totalTokens =
    usage?.totalTokens ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  const ttftMs =
    input.streamTiming?.firstChunkAtMs === undefined
      ? undefined
      : Math.max(
          0,
          input.streamTiming.firstChunkAtMs - input.requestStartedAtMs,
        );
  const samplingMs =
    ttftMs === undefined ? undefined : Math.max(0, durationMs - ttftMs);
  const cacheReadTokens = usage?.cacheReadTokens;
  const cacheCreationTokens = usage?.cacheCreationTokens;

  return compactModelTrace({
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    retryCount: input.attempt - 1,
    adapterId: input.adapterId,
    streaming: input.streaming,
    durationMs,
    ttftMs,
    ttltMs: durationMs,
    requestStartedAt: new Date(input.requestStartedAtMs).toISOString(),
    requestCompletedAt: new Date(input.requestCompletedAtMs).toISOString(),
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRatePct: ratePct(cacheReadTokens, inputTokens),
    inputTokensPerSecond: ratePerSecond(inputTokens, ttftMs),
    outputTokensPerSecond: ratePerSecond(
      outputTokens,
      samplingMs ?? durationMs,
    ),
    messageChars: input.output.message?.length,
    toolCallCount: input.output.toolCalls?.length ?? 0,
  });
}

export function compactModelTrace(trace: ModelOutputTrace): ModelOutputTrace {
  return Object.fromEntries(
    Object.entries(trace).filter(([, value]) => value !== undefined),
  ) as ModelOutputTrace;
}

export function ratePerSecond(
  count: number | undefined,
  ms: number | undefined,
): number | undefined {
  if (count === undefined || ms === undefined || ms <= 0) return undefined;
  return Math.round((count / (ms / 1000)) * 100) / 100;
}

export function ratePct(
  numerator: number | undefined,
  denominator: number | undefined,
): number | undefined {
  if (
    numerator === undefined ||
    denominator === undefined ||
    denominator <= 0
  ) {
    return undefined;
  }
  return Math.round((numerator / denominator) * 10000) / 100;
}

export function countOmissionReasons(
  omitted: Array<{ reason: string }>,
): Record<string, number> {
  return omitted.reduce<Record<string, number>>((counts, item) => {
    counts[item.reason] = (counts[item.reason] ?? 0) + 1;
    return counts;
  }, {});
}
