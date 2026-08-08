import { parseUnifiedDiff } from "./diff.js";
import { displayWidth, graphemeWidth, toGraphemes } from "./graphemes.js";
import { parseMarkdown, type Span } from "./markdown-parse.js";
import { sanitizeAnsiForRender } from "./text.js";
import { highlightLines, type TokenKind } from "./syntax.js";
import type { ToolDisplayTone } from "./tool-display.js";
import type {
  TranscriptDocument,
  TranscriptRow,
  TranscriptRowFormat,
} from "./transcript-document.js";
import type { TranscriptMode } from "./transcript-presentation.js";

export interface LogicalTranscriptRow {
  key: string;
  blockKey: string;
  parentKey?: string;
  level?: "primary" | "detail";
  text: string;
  tone: ToolDisplayTone;
  bold?: boolean;
  spans?: readonly StyledTranscriptSpan[];
}

export interface PhysicalTranscriptRow extends LogicalTranscriptRow {
  logicalRowKey: string;
  /** UTF-16 offset into the logical row, used as the resize-safe anchor. */
  sourceOffset: number;
  /** @reserved Exclusive UTF-16 range end for renderer/layout consumers. */
  sourceEnd: number;
  continuation: number;
}

export type TranscriptSpanColor =
  | "accent"
  | "accent2"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "muted";

export interface StyledTranscriptSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  color?: TranscriptSpanColor;
}

export interface TranscriptLayout {
  documentEpoch: string;
  mode: TranscriptMode;
  columns: number;
  rows: PhysicalTranscriptRow[];
  /** @reserved Bounded-projection metric consumed by viewport diagnostics and performance QA. */
  omittedRows: number;
  /** Physical row count before the bounded materialization window. */
  totalRows: number;
}

export interface TranscriptLayoutOptions {
  maxMaterializedRows?: number;
}

const DEFAULT_MAX_MATERIALIZED_ROWS = 5_000;
const COMPLEX_GRAPHEME_PATTERN: RegExp =
  // Intentional Unicode ranges identify text that needs Intl.Segmenter.
  // eslint-disable-next-line no-misleading-character-class
  /[\p{M}\r\n\u1100-\u11ff\u200d\ufe0e\ufe0f\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007e}]/u;

export function projectTranscriptRows(
  document: TranscriptDocument,
  mode: TranscriptMode,
): LogicalTranscriptRow[] {
  const rows: LogicalTranscriptRow[] = [];
  visitProjectedTranscriptRows(document, mode, (row) => rows.push(row));
  return rows;
}

function visitProjectedTranscriptRows(
  document: TranscriptDocument,
  mode: TranscriptMode,
  visit: (row: LogicalTranscriptRow) => void,
): void {
  let emittedBlocks = 0;
  document.blocks.forEach((block) => {
    if (mode === "compact" && block.visibility === "detailed") return;
    const blockRows: LogicalTranscriptRow[] = [];
    if (emittedBlocks > 0) {
      blockRows.push({
        key: `${block.key}:space`,
        blockKey: block.key,
        text: "",
        tone: "muted",
      });
    }
    emittedBlocks += 1;
    for (const summaryRow of block.summary) {
      if (
        mode === "detailed" &&
        ((block.kind === "tool" &&
          summaryRow.key.startsWith(`${block.key}:result:`)) ||
          (block.kind === "agent" &&
            summaryRow.key.startsWith(`${block.key}:approval:`)))
      ) {
        continue;
      }
      blockRows.push(...expandSourceRow(block.key, summaryRow));
    }
    if (mode === "detailed") {
      for (const section of block.details) {
        blockRows.push({
          key: `${section.key}:label`,
          blockKey: block.key,
          text: `   ${section.label}`,
          tone: section.tone,
          bold: true,
        });
        for (const detailRow of section.rows) {
          const expanded = expandSourceRow(block.key, detailRow);
          for (const row of expanded) {
            blockRows.push({
              ...row,
              text: `     ${row.text}`,
              spans: row.spans ? [{ text: "     " }, ...row.spans] : undefined,
            });
          }
        }
      }
    }
    blockRows.forEach((row) =>
      visit({
        ...row,
        parentKey: block.parentKey,
        level: block.level,
      }),
    );
  });
}

