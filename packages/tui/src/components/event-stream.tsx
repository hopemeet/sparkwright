import React from "react";
import { Box, Static, Text } from "ink";
import type { RunEvent } from "../lib/event-type.js";
import { formatEvent } from "../lib/format-event.js";
import { parseUnifiedDiff } from "../lib/diff.js";
import { sanitizeAnsiForRender } from "../lib/text.js";
import { Markdown } from "./markdown.js";
import { useTheme } from "../lib/theme-context.js";

export interface TranscriptHeaderInfo {
  workspaceRoot: string;
  modelLabel: string;
  sessionId: string | null;
}

type Row =
  | { kind: "header"; key: string; header: TranscriptHeaderInfo }
  | { kind: "event"; key: string; event: RunEvent; inBatch: boolean };

/**
 * Committed transcript. A one-time session header sits at the very top, then
 * each event is printed once into the terminal's native scrollback via Ink's
 * <Static> — so history is owned by the terminal (native scroll, no per-frame
 * repaint) and the header scrolls away as work accumulates.
 *
 * <Static> renders `items.slice(previousLength)` on every commit, so the row
 * array MUST be append-only past index 0 (the header), and each row must
 * render to a STABLE result — we never merge two events (e.g. tool.requested
 * + tool.completed) into one mutating card, since a committed row can't be
 * repainted. Each event maps to its own typed card; noisy intermediate
 * events render to nothing.
 */
export function EventStream(props: {
  events: RunEvent[];
  header: TranscriptHeaderInfo;
}): React.ReactElement {
  // Batch membership is derived purely from event order: a `tool.batch.requested`
  // opens a batch and the matching `tool.batch.completed` closes it. Anything in
  // between (the concurrent child tool.* events) renders indented under the batch
  // header so a batch reads as one group rather than a flat wall of tool lines.
  // This is <Static>-safe: by the time a child row is committed its opening
  // batch.requested has already been seen, so each row's `inBatch` is stable and
  // never changes on a later commit.
  let batchDepth = 0;
  const rows: Row[] = [
    { kind: "header", key: "__header", header: props.header },
    ...props.events.map((event): Row => {
      // The batch.requested header itself is NOT a member (depth flips after
      // it); the batch.completed closer drops back out before this row.
      if (event.type === "tool.batch.completed" && batchDepth > 0) batchDepth--;
      const inBatch = batchDepth > 0;
      if (event.type === "tool.batch.requested") batchDepth++;
      return {
        kind: "event",
        key: event.id ?? `${event.sequence}`,
        event,
        inBatch,
      };
    }),
  ];
  return (
    <Static items={rows}>
      {(row) =>
        row.kind === "header" ? (
          <HeaderRow key={row.key} header={row.header} />
        ) : (
          <EventCardBoundary
            key={row.key}
            event={row.event}
            inBatch={row.inBatch}
          />
        )
      }
    </Static>
  );
}

/**
 * A committed transcript row is rendered once into native scrollback and can
 * never be repainted, so a render throw inside one EventCard must not take down
 * the whole Ink tree (a single malformed payload once crashed the entire TUI —
 * see the `oneLine`/`run.failed` regression). This boundary contains the throw
 * to its own row and degrades to a dim diagnostic line instead.
 */
class EventCardBoundary extends React.Component<
  { event: RunEvent; inBatch: boolean },
  { error: Error | null }
