import React from "react";
import { Box, Static, Text, useStdout } from "ink";
import { runFailureMessage } from "@sparkwright/protocol";
import { isInternalTranscriptEvent, type RunEvent } from "../lib/event-type.js";
import { formatEvent } from "../lib/format-event.js";
import { parseUnifiedDiff } from "../lib/diff.js";
import { sanitizeAnsiForRender } from "../lib/text.js";
import { Markdown } from "./markdown.js";
import { useTheme } from "../lib/theme-context.js";
import { resolveDialogColumns } from "./dialog-frame.js";
import { isShellResult } from "../lib/tool-result-summary.js";
import {
  formatToolRequestPreview,
  oneLine,
  compactMutationPath,
  summarizeToolResultForDisplay,
  type ToolDisplayTone,
  type ToolResultDisplay,
} from "../lib/tool-display.js";
import { middleEllipsisPath } from "../lib/path-display.js";
import { shortTaskId } from "../lib/task-activity.js";

export { oneLine } from "../lib/tool-display.js";

export interface TranscriptHeaderInfo {
  workspaceRoot: string;
  modelLabel: string;
  sessionId: string | null;
}

type Row =
  | { kind: "header"; key: string; header: TranscriptHeaderInfo }
  | {
      kind: "event";
      key: string;
      event: RunEvent;
      inBatch: boolean;
      facts?: RunFactsSnapshot;
    };

interface RunFacts {
  toolCalls: number;
  writePaths: Set<string>;
  approvalsRequested: number;
  approvalsApproved: number;
  approvalsDenied: number;
  shellRequests: string[];
  shellResults: ShellFact[];
}

interface RunFactsSnapshot {
  toolCalls: number;
  changedFiles: number;
  approvalsRequested: number;
  approvalsApproved: number;
  approvalsDenied: number;
  lastShell?: ShellFact;
  commandOutcome?: CommandOutcomeFact;
}

interface ShellFact {
  command?: string;
  exitCode: number | null;
  timedOut: boolean;
}

