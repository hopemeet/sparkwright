import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { SessionForkPoint } from "@sparkwright/protocol";
import type { RunEvent } from "../lib/event-type.js";
import { useTheme } from "../lib/theme-context.js";
import { isBackInput } from "../lib/input-key.js";
import { windowAroundCursor } from "../lib/list-window.js";
import { DialogFrame } from "./dialog-frame.js";

/**
 * Fork-point picker. Each turn is anchored to its stable run id. Enter keeps
 * the selected turn; `e` branches immediately before it and prefills the goal.
 *
 * Enter forks at the highlighted point; esc cancels.
 */
export function ForkDialog(props: {
  events: RunEvent[];
  /**
   * Fork at the chosen point. `edit` true means "edit & resend": fork, then
   * prefill the input with this turn's goal so the user can tweak and re-run.
   */
  onFork: (
    forkPoint: SessionForkPoint | undefined,
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
    runId: string | undefined;
    turnNumber?: number;
  }> = [
    { label: "Full session (clone everything)", runId: undefined },
    ...turns.map((t, index) => ({
      label: t.goal,
      runId: t.runId,
      turnNumber: index + 1,
    })),
  ];
  const [cursor, setCursor] = useState(0);
  const safeCursor = Math.max(0, Math.min(cursor, options.length - 1));
  const windowSize = Math.max(5, Math.min(12, (stdout?.rows ?? 30) - 8));
  const { start, visible } = windowAroundCursor(
    options,
    safeCursor,
    windowSize,
  );

  useInput((input, key) => {
    if (isBackInput(input, key)) {
      props.onCancel();
      return;
    }
    if (key.return) {
      const pick = options[safeCursor];
      props.onFork(
        pick.runId ? { runId: pick.runId, position: "after" } : undefined,
        pick.label,
      );
      return;
    }
    // "e" = fork & edit: only meaningful for a specific user turn (not the
    // full-clone option, which has no single goal to edit).
    if (input === "e") {
      const pick = options[safeCursor];
      if (pick.runId) {
        props.onFork(
          { runId: pick.runId, position: "before" },
          pick.label,
          true,
        );
      }
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
    <DialogFrame borderColor={theme.accent}>
      <Box>
        <Text color={theme.accent} bold>
          fork session
        </Text>
        <Text color={theme.muted}>{"  "}pick a point</Text>
      </Box>
      <Text color={theme.muted}>
        ↑/↓ select · enter fork · e fork+edit · esc close
      </Text>
      {visible.map((opt, i) => {
        const optionIndex = start + i;
        const selected = optionIndex === safeCursor;
        return (
          <Box key={`${opt.runId ?? "full"}-${optionIndex}`}>
            <Text color={selected ? theme.success : undefined}>
              {selected ? "› " : "  "}
            </Text>
            {opt.runId !== undefined ? (
              <Text color={theme.muted}>
                [#{String(opt.turnNumber).padStart(2, " ")}]{" "}
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
    </DialogFrame>
  );
}

interface Turn {
  runId: string;
  goal: string;
}

export function extractTurns(events: RunEvent[]): Turn[] {
  // The synthetic `tui.user` event supplies a fallback goal when
  // `run.started` omits it. Child-agent runs are execution details rather than
  // conversation turns, so only the main agent appears in this picker.
  const turns: Turn[] = [];
  let pendingGoal: string | undefined;
  for (const ev of events) {
    if (ev.type === "tui.user") {
      const g = (ev.payload as { goal?: unknown } | undefined)?.goal;
      if (typeof g === "string" && g.trim()) pendingGoal = g;
      continue;
    }
    if (ev.type !== "run.started") continue;
    if (ev.metadata?.agentId !== undefined && ev.metadata.agentId !== "main") {
      continue;
    }
    if (!ev.runId) continue;
    const p = (ev.payload ?? {}) as { goal?: unknown };
    const ownGoal =
      typeof p.goal === "string" && p.goal.trim() ? p.goal : undefined;
    turns.push({
      runId: ev.runId,
      goal: ownGoal ?? pendingGoal ?? "(run)",
    });
    pendingGoal = undefined;
  }
  return turns;
}
