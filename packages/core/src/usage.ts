// =============================================================================
// AI maintenance note
//
// UsageTracker aggregates per-run usage (tokens, model calls, tool calls,
// wall time, cost) and emits `usage.updated` events. It is fed automatically
// by the run loop:
//
//   - run.ts `recordModelUsage()`      → recordModelUsage()
//   - run.ts `processToolCall()`       → recordToolUsage()
//   - run.ts loop start                → markStarted()
//
// Embedders that want their own aggregation (billing, dashboards) can pass a
// custom UsageTracker via CreateRunOptions.usageTracker. The default
// `createUsageTracker()` is an in-memory implementation suitable for tests
// and single-process deployments.
//
// `RunHandle.usage()` returns the current snapshot.
// =============================================================================

import type { EventEmitter } from "./events.js";
import type { RunId } from "./ids.js";
import type { ModelUsage, ToolResult } from "./types.js";

export interface UsageTokenTotals {
  input: number;
  output: number;
  total: number;
  /** Prompt-cache read tokens (subset of `input`), billed at the cache rate. */
  cached: number;
}

export interface UsageToolStats {
  calls: number;
  failures: number;
}

export interface UsageModelStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  costStatus?: UsageCostStatus;
  costUnavailableReasons?: Record<string, number>;
}

export type UsageCostStatus = "estimated" | "unavailable" | "partial";

export interface UsageSnapshot {
  runId: RunId;
  /** @reserved Public usage-protocol field consumed by billing/dashboards. */
  startedAt?: string;
  updatedAt: string;
  /** @reserved Public usage-protocol field consumed by billing/dashboards. */
  wallTimeMs: number;
  modelCalls: number;
  toolCalls: number;
  /**
   * Input-token count of the most recent model call — i.e. the live context
   * size, not a running sum. Reflects how full the window is, distinct from
   * `tokens.input` which sums every call's input across the run.
   */
  contextTokens: number;
  tokens: UsageTokenTotals;
  costUsd: number;
  costStatus?: UsageCostStatus;
  costUnavailableReasons?: Record<string, number>;
  /** @reserved Public usage-protocol field consumed by billing/dashboards. */
  byTool: Record<string, UsageToolStats>;
  /** @reserved Public usage-protocol field consumed by billing/dashboards. */
  byModel: Record<string, UsageModelStats>;
}

export interface UsageTracker {
  markStarted(): void;
  recordModelUsage(input: {
    adapterId?: string;
    usage: ModelUsage | undefined;
  }): void;
  recordToolUsage(input: {
    toolName: string;
    status: ToolResult["status"];
  }): void;
  snapshot(): UsageSnapshot;
  subscribe(listener: (snapshot: UsageSnapshot) => void): () => void;
}

export interface CreateUsageTrackerOptions {
  runId: RunId;
  /**
   * Optional event emitter. When supplied, the tracker emits `usage.updated`
   * with the latest snapshot as payload after every record* call.
   */
  emitter?: EventEmitter;
  /** Override the clock (defaults to `Date.now`). Useful for tests. */
  now?: () => number;
}

