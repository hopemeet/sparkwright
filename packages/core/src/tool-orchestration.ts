import {
  isToolConcurrencySafe,
  type ToolDefinition,
  type ToolRegistry,
} from "./tools.js";

export interface RequestedToolCall {
  toolName: string;
  arguments: unknown;
  /** Original model-supplied alias when toolName has been canonicalized. */
  requestedToolName?: string;
}

export interface ToolCallBatch {
  mode: "concurrent" | "serial";
  calls: RequestedToolCall[];
}

export interface ToolBatchExecutionOptions {
  maxConcurrency?: number;
}

const DEFAULT_MAX_TOOL_CONCURRENCY = 10;

export type ToolExecutionUpdate<TResult = unknown> =
  | {
      type: "batch_started";
      batchIndex: number;
      batch: ToolCallBatch;
    }
  | {
      type: "tool_completed";
      batchIndex: number;
      callIndex: number;
      call: RequestedToolCall;
      result: TResult;
    }
  | {
      type: "batch_completed";
      batchIndex: number;
      batch: ToolCallBatch;
    };

export function partitionToolCalls(
  registry: ToolRegistry,
  calls: RequestedToolCall[],
): ToolCallBatch[] {
  const batches: ToolCallBatch[] = [];
  let concurrent: RequestedToolCall[] = [];

  const flushConcurrent = () => {
    if (concurrent.length === 0) return;
    batches.push({ mode: "concurrent", calls: concurrent });
    concurrent = [];
  };

  for (const call of calls) {
    if (isConcurrencySafeCall(registry.get(call.toolName), call.arguments)) {
      concurrent.push(call);
      continue;
    }

    flushConcurrent();
    batches.push({ mode: "serial", calls: [call] });
  }

  flushConcurrent();
  return batches;
}

export async function runToolBatch<TResult>(
  batch: ToolCallBatch,
  runner: (call: RequestedToolCall) => Promise<TResult>,
  options: ToolBatchExecutionOptions = {},
): Promise<TResult[]> {
  if (batch.mode === "serial") {
    const results: TResult[] = [];
    for (const call of batch.calls) {
      results.push(await runner(call));
    }
    return results;
  }

  return runWithConcurrencyLimit(
    batch.calls,
    Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_TOOL_CONCURRENCY),
    runner,
  );
}

export async function* runToolBatchUpdates<TResult>(
  batch: ToolCallBatch,
  batchIndex: number,
  runner: (call: RequestedToolCall) => Promise<TResult>,
  options: ToolBatchExecutionOptions = {},
): AsyncGenerator<ToolExecutionUpdate<TResult>, TResult[]> {
  yield { type: "batch_started", batchIndex, batch };

  const results = new Array<TResult>(batch.calls.length);

  if (batch.mode === "serial") {
    for (let callIndex = 0; callIndex < batch.calls.length; callIndex += 1) {
      const call = batch.calls[callIndex]!;
      const result = await runner(call);
      results[callIndex] = result;
      yield { type: "tool_completed", batchIndex, callIndex, call, result };
    }
  } else {
    const maxConcurrency = Math.max(
      1,
      options.maxConcurrency ?? DEFAULT_MAX_TOOL_CONCURRENCY,
    );
    let nextIndex = 0;
    const inFlight = new Set<
      Promise<{
        callIndex: number;
        call: RequestedToolCall;
        result: TResult;
      }>
    >();
    const startNext = () => {
      if (nextIndex >= batch.calls.length) return;
      const callIndex = nextIndex;
      const call = batch.calls[callIndex]!;
      nextIndex += 1;
      const promise = Promise.resolve()
        .then(() => runner(call))
        .then((result) => ({ callIndex, call, result }));
      inFlight.add(promise);
      void promise.then(
        () => inFlight.delete(promise),
        () => inFlight.delete(promise),
      );
    };

    while (inFlight.size < maxConcurrency && nextIndex < batch.calls.length) {
      startNext();
    }

    while (inFlight.size > 0) {
      const item = await Promise.race(inFlight);
      results[item.callIndex] = item.result;
      yield {
        type: "tool_completed",
        batchIndex,
        callIndex: item.callIndex,
        call: item.call,
        result: item.result,
      };
      startNext();
    }
  }

  yield { type: "batch_completed", batchIndex, batch };
  return results;
}

/**
 * Build the payload shared by the `tool.batch.requested` / `tool.batch.completed`
 * span boundary. The run loop now brackets a batch with `withSpan` (so the
 * start/end pair is correlated by a span id and the per-tool events nest under
 * it), passing this same object as both the start and end payload — keeping the
 * payload shape in one tested place rather than duplicated at the call site.
 */
export function toolBatchEventPayload(
  step: number,
  index: number,
  batch: ToolCallBatch,
): {
  step: number;
  batchIndex: number;
  mode: ToolCallBatch["mode"];
  toolCallCount: number;
  toolNames: string[];
} {
  return {
    step,
    batchIndex: index,
    mode: batch.mode,
    toolCallCount: batch.calls.length,
    toolNames: batch.calls.map((call) => call.toolName),
  };
}

function isConcurrencySafeCall(
  tool: ToolDefinition | undefined,
  args: unknown,
): boolean {
  return isToolConcurrencySafe(tool, args);
}

async function runWithConcurrencyLimit<TInput, TResult>(
  inputs: TInput[],
  maxConcurrency: number,
  runner: (input: TInput) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(inputs.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < inputs.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await runner(inputs[currentIndex]!);
    }
  }

  const workerCount = Math.min(maxConcurrency, inputs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
