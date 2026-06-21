// =============================================================================
// context-dedup.ts — Cheap, deterministic compaction stages.
//
// These stages remove redundancy from the context before any model-backed
// summarization runs. They never call out to an LLM, are idempotent, and
// only mutate items they explicitly own (per the CompactionStage contract
// in pipeline.ts).
//
// Three primitives:
//
// - createFileReadDedupStage: when the same file is read multiple times via
//   tools, keep only the most recent body and replace earlier reads with a
//   short reference marker pointing at the kept item id. This collapses
//   the common "agent re-reads the same file each turn" pattern without
//   losing the timeline of accesses.
//
// - createObservationOneLineStage: replace tool_result items older than a
//   recency threshold with a one-line semantic summary derived from their
//   structured metadata (status, exit code, duration, output size). The
//   original ids stay so trace/debug tooling can correlate.
//
// - IMAGE_CHAR_EQUIVALENT + estimateContextChars: image content carries
//   real token cost but has near-zero string length. The helper folds
//   per-image equivalent characters into a size estimate so downstream
//   tail-budget math (used by snip / tool_result_budget stages) is not
//   systematically biased low.
// =============================================================================

import type {
  CompactionResult,
  CompactionStage,
  CompactionStageInput,
} from "./pipeline.js";
import { createContextItemId, type ContextItemId } from "./ids.js";
import type { ContextItem } from "./types.js";

// ---------------------------------------------------------------------------
// Image character equivalence
// ---------------------------------------------------------------------------

/**
 * Estimated character-equivalent cost of a single image attachment when
 * sizing a context window. Anthropic's pricing model for images is image-
 * size dependent, but a conservative ~6.4K characters tracks the typical
 * 1.6K token / image rate at the standard 4-chars-per-token heuristic.
 *
 * Used by {@link estimateContextChars} so context-size calculations that
 * drive tail budgets do not silently underestimate image-laden histories.
 *
 * @public
 * @stability experimental v0.1
 */
export const IMAGE_CHAR_EQUIVALENT = 1600 * 4;

export interface EstimateOptions {
  /** Override the per-image character equivalent. */
  imageCharEquivalent?: number;
}

/**
 * Estimate the character footprint of a context item list, accounting for
 * image attachments referenced via `metadata.imageCount`. Embedders that
 * track images differently can pass a custom `imageCharEquivalent`.
 *
 * @public
 * @stability experimental v0.1
 */
export function estimateContextChars(
  items: ContextItem[],
  options: EstimateOptions = {},
): number {
  const perImage = options.imageCharEquivalent ?? IMAGE_CHAR_EQUIVALENT;
  let total = 0;
  for (const item of items) {
    total += item.content.length;
    const imageCount = readImageCount(item.metadata);
    if (imageCount > 0) total += imageCount * perImage;
  }
  return total;
}

