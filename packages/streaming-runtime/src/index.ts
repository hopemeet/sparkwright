import {
  DefaultContextAssembler,
  DefaultObservationFormatter,
  DefaultPromptBuilder,
  ToolRegistry,
  approvalResolverFromChannel,
  compilePromptCacheBlocks,
  createApprovalRequest,
  createContextItemId,
  createDefaultPolicy,
  createRunId,
  createSpanId,
  createToolCall,
  emitInSpan,
  isToolConcurrencySafe,
  openSpan,
  partitionToolCalls,
  runToolBatch,
  runWithSpan,
  toolBatchEventPayload,
  validateToolArguments,
  validateToolOutput,
  withSpan,
  type ApprovalResolver,
  type ContextAssembler,
  type ContextBudget,
  type ContextItem,
  type EventLog,
  type InteractionChannel,
  type ModelAdapter,
  type ModelInput,
  type ModelOutput,
  type ModelOutputChunk,
  type ObservationFormatter,
  type Policy,
  type PolicyDecision,
  type PolicyResource,
  type PromptBuilder,
  type PromptMessage,
  type RunCommand,
  type RunRecord,
  type RunResult,
  type RunState,
  type RunStopReason,
  type RunStore,
  type RunStreamItem,
  type RuntimeContext,
  type SpanFrame,
  type SparkwrightEvent,
  type ToolDefinition,
  type ToolResult,
} from "@sparkwright/core";
import { EventLog as CoreEventLog } from "@sparkwright/core/internal";

/**
 * Free-form payload injected into the next turn as a user-role context item.
 *
 * `content` is the visible text. `source` and `metadata` populate the trace
 * so notifications are debuggable without leaking into the prompt body.
 *
 * @public
 * @stability experimental v0.1
 */
export interface PendingNotification {
  content: string;
  source?: { kind: string; uri?: string };
  metadata?: Record<string, unknown>;
}

/**
 * Pluggable source of out-of-band signals the agent loop should see between
 * turns. The streaming runtime calls `drain()` at the start of every step;
 * returned items become user-role context items before the model runs.
 *
 * The source is expected to consume what it returns — the runtime will not
 * re-deliver the same items. Typical implementations: a TaskManager's
 * `InMemoryTaskNotificationQueue.drain()` mapped to {@link PendingNotification},
 * a Slack inbox poller, a webhook fan-in.
 *
 * Sources MUST be safe to call repeatedly and SHOULD return synchronously
 * when nothing is queued (`drain()` is in the hot path of every turn).
 *
 * @public
 * @stability experimental v0.1
 */
export interface NotificationSource {
  drain(): PendingNotification[] | Promise<PendingNotification[]>;
}

export interface CreateStreamingRunOptions {
  goal: string;
  model: ModelAdapter;
  tools?: ToolDefinition[];
  policy?: Policy;
  approvalResolver?: ApprovalResolver;
  interactionChannel?: InteractionChannel;
  workspace?: RuntimeContext["workspace"];
  context?: ContextItem[];
  contextAssembler?: ContextAssembler;
  contextBudget?: ContextBudget;
  observationFormatter?: ObservationFormatter;
  promptBuilder?: PromptBuilder<PromptMessage[]>;
  maxSteps?: number;
  streamTimeoutMs?: number;
  /**
   * Higher idle threshold used for the *first* chunk of a model stream, when
   * the model is still doing pre-token work (prompt-cache lookup, tool-result
   * digestion, initial reasoning). Once a chunk has been observed in the
   * current stream, `streamTimeoutMs` applies for inter-chunk waits. When
   * omitted, the same `streamTimeoutMs` is used for both phases (legacy
   * single-threshold behavior). See docs/PROTOCOL.md "model.stream.timeout".
   */
  streamFirstChunkTimeoutMs?: number;
  toolTimeoutMs?: number;
  maxToolConcurrency?: number;
  /**
   * Opt-in eager execution for streamed tool calls. When enabled, the runtime
   * may execute a tool as soon as a complete streamed call is available, but
   * only when the tool is concurrency-safe. Unsafe tools still run after the
   * assistant turn is fully streamed.
   */
  eagerToolExecution?: boolean;
  abortSignal?: AbortSignal;
  metadata?: Record<string, unknown>;
  runStore?: RunStore | ((run: RunRecord) => RunStore);
  /**
   * Out-of-band notification sources. Drained at the start of every step
   * before any pending commands are applied; results land as user-role
   * context items in the working layer. Use for background-task completion
   * signals (`TaskNotificationSink`), inbound chat messages, etc.
   */
  notificationSources?: NotificationSource[];
}

export interface StreamingRunHandle {
  readonly record: RunRecord;
  readonly events: EventLog;
  readonly tools: ToolRegistry;
  readonly abortSignal: AbortSignal;
  start(): Promise<RunResult>;
  stream(): AsyncIterable<RunStreamItem>;
  cancel(input?: {
    reason?: string;
    metadata?: Record<string, unknown>;
  }): RunResult;
  enqueueCommand(command: RunCommand): void;
  checkPolicy(
    action: string,
    metadata?: Record<string, unknown>,
    resource?: PolicyResource,
  ): Promise<PolicyDecision> | PolicyDecision;
}

