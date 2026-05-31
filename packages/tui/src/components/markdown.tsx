import React, { memo } from "react";
import { Box, Text, useStdout } from "ink";
import { parseMarkdown, type Block, type Span } from "../lib/markdown-parse.js";
import { displayWidth, graphemeWidth, toGraphemes } from "../lib/graphemes.js";
import { sanitizeAnsiForRender } from "../lib/text.js";
import { highlightLines, type Token, type TokenKind } from "../lib/syntax.js";
import { useTheme } from "../lib/theme-context.js";
import type { Theme } from "../lib/theme.js";

/**
 * Render a markdown string as Ink elements. Memoized on the exact `text`
 * value: the streaming renderer keys a monotonically-growing stable prefix
 * off this, so an unchanged prefix reuses the cached subtree with zero
 * re-parsing (see streaming-message.tsx).
 *
 * Always returns a single column Box so callers can drop it into either a
 * row or column parent without the children laying out side-by-side.
 */
export const Markdown = memo(function Markdown(props: {
  text: string;
}): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  // Strip OSC/cursor/control escapes from model output before parsing so they
  // can't corrupt layout or leak into scrollback (SGR colour is preserved).
  const blocks = parseMarkdown(sanitizeAnsiForRender(props.text));
  // Budget tables to the terminal width (minus the transcript's paddingX); fall
  // back to a sane default when stdout has no column count (pipes, tests).
  const avail = Math.max((stdout?.columns ?? 80) - 2, 20);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <BlockView
          key={i}
          block={block}
          first={i === 0}
          theme={theme}
          avail={avail}
        />
      ))}
    </Box>
  );
});

function BlockView(props: {
  block: Block;
  first: boolean;
  theme: ReturnType<typeof useTheme>;
  avail: number;
}): React.ReactElement {
  const { block, theme } = props;
  const mt = props.first ? 0 : 1;

  switch (block.type) {
    case "heading":
      return (
        <Box marginTop={mt}>
          <Text bold color={block.level <= 2 ? theme.accent : theme.accent2}>
            <Spans spans={block.spans} theme={theme} />
          </Text>
        </Box>
      );

    case "paragraph":
      return (
        <Box marginTop={mt}>
          <Text>
            <Spans spans={block.spans} theme={theme} />
          </Text>
        </Box>
      );

    case "code": {
      // Highlight the whole block at once so multi-line strings (Python
      // docstrings, backtick template literals) keep their colour across lines.
      const lines = block.lines.length ? block.lines : [""];
      const tokenized = highlightLines(lines, block.lang);
      return (
        <Box marginTop={mt} flexDirection="column">
          {block.lang ? (
            <Box>
              <Text color={theme.muted}>{"│ "}</Text>
              <Text dimColor>{block.lang}</Text>
            </Box>
          ) : null}
          {lines.map((_, i) => (
            <Box key={i}>
              <Text color={theme.muted}>{"│ "}</Text>
              <CodeLine tokens={tokenized[i]!} theme={theme} />
            </Box>
          ))}
        </Box>
      );
    }

    case "list": {
      // Ordered items number per depth (deeper counters drop when the list
      // steps back out); unordered items rotate bullet glyphs by depth. The
      // ordered flag is per item, so a numbered list with nested bullets
      // renders both correctly and the numbering survives the excursion.
      const counters: number[] = [];
      const bullets = ["• ", "◦ ", "▪ "];
      const markers = block.items.map((item) => {
        counters.length = item.depth + 1;
        if (!item.ordered) return bullets[item.depth % bullets.length];
        counters[item.depth] = (counters[item.depth] ?? 0) + 1;
        return `${counters[item.depth]}. `;
      });
      return (
        <Box marginTop={mt} flexDirection="column">
          {block.items.map((item, i) => (
            <Box key={i} marginLeft={item.depth * 2}>
              <Text color={theme.accent}>{markers[i]}</Text>
              <Text>
                <Spans spans={item.spans} theme={theme} />
              </Text>
            </Box>
          ))}
        </Box>
      );
    }

    case "table":
      return (
        <TableView
          block={block}
          marginTop={mt}
          theme={theme}
          avail={props.avail}
        />
      );

    case "quote":
      return (
        <Box marginTop={mt} flexDirection="column">
          {block.lines.map((spans, i) => (
            <Box key={i}>
              <Text color={theme.muted}>{"▏ "}</Text>
              <Text dimColor italic>
                <Spans spans={spans} theme={theme} />
              </Text>
            </Box>
          ))}
        </Box>
      );

    case "rule":
      return (
        <Box marginTop={mt}>
          <Text dimColor>{"─".repeat(24)}</Text>
        </Box>
      );
  }
}

