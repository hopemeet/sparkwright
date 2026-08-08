import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { SessionDiagnostics, SessionSummary } from "../lib/sessions.js";
import { displayWidth, toGraphemes } from "../lib/graphemes.js";
import {
  DialogFrame,
  dialogFrameWidth,
  resolveDialogColumns,
} from "./dialog-frame.js";

/**
 * Session browser with inline filter + diagnostics + actions:
 *   "/"      toggle filter mode (type to filter id/label/preview)
 *   "1"-"9"  resume one of the first nine listed sessions
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
  sessionRootLabel?: string;
  diagnostics: SessionDiagnostics | null;
  loadingDiagnosticsFor: string | null;
  labels: Record<string, string>;
  onPick: (id: string) => void;
  onInspect: (id: string) => void;
  onRename: (id: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const { stdout } = useStdout();
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState<string | null>(null);
  const rowWidth = Math.max(
    20,
    dialogFrameWidth(resolveDialogColumns(stdout?.columns)) - 4,
  );

  const filtered = useMemo(
    () => rankSessions(props.sessions, props.labels, filter ?? ""),
    [props.sessions, props.labels, filter],
  );

  const safeCursor = Math.min(cursor, Math.max(0, filtered.length - 1));
  const pageSize = Math.max(4, Math.min(12, (stdout?.rows ?? 24) - 10));
  const { start: visibleStart, visible } = sessionWindow(
    filtered,
    safeCursor,
    pageSize,
  );

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
    const digit = Number.parseInt(input, 10);
    if (digit >= 1 && digit <= Math.min(9, filtered.length)) {
      const pick = filtered[digit - 1];
      if (pick) props.onPick(pick.id);
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
    const sessionRootLabel = props.sessionRootLabel ?? ".sparkwright/sessions";
    return (
      <DialogFrame borderColor="cyan">
        <Text color="cyan" bold>
          sessions
        </Text>
        <Text dimColor>
          (none found in {sessionRootLabel} — press esc to close)
        </Text>
      </DialogFrame>
    );
  }

  return (
    <DialogFrame borderColor="cyan">
      <Text color="cyan" bold>
        sessions
      </Text>
      <Text dimColor>1-9 quick resume · ↑/↓ navigate · enter resume</Text>
      <Text dimColor>i inspect · r rename · / filter · esc close</Text>
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
      {visibleStart > 0 ? <Text dimColor>↑ {visibleStart} more</Text> : null}
      {visible.map((s, i) => {
        const index = visibleStart + i;
        const selected = index === safeCursor;
        const label = props.labels[s.id];
        const ts = new Date(s.mtimeMs)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);
        const title = label ?? s.preview ?? "(no preview)";
        const line = truncatePlain(
          `${sessionRowPrefix(selected, index)}${ts} ${s.id.slice(0, 12)} ${title}`,
          rowWidth,
        );
        return (
          <Text
            key={s.id}
            color={selected ? "green" : label ? "cyan" : undefined}
          >
            {line}
          </Text>
        );
      })}
      {visibleStart + visible.length < filtered.length ? (
        <Text dimColor>
          ↓ {filtered.length - visibleStart - visible.length} more
        </Text>
      ) : null}
      {filtered.length > pageSize ? (
        <Text dimColor>
          {visibleStart + 1}-{visibleStart + visible.length} of{" "}
          {filtered.length}
        </Text>
      ) : null}
      <SessionDiagnosticsPanel
        diagnostics={props.diagnostics}
        loadingFor={props.loadingDiagnosticsFor}
      />
    </DialogFrame>
  );
}

function sessionRowPrefix(selected: boolean, index: number): string {
  const digit = index < 9 ? String(index + 1) : " ";
  return `${selected ? "›" : " "} ${digit} `;
}

function truncatePlain(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  const budget = Math.max(0, max - 1);
  let out = "";
  let width = 0;
  for (const g of toGraphemes(text)) {
    const w = displayWidth(g);
    if (width + w > budget) break;
    out += g;
    width += w;
  }
  return `${out}…`;
}

export function sessionWindow<T>(
  items: readonly T[],
  cursor: number,
  windowSize: number,
): { start: number; visible: readonly T[] } {
  const size = Math.max(1, windowSize);
  const safeCursor = Math.max(
    0,
    Math.min(cursor, Math.max(0, items.length - 1)),
  );
  const start = Math.max(
    0,
    Math.min(items.length - size, safeCursor - Math.floor(size / 2)),
  );
  return { start, visible: items.slice(start, start + size) };
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
      {diagnostics.compaction ? (
        <CompactionDiagnosticsBlock compaction={diagnostics.compaction} />
      ) : null}
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

function CompactionDiagnosticsBlock(props: {
  compaction: NonNullable<SessionDiagnostics["compaction"]>;
}): React.ReactElement {
  const { compaction } = props;
  const artifact = compaction.artifact;
  const latest = compaction.latestEvent;
  const warningCodes =
    artifact?.warningCodes ?? latest?.warningCodes ?? undefined;
  const consistencyColor = compaction.consistency.ok ? "green" : "red";

  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={consistencyColor}>
        <Text dimColor>compaction </Text>
        {compaction.status}
        <Text dimColor> consistency </Text>
        {compaction.consistency.ok ? "ok" : "failed"}
      </Text>
      {artifact ? (
        <>
          <Text>
            <Text dimColor>compact </Text>
            {artifact.compactedRunCount} run(s), freed {artifact.freedChars}{" "}
            chars
            <Text dimColor> through </Text>
            {artifact.throughRunId}
          </Text>
          <Text>
            <Text dimColor>artifact </Text>
            {artifact.path}
          </Text>
          {artifact.measurement ? (
            <Text>
              <Text dimColor>regime </Text>
              {artifact.measurement.regime}
              <Text dimColor> savings </Text>
              {formatPercent(artifact.measurement.savingsRatio)}
            </Text>
          ) : null}
        </>
      ) : (
        <Text dimColor>artifact none</Text>
      )}
      {latest ? (
        <Text>
          <Text dimColor>latest </Text>
          {latest.type.replace("session.compaction.", "")} #{latest.sequence}
          {latest.skippedReason ? ` (${latest.skippedReason})` : ""}
        </Text>
      ) : null}
      {warningCodes?.length ? (
        <Text color="yellow">warnings {warningCodes.join(", ")}</Text>
      ) : null}
      {compaction.consistency.findings.slice(0, 3).map((finding, index) => (
        <Text
          key={`compaction-finding:${index}`}
          color={compaction.consistency.ok ? "yellow" : "red"}
        >
          compaction finding: {finding}
        </Text>
      ))}
    </Box>
  );
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