function readImageCount(meta: Record<string, unknown> | undefined): number {
  if (!meta) return 0;
  const value = meta["imageCount"];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

// ---------------------------------------------------------------------------
// File read dedup
// ---------------------------------------------------------------------------

export interface FileReadDedupOptions {
  /**
   * Override how a `tool_result` item is associated with a file path. By
   * default this reads `metadata.filePath` (string) and falls back to
   * `source.path`. Returning `undefined` opts the item out of dedup.
   */
  keyOf?: (item: ContextItem) => string | undefined;
  /**
   * Override how the replacement marker for a superseded read is rendered.
   * Receives the file key, the kept item's id, and the dropped char count.
   */
  renderMarker?: (info: {
    filePath: string;
    keptItemId: ContextItemId;
    droppedChars: number;
  }) => string;
  name?: string;
}

/**
 * Stage that collapses repeated reads of the same file to a single
 * authoritative copy (the latest one). Earlier reads are replaced with a
 * one-line marker pointing at the kept item id, preserving the timeline
 * without paying for the bytes more than once.
 *
 * Only operates on `tool_result` items. Items without a recognizable file
 * key are passed through untouched.
 *
 * @public
 * @stability experimental v0.1
 */
export function createFileReadDedupStage(
  options: FileReadDedupOptions = {},
): CompactionStage {
  const keyOf = options.keyOf ?? defaultFileKey;
  const renderMarker = options.renderMarker ?? defaultMarker;

  return {
    name: options.name ?? "file_read_dedup",
    tier: "dedup",
    trigger: "micro",
    shouldRun(input: CompactionStageInput): boolean {
      const seen = new Set<string>();
      for (const item of input.items) {
        if (item.type !== "tool_result") continue;
        const key = keyOf(item);
        if (!key) continue;
        if (seen.has(key)) return true;
        seen.add(key);
      }
      return false;
    },
    apply(input: CompactionStageInput): CompactionResult {
      // Walk newest-to-oldest so the first occurrence we see wins.
      const items = input.items;
      const latestIdByKey = new Map<string, ContextItemId>();
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i]!;
        if (item.type !== "tool_result") continue;
        const key = keyOf(item);
        if (!key) continue;
        if (!latestIdByKey.has(key)) latestIdByKey.set(key, item.id);
      }

      let freed = 0;
      let replaced = 0;
      const next = items.map((item) => {
        if (item.type !== "tool_result") return item;
        const key = keyOf(item);
        if (!key) return item;
        const keptId = latestIdByKey.get(key);
        if (!keptId || keptId === item.id) return item;
        const marker = renderMarker({
          filePath: key,
          keptItemId: keptId,
          droppedChars: item.content.length,
        });
        freed += Math.max(0, item.content.length - marker.length);
        replaced += 1;
        return {
          ...item,
          content: marker,
          metadata: {
            ...item.metadata,
            dedupReplaced: true,
            dedupKeptItemId: keptId,
            originalChars: item.content.length,
          },
        };
      });

      return {
        items: next,
        freedChars: freed,
        metadata: { replaced },
      };
    },
  };
}

function defaultFileKey(item: ContextItem): string | undefined {
  const meta = item.metadata as Record<string, unknown> | undefined;
  const fromMeta =
    typeof meta?.["filePath"] === "string"
      ? (meta["filePath"] as string)
      : undefined;
  if (fromMeta) return fromMeta;
  return item.source?.path;
}

function defaultMarker(info: {
  filePath: string;
  keptItemId: ContextItemId;
  droppedChars: number;
}): string {
  return `[file ${info.filePath}: superseded by later read ${info.keptItemId} (${info.droppedChars} chars)]`;
}

// ---------------------------------------------------------------------------
// Observation one-line summarizer
// ---------------------------------------------------------------------------

export interface ObservationOneLineOptions {
  /**
   * Keep the most recent N tool_result items intact. Defaults to 4.
   * Older items get replaced with a one-line summary.
   */
  keepRecent?: number;
  /**
   * Minimum byte size below which collapsing is not worth it. Defaults
   * to 256 — small results stay as-is.
   */
  minCharsToCollapse?: number;
  /**
   * Optional custom renderer for the one-line summary. Receives the item
   * and must return a short string. The default reads `metadata.toolName`,
   * `metadata.exitCode`, and the content's line count.
   */
  render?: (item: ContextItem) => string;
  name?: string;
}

/**
 * Stage that compresses older `tool_result` items into one-line summaries.
 * Keeps the most recent `keepRecent` results intact so the agent retains
 * working memory for the current sub-task.
 *
 * The summary string is derived from item metadata only — no LLM call —
 * so the stage is cheap enough to run on every step.
 *
 * @public
 * @stability experimental v0.1
 */
