/**
 * Minimal block + inline markdown parser for terminal rendering.
 *
 * This is intentionally NOT CommonMark-complete — it covers the constructs
 * that show up in assistant output (headings, fenced code, lists, block
 * quotes, rules, and inline bold/italic/code/links) and renders everything
 * else as plain paragraphs. The parser is pure and synchronous so it can be
 * memoized on its input string and unit-tested without Ink.
 */

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** True for the visible label of a `[text](url)` link (URL itself dropped). */
  link?: boolean;
}

/** A single list item plus its nesting depth (0 = top level). */
export interface ListItem {
  spans: Span[];
  depth: number;
  /** True for `1.`/`1)` items, false for bullets — tracked per item so a
   * numbered list with nested bullets can live in one block. */
  ordered: boolean;
}

export type Block =
  | { type: "heading"; level: number; spans: Span[] }
  | { type: "paragraph"; spans: Span[] }
  | { type: "code"; lang?: string; lines: string[] }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "table"; header: Span[][]; rows: Span[][][] }
  | { type: "quote"; lines: Span[][] }
  | { type: "rule" };

const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const RULE_RE = /^(\s*)([-*_])(?:\s*\2){2,}\s*$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const TABLE_DELIM_RE = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/;

/** Display column count of leading indentation (tab counts as two columns). */
function indentWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch === "\t" ? 2 : 1;
  return w;
}

/** A `| a | b |` row split into trimmed cell strings (outer pipes dropped). A
 * backslash-escaped pipe (`a\|b`) is not a column separator — it collapses to a
 * literal `|` inside the cell so the row keeps its true column count. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k += 1) {
    if (s[k] === "\\" && s[k + 1] === "|") {
      cur += "|";
      k += 1;
      continue;
    }
    if (s[k] === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += s[k];
  }
  cells.push(cur.trim());
  return cells;
}

/** A table starts where a `|`-bearing line is followed by a delimiter row. */
function isTableStart(lines: string[], idx: number): boolean {
  return (
    idx + 1 < lines.length &&
    lines[idx].includes("|") &&
    TABLE_DELIM_RE.test(lines[idx + 1])
  );
}

export function parseMarkdown(input: string): Block[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].trim() || undefined;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume closing fence (or run off the end)
      blocks.push({ type: "code", lang, lines: body });
      continue;
    }

    // Blank line → block separator.
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (RULE_RE.test(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    // Heading.
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        spans: parseInline(heading[2].trim()),
      });
      i += 1;
      continue;
    }

    // Table: header row + delimiter row + zero or more body rows.
    if (isTableStart(lines, i)) {
      const header = splitTableRow(lines[i]).map((c) => parseInline(c));
      i += 2; // header + delimiter
      const rows: Span[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]).map((c) => parseInline(c)));
        i += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    // List. A list region is consumed whole — including ordered and unordered
    // items at mixed indents and the blank lines between loose-list items — so
    // that a numbered list whose items carry nested bullets (or whose items are
    // separated by blank lines) stays a single block. Splitting it would
    // restart each fragment's numbering at 1. Leading indentation maps to a
    // nesting depth via an indent stack so two- and four-space authors both
    // nest correctly; depth is what the renderer indents by.
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const raw: { text: string; depth: number; ordered: boolean }[] = [];
      const indentStack: number[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (cur.trim() === "") {
          // A blank line continues the list only if more list content follows
          // (a loose list); otherwise it ends the region.
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === "") j += 1;
          if (
            j < lines.length &&
            (UL_RE.test(lines[j]) || OL_RE.test(lines[j]))
          ) {
            i = j;
            continue;
          }
          break;
        }
        const om = OL_RE.exec(cur);
        const m = om ?? UL_RE.exec(cur);
        if (!m) {
          // Lazy continuation: a plain line directly under an item (no blank
          // line, not the start of another block) folds into that item, so a
          // soft-wrapped item doesn't split the list and restart its numbering.
          // A block starter ends the list region instead.
          if (
            raw.length &&
            !FENCE_RE.test(cur) &&
            !HEADING_RE.test(cur) &&
            !RULE_RE.test(cur) &&
            !QUOTE_RE.test(cur) &&
            !isTableStart(lines, i)
          ) {
            raw[raw.length - 1].text += ` ${cur.trim()}`;
            i += 1;
            continue;
          }
          break;
        }
        const indent = indentWidth(m[1]);
        while (
          indentStack.length &&
          indent < indentStack[indentStack.length - 1]
        )
          indentStack.pop();
        if (
          indentStack.length === 0 ||
          indent > indentStack[indentStack.length - 1]
        )
          indentStack.push(indent);
        raw.push({
          text: m[2],
          depth: indentStack.length - 1,
          ordered: om !== null,
        });
        i += 1;
      }
      const items: ListItem[] = raw.map((r) => ({
        spans: parseInline(r.text),
        depth: r.depth,
        ordered: r.ordered,
      }));
      blocks.push({
        type: "list",
        ordered: items[0]?.ordered ?? false,
        items,
      });
      continue;
    }

    // Block quote. Consume consecutive quote lines, then fold their inner
    // content into visual lines the same way paragraphs do: soft-wrapped lines
    // join with a space, while a blank `>` line or a hard break (trailing two
    // spaces / backslash) starts a new line — so the author's intended
    // multi-line structure and blank separators survive to the renderer.
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i]);
        if (!m) break;
        inner.push(m[1]);
        i += 1;
      }
      const visual: string[] = [];
      let cur = "";
      let open = false;
      for (const raw of inner) {
        if (raw.trim() === "") {
          if (open) visual.push(cur);
          visual.push("");
          cur = "";
          open = false;
          continue;
        }
        const hard = / {2,}$/.test(raw) || /\\$/.test(raw);
        const text = raw.replace(/[ \t]+$/, "").replace(/\\$/, "");
        cur = open ? `${cur} ${text}` : text;
        open = true;
        if (hard) {
          visual.push(cur);
          cur = "";
          open = false;
        }
      }
      if (open) visual.push(cur);
      blocks.push({ type: "quote", lines: visual.map((l) => parseInline(l)) });
      continue;
    }

    // Paragraph: gather until a blank line or a line that starts a new block.
    // Soft-wrapped lines join with a space; a line ending in a markdown hard
    // break (two+ trailing spaces or a trailing backslash) joins with a real
    // newline so the author's intended break survives to the renderer.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        l.trim() === "" ||
        FENCE_RE.test(l) ||
        HEADING_RE.test(l) ||
        RULE_RE.test(l) ||
        UL_RE.test(l) ||
        OL_RE.test(l) ||
        QUOTE_RE.test(l) ||
        isTableStart(lines, i)
      )
        break;
      para.push(l);
      i += 1;
    }
    let joined = "";
    let prevHardBreak = false;
    for (let k = 0; k < para.length; k++) {
      const raw = para[k];
      const hard = / {2,}$/.test(raw) || /\\$/.test(raw);
      const text = raw.replace(/[ \t]+$/, "").replace(/\\$/, "");
      if (k > 0) joined += prevHardBreak ? "\n" : " ";
      joined += text;
      prevHardBreak = hard;
    }
    blocks.push({ type: "paragraph", spans: parseInline(joined) });
  }

  return blocks;
}

