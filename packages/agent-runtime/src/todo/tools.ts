// AI maintenance note: Two ToolDefinitions backing the Leader-single-writer
// todo file. The tool surface is intentionally minimal: read returns parsed
// items, write replaces the entire file. The Leader does whole-file rewrites
// per the design (no per-item mutation API) — this keeps the file diff-clean
// and avoids racing whole-file writes against partial edits.
//
// Access control: child agents are denied todo_write at the policy layer via
// `CapabilityRule` (action: "tool.execute", resource: "todo_write",
// effect: "deny"). The tool itself does not gate by role — the policy is
// the authority. See test/todo.test.ts for the wiring example.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool, type ToolDefinition } from "@sparkwright/core";
import {
  itemsOnly,
  parseTodoMarkdown,
  serializeTodoMarkdown,
  type TodoEntry,
} from "./markdown.js";
import type {
  TodoEvidence,
  TodoItem,
  TodoPriority,
  TodoStatus,
} from "./types.js";

const VALID_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "failed",
  "skipped",
]);

// Models routinely reach for status words from other todo systems (the very
// first observed run failed `todo_write` with `status: "todo"`). Accept the
// common synonyms case-insensitively and map them onto the canonical alphabet
// instead of rejecting the whole write. Anything still unrecognized errors so
// genuine typos are not silently coerced.
const STATUS_ALIASES: ReadonlyMap<string, TodoStatus> = new Map([
  ["todo", "pending"],
  ["to_do", "pending"],
  ["to-do", "pending"],
  ["open", "pending"],
  ["not_started", "pending"],
  ["incomplete", "pending"],
  ["doing", "in_progress"],
  ["in-progress", "in_progress"],
  ["inprogress", "in_progress"],
  ["wip", "in_progress"],
  ["active", "in_progress"],
  ["done", "completed"],
  ["complete", "completed"],
  ["completed", "completed"],
  ["finished", "completed"],
  ["cancelled", "skipped"],
  ["canceled", "skipped"],
  ["skip", "skipped"],
  ["error", "failed"],
  ["blocked_on", "blocked"],
]);

/**
 * Normalize a free-form status string to the canonical {@link TodoStatus}
 * alphabet, accepting common synonyms case-insensitively. Returns `undefined`
 * for anything still unrecognized.
 */
function normalizeStatus(raw: unknown): TodoStatus | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim().toLowerCase();
  if (VALID_STATUSES.has(key as TodoStatus)) return key as TodoStatus;
  return STATUS_ALIASES.get(key);
}
const VALID_PRIORITIES: ReadonlySet<TodoPriority> = new Set([
  "high",
  "medium",
  "low",
]);

/**
 * Options for {@link createTodoWriteTool}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface CreateTodoToolsOptions {
  /**
   * Resolver for the todo file's absolute path. Called on every invocation
   * so a single tool bundle can serve many runs.
   */
  getTodoPath(): string;
  /**
   * Optional run-scoped call budget. The todo ledger is bookkeeping, not the
   * work itself; a run that keeps calling todo_write after this limit should
   * stop updating the list and answer or use a concrete non-todo tool.
   */
  maxWritesPerRun?: number;
}

/**
 * Build the todo tool bundle backed by a single markdown file. Only the write
 * tool is exposed to the model: every write returns the updated list and how
 * many items remain, so there is no need for a separate read tool (which a weak
 * model otherwise burns calls re-fetching state already in its context). The
 * supervisor reads the ledger from disk through its own helper, not this tool.
 *
 * @public
 * @stability experimental v0.1
 */
export function createTodoTools(options: CreateTodoToolsOptions): {
  todoWrite: ToolDefinition;
  all(): ToolDefinition[];
} {
  const todoWrite = createTodoWriteTool(options);
  return { todoWrite, all: () => [todoWrite] };
}

/**
 * After this many consecutive no-op writes (byte-identical ledger), the tool
 * starts returning a nudge in its result. Weak models can get stuck rewriting
 * the ledger instead of doing the next task; the no-op guard makes those cheap,
 * and this tells the model to stop and act.
 */
const NOOP_CHURN_THRESHOLD = 1;

