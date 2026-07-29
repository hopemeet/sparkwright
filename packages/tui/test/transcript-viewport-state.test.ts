import { describe, expect, it } from "vitest";
import type { TranscriptLayout } from "../src/lib/transcript-layout.js";
import {
  initialTranscriptViewportState,
  moveTranscriptViewportToEnd,
  scrollTranscriptViewport,
  selectTranscriptWindow,
  synchronizeTranscriptViewport,
  toggleTranscriptViewportMode,
} from "../src/state/transcript-viewport-state.js";

function layout(
  mode: "compact" | "detailed",
  rows: Array<{
    block: string;
    logical: string;
    offset?: number;
    parent?: string;
    level?: "primary" | "detail";
    text?: string;
  }>,
): TranscriptLayout {
  return {
    documentEpoch: "e1",
    mode,
    columns: 80,
    omittedRows: 0,
    totalRows: rows.length,
    rows: rows.map((entry, index) => ({
      key: `${entry.logical}:physical:${entry.offset ?? 0}`,
      blockKey: entry.block,
      logicalRowKey: entry.logical,
      parentKey: entry.parent,
      level: entry.level,
      text: entry.text ?? `${entry.logical}-${index}`,
      tone: "normal",
      sourceOffset: entry.offset ?? 0,
      sourceEnd:
        (entry.offset ?? 0) +
        (entry.text ?? `${entry.logical}-${index}`).length,
      continuation: 0,
    })),
  };
}

