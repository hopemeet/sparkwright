import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { RunEvent } from "../lib/event-type.js";
import { useTheme } from "../lib/theme-context.js";

/**
 * Fork-point picker. We surface each user turn (a `run.started` event with a
 * goal) plus its event sequence; forking at that sequence keeps history up to
 * and including that turn. A "full session (clone)" option forks everything.
 *
 * Enter forks at the highlighted point; esc cancels.
 */
export function TimelineDialog(props: {
  events: RunEvent[];
  /**
   * Fork at the chosen point. `edit` true means "edit & resend": fork, then
   * prefill the input with this turn's goal so the user can tweak and re-run.
   */
  onFork: (
    forkAtSequence: number | undefined,
    label: string,
    edit?: boolean,
  ) => void;
  onCancel: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  const turns = extractTurns(props.events);
  // Options: [full clone, ...turns]. Cursor 0 = full clone.
  const options: Array<{
    label: string;
    seq: number | undefined;
  }> = [
    { label: "Full session (clone everything)", seq: undefined },
    ...turns.map((t) => ({
      label: t.goal,
      seq: t.sequence,
    })),
  ];
  const [cursor, setCursor] = useState(0);
  const safeCursor = Math.max(0, Math.min(cursor, options.length - 1));
  const windowSize = Math.max(5, Math.min(12, (stdout?.rows ?? 30) - 8));
  const { start, visible } = optionWindow(options, safeCursor, windowSize);

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      const pick = options[safeCursor];
      props.onFork(pick.seq, pick.label);
      return;
    }
    // "e" = fork & edit: only meaningful for a specific user turn (not the
    // full-clone option, which has no single goal to edit).
    if (input === "e") {
      const pick = options[safeCursor];
      if (pick.seq !== undefined) props.onFork(pick.seq, pick.label, true);
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(options.length - 1, c + 1));
    } else if (key.pageUp || input === "u") {
      setCursor((c) => Math.max(0, c - windowSize));
    } else if (key.pageDown || input === "d") {
      setCursor((c) => Math.min(options.length - 1, c + windowSize));
    } else if (input === "g") {
      setCursor(0);
    } else if (input === "G") {
      setCursor(options.length - 1);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      <Box>
        <Text color={theme.accent} bold>
          fork session
        </Text>
        <Text color={theme.muted}>
          {"  "}pick a point · ↑/↓ select · enter fork · e fork+edit · esc
        </Text>
      </Box>
      {visible.map((opt, i) => {
        const optionIndex = start + i;
        const selected = optionIndex === safeCursor;
        return (
          <Box key={`${opt.seq ?? "full"}-${optionIndex}`}>
            <Text color={selected ? theme.success : undefined}>
              {selected ? "› " : "  "}
            </Text>
            {opt.seq !== undefined ? (
              <Text color={theme.muted}>
                [{String(opt.seq).padStart(3, " ")}]{" "}
              </Text>
            ) : (
              <Text color={theme.muted}>[all] </Text>
            )}
            <Text color={selected ? theme.success : undefined}>
              {opt.label.replace(/\n/g, " ").slice(0, 70)}
            </Text>
          </Box>
        );
      })}
      {turns.length === 0 ? (
        <Text color={theme.muted}>
          (no user turns recorded yet — only a full clone is available)
        </Text>
      ) : null}
      {options.length > windowSize ? (
        <Text color={theme.muted}>
          {start + 1}-{Math.min(options.length, start + visible.length)} of{" "}
          {options.length} · u/d page · g/G top/bottom
        </Text>
      ) : null}
    </Box>
  );
}

interface Turn {
  sequence: number;
  goal: string;
}

export function extractTurns(events: RunEvent[]): Turn[] {
  // Fork happens at a host sequence, which only `run.started` carries — but its
  // payload.goal is empty on some providers. The TUI's own `tui.user` event
  // (synthetic, negative sequence) always carries the goal text and is appended
  // just before the run starts, so we pair each run.started with the goal of the
  // tui.user that precedes it.
  const turns: Turn[] = [];
  let pendingGoal: string | undefined;
  for (const ev of events) {
    if (ev.type === "tui.user") {
      const g = (ev.payload as { goal?: unknown } | undefined)?.goal;
      if (typeof g === "string" && g.trim()) pendingGoal = g;
      continue;
    }
    if (ev.type !== "run.started") continue;
    const p = (ev.payload ?? {}) as { goal?: unknown };
    const ownGoal =
      typeof p.goal === "string" && p.goal.trim() ? p.goal : undefined;
    turns.push({
      sequence: ev.sequence ?? 0,
      goal: ownGoal ?? pendingGoal ?? "(run)",
    });
    pendingGoal = undefined;
  }
  return turns;
}

export function optionWindow<T>(
  items: readonly T[],
  cursor: number,
  windowSize: number,
): { start: number; visible: readonly T[] } {
  const size = Math.max(1, windowSize);
  const safeCursor = Math.max(
    0,
    Math.min(cursor, Math.max(0, items.length - 1)),
  );
  const start = Math.max(
    0,
    Math.min(items.length - size, safeCursor - Math.floor(size / 2)),
  );
  return { start, visible: items.slice(start, start + size) };
}
