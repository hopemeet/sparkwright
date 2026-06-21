// =============================================================================
// session-compaction.ts — deterministic session-history compaction.
//
// Session compaction uses the shared CompactionResult / stage protocol, but it
// owns its own stage taxonomy. Runtime stages understand tool observations;
// session stages understand completed user/assistant turns.
// =============================================================================

import { createContextItemId, type RunId } from "./ids.js";
import type { ContextUsageHint } from "./context.js";
import type { ContextItem } from "./types.js";
import {
  createCompactionPipeline,
  type CompactionPipelineResult,
  type CompactionStage,
  type CompactionWarning,
} from "./pipeline.js";

export interface SessionCompactionTurn {
  runId: RunId;
  goal: string;
  message: string;
  traceFacts?: SessionTraceFacts;
}

export interface SessionTraceFacts {
  approvals?: {
    requested?: number;
    approved?: number;
    denied?: number;
  };
  workspaceWrites?: {
    completed?: string[];
    denied?: string[];
    skipped?: string[];
  };
  subagents?: Array<{
    childRunId: string;
    finality?: "complete" | "partial" | string;
    role?: string;
  }>;
}

export type SessionSignalKind =
  | "constraint"
  | "literal"
  | "path"
  | "status"
  | "source_run"
  | "approval"
  | "workspace_write"
  | "subagent";

export interface SessionSignal {
  id: string;
  kind: SessionSignalKind;
  text: string;
  runId?: RunId | string;
  metadata?: Record<string, unknown>;
}

export interface SessionSignals {
  constraints: string[];
  literals: string[];
  paths: string[];
  status: string[];
  entries: SessionSignal[];
}

export type SessionUnknownCostPolicy = "skip" | "token_cap_only";

export interface SessionSummarizerBudget {
  maxSourceChars: number;
  /** @reserved Public auxiliary-task budget field consumed by session summarizers. */
  maxOutputTokens: number;
  /** @reserved Public auxiliary-task budget refinement consumed by future tokenizer-aware gates. */
  maxInputTokens?: number;
  maxCostUsd?: number;
  unknownCostPolicy?: SessionUnknownCostPolicy;
}