function spansWidth(spans: Span[]): number {
  let w = 0;
  for (const s of spans) w += displayWidth(s.text);
  return w;
}

/** Split `s` into a leading chunk of at most `maxCols` display columns and the
 * rest. CJK code points count as two columns, so a chunk never splits a wide
 * glyph across the boundary. */
export function sliceByWidth(s: string, maxCols: number): [string, string] {
  let head = "";
  let w = 0;
  let i = 0;
  // Iterate by grapheme so a chunk never splits a wide glyph, an emoji ZWJ
  // sequence, or a base+combining-mark cluster across the boundary.
  for (const g of toGraphemes(s)) {
    const cw = graphemeWidth(g);
    if (w + cw > maxCols) break;
    head += g;
    w += cw;
    i += g.length;
  }
  return [head, s.slice(i)];
}

/** Longest single whitespace-delimited word in a cell, by display width — the
 * floor below which a column cannot shrink without hard-breaking words. */
function longestWordWidth(spans: Span[]): number {
  let max = 0;
  for (const s of spans) {
    for (const word of s.text.split(/\s+/)) {
      max = Math.max(max, displayWidth(word));
    }
  }
  return max;
}

/** Word-wrap styled spans to `width` display columns, hard-breaking any word
 * longer than the column. Returns one `Span[]` per visual line; inline styling
 * (bold/italic/code/link) is preserved on each wrapped fragment. */