interface StreamedToolCallBuilder {
  toolName: string;
  argumentsParts: string[];
  parsedArguments?: unknown;
  eagerExecuted?: boolean;
}

interface RequestedToolCall {
  toolName: string;
  arguments: unknown;
}

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TOOL_CONCURRENCY = 10;

export function createStreamingRun(
  options: CreateStreamingRunOptions,
): StreamingRunHandle {
  return new AfterTurnStreamingRun(options);
}

class AfterTurnStreamingRun implements StreamingRunHandle {
  readonly record: RunRecord;
  readonly events: EventLog;
  readonly tools = new ToolRegistry();
  readonly abortSignal: AbortSignal;

  private readonly model: ModelAdapter;
  private readonly policy: Policy;
  private readonly approvalResolver?: ApprovalResolver;
  private readonly interactionChannel?: InteractionChannel;
  private readonly workspace?: RuntimeContext["workspace"];
  private readonly contextAssembler: ContextAssembler;
  private readonly contextBudget?: ContextBudget;
  private readonly observationFormatter: ObservationFormatter;
  private readonly promptBuilder: PromptBuilder<PromptMessage[]>;
  private readonly maxSteps: number;
  private readonly streamTimeoutMs?: number;
  private readonly streamFirstChunkTimeoutMs?: number;
  private readonly toolTimeoutMs?: number;
  /**
   * Count of model stream invocations that have produced at least one chunk
   * during this run. Used to triage `model.stream.timeout` events: a timeout
   * with `apiCallCount: 0` happened before any chunk was observed (prompt
   * build, credential resolution, or initial network handshake stuck), while
   * a non-zero count means the model started responding before stalling.
   */
  private apiCallCount = 0;
  private readonly maxToolConcurrency: number;
  private readonly eagerToolExecution: boolean;
  private readonly abortController = new AbortController();
  private readonly commandQueue: RunCommand[] = [];
  private readonly runStore?: RunStore;
  private readonly notificationSources: NotificationSource[];
  private storeAppendQueue: Promise<void> = Promise.resolve();
  private context: ContextItem[];
  private result?: RunResult;
  private started = false;
  private eagerToolExecutedInTurn = false;

