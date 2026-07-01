import type {
  TaskOutputChunkSnapshot,
  TaskRecordSnapshot,
} from "@sparkwright/protocol";
import type { RunEvent } from "./event-type.js";
import { sanitizeAnsiForRender } from "./text.js";

export type ActivityTab = "tasks" | "events" | "trace" | "run";
export type TaskActivityStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskActivityItem {
  id: string;
  kind: string;
  title: string;
  command: string;
  cwd: string;
  status: TaskActivityStatus;
  exitCode?: number;
  error?: string;
  outputChunks: number;
  outputBytes: number;
  startedAt?: string;
  completedAt?: string;
  lastOutputAt?: string;
  durationMs?: number;
  lastSequence: number;
  head: string[];
  tail: string[];
  untrackedWritePossible: boolean;
}

export interface TaskActivitySummary {
  tasks: TaskActivityItem[];
  total: number;
  /** @reserved Public task-activity count consumed by Activity Drawer summaries. */
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  untrackedWritePossible: boolean;
}

const MAX_TAIL_LINES = 80;

export function summarizeTaskActivity(
  events: readonly RunEvent[],
  records: readonly TaskRecordSnapshot[] = [],
  outputs: Readonly<Record<string, readonly TaskOutputChunkSnapshot[]>> = {},
): TaskActivitySummary {
  const byId = new Map<string, TaskActivityItem>();
  for (const event of events) {
    const p = rec(event.payload);
    const taskId = str(p.taskId) || str(p.id);
    if (event.type.startsWith("task.") && taskId) {
      const task = ensureTask(byId, taskId, event.sequence);
      task.lastSequence = event.sequence;
      updateTaskFromPayload(task, p);
      if (event.type === "task.created") task.status = "created";
      else if (event.type === "task.started") task.status = "running";
      else if (event.type === "task.output") {
        task.status = terminalStatus(task.status) ? task.status : "running";
        appendOutput(task, p);
      } else if (event.type === "task.completed") {
        task.status = "completed";
        updateTerminalTask(task, p, event);
      } else if (event.type === "task.failed") {
        task.status = "failed";
        updateTerminalTask(task, p, event);
      } else if (event.type === "task.cancelled") {
        task.status = "cancelled";
        updateTerminalTask(task, p, event);
      }
      continue;
    }

    if (event.type === "workspace.write.untracked_access_granted" && taskId) {
      const task = ensureTask(byId, taskId, event.sequence);
      task.untrackedWritePossible = true;
      task.lastSequence = event.sequence;
      updateTaskFromPayload(task, p);
      continue;
    }

    if (event.type === "tool.completed") {
      const toolName = str(p.toolName);
      if (!isTaskToolName(toolName)) continue;
      const output = rec(p.output ?? p.result);
      const outputTaskId = str(output.id) || str(output.taskId);
      if (!outputTaskId) continue;
      const task = ensureTask(byId, outputTaskId, event.sequence);
      task.lastSequence = event.sequence;
      updateTaskFromPayload(task, output);
      const status = str(output.status);
      if (isTaskStatus(status)) task.status = status;
      const chunks = output.chunks;
      if (Array.isArray(chunks)) {
        for (const chunk of chunks) appendOutput(task, rec(chunk));
      }
    }
  }
  for (const record of records) {
    const task = ensureTask(byId, record.id, 0);
    updateTaskFromPayload(task, record as unknown as Record<string, unknown>);
    task.status = record.status === "pending" ? "created" : record.status;
    if (task.head.length === 0 && task.tail.length === 0) {
      for (const chunk of outputs[record.id] ?? []) {
        appendOutput(task, chunk as unknown as Record<string, unknown>);
      }
      updateTaskFromPayload(task, record as unknown as Record<string, unknown>);
    }
  }

  const tasks = [...byId.values()].sort(
    (a, b) => b.lastSequence - a.lastSequence,
  );
  return {
    tasks,
    total: tasks.length,
    running: tasks.filter((task) => task.status === "running").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
    untrackedWritePossible: tasks.some((task) => task.untrackedWritePossible),
  };
}