export function layoutTranscriptDocument(
  document: TranscriptDocument,
  mode: TranscriptMode,
  columns: number,
  options: TranscriptLayoutOptions = {},
): TranscriptLayout {
  const width = Math.max(1, columns);
  const maxRows = Math.max(
    1,
    options.maxMaterializedRows ?? DEFAULT_MAX_MATERIALIZED_ROWS,
  );
  const physical: PhysicalTranscriptRow[] = [];
  let omittedRows = 0;
  let totalRows = 0;

  visitProjectedTranscriptRows(document, mode, (logical) => {
    const wrapped = wrapTextWithOffsets(logical.text, width);
    wrapped.forEach((part, continuation) => {
      totalRows += 1;
      physical.push({
        ...logical,
        key: `${logical.key}:physical:${part.offset}`,
        logicalRowKey: logical.key,
        text: part.text,
        spans: logical.spans
          ? sliceStyledSpans(
              logical.spans,
              part.offset,
              part.offset + part.text.length,
            )
          : undefined,
        sourceOffset: part.offset,
        sourceEnd: part.offset + part.text.length,
        continuation,
      });
    });
    // Bound the projection/layout cache even when a replay contains a very
    // large number of blocks. EventStore/trace data remains untouched.
    if (physical.length > maxRows * 2) {
      const drop = physical.length - maxRows;
      physical.splice(0, drop);
      omittedRows += drop;
    }
  });

  if (physical.length > maxRows) {
    const drop = physical.length - maxRows;
    physical.splice(0, drop);
    omittedRows += drop;
  }
  if (omittedRows > 0) {
    const keep = Math.max(0, maxRows - 1);
    if (physical.length > keep) {
      const drop = physical.length - keep;
      physical.splice(0, drop);
      omittedRows += drop;
    }
    physical.unshift({
      key: "__omitted:physical:0",
      blockKey: "__omitted",
      logicalRowKey: "__omitted",
      level: "primary",
      text: `… ${omittedRows} earlier transcript lines omitted from the viewport …`,
      tone: "warning",
      sourceOffset: 0,
      sourceEnd: 0,
      continuation: 0,
    });
  }

  return {
    documentEpoch: document.epoch,
    mode,
    columns: width,
    rows: physical,
    omittedRows,
    totalRows,
  };
}

