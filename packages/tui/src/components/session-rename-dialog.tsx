import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

/**
 * Inline rename prompt. Takes a sessionId + current label, lets the user edit
 * with basic line-editor keys, returns the new label (empty string = clear).
 *
 * Kept dialog-shaped so the layer stack can render it on top of the session
 * list without losing list state.
 */
export function SessionRenameDialog(props: {
  sessionId: string;
  initialLabel: string;
  onCommit: (label: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [value, setValue] = useState(props.initialLabel);
  const [cursor, setCursor] = useState(props.initialLabel.length);

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      props.onCommit(value.trim());
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(value.length, c + 1));
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
      setCursor((c) => c - 1);
      return;
    }
    if (key.ctrl && input === "u") {
      setValue("");
      setCursor(0);
      return;
    }
    if (key.ctrl || key.meta || key.tab) return;
    if (input && input.length > 0) {
      setValue((v) => v.slice(0, cursor) + input + v.slice(cursor));
      setCursor((c) => c + input.length);
    }
  });

  // Truncate displayed cap at 80; the writer also enforces this.
  const overlong = value.length > 80;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box>
        <Text color="cyan" bold>
          rename session
        </Text>
        <Text dimColor> {props.sessionId}</Text>
      </Box>
      <Box>
        <Text>{"› "}</Text>
        <RenderedLine value={value} cursor={cursor} />
      </Box>
      <Text dimColor>
        {value.length}/80 · enter save · ctrl+u clear · esc cancel
        {overlong ? " · will be truncated" : ""}
      </Text>
    </Box>
  );
}

function RenderedLine(props: {
  value: string;
  cursor: number;
}): React.ReactElement {
  const { value, cursor } = props;
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || " ";
  const after = value.slice(cursor + 1);
  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{at}</Text>
      <Text>{after}</Text>
    </>
  );
}
