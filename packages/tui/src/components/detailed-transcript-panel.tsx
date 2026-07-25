import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { TodoPanelItem } from "../state/event-store.js";
import type { RunEvent } from "../lib/event-type.js";
import {
  buildDetailedTranscript,
  type TranscriptLine,
} from "../lib/transcript-presentation.js";
import { chordMatches, formatBinding, type Chord } from "../lib/keybindings.js";
import { isBackInput } from "../lib/input-key.js";
import { useTheme } from "../lib/theme-context.js";
import { DialogFrame } from "./dialog-frame.js";

const MIN_VIEWPORT_ROWS = 6;
const FRAME_OVERHEAD_ROWS = 5;

export function DetailedTranscriptPanel(props: {
  events: RunEvent[];
  todoItems: readonly TodoPanelItem[];
  toggleChords: readonly Chord[];
  onClose: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  const projection = useMemo(
    () => buildDetailedTranscript(props.events, props.todoItems),
    [props.events, props.todoItems],
  );
  const terminalRows = resolveTerminalRows(stdout?.rows);
  const viewportRows = Math.max(
    MIN_VIEWPORT_ROWS,
    terminalRows - FRAME_OVERHEAD_ROWS,
  );
  const maxScroll = Math.max(0, projection.lines.length - viewportRows);
  const [scroll, setScroll] = useState(maxScroll);
  const [followTail, setFollowTail] = useState(true);

  useEffect(() => {
    if (followTail) {
      setScroll(maxScroll);
      return;
    }
    setScroll((value) => Math.min(value, maxScroll));
  }, [followTail, maxScroll]);

  useInput((input, key) => {
    if (
      isBackInput(input, key) ||
      props.toggleChords.some((chord) => chordMatches(chord, key, input))
    ) {
      props.onClose();
      return;
    }
    if (key.upArrow || input === "k") {
      setFollowTail(false);
      setScroll((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setScroll((value) => {
        const next = Math.min(maxScroll, value + 1);
        setFollowTail(next === maxScroll);
        return next;
      });
      return;
    }
    if (key.pageUp) {
      setFollowTail(false);
      setScroll((value) => Math.max(0, value - viewportRows));
      return;
    }
    if (key.pageDown) {
      setScroll((value) => {
        const next = Math.min(maxScroll, value + viewportRows);
        setFollowTail(next === maxScroll);
        return next;
      });
      return;
    }
    if (input === "g") {
      setFollowTail(false);
      setScroll(0);
      return;
    }
    if (input === "G") {
      setFollowTail(true);
      setScroll(maxScroll);
    }
  });

  const visible = projection.lines.slice(scroll, scroll + viewportRows);
  const end = Math.min(projection.lines.length, scroll + visible.length);
  const toggleLabel = formatBinding([...props.toggleChords]) || "ctrl+t";

  return (
    <DialogFrame borderColor={theme.accent}>
      <Box justifyContent="space-between">
        <Text bold color={theme.accent}>
          details · {projection.scope}
        </Text>
        <Text color={theme.muted}>
          {projection.lines.length === 0
            ? "empty"
            : `${scroll + 1}-${end}/${projection.lines.length}`}
        </Text>
      </Box>

      <Box flexDirection="column" minHeight={MIN_VIEWPORT_ROWS}>
        {visible.length > 0 ? (
          visible.map((line) => <DetailedLine key={line.key} line={line} />)
        ) : (
          <Text color={theme.muted}>No user-facing details for this run.</Text>
        )}
      </Box>

      <Text color={theme.muted}>
        ↑/↓ scroll · PgUp/PgDn page · g/G top/bottom · {toggleLabel}/esc close
        {followTail ? " · following" : ""}
      </Text>
    </DialogFrame>
  );
}

function resolveTerminalRows(stdoutRows: number | undefined): number {
  if (stdoutRows !== undefined && stdoutRows > 0) return stdoutRows;
  const envRows = Number.parseInt(process.env.LINES ?? "", 10);
  return Number.isFinite(envRows) && envRows > 0 ? envRows : 24;
}

function DetailedLine(props: { line: TranscriptLine }): React.ReactElement {
  const theme = useTheme();
  const color =
    props.line.tone === "success"
      ? theme.success
      : props.line.tone === "warning"
        ? theme.warning
        : props.line.tone === "error"
          ? theme.error
          : props.line.tone === "muted"
            ? theme.muted
            : undefined;
  return (
    <Text
      color={color}
      dimColor={props.line.tone === "muted"}
      bold={props.line.bold}
      wrap="truncate-end"
    >
      {props.line.text || " "}
    </Text>
  );
}
