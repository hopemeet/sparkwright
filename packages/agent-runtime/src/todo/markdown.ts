// AI maintenance note: Markdown parser/serializer for the todo file format.
// Each line is one of: a checkbox item (`- [...] ...`), a blank line, or an
// unrecognized "comment" line. Comments are preserved verbatim through
// parse → serialize round-trips so callers can keep section headers etc.
//
// Parsing is line-based and forgiving: unknown markers degrade to `pending`,
// and indentation that isn't a multiple of TODO_INDENT_WIDTH rounds down.

import {
  TODO_INDENT_WIDTH,
  type TodoEvidence,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
} from "./types.js";

const ITEM_PATTERN = /^(?<indent> *)- \[(?<box>[ x~])\](?<rest>.*)$/;
const META_PATTERN =
  /^(?<indent> *)\s*(?<key>id|priority|done-when|owner|note):\s*(?<value>.*)$/;
const EVIDENCE_HEADER_PATTERN = /^(?<indent> *)\s*evidence:\s*$/;
const EVIDENCE_ITEM_PATTERN =
  /^(?<indent> *)\s*-\s*(?<kind>file_changed|command|test|artifact|trace_event):\s*(?<value>.*)$/;

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
  let inEvidenceBlock = false;
  for (const line of lines) {
    const item = parseItemLine(line);
    if (item) {
      entries.push(item);
      lastItem = item;
      inEvidenceBlock = false;
      continue;
    }

    if (lastItem) {
      const meta = parseMetadataLine(line);
      if (meta) {
        applyMetadata(lastItem, meta.key, meta.value);
        inEvidenceBlock = false;
        continue;
      }
      if (EVIDENCE_HEADER_PATTERN.test(line)) {
        if (!lastItem.evidence) lastItem.evidence = [];
        inEvidenceBlock = true;
        continue;
      }
      if (inEvidenceBlock) {
        const evidence = parseEvidenceLine(line);
        if (evidence) {
          lastItem.evidence = [...(lastItem.evidence ?? []), evidence];
          continue;
        }
      }
    }

    entries.push(parseNonItemLine(line));
    if (line.trim().length !== 0) {
      lastItem = undefined;
      inEvidenceBlock = false;
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
  const { status, title, note } = decodeStatus(box, rest);
  return {
    kind: "item",
    title,
    status,
    depth,
    ...(note ? { note } : {}),
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

function parseEvidenceLine(line: string): TodoEvidence | undefined {
  const match = EVIDENCE_ITEM_PATTERN.exec(line);
  if (!match || !match.groups) return undefined;
  return decodeEvidence(match.groups.kind!, match.groups.value!.trim());
}

function applyMetadata(item: TodoItem, key: string, value: string): void {
  if (value.length === 0) return;
  switch (key) {
    case "id":
      item.id = value;
      return;
    case "priority":
      if (isTodoPriority(value)) item.priority = value;
      return;
    case "done-when":
      item.doneWhen = value;
      return;
    case "owner":
      item.owner = value;
      return;
    case "note":
      item.note = value;
      return;
  }
}

function isTodoPriority(value: string): value is TodoPriority {
  return value === "high" || value === "medium" || value === "low";
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
  if (rest.startsWith("⛔")) {
    return splitTitleNote(rest.slice("⛔".length).trimStart(), "blocked");
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
  const lines = [`${pad}- ${marker} ${item.title}${tail}`.trimEnd()];
  const metaPad = `${pad}${" ".repeat(TODO_INDENT_WIDTH)}`;
  if (item.id) lines.push(`${metaPad}id: ${item.id}`);
  if (item.priority) lines.push(`${metaPad}priority: ${item.priority}`);
  if (item.doneWhen) lines.push(`${metaPad}done-when: ${item.doneWhen}`);
  if (item.owner) lines.push(`${metaPad}owner: ${item.owner}`);
  if (item.evidence && item.evidence.length > 0) {
    lines.push(`${metaPad}evidence:`);
    for (const evidence of item.evidence) {
      lines.push(
        `${metaPad}${" ".repeat(TODO_INDENT_WIDTH)}- ${encodeEvidence(evidence)}`,
      );
    }
  }
  return lines.join("\n");
}

function markerFor(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "skipped":
      return "[~]";
    case "in_progress":
      return "[ ] 🔄";
    case "blocked":
      return "[ ] ⛔";
    case "failed":
      return "[ ] ❌";
    case "pending":
      return "[ ]";
  }
}

function encodeEvidence(evidence: TodoEvidence): string {
  switch (evidence.kind) {
    case "file_changed":
      return `file_changed: ${evidence.path}`;
    case "command":
      return `command: ${evidence.command} (exit ${evidence.exitCode})`;
    case "test":
      return `test: ${evidence.command} (${evidence.passed ? "passed" : "failed"})`;
    case "artifact":
      return `artifact: ${evidence.artifactId}`;
    case "trace_event":
      return `trace_event: ${evidence.eventId}`;
  }
}

function decodeEvidence(kind: string, value: string): TodoEvidence | undefined {
  switch (kind) {
    case "file_changed":
      return value ? { kind, path: value } : undefined;
    case "command": {
      const match = /^(?<command>.*)\s+\(exit (?<exitCode>-?\d+)\)$/.exec(
        value,
      );
      if (!match || !match.groups) return undefined;
      return {
        kind,
        command: match.groups.command!.trim(),
        exitCode: Number(match.groups.exitCode),
      };
    }
    case "test": {
      const match = /^(?<command>.*)\s+\((?<status>passed|failed)\)$/.exec(
        value,
      );
      if (!match || !match.groups) return undefined;
      return {
        kind,
        command: match.groups.command!.trim(),
        passed: match.groups.status === "passed",
      };
    }
    case "artifact":
      return value ? { kind, artifactId: value } : undefined;
    case "trace_event":
      return value ? { kind, eventId: value } : undefined;
  }
  return undefined;
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
    .map(
      ({
        id,
        title,
        status,
        depth,
        priority,
        doneWhen,
        evidence,
        owner,
        note,
      }) => ({
        ...(id ? { id } : {}),
        title,
        status,
        depth,
        ...(priority ? { priority } : {}),
        ...(doneWhen ? { doneWhen } : {}),
        ...(evidence && evidence.length > 0 ? { evidence } : {}),
        ...(owner ? { owner } : {}),
        ...(note ? { note } : {}),
      }),
    );
}