interface CommandOutcomeFact {
  lastCommand?: string;
  lastExitCode?: number;
  lastTimedOut?: boolean;
  unresolvedVerificationFailures?: number;
}

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
  let facts = createRunFacts();
  const rows: Row[] = [
    { kind: "header", key: "__header", header: props.header },
    ...props.events.map((event): Row => {
      if (event.type === "run.started") facts = createRunFacts();
      // The batch.requested header itself is NOT a member (depth flips after
      // it); the batch.completed closer drops back out before this row.
      if (event.type === "tool.batch.completed" && batchDepth > 0) batchDepth--;
      const inBatch = batchDepth > 0;
      if (event.type === "tool.batch.requested") batchDepth++;
      const row: Row = {
        kind: "event",
        key: event.id ?? `${event.sequence}`,
        event,
        inBatch,
      };
      if (event.type === "run.completed") {
        row.facts = snapshotRunFacts(facts, event);
        facts = createRunFacts();
      } else {
        recordRunFact(facts, event);
      }
      return row;
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
            facts={row.facts}
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
  { event: RunEvent; inBatch: boolean; facts?: RunFactsSnapshot },
  { error: Error | null }
> {
  constructor(props: {
    event: RunEvent;
    inBatch: boolean;
    facts?: RunFactsSnapshot;
  }) {
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
    return (
      <EventCard
        event={this.props.event}
        inBatch={this.props.inBatch}
        facts={this.props.facts}
      />
    );
  }
}

function HeaderRow(props: {
  header: TranscriptHeaderInfo;
}): React.ReactElement {
  const h = props.header;
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 120;
  const cwd = middleEllipsisPath(h.workspaceRoot, Math.max(16, columns - 6));
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Text>
        <Text bold>SparkWright</Text>
        <Text dimColor> · type a goal · /capabilities · /help</Text>
      </Text>
      <Text>
        <Text dimColor>cwd </Text>
        {cwd}
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
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function createRunFacts(): RunFacts {
  return {
    toolCalls: 0,
    writePaths: new Set<string>(),
    approvalsRequested: 0,
    approvalsApproved: 0,
    approvalsDenied: 0,
    shellRequests: [],
    shellResults: [],
  };
}

function recordRunFact(facts: RunFacts, event: RunEvent): void {
  const p = rec(event.payload);
  switch (event.type) {
    case "tool.requested": {
      facts.toolCalls += 1;
      if (isShellToolName(str(p.toolName))) {
        const args = rec(p.arguments ?? p.input ?? p.args);
        const command = str(args.command);
        if (command) facts.shellRequests.push(command);
      }
      return;
    }
    case "tool.completed": {
      const result = p.result ?? p.output;
      if (isShellResult(result)) {
        const r = result as Record<string, unknown>;
        facts.shellResults.push({
          command: facts.shellRequests.shift(),
          exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
          timedOut: r.timedOut === true,
        });
      }
      return;
    }
    case "workspace.write.applied":
    case "workspace.write.completed": {
      const path = str(p.path);
      if (path) facts.writePaths.add(path);
      return;
    }
    case "approval.requested":
      facts.approvalsRequested += 1;
      return;
    case "approval.resolved": {
      const decision = str(p.decision);
      if (decision === "approved") facts.approvalsApproved += 1;
      else if (decision === "denied") facts.approvalsDenied += 1;
      return;
    }
  }
}

function isShellToolName(name: string): boolean {
  return name === "bash" || name === "shell";
}

function snapshotRunFacts(
  facts: RunFacts,
  completed: RunEvent,
): RunFactsSnapshot {
  const p = rec(completed.payload);
  return {
    toolCalls: facts.toolCalls,
    changedFiles: facts.writePaths.size,
    approvalsRequested: facts.approvalsRequested,
    approvalsApproved: facts.approvalsApproved,
    approvalsDenied: facts.approvalsDenied,
    lastShell: facts.shellResults[facts.shellResults.length - 1],
    commandOutcome: commandOutcomeFact(p.commandOutcome),
  };
}

function commandOutcomeFact(value: unknown): CommandOutcomeFact | undefined {
  const r = rec(value);
  if (Object.keys(r).length === 0) return undefined;
  const verification = rec(r.verification);
  const fact: CommandOutcomeFact = {};
  const lastCommand = str(verification.lastCommand);
  if (lastCommand) fact.lastCommand = lastCommand;
  if (typeof verification.lastExitCode === "number") {
    fact.lastExitCode = verification.lastExitCode;
  }
  if (typeof verification.lastTimedOut === "boolean") {
    fact.lastTimedOut = verification.lastTimedOut;
  }
  if (typeof verification.unresolved === "number") {
    fact.unresolvedVerificationFailures = verification.unresolved;
  }
  return Object.keys(fact).length > 0 ? fact : undefined;
}

function runFactsParts(facts: RunFactsSnapshot | undefined): string[] {
  if (!facts) return [];
  const parts: string[] = [];
  if (facts.changedFiles > 0) {
    parts.push(
      `changed ${facts.changedFiles} file${facts.changedFiles === 1 ? "" : "s"}`,
    );
  }
  if (facts.approvalsRequested > 0) {
    const resolved = facts.approvalsApproved + facts.approvalsDenied;
    const suffix =
      facts.approvalsDenied > 0 ? `, ${facts.approvalsDenied} denied` : "";
    parts.push(`approvals ${resolved}/${facts.approvalsRequested}${suffix}`);
  }
  if (facts.toolCalls > 0) {
    parts.push(`tools ${facts.toolCalls}`);
  }
  const command = commandFact(facts);
  if (command) parts.push(command);
  return parts;
}

function commandFact(facts: RunFactsSnapshot): string | undefined {
  const shell = facts.lastShell;
  if (shell?.command) return `last command: ${commandStatus(shell)}`;
  const outcome = facts.commandOutcome;
  if (!outcome?.lastCommand) return undefined;
  return `last command: ${commandStatus({
    command: outcome.lastCommand,
    exitCode:
      typeof outcome.lastExitCode === "number" ? outcome.lastExitCode : null,
    timedOut: outcome.lastTimedOut === true,
  })}`;
}

function commandStatus(fact: ShellFact): string {
  const command = fact.command ?? "shell";
  if (fact.timedOut) return `${command} timed out`;
  if (fact.exitCode === 0) return `${command} passed`;
  if (typeof fact.exitCode === "number") return `${command} failed`;
  return `${command} completed`;
}

function shortRunId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function RunFactsLine(props: {
  facts: RunFactsSnapshot | undefined;
}): React.ReactElement | null {
  const parts = runFactsParts(props.facts);
  if (parts.length === 0) return null;
  return <Text dimColor>run facts {parts.join(" · ")}</Text>;
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
  facts?: RunFactsSnapshot;
}): React.ReactElement | null {
  const theme = useTheme();
  const { stdout } = useStdout();
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

    case "tui.export.completed": {
      const path = str(p.path).trim();
      if (!path) return null;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box paddingX={1}>
            <Text color={theme.success}>transcript exported</Text>
          </Box>
          <Text>{path}</Text>
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

    case "workspace.anchored_read": {
      const path = str(p.path) || "?";
      const lineCount =
        typeof p.lineCount === "number" ? ` · ${p.lineCount} lines` : "";
      return (
        <Box paddingLeft={childPad} paddingRight={1}>
          <Text color={theme.muted}>{"read anchors "}</Text>
          <Text dimColor>
            {path}
            {lineCount}
          </Text>
        </Box>
      );
    }

    case "tool.requested": {
      const name = str(p.toolName) || "tool";
      const args = p.arguments ?? p.input ?? p.args;
      const cols = resolveDialogColumns(stdout?.columns) ?? 120;
      const marker = inBatch ? "› " : "⚙ ";
      const nameBudget = Math.max(8, Math.min(24, cols - childPad - 4));
      const visibleName = truncatePlain(name, nameBudget);
      const previewBudget = Math.max(
        0,
        cols - childPad - marker.length - visibleName.length - 4,
      );
      const eventPreview = str(p.preview);
      const preview = eventPreview
        ? oneLine(eventPreview, previewBudget)
        : formatToolRequestPreview(name, args, previewBudget);
      return (
        <Box
          paddingLeft={childPad}
          paddingRight={1}
          marginTop={inBatch ? 0 : 1}
        >
          <Text>
            <Text color={theme.accent} bold>
              {marker}
              {visibleName}
            </Text>
            {preview ? <Text dimColor>{"  " + preview}</Text> : null}
          </Text>
        </Box>
      );
    }

    case "tool.completed": {
      const toolName = str(p.toolName) || undefined;
      const result = p.result ?? p.output;
      const artifacts = Array.isArray(p.artifacts) ? p.artifacts : [];
      if (result === undefined && artifacts.length === 0) return null;
      const display =
        result === undefined
          ? ({ kind: "hidden", reason: "no_result" } as const)
          : summarizeToolResultForDisplay({
              toolName,
              result,
              mode: "live",
            });
      if (display.kind === "hidden") {
        return artifacts.length > 0 ? (
          <ArtifactHint artifacts={artifacts} paddingLeft={childPad} />
        ) : null;
      }
      return (
        <ToolResultDisplayBlock
          display={display}
          artifacts={artifacts}
          paddingLeft={childPad}
        />
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

    case "task.created":
    case "task.started":
    case "task.completed":
    case "task.failed":
    case "task.cancelled": {
      return (
        <TaskLifecycleLine
          event={ev}
          paddingLeft={childPad}
          inBatch={inBatch}
        />
      );
    }

    case "task.output":
      return null;

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

    case "workspace.write.untracked_access_granted": {
      const taskId = str(p.taskId);
      const protocol = str(p.protocol);
      const command = str(p.command);
      if (
        protocol !== "background_shell" &&
        protocol !== "promoted_shell" &&
        !taskId
      ) {
        return null;
      }
      return (
        <Box paddingLeft={childPad} paddingRight={1}>
          <Text color={theme.warning}>untracked writes possible</Text>
          {taskId ? (
            <Text
              dimColor
            >{` · ${shortTaskId(taskId)} · ctrl+o activity`}</Text>
          ) : null}
          {command ? (
            <Text dimColor>{` · ${truncatePlain(command, 80)}`}</Text>
          ) : null}
        </Box>
      );
    }

    case "capability.mutation.completed": {
      const action = str(p.action) || "mutation";
      const path = compactMutationPath(str(p.path));
      const reason = str(p.reason);
      const fileCount =
        typeof p.fileCount === "number" ? ` · ${p.fileCount} files` : "";
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text>
            <Text color={theme.warning}>◇ capability mutation </Text>
            <Text bold>{action}</Text>
            {path ? <Text dimColor>{" " + path}</Text> : null}
            {fileCount ? <Text dimColor>{fileCount}</Text> : null}
          </Text>
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
      const depth = optionalNumber(meta.subagentDepth) ?? 0;
      const name =
        str(meta.agentName) ||
        str(p.agentName) ||
        str(meta.childAgentId) ||
        str(meta.agentProfileId) ||
        str(meta.agentId) ||
        str(p.childRunId) ||
        "subagent";
      const childRunId = str(meta.childRunId) || str(p.childRunId);
      const parentRunId = str(meta.parentRunId) || str(p.parentRunId);
      const entrypoint = str(meta.entrypoint);
      const delegateTool = str(meta.delegateTool);
      const terminalState = str(p.terminalState);
      const lifecycle = terminalState || str(p.reason) || str(p.stopReason);
      // The goal doesn't change across phases, so showing it on started AND
      // completed just reprints the same sentence twice more. Introduce it once
      // on `requested`; later phases carry only their own news (the stop reason).
      const goal = phase === "requested" ? str(p.goal) : "";
      const color = phase === "failed" ? theme.error : theme.accent2;
      const branch = depth > 0 ? "└─ " : "agent ";
      const details = [
        `depth ${depth}`,
        entrypoint,
        delegateTool ? `via ${delegateTool}` : undefined,
        childRunId ? `child ${shortRunId(childRunId)}` : undefined,
        parentRunId ? `parent ${shortRunId(parentRunId)}` : undefined,
      ].filter((value): value is string => typeof value === "string");
      return (
        <Box
          paddingLeft={1 + depth * 2}
          paddingRight={1}
          marginTop={phase === "requested" ? 1 : 0}
        >
          <Text color={color}>{branch}</Text>
          <Text bold>{name}</Text>
          <Text color={theme.muted}> {phase}</Text>
          {lifecycle ? <Text color={theme.muted}> · {lifecycle}</Text> : null}
          {details.length > 0 ? (
            <Text color={theme.muted}> · {details.join(" · ")}</Text>
          ) : null}
          {goal ? <Text color={theme.muted}> · {goal}</Text> : null}
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
        const err = runFailureMessage(p, reason || "run failed");
        return (
          <Box flexDirection="column" paddingX={1} marginTop={1}>
            <Text color={theme.error}>── run failed: {err}</Text>
            <RunFactsLine facts={props.facts} />
          </Box>
        );
      }
      if (state === "cancelled") {
        return (
          <Box flexDirection="column" paddingX={1} marginTop={1}>
            <Text color={theme.error}>
              ── run cancelled: {reason || "cancelled"}
            </Text>
            <RunFactsLine facts={props.facts} />
          </Box>
        );
      }
      const displayReason = reason || "completed";
      const isFinal = displayReason === "final_answer";
      return (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text dimColor>{isFinal ? "─────" : `── run ${displayReason}`}</Text>
          <RunFactsLine facts={props.facts} />
        </Box>
      );
    }

    case "run.failed": {
      const err = runFailureMessage(p);
      return (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.error}>── run failed: {err}</Text>
        </Box>
      );
    }

    default: {
      if (isInternalTranscriptEvent(ev.type)) return null;
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

function TaskLifecycleLine(props: {
  event: RunEvent;
  paddingLeft: number;
  inBatch: boolean;
}): React.ReactElement | null {
  const theme = useTheme();
  const ev = props.event;
  const p = rec(ev.payload);
  const taskId = str(p.taskId) || str(p.id);
  if (!taskId) return null;
  const phase = ev.type.slice("task.".length);
  const result = rec(p.result);
  const meta = rec(ev.metadata);
  const kind = str(p.kind);
  const command = str(p.command) || str(result.command);
  const title = str(p.title);
  const exitCode =
    typeof result.exitCode === "number"
      ? result.exitCode
      : typeof p.exitCode === "number"
        ? p.exitCode
        : undefined;
  const chunks =
    typeof p.progressCount === "number"
      ? p.progressCount
      : typeof p.outputChunks === "number"
        ? p.outputChunks
        : undefined;
  const duration =
    typeof meta.durationMs === "number"
      ? formatShortDuration(meta.durationMs)
      : "";
  const status =
    phase === "started"
      ? "started"
      : phase === "created"
        ? "queued"
        : phase === "completed"
          ? "completed"
          : phase;
  const color =
    phase === "failed" || phase === "cancelled"
      ? theme.error
      : phase === "completed"
        ? theme.success
        : theme.accent;
  const details = [
    shortTaskId(taskId),
    kind,
    typeof exitCode === "number" ? `exit ${exitCode}` : undefined,
    chunks !== undefined
      ? `${chunks} chunk${chunks === 1 ? "" : "s"}`
      : undefined,
    duration,
    phase === "started" || phase === "created" ? "ctrl+o activity" : undefined,
  ].filter((value): value is string => Boolean(value));
  const label =
    phase === "started" || phase === "created" ? "background task" : "task";
  const summary = command || title;
  return (
    <Box
      flexDirection="column"
      paddingLeft={props.paddingLeft}
      paddingRight={1}
      marginTop={props.inBatch ? 0 : 1}
    >
      <Text color={color}>
        {label} {status}
        {details.length > 0 ? (
          <Text dimColor> · {details.join(" · ")}</Text>
        ) : null}
      </Text>
      {summary ? (
        <Text dimColor>{"  " + truncatePlain(summary, 120)}</Text>
      ) : null}
    </Box>
  );
}

function formatShortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
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

function ToolResultDisplayBlock(props: {
  display: Exclude<ToolResultDisplay, { kind: "hidden" }>;
  artifacts: unknown[];
  paddingLeft: number;
}): React.ReactElement {
  const theme = useTheme();
  if (props.display.kind === "markdown") {
    return (
      <Box
        flexDirection="column"
        paddingLeft={props.paddingLeft}
        paddingRight={1}
      >
        <Markdown text={props.display.text} />
        {props.display.details.map((line, i) => (
          <Text key={i} dimColor>
            {"  " + line}
          </Text>
        ))}
        {props.artifacts.length > 0 ? (
          <ArtifactHint artifacts={props.artifacts} paddingLeft={0} />
        ) : null}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      paddingLeft={props.paddingLeft}
      paddingRight={1}
    >
      {props.display.head ? (
        <Text color={toolToneColor(props.display.tone, theme)}>
          {props.display.head}
        </Text>
      ) : null}
      {props.display.details.map((line, i) => (
        <Text key={i} dimColor>
          {"  " + line}
        </Text>
      ))}
      {props.artifacts.length > 0 ? (
        <ArtifactHint artifacts={props.artifacts} paddingLeft={0} />
      ) : null}
    </Box>
  );
}

function toolToneColor(
  tone: ToolDisplayTone,
  theme: ReturnType<typeof useTheme>,
): string | undefined {
  if (tone === "success") return theme.success;
  if (tone === "warning") return theme.warning;
  if (tone === "error") return theme.error;
  if (tone === "muted") return theme.muted;
  return undefined;
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

function truncatePlain(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;
}