export function shortTaskId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 9)}...${id.slice(-6)}` : id;
}

export function taskStatusLabel(task: TaskActivityItem): string {
  if (task.status === "completed" && typeof task.exitCode === "number") {
    return `completed exit ${task.exitCode}`;
  }
  if (task.status === "failed" && typeof task.exitCode === "number") {
    return `failed exit ${task.exitCode}`;
  }
  return task.status;
}

export function taskDurationLabel(task: TaskActivityItem): string {
  if (typeof task.durationMs === "number")
    return formatDuration(task.durationMs);
  const start = parseTime(task.startedAt);
  const end = parseTime(task.completedAt);
  if (start !== undefined && end !== undefined && end >= start) {
    return formatDuration(end - start);
  }
  return "";
}

function ensureTask(
  byId: Map<string, TaskActivityItem>,
  id: string,
  sequence: number,
): TaskActivityItem {
  const existing = byId.get(id);
  if (existing) return existing;
  const task: TaskActivityItem = {
    id,
    kind: "",
    title: "",
    command: "",
    cwd: "",
    status: "created",
    outputChunks: 0,
    outputBytes: 0,
    lastSequence: sequence,
    head: [],
    tail: [],
    untrackedWritePossible: false,
  };
  byId.set(id, task);
  return task;
}

function updateTaskFromPayload(
  task: TaskActivityItem,
  payload: Record<string, unknown>,
): void {
  const metadata = rec(payload.metadata);
  const result = rec(payload.result);
  const output = objectRec(payload.output) ?? objectRec(result.output);
  const error = rec(payload.error);
  task.kind = str(payload.kind) || task.kind;
  task.title = str(payload.title) || task.title;
  task.command =
    str(payload.command) ||
    str(metadata.command) ||
    str(result.command) ||
    task.command;
  task.cwd = str(payload.cwd) || str(metadata.cwd) || task.cwd;
  task.startedAt = str(payload.startedAt) || task.startedAt;
  task.completedAt =
    str(payload.completedAt) || str(result.completedAt) || task.completedAt;
  task.lastOutputAt = str(payload.lastOutputAt) || task.lastOutputAt;
  if (typeof payload.outputChunks === "number") {
    task.outputChunks = payload.outputChunks;
  }
  if (typeof payload.outputBytes === "number") {
    task.outputBytes = payload.outputBytes;
  }
  if (
    typeof output?.stdoutBytes === "number" ||
    typeof output?.stderrBytes === "number"
  ) {
    task.outputBytes =
      (typeof output?.stdoutBytes === "number" ? output.stdoutBytes : 0) +
      (typeof output?.stderrBytes === "number" ? output.stderrBytes : 0);
  }
  if (typeof result.exitCode === "number") task.exitCode = result.exitCode;
  if (typeof payload.exitCode === "number") task.exitCode = payload.exitCode;
  task.error =
    str(error.message) ||
    str(payload.message) ||
    str(payload.reason) ||
    task.error;
  appendPreviewOutput(task, output);
}

function updateTerminalTask(
  task: TaskActivityItem,
  payload: Record<string, unknown>,
  event: RunEvent,
): void {
  updateTaskFromPayload(task, payload);
  task.completedAt = task.completedAt || event.occurredAt;
  const meta = rec(event.metadata);
  if (typeof meta.durationMs === "number") task.durationMs = meta.durationMs;
  if (typeof payload.progressCount === "number") {
    task.outputChunks = payload.progressCount;
  }
}

function appendOutput(
  task: TaskActivityItem,
  payload: Record<string, unknown>,
): void {
  const data = sanitizeAnsiForRender(str(payload.data));
  if (!data) return;
  task.outputChunks += 1;
  task.outputBytes += data.length;
  task.lastOutputAt = str(payload.timestamp) || task.lastOutputAt;
  const channel = str(payload.channel);
  const prefix = channel === "stderr" ? "stderr: " : "";
  for (const line of splitOutputLines(data)) {
    const rendered = `${prefix}${line}`;
    if (task.head.length < MAX_TAIL_LINES) task.head.push(rendered);
    task.tail.push(rendered);
  }
  trimTail(task);
}

function appendPreviewOutput(
  task: TaskActivityItem,
  output: Record<string, unknown> | null,
): void {
  if (!output) return;
  const stdout = sanitizeAnsiForRender(str(output.stdoutPreview));
  const stderr = sanitizeAnsiForRender(str(output.stderrPreview));
  const lines = [
    ...splitOutputLines(stdout),
    ...splitOutputLines(stderr).map((line) => `stderr: ${line}`),
  ];
  if (lines.length === 0) return;
  task.head = lines.slice(0, MAX_TAIL_LINES);
  task.tail = lines.slice(-MAX_TAIL_LINES);
}

function splitOutputLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function trimTail(task: TaskActivityItem): void {
  if (task.tail.length > MAX_TAIL_LINES) {
    task.tail = task.tail.slice(-MAX_TAIL_LINES);
  }
}

function terminalStatus(status: TaskActivityStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function isTaskToolName(name: string): boolean {
  return name === "task" || name.startsWith("task_");
}

function isTaskStatus(value: string): value is TaskActivityStatus {
  return (
    value === "created" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function objectRec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rec(value: unknown): Record<string, unknown> {
  return objectRec(value) ?? {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
