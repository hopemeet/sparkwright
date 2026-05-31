/**
 * Bounded text preview. Used by the event-detail panel to show large tool
 * outputs / payloads without blowing up the terminal. Returns the truncated
 * body plus an `overflow` flag the caller surfaces as a "+N more lines" hint.
 */
export function collapseText(
  text: string,
  maxLines: number,
  maxChars: number,
): {
  body: string;
  overflow: boolean;
  droppedLines: number;
  droppedChars: number;
} {
  if (!text)
    return { body: "", overflow: false, droppedLines: 0, droppedChars: 0 };
  const lines = text.split("\n");
  const lineOverflow = lines.length > maxLines;
  const preview = lineOverflow ? lines.slice(0, maxLines).join("\n") : text;
  const charOverflow = preview.length > maxChars;
  const body = charOverflow
    ? preview.slice(0, Math.max(0, maxChars - 1)) + "…"
    : preview;
  return {
    body,
    overflow: lineOverflow || charOverflow,
    droppedLines: lineOverflow ? lines.length - maxLines : 0,
    droppedChars: charOverflow ? preview.length - body.length : 0,
  };
}

/**
 * Pretty-stringify any JSON-ish payload with stable key order. Cycles and
 * non-serialisable values fall back to `String(value)`.
 */
export function prettyJson(value: unknown, indent = 2): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        if (typeof v === "bigint") return v.toString() + "n";
        if (typeof v === "function") return `[Function ${v.name || "anon"}]`;
        return v;
      },
      indent,
    );
  } catch {
    return String(value);
  }
}
