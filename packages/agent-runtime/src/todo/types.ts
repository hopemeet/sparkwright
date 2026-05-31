// AI maintenance note: Todo data model is intentionally simple — a flat list
// of TodoItems with a `depth` field that captures nesting. The serialized form
// is a GitHub-flavored Markdown checkbox list using a 5-state alphabet:
//
//   - [ ]            pending
//   - [ ] 🔄         in_progress
//   - [x]            completed
//   - [ ] ❌         failed
//   - [~]            skipped (cancelled / no-op)
//
// `[x]` and `[ ]` round-trip through GFM checkbox renderers cleanly. The emoji
// suffixes (`🔄`, `❌`) are GFM-tolerant: renderers treat them as ordinary
// trailing text. `[~]` is non-standard but renders harmlessly as a bullet.

/**
 * Lifecycle states for a todo item. Maps 1:1 to a marker in the serialized
 * Markdown checkbox.
 *
 * @public
 * @stability experimental v0.1
 */
export type TodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";

/**
 * A single todo entry. `depth` is the indentation level (0 = top-level).
 * `note` is optional free-text shown after the title — typically a reason for
 * `failed` or `skipped` items.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TodoItem {
  title: string;
  status: TodoStatus;
  depth: number;
  note?: string;
}

/**
 * Indentation (in spaces) representing one nesting level. Two spaces per
 * level keeps lines short and lines up with the default Markdown bullet.
 *
 * @public
 * @stability experimental v0.1
 */
export const TODO_INDENT_WIDTH = 2;
