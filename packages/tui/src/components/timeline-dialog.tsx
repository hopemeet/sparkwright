import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
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
  const safeCursor = Math.min(cursor, options.length - 1);

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
          cancel
        </Text>
      </Box>
      {options.map((opt, i) => {
        const selected = i === safeCursor;
        return (
          <Box key={`${opt.seq ?? "full"}-${i}`}>
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
