import type { TodoPanelItem } from "../state/event-store.js";
import type { RunEvent } from "./event-type.js";
import type { AgentActionSummary } from "@sparkwright/agent-runtime";
import {
  formatToolRequestPreview,
  oneLine,
  summarizeToolResultForDisplay,
  type ToolDisplayTone,
} from "./tool-display.js";
import { isAgentToolResult } from "./tool-result-summary.js";

export type TranscriptMode = "compact" | "detailed";

export type PresentationLevel = "primary" | "detail" | "diagnostic";

export type TranscriptBlockKind =
  | "user"
  | "assistant"
  | "agent"
  | "tool"
  | "todo"
  | "approval"
  | "failure"
  | "notice";

export interface TranscriptDetailSection {
  label: string;
  lines: string[];
  tone?: ToolDisplayTone;
}

export interface TranscriptBlock {
  key: string;
  kind: TranscriptBlockKind;
  level: Exclude<PresentationLevel, "diagnostic">;
  sequence: number;
  indent: number;
  summary: string;
  tone: ToolDisplayTone;
  sections: TranscriptDetailSection[];
}

export interface TranscriptLine {
  key: string;
  text: string;
  tone: ToolDisplayTone;
  bold?: boolean;
}

export interface DetailedTranscriptProjection {
  scope: "current run" | "latest run";
  blocks: TranscriptBlock[];
  lines: TranscriptLine[];
  truncated: boolean;
}

export type AgentDisplayStatus =
  "queued" | "running" | "completed" | "partial" | "blocked" | "failed";

export interface AgentPresentation {
  key: string;
  childRunId?: string;
  parentRunId?: string;
  name: string;
  depth: number;
  task?: string;
  status: AgentDisplayStatus;
  summary?: string;
  blockerCodes: string[];
  blockerLines: string[];
  errorCode?: string;
  actionCount?: number;
  actions: AgentActionSummary[];
  workspaceWrites?: number;
  requestedAt?: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  firstSequence: number;
}

interface ToolPresentation {
  key: string;
  firstSequence: number;
  runId?: string;
  name: string;
  args?: unknown;
  preview?: string;
  result?: unknown;
  failed?: boolean;
  error?: string;
  errorCode?: string;
}

const MAX_DETAIL_LINES = 2_000;
const MAX_SECTION_LINES = 120;
const MAX_LINE_CHARS = 320;
const AGENT_TOOL_NAMES = new Set([
  "spawn_agent",
  "delegate_agent",
  "delegate_parallel",
  "delegates_run",
  "agent_task",
]);

export function isAgentOrchestrationToolName(name: string): boolean {
  return AGENT_TOOL_NAMES.has(name) || name.startsWith("delegate_");
}

/**
 * Pre-compute Agent tool-call ids for replay/bulk rendering. During a live
 * append the well-known tool name is enough to suppress the request; the id
 * pass also recognises custom delegate tools once their structured result is
 * available.
 */
export function collectAgentToolCallIds(
  events: readonly RunEvent[],
): Set<string> {
  const ids = new Set<string>();
  const requestNames = new Map<string, string>();
  for (const event of events) {
    const payload = rec(event.payload);
    if (event.type === "tool.requested") {
      const id = toolRequestId(payload);
      const name = str(payload.toolName);
      if (id) requestNames.set(id, name);
      if (id && isAgentOrchestrationToolName(name)) ids.add(id);
      continue;
    }
    if (event.type !== "tool.completed") continue;
    const id = toolCompletionId(payload);
    const name = str(payload.toolName) || requestNames.get(id) || "";
    const result = payload.result ?? payload.output;
    if (
      id &&
      (isAgentOrchestrationToolName(name) ||
        isAgentToolResult(result) ||
        Boolean(str(rec(result).childRunId)))
    ) {
      ids.add(id);
    }
  }
  return ids;
}

