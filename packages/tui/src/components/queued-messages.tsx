import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../lib/theme-context.js";

/**
 * Compact list of prompts waiting to run, shown just above the input while a
 * run is in flight. Each is the user's queued goal, one-lined and truncated;
 * the head (next to run) is marked. Hidden when the queue is empty.
 */
export function QueuedMessages(props: {
  items: readonly string[];
}): React.ReactElement | null {
  const theme = useTheme();
  if (props.items.length === 0) return null;
  const visible = props.items.slice(0, 5);
  const overflow = props.items.length - visible.length;
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text color={theme.muted}>
        queued ({props.items.length}) · each runs when the current goal finishes
      </Text>
      {visible.map((text, i) => (
        <Box key={i}>
          <Text color={theme.accent}>{i === 0 ? "→ " : "  "}</Text>
          <Text dimColor>{oneLine(text)}</Text>
        </Box>
      ))}
      {overflow > 0 ? <Text dimColor>{`  … +${overflow} more`}</Text> : null}
    </Box>
  );
}

/** Collapse newlines and clip to a single readable row. */
function oneLine(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
