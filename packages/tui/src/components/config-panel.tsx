import React from "react";
import { Box, Text, useInput } from "ink";

export interface ConfigPanelResolved {
  workspaceRoot: string;
  modelName?: string;
  permissionMode: string;
  providers?: Record<string, unknown>;
  sources: {
    workspace?: string;
    model?: string;
    permissionMode?: string;
  };
  attempted: Array<{ path: string; loaded: boolean }>;
}

export function ConfigPanel(props: {
  resolved: ConfigPanelResolved;
  onClose: () => void;
}): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape || key.return) props.onClose();
  });

  const resolved = props.resolved;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text color="cyan" bold>
        resolved config (esc to close)
      </Text>
      <Text>
        <Text dimColor>workspace: </Text>
        {resolved.workspaceRoot}
        <Text dimColor> ({resolved.sources.workspace ?? "?"})</Text>
      </Text>
      <Text>
        <Text dimColor>model: </Text>
        {resolved.modelName ?? "—"}
        <Text dimColor> ({resolved.sources.model ?? "?"})</Text>
      </Text>
      <Text>
        <Text dimColor>permissionMode: </Text>
        {resolved.permissionMode}
        <Text dimColor> ({resolved.sources.permissionMode ?? "?"})</Text>
      </Text>
      {resolved.providers && Object.keys(resolved.providers).length > 0 ? (
        <Text>
          <Text dimColor>providers: </Text>
          {Object.keys(resolved.providers).join(", ")}
        </Text>
      ) : null}
      <Text> </Text>
      <Text color="cyan">files attempted</Text>
      {resolved.attempted.map((attempt) => (
        <Text key={attempt.path} color={attempt.loaded ? "green" : undefined}>
          {attempt.loaded ? "✓ " : "  "}
          <Text dimColor={!attempt.loaded}>{attempt.path}</Text>
        </Text>
      ))}
    </Box>
  );
}
