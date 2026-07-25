import type { SparkwrightEvent } from "@sparkwright/core";

export const MAX_AGENT_ACTION_SUMMARIES = 24;

export interface AgentActionSummary {
  /** Stable child tool call identity used to deduplicate live/replay facts. */
  readonly toolCallId: string;
  /** Child-visible tool name. */
  readonly toolName: string;
  /** Bounded, user-facing argument summary; never the raw argument object. */
  readonly preview?: string;
  readonly status: "running" | "completed" | "failed";
  readonly exitCode?: number | null;
  readonly errorCode?: string;
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
  for (const event of events) {
    const payload = record(event.payload);
    if (event.type === "tool.requested") {
      const toolCallId = string(payload.id);
      const toolName = string(payload.toolName);
      if (
        !toolCallId ||
        !toolName ||
        toolName === "submit_agent_result" ||
        actions.size >= limit
      ) {
        continue;
      }
      const preview = summarizeArguments(payload.arguments);
      actions.set(toolCallId, {
        toolCallId,
        toolName,
        ...(preview ? { preview } : {}),
        status: "running",
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
    if (!toolName || toolName === "submit_agent_result") continue;
    const result = record(payload.output ?? payload.result);
    const error = record(payload.error);
    actions.set(toolCallId, {
      toolCallId,
      toolName,
      ...(previous?.preview ? { preview: previous.preview } : {}),
      status: event.type === "tool.failed" ? "failed" : "completed",
      ...(typeof result.exitCode === "number" || result.exitCode === null
        ? { exitCode: result.exitCode as number | null }
        : {}),
      ...(string(error.code) ? { errorCode: string(error.code) } : {}),
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
