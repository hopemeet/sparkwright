import React from "react";
import { Box, Text } from "ink";
import type {
  ModifiedFile,
  TodoPanelItem,
  UsageSummary,
} from "../state/event-store.js";
import { useTheme } from "../lib/theme-context.js";

/**
 * Right-rail sidebar. Shows the todo ledger (when present), the modified-files
 * list, and a usage summary; a vertical stack so future "slots" (lsp, mcp) can
 * be added without re-laying-out the app.
 */
export function Sidebar(props: {
  files: ModifiedFile[];
  todos: TodoPanelItem[];
  width: number;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width={props.width}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      {props.todos.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <TodoPanel todos={props.todos} width={props.width - 4} />
        </Box>
      ) : null}
      <ModifiedFilesPanel files={props.files} width={props.width - 4} />
    </Box>
  );
}

/** Status → checkbox glyph for the todo panel. */
const TODO_GLYPH: Record<string, string> = {
  pending: "☐",
  in_progress: "◐",
  completed: "☑",
  blocked: "⊘",
  failed: "✗",
  skipped: "⊝",
};

function TodoPanel(props: {
  todos: TodoPanelItem[];
  width: number;
}): React.ReactElement {
  const theme = useTheme();
  const done = props.todos.filter((t) => t.status === "completed").length;
  // Cap the rendered rows so a long ledger can't push the rest of the rail off.
  const visible = props.todos.slice(0, 12);
  const overflow = props.todos.length - visible.length;
  const colorFor = (status: string): string | undefined => {
    if (status === "completed") return theme.success;
    if (status === "in_progress") return theme.accent;
    if (status === "blocked" || status === "failed") return theme.error;
    if (status === "skipped") return theme.muted;
    return undefined;
  };
  return (
    <Box flexDirection="column">
      <Text bold>
        todo ({done}/{props.todos.length})
      </Text>
      {visible.map((t, i) => {
        const glyph = TODO_GLYPH[t.status] ?? "☐";
        const indent = "  ".repeat(Math.min(t.depth, 3));
        const text = truncate(
          t.title,
          Math.max(8, props.width - indent.length - 2),
        );
        return (
          <Text key={i} color={colorFor(t.status)}>
            {indent}
            {glyph} {text}
          </Text>
        );
      })}
      {overflow > 0 ? <Text dimColor>… +{overflow} more</Text> : null}
    </Box>
  );
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function ModifiedFilesPanel(props: {
  files: ModifiedFile[];
  width: number;
}): React.ReactElement {
  if (props.files.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>modified files</Text>
        <Text dimColor>(none yet)</Text>
      </Box>
    );
  }
  // Sort: pending first, then applied, then denied; alpha within each.
  const sorted = [...props.files].sort((a, b) => {
    const rank = { requested: 0, applied: 1, denied: 2 } as const;
    const r = rank[a.status] - rank[b.status];
    return r !== 0 ? r : a.path.localeCompare(b.path);
  });
  // Show up to 12; longer lists collapse.
  const visible = sorted.slice(0, 12);
  const overflow = sorted.length - visible.length;
  return (
    <Box flexDirection="column">
      <Text bold>modified files ({sorted.length})</Text>
      {visible.map((f) => (
        <FileRow key={f.path} file={f} width={props.width} />
      ))}
      {overflow > 0 ? <Text dimColor>… +{overflow} more</Text> : null}
    </Box>
  );
}

function FileRow(props: {
  file: ModifiedFile;
  width: number;
}): React.ReactElement {
  const { file } = props;
  // Right-side counts take ~10 chars; reserve the rest for the path with
  // tail-truncation since the last segment matters most.
  const reserve = 10;
  const maxPath = Math.max(8, props.width - reserve);
  const path =
    file.path.length > maxPath
      ? "…" + file.path.slice(-(maxPath - 1))
      : file.path;
  const theme = useTheme();
  const statusGlyph =
    file.status === "applied" ? "●" : file.status === "denied" ? "✗" : "○";
  const statusColor =
    file.status === "applied"
      ? theme.success
      : file.status === "denied"
        ? theme.error
        : theme.warning;
  return (
    <Box>
      <Text color={statusColor}>{statusGlyph} </Text>
      <Text>{path}</Text>
      <Box flexGrow={1} />
      {file.additions ? (
        <Text color={theme.diffAdded}>+{file.additions}</Text>
      ) : null}
      {file.additions && file.deletions ? <Text dimColor>/</Text> : null}
      {file.deletions ? (
        <Text color={theme.diffRemoved}>-{file.deletions}</Text>
      ) : null}
    </Box>
  );
}

export function UsageSummaryLine(props: {
  usage: UsageSummary | null;
}): React.ReactElement | null {
  const u = props.usage;
  if (!u) return null;
  const total = u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  if (!total) return null;
  return (
    <Box paddingX={1}>
      <Text dimColor>usage </Text>
      {u.contextTokens ? (
        <>
          <Text dimColor>ctx </Text>
          <Text>{formatNumber(u.contextTokens)}</Text>
        </>
      ) : null}
      {u.inputTokens || u.outputTokens ? (
        <>
          {u.contextTokens ? <Text dimColor> · </Text> : null}
          <Text dimColor>in </Text>
          <Text>{formatNumber(u.inputTokens ?? 0)}</Text>
          {u.cachedTokens ? (
            <Text dimColor> ({formatNumber(u.cachedTokens)} cached)</Text>
          ) : null}
          <Text dimColor> / out </Text>
          <Text>{formatNumber(u.outputTokens ?? 0)}</Text>
        </>
      ) : null}
      {u.modelCalls || u.toolCalls ? (
        <>
          <Text dimColor> · calls </Text>
          <Text>{u.modelCalls ?? 0}</Text>
          <Text dimColor> model / </Text>
          <Text>{u.toolCalls ?? 0}</Text>
          <Text dimColor> tool</Text>
        </>
      ) : null}
      {typeof u.estimatedCostUsd === "number" && u.estimatedCostUsd > 0 ? (
        <>
          <Text dimColor> · cost </Text>
          <Text>${u.estimatedCostUsd.toFixed(4)}</Text>
        </>
      ) : null}
    </Box>
  );
}

function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}
