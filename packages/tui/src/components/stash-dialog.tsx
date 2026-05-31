import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { DraftEntry } from "../lib/stash.js";
import { useTheme } from "../lib/theme-context.js";

/**
 * Browse archived drafts. Enter loads the selected one into the input box
 * (the parent owns that wiring). Esc closes.
 */
export function StashDialog(props: {
  entries: DraftEntry[];
  onPick: (text: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const [cursor, setCursor] = useState(Math.max(0, props.entries.length - 1));
  const safeCursor = Math.min(cursor, Math.max(0, props.entries.length - 1));

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      const pick = props.entries[safeCursor];
      if (pick) props.onPick(pick.text);
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(props.entries.length - 1, c + 1));
    }
  });

  if (props.entries.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
      >
        <Text color={theme.accent} bold>
          stashed drafts
        </Text>
        <Text color={theme.muted}>
          (none yet — drafts ≥ 20 chars are snapshotted as you type)
        </Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      <Box>
        <Text color={theme.accent} bold>
          stashed drafts ({props.entries.length})
        </Text>
        <Text color={theme.muted}>
          {"  "}↑/↓ select · enter restore · esc close
        </Text>
      </Box>
      {props.entries.map((entry, i) => {
        const selected = i === safeCursor;
        const ts = new Date(entry.ts)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);
        return (
          <Box key={`${entry.ts}-${i}`}>
            <Text color={selected ? theme.success : undefined}>
              {selected ? "› " : "  "}
            </Text>
            <Text color={theme.muted}>{ts} </Text>
            <Text color={selected ? theme.success : undefined}>
              {entry.text.replace(/\n/g, " ").slice(0, 80)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
