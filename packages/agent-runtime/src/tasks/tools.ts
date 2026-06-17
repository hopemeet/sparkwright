// AI maintenance note: These ToolDefinitions expose the TaskManager
// surface to LLMs. They are intentionally thin — argument parsing and
// translation to TaskManager calls. Risk classification:
//   task_create -> external (host runs arbitrary registered kinds)
//   task(action="stop") -> write
//   task_stop   -> write    (mutates lifecycle state)
//   task(action="list"|"get"|"output") / task_list / task_get / task_output -> read
//
// The host defaults to the compressed task(action=...) surface and keeps the
// legacy task_* tools opt-in for compatibility.

import { defineTool, type ToolDefinition } from "@sparkwright/core";
import type { RunId } from "@sparkwright/core";
import type { TaskManager } from "./manager.js";
import type {
  TaskId,
  TaskOutputChunk,
  TaskRecord,
  TaskStatus,
} from "./types.js";

/**
 * Options for {@link createTaskTools}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface CreateTaskToolsOptions {
  manager: TaskManager;
  /**
   * Resolver for the active run id. Tools call this on every invocation so
   * the same tool bundle can be shared across runs.
   */
  getParentRunId(): RunId;
  /**
   * Default cap on chunks returned by `task_output`. Default 200.
   */
  defaultMaxOutputChunks?: number;
}

const DEFAULT_MAX_OUTPUT_CHUNKS = 200;

/**
 * Build the five long-running-task tools backed by a {@link TaskManager}.
 *
 * @public
 * @stability experimental v0.1
 */
export function createTaskTools(options: CreateTaskToolsOptions): {
  taskCreate: ToolDefinition;
  task: ToolDefinition;
  taskList: ToolDefinition;
  taskGet: ToolDefinition;
  taskStop: ToolDefinition;
  taskOutput: ToolDefinition;
  all(): ToolDefinition[];
} {
  const taskCreate = createTaskCreate(options);
  const task = createTaskControl(options);
  const taskList = createTaskList(options);
  const taskGet = createTaskGet(options);
  const taskStop = createTaskStop(options);
  const taskOutput = createTaskOutput(options);
  return {
    taskCreate,
    task,
    taskList,
    taskGet,
    taskStop,
    taskOutput,
    all: () => [taskCreate, task, taskList, taskGet, taskStop, taskOutput],
  };
}

/** @public @stability experimental v0.1 */
export function createTaskCreate(
  options: CreateTaskToolsOptions,
): ToolDefinition {
  return defineTool({
    name: "task_create",
    description:
      "Spawn a long-running background task by kind. Returns the task id; use task(action=get) / task(action=output) to monitor.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        title: { type: "string" },
        payload: { type: "object" },
      },
      required: ["kind"],
    },
    deferLoading: false,
    policy: { risk: "risky", requiresApproval: false },
    governance: { sideEffects: ["external"] },
    async execute(args: unknown): Promise<{ taskId: TaskId }> {
      const parsed = parseCreateArgs(args);
      const runner = options.manager.getRunner(parsed.kind);
      if (!runner) {
        throw makeToolError(
          "TASK_KIND_UNREGISTERED",
          `No runner registered for task kind: ${parsed.kind}`,
        );
      }
      const handle = options.manager.spawn({
        parentRunId: options.getParentRunId(),
        kind: parsed.kind,
        title: parsed.title,
        payload: parsed.payload,
      });
      return { taskId: handle.record.id };
    },
  });
}

/** @public @stability experimental v0.1 */
export function createTaskControl(
  options: CreateTaskToolsOptions,
): ToolDefinition {
  const taskList = createTaskList(options);
  const taskGet = createTaskGet(options);
  const taskStop = createTaskStop(options);
  const taskOutput = createTaskOutput(options);
  return defineTool({
    name: "task",
    description:
      "Manage background tasks. Use action=list to inspect tasks, get for one task record, output for buffered task output, and stop to request cancellation.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "output", "stop"],
        },
        taskId: { type: "string" },
        status: { type: "string" },
        kind: { type: "string" },
        fromSequence: { type: "integer" },
        maxChunks: { type: "integer" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    deferLoading: false,
    policy: { risk: "risky", requiresApproval: false },
    governance: { sideEffects: ["read", "write"] },
    policyForArgs(args: unknown) {
      const record = args && typeof args === "object" ? args : {};
      if ((record as Record<string, unknown>).action === "stop") {
        return {
          policy: { risk: "risky", requiresApproval: false },
          governance: { sideEffects: ["write"] },
        };
      }
      return {
        policy: { risk: "safe", requiresApproval: false },
        governance: { sideEffects: ["read"] },
      };
    },
    isReadOnly(args: unknown): boolean {
      const record = args && typeof args === "object" ? args : {};
      return (record as Record<string, unknown>).action !== "stop";
    },
    async execute(args: unknown, ctx) {
      const record = requireRecord(args, "task");
      switch (record.action) {
        case "list":
          return taskList.execute(args, ctx);
        case "get":
          return taskGet.execute(args, ctx);
        case "output":
          return taskOutput.execute(args, ctx);
        case "stop":
          return taskStop.execute(args, ctx);
        default:
          throw makeToolError(
            "TASK_ARGUMENTS_INVALID",
            "task: action must be one of list, get, output, or stop.",
          );
      }
    },
  });
}