/** @public @stability experimental v0.1 */
export function createTodoWriteTool(
  options: CreateTodoToolsOptions,
): ToolDefinition {
  // Per-tool-instance (per run-chain) counter of consecutive no-op writes,
  // reset on any write that actually changes the ledger.
  let consecutiveNoops = 0;
  const writesByRun = new Map<string, number>();
  return defineTool({
    name: "todo_write",
    description: [
      "Create and maintain the run's todo list — a short checklist that tracks multi-step work and shows progress. Each call replaces the whole list, so pass every task, in order, every time.",
      "Use this for work with at least three substantive dependent steps, multiple phases, or recovery that benefits from a durable checklist. Do not create a todo list for a simple one-file change, a single command, or merely because a background process runs for a long time.",
      "Each item has a `title` and a `status` (one of: pending, in_progress, completed, blocked, failed, skipped; synonyms like 'todo'/'done' are accepted). Keep at most one item in_progress at a time.",
      "Use in_progress for the current active item, and completed only when its work is actually finished — based on real results, never on intent, and never by loosening what counts as done. Never mark an item completed before its result is in.",
      "Child agents may not call this tool.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              status: { type: "string" },
              priority: { type: "string" },
            },
            required: ["status"],
          },
        },
      },
      required: ["items"],
    },
    deferLoading: false,
    // The ledger is internal session bookkeeping (.sparkwright/sessions/<id>/
    // todo.md), not a user-facing workspace mutation — like a trace write. It
    // is therefore NOT approval-gated: declaring sideEffects:["write"] made the
    // governance policy prompt on every call, so a model that rewrote the
    // ledger N times produced N approval prompts. `sideEffects:["none"]` keeps
    // it unprompted. Child agents are still denied todo_write by a separate
    // CapabilityRule on the resource, preserving the single-writer model.
    policy: { risk: "safe", requiresApproval: false },
    // `idempotency: "idempotent"` exempts todo_write from the generic doom-loop
    // repeat guard in core's run loop: a byte-identical rewrite is a harmless
    // no-op handled by this tool's own no-op guard (below), not the start of a
    // doom loop. Without this, a benign duplicate ledger write (e.g. the model
    // restating the plan) tripped REPEATED_TOOL_CALL_SKIPPED and burned a turn.
    governance: { sideEffects: ["none"], idempotency: "idempotent" },
    async execute(args: unknown, ctx): Promise<TodoWriteResult> {
      const runId = ctx.run?.id ?? "__standalone__";
      const items = parseWriteArgs(args);
      const path = options.getTodoPath();
      const entries: TodoEntry[] = items.map((item) => ({
        kind: "item",
        ...item,
      }));
      const text = serializeTodoMarkdown(entries);
      const echo = renderWriteEcho(items);
      // No-op guard: a rewrite that produces byte-identical content is wasted
      // work (observed: a stuck model rewrote the same 3 items ~70 times). Skip
      // the disk write and report it so the result reads as a no-op rather than
      // progress.
      const current = await safeRead(path);
      if (current === text) {
        consecutiveNoops += 1;
        const result: TodoWriteResult = { ...echo, saved: false };
        if (consecutiveNoops >= NOOP_CHURN_THRESHOLD) {
          // Anti-churn nudge: stop rewriting the unchanged list and make real
          // progress instead. Surfaced in the tool result the model observes.
          result.hint =
            "The list is unchanged from your last write — calling todo_write again accomplishes nothing. Take the next concrete action on the first unfinished item (read a file, run a command, produce output), or, if every item is genuinely done, give your final answer.";
        }
        return result;
      }
      if (options.maxWritesPerRun !== undefined) {
        const nextCount = (writesByRun.get(runId) ?? 0) + 1;
        if (nextCount > options.maxWritesPerRun) {
          const currentItems = itemsOnly(parseTodoMarkdown(current));
          return {
            ...renderWriteEcho(currentItems),
            saved: false,
            rejectedTodos: echo.todos,
            hint:
              `todo_write changed too many times in this run (limit: ${options.maxWritesPerRun}). ` +
              "The proposed update was not saved; todos reflects the current ledger. Do not update the ledger again. Take a concrete non-todo action on the current task, or give your final answer with the current status.",
          };
        }
        writesByRun.set(runId, nextCount);
      }
      consecutiveNoops = 0;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
      return { ...echo, saved: true };
    },
  });
}

/**
 * The result the model observes after a write. It echoes the resulting list and
 * the remaining count so the model always sees current state without a separate
 * read — the single biggest lever for getting a weak model to actually advance
 * item statuses instead of re-deriving or spinning the list.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TodoWriteResult {
  /**
   * Whether this write changed the list on disk (false = byte-identical no-op
   * or rejected proposed update).
   *
   * @reserved Public tool-result field consumed by the model reading the
   * serialized todo_write result, not by an in-process TS reader.
   */
  saved: boolean;
  /** One-line progress summary, e.g. "1/3 done — remaining: List scripts, Pick test". */
  summary: string;
  total: number;
  completed: number;
  /**
   * Count of items still open (not completed/skipped/failed).
   *
   * @reserved Public tool-result field consumed by the model reading the
   * serialized todo_write result, not by an in-process TS reader.
   */
  remaining: number;
  /**
   * The current resulting list, lean (title + status) so the model re-emits lean
   * items. When saved is false because a proposed update was rejected, this
   * remains the committed ledger rather than the rejected proposal.
   *
   * @reserved Public tool-result field consumed by the model reading the
   * serialized todo_write result, not by an in-process TS reader.
   */
  todos: { title: string; status: TodoStatus }[];
  /**
   * Rejected proposed list, present only when saved:false rejected a change.
   *
   * @reserved Public tool-result field consumed by the model reading the
   * serialized todo_write result, not by an in-process TS reader.
   */
  rejectedTodos?: { title: string; status: TodoStatus }[];
  /** Anti-churn nudge, present only after repeated no-op writes. */
  hint?: string;
}

