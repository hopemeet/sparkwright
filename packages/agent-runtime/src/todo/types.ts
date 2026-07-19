// AI maintenance note: Todo data model is intentionally simple — a flat list
// of TodoItems with a `depth` field that captures nesting. The serialized form
// is a GitHub-flavored Markdown checkbox list using a 4-state alphabet:
//
//   - [ ]            pending
//   - [ ] 🔄         in_progress
//   - [x]            completed
//   - [ ] ⛔         blocked
//
// `[x]` and `[ ]` round-trip through GFM checkbox renderers cleanly. The
// `🔄` suffix is GFM-tolerant and renders as ordinary trailing text.

/**
 * Lifecycle states for a todo item. Maps 1:1 to a marker in the serialized
 * Markdown checkbox.
 *
 * @public
 * @stability experimental v0.1
 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";

export type TodoPriority = "high" | "medium" | "low";

/**
 * A single todo entry. `depth` is the indentation level (0 = top-level).
 * `depth` preserves nested Markdown presentation; scheduling never reads it.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TodoItem {
  /**
   * Human-readable task text.
   */
  title: string;
  status: TodoStatus;
  depth: number;
  priority?: TodoPriority;
}

export interface TodoLedger {
  schemaVersion: "todo-ledger.v1";
  items: TodoItem[];
  metadata: Record<string, unknown>;
}

export interface TodoSummary {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  blocked: number;
  unfinished: number;
  hasUnfinished: boolean;
}

/**
 * Indentation (in spaces) representing one nesting level. Two spaces per
 * level keeps lines short and lines up with the default Markdown bullet.
 *
 * @public
 * @stability experimental v0.1
 */
export const TODO_INDENT_WIDTH = 2;