const ASCII_PUNCT_RE = /[!-/:-@[-`{-~]/;

function isSpaceOrEdge(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** A word boundary for underscore flanking: an edge, whitespace, or punctuation
 * (so `_x_` after a space opens, but the `_` in `my_var` does not). */
function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch) || ASCII_PUNCT_RE.test(ch);
}

/** Index of a closing delimiter run for `marker` (length `len`) at or after
 * `from` that is right-flanking (non-space immediately before it, and for `_` a
 * word boundary after it). -1 if none qualifies. */
function findCloser(
  text: string,
  from: number,
  marker: string,
  len: number,
): number {
  const run = marker.repeat(len);
  for (let k = from; k <= text.length - len; k += 1) {
    if (text.slice(k, k + len) !== run) continue;
    const before = text[k - 1];
    const after = text[k + len];
    const canClose =
      !isSpaceOrEdge(before) && (marker === "*" || isBoundary(after));
    if (canClose) return k;
  }
  return -1;
}

/**
 * Inline parser: walks the string once, emitting styled spans. Inline code
 * spans (backticks) win over emphasis so `**` inside code stays literal.
 * Links render as their visible text (the URL is dropped — terminals can't
 * make them clickable here without OSC 8, out of scope).
 *
 * Emphasis (`*`/`_`, single = italic, double = bold) is only honored when the
 * delimiter is flanking and has a matching closer. A bare `*` surrounded by
 * spaces (`a * b * c`) and an intra-word `_` (`my_var_name`) are left literal
 * rather than eating the text between them and leaking the style to the end of
 * the block. Underscore emphasis additionally requires whitespace inside the
 * span so identifier-like tokens (`__main__`, `__init__`) stay literal.
 */
export function parseInline(
  text: string,
  inherited: { bold?: boolean; italic?: boolean } = {},
): Span[] {
  const spans: Span[] = [];
  let buf = "";

  const flush = (): void => {
    if (buf) {
      const span: Span = { text: buf };
      if (inherited.bold) span.bold = true;
      if (inherited.italic) span.italic = true;
      spans.push(span);
    }
    buf = "";
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // Inline code: capture verbatim until the next backtick.
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        spans.push({ text: text.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }

    // Link: [label](url) → emit label only.
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd !== -1) {
          const label = text.slice(i + 1, close);
          flush();
          // Keep the visible label (URL dropped — stock Ink can't carry an
          // OSC 8 hyperlink without breaking its width math), but tag the
          // spans so the renderer can underline them.
          for (const s of parseInline(label, inherited))
            spans.push({ ...s, link: true });
          i = urlEnd + 1;
          continue;
        }
      }
    }

    // Emphasis: * or _ (doubled = bold). Honored only when flanking with a
    // matching closer; otherwise the run is emitted literally.
    if (ch === "*" || ch === "_") {
      const len = text[i + 1] === ch ? 2 : 1;
      const before = text[i - 1];
      const after = text[i + len];
      const canOpen =
        !isSpaceOrEdge(after) && (ch === "*" || isBoundary(before));
      if (canOpen) {
        const closer = findCloser(text, i + len, ch, len);
        if (closer !== -1) {
          const inner = text.slice(i + len, closer);
          if (ch === "*" || /\s/.test(inner)) {
            flush();
            const style =
              len === 2
                ? { ...inherited, bold: true }
                : { ...inherited, italic: true };
            for (const s of parseInline(inner, style)) spans.push(s);
            i = closer + len;
            continue;
          }
        }
      }
      // Not emphasis — emit the delimiter run verbatim and step past it so it
      // can't re-trigger on the next character.
      buf += text.slice(i, i + len);
      i += len;
      continue;
    }

    buf += ch;
    i += 1;
  }
  flush();
  return spans;
}
