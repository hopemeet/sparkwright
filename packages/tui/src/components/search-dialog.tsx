import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { RunEvent } from "../lib/event-type.js";
import { searchTranscript } from "../lib/transcript.js";
import { useTheme } from "../lib/theme-context.js";
import { DialogFrame } from "./dialog-frame.js";

/**
 * Find text in the committed conversation. Type to filter user/assistant
 * messages; enter copies the highlighted message to the clipboard. The
 * transcript lives in terminal scrollback (no programmatic scroll), so the
 * action is "find → copy", not "find → jump" — terminal-native find handles
 * visual navigation.
 */
export function SearchDialog(props: {
  events: RunEvent[];
  onCopy: (text: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const matches = useMemo(
    () => searchTranscript(props.events, query),
    [props.events, query],
  );
  const safeCursor = Math.min(cursor, Math.max(0, matches.length - 1));
  const windowSize = 8;
  const start = Math.max(
    0,
    Math.min(safeCursor - windowSize + 1, matches.length - windowSize),
  );
  const visible = matches.slice(start, start + windowSize);

  useInput((input, key) => {
    if (key.escape) return props.onCancel();
    if (key.return) {
      const pick = matches[safeCursor];
      if (pick) props.onCopy(pick.text);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(matches.length - 1, c + 1));
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((s) => s.slice(0, -1));
      setCursor(0);
      return;
    }
    // Plain printable input narrows the filter.
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setQuery((s) => s + input);
      setCursor(0);
    }
  });

  return (
    <DialogFrame borderColor={theme.accent}>
      <Box>
        <Text color={theme.accent} bold>
          search transcript
        </Text>
        <Text color={theme.muted}>
          {"  "}type to filter · ↑/↓ select · enter copy · esc close
        </Text>
      </Box>
      <Box>
        <Text color={theme.muted}>{"› "}</Text>
        <Text>{query || ""}</Text>
        <Text inverse> </Text>
      </Box>
      {matches.length === 0 ? (
        <Text color={theme.muted}>
          {query ? `no messages match "${query}"` : "(no messages yet)"}
        </Text>
      ) : (
        visible.map((m, i) => {
          const idx = start + i;
          const selected = idx === safeCursor;
          return (
            <Box key={idx}>
              <Text color={selected ? theme.success : undefined}>
                {selected ? "› " : "  "}
              </Text>
              <Text
                color={m.role === "user" ? theme.accent2 : theme.muted}
                bold={m.role === "user"}
              >
                {m.role === "user" ? "you " : "ai  "}
              </Text>
              <Text color={selected ? theme.success : undefined}>
                {m.snippet}
              </Text>
            </Box>
          );
        })
      )}
      {matches.length > windowSize ? (
        <Text color={theme.muted}>
          {safeCursor + 1}/{matches.length}
        </Text>
      ) : null}
    </DialogFrame>
  );
}
