import React from "react";
import { Box, Text } from "ink";
import { Markdown } from "./markdown.js";
import { useTheme } from "../lib/theme-context.js";
import { displayWidth } from "../lib/graphemes.js";
import { parseMarkdown, type Span } from "../lib/markdown-parse.js";
import { sanitizeAnsiForRender } from "../lib/text.js";

const MAX_CHARS = 4000;

const FENCE_RE = /^(`{3,}|~{3,})/;

/**
 * Index of the last `\n\n` boundary that sits at code-block scope (not inside
 * an open fence), or -1 if none. Walks the text once tracking the active fence
 * marker the same way the parser does (open on a fence line, close on a line
 * starting with that marker), so the stable prefix never ends mid-code-block.
 */
function lastStableSplit(text: string): number {
  let best = -1;
  let offset = 0;
  let marker: string | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (marker === null) {
      if (line === "" && i > 0) {
        // An empty line at index `offset` means the `\n` before it (at
        // `offset - 1`) is the start of a `\n\n` boundary at fence-free scope —
        // the same split point `lastIndexOf("\n\n")` would return.
        best = offset - 1;
      }
      const fence = FENCE_RE.exec(line);
      if (fence) marker = fence[1];
    } else if (line.startsWith(marker)) {
      marker = null;
    }
    offset += line.length + 1; // +1 for the consumed "\n"
  }
  return best;
}

/**
 * Live (in-flight) assistant text, rendered as markdown.
 *
 * The panel is clamped to a physical row budget (`maxRows`, set by the App from the
 * terminal height) so a long streaming reply can't push the input box
 * off-screen. On top of that, we split the visible text at the last stable
 * block boundary (a blank line): the prefix — which won't change again this
 * delta — is rendered by its own memoized <Markdown>, so React reuses that
 * subtree untouched and only the small unstable tail is re-parsed on each
 * token. That keeps long streaming replies from re-tokenizing the whole
 * message every frame. The finished message graduates to scrollback
 * (event-stream.tsx) and is rendered once via <Markdown> there.
 */
export function StreamingMessage(props: {
  text: string;
  /** Live reasoning/thinking text, shown dimmed above the answer if present. */
  reasoning?: string;
  /** Physical row budget for the live answer body, including its fold hint. */
  maxRows?: number;
  /** Available answer width after the sidebar and horizontal padding. */
  columns?: number;
}): React.ReactElement | null {
  const theme = useTheme();
  if (!props.text && !props.reasoning) return null;

  const charTruncated = props.text.length > MAX_CHARS;
  const text = charTruncated
    ? sanitizeAnsiForRender(props.text.slice(-MAX_CHARS))
    : props.text;
  const maxRows =
    props.maxRows && props.maxRows > 0 ? Math.floor(props.maxRows) : undefined;
  const columns = Math.max(1, Math.floor(props.columns ?? 80));
  const folded = Boolean(
    props.text &&
    (charTruncated ||
      (maxRows && estimateMarkdownPhysicalRows(text, columns) > maxRows)),
  );
  const contentRows = maxRows
    ? Math.max(1, maxRows - (folded ? 1 : 0))
    : undefined;

  // Split at the last blank line that isn't inside an open code fence:
  // everything before it is a settled block and won't change as more tokens
  // arrive, so it memoizes; the tail is the only part still growing. A blank
  // line inside an unclosed ``` block is NOT a safe split — cutting there would
  // hand the tail to its own <Markdown> with no opening fence, so the rest of
  // the code block would render as a paragraph (and a stray closing ``` would
  // open a phantom block) until the fence finally closes.
  const splitAt = lastStableSplit(text);
  const stable = splitAt > 0 ? text.slice(0, splitAt) : "";
  const tail = splitAt > 0 ? text.slice(splitAt + 2) : text;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {props.reasoning ? (
        <ReasoningBlock text={props.reasoning} theme={theme} />
      ) : null}
      {props.text ? (
        <>
          <Text color={theme.success}>assistant</Text>
          <Box flexDirection="column" {...(maxRows ? { height: maxRows } : {})}>
            {folded ? (
              <Text color={theme.muted}>
                … earlier content temporarily folded
              </Text>
            ) : null}
            <Box
              flexDirection="column"
              justifyContent={folded ? "flex-end" : "flex-start"}
              overflow="hidden"
              {...(contentRows ? { height: contentRows } : {})}
            >
              <Box flexDirection="column" flexShrink={0}>
                {charTruncated ? (
                  <Text>{text}</Text>
                ) : (
                  <>
                    {stable ? <Markdown text={stable} /> : null}
                    {tail ? <Markdown text={tail} /> : null}
                  </>
                )}
              </Box>
            </Box>
          </Box>
        </>
      ) : null}
    </Box>
  );
}

