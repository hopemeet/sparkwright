import { createHash } from "node:crypto";

export const ANCHORED_EDIT_HASH_ALGORITHM = "sparkwright-line-v1";

export interface AnchoredLine {
  line: number;
  anchor: string;
  hash: string;
  content: string;
}

export interface AnchoredText {
  path: string;
  anchorSetId: string;
  lineCount: number;
  content: string;
  lines: AnchoredLine[];
  metadata: Record<string, unknown>;
}

export type AnchoredEditOperation =
  | { op: "replace"; anchor: string; lines: string[] }
  | { op: "delete"; anchor: string }
  | { op: "append"; anchor: string; lines: string[] }
  | { op: "prepend"; anchor: string; lines: string[] };

export interface ApplyAnchoredEditsInput {
  path: string;
  content: string;
  edits: AnchoredEditOperation[];
}

export interface ApplyAnchoredEditsResult {
  content: string;
  anchors: Array<{
    anchor: string;
    line: number;
    op: AnchoredEditOperation["op"];
  }>;
}

export class AnchoredEditError extends Error {
  readonly code: string;
  readonly metadata: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AnchoredEditError";
    this.code = code;
    this.metadata = metadata;
  }
}

export function createAnchoredText(
  path: string,
  content: string,
): AnchoredText {
  const parsed = splitText(content);
  const lines = parsed.lines.map((line, index) => {
    const lineNumber = index + 1;
    const hash = hashLine(line);
    return {
      line: lineNumber,
      anchor: formatAnchor(lineNumber, hash),
      hash,
      content: line,
    };
  });

  return {
    path,
    anchorSetId: `anchors_${hashText(`${path}\n${content}`).slice(0, 16)}`,
    lineCount: lines.length,
    content: lines.map((line) => `${line.anchor}| ${line.content}`).join("\n"),
    lines,
    metadata: {
      fileHash: `sha256:${hashText(content)}`,
      hashAlgorithm: ANCHORED_EDIT_HASH_ALGORITHM,
      newline: parsed.newline,
      trailingNewline: parsed.trailingNewline,
    },
  };
}

export function applyAnchoredEdits(
  input: ApplyAnchoredEditsInput,
): ApplyAnchoredEditsResult {
  if (input.edits.length === 0) {
    throw new AnchoredEditError(
      "ANCHOR_EDIT_EMPTY",
      "At least one anchored edit is required.",
      { path: input.path },
    );
  }

  const parsed = splitText(input.content);
  const changes = new Map<
    number,
    {
      prepend: string[];
      append: string[];
      replace?: string[];
      delete?: boolean;
    }
  >();
  const seenAnchors = new Set<string>();
  const verified: ApplyAnchoredEditsResult["anchors"] = [];

  for (const edit of input.edits) {
    if (seenAnchors.has(edit.anchor)) {
      throw new AnchoredEditError(
        "ANCHOR_DUPLICATE_EDIT",
        `Multiple edits reference the same anchor: ${edit.anchor}`,
        { path: input.path, anchor: edit.anchor },
      );
    }
    seenAnchors.add(edit.anchor);

    const parsedAnchor = parseAnchor(edit.anchor);
    const lineIndex = parsedAnchor.line - 1;
    const current = parsed.lines[lineIndex];

    if (current === undefined) {
      throw new AnchoredEditError(
        "ANCHOR_LINE_OUT_OF_RANGE",
        `Anchor line is outside the current file: ${edit.anchor}`,
        {
          path: input.path,
          anchor: edit.anchor,
          line: parsedAnchor.line,
          lineCount: parsed.lines.length,
        },
      );
    }

    const currentHash = hashLine(current);
    if (currentHash !== parsedAnchor.hash) {
      throw new AnchoredEditError(
        "ANCHOR_HASH_MISMATCH",
        `Anchor hash does not match current line: ${edit.anchor}`,
        {
          path: input.path,
          anchor: edit.anchor,
          line: parsedAnchor.line,
          expectedHash: parsedAnchor.hash,
          currentHash,
        },
      );
    }

    const change = changes.get(lineIndex) ?? {
      prepend: [],
      append: [],
    };

    if (edit.op === "prepend") change.prepend.push(...edit.lines);
    if (edit.op === "append") change.append.push(...edit.lines);
    if (edit.op === "replace") change.replace = [...edit.lines];
    if (edit.op === "delete") change.delete = true;

    changes.set(lineIndex, change);
    verified.push({
      anchor: edit.anchor,
      line: parsedAnchor.line,
      op: edit.op,
    });
  }

  const nextLines: string[] = [];
  for (const [index, line] of parsed.lines.entries()) {
    const change = changes.get(index);
    if (!change) {
      nextLines.push(line);
      continue;
    }

    nextLines.push(...change.prepend);
    if (change.replace) {
      nextLines.push(...change.replace);
    } else if (!change.delete) {
      nextLines.push(line);
    }
    nextLines.push(...change.append);
  }

  return {
    content: joinText(nextLines, parsed.newline, parsed.trailingNewline),
    anchors: verified,
  };
}

function parseAnchor(anchor: string): { line: number; hash: string } {
  const match = /^([1-9]\d*)#([A-Z0-9]{4})$/.exec(anchor);
  if (!match) {
    throw new AnchoredEditError(
      "ANCHOR_INVALID",
      `Invalid anchor format: ${anchor}`,
      { anchor },
    );
  }

  return {
    line: Number(match[1]),
    hash: match[2],
  };
}

function formatAnchor(line: number, hash: string): string {
  return `${line}#${hash}`;
}

function hashLine(line: string): string {
  return createHash("sha256")
    .update(line)
    .digest("base64url")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4);
}

function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function splitText(content: string): {
  lines: string[];
  newline: "\n" | "\r\n";
  trailingNewline: boolean;
} {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.endsWith("\n");
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  return {
    lines,
    newline,
    trailingNewline,
  };
}

function joinText(
  lines: string[],
  newline: "\n" | "\r\n",
  trailingNewline: boolean,
): string {
  const content = lines.join(newline);
  return trailingNewline ? `${content}${newline}` : content;
}
