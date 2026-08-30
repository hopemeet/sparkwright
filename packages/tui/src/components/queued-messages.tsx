import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../lib/theme-context.js";
import type { QueuedSubmission } from "../state/queue-store.js";

/**
 * Compact list of prompts waiting to run, shown just above the input while a
 * run is in flight. Each structured entry is labeled by scheduling ownership,
 * one-lined, and truncated; the head is marked. Hidden when the queue is empty.
 */
export function QueuedMessages(props: {
  items: readonly QueuedSubmission[];
}): React.ReactElement | null {
  const theme = useTheme();
  if (props.items.length === 0) return null;
  const visible = props.items.slice(0, 5);
  const overflow = props.items.length - visible.length;
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text color={theme.muted}>
        pending ({props.items.length}) · runs in order after the current goal
      </Text>
      {visible.map((item, i) => (
        <Box key={item.commandId ?? `${item.goal}:${i}`}>
          <Text color={theme.accent}>{i === 0 ? "→ " : "  "}</Text>
          <Text color={theme.muted}>{queueKind(item).padEnd(10)} </Text>
          <Text dimColor>{oneLine(item.goal)}</Text>
        </Box>
      ))}
      {overflow > 0 ? <Text dimColor>{`  … +${overflow} more`}</Text> : null}
    </Box>
  );
}

function queueKind(item: QueuedSubmission): string {
  if (item.commandId) return "follow-up";
  if (item.projectCommand) return "command";
  return "next";
}

/** Collapse newlines and clip to a single readable row. */
function oneLine(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
