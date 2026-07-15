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
  "max_steps_exceeded",
  "max_model_calls_exceeded",
  "max_tool_calls_exceeded",
  "token_budget_exceeded",
  "model_output_invalid",
]);

/** Tool named by the built-in Todo reconciliation continuation prompt. */
export const TODO_CONTINUATION_REQUIRED_TOOL = "todo_write";

/**
 * Whether a Core stop reason can hand control to a Todo episode supervisor.
 * Workflow projections use the same predicate so they do not claim terminal
 * ownership before the supervisor has decided whether to continue or hand off.
 *
 * @public
 * @stability experimental v0.1
 */
function isTodoResumableStopReason(
  reason: string | undefined,
): reason is RunStopReason {
  return (
    reason !== undefined &&
    DEFAULT_RESUMABLE_STOP_REASONS.has(reason as RunStopReason)
  );
}

export interface TodoTerminalAuditOptions {
  /**
   * Terminal result from the run that just ended.
   */
  result: RunResult;
  /**
   * Events from the just-finished run. Used to detect external progress when an
   * explicit {@link hasProgress} signal is not supplied.
   */
  events?: readonly SparkwrightEvent[];
  /**
   * Whether the just-finished run made forward progress. When omitted, the
   * audit falls back to {@link hasExternalProgressEvidence} over `events` — a
   * write/edit/artifact signal. Read-only work produces none of those, so a
   * supervisor that also counts newly-completed ledger items (a bounded,
   * monotonic signal) should compute the combined verdict and pass it here so
   * an honest read-only investigation is not mistaken for a stall.
   */
  hasProgress?: boolean;
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
      directive: TodoDirective;
      prompt: string;
    }
  | {
      kind: "handoff";
      summary: TodoSummary;
      reason:
        | "unfinished_todo"
        | "non_resumable_stop_reason"
        | "continuation_limit"
        | "stalled_without_progress"
        | "required_tool_unavailable";
      message: string;
    };

/**
 * A mechanically-derived "what to do next" instruction for a continuation run,
 * computed from the ledger alone. It replaces the free-form prose that used to
 * carry this branching, so the variable part of the continuation prompt is
 * structured and unit-testable, and a new case is added as a union member
 * rather than as another accreting sentence. What the directive deliberately
 * does NOT decide — whether an open item's work is *actually* finished and just
 * unmarked — stays the model's judgment, expressed once as a fixed reconcile
 * instruction in {@link buildTodoContinuationPrompt}.
 *
 * @public
 * @stability experimental v0.1
 */
export type TodoDirective =
  | { kind: "next_open_item"; title: string }
  | { kind: "all_blocked"; titles: string[] };

/**
 * Derive the continuation directive from the ledger. Actionable items
 * (pending/in_progress) yield `next_open_item` pointing at the first one. If
 * every unfinished item is `blocked`, yield `all_blocked` instead — telling the
 * model to clear the blockers rather than spin trying to "act on the next item"
 * when none is actionable. Only meaningful when the ledger has unfinished items
 * (the audit returns `complete` otherwise).
 *
 * @public
 * @stability experimental v0.1
 */
export function computeTodoDirective(ledger: TodoLedger): TodoDirective {
  const actionable = ledger.items.find(
    (item) => item.status === "pending" || item.status === "in_progress",
  );
  if (actionable) {
    return { kind: "next_open_item", title: actionable.title };
  }
  const titles = ledger.items
    .filter((item) => item.status === "blocked")
    .map((item) => item.title);
  return { kind: "all_blocked", titles };
}

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

  const hasProgress =
    options.hasProgress ?? hasExternalProgressEvidence(options.events ?? []);
  const finalAnswerNeedsReconciliation =
    options.result.stopReason === "final_answer" &&
    summary.blocked === 0 &&
    hasProgress;
  const resumable =
    options.result.stopReason !== undefined &&
    ((options.resumableStopReasons
      ? options.resumableStopReasons.has(options.result.stopReason)
      : isTodoResumableStopReason(options.result.stopReason)) ||
      finalAnswerNeedsReconciliation);
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

  const directive = computeTodoDirective(ledger);
  return {
    kind: "continue",
    summary,
    reason: "unfinished_todo",
    directive,
    prompt: buildTodoContinuationPrompt(ledger, directive),
  };
}

/**
 * The directive injected as the final turn of a continuation. It is a
 * reconciliation checkpoint: the resumed run carries the full prior
 * conversation, so the model is told to first bring the list into line with
 * what it has already done, then either continue the next open item or — if
 * reconciling shows everything is done — finish. Wrapped in a
 * `<system-reminder>` block, whose authority is defined once in the resident
 * harness contract, so the model treats it as a runtime directive rather than
 * user input. Operating cadence ("when to use the list", "don't spin it") lives
 * in the durable system contract and is not restated here.
 *
 * @public @stability experimental v0.1
 */
export function buildTodoContinuationPrompt(
  ledger: TodoLedger,
  directive: TodoDirective = computeTodoDirective(ledger),
): string {
  const completed = ledger.items.filter((item) => item.status === "completed");
  const unfinished = unfinishedTodoItems(ledger);
  const doneLine = completed.length
    ? `Already completed: ${completed.map((i) => i.title).join("; ")}.`
    : "Nothing is marked completed yet.";
  const openLine = unfinished.length
    ? `Still open: ${unfinished.map((i) => i.title).join("; ")}.`
    : "No open items remain in the list.";
  // The one irreducible model-judgment instruction: only the model knows whether
  // an open item's work is actually done (and just unmarked) versus still
  // pending. Stated once, here — cadence ("when to touch the list") lives in the
  // durable todo_planning contract and is not restated.
  const reconcileLine = `First reconcile the list with what the conversation above already shows you finished: in a single ${TODO_CONTINUATION_REQUIRED_TOOL}, mark every item whose work is actually done as completed.`;
  // The variable "what next" branch, derived mechanically from the ledger.
  const directiveLine =
    directive.kind === "next_open_item"
      ? `Next open item: ${directive.title}. Act on it, then give your final answer once the work is genuinely complete. If reconciling alone already finished the list — every item was done and you did no new work this turn — do not restate the prior answer; say only that the Todo ledger is reconciled. Never say a background task or process is complete unless a task.completed observation is present in the conversation.`
      : `Every remaining item is blocked: ${directive.titles.join("; ")}. Resolve or surface the blockers — do not loop retrying them. If they cannot be cleared this turn, hand off with a one-line status.`;
  return [
    "<system-reminder>",
    "You are resuming an earlier turn because the todo list still has open items. The full conversation above is yours to build on — do not restart it.",
    doneLine,
    openLine,
    reconcileLine,
    directiveLine,
    "</system-reminder>",
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
    "task.started",
  ],
);

/** @public @stability experimental v0.1 */
export function hasExternalProgressEvidence(
  events: readonly SparkwrightEvent[],
): boolean {
  return events.some((event) => EXTERNAL_PROGRESS_EVENTS.has(event.type));
}

// Model-facing render is intentionally lean — just status + title. The model
// re-emits whatever shape it sees, so showing fat items (id, owner, evidence,
// done-when, note) led weak models to regenerate all of them every write,
// which both drifted the free-text fields (defeating the no-op guard) and made
// advancing a single status unreliable. The rich fields still live on disk.
function renderTodoLine(item: TodoItem): string {
  const prefix = "  ".repeat(Math.max(0, item.depth));
  return `${prefix}- ${item.status}: ${item.title}`;
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