export interface SessionSummaryResult {
  content: string;
  coveredSignalIds?: string[];
  unknownSignalIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface SessionSummarizer {
  summarizeSession(input: {
    items: ContextItem[];
    requiredSignals: SessionSignals;
    sourceRunIds: RunId[];
    budget: SessionSummarizerBudget;
    abortSignal?: AbortSignal;
  }): Promise<SessionSummaryResult | null> | SessionSummaryResult | null;
}

export type SessionCompactionRegime =
  | "no_savings"
  | "redundancy_bound"
  | "density_bound"
  | "mixed";

export interface SessionCompactionSummarizerMeasurement {
  applied: boolean;
  skippedReason?: string;
  mode?: string;
  modelId?: string;
  promptVersion?: string;
  /** @reserved Public oracle version consumed by artifact and diagnostics readers. */
  oracleVersion?: string;
  /** @reserved Public summary input fingerprint consumed by artifact reuse diagnostics. */
  inputHash?: string;
  /** @reserved Public reproducibility flag consumed by compact artifact readers. */
  nonDeterministic?: boolean;
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface SessionCompactionMeasurement {
  sourceRunCount: number;
  originalCharCount: number;
  summaryCharCount: number;
  freedChars: number;
  savingsRatio: number;
  freedByTier: CompactionPipelineResult["freedByTier"];
  regime: SessionCompactionRegime;
  signalCount: number;
  summarizer?: SessionCompactionSummarizerMeasurement;
}

export interface SessionCompactionCorpusCase {
  id: string;
  turns: SessionCompactionTurn[];
  options?: SessionCompactionOptions;
  expectedRegime?: SessionCompactionRegime;
}

export interface SessionCompactionCorpusReport {
  cases: Array<{
    id: string;
    result: SessionCompactionResult;
    measurement: SessionCompactionMeasurement;
    expectedRegime?: SessionCompactionRegime;
    passedExpectedRegime?: boolean;
  }>;
  totals: {
    caseCount: number;
    originalCharCount: number;
    summaryCharCount: number;
    freedChars: number;
    savingsRatio: number;
    byRegime: Record<SessionCompactionRegime, number>;
    summarizerCostUsd?: number;
    summarizerLatencyMs?: number;
  };
}

export interface SessionSummarizerWakePolicy {
  minContextWindowPressure?: number;
  maxDedupFreedRatio?: number;
}

export type SessionSummarizerTrigger = "manual" | "auto";

export interface SessionCompactionOptions {
  reason?: string;
  stages?: CompactionStage[];
  summarizer?: SessionSummarizer;
  summarizerTrigger?: SessionSummarizerTrigger;
  summarizerBudget?: Partial<SessionSummarizerBudget>;
  summarizerUsage?: ContextUsageHint;
  summarizerWakePolicy?: SessionSummarizerWakePolicy;
  summarizerModelId?: string;
  summarizerTimeoutMs?: number;
  abortSignal?: AbortSignal;
  extractionMaxUserChars?: number;
  extractionMaxAssistantChars?: number;
  extractionMinOriginalChars?: number;
  evictionTriggerChars?: number;
  evictionKeepHeadTurns?: number;
  evictionKeepTailTurns?: number;
}

interface SessionCompactionResultBase {
  items: ContextItem[];
  content: string;
  sourceRunIds: RunId[];
  originalCharCount: number;
  summaryCharCount: number;
  freedChars: number;
  measurement: SessionCompactionMeasurement;
  warnings?: CompactionWarning[];
  appliedStages: CompactionPipelineResult["appliedStages"];
  skippedStages: CompactionPipelineResult["skippedStages"];
}

export interface SessionCompactionAppliedResult extends SessionCompactionResultBase {
  throughRunId: RunId;
  compactedRunCount: number;
  skippedReason?: undefined;
}

export interface SessionCompactionSkippedResult extends SessionCompactionResultBase {
  throughRunId: null;
  compactedRunCount: 0;
  skippedReason: string;
}

export type SessionCompactionResult =
  | SessionCompactionAppliedResult
  | SessionCompactionSkippedResult;

export function sessionTurnToContextItems(
  turn: SessionCompactionTurn,
): ContextItem[] {
  return [
    {
      id: `ctx_${turn.runId}_user` as ContextItem["id"],
      type: "user",
      source: { kind: "session_turn", uri: turn.runId },
      content: turn.goal.trim(),
      metadata: {
        layer: "conversation",
        stability: "session",
        runId: turn.runId,
        turnRole: "user",
        ...(turn.traceFacts ? { sessionTraceFacts: turn.traceFacts } : {}),
      },
    },
    {
      id: `ctx_${turn.runId}_assistant` as ContextItem["id"],
      type: "assistant",
      source: { kind: "session_turn", uri: turn.runId },
      content: turn.message.trim(),
      metadata: {
        layer: "conversation",
        stability: "session",
        runId: turn.runId,
        turnRole: "assistant",
      },
    },
  ];
}

export function sessionTurnsToContextItems(
  turns: SessionCompactionTurn[],
): ContextItem[] {
  return turns.flatMap((turn) => sessionTurnToContextItems(turn));
}

export function compactSessionTurns(
  turns: SessionCompactionTurn[],
  options: SessionCompactionOptions = {},
): Promise<SessionCompactionResult> {
  return Promise.resolve().then(async () => {
    const sourceRunIds = turns.map((turn) => turn.runId);
    const sourceItems = sessionTurnsToContextItems(turns);
    const originalCharCount = turns.reduce(
      (sum, turn) => sum + turn.goal.length + turn.message.length,
      0,
    );
    const sourceSignals = extractSessionSignalsFromItems(
      sourceItems,
      sourceRunIds,
    );

    if (turns.length === 0) {
      return skippedSessionCompactionResult({
        sourceRunIds,
        originalCharCount,
        signalCount: 0,
        skippedReason: "no_completed_turns",
      });
    }

    const pipeline = createCompactionPipeline({
      stages: options.stages ?? createDefaultSessionCompactionStages(options),
    });
    const result = await pipeline.run({
      items: sourceItems,
      hints: {
        budget: { maxTotalChars: Math.max(1, originalCharCount) },
        ...(options.summarizerUsage ? { usage: options.summarizerUsage } : {}),
        reasons: [
          "session_compact",
          ...(options.reason ? [options.reason] : []),
        ],
        metadata: {
          sessionSourceRunIds: sourceRunIds,
        },
      },
    });

    const throughRunId = sourceRunIds[sourceRunIds.length - 1]!;
    const content = renderSessionCompactionContent({
      items: result.items,
      sourceRunIds,
      throughRunId,
      originalCharCount,
      pipelineResult: result,
      reason: options.reason,
    });
    const summaryCharCount = content.length;
    const freedChars = Math.max(0, originalCharCount - summaryCharCount);
    const measurement = createSessionCompactionMeasurement({
      sourceRunIds,
      originalCharCount,
      summaryCharCount,
      freedChars,
      pipelineResult: result,
      signalCount: sourceSignals.entries.length,
    });

    if (freedChars <= 0 || result.freedChars <= 0) {
      return {
        ...skippedSessionCompactionResult({
          sourceRunIds,
          originalCharCount,
          signalCount: sourceSignals.entries.length,
          skippedReason: result.skippedReason ?? "no_savings",
          warnings: result.warnings,
          appliedStages: result.appliedStages,
          skippedStages: result.skippedStages,
          measurement: {
            ...measurement,
            summaryCharCount: originalCharCount,
            freedChars: 0,
            savingsRatio: 0,
            regime: "no_savings",
          },
        }),
        summaryCharCount: originalCharCount,
      };
    }

    return {
      items: result.items,
      content,
      sourceRunIds,
      throughRunId,
      compactedRunCount: turns.length,
      originalCharCount,
      summaryCharCount,
      freedChars,
      measurement,
      warnings: result.warnings,
      appliedStages: result.appliedStages,
      skippedStages: result.skippedStages,
    };
  });
}

function skippedSessionCompactionResult(input: {
  sourceRunIds: RunId[];
  originalCharCount: number;
  signalCount: number;
  skippedReason: string;
  warnings?: CompactionWarning[];
  appliedStages?: CompactionPipelineResult["appliedStages"];
  skippedStages?: CompactionPipelineResult["skippedStages"];
  measurement?: SessionCompactionMeasurement;
}): SessionCompactionResult {
  return {
    items: [],
    content: "",
    sourceRunIds: input.sourceRunIds,
    throughRunId: null,
    compactedRunCount: 0,
    originalCharCount: input.originalCharCount,
    summaryCharCount: input.originalCharCount,
    freedChars: 0,
    measurement:
      input.measurement ??
      createSessionCompactionMeasurement({
        sourceRunIds: input.sourceRunIds,
        originalCharCount: input.originalCharCount,
        summaryCharCount: input.originalCharCount,
        freedChars: 0,
        signalCount: input.signalCount,
      }),
    skippedReason: input.skippedReason,
    warnings: input.warnings,
    appliedStages: input.appliedStages ?? [],
    skippedStages: input.skippedStages ?? [],
  };
}

export function createDefaultSessionCompactionStages(
  options: SessionCompactionOptions = {},
): CompactionStage[] {
  const stages: CompactionStage[] = [
    createSessionDuplicateTurnStage(),
    createSessionTurnExtractionStage({
      maxUserChars: options.extractionMaxUserChars,
      maxAssistantChars: options.extractionMaxAssistantChars,
      minOriginalChars: options.extractionMinOriginalChars,
    }),
    createSessionOldTurnEvictionStage({
      triggerChars: options.evictionTriggerChars,
      keepHeadTurns: options.evictionKeepHeadTurns,
      keepTailTurns: options.evictionKeepTailTurns,
    }),
  ];
  if (options.summarizer) {
    stages.push(
      createSessionSummarizerStage({
        summarizer: options.summarizer,
        trigger: options.summarizerTrigger,
        budget: options.summarizerBudget,
        wakePolicy: options.summarizerWakePolicy,
        modelId: options.summarizerModelId,
        timeoutMs: options.summarizerTimeoutMs,
        abortSignal: options.abortSignal,
      }),
    );
  }
  return stages;
}

export function createSessionDuplicateTurnStage(
  options: {
    name?: string;
  } = {},
): CompactionStage {
  return {
    name: options.name ?? "session_duplicate_turns",
    tier: "dedup",
    trigger: "micro",
    shouldRun(input) {
      const seen = new Set<string>();
      for (const turn of collectSessionTurns(input.items)) {
        const key = duplicateTurnKey(turn);
        if (seen.has(key)) return true;
        seen.add(key);
      }
      return false;
    },
    apply(input) {
      const turns = collectSessionTurns(input.items);
      const latestByKey = new Map<string, SessionCollectedTurn>();
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = turns[i]!;
        const key = duplicateTurnKey(turn);
        if (!latestByKey.has(key)) latestByKey.set(key, turn);
      }

      let freedChars = 0;
      let replaced = 0;
      const drop = new Set<number>();
      const replacements = new Map<number, ContextItem>();
      for (const turn of turns) {
        const latest = latestByKey.get(duplicateTurnKey(turn));
        if (!latest || latest.runId === turn.runId) continue;
        const originalChars =
          turn.user.content.length + turn.assistant.content.length;
        const marker = `[duplicate session turn ${turn.runId}: same as later turn ${latest.runId}]`;
        freedChars += Math.max(0, originalChars - marker.length);
        replaced += 1;
        drop.add(turn.assistantIndex);
        replacements.set(turn.userIndex, {
          id: createContextItemId(),
          type: "summary",
          source: { kind: "session_compact_duplicate", uri: turn.runId },
          content: marker,
          metadata: {
            layer: "conversation",
            stability: "session",
            runId: turn.runId,
            duplicateOfRunId: latest.runId,
            originalChars,
            ...(turn.traceFacts ? { sessionTraceFacts: turn.traceFacts } : {}),
          },
        });
      }

      if (replaced === 0) {
        return {
          items: input.items,
          freedChars: 0,
          skippedReason: "no_duplicate_turns",
        };
      }

      const items: ContextItem[] = [];
      input.items.forEach((item, index) => {
        if (drop.has(index)) return;
        items.push(replacements.get(index) ?? item);
      });
      return {
        items,
        freedChars,
        metadata: { replaced },
      };
    },
  };
}

export function createSessionTurnExtractionStage(
  options: {
    name?: string;
    maxUserChars?: number;
    maxAssistantChars?: number;
    minOriginalChars?: number;
  } = {},
): CompactionStage {
  const maxUserChars = options.maxUserChars ?? 360;
  const maxAssistantChars = options.maxAssistantChars ?? 720;
  const minOriginalChars = options.minOriginalChars ?? 1_200;

  return {
    name: options.name ?? "session_turn_extract",
    tier: "extract",
    trigger: "collapse",
    shouldRun(input) {
      return collectSessionTurns(input.items).some((turn) => {
        const originalChars =
          turn.user.content.length + turn.assistant.content.length;
        return originalChars >= minOriginalChars;
      });
    },
    apply(input) {
      const turns = collectSessionTurns(input.items);
      if (turns.length === 0) {
        return {
          items: input.items,
          freedChars: 0,
          skippedReason: "no_session_turns",
        };
      }

      const drop = new Set<number>();
      const replacements = new Map<number, ContextItem>();
      let freedChars = 0;
      let extracted = 0;
      for (let i = 0; i < turns.length; i += 1) {
        const turn = turns[i]!;
        const originalChars =
          turn.user.content.length + turn.assistant.content.length;
        if (originalChars < minOriginalChars) continue;
        const content = renderExtractedTurn(turn, i + 1, {
          maxUserChars,
          maxAssistantChars,
        });
        const saved = originalChars - content.length;
        if (saved <= 0) continue;
        freedChars += saved;
        extracted += 1;
        drop.add(turn.assistantIndex);
        replacements.set(turn.userIndex, {
          id: createContextItemId(),
          type: "summary",
          source: { kind: "session_turn_extract", uri: turn.runId },
          content,
          metadata: {
            layer: "conversation",
            stability: "session",
            runId: turn.runId,
            sessionTurnExtracted: true,
            originalChars,
            extractedChars: content.length,
            ...(turn.traceFacts ? { sessionTraceFacts: turn.traceFacts } : {}),
          },
        });
      }

      if (extracted === 0) {
        return {
          items: input.items,
          freedChars: 0,
          skippedReason: "no_extractable_turns",
        };
      }

      const items: ContextItem[] = [];
      input.items.forEach((item, index) => {
        if (drop.has(index)) return;
        items.push(replacements.get(index) ?? item);
      });
      return {
        items,
        freedChars,
        metadata: {
          extracted,
          maxUserChars,
          maxAssistantChars,
          minOriginalChars,
        },
      };
    },
  };
}

export function createSessionOldTurnEvictionStage(
  options: {
    name?: string;
    triggerChars?: number;
    keepHeadTurns?: number;
    keepTailTurns?: number;
  } = {},
): CompactionStage {
  const triggerChars = options.triggerChars ?? 24_000;
  const keepHeadTurns = Math.max(0, options.keepHeadTurns ?? 2);
  const keepTailTurns = Math.max(1, options.keepTailTurns ?? 8);

  return {
    name: options.name ?? "session_old_turn_evict",
    tier: "evict",
    trigger: "snip",
    shouldRun(input) {
      const candidates = collectSessionEvictionUnits(input.items);
      return (
        input.totalChars >= triggerChars &&
        candidates.length > keepHeadTurns + keepTailTurns + 1
      );
    },
    apply(input) {
      const candidates = collectSessionEvictionUnits(input.items);
      if (candidates.length <= keepHeadTurns + keepTailTurns + 1) {
        return {
          items: input.items,
          freedChars: 0,
          skippedReason: "not_enough_session_turns",
        };
      }

      const middle = candidates.slice(
        keepHeadTurns,
        candidates.length - keepTailTurns,
      );
      if (middle.length === 0) {
        return {
          items: input.items,
          freedChars: 0,
          skippedReason: "no_middle_session_turns",
        };
      }

      const droppedIndexes = new Set<number>();
      for (const entry of middle) {
        for (let i = entry.startIndex; i <= entry.endIndex; i += 1) {
          droppedIndexes.add(i);
        }
      }
      const droppedRunIds = middle
        .map((entry) => entry.runId)
        .filter((value): value is string => Boolean(value));
      const droppedTraceFacts = mergeSessionTraceFacts(
        middle.map((entry) => entry.traceFacts),
      );
      const droppedChars = middle.reduce(
        (sum, entry) => sum + entry.contentChars,
        0,
      );
      const markerContent = [
        `[evicted ${middle.length} older compacted session turn(s), ${droppedChars} chars]`,
        droppedRunIds.length > 0 ? `Run ids: ${droppedRunIds.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const marker: ContextItem = {
        id: createContextItemId(),
        type: "summary",
        source: { kind: "session_compact_eviction" },
        content: markerContent,
        metadata: {
          layer: "conversation",
          stability: "session",
          sessionTurnsEvicted: true,
          droppedRunIds,
          droppedCount: middle.length,
          droppedChars,
          ...(droppedTraceFacts
            ? { sessionTraceFacts: droppedTraceFacts }
            : {}),
        },
      };

      const insertAt = middle[0]!.startIndex;
      const items: ContextItem[] = [];
      for (let i = 0; i < input.items.length; i += 1) {
        if (i === insertAt) items.push(marker);
        if (droppedIndexes.has(i)) continue;
        items.push(input.items[i]!);
      }

      const warnings: CompactionWarning[] = [
        {
          code: "SESSION_TURNS_EVICTED",
          message:
            "Older compacted session turns were replaced by an explicit marker.",
          metadata: { droppedRunIds, droppedCount: middle.length },
        },
      ];

      return {
        items,
        freedChars: Math.max(0, droppedChars - markerContent.length),
        warnings,
        metadata: {
          droppedRunIds,
          droppedCount: middle.length,
          droppedChars,
          keepHeadTurns,
          keepTailTurns,
        },
      };
    },
  };
}

export const DEFAULT_SESSION_SUMMARIZER_BUDGET: SessionSummarizerBudget = {
  maxSourceChars: 60_000,
  maxOutputTokens: 1_600,
  unknownCostPolicy: "skip",
};

const DEFAULT_SESSION_SUMMARIZER_TIMEOUT_MS = 60_000;

export const SESSION_SUMMARY_ORACLE_VERSION = "session-signals.v1" as const;

const DEFAULT_SESSION_SUMMARIZER_WAKE_POLICY: Required<SessionSummarizerWakePolicy> =
  {
    minContextWindowPressure: 0.8,
    maxDedupFreedRatio: 0.4,
  };

export function createSessionSummarizerStage(options: {
  summarizer: SessionSummarizer;
  name?: string;
  trigger?: SessionSummarizerTrigger;
  budget?: Partial<SessionSummarizerBudget>;
  wakePolicy?: SessionSummarizerWakePolicy;
  modelId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): CompactionStage {
  const trigger = options.trigger ?? "manual";
  const budget = normalizeSessionSummarizerBudget(options.budget);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_SUMMARIZER_TIMEOUT_MS;
  const wakePolicy = {
    ...DEFAULT_SESSION_SUMMARIZER_WAKE_POLICY,
    ...(options.wakePolicy ?? {}),
  };

  return {
    name: options.name ?? "session_summarize",
    tier: "summarize",
    trigger: "auto",
    shouldRun(input) {
      if (trigger === "manual") return true;
      const usage = input.hints.usage;
      if (
        (usage?.contextWindowPressure ?? 0) <
        wakePolicy.minContextWindowPressure
      ) {
        return false;
      }
      const previousFreed = input.previousFreedChars ?? 0;
      if (previousFreed <= 0) return false;
      const previousByTier = input.previousFreedByTier;
      const dedupFreed = previousByTier?.dedup ?? 0;
      const dedupRatio = dedupFreed / previousFreed;
      return dedupRatio <= wakePolicy.maxDedupFreedRatio;
    },
    async apply(input) {
      const sourceChars = input.items.reduce(
        (sum, item) => sum + item.content.length,
        0,
      );
      const sourceRunIds = sessionSourceRunIds(input.items, input.hints);
      const requiredSignals = extractSessionSignalsFromItems(
        input.items,
        sourceRunIds,
      );
      const inputHash = stableSessionInputHash({
        items: input.items,
        requiredSignals,
        sourceRunIds,
        budget,
      });
      const baseMetadata = {
        trigger,
        modelId: options.modelId,
        budget,
        sourceChars,
        inputHash,
        oracleVersion: SESSION_SUMMARY_ORACLE_VERSION,
        signalCount: requiredSignals.entries.length,
      };

      const spendGate = evaluateSessionSummarizerSpendGate({
        trigger,
        budget,
        sourceChars,
        usage: input.hints.usage,
      });
      if (!spendGate.allowed) {
        return {
          items: input.items,
          freedChars: 0,
          skippedReason: spendGate.reason,
          warnings: spendGate.warnings,
          metadata: {
            ...baseMetadata,
            gate: "spend",
            reason: spendGate.reason,
          },
        };
      }

      let summary: SessionSummaryResult | null;
      try {
        summary = await summarizeSessionWithTimeout({
          summarizer: options.summarizer,
          items: input.items,
          requiredSignals,
          sourceRunIds,
          budget,
          timeoutMs,
          abortSignal: options.abortSignal,
        });
      } catch (cause) {
        return {
          items: input.items,
          freedChars: 0,
          skippedReason: "summarizer_failed",
          warnings: [
            ...spendGate.warnings,
            {
              code: "SESSION_SUMMARIZER_FAILED",
              message: cause instanceof Error ? cause.message : String(cause),
              metadata: baseMetadata,
            },
          ],
          metadata: {
            ...baseMetadata,
            gate: "summarizer",
            reason: "summarizer_failed",
          },
        };
      }

      if (!summary || !summary.content.trim()) {
        return {
          items: input.items,
          freedChars: 0,
          skippedReason: "summarizer_declined",
          warnings: [
            ...spendGate.warnings,
            {
              code: "SESSION_SUMMARIZER_DECLINED",
              message: "Session summarizer declined to produce a summary.",
              metadata: baseMetadata,
            },
          ],
          metadata: {
            ...baseMetadata,
            gate: "summarizer",
            reason: "summarizer_declined",
          },
        };
      }

      const oracle = verifySessionSummaryCoverage(summary, requiredSignals);
      if (!oracle.ok) {
        return {
          items: input.items,
          freedChars: 0,
          skippedReason: "oracle_rejected",
          warnings: [
            ...spendGate.warnings,
            {
              code: "SESSION_SUMMARY_ORACLE_REJECTED",
              message:
                "Session summarizer output omitted required deterministic signals.",
              metadata: {
                ...baseMetadata,
                missingSignalIds: oracle.missingSignalIds,
                unknownSignalIds: oracle.unknownSignalIds,
              },
            },
          ],
          metadata: {
            ...baseMetadata,
            gate: "acceptance",
            reason: "oracle_rejected",
            missingSignalIds: oracle.missingSignalIds,
            unknownSignalIds: oracle.unknownSignalIds,
          },
        };
      }

      const summaryFingerprint = {
        kind: "session_summarizer",
        modelId:
          recordString(summary.metadata, "modelId") ??
          options.modelId ??
          "unknown",
        promptVersion:
          recordString(summary.metadata, "promptVersion") ?? "unknown",
        oracleVersion: SESSION_SUMMARY_ORACLE_VERSION,
        inputHash,
        sourceRunIds,
        throughRunId: sourceRunIds[sourceRunIds.length - 1] ?? null,
        budget,
      };

      const item: ContextItem = {
        id: createContextItemId(),
        type: "summary",
        source: { kind: "session_summary" },
        content: summary.content.trim(),
        metadata: {
          layer: "conversation",
          stability: "session",
          sessionSummarized: true,
          sourceRunIds,
          signalCoverage: {
            required: requiredSignals.entries.length,
            covered:
              requiredSignals.entries.length - oracle.unknownSignalIds.length,
            unknown: oracle.unknownSignalIds.length,
          },
          ...(options.modelId ? { modelId: options.modelId } : {}),
          summaryFingerprint,
          ...(summary.metadata ? { summaryMetadata: summary.metadata } : {}),
        },
      };
      const freedChars = sourceChars - item.content.length;
      if (freedChars <= 0) {
        return {
          items: input.items,
          freedChars: 0,
          skippedReason: "summarizer_no_savings",
          warnings: [
            ...spendGate.warnings,
            {
              code: "SESSION_SUMMARIZER_NO_SAVINGS",
              message:
                "Session summarizer output was not smaller than deterministic content.",
              metadata: baseMetadata,
            },
          ],
          metadata: {
            ...baseMetadata,
            gate: "yield",
            reason: "summarizer_no_savings",
          },
        };
      }

      return {
        items: [item],
        freedChars,
        warnings:
          spendGate.warnings.length > 0 ? spendGate.warnings : undefined,
        metadata: {
          ...baseMetadata,
          mode: summary.metadata?.mode ?? "summarizer",
          nonDeterministic: recordBoolean(summary.metadata, "nonDeterministic"),
          promptVersion: summaryFingerprint.promptVersion,
          summaryFingerprint,
          durationMs: recordNumber(summary.metadata, "durationMs"),
          usage: recordObject(summary.metadata, "usage"),
          coveredSignalIds: summary.coveredSignalIds,
          unknownSignalIds: summary.unknownSignalIds,
          freedChars,
        },
      };
    },
  };
}

async function summarizeSessionWithTimeout(input: {
  summarizer: SessionSummarizer;
  items: ContextItem[];
  requiredSignals: SessionSignals;
  sourceRunIds: RunId[];
  budget: SessionSummarizerBudget;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<SessionSummaryResult | null> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    return input.summarizer.summarizeSession({
      items: input.items,
      requiredSignals: input.requiredSignals,
      sourceRunIds: input.sourceRunIds,
      budget: input.budget,
      abortSignal: input.abortSignal,
    });
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let parentAbort: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        new Error(`Session summarizer timed out after ${input.timeoutMs}ms.`),
      );
    }, input.timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    parentAbort = () => {
      controller.abort(input.abortSignal?.reason);
      reject(new Error("Session summarizer aborted."));
    };
    if (input.abortSignal?.aborted) {
      parentAbort();
      return;
    }
    input.abortSignal?.addEventListener("abort", parentAbort, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve(
        input.summarizer.summarizeSession({
          items: input.items,
          requiredSignals: input.requiredSignals,
          sourceRunIds: input.sourceRunIds,
          budget: input.budget,
          abortSignal: controller.signal,
        }),
      ),
      timeoutPromise,
      abortPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (parentAbort) {
      input.abortSignal?.removeEventListener("abort", parentAbort);
    }
  }
}

export function createDeterministicSessionSummarizer(
  options: { mode?: string } = {},
): SessionSummarizer {
  return {
    summarizeSession(input) {
      const signals = input.requiredSignals.entries;
      const lines = [
        "Session deterministic-summary preview.",
        `Source runs: ${input.sourceRunIds.join(", ") || "(none)"}`,
      ];
      if (signals.length > 0) {
        lines.push("Required signals:");
        for (const signal of signals) {
          lines.push(`- [${signal.id}] ${signal.kind}: ${signal.text}`);
        }
      }
      return {
        content: lines.join("\n"),
        coveredSignalIds: signals.map((signal) => signal.id),
        metadata: {
          mode: options.mode ?? "deterministic_stub",
          nonDeterministic: false,
        },
      };
    },
  };
}

export async function measureSessionCompactionCorpus(
  cases: SessionCompactionCorpusCase[],
): Promise<SessionCompactionCorpusReport> {
  const measured: SessionCompactionCorpusReport["cases"] = [];
  const byRegime: Record<SessionCompactionRegime, number> = {
    no_savings: 0,
    redundancy_bound: 0,
    density_bound: 0,
    mixed: 0,
  };
  let originalCharCount = 0;
  let summaryCharCount = 0;
  let freedChars = 0;
  let summarizerCostUsd = 0;
  let summarizerCostSeen = false;
  let summarizerLatencyMs = 0;
  let summarizerLatencySeen = false;

  for (const entry of cases) {
    const result = await compactSessionTurns(entry.turns, entry.options);
    const measurement = result.measurement;
    measured.push({
      id: entry.id,
      result,
      measurement,
      ...(entry.expectedRegime ? { expectedRegime: entry.expectedRegime } : {}),
      ...(entry.expectedRegime
        ? { passedExpectedRegime: measurement.regime === entry.expectedRegime }
        : {}),
    });
    byRegime[measurement.regime] += 1;
    originalCharCount += measurement.originalCharCount;
    summaryCharCount += measurement.summaryCharCount;
    freedChars += measurement.freedChars;
    if (measurement.summarizer?.costUsd !== undefined) {
      summarizerCostSeen = true;
      summarizerCostUsd += measurement.summarizer.costUsd;
    }
    if (measurement.summarizer?.durationMs !== undefined) {
      summarizerLatencySeen = true;
      summarizerLatencyMs += measurement.summarizer.durationMs;
    }
  }

  return {
    cases: measured,
    totals: {
      caseCount: measured.length,
      originalCharCount,
      summaryCharCount,
      freedChars,
      savingsRatio: originalCharCount > 0 ? freedChars / originalCharCount : 0,
      byRegime,
      ...(summarizerCostSeen ? { summarizerCostUsd } : {}),
      ...(summarizerLatencySeen ? { summarizerLatencyMs } : {}),
    },
  };
}

interface SessionCollectedTurn {
  runId: string;
  userIndex: number;
  assistantIndex: number;
  user: ContextItem;
  assistant: ContextItem;
  traceFacts?: SessionTraceFacts;
}

function collectSessionTurns(items: ContextItem[]): SessionCollectedTurn[] {
  const turns: SessionCollectedTurn[] = [];
  for (let i = 0; i < items.length - 1; i += 1) {
    const user = items[i]!;
    const assistant = items[i + 1]!;
    if (user.type !== "user" || assistant.type !== "assistant") continue;
    const userRunId = metadataString(user.metadata, "runId");
    const assistantRunId = metadataString(assistant.metadata, "runId");
    const runId = userRunId ?? assistantRunId ?? user.source?.uri ?? "";
    if (assistantRunId && userRunId && assistantRunId !== userRunId) continue;
    turns.push({
      runId,
      userIndex: i,
      assistantIndex: i + 1,
      user,
      assistant,
      traceFacts:
        sessionTraceFacts(user.metadata) ??
        sessionTraceFacts(assistant.metadata),
    });
    i += 1;
  }
  return turns;
}

interface SessionEvictionUnit {
  startIndex: number;
  endIndex: number;
  contentChars: number;
  runId?: string;
  traceFacts?: SessionTraceFacts;
}

function collectSessionEvictionUnits(
  items: ContextItem[],
): SessionEvictionUnit[] {
  const turnsByStart = new Map<number, SessionCollectedTurn>();
  const rawTurnIndexes = new Set<number>();
  for (const turn of collectSessionTurns(items)) {
    turnsByStart.set(turn.userIndex, turn);
    rawTurnIndexes.add(turn.userIndex);
    rawTurnIndexes.add(turn.assistantIndex);
  }

  const out: SessionEvictionUnit[] = [];
  items.forEach((item, index) => {
    const turn = turnsByStart.get(index);
    if (turn) {
      out.push({
        startIndex: turn.userIndex,
        endIndex: turn.assistantIndex,
        contentChars: turn.user.content.length + turn.assistant.content.length,
        ...(turn.runId ? { runId: turn.runId } : {}),
        ...(turn.traceFacts ? { traceFacts: turn.traceFacts } : {}),
      });
      return;
    }
    if (rawTurnIndexes.has(index)) return;
    if (
      item.type === "summary" &&
      (item.metadata["sessionTurnExtracted"] === true ||
        item.metadata["duplicateOfRunId"] !== undefined)
    ) {
      out.push({
        startIndex: index,
        endIndex: index,
        contentChars: item.content.length,
        ...(metadataString(item.metadata, "runId")
          ? { runId: metadataString(item.metadata, "runId") }
          : {}),
        ...(sessionTraceFacts(item.metadata)
          ? { traceFacts: sessionTraceFacts(item.metadata) }
          : {}),
      });
    }
  });
  return out;
}

function duplicateTurnKey(turn: SessionCollectedTurn): string {
  return `${normalizeForKey(turn.user.content)}\n---\n${normalizeForKey(
    turn.assistant.content,
  )}`;
}

function normalizeForKey(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderExtractedTurn(
  turn: SessionCollectedTurn,
  turnNumber: number,
  options: { maxUserChars: number; maxAssistantChars: number },
): string {
  const user = compactLine(turn.user.content, options.maxUserChars);
  const assistant = compactLine(
    turn.assistant.content,
    options.maxAssistantChars,
  );
  const signals = extractSessionSignals(
    [turn.user.content, turn.assistant.content],
    {
      sourceRunIds: turn.runId ? [turn.runId as RunId] : [],
      traceFacts: turn.traceFacts,
    },
  );
  const lines = [
    `Turn ${turnNumber} (${turn.runId || "unknown"})`,
    `User: ${user}`,
    `Assistant: ${assistant}`,
  ];
  if (signals.constraints.length > 0) {
    lines.push(`Constraints: ${signals.constraints.join(" | ")}`);
  }
  if (signals.literals.length > 0) {
    lines.push(`Literals: ${signals.literals.join(", ")}`);
  }
  if (signals.paths.length > 0) {
    lines.push(`Paths: ${signals.paths.join(", ")}`);
  }
  if (signals.status.length > 0) {
    lines.push(`Status: ${signals.status.join(", ")}`);
  }
  return lines.join("\n");
}

export function extractSessionSignals(
  parts: string[],
  options: {
    sourceRunIds?: RunId[];
    traceFacts?: SessionTraceFacts;
  } = {},
): SessionSignals {
  const text = parts.join("\n");
  const constraints = uniqueLimited(extractConstraintLines(text), 6);
  const literals = uniqueLimited(extractExactLiteralTokens(text), 12);
  const paths = uniqueLimited(extractPathLikeValues(text), 10);
  const status = uniqueLimited(extractStatusSignals(text), 8);
  const entries: SessionSignal[] = [];
  for (const value of constraints) {
    entries.push(createSessionSignal("constraint", value));
  }
  for (const value of literals) {
    entries.push(createSessionSignal("literal", value));
  }
  for (const value of paths) {
    entries.push(createSessionSignal("path", value));
  }
  for (const value of status) {
    entries.push(createSessionSignal("status", value));
  }
  for (const runId of options.sourceRunIds ?? []) {
    entries.push(createSessionSignal("source_run", runId, { runId }));
  }
  entries.push(...signalsFromTraceFacts(options.traceFacts));
  return {
    constraints,
    literals,
    paths,
    status,
    entries: uniqueSignals(entries),
  };
}

export function extractSessionSignalsFromItems(
  items: ContextItem[],
  sourceRunIds: RunId[] = [],
): SessionSignals {
  const parts = items.map((item) => item.content);
  const facts = mergeSessionTraceFacts(
    items.map((item) => sessionTraceFacts(item.metadata)).filter(Boolean),
  );
  return extractSessionSignals(parts, { sourceRunIds, traceFacts: facts });
}

function extractConstraintLines(text: string): string[] {
  const pattern =
    /(must|should|shall|required|exactly|only|never|do not|don't|cannot|can't|approval|sandbox|read[- ]only|budget|必须|需要|只读|不要|不能|禁止|务必|请勿)/i;
  return text
    .split(/\r?\n/)
    .map((line) => compactLine(line, 180))
    .filter((line) => pattern.test(line));
}

// Language that flags a nearby token as a hard exact-match requirement. Kept
// narrow so we only mint literal signals when the transcript actually asks for
// verbatim preservation, not for every uppercase identifier in tool output.
const EXACT_LITERAL_LANGUAGE =
  /(exact|exactly|verbatim|literal|preserve|keep|retain|include|must contain|character[- ]for[- ]character|原样|逐字|保留|精确|保持|包含)/i;

// Sentinel-shaped tokens (uppercase alnum segments joined by - or _) and
// quoted/backticked literals that sit next to exact-match language. These are
// required verbatim by the oracle, so a paraphrasing summary cannot silently
// drop them even when the surrounding constraint line is compacted away.
function extractExactLiteralTokens(text: string): string[] {
  const candidates: Array<{ value: string; index: number }> = [];
  const push = (value: string | undefined, index: number): void => {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= 2 && trimmed.length <= 80) {
      candidates.push({ value: trimmed, index });
    }
  };
  for (const match of text.matchAll(/[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+/g)) {
    if (match[0].length >= 6) push(match[0], match.index ?? 0);
  }
  for (const match of text.matchAll(/`([^`\n]{2,80})`/g)) {
    push(match[1], match.index ?? 0);
  }
  for (const match of text.matchAll(/"([^"\n]{2,80})"/g)) {
    push(match[1], match.index ?? 0);
  }
  for (const match of text.matchAll(/'([^'\n]{2,80})'/g)) {
    push(match[1], match.index ?? 0);
  }
  const literals: string[] = [];
  for (const candidate of candidates) {
    const windowStart = Math.max(0, candidate.index - 240);
    const windowEnd = candidate.index + candidate.value.length + 80;
    if (EXACT_LITERAL_LANGUAGE.test(text.slice(windowStart, windowEnd))) {
      literals.push(candidate.value);
    }
  }
  return literals;
}

function extractPathLikeValues(text: string): string[] {
  const matches = text.matchAll(
    /(?:^|[\s"'`(])((?:\.{1,2}\/|\/|[A-Za-z]:\\|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_@%+=:.,~#()[\]/\\-]+)/g,
  );
  const paths: string[] = [];
  for (const match of matches) {
    const value = match[1]?.replace(/[),.;:]+$/g, "");
    if (value && value.length >= 3) paths.push(value);
  }
  return paths;
}

function extractStatusSignals(text: string): string[] {
  const signals: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [
      /\b(error|failed|failure|denied|blocked|timeout|timed out)\b/i,
      "failure_or_blocked",
    ],
    [/\b(partial|truncated|incomplete|skipped)\b/i, "partial_or_truncated"],
    [
      /\b(wrote|modified|created|deleted|renamed|patched)\b/i,
      "workspace_write",
    ],
    [/\b(test(ed|s)?|verified|validation|passed)\b/i, "verification"],
    [/(失败|报错|拒绝|阻塞|未完成|截断|跳过)/, "failure_or_blocked"],
    [/(修改|写入|创建|删除|重命名|打补丁)/, "workspace_write"],
    [/(测试|验证|通过)/, "verification"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) signals.push(label);
  }
  return signals;
}

function normalizeSessionSummarizerBudget(
  input: Partial<SessionSummarizerBudget> | undefined,
): SessionSummarizerBudget {
  return {
    ...DEFAULT_SESSION_SUMMARIZER_BUDGET,
    ...(input ?? {}),
    unknownCostPolicy:
      input?.unknownCostPolicy ??
      DEFAULT_SESSION_SUMMARIZER_BUDGET.unknownCostPolicy,
  };
}

function evaluateSessionSummarizerSpendGate(input: {
  trigger: SessionSummarizerTrigger;
  budget: SessionSummarizerBudget;
  sourceChars: number;
  usage?: ContextUsageHint;
}): {
  allowed: boolean;
  reason?: string;
  warnings: CompactionWarning[];
} {
  const warnings: CompactionWarning[] = [];
  if (input.sourceChars > input.budget.maxSourceChars) {
    return {
      allowed: false,
      reason: "source_over_max_source_chars",
      warnings: [
        {
          code: "SESSION_SUMMARIZER_SOURCE_TOO_LARGE",
          message:
            "Session summarizer input exceeded maxSourceChars; deterministic content was kept.",
          metadata: {
            sourceChars: input.sourceChars,
            maxSourceChars: input.budget.maxSourceChars,
          },
        },
      ],
    };
  }

  const explicitDollarCap = input.budget.maxCostUsd !== undefined;
  const costStatus = input.usage?.costStatus;
  const costUnknown = costStatus !== "estimated" && costStatus !== "partial";
  if (costUnknown) {
    const warning: CompactionWarning = {
      code: "SESSION_SUMMARIZER_COST_UNAVAILABLE",
      message:
        "Session summarizer pricing was unavailable; maxCostUsd cannot be enforced.",
      metadata: {
        costStatus: costStatus ?? "unavailable",
        costUnavailableReasons: input.usage?.costUnavailableReasons,
        maxCostUsd: input.budget.maxCostUsd,
        unknownCostPolicy: input.budget.unknownCostPolicy,
      },
    };
    if (
      input.trigger === "auto" &&
      explicitDollarCap &&
      input.budget.unknownCostPolicy !== "token_cap_only"
    ) {
      return {
        allowed: false,
        reason: "unknown_cost_policy_skip",
        warnings: [warning],
      };
    }
    warnings.push(warning);
  }

  return { allowed: true, warnings };
}

function createSessionCompactionMeasurement(input: {
  sourceRunIds: RunId[];
  originalCharCount: number;
  summaryCharCount: number;
  freedChars: number;
  signalCount: number;
  pipelineResult?: CompactionPipelineResult;
}): SessionCompactionMeasurement {
  const freedByTier = input.pipelineResult?.freedByTier ?? {
    dedup: 0,
    extract: 0,
    evict: 0,
    summarize: 0,
  };
  const summarizer = input.pipelineResult
    ? summarizerMeasurement(input.pipelineResult)
    : undefined;
  return {
    sourceRunCount: input.sourceRunIds.length,
    originalCharCount: input.originalCharCount,
    summaryCharCount: input.summaryCharCount,
    freedChars: input.freedChars,
    savingsRatio:
      input.originalCharCount > 0
        ? input.freedChars / input.originalCharCount
        : 0,
    freedByTier,
    regime: classifySessionCompactionRegime(input.freedChars, freedByTier),
    signalCount: input.signalCount,
    ...(summarizer ? { summarizer } : {}),
  };
}

function classifySessionCompactionRegime(
  freedChars: number,
  freedByTier: CompactionPipelineResult["freedByTier"],
): SessionCompactionRegime {
  if (freedChars <= 0) return "no_savings";
  const stageFreed =
    freedByTier.dedup +
    freedByTier.extract +
    freedByTier.evict +
    freedByTier.summarize;
  if (freedByTier.summarize > 0) return "density_bound";
  if (stageFreed <= 0) return "mixed";
  const dedupRatio = freedByTier.dedup / stageFreed;
  if (dedupRatio >= 0.6) return "redundancy_bound";
  const densityFreed = freedByTier.extract + freedByTier.evict;
  if (densityFreed > freedByTier.dedup) return "density_bound";
  return "mixed";
}

function summarizerMeasurement(
  pipelineResult: CompactionPipelineResult,
): SessionCompactionSummarizerMeasurement | undefined {
  const applied = pipelineResult.appliedStages.find(
    (stage) => stage.tier === "summarize",
  );
  const skipped = pipelineResult.skippedStages.find(
    (stage) => stage.tier === "summarize",
  );
  const metadata = applied?.metadata ?? skipped?.metadata;
  if (!metadata) return undefined;
  const fingerprint = recordObject(metadata, "summaryFingerprint");
  const usage = recordObject(metadata, "usage");
  return {
    applied: Boolean(applied),
    ...(skipped?.reason ? { skippedReason: skipped.reason } : {}),
    ...(recordString(metadata, "mode")
      ? { mode: recordString(metadata, "mode") }
      : {}),
    ...(recordString(metadata, "modelId")
      ? { modelId: recordString(metadata, "modelId") }
      : {}),
    ...(recordString(metadata, "promptVersion")
      ? { promptVersion: recordString(metadata, "promptVersion") }
      : {}),
    ...(recordString(metadata, "oracleVersion")
      ? { oracleVersion: recordString(metadata, "oracleVersion") }
      : {}),
    ...(recordString(metadata, "inputHash")
      ? { inputHash: recordString(metadata, "inputHash") }
      : {}),
    ...(recordBoolean(metadata, "nonDeterministic") !== undefined
      ? { nonDeterministic: recordBoolean(metadata, "nonDeterministic") }
      : {}),
    ...(recordNumber(metadata, "durationMs") !== undefined
      ? { durationMs: recordNumber(metadata, "durationMs") }
      : {}),
    ...(recordNumber(usage, "costUsd") !== undefined
      ? { costUsd: recordNumber(usage, "costUsd") }
      : {}),
    ...(recordNumber(usage, "inputTokens") !== undefined
      ? { inputTokens: recordNumber(usage, "inputTokens") }
      : {}),
    ...(recordNumber(usage, "outputTokens") !== undefined
      ? { outputTokens: recordNumber(usage, "outputTokens") }
      : {}),
    ...(recordNumber(usage, "totalTokens") !== undefined
      ? { totalTokens: recordNumber(usage, "totalTokens") }
      : {}),
    ...(fingerprint && recordString(fingerprint, "inputHash")
      ? { inputHash: recordString(fingerprint, "inputHash") }
      : {}),
  };
}

function verifySessionSummaryCoverage(
  summary: SessionSummaryResult,
  requiredSignals: SessionSignals,
): {
  ok: boolean;
  missingSignalIds: string[];
  unknownSignalIds: string[];
} {
  const covered = new Set(summary.coveredSignalIds ?? []);
  const unknown = new Set(summary.unknownSignalIds ?? []);
  const text = normalizeForKey(summary.content);
  const missing: string[] = [];
  const unknownRequired: string[] = [];
  for (const signal of requiredSignals.entries) {
    if (signal.kind === "literal") {
      // Exact literals must appear verbatim. Self-reported coverage cannot
      // waive presence, and marking the literal "unknown" does not excuse
      // dropping a token the user asked to preserve.
      if (signal.text && text.includes(normalizeForKey(signal.text))) continue;
      missing.push(signal.id);
      continue;
    }
    if (unknown.has(signal.id)) {
      unknownRequired.push(signal.id);
      continue;
    }
    const idMarker = normalizeForKey(`[${signal.id}]`);
    const bareId = normalizeForKey(signal.id);
    if (
      covered.has(signal.id) &&
      (text.includes(idMarker) || text.includes(bareId))
    ) {
      continue;
    }
    if (signal.text && text.includes(normalizeForKey(signal.text))) continue;
    missing.push(signal.id);
  }
  return {
    ok: missing.length === 0 && unknownRequired.length === 0,
    missingSignalIds: missing,
    unknownSignalIds: unknownRequired,
  };
}

function sessionSourceRunIds(
  items: ContextItem[],
  hints: { metadata?: Record<string, unknown> },
): RunId[] {
  const fromHints = hints.metadata?.["sessionSourceRunIds"];
  if (Array.isArray(fromHints)) {
    return fromHints.filter(
      (value): value is RunId => typeof value === "string",
    );
  }
  const runIds: RunId[] = [];
  for (const item of items) {
    const value = metadataString(item.metadata, "runId") ?? item.source?.uri;
    if (value && !runIds.includes(value as RunId)) runIds.push(value as RunId);
    const sourceRunIds = item.metadata["sourceRunIds"];
    if (Array.isArray(sourceRunIds)) {
      for (const runId of sourceRunIds) {
        if (typeof runId === "string" && !runIds.includes(runId as RunId)) {
          runIds.push(runId as RunId);
        }
      }
    }
  }
  return runIds;
}

function createSessionSignal(
  kind: SessionSignalKind,
  text: string,
  options: { runId?: RunId | string; metadata?: Record<string, unknown> } = {},
): SessionSignal {
  return {
    id: `${kind}:${stableSignalHash(`${options.runId ?? ""}\n${text}`)}`,
    kind,
    text,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

function uniqueSignals(values: SessionSignal[]): SessionSignal[] {
  const seen = new Set<string>();
  const out: SessionSignal[] = [];
  for (const value of values) {
    if (seen.has(value.id)) continue;
    seen.add(value.id);
    out.push(value);
  }
  return out;
}

function signalsFromTraceFacts(
  facts: SessionTraceFacts | undefined,
): SessionSignal[] {
  if (!facts) return [];
  const entries: SessionSignal[] = [];
  const approvals = facts.approvals;
  if (approvals) {
    for (const [key, count] of Object.entries(approvals)) {
      if (typeof count === "number" && count > 0) {
        entries.push(
          createSessionSignal("approval", `approval_${key}:${count}`, {
            metadata: { [key]: count },
          }),
        );
      }
    }
  }
  const writes = facts.workspaceWrites;
  if (writes) {
    for (const [key, paths] of Object.entries(writes)) {
      if (!Array.isArray(paths) || paths.length === 0) continue;
      entries.push(
        createSessionSignal(
          "workspace_write",
          `workspace_write_${key}:${paths.join(",")}`,
          { metadata: { [key]: paths } },
        ),
      );
    }
  }
  for (const subagent of facts.subagents ?? []) {
    entries.push(
      createSessionSignal(
        "subagent",
        `subagent ${subagent.childRunId} finality=${subagent.finality ?? "unknown"}`,
        { metadata: subagent },
      ),
    );
  }
  return entries;
}

function mergeSessionTraceFacts(
  facts: Array<SessionTraceFacts | undefined>,
): SessionTraceFacts | undefined {
  const approvals = { requested: 0, approved: 0, denied: 0 };
  const completed = new Set<string>();
  const denied = new Set<string>();
  const skipped = new Set<string>();
  const subagents = new Map<
    string,
    NonNullable<SessionTraceFacts["subagents"]>[number]
  >();
  let seen = false;
  for (const fact of facts) {
    if (!fact) continue;
    seen = true;
    approvals.requested += fact.approvals?.requested ?? 0;
    approvals.approved += fact.approvals?.approved ?? 0;
    approvals.denied += fact.approvals?.denied ?? 0;
    for (const path of fact.workspaceWrites?.completed ?? [])
      completed.add(path);
    for (const path of fact.workspaceWrites?.denied ?? []) denied.add(path);
    for (const path of fact.workspaceWrites?.skipped ?? []) skipped.add(path);
    for (const subagent of fact.subagents ?? []) {
      subagents.set(subagent.childRunId, subagent);
    }
  }
  if (!seen) return undefined;
  return {
    approvals,
    workspaceWrites: {
      completed: [...completed],
      denied: [...denied],
      skipped: [...skipped],
    },
    subagents: [...subagents.values()],
  };
}

function sessionTraceFacts(
  metadata: Record<string, unknown>,
): SessionTraceFacts | undefined {
  const value = metadata["sessionTraceFacts"];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as SessionTraceFacts;
}

function stableSessionInputHash(input: {
  items: ContextItem[];
  requiredSignals: SessionSignals;
  sourceRunIds: RunId[];
  budget: SessionSummarizerBudget;
}): string {
  return stableSignalHash(
    JSON.stringify({
      sourceRunIds: input.sourceRunIds,
      budget: input.budget,
      signals: input.requiredSignals.entries.map((signal) => ({
        id: signal.id,
        kind: signal.kind,
        text: signal.text,
        runId: signal.runId,
      })),
      items: input.items.map((item) => ({
        type: item.type,
        source: item.source,
        content: item.content,
        runId: metadataString(item.metadata, "runId"),
        sourceRunIds: item.metadata["sourceRunIds"],
      })),
    }),
  );
}

function stableSignalHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function uniqueLimited(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

function renderSessionCompactionContent(input: {
  items: ContextItem[];
  sourceRunIds: RunId[];
  throughRunId: RunId | null;
  originalCharCount: number;
  pipelineResult: CompactionPipelineResult;
  reason?: string;
}): string {
  const lines = [
    "Session compact summary.",
    `Compacted turns: ${input.sourceRunIds.length}`,
    `Through run: ${input.throughRunId ?? "unknown"}`,
  ];
  lines.push("");
  for (const item of input.items) {
    lines.push(renderSessionCompactionItem(item));
    lines.push("");
  }
  return lines.join("\n").trim();
}

function renderSessionCompactionItem(item: ContextItem): string {
  if (item.type === "summary") return item.content.trim();
  const role = item.type === "assistant" ? "Assistant" : "User";
  const runId =
    metadataString(item.metadata, "runId") ?? item.source?.uri ?? "unknown";
  return `${role} (${runId}): ${item.content.trim()}`;
}

function compactLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function metadataString(
  meta: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordNumber(
  meta: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = meta?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function recordBoolean(
  meta: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = meta?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function recordObject(
  meta: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = meta?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : undefined;
}
