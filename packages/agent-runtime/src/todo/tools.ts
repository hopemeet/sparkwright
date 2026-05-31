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
import type { TodoItem, TodoStatus } from "./types.js";

const VALID_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "skipped",
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
      "Read the run's todo list. Returns the parsed items (status, depth, title, optional note).",
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

/** @public @stability experimental v0.1 */
export function createTodoWriteTool(
  options: CreateTodoToolsOptions,
): ToolDefinition {
  return defineTool({
    name: "todo_write",
    description:
      "Replace the run's todo list. Pass `items` (array of {title, status, depth, note?}). Child agents are denied this tool by policy.",
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
              depth: { type: "integer" },
              note: { type: "string" },
            },
            required: ["title", "status"],
          },
        },
      },
      required: ["items"],
    },
    deferLoading: false,
    // Write is a workspace mutation but not externally observable; the
    // policy layer should additionally restrict callers by agent role.
    policy: { risk: "risky", requiresApproval: false },
    governance: { sideEffects: ["write"] },
    async execute(args: unknown): Promise<{ written: number; path: string }> {
      const items = parseWriteArgs(args);
      const path = options.getTodoPath();
      const entries: TodoEntry[] = items.map((item) => ({
        kind: "item",
        ...item,
      }));
      const text = serializeTodoMarkdown(entries);
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
  if (typeof r.title !== "string" || r.title.length === 0) {
    throw new Error(
      `todo_write: items[${index}].title must be a non-empty string.`,
    );
  }
  if (
    typeof r.status !== "string" ||
    !VALID_STATUSES.has(r.status as TodoStatus)
  ) {
    throw new Error(
      `todo_write: items[${index}].status must be one of: ${[...VALID_STATUSES].join(", ")}`,
    );
  }
  const depth =
    typeof r.depth === "number" && Number.isInteger(r.depth) && r.depth >= 0
      ? r.depth
      : 0;
  const note = typeof r.note === "string" ? r.note : undefined;
  return {
    title: r.title,
    status: r.status as TodoStatus,
    depth,
    ...(note ? { note } : {}),
  };
}
