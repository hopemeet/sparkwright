import { runFailureMessage } from "@sparkwright/protocol";
import type { TodoPanelItem } from "../state/event-store.js";
import { isInternalTranscriptEvent, type RunEvent } from "./event-type.js";
import { formatEvent } from "./format-event.js";
import { compactMutationPath, type ToolDisplayTone } from "./tool-display.js";
import { shortTaskId } from "./task-activity.js";
import { conversationApprovalIdentity } from "./conversation-projection.js";
import {
  agentCompactFailureDetail,
  agentIdentity,
  buildDetailedTranscript,
  collectAgentPresentations,
  isChildCompactException,
  isAgentOrchestrationToolName,
  toolIdentity,
  type AgentPresentation,
  type TranscriptBlock as PresentationBlock,
  type TranscriptBlockKind,
} from "./transcript-presentation.js";

export type TranscriptRowFormat = "plain" | "markdown" | "diff";

export interface TranscriptRow {
  readonly key: string;
  readonly text: string;
  readonly tone: ToolDisplayTone;
  readonly bold?: boolean;
  readonly format?: TranscriptRowFormat;
}

export interface TranscriptSection {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly TranscriptRow[];
  readonly tone: ToolDisplayTone;
}

export interface TranscriptDocumentBlock {
  readonly key: string;
  readonly kind: TranscriptBlockKind;
  readonly level: "primary" | "detail";
  readonly ordinal: number;
  readonly summary: readonly TranscriptRow[];
  readonly details: readonly TranscriptSection[];
  readonly runId?: string;
  readonly parentKey?: string;
  readonly visibility: "always" | "detailed";
}

export interface TranscriptDocumentHeader {
  workspaceRoot: string;
  modelLabel: string;
  sessionId: string | null;
}

/**
 * Immutable semantic snapshot. `epoch` changes only at a real document
 * boundary (/clear, /new, or a session switch); a mode toggle or resize merely
 * re-projects the same blocks.
 */
export interface TranscriptDocument {
  readonly epoch: string;
  readonly blocks: readonly TranscriptDocumentBlock[];
}

export interface AssembleTranscriptDocumentInput {
  epoch: string;
  events: readonly RunEvent[];
  todoItems?: readonly TodoPanelItem[];
  header: TranscriptDocumentHeader;
}

const MAX_SECTION_SOURCE_ROWS = 120;

type MutableTranscriptDocumentBlock = Omit<
  TranscriptDocumentBlock,
  "summary" | "details" | "parentKey" | "visibility"
> & {
  summary: TranscriptRow[];
  details: TranscriptSection[];
  parentKey?: string;
  visibility: "always" | "detailed";
};

export function assembleTranscriptDocument(
  input: AssembleTranscriptDocumentInput,
): TranscriptDocument {
  const events = [...input.events];
  const projection = buildDetailedTranscript(events, input.todoItems ?? [], {
    scope: "session",
    maxLines: 5_001,
  });
  const ordinals = correlationOrdinals(events);
  const toolEffects = collectStructuredToolEffects(events);
  const agents = collectAgentPresentations(events);
  const coveredChildFailureCalls = new Set(
    [...agents.values()].flatMap((agent) =>
      agent.childRunId
        ? agent.actions
            .filter((action) => action.status === "failed")
            .map(
              (action) => `run:${agent.childRunId}:call:${action.toolCallId}`,
            )
        : [],
    ),
  );
  const childRunIds = new Set(
    [...agents.values()]
      .map((agent) => agent.childRunId)
      .filter((runId): runId is string => Boolean(runId)),
  );
  const blocks: MutableTranscriptDocumentBlock[] = [
    headerBlock(input.header),
    ...projection.blocks.map((block, index) =>
      fromPresentationBlock(
        block,
        ordinals.get(block.key) ?? events.length + index,
        agents,
      ),
    ),
  ];
  const known = new Set(blocks.map((block) => block.key));

  events.forEach((event, ordinal) => {
    if (
      event.type === "tool.failed" &&
      coveredChildFailureCalls.has(toolIdentity(event, ordinal))
    ) {
      return;
    }
    if (
      event.runId &&
      childRunIds.has(event.runId) &&
      !isChildCompactException(event, rec(event.payload))
    ) {
      return;
    }
    if (isOwnedToolEffect(event, toolEffects)) return;
    const correlatedKey = correlationKey(event, ordinal);
    if (correlatedKey && known.has(correlatedKey)) return;
    if (event.type.startsWith("subagent.")) return;
    if (
      (event.type === "tool.requested" ||
        event.type === "tool.completed" ||
        event.type === "tool.failed") &&
      shouldSkipUnprojectedTool(event)
    ) {
      return;
    }
    const block = standaloneEventBlock(event, ordinal);
    if (!block || known.has(block.key)) return;
    known.add(block.key);
    blocks.push(block);
  });

  decorateProposalMutations(blocks, events);
  decorateRunTerminals(blocks, events);
  relinkStructuredParents(blocks);
  blocks.sort((left, right) => left.ordinal - right.ordinal);
  return freezeTranscriptDocument(input.epoch, blocks);
}