> {
  constructor(props: { event: RunEvent; inBatch: boolean }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  render(): React.ReactNode {
    if (this.state.error) {
      const ev = this.props.event;
      return (
        <Box paddingX={1}>
          <Text dimColor>
            [{String(ev.sequence).padStart(3, " ")}] {ev.type} — render error:{" "}
            {this.state.error.message}
          </Text>
        </Box>
      );
    }
    return <EventCard event={this.props.event} inBatch={this.props.inBatch} />;
  }
}

function HeaderRow(props: {
  header: TranscriptHeaderInfo;
}): React.ReactElement {
  const h = props.header;
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Text>
        <Text bold>SparkWright</Text>
        <Text dimColor> · type a goal · /capabilities · /help</Text>
      </Text>
      <Text>
        <Text dimColor>cwd </Text>
        {h.workspaceRoot}
      </Text>
      <Text>
        <Text dimColor>model </Text>
        <Text color="cyan">{h.modelLabel}</Text>
        <Text dimColor> · session </Text>
        {h.sessionId ?? "—"}
      </Text>
    </Box>
  );
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * One committed event → one typed card. Intermediate / noisy events
 * (stream start, tool start, usage, write-requested) render to nothing so the
 * transcript reads as a conversation rather than a log. Anything unrecognised
 * falls back to a dim `[seq] type detail` line so the transcript stays
 * lossless.
 */
function EventCard(props: {
  event: RunEvent;
  inBatch: boolean;
}): React.ReactElement | null {
  const theme = useTheme();
  const ev = props.event;
  const p = rec(ev.payload);
  // Batch members are indented one extra step and packed tightly (no per-card
  // top margin) so the group's child tool lines sit visually under the batch
  // header instead of each floating as its own block.
  const inBatch = props.inBatch;
  const childPad = inBatch ? 3 : 1;

  switch (ev.type) {
    // Synthetic user goal injected by the RunController (see appendUserMessage).
    // `run.started` is hidden below — its payload is empty on the deterministic
    // provider, and carrying the goal here works for every provider.
    case "tui.user": {
      const goal = str(p.goal).trim();
      if (!goal) return null;
      // The typed goal carries the emphasis (bold), so the line reads clearly
      // as the user's own input; the marker stays a calm gutter cue rather than
      // a loud accent so committed history isn't visually noisy.
      return (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.muted}>{"› "}</Text>
          <Text bold>{goal}</Text>
        </Box>
      );
    }

    // A TUI-local divider (todo-supervisor continuation banner). Calm muted
    // cue so a superseded-and-resumed boundary reads as system bookkeeping, not
    // user input or an error.
    case "tui.notice": {
      const text = str(p.text).trim();
      if (!text) return null;
      return (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.muted}>{`↻ ${text}`}</Text>
        </Box>
      );
    }

    // The assistant's answer (and any mid-run commentary). `model.completed`
    // is emitted by every provider (deterministic and streaming) and its
    // payload spreads the model output, so the text is at `payload.message`.
    // We render the committed card from `model.completed` only — the streaming
    // path also fires `model.stream.completed`, which we hide below so the
    // finished reply isn't printed twice.
    case "model.completed":
    case "model.assistant_text": {
      const message = str(p.message).trim();
      if (!message) return null;
      return (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text color={theme.success}>assistant</Text>
          <Markdown text={message} />
        </Box>
      );
    }

    // A concurrent/sequential tool batch (deterministic provider). Render a
    // single header line that introduces the group; the child tool cards below
    // are indented under it (see `inBatch`). `tool.batch.completed` stays hidden
    // — the closer needs no card.
    case "tool.batch.requested": {
      const count =
        typeof p.toolCallCount === "number"
          ? p.toolCallCount
          : Array.isArray(p.toolNames)
            ? p.toolNames.length
            : 0;
      const mode = str(p.mode) || "concurrent";
      return (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.accent}>{"⚙ "}</Text>
          <Text color={theme.accent} bold>
            batch
          </Text>
          <Text
            dimColor
          >{`  ${count} tool${count === 1 ? "" : "s"} · ${mode}`}</Text>
        </Box>
      );
    }

    case "workspace.read": {
      const path = str(p.path) || "?";
      return (
        <Box paddingLeft={childPad} paddingRight={1}>
          <Text color={theme.muted}>{"read "}</Text>
          <Text dimColor>{path}</Text>
        </Box>
      );
    }

    case "tool.requested": {
      const name = str(p.toolName) || "tool";
      const args = p.arguments ?? p.input ?? p.args;
      const preview = args !== undefined ? oneLine(args, 80) : "";
      return (
        <Box
          paddingLeft={childPad}
          paddingRight={1}
          marginTop={inBatch ? 0 : 1}
        >
          <Text color={theme.accent}>{inBatch ? "› " : "⚙ "}</Text>
          <Text color={theme.accent} bold>
            {name}
          </Text>
          {preview ? <Text dimColor>{"  " + preview}</Text> : null}
        </Box>
      );
    }

    case "tool.completed": {
      const result = p.result ?? p.output;
      const artifacts = Array.isArray(p.artifacts) ? p.artifacts : [];
      if (result === undefined && artifacts.length === 0) return null;
      // read_file returns a structured envelope ({ path, content, totalLines,
      // bytes, … }). Dumping it via oneLine floods the transcript with the
      // entire file body as JSON — but more than that, a read_file call already
      // emitted a `workspace.read` line (ControlledWorkspace.readText fires it
      // from inside the tool), so a tool.completed card here would just repeat
      // "read <path>". Recognise the envelope structurally and render nothing;
      // the workspace.read line is the canonical row for a file read.
      if (isFileReadResult(result)) {
        return artifacts.length > 0 ? (
          <ArtifactHint artifacts={artifacts} paddingLeft={childPad} />
        ) : null;
      }
      // A sub-agent tool (delegate_* / spawn_agent) returns a structured
      // envelope { childRunId, signal, stopReason, message, usage, … }. Dumping
      // it via oneLine floods the transcript with raw JSON (spanId, token
      // counts, promotionHint). The only part worth committing is the child's
      // own answer (`message`); the `subagent.completed` line already marked the
      // run done, and the rest stays inspectable via /events.
      if (isAgentToolResult(result)) {
        const message = str(rec(result).message).trim();
        if (!message) return null;
        return (
          <Box flexDirection="column" paddingLeft={childPad} paddingRight={1}>
            <Markdown text={message} />
            {artifacts.length > 0 ? (
              <ArtifactHint artifacts={artifacts} paddingLeft={0} />
            ) : null}
          </Box>
        );
      }
      // A `skill_load` result carries the whole skill body in `content`, which
      // oneLine would truncate to a meaningless ~200-char JSON stub (hiding the
      // one fact that matters: did the body actually come back?). Render a
      // proof-of-load summary — status + body length + resource count — and
      // leave the full envelope inspectable via /events.
      if (isSkillLoadResult(result)) {
        const r = rec(result);
        if (r.status === "not_found") {
          const avail = Array.isArray(r.availableSkills)
            ? r.availableSkills.join(", ")
            : "";
          return (
            <Box paddingLeft={childPad} paddingRight={1}>
              <Text color={theme.error}>
                {`skill_load ${str(r.requestedName)} → not found`}
              </Text>
              {avail ? <Text dimColor>{"  available: " + avail}</Text> : null}
            </Box>
          );
        }
        const bodyChars = str(r.content).length;
        const resources = Array.isArray(r.resourceFiles)
          ? r.resourceFiles.length
          : 0;
        const version = str(r.version);
        return (
          <Box paddingLeft={childPad} paddingRight={1}>
            <Text color={theme.success}>
              {`skill_load ${str(r.name)} → loaded`}
            </Text>
            <Text dimColor>
              {`  body ${bodyChars} chars · ${resources} resource file${
                resources === 1 ? "" : "s"
              }${version ? " · v" + version : ""}`}
            </Text>
          </Box>
        );
      }
      // A `list_dir` result carries an `entries` array that oneLine would dump
      // as truncated JSON (`{"path":".","entries":[{"path":"dist",…`). Render a
      // compact "N entries + names" summary instead; the full listing stays
      // inspectable via /events.
      if (isListDirResult(result)) {
        const { head, detail } = summarizeListDir(result);
        return (
          <Box flexDirection="column" paddingLeft={childPad} paddingRight={1}>
            <Text color={theme.muted}>{head}</Text>
            {detail ? <Text dimColor>{"  " + detail}</Text> : null}
            {artifacts.length > 0 ? (
              <ArtifactHint artifacts={artifacts} paddingLeft={0} />
            ) : null}
          </Box>
        );
      }
      // Tool output (shell stdout especially) is the most likely carrier of
      // raw escape sequences — strip them so a `clear`/cursor-move in stdout
      // can't scramble the transcript.
      const text = sanitizeAnsiForRender(
        typeof result === "string" ? result : oneLine(result, 200),
      );
      const lines = text.split("\n").slice(0, 6);
      const truncated = text.split("\n").length > 6;
      return (
        <Box flexDirection="column" paddingLeft={childPad} paddingRight={1}>
          {lines.map((l, i) => (
            <Text key={i} dimColor>
              {"  " + l}
            </Text>
          ))}
          {truncated ? <Text dimColor>{"  …"}</Text> : null}
          {artifacts.length > 0 ? (
            <ArtifactHint artifacts={artifacts} paddingLeft={0} />
          ) : null}
        </Box>
      );
    }

    case "tool.failed": {
      // `tool.failed` usually omits toolName (the name lives on the paired
      // `tool.requested`, correlated by toolCallId, which the committed
      // renderer doesn't track) — fall back to "tool". The doom-loop repeat
      // nudge does carry toolName so its skip can be named.
      const name = str(p.toolName) || "tool";
      const errObj = rec(p.error);
      // A skipped repeated call isn't a real execution failure — it's the
      // anti-thrashing nudge. Render it as a compact "skipped" line rather
      // than dumping the full corrective message as an error.
      if (str(errObj.code) === "REPEATED_TOOL_CALL_SKIPPED") {
        return (
          <Box paddingLeft={childPad} paddingRight={1}>
            <Text color={theme.warning}>{`⤳ ${name} skipped`}</Text>
            <Text dimColor>{"  repeated call · no new information"}</Text>
          </Box>
        );
      }
      const err = sanitizeAnsiForRender(
        str(errObj.message) || oneLine(p.error, 120),
      );
      return (
        <Box paddingLeft={childPad} paddingRight={1}>
          <Text color={theme.error}>✗ {name} failed</Text>
          {err ? <Text dimColor>{"  " + err}</Text> : null}
        </Box>
      );
    }

    case "workspace.write.applied":
    case "workspace.write.completed": {
      const path = str(p.path) || "?";
      const diff = str(p.diff);
      return (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text>
            <Text color={theme.accent2}>✎ write </Text>
            <Text bold>{path}</Text>
          </Text>
          {diff ? <CompactDiff diff={diff} /> : null}
        </Box>
      );
    }

    case "workspace.write.denied": {
      const path = str(p.path) || "?";
      const reason = str(p.reason);
      return (
        <Box paddingX={1}>
          <Text color={theme.error}>🚫 write denied </Text>
          <Text bold>{path}</Text>
          {reason ? <Text dimColor>{"  " + reason}</Text> : null}
        </Box>
      );
    }

    case "approval.resolved": {
      const decision = str(p.decision) || "?";
      return (
        <Box paddingX={1}>
          <Text color={decision === "approved" ? theme.success : theme.warning}>
            approval {decision}
          </Text>
        </Box>
      );
    }

    case "skill.loaded": {
      const name = str(p.name) || "skill";
      const meta = rec(ev.metadata);
      const reason = str(meta.selectionReason) || str(p.selectionReason);
      return (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.accent}>skill </Text>
          <Text bold>{name}</Text>
          <Text color={theme.muted}> loaded</Text>
          {reason ? <Text color={theme.muted}> · {reason}</Text> : null}
        </Box>
      );
    }

    case "mcp.server.prepared": {
      const name = str(p.name) || str(p.serverName) || "mcp";
      const status = str(p.status) || "prepared";
      const errorCode = str(p.errorCode);
      const errorPhase = str(p.errorPhase);
      const error = rec(p.error);
      const errorMessage = str(error?.message);
      const toolCount =
        typeof p.toolCount === "number"
          ? p.toolCount
          : Array.isArray(p.toolNames)
            ? p.toolNames.length
            : undefined;
      return (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.accent}>mcp </Text>
          <Text bold>{name}</Text>
          <Text color={theme.muted}> {status}</Text>
          {toolCount !== undefined ? (
            <Text color={theme.muted}>
              {" "}
              · {toolCount} tool{toolCount === 1 ? "" : "s"}
            </Text>
          ) : null}
          {errorCode ? (
            <Text color={theme.error}>
              {" "}
              · {errorCode}
              {errorPhase ? ` (${errorPhase})` : ""}
            </Text>
          ) : null}
          {errorMessage ? (
            <Text color={theme.muted}> · {errorMessage}</Text>
          ) : null}
        </Box>
      );
    }

    case "agent.profile.derived": {
      const parent = str(p.parentAgentId);
      const child = str(p.childAgentId) || str(p.agentId) || "agent";
      const count =
        typeof p.effectiveToolCount === "number"
          ? p.effectiveToolCount
          : undefined;
      return (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.accent2}>agent </Text>
          {parent ? (
            <>
              <Text>{parent}</Text>
              <Text color={theme.muted}> → </Text>
            </>
          ) : null}
          <Text bold>{child}</Text>
          <Text color={theme.muted}> profile</Text>
          {count !== undefined ? (
            <Text color={theme.muted}>
              {" "}
              · {count} tool{count === 1 ? "" : "s"}
            </Text>
          ) : null}
        </Box>
      );
    }

    case "subagent.requested":
    case "subagent.started":
    case "subagent.completed":
    case "subagent.failed": {
      const phase = ev.type.slice("subagent.".length);
      const meta = rec(ev.metadata);
      const name =
        str(meta.agentName) ||
        str(p.agentName) ||
        str(meta.agentProfileId) ||
        str(p.childRunId) ||
        "subagent";
      // The goal doesn't change across phases, so showing it on started AND
      // completed just reprints the same sentence twice more. Introduce it once
      // on `requested`; later phases carry only their own news (the stop reason).
      const goal = phase === "requested" ? str(p.goal) : "";
      const reason = str(p.reason) || str(p.stopReason);
      const color = phase === "failed" ? theme.error : theme.accent2;
      return (
        <Box paddingX={1} marginTop={phase === "requested" ? 1 : 0}>
          <Text color={color}>subagent </Text>
          <Text bold>{name}</Text>
          <Text color={theme.muted}> {phase}</Text>
          {goal ? <Text color={theme.muted}> · {goal}</Text> : null}
          {reason ? <Text color={theme.muted}> · {reason}</Text> : null}
        </Box>
      );
    }

    case "run.completed": {
      // `final_answer` is the normal happy path — the assistant card above
      // already ended the turn, so show only a subtle separator. Surface the
      // reason text just for the unusual stops (budget, cancelled, etc.).
      const state = str(p.state);
      const reason = str(p.reason) || str(p.stopReason);
      if (state === "failed") {
        const err =
          str(p.message) ||
          str(rec(p.failure).message) ||
          str(rec(p.error).message) ||
          reason ||
          "run failed";
        return (
          <Box paddingX={1} marginTop={1}>
            <Text color={theme.error}>── run failed: {err}</Text>
          </Box>
        );
      }
      if (state === "cancelled") {
        return (
          <Box paddingX={1} marginTop={1}>
            <Text color={theme.error}>
              ── run cancelled: {reason || "cancelled"}
            </Text>
          </Box>
        );
      }
      const displayReason = reason || "completed";
      const isFinal = displayReason === "final_answer";
      return (
        <Box paddingX={1} marginTop={1}>
          <Text dimColor>{isFinal ? "─────" : `── run ${displayReason}`}</Text>
        </Box>
      );
    }

    case "run.failed": {
      // The payload exposes the failure as `message` (with `failure.message` /
      // `reason` as fallbacks); there is no top-level `error` field, so reading
      // `p.error` yielded undefined and crashed oneLine. Pull from the shapes
      // that actually exist and never hand oneLine an undefined.
      const err =
        str(p.message) ||
        str(rec(p.failure).message) ||
        str(rec(p.error).message) ||
        str(p.reason) ||
        "run failed";
      return (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.error}>── run failed: {err}</Text>
        </Box>
      );
    }

    // Intermediate / low-signal scaffolding: hidden so the transcript reads
    // as a conversation. (Full payloads are still inspectable via /events.)
    // Context-management scaffolding and span brackets are also hidden for the
    // same reason: users should see the conversation, not the machinery.
    // The cancel/state-machine plumbing (run.cancelled / run.cancel_requested /
    // run.state_transition.rejected) is hidden too: the user-facing cancel is
    // surfaced by the run.completed (state=cancelled) card and the "cancelling…"
    // toast, so these would otherwise leak as raw "[seq] type" debug rows.
    case "run.started":
    case "run.created":
    case "run.cancelled":
    case "run.cancel_requested":
    case "run.state_transition.rejected":
    case "context.assembled":
    case "context.cache_break.detected":
    case "context.compaction_requested":
    case "context.compaction.started":
    case "context.compaction.completed":
    case "context.compaction.failed":
    case "skill.indexed":
    case "prompt.built":
    case "model.turn.started":
    case "model.turn.completed":
    case "model.requested":
    case "model.retrying":
    case "model.stream.failed":
    case "model.stream.started":
    case "model.stream.chunk":
    case "model.stream.completed":
    case "tool.batch.completed":
    case "tool.started":
    case "tool.progress":
    case "workspace.write.requested":
    case "approval.requested":
    case "interaction.requested":
    case "interaction.resolved":
    case "usage.updated":
      return null;

    default: {
      const f = formatEvent(ev);
      return (
        <Box paddingX={1}>
          <Text dimColor>[{String(ev.sequence).padStart(3, " ")}] </Text>
          <Text color={f.color}>{f.label}</Text>
          {f.detail ? (
            <>
              <Text> </Text>
              <Text dimColor>{f.detail}</Text>
            </>
          ) : null}
        </Box>
      );
    }
  }
}

