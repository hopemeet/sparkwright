import React, { useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";
import type { StoreState } from "../state/event-store.js";
import { useTheme } from "../lib/theme-context.js";
import { Spinner } from "./spinner.js";

/**
 * Header / status bar. Shows resolved config + live run state. The elapsed
 * timer ticks once a second while running; we keep the interval local so it
 * doesn't pollute the store with redraws when nothing's happening.
 */
export function StatusBar(props: {
  state: StoreState;
  modelLabel: string;
  permissionMode: string;
  focused: boolean;
}): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  const elapsedMs = useElapsed(props.state);
  const compact = (stdout?.columns ?? 120) < 100;
  const statusLabel =
    props.state.status === "awaiting-approval"
      ? "approval"
      : props.state.status;
  const modelLabel = compact
    ? compactModelLabel(props.modelLabel)
    : props.modelLabel;
  const statusColor =
    props.state.status === "error"
      ? theme.statusError
      : props.state.status === "done"
        ? theme.statusDone
        : props.state.status === "awaiting-approval"
          ? theme.statusAwaiting
          : props.state.status === "running"
            ? theme.statusRunning
            : theme.statusIdle;
  const total = props.state.usage?.totalTokens;
  const cost = props.state.usage?.estimatedCostUsd;
  const isRunning = props.state.status === "running";
  // Single compact line pinned above the input. Only the fields you actually
  // watch while working live here; static context (cwd, session id) is shown
  // once in the welcome area and via /config, so it doesn't squat on-screen.
  return (
    <Box paddingX={1}>
      <Text bold>SparkWright</Text>
      <Text> </Text>
      {isRunning ? (
        <>
          <Spinner color={statusColor} />
          <Text color={statusColor}> {statusLabel}</Text>
        </>
      ) : (
        <Text color={statusColor}>● {statusLabel}</Text>
      )}
      {props.state.stopReason ? (
        <Text color={theme.muted}> ({props.state.stopReason})</Text>
      ) : null}
      {elapsedMs !== null ? (
        <Text color={theme.muted}> · {formatDuration(elapsedMs)}</Text>
      ) : null}
      {total ? <Text color={theme.muted}> · {formatTokens(total)}</Text> : null}
      {typeof cost === "number" && cost > 0 ? (
        <Text color={theme.muted}> · ${cost.toFixed(cost < 1 ? 4 : 2)}</Text>
      ) : null}
      {!props.focused ? <Text color={theme.muted}> · ⊙ blurred</Text> : null}
      <Box flexGrow={1} />
      <Text color={theme.accent}>{modelLabel}</Text>
      <Text color={theme.muted}> · {props.permissionMode}</Text>
    </Box>
  );
}

function useElapsed(state: StoreState): number | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (state.status !== "running") return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [state.status]);
  if (!state.runStartedAt) return null;
  const end = state.runEndedAt ?? Date.now();
  return Math.max(0, end - state.runStartedAt);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${(n / 1_000_000).toFixed(2)}M tok`;
}

function compactModelLabel(label: string): string {
  const slash = label.lastIndexOf("/");
  return slash >= 0 ? label.slice(slash + 1) : label;
}
