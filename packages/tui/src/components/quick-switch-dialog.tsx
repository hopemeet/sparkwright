import React from "react";
import { Box, Text, useInput } from "ink";
import type { SessionSummary } from "../lib/sessions.js";

/**
 * 9-slot quick session switcher. Press 1-9 to switch; esc to cancel. We
 * deliberately avoid leader-key chains here — single-digit hotkeys land in
 * one keystroke and need no infra. The dialog also accepts arrow keys + enter
 * for non-keyboard-power users.
 */
export function QuickSwitchDialog(props: {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  labels: Record<string, string>;
  onPick: (id: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const slots = props.sessions.slice(0, 9);
  const [cursor, setCursor] = React.useState(0);

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      const pick = slots[cursor];
      if (pick) props.onPick(pick.id);
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(slots.length - 1, c + 1));
      return;
    }
    // 1-9 hotkeys.
    const digit = parseInt(input, 10);
    if (digit >= 1 && digit <= slots.length) {
      const pick = slots[digit - 1];
      if (pick) props.onPick(pick.id);
    }
  });

  if (slots.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
      >
        <Text color="cyan" bold>
          quick switch
        </Text>
        <Text dimColor>(no sessions yet — esc to close)</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box>
        <Text color="cyan" bold>
          quick switch
        </Text>
        <Text dimColor> press 1-{slots.length} · esc close</Text>
      </Box>
      {slots.map((s, i) => {
        const isCurrent = s.id === props.currentSessionId;
        const selected = i === cursor;
        const ts = new Date(s.mtimeMs)
          .toISOString()
          .replace("T", " ")
          .slice(5, 16);
        return (
          <Box key={s.id}>
            <Text
              color={isCurrent ? "green" : selected ? "cyan" : "yellow"}
              bold
            >
              {i + 1}
            </Text>
            <Text dimColor> · </Text>
            <Text dimColor>{ts}</Text>
            <Text> </Text>
            {props.labels[s.id] ? (
              <Text color={isCurrent ? "green" : "cyan"}>
                {props.labels[s.id]}
              </Text>
            ) : (
              <Text color={isCurrent ? "green" : undefined}>
                {s.preview || s.id.slice(0, 16)}
              </Text>
            )}
            {isCurrent ? <Text dimColor> (current)</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