/**
 * Collapsed, dimmed view of the model's in-flight reasoning. We show only the
 * trailing few lines (reasoning can be very long and isn't the answer) as
 * plain dim text — deliberately quiet so it reads as scaffolding, not output.
 */
function ReasoningBlock(props: {
  text: string;
  theme: ReturnType<typeof useTheme>;
}): React.ReactElement {
  const lines = props.text.split("\n").filter((l) => l.trim());
  const tail = lines.slice(-3);
  return (
    <Box flexDirection="column">
      <Text color={props.theme.muted}>thinking…</Text>
      {tail.map((l, i) => (
        <Text key={i} dimColor italic wrap="truncate-end">
          {sanitizeAnsiForRender(l)}
        </Text>
      ))}
    </Box>
  );
}

/** Answer rows for normal terminals; tiny screens degrade to preserve input. */
export function resolveStreamingAnswerRows(screenRows: number): number {
  const rows = Math.max(1, Math.floor(screenRows));
  if (rows < 18) return Math.max(1, Math.min(5, Math.floor(rows / 4)));
  return Math.max(6, Math.min(12, Math.floor(rows / 3)));
}

function estimateMarkdownPhysicalRows(text: string, columns: number): number {
  const blocks = parseMarkdown(sanitizeAnsiForRender(text));
  return blocks.reduce(
    (total, block, index) =>
      total + (index > 0 ? 1 : 0) + estimateBlockRows(block, columns),
    0,
  );
}

function estimateBlockRows(
  block: ReturnType<typeof parseMarkdown>[number],
  columns: number,
): number {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return estimateTextRows(spansText(block.spans), columns);
    case "code":
      return (
        (block.lang ? 1 : 0) +
        (block.lines.length ? block.lines : [""]).reduce(
          (rows, line) => rows + estimateTextRows(line, columns, 2),
          0,
        )
      );
    case "list":
      return block.items.reduce((rows, item, index) => {
        const marker = item.ordered ? `${index + 1}. ` : "• ";
        return (
          rows +
          estimateTextRows(
            spansText(item.spans),
            columns,
            item.depth * 2 + displayWidth(marker),
          )
        );
      }, 0);
    case "quote":
      return block.lines.reduce(
        (rows, spans) => rows + estimateTextRows(spansText(spans), columns, 2),
        0,
      );
    case "table": {
      const rows = [block.header, ...block.rows];
      return (
        1 +
        rows.reduce((total, cells) => {
          const width =
            cells.reduce(
              (sum, spans) => sum + displayWidth(spansText(spans)),
              0,
            ) +
            Math.max(0, cells.length - 1) * 3;
          return total + Math.max(1, Math.ceil(width / columns));
        }, 0)
      );
    }
    case "rule":
      return 1;
  }
}

function estimateTextRows(
  text: string,
  columns: number,
  prefixColumns = 0,
): number {
  return text
    .split("\n")
    .reduce(
      (rows, line) =>
        rows +
        Math.max(1, Math.ceil((prefixColumns + displayWidth(line)) / columns)),
      0,
    );
}

function spansText(spans: Span[]): string {
  return spans.map((span) => span.text).join("");
}