/** @public @stability experimental v0.1 */
export function createTaskList(
  options: CreateTaskToolsOptions,
): ToolDefinition {
  return defineTool({
    name: "task_list",
    description:
      "List background tasks, optionally filtered by status or kind.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        kind: { type: "string" },
      },
    },
    deferLoading: false,
    policy: { risk: "safe", requiresApproval: false },
    governance: { sideEffects: ["read"] },
    async execute(args: unknown): Promise<{ tasks: TaskRecord[] }> {
      const parsed = parseListArgs(args);
      const tasks = options.manager.store.list({
        status: parsed.status,
        kind: parsed.kind,
        parentRunId: options.getParentRunId(),
      });
      return { tasks };
    },
  });
}

/** @public @stability experimental v0.1 */
export function createTaskGet(options: CreateTaskToolsOptions): ToolDefinition {
  return defineTool({
    name: "task_get",
    description: "Fetch the latest record for a single background task.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
    deferLoading: false,
    policy: { risk: "safe", requiresApproval: false },
    governance: { sideEffects: ["read"] },
    async execute(args: unknown): Promise<TaskRecord> {
      const id = parseTaskId(args);
      const record = options.manager.store.get(id);
      if (!record) {
        throw makeToolError("TASK_NOT_FOUND", `Task not found: ${id}`);
      }
      return record;
    },
  });
}

/** @public @stability experimental v0.1 */
export function createTaskStop(
  options: CreateTaskToolsOptions,
): ToolDefinition {
  return defineTool({
    name: "task_stop",
    description:
      "Request cancellation of a background task. Returns whether the call resulted in a cancellation.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
    deferLoading: false,
    policy: { risk: "risky", requiresApproval: false },
    governance: { sideEffects: ["write"] },
    async execute(args: unknown): Promise<{ cancelled: boolean }> {
      const id = parseTaskId(args);
      const before = options.manager.store.get(id);
      if (!before) {
        throw makeToolError("TASK_NOT_FOUND", `Task not found: ${id}`);
      }
      if (isTerminal(before.status)) {
        return { cancelled: false };
      }
      const handle = options.manager.handle(id);
      if (!handle) {
        return { cancelled: false };
      }
      await handle.cancel();
      const after = options.manager.store.get(id);
      return { cancelled: after?.status === "cancelled" };
    },
  });
}

/** @public @stability experimental v0.1 */
export function createTaskOutput(
  options: CreateTaskToolsOptions,
): ToolDefinition {
  const defaultMax =
    options.defaultMaxOutputChunks ?? DEFAULT_MAX_OUTPUT_CHUNKS;
  return defineTool({
    name: "task_output",
    description:
      "Fetch buffered output chunks for a task. Polls a snapshot — does not block on live output.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        fromSequence: { type: "integer" },
        maxChunks: { type: "integer" },
      },
      required: ["taskId"],
    },
    deferLoading: false,
    policy: { risk: "safe", requiresApproval: false },
    governance: { sideEffects: ["read"] },
    async execute(args: unknown): Promise<{
      chunks: TaskOutputChunk[];
      nextSequence: number;
      complete: boolean;
      status: TaskStatus;
      error?: TaskRecord["error"];
      lastOutputAt?: string;
      stalled: boolean;
    }> {
      const parsed = parseOutputArgs(args);
      const record = options.manager.store.get(parsed.taskId);
      if (!record) {
        throw makeToolError(
          "TASK_NOT_FOUND",
          `Task not found: ${parsed.taskId}`,
        );
      }
      const max = parsed.maxChunks ?? defaultMax;
      const fromSequence = parsed.fromSequence ?? 0;
      const chunks: TaskOutputChunk[] = [];
      const iterable = options.manager.store.loadOutput(
        parsed.taskId,
        fromSequence,
      );
      const iterator = iterable[Symbol.asyncIterator]();
      // We only drain currently-buffered chunks (and any live chunk already
      // queued). For a streaming surface, callers should consume the
      // TaskHandle.output() iterator directly.
      while (chunks.length < max) {
        const next = await raceWithImmediate(iterator);
        if (next === IMMEDIATE_NONE) break;
        if (next.done) break;
        chunks.push(next.value);
      }
      // Best-effort close of the iterator so subscribers detach.
      if (iterator.return) await iterator.return(undefined);
      const lastSeq =
        chunks.length > 0
          ? chunks[chunks.length - 1]!.sequence
          : fromSequence - 1;
      return {
        chunks,
        nextSequence: lastSeq + 1,
        complete: isTerminal(record.status),
        status: record.status,
        error: record.error,
        lastOutputAt: record.lastOutputAt,
        stalled: record.status === "running" && chunks.length === 0,
      };
    },
  });
}

