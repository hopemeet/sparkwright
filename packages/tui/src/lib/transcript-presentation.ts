import type { TodoPanelItem } from "../state/event-store.js";
import type { RunEvent } from "./event-type.js";
import type { AgentActionSummary } from "@sparkwright/agent-runtime";
import {
  formatToolRequestPreview,
  oneLine,
  summarizeToolResultForDisplay,
  type ToolDisplayTone,
} from "./tool-display.js";
import { isParentAgentResult } from "./tool-result-summary.js";
import {
  collectConversationApprovalStates,
  conversationApprovalIdentity,
  formatConversationApprovalStatus,
  type ConversationApprovalState,
} from "./conversation-projection.js";

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
  runId?: string;
  parentKey?: string;
}

export interface TranscriptLine {
  key: string;
  text: string;
  tone: ToolDisplayTone;
  bold?: boolean;
}

export interface DetailedTranscriptProjection {
  scope: "current run" | "latest run" | "session";
  blocks: TranscriptBlock[];
  lines: TranscriptLine[];
  truncated: boolean;
}

export interface TranscriptProjectionOptions {
  /**
   * The legacy details panel showed only the current/latest turn. The owned
   * viewport needs the complete presentation history, so it opts into session
   * scope while export remains independent of either projection.
   */
  scope?: "latest" | "session";
  maxLines?: number;
}