export function collectChildRunIds(events: readonly RunEvent[]): Set<string> {
  const childRunIds = new Set<string>();
  for (const event of events) {
    if (!event.type.startsWith("subagent.")) continue;
    const payload = rec(event.payload);
    const metadata = rec(event.metadata);
    const childRunId = str(payload.childRunId) || str(metadata.childRunId);
    if (childRunId) childRunIds.add(childRunId);
  }
  return childRunIds;
}

export function shouldShowInCompactTranscript(
  event: RunEvent,
  agentToolCallIds: ReadonlySet<string>,
  childRunIds: ReadonlySet<string> = new Set(),
): boolean {
  const payload = rec(event.payload);
  if (event.runId && childRunIds.has(event.runId)) {
    // Replayed traces contain child-run events that are not streamed into the
    // live parent transcript. Keep child failures/approvals visible, but fold
    // successful child work and the child's full final answer under its Agent
    // block in the detailed projection.
    return isChildCompactException(event, payload);
  }
  if (
    event.type === "subagent.requested" ||
    event.type === "subagent.started"
  ) {
    return false;
  }
  if (event.type === "tool.requested") {
    const name = str(payload.toolName);
    const id = toolRequestId(payload);
    return !isAgentOrchestrationToolName(name) && !agentToolCallIds.has(id);
  }
  if (event.type === "tool.completed") {
    const name = str(payload.toolName);
    const id = toolCompletionId(payload);
    const result = payload.result ?? payload.output;
    return (
      !isAgentOrchestrationToolName(name) &&
      !agentToolCallIds.has(id) &&
      !isAgentToolResult(result)
    );
  }
  // Failures, approvals, safety signals, and all other conversation-worthy
  // events are intentionally never suppressed here.
  return true;
}

export function collectAgentPresentations(
  events: readonly RunEvent[],
): Map<string, AgentPresentation> {
  const agents = new Map<string, AgentPresentation>();
  for (const event of events) {
    if (!event.type.startsWith("subagent.")) continue;
    const payload = rec(event.payload);
    const metadata = rec(event.metadata);
    const key = agentIdentity(event);
    const previous = agents.get(key);
    const timestamp = eventTimestamp(event);
    const phase = event.type.slice("subagent.".length);
    const semanticStatus = str(payload.status);
    const assessment = rec(payload.assessment);
    const assessmentHealth = str(assessment.health);
    const terminalState = str(payload.terminalState);
    const status: AgentDisplayStatus =
      semanticStatus === "blocked" || semanticStatus === "partial"
        ? semanticStatus
        : semanticStatus === "completed"
          ? "completed"
          : phase === "requested"
            ? "queued"
            : phase === "started"
              ? "running"
              : phase === "failed"
                ? "failed"
                : payload.stepLimitReached === true ||
                    assessmentHealth === "failing" ||
                    (terminalState !== "" && terminalState !== "completed")
                  ? "partial"
                  : "completed";
    const blockers = Array.isArray(payload.blockers)
      ? payload.blockers.map(rec)
      : [];
    const assessmentIssues = Array.isArray(assessment.issues)
      ? assessment.issues.map(rec)
      : [];
    const error = rec(payload.error);
    const actions = parseAgentActions(payload.actions);
    const durationMs =
      number(metadata.durationMs) ??
      number(payload.durationMs) ??
      (phase === "completed" || phase === "failed"
        ? elapsedMs(previous?.startedAt ?? previous?.requestedAt, timestamp)
        : undefined);
    agents.set(key, {
      key,
      childRunId:
        str(payload.childRunId) ||
        str(metadata.childRunId) ||
        previous?.childRunId ||
        undefined,
      parentRunId:
        str(payload.parentRunId) ||
        str(metadata.parentRunId) ||
        previous?.parentRunId ||
        undefined,
      name:
        str(metadata.agentName) ||
        str(payload.agentName) ||
        str(metadata.childAgentId) ||
        str(metadata.agentProfileId) ||
        str(metadata.agentId) ||
        previous?.name ||
        str(payload.childRunId) ||
        "agent",
      depth: number(metadata.subagentDepth) ?? previous?.depth ?? 0,
      task: str(payload.goal) || previous?.task || undefined,
      status,
      summary: str(payload.summary) || previous?.summary || undefined,
      blockerCodes: unique([
        ...blockers.map((blocker) => str(blocker.code)),
        ...assessmentIssues.map((issue) => str(issue.code)),
      ]),
      blockerLines: unique(
        blockers
          .map((blocker) =>
            [str(blocker.code), str(blocker.message)]
              .filter(Boolean)
              .join(" · "),
          )
          .filter(Boolean),
      ),
      errorCode:
        str(error.code) ||
        str(payload.errorCode) ||
        previous?.errorCode ||
        undefined,
      actionCount:
        actions.length > 0
          ? actions.length
          : (number(payload.toolCalls) ?? previous?.actionCount ?? undefined),
      actions: actions.length > 0 ? actions : (previous?.actions ?? []),
      workspaceWrites:
        number(payload.workspaceWrites) ?? previous?.workspaceWrites,
      requestedAt: phase === "requested" ? timestamp : previous?.requestedAt,
      startedAt: phase === "started" ? timestamp : previous?.startedAt,
      endedAt:
        phase === "completed" || phase === "failed"
          ? timestamp
          : previous?.endedAt,
      durationMs: durationMs ?? previous?.durationMs,
      firstSequence: previous?.firstSequence ?? event.sequence,
    });
  }
  return agents;
}

