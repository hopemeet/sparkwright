import React from "react";
import { Box, Text } from "ink";
import type { TodoPanelItem } from "../state/event-store.js";
import { useTheme } from "../lib/theme-context.js";
import { displayWidth, toGraphemes } from "../lib/graphemes.js";

/**
 * The todo ledger as a full-width band in the live frame, pinned just above the
 * input. Unlike a right rail (which the Static-scrollback model can only render
 * as a cramped corner box), a full-width band gives CJK titles room and reads
 * as a natural checklist.
 *
 * Collapse strategy keeps it minimal-chrome:
 *  - `compact` (e.g. while the model is streaming a long answer) → a single
 *    line showing only progress + the current item.
 *  - expanded → completed items fold into one "done" count line; the active
 *    items (in_progress / pending / blocked / …) are listed, current first and
 *    highlighted, capped so a long ledger can't dominate the frame.
 */
const TODO_GLYPH: Record<string, string> = {
  pending: "☐",
  in_progress: "◐",
  completed: "☑",
  blocked: "⊘",
  failed: "✗",
  skipped: "⊝",
};

const MAX_ACTIVE_ROWS = 8;

export function TodoBand(props: {
  todos: TodoPanelItem[];
  width: number;
  compact: boolean;
}): React.ReactElement | null {
  const theme = useTheme();
  const { todos } = props;
  if (todos.length === 0) return null;

  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const current =
    todos.find((t) => t.status === "in_progress") ??
    todos.find((t) => t.status !== "completed");

  const colorFor = (status: string): string | undefined => {
    if (status === "completed") return theme.success;
    if (status === "in_progress") return theme.accent;
    if (status === "blocked" || status === "failed") return theme.error;
    if (status === "skipped") return theme.muted;
    return undefined;
  };

  // Reserve a couple of columns for the gutter glyph + a space.
  const titleWidth = Math.max(8, props.width - 4);

  if (props.compact) {
    const glyph = current ? (TODO_GLYPH[current.status] ?? "☐") : "☑";
    const tail = current ? ` ▸ ${current.title}` : " ▸ all done";
    return (
      <Box paddingX={1} marginTop={1}>
        <Text color={theme.accent}>{glyph} </Text>
        <Text color={theme.muted}>
          todo {done}/{total}
        </Text>
        <Text color={colorFor(current?.status ?? "completed")}>
          {truncateToWidth(tail, titleWidth)}
        </Text>
      </Box>
    );
  }

  const active = todos.filter((t) => t.status !== "completed");
  const visible = active.slice(0, MAX_ACTIVE_ROWS);
  const overflow = active.length - visible.length;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold color={theme.muted}>
        todo {done}/{total}
      </Text>
      {done > 0 ? (
        <Text color={theme.success}>
          {"  "}
          {TODO_GLYPH.completed} {done} done
        </Text>
      ) : null}
      {visible.map((t, i) => {
        const glyph = TODO_GLYPH[t.status] ?? "☐";
        const isCurrent = t === current;
        const indent = "  ".repeat(Math.min(t.depth, 3));
        const title = truncateToWidth(t.title, titleWidth - indent.length);
        return (
          <Text key={i} color={colorFor(t.status)} bold={isCurrent}>
            {"  "}
            {indent}
            {glyph} {title}
          </Text>
        );
      })}
      {overflow > 0 ? (
        <Text color={theme.muted}>
          {"  "}… +{overflow} more
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Truncate to a terminal-column budget (not code-unit length), so CJK/wide
 * glyphs — each two columns — don't overflow the band and force Ink to wrap.
 */
function truncateToWidth(text: string, maxCols: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (displayWidth(oneLine) <= maxCols) return oneLine;
  const budget = Math.max(1, maxCols - 1); // leave a column for the ellipsis
  let out = "";
  let used = 0;
  for (const g of toGraphemes(oneLine)) {
    const w = displayWidth(g);
    if (used + w > budget) break;
    out += g;
    used += w;
  }
  return `${out}…`;
}
