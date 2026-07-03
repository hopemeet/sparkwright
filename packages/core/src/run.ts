// =============================================================================
// AI maintenance note
//
// `run.ts` owns the reference run loop. Most extension work should NOT happen
// here — prefer the dedicated seams:
//
//   * Tools          → tools.ts                 (defineTool, ToolRegistry)
//   * Policy         → policy.ts                (createLayeredPolicy)
//   * Approval       → approval.ts              (ApprovalResolver)
//   * Interaction    → interaction.ts           (InteractionChannel)
//   * Hooks          → hooks.ts                 (RunHook)
//   * Usage / cost   → usage.ts                 (UsageTracker)
//   * Context shape  → context.ts, pipeline.ts  (ContextAssembler, Compactor)
//   * Sub-agents     → docs/EXTENSION_INTERFACES.md "Sub-agents"
//
// When you do edit this file, keep the loop body in `runLoop()` thin and add
// phase helpers below it. The class shape is internal (@internal); the
// stable surface is the `createRun` factory plus the `RunHandle` interface.
// =============================================================================

import { isDeepStrictEqual } from "node:util";
import { createContextItemId, createRunId, createSpanId } from "./ids.js";
import {
  emitInSpan,
  openSpan,
  runWithSpan,
  withSpan,
  type SpanFrame,
} from "./spans.js";
import {
  createApprovalRequest,
  type ApprovalResolver,
  resolveApproval,
} from "./approval.js";
import {
  approvalResolverFromChannel,
  createInteractionNotification,
  createInteractionQuestionRequest,
  type InteractionChannel,
  type InteractionNotification,
  type InteractionNotificationLevel,
  type InteractionQuestionRequest,
  type InteractionQuestionResponse,
} from "./interaction.js";
import {
  createDynamicHookSet,
  type RunHook,
  type ToolCallHookDecision,
} from "./hooks.js";
import {
  runWorkflowHooks,
  type WorkflowHook,
  type WorkflowHookAdvance,
  type WorkflowHookBlock,
  type WorkflowHookExecution,
  type WorkflowHookName,
} from "./workflow-hooks.js";
import { createUsageTracker, type UsageTracker } from "./usage.js";
import {
  DefaultContextAssembler,
  DefaultObservationFormatter,
  DefaultPromptBuilder,
  compilePromptCacheBlocks,
  type ContextAssembler,
  type ContextBudget,
  type ContentPart,
  type ContextUsageHint,
  type ObservationFormatter,
  type PromptBuilder,
  type PromptMessage,
} from "./context.js";
import { EventLog, type SparkwrightEvent } from "./events.js";
import {
  createCompactionPipeline,
  createDefaultCompactionStages,
  createPendingSummary,
  startPrefetch,
  type CompactionStage,
  type ContextPrefetcher,
  type ObservationSummarizer,
} from "./pipeline.js";
import {
  createDefaultPolicy,
  type Policy,
  type PolicyDecision,
  type PolicyResource,
} from "./policy.js";
import type { RunStore } from "./storage.js";
import {
  toolBatchEventPayload,
  partitionToolCalls,
  runToolBatch,
  type ToolCallBatch,
  type RequestedToolCall,
} from "./tool-orchestration.js";
import {
  classifyToolFailure,
  commandOutcomeSnapshot,
  completedRunOutcomeFromEvents,
  stableRefTarget,
  toolOutcomeSnapshot,
  type ToolFailureCategory,
} from "./run-outcome.js";
import { ControlledWorkspace } from "./workspace.js";
import type { WorkspaceCheckpointStore } from "./workspace-checkpoint.js";
import {
  createToolCall,
  executeTool,
  formatToolRequestPreview,
  normalizeToolError,
  ToolRegistry,
  validateToolArguments,
  type ToolDefinition,
  type ToolDescriptor,
} from "./tools.js";
import {
  kickPostSamplingHooks,
  runValidationHooks,
  validationFailureMessage,
  type ValidationFailure,
  type ValidationHook,
} from "./validation.js";
import type {
  ContextItem,
  ModelAdapter,
  ModelInput,
  ModelOutput,
  ModelRecoveryHint,
  ModelRetryPolicy,
  NotificationSource,
  PendingNotification,
  RunBudget,
  RunBudgetUsage,
  RunCheckpointV1,
  RunCommand,
  RunRecord,
  RunFailureCategory,
  RunLoopState,
  RunLoopTransition,
  RunResult,
  RunStreamItem,
  RunState,
  RunStopReason,
  RuntimeContext,
  TaskRevivalSource,
  ToolResult,
  ModelErrorEnvelope,
} from "./types.js";
import { getStringProperty, isRecord, omitUndefined } from "./record-utils.js";
import {
  ModelCompletionFailure,
  extractRecoveryHint,
  isLikelySideEffectFailure,
  isRetryableModelFailure,
  normalizeModelError,
  toModelFailure,
} from "./run-model-errors.js";
import {
  buildModelOutputTrace,
  countOmissionReasons,
  mergeModelUsage,
  type StreamTraceTiming,
} from "./run-trace-build.js";
import {
  selectModelFailureStopReason,
  validateModelOutput,
  validateRunBudget,
} from "./run-validation.js";
import { RunHealthAnalyzer, type RunHealthFeedback } from "./run-health.js";

const DEFAULT_DOOM_LOOP_TOOL_CALL_REPEAT_LIMIT = 3;
const DEFAULT_MODEL_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_MODEL_RETRY_INITIAL_DELAY_MS = 500;
const DEFAULT_MODEL_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_MODEL_RETRY_BACKOFF_MULTIPLIER = 2;
const DEFAULT_MODEL_RETRY_JITTER: "full" | "none" = "full";
const DEFAULT_MODEL_RETRY_RESPECT_RETRY_AFTER = true;
const DEFAULT_MAX_REVIVAL_TURNS = 5;
const FAILURE_CAUSE_RESPONSE_BODY_PREVIEW_CHARS = 2_000;

interface ToolStageTimings {
  schemaValidationMs?: number;
  inputValidationMs?: number;
  policyForArgsMs?: number;
  policyDecisionMs?: number;
  approvalWaitMs?: number;
  executionMs?: number;
  resultValidationMs?: number;
}

interface DeferredToolObservation {
  originalIndex: number;
  sequence: number;
  toolName: string;
  result: ToolResult;
}

interface ToolResultRecordingOptions {
  appendContext?: boolean;
  batchResults?: ToolResult[];
  deferredObservations?: DeferredToolObservation[];
  loadedDeferredToolsAtTurnStart?: ReadonlySet<string>;
  originalIndex?: number;
}

export interface CreateRunOptions {
  goal: string;
  /**
   * Primary model adapter. If `models` is supplied, this becomes the first
   * element of the fallback chain and `model` is treated as the head.
   */
  model?: ModelAdapter;
  /**
   * Optional fallback chain (head-first). When the active model throws a
   * recoverable error with `recoveryHint: 'fallback_model'` (or exhausts its
   * retry budget), the loop advances to the next adapter and re-runs the
   * same step. The current adapter id is exposed via `model.requested`
   * events for downstream tracing.
   */
  models?: ModelAdapter[];
  modelRetry?: ModelRetryPolicy;
  /**
   * Optional low-level loop services. This is the dependency-injection seam
   * for tests and advanced embedders that need to replace model calling,
   * clocks, or ids without forking the reference loop.
   */
  loopServices?: RunLoopServices;
  tools?: ToolDefinition[];
  policy?: Policy;
  approvalResolver?: ApprovalResolver;
  /**
   * Unified outbound channel for approve / ask / notify. When provided, the
   * loop uses `interactionChannel.approve` as the approval resolver (taking
   * precedence over `approvalResolver` for that one capability) and exposes
   * `RunHandle.askUser()` / `RunHandle.notifyUser()` for tools and hooks.
   * See {@link InteractionChannel}.
   */
  interactionChannel?: InteractionChannel;
  /**
   * Low-level lifecycle middleware for embedders and instrumentation. Hooks
   * observe model/tool/event boundaries and may skip a tool call via
   * `beforeToolCall` returning `{ skip: { reason } }`. Hook errors never break
   * the run; they emit a `hook.failed` event. Project-facing rules should
   * prefer `workflowHooks` / `capabilities.hooks.workflow`.
   * See {@link RunHook}.
   */
  hooks?: RunHook[];
  /**
   * Deterministic lifecycle hooks over the standard agent workflow. These are
   * higher-level than RunHook and are intended for rules that must happen at
   * known lifecycle points (tool gates, post-tool checks, stop gates, runtime
   * signals). This is the preferred surface for project-facing workflow
   * policy. Legacy `hooks` and `validationHooks` remain supported for
   * embedders and compatibility.
   */
  workflowHooks?: WorkflowHook[];
  /**
   * Custom usage tracker. When omitted, an in-memory tracker is created and
   * fed automatically by the loop. Embedders that want their own aggregation
   * (billing, dashboards) can supply a tracker that fans out to their store.
   */
  usageTracker?: UsageTracker;
  workspace?: RuntimeContext["workspace"];
  /**
   * Optional transparent workspace checkpoint store. When provided, file writes
   * capture pre-images so a turn's edits can be rolled back. Invisible to the
   * model; open a checkpoint per turn via {@link WorkspaceCheckpointStore}.
   */
  workspaceCheckpointStore?: WorkspaceCheckpointStore;
  context?: ContextItem[];
  contextAssembler?: ContextAssembler;
  contextBudget?: ContextBudget;
  /**
   * Optional compaction stages run BEFORE each model call. Stages apply in
   * order; each stage may shrink context further. The loop also re-invokes
   * the pipeline reactively when the model reports `recoveryHint:
   * 'reduce_input'`. See {@link CompactionStage}.
   *
   * Defaults to {@link createDefaultCompactionStages} (deterministic,
   * self-gating, no LLM) when omitted. Pass `[]` to disable compaction.
   */
  compactionStages?: CompactionStage[];
  /**
   * Optional prefetchers (Skills, Memory, MCP resources, ...). Fired before
   * the model call so I/O overlaps the LLM round-trip; results are merged
   * into the NEXT turn's context. Errors are swallowed and logged.
   */
  prefetchers?: ContextPrefetcher[];
  /**
   * Optional async summarizer over each completed tool batch. The summary is
   * awaited just before the next model call and injected as a `summary`
   * ContextItem alongside the verbose tool_result observations.
   */
  observationSummarizer?: ObservationSummarizer;
  observationFormatter?: ObservationFormatter;
  promptBuilder?: PromptBuilder<PromptMessage[]>;
  validationHooks?: ValidationHook[];
  runBudget?: RunBudget;
  maxSteps?: number;
  toolTimeoutMs?: number;
  maxToolConcurrency?: number;
  doomLoopRepeatLimit?: number;
  finalOutputValidation?: "fail" | "continue";
  /**
   * Maximum number of `extend_output` recoveries the loop will attempt per
   * run. Default 3.
   */
  maxOutputRecoveries?: number;
  /**
   * Maximum number of awaited-task revival turns. These turns are budgeted
   * separately from maxSteps so a legitimate slow task completion can still be
   * injected after the normal step budget is otherwise spent. Default 5.
   */
  maxRevivalTurns?: number;
  /**
   * Out-of-band notifications drained at the start of each model step and
   * injected into working context through `run.notification.injected`.
   */
  notificationSources?: NotificationSource[];
  /**
   * Non-consuming awaited-task readiness source. When supplied, the loop can
   * stay inside the same run while awaited background work is pending, then
   * re-enter a normal step where `notificationSources` performs the sole drain.
   */
  taskRevivalSource?: TaskRevivalSource;
  /**
   * Optional externally owned abort signal. When it fires the run cancels
   * with `manual_cancelled`. Independent of internal `cancel()` plumbing.
   */
  abortSignal?: AbortSignal;
  metadata?: Record<string, unknown>;
  /**
   * Optional persistent run store. When provided, the run will:
   *  - call `runStore.append(event)` for every event emitted during the run
   *    (including events that were already buffered before the store was wired)
   *  - call `runStore.finish(record, result)` once the run terminates
   * Errors thrown by the store are caught and surfaced via `console.warn`
   * (non-fatal) so storage failure cannot break the run.
   *
   * May be either a ready `RunStore` instance or a factory that receives the
   * freshly-minted `RunRecord` (useful for stores like `FileRunStore` that
   * derive their path from `run.id`).
   */
  runStore?: RunStore | ((run: RunRecord) => RunStore);
  /**
   * Optional resolver invoked when the model fails with an auth or quota
   * error. The run transitions to `waiting_credentials` (non-terminal) while
   * the resolver runs; if it reports `refreshed: true`, the same step is
   * retried with the (presumably new) provider configuration. If absent, or
   * if the resolver returns `refreshed: false`, the run fails with the
   * corresponding P1 stop reason (`model_auth_failed` / `model_quota_exhausted`).
   *
   * Typical host wiring: prompt the user for a new API key, or wait for a
   * billing webhook indicating quota refill, then mutate the underlying
   * model adapter's credentials and return `{ refreshed: true }`.
   */
  credentialResolver?: CredentialResolver;
  /**
   * When set to N ≥ 1, the loop calls {@link RunHandle.persistCheckpoint}
   * roughly every N steps (and once just before the first model call).
   * The configured `RunStore` decides what "persist" means — `FileRunStore`
   * atomically writes `<runDir>/checkpoint.json`; stores without
   * `saveCheckpoint` no-op the persistence and still return the snapshot.
   *
   * Set to `undefined` (default) or `0` to disable. Hosts that want a more
   * sophisticated schedule (e.g. checkpoint after every successful tool
   * batch, or on a wall-clock timer) should leave this disabled and call
   * `persistCheckpoint()` directly from a `RunHook`.
   */
  autoCheckpointEveryNSteps?: number;
  /**
   * Reserved internal seed used by {@link resumeRunFromCheckpoint}. When
   * supplied, the run's identity, accumulated budget usage, model fallback
   * cursor, output-recovery counter, and initial loop state are seeded from
   * the checkpoint instead of being freshly initialized.
   *
   * Direct callers should prefer `resumeRunFromCheckpoint(checkpoint, options)`
   * — it validates the checkpoint's `resumability` flag and emits the right
   * `run.resumed` evidence event.
   *
   * @internal
   */
  seedFromCheckpoint?: RunCheckpointV1;
}

export interface RunLoopModelCallInput {
  run: RunRecord;
  step: number;
  adapter: ModelAdapter;
  input: ModelInput;
  useStream: boolean;
  completeStream(
    adapter: ModelAdapter,
    input: ModelInput,
  ): Promise<ModelOutput>;
}

export interface CredentialRefreshRequest {
  category: "auth" | "quota";
  /** Underlying error message from the provider, suitable for showing to users. */
  message: string;
  /**
   * Normalized model error envelope for richer host UX (e.g. show provider code).
   * @reserved Public credential-refresh field consumed by host UIs.
   */
  modelError: ModelErrorEnvelope;
  /** 1-based attempt count for this refresh prompt within the current step. */
  attempt: number;
}

export interface CredentialRefreshResponse {
  /**
   * `true` if the credentials were updated and the loop should retry the same
   * step. `false` (or rejection) lets the run fail through the normal
   * stop-reason path.
   */
  refreshed: boolean;
  /** Opaque diagnostic info echoed into the `run.credentials_refreshed` event. */
  metadata?: Record<string, unknown>;
}

export type CredentialResolver = (
  request: CredentialRefreshRequest,
) => Promise<CredentialRefreshResponse> | CredentialRefreshResponse;

export interface RunLoopServices {
  now?: () => Date;
  createRunId?: typeof createRunId;
  createContextItemId?: typeof createContextItemId;
  callModel?(input: RunLoopModelCallInput): Promise<ModelOutput>;
}

