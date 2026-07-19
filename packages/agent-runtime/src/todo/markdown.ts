// AI maintenance note: Markdown parser/serializer for the todo file format.
// Each line is one of: a checkbox item (`- [...] ...`), a blank line, or an
// unrecognized "comment" line. Comments are preserved verbatim through
// parse → serialize round-trips so callers can keep section headers etc.
//
// Parsing is line-based and forgiving: unknown markers degrade to `pending`,
// and indentation that isn't a multiple of TODO_INDENT_WIDTH rounds down.

import {
  TODO_INDENT_WIDTH,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
} from "./types.js";

const ITEM_PATTERN = /^(?<indent> *)- \[(?<box>[ x])\](?<rest>.*)$/;
const META_PATTERN = /^(?<indent> *)\s*(?<key>priority):\s*(?<value>.*)$/;

/**
 * Discriminated entry returned by {@link parseTodoMarkdown}. Comments and
 * blank lines are preserved alongside items so callers can re-serialize
 * without losing structure.
 *
 * @public
 * @stability experimental v0.1
 */
export type TodoEntry =
  | ({ kind: "item" } & TodoItem)
  | { kind: "comment"; text: string }
  | { kind: "blank" };

/**
 * Parse a todo markdown document. Unknown lines become `comment` entries and
 * survive round-trip. Lines that look like checkbox items but use unknown
 * markers degrade to `pending`.
 *
 * @public
 * @stability experimental v0.1
 */
export function parseTodoMarkdown(input: string): TodoEntry[] {
  const lines = input.split(/\r?\n/);
  // Drop a trailing empty line caused by a final newline so we don't emit
  // a spurious blank entry.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const entries: TodoEntry[] = [];
  let lastItem: ({ kind: "item" } & TodoItem) | undefined;
  for (const line of lines) {
    const item = parseItemLine(line);
    if (item) {
      entries.push(item);
      lastItem = item;
      continue;
    }

    if (lastItem) {
      const meta = parseMetadataLine(line);
      if (meta) {
        applyMetadata(lastItem, meta.key, meta.value);
        continue;
      }
    }

    entries.push(parseNonItemLine(line));
    if (line.trim().length !== 0) {
      lastItem = undefined;
    }
  }
  return entries;
}

function parseNonItemLine(line: string): TodoEntry {
  if (line.trim().length === 0) return { kind: "blank" };
  return { kind: "comment", text: line };
}

function parseItemLine(
  line: string,
): ({ kind: "item" } & TodoItem) | undefined {
  const match = ITEM_PATTERN.exec(line);
  if (!match || !match.groups) return undefined;
  const indent = match.groups.indent!.length;
  const depth = Math.floor(indent / TODO_INDENT_WIDTH);
  const box = match.groups.box!;
  const rest = match.groups.rest!.replace(/^\s+/, "");
  const { status, title } = decodeStatus(box, rest);
  return {
    kind: "item",
    title,
    status,
    depth,
  };
}

function parseMetadataLine(
  line: string,
): { key: string; value: string } | undefined {
  const match = META_PATTERN.exec(line);
  if (!match || !match.groups) return undefined;
  return {
    key: match.groups.key!,
    value: match.groups.value!.trim(),
  };
}

function applyMetadata(item: TodoItem, key: string, value: string): void {
  if (value.length === 0) return;
  switch (key) {
    case "priority":
      if (isTodoPriority(value)) item.priority = value;
      return;
  }
}

function isTodoPriority(value: string): value is TodoPriority {
  return value === "high" || value === "medium" || value === "low";
}

interface DecodedStatus {
  status: TodoStatus;
  title: string;
}

function decodeStatus(box: string, rest: string): DecodedStatus {
  if (box === "x") {
    return { status: "completed", title: rest.trim() };
  }
  // box === " " — distinguish pending / in_progress / blocked by marker.
  if (rest.startsWith("🔄")) {
    return {
      status: "in_progress",
      title: rest.slice("🔄".length).trim(),
    };
  }
  if (rest.startsWith("⛔")) {
    return { status: "blocked", title: rest.slice("⛔".length).trim() };
  }
  return { status: "pending", title: rest.trim() };
}

/**
 * Serialize a list of entries back into Markdown. Items are emitted in the
 * order supplied; the caller is responsible for ordering and depth.
 *
 * @public
 * @stability experimental v0.1
 */
export function serializeTodoMarkdown(entries: TodoEntry[]): string {
  const lines = entries.map((entry) => {
    if (entry.kind === "blank") return "";
    if (entry.kind === "comment") return entry.text;
    return serializeItem(entry);
  });
  return lines.join("\n") + "\n";
}

function serializeItem(item: { kind: "item" } & TodoItem): string {
  const pad = " ".repeat(Math.max(0, item.depth) * TODO_INDENT_WIDTH);
  const marker = markerFor(item.status);
  const lines = [`${pad}- ${marker} ${item.title}`.trimEnd()];
  const metaPad = `${pad}${" ".repeat(TODO_INDENT_WIDTH)}`;
  if (item.priority) lines.push(`${metaPad}priority: ${item.priority}`);
  return lines.join("\n");
}

function markerFor(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[ ] 🔄";
    case "blocked":
      return "[ ] ⛔";
    case "pending":
      return "[ ]";
  }
}

/**
 * Convenience: return only the {@link TodoItem} entries from a parsed
 * document, discarding comments and blanks. Useful for callers that don't
 * care about preserving layout.
 *
 * @public
 * @stability experimental v0.1
 */
export function itemsOnly(entries: TodoEntry[]): TodoItem[] {
  return entries
    .filter((e): e is { kind: "item" } & TodoItem => e.kind === "item")
    .map(({ title, status, depth, priority }) => ({
      title,
      status,
      depth,
      ...(priority ? { priority } : {}),
    }));
}
