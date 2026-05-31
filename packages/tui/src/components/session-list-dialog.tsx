import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionDiagnostics, SessionSummary } from "../lib/sessions.js";

/**
 * Session browser with inline filter + diagnostics + actions:
 *   "/"      toggle filter mode (type to filter id/label/preview)
 *   j/k ↑↓   navigate
 *   enter    resume
 *   i        inspect (diagnostics)
 *   r        rename (opens a sibling layer; parent owns transition)
 *   esc      close (or exit filter mode if active)
 *
 * Filter is case-insensitive substring across {id, label, preview}; ranking
 * mirrors the FileIndex weights (prefix > substring).
 */
export function SessionListDialog(props: {
  sessions: SessionSummary[];
  diagnostics: SessionDiagnostics | null;
  loadingDiagnosticsFor: string | null;
  labels: Record<string, string>;
  onPick: (id: string) => void;
  onInspect: (id: string) => void;
  onRename: (id: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState<string | null>(null);

  const filtered = useMemo(
    () => rankSessions(props.sessions, props.labels, filter ?? ""),
    [props.sessions, props.labels, filter],
  );

  const safeCursor = Math.min(cursor, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    // Filter-mode owns most keys when active.
    if (filter !== null) {
      if (key.escape) {
        setFilter(null);
        return;
      }
      if (key.return) {
        const pick = filtered[safeCursor];
        if (pick) props.onPick(pick.id);
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(filtered.length - 1, c + 1));
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((f) => (f && f.length > 0 ? f.slice(0, -1) : ""));
        setCursor(0);
        return;
      }
      if (key.ctrl || key.meta || key.tab) return;
      if (input && input.length > 0) {
        setFilter((f) => (f ?? "") + input);
        setCursor(0);
      }
      return;
    }

    if (key.escape) {
      props.onCancel();
      return;
    }
    if (input === "/") {
      setFilter("");
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(filtered.length - 1, c + 1));
    } else if (key.return) {
      const pick = filtered[safeCursor];
      if (pick) props.onPick(pick.id);
    } else if (input === "i") {
      const pick = filtered[safeCursor];
      if (pick) props.onInspect(pick.id);
    } else if (input === "r") {
      const pick = filtered[safeCursor];
      if (pick) props.onRename(pick.id);
    }
  });

  if (props.sessions.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
      >
        <Text color="cyan" bold>
          sessions
        </Text>
        <Text dimColor>
          (none found in .sparkwright/sessions — press esc to close)
        </Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box>
        <Text color="cyan" bold>
          sessions
        </Text>
        <Text dimColor>
          {"  "}↑/↓ navigate · enter resume · i inspect · r rename · / filter ·
          esc close
        </Text>
      </Box>
      {filter !== null ? (
        <Box>
          <Text color="yellow">filter: </Text>
          <Text>{filter}</Text>
          <Text color="yellow">▎</Text>
          <Text dimColor>
            {"  "}({filtered.length}/{props.sessions.length})
          </Text>
        </Box>
      ) : null}
      {filtered.slice(0, 12).map((s, i) => {
        const selected = i === safeCursor;
        const label = props.labels[s.id];
        const ts = new Date(s.mtimeMs)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);
        return (
          <Box key={s.id}>
            <Text color={selected ? "green" : undefined}>
              {selected ? "› " : "  "}
            </Text>
            <Text color={selected ? "green" : undefined}>{ts}</Text>
            <Text> </Text>
            <Text dimColor>{s.id.slice(0, 12)}</Text>
            <Text> </Text>
            {label ? (
              <Text color="cyan">{label}</Text>
            ) : (
              <Text dimColor>{s.preview || "(no preview)"}</Text>
            )}
          </Box>
        );
      })}
      {filtered.length > 12 ? (
        <Text dimColor>… +{filtered.length - 12} more (narrow filter)</Text>
      ) : null}
      <SessionDiagnosticsPanel
        diagnostics={props.diagnostics}
        loadingFor={props.loadingDiagnosticsFor}
      />
    </Box>
  );
}

