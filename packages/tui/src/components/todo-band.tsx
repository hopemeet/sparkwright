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
const MAX_EXPANDED_ROWS = 16;

export function TodoBand(props: {
  todos: TodoPanelItem[];
  width: number;
  compact: boolean;
  /**
   * When true, completed items are listed (with their titles) so the user can
   * see *what* was done; when false, completed items collapse to a one-line
   * count hint and only active items are listed. Toggled with ctrl+t.
   */
  expanded: boolean;
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

  // Expanded lists every item in ledger order (so completed work is visible);
  // collapsed lists only the active items and folds completed ones into a
  // one-line, actionable hint.
  const active = todos.filter((t) => t.status !== "completed");
  const shown = props.expanded ? todos : active;
  const cap = props.expanded ? MAX_EXPANDED_ROWS : MAX_ACTIVE_ROWS;
  const visible = shown.slice(0, cap);
  const overflow = shown.length - visible.length;

  const renderRow = (t: TodoPanelItem, i: number): React.ReactElement => {
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
  };

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold color={theme.muted}>
        todo {done}/{total}
      </Text>
      {visible.map(renderRow)}
      {overflow > 0 ? (
        <Text color={theme.muted}>
          {"  "}… +{overflow} more
        </Text>
      ) : null}
      {props.expanded ? (
        <Text color={theme.muted}>{"  "}ctrl+t 收起已完成</Text>
      ) : done > 0 ? (
        <Text color={theme.muted}>
          {"  "}
          {TODO_GLYPH.completed} {done} done · ctrl+t 展开
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