interface StructuredToolEffects {
  readonly spans: ReadonlySet<string>;
  readonly calls: ReadonlySet<string>;
}

const TOOL_OWNED_EFFECT_TYPES = new Set([
  "workspace.read",
  "workspace.anchored_read",
  "skill.loaded",
]);

/**
 * Effect events are useful when they stand alone, but some tools also emit an
 * exact effect fact inside their own span. In that case the tool block owns the
 * presentation. This deliberately accepts only structured span/call identity;
 * it never guesses from event adjacency, names, or paths.
 */
function collectStructuredToolEffects(
  events: readonly RunEvent[],
): StructuredToolEffects {
  const spans = new Set<string>();
  const calls = new Set<string>();
  for (const event of events) {
    if (
      event.type !== "tool.requested" &&
      event.type !== "tool.completed" &&
      event.type !== "tool.failed"
    ) {
      continue;
    }
    if (event.spanId) spans.add(scopedIdentity("span", event, event.spanId));
    const payload = rec(event.payload);
    const callId = str(payload.toolCallId) || str(payload.id);
    if (callId) calls.add(scopedIdentity("call", event, callId));
  }
  return { spans, calls };
}

function isOwnedToolEffect(
  event: RunEvent,
  owners: StructuredToolEffects,
): boolean {
  if (!TOOL_OWNED_EFFECT_TYPES.has(event.type)) return false;
  if (
    event.spanId &&
    owners.spans.has(scopedIdentity("span", event, event.spanId))
  ) {
    return true;
  }
  const payload = rec(event.payload);
  const metadata = rec(event.metadata);
  const callId = str(payload.toolCallId) || str(metadata.toolCallId);
  return Boolean(
    callId && owners.calls.has(scopedIdentity("call", event, callId)),
  );
}

function scopedIdentity(
  kind: "span" | "call",
  event: RunEvent,
  id: string,
): string {
  const payload = rec(event.payload);
  const runId = event.runId || str(payload.runId);
  return runId ? `${kind}:run:${runId}:${id}` : `${kind}:${id}`;
}

function headerBlock(
  header: TranscriptDocumentHeader,
): MutableTranscriptDocumentBlock {
  return {
    key: "__header",
    kind: "notice",
    level: "primary",
    ordinal: -1,
    summary: [
      row(
        "__header:title",
        "SparkWright · type a goal · /capabilities · /help",
        "normal",
        true,
      ),
      row("__header:cwd", `cwd ${header.workspaceRoot}`, "muted"),
      row(
        "__header:session",
        `model ${header.modelLabel} · session ${header.sessionId ?? "—"}`,
        "muted",
      ),
    ],
    details: [],
    visibility: "always",
  };
}