function expandSourceRow(
  blockKey: string,
  source: TranscriptRow,
): LogicalTranscriptRow[] {
  const format: TranscriptRowFormat = source.format ?? "plain";
  if (format === "markdown") {
    return markdownRows(blockKey, source);
  }
  if (format === "diff") {
    const parsed = parseUnifiedDiff(sanitizeAnsiForRender(source.text));
    return [
      {
        key: `${source.key}:summary`,
        blockKey,
        text: `+${parsed.additions} / -${parsed.deletions}`,
        tone: "muted",
      },
      ...parsed.lines
        .filter((line) => line.kind !== "header" && line.kind !== "meta")
        .slice(0, 120)
        .map(
          (line, index): LogicalTranscriptRow => ({
            key: `${source.key}:diff:${index}`,
            blockKey,
            text: line.text,
            tone:
              line.kind === "add"
                ? "success"
                : line.kind === "del"
                  ? "error"
                  : line.kind === "hunk"
                    ? "muted"
                    : source.tone,
          }),
        ),
    ];
  }
  return sanitizeAnsiForRender(source.text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((text, index) => ({
      key: index === 0 ? source.key : `${source.key}:line:${index}`,
      blockKey,
      text,
      tone: source.tone,
      bold: source.bold,
    }));
}

function markdownRows(
  blockKey: string,
  source: TranscriptRow,
): LogicalTranscriptRow[] {
  const output: LogicalTranscriptRow[] = [];
  const blocks = parseMarkdown(sanitizeAnsiForRender(source.text));
  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0) {
      output.push({
        key: `${source.key}:md:${blockIndex}:space`,
        blockKey,
        text: "",
        tone: "muted",
      });
    }
    const push = (
      suffix: string,
      text: string,
      tone: ToolDisplayTone = source.tone,
      bold = false,
      spans?: readonly StyledTranscriptSpan[],
    ): void => {
      output.push({
        key: `${source.key}:md:${blockIndex}:${suffix}`,
        blockKey,
        text,
        tone,
        bold,
        spans,
      });
    };
    switch (block.type) {
      case "heading": {
        const text = spanText(block.spans);
        push(
          "heading",
          text,
          "normal",
          true,
          markdownSpans(block.spans, {
            bold: true,
            color: block.level <= 2 ? "accent" : "accent2",
          }),
        );
        break;
      }
      case "paragraph": {
        const text = spanText(block.spans);
        push("paragraph", text, source.tone, false, markdownSpans(block.spans));
        break;
      }
      case "code": {
        if (block.lang) {
          push("lang", `│ ${block.lang}`, "muted", false, [
            { text: "│ ", color: "muted" },
            { text: block.lang, color: "muted", dim: true },
          ]);
        }
        const lines = block.lines.length > 0 ? block.lines : [""];
        const highlighted = highlightLines(lines, block.lang);
        lines.forEach((line, index) =>
          push(`code:${index}`, `│ ${line}`, "normal", false, [
            { text: "│ ", color: "muted" },
            ...highlighted[index]!.map(tokenSpan),
          ]),
        );
        break;
      }
      case "list": {
        const counters: number[] = [];
        block.items.forEach((item, index) => {
          counters.length = item.depth + 1;
          const marker = item.ordered
            ? `${(counters[item.depth] = (counters[item.depth] ?? 0) + 1)}.`
            : ["•", "◦", "▪"][item.depth % 3];
          const prefix = `${"  ".repeat(item.depth)}${marker} `;
          push(
            `list:${index}`,
            `${prefix}${spanText(item.spans)}`,
            source.tone,
            false,
            [{ text: prefix, color: "accent" }, ...markdownSpans(item.spans)],
          );
        });
        break;
      }
      case "table": {
        const headerSpans = tableSpans(block.header, true);
        push(
          "table:header",
          headerSpans.map((span) => span.text).join(""),
          "normal",
          true,
          headerSpans,
        );
        block.rows.forEach((cells, index) => {
          const spans = tableSpans(cells, false);
          push(
            `table:${index}`,
            spans.map((span) => span.text).join(""),
            source.tone,
            false,
            spans,
          );
        });
        break;
      }
      case "quote":
        block.lines.forEach((line, index) => {
          const prefix = "▏ ";
          push(`quote:${index}`, `${prefix}${spanText(line)}`, "muted", false, [
            { text: prefix, color: "muted", dim: true },
            ...markdownSpans(line, {
              italic: true,
              color: "muted",
              dim: true,
            }),
          ]);
        });
        break;
      case "rule":
        push("rule", "─".repeat(24), "muted", false, [
          { text: "─".repeat(24), color: "muted", dim: true },
        ]);
        break;
    }
  });
  return output.length > 0
    ? output
    : [
        {
          key: source.key,
          blockKey,
          text: "",
          tone: source.tone,
        },
      ];
}

function spanText(spans: readonly Span[]): string {
  return spans.map((span) => span.text).join("");
}

function markdownSpans(
  spans: readonly Span[],
  defaults: Omit<StyledTranscriptSpan, "text"> = {},
): StyledTranscriptSpan[] {
  return spans.map((span) => ({
    ...defaults,
    text: span.text,
    bold: span.bold ?? defaults.bold,
    italic: span.italic ?? defaults.italic,
    underline: span.link || defaults.underline,
    color: span.code ? "info" : span.link ? "accent" : defaults.color,
  }));
}

function tableSpans(
  cells: readonly (readonly Span[])[],
  bold: boolean,
): StyledTranscriptSpan[] {
  const output: StyledTranscriptSpan[] = [];
  cells.forEach((cell, index) => {
    if (index > 0) output.push({ text: " │ ", color: "muted" });
    output.push(...markdownSpans(cell, { bold }));
  });
  return output;
}

