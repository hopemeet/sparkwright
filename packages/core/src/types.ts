// AI maintenance note: Stable v0 data shapes used across packages. Adding a
// required field here is a breaking protocol change; prefer optional fields
// and metadata. Schema files in schemas/ mirror these — update both.

import type {
  AnchoredEditOperation,
  AnchoredText,
  ApplyAnchoredEditsResult,
} from "./anchored-edit.js";
import type {
  ArtifactId,
  ApprovalId,
  ContextItemId,
  RunId,
  ToolCallId,
  WorkspaceWriteId,
} from "./ids.js";
import type { SparkwrightEvent } from "./events.js";
import type {
  ContextLayer,
  ContextStability,
  ModelContextHints,
  PromptMessage,
} from "./context.js";
import type { ToolDescriptor, ToolProgressUpdate } from "./tools.js";

export type RunState =
  | "created"
  | "running"
  | "waiting_approval"
  | "waiting_credentials"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStopReason =
  | "no_model_configured"
  | "final_answer"
  | "max_steps_exceeded"
  | "model_completion_failed"
  | "model_retry_exhausted"
  | "model_auth_failed"
  | "model_quota_exhausted"
  | "model_provider_unavailable"
  | "model_output_invalid"
  | "tool_doom_loop"
  | "max_duration_exceeded"
  | "max_model_calls_exceeded"
  | "max_tool_calls_exceeded"
  | "token_budget_exceeded"
  | "cost_budget_exceeded"
  | "blocking_limit"
  | "validation_failed"
  | "hook_stopped"
  | "stop_hook_prevented"
  | "aborted_streaming"
  | "aborted_tools"
  | "manual_cancelled"
  | "state_transition_invalid";

export type RunResultSignal =
  | "continue"
  | "completed"
  | "failed"
  | "cancelled"
  | "compact";
export type RunFailureCategory =
  | "model"
  | "tool"
  | "approval"
  | "policy"
  | "workspace"
  | "validation"
  | "runtime";