function fromPresentationBlock(
  block: PresentationBlock,
  ordinal: number,
  agents: ReadonlyMap<string, AgentPresentation>,
): MutableTranscriptDocumentBlock {
  const summary: TranscriptRow[] = [
    row(
      `${block.key}:summary`,
      block.summary,
      block.tone,
      block.kind === "agent" || block.kind === "tool",
    ),
  ];

  if (block.kind === "assistant") {
    const message = block.sections.find(
      (section) => section.label === "message",
    );
    if (message) {
      summary.push(
        row(
          `${block.key}:message`,
          message.lines.join("\n"),
          "normal",
          false,
          "markdown",
        ),
      );
    }
  } else if (block.kind === "agent") {
    const identity = block.key.slice("agent:".length);
    const failure = agents.get(identity);
    const detail = failure ? agentCompactFailureDetail(failure) : undefined;
    if (detail) {
      summary.push(
        row(`${block.key}:failure`, `   ${detail} · Ctrl+T 查看详情`, "error"),
      );
    }
  } else if (block.kind === "tool") {
    const match = /^tool (.+?) (?:failed|running|completed)$/u.exec(
      block.summary,
    );
    const name = match?.[1] ?? "tool";
    const parameters =
      block.sections.find((section) => section.label === "command") ??
      block.sections.find((section) => section.label === "parameters");
    summary[0] = row(
      `${block.key}:summary`,
      block.tone === "error"
        ? `✗ ${name} failed`
        : `⚙ ${name}${parameters?.lines[0] ? `  ${parameters.lines[0]}` : ""}`,
      block.tone,
      true,
    );
    const result = block.sections.find((section) => section.label === "result");
    if (result) {
      result.lines.slice(0, 12).forEach((lineText, index) => {
        summary.push(
          row(
            `${block.key}:result:${index}`,
            `  ${lineText}`,
            result.tone ?? "muted",
          ),
        );
      });
    }
  }

  const details =
    block.kind === "assistant"
      ? []
      : block.sections.map((section, sectionIndex) => {
          const rows = section.lines
            .slice(0, MAX_SECTION_SOURCE_ROWS)
            .map((lineText, lineIndex) =>
              row(
                `${block.key}:section:${sectionIndex}:${lineIndex}`,
                lineText,
                section.tone ?? "normal",
              ),
            );
          if (section.lines.length > MAX_SECTION_SOURCE_ROWS) {
            rows.push(
              row(
                `${block.key}:section:${sectionIndex}:omitted`,
                `… ${section.lines.length - MAX_SECTION_SOURCE_ROWS} lines omitted …`,
                "warning",
              ),
            );
          }
          return {
            key: `${block.key}:section:${sectionIndex}`,
            label: section.label,
            tone: section.tone ?? "muted",
            rows,
          };
        });
  return {
    key: block.key,
    kind: block.kind,
    // Visibility and content identity are independent: a failed tool remains
    // Tool content, but its error severity promotes it to a primary block.
    level: block.tone === "error" ? "primary" : block.level,
    ordinal,
    summary,
    details,
    runId: block.runId,
    parentKey: block.parentKey,
    visibility: compactVisibility(block),
  };
}

function correlationOrdinals(events: readonly RunEvent[]): Map<string, number> {
  const ordinals = new Map<string, number>();
  events.forEach((event, ordinal) => {
    const key = correlationKey(event, ordinal);
    if (key && !ordinals.has(key)) ordinals.set(key, ordinal);
  });
  return ordinals;
}

function correlationKey(event: RunEvent, ordinal: number): string | undefined {
  if (event.type.startsWith("subagent.")) {
    return `agent:${agentIdentity(event, ordinal)}`;
  }
  if (
    event.type === "tool.requested" ||
    event.type === "tool.completed" ||
    event.type === "tool.failed"
  ) {
    return `tool:${toolIdentity(event, ordinal)}`;
  }
  const approvalIdentity = conversationApprovalIdentity(event);
  if (approvalIdentity) return approvalIdentity;
  return eventKey(event, ordinal);
}

