import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { runFailureMessage } from "@sparkwright/protocol";
import type { RunEvent } from "../lib/event-type.js";
import { formatEvent, type FormattedEvent } from "../lib/format-event.js";
import { collapseText, prettyJson } from "../lib/collapse.js";
import { DialogFrame } from "./dialog-frame.js";
import { extractTurns } from "./fork-dialog.js";

const MAX_LINES = 30;
const MAX_CHARS = 4000;
const MAX_EVENTS = 200;
const MAX_DETAIL_STRING = 12_000;
const MAX_DETAIL_ARRAY = 50;
const MAX_DETAIL_KEYS = 40;
const MAX_DETAIL_DEPTH = 8;
const MAX_SEARCH_PAYLOAD_CHARS = 2000;
const MAX_SEARCH_QUERY_LABEL = 24;

interface DetailRow {
  event: RunEvent;
  formatted: FormattedEvent;
}

type RunInspectorTab = "events" | "facts" | "turns";

const RUN_INSPECTOR_TABS: RunInspectorTab[] = ["events", "facts", "turns"];

export type EventDetailFilter =
  | "all"
  | "errors"
  | "approvals"
  | "tools"
  | "writes"
  | "model";

const FILTERS: EventDetailFilter[] = [
  "all",
  "errors",
  "approvals",
  "tools",
  "writes",
  "model",
];

export function eventMatchesFilter(
  event: RunEvent,
  filter: EventDetailFilter,
): boolean {
  const type = event.type;
  const failedRunCompleted = isFailedRunCompletedEvent(event);
  switch (filter) {
    case "all":
      return true;
    case "errors":
      return (
        type === "run.failed" ||
        failedRunCompleted ||
        type.endsWith(".failed") ||
        type.endsWith(".denied") ||
        type.endsWith(".rejected") ||
        type.endsWith(".timeout")
      );
    case "approvals":
      return type.startsWith("approval.");
    case "tools":
      return (
        type.startsWith("tool.") ||
        type.startsWith("mcp.") ||
        type.startsWith("subagent.")
      );
    case "writes":
      return (
        type.startsWith("workspace.write.") ||
        type === "capability.mutation.completed"
      );
    case "model":
      return type.startsWith("model.") || type === "usage.updated";
  }
}

export function eventDetailFilterLabel(filter: EventDetailFilter): string {
  return filter;
}

export interface RunInspectorFacts {
  eventCount: number;
  runStarted: number;
  runCompleted: number;
  runFailed: number;
  toolCalls: number;
  changedFiles: string[];
  approvalsRequested: number;
  approvalsApproved: number;
  approvalsDenied: number;
  modelCalls: number;
  errorCount: number;
  lastCommand?: string;
  lastError?: string;
}

export function summarizeRunInspectorFacts(
  events: readonly RunEvent[],
): RunInspectorFacts {
  const facts: RunInspectorFacts = {
    eventCount: events.length,
    runStarted: 0,
    runCompleted: 0,
    runFailed: 0,
    toolCalls: 0,
    changedFiles: [],
    approvalsRequested: 0,
    approvalsApproved: 0,
    approvalsDenied: 0,
    modelCalls: 0,
    errorCount: 0,
  };
  const changedFiles = new Set<string>();
  for (const event of events) {
    const payload = rec(event.payload);
    if (event.type === "run.started") facts.runStarted += 1;
    if (event.type === "run.completed") facts.runCompleted += 1;
    if (event.type === "run.failed") facts.runFailed += 1;
    if (event.type === "tool.requested") {
      facts.toolCalls += 1;
      if (str(payload.toolName) === "shell") {
        const args = rec(payload.arguments ?? payload.input ?? payload.args);
        const command = str(args.command);
        if (command) facts.lastCommand = command;
      }
    }
    if (event.type === "model.completed") facts.modelCalls += 1;
    const failedRunCompleted =
      event.type === "run.completed" && str(payload.state) === "failed";
    if (
      failedRunCompleted ||
      event.type.endsWith(".failed") ||
      event.type.endsWith(".denied") ||
      event.type.endsWith(".rejected") ||
      event.type.endsWith(".timeout")
    ) {
      facts.errorCount += 1;
      facts.lastError =
        (event.type === "run.failed" || failedRunCompleted
          ? runFailureMessage(payload)
          : "") ||
        str(rec(payload.error).message) ||
        str(payload.message) ||
        str(payload.reason) ||
        event.type;
    }
    if (
      event.type === "workspace.write.applied" ||
      event.type === "workspace.write.completed"
    ) {
      const path = str(payload.path);
      if (path) changedFiles.add(path);
    }
    if (event.type === "approval.requested") facts.approvalsRequested += 1;
    if (event.type === "approval.resolved") {
      const decision = str(payload.decision);
      if (decision === "approved") facts.approvalsApproved += 1;
      else if (decision === "denied") facts.approvalsDenied += 1;
    }
  }
  facts.changedFiles = [...changedFiles].sort();
  return facts;
}

