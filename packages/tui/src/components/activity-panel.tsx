import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type {
  TaskOutputChunkSnapshot,
  TaskRecordSnapshot,
} from "@sparkwright/protocol";
import type { RunEvent } from "../lib/event-type.js";
import { formatEvent } from "../lib/format-event.js";
import { collapseText, prettyJson } from "../lib/collapse.js";
import {
  type ActivityTab,
  type TaskActivityItem,
  shortTaskId,
  summarizeTaskActivity,
  taskDurationLabel,
  taskStatusLabel,
} from "../lib/task-activity.js";
import { oneLine } from "../lib/tool-display.js";
import { useTheme } from "../lib/theme-context.js";
import { DialogFrame } from "./dialog-frame.js";
import {
  eventDetailFilterLabel,
  eventMatchesFilter,
  eventMatchesSearch,
  summarizeRunInspectorFacts,
  type EventDetailFilter,
} from "./event-detail.js";

export type { ActivityTab } from "../lib/task-activity.js";

const TABS: ActivityTab[] = ["tasks", "events", "trace", "run"];
const EVENT_FILTERS: EventDetailFilter[] = [
  "all",
  "errors",
  "approvals",
  "tools",
  "writes",
  "model",
];
const MAX_EVENT_ROWS = 10;
const MAX_EVENT_SCAN = 500;
const MAX_TASK_ROWS = 8;
const MAX_OUTPUT_LINES = 10;
const MAX_DETAIL_LINES = 16;
const MAX_DETAIL_CHARS = 2600;

type OutputMode = "tail" | "head" | "follow";

interface EventActivityRow {
  event: RunEvent;
  formatted: ReturnType<typeof formatEvent>;
}

