import type { SparkwrightEvent } from "@sparkwright/core";

export const MAX_AGENT_ACTION_SUMMARIES = 24;

export interface AgentActionSummary {
  /** Stable child tool call identity used to deduplicate live/replay facts. */
  readonly toolCallId: string;
  /** Child-visible tool name. */
  readonly toolName: string;
  /** Bounded, user-facing argument summary; never the raw argument object. */
  readonly preview?: string;
  readonly status: "running" | "completed" | "failed" | "skipped";
  /** Final approval state observed inside this tool span, when approval ran. */
  readonly approval?: "requested" | "approved" | "denied";
  /** Bounded producer-authored label used by live clients when child events are unavailable. */
  readonly approvalSummary?: string;
  /** True when policy approved the action without a manual user decision. */
  readonly approvalAutoApproved?: boolean;
  readonly exitCode?: number | null;
  readonly errorCode?: string;
  /** Bounded human-readable failure context; never raw tool output. */
  readonly errorMessage?: string;
  readonly skipReason?: string;
}

/**
 * Build a bounded terminal action receipt from one child run.
 *
 * The receipt deliberately excludes raw arguments and outputs. It is safe to
 * attach to the parent-visible subagent terminal event and gives live clients
 * the same action list that replay can otherwise reconstruct from child trace.
 */
export function summarizeAgentActions(
  events: readonly SparkwrightEvent[],
  limit = MAX_AGENT_ACTION_SUMMARIES,
): AgentActionSummary[] {
  const actions = new Map<string, AgentActionSummary>();
  const toolCallIdsBySpan = new Map<string, string>();
  const toolCallIdsByApproval = new Map<string, string>();
  for (const event of events) {
    const payload = record(event.payload);
    if (event.type === "tool.requested") {
      const toolCallId = string(payload.id);
      const toolName = string(payload.toolName);
      if (!toolCallId || !toolName || actions.size >= limit) {
        continue;
      }
      const preview = summarizeArguments(payload.arguments);
      actions.set(toolCallId, {
        toolCallId,
        toolName,
        ...(preview ? { preview } : {}),
        status: "running",
      });
      if (event.spanId) toolCallIdsBySpan.set(event.spanId, toolCallId);
      continue;
    }
    if (event.type === "approval.requested") {
      const approvalId = string(payload.id) || string(payload.approvalId);
      const toolCallId =
        string(payload.toolCallId) ||
        string(record(event.metadata).toolCallId) ||
        (event.spanId ? toolCallIdsBySpan.get(event.spanId) : undefined);
      const previous = toolCallId ? actions.get(toolCallId) : undefined;
      if (!toolCallId || !previous) continue;
      if (approvalId) toolCallIdsByApproval.set(approvalId, toolCallId);
      const approvalSummary = bounded(string(payload.summary), 180);
      actions.set(toolCallId, {
        ...previous,
        approval: "requested",
        ...(approvalSummary ? { approvalSummary } : {}),
      });
      continue;
    }
    if (event.type === "approval.resolved") {
      const approvalId = string(payload.approvalId) || string(payload.id);
      const toolCallId =
        toolCallIdsByApproval.get(approvalId) ||
        string(payload.toolCallId) ||
        string(record(event.metadata).toolCallId) ||
        (event.spanId ? toolCallIdsBySpan.get(event.spanId) : undefined);
      const previous = toolCallId ? actions.get(toolCallId) : undefined;
      const decision = payload.decision;
      if (
        !toolCallId ||
        !previous ||
        (decision !== "approved" && decision !== "denied")
      ) {
        continue;
      }
      actions.set(toolCallId, {
        ...previous,
        approval: decision,
        ...(typeof payload.autoApproved === "boolean"
          ? { approvalAutoApproved: payload.autoApproved }
          : {}),
      });
      continue;
    }
    if (event.type !== "tool.completed" && event.type !== "tool.failed") {
      continue;
    }
    const toolCallId = string(payload.toolCallId);
    if (!toolCallId) continue;
    const previous = actions.get(toolCallId);
    const toolName = string(payload.toolName) || previous?.toolName;
    if (!toolName) continue;
    const result = record(payload.output ?? payload.result);
    const error = record(payload.error);
    const errorMessage = bounded(
      string(error.message) || string(payload.error),
      180,
    );
    const skipped = result.skipped === true;
    const skipReason = string(result.reason);
    actions.set(toolCallId, {
      toolCallId,
      toolName,
      ...(previous?.preview ? { preview: previous.preview } : {}),
      ...(previous?.approval ? { approval: previous.approval } : {}),
      ...(previous?.approvalSummary
        ? { approvalSummary: previous.approvalSummary }
        : {}),
      ...(previous?.approvalAutoApproved !== undefined
        ? { approvalAutoApproved: previous.approvalAutoApproved }
        : {}),
      status:
        event.type === "tool.failed"
          ? "failed"
          : skipped
            ? "skipped"
            : "completed",
      ...(typeof result.exitCode === "number" || result.exitCode === null
        ? { exitCode: result.exitCode as number | null }
        : {}),
      ...(string(error.code) ? { errorCode: string(error.code) } : {}),
      ...(event.type === "tool.failed" && errorMessage ? { errorMessage } : {}),
      ...(skipped && skipReason ? { skipReason } : {}),
    });
  }
  return [...actions.values()].slice(0, Math.max(0, Math.floor(limit)));
}

function summarizeArguments(value: unknown): string | undefined {
  const args = record(value);
  const command = bounded(string(args.command), 180);
  if (command) return `$ ${command}`;

  const path = bounded(
    string(args.path) || string(args.filePath) || string(args.target),
    140,
  );
  if (path) {
    const line =
      number(args.line) ??
      number(args.startLine) ??
      number(args.offset) ??
      number(args.from);
    const count =
      number(args.limit) ?? number(args.lineCount) ?? number(args.count);
    return `${path}${line === undefined ? "" : `:${line}`}${
      count === undefined ? "" : ` +${count}`
    }`;
  }

  const patterns = stringArray(args.patterns);
  if (patterns.length > 0) return bounded(patterns.join(", "), 160);
  const pattern = bounded(string(args.pattern), 160);
  if (pattern) return pattern;

  const preferredKeys = ["query", "name", "action", "taskId", "proposalId"];
  const preferred = preferredKeys
    .map((key) => scalarField(key, args[key]))
    .filter((field): field is string => Boolean(field));
  if (preferred.length > 0) return bounded(preferred.join(" · "), 180);

  const fields = Object.entries(args)
    .map(([key, field]) => scalarField(key, field))
    .filter((field): field is string => Boolean(field))
    .slice(0, 3);
  return fields.length > 0 ? bounded(fields.join(" · "), 180) : undefined;
}

function scalarField(key: string, value: unknown): string | undefined {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return undefined;
  }
  const rendered = bounded(String(value), 80);
  return rendered ? `${key}=${rendered}` : undefined;
}

function bounded(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 1))}…`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
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