export type AgentDisplayStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_issues"
  | "partial"
  | "blocked"
  | "failed";

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
  issueLines: string[];
  diagnosticCodes: string[];
  errorCode?: string;
  errorMessage?: string;
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
  skipped?: boolean;
  skipReason?: string;
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
  for (const [ordinal, event] of events.entries()) {
    const payload = rec(event.payload);
    if (event.type === "tool.requested") {
      const id = toolIdentity(event, ordinal);
      const name = str(payload.toolName);
      if (id) requestNames.set(id, name);
      if (id && isAgentOrchestrationToolName(name)) ids.add(id);
      continue;
    }
    if (event.type !== "tool.completed") continue;
    const id = toolIdentity(event, ordinal);
    const name = str(payload.toolName) || requestNames.get(id) || "";
    const result = payload.result ?? payload.output;
    if (
      id &&
      (isAgentOrchestrationToolName(name) ||
        isParentAgentResult(result) ||
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
    // live parent transcript. Keep child failures visible, but fold approvals,
    // successful child work, and the child's full final answer under its Agent
    // block.
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
    const id = scopedToolCallIdentity(event) ?? "";
    return !isAgentOrchestrationToolName(name) && !agentToolCallIds.has(id);
  }
  if (event.type === "tool.completed") {
    const name = str(payload.toolName);
    const id = scopedToolCallIdentity(event) ?? "";
    const result = payload.result ?? payload.output;
    return (
      !isAgentOrchestrationToolName(name) &&
      !agentToolCallIds.has(id) &&
      !isParentAgentResult(result)
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
  for (const [ordinal, event] of events.entries()) {
    if (!event.type.startsWith("subagent.")) continue;
    const payload = rec(event.payload);
    const metadata = rec(event.metadata);
    const key = agentIdentity(event, ordinal);
    const previous = agents.get(key);
    const timestamp = eventTimestamp(event);
    const phase = event.type.slice("subagent.".length);
    const semanticStatus = str(payload.status);
    const assessment = rec(payload.assessment);
    const assessmentHealth = str(assessment.health);
    const terminalState = str(payload.terminalState);
    const assessmentIssues = Array.isArray(assessment.issues)
      ? assessment.issues.map(rec)
      : [];
    const actions = parseAgentActions(payload.actions);
    const hasAssessmentIssues =
      assessmentHealth === "degraded" ||
      assessmentHealth === "failing" ||
      assessmentIssues.length > 0;
    const status: AgentDisplayStatus =
      semanticStatus === "blocked" || semanticStatus === "partial"
        ? semanticStatus
        : semanticStatus === "completed"
          ? hasAssessmentIssues
            ? "completed_with_issues"
            : "completed"
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
    const error = rec(payload.error);
    const workspaceWrites =
      number(payload.workspaceWrites) ?? previous?.workspaceWrites;
    const issueLines =
      assessmentIssues.length > 0
        ? assessmentIssues.flatMap((issue) =>
            formatAssessmentIssue(issue, actions, workspaceWrites),
          )
        : (previous?.issueLines ?? []);
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
      blockerCodes: unique(blockers.map((blocker) => str(blocker.code))),
      blockerLines: unique(
        blockers.map((blocker) => str(blocker.message)).filter(Boolean),
      ),
      issueLines,
      diagnosticCodes: unique([
        ...assessmentIssues.flatMap(assessmentDiagnosticCodes),
        ...actions.map((action) => action.errorCode ?? ""),
        ...(previous?.diagnosticCodes ?? []),
      ]),
      errorCode:
        str(error.code) ||
        str(payload.errorCode) ||
        previous?.errorCode ||
        undefined,
      errorMessage: str(error.message) || previous?.errorMessage || undefined,
      actionCount:
        actions.length > 0
          ? actions.length
          : (number(payload.toolCalls) ?? previous?.actionCount ?? undefined),
      actions: actions.length > 0 ? actions : (previous?.actions ?? []),
      workspaceWrites,
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
  const status =
    agent.status === "completed_with_issues"
      ? "completed with issues"
      : agent.status;
  return `└─ Agent · ${agent.name} ${status}${suffix ? ` · ${suffix}` : ""}`;
}

export function agentTone(agent: AgentPresentation): ToolDisplayTone {
  if (agent.status === "failed") return "error";
  if (agent.status === "blocked" || agent.status === "partial")
    return "warning";
  if (agent.status === "completed_with_issues") return "warning";
  if (agent.status === "completed") return "success";
  return "normal";
}

export function agentCompactFailureDetail(
  agent: AgentPresentation,
): string | undefined {
  if (
    agent.status !== "failed" &&
    agent.status !== "blocked" &&
    agent.status !== "partial" &&
    agent.status !== "completed_with_issues"
  ) {
    return undefined;
  }
  return (
    agent.errorMessage ||
    agent.issueLines[0] ||
    agent.blockerLines[0] ||
    agent.summary ||
    `${agent.status} before completion`
  );
}

export function buildDetailedTranscript(
  allEvents: readonly RunEvent[],
  todoItems: readonly TodoPanelItem[] = [],
  options: TranscriptProjectionOptions = {},
): DetailedTranscriptProjection {
  const events =
    options.scope === "session"
      ? [...allEvents]
      : currentOrLatestRunEvents(allEvents);
  const approvalStates = collectConversationApprovalStates(events);
  const agents = collectAgentPresentations(events);
  const agentByRunId = new Map<string, AgentPresentation>();
  for (const agent of agents.values()) {
    if (agent.childRunId) agentByRunId.set(agent.childRunId, agent);
  }
  const childResults = collectChildResults(events, agentByRunId);
  const rawApprovalsByRun = collectRawApprovalLinesByRun(
    events,
    approvalStates,
    agentByRunId,
  );
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

  for (const [ordinal, event] of events.entries()) {
    const payload = rec(event.payload);
    if (event.type.startsWith("subagent.")) {
      const key = agentIdentity(event, ordinal);
      if (emittedAgents.has(key)) continue;
      emittedAgents.add(key);
      const agent = agents.get(key);
      if (!agent) continue;
      blocks.push(
        agentBlock(
          agent,
          actionsByAgent.get(key) ?? [],
          agent.childRunId
            ? (rawApprovalsByRun.get(agent.childRunId) ??
                receiptApprovalLines(agent.actions))
            : [],
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
      const tool = tools.get(toolIdentity(event, ordinal));
      if (!tool || emittedTools.has(tool.key)) continue;
      emittedTools.add(tool.key);
      const owningAgent = tool.runId ? agentByRunId.get(tool.runId) : undefined;
      const terminalReceiptCoversTool =
        owningAgent?.actions.some((action) =>
          toolIdentityMatchesCall(tool.key, action.toolCallId),
        ) === true;
      if (owningAgent && (!tool.failed || terminalReceiptCoversTool)) continue;
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

    if (
      event.runId &&
      agentByRunId.has(event.runId) &&
      !isChildCompactException(event, payload)
    ) {
      // Child-run success content is owned by the parent Agent block. Tool
      // lifecycles were already consumed above as Agent actions.
      continue;
    }

    if (event.type === "tui.user") {
      const goal = str(payload.goal).trim();
      if (goal) {
        blocks.push({
          key: eventKey(event, ordinal),
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
      if (message) blocks.push(assistantBlock(event, message, ordinal));
      continue;
    }

    if (event.type === "run.completed") {
      const state = str(payload.state);
      if (state === "failed") {
        blocks.push({
          key: eventKey(event, ordinal),
          kind: "failure",
          level: "primary",
          sequence: event.sequence,
          indent: 0,
          summary: `── run failed: ${failureMessage(payload)}`,
          tone: "error",
          sections: [],
        });
      } else {
        const message = str(payload.message).trim();
        if (message) blocks.push(assistantBlock(event, message, ordinal));
      }
      continue;
    }

    if (event.type === "run.cancelled") {
      blocks.push({
        key: eventKey(event, ordinal),
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
      const approvalIdentity = conversationApprovalIdentity(event);
      const status = formatConversationApprovalStatus(
        approvalIdentity ? approvalStates.get(approvalIdentity) : undefined,
      );
      blocks.push({
        key: approvalIdentity ?? eventKey(event, ordinal),
        kind: "approval",
        level: "primary",
        sequence: event.sequence,
        indent: 0,
        summary: `approval ${status} · ${str(payload.summary) || str(payload.action) || "review required"}`,
        tone:
          status === "approved" || status === "auto-approved"
            ? "success"
            : "warning",
        sections: [],
      });
      continue;
    }

    if (event.type === "approval.resolved") {
      const approvalIdentity = conversationApprovalIdentity(event);
      if (approvalIdentity && approvalStates.get(approvalIdentity)?.requested) {
        continue;
      }
      const decision = str(payload.decision) || "resolved";
      if (decision === "approved") continue;
      blocks.push({
        key: eventKey(event, ordinal),
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
        key: eventKey(event, ordinal),
        kind: "failure",
        level: "primary",
        sequence: event.sequence,
        indent: 0,
        summary:
          event.type === "workspace.write.denied"
            ? `write denied · ${str(payload.path) || "workspace"}`
            : `── run failed: ${failureMessage(payload)}`,
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
  const maxLines = options.maxLines ?? MAX_DETAIL_LINES;
  const truncated = flattened.length > maxLines;
  const lines = truncated
    ? [
        {
          key: "__truncated",
          text: `… ${flattened.length - maxLines} earlier detail lines omitted …`,
          tone: "warning" as const,
        },
        ...flattened.slice(-maxLines),
      ]
    : flattened;
  return {
    scope:
      options.scope === "session"
        ? "session"
        : hasOpenRun(events)
          ? "current run"
          : "latest run",
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
  for (const [ordinal, event] of events.entries()) {
    const payload = rec(event.payload);
    if (event.type === "tool.requested") {
      const key = toolIdentity(event, ordinal);
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
    const key = toolIdentity(event, ordinal);
    const previous = tools.get(key);
    const error = rec(payload.error);
    const result = payload.result ?? payload.output ?? previous?.result;
    const resultRecord = rec(result);
    tools.set(key, {
      key,
      firstSequence: previous?.firstSequence ?? event.sequence,
      runId: previous?.runId ?? runIdForEvent(event),
      name: str(payload.toolName) || previous?.name || "tool",
      args: previous?.args,
      preview: previous?.preview,
      result,
      failed: event.type === "tool.failed",
      skipped: resultRecord.skipped === true,
      skipReason: str(resultRecord.reason) || undefined,
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
  approvals: readonly string[],
  childResult?: string,
): TranscriptBlock {
  const sections: TranscriptDetailSection[] = [];
  if (agent.task) sections.push({ label: "task", lines: [agent.task] });
  const actions =
    fallbackActions.length > 0
      ? fallbackActions
      : agent.actions.map(formatAgentActionSummary);
  if (actions.length > 0) {
    sections.push({ label: "actions", lines: [...actions] });
  }
  if (approvals.length > 0) {
    sections.push({
      label: "approvals",
      lines: [...approvals],
      tone: approvals.some((line) =>
        /approval (?:requested|denied)\b/u.test(line),
      )
        ? "warning"
        : "success",
    });
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
  const issues = unique([
    ...agent.issueLines,
    ...(agent.errorMessage ? [agent.errorMessage] : []),
    ...agent.blockerLines,
  ]);
  if (issues.length > 0) {
    sections.push({ label: "issue", lines: issues, tone: "warning" });
  }
  const result = childResult || agent.summary;
  if (result) {
    sections.push({
      label: "result",
      lines: splitText(result),
      tone: agentTone(agent),
    });
  }
  const diagnostics = unique([
    ...(agent.errorCode ? [agent.errorCode] : []),
    ...agent.blockerCodes,
    ...agent.diagnosticCodes,
  ]);
  if (diagnostics.length > 0) {
    sections.push({
      label: "diagnostics",
      lines: diagnostics,
      tone: "muted",
    });
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
    runId: agent.childRunId,
    parentKey: agent.parentRunId ? `run:${agent.parentRunId}` : undefined,
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
    runId: tool.runId,
    parentKey: tool.runId ? `run:${tool.runId}` : undefined,
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
    summary: `todo (current snapshot) · ${items.filter((item) => item.status !== "completed").length} open · ${items.filter((item) => item.status === "completed").length} completed`,
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

function assistantBlock(
  event: RunEvent,
  message: string,
  ordinal: number,
): TranscriptBlock {
  return {
    key: eventKey(event, ordinal),
    kind: "assistant",
    level: "primary",
    sequence: event.sequence,
    indent: 0,
    summary: "assistant",
    tone: "success",
    sections: [{ label: "message", lines: splitText(message) }],
  };
}

export function isChildCompactException(
  event: RunEvent,
  payload: Record<string, unknown>,
): boolean {
  if (event.type === "tool.failed") return true;
  if (event.type === "approval.requested" || event.type === "approval.resolved")
    return false;
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
  const exitCode = number(rec(tool.result).exitCode);
  const status = tool.failed
    ? "✗"
    : tool.result === undefined
      ? "…"
      : tool.skipped
        ? [tool.skipReason, "skipped"].filter(Boolean).join(" · ")
        : exitCode !== undefined && exitCode !== 0
          ? `exit ${exitCode} ✗`
          : "✓";
  return `${[tool.name, preview].filter(Boolean).join("  ")}  ${status}`;
}

function formatAgentActionSummary(action: AgentActionSummary): string {
  const outcome =
    action.status === "failed"
      ? [action.errorCode, "✗"].filter(Boolean).join(" ")
      : action.status === "skipped"
        ? [action.skipReason, "skipped"].filter(Boolean).join(" · ")
        : action.status === "completed"
          ? completedActionOutcome(action.exitCode)
          : "…";
  return [action.toolName, action.preview, outcome].filter(Boolean).join("  ");
}

function collectRawApprovalLinesByRun(
  events: readonly RunEvent[],
  states: ReadonlyMap<string, ConversationApprovalState>,
  agentByRunId: ReadonlyMap<string, AgentPresentation>,
): Map<string, string[]> {
  const linesByRun = new Map<string, string[]>();
  const requested = new Set<string>();
  for (const event of events) {
    if (
      event.type !== "approval.requested" &&
      event.type !== "approval.resolved"
    ) {
      continue;
    }
    const runId = runIdForEvent(event);
    if (!runId || !agentByRunId.has(runId)) continue;
    const identity = conversationApprovalIdentity(event);
    if (!identity) continue;
    if (event.type === "approval.requested") {
      requested.add(identity);
      const payload = rec(event.payload);
      appendApprovalLine(
        linesByRun,
        runId,
        formatApprovalLine(
          formatConversationApprovalStatus(states.get(identity)),
          str(payload.summary) || str(payload.action) || "review required",
        ),
      );
      continue;
    }
    if (requested.has(identity) || states.get(identity)?.requested) continue;
    const payload = rec(event.payload);
    appendApprovalLine(
      linesByRun,
      runId,
      formatApprovalLine(
        formatConversationApprovalStatus(states.get(identity)),
        str(payload.summary) || str(payload.action),
      ),
    );
  }
  return linesByRun;
}

function receiptApprovalLines(
  actions: readonly AgentActionSummary[],
): string[] {
  return actions.flatMap((action) => {
    if (!action.approval) return [];
    const status = formatConversationApprovalStatus({
      requested: action.approval === "requested",
      ...(action.approval !== "requested" ? { decision: action.approval } : {}),
      ...(action.approvalAutoApproved !== undefined
        ? { autoApproved: action.approvalAutoApproved }
        : {}),
    });
    return [
      formatApprovalLine(
        status,
        action.approvalSummary ||
          [action.toolName, action.preview].filter(Boolean).join(" "),
      ),
    ];
  });
}

function appendApprovalLine(
  linesByRun: Map<string, string[]>,
  runId: string,
  line: string,
): void {
  const lines = linesByRun.get(runId) ?? [];
  lines.push(line);
  linesByRun.set(runId, lines);
}

function formatApprovalLine(status: string, summary: string): string {
  return `approval ${status}${summary ? ` · ${summary}` : ""}`;
}

function formatAssessmentIssue(
  issue: Record<string, unknown>,
  actions: readonly AgentActionSummary[],
  workspaceWrites: number | undefined,
): string[] {
  const code = str(issue.code);
  const count = Math.max(1, number(issue.count) ?? 1);
  const details = rec(issue.details);
  const tools = stringArray(details.toolNames).slice(0, 3);
  const underlyingCodes = stringArray(details.codes).slice(0, 3);

  if (code === "UNRESOLVED_TOOL_FAILURE") {
    const failedActions = actions.filter(
      (action) => action.status === "failed",
    );
    if (failedActions.length > 0) {
      return failedActions
        .slice(0, 3)
        .map((action) => formatUnresolvedAction(action, workspaceWrites));
    }
    return [
      `${count} tool failure${count === 1 ? "" : "s"} remained unresolved${
        tools.length > 0 ? ` in ${tools.join(", ")}` : ""
      }${underlyingCodes.length > 0 ? ` (${underlyingCodes.join(", ")})` : ""}`,
    ];
  }
  if (code === "RECOVERED_TOOL_FAILURE") {
    return [
      `${count} tool failure${count === 1 ? " was" : "s were"} recovered${
        tools.length > 0 ? ` in ${tools.join(", ")}` : ""
      }`,
    ];
  }
  if (code === "EXPECTED_DENIAL") {
    return [
      `${count} expected policy or approval denial${
        count === 1 ? " occurred" : "s occurred"
      }${tools.length > 0 ? ` in ${tools.join(", ")}` : ""}`,
    ];
  }
  if (code === "VERIFICATION_FAILED") {
    const command = str(details.lastCommand);
    return [
      `Verification failed${command ? ` for ${command}` : ""}; the affected result is not verified`,
    ];
  }
  const label = code
    ? code.toLowerCase().replaceAll("_", " ")
    : "runtime assessment issue";
  return [`${label}${count > 1 ? ` (${count})` : ""}`];
}

function formatUnresolvedAction(
  action: AgentActionSummary,
  workspaceWrites: number | undefined,
): string {
  const subject = [action.toolName, action.preview].filter(Boolean).join(" ");
  let message: string;
  if (action.errorCode === "WORKSPACE_CREATE_CONFLICT") {
    message = `${subject} failed because the target already exists`;
  } else if (action.errorCode === "WORKSPACE_REPLACE_CONFLICT") {
    message = `${subject} failed because the target does not exist`;
  } else if (action.errorMessage) {
    message = `${subject} failed: ${action.errorMessage}`;
  } else {
    message = `${subject} failed and was not recovered`;
  }
  return isWorkspaceMutationAction(action) && workspaceWrites === 0
    ? `${message}; no successful workspace write proved creation or modification`
    : message;
}

function isWorkspaceMutationAction(action: AgentActionSummary): boolean {
  return (
    action.toolName === "create" ||
    action.toolName === "write" ||
    action.toolName === "edit" ||
    action.toolName === "edit_anchored_text"
  );
}

function assessmentDiagnosticCodes(issue: Record<string, unknown>): string[] {
  return unique([str(issue.code), ...stringArray(rec(issue.details).codes)]);
}

function toolIdentityMatchesCall(
  identity: string,
  toolCallId: string,
): boolean {
  return (
    identity === `call:${toolCallId}` ||
    identity.endsWith(`:call:${toolCallId}`)
  );
}

function completedActionOutcome(exitCode: number | null | undefined): string {
  return [
    typeof exitCode === "number" ? `exit ${exitCode}` : "",
    typeof exitCode === "number" && exitCode !== 0 ? "✗" : "✓",
  ]
    .filter(Boolean)
    .join(" ");
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

export function agentIdentity(event: RunEvent, ordinal: number): string {
  const payload = rec(event.payload);
  const metadata = rec(event.metadata);
  const childRunId = str(payload.childRunId) || str(metadata.childRunId);
  if (childRunId) return childRunId;
  const callId =
    str(payload.agentCallId) ||
    str(metadata.agentCallId) ||
    str(payload.invocationId) ||
    str(metadata.invocationId) ||
    str(payload.toolCallId) ||
    str(metadata.toolCallId);
  if (!callId) return eventIdentity(event, ordinal);
  const parentRunId =
    str(payload.parentRunId) ||
    str(metadata.parentRunId) ||
    event.runId ||
    str(payload.runId);
  return parentRunId ? `run:${parentRunId}:call:${callId}` : `call:${callId}`;
}

export function toolIdentity(event: RunEvent, ordinal: number): string {
  return scopedToolCallIdentity(event) ?? eventIdentity(event, ordinal);
}

function scopedToolCallIdentity(event: RunEvent): string | undefined {
  const payload = rec(event.payload);
  const callId = str(payload.toolCallId) || str(payload.id);
  if (!callId) return undefined;
  const runId = runIdForEvent(event);
  return runId ? `run:${runId}:call:${callId}` : `call:${callId}`;
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

function eventIdentity(event: RunEvent, ordinal: number): string {
  return event.id ? `event:${event.id}` : `ordinal:${ordinal}`;
}

function eventKey(event: RunEvent, ordinal: number): string {
  return event.id ?? `${event.type}:ordinal:${ordinal}`;
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
          action.status === "failed" ||
          action.status === "skipped"),
    )
    .slice(0, 24)
    .map((action) => ({
      toolCallId: str(action.toolCallId),
      toolName: str(action.toolName),
      ...(str(action.preview) ? { preview: str(action.preview) } : {}),
      status: action.status as AgentActionSummary["status"],
      ...(action.approval === "requested" ||
      action.approval === "approved" ||
      action.approval === "denied"
        ? { approval: action.approval }
        : {}),
      ...(str(action.approvalSummary)
        ? { approvalSummary: str(action.approvalSummary) }
        : {}),
      ...(typeof action.approvalAutoApproved === "boolean"
        ? { approvalAutoApproved: action.approvalAutoApproved }
        : {}),
      ...(typeof action.exitCode === "number" || action.exitCode === null
        ? { exitCode: action.exitCode as number | null }
        : {}),
      ...(str(action.errorCode) ? { errorCode: str(action.errorCode) } : {}),
      ...(str(action.errorMessage)
        ? { errorMessage: str(action.errorMessage) }
        : {}),
      ...(str(action.skipReason) ? { skipReason: str(action.skipReason) } : {}),
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