export function createUsageTracker(
  options: CreateUsageTrackerOptions,
): UsageTracker {
  const now = options.now ?? (() => Date.now());
  const runId = options.runId;
  let startedAtMs: number | undefined;
  let updatedAtMs = now();
  const listeners = new Set<(snapshot: UsageSnapshot) => void>();

  const counters = {
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
  };
  let estimatedCostSeen = false;
  const costUnavailableReasons: Record<string, number> = {};
  let contextTokens = 0;
  const byTool: Record<string, UsageToolStats> = {};
  const byModel: Record<string, UsageModelStats> = {};

  function build(): UsageSnapshot {
    return {
      runId,
      startedAt:
        startedAtMs === undefined
          ? undefined
          : new Date(startedAtMs).toISOString(),
      updatedAt: new Date(updatedAtMs).toISOString(),
      wallTimeMs:
        startedAtMs === undefined ? 0 : Math.max(0, now() - startedAtMs),
      modelCalls: counters.modelCalls,
      toolCalls: counters.toolCalls,
      contextTokens,
      tokens: {
        input: counters.inputTokens,
        output: counters.outputTokens,
        total: counters.totalTokens,
        cached: counters.cachedTokens,
      },
      costUsd: counters.costUsd,
      ...costStatusFields(estimatedCostSeen, costUnavailableReasons),
      byTool: cloneTool(byTool),
      byModel: cloneModel(byModel),
    };
  }

  function publish(): void {
    updatedAtMs = now();
    const snap = build();
    if (options.emitter) {
      try {
        options.emitter.emit("usage.updated", snap);
      } catch {
        // emitter errors must not break the run loop
      }
    }
    for (const listener of listeners) {
      try {
        listener(snap);
      } catch {
        // listener errors must not break the run loop
      }
    }
  }

  return {
    markStarted() {
      if (startedAtMs === undefined) startedAtMs = now();
      publish();
    },
    recordModelUsage({ adapterId, usage }) {
      counters.modelCalls += 1;
      if (usage) {
        const input = usage.inputTokens ?? 0;
        const output = usage.outputTokens ?? 0;
        const total = usage.totalTokens ?? input + output;
        counters.inputTokens += input;
        counters.outputTokens += output;
        counters.totalTokens += total;
        counters.cachedTokens += usage.cacheReadTokens ?? 0;
        counters.costUsd += usage.costUsd ?? 0;
        if (usage.costStatus === "estimated" || usage.costUsd !== undefined) {
          estimatedCostSeen = true;
        }
        if (usage.costStatus === "unavailable") {
          incrementReason(
            costUnavailableReasons,
            usage.costUnavailableReason ?? "unknown",
          );
        }
        if (typeof usage.inputTokens === "number") contextTokens = input;
        if (adapterId) {
          const slot = (byModel[adapterId] ??= {
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          });
          slot.calls += 1;
          slot.inputTokens += input;
          slot.outputTokens += output;
          slot.totalTokens += total;
          slot.costUsd += usage.costUsd ?? 0;
          recordModelCostStatus(slot, usage);
        }
      } else if (adapterId) {
        const slot = (byModel[adapterId] ??= {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        });
        slot.calls += 1;
      }
      publish();
    },
    recordToolUsage({ toolName, status }) {
      counters.toolCalls += 1;
      const slot = (byTool[toolName] ??= { calls: 0, failures: 0 });
      slot.calls += 1;
      if (status !== "completed") slot.failures += 1;
      publish();
    },
    snapshot() {
      return build();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Session-level usage, summed across every run in a session. A run's
 * UsageTracker resets to zero each turn, so `tokens`/`calls`/`costUsd` here are
 * the running totals across turns. `contextTokens` is NOT summed — it carries
 * the live context size from the most-recently-updated run.
 */
export interface SessionUsageTotals {
  /** @reserved Public session-usage field consumed by billing/dashboards. */
  runCount: number;
  modelCalls: number;
  toolCalls: number;
  contextTokens: number;
  tokens: UsageTokenTotals;
  costUsd: number;
}

export interface SessionUsageAccumulator {
  /**
   * @reserved Public accumulator helper consumed by session usage integrators.
   * Fold a run's latest snapshot in; returns the updated session totals.
   */
  fold(snapshot: UsageSnapshot): SessionUsageTotals;
  total(): SessionUsageTotals;
}

/**
 * Sum per-run snapshots into a session total. A run emits many snapshots as it
 * progresses (each a running total for that run), so we key by runId and keep
 * the latest snapshot per run, then sum across runs — never double-counting a
 * run's intermediate snapshots.
 */
export function createSessionUsageAccumulator(): SessionUsageAccumulator {
  const byRun = new Map<RunId, UsageSnapshot>();
  let lastRunId: RunId | undefined;

  function total(): SessionUsageTotals {
    const t: SessionUsageTotals = {
      runCount: byRun.size,
      modelCalls: 0,
      toolCalls: 0,
      contextTokens: 0,
      tokens: { input: 0, output: 0, total: 0, cached: 0 },
      costUsd: 0,
    };
    for (const snap of byRun.values()) {
      t.modelCalls += snap.modelCalls;
      t.toolCalls += snap.toolCalls;
      t.tokens.input += snap.tokens.input;
      t.tokens.output += snap.tokens.output;
      t.tokens.total += snap.tokens.total;
      t.tokens.cached += snap.tokens.cached;
      t.costUsd += snap.costUsd;
    }
    const last = lastRunId === undefined ? undefined : byRun.get(lastRunId);
    t.contextTokens = last?.contextTokens ?? 0;
    return t;
  }

  return {
    fold(snapshot) {
      byRun.set(snapshot.runId, snapshot);
      lastRunId = snapshot.runId;
      return total();
    },
    total,
  };
}

function cloneTool(
  src: Record<string, UsageToolStats>,
): Record<string, UsageToolStats> {
  const copy: Record<string, UsageToolStats> = {};
  for (const [k, v] of Object.entries(src)) copy[k] = { ...v };
  return copy;
}

function cloneModel(
  src: Record<string, UsageModelStats>,
): Record<string, UsageModelStats> {
  const copy: Record<string, UsageModelStats> = {};
  for (const [k, v] of Object.entries(src)) {
    copy[k] = {
      ...v,
      ...(v.costUnavailableReasons
        ? { costUnavailableReasons: { ...v.costUnavailableReasons } }
        : {}),
    };
  }
  return copy;
}

function recordModelCostStatus(
  stats: UsageModelStats,
  usage: ModelUsage,
): void {
  const estimatedSeen =
    stats.costStatus === "estimated" ||
    stats.costStatus === "partial" ||
    usage.costStatus === "estimated" ||
    usage.costUsd !== undefined;
  if (usage.costStatus === "unavailable") {
    const reasons = (stats.costUnavailableReasons ??= {});
    incrementReason(reasons, usage.costUnavailableReason ?? "unknown");
  }
  const fields = costStatusFields(
    estimatedSeen,
    stats.costUnavailableReasons ?? {},
  );
  if (fields.costStatus) stats.costStatus = fields.costStatus;
  if (fields.costUnavailableReasons) {
    stats.costUnavailableReasons = fields.costUnavailableReasons;
  }
}

function costStatusFields(
  estimatedSeen: boolean,
  unavailableReasons: Record<string, number>,
): Pick<UsageSnapshot, "costStatus" | "costUnavailableReasons"> {
  const unavailableSeen = Object.keys(unavailableReasons).length > 0;
  const costStatus =
    estimatedSeen && unavailableSeen
      ? "partial"
      : estimatedSeen
        ? "estimated"
        : unavailableSeen
          ? "unavailable"
          : undefined;
  return {
    ...(costStatus ? { costStatus } : {}),
    ...(unavailableSeen
      ? { costUnavailableReasons: { ...unavailableReasons } }
      : {}),
  };
}

function incrementReason(target: Record<string, number>, reason: string): void {
  target[reason] = (target[reason] ?? 0) + 1;
}