/** Compact, non-scrolling diff for committed scrollback (capped rows). */
function CompactDiff(props: { diff: string }): React.ReactElement {
  const theme = useTheme();
  const parsed = parseUnifiedDiff(props.diff);
  const rows = parsed.lines.filter(
    (l) => l.kind !== "header" && l.kind !== "meta",
  );
  const MAX = 40;
  const shown = rows.slice(0, MAX);
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.diffAdded}>+{parsed.additions}</Text>
        <Text dimColor> / </Text>
        <Text color={theme.diffRemoved}>-{parsed.deletions}</Text>
      </Text>
      {shown.map((line, i) => {
        const color =
          line.kind === "add"
            ? theme.diffAdded
            : line.kind === "del"
              ? theme.diffRemoved
              : line.kind === "hunk"
                ? theme.diffHunk
                : theme.muted;
        return (
          <Text key={i} color={color} dimColor={line.kind === "hunk"}>
            {line.text || " "}
          </Text>
        );
      })}
      {rows.length > MAX ? (
        <Text dimColor> … {rows.length - MAX} more lines</Text>
      ) : null}
    </Box>
  );
}

function ArtifactHint(props: {
  artifacts: unknown[];
  paddingLeft: number;
}): React.ReactElement | null {
  if (props.artifacts.length === 0) return null;
  const labels = props.artifacts.slice(0, 3).map((artifact) => {
    const r = rec(artifact);
    const id = str(r.id) || "artifact";
    const name = str(r.name) || str(r.type) || "artifact";
    return `${name}:${id}`;
  });
  const overflow = props.artifacts.length - labels.length;
  return (
    <Box paddingLeft={props.paddingLeft}>
      <Text dimColor>
        {"  full output saved "}
        {labels.join(", ")}
        {overflow > 0 ? ` +${overflow} more` : ""}
      </Text>
    </Box>
  );
}