export function ActivityPanel(props: {
  events: RunEvent[];
  taskRecords?: readonly TaskRecordSnapshot[];
  taskOutputs?: Readonly<Record<string, readonly TaskOutputChunkSnapshot[]>>;
  loadingTasks?: boolean;
  initialTab?: ActivityTab;
  onClose: () => void;
  onTabChange?: (tab: ActivityTab) => void;
  onRefreshTasks?: () => void;
  onStopTask?: (taskId: string) => void;
  onJoinTask?: (taskId: string) => void;
  onPromoteTask?: (taskId: string) => void;
}): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  const summary = useMemo(
    () =>
      summarizeTaskActivity(
        props.events,
        props.taskRecords ?? [],
        props.taskOutputs ?? {},
      ),
    [props.events, props.taskRecords, props.taskOutputs],
  );
  const facts = useMemo(
    () => summarizeRunInspectorFacts(props.events),
    [props.events],
  );
  const [tabIndex, setTabIndex] = useState(() =>
    Math.max(0, TABS.indexOf(props.initialTab ?? "tasks")),
  );
  const [cursor, setCursor] = useState(0);
  const [outputMode, setOutputMode] = useState<OutputMode>("tail");
  const [detailScroll, setDetailScroll] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [filterIndex, setFilterIndex] = useState(0);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const tab = TABS[tabIndex] ?? "tasks";
  const filter = EVENT_FILTERS[filterIndex] ?? "all";
  const eventSource = useMemo(
    () => props.events.slice(-MAX_EVENT_SCAN),
    [props.events],
  );
  const eventRows = useMemo<EventActivityRow[]>(
    () =>
      eventSource
        .map((event) => ({ event, formatted: formatEvent(event) }))
        .filter(
          (row) =>
            eventMatchesFilter(row.event, filter) &&
            eventMatchesSearch(row.event, row.formatted, searchQuery),
        ),
    [eventSource, filter, searchQuery],
  );
  const safeTaskCursor = Math.min(
    cursor,
    Math.max(0, summary.tasks.length - 1),
  );
  const selectedTask = summary.tasks[safeTaskCursor];
  const detailLineCount = selectedTask
    ? outputMode === "head"
      ? selectedTask.head.length
      : selectedTask.tail.length
    : 0;
  const maxDetailScroll = Math.max(0, detailLineCount - MAX_OUTPUT_LINES);

  const resetDetailScroll = (): void => setDetailScroll(0);
  const scrollTaskDetails = (direction: "older" | "newer", amount: number) => {
    if (detailLineCount <= MAX_OUTPUT_LINES) return;
    if (outputMode === "follow") setOutputMode("tail");
    setDetailScroll((value) => {
      const delta =
        outputMode === "head"
          ? direction === "newer"
            ? amount
            : -amount
          : direction === "older"
            ? amount
            : -amount;
      return clamp(value + delta, 0, maxDetailScroll);
    });
  };

  useEffect(() => {
    const next = props.initialTab;
    if (!next) return;
    const index = TABS.indexOf(next);
    if (index >= 0) setTabIndex(index);
  }, [props.initialTab]);

  const setTab = (next: number): void => {
    const wrapped = (next + TABS.length) % TABS.length;
    setTabIndex(wrapped);
    setCursor(0);
    setExpanded(false);
    setSearchMode(false);
    props.onTabChange?.(TABS[wrapped] ?? "tasks");
  };

  useInput((input, key) => {
    if (searchMode) {
      if (key.escape) {
        setSearchMode(false);
        if (searchQuery) {
          setSearchQuery("");
          setCursor(0);
          setExpanded(false);
        }
        return;
      }
      if (key.return) {
        setSearchMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((query) => query.slice(0, -1));
        setCursor(0);
        setExpanded(false);
        return;
      }
      if (key.ctrl || key.meta || key.tab) return;
      if (input) {
        setSearchQuery((query) => query + input);
        setCursor(0);
        setExpanded(false);
      }
      return;
    }
    if (key.escape || (key.ctrl && input === "c")) {
      props.onClose();
      return;
    }
    if (tab === "events" && input === "/") {
      setSearchMode(true);
      setExpanded(false);
      return;
    }
    if (tab === "events" && input === "x" && searchQuery) {
      setSearchQuery("");
      setCursor(0);
      setExpanded(false);
      return;
    }
    if (tab === "events" && (input === "o" || key.return)) {
      setExpanded((value) => !value);
      return;
    }
    if (tab === "tasks") {
      if (input === "r") {
        props.onRefreshTasks?.();
        return;
      }
      if (input === "s") {
        const selected =
          summary.tasks[Math.min(cursor, summary.tasks.length - 1)];
        if (selected && selected.status === "running") {
          props.onStopTask?.(selected.id);
        }
        return;
      }
      if (input === "w") {
        const selected =
          summary.tasks[Math.min(cursor, summary.tasks.length - 1)];
        if (selected && selected.status === "running") {
          props.onJoinTask?.(selected.id);
        }
        return;
      }
      if (input === "p") {
        const selected =
          summary.tasks[Math.min(cursor, summary.tasks.length - 1)];
        if (selected && selected.status === "running") {
          props.onPromoteTask?.(selected.id);
        }
        return;
      }
      if (input === "f") {
        setOutputMode("follow");
        resetDetailScroll();
        return;
      }
      if (input === "H") {
        setOutputMode("head");
        resetDetailScroll();
        return;
      }
      if (input === "T") {
        setOutputMode("tail");
        resetDetailScroll();
        return;
      }
      if (key.pageUp || input === "[") {
        scrollTaskDetails("older", key.pageUp ? MAX_OUTPUT_LINES : 1);
        return;
      }
      if (key.pageDown || input === "]") {
        scrollTaskDetails("newer", key.pageDown ? MAX_OUTPUT_LINES : 1);
        return;
      }
    }
    if (key.tab || input === "l") {
      if (tab === "events" && input === "l") {
        setFilterIndex((value) => (value + 1) % EVENT_FILTERS.length);
        setCursor(0);
        setExpanded(false);
        return;
      }
      setTab(tabIndex + 1);
      return;
    }
    if (input === "h") {
      if (tab === "events") {
        setFilterIndex(
          (value) => (value - 1 + EVENT_FILTERS.length) % EVENT_FILTERS.length,
        );
        setCursor(0);
        setExpanded(false);
        return;
      }
      setTab(tabIndex - 1);
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((value) => Math.max(0, value - 1));
      resetDetailScroll();
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((value) => value + 1);
      resetDetailScroll();
      return;
    }
    if (key.pageUp || input === "g") {
      setCursor(0);
      resetDetailScroll();
      return;
    }
    if (key.pageDown || input === "G") {
      setCursor(10_000);
      resetDetailScroll();
    }
  });

  const taskCountLabel =
    summary.total === 0
      ? "no tasks"
      : [
          summary.running ? `${summary.running} running` : "",
          summary.failed ? `${summary.failed} failed` : "",
          summary.completed ? `${summary.completed} completed` : "",
        ]
          .filter(Boolean)
          .join(" · ");
  const activityStatusLabel =
    tab === "tasks" ? taskCountLabel : `events ${props.events.length}`;

  return (
    <DialogFrame borderColor={summary.failed > 0 ? "red" : theme.accent}>
      <Box flexDirection="column">
        <Box>
          <Text color={theme.accent} bold>
            activity
          </Text>
          <Text dimColor> · ctrl+o/esc close · tab switch</Text>
          <Box flexGrow={1} />
          <Text dimColor>{activityStatusLabel}</Text>
        </Box>
        <Box marginBottom={1}>
          {TABS.map((entry) => (
            <Text
              key={entry}
              color={entry === tab ? theme.accent : theme.muted}
              bold={entry === tab}
            >
              {entry === tab ? `[${entry}] ` : `${entry} `}
            </Text>
          ))}
        </Box>
        {tab === "tasks" ? (
          <TasksTab
            tasks={summary.tasks}
            cursor={cursor}
            width={stdout?.columns ?? 100}
            outputMode={outputMode}
            detailScroll={detailScroll}
            loading={props.loadingTasks ?? false}
            onStopTask={props.onStopTask}
            onJoinTask={props.onJoinTask}
            onPromoteTask={props.onPromoteTask}
          />
        ) : tab === "events" ? (
          <EventsTab
            rows={eventRows}
            cursor={cursor}
            expanded={expanded}
            filter={filter}
            searchMode={searchMode}
            searchQuery={searchQuery}
            limited={props.events.length > eventSource.length}
          />
        ) : tab === "trace" ? (
          <TraceTab events={props.events} />
        ) : (
          <RunTab facts={facts} />
        )}
      </Box>
    </DialogFrame>
  );
}

