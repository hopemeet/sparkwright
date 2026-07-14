interface PatchLine {
  kind: " " | "-" | "+";
  text: string;
}

interface PatchHunk {
  /** 1-based source start line from the `@@` header, used as a search hint. */
  oldStart: number;
  /** The hunk body in order, markers preserved. */
  body: PatchLine[];
  /** Lines expected in the source (context + removed), in order. */
  source: string[];
}

/**
 * Apply a unified diff to `content`, returning the patched content and the
 * number of hunks applied. Hunks are located in order from a running cursor;
 * each is matched first exactly, then with trailing-whitespace tolerance.
 * A hunk that matches nowhere throws — the tool never applies a partial or
 * guessed patch.
 */
export function applyUnifiedDiff(
  content: string,
  patch: string,
): { content: string; hunksApplied: number } {
  const hunks = parseUnifiedDiff(patch);
  if (hunks.length === 0) {
    throw new Error("patch contains no hunks.");
  }

  const { lines, trailingNewline } = toLines(content);
  let cursor = 0;
  let applied = 0;

  for (const hunk of hunks) {
    const at = locateHunk(lines, hunk, cursor);
    if (at === -1) {
      throw new Error(
        `Patch hunk near line ${hunk.oldStart} did not match the file.`,
      );
    }
    // Build the replacement, reusing the file's own context lines so a fuzzy
    // match never reformats an untouched line.
    const replacement: string[] = [];
    let srcPtr = at;
    for (const line of hunk.body) {
      if (line.kind === " ") {
        replacement.push(lines[srcPtr]);
        srcPtr += 1;
      } else if (line.kind === "-") {
        srcPtr += 1;
      } else {
        replacement.push(line.text);
      }
    }
    lines.splice(at, hunk.source.length, ...replacement);
    cursor = at + replacement.length;
    applied += 1;
  }

  return { content: fromLines(lines, trailingNewline), hunksApplied: applied };
}

function parseUnifiedDiff(patch: string): PatchHunk[] {
  const lines = patch.split("\n");
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;

  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      // The line range is only a search hint — hunks are located by context
      // (see locateHunk), so we do not require it. Models routinely emit a
      // bare "@@" (or the "*** Begin Patch / *** Update File" envelope) with no
      // ranges; accept that and fall back to scanning from the running cursor.
      const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
      current = {
        oldStart: match ? Number(match[1]) : 0,
        body: [],
        source: [],
      };
      hunks.push(current);
      continue;
    }
    // Ignore file headers and any preamble before the first hunk.
    if (!current) continue;
    if (raw.startsWith("---") || raw.startsWith("+++")) continue;

    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === " ") {
      current.body.push({ kind: " ", text });
      current.source.push(text);
    } else if (marker === "-") {
      current.body.push({ kind: "-", text });
      current.source.push(text);
    } else if (marker === "+") {
      current.body.push({ kind: "+", text });
    } else if (raw === "\\ No newline at end of file") {
      // Trailing-newline marker; ignored for matching purposes.
      continue;
    }
    // Any other line (including a bare empty line — canonical diffs encode a
    // blank context line as a single space) ends the current hunk's body.
    else {
      current = undefined;
    }
  }

  return hunks;
}

/**
 * Find where a hunk's source block sits in `lines`, scanning from `from`.
 * Pure-insertion hunks (no source lines) anchor at the header's hint line,
 * clamped to the cursor. Returns -1 when no acceptable location is found.
 */
function locateHunk(lines: string[], hunk: PatchHunk, from: number): number {
  if (hunk.source.length === 0) {
    // Pure insertion: `@@ -L,0 ... @@` inserts after 1-based line L, i.e. at
    // 0-based index L. Clamp into [cursor, end].
    return Math.max(from, Math.min(hunk.oldStart, lines.length));
  }

  const exact = findBlock(lines, hunk.source, from, false);
  if (exact !== -1) return exact;
  return findBlock(lines, hunk.source, from, true);
}

function findBlock(
  lines: string[],
  block: string[],
  from: number,
  fuzzy: boolean,
): number {
  const last = lines.length - block.length;
  for (let start = Math.max(0, from); start <= last; start += 1) {
    let matched = true;
    for (let i = 0; i < block.length; i += 1) {
      if (!linesEqual(lines[start + i], block[i], fuzzy)) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

function linesEqual(a: string, b: string, fuzzy: boolean): boolean {
  if (a === b) return true;
  return fuzzy && a.trimEnd() === b.trimEnd();
}

function toLines(content: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  if (content === "") return { lines: [], trailingNewline: false };
  const trailingNewline = content.endsWith("\n");
  const body = trailingNewline ? content.slice(0, -1) : content;
  return { lines: body.split("\n"), trailingNewline };
}

function fromLines(lines: string[], trailingNewline: boolean): string {
  const body = lines.join("\n");
  return trailingNewline && lines.length > 0 ? `${body}\n` : body;
}
