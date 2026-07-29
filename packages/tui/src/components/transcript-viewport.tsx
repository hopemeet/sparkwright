import React from "react";
import { Box, Text } from "ink";
import type { ToolDisplayTone } from "../lib/tool-display.js";
import type {
  PhysicalTranscriptRow,
  StyledTranscriptSpan,
  TranscriptLayout,
  TranscriptSpanColor,
} from "../lib/transcript-layout.js";
import { useTheme } from "../lib/theme-context.js";
import {
  selectTranscriptWindow,
  type TranscriptViewportState,
} from "../state/transcript-viewport-state.js";

export function TranscriptViewport(props: {
  layout: TranscriptLayout;
  state: TranscriptViewportState;
  rows: number;
}): React.ReactElement {
  const theme = useTheme();
  const height = Math.max(1, props.rows);
  const indicatorRows = props.state.unseenRows > 0 ? 1 : 0;
  const window = selectTranscriptWindow(
    props.layout,
    props.state,
    Math.max(1, height - indicatorRows),
  );
  return (
    <Box flexDirection="column" height={height} overflow="hidden" paddingX={1}>
      {window.rows.map((row) => (
        <TranscriptPhysicalRow key={row.key} row={row} />
      ))}
      {props.state.unseenRows > 0 ? (
        <Text color={theme.accent}>
          ↓ {props.state.unseenRows} new line
          {props.state.unseenRows === 1 ? "" : "s"} · Ctrl+End
        </Text>
      ) : null}
    </Box>
  );
}

export function TranscriptPhysicalRow(props: {
  row: PhysicalTranscriptRow;
}): React.ReactElement {
  const theme = useTheme();
  const row = props.row;
  return (
    <Text
      color={toneColor(row.tone, theme)}
      bold={row.bold}
      dimColor={row.tone === "muted"}
      wrap="truncate"
    >
      {row.spans && row.spans.length > 0
        ? row.spans.map((span, index) => (
            <TranscriptSpan
              key={`${index}:${span.text.length}`}
              span={span}
              theme={theme}
            />
          ))
        : row.text || " "}
    </Text>
  );
}

function TranscriptSpan(props: {
  span: StyledTranscriptSpan;
  theme: ReturnType<typeof useTheme>;
}): React.ReactElement {
  return (
    <Text
      color={spanColor(props.span.color, props.theme)}
      bold={props.span.bold}
      italic={props.span.italic}
      underline={props.span.underline}
      dimColor={props.span.dim}
    >
      {props.span.text}
    </Text>
  );
}

function spanColor(
  color: TranscriptSpanColor | undefined,
  theme: ReturnType<typeof useTheme>,
): string | undefined {
  return color ? theme[color] : undefined;
}

function toneColor(
  tone: ToolDisplayTone,
  theme: ReturnType<typeof useTheme>,
): string | undefined {
  if (tone === "success") return theme.success;
  if (tone === "warning") return theme.warning;
  if (tone === "error") return theme.error;
  if (tone === "muted") return theme.muted;
  return undefined;
}