  constructor(options: CreateStreamingRunOptions) {
    const now = new Date().toISOString();
    this.record = {
      id: createRunId(),
      goal: options.goal,
      state: "created",
      createdAt: now,
      updatedAt: now,
      metadata: options.metadata ?? {},
    };
    this.events = new CoreEventLog(this.record.id);
    this.abortSignal = this.abortController.signal;
    this.model = options.model;
    this.policy = options.policy ?? createDefaultPolicy();
    this.interactionChannel = options.interactionChannel;
    this.approvalResolver =
      (this.interactionChannel &&
        approvalResolverFromChannel(this.interactionChannel)) ??
      options.approvalResolver;
    this.workspace = options.workspace;
    this.context = [...(options.context ?? [])];
    this.contextAssembler =
      options.contextAssembler ??
      new DefaultContextAssembler({ budget: options.contextBudget });
    this.contextBudget = options.contextBudget;
    this.observationFormatter =
      options.observationFormatter ?? new DefaultObservationFormatter();
    this.promptBuilder = options.promptBuilder ?? new DefaultPromptBuilder();
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.streamTimeoutMs = options.streamTimeoutMs;
    this.streamFirstChunkTimeoutMs = options.streamFirstChunkTimeoutMs;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.maxToolConcurrency =
      options.maxToolConcurrency ?? DEFAULT_MAX_TOOL_CONCURRENCY;
    this.eagerToolExecution = options.eagerToolExecution ?? false;
    this.notificationSources = [...(options.notificationSources ?? [])];

    validatePositiveInteger("maxSteps", this.maxSteps);
    validateOptionalPositiveInteger("streamTimeoutMs", this.streamTimeoutMs);
    validateOptionalPositiveInteger(
      "streamFirstChunkTimeoutMs",
      this.streamFirstChunkTimeoutMs,
    );
    validateOptionalPositiveInteger("toolTimeoutMs", this.toolTimeoutMs);
    validatePositiveInteger("maxToolConcurrency", this.maxToolConcurrency);

    for (const tool of options.tools ?? []) {
      this.tools.register(tool);
    }

    this.events.emit("run.created", { goal: this.record.goal });

    this.runStore =
      typeof options.runStore === "function"
        ? options.runStore(this.record)
        : options.runStore;
    if (this.runStore) {
      for (const event of this.events.all()) {
        this.safeStoreAppend(event);
      }
      this.events.subscribe((event) => this.safeStoreAppend(event));
    }

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        this.cancel({ reason: "External abort signal was already aborted." });
      } else {
        options.abortSignal.addEventListener(
          "abort",
          () => {
            this.cancel({ reason: "External abort signal aborted the run." });
          },
          { once: true },
        );
      }
    }
  }

  async start(): Promise<RunResult> {
    if (this.result) return this.result;
    if (this.started) {
      throw new Error("Streaming run has already been started.");
    }

    this.started = true;
    const result = await this.runLoop();
    await this.safeStoreFinish(result);
    return result;
  }

  async *stream(): AsyncIterable<RunStreamItem> {
    const yielded = new Set<string>();
    for (const event of this.events.all()) {
      yielded.add(event.id);
      yield event;
    }

    if (isTerminalState(this.record.state) && this.result) {
      yield { type: "run.result", runId: this.record.id, result: this.result };
      return;
    }

    const queue: SparkwrightEvent[] = [];
    let wake: (() => void) | undefined;
    let settled = false;
    let thrown: unknown;

    const unsubscribe = this.events.subscribe((event) => {
      if (yielded.has(event.id)) return;
      queue.push(event);
      wake?.();
      wake = undefined;
    });

    const resultPromise = this.start()
      .then((result) => {
        settled = true;
        wake?.();
        wake = undefined;
        return result;
      })
      .catch((cause) => {
        thrown = cause;
        settled = true;
        wake?.();
        wake = undefined;
        return undefined;
      });

    try {
      while (!settled || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }

        while (queue.length > 0) {
          const event = queue.shift()!;
          yielded.add(event.id);
          yield event;
        }

        if (thrown !== undefined) throw thrown;
      }

      const result = await resultPromise;
      if (thrown !== undefined) throw thrown;
      if (result) yield { type: "run.result", runId: this.record.id, result };
    } finally {
      unsubscribe();
    }
  }

  cancel(
    input: {
      reason?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): RunResult {
    if (this.result) return this.result;

    this.abortController.abort();
    this.events.emit("run.cancel_requested", {
      reason: input.reason ?? "Run cancelled.",
      metadata: input.metadata ?? {},
    });
    this.setState("cancelled", "manual_cancelled");
    this.events.emit("run.cancelled", {
      reason: "manual_cancelled",
      message: input.reason ?? "Run cancelled.",
      metadata: input.metadata ?? {},
    });
    this.result = {
      signal: "cancelled",
      state: "cancelled",
      stopReason: "manual_cancelled",
      message: input.reason,
      metadata: input.metadata ?? {},
    };
    return this.result;
  }

  enqueueCommand(command: RunCommand): void {
    this.commandQueue.push(command);
    this.events.emit("run.command.enqueued", {
      commandType: command.type,
      metadata: command.metadata ?? {},
    });
    if (command.type === "cancel") {
      this.cancel({ reason: command.reason, metadata: command.metadata });
    }
  }

  async checkPolicy(
    action: string,
    metadata: Record<string, unknown> = {},
    resource?: PolicyResource,
  ) {
    return this.policy.decide({ action, metadata, resource });
  }

  private async runLoop(): Promise<RunResult> {
    // Root span for the whole run, mirroring core's SparkwrightRun. Reuses the
    // EventLog's trace id so `run.created` (emitted before the loop) and every
    // in-loop event stay on ONE trace; a fresh trace id here would fragment the
    // run. All model turns, tool batches, and tool calls inherit this frame via
    // AsyncLocalStorage so the trace rebuilds as a tree.
    const runFrame: SpanFrame = {
      traceId: this.events.traceId,
      spanId: createSpanId(),
    };
    return runWithSpan(runFrame, () => this.runLoopBody());
  }

  private async runLoopBody(): Promise<RunResult> {
    if (this.result) return this.result;
    if (!this.model.stream) {
      return this.fail(
        "model_completion_failed",
        "MODEL_STREAM_UNAVAILABLE",
        "Streaming runtime requires a model adapter with stream().",
      );
    }

    this.setState("running");
    this.events.emit("run.started", { goal: this.record.goal });

    for (let step = 1; step <= this.maxSteps; step += 1) {
      await this.drainNotificationSources(step);
      const commandResult = this.consumePendingCommands(step);
      if (commandResult) return commandResult;
      if (this.result) return this.result;

      let output: ModelOutput;
      try {
        const input = await this.buildModelInput(step);
        output = await this.completeStreamingTurn(input);
      } catch (cause) {
        if (this.result) return this.result;
        if (cause instanceof StreamTimeoutError) {
          return this.fail(
            "aborted_streaming",
            "MODEL_STREAM_TIMEOUT",
            cause.message,
            { step, timeoutMs: cause.timeoutMs },
          );
        }
        if (isAbortError(cause) || this.abortSignal.aborted) {
          return this.cancel({
            reason: "Model stream aborted by cancellation.",
            metadata: { step },
          });
        }
        return this.fail(
          "model_completion_failed",
          "MODEL_STREAM_FAILED",
          cause instanceof Error ? cause.message : String(cause),
          { step },
        );
      }

      const toolCalls = output.toolCalls ?? [];
      if (toolCalls.length === 0) {
        if (this.eagerToolExecutedInTurn) {
          this.eagerToolExecutedInTurn = false;
          if (output.message) {
            // Eager tools already ran; the model also produced assistant text
            // in the same turn. We intentionally do NOT terminate — the next
            // turn lets the model reconcile against the tool result. Surface
            // the discarded text in the trace so it is not silently lost.
            this.events.emit("model.assistant_text", {
              step,
              message: output.message,
              discardedReason: "eager_tool_executed_in_turn",
            });
          }
          continue;
        }
        return this.complete("final_answer", { message: output.message });
      }

      const toolResult = await this.runToolsAfterTurn(step, toolCalls);
      if (toolResult) return toolResult;
    }

    return this.fail(
      "max_steps_exceeded",
      "MAX_STEPS_EXCEEDED",
      `Run exceeded the maximum step count of ${this.maxSteps}.`,
      { maxSteps: this.maxSteps },
    );
  }

  private async buildModelInput(step: number): Promise<ModelInput> {
    const assembled = await this.contextAssembler.assemble({
      run: this.record,
      step,
      goal: this.record.goal,
      events: this.events.all(),
      priorContext: this.context,
      tools: this.tools.listDescriptors(),
      model: this.model.contextHints,
      budget: this.contextBudget,
    });
    this.events.emit("context.assembled", {
      step,
      selectedCount: assembled.items.length,
      omittedCount: assembled.omitted.length,
      omitted: assembled.omitted,
      metadata: assembled.metadata,
    });

    const prompt = await this.promptBuilder.build({
      run: this.record,
      step,
      tools: this.tools.listDescriptors(),
      context: assembled.items,
    });
    const cacheBlocks = compilePromptCacheBlocks(prompt);
    this.events.emit("prompt.built", {
      step,
      messageCount: prompt.length,
      roles: prompt.map((message) => message.role),
      cacheBlocks: cacheBlocks.blocks.map((block, index) => ({
        index,
        role: block.role,
        cachePolicy: block.cachePolicy,
        stability: block.stability,
        chars: block.content.length,
        messageIndexes: block.messageIndexes,
        sectionNames: block.sectionNames,
      })),
      stablePrefixBlockCount: cacheBlocks.stablePrefix.length,
    });

    return {
      run: this.record,
      context: assembled.items,
      prompt,
      tools: this.tools.listDescriptors(),
      events: this.events.all(),
      step,
      abortSignal: this.abortSignal,
    };
  }

  private async completeStreamingTurn(input: ModelInput): Promise<ModelOutput> {
    // Per-turn model span. The inner body's `model.requested`, every
    // `model.stream.*` chunk/marker, and the turn's `model.completed` are
    // emitted inside this frame (EventLog.emit falls back to the active ALS
    // span), so the trace reads run → model.turn → {stream events}. A stream
    // failure/timeout throws out of the inner body; withSpan emits
    // `model.turn.completed` (its fail close defaults to the end type) and
    // re-throws, so the model phase is always bracketed.
    return withSpan(
      this.events,
      {
        startType: "model.turn.started",
        endType: "model.turn.completed",
        payload: { step: input.step },
      },
      () => this.completeStreamingTurnInner(input),
    );
  }

  private async completeStreamingTurnInner(
    input: ModelInput,
  ): Promise<ModelOutput> {
    this.events.emit("model.requested", {
      goal: this.record.goal,
      step: input.step,
      streaming: true,
    });
    this.events.emit("model.stream.started", { step: input.step });

    let text = "";
    let usage: ModelOutput["usage"];
    let stopReason: ModelOutput["stopReason"];
    const builders = new Map<number, StreamedToolCallBuilder>();
    let nextImplicitToolCallIndex = 0;
    this.eagerToolExecutedInTurn = false;

    const iterator = this.model.stream!(input)[Symbol.asyncIterator]();
    let chunksReceived = 0;
    try {
      while (true) {
        // Dual-threshold idle detection: before the first chunk, the model
        // may still be doing pre-token work (prompt-cache lookup, tool-result
        // digestion). After the first chunk, inter-chunk gaps should be
        // small. `streamFirstChunkTimeoutMs` is the high threshold; falls
        // back to `streamTimeoutMs` when not configured (legacy behavior).
        const effectiveTimeoutMs =
          chunksReceived === 0
            ? (this.streamFirstChunkTimeoutMs ?? this.streamTimeoutMs)
            : this.streamTimeoutMs;
        const next = await nextStreamChunk(
          iterator,
          this.abortSignal,
          effectiveTimeoutMs,
          chunksReceived === 0 ? "pre-first-chunk" : "post-first-chunk",
        );
        if (next.done) break;

        const chunk = next.value;
        if (chunksReceived === 0) this.apiCallCount += 1;
        chunksReceived += 1;
        this.events.emit("model.stream.chunk", chunk);

        if (chunk.type === "text_delta" && chunk.text !== undefined) {
          text += chunk.text;
        } else if (
          chunk.type === "tool_call_start" &&
          chunk.toolName !== undefined
        ) {
          const index = chunk.toolCallIndex ?? nextImplicitToolCallIndex++;
          builders.set(index, {
            toolName: chunk.toolName,
            argumentsParts: [],
          });
        } else if (
          chunk.type === "tool_call_delta" &&
          chunk.argumentsDelta !== undefined
        ) {
          const index = chunk.toolCallIndex;
          if (index !== undefined) {
            builders.get(index)?.argumentsParts.push(chunk.argumentsDelta);
          }
        } else if (chunk.type === "tool_call_end") {
          const index = chunk.toolCallIndex;
          if (index !== undefined && builders.has(index)) {
            const builder = builders.get(index)!;
            if (chunk.arguments !== undefined) {
              builder.parsedArguments = chunk.arguments;
            }
            await this.tryExecuteStreamedToolEagerly(input.step, builder);
          }
        } else if (chunk.type === "usage") {
          usage = mergeModelUsage(usage, chunk.usage);
        } else if (chunk.type === "stop") {
          stopReason = chunk.stopReason ?? "completed";
        }
      }
    } catch (cause) {
      if (cause instanceof StreamTimeoutError) {
        this.abortController.abort();
        // Diagnostic split: `phase: "pre-first-chunk"` with apiCallCount=0
        // means no chunk was ever observed — the stall is upstream of the
        // model's first token (prompt build, credential resolution, network
        // handshake). `phase: "post-first-chunk"` means the model started
        // responding and then stalled mid-stream. The two failure modes
        // call for very different triage; surfacing them as distinct
        // metadata avoids "timed out, somewhere" log triage.
        this.events.emit("model.stream.timeout", {
          step: input.step,
          timeoutMs: cause.timeoutMs,
          phase: cause.phase,
          apiCallCount: this.apiCallCount,
          chunksReceived,
        });
      } else {
        this.events.emit("model.stream.failed", {
          step: input.step,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
      throw cause;
    } finally {
      await iterator.return?.();
    }

    const output: ModelOutput = {
      message: text || undefined,
      toolCalls: this.materializeToolCalls(builders, input.step),
      usage,
      stopReason,
    };
    // Stream-layer terminal marker only — `output` rides on the following
    // `model.completed` (avoids serializing the full answer twice).
    this.events.emit("model.stream.completed", { step: input.step });
    this.events.emit("model.completed", output);
    return output;
  }

  private materializeToolCalls(
    builders: Map<number, StreamedToolCallBuilder>,
    step: number,
  ): ModelOutput["toolCalls"] {
    if (builders.size === 0) return undefined;

    const toolCalls: RequestedToolCall[] = [];
    for (const builder of builders.values()) {
      if (builder.eagerExecuted) continue;
      if (builder.parsedArguments !== undefined) {
        toolCalls.push({
          toolName: builder.toolName,
          arguments: builder.parsedArguments,
        });
        continue;
      }

      const raw = builder.argumentsParts.join("");
      if (raw === "") {
        // Some models emit `tool_call_start` + `tool_call_end` without any
        // `argumentsDelta` when invoking a zero-argument tool. Treat the
        // empty payload as `{}`; argument schema validation downstream will
        // still reject calls that require parameters.
        toolCalls.push({ toolName: builder.toolName, arguments: {} });
        continue;
      }
      try {
        toolCalls.push({
          toolName: builder.toolName,
          arguments: JSON.parse(raw),
        });
      } catch (cause) {
        const preview = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
        this.events.emit("model.stream.failed", {
          step,
          error:
            cause instanceof Error
              ? cause.message
              : "Failed to parse streamed tool call arguments.",
          metadata: {
            toolName: builder.toolName,
            rawArgumentsPreview: preview,
          },
        });
        throw new Error(
          `Streamed tool call arguments were not valid JSON for ${builder.toolName}.`,
        );
      }
    }
    return toolCalls.length > 0 ? toolCalls : undefined;
  }

  private async tryExecuteStreamedToolEagerly(
    step: number,
    builder: StreamedToolCallBuilder,
  ): Promise<void> {
    if (!this.eagerToolExecution || builder.eagerExecuted) return;

    const tool = this.tools.get(builder.toolName);
    if (!tool) return;

    let args = builder.parsedArguments;
    if (args === undefined) {
      try {
        args = JSON.parse(builder.argumentsParts.join(""));
      } catch {
        return;
      }
      builder.parsedArguments = args;
    }

    if (!isToolConcurrencySafe(tool, args)) return;

    builder.eagerExecuted = true;
    this.eagerToolExecutedInTurn = true;
    // Eager single-tool batch: bracket it in a span so the eager tool call
    // nests under it just like a normal post-turn batch.
    const eagerBatchPayload = {
      step,
      batchIndex: -1,
      mode: "concurrent" as const,
      toolCallCount: 1,
      toolNames: [builder.toolName],
      eager: true,
    };
    await withSpan(
      this.events,
      {
        startType: "tool.batch.requested",
        endType: "tool.batch.completed",
        payload: eagerBatchPayload,
      },
      () =>
        this.processToolCall(step, {
          toolName: builder.toolName,
          arguments: args,
        }),
    );
  }

  private async runToolsAfterTurn(
    step: number,
    toolCalls: RequestedToolCall[],
  ): Promise<RunResult | undefined> {
    const batches = partitionToolCalls(this.tools, toolCalls);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      if (this.abortSignal.aborted) {
        return this.cancel({
          reason: "Tool batch aborted by cancellation.",
          metadata: { step, batchIndex },
        });
      }

      const batch = batches[batchIndex]!;
      // Bracket the batch in a span: the `tool.batch.requested`/`.completed`
      // pair shares a span id and every per-tool call inside `runToolBatch`
      // (including the concurrent fan-out, carried by AsyncLocalStorage) nests
      // beneath it.
      await withSpan(
        this.events,
        {
          startType: "tool.batch.requested",
          endType: "tool.batch.completed",
          payload: toolBatchEventPayload(step, batchIndex, batch),
        },
        () =>
          runToolBatch(
            batch,
            (requestedCall) => this.processToolCall(step, requestedCall),
            { maxConcurrency: this.maxToolConcurrency },
          ),
      );
    }
    return undefined;
  }

  private async processToolCall(
    step: number,
    requestedCall: RequestedToolCall,
  ): Promise<void> {
    const call = createToolCall(
      this.record.id,
      requestedCall.toolName,
      requestedCall.arguments,
    );
    // Open a span for this call: `tool.requested` is the start, the terminal
    // `tool.completed`/`tool.failed` (emitted by `finishToolResult`) the end,
    // and the body runs inside `runWithSpan` so `tool.started` plus the tool's
    // own `workspace.read`/`tool.progress` events inherit this frame and nest
    // under the call — which itself nests under the enclosing batch span.
    const span = openSpan(this.events, {
      startType: "tool.requested",
      payload: call,
    });
    await runWithSpan(span.frame, () =>
      this.runToolCallInSpan(call, requestedCall, span),
    );
  }

  private async runToolCallInSpan(
    call: ReturnType<typeof createToolCall>,
    requestedCall: RequestedToolCall,
    span: ReturnType<typeof openSpan>,
  ): Promise<void> {
    const validationResult = this.validateToolCall(
      call.id,
      requestedCall.toolName,
      requestedCall.arguments,
    );
    if (validationResult) {
      this.finishToolResult(requestedCall.toolName, validationResult, span);
      return;
    }

    const gatedResult = await this.checkToolGate(
      call.id,
      requestedCall.toolName,
    );
    if (gatedResult) {
      this.finishToolResult(requestedCall.toolName, gatedResult, span);
      return;
    }

    if (this.abortSignal.aborted) {
      this.finishToolResult(
        requestedCall.toolName,
        {
          toolCallId: call.id,
          status: "cancelled",
          error: {
            code: "TOOL_ABORTED",
            message: `Tool aborted before execution: ${requestedCall.toolName}`,
          },
          artifacts: [],
        },
        span,
      );
      return;
    }

    emitInSpan(this.events, "tool.started", {
      toolCallId: call.id,
      toolName: call.toolName,
    });
    const result = await this.executeToolCall(
      requestedCall.toolName,
      requestedCall.arguments,
      call.id,
    );
    this.finishToolResult(requestedCall.toolName, result, span);
  }

  private validateToolCall(
    toolCallId: ToolResult["toolCallId"],
    toolName: string,
    args: unknown,
  ): ToolResult | undefined {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        toolCallId,
        status: "failed",
        error: {
          code: "TOOL_NOT_FOUND",
          message: `Tool not found: ${toolName}`,
        },
        artifacts: [],
      };
    }

    const validationError = validateToolArguments(tool.inputSchema, args);
    if (!validationError) return undefined;

    return {
      toolCallId,
      status: "failed",
      error: validationError,
      artifacts: [],
    };
  }

  private async checkToolGate(
    toolCallId: ToolResult["toolCallId"],
    toolName: string,
  ): Promise<ToolResult | undefined> {
    const tool = this.tools.get(toolName);
    if (!tool) return undefined;

    const risk = tool.policy?.risk ?? "safe";
    const metadata = {
      toolName,
      risk,
      governance: tool.governance,
      toolOrigin: tool.governance?.origin,
    };

    if (risk === "denied") {
      return {
        toolCallId,
        status: "failed",
        error: {
          code: "TOOL_DENIED",
          message: `Tool is denied by policy metadata: ${toolName}`,
          metadata,
        },
        artifacts: [],
      };
    }

    const decision = await this.policy.decide({
      action: "tool.execute",
      resource: {
        kind: "tool",
        name: toolName,
        metadata: {
          risk,
          governance: tool.governance,
          toolOrigin: tool.governance?.origin,
        },
      },
      metadata,
    });

    if (decision.decision === "deny") {
      return {
        toolCallId,
        status: "failed",
        error: {
          code: "TOOL_DENIED",
          message: decision.reason,
          metadata: decision.metadata,
        },
        artifacts: [],
      };
    }

    if (
      risk === "risky" ||
      tool.policy?.requiresApproval === true ||
      decision.decision === "requires_approval"
    ) {
      let approved = false;
      try {
        approved = await this.requestApproval({
          action: "tool.execute",
          summary: `Run tool ${toolName}`,
          details: { ...metadata, policy: decision },
        });
      } catch (cause) {
        return {
          toolCallId,
          status: "failed",
          error: {
            code: "APPROVAL_UNAVAILABLE",
            message:
              cause instanceof Error ? cause.message : "Approval failed.",
            cause,
            metadata,
          },
          artifacts: [],
        };
      }

      if (!approved) {
        return {
          toolCallId,
          status: "failed",
          error: {
            code: "TOOL_APPROVAL_DENIED",
            message: `Approval denied for tool: ${toolName}`,
            metadata,
          },
          artifacts: [],
        };
      }
    }

    return undefined;
  }

  private async executeToolCall(
    toolName: string,
    args: unknown,
    toolCallId: ToolResult["toolCallId"],
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        toolCallId,
        status: "failed",
        error: {
          code: "TOOL_NOT_FOUND",
          message: `Tool not found: ${toolName}`,
        },
        artifacts: [],
      };
    }

    try {
      const output = await executeWithTimeout(
        () =>
          tool.execute(args, this.createRuntimeContext(toolCallId, toolName)),
        tool.timeoutMs ?? this.toolTimeoutMs,
        toolName,
        this.abortSignal,
      );
      const outputError = validateToolOutput(tool.outputSchema, output);
      if (outputError) {
        return {
          toolCallId,
          status: "failed",
          error: outputError,
          artifacts: [],
        };
      }
      return {
        toolCallId,
        status: "completed",
        output,
        artifacts: [],
      };
    } catch (cause) {
      if (cause instanceof ToolTimeoutError) {
        return {
          toolCallId,
          status: "failed",
          error: {
            code: "TOOL_TIMEOUT",
            message: cause.message,
            cause,
            metadata: cause.metadata,
          },
          artifacts: [],
        };
      }
      if (isAbortError(cause) || this.abortSignal.aborted) {
        return {
          toolCallId,
          status: "cancelled",
          error: {
            code: "TOOL_ABORTED",
            message: `Tool aborted: ${toolName}`,
            metadata: { toolName },
          },
          artifacts: [],
        };
      }
      return {
        toolCallId,
        status: "failed",
        error: {
          code:
            isRecord(cause) && typeof cause.code === "string"
              ? cause.code
              : "TOOL_EXECUTION_FAILED",
          message:
            cause instanceof Error ? cause.message : "Tool execution failed.",
          cause,
          metadata:
            isRecord(cause) && isRecord(cause.metadata)
              ? cause.metadata
              : undefined,
        },
        artifacts: [],
      };
    }
  }

  private async requestApproval(input: {
    action: string;
    summary: string;
    details?: Record<string, unknown>;
  }): Promise<boolean> {
    if (!this.approvalResolver) {
      throw new Error(
        "Approval requested but no approval resolver was configured.",
      );
    }

    const request = createApprovalRequest({
      runId: this.record.id,
      action: input.action,
      summary: input.summary,
      details: input.details,
    });
    this.setState("waiting_approval");
    this.events.emit("approval.requested", request);
    this.events.emit("interaction.requested", { kind: "approval", request });
    const response = await this.approvalResolver(request);
    this.events.emit("approval.resolved", response);
    this.events.emit("interaction.resolved", { kind: "approval", response });
    this.setState("running");
    return (
      response.approvalId === request.id && response.decision === "approved"
    );
  }

  private createRuntimeContext(
    toolCallId: ToolResult["toolCallId"],
    toolName: string,
  ): RuntimeContext {
    return {
      run: this.record,
      workspace: this.workspace,
      abortSignal: this.abortSignal,
      reportToolProgress: (update) => {
        this.events.emit("tool.progress", {
          toolCallId,
          toolName,
          ...update,
        });
      },
    };
  }

  private finishToolResult(
    toolName: string,
    result: ToolResult,
    span?: ReturnType<typeof openSpan>,
  ): void {
    const terminalType =
      result.status === "completed" ? "tool.completed" : "tool.failed";
    // Close the call span when one is open (so the terminal carries the span's
    // duration); otherwise fall back to a plain emit for any caller that
    // finishes a result outside a span.
    if (span) span.close(terminalType, result);
    else this.events.emit(terminalType, result);
    this.context.push(
      this.observationFormatter.format({
        toolName,
        result,
        run: this.record,
      }),
    );
  }

  private async drainNotificationSources(step: number): Promise<void> {
    if (this.notificationSources.length === 0) return;
    for (let i = 0; i < this.notificationSources.length; i += 1) {
      const source = this.notificationSources[i]!;
      let items: PendingNotification[];
      try {
        items = await source.drain();
      } catch (cause) {
        this.events.emit("run.notification.source_failed", {
          step,
          sourceIndex: i,
          message: errorMessage(cause),
        });
        continue;
      }
      if (items.length === 0) continue;
      for (const item of items) {
        this.context.push({
          id: createContextItemId(),
          type: "user",
          source: item.source ?? { kind: "notification" },
          content: item.content,
          metadata: {
            layer: "working",
            stability: "turn",
            step,
            origin: "notification-source",
            sourceIndex: i,
            ...(item.metadata ?? {}),
          },
        });
      }
      this.events.emit("run.notification.injected", {
        step,
        sourceIndex: i,
        count: items.length,
      });
    }
  }

  private consumePendingCommands(step: number): RunResult | undefined {
    while (this.commandQueue.length > 0) {
      const command = this.commandQueue.shift()!;
      this.events.emit("run.command.applied", {
        commandType: command.type,
        step,
        metadata: command.metadata ?? {},
      });
      if (command.type === "cancel") {
        return this.cancel({
          reason: command.reason,
          metadata: command.metadata,
        });
      }
      this.context.push({
        id: createContextItemId(),
        type: "user",
        source: { kind: "command", uri: "run.command.user_message" },
        content: command.content,
        metadata: {
          layer: "working",
          stability: "turn",
          step,
          ...(command.metadata ?? {}),
        },
      });
    }
    return undefined;
  }

  private complete(
    reason: Extract<RunStopReason, "final_answer">,
    payload: { message?: string },
  ): RunResult {
    this.setState("completed", reason);
    this.events.emit("run.completed", {
      reason,
      ...payload,
    });
    this.result = {
      signal: "completed",
      state: "completed",
      stopReason: reason,
      message: payload.message,
      metadata: omitUndefined(payload),
    };
    return this.result;
  }

  private fail(
    reason: Exclude<RunStopReason, "no_model_configured" | "final_answer">,
    code: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): RunResult {
    this.setState("failed", reason);
    const failure = {
      category: code.startsWith("TOOL")
        ? ("tool" as const)
        : ("model" as const),
      code,
      message,
      metadata: omitUndefined(metadata),
    };
    this.events.emit("run.failed", {
      reason,
      code,
      message,
      failure,
      metadata,
    });
    this.result = {
      signal: "failed",
      state: "failed",
      stopReason: reason,
      failure,
      metadata: omitUndefined(metadata),
    };
    return this.result;
  }

  private setState(state: RunState, stopReason?: RunStopReason): void {
    if (isTerminalState(this.record.state)) return;
    this.record.state = state;
    if (stopReason) this.record.stopReason = stopReason;
    this.record.updatedAt = new Date().toISOString();
  }

  private safeStoreAppend(event: SparkwrightEvent): void {
    if (!this.runStore) return;
    this.storeAppendQueue = this.storeAppendQueue.then(async () => {
      try {
        await this.runStore?.append(event);
      } catch (err) {
        console.warn(
          `[sparkwright/streaming-runtime] runStore.append failed: ${errorMessage(err)}`,
        );
      }
    });
  }

  private async safeStoreFinish(result: RunResult): Promise<void> {
    if (!this.runStore) return;
    try {
      await this.storeAppendQueue;
      await this.runStore.finish(this.record, result);
    } catch (err) {
      console.warn(
        `[sparkwright/streaming-runtime] runStore.finish failed: ${errorMessage(err)}`,
      );
    }
  }
}