function shouldSkipUnprojectedTool(event: RunEvent): boolean {
  const payload = rec(event.payload);
  const name = str(payload.toolName);
  return name === "todo_write" || isAgentOrchestrationToolName(name);
}

function standaloneEventBlock(
  event: RunEvent,
  ordinal: number,
): MutableTranscriptDocumentBlock | null {
  const payload = rec(event.payload);
  const key = eventKey(event, ordinal);
  const base = (
    kind: TranscriptBlockKind,
    level: "primary" | "detail",
    rows: TranscriptRow[],
    details: TranscriptSection[] = [],
  ): MutableTranscriptDocumentBlock => ({
    key,
    kind,
    level,
    ordinal,
    summary: rows,
    details,
    visibility: "always",
    runId: event.runId,
    parentKey:
      str(payload.parentRunId) || str(rec(event.metadata).parentRunId)
        ? `run:${str(payload.parentRunId) || str(rec(event.metadata).parentRunId)}`
        : undefined,
  });

  switch (event.type) {
    case "tui.notice": {
      const text = str(payload.text).trim();
      return text
        ? base("notice", "primary", [
            row(`${key}:summary`, `↻ ${text}`, "muted"),
          ])
        : null;
    }
    case "tui.export.completed": {
      const path = str(payload.path).trim();
      return path
        ? base("notice", "primary", [
            row(`${key}:summary`, "transcript exported", "success"),
            row(`${key}:path`, path, "normal"),
          ])
        : null;
    }
    case "workspace.read":
      return base("tool", "detail", [
        row(`${key}:summary`, `read ${str(payload.path) || "?"}`, "muted"),
      ]);
    case "workspace.anchored_read": {
      const count =
        typeof payload.lineCount === "number"
          ? ` · ${payload.lineCount} lines`
          : "";
      return base("tool", "detail", [
        row(
          `${key}:summary`,
          `read anchors ${str(payload.path) || "?"}${count}`,
          "muted",
        ),
      ]);
    }
    case "workspace.write.applied":
    case "workspace.write.completed": {
      const diff = str(payload.diff);
      return base(
        "tool",
        "primary",
        [
          row(
            `${key}:summary`,
            `✎ write ${str(payload.path) || "?"}`,
            "success",
            true,
          ),
        ],
        diff
          ? [
              {
                key: `${key}:diff`,
                label: "diff",
                tone: "normal",
                rows: [row(`${key}:diff:0`, diff, "normal", false, "diff")],
              },
            ]
          : [],
      );
    }
    case "task.started":
    case "task.completed":
    case "task.failed":
    case "task.cancelled": {
      const phase = event.type.slice("task.".length);
      const taskId = str(payload.taskId) || str(payload.id);
      if (!taskId) return null;
      const tone: ToolDisplayTone =
        phase === "failed"
          ? "error"
          : phase === "cancelled"
            ? "warning"
            : phase === "completed"
              ? "success"
              : "normal";
      return base("tool", phase === "failed" ? "primary" : "detail", [
        row(`${key}:summary`, formatTaskLifecycle(event, phase, taskId), tone),
      ]);
    }
    case "task.output":
    case "task.created":
    case "tool.batch.requested":
    case "tool.batch.completed":
    case "approval.requested":
    case "approval.resolved":
      return null;
    case "capability.mutation.completed": {
      const action = str(payload.action) || "mutation";
      const path = compactMutationPath(str(payload.path));
      const reason = str(payload.reason);
      const proposalMutation = path.includes(
        ".sparkwright/skill-evolution/proposals/",
      );
      const block = base("notice", "detail", [
        row(
          `${key}:summary`,
          `◇ capability mutation ${action}${path ? ` ${path}` : ""}`,
          "warning",
          true,
        ),
        ...(reason ? [row(`${key}:reason`, `  ${reason}`, "muted")] : []),
      ]);
      block.visibility = proposalMutation ? "detailed" : "always";
      return block;
    }
    case "skill.loaded": {
      const name = str(payload.name) || "skill";
      const block = base("notice", "detail", [
        row(`${key}:summary`, `skill ${name} loaded`, "normal"),
      ]);
      block.visibility = "detailed";
      return block;
    }
    case "mcp.server.prepared": {
      const name = str(payload.name) || str(payload.serverName) || "mcp";
      const status = str(payload.status) || "prepared";
      const errorCode = str(payload.errorCode);
      const block = base(
        errorCode ? "failure" : "notice",
        errorCode ? "primary" : "detail",
        [
          row(
            `${key}:summary`,
            `mcp ${name} ${status}${errorCode ? ` · ${errorCode}` : ""}`,
            errorCode ? "error" : "normal",
          ),
        ],
      );
      block.visibility = errorCode ? "always" : "detailed";
      return block;
    }
    case "run.completed": {
      const state = str(payload.state);
      if (state === "failed") {
        return base("failure", "primary", [
          row(
            `${key}:summary`,
            `── run failed: ${runFailureMessage(payload)}`,
            "error",
          ),
        ]);
      }
      if (state === "cancelled") {
        return base("failure", "primary", [
          row(
            `${key}:summary`,
            `── run cancelled: ${str(payload.reason) || str(payload.stopReason) || "cancelled"}`,
            "warning",
          ),
        ]);
      }
      return base("notice", "primary", [
        row(
          `${key}:summary`,
          str(payload.reason) === "final_answer"
            ? "─────"
            : `── run ${str(payload.reason) || "completed"}`,
          "muted",
        ),
      ]);
    }
    case "run.failed":
      return base("failure", "primary", [
        row(
          `${key}:summary`,
          `── run failed: ${runFailureMessage(payload)}`,
          "error",
        ),
      ]);
    default: {
      if (isInternalTranscriptEvent(event.type)) return null;
      const formatted = formatEvent(event);
      const detail = formatted.detail ? ` ${formatted.detail}` : "";
      return base("notice", "detail", [
        row(
          `${key}:summary`,
          `[${String(event.sequence).padStart(3, " ")}] ${formatted.label}${detail}`,
          "muted",
        ),
      ]);
    }
  }
}