export function eventMatchesSearch(
  event: RunEvent,
  formatted: FormattedEvent,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return eventSearchText(event, formatted).includes(normalized);
}

function eventSearchText(event: RunEvent, formatted: FormattedEvent): string {
  const parts = [
    event.type,
    formatted.label,
    formatted.detail,
    event.id ?? "",
    String(event.sequence ?? ""),
  ];
  if (event.payload !== undefined) {
    parts.push(safeSearchJson(event.payload));
  }
  return parts.join("\n").toLowerCase();
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isFailedRunCompletedEvent(event: RunEvent): boolean {
  return (
    event.type === "run.completed" && str(rec(event.payload).state) === "failed"
  );
}

function safeSearchJson(value: unknown): string {
  try {
    return JSON.stringify(pruneForSearch(value)).slice(
      0,
      MAX_SEARCH_PAYLOAD_CHARS,
    );
  } catch {
    return "";
  }
}

function pruneForSearch(value: unknown): unknown {
  return pruneValue(value, 0, new WeakSet<object>(), {
    maxString: 300,
    maxArray: 12,
    maxKeys: 16,
    maxDepth: 4,
  });
}

function eventDetailEmptyLabel(filter: EventDetailFilter): string {
  switch (filter) {
    case "all":
      return "matching";
    case "errors":
      return "error";
    case "approvals":
      return "approval";
    case "tools":
      return "tool";
    case "writes":
      return "write";
    case "model":
      return "model";
  }
}

/**
 * Modal event browser. Shows the most recent events newest-last, lets the
 * user select one and expand to see the full pretty-printed payload (with
 * truncation safeguards). Designed as a layer so its useInput owns input
 * cleanly while the panel is open.
 *
 * Keys: j/k or ↑/↓ navigate · o or enter expand/collapse · g/G top/bottom ·
 *       tab/l/h filter · / search · esc close.
 */
export function EventDetailPanel(props: {
  events: RunEvent[];
  onClose: () => void;
}): React.ReactElement {
  const { stdout } = useStdout();
  const [tabIndex, setTabIndex] = useState(0);
  const [filterIndex, setFilterIndex] = useState(0);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const tab = RUN_INSPECTOR_TABS[tabIndex] ?? "events";
  const filter = FILTERS[filterIndex] ?? "all";
  // Window and pre-format the list so navigation never repeatedly inspects
  // huge payload objects. The raw event is kept only for the selected detail.
  const allRows = useMemo<DetailRow[]>(
    () =>
      props.events.slice(-MAX_EVENTS).map((event) => ({
        event,
        formatted: formatEvent(event),
      })),
    [props.events],
  );
  const rows = useMemo<DetailRow[]>(
    () =>
      allRows.filter(
        (row) =>
          eventMatchesFilter(row.event, filter) &&
          eventMatchesSearch(row.event, row.formatted, searchQuery),
      ),
    [allRows, filter, searchQuery],
  );
  const facts = useMemo(
    () => summarizeRunInspectorFacts(props.events),
    [props.events],
  );
  const turns = useMemo(() => extractTurns(props.events), [props.events]);
  const [cursor, setCursor] = useState(Math.max(0, rows.length - 1));
  const [expanded, setExpanded] = useState(false);

  const viewportRows = Math.max(8, (stdout?.rows ?? 30) - 12);
  const safeCursor = Math.min(cursor, Math.max(0, rows.length - 1));

  const cycleFilter = (delta: 1 | -1) => {
    setFilterIndex((idx) => (idx + delta + FILTERS.length) % FILTERS.length);
    setCursor(MAX_EVENTS);
    setExpanded(false);
  };
  const setTab = (index: number) => {
    setTabIndex(index);
    setSearchMode(false);
    setExpanded(false);
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      props.onClose();
      return;
    }
    if (searchMode) {
      if (key.escape) {
        setSearchMode(false);
        if (searchQuery) {
          setSearchQuery("");
          setCursor(MAX_EVENTS);
        }
        return;
      }
      if (key.return) {
        setSearchMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((query) => query.slice(0, -1));
        setCursor(MAX_EVENTS);
        setExpanded(false);
        return;
      }
      if (key.ctrl || key.meta || key.tab) return;
      if (input) {
        setSearchQuery((query) => query + input);
        setCursor(MAX_EVENTS);
        setExpanded(false);
      }
      return;
    }
    if (key.escape || input === "q") {
      props.onClose();
      return;
    }
    if (input === "1" || input === "2" || input === "3") {
      setTab(Number(input) - 1);
      return;
    }
    if (tab !== "events") return;
    if (input === "/") {
      setSearchMode(true);
      setExpanded(false);
      return;
    }
    if (input === "x" && searchQuery) {
      setSearchQuery("");
      setCursor(MAX_EVENTS);
      setExpanded(false);
      return;
    }
    if (key.tab || input === "l") {
      cycleFilter(1);
      return;
    }
    if (input === "h") {
      cycleFilter(-1);
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

  if (tab === "facts") {
    return (
      <DialogFrame borderColor="cyan">
        <RunInspectorHeader tab={tab} />
        <FactsView facts={facts} />
      </DialogFrame>
    );
  }
  if (tab === "turns") {
    return (
      <DialogFrame borderColor="cyan">
        <RunInspectorHeader tab={tab} />
        <TurnsView turns={turns} viewportRows={viewportRows} />
      </DialogFrame>
    );
  }

  if (rows.length === 0) {
    const hasEvents = allRows.length > 0;
    return (
      <DialogFrame borderColor="cyan">
        <EventDetailHeader
          tab={tab}
          filter={filter}
          searchMode={searchMode}
          searchQuery={searchQuery}
        />
        <Text dimColor>
          {hasEvents ? emptyMessage(filter, searchQuery) : "(no events yet)"}
        </Text>
      </DialogFrame>
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
    <DialogFrame borderColor="cyan">
      <EventDetailHeader
        tab={tab}
        filter={filter}
        index={safeCursor + 1}
        total={rows.length}
        searchMode={searchMode}
        searchQuery={searchQuery}
      />
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
    </DialogFrame>
  );
}

function EventDetailHeader(props: {
  tab: RunInspectorTab;
  filter: EventDetailFilter;
  index?: number;
  total?: number;
  searchMode: boolean;
  searchQuery: string;
}): React.ReactElement {
  const position =
    props.index !== undefined && props.total !== undefined
      ? ` · #${props.index}/${props.total}`
      : "";
  const search = props.searchQuery
    ? ` · /${formatSearchQueryLabel(props.searchQuery)}`
    : "";
  const searchHelp = props.searchQuery ? " · x clear" : "";
  const navigation = props.searchMode
    ? ["type search · enter done · esc clear"]
    : props.index !== undefined
      ? [
          `tab/l/h filter · / search${searchHelp}`,
          "↑/↓ select · o expand · esc/q close",
        ]
      : [`tab/l/h filter · / search${searchHelp} · esc/q close`];
  return (
    <>
      <RunInspectorHeader tab={props.tab} />
      <Text>
        <Text dimColor>
          filter:{eventDetailFilterLabel(props.filter)}
          {position}
          {search}
        </Text>
      </Text>
      {navigation.map((line) => (
        <Text key={line} dimColor>
          {line}
        </Text>
      ))}
    </>
  );
}

function RunInspectorHeader(props: {
  tab: RunInspectorTab;
}): React.ReactElement {
  return (
    <>
      <Text color="cyan" bold>
        run inspector
      </Text>
      <Text dimColor>{tabSelectorLabel(props.tab)}</Text>
    </>
  );
}

function tabSelectorLabel(active: RunInspectorTab): string {
  return RUN_INSPECTOR_TABS.map((tab, index) =>
    tab === active ? `[${index + 1} ${tab}]` : `${index + 1} ${tab}`,
  ).join(" · ");
}

function FactsView(props: { facts: RunInspectorFacts }): React.ReactElement {
  const facts = props.facts;
  const approvalsResolved = facts.approvalsApproved + facts.approvalsDenied;
  return (
    <>
      <Text>
        <Text dimColor>events </Text>
        {facts.eventCount}
        <Text dimColor> · runs </Text>
        {facts.runCompleted}/{facts.runStarted}
        {facts.runFailed > 0 ? (
          <Text color="red"> failed {facts.runFailed}</Text>
        ) : null}
      </Text>
      <Text>
        <Text dimColor>model calls </Text>
        {facts.modelCalls}
        <Text dimColor> · tool calls </Text>
        {facts.toolCalls}
      </Text>
      <Text>
        <Text dimColor>approvals </Text>
        {approvalsResolved}/{facts.approvalsRequested}
        {facts.approvalsDenied > 0 ? (
          <Text color="red"> denied {facts.approvalsDenied}</Text>
        ) : null}
      </Text>
      <Text>
        <Text dimColor>changed files </Text>
        {facts.changedFiles.length}
      </Text>
      {facts.changedFiles.slice(0, 5).map((path) => (
        <Text key={path} dimColor>
          {"  "}
          {path}
        </Text>
      ))}
      {facts.changedFiles.length > 5 ? (
        <Text dimColor> +{facts.changedFiles.length - 5} more</Text>
      ) : null}
      {facts.lastCommand ? (
        <Text>
          <Text dimColor>last command </Text>
          {facts.lastCommand}
        </Text>
      ) : null}
      {facts.errorCount > 0 ? (
        <Text color="red">
          errors {facts.errorCount}
          {facts.lastError ? ` · ${facts.lastError}` : ""}
        </Text>
      ) : (
        <Text dimColor>errors 0</Text>
      )}
      <Text dimColor>press 1/2/3 tabs · esc/q close</Text>
    </>
  );
}

function TurnsView(props: {
  turns: ReturnType<typeof extractTurns>;
  viewportRows: number;
}): React.ReactElement {
  const visible = props.turns.slice(0, Math.max(1, props.viewportRows - 4));
  return (
    <>
      <Text dimColor>
        {props.turns.length} turn{props.turns.length === 1 ? "" : "s"} recorded
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>(no user turns recorded yet)</Text>
      ) : (
        visible.map((turn, index) => (
          <Box key={`${turn.sequence}:${index}`}>
            <Text dimColor>[{String(turn.sequence).padStart(3, " ")}] </Text>
            <Text>{turn.goal.replace(/\n/g, " ").slice(0, 72)}</Text>
          </Box>
        ))
      )}
      {props.turns.length > visible.length ? (
        <Text dimColor>+{props.turns.length - visible.length} more</Text>
      ) : null}
      <Text dimColor>
        press 1/2/3 tabs · /fork to branch a turn · esc/q close
      </Text>
    </>
  );
}

function emptyMessage(filter: EventDetailFilter, query: string): string {
  if (query.trim()) {
    return `(no ${eventDetailEmptyLabel(filter)} events match /${formatSearchQueryLabel(query)})`;
  }
  return `(no ${eventDetailEmptyLabel(filter)} events)`;
}

function formatSearchQueryLabel(query: string): string {
  const compact = query.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_SEARCH_QUERY_LABEL) return compact;
  return `${compact.slice(0, MAX_SEARCH_QUERY_LABEL - 1)}…`;
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
  return pruneValue(value, 0, new WeakSet<object>(), {
    maxString: MAX_DETAIL_STRING,
    maxArray: MAX_DETAIL_ARRAY,
    maxKeys: MAX_DETAIL_KEYS,
    maxDepth: MAX_DETAIL_DEPTH,
  });
}

function pruneValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  limits: {
    maxString: number;
    maxArray: number;
    maxKeys: number;
    maxDepth: number;
  },
): unknown {
  if (typeof value === "string") {
    if (value.length <= limits.maxString) return value;
    return {
      type: "string",
      length: value.length,
      preview: value.slice(0, limits.maxString),
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
  if (depth >= limits.maxDepth) return "[MaxDepth]";
  seen.add(value);

  if (Array.isArray(value)) {
    const shown = value
      .slice(0, limits.maxArray)
      .map((item) => pruneValue(item, depth + 1, seen, limits));
    if (value.length <= limits.maxArray) return shown;
    return {
      type: "array",
      length: value.length,
      preview: shown,
      truncated: true,
    };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, nested] of entries.slice(0, limits.maxKeys)) {
    out[key] = pruneValue(nested, depth + 1, seen, limits);
  }
  if (entries.length > limits.maxKeys) {
    out.__truncatedKeys = entries.length - limits.maxKeys;
  }
  return out;
}
