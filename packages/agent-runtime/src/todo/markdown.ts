// AI maintenance note: Markdown parser/serializer for the todo file format.
// Each line is one of: a checkbox item (`- [...] ...`), a blank line, or an
// unrecognized "comment" line. Comments are preserved verbatim through
// parse → serialize round-trips so callers can keep section headers etc.
//
// Parsing is line-based and forgiving: unknown markers degrade to `pending`,
// and indentation that isn't a multiple of TODO_INDENT_WIDTH rounds down.

import { TODO_INDENT_WIDTH, type TodoItem, type TodoStatus } from "./types.js";

const ITEM_PATTERN = /^(?<indent> *)- \[(?<box>[ x~])\](?<rest>.*)$/;

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
  return lines.map(parseLine);
}

function parseLine(line: string): TodoEntry {
  if (line.trim().length === 0) return { kind: "blank" };
  const match = ITEM_PATTERN.exec(line);
  if (!match || !match.groups) return { kind: "comment", text: line };
  const indent = match.groups.indent!.length;
  const depth = Math.floor(indent / TODO_INDENT_WIDTH);
  const box = match.groups.box!;
  const rest = match.groups.rest!.replace(/^\s+/, "");
  const { status, title, note } = decodeStatus(box, rest);
  return {
    kind: "item",
    title,
    status,
    depth,
    ...(note ? { note } : {}),
  };
}

interface DecodedStatus {
  status: TodoStatus;
  title: string;
  note?: string;
}

function decodeStatus(box: string, rest: string): DecodedStatus {
  if (box === "x") {
    return splitTitleNote(rest, "completed");
  }
  if (box === "~") {
    return splitTitleNote(rest, "skipped");
  }
  // box === " " — distinguish pending / in_progress / failed by the leading
  // emoji marker.
  if (rest.startsWith("🔄")) {
    return splitTitleNote(rest.slice("🔄".length).trimStart(), "in_progress");
  }
  if (rest.startsWith("❌")) {
    return splitTitleNote(rest.slice("❌".length).trimStart(), "failed");
  }
  return splitTitleNote(rest, "pending");
}

function splitTitleNote(rest: string, status: TodoStatus): DecodedStatus {
  // Optional parenthetical note at the end, e.g. "Step 3 (skipped per spec)".
  const noteMatch = /^(?<title>.*?)\s*\((?<note>[^)]*)\)\s*$/.exec(rest);
  if (noteMatch && noteMatch.groups) {
    return {
      status,
      title: noteMatch.groups.title!.trim(),
      note: noteMatch.groups.note!.trim(),
    };
  }
  return { status, title: rest.trim() };
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
  const tail = item.note ? ` (${item.note})` : "";
  return `${pad}- ${marker} ${item.title}${tail}`.trimEnd();
}

function markerFor(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "skipped":
      return "[~]";
    case "in_progress":
      return "[ ] 🔄";
    case "failed":
      return "[ ] ❌";
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
    .map(({ title, status, depth, note }) => ({
      title,
      status,
      depth,
      ...(note ? { note } : {}),
    }));
}