/**
 * Recognise a `read_file` result envelope by its shape: a record carrying a
 * string `path`, a string `content`, and numeric `totalLines`/`bytes`. The
 * committed renderer has no toolCallId correlation, so this structural check is
 * how `tool.completed` knows a result is a file read (and can suppress its card
 * in favour of the `workspace.read` line). Returns true for a file-read result.
 */
export function isFileReadResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r.path === "string" &&
    typeof r.content === "string" &&
    typeof r.totalLines === "number" &&
    typeof r.bytes === "number"
  );
}

/**
 * Recognise a sub-agent tool result envelope by its shape: a record carrying a
 * string `childRunId`, a string `signal`, and a `stopReason`. Both the stable
 * delegate tool (`AgentToolResult`) and the dynamic `spawn_agent` output share
 * this core. The committed renderer has no toolCallId correlation, so this
 * structural check is how `tool.completed` knows to surface only the child's
 * `message` instead of dumping the whole envelope as JSON. Returns true for a
 * sub-agent result.
 */
export function isAgentToolResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r.childRunId === "string" &&
    typeof r.signal === "string" &&
    "stopReason" in r
  );
}

/**
 * Recognise a `skill_load` tool result by its shape: a record with a string
 * `status` that is either a loaded skill (`name` + string `content` body) or a
 * `not_found` miss (`requestedName`). The committed renderer has no toolCallId
 * correlation, so this structural check is how `tool.completed` knows to render
 * a proof-of-load summary instead of dumping/truncating the body-bearing
 * envelope as JSON. Returns true for a skill_load result.
 */