export function wrapSpans(spans: Span[], width: number): Span[][] {
  const cap = Math.max(1, width);
  const words: Span[] = [];
  for (const span of spans) {
    for (const text of span.text.split(/\s+/)) {
      if (text) words.push({ ...span, text });
    }
  }
  const lines: Span[][] = [];
  let line: Span[] = [];
  let lineW = 0;
  for (const word of words) {
    let wText = word.text;
    // Hard-break a word that cannot fit on a line of its own.
    while (displayWidth(wText) > cap) {
      const room = lineW === 0 ? cap : cap - lineW - 1;
      if (room <= 0) {
        lines.push(line);
        line = [];
        lineW = 0;
        continue;
      }
      const [head, rest] = sliceByWidth(wText, room);
      if (!head) {
        lines.push(line);
        line = [];
        lineW = 0;
        continue;
      }
      if (lineW > 0) {
        line.push({ text: " " });
        lineW += 1;
      }
      line.push({ ...word, text: head });
      lineW += displayWidth(head);
      wText = rest;
    }
    const w = displayWidth(wText);
    if (lineW > 0 && lineW + 1 + w > cap) {
      lines.push(line);
      line = [];
      lineW = 0;
    }
    if (lineW > 0) {
      line.push({ text: " " });
      lineW += 1;
    }
    line.push({ ...word, text: wText });
    lineW += w;
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
}

/**
 * Allocate column widths to fit `budget` display columns. Tier 1: if the
 * natural widths already fit, keep them. Tier 2: otherwise shave one column at
 * a time from whichever column has the most headroom above its per-column
 * minimum (its longest word, capped) — a balanced proportional shrink that the
 * cell wrapper then word-wraps into.
 */
export function allocateColumnWidths(
  natural: number[],
  minWidths: number[],
  budget: number,
): number[] {
  const totalNatural = natural.reduce((a, b) => a + b, 0);
  if (totalNatural <= budget) return natural;
  const widths = [...natural];
  let over = totalNatural - budget;
  while (over > 0) {
    let idx = -1;
    let best = 0;
    for (let c = 0; c < widths.length; c++) {
      const headroom = widths[c]! - minWidths[c]!;
      if (headroom > best) {
        best = headroom;
        idx = c;
      }
    }
    if (idx === -1) break; // every column is at its floor
    widths[idx]! -= 1;
    over -= 1;
  }
  return widths;
}

const TABLE_SEP = " │ ";

function TableView(props: {
  block: Extract<Block, { type: "table" }>;
  marginTop: number;
  theme: Theme;
  avail: number;
}): React.ReactElement {
  const { block, theme } = props;
  const cols = Math.max(
    block.header.length,
    ...block.rows.map((r) => r.length),
    1,
  );
  const allCells = (c: number): Span[][] => [
    block.header[c] ?? [],
    ...block.rows.map((r) => r[c] ?? []),
  ];
  // Natural (unconstrained) and minimum (longest unbreakable word, capped)
  // width per column, then fit them to the terminal budget.
  const natural: number[] = [];
  const minWidths: number[] = [];
  for (let c = 0; c < cols; c++) {
    const cells = allCells(c);
    natural[c] = Math.max(1, ...cells.map(spansWidth));
    const longest = Math.max(1, ...cells.map(longestWordWidth));
    minWidths[c] = Math.min(natural[c], Math.max(3, Math.min(longest, 16)));
  }
  const sepTotal = (cols - 1) * displayWidth(TABLE_SEP);
  const widths = allocateColumnWidths(
    natural,
    minWidths,
    Math.max(cols, props.avail - sepTotal),
  );

  const row = (
    cells: Span[][],
    bold: boolean,
    key: number,
  ): React.ReactElement => {
    // Wrap each cell to its column width; the row spans as many visual lines as
    // the tallest cell, with the others padded out.
    const wrapped = Array.from({ length: cols }, (_, c) =>
      wrapSpans(cells[c] ?? [], widths[c]!),
    );
    const height = Math.max(1, ...wrapped.map((w) => w.length));
    return (
      <Box key={key} flexDirection="column">
        {Array.from({ length: height }).map((_, line) => (
          <Text key={line}>
            {Array.from({ length: cols }).map((_, c) => {
              const cellLine = wrapped[c]![line] ?? [];
              const pad = widths[c]! - spansWidth(cellLine);
              return (
                <React.Fragment key={c}>
                  {c > 0 ? <Text color={theme.muted}>{TABLE_SEP}</Text> : null}
                  <Text bold={bold}>
                    <Spans spans={cellLine} theme={theme} />
                  </Text>
                  {pad > 0 ? <Text>{" ".repeat(pad)}</Text> : null}
                </React.Fragment>
              );
            })}
          </Text>
        ))}
      </Box>
    );
  };
  const ruleWidth = widths.reduce((a, b) => a + b, 0) + sepTotal;
  return (
    <Box marginTop={props.marginTop} flexDirection="column">
      {row(block.header, true, -1)}
      <Text color={theme.muted}>{"─".repeat(Math.max(ruleWidth, 1))}</Text>
      {block.rows.map((r, i) => row(r, false, i))}
    </Box>
  );
}

function tokenColor(kind: TokenKind, theme: Theme): string | undefined {
  switch (kind) {
    case "keyword":
      return theme.accent2;
    case "string":
      return theme.success;
    case "number":
      return theme.warning;
    case "comment":
      return theme.muted;
    case "decorator":
      return theme.accent;
    case "interp":
      // Interpolation (`{expr}` / `${expr}`) renders in the normal foreground
      // so it stands out from the surrounding string colour.
      return undefined;
    default:
      // Plain tokens (identifiers, punctuation, the bulk of any block) render
      // in the normal foreground — colouring them was visually overwhelming.
      return undefined;
  }
}

function CodeLine(props: {
  tokens: Token[];
  theme: Theme;
}): React.ReactElement {
  const { tokens } = props;
  if (tokens.length === 0) return <Text> </Text>;
  return (
    <Text>
      {tokens.map((t, i) => (
        <Text
          key={i}
          color={tokenColor(t.kind, props.theme)}
          dimColor={t.kind === "comment"}
        >
          {t.text}
        </Text>
      ))}
    </Text>
  );
}

function Spans(props: {
  spans: Span[];
  theme: ReturnType<typeof useTheme>;
}): React.ReactElement {
  return (
    <>
      {props.spans.map((s, i) =>
        s.code ? (
          <Text key={i} color={props.theme.info} backgroundColor={undefined}>
            {s.text}
          </Text>
        ) : s.link ? (
          <Text
            key={i}
            color={props.theme.accent}
            underline
            bold={s.bold}
            italic={s.italic}
          >
            {s.text}
          </Text>
        ) : (
          <Text key={i} bold={s.bold} italic={s.italic}>
            {s.text}
          </Text>
        ),
      )}
    </>
  );
}
