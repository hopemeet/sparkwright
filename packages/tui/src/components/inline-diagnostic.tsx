import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../lib/theme-context.js";

export function InlineDiagnostic(props: {
  title: string;
  message?: string;
  hint?: string;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <Box paddingX={1} flexWrap="wrap">
      <Text color={theme.error} bold>
        {props.title}
        {props.message ? `: ${props.message}` : ""}
      </Text>
      {props.hint ? <Text color={theme.muted}> · {props.hint}</Text> : null}
    </Box>
  );
}
