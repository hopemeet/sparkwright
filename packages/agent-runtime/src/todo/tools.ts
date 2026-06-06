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
 * Options shared by {@link createTodoReadTool} and {@link createTodoWriteTool}.
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
}

/**
 * Build the read + write tool pair backed by a single markdown file.
 *
 * @public
 * @stability experimental v0.1
 */
export function createTodoTools(options: CreateTodoToolsOptions): {
  todoRead: ToolDefinition;
  todoWrite: ToolDefinition;
  all(): ToolDefinition[];
} {
  const todoRead = createTodoReadTool(options);
  const todoWrite = createTodoWriteTool(options);
  return { todoRead, todoWrite, all: () => [todoRead, todoWrite] };
}

/** @public @stability experimental v0.1 */
export function createTodoReadTool(
  options: CreateTodoToolsOptions,
): ToolDefinition {
  return defineTool({
    name: "todo_read",
    description:
      "Read the run's todo ledger. Returns parsed items with status, depth, title, evidence, and optional metadata.",
    inputSchema: { type: "object", properties: {} },
    deferLoading: false,
    policy: { risk: "safe", requiresApproval: false },
    governance: { sideEffects: ["read"] },
    async execute(): Promise<{ items: TodoItem[]; raw: string }> {
      const raw = await safeRead(options.getTodoPath());
      const entries = parseTodoMarkdown(raw);
      return { items: itemsOnly(entries), raw };
    },
  });
}

/**
 * After this many consecutive no-op writes (byte-identical ledger), the tool
 * starts returning a nudge in its result. Weak models can get stuck rewriting
 * the ledger instead of doing the next task; the no-op guard makes those cheap,
 * and this tells the model to stop and act.
 */
const NOOP_CHURN_THRESHOLD = 2;

/** @public @stability experimental v0.1 */
export function createTodoWriteTool(
  options: CreateTodoToolsOptions,
): ToolDefinition {
  // Per-tool-instance (per run-chain) counter of consecutive no-op writes,
  // reset on any write that actually changes the ledger.
  let consecutiveNoops = 0;
  return defineTool({
    name: "todo_write",
    description:
      "Replace the run's todo ledger. Pass `items` (array of {title/content, status, depth?, priority?, doneWhen?, evidence?, owner?, note?}). `status` must be one of: pending, in_progress, completed, blocked, failed, skipped (common synonyms like 'todo'/'done' are accepted). `depth` is 0 for a top-level item; use depth>0 ONLY for a genuine sub-task nested under the item above it — sequential steps of one plan are all depth 0, not 0/1/2/3. Only mark an item completed when its done-when is actually satisfied — do not relax done-when to claim completion. Child agents are denied this tool by policy.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              content: { type: "string" },
              status: { type: "string" },
              depth: { type: "integer" },
              id: { type: "string" },
              priority: { type: "string" },
              doneWhen: { type: "string" },
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    kind: { type: "string" },
                    path: { type: "string" },
                    command: { type: "string" },
                    exitCode: { type: "integer" },
                    passed: { type: "boolean" },
                    artifactId: { type: "string" },
                    eventId: { type: "string" },
                  },
                  required: ["kind"],
                },
              },
              owner: { type: "string" },
              note: { type: "string" },
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
    governance: { sideEffects: ["none"] },
    async execute(args: unknown): Promise<{
      written: number;
      path: string;
      noop?: boolean;
      hint?: string;
    }> {
      const items = parseWriteArgs(args);
      const path = options.getTodoPath();
      const entries: TodoEntry[] = items.map((item) => ({
        kind: "item",
        ...item,
      }));
      const text = serializeTodoMarkdown(entries);
      // No-op guard: a rewrite that produces byte-identical content is wasted
      // work (observed: a stuck model rewrote the same 3 items ~70 times). Skip
      // the disk write and report it so the result reads as a no-op rather than
      // progress.
      const current = await safeRead(path);
      if (current === text) {
        consecutiveNoops += 1;
        const result: {
          written: number;
          path: string;
          noop: true;
          hint?: string;
        } = { written: items.length, path, noop: true };
        if (consecutiveNoops >= NOOP_CHURN_THRESHOLD) {
          // Anti-churn nudge: stop rewriting the unchanged ledger and make real
          // progress instead. Surfaced in the tool result the model observes.
          result.hint =
            "The todo ledger is unchanged from your last write(s). Stop calling todo_write and take the next concrete action toward the first unfinished item (read a file, run a command, or write output) — or, if every item is genuinely done, give your final answer.";
        }
        return result;
      }
      consecutiveNoops = 0;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
      return { written: items.length, path };
    },
  });
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
