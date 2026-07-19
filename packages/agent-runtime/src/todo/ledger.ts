import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createContextItemId, type ContextItem } from "@sparkwright/core";
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
 * unfinished: it requires user attention before the task is done.
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
    `total=${summary.total} completed=${summary.completed} unfinished=${summary.unfinished} blocked=${summary.blocked}`,
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
