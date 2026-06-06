import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createContextItemId,
  type ContextItem,
  type RunResult,
  type RunStopReason,
  type SparkwrightEvent,
} from "@sparkwright/core";
import {
  itemsOnly,
  parseTodoMarkdown,
  serializeTodoMarkdown,
  type TodoEntry,
} from "./markdown.js";
import type { TodoItem, TodoLedger, TodoStatus, TodoSummary } from "./types.js";

const UNFINISHED_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "blocked",
]);

const DEFAULT_RESUMABLE_STOP_REASONS: ReadonlySet<RunStopReason> = new Set([
  "final_answer",
  "max_steps_exceeded",
  "max_model_calls_exceeded",
  "max_tool_calls_exceeded",
  "token_budget_exceeded",
  "model_output_invalid",
]);

export interface TodoTerminalAuditOptions {
  /**
   * Terminal result from the run that just ended.
   */
  result: RunResult;
  /**
   * Events from the just-finished run. Used only to detect external progress;
   * todo status changes alone never count as progress.
   */
  events?: readonly SparkwrightEvent[];
  continuationCount?: number;
  maxContinuations?: number;
  stalledContinuationCount?: number;
  maxStalledContinuations?: number;
  resumableStopReasons?: ReadonlySet<RunStopReason>;
}

export type TodoTerminalAuditDecision =
  | {
      kind: "complete";
      summary: TodoSummary;
      reason: "all_todos_finished";
    }
  | {
      kind: "continue";
      summary: TodoSummary;
      reason: "unfinished_todo";
      prompt: string;
    }
  | {
      kind: "handoff";
      summary: TodoSummary;
      reason:
        | "unfinished_todo"
        | "non_resumable_stop_reason"
        | "continuation_limit"
        | "stalled_without_progress";
      message: string;
    };

/**
 * Read a todo ledger from disk. Missing files return an empty v1 ledger.
 *
 * @public
 * @stability experimental v0.1
 */
export async function readTodoLedger(path: string): Promise<TodoLedger> {
  const raw = await safeRead(path);
  return {
    schemaVersion: "todo-ledger.v1",
    items: itemsOnly(parseTodoMarkdown(raw)),
    metadata: {},
  };
}

/**
 * Replace the on-disk ledger. The current v1 persistence is Markdown so humans
 * can inspect and repair the work ledger directly.
 *
 * @public
 * @stability experimental v0.1
 */
export async function writeTodoLedger(
  path: string,
  ledger: TodoLedger,
): Promise<void> {
  const entries: TodoEntry[] = ledger.items.map((item) => ({
    kind: "item",
    ...item,
  }));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeTodoMarkdown(entries), "utf8");
}

/**
 * Summarize item counts by status. `blocked` is deliberately considered
 * unfinished: it requires user/supervisor attention before the task is done.
 *
 * @public
 * @stability experimental v0.1
 */
export function summarizeTodoLedger(
  ledgerOrItems: TodoLedger | readonly TodoItem[],
): TodoSummary {
  const items = "items" in ledgerOrItems ? ledgerOrItems.items : ledgerOrItems;
  const summary: TodoSummary = {
    total: items.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    unfinished: 0,
    hasUnfinished: false,
  };
  for (const item of items) {
    switch (item.status) {
      case "pending":
        summary.pending += 1;
        break;
      case "in_progress":
        summary.inProgress += 1;
        break;
      case "completed":
        summary.completed += 1;
        break;
      case "blocked":
        summary.blocked += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
    }
    if (UNFINISHED_STATUSES.has(item.status)) summary.unfinished += 1;
  }
  summary.hasUnfinished = summary.unfinished > 0;
  return summary;
}

/** @public @stability experimental v0.1 */
export function hasUnfinishedTodo(ledger: TodoLedger): boolean {
  return summarizeTodoLedger(ledger).hasUnfinished;
}

/** @public @stability experimental v0.1 */
export function unfinishedTodoItems(ledger: TodoLedger): TodoItem[] {
  return ledger.items.filter((item) => UNFINISHED_STATUSES.has(item.status));
}

/**
 * Render the authoritative todo ledger as a context item. Compactors may
 * summarize conversation history, but this context item preserves the current
 * work ledger as runtime state.
 *
 * @public
 * @stability experimental v0.1
 */
export function renderTodoLedgerContext(
  ledger: TodoLedger,
  options: { title?: string; sessionId?: string } = {},
): ContextItem {
  const summary = summarizeTodoLedger(ledger);
  const lines = [
    options.title ?? "Current todo ledger",
    `total=${summary.total} completed=${summary.completed} unfinished=${summary.unfinished} blocked=${summary.blocked} failed=${summary.failed}`,
    "",
    ...ledger.items.map(renderTodoLine),
  ];
  return {
    id: createContextItemId(),
    type: "summary",
    source: { kind: "todo_ledger", uri: options.sessionId },
    content: lines.join("\n").trimEnd(),
    metadata: {
      layer: "runtime",
      stability: "session",
      todoLedger: true,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...summary,
    },
  };
}