const DONE_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "completed",
  "skipped",
  "failed",
]);

function renderWriteEcho(
  items: TodoItem[],
): Omit<TodoWriteResult, "saved" | "hint"> {
  const todos = items.map((item) => ({
    title: item.title,
    status: item.status,
  }));
  const total = items.length;
  const completed = items.filter((item) => item.status === "completed").length;
  const open = items.filter((item) => !DONE_STATUSES.has(item.status));
  const remaining = open.length;
  const summary =
    remaining === 0
      ? `All ${total} item(s) done.`
      : `${completed}/${total} done — remaining: ${open.map((i) => i.title).join(", ")}`;
  return { summary, total, completed, remaining, todos };
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

function parseWriteArgs(args: unknown): TodoItem[] {
  if (typeof args !== "object" || args === null) {
    throw new Error("todo_write: arguments must be an object.");
  }
  const record = args as Record<string, unknown>;
  if (!Array.isArray(record.items)) {
    throw new Error("todo_write: items must be an array.");
  }
  return record.items.map((raw, index) => normalizeItem(raw, index));
}

function normalizeItem(raw: unknown, index: number): TodoItem {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`todo_write: items[${index}] must be an object.`);
  }
  const r = raw as Record<string, unknown>;
  const title =
    typeof r.title === "string" && r.title.trim().length > 0
      ? r.title.trim()
      : typeof r.content === "string" && r.content.trim().length > 0
        ? r.content.trim()
        : undefined;
  if (!title) {
    throw new Error(
      `todo_write: items[${index}] must include non-empty title or content.`,
    );
  }
  const status = normalizeStatus(r.status);
  if (!status) {
    throw new Error(
      `todo_write: items[${index}].status must be one of: ${[...VALID_STATUSES].join(", ")}`,
    );
  }
  const depth =
    typeof r.depth === "number" && Number.isInteger(r.depth) && r.depth >= 0
      ? r.depth
      : 0;
  const id =
    typeof r.id === "string" && r.id.trim().length > 0
      ? r.id.trim()
      : undefined;
  const priority =
    typeof r.priority === "string" &&
    VALID_PRIORITIES.has(r.priority as TodoPriority)
      ? (r.priority as TodoPriority)
      : undefined;
  const doneWhen =
    typeof r.doneWhen === "string" && r.doneWhen.trim().length > 0
      ? r.doneWhen.trim()
      : undefined;
  const evidence = Array.isArray(r.evidence)
    ? r.evidence.map(normalizeEvidence).filter((e): e is TodoEvidence => !!e)
    : undefined;
  const owner =
    typeof r.owner === "string" && r.owner.trim().length > 0
      ? r.owner.trim()
      : undefined;
  const note = typeof r.note === "string" ? r.note : undefined;
  return {
    ...(id ? { id } : {}),
    title,
    ...(typeof r.content === "string" ? { content: r.content } : {}),
    status,
    depth,
    ...(priority ? { priority } : {}),
    ...(doneWhen ? { doneWhen } : {}),
    ...(evidence && evidence.length > 0 ? { evidence } : {}),
    ...(owner ? { owner } : {}),
    ...(note ? { note } : {}),
  };
}

function normalizeEvidence(raw: unknown): TodoEvidence | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "file_changed":
      return typeof r.path === "string" && r.path.length > 0
        ? { kind: "file_changed", path: r.path }
        : undefined;
    case "command":
      return typeof r.command === "string" && typeof r.exitCode === "number"
        ? { kind: "command", command: r.command, exitCode: r.exitCode }
        : undefined;
    case "test":
      return typeof r.command === "string" && typeof r.passed === "boolean"
        ? { kind: "test", command: r.command, passed: r.passed }
        : undefined;
    case "artifact":
      return typeof r.artifactId === "string" && r.artifactId.length > 0
        ? { kind: "artifact", artifactId: r.artifactId }
        : undefined;
    case "trace_event":
      return typeof r.eventId === "string" && r.eventId.length > 0
        ? { kind: "trace_event", eventId: r.eventId }
        : undefined;
  }
  return undefined;
}
