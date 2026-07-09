import { runFailureMessage } from "@sparkwright/protocol";
import type { RunEvent } from "./event-type.js";
import type { FormattedEvent } from "./format-event.js";

const MAX_SEARCH_PAYLOAD_CHARS = 2000;

export type EventDetailFilter =
  | "all"
  | "errors"
  | "approvals"
  | "tools"
  | "writes"
  | "model";

export function eventMatchesFilter(
  event: RunEvent,
  filter: EventDetailFilter,
): boolean {
  const type = event.type;
  const failedRunCompleted = isFailedRunCompletedEvent(event);
  switch (filter) {
    case "all":
      return true;
    case "errors":
      return (
        type === "run.failed" ||
        failedRunCompleted ||
        type.endsWith(".failed") ||
        type.endsWith(".denied") ||
        type.endsWith(".rejected") ||
        type.endsWith(".timeout")
      );
    case "approvals":
      return type.startsWith("approval.");
    case "tools":
      return (
        type.startsWith("tool.") ||
        type.startsWith("task.") ||
        type.startsWith("mcp.") ||
        type.startsWith("subagent.")
      );
    case "writes":
      return (
        type.startsWith("workspace.write.") ||
        type === "capability.mutation.completed"
      );
    case "model":
      return type.startsWith("model.") || type === "usage.updated";
  }
}

export function eventDetailFilterLabel(filter: EventDetailFilter): string {
  return filter;
}

export interface RunInspectorFacts {
  eventCount: number;
  runStarted: number;
  runCompleted: number;
  runFailed: number;
  toolCalls: number;
  changedFiles: string[];
  approvalsRequested: number;
  approvalsApproved: number;
  approvalsDenied: number;
  modelCalls: number;
  errorCount: number;
  lastCommand?: string;
  lastError?: string;
}

export function summarizeRunInspectorFacts(
  events: readonly RunEvent[],
): RunInspectorFacts {
  const facts: RunInspectorFacts = {
    eventCount: events.length,
    runStarted: 0,
    runCompleted: 0,
    runFailed: 0,
    toolCalls: 0,
    changedFiles: [],
    approvalsRequested: 0,
    approvalsApproved: 0,
    approvalsDenied: 0,
    modelCalls: 0,
    errorCount: 0,
  };
  const changedFiles = new Set<string>();
  for (const event of events) {
    const payload = rec(event.payload);
    if (event.type === "run.started") facts.runStarted += 1;
    if (event.type === "run.completed") facts.runCompleted += 1;
    if (event.type === "run.failed") facts.runFailed += 1;
    if (event.type === "tool.requested") {
      facts.toolCalls += 1;
      if (isShellToolName(str(payload.toolName))) {
        const args = rec(payload.arguments ?? payload.input ?? payload.args);
        const command = str(args.command);
        if (command) facts.lastCommand = command;
      }
    }
    if (event.type === "model.completed") facts.modelCalls += 1;
    const failedRunCompleted =
      event.type === "run.completed" && str(payload.state) === "failed";
    if (
      failedRunCompleted ||
      event.type.endsWith(".failed") ||
      event.type.endsWith(".denied") ||
      event.type.endsWith(".rejected") ||
      event.type.endsWith(".timeout")
    ) {
      facts.errorCount += 1;
      facts.lastError =
        (event.type === "run.failed" || failedRunCompleted
          ? runFailureMessage(payload)
          : "") ||
        str(rec(payload.error).message) ||
        str(payload.message) ||
        str(payload.reason) ||
        event.type;
    }
    if (
      event.type === "workspace.write.applied" ||
      event.type === "workspace.write.completed"
    ) {
      const path = str(payload.path);
      if (path) changedFiles.add(path);
    }
    if (event.type === "approval.requested") facts.approvalsRequested += 1;
    if (event.type === "approval.resolved") {
      const decision = str(payload.decision);
      if (decision === "approved") facts.approvalsApproved += 1;
      else if (decision === "denied") facts.approvalsDenied += 1;
    }
  }
  facts.changedFiles = [...changedFiles].sort();
  return facts;
}

function isShellToolName(name: string): boolean {
  return name === "bash" || name === "shell";
}

export function eventMatchesSearch(
  event: RunEvent,
  formatted: FormattedEvent,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return eventSearchText(event, formatted).includes(normalized);
}

function eventSearchText(event: RunEvent, formatted: FormattedEvent): string {
  const parts = [
    event.type,
    formatted.label,
    formatted.detail,
    event.id ?? "",
    String(event.sequence ?? ""),
  ];
  if (event.payload !== undefined) {
    parts.push(safeSearchJson(event.payload));
  }
  return parts.join("\n").toLowerCase();
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isFailedRunCompletedEvent(event: RunEvent): boolean {
  return (
    event.type === "run.completed" && str(rec(event.payload).state) === "failed"
  );
}

function safeSearchJson(value: unknown): string {
  try {
    return JSON.stringify(pruneForSearch(value)).slice(
      0,
      MAX_SEARCH_PAYLOAD_CHARS,
    );
  } catch {
    return "";
  }
}

function pruneForSearch(value: unknown): unknown {
  return pruneValue(value, 0, new WeakSet<object>(), {
    maxString: 300,
    maxArray: 12,
    maxKeys: 16,
    maxDepth: 4,
  });
}

function pruneValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  limits: {
    maxString: number;
    maxArray: number;
    maxKeys: number;
    maxDepth: number;
  },
): unknown {
  if (typeof value === "string") {
    if (value.length <= limits.maxString) return value;
    return {
      type: "string",
      length: value.length,
      preview: value.slice(0, limits.maxString),
      truncated: true,
    };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (seen.has(value)) return "[Circular]";
  if (depth >= limits.maxDepth) return "[MaxDepth]";
  seen.add(value);

  if (Array.isArray(value)) {
    const shown = value
      .slice(0, limits.maxArray)
      .map((item) => pruneValue(item, depth + 1, seen, limits));
    if (value.length <= limits.maxArray) return shown;
    return {
      type: "array",
      length: value.length,
      preview: shown,
      truncated: true,
    };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, nested] of entries.slice(0, limits.maxKeys)) {
    out[key] = pruneValue(nested, depth + 1, seen, limits);
  }
  if (entries.length > limits.maxKeys) {
    out.__truncatedKeys = entries.length - limits.maxKeys;
  }
  return out;
}