export function formatAgentSummary(agent: AgentPresentation): string {
  const suffix = [
    agent.durationMs !== undefined
      ? formatShortDuration(agent.durationMs)
      : undefined,
    agent.actionCount !== undefined
      ? `${agent.actionCount} action${agent.actionCount === 1 ? "" : "s"}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return `└─ Agent · ${agent.name} ${agent.status}${suffix ? ` · ${suffix}` : ""}`;
}

export function agentTone(agent: AgentPresentation): ToolDisplayTone {
  if (agent.status === "failed") return "error";
  if (agent.status === "blocked" || agent.status === "partial")
    return "warning";
  if (agent.status === "completed") return "success";
  return "normal";
}

export function agentCompactFailureDetail(
  agent: AgentPresentation,
): string | undefined {
  if (
    agent.status !== "failed" &&
    agent.status !== "blocked" &&
    agent.status !== "partial"
  ) {
    return undefined;
  }
  return (
    agent.errorCode ||
    agent.blockerCodes[0] ||
    agent.summary ||
    `${agent.status} before completion`
  );
}

export function buildDetailedTranscript(
  allEvents: readonly RunEvent[],
  todoItems: readonly TodoPanelItem[] = [],
): DetailedTranscriptProjection {
  const events = currentOrLatestRunEvents(allEvents);
  const agents = collectAgentPresentations(events);
  const agentByRunId = new Map<string, AgentPresentation>();
  for (const agent of agents.values()) {
    if (agent.childRunId) agentByRunId.set(agent.childRunId, agent);
  }
  const childResults = collectChildResults(events, agentByRunId);
  const tools = collectToolPresentations(events);
  const actionsByAgent = new Map<string, string[]>();
  for (const tool of tools.values()) {
    const agent = tool.runId ? agentByRunId.get(tool.runId) : undefined;
    if (!agent) continue;
    const list = actionsByAgent.get(agent.key) ?? [];
    list.push(formatToolAction(tool));
    actionsByAgent.set(agent.key, list);
  }

  const blocks: TranscriptBlock[] = [];
  const emittedAgents = new Set<string>();
  const emittedTools = new Set<string>();
  let emittedTodo = false;

  for (const event of events) {
    const payload = rec(event.payload);
    if (event.type.startsWith("subagent.")) {
      const key = agentIdentity(event);
      if (emittedAgents.has(key)) continue;
      emittedAgents.add(key);
      const agent = agents.get(key);
      if (!agent) continue;
      blocks.push(
        agentBlock(
          agent,
          actionsByAgent.get(key) ?? [],
          agent.childRunId ? childResults.get(agent.childRunId) : undefined,
        ),
      );
      continue;
    }

    if (
      event.type === "tool.requested" ||
      event.type === "tool.completed" ||
      event.type === "tool.failed"
    ) {
      const key =
        event.type === "tool.requested"
          ? toolRequestId(payload)
          : toolCompletionId(payload);
      const tool = tools.get(key || `event:${event.id ?? event.sequence}`);
      if (!tool || emittedTools.has(tool.key)) continue;
      emittedTools.add(tool.key);
      if (tool.runId && agentByRunId.has(tool.runId)) continue;
      if (isAgentOrchestrationToolName(tool.name)) continue;
      if (tool.name === "todo_write") {
        if (!emittedTodo && todoItems.length > 0) {
          blocks.push(todoBlock(tool.firstSequence, todoItems));
          emittedTodo = true;
        }
        continue;
      }
      blocks.push(toolBlock(tool));
      continue;
    }

    if (event.runId && agentByRunId.has(event.runId)) {
      // Child-run success content is owned by the parent Agent block. Tool
      // lifecycles were already consumed above as Agent actions.
      continue;
    }

    if (event.type === "tui.user") {
      const goal = str(payload.goal).trim();
      if (goal) {
        blocks.push({
          key: eventKey(event),
          kind: "user",
          level: "primary",
          sequence: event.sequence,
          indent: 0,
          summary: `› ${goal}`,
          tone: "normal",
          sections: [],
        });
      }
      continue;
    }

    if (event.type === "model.assistant_text") {
      const message = str(payload.message).trim();
      if (message) blocks.push(assistantBlock(event, message));
      continue;
    }

    if (event.type === "run.completed") {
      const state = str(payload.state);
      if (state === "failed") {
        blocks.push({
          key: eventKey(event),
          kind: "failure",
          level: "primary",
          sequence: event.sequence,
          indent: 0,
          summary: `run failed · ${failureMessage(payload)}`,
          tone: "error",
          sections: [],
        });
      } else {
        const message = str(payload.message).trim();
        if (message) blocks.push(assistantBlock(event, message));
      }
      continue;
    }

    if (event.type === "run.cancelled") {
      blocks.push({
        key: eventKey(event),
        kind: "failure",
        level: "primary",
        sequence: event.sequence,
        indent: 0,
        summary: `run cancelled · ${str(payload.reason) || str(payload.stopReason) || "cancelled"}`,
        tone: "warning",
        sections: [],
      });
      continue;
    }

    if (event.type === "approval.requested") {
      blocks.push({
        key: eventKey(event),
        kind: "approval",
        level: "primary",
        sequence: event.sequence,
        indent: 0,
        summary: `approval requested · ${str(payload.summary) || str(payload.action) || "review required"}`,
        tone: "warning",
        sections: [],
      });
      continue;
    }

    if (event.type === "approval.resolved") {
      const decision = str(payload.decision) || "resolved";
      blocks.push({
        key: eventKey(event),
        kind: "approval",
        level: "primary",
        sequence: event.sequence,
        indent: 0,
        summary: `approval ${decision}`,
        tone: decision === "approved" ? "success" : "warning",
        sections: [],
      });
      continue;
    }

    if (
      event.type === "workspace.write.denied" ||
      event.type === "run.failed"
    ) {
      blocks.push({
        key: eventKey(event),
        kind: "failure",
        level: "primary",
        sequence: event.sequence,
        indent: 0,
        summary:
          event.type === "workspace.write.denied"
            ? `write denied · ${str(payload.path) || "workspace"}`
            : `run failed · ${failureMessage(payload)}`,
        tone: "error",
        sections: [],
      });
      continue;
    }
  }

  if (!emittedTodo && todoItems.length > 0) {
    blocks.push(todoBlock(Number.MAX_SAFE_INTEGER, todoItems));
  }

  const flattened = flattenTranscriptBlocks(blocks);
  const truncated = flattened.length > MAX_DETAIL_LINES;
  const lines = truncated
    ? [
        {
          key: "__truncated",
          text: `… ${flattened.length - MAX_DETAIL_LINES} earlier detail lines omitted …`,
          tone: "warning" as const,
        },
        ...flattened.slice(-MAX_DETAIL_LINES),
      ]
    : flattened;
  return {
    scope: hasOpenRun(events) ? "current run" : "latest run",
    blocks,
    lines,
    truncated,
  };
}

export function flattenTranscriptBlocks(
  blocks: readonly TranscriptBlock[],
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const block of blocks) {
    if (lines.length > 0) {
      lines.push({
        key: `${block.key}:space`,
        text: "",
        tone: "muted",
      });
    }
    const prefix = "  ".repeat(block.indent);
    lines.push({
      key: `${block.key}:summary`,
      text: prefix + block.summary,
      tone: block.tone,
      bold:
        block.kind === "agent" ||
        block.kind === "tool" ||
        block.kind === "assistant",
    });
    block.sections.forEach((section, sectionIndex) => {
      lines.push({
        key: `${block.key}:section:${sectionIndex}`,
        text: `${prefix}   ${section.label}`,
        tone: section.tone ?? "muted",
        bold: true,
      });
      section.lines.slice(0, MAX_SECTION_LINES).forEach((line, lineIndex) => {
        lines.push({
          key: `${block.key}:section:${sectionIndex}:${lineIndex}`,
          text: `${prefix}     ${oneLine(line, MAX_LINE_CHARS)}`,
          tone: section.tone ?? "normal",
        });
      });
      if (section.lines.length > MAX_SECTION_LINES) {
        lines.push({
          key: `${block.key}:section:${sectionIndex}:truncated`,
          text: `${prefix}     … ${section.lines.length - MAX_SECTION_LINES} lines omitted …`,
          tone: "warning",
        });
      }
    });
  }
  return lines;
}

function collectToolPresentations(
  events: readonly RunEvent[],
): Map<string, ToolPresentation> {
  const tools = new Map<string, ToolPresentation>();
  for (const event of events) {
    const payload = rec(event.payload);
    if (event.type === "tool.requested") {
      const key =
        toolRequestId(payload) || `event:${event.id ?? event.sequence}`;
      tools.set(key, {
        key,
        firstSequence: event.sequence,
        runId: runIdForEvent(event),
        name: str(payload.toolName) || "tool",
        args: payload.arguments ?? payload.input ?? payload.args,
        preview: str(payload.preview) || undefined,
      });
      continue;
    }
    if (event.type !== "tool.completed" && event.type !== "tool.failed") {
      continue;
    }
    const key =
      toolCompletionId(payload) || `event:${event.id ?? event.sequence}`;
    const previous = tools.get(key);
    const error = rec(payload.error);
    tools.set(key, {
      key,
      firstSequence: previous?.firstSequence ?? event.sequence,
      runId: previous?.runId ?? runIdForEvent(event),
      name: str(payload.toolName) || previous?.name || "tool",
      args: previous?.args,
      preview: previous?.preview,
      result: payload.result ?? payload.output ?? previous?.result,
      failed: event.type === "tool.failed",
      error:
        str(error.message) ||
        (event.type === "tool.failed"
          ? oneLine(payload.error, 240)
          : undefined),
      errorCode: str(error.code) || undefined,
    });
  }
  return tools;
}

function collectChildResults(
  events: readonly RunEvent[],
  agentByRunId: ReadonlyMap<string, AgentPresentation>,
): Map<string, string> {
  const results = new Map<string, string>();
  for (const event of events) {
    if (
      event.type !== "run.completed" ||
      !event.runId ||
      !agentByRunId.has(event.runId)
    ) {
      continue;
    }
    const message = str(rec(event.payload).message).trim();
    if (message) results.set(event.runId, message);
  }
  return results;
}

function agentBlock(
  agent: AgentPresentation,
  fallbackActions: readonly string[],
  childResult?: string,
): TranscriptBlock {
  const sections: TranscriptDetailSection[] = [];
  if (agent.task) sections.push({ label: "task", lines: [agent.task] });
  const actions =
    agent.actions.length > 0
      ? agent.actions.map(formatAgentActionSummary)
      : fallbackActions;
  if (actions.length > 0) {
    sections.push({ label: "actions", lines: [...actions] });
  }
  if (agent.workspaceWrites !== undefined) {
    sections.push({
      label: "evidence",
      lines: [
        agent.workspaceWrites === 0
          ? "0 structured workspace writes · creation or modification is not proven by structured evidence"
          : `${agent.workspaceWrites} structured workspace write${
              agent.workspaceWrites === 1 ? "" : "s"
            } recorded`,
      ],
      tone: agent.workspaceWrites === 0 ? "warning" : "success",
    });
  }
  const result = childResult || agent.summary;
  if (result) {
    sections.push({
      label: "result",
      lines: splitText(result),
      tone: agentTone(agent),
    });
  }
  const errors = unique([
    ...(agent.errorCode ? [agent.errorCode] : []),
    ...agent.blockerLines,
    ...agent.blockerCodes,
  ]);
  if (errors.length > 0) {
    sections.push({ label: "error", lines: errors, tone: "error" });
  }
  return {
    key: `agent:${agent.key}`,
    kind: "agent",
    level: "primary",
    sequence: agent.firstSequence,
    indent: Math.max(0, agent.depth - 1),
    summary: formatAgentSummary(agent),
    tone: agentTone(agent),
    sections,
  };
}

function toolBlock(tool: ToolPresentation): TranscriptBlock {
  const sections: TranscriptDetailSection[] = [];
  const argsPreview = detailedArgumentPreview(tool);
  if (argsPreview) {
    sections.push({
      label: tool.name === "bash" ? "command" : "parameters",
      lines: splitText(argsPreview),
    });
  }
  if (tool.failed) {
    sections.push({
      label: "error",
      lines: [
        [tool.errorCode, tool.error].filter(Boolean).join(" · ") ||
          "tool execution failed",
      ],
      tone: "error",
    });
  } else if (tool.result !== undefined) {
    const toolSearch = summarizeToolSearchResult(tool.name, tool.result);
    if (toolSearch) {
      sections.push({
        label: "result",
        lines: toolSearch,
        tone: "muted",
      });
    } else {
      const display = summarizeToolResultForDisplay({
        toolName: tool.name,
        result: tool.result,
        mode: "export",
        maxFallbackChars: 2_000,
      });
      if (display.kind === "summary") {
        const lines =
          !display.head &&
          display.details.some((line) => /^[{[]/.test(line.trim())) &&
          Object.keys(rec(tool.result)).length > 0
            ? summarizeStructuredResult(tool.result)
            : [display.head, ...display.details].filter(Boolean);
        if (lines.length > 0) {
          sections.push({ label: "result", lines, tone: display.tone });
        }
      } else if (display.kind === "markdown") {
        sections.push({
          label: "result",
          lines: [...splitText(display.text), ...display.details],
          tone: display.tone,
        });
      }
    }
  }
  return {
    key: `tool:${tool.key}`,
    kind: "tool",
    level: "detail",
    sequence: tool.firstSequence,
    indent: 0,
    summary: `tool ${tool.name} ${tool.failed ? "failed" : tool.result === undefined ? "running" : "completed"}`,
    tone: tool.failed
      ? "error"
      : tool.result === undefined
        ? "normal"
        : "success",
    sections,
  };
}

function todoBlock(
  sequence: number,
  items: readonly TodoPanelItem[],
): TranscriptBlock {
  return {
    key: `todo:${sequence}`,
    kind: "todo",
    level: "detail",
    sequence,
    indent: 0,
    summary: `todo · ${items.filter((item) => item.status !== "completed").length} open · ${items.filter((item) => item.status === "completed").length} completed`,
    tone: "normal",
    sections: [
      {
        label: "items",
        lines: items.map(
          (item) =>
            `${"  ".repeat(Math.max(0, item.depth))}${item.status === "completed" ? "✓" : "○"} ${item.title}`,
        ),
      },
    ],
  };
}

function assistantBlock(event: RunEvent, message: string): TranscriptBlock {
  return {
    key: eventKey(event),
    kind: "assistant",
    level: "primary",
    sequence: event.sequence,
    indent: 0,
    summary: "assistant",
    tone: "success",
    sections: [{ label: "message", lines: splitText(message) }],
  };
}

function isChildCompactException(
  event: RunEvent,
  payload: Record<string, unknown>,
): boolean {
  if (event.type === "tool.failed") return true;
  if (event.type === "approval.requested") return true;
  if (event.type === "approval.resolved") {
    return str(payload.decision) !== "approved";
  }
  if (
    event.type === "workspace.write.denied" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  ) {
    return true;
  }
  if (event.type === "run.completed") {
    const state = str(payload.state);
    return state === "failed" || state === "cancelled";
  }
  return false;
}

function formatToolAction(tool: ToolPresentation): string {
  const preview = detailedArgumentPreview(tool, 120);
  const status = tool.failed ? "✗" : tool.result === undefined ? "…" : "✓";
  return `${[tool.name, preview].filter(Boolean).join("  ")}  ${status}`;
}

function formatAgentActionSummary(action: AgentActionSummary): string {
  const outcome =
    action.status === "failed"
      ? [action.errorCode, "✗"].filter(Boolean).join(" ")
      : action.status === "completed"
        ? [action.exitCode !== undefined ? `exit ${action.exitCode}` : "", "✓"]
            .filter(Boolean)
            .join(" ")
        : "…";
  return [action.toolName, action.preview, outcome].filter(Boolean).join("  ");
}

function detailedArgumentPreview(
  tool: ToolPresentation,
  maxChars = MAX_LINE_CHARS,
): string {
  const preview =
    tool.preview || formatToolRequestPreview(tool.name, tool.args, maxChars);
  if (!/^[{[]/.test(preview.trim())) return preview;
  const args = rec(tool.args);
  const fields = Object.entries(args)
    .slice(0, 8)
    .map(([key, value]) => {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        return `${key}=${oneLine(value, 80)}`;
      }
      if (Array.isArray(value)) return `${key}=${value.length} items`;
      return `${key}=structured`;
    });
  return fields.length > 0 ? fields.join(" · ") : "structured parameters";
}

function summarizeToolSearchResult(
  toolName: string,
  result: unknown,
): string[] | undefined {
  if (toolName !== "tool_search") return undefined;
  const record = rec(result);
  const persistedMatches = rec(record.matches);
  const matches = Array.isArray(record.matches)
    ? record.matches.map(rec)
    : Array.isArray(persistedMatches.preview)
      ? persistedMatches.preview.map(rec)
      : [];
  const matchCount = Array.isArray(record.matches)
    ? record.matches.length
    : persistedMatches.type === "array"
      ? (number(persistedMatches.length) ?? matches.length)
      : matches.length;
  const names = matches.map((match) => str(match.name)).filter(Boolean);
  return [
    `${matchCount} match${matchCount === 1 ? "" : "es"}`,
    ...(names.length > 0 ? [names.join(" · ")] : []),
  ];
}

function summarizeStructuredResult(result: unknown): string[] {
  const record = rec(result);
  const scalarFields = Object.entries(record)
    .filter(
      ([, value]) =>
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean",
    )
    .slice(0, 6)
    .map(([key, value]) => `${key}=${oneLine(value, 100)}`);
  const collectionFields = Object.entries(record)
    .filter(([, value]) => Array.isArray(value))
    .slice(0, 4)
    .map(
      ([key, value]) =>
        `${key}=${(value as unknown[]).length} item${
          (value as unknown[]).length === 1 ? "" : "s"
        }`,
    );
  const lines = [...scalarFields, ...collectionFields];
  return lines.length > 0
    ? lines
    : [`structured result · ${Object.keys(record).slice(0, 8).join(", ")}`];
}

function currentOrLatestRunEvents(events: readonly RunEvent[]): RunEvent[] {
  let start = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "tui.user") {
      start = index;
      break;
    }
  }
  if (start < 0) {
    const childRuns = new Set(
      events
        .filter((event) => event.type.startsWith("subagent."))
        .map((event) => {
          const payload = rec(event.payload);
          const metadata = rec(event.metadata);
          return str(payload.childRunId) || str(metadata.childRunId);
        })
        .filter(Boolean),
    );
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (
        event?.type === "run.started" &&
        !childRuns.has(runIdForEvent(event) ?? "")
      ) {
        start = index;
        break;
      }
    }
  }
  return events.slice(Math.max(0, start));
}

function hasOpenRun(events: readonly RunEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type;
    if (type === "run.started") return true;
    if (
      type === "run.completed" ||
      type === "run.failed" ||
      type === "run.cancelled"
    ) {
      return false;
    }
  }
  return false;
}

export function agentIdentity(event: RunEvent): string {
  const payload = rec(event.payload);
  const metadata = rec(event.metadata);
  return (
    str(payload.childRunId) ||
    str(metadata.childRunId) ||
    str(payload.spanId) ||
    event.spanId ||
    str(metadata.spanId) ||
    `legacy:${str(metadata.agentName) || str(metadata.agentId) || event.id || event.sequence}`
  );
}

function toolRequestId(payload: Record<string, unknown>): string {
  return str(payload.id) || str(payload.toolCallId);
}

function toolCompletionId(payload: Record<string, unknown>): string {
  return str(payload.toolCallId) || str(payload.id);
}

function runIdForEvent(event: RunEvent): string | undefined {
  const payload = rec(event.payload);
  return event.runId || str(payload.runId) || undefined;
}

function eventTimestamp(event: RunEvent): number | undefined {
  const raw = event.timestamp ?? event.occurredAt;
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function elapsedMs(
  start: number | undefined,
  end: number | undefined,
): number | undefined {
  return start !== undefined && end !== undefined && end >= start
    ? end - start
    : undefined;
}

function formatShortDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms / 1_000)}s`;
}

function failureMessage(payload: Record<string, unknown>): string {
  const failure = rec(payload.failure);
  return (
    str(failure.message) ||
    str(payload.message) ||
    str(payload.reason) ||
    "unknown failure"
  );
}

function eventKey(event: RunEvent): string {
  return event.id ?? `${event.type}:${event.sequence}`;
}

function splitText(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseAgentActions(value: unknown): AgentActionSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(rec)
    .filter(
      (action) =>
        str(action.toolCallId) &&
        str(action.toolName) &&
        (action.status === "running" ||
          action.status === "completed" ||
          action.status === "failed"),
    )
    .slice(0, 24)
    .map((action) => ({
      toolCallId: str(action.toolCallId),
      toolName: str(action.toolName),
      ...(str(action.preview) ? { preview: str(action.preview) } : {}),
      status: action.status as AgentActionSummary["status"],
      ...(typeof action.exitCode === "number" || action.exitCode === null
        ? { exitCode: action.exitCode as number | null }
        : {}),
      ...(str(action.errorCode) ? { errorCode: str(action.errorCode) } : {}),
    }));
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