function compactVisibility(block: PresentationBlock): "always" | "detailed" {
  if (
    block.kind === "agent" &&
    (block.summary.endsWith(" queued") || block.summary.endsWith(" running"))
  ) {
    return "detailed";
  }
  if (block.kind === "tool") {
    const resultText = block.sections
      .flatMap((section) => section.lines)
      .join("\n");
    if (
      /^tool skill_load /u.test(block.summary) &&
      !/not[_ ]found|failed|error/iu.test(resultText)
    ) {
      return "detailed";
    }
  }
  return "always";
}

function formatTaskLifecycle(
  event: RunEvent,
  phase: string,
  taskId: string,
): string {
  const payload = rec(event.payload);
  const result = rec(payload.result);
  const metadata = rec(event.metadata);
  const details = [
    shortTaskId(taskId),
    str(payload.kind),
    typeof result.exitCode === "number" ? `exit ${result.exitCode}` : undefined,
    typeof payload.progressCount === "number"
      ? `${payload.progressCount} chunk${payload.progressCount === 1 ? "" : "s"}`
      : undefined,
    typeof metadata.durationMs === "number"
      ? formatDuration(metadata.durationMs)
      : undefined,
    phase === "started" ? "ctrl+o activity" : undefined,
  ].filter(Boolean);
  return `${phase === "started" ? "background task" : "task"} ${phase}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function decorateProposalMutations(
  blocks: MutableTranscriptDocumentBlock[],
  events: readonly RunEvent[],
): void {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "capability.mutation.completed" || !event.spanId) {
      continue;
    }
    const path = str(rec(event.payload).path).replace(/\\/gu, "/");
    if (!path.includes(".sparkwright/skill-evolution/proposals/")) continue;
    counts.set(event.spanId, (counts.get(event.spanId) ?? 0) + 1);
  }
  for (const [ordinal, event] of events.entries()) {
    if (event.type !== "tool.completed" || !event.spanId) continue;
    const count = counts.get(event.spanId);
    if (!count) continue;
    const key = correlationKey(event, ordinal);
    const block = blocks.find((candidate) => candidate.key === key);
    if (!block) continue;
    block.summary.push(
      row(
        `${block.key}:internal-mutations`,
        `  ${count} internal mutation${count === 1 ? "" : "s"}`,
        "muted",
      ),
    );
  }
}

interface RunFacts {
  paths: Set<string>;
  shellRequests: string[];
  lastShell?: {
    command?: string;
    exitCode: number | null;
    background: boolean;
    timedOut: boolean;
  };
  terminalTasks: Array<{
    taskId: string;
    status: string;
    exitCode?: number;
    chunks?: number;
    durationMs?: number;
  }>;
  afterModelRequest: boolean;
}

function decorateRunTerminals(
  blocks: MutableTranscriptDocumentBlock[],
  events: readonly RunEvent[],
): void {
  const factsByRun = new Map<string, RunFacts>();
  for (const [ordinal, event] of events.entries()) {
    const payload = rec(event.payload);
    const runKey = event.runId || str(payload.runId) || "__unscoped";
    if (event.type === "run.started") {
      factsByRun.set(runKey, newRunFacts());
    }
    const facts = factsByRun.get(runKey) ?? newRunFacts();
    if (!factsByRun.has(runKey)) factsByRun.set(runKey, facts);
    if (
      event.type === "workspace.write.applied" ||
      event.type === "workspace.write.completed"
    ) {
      const path = str(payload.path);
      if (path) facts.paths.add(path);
    }
    if (event.type === "tool.requested" && str(payload.toolName) === "bash") {
      const command = str(
        rec(payload.arguments ?? payload.input ?? payload.args).command,
      );
      if (command) facts.shellRequests.push(command);
    }
    if (event.type === "tool.completed" && str(payload.toolName) === "bash") {
      const result = rec(payload.result ?? payload.output);
      if (typeof result.exitCode === "number" || result.exitCode === null) {
        facts.lastShell = {
          command: facts.shellRequests.shift(),
          exitCode:
            typeof result.exitCode === "number" ? result.exitCode : null,
          background: result.background === true,
          timedOut: result.timedOut === true,
        };
      }
    }
    if (event.type === "model.requested") {
      facts.afterModelRequest = true;
      facts.terminalTasks = [];
    }
    if (
      facts.afterModelRequest &&
      (event.type === "task.completed" ||
        event.type === "task.failed" ||
        event.type === "task.cancelled")
    ) {
      const result = rec(payload.result);
      const metadata = rec(event.metadata);
      const taskId = str(payload.taskId) || str(payload.id);
      if (taskId) {
        facts.terminalTasks.push({
          taskId,
          status: event.type.slice("task.".length),
          ...(typeof result.exitCode === "number"
            ? { exitCode: result.exitCode }
            : {}),
          ...(typeof payload.progressCount === "number"
            ? { chunks: payload.progressCount }
            : {}),
          ...(typeof metadata.durationMs === "number"
            ? { durationMs: metadata.durationMs }
            : {}),
        });
      }
    }
    if (
      event.type !== "run.completed" &&
      event.type !== "run.failed" &&
      event.type !== "run.cancelled"
    ) {
      continue;
    }
    const block = blocks.find(
      (candidate) => candidate.key === eventKey(event, ordinal),
    );
    if (!block) continue;
    facts.terminalTasks.forEach((task, index) => {
      const taskDetails = [
        shortTaskId(task.taskId),
        task.status,
        task.exitCode !== undefined ? `exit ${task.exitCode}` : undefined,
        task.chunks !== undefined
          ? `${task.chunks} chunk${task.chunks === 1 ? "" : "s"}`
          : undefined,
        task.durationMs !== undefined
          ? formatDuration(task.durationMs)
          : undefined,
      ].filter(Boolean);
      block.summary.push(
        row(
          `${block.key}:runtime:${index}`,
          `runtime update · ${taskDetails.join(" · ")}`,
          task.status === "failed"
            ? "error"
            : task.status === "cancelled"
              ? "warning"
              : "success",
        ),
      );
    });
    const parts = runFactParts(facts, payload);
    if (parts.length > 0) {
      block.summary.push(
        row(`${block.key}:facts`, `summary ${parts.join(" · ")}`, "muted"),
      );
    }
    factsByRun.delete(runKey);
  }
}

function runFactParts(
  facts: RunFacts,
  terminalPayload: Record<string, unknown>,
): string[] {
  const parts: string[] = [];
  const assessment = rec(terminalPayload.assessment);
  const health = str(assessment.health);
  const issues = Array.isArray(assessment.issues)
    ? assessment.issues
        .map((issue) => str(rec(issue).code))
        .filter(Boolean)
        .slice(0, 4)
    : [];
  if (health && health !== "clean") {
    parts.push(
      `health ${health}${issues.length ? ` (${issues.join(", ")})` : ""}`,
    );
  }
  if (facts.paths.size > 0) {
    parts.push(
      `changed ${facts.paths.size} file${facts.paths.size === 1 ? "" : "s"}`,
    );
  }
  const shell = facts.lastShell;
  if (shell && !shell.background && shell.command) {
    const status = shell.timedOut
      ? "timed out"
      : shell.exitCode === 0
        ? "passed"
        : typeof shell.exitCode === "number"
          ? "failed"
          : "completed";
    parts.push(`last command: ${shell.command} ${status}`);
  } else if (!shell?.background) {
    const verificationIssue = Array.isArray(assessment.issues)
      ? assessment.issues
          .map(rec)
          .find((issue) => str(issue.code) === "VERIFICATION_FAILED")
      : undefined;
    const details = rec(verificationIssue?.details);
    const command = str(details.lastCommand);
    if (command) {
      parts.push(
        `last command: ${command}${typeof details.lastExitCode === "number" && details.lastExitCode !== 0 ? " failed" : " completed"}`,
      );
    }
  }
  return parts;
}

function newRunFacts(): RunFacts {
  return {
    paths: new Set(),
    shellRequests: [],
    terminalTasks: [],
    afterModelRequest: false,
  };
}

function relinkStructuredParents(
  blocks: MutableTranscriptDocumentBlock[],
): void {
  const byRunId = new Map<string, string>();
  for (const block of blocks) {
    if (!block.runId) continue;
    // A child run can contain many tool/detail blocks. Nested Agent ancestry
    // must point to the semantic Agent block for that run, never whichever
    // child tool happened to arrive last.
    if (block.kind === "agent" || !byRunId.has(block.runId)) {
      byRunId.set(block.runId, block.key);
    }
  }
  for (const block of blocks) {
    if (!block.parentKey?.startsWith("run:")) continue;
    const parent = byRunId.get(block.parentKey.slice("run:".length));
    if (parent) block.parentKey = parent;
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

function row(
  key: string,
  text: string,
  tone: ToolDisplayTone,
  bold = false,
  format: TranscriptRowFormat = "plain",
): TranscriptRow {
  return Object.freeze({ key, text, tone, bold, format });
}

function freezeTranscriptDocument(
  epoch: string,
  blocks: readonly MutableTranscriptDocumentBlock[],
): TranscriptDocument {
  const frozenBlocks = blocks.map((block) =>
    Object.freeze({
      ...block,
      summary: Object.freeze([...block.summary]),
      details: Object.freeze(
        block.details.map((section) =>
          Object.freeze({
            ...section,
            rows: Object.freeze([...section.rows]),
          }),
        ),
      ),
    }),
  );
  return Object.freeze({
    epoch,
    blocks: Object.freeze(frozenBlocks),
  });
}

function eventKey(event: RunEvent, ordinal: number): string {
  return event.id ?? `${event.type}:ordinal:${ordinal}`;
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
