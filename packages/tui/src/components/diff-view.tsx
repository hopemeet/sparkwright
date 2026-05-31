import React from "react";
import { Box, Text } from "ink";
import { parseUnifiedDiff, type DiffLine } from "../lib/diff.js";
import { useTheme } from "../lib/theme-context.js";

/**
 * Render a unified diff as coloured rows with an optional scroll window. The
 * caller controls `scrollOffset` and `viewportRows`; we slice deterministically
 * so the parent can wire arrow keys / page keys without owning render state.
 */
export function DiffView(props: {
  diff: string;
  scrollOffset: number;
  viewportRows: number;
  width?: number;
}): React.ReactElement {
  const theme = useTheme();
  const parsed = parseUnifiedDiff(props.diff);
  const renderable = parsed.lines.filter(
    (l) => l.kind !== "header" && l.kind !== "meta",
  );
  const start = clamp(
    props.scrollOffset,
    0,
    Math.max(0, renderable.length - 1),
  );
  const slice = renderable.slice(start, start + props.viewportRows);
  const total = renderable.length;
  const end = Math.min(total, start + props.viewportRows);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.muted}>
          {parsed.hunkCount} hunk{parsed.hunkCount === 1 ? "" : "s"} ·{" "}
        </Text>
        <Text color={theme.diffAdded}>+{parsed.additions}</Text>
        <Text color={theme.muted}> / </Text>
        <Text color={theme.diffRemoved}>-{parsed.deletions}</Text>
        <Text color={theme.muted}>
          {"  "}showing {start + 1}-{end} of {total}
        </Text>
      </Box>
      {slice.map((line, i) => (
        <DiffRow key={start + i} line={line} maxWidth={props.width} />
      ))}
    </Box>
  );
}

function DiffRow(props: {
  line: DiffLine;
  maxWidth?: number;
}): React.ReactElement {
  const theme = useTheme();
  const { line } = props;
  const text =
    props.maxWidth && line.text.length > props.maxWidth
      ? line.text.slice(0, props.maxWidth - 1) + "…"
      : line.text;

  switch (line.kind) {
    case "hunk":
      return (
        <Text color={theme.diffHunk} dimColor>
          {text}
        </Text>
      );
    case "add":
      return <Text color={theme.diffAdded}>{text}</Text>;
    case "del":
      return <Text color={theme.diffRemoved}>{text}</Text>;
    default:
      return <Text color={theme.muted}>{text || " "}</Text>;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
