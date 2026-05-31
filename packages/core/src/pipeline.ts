// =============================================================================
// pipeline.ts — Loop-adjacent extension points (compaction, summarization,
// prefetch, stop hooks, post-sampling hooks). These are the "edges" the
// reference run loop talks to in addition to the model adapter and tool
// registry. Each interface is optional; the loop degrades gracefully when
// nothing is wired up.
//
// Design notes:
// - Compactors run as a pipeline (apply-in-order until budget pressure is
//   relieved or all stages are exhausted). The reference sequence is
//   cheap edits first, model-backed last:
//   `applyToolResultBudget → snip → micro → collapse → auto`.
// - Stop hooks are a stage of the existing ValidationHook (`pre_terminal`)
//   that can block run completion and inject a continuation note.
// - Post-sampling hooks are explicitly fire-and-forget — they observe model
//   output but cannot influence the loop. Errors are surfaced as events.
// - The summarizer is opt-in async; the loop awaits it just before the next
//   model call and inserts the summary as a `summary` ContextItem.
// =============================================================================

import { createContextItemId } from "./ids.js";
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
  | "snip" // drop middle redundant items
  | "micro" // replace stale tool results with id refs
  | "collapse" // fold older blocks into summaries
  | "auto" // model-driven full-history summary
  | "reactive"; // recover from over-budget error

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
  readonly trigger: CompactionTrigger;
  shouldRun(input: CompactionStageInput): boolean | Promise<boolean>;
  apply(
    input: CompactionStageInput,
  ): Promise<CompactionStageResult> | CompactionStageResult;
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
   * Stage may be invoked reactively in response to a previous overflow
   * error. When `reactive: true`, stages may be more aggressive.
   */
  reactive: boolean;
}

export interface CompactionStageResult {
  items: ContextItem[];
  freedChars: number;
  metadata?: Record<string, unknown>;
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
  appliedStages: Array<{
    name: string;
    trigger: CompactionTrigger;
    freedChars: number;
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
      const reactive = Boolean(input.reactive);

      for (const stage of stages) {
        const totalChars = items.reduce(
          (sum, item) => sum + item.content.length,
          0,
        );
        const stageInput: CompactionStageInput = {
          items,
          hints: input.hints,
          totalChars,
          reactive,
        };

        let willRun: boolean;
        try {
          willRun = await stage.shouldRun(stageInput);
        } catch (cause) {
          input.events?.emit("context.compaction.failed", {
            stage: stage.name,
            trigger: stage.trigger,
            phase: "should_run",
            error: cause instanceof Error ? cause.message : String(cause),
          });
          continue;
        }
        if (!willRun) continue;

        input.events?.emit("context.compaction.started", {
          stage: stage.name,
          trigger: stage.trigger,
          reactive,
          totalChars,
        });

        try {
          const result = await stage.apply(stageInput);
          items = result.items;
          applied.push({
            name: stage.name,
            trigger: stage.trigger,
            freedChars: result.freedChars,
            metadata: result.metadata,
          });
          input.events?.emit("context.compaction.completed", {
            stage: stage.name,
            trigger: stage.trigger,
            freedChars: result.freedChars,
            metadata: result.metadata,
          });
        } catch (cause) {
          input.events?.emit("context.compaction.failed", {
            stage: stage.name,
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
      return { items, freedChars, appliedStages: applied };
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
 * Layered cheapest-first: a per-item tool-result budget, then a coarse `snip`
 * of the middle. Both are self-gating — they only fire when an item or the
 * whole context genuinely overflows — so normal runs keep an append-only,
 * cache-stable prefix and compaction only kicks in late, collapsing a big
 * chunk at once. Model-backed summarization is intentionally NOT included
 * here; that requires provider access and is the embedder's responsibility.
 *
 * Pass `compactionStages: []` to disable compaction entirely.
 *
 * @public
 * @stability experimental v0.1
 */
export function createDefaultCompactionStages(options?: {
  maxCharsPerItem?: number;
  triggerChars?: number;
  keepHead?: number;
  keepTail?: number;
}): CompactionStage[] {
  return [
    createToolResultBudgetStage({
      maxCharsPerItem: options?.maxCharsPerItem ?? 8_000,
    }),
    createSnipStage({
      triggerChars: options?.triggerChars ?? 96_000,
      keepHead: options?.keepHead ?? 2,
      keepTail: options?.keepTail ?? 12,
    }),
  ];
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