type StreamPhase = "pre-first-chunk" | "post-first-chunk";

async function nextStreamChunk(
  iterator: AsyncIterator<ModelOutputChunk>,
  signal: AbortSignal,
  timeoutMs: number | undefined,
  phase: StreamPhase,
): Promise<IteratorResult<ModelOutputChunk>> {
  if (signal.aborted) throw createAbortError();
  if (timeoutMs === undefined) return iterator.next();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new StreamTimeoutError(timeoutMs, phase));
        }, timeoutMs);
      }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(createAbortError());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

class StreamTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly phase: StreamPhase,
  ) {
    super(
      `Model stream timed out after ${timeoutMs}ms (${phase === "pre-first-chunk" ? "no chunk received" : "between chunks"}).`,
    );
    this.name = "StreamTimeoutError";
  }
}

function mergeModelUsage(
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
    costStatus: next.costStatus ?? current?.costStatus,
    costUnavailableReason:
      next.costUnavailableReason ?? current?.costUnavailableReason,
  };
}

function createAbortError(): Error {
  const error = new Error("Streaming run aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  if (cause.name === "AbortError") return true;
  const code = (cause as { code?: string }).code;
  return code === "ABORT_ERR" || code === "ERR_ABORTED";
}

async function executeWithTimeout<TResult>(
  execute: () => Promise<TResult> | TResult,
  timeoutMs: number | undefined,
  toolName: string,
  signal: AbortSignal,
): Promise<TResult> {
  if (signal.aborted) throw createAbortError();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const racers: Array<Promise<TResult>> = [Promise.resolve().then(execute)];
    if (timeoutMs !== undefined) {
      racers.push(
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new ToolTimeoutError(toolName, timeoutMs));
          }, timeoutMs);
        }),
      );
    }
    racers.push(
      new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(createAbortError());
          return;
        }
        onAbort = () => reject(createAbortError());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    );

    return await Promise.race(racers);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

class ToolTimeoutError extends Error {
  readonly metadata: Record<string, unknown>;

  constructor(toolName: string, timeoutMs: number) {
    super(`Tool timed out after ${timeoutMs}ms: ${toolName}`);
    this.name = "ToolTimeoutError";
    this.metadata = { toolName, timeoutMs };
  }
}

function isTerminalState(state: RunState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function validateOptionalPositiveInteger(
  name: string,
  value: number | undefined,
): void {
  if (value !== undefined) validatePositiveInteger(name, value);
}

function omitUndefined(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