// ----------------------------------------------------------------------------
// Argument parsers — strict, no `any`.
// ----------------------------------------------------------------------------

interface CreateArgs {
  kind: string;
  title?: string;
  payload?: Record<string, unknown>;
}

function parseCreateArgs(args: unknown): CreateArgs {
  const record = requireRecord(args, "task_create");
  const kind = record.kind;
  if (typeof kind !== "string" || kind.length === 0) {
    throw makeToolError(
      "TASK_ARGUMENTS_INVALID",
      "task_create: kind must be a non-empty string.",
    );
  }
  const title = typeof record.title === "string" ? record.title : undefined;
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : undefined;
  return { kind, title, payload };
}

interface ListArgs {
  status?: TaskStatus;
  kind?: string;
}

function parseListArgs(args: unknown): ListArgs {
  if (args === undefined || args === null) return {};
  const record = requireRecord(args, "task_list");
  const status =
    typeof record.status === "string" && isValidStatus(record.status)
      ? (record.status as TaskStatus)
      : undefined;
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  return { status, kind };
}

function parseTaskId(args: unknown): TaskId {
  const record = requireRecord(args, "taskId");
  const value = record.taskId;
  if (typeof value !== "string" || value.length === 0) {
    throw makeToolError(
      "TASK_ARGUMENTS_INVALID",
      "taskId must be a non-empty string.",
    );
  }
  return value as unknown as TaskId;
}

interface OutputArgs {
  taskId: TaskId;
  fromSequence?: number;
  maxChunks?: number;
}

function parseOutputArgs(args: unknown): OutputArgs {
  const record = requireRecord(args, "task_output");
  const taskId = parseTaskId(args);
  const fromSequence =
    typeof record.fromSequence === "number" &&
    Number.isInteger(record.fromSequence) &&
    record.fromSequence >= 0
      ? record.fromSequence
      : undefined;
  const maxChunks =
    typeof record.maxChunks === "number" &&
    Number.isInteger(record.maxChunks) &&
    record.maxChunks > 0
      ? record.maxChunks
      : undefined;
  return { taskId, fromSequence, maxChunks };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw makeToolError(
      "TASK_ARGUMENTS_INVALID",
      `${label}: arguments must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function isValidStatus(value: string): value is TaskStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isTerminal(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

interface ToolError extends Error {
  code: string;
}

function makeToolError(code: string, message: string): ToolError {
  const err = new Error(message) as ToolError;
  err.code = code;
  return err;
}

// ----------------------------------------------------------------------------
// Non-blocking iterator drain.
// ----------------------------------------------------------------------------

const IMMEDIATE_NONE = Symbol("IMMEDIATE_NONE");
type ImmediateNone = typeof IMMEDIATE_NONE;

/**
 * Race the iterator's next() against an immediately-resolved sentinel. If the
 * iterator does not have a value ready synchronously (via microtask), return
 * the sentinel so callers can stop polling.
 */
async function raceWithImmediate<T>(
  iterator: AsyncIterator<T>,
): Promise<IteratorResult<T> | ImmediateNone> {
  let settled = false;
  const next = iterator.next().then((result) => {
    settled = true;
    return result;
  });
  // Yield two microtasks so any already-buffered value gets pulled.
  await Promise.resolve();
  await Promise.resolve();
  if (settled) return next;
  return IMMEDIATE_NONE;
}
