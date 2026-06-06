// AI maintenance note: Todo data model is intentionally simple — a flat list
// of TodoItems with a `depth` field that captures nesting. The serialized form
// is a GitHub-flavored Markdown checkbox list using a 6-state alphabet:
//
//   - [ ]            pending
//   - [ ] 🔄         in_progress
//   - [x]            completed
//   - [ ] ⛔         blocked
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
  | "blocked"
  | "failed"
  | "skipped";

export type TodoPriority = "high" | "medium" | "low";

export type TodoEvidence =
  | { kind: "file_changed"; path: string }
  | { kind: "command"; command: string; exitCode: number }
  | { kind: "test"; command: string; passed: boolean }
  | { kind: "artifact"; artifactId: string }
  | { kind: "trace_event"; eventId: string };

export type TodoOwner =
  | "primary"
  | "supervisor"
  | `subagent:${string}`
  | string;

/**
 * A single todo entry. `depth` is the indentation level (0 = top-level).
 * `note` is optional free-text shown after the title — typically a reason for
 * `failed`, `blocked`, or `skipped` items.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TodoItem {
  /**
   * Optional stable item id. Hosts should set this when they need to correlate
   * evidence or child-agent results across whole-file rewrites.
   */
  id?: string;
  /**
   * Human-readable task text. This remains the canonical field for backwards
   * compatibility with v0.1 callers.
   */
  title: string;
  /**
   * Alternative task-text field accepted from clients that send `content`
   * instead of `title`. Normalizers copy it into `title`; serializers emit
   * `title`.
   */
  content?: string;
  status: TodoStatus;
  depth: number;
  priority?: TodoPriority;
  doneWhen?: string;
  evidence?: TodoEvidence[];
  owner?: TodoOwner;
  note?: string;
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
  failed: number;
  skipped: number;
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