export function activityTabFromPayload(
  payload: unknown,
): ActivityTab | undefined {
  const record =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const tab = record.tab;
  return typeof tab === "string" && isActivityTab(tab) ? tab : undefined;
}

function TasksTab(props: {
  tasks: TaskActivityItem[];
  cursor: number;
  width: number;
  outputMode: OutputMode;
  detailScroll: number;
  loading: boolean;
  onStopTask?: (taskId: string) => void;
  onJoinTask?: (taskId: string) => void;
  onPromoteTask?: (taskId: string) => void;
}): React.ReactElement {
  const theme = useTheme();
  if (props.tasks.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{props.loading ? "refreshing" : "r refresh"}</Text>
        <Text dimColor>No background tasks yet.</Text>
      </Box>
    );
  }
  const safeCursor = Math.min(props.cursor, props.tasks.length - 1);
  const start = Math.max(
    0,
    Math.min(
      safeCursor - MAX_TASK_ROWS + 1,
      props.tasks.length - MAX_TASK_ROWS,
    ),
  );
  const shown = props.tasks.slice(start, start + MAX_TASK_ROWS);
  const selected = props.tasks[safeCursor] ?? props.tasks[0]!;
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {props.loading ? "refreshing · " : ""}session tasks · r refresh · s stop
        {props.onJoinTask ? " · w join" : ""}
        {props.onPromoteTask ? " · p promote" : ""} · f follow · H head · T tail
      </Text>
      {shown.map((task, index) => {
        const absoluteIndex = start + index;
        const active = absoluteIndex === safeCursor;
        const color =
          task.status === "failed" || task.status === "cancelled"
            ? theme.error
            : task.status === "completed"
              ? theme.success
              : theme.accent;
        const last = task.tail[task.tail.length - 1] ?? "";
        const line = [
          active ? ">" : " ",
          shortTaskId(task.id),
          taskStatusLabel(task),
          task.awaited ? "awaited" : "detached",
          task.kind,
          task.error ? `error: ${task.error}` : last,
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <Text key={task.id} color={active ? color : undefined}>
            {truncate(line, Math.max(32, props.width - 8))}
          </Text>
        );
      })}
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.accent}>details</Text>
        <TaskDetails
          task={selected}
          width={props.width}
          outputMode={props.outputMode}
          detailScroll={props.detailScroll}
          canStop={Boolean(props.onStopTask && selected.status === "running")}
          canJoin={Boolean(props.onJoinTask && selected.status === "running")}
          canPromote={Boolean(
            props.onPromoteTask && selected.status === "running",
          )}
        />
      </Box>
    </Box>
  );
}