describe("TranscriptViewportState", () => {
  it("keeps following the newest tail across repeated appends", () => {
    const first = layout(
      "compact",
      Array.from({ length: 6 }, (_, index) => ({
        block: `b${index}`,
        logical: `r${index}`,
      })),
    );
    let state = synchronizeTranscriptViewport(
      initialTranscriptViewportState(),
      first,
      3,
    );
    expect(selectTranscriptWindow(first, state, 3).start).toBe(3);

    const second = layout("compact", [
      ...first.rows.map((row) => ({
        block: row.blockKey,
        logical: row.key.split(":physical:")[0]!,
      })),
      { block: "b6", logical: "r6" },
    ]);
    state = synchronizeTranscriptViewport(state, second, 3, 1);
    expect(selectTranscriptWindow(second, state, 3).start).toBe(4);

    const third = layout("compact", [
      ...second.rows.map((row) => ({
        block: row.blockKey,
        logical: row.key.split(":physical:")[0]!,
      })),
      { block: "b7", logical: "r7" },
    ]);
    state = synchronizeTranscriptViewport(state, third, 3, 1);
    expect(selectTranscriptWindow(third, state, 3).start).toBe(5);
    expect(state.followTail).toBe(true);
    expect(state.unseenRows).toBe(0);
  });

  it("stops following when scrolled up and counts appended rows", () => {
    const before = layout(
      "compact",
      Array.from({ length: 10 }, (_, index) => ({
        block: `b${index}`,
        logical: `r${index}`,
      })),
    );
    let state = initialTranscriptViewportState();
    state = synchronizeTranscriptViewport(state, before, 4);
    state = scrollTranscriptViewport(state, before, 4, -2);
    expect(state.followTail).toBe(false);

    const after = layout("compact", [
      ...before.rows.map((row) => ({
        block: row.blockKey,
        logical: row.key.split(":physical:")[0]!,
      })),
      { block: "b10", logical: "r10" },
      { block: "b11", logical: "r11" },
    ]);
    state = synchronizeTranscriptViewport(state, after, 4, 2);
    expect(state.unseenRows).toBe(2);
    expect(selectTranscriptWindow(after, state, 4).rows[0]?.blockKey).toBe(
      "b4",
    );

    state = moveTranscriptViewportToEnd(state, after, 4);
    expect(state.followTail).toBe(true);
    expect(state.unseenRows).toBe(0);
  });

  it("falls back to the same block when a detailed row disappears", () => {
    const detailed = layout("detailed", [
      { block: "user", logical: "user:summary" },
      { block: "agent", logical: "agent:summary" },
      { block: "agent", logical: "agent:detail" },
      { block: "assistant", logical: "assistant:summary" },
    ]);
    let state = initialTranscriptViewportState("detailed");
    state = synchronizeTranscriptViewport(state, detailed, 2);
    state = scrollTranscriptViewport(state, detailed, 2, -1);
    state = toggleTranscriptViewportMode(state, detailed, 2);

    const compact = layout("compact", [
      { block: "user", logical: "user:summary" },
      { block: "agent", logical: "agent:summary" },
      { block: "assistant", logical: "assistant:summary" },
    ]);
    expect(selectTranscriptWindow(compact, state, 2).rows[0]?.blockKey).toBe(
      "agent",
    );
  });

  it("falls back to the block summary instead of its separator row", () => {
    const detailed = layout("detailed", [
      { block: "user", logical: "user:summary" },
      { block: "agent", logical: "agent:summary" },
      { block: "agent", logical: "agent:detail" },
    ]);
    let state = synchronizeTranscriptViewport(
      initialTranscriptViewportState("detailed"),
      detailed,
      1,
    );
    state = toggleTranscriptViewportMode(state, detailed, 1);

    const compact = layout("compact", [
      { block: "user", logical: "user:summary" },
      { block: "agent", logical: "agent:space", text: "" },
      { block: "agent", logical: "agent:summary" },
    ]);
    expect(
      selectTranscriptWindow(compact, state, 1).rows[0]?.logicalRowKey,
    ).toBe("agent:summary");
  });

  it("falls back from a hidden detail-only block to its parent", () => {
    const detailed = layout("detailed", [
      { block: "user", logical: "user:summary", level: "primary" },
      { block: "agent", logical: "agent:summary", level: "primary" },
      {
        block: "tool",
        logical: "tool:summary",
        parent: "agent",
        level: "detail",
      },
      { block: "assistant", logical: "assistant:summary", level: "primary" },
    ]);
    let state = synchronizeTranscriptViewport(
      initialTranscriptViewportState("detailed"),
      detailed,
      2,
    );
    state = toggleTranscriptViewportMode(state, detailed, 2);

    const compact = layout("compact", [
      { block: "user", logical: "user:summary", level: "primary" },
      { block: "agent", logical: "agent:summary", level: "primary" },
      { block: "assistant", logical: "assistant:summary", level: "primary" },
    ]);
    expect(selectTranscriptWindow(compact, state, 2).rows[0]?.blockKey).toBe(
      "agent",
    );
  });

  it("falls back from an unrelated hidden detail block to prior primary", () => {
    const detailed = layout("detailed", [
      { block: "user", logical: "user:summary", level: "primary" },
      { block: "notice", logical: "notice:summary", level: "detail" },
      { block: "assistant", logical: "assistant:summary", level: "primary" },
    ]);
    let state = synchronizeTranscriptViewport(
      initialTranscriptViewportState("detailed"),
      detailed,
      2,
    );
    state = toggleTranscriptViewportMode(state, detailed, 2);

    const compact = layout("compact", [
      { block: "user", logical: "user:summary", level: "primary" },
      { block: "assistant", logical: "assistant:summary", level: "primary" },
    ]);
    expect(selectTranscriptWindow(compact, state, 1).rows[0]?.blockKey).toBe(
      "user",
    );
  });

  it("keeps the semantic anchor across detailed-mode resize reflow", () => {
    const wide = layout("detailed", [
      { block: "user", logical: "user:summary" },
      { block: "agent", logical: "agent:summary" },
      { block: "agent", logical: "agent:detail", offset: 0 },
      { block: "assistant", logical: "assistant:summary" },
    ]);
    let state = initialTranscriptViewportState("detailed");
    state = synchronizeTranscriptViewport(state, wide, 2);
    state = scrollTranscriptViewport(state, wide, 2, -1);

    const narrow = layout("detailed", [
      { block: "user", logical: "user:summary" },
      { block: "agent", logical: "agent:summary" },
      { block: "agent", logical: "agent:detail", offset: 0 },
      { block: "agent", logical: "agent:detail", offset: 20 },
      { block: "assistant", logical: "assistant:summary" },
    ]);
    expect(selectTranscriptWindow(narrow, state, 2).rows[0]?.blockKey).toBe(
      "agent",
    );
  });
});
