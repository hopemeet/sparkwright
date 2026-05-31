import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { RunEvent } from "../lib/event-type.js";
import { formatEvent, type FormattedEvent } from "../lib/format-event.js";
import { collapseText, prettyJson } from "../lib/collapse.js";

const MAX_LINES = 30;
const MAX_CHARS = 4000;
const MAX_EVENTS = 200;
const MAX_DETAIL_STRING = 12_000;
const MAX_DETAIL_ARRAY = 50;
const MAX_DETAIL_KEYS = 40;
const MAX_DETAIL_DEPTH = 8;

interface DetailRow {
  event: RunEvent;
  formatted: FormattedEvent;
}

/**
 * Modal event browser. Shows the most recent events newest-last, lets the
 * user select one and expand to see the full pretty-printed payload (with
 * truncation safeguards). Designed as a layer so its useInput owns input
 * cleanly while the panel is open.
 *
 * Keys: j/k or ↑/↓ navigate · o or enter expand/collapse · g/G top/bottom ·
 *       esc close.
 */
export function EventDetailPanel(props: {
  events: RunEvent[];
  onClose: () => void;
}): React.ReactElement {
  const { stdout } = useStdout();
  // Window and pre-format the list so navigation never repeatedly inspects
  // huge payload objects. The raw event is kept only for the selected detail.
  const rows = useMemo<DetailRow[]>(
    () =>
      props.events.slice(-MAX_EVENTS).map((event) => ({
        event,
        formatted: formatEvent(event),
      })),
    [props.events],
  );
  const [cursor, setCursor] = useState(Math.max(0, rows.length - 1));
  const [expanded, setExpanded] = useState(false);

  const viewportRows = Math.max(8, (stdout?.rows ?? 30) - 12);
  const safeCursor = Math.min(cursor, Math.max(0, rows.length - 1));

  useInput((input, key) => {
    if (key.escape || input === "q" || (key.ctrl && input === "c")) {
      props.onClose();
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(rows.length - 1, c + 1));
      setExpanded(false);
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
      setExpanded(false);
      return;
    }
    if (input === "g") {
      setCursor(0);
      setExpanded(false);
      return;
    }
    if (input === "G") {
      setCursor(rows.length - 1);
      setExpanded(false);
      return;
    }
    if (input === "o" || key.return) {
      setExpanded((x) => !x);
    }
  });

  if (rows.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
      >
        <Text color="cyan" bold>
          event detail (esc close)
        </Text>
        <Text dimColor>(no events yet)</Text>
      </Box>
    );
  }

  // Slice a viewport around the cursor; reserve a third for the expanded
  // detail block so navigating doesn't make the selected row jump off-screen.
  const listHeight = expanded
    ? Math.max(4, Math.floor(viewportRows / 2))
    : viewportRows;
  const start = Math.max(
    0,
    Math.min(rows.length - listHeight, safeCursor - Math.floor(listHeight / 2)),
  );
  const visible = rows.slice(start, start + listHeight);
  const selected = rows[safeCursor]?.event;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box>
        <Text color="cyan" bold>
          event detail
        </Text>
        <Text dimColor>
          {"  "}#{safeCursor + 1}/{rows.length} · ↑/↓ select · o expand · esc/q
          close
        </Text>
      </Box>
      {visible.map((row, i) => {
        const idx = start + i;
        const selectedRow = idx === safeCursor;
        const f = row.formatted;
        return (
          <Box key={row.event.id ?? `${row.event.sequence}`}>
            <Text color={selectedRow ? "green" : undefined}>
              {selectedRow ? "› " : "  "}
            </Text>
            <Text dimColor>
              [{String(row.event.sequence ?? "?").padStart(3, " ")}]{" "}
            </Text>
            <Text color={f.color} bold={selectedRow}>
              {f.label}
            </Text>
            {f.detail ? (
              <>
                <Text> </Text>
                <Text dimColor>{f.detail}</Text>
              </>
            ) : null}
          </Box>
        );
      })}
      {expanded && selected ? (
        <ExpandedPayload
          event={selected}
          viewportRows={viewportRows - listHeight - 2}
        />
      ) : null}
    </Box>
  );
}

function ExpandedPayload(props: {
  event: RunEvent;
  viewportRows: number;
}): React.ReactElement {
  const ev = props.event;
  const json = prettyJson(pruneForDetail(ev));
  const collapsed = collapseText(json, MAX_LINES, MAX_CHARS);
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      <Box>
        <Text dimColor>type </Text>
        <Text>{ev.type}</Text>
        {ev.occurredAt ? <Text dimColor> · {ev.occurredAt}</Text> : null}
      </Box>
      {collapsed.body.split("\n").map((line, i) => (
        <Text
          key={i}
          dimColor={
            line.startsWith("{") || line.startsWith("}") || line.trim() === ""
          }
        >
          {line || " "}
        </Text>
      ))}
      {collapsed.overflow ? (
        <Text dimColor>
          … truncated (
          {collapsed.droppedLines > 0
            ? `+${collapsed.droppedLines} lines`
            : `+${collapsed.droppedChars} chars`}
          )
        </Text>
      ) : null}
    </Box>
  );
}

function pruneForDetail(value: unknown): unknown {
  return pruneValue(value, 0, new WeakSet<object>());
}

function pruneValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_DETAIL_STRING) return value;
    return {
      type: "string",
      length: value.length,
      preview: value.slice(0, MAX_DETAIL_STRING),
      truncated: true,
    };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DETAIL_DEPTH) return "[MaxDepth]";
  seen.add(value);

  if (Array.isArray(value)) {
    const shown = value
      .slice(0, MAX_DETAIL_ARRAY)
      .map((item) => pruneValue(item, depth + 1, seen));
    if (value.length <= MAX_DETAIL_ARRAY) return shown;
    return {
      type: "array",
      length: value.length,
      preview: shown,
      truncated: true,
    };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, nested] of entries.slice(0, MAX_DETAIL_KEYS)) {
    out[key] = pruneValue(nested, depth + 1, seen);
  }
  if (entries.length > MAX_DETAIL_KEYS) {
    out.__truncatedKeys = entries.length - MAX_DETAIL_KEYS;
  }
  return out;
}