function TaskDetails(props: {
  task: TaskActivityItem;
  width: number;
  outputMode: OutputMode;
  detailScroll: number;
  canStop: boolean;
  canJoin: boolean;
  canPromote: boolean;
}): React.ReactElement {
  const duration = taskDurationLabel(props.task);
  const outputModeLabel =
    props.outputMode === "follow"
      ? "follow"
      : props.outputMode === "head"
        ? "head"
        : "tail";
  const lines = [
    `id ${props.task.id}`,
    `status ${taskStatusLabel(props.task)}${duration ? ` · ${duration}` : ""}`,
    `mode ${props.task.awaited ? "awaited" : "detached"}`,
    props.task.kind ? `kind ${props.task.kind}` : "",
    props.task.cwd ? `cwd ${props.task.cwd}` : "",
    props.task.command || props.task.title
      ? `$ ${props.task.command || props.task.title}`
      : "",
    props.task.untrackedWritePossible ? "untracked writes possible" : "",
    props.task.error ? `error ${props.task.error}` : "",
    `output ${props.task.outputChunks} chunk${props.task.outputChunks === 1 ? "" : "s"} · ${props.task.outputBytes} bytes`,
  ].filter(Boolean);
  const sourceOutput =
    props.outputMode === "head" ? props.task.head : props.task.tail;
  const maxScroll = Math.max(0, sourceOutput.length - MAX_OUTPUT_LINES);
  const scroll = clamp(props.detailScroll, 0, maxScroll);
  const start =
    props.outputMode === "head"
      ? scroll
      : Math.max(0, sourceOutput.length - MAX_OUTPUT_LINES - scroll);
  const output = sourceOutput.slice(start, start + MAX_OUTPUT_LINES);
  const scrollLabel =
    maxScroll > 0 ? ` · PgUp/PgDn ${scroll}/${maxScroll}` : "";
  const actionHint = [
    props.canJoin ? "w join" : "",
    props.canPromote ? "p promote" : "",
    props.canStop ? "s stop" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} dimColor>
          {truncate(line, Math.max(32, props.width - 8))}
        </Text>
      ))}
      {output.length > 0 ? (
        <Text dimColor>
          {outputModeLabel} · f follow · H head · T tail
          {scrollLabel}
          {actionHint ? ` · ${actionHint}` : ""}
        </Text>
      ) : (
        <Text dimColor>
          f follow · H head · T tail{actionHint ? ` · ${actionHint}` : ""}
        </Text>
      )}
      {output.map((line, index) => (
        <Text key={`tail:${index}`}>
          {truncate(line, Math.max(32, props.width - 8))}
        </Text>
      ))}
    </Box>
  );
}

