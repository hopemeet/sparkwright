import type {
  PhysicalTranscriptRow,
  TranscriptLayout,
} from "../lib/transcript-layout.js";
import type { TranscriptMode } from "../lib/transcript-presentation.js";

export interface TranscriptViewportState {
  mode: TranscriptMode;
  /**
   * Opaque semantic anchor. It encodes a block key plus a logical row key; the
   * public state deliberately does not retain physical line numbers.
   */
  anchorKey: string | null;
  /** UTF-16 source offset within the anchored logical row. */
  anchorOffset: number;
  followTail: boolean;
  unseenRows: number;
}

export interface TranscriptWindow {
  start: number;
  end: number;
  rows: PhysicalTranscriptRow[];
}

const ANCHOR_SEPARATOR = "\u0000";

export function initialTranscriptViewportState(
  mode: TranscriptMode = "compact",
): TranscriptViewportState {
  return {
    mode,
    anchorKey: null,
    anchorOffset: 0,
    followTail: true,
    unseenRows: 0,
  };
}

export function selectTranscriptWindow(
  layout: TranscriptLayout,
  state: TranscriptViewportState,
  viewportRows: number,
): TranscriptWindow {
  const size = Math.max(1, viewportRows);
  const maxStart = Math.max(0, layout.rows.length - size);
  const start = state.anchorKey
    ? Math.min(maxStart, resolveAnchorIndex(layout.rows, state))
    : maxStart;
  const end = Math.min(layout.rows.length, start + size);
  return { start, end, rows: layout.rows.slice(start, end) };
}

export function synchronizeTranscriptViewport(
  state: TranscriptViewportState,
  layout: TranscriptLayout,
  viewportRows: number,
  appendedRows = 0,
): TranscriptViewportState {
  if (state.followTail) {
    const tailStart = Math.max(
      0,
      layout.rows.length - Math.max(1, viewportRows),
    );
    return {
      ...state,
      ...anchorAt(layout.rows, tailStart),
      unseenRows: 0,
    };
  }
  return {
    ...state,
    unseenRows: state.unseenRows + Math.max(0, appendedRows),
  };
}

export function scrollTranscriptViewport(
  state: TranscriptViewportState,
  layout: TranscriptLayout,
  viewportRows: number,
  delta: number,
): TranscriptViewportState {
  const window = selectTranscriptWindow(layout, state, viewportRows);
  const maxStart = Math.max(0, layout.rows.length - Math.max(1, viewportRows));
  const start = Math.max(0, Math.min(maxStart, window.start + delta));
  const followTail = start >= maxStart;
  return {
    ...state,
    ...anchorAt(layout.rows, start),
    followTail,
    unseenRows: followTail ? 0 : state.unseenRows,
  };
}

export function moveTranscriptViewportToStart(
  state: TranscriptViewportState,
  layout: TranscriptLayout,
): TranscriptViewportState {
  return {
    ...state,
    ...anchorAt(layout.rows, 0),
    followTail: false,
  };
}

export function moveTranscriptViewportToEnd(
  state: TranscriptViewportState,
  layout: TranscriptLayout,
  viewportRows: number,
): TranscriptViewportState {
  const start = Math.max(0, layout.rows.length - Math.max(1, viewportRows));
  return {
    ...state,
    ...anchorAt(layout.rows, start),
    followTail: true,
    unseenRows: 0,
  };
}

/**
 * Capture the top visible logical row before changing projection. If that row
 * does not exist in the other mode (for example a detail section), anchor
 * resolution falls back to the same semantic block.
 */
export function toggleTranscriptViewportMode(
  state: TranscriptViewportState,
  currentLayout: TranscriptLayout,
  viewportRows: number,
): TranscriptViewportState {
  const window = selectTranscriptWindow(currentLayout, state, viewportRows);
  return {
    ...state,
    ...anchorAt(currentLayout.rows, window.start),
    mode: state.mode === "compact" ? "detailed" : "compact",
    followTail: state.followTail,
  };
}

export function resetTranscriptViewport(
  state: TranscriptViewportState,
): TranscriptViewportState {
  return initialTranscriptViewportState(state.mode);
}

function anchorAt(
  rows: readonly PhysicalTranscriptRow[],
  index: number,
): Pick<TranscriptViewportState, "anchorKey" | "anchorOffset"> {
  const safeIndex = Math.max(0, Math.min(rows.length - 1, index));
  const row = rows[safeIndex];
  if (!row) return { anchorKey: null, anchorOffset: 0 };
  let previousPrimaryKey: string | undefined;
  for (let cursor = safeIndex; cursor >= 0; cursor -= 1) {
    const candidate = rows[cursor];
    if (candidate?.level === "primary" && candidate.blockKey !== "__omitted") {
      previousPrimaryKey = candidate.blockKey;
      break;
    }
  }
  return {
    anchorKey: encodeAnchor(
      row.blockKey,
      logicalKey(row),
      row.parentKey,
      previousPrimaryKey,
    ),
    anchorOffset: row.sourceOffset,
  };
}

function resolveAnchorIndex(
  rows: readonly PhysicalTranscriptRow[],
  state: TranscriptViewportState,
): number {
  if (!state.anchorKey) return Math.max(0, rows.length - 1);
  const anchor = decodeAnchor(state.anchorKey);
  let blockFallback = -1;
  let blockFirst = -1;
  let closest = -1;
  let closestDistance = Number.POSITIVE_INFINITY;
  rows.forEach((row, index) => {
    if (row.blockKey !== anchor.blockKey) return;
    if (blockFirst < 0) blockFirst = index;
    if (
      blockFallback < 0 &&
      row.text.length > 0 &&
      !row.logicalRowKey.endsWith(":space")
    ) {
      blockFallback = index;
    }
    if (logicalKey(row) !== anchor.rowKey) return;
    const distance = Math.abs(row.sourceOffset - state.anchorOffset);
    if (distance < closestDistance) {
      closest = index;
      closestDistance = distance;
    }
  });
  if (closest >= 0) return closest;
  if (blockFallback >= 0) return blockFallback;
  if (blockFirst >= 0) return blockFirst;
  const parentFallback = firstBlockIndex(rows, anchor.parentKey);
  if (parentFallback >= 0) return parentFallback;
  const primaryFallback = firstBlockIndex(rows, anchor.previousPrimaryKey);
  if (primaryFallback >= 0) return primaryFallback;
  const omissionFallback = firstBlockIndex(rows, "__omitted");
  if (omissionFallback >= 0) return omissionFallback;
  return state.followTail ? Math.max(0, rows.length - 1) : 0;
}

function logicalKey(row: PhysicalTranscriptRow): string {
  return row.logicalRowKey;
}

function encodeAnchor(
  blockKey: string,
  rowKey: string,
  parentKey?: string,
  previousPrimaryKey?: string,
): string {
  return [blockKey, rowKey, parentKey ?? "", previousPrimaryKey ?? ""].join(
    ANCHOR_SEPARATOR,
  );
}

function decodeAnchor(value: string): {
  blockKey: string;
  rowKey: string;
  parentKey?: string;
  previousPrimaryKey?: string;
} {
  const [blockKey = value, rowKey = value, parentKey, previousPrimaryKey] =
    value.split(ANCHOR_SEPARATOR);
  return {
    blockKey,
    rowKey,
    parentKey: parentKey || undefined,
    previousPrimaryKey: previousPrimaryKey || undefined,
  };
}

function firstBlockIndex(
  rows: readonly PhysicalTranscriptRow[],
  blockKey: string | undefined,
): number {
  return blockKey ? rows.findIndex((row) => row.blockKey === blockKey) : -1;
}