export function createObservationOneLineStage(
  options: ObservationOneLineOptions = {},
): CompactionStage {
  const keepRecent = Math.max(0, options.keepRecent ?? 4);
  const minChars = Math.max(0, options.minCharsToCollapse ?? 256);
  const render = options.render ?? defaultOneLineRender;

  return {
    name: options.name ?? "observation_one_line",
    tier: "dedup",
    trigger: "micro",
    shouldRun(input: CompactionStageInput): boolean {
      // Identify tool_result indices; if any older-than-keepRecent item
      // exceeds the min threshold, there is work to do.
      const indices = collectIndices(input.items);
      if (indices.length <= keepRecent) return false;
      const collapsible = indices.slice(0, indices.length - keepRecent);
      for (const i of collapsible) {
        const item = input.items[i]!;
        if (item.metadata["oneLineCollapsed"] === true) continue;
        if (item.content.length >= minChars) return true;
      }
      return false;
    },
    apply(input: CompactionStageInput): CompactionResult {
      const items = [...input.items];
      const indices = collectIndices(items);
      const collapsible = indices.slice(
        0,
        Math.max(0, indices.length - keepRecent),
      );
      let freed = 0;
      let collapsed = 0;
      for (const i of collapsible) {
        const item = items[i]!;
        if (item.metadata["oneLineCollapsed"] === true) continue;
        if (item.content.length < minChars) continue;
        const line = render(item);
        freed += Math.max(0, item.content.length - line.length);
        collapsed += 1;
        items[i] = {
          ...item,
          content: line,
          metadata: {
            ...item.metadata,
            oneLineCollapsed: true,
            originalChars: item.content.length,
          },
        };
      }
      return {
        items,
        freedChars: freed,
        metadata: { collapsed, keepRecent },
      };
    },
  };
}

function collectIndices(items: ContextItem[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (items[i]!.type === "tool_result") out.push(i);
  }
  return out;
}

function defaultOneLineRender(item: ContextItem): string {
  const meta = item.metadata as Record<string, unknown>;
  const toolName =
    typeof meta["toolName"] === "string"
      ? (meta["toolName"] as string)
      : (item.source?.uri ?? "tool");
  const exitCode =
    typeof meta["exitCode"] === "number" ? ` exit=${meta["exitCode"]}` : "";
  const status =
    typeof meta["status"] === "string" ? ` status=${meta["status"]}` : "";
  const lineCount =
    item.content.length === 0 ? 0 : item.content.split("\n").length;
  const toolDetails =
    toolName === "spawn_agent" ? renderSpawnAgentOneLineDetails(meta) : "";
  return `[${toolName}]${status}${exitCode}${toolDetails} ${item.content.length} chars, ${lineCount} lines (collapsed)`;
}

function renderSpawnAgentOneLineDetails(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  const role = metadataString(meta, "role");
  if (role) parts.push(`role=${compactOneLineValue(role, 48)}`);

  const childRunId = metadataString(meta, "childRunId");
  if (childRunId) parts.push(`child=${compactOneLineValue(childRunId, 72)}`);

  const finality = metadataString(meta, "finality");
  if (finality) parts.push(`finality=${compactOneLineValue(finality, 24)}`);

  const stepLimitReached = meta["stepLimitReached"] === true;
  const truncated = meta["truncated"] === true;
  if (stepLimitReached || truncated || finality === "partial") {
    const reasons = [
      stepLimitReached ? "stepLimit" : undefined,
      truncated ? "truncated" : undefined,
    ].filter((value): value is string => typeof value === "string");
    parts.push(
      `partial=true${reasons.length > 0 ? `(${reasons.join("+")})` : ""}`,
    );
  }

  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function metadataString(
  meta: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compactOneLineValue(value: string, maxChars: number): string {
  const compacted = value.trim().replace(/\s+/g, "_");
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 1))}~`;
}

// ---------------------------------------------------------------------------
// Reference marker helper (rarely used directly; exposed for symmetry with
// the file-read dedup marker, in case a host wants to render its own
// dropped-block placeholders that keep id correlation).
// ---------------------------------------------------------------------------

export function createReferenceMarker(
  ref: ContextItemId,
  description: string,
): ContextItem {
  return {
    id: createContextItemId(),
    type: "summary",
    source: { kind: "context_reference" },
    content: `[ref → ${ref}: ${description}]`,
    metadata: {
      layer: "working",
      stability: "turn",
      referenceTo: ref,
    },
  };
}