export function isSkillLoadResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if (r.status === "loaded") {
    return typeof r.name === "string" && typeof r.content === "string";
  }
  return r.status === "not_found" && typeof r.requestedName === "string";
}

/**
 * Recognise a `list_dir` tool result by its shape: a record with a string `path`
 * and an `entries` array of `{ name, type }`. Like read_file/skill_load, the
 * committed renderer has no toolCallId correlation, so this structural check is
 * how `tool.completed` knows to render a compact directory summary instead of
 * dumping the entries array as truncated JSON. Returns true for a list_dir result.
 */
export function isListDirResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if (typeof r.path !== "string" || !Array.isArray(r.entries)) return false;
  return r.entries.every(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as Record<string, unknown>).name === "string" &&
      typeof (e as Record<string, unknown>).type === "string",
  );
}

/**
 * Compact one-or-two-line summary of a `list_dir` result: a count headline plus
 * a sample of entry names (directories suffixed with `/`), capped so a large
 * directory can't flood the transcript. Pure for testing.
 */
export function summarizeListDir(
  value: unknown,
  maxNames = 8,
): { head: string; detail: string } {
  const r = value as { path?: unknown; entries?: unknown };
  const path = typeof r.path === "string" && r.path ? r.path : ".";
  const entries = Array.isArray(r.entries) ? r.entries : [];
  const head = `list_dir ${path} → ${entries.length} ${
    entries.length === 1 ? "entry" : "entries"
  }`;
  const names = entries.slice(0, maxNames).map((e) => {
    const rec = e as Record<string, unknown>;
    const name = String(rec.name ?? "");
    return rec.type === "directory" ? `${name}/` : name;
  });
  const more = entries.length - names.length;
  const detail = names.join(" · ") + (more > 0 ? ` · +${more} more` : "");
  return { head, detail };
}

/** Best-effort one-line preview of a value (object → compact JSON). */
export function oneLine(value: unknown, max: number): string {
  let s: string;
  if (typeof value === "string") s = value;
  else if (value === undefined || value === null) s = "";
  else {
    try {
      // JSON.stringify returns undefined for undefined/functions/symbols, so
      // fall back to String() to guarantee a string (the .replace below would
      // otherwise throw on undefined).
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
  }
  // Strip raw escape/control sequences (a tool arg can echo terminal codes)
  // before folding so a preview can't carry cursor moves or OSC sets.
  s = sanitizeAnsiForRender(s);
  // JSON.stringify renders newlines/tabs inside strings as the two literal
  // characters `\n` / `\t`, which the whitespace collapse below would miss —
  // fold those escape sequences to a space first so previews stay one line.
  s = s
    .replace(/\\[nrt]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
