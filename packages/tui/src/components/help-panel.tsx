import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { CommandRegistry } from "../lib/commands.js";

// Input editing affordances live inside InputBox (readline-style), so they have
// no /command entry. Surface them here so the help panel remains comprehensive.
const INPUT_HELP: ReadonlyArray<{ keys: string; what: string }> = [
  { keys: "enter", what: "run · \\↵ newline" },
  { keys: "↑ ↓", what: "recall input history" },
  { keys: "ctrl+r", what: "search input history" },
  { keys: "@  /", what: "mention a file · slash commands" },
  { keys: "ctrl+a / ctrl+e", what: "jump to line start / end" },
  { keys: "ctrl+w / ctrl+u", what: "delete word back / to line start" },
  { keys: "alt+← →", what: "jump by word (ctrl+← → too)" },
  { keys: "alt+d", what: "delete word forward" },
];

export function HelpPanel(props: {
  registry: CommandRegistry;
  onClose: () => void;
}): React.ReactElement {
  const { stdout } = useStdout();
  const [scroll, setScroll] = useState(0);

  const cmds = props.registry.list();
  const grouped = new Map<string, typeof cmds>();
  for (const command of cmds) {
    const group = grouped.get(command.category) ?? [];
    group.push(command);
    grouped.set(command.category, group);
  }

  const rows: React.ReactElement[] = [
    <Text key="input-heading" bold>
      input editing
    </Text>,
  ];
  for (const row of INPUT_HELP) {
    rows.push(
      <Box key={`input-${row.keys}`}>
        <Text color="cyan">{row.keys}</Text>
        <Text> </Text>
        <Text>{row.what}</Text>
      </Box>,
    );
  }
  for (const [category, list] of grouped.entries()) {
    rows.push(<Text key={`space-${category}`}> </Text>);
    rows.push(
      <Text key={`heading-${category}`} bold>
        {category}
      </Text>,
    );
    for (const command of list) {
      rows.push(
        <Box key={`command-${command.name}`}>
          <Text color="cyan">/{command.name}</Text>
          <Text> </Text>
          <Text>{command.title}</Text>
          {command.hint ? <Text dimColor> [{command.hint}]</Text> : null}
        </Box>,
      );
    }
  }

  const viewport = Math.max(6, (stdout?.rows ?? 30) - 10);
  const maxScroll = Math.max(0, rows.length - viewport);
  const clamped = Math.min(scroll, maxScroll);
  const visible = rows.slice(clamped, clamped + viewport);
  const more = rows.length - (clamped + visible.length);

  useInput((input, key) => {
    if (key.escape || key.return) return props.onClose();
    if (key.downArrow || input === "j")
      setScroll((value) => Math.min(maxScroll, value + 1));
    else if (key.upArrow || input === "k")
      setScroll((value) => Math.max(0, value - 1));
    else if (key.pageDown || input === "d")
      setScroll((value) => Math.min(maxScroll, value + viewport));
    else if (key.pageUp || input === "u")
      setScroll((value) => Math.max(0, value - viewport));
    else if (input === "g") setScroll(0);
    else if (input === "G") setScroll(maxScroll);
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
    >
      <Text color="magenta" bold>
        keyboard / commands
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visible}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>esc close</Text>
        {maxScroll > 0 ? (
          <Text dimColor>
            {" · ↑/↓ j/k scroll · u/d page"}
            {more > 0 ? ` · ${more} more ↓` : " · end"}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
