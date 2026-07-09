import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { CommandRegistry } from "../lib/commands.js";
import { formatBinding, type Bindings } from "../lib/keybindings.js";
import { DialogFrame } from "./dialog-frame.js";

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

// App-level chords with no /command entry (or worth calling out here). This is
// the home for what the pinned input footer used to show, now that the footer
// is gone.
const GLOBAL_KEYS: ReadonlyArray<{ binding: keyof Bindings; what: string }> = [
  {
    binding: "cycle-permission-mode",
    what: "cycle permission mode (next run)",
  },
  { binding: "activity.open", what: "background tasks / activity drawer" },
  { binding: "events.open", what: "activity events tab" },
  { binding: "todo.toggle", what: "expand / collapse the todo band" },
  { binding: "cancel.run", what: "cancel the running goal" },
  { binding: "quit.app", what: "back out · press twice to quit" },
];

export function HelpPanel(props: {
  registry: CommandRegistry;
  bindings: Bindings;
  onClose: () => void;
}): React.ReactElement {
  const { stdout } = useStdout();
  const [scroll, setScroll] = useState(0);

  const allCommands = props.registry.list();
  const cmds = allCommands.filter((cmd) => !cmd.hiddenByDefault);
  const hiddenCommands = allCommands.filter((cmd) => cmd.hiddenByDefault);
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
  if (hiddenCommands.length > 0) {
    rows.push(<Text key="space-more-commands"> </Text>);
    rows.push(
      <Text key="more-commands-heading" bold>
        more commands
      </Text>,
    );
    for (const command of hiddenCommands) {
      rows.push(
        <Box key={`hidden-command-${command.name}`}>
          <Text color="cyan">/{command.name}</Text>
          <Text> </Text>
          <Text>{command.title}</Text>
          {command.hint ? <Text dimColor> [{command.hint}]</Text> : null}
        </Box>,
      );
    }
  }
  // Global chords last: the command list is what people scan for first, so the
  // key reference sits at the bottom rather than pushing commands below the fold.
  const globalKeyRows = GLOBAL_KEYS.map((k) => ({
    keys: formatBinding(props.bindings[k.binding]),
    what: k.what,
  })).filter((row) => row.keys);
  if (globalKeyRows.length > 0) {
    rows.push(<Text key="space-global"> </Text>);
    rows.push(
      <Text key="global-heading" bold>
        global keys
      </Text>,
    );
    for (const row of globalKeyRows) {
      rows.push(
        <Box key={`global-${row.keys}`}>
          <Text color="cyan">{row.keys}</Text>
          <Text> </Text>
          <Text>{row.what}</Text>
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
    <DialogFrame borderColor="magenta">
      <Text color="magenta" bold>
        keyboard / commands
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visible}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{footerText(maxScroll > 0, more)}</Text>
      </Box>
    </DialogFrame>
  );
}

function footerText(scrollable: boolean, more: number): string {
  const suffix = " · search for more";
  if (!scrollable) return `esc close${suffix}`;
  return `esc close · ↑/↓ j/k · u/d page${
    more > 0 ? ` · ${more} more ↓` : " · end"
  }${suffix}`;
}