export interface RunHandle {
  readonly record: RunRecord;
  readonly events: EventLog;
  readonly tools: ToolRegistry;
  /** Effective model-turn ceiling for this run. Child runs inherit it by default. */
  readonly maxSteps: number;
  /**
   * Run-scoped abort signal. Fires when `cancel()` is called or when the
   * external `CreateRunOptions.abortSignal` aborts. Embedders can wire this
   * into their own teardown (e.g. closing SSE connections to a UI).
   */
  readonly abortSignal: AbortSignal;
  start(): Promise<RunResult>;
  stream(): AsyncIterable<RunStreamItem>;
  cancel(input?: {
    reason?: string;
    metadata?: Record<string, unknown>;
  }): RunResult;
  enqueueCommand(command: RunCommand): void;
  /**
   * @reserved Public run-control helper consumed by embedders and frontends.
   */
  injectUserMessage(input: {
    content: string;
    parts?: ContentPart[];
    metadata?: Record<string, unknown>;
  }): void;
  requestApproval(input: {
    action: string;
    summary: string;
    details?: Record<string, unknown>;
  }): Promise<boolean>;
  /**
   * Ask the user a free-form or multiple-choice question via the configured
   * InteractionChannel. Resolves with `undefined` when no channel is wired
   * or the channel cannot ask.
   */
  askUser(input: {
    prompt: string;
    choices?: InteractionQuestionRequest["choices"];
    defaultChoiceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<InteractionQuestionResponse | undefined>;
  /**
   * Fire-and-forget notification to the user via the configured
   * InteractionChannel. No-ops when no channel is wired.
   */
  notifyUser(input: {
    level: InteractionNotificationLevel;
    message: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  /** Current usage snapshot (tokens / cost / wall time / per-tool / per-model). */
  usage(): ReturnType<UsageTracker["snapshot"]>;
  /**
   * The run's live {@link UsageTracker}. Exposed so an orchestrator spawning a
   * sub-agent can pass it as `parentUsageTracker`, folding the child's
   * tool/model usage into this run's `usage()` snapshot (and `usage.updated`
   * stream). Mutating it outside the rollup path is unsupported.
   *
   * @reserved Public sub-agent-protocol accessor consumed by spawn helpers.
   */
  getUsageTracker(): UsageTracker;
  /**
   * The run's {@link RuntimeContext} workspace, if one was configured. Exposed
   * so an orchestrator spawning a sub-agent can inherit it as the child's
   * workspace — otherwise the child's `ctx.workspace` is undefined and any
   * workspace-backed tool (e.g. `read_file`) throws "Workspace is not
   * configured", even when factory-bound tools like `glob` still work.
   *
   * @reserved Public sub-agent-protocol accessor consumed by spawn helpers.
   */
  getWorkspace(): RuntimeContext["workspace"] | undefined;
  /**
   * Serializable best-effort snapshot for debugging, branch/fork, and resume.
   *
   * @reserved Public run-control helper consumed by stores and frontends.
   */
  checkpoint(metadata?: Record<string, unknown>): RunCheckpointV1;
  /**
   * Snapshot the run via {@link checkpoint} and, if the wired `RunStore`
   * supports it (e.g. `FileRunStore.saveCheckpoint`), atomically persist the
   * snapshot to disk. Returns the checkpoint regardless. No-op persistence
   * when the store doesn't implement `saveCheckpoint`.
   *
   * Hosts typically call this on a timer or after meaningful loop transitions
   * so that a hard crash (process kill, OOM, network drop) leaves a
   * resumable snapshot for `resumeRunFromCheckpoint`.
   */
  persistCheckpoint(metadata?: Record<string, unknown>): RunCheckpointV1;
  checkPolicy(
    action: string,
    metadata?: Record<string, unknown>,
    resource?: PolicyResource,
  ): Promise<PolicyDecision> | PolicyDecision;
  /**
   * Register a {@link RunHook} after the run has been created. Useful for
   * skill / plugin code that wants to react to lifecycle events without
   * being wired at `createRun` time. Past events are replayed to the new
   * hook's `onEvent` synchronously (matching the constructor-time seed
   * semantics) so a late-attached observer still sees `run.created`.
   *
   * Returns the hook's id — pass it to {@link removeHook} to unregister.
   * If the hook supplied an `id`, it is honored; otherwise a fresh id is
   * synthesized. Re-adding a hook with an id already present throws.
   */
  addHook(hook: RunHook): string;
  /**
   * Unregister a hook previously added via {@link addHook} or seeded via
   * `CreateRunOptions.hooks`. Returns true if a hook with that id was
   * removed, false otherwise. Safe to call from inside a hook callback —
   * the combined wrapper re-reads the hook list on every phase.
   */
  removeHook(id: string): boolean;
}

/**
 * @internal Reference implementation. Public API is the `createRun` factory.
 * Class shape may change before 1.0. Import via `@sparkwright/core/internal`.
 */
export class SparkwrightRun implements RunHandle {
  readonly record: RunRecord;
  readonly events: EventLog;
  readonly tools = new ToolRegistry();
  private readonly policy: Policy;
  private readonly approvalResolver?: ApprovalResolver;
  private readonly interactionChannel?: InteractionChannel;
  private readonly hook: RunHook;
  /**
   * Live hook list backing `this.hook`. The combined wrapper reads this on
   * every phase so `addHook` / `removeHook` take effect mid-run without
   * rebinding. Hooks supplied via `CreateRunOptions.hooks` are seeded here.
   */
  private readonly dynamicHooks: RunHook[] = [];
  private dynamicHookCounter = 0;
  private readonly loopServices: RunLoopServices;
  private readonly usageTracker: UsageTracker;
  private readonly models: ModelAdapter[];
  private activeModelIndex = 0;
  private readonly modelRetry: Required<ModelRetryPolicy>;
  private readonly workspace?: RuntimeContext["workspace"];
  private readonly runtimeWorkspace?: RuntimeContext["workspace"];
  private context: ContextItem[];
  private readonly contextAssembler: ContextAssembler;
  private readonly contextBudget?: ContextBudget;
  private readonly observationFormatter: ObservationFormatter;
  private readonly promptBuilder: PromptBuilder<PromptMessage[]>;
  private readonly validationHooks: ValidationHook[];
  private readonly workflowHooks: WorkflowHook[];
  private readonly runHealth = new RunHealthAnalyzer();
  private readonly compactionPipeline?: ReturnType<
    typeof createCompactionPipeline
  >;
  private readonly prefetchers: ContextPrefetcher[];
  private readonly observationSummarizer?: ObservationSummarizer;
  private readonly runBudget?: RunBudget;
  readonly maxSteps: number;
  private readonly toolTimeoutMs?: number;
  private readonly maxToolConcurrency: number;
  private readonly doomLoopRepeatLimit: number;
  private readonly finalOutputValidation: "fail" | "continue";
  private readonly maxOutputRecoveries: number;
  private outputRecoveriesUsed = 0;
  private readonly maxRevivalTurns: number;
  private revivalTurnsUsed = 0;
  private readonly commandQueue: RunCommand[] = [];
  private readonly notificationSources: NotificationSource[];
  private readonly taskRevivalSource?: TaskRevivalSource;
  private readonly loadedDeferredTools = new Set<string>();
  private startedAtMs?: number;
  private readonly budgetUsage: Omit<RunBudgetUsage, "elapsedMs"> = {
    modelCalls: 0,
    toolCalls: 0,
    tokens: 0,
    costUsd: 0,
  };
  private result?: RunResult;
  private readonly runStore?: RunStore;
  private storeAppendQueue: Promise<void> = Promise.resolve();
  private readonly abortController = new AbortController();
  private readonly externalAbortSignal?: AbortSignal;
  /** Pending summary for the most recently completed tool batch. */
  private pendingSummary?: Promise<ContextItem | undefined>;
  /** Pending prefetch kicked off at the start of the current iteration. */
  private pendingPrefetch?: Promise<ContextItem[]>;
  private lastStreamTraceTiming?: StreamTraceTiming;
  /**
   * Most recent model call's reported input-token count. Feeds the cost-aware
   * `ContextUsageHint.contextWindowPressure` so compaction stages can react to
   * real window fill rather than char heuristics. Updated in recordModelUsage.
   */
  private lastModelInputTokens?: number;
  private lastLoopState?: RunLoopState;
  private readonly credentialResolver?: CredentialResolver;
  private readonly autoCheckpointEveryNSteps?: number;
  private lastAutoCheckpointStep = 0;
  private seedLoopState?: RunLoopState;
  private resumedFromCheckpoint?: {
    createdAt: string;
    metadata: Record<string, unknown>;
  };

  constructor(options: CreateRunOptions) {
    this.loopServices = options.loopServices ?? {};
    const now = this.nowIso();
    const checkpoint = options.seedFromCheckpoint;
    this.record = checkpoint
      ? {
          // Preserve identity across resume so on-disk trace / session
          // membership / replay tooling continues to point at the same run.
          id: checkpoint.run.id,
          goal: options.goal,
          state: "created",
          createdAt: checkpoint.run.createdAt,
          updatedAt: now,
          metadata: {
            ...checkpoint.run.metadata,
            ...(options.metadata ?? {}),
            resumedFromCheckpointAt: checkpoint.createdAt,
          },
        }
      : {
          id: (this.loopServices.createRunId ?? createRunId)(),
          goal: options.goal,
          state: "created",
          createdAt: now,
          updatedAt: now,
          metadata: options.metadata ?? {},
        };
    this.events = new EventLog(this.record.id, {
      sequence: checkpoint?.eventSequence,
    });
    this.events.subscribe((event) => this.runHealth.observeEvent(event));
    this.policy = options.policy ?? createDefaultPolicy();
    this.interactionChannel = options.interactionChannel;
    // InteractionChannel.approve, when supplied, takes precedence as the
    // approval resolver. The legacy `approvalResolver` is honored when the
    // channel does not implement approve, or when no channel is supplied.
    this.approvalResolver =
      (this.interactionChannel &&
        approvalResolverFromChannel(this.interactionChannel)) ??
      options.approvalResolver;
    for (const seed of options.hooks ?? []) {
      this.dynamicHooks.push({
        ...seed,
        id: seed.id ?? `hook-seed-${++this.dynamicHookCounter}`,
      });
    }
    this.hook = createDynamicHookSet(() => this.dynamicHooks);
    this.usageTracker =
      options.usageTracker ??
      createUsageTracker({
        runId: this.record.id,
        emitter: this.events,
      });
    const fallbackChain = options.models ?? [];
    this.models = [...(options.model ? [options.model] : []), ...fallbackChain];
    this.modelRetry = {
      maxAttempts:
        options.modelRetry?.maxAttempts ?? DEFAULT_MODEL_RETRY_MAX_ATTEMPTS,
      initialDelayMs:
        options.modelRetry?.initialDelayMs ??
        DEFAULT_MODEL_RETRY_INITIAL_DELAY_MS,
      maxDelayMs:
        options.modelRetry?.maxDelayMs ?? DEFAULT_MODEL_RETRY_MAX_DELAY_MS,
      backoffMultiplier:
        options.modelRetry?.backoffMultiplier ??
        DEFAULT_MODEL_RETRY_BACKOFF_MULTIPLIER,
      jitter: options.modelRetry?.jitter ?? DEFAULT_MODEL_RETRY_JITTER,
      respectRetryAfter:
        options.modelRetry?.respectRetryAfter ??
        DEFAULT_MODEL_RETRY_RESPECT_RETRY_AFTER,
    };
    this.workspace = options.workspace;
    this.runtimeWorkspace = options.workspace
      ? new ControlledWorkspace({
          run: this.record,
          workspace: options.workspace,
          events: this.events,
          policy: this.policy,
          approvalResolver: this.approvalResolver,
          validationHooks: options.validationHooks,
          setState: (state) => this.setState(state),
          checkpointStore: options.workspaceCheckpointStore,
        })
      : undefined;
    this.context = [...(options.context ?? [])];
    this.contextAssembler =
      options.contextAssembler ?? new DefaultContextAssembler();
    this.contextBudget = options.contextBudget;
    this.observationFormatter =
      options.observationFormatter ?? new DefaultObservationFormatter();
    this.promptBuilder = options.promptBuilder ?? new DefaultPromptBuilder();
    this.validationHooks = [...(options.validationHooks ?? [])];
    this.workflowHooks = [...(options.workflowHooks ?? [])];
    // Default to deterministic, self-gating stages when the embedder does not
    // configure their own. An explicit empty array disables compaction.
    const compactionStages =
      options.compactionStages ?? createDefaultCompactionStages();
    this.compactionPipeline =
      compactionStages.length > 0
        ? createCompactionPipeline({ stages: compactionStages })
        : undefined;
    this.prefetchers = [...(options.prefetchers ?? [])];
    this.observationSummarizer = options.observationSummarizer;
    this.runBudget = options.runBudget;
    this.maxSteps = options.maxSteps ?? 8;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.maxToolConcurrency = options.maxToolConcurrency ?? 10;
    this.doomLoopRepeatLimit =
      options.doomLoopRepeatLimit ?? DEFAULT_DOOM_LOOP_TOOL_CALL_REPEAT_LIMIT;
    this.finalOutputValidation = options.finalOutputValidation ?? "fail";
    this.maxOutputRecoveries = options.maxOutputRecoveries ?? 3;
    this.maxRevivalTurns = options.maxRevivalTurns ?? DEFAULT_MAX_REVIVAL_TURNS;
    this.notificationSources = [...(options.notificationSources ?? [])];
    this.taskRevivalSource = options.taskRevivalSource;
    this.credentialResolver = options.credentialResolver;
    const autoEvery = options.autoCheckpointEveryNSteps;
    if (autoEvery !== undefined && autoEvery !== 0) {
      if (!Number.isInteger(autoEvery) || autoEvery < 1) {
        throw new Error(
          "autoCheckpointEveryNSteps must be a positive integer or undefined.",
        );
      }
      this.autoCheckpointEveryNSteps = autoEvery;
    }
    this.externalAbortSignal = options.abortSignal;
    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        this.abortController.abort();
      } else {
        options.abortSignal.addEventListener(
          "abort",
          () => this.abortController.abort(),
          { once: true },
        );
      }
    }

    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) {
      throw new Error("maxSteps must be a positive integer.");
    }

    if (!Number.isInteger(this.maxRevivalTurns) || this.maxRevivalTurns < 0) {
      throw new Error("maxRevivalTurns must be a non-negative integer.");
    }

    if (
      !Number.isInteger(this.doomLoopRepeatLimit) ||
      this.doomLoopRepeatLimit < 1
    ) {
      throw new Error("doomLoopRepeatLimit must be a positive integer.");
    }

    if (
      this.toolTimeoutMs !== undefined &&
      (!Number.isInteger(this.toolTimeoutMs) || this.toolTimeoutMs < 1)
    ) {
      throw new Error("toolTimeoutMs must be a positive integer.");
    }

    if (
      !Number.isInteger(this.maxToolConcurrency) ||
      this.maxToolConcurrency < 1
    ) {
      throw new Error("maxToolConcurrency must be a positive integer.");
    }

    validateRunBudget(this.runBudget);

    if (
      !Number.isInteger(this.modelRetry.maxAttempts) ||
      this.modelRetry.maxAttempts < 1
    ) {
      throw new Error("modelRetry.maxAttempts must be a positive integer.");
    }

    if (
      !Number.isFinite(this.modelRetry.initialDelayMs) ||
      this.modelRetry.initialDelayMs < 0
    ) {
      throw new Error(
        "modelRetry.initialDelayMs must be a non-negative number.",
      );
    }

    if (
      !Number.isFinite(this.modelRetry.maxDelayMs) ||
      this.modelRetry.maxDelayMs < this.modelRetry.initialDelayMs
    ) {
      throw new Error(
        "modelRetry.maxDelayMs must be a finite number >= initialDelayMs.",
      );
    }

    if (
      !Number.isFinite(this.modelRetry.backoffMultiplier) ||
      this.modelRetry.backoffMultiplier < 1
    ) {
      throw new Error("modelRetry.backoffMultiplier must be a number >= 1.");
    }

    for (const tool of options.tools ?? []) {
      this.tools.register(tool);
    }

    if (checkpoint) {
      // Restore accumulated counters so a resumed run keeps honoring the
      // original budget rather than starting fresh. elapsedMs is recomputed
      // from `startedAtMs`, which is set when start() runs.
      this.budgetUsage = {
        modelCalls: checkpoint.budget.usage.modelCalls,
        toolCalls: checkpoint.budget.usage.toolCalls,
        tokens: checkpoint.budget.usage.tokens,
        costUsd: checkpoint.budget.usage.costUsd,
      };
      // Resume on the model the original run was actively using when the
      // checkpoint was taken; default to head if the recorded index falls
      // outside the configured fallback chain (e.g. caller reduced models[]).
      this.activeModelIndex =
        checkpoint.model.activeIndex < this.models.length
          ? checkpoint.model.activeIndex
          : 0;
      this.outputRecoveriesUsed = checkpoint.recovery.outputRecoveriesUsed;
      this.context = [...checkpoint.loop.context];
      this.seedLoopState = cloneLoopState(checkpoint.loop);
      this.resumedFromCheckpoint = {
        createdAt: checkpoint.createdAt,
        metadata: { ...checkpoint.metadata },
      };
    }

    this.events.emit("run.created", { goal: this.record.goal });

    // Hook.onEvent — synchronous observer. subscribeWithReplay backfills
    // events emitted before this point. Subscribe unconditionally so that
    // hooks added later via addHook() also receive future events through the
    // dynamic combined wrapper (the wrapper re-reads dynamicHooks on each
    // call). Past events for late-added hooks are replayed in addHook() so
    // each newly-added hook sees them exactly once.
    this.events.subscribeWithReplay((event) => {
      try {
        this.hook.onEvent?.({ event });
      } catch {
        /* swallowed; createDynamicHookSet already logs per-hook errors */
      }
    });

    this.runStore =
      typeof options.runStore === "function"
        ? options.runStore(this.record)
        : options.runStore;
    if (this.runStore) {
      // Backfill any events emitted before the store was wired (e.g. run.created),
      // then subscribe for the rest of the run's events.
      for (const event of this.events.all()) {
        this.safeStoreAppend(event);
      }
      this.events.subscribe((event) => this.safeStoreAppend(event));
    }
  }

  private safeStoreAppend(event: SparkwrightEvent): void {
    if (!this.runStore) return;
    this.storeAppendQueue = this.storeAppendQueue.then(() =>
      this.appendStoreEvent(event),
    );
  }

  private async safeStoreFinish(result: RunResult): Promise<void> {
    if (!this.runStore) return;
    try {
      await this.storeAppendQueue;
      await this.runStore.finish(this.record, result);
    } catch (err) {
      console.warn(
        `[sparkwright] runStore.finish failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async appendStoreEvent(event: SparkwrightEvent): Promise<void> {
    if (!this.runStore) return;
    try {
      await this.runStore.append(event);
    } catch (err) {
      console.warn(
        `[sparkwright] runStore.append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async start(): Promise<RunResult> {
    if (isTerminalState(this.record.state) && this.result) {
      return this.result;
    }

    let finalResult: RunResult;
    try {
      finalResult = await this.runLoop();
    } catch (err) {
      // Ensure store sees a terminal even if the loop throws unexpectedly.
      const fallback: RunResult = this.result ?? {
        signal: "failed",
        state: "failed",
        stopReason: this.record.stopReason ?? "model_completion_failed",
        message: err instanceof Error ? err.message : String(err),
        metadata: {},
      };
      await this.safeStoreFinish(fallback);
      throw err;
    }
    await this.safeStoreFinish(finalResult);
    return finalResult;
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

    const resultPromise: Promise<RunResult | undefined> = this.start()
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

  // ---------------------------------------------------------------------------
  // Loop body.
  //
  // The reference loop is intentionally a `while (true)` over an immutable
  // `RunLoopState`. Each `continue` point rebuilds a *new* state object (we
  // never mutate the one we entered the iteration with) so that the next
  // iteration's transition is self-describing. Phases are factored into
  // named helpers below; the body here only orchestrates them.
  //
  // Phase order, per turn:
  //   1. consume queued commands          -> may inject user content / cancel
  //   2. check step budget                -> early-return on overflow
  //   3. shape context: assembler -> compaction pipeline
  //   4. kick prefetch + post-sampling-eligible state in parallel
  //   5. call model (with retries, fallback chain, recoverable hints)
  //   6. final-answer branch              -> pre_terminal stop hook ->
  //                                          final_output validation -> complete
  //   7. tool-batch branch                -> partition + run batches ->
  //                                          schedule async summary
  //   8. assemble next state (await prefetch/summary into context)
  // ---------------------------------------------------------------------------
  private async runLoop(): Promise<RunResult> {
    // Root span for the whole run. Every event emitted from within the loop
    // (model turns, tool batches, individual tool calls, and the tool's own
    // workspace reads/writes) inherits this frame via AsyncLocalStorage, so the
    // trace rebuilds as a tree rooted here instead of a flat sequence. The
    // frame reuses the EventLog's trace id so `run.created` (emitted before the
    // loop, outside any span) and the in-loop events stay on ONE trace — a
    // fresh `createTraceId()` here would fragment the run across two traces.
    const runFrame: SpanFrame = {
      traceId: this.events.traceId,
      spanId: createSpanId(),
    };
    return runWithSpan(runFrame, () => this.runLoopBody());
  }

  private async runLoopBody(): Promise<RunResult> {
    this.setState("running");
    this.startedAtMs = Date.now();
    this.usageTracker.markStarted();
    this.events.emit("run.started", runStartedPayload(this.record.metadata));
    if (this.resumedFromCheckpoint && this.seedLoopState) {
      this.events.emit("run.resumed", {
        fromStep: this.seedLoopState.step,
        checkpointCreatedAt: this.resumedFromCheckpoint.createdAt,
        checkpointMetadata: this.resumedFromCheckpoint.metadata,
        activeModelIndex: this.activeModelIndex,
        outputRecoveriesUsed: this.outputRecoveriesUsed,
      });
    }
    this.emitBudgetChecked("run_started");
    let state: RunLoopState = this.seedLoopState
      ? {
          ...cloneLoopState(this.seedLoopState),
          // The seeded transition reason came from the loop iteration that
          // was about to run when the checkpoint was taken. Overwrite it so
          // downstream observers can distinguish a resumed iteration from
          // the original one (and from a plain fresh start).
          transition: { reason: "resumed_from_checkpoint" },
        }
      : {
          step: 1,
          turnCount: 0,
          context: [...this.context],
          repeatedToolCallCount: 0,
          transition: { reason: "run_started" },
        };
    this.lastLoopState = cloneLoopState(state);

    const sessionStartHooks = await this.runWorkflowHookPhase(
      "RunStart",
      {
        goal: this.record.goal,
        resumedFromCheckpoint: this.resumedFromCheckpoint !== undefined,
      },
      { step: state.step },
      state.step,
    );
    if (sessionStartHooks.status === "blocked") {
      return this.failWorkflowHookBlock(
        "hook_stopped",
        sessionStartHooks.block,
      );
    }
    if (sessionStartHooks.context.length > 0) {
      state = {
        ...state,
        context: [...state.context, ...sessionStartHooks.context],
      };
      this.lastLoopState = cloneLoopState(state);
    }

    if (this.models.length === 0) {
      return this.complete("no_model_configured", {
        message: "No model adapter configured.",
      });
    }

    while (this.canEnterLoopStep(state)) {
      this.lastLoopState = cloneLoopState(state);
      this.maybeAutoCheckpoint(state.step);
      await this.drainNotificationSources(state.step, state.context);
      // --- Phase 1: commands ------------------------------------------------
      const commandResult = this.consumePendingCommands(state);
      if (commandResult) return commandResult;
      if (this.abortController.signal.aborted) {
        return this.handleAbortBetweenTurns();
      }

      const promptSubmitHooks = await this.runWorkflowHookPhase(
        "TurnStart",
        {
          goal: this.record.goal,
          transition: state.transition,
          context: state.context,
        },
        { step: state.step, transition: state.transition },
        state.step,
      );
      if (promptSubmitHooks.status === "blocked") {
        return this.failWorkflowHookBlock(
          "hook_stopped",
          promptSubmitHooks.block,
        );
      }
      if (promptSubmitHooks.context.length > 0) {
        state = {
          ...state,
          context: [...state.context, ...promptSubmitHooks.context],
        };
        this.lastLoopState = cloneLoopState(state);
      }

      // --- Phase 2: budget --------------------------------------------------
      const stepBudgetFailure = this.checkRunBudget("step_started", {
        step: state.step,
        transition: state.transition,
      });
      if (stepBudgetFailure) return stepBudgetFailure;

      // --- Phase 3: context shaping ----------------------------------------
      let shapedContext: ContextItem[];
      let prompt: PromptMessage[];
      try {
        shapedContext = await this.shapeContext(state, /* reactive */ false);
        prompt = await this.buildPromptPhase(state, shapedContext);
      } catch (cause) {
        if (cause instanceof RunBudgetExceededError) {
          return this.fail(
            cause.reason,
            cause.code,
            cause.message,
            cause.metadata,
          );
        }
        const failure = toModelFailure(cause);
        return this.fail(
          "model_completion_failed",
          "CONTEXT_PHASE_FAILED",
          failure.message,
          { cause: failure.cause },
        );
      }

      // --- Phase 4: kick prefetch in parallel with model stream ------------
      this.pendingPrefetch = startPrefetch(this.prefetchers, {
        run: this.record,
        step: state.step + 1, // results land in NEXT turn
        goal: this.record.goal,
        abortSignal: this.abortController.signal,
        events: this.events,
      });

      // --- Phase 5: call model (retry/fallback/recover) --------------------
      await this.hook.beforeModelCall?.({
        runId: this.record.id,
        step: state.step,
        prompt,
        context: shapedContext,
      });
      // Per-turn model span. callModelPhase runs inside this frame so every
      // attempt's `model.requested`/`model.retrying`/`model.stream.*` nests
      // under it; the turn's `model.completed` is emitted in-frame below. The
      // span is closed on EVERY exit from the model phase (recovery-continue,
      // throw, output-invalid, success) — `close` is idempotent, so the
      // belt-and-suspenders close sites can't double-emit.
      const modelTurn = openSpan(this.events, {
        startType: "model.turn.started",
        payload: { step: state.step },
      });
      let output: ModelOutput;
      try {
        const result = await runWithSpan(modelTurn.frame, () =>
          this.callModelPhase(state, shapedContext, prompt),
        );
        output = result.output;
        if (result.recoveryApplied) {
          modelTurn.close("model.turn.completed", { step: state.step });
          // The recovery path mutated context; persist and re-loop without
          // counting this as a normal turn transition.
          state = {
            ...state,
            context: result.recoveredContext ?? state.context,
            transition: {
              reason: "model_recovery",
              metadata: { hint: result.recoveryApplied },
            },
          };
          this.lastLoopState = cloneLoopState(state);
          continue;
        }
      } catch (cause) {
        modelTurn.close("model.turn.completed", { step: state.step });
        if (cause instanceof RunBudgetExceededError) {
          return this.fail(
            cause.reason,
            cause.code,
            cause.message,
            cause.metadata,
          );
        }
        if (cause instanceof ModelOutputInvalidError) {
          return this.fail(
            "model_output_invalid",
            "MODEL_OUTPUT_INVALID",
            cause.message,
            { ...cause.metadata, retryable: false },
          );
        }
        if (this.abortController.signal.aborted) {
          return this.fail(
            "aborted_streaming",
            "ABORTED_STREAMING",
            "Model stream aborted by cancellation.",
            { step: state.step },
          );
        }
        const failure = toModelFailure(cause);
        const modelError = normalizeModelError(cause);
        // Auth / quota failures get one shot at credential refresh before
        // we give up. If the host resolver returns `refreshed: true`, we
        // re-enter the same step without consuming any retry budget — the
        // assumption is the underlying model adapter now has new credentials
        // or restored quota. See CreateRunOptions.credentialResolver.
        if (
          this.credentialResolver &&
          (modelError.category === "auth" || modelError.category === "quota")
        ) {
          const refreshed = await this.awaitCredentialRefresh(
            modelError,
            failure.message,
            state.step,
          );
          if (refreshed) {
            state = {
              ...state,
              transition: {
                reason: "next_turn",
                metadata: { credentialRefreshed: true },
              },
            };
            this.lastLoopState = cloneLoopState(state);
            continue;
          }
        }
        return this.fail(
          selectModelFailureStopReason({
            category: modelError.category,
            retryable: failure.retryable,
            exhausted: failure.attempt >= this.modelRetry.maxAttempts,
          }),
          "MODEL_COMPLETION_FAILED",
          failure.message,
          {
            attempts: failure.attempt,
            maxAttempts: this.modelRetry.maxAttempts,
            retryable: failure.retryable,
            cause: failure.cause,
            modelError,
          },
        );
      }

      const outputError = validateModelOutput(output);
      if (outputError) {
        modelTurn.close("model.turn.completed", { step: state.step });
        return this.fail(
          "model_output_invalid",
          "MODEL_OUTPUT_INVALID",
          outputError,
          { output },
        );
      }

      // Emit `model.completed` in-frame so it nests under the model.turn span,
      // then close the span — the model phase ends here; the tool batches that
      // follow are siblings of model.turn under the run span.
      runWithSpan(modelTurn.frame, () =>
        this.events.emit("model.completed", {
          step: state.step,
          ...output,
        }),
      );
      modelTurn.close("model.turn.completed", { step: state.step });
      this.recordModelUsage(output);
      await this.hook.afterModelCall?.({
        runId: this.record.id,
        step: state.step,
        output,
      });
      const modelOutputHooks = await this.runWorkflowHookPhase(
        "ModelOutput",
        {
          message: output.message,
          toolCalls: output.toolCalls ?? [],
          stopReason: output.stopReason,
          usage: output.usage,
        },
        {
          step: state.step,
          toolCallCount: output.toolCalls?.length ?? 0,
        },
        state.step,
      );
      if (modelOutputHooks.status === "blocked") {
        state = {
          ...state,
          context: [
            ...state.context,
            this.formatWorkflowHookBlockContinuation(
              "ModelOutput",
              modelOutputHooks.block,
              state.step,
            ),
          ],
          step: state.step + 1,
          turnCount: state.turnCount + 1,
          transition: {
            reason: "validation_continuation",
            metadata: { hookName: modelOutputHooks.block.hookName },
          },
        };
        this.lastLoopState = cloneLoopState(state);
        continue;
      }
      if (modelOutputHooks.status === "advanced") {
        state = {
          ...state,
          context: [
            ...state.context,
            this.formatWorkflowHookAdvanceContinuation(
              "ModelOutput",
              modelOutputHooks.advance,
              state.step,
            ),
            ...modelOutputHooks.context,
          ],
          step: state.step + 1,
          turnCount: state.turnCount + 1,
          transition: {
            reason: "workflow_hook_advanced",
            metadata: {
              hookName: modelOutputHooks.advance.hookName,
              hookId: modelOutputHooks.advance.hookId,
              hook: "ModelOutput",
            },
          },
        };
        this.lastLoopState = cloneLoopState(state);
        continue;
      }
      if (modelOutputHooks.context.length > 0) {
        state = {
          ...state,
          context: [...state.context, ...modelOutputHooks.context],
        };
        this.lastLoopState = cloneLoopState(state);
      }
      // Fire post_sampling hooks fire-and-forget so they observe model output
      // without blocking the loop. Failures are logged via validation events.
      kickPostSamplingHooks({
        hooks: this.validationHooks,
        stage: "post_sampling",
        run: this.record,
        subject: output,
        metadata: { step: state.step },
        events: this.events,
      });
      const outputBudgetFailure = this.checkRunBudget("model_completed", {
        step: state.step,
      });
      if (outputBudgetFailure) return outputBudgetFailure;

      const toolCalls = output.toolCalls ?? [];

      // --- Phase 6: terminal branch ---------------------------------------
      if (toolCalls.length === 0) {
        // pre_terminal stop hook: a failed hook here BLOCKS termination and
        // converts itself into a continuation context item.
        const stopHookFailure = await this.runValidation(
          "pre_terminal",
          output.message,
          { step: state.step },
        );
        if (stopHookFailure) {
          const continuation = this.formatStopHookContinuation(
            stopHookFailure,
            state.step,
          );
          this.events.emit("validation.failed", {
            hookName: stopHookFailure.hookName,
            stage: "pre_terminal",
            result: stopHookFailure.result,
            metadata: { step: state.step, blockedTermination: true },
          });
          state = {
            ...state,
            context: [...state.context, continuation],
            step: state.step + 1,
            turnCount: state.turnCount + 1,
            transition: {
              reason: "stop_hook_blocked",
              metadata: { hookName: stopHookFailure.hookName },
            },
          };
          this.lastLoopState = cloneLoopState(state);
          continue;
        }

        const validationFailure = await this.runValidation(
          "final_output",
          output.message,
          { step: state.step },
        );
        if (validationFailure) {
          if (this.finalOutputValidation === "continue") {
            state = {
              ...state,
              context: [
                ...state.context,
                this.formatValidationFailureContext(
                  validationFailure,
                  state.step,
                ),
              ],
              step: state.step + 1,
              turnCount: state.turnCount + 1,
              transition: {
                reason: "validation_continuation",
                metadata: { hookName: validationFailure.hookName },
              },
            };
            this.lastLoopState = cloneLoopState(state);
            continue;
          }

          return this.fail(
            "validation_failed",
            "VALIDATION_FAILED",
            validationFailureMessage(validationFailure),
            {
              stage: "final_output",
              validation: validationFailure,
            },
          );
        }

        const stopHooks = await this.runWorkflowHookPhase(
          "Stop",
          {
            message: output.message,
            stepsUsed: state.step,
            maxSteps: this.maxSteps,
            events: this.events.all(),
          },
          { step: state.step },
          state.step,
        );
        if (stopHooks.status === "blocked") {
          state = {
            ...state,
            context: [
              ...state.context,
              this.formatWorkflowHookBlockContinuation(
                "Stop",
                stopHooks.block,
                state.step,
              ),
            ],
            step: state.step + 1,
            turnCount: state.turnCount + 1,
            transition: {
              reason: "stop_hook_blocked",
              metadata: { hookName: stopHooks.block.hookName },
            },
          };
          this.lastLoopState = cloneLoopState(state);
          continue;
        }
        if (stopHooks.status === "advanced") {
          state = {
            ...state,
            context: [
              ...state.context,
              this.formatWorkflowHookAdvanceContinuation(
                "Stop",
                stopHooks.advance,
                state.step,
              ),
              ...stopHooks.context,
            ],
            step: state.step + 1,
            turnCount: state.turnCount + 1,
            transition: {
              reason: "workflow_hook_advanced",
              metadata: {
                hookName: stopHooks.advance.hookName,
                hookId: stopHooks.advance.hookId,
                hook: "Stop",
              },
            },
          };
          this.lastLoopState = cloneLoopState(state);
          continue;
        }

        // Surface step-budget context on a natural finish. A model can answer
        // on its *last* allowed step, which is a `final_answer` indistinguishable
        // from a roomy finish unless we say so — callers (e.g. a parent agent
        // summarizing a sub-agent) otherwise can't tell "done" from "ran out of
        // room and wrapped up", and may over-trust a possibly-truncated answer.
        const waitedState = await this.waitForAwaitedTasksBeforeTerminal(state);
        if (waitedState) {
          state = waitedState;
          this.lastLoopState = cloneLoopState(state);
          continue;
        }
        return this.complete("final_answer", {
          message: output.message,
          stepsUsed: state.step,
          maxSteps: this.maxSteps,
          stepLimitReached:
            state.step >= this.maxSteps && !isWaitingTasksWake(state),
          ...(this.revivalTurnsUsed > 0
            ? { revivalTurnsUsed: this.revivalTurnsUsed }
            : {}),
        });
      }

      // --- Phase 7: tool batches ------------------------------------------
      const loadedDeferredToolsAtTurnStart = new Set(this.loadedDeferredTools);
      const batches = partitionToolCalls(this.tools, toolCalls);
      const batchResults: ToolResult[] = [];
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        if (this.abortController.signal.aborted) {
          return this.fail(
            "aborted_tools",
            "ABORTED_TOOLS",
            "Tool batch aborted by cancellation.",
            { step: state.step, batchIndex },
          );
        }
        const batch = batches[batchIndex]!;
        // Bracket the batch in a span: `tool.batch.requested` → `.completed`
        // share a span id, and every per-tool call inside `runToolBatch`
        // (including the concurrent path, which fans out under this frame via
        // AsyncLocalStorage) nests beneath it.
        const toolExecutionDiagnostics = createToolExecutionDiagnostics(
          batch,
          this.maxToolConcurrency,
        );
        const deferredObservations: DeferredToolObservation[] = [];
        const batchCallIndexes = new Map(
          batch.calls.map((call, index) => [call, index] as const),
        );
        const appendContext = batch.mode !== "concurrent";
        const results = await withSpan(
          this.events,
          {
            startType: "tool.batch.requested",
            endType: "tool.batch.completed",
            payload: toolBatchEventPayload(state.step, batchIndex, batch),
          },
          () =>
            runToolBatch(
              batch,
              (requestedCall) =>
                this.processToolCall(
                  requestedCall,
                  state,
                  diagnoseToolExecution(
                    toolExecutionDiagnostics,
                    requestedCall,
                  ),
                  {
                    appendContext,
                    batchResults,
                    deferredObservations,
                    loadedDeferredToolsAtTurnStart,
                    originalIndex: batchCallIndexes.get(requestedCall) ?? 0,
                  },
                ),
              { maxConcurrency: this.maxToolConcurrency },
            ),
        );
        if (!appendContext) {
          this.flushDeferredToolObservations(
            state.context,
            batchResults,
            deferredObservations,
          );
        }
        const terminal = results.find(
          (result): result is RunResult => result !== undefined,
        );
        if (terminal) return terminal;
      }

      // Schedule an async summary of the tool batch; awaited at start of next
      // turn so it overlaps any in-between bookkeeping. The summary runs as
      // a pending future that the next turn awaits.
      this.pendingSummary = createPendingSummary(this.observationSummarizer, {
        run: this.record,
        step: state.step,
        results: batchResults,
        abortSignal: this.abortController.signal,
        events: this.events,
      });

      // --- Phase 8: assemble next state ------------------------------------
      this.context = state.context;
      const nextContext = await this.finalizeTurnContext(state.context);
      state = {
        ...state,
        context: nextContext,
        step: state.step + 1,
        turnCount: state.turnCount + 1,
        transition: { reason: "next_turn" },
      };
      this.lastLoopState = cloneLoopState(state);
    }

    // Budget exhausted mid-task. Rather than hard-failing and discarding every
    // tool result the run gathered, force one final tool-less wrap-up turn so
    // the model can hand back a labeled best-effort partial. Only if even that
    // turn cannot run (e.g. the resource budget is also spent, or the model
    // errors) do we fall back to the original hard failure.
    return this.finishWithBudgetWrapUp(state);
  }

  /**
   * Forced wrap-up turn after the step budget is exhausted. Reuses the normal
   * context-shaping, prompt-building, and model-call machinery but with the
   * tool list stripped and a budget directive injected, so the model must
   * answer rather than start new tool work. Completes as a `final_answer`
   * flagged `stepLimitReached`/`truncated` so callers (and the sub-agent caveat
   * path) can tell it apart from a roomy finish. Falls back to the original
   * `max_steps_exceeded` failure if the wrap-up turn itself cannot complete.
   */
  private async finishWithBudgetWrapUp(
    state: RunLoopState,
  ): Promise<RunResult> {
    const hardFail = (): RunResult =>
      this.fail(
        "max_steps_exceeded",
        "MAX_STEPS_EXCEEDED",
        `Run exceeded the maximum step count of ${this.maxSteps}.`,
        { maxSteps: this.maxSteps },
      );

    const wrapUpState: RunLoopState = {
      ...state,
      context: [
        ...state.context,
        makeBudgetWrapUpContextItem(state.step - 1, this.maxSteps),
      ],
    };

    const modelTurn = openSpan(this.events, {
      startType: "model.turn.started",
      payload: { step: state.step, budgetWrapUp: true },
    });
    try {
      const shaped = await this.shapeContext(wrapUpState, /* reactive */ false);
      const prompt = await this.buildPromptPhase(wrapUpState, shaped);
      const output = await runWithSpan(modelTurn.frame, () =>
        this.completeModelWithRetries({
          run: this.record,
          context: shaped,
          prompt,
          // No tools on the wrap-up turn: the model must produce a text answer.
          tools: [],
          events: this.events.all(),
          step: state.step,
          abortSignal: this.abortController.signal,
        }),
      );
      runWithSpan(modelTurn.frame, () =>
        this.events.emit("model.completed", { step: state.step, ...output }),
      );
      modelTurn.close("model.turn.completed", { step: state.step });
      this.recordModelUsage(output);

      const message =
        typeof output.message === "string" && output.message.trim().length > 0
          ? output.message
          : "Step budget exhausted before this task could be completed; no " +
            "partial summary was produced. The work gathered so far remains " +
            "in the trace.";
      return this.complete("final_answer", {
        message,
        stepsUsed: state.step - 1,
        maxSteps: this.maxSteps,
        stepLimitReached: true,
        truncated: true,
      });
    } catch {
      // Span may already be closed on the success path; close is idempotent.
      modelTurn.close("model.turn.completed", { step: state.step });
      return hardFail();
    }
  }

  // ---------------------------------------------------------------------------
  // Phase helpers. These are intentionally small, side-effect-minimal methods
  // so future deps-injection (see RunDeps roadmap) can replace them one at a
  // time without rewriting the loop body.
  // ---------------------------------------------------------------------------

  private async shapeContext(
    state: RunLoopState,
    reactive: boolean,
  ): Promise<ContextItem[]> {
    // 1) Run compaction pipeline FIRST when configured. The reference
    //    layered model is:
    //    cheap edits (tool-result budget, snip) → mid-cost (micro/collapse) →
    //    expensive (auto/reactive). Order is owned by the embedder via the
    //    `compactionStages` option.
    let priorContext = [...state.context];
    if (this.compactionPipeline) {
      const result = await this.compactionPipeline.run({
        items: priorContext,
        hints: {
          step: state.step,
          goal: this.record.goal,
          budget: this.contextBudget,
          model: this.activeModel().contextHints,
          reasons: reactive ? ["reactive_overflow"] : [],
          usage: this.buildUsageHint(),
        },
        reactive,
        events: this.events,
        run: this.record,
      });
      if (result.appliedStages.length > 0) {
        priorContext = result.items;
      }
    }

    const assembledContext = await this.contextAssembler.assemble({
      run: this.record,
      step: state.step,
      goal: this.record.goal,
      events: this.events.all(),
      priorContext,
      tools: await this.tools.listModelDescriptors(),
      model: this.activeModel().contextHints,
      budget: this.contextBudget,
    });
    this.events.emit("context.assembled", {
      step: state.step,
      selectedCount: assembledContext.items.length,
      omittedCount: assembledContext.omitted.length,
      omitted: assembledContext.omitted,
      metadata: assembledContext.metadata,
    });
    if (shouldRequestContextCompaction(assembledContext.omitted)) {
      this.events.emit("context.compaction_requested", {
        step: state.step,
        selectedCount: assembledContext.items.length,
        omittedCount: assembledContext.omitted.length,
        reasons: countOmissionReasons(assembledContext.omitted),
        metadata: assembledContext.metadata,
      });
    }
    return assembledContext.items;
  }

  private async buildPromptPhase(
    state: RunLoopState,
    items: ContextItem[],
  ): Promise<PromptMessage[]> {
    const prompt = await this.promptBuilder.build({
      run: this.record,
      step: state.step,
      maxSteps: this.maxSteps,
      tools: await this.tools.listModelDescriptors(),
      context: items,
    });
    const cacheBlocks = compilePromptCacheBlocks(prompt);
    this.events.emit("prompt.built", {
      step: state.step,
      messageCount: prompt.length,
      stableMessageCount: prompt.filter(
        (message) => message.stability === "stable",
      ).length,
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
      messages: prompt,
      sections: prompt.map((message, index) => ({
        index,
        name: promptMetadataString(message.metadata, "sectionName"),
        layer: promptMetadataString(message.metadata, "layer"),
        stability: message.stability,
        cachePolicy: promptMetadataString(message.metadata, "cachePolicy"),
        chars: message.content.length,
      })),
    });
    return prompt;
  }

  // Returns either the model output, or signals that a recovery was applied
  // and the caller should `continue` the loop without consuming a turn.
  private async callModelPhase(
    state: RunLoopState,
    contextItems: ContextItem[],
    prompt: PromptMessage[],
  ): Promise<{
    output: ModelOutput;
    recoveryApplied?: ModelRecoveryHint;
    recoveredContext?: ContextItem[];
  }> {
    const input: ModelInput = {
      run: this.record,
      context: contextItems,
      prompt,
      tools: this.modelRequestTools(await this.tools.listModelDescriptors()),
      events: this.events.all(),
      step: state.step,
      abortSignal: this.abortController.signal,
    };

    try {
      const output = await this.completeModelWithRetries(input);
      // Detect output truncation reported via stopReason.
      if (
        output.stopReason === "max_output_tokens" &&
        this.outputRecoveriesUsed < this.maxOutputRecoveries
      ) {
        this.outputRecoveriesUsed += 1;
        const continuation = makeContinuationContextItem(
          this.outputRecoveriesUsed,
          this.maxOutputRecoveries,
        );
        this.events.emit("model.retrying", {
          step: state.step,
          attempt: this.outputRecoveriesUsed,
          maxAttempts: this.maxOutputRecoveries,
          error: { reason: "max_output_tokens", recoveryHint: "extend_output" },
        });
        return {
          output,
          recoveryApplied: "extend_output",
          recoveredContext: [...state.context, continuation],
        };
      }
      return { output };
    } catch (cause) {
      const hint = extractRecoveryHint(cause);
      if (!hint) throw cause;

      if (hint === "reduce_input" && this.compactionPipeline) {
        // Reactive compaction. Reshape and let the loop continue without
        // counting a turn — caller treats this as model_recovery.
        this.events.emit("model.retrying", {
          step: state.step,
          attempt: 1,
          maxAttempts: 1,
          error: { reason: "reduce_input", recoveryHint: hint },
        });
        const recoveredContext = await this.shapeContext(state, true);
        return {
          // Synthetic empty output: the loop will continue immediately and
          // re-issue a fresh call next iteration with the shrunk context.
          output: { message: undefined, toolCalls: [] },
          recoveryApplied: hint,
          recoveredContext,
        };
      }

      if (hint === "extend_output") {
        if (this.outputRecoveriesUsed >= this.maxOutputRecoveries) {
          throw cause;
        }
        this.outputRecoveriesUsed += 1;
        const continuation = makeContinuationContextItem(
          this.outputRecoveriesUsed,
          this.maxOutputRecoveries,
        );
        return {
          output: { message: undefined, toolCalls: [] },
          recoveryApplied: hint,
          recoveredContext: [...state.context, continuation],
        };
      }

      if (hint === "fallback_model") {
        if (this.activeModelIndex >= this.models.length - 1) {
          throw cause;
        }
        this.activeModelIndex += 1;
        this.events.emit("model.retrying", {
          step: state.step,
          attempt: this.activeModelIndex + 1,
          maxAttempts: this.models.length,
          error: { reason: "fallback_model", recoveryHint: hint },
        });
        return {
          output: { message: undefined, toolCalls: [] },
          recoveryApplied: hint,
          recoveredContext: state.context,
        };
      }

      throw cause;
    }
  }

  private modelRequestTools(tools: ToolDescriptor[]): ToolDescriptor[] {
    return tools.filter(
      (tool) =>
        !tool.loading?.defer ||
        tool.loading.alwaysLoad === true ||
        this.loadedDeferredTools.has(tool.name),
    );
  }

  // Awaits any pending prefetch + tool-batch summary and merges their results
  // into the context that the NEXT turn will see. Errors inside prefetch and
  // summarize are swallowed at the source (see pipeline.ts); this method only
  // appends successful outputs.
  private async finalizeTurnContext(
    base: ContextItem[],
  ): Promise<ContextItem[]> {
    const additions: ContextItem[] = [];
    if (this.pendingSummary) {
      const summary = await this.pendingSummary.catch(() => undefined);
      this.pendingSummary = undefined;
      if (summary) additions.push(summary);
    }
    if (this.pendingPrefetch) {
      const items = await this.pendingPrefetch.catch(() => []);
      this.pendingPrefetch = undefined;
      if (items.length > 0) additions.push(...items);
    }
    return additions.length > 0 ? [...base, ...additions] : base;
  }

  private activeModel(): ModelAdapter {
    return this.models[this.activeModelIndex]!;
  }

  private nowIso(): string {
    return (this.loopServices.now?.() ?? new Date()).toISOString();
  }

  private handleAbortBetweenTurns(): RunResult {
    return this.fail(
      "manual_cancelled",
      "MANUAL_CANCELLED",
      "Run aborted between turns.",
      {},
    );
  }

  private async drainNotificationSources(
    step: number,
    context: ContextItem[],
  ): Promise<void> {
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
          message: notificationErrorMessage(cause),
        });
        continue;
      }
      if (items.length === 0) continue;
      for (const item of items) {
        context.push({
          id: (this.loopServices.createContextItemId ?? createContextItemId)(),
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

  private canEnterLoopStep(state: RunLoopState): boolean {
    if (state.step <= this.maxSteps) return true;
    return isWaitingTasksWake(state);
  }

  private async waitForAwaitedTasksBeforeTerminal(
    state: RunLoopState,
  ): Promise<RunLoopState | undefined> {
    const source = this.taskRevivalSource;
    if (!source) return undefined;
    if (this.revivalTurnsUsed >= this.maxRevivalTurns) return undefined;
    let hasAwaitedPending: boolean;
    try {
      hasAwaitedPending = await source.hasAwaitedPending();
    } catch (cause) {
      this.events.emit("run.notification.source_failed", {
        step: state.step,
        sourceIndex: -1,
        message: notificationErrorMessage(cause),
        phase: "hasAwaitedPending",
      });
      return undefined;
    }
    if (!hasAwaitedPending) return undefined;

    const previousState = this.record.state;
    this.setState("waiting_tasks");
    const waitStartedAfterSequence = this.events.all().at(-1)?.sequence ?? 0;
    const waitAbortController = new AbortController();
    const abortTaskWait = () => waitAbortController.abort();
    this.abortController.signal.addEventListener("abort", abortTaskWait, {
      once: true,
    });
    try {
      await Promise.race([
        source
          .waitUntilAvailable({ signal: waitAbortController.signal })
          .catch((cause) => {
            if (waitAbortController.signal.aborted) return;
            throw cause;
          }),
        this.waitForCommandEnqueuedAfter(
          waitStartedAfterSequence,
          waitAbortController.signal,
        ),
        this.waitForAbort(waitAbortController.signal),
      ]);
    } catch (cause) {
      this.events.emit("run.notification.source_failed", {
        step: state.step,
        sourceIndex: -1,
        message: notificationErrorMessage(cause),
        phase: "waiting_tasks",
      });
      return undefined;
    } finally {
      this.abortController.signal.removeEventListener("abort", abortTaskWait);
      abortTaskWait();
      if (this.record.state === "waiting_tasks") {
        this.setState(previousState === "running" ? "running" : previousState);
      }
    }

    this.revivalTurnsUsed += 1;
    return {
      ...state,
      step: state.step + 1,
      turnCount: state.turnCount + 1,
      transition: {
        reason: "next_turn",
        metadata: { wake: "waiting_tasks" },
      },
    };
  }

  private waitForCommandEnqueuedAfter(
    sequence: number,
    signal: AbortSignal,
  ): Promise<void> {
    const alreadyQueued = this.events
      .all()
      .some(
        (event) =>
          event.sequence > sequence && event.type === "run.command.enqueued",
      );
    if (alreadyQueued || signal.aborted) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let resolved = false;
      const unsubscribe: { current?: () => void } = {};
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        unsubscribe.current?.();
        signal.removeEventListener("abort", cleanup);
        resolve();
      };
      unsubscribe.current = this.events.subscribe((event) => {
        if (event.sequence <= sequence) return;
        if (event.type === "run.command.enqueued") cleanup();
      });
      signal.addEventListener("abort", cleanup, { once: true });
    });
  }

  private waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  private formatStopHookContinuation(
    failure: ValidationFailure,
    step: number,
  ): ContextItem {
    return {
      id: (this.loopServices.createContextItemId ?? createContextItemId)(),
      type: "summary",
      source: { kind: "validation", uri: failure.hookName },
      content: JSON.stringify({
        stage: "pre_terminal",
        status: "blocked_termination",
        hookName: failure.hookName,
        message: validationFailureMessage(failure),
        result: failure.result,
        guidance:
          "A stop hook prevented this run from terminating. Address the finding and continue.",
      }),
      metadata: {
        layer: "working",
        stability: "turn",
        step,
        stopHookContinuation: true,
        hookName: failure.hookName,
      },
    };
  }

  private formatWorkflowHookBlockContinuation(
    hook: WorkflowHookName,
    block: WorkflowHookBlock,
    step: number,
  ): ContextItem {
    return {
      id: (this.loopServices.createContextItemId ?? createContextItemId)(),
      type: "summary",
      source: { kind: "validation", uri: block.hookName },
      content: JSON.stringify({
        stage: hook,
        status: "blocked",
        hookName: block.hookName,
        hookId: block.hookId,
        message: workflowHookBlockMessage(block),
        findings: block.findings,
        guidance:
          "A workflow hook prevented this path from continuing. Address the finding and continue.",
      }),
      metadata: {
        layer: "working",
        stability: "turn",
        step,
        workflowHookContinuation: true,
        workflowHook: hook,
        hookName: block.hookName,
        hookId: block.hookId,
      },
    };
  }

  private formatWorkflowHookAdvanceContinuation(
    hook: WorkflowHookName,
    advance: WorkflowHookAdvance,
    step: number,
  ): ContextItem {
    return {
      id: (this.loopServices.createContextItemId ?? createContextItemId)(),
      type: "summary",
      source: { kind: "extension", uri: advance.hookName },
      content: JSON.stringify({
        stage: hook,
        status: "advanced",
        hookName: advance.hookName,
        hookId: advance.hookId,
        reason: advance.reason,
        metadata: advance.metadata,
        guidance:
          "A workflow hook advanced this run to the next turn. Continue from the supplied workflow context.",
      }),
      metadata: {
        layer: "working",
        stability: "turn",
        step,
        workflowHookAdvanceContinuation: true,
        workflowHook: hook,
        hookName: advance.hookName,
        hookId: advance.hookId,
      },
    };
  }

  async requestApproval(input: {
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
    const response = await resolveApproval(request, this.approvalResolver);
    this.events.emit("approval.resolved", response);
    this.events.emit("interaction.resolved", { kind: "approval", response });
    this.setState("running");
    return response.decision === "approved";
  }

  async askUser(input: {
    prompt: string;
    choices?: InteractionQuestionRequest["choices"];
    defaultChoiceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<InteractionQuestionResponse | undefined> {
    if (!this.interactionChannel?.ask) return undefined;
    const request = createInteractionQuestionRequest({
      runId: this.record.id,
      prompt: input.prompt,
      choices: input.choices,
      defaultChoiceId: input.defaultChoiceId,
      metadata: input.metadata,
    });
    this.events.emit("interaction.requested", { kind: "question", request });
    const response = await this.interactionChannel.ask(request);
    this.events.emit("interaction.resolved", { kind: "question", response });
    return response;
  }

  async notifyUser(input: {
    level: InteractionNotificationLevel;
    message: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.interactionChannel?.notify) return;
    const notification: InteractionNotification = createInteractionNotification(
      {
        runId: this.record.id,
        level: input.level,
        message: input.message,
        title: input.title,
        metadata: input.metadata,
      },
    );
    this.events.emit("interaction.requested", {
      kind: "notification",
      notification,
    });
    try {
      await this.interactionChannel.notify(notification);
    } catch (err) {
      // Notification failures must not interrupt the run.
      console.warn(
        `[sparkwright] notifyUser failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.events.emit("interaction.resolved", {
      kind: "notification",
      notification,
    });
  }

  usage() {
    return this.usageTracker.snapshot();
  }

  getUsageTracker(): UsageTracker {
    return this.usageTracker;
  }

  getWorkspace(): RuntimeContext["workspace"] | undefined {
    return this.workspace;
  }

  addHook(hook: RunHook): string {
    const id = hook.id ?? `hook-dyn-${++this.dynamicHookCounter}`;
    if (this.dynamicHooks.some((existing) => existing.id === id)) {
      throw new Error(
        `RunHandle.addHook: a hook with id "${id}" is already registered.`,
      );
    }
    const registered: RunHook = { ...hook, id };
    this.dynamicHooks.push(registered);
    if (registered.onEvent) {
      // Replay past events to *only this hook* so late-attached observers
      // see lifecycle events emitted before they registered. The shared
      // subscription is already wired to the dynamic set, so future events
      // will flow through automatically.
      for (const event of this.events.all()) {
        try {
          registered.onEvent({ event });
        } catch {
          /* swallow — createDynamicHookSet semantics: errors never escape */
        }
      }
    }
    return id;
  }

  removeHook(id: string): boolean {
    const index = this.dynamicHooks.findIndex((hook) => hook.id === id);
    if (index < 0) return false;
    this.dynamicHooks.splice(index, 1);
    return true;
  }

  checkpoint(metadata: Record<string, unknown> = {}): RunCheckpointV1 {
    const loop = this.lastLoopState ?? {
      step: 0,
      turnCount: 0,
      context: [...this.context],
      repeatedToolCallCount: 0,
      transition: { reason: "run_started" },
    };
    const reasons: string[] = [];
    if (this.pendingPrefetch) reasons.push("pending_prefetch_not_serialized");
    if (this.pendingSummary) reasons.push("pending_summary_not_serialized");
    if (this.commandQueue.length > 0)
      reasons.push("command_queue_not_serialized");
    if (this.record.state === "waiting_tasks")
      reasons.push("waiting_tasks_not_serialized");

    return {
      schemaVersion: "run-checkpoint.v1",
      run: { ...this.record, metadata: { ...this.record.metadata } },
      loop: cloneLoopState(loop),
      eventSequence: this.events.lastSequence,
      model: {
        activeIndex: this.activeModelIndex,
        activeAdapterId: getModelAdapterId(this.models[this.activeModelIndex]),
        fallbackCount: Math.max(0, this.models.length - 1),
      },
      recovery: {
        outputRecoveriesUsed: this.outputRecoveriesUsed,
        maxOutputRecoveries: this.maxOutputRecoveries,
      },
      budget: {
        configured: this.runBudget,
        usage: this.currentBudgetUsage(),
      },
      queues: {
        commandCount: this.commandQueue.length,
        pendingPrefetch: Boolean(this.pendingPrefetch),
        pendingSummary: Boolean(this.pendingSummary),
      },
      resumability: {
        complete: reasons.length === 0 && !isTerminalState(this.record.state),
        reasons,
      },
      createdAt: this.nowIso(),
      metadata,
    };
  }

  private maybeAutoCheckpoint(currentStep: number): void {
    const every = this.autoCheckpointEveryNSteps;
    if (!every) return;
    // Use a monotonic gate (`>= last + every`) rather than `step % every === 0`
    // so a resumed run, whose first iteration may be step=K (K!=1), still gets
    // checkpointed promptly and on the same cadence afterwards.
    if (currentStep < this.lastAutoCheckpointStep + every) return;
    this.lastAutoCheckpointStep = currentStep;
    // persistCheckpoint already tolerates store failures; ignore return.
    this.persistCheckpoint({ auto: true, step: currentStep });
  }

  persistCheckpoint(metadata: Record<string, unknown> = {}): RunCheckpointV1 {
    const checkpoint = this.checkpoint(metadata);
    const store = this.runStore as
      | (RunStore & { saveCheckpoint?: (cp: RunCheckpointV1) => void })
      | undefined;
    if (store?.saveCheckpoint) {
      try {
        store.saveCheckpoint(checkpoint);
      } catch (err) {
        // Mirror the existing tolerance pattern (see safeStoreAppend): a
        // failed checkpoint persist must never tear down an otherwise
        // healthy run.
        console.warn(
          `[sparkwright] runStore.saveCheckpoint failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return checkpoint;
  }

  cancel(
    input: { reason?: string; metadata?: Record<string, unknown> } = {},
  ): RunResult {
    this.setState("cancelled", "manual_cancelled");
    // Trip the internal abort controller so any mid-stream model call or
    // in-flight tool that honors `RuntimeContext.abortSignal` tears down
    // promptly instead of waiting for the next loop boundary.
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    const payload = {
      reason: "manual_cancelled",
      message: input.reason ?? "Run cancelled.",
      metadata: input.metadata ?? {},
    };
    this.events.emit("run.cancelled", payload);
    this.result = {
      signal: "cancelled",
      state: "cancelled",
      stopReason: "manual_cancelled",
      message: payload.message,
      metadata: payload.metadata,
    };
    // Fire-and-forget; cancel() is sync and storage failure cannot break the run.
    void this.safeStoreFinish(this.result);
    return this.result;
  }

  /**
   * Run-scoped abort signal. Fires when `cancel()` is called or the
   * external `options.abortSignal` aborts. Embedders can wire this into
   * their own teardown logic (e.g. closing SSE connections to a UI).
   */
  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  enqueueCommand(command: RunCommand): void {
    this.commandQueue.push(command);
    this.events.emit("run.command.enqueued", {
      commandType: command.type,
      metadata: command.metadata ?? {},
    });
  }

  injectUserMessage(input: {
    content: string;
    parts?: ContentPart[];
    metadata?: Record<string, unknown>;
  }): void {
    this.enqueueCommand({
      type: "user_message",
      content: input.content,
      parts: input.parts,
      metadata: input.metadata,
    });
  }

  async checkPolicy(
    action: string,
    metadata: Record<string, unknown> = {},
    resource?: PolicyResource,
  ) {
    return this.policy.decide({ action, metadata, resource });
  }

  private consumePendingCommands(state: RunLoopState): RunResult | undefined {
    while (this.commandQueue.length > 0) {
      const command = this.commandQueue.shift()!;
      this.events.emit("run.command.applied", {
        commandType: command.type,
        step: state.step,
        metadata: command.metadata ?? {},
      });

      if (command.type === "cancel") {
        this.events.emit("run.cancel_requested", {
          reason: command.reason ?? "Command requested cancellation.",
          metadata: command.metadata ?? {},
        });
        return this.cancel({
          reason: command.reason,
          metadata: command.metadata,
        });
      }

      const commandParts = command.parts ?? [];
      const commandImageCount = commandParts.filter(
        (part) => part.type === "image",
      ).length;
      state.context.push({
        id: (this.loopServices.createContextItemId ?? createContextItemId)(),
        type: "user",
        source: {
          kind: "command",
          uri: "run.command.user_message",
        },
        content: command.content,
        ...(commandParts.length > 0 ? { parts: commandParts } : {}),
        metadata: {
          layer: "runtime",
          stability: "turn",
          injected: true,
          ...(commandParts.length > 0
            ? {
                multimodal: true,
                attachmentCount: commandParts.length,
                ...(commandImageCount > 0
                  ? { imageCount: commandImageCount }
                  : {}),
              }
            : {}),
          ...(command.metadata ?? {}),
        },
      });
      state.transition = {
        reason: "command_injected",
        metadata: command.metadata,
      };
    }

    return undefined;
  }

  private createRuntimeContext(input?: {
    toolCallId?: ToolResult["toolCallId"];
    toolName?: string;
  }): RuntimeContext {
    return {
      run: this.record,
      workspace: this.runtimeWorkspace,
      abortSignal: this.abortController.signal,
      reportToolProgress: input?.toolCallId
        ? (update) => {
            this.events.emit("tool.progress", {
              toolCallId: input.toolCallId,
              toolName: input.toolName,
              ...update,
            });
          }
        : undefined,
      reportWorkspaceWriteSkipped: (payload) => {
        this.events.emit("workspace.write.skipped", payload);
      },
      reportCapabilityMutationCompleted: (payload) => {
        this.events.emit("capability.mutation.completed", payload);
      },
      reportToolArtifact: (artifact) => {
        // Workspace write helpers already emit artifact.created for their diff
        // artifacts before returning them to the tool. `reportToolArtifact`
        // attaches such artifacts to the tool result; emitting them again would
        // duplicate trace evidence with the same id. Other tool-produced
        // artifacts (logs, screenshots, generated files) enter the trace here.
        if (
          artifact.type === "diff" &&
          typeof artifact.metadata?.targetPath === "string"
        ) {
          return;
        }
        this.events.emit("artifact.created", artifact);
      },
    };
  }

  private createValidationRuntimeContext(input?: {
    toolCallId?: ToolResult["toolCallId"];
    toolName?: string;
  }): RuntimeContext {
    const workspace = this.runtimeWorkspace;
    return {
      run: this.record,
      abortSignal: this.abortController.signal,
      ...(workspace
        ? {
            workspace: {
              readText: workspace.readText.bind(workspace),
              canonicalPath: workspace.canonicalPath?.bind(workspace),
              readAnchoredText: workspace.readAnchoredText.bind(workspace),
              editAnchoredText: async () => {
                throw new Error(
                  `validateInput for ${input?.toolName ?? "tool"} cannot edit the workspace.`,
                );
              },
              writeText: async () => {
                throw new Error(
                  `validateInput for ${input?.toolName ?? "tool"} cannot write the workspace.`,
                );
              },
              diffText: workspace.diffText.bind(workspace),
            },
          }
        : {}),
    };
  }

  private async processToolCall(
    requestedCall: RequestedToolCall,
    state: RunLoopState,
    executionDiagnostic?: ToolExecutionDiagnostic,
    recordingOptions: ToolResultRecordingOptions = {},
  ): Promise<RunResult | undefined> {
    const preToolHooks = await this.runWorkflowHookPhase(
      "PreToolUse",
      {
        toolName: requestedCall.toolName,
        arguments: requestedCall.arguments,
        path: extractWorkflowPath(requestedCall.arguments),
      },
      {
        step: state.step,
        toolName: requestedCall.toolName,
        path: extractWorkflowPath(requestedCall.arguments),
      },
      state.step,
    );
    if (preToolHooks.status === "blocked") {
      const call = createToolCall(
        this.record.id,
        requestedCall.toolName,
        requestedCall.arguments,
      );
      const span = openSpan(this.events, {
        startType: "tool.requested",
        payload: this.toolRequestedPayload(call, requestedCall),
      });
      const blocked: ToolResult = {
        toolCallId: call.id,
        status: "failed",
        error: {
          code: "TOOL_BLOCKED_BY_WORKFLOW_HOOK",
          message: workflowHookBlockMessage(preToolHooks.block),
          metadata: { workflowHook: preToolHooks.block },
        },
        artifacts: [],
      };
      span.close("tool.failed", {
        ...blocked,
        toolName: requestedCall.toolName,
      });
      this.usageTracker.recordToolUsage({
        toolName: requestedCall.toolName,
        status: blocked.status,
      });
      this.recordToolResult(
        state.context,
        requestedCall.toolName,
        blocked,
        recordingOptions,
      );
      await this.runAfterToolCallHook(state, requestedCall, blocked);
      return undefined;
    }
    for (const rewrite of preToolHooks.rewrites) {
      if ("arguments" in rewrite) {
        requestedCall = {
          ...requestedCall,
          arguments: rewrite.arguments,
        };
      }
    }

    const toolBudgetFailure = this.reserveToolCallBudget({
      step: state.step,
      toolName: requestedCall.toolName,
    });
    if (toolBudgetFailure) return toolBudgetFailure;

    // A repeat is either the *same* call verbatim, or a fresh attempt at a
    // target that just failed — the latter catches a model that varies cosmetic
    // arguments (e.g. read `offset`/`limit`) while hammering the same broken
    // path. `lastFailedToolTarget` is cleared on any success, so legitimate
    // pagination never lands here.
    const targetKey = semanticToolTarget(
      requestedCall.toolName,
      requestedCall.arguments,
    );
    const priorFailure =
      state.lastFailedToolTarget?.key === targetKey
        ? state.lastFailedToolTarget
        : undefined;
    const priorNoop =
      state.lastNoopToolTarget?.key === targetKey
        ? state.lastNoopToolTarget
        : undefined;
    const verbatimRepeat = isRepeatedToolCall(
      state.previousToolCall,
      requestedCall,
    );
    // An idempotent tool repeating verbatim is a harmless no-op — it returns the
    // same result with no side effect (e.g. rewriting an unchanged todo ledger)
    // — not the start of a doom loop. Such tools carry their own no-op handling
    // that course-corrects the model, so the generic repeat guard must defer to
    // them rather than burning a turn on REPEATED_TOOL_CALL_SKIPPED. A repeated
    // *failure* or explicit no-progress result on the same target still counts
    // even for idempotent tools, so the exemption requires no remembered
    // failure/no-op target.
    const benignIdempotentRepeat =
      verbatimRepeat &&
      !priorFailure &&
      !priorNoop &&
      this.tools.get(requestedCall.toolName)?.governance?.idempotency ===
        "idempotent";
    if (
      (verbatimRepeat || priorFailure || priorNoop) &&
      !benignIdempotentRepeat
    ) {
      state.repeatedToolCallCount += 1;
    } else {
      state.previousToolCall = requestedCall;
      state.repeatedToolCallCount = 1;
    }

    if (state.repeatedToolCallCount >= 2) {
      const signalHooks = await this.runWorkflowHookPhase(
        "RuntimeSignal",
        {
          signal:
            state.repeatedToolCallCount >= this.doomLoopRepeatLimit
              ? "doom_loop"
              : "repeated_tool_call",
          toolName: requestedCall.toolName,
          arguments: requestedCall.arguments,
          repeatedToolCallCount: state.repeatedToolCallCount,
          repeatLimit: this.doomLoopRepeatLimit,
          priorFailure,
          priorNoop,
        },
        {
          step: state.step,
          signal:
            state.repeatedToolCallCount >= this.doomLoopRepeatLimit
              ? "doom_loop"
              : "repeated_tool_call",
          toolName: requestedCall.toolName,
        },
        state.step,
      );
      if (signalHooks.status === "blocked") {
        return this.failWorkflowHookBlock("hook_stopped", signalHooks.block, {
          toolName: requestedCall.toolName,
          arguments: requestedCall.arguments,
          repeatedToolCallCount: state.repeatedToolCallCount,
          repeatLimit: this.doomLoopRepeatLimit,
        });
      }
      if (signalHooks.context.length > 0) {
        state.context.push(...signalHooks.context);
      }
    }

    if (state.repeatedToolCallCount >= this.doomLoopRepeatLimit) {
      return this.fail(
        "tool_doom_loop",
        "TOOL_DOOM_LOOP",
        priorFailure
          ? `Run stopped after ${state.repeatedToolCallCount} attempts at ` +
              `\`${requestedCall.toolName}\` on the same target, which kept ` +
              `failing (${priorFailure.code}: ${priorFailure.message}).`
          : `Run stopped after ${state.repeatedToolCallCount} repeated identical tool calls.`,
        {
          toolName: requestedCall.toolName,
          arguments: requestedCall.arguments,
          repeatedToolCallCount: state.repeatedToolCallCount,
          repeatLimit: this.doomLoopRepeatLimit,
          ...(priorFailure ? { repeatedFailureCode: priorFailure.code } : {}),
          ...(priorNoop ? { repeatedNoopCode: priorNoop.code } : {}),
        },
      );
    }

    const call = createToolCall(
      this.record.id,
      requestedCall.toolName,
      requestedCall.arguments,
    );
    // Open a span for this individual call: `tool.requested` is the start,
    // `tool.completed`/`tool.failed` the end (emitted via `span.close`), and
    // the whole body runs inside `runWithSpan` so `tool.started` plus the
    // tool's own `workspace.read`/`tool.progress` events inherit this frame and
    // nest under the call — which itself nests under the enclosing batch span.
    const span = openSpan(this.events, {
      startType: "tool.requested",
      payload: this.toolRequestedPayload(call, requestedCall),
    });

    if (executionDiagnostic?.duplicateKind === "in_flight_duplicate") {
      return runWithSpan(span.frame, () =>
        this.emitInFlightDuplicateToolCall(
          call,
          requestedCall,
          state,
          recordingOptions,
          span,
        ),
      );
    }

    // One step before the hard doom-loop stop, skip the (redundant) execution
    // and feed back a corrective tool result instead. A repeated identical call
    // cannot produce new information, so re-running it wastes a step; weaker
    // models in particular loop silently because nothing tells them they are
    // repeating. This gives the model exactly one chance to course-correct
    // before `repeatedToolCallCount >= doomLoopRepeatLimit` ends the run above.
    // The condition `=== limit - 1` is reached at most once per identical
    // streak, so the nudge fires exactly once (and never on a first call, since
    // it also requires the count to be a genuine repeat, `>= 2`).
    if (
      state.repeatedToolCallCount >= 2 &&
      state.repeatedToolCallCount === this.doomLoopRepeatLimit - 1
    ) {
      return runWithSpan(span.frame, () =>
        this.emitRepeatedToolCallNudge(
          call,
          requestedCall,
          state,
          recordingOptions,
          span,
          priorFailure,
          priorNoop,
        ),
      );
    }

    return runWithSpan(span.frame, () =>
      this.runToolCallInSpan(
        call,
        requestedCall,
        state,
        recordingOptions,
        span,
      ),
    );
  }

  private toolRequestedPayload(
    call: ReturnType<typeof createToolCall>,
    requestedCall: RequestedToolCall,
  ): ReturnType<typeof createToolCall> & { preview?: string } {
    const requestPreview = formatToolRequestPreview(
      this.tools.get(requestedCall.toolName),
      requestedCall.arguments,
    );
    return {
      ...call,
      ...(requestPreview ? { preview: requestPreview } : {}),
    };
  }

  /**
   * Skip a duplicate requested in the same concurrent batch while the first
   * identical call is still outstanding. The caller has already counted the
   * repeated request for same-turn doom-loop detection; this result only avoids
   * the misleading completed-result wording and does not mark the semantic
   * target as failed/no-op for next-turn bookkeeping.
   */
  private async emitInFlightDuplicateToolCall(
    call: ReturnType<typeof createToolCall>,
    requestedCall: RequestedToolCall,
    state: RunLoopState,
    recordingOptions: ToolResultRecordingOptions,
    span: ReturnType<typeof openSpan>,
  ): Promise<RunResult | undefined> {
    const skipped: ToolResult = {
      toolCallId: call.id,
      status: "failed",
      error: {
        code: "DUPLICATE_TOOL_CALL_SKIPPED",
        message:
          `Skipped: \`${requestedCall.toolName}\` was already requested ` +
          "with identical arguments in this concurrent batch and is still " +
          "running. Wait for that result before deciding whether to call it " +
          "again.",
        metadata: {
          duplicateKind: "in_flight_duplicate",
        },
      },
      artifacts: [],
    };
    span.close("tool.failed", {
      ...skipped,
      toolName: requestedCall.toolName,
    });
    this.usageTracker.recordToolUsage({
      toolName: requestedCall.toolName,
      status: skipped.status,
    });
    this.recordToolResult(
      state.context,
      requestedCall.toolName,
      skipped,
      recordingOptions,
    );
    await this.runAfterToolCallHook(state, requestedCall, skipped);
    return undefined;
  }

  /**
   * Skip a repeated identical tool call and surface a corrective result instead
   * of executing it. True failures remain failed results; idempotent no-progress
   * repeats are completed no-op results so traces do not invent a tool failure.
   * Both paths close the span, record usage, append context, run after-hooks,
   * and push to the current batch so the model sees the feedback on its next
   * turn. Returns `undefined` so the run continues; the hard doom-loop stop in
   * `processToolCall` still fires if the model repeats the call again.
   */
  private async emitRepeatedToolCallNudge(
    call: ReturnType<typeof createToolCall>,
    requestedCall: RequestedToolCall,
    state: RunLoopState,
    recordingOptions: ToolResultRecordingOptions,
    span: ReturnType<typeof openSpan>,
    priorFailure?: RunLoopState["lastFailedToolTarget"],
    priorNoop?: RunLoopState["lastNoopToolTarget"],
  ): Promise<RunResult | undefined> {
    if (priorNoop && !priorFailure) {
      const nudged: ToolResult = {
        toolCallId: call.id,
        status: "completed",
        output: {
          saved: false,
          changed: false,
          skipped: true,
          reason: "repeated_idempotent_noop",
          hint:
            `Skipped: \`${requestedCall.toolName}\` already completed ` +
            `without making progress on this target (${priorNoop.code}: ` +
            `${priorNoop.message}). Repeating it cannot produce new ` +
            `information. Choose a different concrete action, or answer the ` +
            `user directly if the work is done. Repeating this exact call ` +
            `again will end the run.`,
        },
        artifacts: [],
      };
      span.close("tool.completed", {
        ...nudged,
        toolName: requestedCall.toolName,
      });
      this.usageTracker.recordToolUsage({
        toolName: requestedCall.toolName,
        status: nudged.status,
      });
      this.recordToolResult(
        state.context,
        requestedCall.toolName,
        nudged,
        recordingOptions,
      );
      await this.runAfterToolCallHook(state, requestedCall, nudged);
      return undefined;
    }

    const nudged: ToolResult = {
      toolCallId: call.id,
      status: "failed",
      error: {
        code: "REPEATED_TOOL_CALL_SKIPPED",
        message: repeatedToolCallNudgeMessage(
          requestedCall.toolName,
          priorFailure,
        ),
        ...(priorFailure
          ? { metadata: repeatedToolCallNudgeMetadata(priorFailure) }
          : {}),
      },
      artifacts: [],
    };
    // Carry `toolName` on the event payload (the `nudged` ToolResult omits it)
    // so UIs can name the skipped call instead of rendering a generic "tool".
    span.close("tool.failed", { ...nudged, toolName: requestedCall.toolName });
    this.usageTracker.recordToolUsage({
      toolName: requestedCall.toolName,
      status: nudged.status,
    });
    this.recordToolResult(
      state.context,
      requestedCall.toolName,
      nudged,
      recordingOptions,
    );
    await this.runAfterToolCallHook(state, requestedCall, nudged);
    return undefined;
  }

  /**
   * Execute a tool call whose span is already open. Runs inside
   * `runWithSpan(span.frame, …)` so every event it emits (directly or via the
   * tool implementation) is correlated to the call. Each terminal path closes
   * the span exactly once through `span.close`.
   */
  private async runToolCallInSpan(
    call: ReturnType<typeof createToolCall>,
    requestedCall: RequestedToolCall,
    state: RunLoopState,
    recordingOptions: ToolResultRecordingOptions,
    span: ReturnType<typeof openSpan>,
  ): Promise<RunResult | undefined> {
    const timings: ToolStageTimings = {};
    // beforeToolCall hook: may return { skip } to synthesize a failed result.
    let hookDecision: ToolCallHookDecision | undefined;
    try {
      const result = await this.hook.beforeToolCall?.({
        runId: this.record.id,
        step: state.step,
        toolName: requestedCall.toolName,
        arguments: requestedCall.arguments,
      });
      hookDecision = result ?? undefined;
    } catch (err) {
      // combineRunHooks already logs; emit a hook.failed event for traceability.
      this.events.emit("hook.failed", {
        phase: "beforeToolCall",
        toolName: requestedCall.toolName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (hookDecision?.skip) {
      const skipped: ToolResult = {
        toolCallId: call.id,
        status: "failed",
        error: {
          code: "TOOL_SKIPPED_BY_HOOK",
          message: hookDecision.skip.reason,
        },
        artifacts: [],
      };
      span.close(
        "tool.failed",
        {
          ...skipped,
          toolName: requestedCall.toolName,
        },
        this.toolTimingMetadata(timings),
      );
      this.usageTracker.recordToolUsage({
        toolName: requestedCall.toolName,
        status: skipped.status,
      });
      this.recordToolResult(
        state.context,
        requestedCall.toolName,
        skipped,
        recordingOptions,
      );
      await this.runAfterToolCallHook(state, requestedCall, skipped);
      return undefined;
    }

    const validationResult = this.validateToolCall(
      call.id,
      requestedCall.toolName,
      requestedCall.arguments,
      timings,
      recordingOptions.loadedDeferredToolsAtTurnStart,
    );
    if (validationResult) {
      span.close(
        "tool.failed",
        {
          ...validationResult,
          toolName: requestedCall.toolName,
        },
        this.toolTimingMetadata(timings),
      );
      this.usageTracker.recordToolUsage({
        toolName: requestedCall.toolName,
        status: validationResult.status,
      });
      this.recordToolResult(
        state.context,
        requestedCall.toolName,
        validationResult,
        recordingOptions,
      );
      await this.runAfterToolCallHook(state, requestedCall, validationResult);
      return undefined;
    }

    const inputValidationResult = await this.validateToolInput(
      call.id,
      requestedCall.toolName,
      requestedCall.arguments,
      timings,
    );
    if (inputValidationResult) {
      span.close(
        "tool.failed",
        {
          ...inputValidationResult,
          toolName: requestedCall.toolName,
        },
        this.toolTimingMetadata(timings),
      );
      this.usageTracker.recordToolUsage({
        toolName: requestedCall.toolName,
        status: inputValidationResult.status,
      });
      this.recordToolResult(
        state.context,
        requestedCall.toolName,
        inputValidationResult,
        recordingOptions,
      );
      await this.runAfterToolCallHook(
        state,
        requestedCall,
        inputValidationResult,
      );
      return undefined;
    }

    const gatedResult = await this.checkToolGate(
      call.id,
      requestedCall.toolName,
      requestedCall.arguments,
      timings,
    );
    if (gatedResult) {
      span.close(
        "tool.failed",
        {
          ...gatedResult,
          toolName: requestedCall.toolName,
        },
        this.toolTimingMetadata(timings),
      );
      this.usageTracker.recordToolUsage({
        toolName: requestedCall.toolName,
        status: gatedResult.status,
      });
      this.recordToolResult(
        state.context,
        requestedCall.toolName,
        gatedResult,
        recordingOptions,
      );
      await this.runAfterToolCallHook(state, requestedCall, gatedResult);
      return undefined;
    }

    if (this.abortController.signal.aborted) {
      const aborted: ToolResult = {
        toolCallId: call.id,
        status: "cancelled",
        error: {
          code: "TOOL_ABORTED",
          message: `Tool aborted before execution: ${requestedCall.toolName}`,
        },
        artifacts: [],
      };
      span.close(
        "tool.failed",
        {
          ...aborted,
          toolName: requestedCall.toolName,
        },
        this.toolTimingMetadata(timings),
      );
      this.usageTracker.recordToolUsage({
        toolName: requestedCall.toolName,
        status: aborted.status,
      });
      this.recordToolResult(
        state.context,
        requestedCall.toolName,
        aborted,
        recordingOptions,
      );
      await this.runAfterToolCallHook(state, requestedCall, aborted);
      return undefined;
    }

    emitInSpan(this.events, "tool.started", {
      toolCallId: call.id,
      toolName: call.toolName,
    });
    const executionStartedAt = Date.now();
    const result = await executeTool(
      this.tools,
      call,
      this.createRuntimeContext({
        toolCallId: call.id,
        toolName: call.toolName,
      }),
      {
        timeoutMs: this.toolTimeoutMs,
        abortSignal: this.abortController.signal,
      },
    );
    timings.executionMs = elapsedMs(executionStartedAt);
    const checkedResult = await this.applyToolResultValidation(
      requestedCall.toolName,
      result,
      {
        step: state.step,
      },
      timings,
    );
    const normalizedResult =
      requestedCall.toolName === "skill_load"
        ? this.normalizeSkillLoadResult(checkedResult)
        : checkedResult;
    const annotatedResult =
      normalizedResult.status === "failed"
        ? this.annotateReplayRiskOnFailure(call.toolName, normalizedResult)
        : normalizedResult;
    span.close(
      annotatedResult.status === "completed" ? "tool.completed" : "tool.failed",
      { ...annotatedResult, toolName: requestedCall.toolName },
      this.toolTimingMetadata(timings),
    );
    if (requestedCall.toolName === "skill_load") {
      this.emitSkillEventFromToolResult(annotatedResult);
    }
    if (requestedCall.toolName === "tool_search") {
      this.loadDeferredToolsFromToolSearch(annotatedResult);
    }
    this.usageTracker.recordToolUsage({
      toolName: requestedCall.toolName,
      status: annotatedResult.status,
    });
    this.recordToolResult(
      state.context,
      requestedCall.toolName,
      annotatedResult,
      recordingOptions,
    );
    await this.runAfterToolCallHook(state, requestedCall, annotatedResult);
    return undefined;
  }

  private normalizeSkillLoadResult(result: ToolResult): ToolResult {
    if (result.status !== "completed" || !isRecord(result.output)) {
      return result;
    }
    const status = getStringProperty(result.output, "status");
    if (
      status !== "not_found" &&
      status !== "resource_not_found" &&
      status !== "resource_denied"
    ) {
      return result;
    }
    const name =
      getStringProperty(result.output, "name") ??
      getStringProperty(result.output, "requestedName");
    const resource = getStringProperty(result.output, "resource");
    const message =
      getStringProperty(result.output, "message") ??
      (name
        ? `Skill load failed for ${name}: ${status}`
        : `Skill load failed: ${status}`);
    return {
      toolCallId: result.toolCallId,
      status: "failed",
      error: {
        code: "SKILL_LOAD_FAILED",
        message,
        metadata: omitUndefined({
          skillName: name,
          skillLoadStatus: status,
          resource,
        }),
      },
      artifacts: result.artifacts,
    };
  }

  private emitSkillEventFromToolResult(result: ToolResult): void {
    if (result.status === "failed") {
      const metadata = isRecord(result.error?.metadata)
        ? result.error.metadata
        : {};
      const name = getStringProperty(metadata, "skillName");
      if (!name) return;
      this.events.emit(
        "skill.failed",
        {
          toolCallId: result.toolCallId,
          name,
          message: result.error?.message ?? "Skill load failed.",
          status:
            getStringProperty(metadata, "skillLoadStatus") ?? "load_failed",
          resource: getStringProperty(metadata, "resource"),
        },
        {
          sourcePackage: "@sparkwright/skills",
          mode: "on_demand_tool",
          phase: "load",
        },
      );
      return;
    }

    if (result.status !== "completed" || !isRecord(result.output)) return;
    if (result.output.status !== "loaded") return;
    const name = getStringProperty(result.output, "name");
    if (!name) return;

    // sourcePath/contentHash are intentionally not echoed here: the on-demand
    // skill_load result no longer carries them (they are absolute host paths
    // the model cannot use). The same provenance is available on the
    // skill.indexed event, joined by skill name.
    this.events.emit(
      "skill.loaded",
      { name, status: "loaded" },
      {
        sourcePackage: "@sparkwright/skills",
        mode: "on_demand_tool",
        version: getStringProperty(result.output, "version"),
      },
    );
  }

  private loadDeferredToolsFromToolSearch(result: ToolResult): void {
    if (result.status !== "completed" || !isRecord(result.output)) return;
    const matches = result.output.matches;
    if (!Array.isArray(matches)) return;
    for (const match of matches) {
      if (!isRecord(match)) continue;
      const name = getStringProperty(match, "name");
      if (!name) continue;
      const tool = this.tools.get(name);
      if (!tool?.deferLoading || tool.alwaysLoad === true) continue;
      this.loadedDeferredTools.add(name);
    }
  }

  /**
   * If a non-replay-safe tool failed with a network-class error, annotate
   * the result and emit `tool.replay_risk` *before* the canonical
   * `tool.failed` event. Hosts that see the warning can pause the run
   * (e.g. ask the user) rather than letting the model silently re-issue a
   * call that may already have produced an external side effect.
   *
   * Read-only / idempotent tools (`isReplaySafe: true`) and tools that
   * declare nothing (legacy) skip this annotation to preserve existing
   * behavior.
   */
  private annotateReplayRiskOnFailure(
    toolName: string,
    result: ToolResult,
  ): ToolResult {
    const tool = this.tools.get(toolName);
    if (!tool || tool.isReplaySafe !== false) return result;
    if (!isLikelySideEffectFailure(result.error)) return result;

    const replayRisk = "side_effect_may_have_landed";
    this.events.emit("tool.replay_risk", {
      toolCallId: result.toolCallId,
      toolName,
      replayRisk,
      reason: result.error?.message ?? "Tool failed mid-execution.",
    });

    const existingMetadata = result.error?.metadata ?? {};
    return {
      ...result,
      error: result.error
        ? {
            ...result.error,
            metadata: { ...existingMetadata, replayRisk },
          }
        : result.error,
    };
  }

  private async awaitCredentialRefresh(
    modelError: ModelErrorEnvelope,
    message: string,
    step: number,
  ): Promise<boolean> {
    if (!this.credentialResolver) return false;
    const category = modelError.category as "auth" | "quota";
    const previousState = this.record.state;
    this.setState("waiting_credentials");
    this.events.emit("run.waiting_credentials", {
      step,
      category,
      message,
      providerCode: modelError.providerCode,
      status: modelError.status,
    });
    try {
      const response = await this.credentialResolver({
        category,
        message,
        modelError,
        attempt: 1,
      });
      if (!response.refreshed) {
        // Failed to refresh — fall back to the normal fail() path. Move
        // through `running` so the subsequent `fail()` call's state
        // transition (`waiting_credentials` -> `failed` is allowed) does
        // not surprise downstream observers expecting running -> failed.
        this.setState("running");
        return false;
      }
      this.setState("running");
      this.events.emit("run.credentials_refreshed", {
        step,
        category,
        metadata: response.metadata ?? {},
      });
      return true;
    } catch (cause) {
      // Resolver itself threw — surface as failure path; the loop's outer
      // catch will record a model failure with the original cause's reason.
      // Restore state so the subsequent fail() transition is valid.
      if (this.record.state === "waiting_credentials") {
        this.setState("running");
      }
      console.warn(
        `[sparkwright] credentialResolver threw: ${cause instanceof Error ? cause.message : String(cause)}; falling back to failure path.`,
      );
      // Restore the original record.state if we somehow overshot.
      if (previousState !== this.record.state && previousState === "running") {
        // best-effort; no-op if already running
      }
      return false;
    }
  }

  private async runAfterToolCallHook(
    state: RunLoopState,
    requestedCall: RequestedToolCall,
    result: ToolResult,
  ): Promise<void> {
    // Loop-guard bookkeeping: remember the semantic target of a failure so a
    // retry with cosmetically different arguments still counts as a repeat, and
    // forget it on any progress so legitimate work resets the guard. Idempotent
    // tools can also complete with an explicit no-op result (for example an
    // unchanged todo_write ledger); treat that as non-progress so repeated
    // no-op bookkeeping can use the same nudge/doom-loop path without blocking
    // the first harmless no-op.
    if (isInFlightDuplicateToolResult(result)) {
      // Same-batch duplicate diagnostics are advisory; they do not mean the
      // target failed or made no progress, so they must not feed doom-loop
      // bookkeeping for the next turn.
    } else if (result.status === "failed") {
      state.lastFailedToolTarget = {
        key: semanticToolTarget(
          requestedCall.toolName,
          requestedCall.arguments,
        ),
        code: result.error?.code ?? "TOOL_FAILED",
        message: result.error?.message ?? "Tool call failed.",
        ...toolFailureContext(result),
      };
      state.lastNoopToolTarget = undefined;
    } else if (
      result.status === "completed" &&
      this.tools.get(requestedCall.toolName)?.governance?.idempotency ===
        "idempotent" &&
      isIdempotentNoopToolResult(result)
    ) {
      const output = isRecord(result.output) ? result.output : undefined;
      state.lastFailedToolTarget = undefined;
      state.lastNoopToolTarget = {
        key: semanticToolTarget(
          requestedCall.toolName,
          requestedCall.arguments,
        ),
        code: "IDEMPOTENT_NOOP",
        message:
          (output ? getStringProperty(output, "hint") : undefined) ??
          "Tool completed without making progress.",
      };
    } else if (result.status === "completed") {
      state.lastFailedToolTarget = undefined;
      state.lastNoopToolTarget = undefined;
    }
    try {
      await this.hook.afterToolCall?.({
        runId: this.record.id,
        step: state.step,
        toolName: requestedCall.toolName,
        arguments: requestedCall.arguments,
        result,
      });
    } catch (err) {
      this.events.emit("hook.failed", {
        phase: "afterToolCall",
        toolName: requestedCall.toolName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    const postToolHooks = await this.runWorkflowHookPhase(
      "PostToolUse",
      {
        toolName: requestedCall.toolName,
        arguments: requestedCall.arguments,
        path: extractWorkflowPath(requestedCall.arguments),
        status: result.status,
        result,
      },
      {
        step: state.step,
        toolName: requestedCall.toolName,
        path: extractWorkflowPath(requestedCall.arguments),
        status: result.status,
      },
      state.step,
    );
    if (postToolHooks.status === "blocked") {
      state.context.push(
        this.formatWorkflowHookBlockContinuation(
          "PostToolUse",
          postToolHooks.block,
          state.step,
        ),
      );
    }
    if (postToolHooks.context.length > 0) {
      state.context.push(...postToolHooks.context);
    }
    for (const feedback of this.runHealth.consumeFeedback()) {
      state.context.push(
        this.formatRunHealthFeedbackContext(feedback, state.step),
      );
    }
  }

  private validateToolCall(
    toolCallId: ToolResult["toolCallId"],
    toolName: string,
    args: unknown,
    timings?: ToolStageTimings,
    loadedDeferredToolsForModelTurn: ReadonlySet<string> = this
      .loadedDeferredTools,
  ): ToolResult | undefined {
    const startedAt = Date.now();
    const tool = this.tools.get(toolName);

    try {
      if (!tool) {
        return {
          toolCallId,
          status: "failed",
          error: {
            code: "TOOL_NOT_FOUND",
            message: `Tool not found: ${toolName}`,
            metadata: { toolName },
          },
          artifacts: [],
        };
      }

      const validationError = validateToolArguments(tool.inputSchema, args);
      if (!validationError) return undefined;

      const schemaNotLoaded =
        tool.deferLoading === true &&
        tool.alwaysLoad !== true &&
        !loadedDeferredToolsForModelTurn.has(tool.name);
      const recoveryMetadata = schemaNotLoaded
        ? {
            reason: "schema_not_loaded",
            recoveryTool: "tool_search",
            recoveryQuery: `select:${toolName}`,
            deferred: true,
            schemaLoaded: false,
          }
        : {};
      const recoveryMessage = schemaNotLoaded
        ? ` The schema for deferred tool \`${toolName}\` has not been loaded in this run. First call \`tool_search\` with query \`select:${toolName}\` to load the schema, then retry the tool call.`
        : "";

      return {
        toolCallId,
        status: "failed",
        error: {
          ...validationError,
          message: `${validationError.message}${recoveryMessage}`,
          metadata: {
            ...(validationError.metadata ?? {}),
            toolName,
            ...recoveryMetadata,
          },
        },
        artifacts: [],
      };
    } finally {
      if (timings) timings.schemaValidationMs = elapsedMs(startedAt);
    }
  }

  private async validateToolInput(
    toolCallId: ToolResult["toolCallId"],
    toolName: string,
    args: unknown,
    timings?: ToolStageTimings,
  ): Promise<ToolResult | undefined> {
    const tool = this.tools.get(toolName);
    if (!tool?.validateInput) return undefined;

    const startedAt = Date.now();
    try {
      const validation = await tool.validateInput(
        args as never,
        this.createValidationRuntimeContext({
          toolCallId,
          toolName,
        }) as never,
      );
      if (validation.ok) return undefined;
      return {
        toolCallId,
        status: "failed",
        error: {
          code: validation.code ?? "TOOL_ARGUMENTS_INVALID",
          message: validation.message,
          metadata: {
            ...(validation.metadata ?? {}),
            toolName,
            phase: "validateInput",
          },
        },
        artifacts: [],
      };
    } catch (cause) {
      const error = normalizeToolError(cause, {
        code: "TOOL_ARGUMENTS_INVALID",
        message: "Tool input validation failed.",
      });
      return {
        toolCallId,
        status: "failed",
        error: {
          ...error,
          metadata: {
            ...(error.metadata ?? {}),
            toolName,
            phase: "validateInput",
          },
        },
        artifacts: [],
      };
    } finally {
      if (timings) timings.inputValidationMs = elapsedMs(startedAt);
    }
  }

  private async checkToolGate(
    toolCallId: ToolResult["toolCallId"],
    toolName: string,
    args: unknown,
    timings?: ToolStageTimings,
  ): Promise<ToolResult | undefined> {
    const tool = this.tools.get(toolName);

    if (!tool) return undefined;

    let argPolicy:
      | ReturnType<NonNullable<typeof tool.policyForArgs>>
      | undefined;
    const policyForArgsStartedAt = Date.now();
    try {
      argPolicy = tool.policyForArgs?.(args as never);
    } catch (cause) {
      if (timings) timings.policyForArgsMs = elapsedMs(policyForArgsStartedAt);
      const error = normalizeToolError(cause, {
        code: "TOOL_ARGUMENTS_INVALID",
        message: "Tool argument policy failed.",
      });
      return {
        toolCallId,
        status: "failed",
        error: {
          ...error,
          metadata: {
            ...(error.metadata ?? {}),
            toolName,
            phase: "policyForArgs",
          },
        },
        artifacts: [],
      };
    }
    if (timings) timings.policyForArgsMs = elapsedMs(policyForArgsStartedAt);
    const effectivePolicy = argPolicy?.policy ?? tool.policy;
    const effectiveGovernance = argPolicy?.governance ?? tool.governance;
    const risk = effectivePolicy?.risk ?? "safe";
    const metadata = {
      toolName,
      risk,
      governance: effectiveGovernance,
      toolOrigin: effectiveGovernance?.origin,
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

    const policyDecisionStartedAt = Date.now();
    const decision = await this.policy.decide({
      action: "tool.execute",
      resource: {
        kind: "tool",
        name: toolName,
        metadata: {
          risk,
          governance: effectiveGovernance,
          toolOrigin: effectiveGovernance?.origin,
        },
      },
      metadata,
    });
    if (timings) timings.policyDecisionMs = elapsedMs(policyDecisionStartedAt);

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
      effectivePolicy?.requiresApproval === true ||
      decision.decision === "requires_approval"
    ) {
      let approved = false;

      const approvalStartedAt = Date.now();
      try {
        approved = await this.requestApproval({
          action: "tool.execute",
          summary: `Run tool ${toolName}`,
          details: {
            ...metadata,
            arguments: args,
            policy: decision,
          },
        });
        if (timings) timings.approvalWaitMs = elapsedMs(approvalStartedAt);
      } catch (cause) {
        if (timings) timings.approvalWaitMs = elapsedMs(approvalStartedAt);
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

  private appendToolResultContext(
    context: ContextItem[],
    toolName: string,
    result: ToolResult,
  ): void {
    context.push(
      this.observationFormatter.format({
        toolName,
        result,
        run: this.record,
      }),
    );
  }

  private recordToolResult(
    context: ContextItem[],
    toolName: string,
    result: ToolResult,
    options: ToolResultRecordingOptions,
  ): void {
    if (options.appendContext === false) {
      options.deferredObservations?.push({
        originalIndex: options.originalIndex ?? 0,
        sequence: options.deferredObservations.length,
        toolName,
        result,
      });
      return;
    }
    this.appendToolResultContext(context, toolName, result);
    options.batchResults?.push(result);
  }

  private flushDeferredToolObservations(
    context: ContextItem[],
    batchResults: ToolResult[],
    observations: DeferredToolObservation[],
  ): void {
    observations
      .slice()
      .sort(
        (left, right) =>
          left.originalIndex - right.originalIndex ||
          left.sequence - right.sequence,
      )
      .forEach((observation) => {
        this.appendToolResultContext(
          context,
          observation.toolName,
          observation.result,
        );
        batchResults.push(observation.result);
      });
  }

  private toolTimingMetadata(
    timings: ToolStageTimings,
  ): Record<string, unknown> | undefined {
    const metadata = omitUndefined({
      schemaValidationMs: timings.schemaValidationMs,
      inputValidationMs: timings.inputValidationMs,
      policyForArgsMs: timings.policyForArgsMs,
      policyDecisionMs: timings.policyDecisionMs,
      approvalWaitMs: timings.approvalWaitMs,
      executionMs: timings.executionMs,
      resultValidationMs: timings.resultValidationMs,
    });
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private formatValidationFailureContext(
    validationFailure: ValidationFailure,
    step: number,
  ): ContextItem {
    return {
      id: (this.loopServices.createContextItemId ?? createContextItemId)(),
      type: "summary",
      source: {
        kind: "validation",
        uri: validationFailure.hookName,
      },
      content: JSON.stringify({
        stage: "final_output",
        status: "failed",
        message: validationFailureMessage(validationFailure),
        result: validationFailure.result,
      }),
      metadata: {
        layer: "working",
        stability: "turn",
        step,
        validationContinuation: true,
        hookName: validationFailure.hookName,
      },
    };
  }

  private formatRunHealthFeedbackContext(
    feedback: RunHealthFeedback,
    step: number,
  ): ContextItem {
    return {
      id: (this.loopServices.createContextItemId ?? createContextItemId)(),
      type: "summary",
      source: {
        kind: "runtime",
        uri: "run.health",
      },
      content: feedback.message,
      metadata: {
        layer: "working",
        stability: "turn",
        runHealth: true,
        code: feedback.code,
        toolName: feedback.toolName,
        path: feedback.path,
        count: feedback.count,
        ...(feedback.nextUnreadOffset !== undefined
          ? { nextUnreadOffset: feedback.nextUnreadOffset }
          : {}),
        step,
        ...(feedback.currentToolCallId
          ? { toolCallId: feedback.currentToolCallId }
          : {}),
        ...(feedback.previousToolCallId
          ? { previousToolCallId: feedback.previousToolCallId }
          : {}),
      },
    };
  }

  private async applyToolResultValidation(
    toolName: string,
    result: ToolResult,
    metadata: Record<string, unknown>,
    timings?: ToolStageTimings,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const validationFailure = await this.runValidation("tool_result", result, {
      ...metadata,
      toolName,
      toolCallId: result.toolCallId,
      status: result.status,
    });
    if (timings) timings.resultValidationMs = elapsedMs(startedAt);
    if (!validationFailure) return result;

    return {
      toolCallId: result.toolCallId,
      status: "failed",
      error: {
        code: "VALIDATION_FAILED",
        message: validationFailureMessage(validationFailure),
        metadata: {
          stage: "tool_result",
          validation: validationFailure,
        },
      },
      artifacts: result.artifacts,
    };
  }

  private runValidation(
    stage: Parameters<typeof runValidationHooks>[0]["stage"],
    subject: unknown,
    metadata: Record<string, unknown>,
  ): Promise<ValidationFailure | undefined> {
    return runValidationHooks({
      hooks: this.validationHooks,
      stage,
      run: this.record,
      subject,
      metadata,
      events: this.events,
    });
  }

  private runWorkflowHookPhase<TPayload>(
    hook: WorkflowHookName,
    payload: TPayload,
    metadata: Record<string, unknown>,
    step?: number,
  ): Promise<WorkflowHookExecution> {
    return runWorkflowHooks({
      hooks: this.workflowHooks,
      hook,
      run: this.record,
      step,
      payload,
      metadata,
      events: this.events,
    });
  }

  private kickWorkflowHookPhase<TPayload>(
    hook: WorkflowHookName,
    payload: TPayload,
    metadata: Record<string, unknown> = {},
    step?: number,
  ): void {
    void this.runWorkflowHookPhase(hook, payload, metadata, step);
  }

  private failWorkflowHookBlock(
    reason: Extract<RunStopReason, "hook_stopped">,
    block: WorkflowHookBlock,
    metadata: Record<string, unknown> = {},
  ): RunResult {
    return this.fail(
      reason,
      "WORKFLOW_HOOK_BLOCKED",
      workflowHookBlockMessage(block),
      {
        ...metadata,
        workflowHook: block,
      },
    );
  }

  private reserveToolCallBudget(metadata: {
    step: number;
    toolName: string;
  }): RunResult | undefined {
    if (
      this.runBudget?.maxToolCalls !== undefined &&
      this.budgetUsage.toolCalls >= this.runBudget.maxToolCalls
    ) {
      return this.fail(
        "max_tool_calls_exceeded",
        "MAX_TOOL_CALLS_EXCEEDED",
        `Run exceeded the maximum tool call count of ${this.runBudget.maxToolCalls}.`,
        {
          ...metadata,
          budget: this.runBudget,
          usage: this.currentBudgetUsage(),
        },
      );
    }

    this.budgetUsage.toolCalls += 1;
    this.emitBudgetChecked("tool_call_reserved", metadata);
    return this.checkRunBudget("tool_call_reserved", metadata);
  }

  private reserveModelCallBudget(metadata: {
    step: number;
    attempt: number;
  }): void {
    if (
      this.runBudget?.maxModelCalls !== undefined &&
      this.budgetUsage.modelCalls >= this.runBudget.maxModelCalls
    ) {
      throw new RunBudgetExceededError(
        "max_model_calls_exceeded",
        "MAX_MODEL_CALLS_EXCEEDED",
        `Run exceeded the maximum model call count of ${this.runBudget.maxModelCalls}.`,
        {
          ...metadata,
          budget: this.runBudget,
          usage: this.currentBudgetUsage(),
        },
      );
    }

    this.budgetUsage.modelCalls += 1;
    this.emitBudgetChecked("model_call_reserved", metadata);
  }

  /**
   * Project the live usage tracker snapshot into the small {@link
   * ContextUsageHint} consumed by cost-aware compaction. Computes
   * `contextWindowPressure` from the most recent call's input tokens against
   * the active model's declared context window, when both are known.
   */
  private buildUsageHint(): ContextUsageHint {
    const snapshot = this.usageTracker.snapshot();
    const windowTokens = this.activeModel().contextHints?.contextWindowTokens;
    const lastInputTokens = this.lastModelInputTokens;
    const contextWindowPressure =
      typeof windowTokens === "number" &&
      windowTokens > 0 &&
      typeof lastInputTokens === "number"
        ? Math.min(1, Math.max(0, lastInputTokens / windowTokens))
        : undefined;
    return {
      inputTokens: snapshot.tokens.input,
      outputTokens: snapshot.tokens.output,
      totalTokens: snapshot.tokens.total,
      costUsd: snapshot.costUsd,
      ...(snapshot.costStatus ? { costStatus: snapshot.costStatus } : {}),
      ...(snapshot.costUnavailableReasons
        ? { costUnavailableReasons: snapshot.costUnavailableReasons }
        : {}),
      modelCalls: snapshot.modelCalls,
      ...(lastInputTokens !== undefined ? { lastInputTokens } : {}),
      ...(contextWindowPressure !== undefined ? { contextWindowPressure } : {}),
    };
  }

  private recordModelUsage(output: ModelOutput): void {
    const usage = output.usage;
    // Feed the usage tracker for every model call so per-model-call counters
    // advance even when the provider returned no usage block.
    this.usageTracker.recordModelUsage({
      adapterId: getModelAdapterId(this.activeModel()),
      usage,
    });

    if (!usage) return;

    if (typeof usage.inputTokens === "number") {
      this.lastModelInputTokens = usage.inputTokens;
    }

    const tokens =
      usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    this.budgetUsage.tokens += tokens;
    this.budgetUsage.costUsd += usage.costUsd ?? 0;
    this.emitBudgetChecked("model_usage_recorded", { usage });
  }

  private checkRunBudget(
    stage: string,
    metadata: Record<string, unknown> = {},
  ): RunResult | undefined {
    this.emitBudgetChecked(stage, metadata);
    const usage = this.currentBudgetUsage();

    if (
      this.runBudget?.maxDurationMs !== undefined &&
      usage.elapsedMs > this.runBudget.maxDurationMs
    ) {
      return this.fail(
        "max_duration_exceeded",
        "MAX_DURATION_EXCEEDED",
        `Run exceeded the maximum duration of ${this.runBudget.maxDurationMs}ms.`,
        { ...metadata, budget: this.runBudget, usage },
      );
    }

    if (
      this.runBudget?.maxTokens !== undefined &&
      usage.tokens > this.runBudget.maxTokens
    ) {
      return this.fail(
        "token_budget_exceeded",
        "TOKEN_BUDGET_EXCEEDED",
        `Run exceeded the token budget of ${this.runBudget.maxTokens}.`,
        { ...metadata, budget: this.runBudget, usage },
      );
    }

    if (
      this.runBudget?.maxCostUsd !== undefined &&
      usage.costUsd > this.runBudget.maxCostUsd
    ) {
      return this.fail(
        "cost_budget_exceeded",
        "COST_BUDGET_EXCEEDED",
        `Run exceeded the cost budget of ${this.runBudget.maxCostUsd} USD.`,
        { ...metadata, budget: this.runBudget, usage },
      );
    }

    return undefined;
  }

  private emitBudgetChecked(
    stage: string,
    metadata: Record<string, unknown> = {},
  ): void {
    if (!this.runBudget) return;

    this.events.emit("run.budget.checked", {
      stage,
      budget: this.runBudget,
      usage: this.currentBudgetUsage(),
      metadata,
    });
  }

  private currentBudgetUsage(): RunBudgetUsage {
    return {
      elapsedMs:
        this.startedAtMs === undefined ? 0 : Date.now() - this.startedAtMs,
      ...this.budgetUsage,
    };
  }

  private async completeModelWithRetries(
    input: ModelInput,
  ): Promise<ModelOutput> {
    for (
      let attempt = 1;
      attempt <= this.modelRetry.maxAttempts;
      attempt += 1
    ) {
      this.reserveModelCallBudget({
        step: input.step,
        attempt,
      });
      const adapter = this.activeModel();
      const adapterId = getModelAdapterId(adapter);
      const streaming = Boolean(adapter.stream);
      const requestStartedAtMs = Date.now();
      this.events.emit("model.requested", {
        goal: this.record.goal,
        step: input.step,
        attempt,
        adapterId,
        streaming,
      });

      const resolvedInput: ModelInput = {
        ...input,
        events: this.events.all(),
        abortSignal: this.abortController.signal,
      };

      try {
        this.lastStreamTraceTiming = undefined;
        const callModel =
          this.loopServices.callModel ??
          ((call: RunLoopModelCallInput) =>
            call.useStream
              ? call.completeStream(call.adapter, call.input)
              : call.adapter.complete(call.input));
        const output = await callModel({
          run: this.record,
          step: input.step,
          adapter,
          input: resolvedInput,
          useStream: streaming,
          completeStream: (streamAdapter, streamInput) =>
            this.completeModelWithStream(streamAdapter, streamInput),
        });
        const requestCompletedAtMs = Date.now();
        return {
          ...output,
          trace: buildModelOutputTrace({
            output,
            attempt,
            maxAttempts: this.modelRetry.maxAttempts,
            adapterId,
            streaming,
            requestStartedAtMs,
            requestCompletedAtMs,
            streamTiming: this.lastStreamTraceTiming,
          }),
        };
      } catch (cause) {
        if (cause instanceof ModelOutputInvalidError) {
          throw cause;
        }

        // Cancellation is terminal: if the run was aborted, the stream's
        // AbortError must not be treated as a retryable network blip (which
        // would emit a spurious `model.retrying` and stall teardown for the
        // back-off delay). Bail out as a non-retryable failure immediately.
        if (this.abortController.signal.aborted) {
          throw new ModelCompletionFailure(cause, attempt, false);
        }

        const retryable = isRetryableModelFailure(cause);
        const exhausted = attempt >= this.modelRetry.maxAttempts;

        if (!retryable || exhausted) {
          throw new ModelCompletionFailure(cause, attempt, retryable);
        }

        const modelError = normalizeModelError(cause);
        const delayMs = this.computeRetryDelayMs(attempt, modelError);
        this.events.emit("model.retrying", {
          step: input.step,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: this.modelRetry.maxAttempts,
          delayMs,
          error: modelError,
        });
        if (delayMs > 0) {
          await this.sleepWithAbort(delayMs);
          // If cancellation arrived during the cool-down, surface it as a
          // non-retryable failure rather than spending another attempt.
          if (this.abortController.signal.aborted) {
            throw new ModelCompletionFailure(cause, attempt, false);
          }
        }
      }
    }

    throw new ModelCompletionFailure(
      new Error("Model completion failed."),
      this.modelRetry.maxAttempts,
      true,
    );
  }

  /**
   * Compute how long to wait before retry `attempt + 1`. Combines exponential
   * backoff (`initialDelayMs * multiplier^(attempt-1)`, capped at `maxDelayMs`)
   * with optional jitter, then takes the max against a provider-supplied
   * `Retry-After` when `respectRetryAfter` is enabled — so we never retry
   * sooner than the provider asked, but still cap to `maxDelayMs`.
   */
  private computeRetryDelayMs(
    attempt: number,
    modelError: ModelErrorEnvelope,
  ): number {
    const policy = this.modelRetry;
    // `attempt` is 1-based: the delay BEFORE the first retry uses exponent 0.
    const exponential =
      policy.initialDelayMs *
      Math.pow(policy.backoffMultiplier, Math.max(0, attempt - 1));
    const capped = Math.min(exponential, policy.maxDelayMs);
    const jittered = policy.jitter === "full" ? Math.random() * capped : capped;

    let delay = jittered;
    if (
      policy.respectRetryAfter &&
      typeof modelError.retryAfterMs === "number" &&
      Number.isFinite(modelError.retryAfterMs) &&
      modelError.retryAfterMs > 0
    ) {
      // Honor the provider's cool-down, but never exceed our own ceiling.
      delay = Math.max(
        delay,
        Math.min(modelError.retryAfterMs, policy.maxDelayMs),
      );
    }
    return Math.max(0, Math.round(delay));
  }

  /**
   * Abort-aware sleep. Resolves after `ms`, or early (without throwing) when
   * the run's abort signal fires — the caller re-checks `aborted` afterwards.
   */
  private sleepWithAbort(ms: number): Promise<void> {
    const signal = this.abortController.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // Streaming consumption. Two extensions over the v0 baseline:
  //   - if the provider emits `tool_call_end` with a `.arguments` payload,
  //     we treat that index as already-parsed and skip the join+JSON.parse;
  //   - `stop` chunks set `stopReason` on the returned ModelOutput so the
  //     loop can detect `max_output_tokens` truncation without inspecting
  //     the underlying error shape.
  // Eager mid-stream tool dispatch (StreamingToolExecutor) is a future
  // extension: the hook is the `tool_call_end` event below; once we surface
  // an iteration boundary that lets `runLoop` consume completed tools while
  // the model is still emitting text, this is where it plugs in.
  private async completeModelWithStream(
    adapter: ModelAdapter,
    input: ModelInput,
  ): Promise<ModelOutput> {
    const timing: StreamTraceTiming = { startedAtMs: Date.now() };
    this.lastStreamTraceTiming = timing;
    this.events.emit("model.stream.started", { step: input.step });

    let text = "";
    let usage: ModelOutput["usage"];
    let stopReason: ModelOutput["stopReason"];
    const toolCallBuilders: Map<
      number,
      {
        toolName: string;
        argumentsParts: string[];
        parsedArguments?: unknown;
        closed?: boolean;
      }
    > = new Map();

    try {
      for await (const chunk of adapter.stream!(input)) {
        timing.firstChunkAtMs ??= Date.now();
        this.events.emit("model.stream.chunk", chunk);

        if (chunk.type === "text_delta" && chunk.text !== undefined) {
          text += chunk.text;
        } else if (
          chunk.type === "tool_call_start" &&
          chunk.toolCallIndex !== undefined &&
          chunk.toolName !== undefined
        ) {
          toolCallBuilders.set(chunk.toolCallIndex, {
            toolName: chunk.toolName,
            argumentsParts: [],
          });
        } else if (
          chunk.type === "tool_call_delta" &&
          chunk.toolCallIndex !== undefined &&
          chunk.argumentsDelta !== undefined
        ) {
          const builder = toolCallBuilders.get(chunk.toolCallIndex);
          if (builder) {
            builder.argumentsParts.push(chunk.argumentsDelta);
          }
        } else if (
          chunk.type === "tool_call_end" &&
          chunk.toolCallIndex !== undefined
        ) {
          const builder = toolCallBuilders.get(chunk.toolCallIndex);
          if (builder) {
            builder.closed = true;
            if (chunk.arguments !== undefined) {
              builder.parsedArguments = chunk.arguments;
            }
          }
        } else if (chunk.type === "usage") {
          usage = mergeModelUsage(usage, chunk.usage);
        } else if (chunk.type === "stop") {
          stopReason = chunk.stopReason ?? "completed";
        }
      }
    } catch (cause) {
      timing.completedAtMs = Date.now();
      const modelError = normalizeModelError(cause);
      if (modelError.category === "timeout") {
        this.events.emit("model.stream.timeout", {
          step: input.step,
          message: modelError.message,
          timeoutKind: modelError.timeoutKind ?? "unknown",
          retryable: modelError.retryable,
          ...(modelError.configuredTimeoutMs !== undefined
            ? { configuredTimeoutMs: modelError.configuredTimeoutMs }
            : {}),
          ...(modelError.elapsedMs !== undefined
            ? { elapsedMs: modelError.elapsedMs }
            : {}),
        });
      }
      this.events.emit("model.stream.failed", {
        step: input.step,
        error: modelError.message,
        ...(modelError.category === "timeout"
          ? {
              metadata: {
                category: modelError.category,
                timeoutKind: modelError.timeoutKind ?? "unknown",
                retryable: modelError.retryable,
                ...(modelError.configuredTimeoutMs !== undefined
                  ? { configuredTimeoutMs: modelError.configuredTimeoutMs }
                  : {}),
                ...(modelError.elapsedMs !== undefined
                  ? { elapsedMs: modelError.elapsedMs }
                  : {}),
              },
            }
          : {}),
      });
      throw cause;
    }

    let toolCalls: Array<{ toolName: string; arguments: unknown }> | undefined;
    if (toolCallBuilders.size > 0) {
      toolCalls = [];
      for (const builder of toolCallBuilders.values()) {
        if (builder.parsedArguments !== undefined) {
          toolCalls.push({
            toolName: builder.toolName,
            arguments: builder.parsedArguments,
          });
          continue;
        }
        const raw = builder.argumentsParts.join("");
        if (raw === "") {
          // Some models emit tool-call start/end without any argument deltas
          // when invoking a zero-argument tool (e.g. an MCP list gateway).
          // Treat the empty payload as `{}`; argument schema validation
          // downstream still rejects calls that require parameters.
          toolCalls.push({ toolName: builder.toolName, arguments: {} });
          continue;
        }
        try {
          toolCalls.push({
            toolName: builder.toolName,
            arguments: JSON.parse(raw),
          });
        } catch (cause) {
          const truncated = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
          this.events.emit("model.stream.failed", {
            step: input.step,
            error:
              cause instanceof Error
                ? cause.message
                : "Failed to parse streamed tool call arguments.",
            metadata: {
              toolName: builder.toolName,
              rawArgumentsPreview: truncated,
            },
          });
          throw new ModelOutputInvalidError(
            "Streamed tool call arguments were not valid JSON.",
            {
              toolName: builder.toolName,
              rawArgumentsPreview: truncated,
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          );
        }
      }
    }

    const output: ModelOutput = {
      message: text || undefined,
      toolCalls,
      usage,
      stopReason,
    };

    timing.completedAtMs = Date.now();
    // Stream-layer terminal marker only: the assembled `output` (text, tool
    // calls, usage) is emitted on the immediately-following `model.completed`,
    // so re-attaching it here would serialize the whole answer twice in a row.
    this.events.emit("model.stream.completed", { step: input.step });

    return output;
  }

  private complete(
    reason: Extract<RunStopReason, "no_model_configured" | "final_answer">,
    payload: Record<string, unknown>,
  ): RunResult {
    // A cancel that lands just as the run finishes already emitted its terminal
    // event (run.cancelled) and set `result`; emitting a second run.completed
    // here would give the run two terminal events (setState rejects the
    // transition anyway — see run.state_transition.rejected). Honor the
    // existing terminal instead so the trace stays single-terminal per run.
    if (isTerminalState(this.record.state) && this.result) {
      return this.result;
    }
    const outcome =
      reason === "final_answer"
        ? completedRunOutcomeFromEvents(
            this.events.all(),
            typeof payload.message === "string" ? payload.message : undefined,
          )
        : undefined;
    // Persist the command- and tool-outcome verdicts (computed over the full
    // event stream) so trace summaries stay correct for legacy traces that
    // may not retain the tool.completed output / tool.requested arguments they
    // would otherwise be recomputed from.
    const commandOutcome = commandOutcomeSnapshot(this.events.all());
    const toolOutcome = toolOutcomeSnapshot(this.events.all());
    const completedPayload = {
      reason,
      ...payload,
      ...(outcome ? { outcome } : {}),
      ...(commandOutcome ? { commandOutcome } : {}),
      ...(toolOutcome ? { toolOutcome } : {}),
    };
    this.setState("completed", reason);
    this.events.emit("run.completed", completedPayload);
    this.kickWorkflowHookPhase("RunEnd", {
      state: "completed",
      reason,
      result: completedPayload,
    });
    const { message: payloadMessage, ...rest } = payload;
    this.result = {
      signal: "completed",
      state: "completed",
      stopReason: reason,
      message: typeof payloadMessage === "string" ? payloadMessage : undefined,
      metadata: omitUndefined({
        ...rest,
        ...(outcome ? { outcome } : {}),
      }),
    };
    return this.result;
  }

  private fail(
    reason: Exclude<RunStopReason, "no_model_configured" | "final_answer">,
    code: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): RunResult {
    // Already-terminal (e.g. cancelled mid-flight): don't emit a second terminal
    // event on top of the existing one.
    if (isTerminalState(this.record.state) && this.result) {
      return this.result;
    }
    const safeMetadata = sanitizeFailureMetadata(metadata);
    const failureMetadata = { ...safeMetadata };
    const failure = {
      category: failureCategoryFor(reason, code),
      code,
      message,
      retryable:
        typeof safeMetadata.retryable === "boolean"
          ? safeMetadata.retryable
          : undefined,
      metadata: failureMetadata,
    };
    this.setState("failed", reason);
    this.events.emit("run.failed", {
      reason,
      code,
      message,
      failure,
      metadata: { ...safeMetadata },
    });
    this.kickWorkflowHookPhase("RunEnd", {
      state: "failed",
      reason,
      failure,
    });
    this.result = {
      signal: "failed",
      state: "failed",
      stopReason: reason,
      failure,
      metadata: { ...safeMetadata },
    };
    return this.result;
  }

  private setState(state: RunState, stopReason?: RunStopReason): void {
    // Both rejection paths are silent at the type level (no throw); the
    // run loop relies on the `run.state_transition.rejected` event to
    // make these visible to sinks and tests. Crucially, neither branch
    // mutates `stopReason` — earlier code wrote
    // `stopReason = "state_transition_invalid"` only on the
    // `invalid_transition` branch, which then leaked into the eventual
    // legitimate `RunResult` if the run later terminated normally.
    if (isTerminalState(this.record.state)) {
      this.events.emit("run.state_transition.rejected", {
        from: this.record.state,
        to: state,
        reason: "terminal_state",
      });
      return;
    }

    if (!canTransition(this.record.state, state)) {
      this.events.emit("run.state_transition.rejected", {
        from: this.record.state,
        to: state,
        reason: "invalid_transition",
      });
      return;
    }

    this.record.state = state;
    if (stopReason) this.record.stopReason = stopReason;
    this.record.updatedAt = this.nowIso();
  }
}

function canTransition(from: RunState, to: RunState): boolean {
  if (from === to) return true;

  switch (from) {
    case "created":
      return to === "running" || to === "cancelled";
    case "running":
      return (
        to === "waiting_approval" ||
        to === "waiting_credentials" ||
        to === "waiting_tasks" ||
        to === "completed" ||
        to === "failed" ||
        to === "cancelled"
      );
    case "waiting_approval":
      return to === "running" || to === "failed" || to === "cancelled";
    case "waiting_credentials":
      return to === "running" || to === "failed" || to === "cancelled";
    case "waiting_tasks":
      return to === "running" || to === "failed" || to === "cancelled";
    case "completed":
    case "failed":
    case "cancelled":
      return false;
  }
}

function isTerminalState(state: RunState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function isWaitingTasksWake(state: RunLoopState): boolean {
  return state.transition.metadata?.wake === "waiting_tasks";
}

function notificationErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

interface ToolExecutionDiagnostics {
  enabled: boolean;
  startedCalls: RequestedToolCall[];
}

interface ToolExecutionDiagnostic {
  duplicateKind?: "in_flight_duplicate";
}

function createToolExecutionDiagnostics(
  batch: ToolCallBatch,
  maxConcurrency: number,
): ToolExecutionDiagnostics {
  return {
    enabled: batch.mode === "concurrent" && maxConcurrency > 1,
    startedCalls: [],
  };
}

function diagnoseToolExecution(
  diagnostics: ToolExecutionDiagnostics,
  call: RequestedToolCall,
): ToolExecutionDiagnostic | undefined {
  if (!diagnostics.enabled) return undefined;
  const duplicate = diagnostics.startedCalls.some((started) =>
    isRepeatedToolCall(started, call),
  );
  diagnostics.startedCalls.push(call);
  return duplicate ? { duplicateKind: "in_flight_duplicate" } : undefined;
}

function isInFlightDuplicateToolResult(result: ToolResult): boolean {
  return (
    result.status === "failed" &&
    result.error?.metadata?.duplicateKind === "in_flight_duplicate"
  );
}

function isRepeatedToolCall(
  previous: { toolName: string; arguments: unknown } | undefined,
  next: { toolName: string; arguments: unknown },
): boolean {
  return (
    previous?.toolName === next.toolName &&
    isDeepStrictEqual(previous.arguments, next.arguments)
  );
}

/**
 * A coarse "what does this call act on" key, used only by the doom-loop guard.
 * This intentionally stays narrower than outcome recovery fingerprinting: a
 * corrected argument shape for the same human-visible target should get a real
 * execution chance instead of being skipped as another repeat.
 */
function semanticToolTarget(toolName: string, args: unknown): string {
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    // Capability calls (cron/agent/task) act on a stable `ref`; collapse to it
    // so a model varying cosmetic job/patch fields cannot escape the guard.
    const ref = stableRefTarget(record);
    if (ref !== undefined) {
      return `${toolName}::ref::${ref}`;
    }
    if (isShellToolName(toolName) && typeof record.command === "string") {
      const cwd =
        typeof record.cwd === "string" && record.cwd.length > 0
          ? `\u0000cwd:${record.cwd}`
          : "";
      return `${toolName}::command::${record.command}${cwd}`;
    }
    if (typeof record.path === "string") {
      return `${toolName}::path::${record.path}`;
    }
    if (Array.isArray(record.patterns)) {
      return `${toolName}::patterns::${record.patterns.join("\u0000")}`;
    }
    if (typeof record.pattern === "string") {
      return `${toolName}::pattern::${record.pattern}`;
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? String(args);
  } catch {
    serialized = String(args);
  }
  return `${toolName}::args::${serialized}`;
}

function toolFailureContext(result: ToolResult): {
  category: ToolFailureCategory;
  expectedDenial?: boolean;
} {
  const metadata = isRecord(result.error?.metadata)
    ? result.error.metadata
    : undefined;
  const repeatedCategory = parseToolFailureCategory(
    metadata?.repeatedPriorFailureCategory,
  );
  const category =
    repeatedCategory ??
    classifyToolFailure(result.error?.code ?? "TOOL_FAILED");
  const expectedDenial =
    metadata?.repeatedPriorFailureExpectedDenial === true ||
    isExpectedDenialCategory(category);
  return {
    category,
    ...(expectedDenial ? { expectedDenial: true } : {}),
  };
}

function repeatedToolCallNudgeMessage(
  toolName: string,
  priorFailure: RunLoopState["lastFailedToolTarget"] | undefined,
): string {
  if (!priorFailure) {
    return (
      `Skipped: \`${toolName}\` was already called with identical arguments ` +
      `and returned the same result. Repeating it cannot produce new ` +
      `information. Choose a different action or set of arguments, or stop ` +
      `calling tools and answer the user directly. Repeating this exact call ` +
      `again will end the run.`
    );
  }

  const failureSummary = `${priorFailure.code}: ${priorFailure.message}`;
  if (priorFailure.expectedDenial) {
    const denialKind =
      priorFailure.category === "approval_denial" ? "approval" : "policy";
    return (
      `Skipped: \`${toolName}\` already hit an expected ${denialKind} ` +
      `denial on this target (${failureSummary}). Repeating the same denied ` +
      `action in the same run cannot change the permission boundary. Choose a ` +
      `permitted alternative, change the run access/approval posture, or answer ` +
      `the user with the denial. Repeating this will end the run.`
    );
  }

  if (isPathLikeSemanticTarget(priorFailure.key)) {
    return (
      `Skipped: \`${toolName}\` already failed on this target ` +
      `(${failureSummary}). Retrying it with different arguments (e.g. a new ` +
      `offset/limit) cannot succeed - the target may be a directory or ` +
      `otherwise invalid. Use a listing tool (e.g. glob) or choose a different ` +
      `path. Repeating this will end the run.`
    );
  }

  return (
    `Skipped: \`${toolName}\` already failed on this target ` +
    `(${failureSummary}). Retrying the same failing target with cosmetic ` +
    `argument changes cannot succeed. Choose a different concrete action, fix ` +
    `the cause of the failure, or answer the user directly if the failure is ` +
    `the result. Repeating this will end the run.`
  );
}

function repeatedToolCallNudgeMetadata(
  priorFailure: NonNullable<RunLoopState["lastFailedToolTarget"]>,
): Record<string, unknown> {
  return {
    repeatedPriorFailureCode: priorFailure.code,
    repeatedPriorFailureCategory: priorFailure.category ?? "tool_runtime_error",
    repeatedPriorFailureExpectedDenial: priorFailure.expectedDenial === true,
  };
}

function parseToolFailureCategory(
  value: unknown,
): ToolFailureCategory | undefined {
  return value === "policy_denial" ||
    value === "approval_denial" ||
    value === "model_arg_error" ||
    value === "tool_runtime_error"
    ? value
    : undefined;
}

function isExpectedDenialCategory(category: ToolFailureCategory): boolean {
  return category === "policy_denial" || category === "approval_denial";
}

function isPathLikeSemanticTarget(key: string): boolean {
  return key.includes("::path::");
}

function isShellToolName(toolName: string): boolean {
  return toolName === "bash" || toolName === "shell";
}

function isIdempotentNoopToolResult(result: ToolResult): boolean {
  if (result.status !== "completed" || !isRecord(result.output)) return false;
  const output = result.output;
  const saved = output.saved;
  const changed = output.changed;
  const hint = getStringProperty(output, "hint");
  return (
    (saved === false || changed === false) &&
    Boolean(hint && /unchanged|no[- ]?op|nothing|do not|again/i.test(hint))
  );
}

function shouldRequestContextCompaction(
  omitted: Array<{ reason: string }>,
): boolean {
  // Deterministic per-item truncation is cache-safe and must NOT request
  // compaction. Only cache-breaking drops (window/budget overflow) do.
  return omitted.some(
    (item) =>
      item.reason === "max_items_exceeded" ||
      item.reason === "max_total_chars_exceeded",
  );
}

function runStartedPayload(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const resolvedModel = metadata.resolvedModel;
  const mcpWorkspaceCwdServers = Array.isArray(metadata.mcpWorkspaceCwdServers)
    ? metadata.mcpWorkspaceCwdServers.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return {
    ...(isRecord(resolvedModel) ? { resolvedModel } : {}),
    ...(mcpWorkspaceCwdServers.length > 0 ? { mcpWorkspaceCwdServers } : {}),
  };
}

class ModelOutputInvalidError extends Error {
  readonly metadata: Record<string, unknown>;

  constructor(message: string, metadata: Record<string, unknown> = {}) {
    super(message);
    this.name = "ModelOutputInvalidError";
    this.metadata = metadata;
  }
}

function getModelAdapterId(
  adapter: ModelAdapter | undefined,
): string | undefined {
  if (!adapter) return undefined;
  const named = adapter as ModelAdapter & { id?: string; name?: string };
  return named.id ?? named.name;
}

function cloneLoopState(state: RunLoopState): RunLoopState {
  return {
    ...state,
    context: [...state.context],
    previousToolCall: state.previousToolCall
      ? {
          toolName: state.previousToolCall.toolName,
          arguments: state.previousToolCall.arguments,
        }
      : undefined,
    lastFailedToolTarget: state.lastFailedToolTarget
      ? { ...state.lastFailedToolTarget }
      : undefined,
    lastNoopToolTarget: state.lastNoopToolTarget
      ? { ...state.lastNoopToolTarget }
      : undefined,
    transition: {
      reason: state.transition.reason,
      metadata: state.transition.metadata
        ? { ...state.transition.metadata }
        : undefined,
    },
  };
}

class RunBudgetExceededError extends Error {
  constructor(
    readonly reason: Exclude<
      RunStopReason,
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
      | "blocking_limit"
      | "validation_failed"
      | "hook_stopped"
      | "stop_hook_prevented"
      | "aborted_streaming"
      | "aborted_tools"
      | "manual_cancelled"
      | "state_transition_invalid"
    >,
    readonly code: string,
    message: string,
    readonly metadata: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RunBudgetExceededError";
  }
}

function makeContinuationContextItem(
  attempt: number,
  maxAttempts: number,
): ContextItem {
  return {
    id: createContextItemId(),
    type: "user",
    source: { kind: "recovery", uri: "model.continuation" },
    content: [
      "[Harness recovery: previous response was truncated.]",
      "Please continue from exactly where you left off.",
      "Do NOT restart, do NOT summarize, do NOT apologize.",
      `Attempt ${attempt} of ${maxAttempts}.`,
    ].join("\n"),
    metadata: {
      layer: "runtime",
      stability: "turn",
      injected: true,
      recovery: "extend_output",
    },
  };
}

/**
 * Directive injected for the forced wrap-up turn when a run exhausts its step
 * budget mid-task. It tells the model to stop gathering and deliver a labeled
 * best-effort partial, so the run returns usable output instead of discarding
 * all work in a hard `max_steps_exceeded` failure.
 */
function makeBudgetWrapUpContextItem(
  stepsUsed: number,
  maxSteps: number,
): ContextItem {
  return {
    id: createContextItemId(),
    type: "user",
    source: { kind: "recovery", uri: "run.budget_wrap_up" },
    content: [
      `[Harness: step budget exhausted — used all ${stepsUsed} of ${maxSteps} allowed steps.]`,
      "You cannot call any more tools. Produce your best-effort FINAL answer",
      "now from what you have already gathered. State plainly that it is a",
      "partial result produced under an exhausted step budget, and note what",
      "remains undone. Do NOT call tools; do NOT apologize at length.",
    ].join("\n"),
    metadata: {
      layer: "runtime",
      stability: "turn",
      injected: true,
      recovery: "budget_wrap_up",
    },
  };
}

// `RunLoopTransition` is re-exported via index for embedders that build
// custom drivers; keep a runtime sentinel so tools depending on it have a
// nameable value. Not used by the reference loop itself.
export const TERMINAL_TRANSITION: RunLoopTransition = { reason: "terminal" };

function workflowHookBlockMessage(block: WorkflowHookBlock): string {
  const finding = block.findings?.[0];
  return finding
    ? `${block.hookName}: ${finding.message}`
    : `${block.hookName}: ${block.reason}`;
}

function extractWorkflowPath(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const direct =
    getStringProperty(args, "path") ??
    getStringProperty(args, "workspacePath") ??
    getStringProperty(args, "file") ??
    getStringProperty(args, "targetPath");
  if (direct) return direct;
  const paths = args.paths;
  return Array.isArray(paths) && typeof paths[0] === "string"
    ? paths[0]
    : undefined;
}

function failureCategoryFor(
  reason: RunStopReason,
  code: string,
): RunFailureCategory {
  if (reason.startsWith("model_") || code.startsWith("MODEL_")) return "model";
  if (reason.startsWith("tool_") || code.startsWith("TOOL_")) return "tool";
  if (code.startsWith("APPROVAL_")) return "approval";
  if (code.startsWith("POLICY_")) return "policy";
  if (code.startsWith("WORKSPACE_")) return "workspace";
  if (reason.startsWith("validation_") || code.startsWith("VALIDATION_"))
    return "validation";
  return "runtime";
}

function sanitizeFailureMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const out = omitUndefined(metadata);
  if ("cause" in out) {
    const cause = summarizeFailureCause(out.cause);
    if (cause === undefined) delete out.cause;
    else out.cause = cause;
  }
  return out;
}

function summarizeFailureCause(cause: unknown): unknown {
  if (cause === undefined) return undefined;
  if (typeof cause === "string") return truncateFailureString(cause);
  if (
    cause === null ||
    typeof cause === "number" ||
    typeof cause === "boolean"
  ) {
    return cause;
  }

  const record = isRecord(cause) ? cause : undefined;
  const out: Record<string, unknown> = {};
  const name =
    cause instanceof Error ? cause.name : stringFromRecord(record, "name");
  const message =
    cause instanceof Error
      ? cause.message
      : stringFromRecord(record, "message");
  const code = stringFromRecord(record, "code");
  const status = numberFromRecord(record, "status");
  const statusCode = numberFromRecord(record, "statusCode");
  const requestId =
    stringFromRecord(record, "requestId") ??
    stringFromRecord(record, "requestID") ??
    stringFromHeaders(record?.responseHeaders, "x-request-id") ??
    stringFromHeaders(record?.headers, "x-request-id");
  const responseBody = responseBodyFromRecord(record);

  if (name !== undefined) out.name = name;
  if (message !== undefined) out.message = truncateFailureString(message);
  if (code !== undefined) out.code = code;
  if (status !== undefined) out.status = status;
  if (statusCode !== undefined) out.statusCode = statusCode;
  if (requestId !== undefined) out.requestId = requestId;
  if (responseBody !== undefined) {
    out.responseBodyPreview = truncateFailureString(responseBody);
  }

  if (Object.keys(out).length > 0) return out;
  return { type: typeof cause };
}

function responseBodyFromRecord(
  record: Record<string, unknown> | undefined,
): string | undefined {
  if (!record) return undefined;
  const direct = stringFromRecord(record, "responseBody");
  if (direct !== undefined) return direct;
  const response = record.response;
  return isRecord(response)
    ? (stringFromRecord(response, "body") ?? stringFromRecord(response, "text"))
    : undefined;
}

function stringFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringFromHeaders(headers: unknown, key: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): unknown }).get(key);
    return typeof value === "string" ? value : undefined;
  }
  if (!isRecord(headers)) return undefined;
  const target = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === target && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function truncateFailureString(value: string): string {
  return value.length > FAILURE_CAUSE_RESPONSE_BODY_PREVIEW_CHARS
    ? `${value.slice(0, FAILURE_CAUSE_RESPONSE_BODY_PREVIEW_CHARS)}...`
    : value;
}

function promptMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

export function createRun(options: CreateRunOptions): RunHandle {
  return new SparkwrightRun(options);
}

export interface ResumeRunOptions extends Omit<
  CreateRunOptions,
  "seedFromCheckpoint" | "goal"
> {
  /**
   * Override the original run's goal. Defaults to the checkpoint's recorded
   * goal so the loop continues from the same intent.
   */
  goal?: string;
  /**
   * Allow resuming a checkpoint marked `resumability.complete = false`.
   * Defaults to `false` — the factory throws unless the checkpoint promises
   * full resumability or the caller opts in to a best-effort resume.
   */
  force?: boolean;
}

/**
 * Re-enter a run from a previously-taken {@link RunCheckpointV1}.
 *
 * Resume preserves the original `runId`, accumulated budget counters, model
 * fallback cursor, output-recovery counter, and loop step so that an outage
 * (network drop, process crash, account quota refilled later) does not force
 * the embedder to throw away prior progress.
 *
 * What's restored:
 *   - run identity and createdAt
 *   - accumulated tokens / cost / model & tool call counters
 *   - active model index in the fallback chain
 *   - output-recovery counter (so `extend_output` budget keeps decrementing)
 *   - the in-loop context at the moment the checkpoint was taken
 *   - loop step / turnCount / repeated-tool-call guard counter
 *
 * What's NOT carried across (by design — listed in checkpoint.resumability.reasons):
 *   - in-flight async prefetch and observation summarization (re-derived)
 *   - command queue (caller should re-enqueue if needed)
 *   - waiting_tasks idle state (v1 blocks live; durable detach/resume needs a
 *     later checkpoint reconstruction design)
 *   - in-flight model stream (always re-issued)
 *   - tool calls that were mid-execution when the process died (caller must
 *     reconcile; tools should declare `isReplaySafe` so the model can decide)
 *
 * The factory rejects checkpoints whose runs are already terminal
 * (`completed` / `failed` / `cancelled`) and, by default, ones whose
 * `resumability.complete` is `false`. Pass `force: true` to bypass the
 * resumability gate for best-effort recovery.
 */
export function resumeRunFromCheckpoint(
  checkpoint: RunCheckpointV1,
  options: ResumeRunOptions = {},
): RunHandle {
  if (checkpoint.schemaVersion !== "run-checkpoint.v1") {
    throw new Error(
      `Unsupported checkpoint schema: ${(checkpoint as { schemaVersion?: string }).schemaVersion}`,
    );
  }
  if (isTerminalState(checkpoint.run.state)) {
    throw new Error(
      `Cannot resume a checkpoint whose run is already terminal (state=${checkpoint.run.state}).`,
    );
  }
  if (!checkpoint.resumability.complete && options.force !== true) {
    throw new Error(
      `Checkpoint is not fully resumable (reasons: ${checkpoint.resumability.reasons.join(", ") || "unspecified"}). ` +
        `Pass { force: true } to attempt a best-effort resume.`,
    );
  }
  const { goal: goalOverride, force: _force, ...rest } = options;
  return new SparkwrightRun({
    ...rest,
    goal: goalOverride ?? checkpoint.run.goal,
    seedFromCheckpoint: checkpoint,
  });
}
