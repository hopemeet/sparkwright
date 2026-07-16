// =============================================================================
// pipeline.ts — Loop-adjacent extension points (compaction, summarization,
// prefetch). These are the "edges" the
// reference run loop talks to in addition to the model adapter and tool
// registry. Each interface is optional; the loop degrades gracefully when
// nothing is wired up.
//
// Design notes:
// - Compactors run as a pipeline (apply-in-order until budget pressure is
//   relieved or all stages are exhausted). The reference sequence is
//   cheap edits first, model-backed last:
//   `applyToolResultBudget → snip → micro → collapse → auto`.
// - The summarizer is opt-in async; the loop awaits it just before the next
//   model call and inserts the summary as a `summary` ContextItem.
// =============================================================================

import { createContextItemId } from "./ids.js";
import {
  createFileReadDedupStage,
  createObservationOneLineStage,
} from "./context-dedup.js";
import type { EventEmitter } from "./events.js";
import type {
  ContextHints,
  ContextUsageHint,
  Compactor as ContextCompactor,
} from "./context.js";
import type { ContextItem, RunRecord, ToolResult } from "./types.js";

/**
 * Reason a compactor was invoked. The layered triggers let embedders shape
 * a multi-stage pipeline (cheap edits first, model-backed last).
 *
 * @public
 * @stability experimental v0.1
 */
export type CompactionTrigger =
  | "tool_result_budget" // shrink oversize tool_result items
  | "clear_tool_uses" // replace stale tool results with explicit placeholders
  | "snip" // drop middle redundant items
  | "micro" // replace stale tool results with id refs
  | "collapse" // fold older blocks into summaries
  | "auto" // model-driven full-history summary
  | "reactive"; // recover from over-budget error

export type CompactionTier = "dedup" | "extract" | "evict" | "summarize";