function tokenSpan(token: {
  text: string;
  kind: TokenKind;
}): StyledTranscriptSpan {
  const color: TranscriptSpanColor | undefined =
    token.kind === "keyword"
      ? "accent2"
      : token.kind === "string"
        ? "success"
        : token.kind === "number"
          ? "warning"
          : token.kind === "comment"
            ? "muted"
            : token.kind === "decorator"
              ? "accent"
              : undefined;
  return {
    text: token.text,
    color,
    dim: token.kind === "comment",
  };
}

function sliceStyledSpans(
  spans: readonly StyledTranscriptSpan[],
  start: number,
  end: number,
): StyledTranscriptSpan[] {
  const output: StyledTranscriptSpan[] = [];
  let offset = 0;
  for (const span of spans) {
    const spanEnd = offset + span.text.length;
    const from = Math.max(start, offset);
    const to = Math.min(end, spanEnd);
    if (from < to) {
      output.push({
        ...span,
        text: span.text.slice(from - offset, to - offset),
      });
    }
    offset = spanEnd;
    if (offset >= end) break;
  }
  return output;
}

interface WrappedPart {
  text: string;
  offset: number;
}

/**
 * CJK/grapheme-aware hard wrapping with stable source offsets. Whitespace near
 * the right edge is preferred, but an overlong word is split on a grapheme
 * boundary instead of overflowing Ink's layout.
 */
export function wrapTextWithOffsets(
  input: string,
  columns: number,
): WrappedPart[] {
  const width = Math.max(1, columns);
  if (input === "") return [{ text: "", offset: 0 }];
  const graphemes = COMPLEX_GRAPHEME_PATTERN.test(input)
    ? toGraphemes(input)
    : Array.from(input);
  let totalWidth = 0;
  for (const grapheme of graphemes) totalWidth += graphemeWidth(grapheme);
  if (totalWidth <= width) return [{ text: input.trimEnd(), offset: 0 }];
  const result: WrappedPart[] = [];
  let startIndex = 0;
  let startOffset = 0;

  while (startIndex < graphemes.length) {
    let used = 0;
    let end = startIndex;
    let offset = startOffset;
    let lastWhitespace = -1;
    let lastWhitespaceOffset = -1;
    while (end < graphemes.length) {
      const grapheme = graphemes[end]!;
      const nextWidth = used + graphemeWidth(grapheme);
      if (nextWidth > width) break;
      used = nextWidth;
      offset += grapheme.length;
      if (/\s/u.test(grapheme)) {
        lastWhitespace = end;
        lastWhitespaceOffset = offset;
      }
      end += 1;
    }
    if (end === startIndex) {
      const grapheme = graphemes[end]!;
      result.push({ text: grapheme, offset: startOffset });
      startIndex += 1;
      startOffset += grapheme.length;
      continue;
    }
    const hasOverflow = end < graphemes.length;
    const breakAt =
      hasOverflow && lastWhitespace >= startIndex ? lastWhitespace + 1 : end;
    const endOffset =
      breakAt === lastWhitespace + 1 && lastWhitespaceOffset >= 0
        ? lastWhitespaceOffset
        : startOffset +
          graphemes
            .slice(startIndex, breakAt)
            .reduce((sum, grapheme) => sum + grapheme.length, 0);
    const text = graphemes.slice(startIndex, breakAt).join("").trimEnd();
    result.push({ text, offset: startOffset });
    startIndex = breakAt;
    startOffset = endOffset;
    while (
      startIndex < graphemes.length &&
      /\s/u.test(graphemes[startIndex]!)
    ) {
      startOffset += graphemes[startIndex]!.length;
      startIndex += 1;
    }
  }
  return result;
}

export function physicalRowsWidth(
  rows: readonly PhysicalTranscriptRow[],
): number {
  return rows.reduce((max, row) => Math.max(max, displayWidth(row.text)), 0);
}