/**
 * Rank sessions for the filter. Ties broken by recency (mtime desc).
 */
function rankSessions(
  sessions: SessionSummary[],
  labels: Record<string, string>,
  filter: string,
): SessionSummary[] {
  if (!filter.trim()) {
    return [...sessions].sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
  const q = filter.trim().toLowerCase();
  const scored: Array<{ s: SessionSummary; score: number }> = [];
  for (const s of sessions) {
    const label = (labels[s.id] ?? "").toLowerCase();
    const id = s.id.toLowerCase();
    const preview = (s.preview ?? "").toLowerCase();
    let score = -1;
    if (label.startsWith(q)) score = 0;
    else if (label.includes(q)) score = 1;
    else if (id.startsWith(q)) score = 2;
    else if (preview.includes(q)) score = 3;
    else if (id.includes(q)) score = 4;
    if (score >= 0) scored.push({ s, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return b.s.mtimeMs - a.s.mtimeMs;
  });
  return scored.map((x) => x.s);
}

function SessionDiagnosticsPanel(props: {
  diagnostics: SessionDiagnostics | null;
  loadingFor: string | null;
}): React.ReactElement | null {
  if (props.loadingFor) {
    return (
      <Box marginTop={1}>
        <Text dimColor>loading diagnostics for {props.loadingFor}…</Text>
      </Box>
    );
  }
  const diagnostics = props.diagnostics;
  if (!diagnostics) {
    return (
      <Box marginTop={1}>
        <Text dimColor>press i to inspect the selected session</Text>
      </Box>
    );
  }

  const findings = diagnostics.consistency.findings ?? [];
  const phases = diagnostics.timeline.phases ?? [];
  const topPhases = phases.slice(0, 8);
  return (
    <Box
      marginTop={1}
      flexDirection="column"
      borderStyle="single"
      borderColor={diagnostics.consistency.ok === false ? "red" : "green"}
      paddingX={1}
    >
      <Text color={diagnostics.consistency.ok === false ? "red" : "green"} bold>
        diagnostics {diagnostics.consistency.ok === false ? "failed" : "ok"}
      </Text>
      <Text>
        <Text dimColor>session </Text>
        {diagnostics.sessionId}
      </Text>
      <Text>
        <Text dimColor>events </Text>
        {diagnostics.summary.eventCount ?? 0}
        <Text dimColor> runs </Text>
        {diagnostics.summary.runIds?.length ?? 0}
        <Text dimColor> agents </Text>
        {diagnostics.summary.agentIds?.join(", ") || "none"}
      </Text>
      <Text>
        <Text dimColor>errors </Text>
        {diagnostics.summary.errorCount ?? 0}
        <Text dimColor> artifacts </Text>
        {diagnostics.summary.artifactCount ?? 0}
        <Text dimColor> tokens </Text>
        {diagnostics.summary.usage?.totalTokens ?? 0}
      </Text>
      <Text>
        <Text dimColor>timeline </Text>
        {phases.length} phase(s), {diagnostics.timeline.durationMs ?? 0}ms
      </Text>
      {findings.slice(0, 4).map((finding, index) => (
        <Text key={`${finding.code ?? "finding"}:${index}`} color="red">
          {finding.severity ?? "warning"} {finding.code ?? "finding"}:{" "}
          {finding.message ?? ""}
        </Text>
      ))}
      {topPhases.map((phase, index) => (
        <Text key={`${phase.startSequence ?? index}:${phase.label}`} dimColor>
          [{phase.startSequence}
          {phase.endSequence ? `-${phase.endSequence}` : ""}]{" "}
          {phase.status ?? "instant"} {phase.category ?? "other"}{" "}
          {phase.label ?? ""}
          {phase.durationMs !== undefined ? ` (${phase.durationMs}ms)` : ""}
        </Text>
      ))}
    </Box>
  );
}