/**
 * Decide what a todo-aware supervisor should do after a run reaches terminal.
 * The decision intentionally treats todo status changes as self-reporting; an
 * automatic continuation needs external progress evidence from run events.
 *
 * @public
 * @stability experimental v0.1
 */
export function auditTodoAfterTerminal(
  ledger: TodoLedger,
  options: TodoTerminalAuditOptions,
): TodoTerminalAuditDecision {
  const summary = summarizeTodoLedger(ledger);
  if (!summary.hasUnfinished) {
    return { kind: "complete", summary, reason: "all_todos_finished" };
  }

  const resumable =
    options.result.stopReason !== undefined &&
    (options.resumableStopReasons ?? DEFAULT_RESUMABLE_STOP_REASONS).has(
      options.result.stopReason,
    );
  if (!resumable) {
    return {
      kind: "handoff",
      summary,
      reason: "non_resumable_stop_reason",
      message: `Todo ledger is unfinished, but stopReason=${options.result.stopReason ?? "unknown"} is not safe to auto-continue.`,
    };
  }

  if (
    options.maxContinuations !== undefined &&
    (options.continuationCount ?? 0) >= options.maxContinuations
  ) {
    return {
      kind: "handoff",
      summary,
      reason: "continuation_limit",
      message: `Todo ledger is unfinished, but continuation limit ${options.maxContinuations} was reached.`,
    };
  }

  const hasProgress = hasExternalProgressEvidence(options.events ?? []);
  if (
    !hasProgress &&
    options.maxStalledContinuations !== undefined &&
    (options.stalledContinuationCount ?? 0) >= options.maxStalledContinuations
  ) {
    return {
      kind: "handoff",
      summary,
      reason: "stalled_without_progress",
      message:
        "Todo ledger is unfinished, but the last continuation produced no external progress evidence.",
    };
  }

  return {
    kind: "continue",
    summary,
    reason: "unfinished_todo",
    prompt: buildTodoContinuationPrompt(ledger),
  };
}

/** @public @stability experimental v0.1 */
export function buildTodoContinuationPrompt(ledger: TodoLedger): string {
  const unfinished = unfinishedTodoItems(ledger);
  const preferred =
    unfinished.find((item) => item.status === "in_progress") ??
    unfinished.find((item) => item.priority === "high") ??
    unfinished[0];
  const nextLine = preferred
    ? `Next preferred item: ${preferred.title}`
    : "No unfinished item could be selected.";
  return [
    "Continue from the todo ledger.",
    "",
    "Do not restart from scratch.",
    "Inspect unfinished todo items first.",
    "Prefer the existing in_progress item; otherwise pick the highest-priority pending item.",
    "Update the todo ledger before and after work.",
    "Only mark an item completed when there is evidence.",
    "If blocked, mark it blocked and explain the blocker.",
    "",
    nextLine,
  ].join("\n");
}

/**
 * Strong, externally-observable side effects from a run. Used by the stall
 * guard to decide whether a continuation is making real forward progress or
 * just spinning.
 *
 * Deliberately does NOT include `tool.completed`: that event fires for every
 * tool call — including a read that returned nothing or an empty glob — so
 * counting it as "progress" let a model thrash in a dead end (e.g. globbing a
 * non-existent path) forever without the stall guard ever firing. Matching the
 * function's name, only genuine *external* changes count: a workspace write, a
 * verified anchored edit, or a created artifact. Reads and no-ops are internal
 * information-gathering, not progress. A read-only run that produces no such
 * side effect across `maxStalledContinuations` rounds is intended to hand off
 * to the human rather than auto-continue indefinitely.
 *
 * @public @stability experimental v0.1
 */
const EXTERNAL_PROGRESS_EVENTS: ReadonlySet<SparkwrightEvent["type"]> = new Set(
  [
    "workspace.write.completed",
    "workspace.anchored_edit.verified",
    "artifact.created",
  ],
);

/** @public @stability experimental v0.1 */
export function hasExternalProgressEvidence(
  events: readonly SparkwrightEvent[],
): boolean {
  return events.some((event) => EXTERNAL_PROGRESS_EVENTS.has(event.type));
}

function renderTodoLine(item: TodoItem): string {
  const prefix = "  ".repeat(Math.max(0, item.depth));
  const id = item.id ? ` id=${item.id}` : "";
  const priority = item.priority ? ` priority=${item.priority}` : "";
  const owner = item.owner ? ` owner=${item.owner}` : "";
  const doneWhen = item.doneWhen ? ` done-when=${item.doneWhen}` : "";
  const evidence =
    item.evidence && item.evidence.length > 0
      ? ` evidence=${item.evidence.length}`
      : "";
  const note = item.note ? ` note=${item.note}` : "";
  return `${prefix}- ${item.status}: ${item.title}${id}${priority}${owner}${doneWhen}${evidence}${note}`;
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (
      cause &&
      typeof cause === "object" &&
      (cause as { code?: string }).code === "ENOENT"
    ) {
      return "";
    }
    throw cause;
  }
}
