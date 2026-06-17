import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Command, CommandRegistry } from "../lib/commands.js";
import { useTheme } from "../lib/theme-context.js";
import { DialogFrame } from "./dialog-frame.js";

/**
 * Modal command picker. Inline text input (no Ink TextInput dep) + scrollable
 * filtered list. Up/Down to navigate, Enter to dispatch, Esc to close.
 *
 * The same registry powers `/foo` typed into the InputBox, so adding a command
 * once lights up both surfaces.
 */
export function CommandPalette(props: {
  registry: CommandRegistry;
  onPick: (cmd: Command) => void;
  onCancel: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const matches = useMemo(() => props.registry.search(query), [query]);
  const safeCursor = Math.min(cursor, Math.max(0, matches.length - 1));

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      const cmd = matches[safeCursor];
      if (cmd && (cmd.available?.() ?? true)) props.onPick(cmd);
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(matches.length - 1, c + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setCursor(0);
      return;
    }
    if (key.ctrl || key.meta || key.tab) return;
    if (input && input.length > 0) {
      setQuery((q) => q + input);
      setCursor(0);
    }
  });

  // Window the list around the cursor so long registries don't blow up the
  // panel. 10 visible rows is enough for any realistic command count.
  const windowSize = 10;
  const start = Math.max(
    0,
    Math.min(
      matches.length - windowSize,
      safeCursor - Math.floor(windowSize / 2),
    ),
  );
  const visible = matches.slice(start, start + windowSize);

  return (
    <DialogFrame borderColor={theme.accent2}>
      <Box>
        <Text color={theme.accent2} bold>
          ⌘ command palette
        </Text>
        <Text dimColor> ↑/↓ select · enter run · esc close</Text>
      </Box>
      <Box>
        <Text color={theme.accent2}>› </Text>
        <Text>{query}</Text>
        <Text color={theme.accent2}>▎</Text>
      </Box>
      {visible.length === 0 ? (
        <Text dimColor>no matches</Text>
      ) : (
        visible.map((cmd, i) => {
          const selected = start + i === safeCursor;
          const enabled = cmd.available?.() ?? true;
          return (
            <Box key={cmd.name}>
              <Text color={selected ? theme.success : undefined}>
                {selected ? "› " : "  "}
              </Text>
              <Box flexDirection="column">
                <Box>
                  <Text
                    color={
                      selected
                        ? theme.success
                        : enabled
                          ? undefined
                          : theme.muted
                    }
                    bold={selected}
                  >
                    /{cmd.name}
                  </Text>
                  <Text dimColor> {cmd.title}</Text>
                  {cmd.hint ? <Text dimColor> [{cmd.hint}]</Text> : null}
                  <Text dimColor> · {cmd.category}</Text>
                </Box>
                {selected ? <Text dimColor> {cmd.description}</Text> : null}
              </Box>
            </Box>
          );
        })
      )}
      {matches.length > windowSize ? (
        <Text dimColor>
          {start + 1}-{Math.min(matches.length, start + windowSize)} of{" "}
          {matches.length}
        </Text>
      ) : null}
    </DialogFrame>
  );
}
