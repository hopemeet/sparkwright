import React from "react";
import { Box, Text } from "ink";

export interface KeyHint {
  keys: string;
  label: string;
}

/** Shared footer projection so visible hints and action descriptors stay data-driven. */
export function KeyHints(props: {
  hints: readonly KeyHint[];
}): React.ReactElement {
  return (
    <Box flexWrap="wrap">
      {props.hints.map((hint, index) => (
        <React.Fragment key={`${hint.keys}:${hint.label}`}>
          {index > 0 ? <Text dimColor> · </Text> : null}
          <Text dimColor>
            {hint.keys} {hint.label}
          </Text>
        </React.Fragment>
      ))}
    </Box>
  );
}