export interface CompactionWarning {
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface CompactionResult {
  items: ContextItem[];
  freedChars: number;
  skippedReason?: string;
  warnings?: CompactionWarning[];
  metadata?: Record<string, unknown>;
}

/**
 * A single compaction stage. `shouldRun` is consulted before each iteration;
 * `apply` returns the rewritten context plus optional metadata. Stages should
 * be conservative — only mutate what they own and return `freedChars: 0`
 * when they cannot make further progress (signals the loop to advance to
 * the next stage).
 *
 * @public
 * @stability experimental v0.1
 */
export interface CompactionStage {
  readonly name: string;
  readonly tier: CompactionTier;
  readonly trigger: CompactionTrigger;
  shouldRun(input: CompactionStageInput): boolean | Promise<boolean>;
  apply(
    input: CompactionStageInput,
  ): Promise<CompactionResult> | CompactionResult;
}

export interface CompactionStageInput {
  items: ContextItem[];
  hints: ContextHints;
  /**
   * Best-effort total character count for the current context. Stages can
   * use this to decide whether their work is "enough" or to give up early.
   */
  totalChars: number;
  /**
   * Savings accumulated by stages that have already run in this pipeline pass.
   * Later stages can use this to decide whether the current regime is still
   * density-bound, without reclassifying earlier stage work.
   */
  previousFreedChars?: number;
  /** Savings accumulated by already-applied stages, grouped by stage tier. */
  previousFreedByTier?: Readonly<Record<CompactionTier, number>>;
  /**
   * Stage may be invoked reactively in response to a previous overflow
   * error. When `reactive: true`, stages may be more aggressive.
   */
  reactive: boolean;
}

export interface CompactionPipelineOptions {
  stages: CompactionStage[];
  /**
   * Optional adapter from the existing `Compactor` (single-shot) protocol
   * into a pipeline stage. Stays additive so the older API still works.
   */
}

export interface CompactionPipelineInput {
  items: ContextItem[];
  hints: ContextHints;
  reactive?: boolean;
  events?: EventEmitter;
  run?: RunRecord;
}

export interface CompactionPipelineResult {
  items: ContextItem[];
  freedChars: number;
  skippedReason?: string;
  warnings?: CompactionWarning[];
  /** @reserved Public compaction metric consumed by diagnostics and tuning UIs. */
  freedByTier: Record<CompactionTier, number>;
  appliedStages: Array<{
    name: string;
    tier: CompactionTier;
    trigger: CompactionTrigger;
    freedChars: number;
    warnings?: CompactionWarning[];
    metadata?: Record<string, unknown>;
  }>;
  skippedStages: Array<{
    name: string;
    tier: CompactionTier;
    trigger: CompactionTrigger;
    reason: string;
    metadata?: Record<string, unknown>;
  }>;
}

/**
 * Wrap a list of stages as a pipeline runner. The loop calls
 * `pipeline.run(input)` whenever it needs to shrink context — typically once
 * per step before assembling the prompt, and again reactively on overflow
 * errors. Stages are applied in declaration order; ordering matters.
 *
 * @public
 * @stability experimental v0.1
 */
export function createCompactionPipeline(options: CompactionPipelineOptions): {
  run(input: CompactionPipelineInput): Promise<CompactionPipelineResult>;
} {
  const stages = options.stages;
  return {
    async run(
      input: CompactionPipelineInput,
    ): Promise<CompactionPipelineResult> {
      let items = input.items;
      const applied: CompactionPipelineResult["appliedStages"] = [];
      const skipped: CompactionPipelineResult["skippedStages"] = [];
      const warnings: CompactionWarning[] = [];
      const reactive = Boolean(input.reactive);
      const freedByTier: Record<CompactionTier, number> = {
        dedup: 0,
        extract: 0,
        evict: 0,
        summarize: 0,
      };

      for (const stage of stages) {
        const totalChars = items.reduce(
          (sum, item) => sum + item.content.length,
          0,
        );
        const stageInput: CompactionStageInput = {
          items,
          hints: input.hints,
          totalChars,
          previousFreedChars: applied.reduce(
            (sum, entry) => sum + entry.freedChars,
            0,
          ),
          previousFreedByTier: { ...freedByTier },
          reactive,
        };

        let willRun: boolean;
        try {
          willRun = await stage.shouldRun(stageInput);
        } catch (cause) {
          input.events?.emit("context.compaction.failed", {
            stage: stage.name,
            tier: stage.tier,
            trigger: stage.trigger,
            phase: "should_run",
            error: cause instanceof Error ? cause.message : String(cause),
          });
          continue;
        }
        if (!willRun) continue;

        input.events?.emit("context.compaction.started", {
          stage: stage.name,
          tier: stage.tier,
          trigger: stage.trigger,
          reactive,
          totalChars,
        });

        try {
          const result = await stage.apply(stageInput);
          const stageWarnings = result.warnings ?? [];
          if (stageWarnings.length > 0) warnings.push(...stageWarnings);
          if (result.freedChars <= 0) {
            const reason = result.skippedReason ?? "no_savings";
            skipped.push({
              name: stage.name,
              tier: stage.tier,
              trigger: stage.trigger,
              reason,
              metadata: result.metadata,
            });
            input.events?.emit("context.compaction.completed", {
              stage: stage.name,
              tier: stage.tier,
              trigger: stage.trigger,
              freedChars: 0,
              skippedReason: reason,
              warnings: stageWarnings,
              metadata: result.metadata,
            });
            continue;
          }
          items = result.items;
          freedByTier[stage.tier] += result.freedChars;
          applied.push({
            name: stage.name,
            tier: stage.tier,
            trigger: stage.trigger,
            freedChars: result.freedChars,
            warnings: stageWarnings.length > 0 ? stageWarnings : undefined,
            metadata: result.metadata,
          });
          input.events?.emit("context.compaction.completed", {
            stage: stage.name,
            tier: stage.tier,
            trigger: stage.trigger,
            freedChars: result.freedChars,
            warnings: stageWarnings,
            metadata: result.metadata,
          });
        } catch (cause) {
          input.events?.emit("context.compaction.failed", {
            stage: stage.name,
            tier: stage.tier,
            trigger: stage.trigger,
            phase: "apply",
            error: cause instanceof Error ? cause.message : String(cause),
          });
          // continue to next stage; partial progress is preserved
        }
      }

      const freedChars = applied.reduce(
        (sum, entry) => sum + entry.freedChars,
        0,
      );
      return {
        items,
        freedChars,
        ...(freedChars <= 0 ? { skippedReason: "no_savings" } : {}),
        warnings: warnings.length > 0 ? warnings : undefined,
        freedByTier,
        appliedStages: applied,
        skippedStages: skipped,
      };
    },
  };
}

/**
 * Adapt an existing single-shot {@link ContextCompactor} (already in core)
 * into a {@link CompactionStage}. Useful when embedders already have a
 * model-backed compactor and want to drop it into the pipeline as the last
 * resort.
 *
 * @public
 * @stability experimental v0.1
 */
export function compactionStageFromCompactor(
  name: string,
  trigger: CompactionTrigger,
  compactor: ContextCompactor,
  options: { onlyWhenChars?: number } = {},
): CompactionStage {
  return {
    name,
    tier: "summarize",
    trigger,
    shouldRun(input) {
      if (options.onlyWhenChars === undefined) return true;
      return input.totalChars >= options.onlyWhenChars;
    },
    async apply(input) {
      const before = input.totalChars;
      const next = await compactor.compact(input.items, {
        ...input.hints,
        reasons: [...(input.hints.reasons ?? []), trigger],
      });
      const after = next.reduce((sum, item) => sum + item.content.length, 0);
      return {
        items: next,
        freedChars: Math.max(0, before - after),
        metadata: { itemsBefore: input.items.length, itemsAfter: next.length },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Cost-aware gating — close the cost-observability loop by letting accumulated
// usage (tokens / cost / context-window pressure) decide *when* a compaction
// stage is allowed to run, not just character heuristics.
// ---------------------------------------------------------------------------

/**
 * Thresholds for {@link gateStageByUsage}. A gate "opens" only when the live
 * {@link ContextUsageHint} is present AND every supplied threshold is met
 * (logical AND). Omitted thresholds are not checked.
 *
 * @public
 * @stability experimental v0.1
 */
export interface UsageGateThresholds {
  /** Minimum fraction `[0,1]` of the context window the last call must fill. */
  minContextWindowPressure?: number;
  /** Minimum accumulated run cost (USD) before the gate opens. */
  minCostUsd?: number;
  /** Minimum accumulated total tokens before the gate opens. */
  minTotalTokens?: number;
}

/**
 * Returns `true` when `usage` clears every supplied threshold. A missing
 * `usage` (no tracker, or before the first model call) never clears a
 * cost gate — cost-aware compaction is intentionally conservative and waits
 * until there is real, measured pressure before acting.
 *
 * @public
 * @stability experimental v0.1
 */
export function usageMeetsGate(
  usage: ContextUsageHint | undefined,
  thresholds: UsageGateThresholds,
): boolean {
  if (!usage) return false;
  if (
    thresholds.minContextWindowPressure !== undefined &&
    (usage.contextWindowPressure ?? 0) < thresholds.minContextWindowPressure
  ) {
    return false;
  }
  if (
    thresholds.minCostUsd !== undefined &&
    usage.costUsd < thresholds.minCostUsd
  ) {
    return false;
  }
  if (
    thresholds.minTotalTokens !== undefined &&
    usage.totalTokens < thresholds.minTotalTokens
  ) {
    return false;
  }
  return true;
}

/**
 * Wrap a {@link CompactionStage} so it only runs once accumulated usage clears
 * `thresholds` (see {@link usageMeetsGate}). This is the canonical way to make
 * an existing cheap/char-based stage cost-aware: e.g. gate a model-backed
 * `auto` summarizer behind `{ minContextWindowPressure: 0.8 }` so the
 * expensive compaction only fires when the window is genuinely near full, or
 * behind `{ minCostUsd: 1 }` to cap spend on a long-running run.
 *
 * The wrapped stage's `apply` is untouched — gating affects only `shouldRun`.
 * Reactive overflow recovery still bypasses the gate: when `input.reactive`
 * is `true` the stage runs regardless, since the model already reported the
 * context is too large and ignoring that would stall the run.
 *
 * @public
 * @stability experimental v0.1
 */
export function gateStageByUsage(
  stage: CompactionStage,
  thresholds: UsageGateThresholds,
): CompactionStage {
  return {
    name: stage.name,
    tier: stage.tier,
    trigger: stage.trigger,
    async shouldRun(input) {
      if (!input.reactive && !usageMeetsGate(input.hints.usage, thresholds)) {
        return false;
      }
      return stage.shouldRun(input);
    },
    apply(input) {
      return stage.apply(input);
    },
  };
}

// ---------------------------------------------------------------------------
// Observation summarizer — async summary of a completed tool batch, injected
// into the next turn's context.
// ---------------------------------------------------------------------------

/**
 * Optional summarizer the loop can call after each tool batch finishes. The
 * summary is awaited just before the next model call (so it overlaps with
 * any work in-between). Returning `null` skips injection for that batch.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ObservationSummarizer {
  summarizeBatch(input: {
    run: RunRecord;
    step: number;
    results: ToolResult[];
    abortSignal?: AbortSignal;
  }): Promise<string | null> | string | null;
}

export function createPendingSummary(
  summarizer: ObservationSummarizer | undefined,
  input: {
    run: RunRecord;
    step: number;
    results: ToolResult[];
    abortSignal?: AbortSignal;
    events?: EventEmitter;
  },
): Promise<ContextItem | undefined> {
  if (!summarizer || input.results.length === 0) {
    return Promise.resolve(undefined);
  }
  return Promise.resolve()
    .then(() => summarizer.summarizeBatch(input))
    .then((text) => {
      if (!text) return undefined;
      return {
        id: createContextItemId(),
        type: "summary" as const,
        source: { kind: "tool_batch_summary" },
        content: text,
        metadata: {
          layer: "working" as const,
          stability: "session" as const,
          step: input.step,
          summarized: true,
          toolCallIds: input.results.map((r) => r.toolCallId),
        },
      };
    })
    .catch((cause) => {
      input.events?.emit("validation.failed", {
        hookName: "observation_summarizer",
        stage: "tool_result",
        result: {
          status: "failed",
          findings: [
            {
              code: "OBSERVATION_SUMMARIZER_ERROR",
              message: cause instanceof Error ? cause.message : String(cause),
              severity: "warning",
            },
          ],
        },
        metadata: {},
      });
      return undefined;
    });
}

// ---------------------------------------------------------------------------
// Context prefetch — Skills/Memory parallel fetch overlapping the model call.
// ---------------------------------------------------------------------------

/**
 * Pre-step prefetcher. The loop fires `prefetch()` *before* awaiting the
 * model so I/O-bound lookups (Skill index, memory recall, MCP resource
 * fetch, …) overlap the LLM round-trip. Resulting items are merged into the
 * next turn's context. Errors are swallowed and logged — prefetch is a
 * best-effort optimization, never a hard dependency.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ContextPrefetcher {
  readonly name: string;
  prefetch(input: {
    run: RunRecord;
    step: number;
    goal: string;
    abortSignal?: AbortSignal;
  }): Promise<ContextItem[]> | ContextItem[];
}

// ---------------------------------------------------------------------------
// Reference compaction stages. Cheap edits-first stages that ship with core
// so an embedder can compose a multi-tier pipeline without first writing
// their own. Heavier model-backed `auto` and `collapse` stages remain the
// embedder's responsibility (they need provider access).
// ---------------------------------------------------------------------------

/**
 * `tool_result_budget` stage: truncates oversized tool_result ContextItems
 * in-place, replacing the tail with a `[truncated N chars]` marker. Idempotent
 * — re-running on already-truncated items is a no-op.
 *
 * @public
 * @stability experimental v0.1
 */
export function createToolResultBudgetStage(options: {
  maxCharsPerItem: number;
  name?: string;
}): CompactionStage {
  const limit = options.maxCharsPerItem;
  return {
    name: options.name ?? "tool_result_budget",
    tier: "evict",
    trigger: "tool_result_budget",
    shouldRun(input) {
      return input.items.some(
        (item) => item.type === "tool_result" && item.content.length > limit,
      );
    },
    apply(input) {
      let freed = 0;
      const items = input.items.map((item) => {
        if (item.type !== "tool_result") return item;
        if (item.content.length <= limit) return item;
        const head = item.content.slice(0, limit);
        const droppedChars = item.content.length - limit;
        const truncated = `${head}\n…[truncated ${droppedChars} chars by tool_result_budget]`;
        freed += droppedChars - truncated.length + head.length;
        return { ...item, content: truncated };
      });
      return {
        items,
        freedChars: Math.max(0, freed),
        metadata: { limit },
      };
    },
  };
}

export interface ClearToolUsesStageOptions {
  /**
   * Run only once the current context reaches this size. Reactive overflow
   * recovery bypasses this gate. Defaults to 60k chars.
   */
  triggerChars?: number;
  /** Keep the most recent N tool results intact. Defaults to 3. */
  keepRecent?: number;
  /**
   * If set, skip the rewrite unless it would free at least this many chars.
   * Mirrors provider-side "clear_at_least" behavior to avoid small cache
   * breaks that do not buy meaningful room.
   */
  clearAtLeastChars?: number;
  /** Tool names whose results should never be cleared. */
  excludeTools?: string[];
  name?: string;
}

/**
 * `clear_tool_uses` stage: replaces older tool results with stable placeholder
 * observations while keeping recent tool results intact. The runtime still
 * retains the original context; this only edits the prompt-bound copy so the
 * model can see that earlier observations existed but their bodies were
 * intentionally cleared.
 *
 * @public
 * @stability experimental v0.1
 */
export function createClearToolUsesStage(
  options: ClearToolUsesStageOptions = {},
): CompactionStage {
  const triggerChars = options.triggerChars ?? 60_000;
  const keepRecent = Math.max(0, options.keepRecent ?? 3);
  const clearAtLeastChars = Math.max(0, options.clearAtLeastChars ?? 0);
  const excludeTools = new Set(options.excludeTools ?? []);

  return {
    name: options.name ?? "clear_tool_uses",
    tier: "evict",
    trigger: "clear_tool_uses",
    shouldRun(input) {
      if (!input.reactive && input.totalChars < triggerChars) return false;
      const plan = planClearToolUses(input.items, {
        keepRecent,
        excludeTools,
      });
      return (
        plan.replaced > 0 &&
        (clearAtLeastChars === 0 || plan.freedChars >= clearAtLeastChars)
      );
    },
    apply(input) {
      const plan = planClearToolUses(input.items, {
        keepRecent,
        excludeTools,
      });
      if (
        plan.replaced === 0 ||
        (clearAtLeastChars > 0 && plan.freedChars < clearAtLeastChars)
      ) {
        return {
          items: input.items,
          freedChars: 0,
          metadata: {
            replaced: 0,
            skipped: true,
            clearAtLeastChars,
            potentialFreedChars: plan.freedChars,
          },
        };
      }
      return {
        items: plan.items,
        freedChars: plan.freedChars,
        metadata: {
          replaced: plan.replaced,
          keepRecent,
          excludedTools: [...excludeTools],
        },
      };
    },
  };
}

function planClearToolUses(
  items: ContextItem[],
  options: { keepRecent: number; excludeTools: Set<string> },
): { items: ContextItem[]; freedChars: number; replaced: number } {
  const toolResultIndexes = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.type === "tool_result")
    .map(({ index }) => index);
  const keep = new Set(
    toolResultIndexes.slice(
      Math.max(0, toolResultIndexes.length - options.keepRecent),
    ),
  );

  let freedChars = 0;
  let replaced = 0;
  const next = items.map((item, index) => {
    if (item.type !== "tool_result") return item;
    if (keep.has(index)) return item;
    if (item.metadata["clearToolUsesCleared"] === true) return item;
    const toolName = contextToolName(item);
    if (toolName && options.excludeTools.has(toolName)) return item;

    const placeholder = renderClearedToolUsePlaceholder(item, toolName);
    freedChars += Math.max(0, item.content.length - placeholder.length);
    replaced += 1;
    return {
      ...item,
      content: placeholder,
      metadata: {
        ...item.metadata,
        clearToolUsesCleared: true,
        originalChars: item.content.length,
      },
    };
  });

  return { items: next, freedChars, replaced };
}

function contextToolName(item: ContextItem): string | undefined {
  const fromMetadata =
    typeof item.metadata["toolName"] === "string"
      ? item.metadata["toolName"]
      : undefined;
  return fromMetadata ?? item.source?.uri;
}

function renderClearedToolUsePlaceholder(
  item: ContextItem,
  toolName: string | undefined,
): string {
  const status =
    typeof item.metadata["status"] === "string"
      ? ` status=${item.metadata["status"]}`
      : "";
  const tool = toolName ? ` tool=${toolName}` : "";
  const toolCallId =
    typeof item.metadata["toolCallId"] === "string"
      ? ` toolCallId=${item.metadata["toolCallId"]}`
      : "";
  return `[tool result cleared by clear_tool_uses:${tool}${status}${toolCallId} originalChars=${item.content.length}]`;
}

/**
 * `snip` stage: drops the middle of an over-long context, keeping the head
 * and tail. Useful as a coarse second-tier reduction before invoking
 * model-backed summarization. Only runs when total characters exceed
 * `triggerChars`; preserves the most recent `keepTail` items and the oldest
 * `keepHead` items.
 *
 * @public
 * @stability experimental v0.1
 */
export function createSnipStage(options: {
  triggerChars: number;
  keepHead: number;
  keepTail: number;
  name?: string;
}): CompactionStage {
  return {
    name: options.name ?? "snip",
    tier: "evict",
    trigger: "snip",
    shouldRun(input) {
      return (
        input.totalChars >= options.triggerChars &&
        input.items.length > options.keepHead + options.keepTail + 1
      );
    },
    apply(input) {
      const { keepHead, keepTail } = options;
      const head = input.items.slice(0, keepHead);
      const tail = input.items.slice(input.items.length - keepTail);
      const droppedCount = input.items.length - keepHead - keepTail;
      const droppedChars = input.items
        .slice(keepHead, input.items.length - keepTail)
        .reduce((sum, item) => sum + item.content.length, 0);
      const marker: ContextItem = {
        id: createContextItemId(),
        type: "summary",
        source: { kind: "snip" },
        content: `[snipped ${droppedCount} item(s), ${droppedChars} chars]`,
        metadata: {
          layer: "working",
          stability: "turn",
          snipped: true,
          droppedCount,
          droppedChars,
        },
      };
      const items = [...head, marker, ...tail];
      return {
        items,
        freedChars: Math.max(0, droppedChars - marker.content.length),
        metadata: { droppedCount, droppedChars },
      };
    },
  };
}

/**
 * Default deterministic (no-LLM) compaction stages used by the run loop when
 * the embedder does not supply its own `compactionStages`.
 *
 * Layered cheapest-first: a per-item tool-result budget, deterministic
 * micro-compaction for redundant/old tool observations, then a coarse `snip`
 * of the middle. All stages are self-gating — they only fire when they find
 * owned redundancy or genuine overflow — so normal runs keep an append-only,
 * cache-stable prefix while repeated reads and stale observations stop
 * accumulating unboundedly. Model-backed summarization is intentionally NOT
 * included here; that requires provider access and is the embedder's
 * responsibility.
 *
 * Pass `compactionStages: []` to disable compaction entirely.
 *
 * @public
 * @stability experimental v0.1
 */
export function createDefaultCompactionStages(options?: {
  maxCharsPerItem?: number;
  /**
   * Collapse superseded reads of the same file before coarser snipping.
   * Enabled by default because it is deterministic and preserves an id
   * reference to the latest retained read.
   */
  fileReadDedup?: boolean;
  /**
   * Collapse older tool observations to one-line summaries before coarser
   * snipping. Enabled by default because it is deterministic and preserves the
   * newest observations intact.
   */
  observationOneLine?: boolean;
  /**
   * Replace stale tool results with explicit placeholders once context grows.
   * Enabled by default because it preserves chronology while avoiding silent
   * loss of older tool observations.
   */
  clearToolUses?: boolean;
  observationKeepRecent?: number;
  observationMinCharsToCollapse?: number;
  triggerChars?: number;
  keepHead?: number;
  keepTail?: number;
}): CompactionStage[] {
  const stages: CompactionStage[] = [
    createToolResultBudgetStage({
      maxCharsPerItem: options?.maxCharsPerItem ?? 8_000,
    }),
  ];
  if (options?.fileReadDedup !== false) {
    stages.push(createFileReadDedupStage());
  }
  if (options?.observationOneLine !== false) {
    stages.push(
      createObservationOneLineStage({
        keepRecent: options?.observationKeepRecent,
        minCharsToCollapse: options?.observationMinCharsToCollapse,
      }),
    );
  }
  if (options?.clearToolUses !== false) {
    stages.push(createClearToolUsesStage());
  }
  stages.push(
    createSnipStage({
      triggerChars: options?.triggerChars ?? 96_000,
      keepHead: options?.keepHead ?? 2,
      keepTail: options?.keepTail ?? 12,
    }),
  );
  return stages;
}

export function startPrefetch(
  prefetchers: ContextPrefetcher[],
  input: {
    run: RunRecord;
    step: number;
    goal: string;
    abortSignal?: AbortSignal;
    events?: EventEmitter;
  },
): Promise<ContextItem[]> {
  if (prefetchers.length === 0) return Promise.resolve([]);
  return Promise.all(
    prefetchers.map(async (prefetcher) => {
      try {
        const items = await prefetcher.prefetch(input);
        return items ?? [];
      } catch (cause) {
        input.events?.emit("validation.failed", {
          hookName: prefetcher.name,
          stage: "tool_result",
          result: {
            status: "failed",
            findings: [
              {
                code: "PREFETCH_ERROR",
                message: cause instanceof Error ? cause.message : String(cause),
                severity: "warning",
              },
            ],
          },
          metadata: {},
        });
        return [];
      }
    }),
  ).then((nested) => nested.flat());
}