export interface RunFailure {
  category: RunFailureCategory;
  code: string;
  message: string;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RunResult {
  signal: Exclude<RunResultSignal, "continue" | "compact">;
  state: Extract<RunState, "completed" | "failed" | "cancelled">;
  stopReason?: RunStopReason;
  message?: string;
  failure?: RunFailure;
  metadata: Record<string, unknown>;
}

/**
 * Discrete causes that explain why the loop is entering an iteration. Each
 * `continue` branch in the reference loop sets a transition reason so events,
 * traces, and downstream tools can reconstruct the loop's decision history.
 *
 * - `run_started`         — first iteration after `start()`.
 * - `next_turn`           — model produced tool calls and we proceed normally.
 * - `command_injected`    — runtime command (user_message) merged into context.
 * - `validation_continuation` — final-output validation failed with
 *                              `finalOutputValidation: "continue"`.
 * - `stop_hook_blocked`   — a `pre_terminal` stop hook prevented termination
 *                           and the loop must do another turn.
 * - `model_recovery`      — recoverable model error (e.g. context too long,
 *                           output truncated) triggered a recovery step.
 * - `compaction_applied`  — one or more compactors materially shrank context.
 * - `fallback_model`      — primary model failed and the loop switched to a
 *                           configured fallback adapter.
 * - `resumed_from_checkpoint` — first iteration after `resumeRunFromCheckpoint`,
 *                               re-entering the loop with a seeded `RunLoopState`.
 * - `terminal`            — sentinel for terminal transitions (not actually
 *                           used to enter a new iteration; reserved).
 */
export type RunLoopTransitionReason =
  | "run_started"
  | "next_turn"
  | "command_injected"
  | "validation_continuation"
  | "stop_hook_blocked"
  | "model_recovery"
  | "compaction_applied"
  | "fallback_model"
  | "resumed_from_checkpoint"
  | "terminal";

export interface RunLoopTransition {
  reason: RunLoopTransitionReason;
  metadata?: Record<string, unknown>;
}

/**
 * Serializable loop snapshot used by the reference run loop. The state is
 * intentionally plain data so future checkpoint/resume implementations can
 * persist it without depending on class internals.
 */
export interface RunLoopState {
  step: number;
  turnCount: number;
  context: ContextItem[];
  previousToolCall?: {
    toolName: string;
    arguments: unknown;
  };
  repeatedToolCallCount: number;
  transition: RunLoopTransition;
}

/**
 * Serializable run checkpoint intended for durable resume, branch/fork, and
 * AI debugging. The reference loop can expose this shape without promising
 * that every field is resumable in v0; `resumability` records that boundary
 * explicitly for hosts.
 */
export interface RunCheckpointV1 {
  /** @reserved Public checkpoint protocol discriminator consumed by stores. */
  schemaVersion: "run-checkpoint.v1";
  run: RunRecord;
  /** @reserved Public checkpoint payload consumed by resume/fork tooling. */
  loop: RunLoopState;
  model: {
    activeIndex: number;
    activeAdapterId?: string;
    fallbackCount: number;
  };
  /** @reserved Public checkpoint payload consumed by recovery tooling. */
  recovery: {
    outputRecoveriesUsed: number;
    maxOutputRecoveries: number;
  };
  budget: {
    configured?: RunBudget;
    usage: RunBudgetUsage;
  };
  /** @reserved Public checkpoint payload consumed by resume/fork tooling. */
  queues: {
    commandCount: number;
    pendingPrefetch: boolean;
    pendingSummary: boolean;
  };
  /** @reserved Public checkpoint payload consumed by resume/fork tooling. */
  resumability: {
    complete: boolean;
    reasons: string[];
  };
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface RunRecord {
  id: RunId;
  goal: string;
  state: RunState;
  stopReason?: RunStopReason;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface RunBudget {
  maxDurationMs?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface RunBudgetUsage {
  elapsedMs: number;
  modelCalls: number;
  toolCalls: number;
  tokens: number;
  costUsd: number;
}

export type ArtifactType = "text" | "json" | "diff" | "patch" | "file" | "log";

export interface Artifact {
  id: ArtifactId;
  runId: RunId;
  type: ArtifactType;
  name: string;
  path?: string;
  content?: unknown;
  metadata: Record<string, unknown>;
}

export type ContextItemType =
  | "user"
  | "assistant"
  | "system"
  | "file"
  | "tool_result"
  | "summary";

export interface ContextSourceRef {
  kind: string;
  path?: string;
  uri?: string;
}

export interface ContextItemMetadata extends Record<string, unknown> {
  layer?: ContextLayer;
  stability?: ContextStability;
  priority?: number;
  required?: boolean;
  truncated?: boolean;
  originalChars?: number;
  artifactRefs?: Array<{
    id: ArtifactId;
    path?: string;
    summary?: string;
  }>;
}

export interface ContextItem {
  id: ContextItemId;
  type: ContextItemType;
  source?: ContextSourceRef;
  content: string;
  metadata: ContextItemMetadata;
}

export interface ToolCall {
  id: ToolCallId;
  runId: RunId;
  toolName: string;
  arguments: unknown;
}

export interface ToolResult {
  toolCallId: ToolCallId;
  status: "completed" | "failed" | "cancelled";
  output?: unknown;
  error?: SparkwrightError;
  artifacts: Artifact[];
}

export interface SparkwrightError {
  code: string;
  message: string;
  cause?: unknown;
  metadata?: Record<string, unknown>;
}

export type {
  ContextExtension,
  ContextExtensionDescriptor,
  ContextExtensionLoadInput,
  ToolExtension,
} from "./extensions.js";

export interface ModelInput {
  run: RunRecord;
  context: ContextItem[];
  prompt?: PromptMessage[];
  tools: ToolDescriptor[];
  events: SparkwrightEvent[];
  step: number;
  /**
   * Optional run-scoped abort signal. Provider adapters that honor this can
   * terminate streaming early when the embedder cancels the run. Adapters
   * which do not consult the signal will still be interrupted at the loop
   * boundary, but in-flight HTTP requests will continue until they finish.
   */
  abortSignal?: AbortSignal;
  /**
   * Hint to the model for the maximum output tokens this turn. The reference
   * loop bumps this when recovering from a `max_output_tokens` truncation.
   * Adapters that ignore this field fall back to their configured default.
   *
   * @reserved Public provider-adapter hint consumed by streaming adapters
   *           and the `extend_output` recovery path.
   */
  maxOutputTokens?: number;
}

export interface ModelOutput {
  message?: string;
  toolCalls?: Array<{
    toolName: string;
    arguments: unknown;
  }>;
  usage?: ModelUsage;
  /**
   * Run-loop generated diagnostics for trace viewers and telemetry sinks.
   * Providers may omit this; the reference loop fills it before emitting
   * `model.completed`.
   */
  trace?: ModelOutputTrace;
  /**
   * Provider-reported stop signal. The loop uses this to detect output
   * truncation (`max_output_tokens`) and run the continuation recovery path.
   */
  stopReason?:
    | "completed"
    | "max_output_tokens"
    | "stop_sequence"
    | "tool_use"
    | "content_filter"
    | "error"
    | "unknown";
}

/**
 * Recovery hint that providers can attach to thrown errors. The loop reads
 * `(error as { recoveryHint?: ModelRecoveryHint }).recoveryHint` to decide
 * whether to compact context, extend output, switch to a fallback model, or
 * propagate the failure.
 */
export type ModelRecoveryHint =
  | "reduce_input"
  | "extend_output"
  | "fallback_model";

export type ModelErrorCategory =
  | "context_overflow"
  | "output_truncated"
  | "rate_limited"
  | "auth"
  | "quota"
  | "provider_unavailable"
  | "invalid_request"
  | "content_filter"
  | "network"
  | "unknown";

/**
 * Provider-neutral model error description. Model adapters may throw native
 * errors, but loop code and embedders should converge on this envelope for
 * retry/recovery decisions and stable trace payloads.
 */
export interface ModelErrorEnvelope {
  category: ModelErrorCategory;
  message: string;
  code?: string;
  providerCode?: string;
  status?: number;
  retryable: boolean;
  recoveryHint?: ModelRecoveryHint;
  /**
   * Provider-requested cool-down before the next attempt, in milliseconds.
   * Normalized from an HTTP `Retry-After` header (seconds or HTTP-date) or a
   * `retryAfterMs` / `retryAfter` field on the raw error. When present and the
   * retry policy has `respectRetryAfter` enabled, the run loop waits at least
   * this long instead of its computed exponential backoff.
   * @reserved Public model-error field consumed by retry controllers.
   */
  retryAfterMs?: number;
  /** @reserved Public model-error field consumed by streaming UIs. */
  withholdOutput?: boolean;
  /** @reserved Public model-error field consumed by retry controllers. */
  safeToRetrySamePrompt?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Provider-reported prompt-cache read tokens, when available. */
  cacheReadTokens?: number;
  /** Provider-reported prompt-cache creation/write tokens, when available. */
  cacheCreationTokens?: number;
  costUsd?: number;
}

/**
 * Per-million-token USD pricing for a model. All fields are optional so callers
 * can supply only the dimensions a provider charges for. Consumed by adapters
 * (and any custom UsageTracker integration) to convert `ModelUsage` token
 * counts into `costUsd`.
 */
export interface ModelPricing {
  inputPerMTokUsd?: number;
  outputPerMTokUsd?: number;
  cacheReadPerMTokUsd?: number;
  cacheCreationPerMTokUsd?: number;
}

export interface ModelOutputTrace {
  attempt: number;
  maxAttempts: number;
  /** @reserved Public retry telemetry field consumed by trace viewers. */
  retryCount: number;
  adapterId?: string;
  streaming: boolean;
  durationMs: number;
  /** Time to first streamed chunk. Only present for streaming adapters. */
  ttftMs?: number;
  /**
   * Alias for total model-call wall time, useful for timeline consumers.
   * @reserved Public latency telemetry field consumed by timeline UIs.
   */
  ttltMs: number;
  /** @reserved Public timestamp consumed by model-call trace viewers. */
  requestStartedAt: string;
  /** @reserved Public timestamp consumed by model-call trace viewers. */
  requestCompletedAt: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheHitRatePct?: number;
  inputTokensPerSecond?: number;
  outputTokensPerSecond?: number;
  /** @reserved Public output-size telemetry field consumed by trace viewers. */
  messageChars?: number;
  /** @reserved Public tool-call telemetry field consumed by trace viewers. */
  toolCallCount: number;
}

export interface ModelRetryPolicy {
  /** Total number of attempts (initial call + retries). Default 3. */
  maxAttempts?: number;
  /**
   * Base delay before the FIRST retry, in milliseconds. Subsequent retries
   * grow this geometrically by `backoffMultiplier`, capped at `maxDelayMs`.
   * Set to `0` to retry immediately (legacy behavior). Default 500.
   */
  initialDelayMs?: number;
  /** Upper bound on any single backoff delay, in milliseconds. Default 30_000. */
  maxDelayMs?: number;
  /** Geometric growth factor applied between attempts. Default 2. */
  backoffMultiplier?: number;
  /**
   * Jitter strategy applied to each computed delay to avoid thundering-herd
   * retries across concurrent runs:
   *  - `"full"`: sample uniformly from `[0, computedDelay]` (default)
   *  - `"none"`: use the computed delay verbatim
   */
  jitter?: "full" | "none";
  /**
   * When `true` (default), a provider-supplied `Retry-After`
   * ({@link ModelErrorEnvelope.retryAfterMs}) overrides the computed backoff
   * for that attempt — the loop waits the larger of the two so we never retry
   * sooner than the provider asked.
   */
  respectRetryAfter?: boolean;
}

export interface ModelOutputChunk {
  type:
    | "text_delta"
    | "tool_call_start"
    | "tool_call_delta"
    | "tool_call_end"
    | "usage"
    | "stop";
  text?: string; // for text_delta
  toolName?: string; // for tool_call_start
  toolCallIndex?: number; // for tool_call_start/delta/end
  argumentsDelta?: string; // for tool_call_delta (partial JSON string)
  usage?: ModelUsage; // for usage chunk
  /**
   * For `tool_call_end`: optional fully-parsed arguments object the provider
   * has already validated. When present the loop skips re-parsing the
   * concatenated delta string and may dispatch the tool eagerly mid-stream.
   */
  arguments?: unknown;
  /**
   * For `stop` chunks: matches `ModelOutput.stopReason`. Allows providers to
   * signal `max_output_tokens` truncation while streaming.
   */
  stopReason?: ModelOutput["stopReason"];
}

export interface ModelAdapter {
  contextHints?: ModelContextHints;
  complete(input: ModelInput): Promise<ModelOutput>;
  stream?(input: ModelInput): AsyncIterable<ModelOutputChunk>;
}

export type RunCommand =
  | {
      type: "user_message";
      content: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "cancel";
      reason?: string;
      metadata?: Record<string, unknown>;
    };

export type RunStreamItem =
  | SparkwrightEvent
  | {
      type: "run.result";
      runId: RunId;
      result: RunResult;
    };

export interface RuntimeContext {
  run: RunRecord;
  workspace?: WorkspaceRuntime;
  /**
   * Run-scoped abort signal. Tools that perform I/O SHOULD wire this into
   * their underlying request (fetch, child_process, etc.) so that `cancel()`
   * on the run is observed mid-execution. Tools which ignore the signal will
   * still be interrupted at the loop boundary.
   */
  abortSignal?: AbortSignal;
  /**
   * Optional progress channel for long-running tools. The reference run loop
   * wires this to `tool.progress` events; embedders that execute tools outside
   * a run may omit it.
   *
   * @reserved Public runtime-context helper consumed by long-running tools.
   */
  reportToolProgress?(update: ToolProgressUpdate): void;
  /**
   * Tools that intentionally skip a workspace mutation (because the desired
   * state is already present, etc.) SHOULD call this so the run trace
   * distinguishes "no write attempted" from "write attempted and applied".
   * Emits `workspace.write.skipped` on the run event log.
   *
   * @reserved Public runtime-context helper consumed by idempotent edit tools.
   */
  reportWorkspaceWriteSkipped?(payload: {
    path: string;
    reason?: string;
  }): void;
  /**
   * Tools that receive artifacts from helper APIs can attach them to the
   * current tool result so traces and later context preserve the mutation
   * evidence chain.
   *
   * @reserved Public runtime-context helper consumed by artifact-producing tools.
   */
  reportToolArtifact?(artifact: Artifact): void;
}

export interface WorkspaceRuntime {
  readText(path: string): Promise<string>;
  canonicalPath?(path: string): Promise<string> | string;
  readAnchoredText(path: string): Promise<AnchoredText>;
  editAnchoredText(
    path: string,
    edits: AnchoredEditOperation[],
    options?: { reason?: string },
  ): Promise<ApplyAnchoredEditsResult & { write?: WorkspaceWriteResult }>;
  writeText(
    path: string,
    content: string,
    options?: { reason?: string },
  ): Promise<WorkspaceWriteResult | void>;
  diffText(path: string, nextContent: string): Promise<string>;
}

export interface WorkspaceWriteResult {
  /** @reserved Public write-result field consumed by tool outputs and traces. */
  proposalId: WorkspaceWriteId;
  path: string;
  diffArtifactId?: ArtifactId;
  diffArtifact?: Artifact;
  summary: {
    lineCount: number;
    lastLines: string[];
  };
}

export interface WorkspaceWriteProposal {
  id: WorkspaceWriteId;
  runId: RunId;
  path: string;
  content: string;
  diff: string;
  reason?: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: ApprovalId;
  runId: RunId;
  action: string;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
  status: "pending" | "approved" | "denied" | "expired";
}

export interface ApprovalResponse {
  approvalId: ApprovalId;
  decision: "approved" | "denied";
  message?: string;
}
