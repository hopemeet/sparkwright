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
  onFork: (forkAtSequence: number | undefined, label: string) => void;
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
          {"  "}pick a point to fork from · ↑/↓ select · enter fork · esc cancel
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

function extractTurns(events: RunEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const ev of events) {
    if (ev.type !== "run.started") continue;
    const p = (ev.payload ?? {}) as { goal?: unknown };
    const goal = typeof p.goal === "string" ? p.goal : "(run)";
    turns.push({ sequence: ev.sequence ?? 0, goal });
  }
  return turns;
}
