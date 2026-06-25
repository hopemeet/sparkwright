import React from "react";
import { Text, useInput, useStdout } from "ink";
import { DialogFrame } from "./dialog-frame.js";
import { middleEllipsisPath } from "../lib/path-display.js";

export interface ConfigPanelResolved {
  workspaceRoot: string;
  modelName?: string;
  tuiPermissionMode: string;
  permissionMode: string;
  shouldWrite?: boolean;
  providers?: Record<string, unknown>;
  sources: {
    workspace?: string;
    model?: string;
    tuiPermissionMode?: string;
  };
  attempted: Array<{ path: string; loaded: boolean }>;
}

export function ConfigPanel(props: {
  resolved: ConfigPanelResolved;
  onClose: () => void;
}): React.ReactElement {
  const { stdout } = useStdout();
  useInput((_input, key) => {
    if (key.escape || key.return) props.onClose();
  });

  const resolved = props.resolved;
  const columns = stdout?.columns ?? 120;
  const workspace = middleEllipsisPath(
    resolved.workspaceRoot,
    Math.max(16, columns - 18),
  );
  return (
    <DialogFrame borderColor="cyan">
      <Text color="cyan" bold>
        resolved config (esc to close)
      </Text>
      <Text>
        <Text dimColor>workspace: </Text>
        {workspace}
        <Text dimColor> ({resolved.sources.workspace ?? "?"})</Text>
      </Text>
      <Text>
        <Text dimColor>model: </Text>
        {resolved.modelName ?? "—"}
        <Text dimColor> ({resolved.sources.model ?? "?"})</Text>
      </Text>
      <Text>
        <Text dimColor>tuiPermissionMode: </Text>
        {resolved.tuiPermissionMode}
        <Text dimColor> ({resolved.sources.tuiPermissionMode ?? "?"})</Text>
      </Text>
      <Text>
        <Text dimColor>core permission: </Text>
        {resolved.permissionMode}
        <Text dimColor> / shouldWrite={String(resolved.shouldWrite)}</Text>
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
    </DialogFrame>
  );
}