function EventsTab(props: {
  rows: EventActivityRow[];
  cursor: number;
  expanded: boolean;
  filter: EventDetailFilter;
  searchMode: boolean;
  searchQuery: string;
  limited: boolean;
}): React.ReactElement {
  const rows = props.rows;
  const safeCursor = Math.min(props.cursor, Math.max(0, rows.length - 1));
  const start = Math.max(
    0,
    Math.min(
      safeCursor - MAX_EVENT_ROWS + 1,
      Math.max(0, rows.length - MAX_EVENT_ROWS),
    ),
  );
  const shown = rows.slice(start, start + MAX_EVENT_ROWS);
  const selected = rows[safeCursor]?.event;
  const query = props.searchQuery.trim();
  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {props.limited ? `latest ${MAX_EVENT_SCAN} · ` : ""}
          filter:{eventDetailFilterLabel(props.filter)}
          {query ? ` · /${query}` : ""}
        </Text>
        <Text dimColor>No matching events.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {props.limited ? `latest ${MAX_EVENT_SCAN} · ` : ""}
        filter:{eventDetailFilterLabel(props.filter)} · #{safeCursor + 1}/
        {rows.length}
        {query ? ` · /${query}` : ""}
      </Text>
      <Text dimColor>
        {props.searchMode
          ? "type search · enter done · esc clear"
          : "l/h filter · / search · x clear · o expand"}
      </Text>
      {shown.map((row, index) => {
        const absoluteIndex = start + index;
        const event = row.event;
        const formatted = row.formatted;
        const active = absoluteIndex === safeCursor;
        return (
          <Text
            key={event.id ?? `${event.sequence}`}
            color={active ? formatted.color : undefined}
          >
            {active ? "> " : "  "}
            <Text dimColor>[{String(event.sequence).padStart(3, " ")}] </Text>
            {formatted.label}
            {formatted.detail ? (
              <Text dimColor> {formatted.detail}</Text>
            ) : null}
          </Text>
        );
      })}
      {props.expanded && selected ? <ExpandedEvent event={selected} /> : null}
    </Box>
  );
}

function ExpandedEvent(props: { event: RunEvent }): React.ReactElement {
  const json = prettyJson(props.event);
  const collapsed = collapseText(json, MAX_DETAIL_LINES, MAX_DETAIL_CHARS);
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      <Text>
        <Text dimColor>type </Text>
        {props.event.type}
      </Text>
      {collapsed.body.split("\n").map((line, index) => (
        <Text key={index} dimColor>
          {line || " "}
        </Text>
      ))}
      {collapsed.overflow ? (
        <Text dimColor>
          ... truncated (
          {collapsed.droppedLines > 0
            ? `+${collapsed.droppedLines} lines`
            : `+${collapsed.droppedChars} chars`}
          )
        </Text>
      ) : null}
    </Box>
  );
}

function TraceTab(props: { events: RunEvent[] }): React.ReactElement {
  const taskEvents = props.events.filter((event) =>
    event.type.startsWith("task."),
  );
  const failures = props.events.filter(
    (event) =>
      event.type.endsWith(".failed") ||
      event.type.endsWith(".denied") ||
      event.type.endsWith(".rejected"),
  );
  return (
    <Box flexDirection="column">
      <Text>events {props.events.length}</Text>
      <Text>task events {taskEvents.length}</Text>
      <Text>failure-like events {failures.length}</Text>
      <Text dimColor>
        Raw trace remains the source of truth for exact payloads and
        diagnostics.
      </Text>
    </Box>
  );
}

function RunTab(props: {
  facts: ReturnType<typeof summarizeRunInspectorFacts>;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>events {props.facts.eventCount}</Text>
      <Text>
        runs {props.facts.runStarted} started · {props.facts.runCompleted}{" "}
        completed
      </Text>
      <Text>tools {props.facts.toolCalls}</Text>
      <Text>model calls {props.facts.modelCalls}</Text>
      <Text>
        approvals {props.facts.approvalsApproved + props.facts.approvalsDenied}/
        {props.facts.approvalsRequested}
      </Text>
      <Text>changed files {props.facts.changedFiles.length}</Text>
      {props.facts.lastCommand ? (
        <Text dimColor>{oneLine(props.facts.lastCommand, 120)}</Text>
      ) : null}
      {props.facts.lastError ? (
        <Text color="red">{props.facts.lastError}</Text>
      ) : null}
    </Box>
  );
}

function isActivityTab(value: string): value is ActivityTab {
  return (
    value === "tasks" ||
    value === "events" ||
    value === "trace" ||
    value === "run"
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
