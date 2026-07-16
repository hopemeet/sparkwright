// AI maintenance note: These ToolDefinitions expose the TaskManager
// surface to LLMs. They are intentionally thin — argument parsing and
// translation to TaskManager calls. Risk classification:
//   task_create -> external (host runs arbitrary registered kinds)
//   task(action="stop") -> write (mutates lifecycle state)
//   task(action="list"|"get"|"output"|"wait") -> read

import {
  defineTool,
  type BackgroundTaskPolicy,
  type RuntimeContext,
  type ToolDefinition,
  type ToolRequestPreviewOptions,
} from "@sparkwright/core";
import type { RunId } from "@sparkwright/core";
import type { TaskManager, TaskRunner } from "./manager.js";
import type {
  TaskId,
  TaskOutputChunk,
  TaskRecord,
  TaskStatus,
} from "./types.js";

type JsonSchemaObject = Record<string, unknown>;

export interface TaskCreateKindDescriptor {
  kind: string;
  description?: string;
  payloadDescription?: string;
  payloadSchema?: JsonSchemaObject;
  requiresPayload?: boolean;
  policyForPayload?(
    payload: Record<string, unknown> | undefined,
    call: TaskCreateKindCall,
  ):
    | {
        policy?: ToolDefinition["policy"];
        governance?: ToolDefinition["governance"];
      }
    | undefined;
  approvalSummaryForPayload?(
    payload: Record<string, unknown> | undefined,
    call: TaskCreateKindCall,
    options: ToolRequestPreviewOptions,
  ): string | undefined;
}

export interface TaskCreateKindCall {
  title?: string;
  mode: TaskCreateMode;
  awaited: boolean;
}

/**
 * Options for the canonical task tool factories.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskToolOptions {
  manager: TaskManager;
  /**
   * Execution-scoped runners captured by this tool bundle. These take
   * precedence over process/workspace registered runners so delayed task
   * startup cannot observe dependencies from a later run.
   */
  taskRunners?: Readonly<Record<string, TaskRunner>>;
  /**
   * Resolver for the active run id. Tools call this on every invocation so
   * the same tool bundle can be shared across runs.
   */
  getParentRunId(ctx?: RuntimeContext): RunId;
  /**
   * Default cap on chunks returned by `task(action="output")`. Default 200.
   */
  defaultMaxOutputChunks?: number;
  /**
   * Optional model-facing hints for registered task_create kinds.
   * Execution still dispatches through TaskManager's live registry.
   */
  taskCreateKinds?: readonly TaskCreateKindDescriptor[];
  concurrencyLimits?: TaskConcurrencyLimits;
  foregroundTimeoutMs?: number;
  backgroundTasks?: BackgroundTaskPolicy;
}

export interface TaskConcurrencyLimits {
  global?: number;
  perKind?: Record<string, number>;
}

type TaskListScope = "run" | "all";

const DEFAULT_CONCURRENCY_LIMITS: TaskConcurrencyLimits = {
  global: 4,
  perKind: { agent: 1 },
};

const DEFAULT_MAX_OUTPUT_CHUNKS = 200;
const DEFAULT_FOREGROUND_TIMEOUT_MS = 300_000;

/** @public @stability experimental v0.1 */
export function createTaskCreate(options: TaskToolOptions): ToolDefinition {
  const kinds = taskCreateKindDescriptors(options);
  const kindsByName = new Map(kinds.map((kind) => [kind.kind, kind]));
  const limits = mergeConcurrencyLimits(
    DEFAULT_CONCURRENCY_LIMITS,
    options.concurrencyLimits,
  );
  return defineTool({
    name: "task_create",
    description: taskCreateDescription(kinds, limits),
    inputSchema: taskCreateInputSchema(kinds),
    deferLoading: false,
    policy: { risk: "risky", requiresApproval: false },
    governance: { sideEffects: ["external"] },
    policyForArgs(args: unknown) {
      const parsed = tryParseCreateArgs(args);
      if (!parsed) return {};
      return (
        kindsByName
          .get(parsed.kind)
          ?.policyForPayload?.(parsed.payload, taskCreateKindCall(parsed)) ?? {}
      );
    },
    approvalSummaryForArgs(
      args: unknown,
      previewOptions: ToolRequestPreviewOptions,
    ) {
      const parsed = tryParseCreateArgs(args);
      if (!parsed) return undefined;
      return kindsByName
        .get(parsed.kind)
        ?.approvalSummaryForPayload?.(
          parsed.payload,
          taskCreateKindCall(parsed),
          previewOptions,
        );
    },
    async execute(args: unknown, ctx): Promise<TaskCreateResult> {
      const parsed = parseCreateArgs(args);
      const backgroundTasks = options.backgroundTasks ?? "enabled";
      if (backgroundTasks === "disabled") {
        throw makeToolError(
          "BACKGROUND_TASKS_DISABLED",
          "Background task creation is disabled by this session's access policy.",
        );
      }
      const mode =
        backgroundTasks === "foreground-only" ? "foreground" : parsed.mode;
      const runner =
        options.taskRunners?.[parsed.kind] ??
        options.manager.getRunner(parsed.kind);
      if (!runner) {
        const available = options.manager.registeredKinds();
        const availableText =
          available.length > 0
            ? ` Available kinds: ${available.join(", ")}.`
            : "";
        throw makeToolError(
          "TASK_KIND_UNREGISTERED",
          `No runner registered for task kind: ${parsed.kind}.${availableText}`,
        );
      }
      const parentRunId = options.getParentRunId(ctx);
      // Collapse an accidental duplicate onto the still-active task instead of
      // leaking a second one. Models re-issue task_create for the same goal
      // (observed: two background tasks for one "run in background" request, the
      // second never joined). Key on kind + case-folded title within the run;
      // only dedup detached work, since a foreground caller waits inline anyway.
      const dedupeTitle = normalizeTaskTitle(parsed.title);
      if (mode !== "foreground" && dedupeTitle) {
        const existing = options.manager.store
          .list({ parentRunId, kind: parsed.kind })
          .find(
            (task) =>
              !isTerminal(task.status) &&
              normalizeTaskTitle(task.title) === dedupeTitle,
          );
        if (existing) {
          return {
            taskId: existing.id,
            mode,
            awaited: existing.awaited,
            deduplicated: true,
            nextAction: taskCreateNextAction(existing.id, existing.awaited),
          };
        }
      }
      enforceConcurrencyLimit(options, parentRunId, parsed.kind);
      const handle = options.manager.spawn({
        parentRunId,
        kind: parsed.kind,
        title: parsed.title,
        awaited: parsed.awaited,
        runner,
        payload: parsed.payload,
      });
      if (mode !== "foreground") {
        return {
          taskId: handle.record.id,
          mode,
          awaited: parsed.awaited,
          nextAction: taskCreateNextAction(handle.record.id, parsed.awaited),
        };
      }

      const wait = handle.wait();
      const foreground =
        backgroundTasks === "foreground-only"
          ? { kind: "completed" as const, record: await wait }
          : await waitForForegroundTask(
              wait,
              options.foregroundTimeoutMs ?? DEFAULT_FOREGROUND_TIMEOUT_MS,
              (signal) =>
                options.manager.waitForPromotion(handle.record.id, { signal }),
            );
      if (foreground.kind === "timeout" || foreground.kind === "promote") {
        options.manager.store.update(handle.record.id, {
          awaited: true,
          ...(foreground.kind === "promote"
            ? { metadata: { manualPromotionDelivered: true } }
            : {}),
        });
        return {
          taskId: handle.record.id,
          mode: "foreground",
          promoted: true,
          awaited: true,
          nextAction: taskCreateNextAction(handle.record.id, true),
        };
      }

      options.manager.store.update(handle.record.id, {
        awaited: false,
        metadata: { foregroundInline: true },
      });
      return taskCreateInlineResult(foreground.record);
    },
  });
}

export type TaskCreateMode = "foreground" | "awaited" | "background";

export type TaskCreateResult =
  | {
      taskId: TaskId;
      mode: "foreground";
      promoted: true;
      awaited: true;
      nextAction: TaskCreateNextAction;
    }
  | {
      taskId: TaskId;
      mode: "awaited" | "background";
      awaited: boolean;
      /**
       * Set when this call was collapsed onto an already-active task with the
       * same kind+title in the same run, instead of spawning a duplicate. The
       * returned taskId is the pre-existing task.
       */
      deduplicated?: true;
      nextAction: TaskCreateNextAction;
    }
  | {
      taskId: TaskId;
      mode: "foreground";
      promoted: false;
      awaited: false;
      status: TaskRecord["status"];
      result?: unknown;
      error?: TaskRecord["error"];
    };

export interface TaskCreateNextAction {
  tool: "task";
  taskId: TaskId;
  action: "wait";
  /** @reserved Public task-create output field consumed by model-visible tool results. */
  instruction: string;
  /** @reserved Public task-create output field consumed by model-visible tool results. */
  outputInstruction?: string;
  /** @reserved Public task-create output field consumed by model-visible tool results. */
  duplicateAvoidance: string;
}

function taskCreateNextAction(
  taskId: TaskId,
  awaited: boolean,
): TaskCreateNextAction {
  return {
    tool: "task",
    taskId,
    action: "wait",
    instruction: awaited
      ? `Call task with action="wait" and taskId="${taskId}" to wait for this task before creating another task for the same goal.`
      : `The background launch is complete. If you need terminal completion before answering, call task with action="wait" and taskId="${taskId}"; use action="get" only for a one-time status snapshot.`,
    outputInstruction:
      'After the task is terminal, call task with action="output" and the same taskId if you need buffered output that was not included in the task result.',
    duplicateAvoidance:
      "Do not call task_create again for the same goal; use this taskId to wait, inspect, or retrieve output.",
  };
}

function taskCreateKindCall(parsed: CreateArgs): TaskCreateKindCall {
  return {
    ...(parsed.title ? { title: parsed.title } : {}),
    mode: parsed.mode,
    awaited: parsed.awaited,
  };
}

function taskCreateKindDescriptors(
  options: TaskToolOptions,
): TaskCreateKindDescriptor[] {
  const descriptors =
    options.taskCreateKinds ??
    options.manager.registeredKinds().map((kind) => ({ kind }));
  return descriptors
    .filter((descriptor) => descriptor.kind.trim().length > 0)
    .map((descriptor) => ({ ...descriptor, kind: descriptor.kind.trim() }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

function taskCreateDescription(
  kinds: readonly TaskCreateKindDescriptor[],
  limits: TaskConcurrencyLimits,
): string {
  const base =
    "Run a long-running task by registered kind. Defaults to foreground: wait inline for the result, then auto-promote to a background task if the foreground budget is exceeded. Use mode=awaited for detached work that should revive this run, or mode=background for fire-and-forget work.";
  const limitText = taskConcurrencyLimitDescription(limits);
  const baseWithLimits = limitText ? `${base} ${limitText}` : base;
  if (kinds.length === 0) return baseWithLimits;
  const kindText = kinds
    .map((kind) =>
      kind.description ? `${kind.kind}: ${kind.description}` : kind.kind,
    )
    .join("; ");
  return `${baseWithLimits} Registered kinds: ${kindText}.`;
}

function taskConcurrencyLimitDescription(
  limits: TaskConcurrencyLimits,
): string {
  const parts: string[] = [];
  if (limits.global !== undefined) parts.push(`global=${limits.global}`);
  const perKind = Object.entries(limits.perKind ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, limit]) => `${kind}=${limit}`);
  if (perKind.length > 0) parts.push(`per-kind ${perKind.join(", ")}`);
  if (parts.length === 0) return "";
  return `Active task concurrency limit: ${parts.join("; ")}. If the limit is reached, wait for or stop the existing task before starting another.`;
}

function taskCreateInputSchema(
  kinds: readonly TaskCreateKindDescriptor[],
): JsonSchemaObject {
  const knownKindNames = kinds.map((kind) => kind.kind);
  const singlePayloadKind =
    kinds.length === 1 && kinds[0]?.payloadSchema ? kinds[0] : undefined;
  const payloadDescriptions = kinds
    .filter(
      (kind) =>
        kind.payloadDescription !== undefined ||
        kind.payloadSchema !== undefined,
    )
    .map((kind) =>
      kind.payloadDescription
        ? `${kind.kind}: ${kind.payloadDescription}`
        : `${kind.kind}: kind-specific payload.`,
    );
  const required = ["kind"];
  if (singlePayloadKind?.requiresPayload === true) required.push("payload");
  return {
    type: "object",
    properties: {
      kind: {
        type: "string",
        ...(knownKindNames.length > 0 ? { enum: knownKindNames } : {}),
        description:
          knownKindNames.length > 0
            ? `Registered task kind. Available: ${knownKindNames.join(", ")}.`
            : "Registered task kind.",
      },
      title: { type: "string" },
      mode: {
        type: "string",
        enum: ["foreground", "awaited", "background"],
        description:
          "foreground waits inline and auto-promotes on budget overrun; awaited starts detached but keeps this run alive; background starts detached fire-and-forget.",
      },
      awaited: {
        type: "boolean",
        description:
          "Compatibility flag for detached tasks. mode is preferred. Without mode, awaited=false selects background; otherwise foreground is the default.",
      },
      payload:
        singlePayloadKind?.payloadSchema ??
        ({
          type: "object",
          ...(payloadDescriptions.length > 0
            ? { description: payloadDescriptions.join(" ") }
            : {}),
        } satisfies JsonSchemaObject),
    },
    required,
  };
}

/** @public @stability experimental v0.1 */
export function createTaskControl(options: TaskToolOptions): ToolDefinition {
  return defineTool({
    name: "task",
    description:
      "Manage background tasks. Use action=list to inspect tasks, get for one task record, output for buffered task output, wait to join one or more tasks, and stop to request cancellation. List defaults to scope=run; after resume, use scope=all if you need durable tasks from earlier runs. For wait/output/get/stop, use a concrete taskId returned by an earlier task_create or task list/get call; do not guess, leave blank, or batch dependent task calls before task_create returns.",
    inputSchema: taskControlInputSchema(),
    deferLoading: false,
    policy: { risk: "risky", requiresApproval: false },
    governance: { sideEffects: ["read", "write"] },
    repeatedCallGuidanceForArgs(args: unknown) {
      const record = normalizeTaskControlArgs(args);
      if ((record as Record<string, unknown>).action !== "get")
        return undefined;
      const taskId = (record as Record<string, unknown>).taskId;
      if (typeof taskId !== "string" || taskId.length === 0) return undefined;
      return `Skipped a repeated point-in-time snapshot for ${taskId}. Call task with action="wait" and this taskId to wait for terminal completion, or action="output" with fromSequence to inspect new buffered output.`;
    },
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
    validateInput(args: unknown) {
      return validateTaskControlInput(normalizeTaskControlArgs(args));
    },
    isReadOnly(args: unknown): boolean {
      const record = args && typeof args === "object" ? args : {};
      return (record as Record<string, unknown>).action !== "stop";
    },
    async execute(args: unknown, ctx) {
      const normalizedArgs = normalizeTaskControlArgs(args);
      const validation = validateTaskControlInput(normalizedArgs);
      if (!validation.ok) {
        throw makeToolError(validation.code, validation.message);
      }
      const record = requireRecord(normalizedArgs, "task");
      switch (record.action) {
        case "list":
          return executeTaskList(options, normalizedArgs, ctx);
        case "get":
          return executeTaskGet(options, normalizedArgs);
        case "output":
          return executeTaskOutput(options, normalizedArgs);
        case "wait":
          return executeTaskWait(options, normalizedArgs);
        case "stop":
          return executeTaskStop(options, normalizedArgs);
        default:
          throw makeToolError(
            "TASK_ARGUMENTS_INVALID",
            "task: action must be one of list, get, output, wait, or stop.",
          );
      }
    },
  });
}

function taskControlInputSchema(): JsonSchemaObject {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "output", "wait", "stop"],
        description:
          "list inspects tasks, get/output/stop require taskId, and wait requires taskId or ids.",
      },
      taskId: {
        type: "string",
        minLength: 1,
        description:
          "For action=get, output, stop, or one-task wait only. Concrete task id returned by task_create/list/get; omit for action=list and when wait uses ids.",
      },
      ids: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 },
        description:
          "For action=wait only. Concrete task ids returned by task_create/list/get; omit for every other action and do not combine with a different taskId.",
      },
      mode: {
        type: "string",
        enum: ["any", "all"],
        description:
          "For action=wait only; omit otherwise. any returns after the first listed task reaches terminal state; all waits for every listed task.",
      },
      status: {
        type: "string",
        description:
          "For action=list only; omit otherwise and omit when unfiltered.",
      },
      kind: {
        type: "string",
        description:
          "For action=list only; omit otherwise and omit when unfiltered.",
      },
      scope: {
        type: "string",
        enum: ["run", "all"],
        description:
          "For action=list only. run lists tasks owned by the current run; all lists every durable task in this task store, useful after resume when older task ids are unknown.",
      },
      fromSequence: {
        type: "integer",
        description: "For action=output only; omit otherwise.",
      },
      maxChunks: {
        type: "integer",
        description: "For action=output only; omit otherwise.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  };
}

/**
 * Canonicalize the provider-friendly flat task schema before action-specific
 * validation and execution. Models sometimes populate every optional field;
 * harmless empty or unrelated values must not leak into action handlers.
 */
function normalizeTaskControlArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return {};
  }
  const input = args as Record<string, unknown>;
  const action = input.action;
  if (typeof action !== "string") return {};
  const nonEmptyString = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const output: Record<string, unknown> = { action };

  switch (action) {
    case "list": {
      const status = nonEmptyString(input.status);
      const kind = nonEmptyString(input.kind);
      const scope = nonEmptyString(input.scope);
      if (status) output.status = status;
      if (kind) output.kind = kind;
      if (scope) output.scope = scope;
      break;
    }
    case "get":
    case "stop": {
      const taskId = nonEmptyString(input.taskId);
      if (taskId) output.taskId = taskId;
      break;
    }
    case "output": {
      const taskId = nonEmptyString(input.taskId);
      if (taskId) output.taskId = taskId;
      if (Number.isInteger(input.fromSequence)) {
        output.fromSequence = input.fromSequence;
      }
      if (Number.isInteger(input.maxChunks)) output.maxChunks = input.maxChunks;
      break;
    }
    case "wait": {
      const taskId = nonEmptyString(input.taskId);
      const ids = Array.isArray(input.ids)
        ? input.ids.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : undefined;
      if (taskId) output.taskId = taskId;
      if (ids && (ids.length !== 1 || ids[0] !== taskId)) output.ids = ids;
      if (input.mode === "any" || input.mode === "all") {
        output.mode = input.mode;
      }
      break;
    }
    default:
      break;
  }
  return output;
}

function validateTaskControlInput(
  args: unknown,
): { ok: true } | { ok: false; code: string; message: string } {
  if (typeof args !== "object" || args === null) {
    return {
      ok: false,
      code: "TASK_ARGUMENTS_INVALID",
      message: "task: arguments must be an object.",
    };
  }
  const record = args as Record<string, unknown>;
  switch (record.action) {
    case "list":
      return validateTaskListArgs(record);
    case "get":
    case "output":
    case "stop":
      return validateTaskControlTaskId(record.taskId);
    case "wait":
      return validateTaskControlWaitIds(record);
    default:
      return {
        ok: false,
        code: "TASK_ARGUMENTS_INVALID",
        message:
          "task: action must be one of list, get, output, wait, or stop.",
      };
  }
}

function validateTaskListArgs(
  record: Record<string, unknown>,
): { ok: true } | { ok: false; code: string; message: string } {
  if (
    record.scope !== undefined &&
    record.scope !== "run" &&
    record.scope !== "all"
  ) {
    return {
      ok: false,
      code: "TASK_ARGUMENTS_INVALID",
      message: "task list scope must be run or all.",
    };
  }
  return { ok: true };
}

function validateTaskControlTaskId(
  taskId: unknown,
): { ok: true } | { ok: false; code: string; message: string } {
  if (typeof taskId === "string" && taskId.length > 0) {
    return { ok: true };
  }
  return {
    ok: false,
    code: "TASK_ARGUMENTS_INVALID",
    message: "taskId must be a non-empty string.",
  };
}

function validateTaskControlWaitIds(
  record: Record<string, unknown>,
): { ok: true } | { ok: false; code: string; message: string } {
  const hasTaskId = record.taskId !== undefined;
  if (
    hasTaskId &&
    (typeof record.taskId !== "string" || record.taskId.length === 0)
  ) {
    return {
      ok: false,
      code: "TASK_ARGUMENTS_INVALID",
      message: "task wait taskId must be a non-empty string when provided.",
    };
  }
  if (record.ids !== undefined) {
    if (!Array.isArray(record.ids)) {
      return {
        ok: false,
        code: "TASK_ARGUMENTS_INVALID",
        message: "task wait ids must be an array of non-empty strings.",
      };
    }
    if (record.ids.length === 0) {
      return {
        ok: false,
        code: "TASK_ARGUMENTS_INVALID",
        message: "task wait requires at least one task id.",
      };
    }
    if (record.ids.some((id) => typeof id !== "string" || id.length === 0)) {
      return {
        ok: false,
        code: "TASK_ARGUMENTS_INVALID",
        message: "task wait ids must be non-empty strings.",
      };
    }
    if (
      typeof record.taskId === "string" &&
      (record.ids.length !== 1 || record.ids[0] !== record.taskId)
    ) {
      return {
        ok: false,
        code: "TASK_ARGUMENTS_INVALID",
        message:
          "task wait must not combine taskId with a different ids list; use one form.",
      };
    }
  }
  const hasIds = Array.isArray(record.ids) && record.ids.length > 0;
  return hasTaskId || hasIds
    ? { ok: true }
    : {
        ok: false,
        code: "TASK_ARGUMENTS_INVALID",
        message: "task wait requires at least one task id.",
      };
}

function executeTaskList(
  options: TaskToolOptions,
  args: unknown,
  ctx: RuntimeContext,
): { tasks: TaskRecord[] } {
  const parsed = parseListArgs(args);
  const tasks = options.manager.store.list({
    status: parsed.status,
    kind: parsed.kind,
    ...(parsed.scope === "run"
      ? { parentRunId: options.getParentRunId(ctx) }
      : {}),
  });
  return { tasks };
}

function executeTaskGet(options: TaskToolOptions, args: unknown): TaskRecord {
  const id = parseTaskId(args);
  const record = options.manager.store.get(id);
  if (!record) {
    throw makeToolError("TASK_NOT_FOUND", `Task not found: ${id}`);
  }
  return record;
}

async function executeTaskStop(
  options: TaskToolOptions,
  args: unknown,
): Promise<{ cancelled: boolean }> {
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
}

async function executeTaskOutput(
  options: TaskToolOptions,
  args: unknown,
): Promise<{
  chunks: TaskOutputChunk[];
  nextSequence: number;
  complete: boolean;
  status: TaskStatus;
  error?: TaskRecord["error"];
  lastOutputAt?: string;
  stalled: boolean;
}> {
  const defaultMax =
    options.defaultMaxOutputChunks ?? DEFAULT_MAX_OUTPUT_CHUNKS;
  const parsed = parseOutputArgs(args);
  const record = options.manager.store.get(parsed.taskId);
  if (!record) {
    throw makeToolError("TASK_NOT_FOUND", `Task not found: ${parsed.taskId}`);
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
    chunks.length > 0 ? chunks[chunks.length - 1]!.sequence : fromSequence - 1;
  return {
    chunks,
    nextSequence: lastSeq + 1,
    complete: isTerminal(record.status),
    status: record.status,
    error: record.error,
    lastOutputAt: record.lastOutputAt,
    stalled: record.status === "running" && chunks.length === 0,
  };
}

async function executeTaskWait(
  options: TaskToolOptions,
  args: unknown,
): Promise<TaskWaitResult> {
  const parsed = parseWaitArgs(args);
  const records = parsed.ids.map((id) => {
    const record = options.manager.store.get(id);
    if (!record) {
      throw makeToolError("TASK_NOT_FOUND", `Task not found: ${id}`);
    }
    return record;
  });
  if (records.length === 0) {
    throw makeToolError(
      "TASK_ARGUMENTS_INVALID",
      "task wait requires at least one task id.",
    );
  }

  const waitRecord =
    parsed.mode === "all"
      ? await waitForAllTasks(options.manager, records)
      : await waitForAnyTask(options.manager, records);

  const terminalRecords = waitRecord.filter((record) =>
    isTerminal(record.status),
  );
  const terminalIds = new Set(terminalRecords.map((record) => record.id));
  for (const record of terminalRecords) {
    options.manager.store.update(record.id, { awaited: false });
  }

  return {
    mode: parsed.mode,
    complete:
      parsed.mode === "all"
        ? terminalRecords.length === parsed.ids.length
        : terminalRecords.length > 0,
    taskIds: parsed.ids,
    terminalTaskIds: [...terminalIds],
    tasks: waitRecord.map(
      (record) => options.manager.store.get(record.id) ?? record,
    ),
    completed: terminalRecords.filter((record) => record.status === "completed")
      .length,
    failed: terminalRecords.filter((record) => record.status === "failed")
      .length,
    cancelled: terminalRecords.filter((record) => record.status === "cancelled")
      .length,
  };
}

interface TaskWaitResult {
  mode: "any" | "all";
  complete: boolean;
  taskIds: TaskId[];
  terminalTaskIds: TaskId[];
  tasks: TaskRecord[];
  completed: number;
  failed: number;
  cancelled: number;
}

// ----------------------------------------------------------------------------
// Argument parsers — strict, no `any`.
// ----------------------------------------------------------------------------

interface CreateArgs {
  kind: string;
  title?: string;
  mode: TaskCreateMode;
  awaited: boolean;
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
  const mode = parseTaskCreateMode(record.mode, record.awaited);
  const awaited = parseTaskCreateAwaited(mode, record.awaited);
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : undefined;
  return { kind, title, mode, awaited, payload };
}

function tryParseCreateArgs(args: unknown): CreateArgs | undefined {
  try {
    return parseCreateArgs(args);
  } catch {
    return undefined;
  }
}

function parseTaskCreateMode(
  rawMode: unknown,
  rawAwaited: unknown,
): TaskCreateMode {
  if (
    rawMode === "foreground" ||
    rawMode === "awaited" ||
    rawMode === "background"
  ) {
    return rawMode;
  }
  if (rawMode !== undefined) {
    throw makeToolError(
      "TASK_ARGUMENTS_INVALID",
      "task_create: mode must be foreground, awaited, or background.",
    );
  }
  return rawAwaited === false ? "background" : "foreground";
}

function parseTaskCreateAwaited(
  mode: TaskCreateMode,
  rawAwaited: unknown,
): boolean {
  const expected = mode === "background" ? false : true;
  if (rawAwaited === undefined) return expected;
  if (typeof rawAwaited !== "boolean") {
    throw makeToolError(
      "TASK_ARGUMENTS_INVALID",
      "task_create: awaited must be a boolean when provided.",
    );
  }
  if (rawAwaited !== expected) {
    throw makeToolError(
      "TASK_ARGUMENTS_INVALID",
      `task_create: mode=${mode} conflicts with awaited=${rawAwaited}. Omit awaited or choose a matching mode.`,
    );
  }
  return rawAwaited;
}

function enforceConcurrencyLimit(
  options: TaskToolOptions,
  parentRunId: RunId,
  kind: string,
): void {
  const limits = mergeConcurrencyLimits(
    DEFAULT_CONCURRENCY_LIMITS,
    options.concurrencyLimits,
  );
  const active = options.manager.store
    .list({ parentRunId })
    .filter((task) => !isTerminal(task.status));
  if (limits.global !== undefined && active.length >= limits.global) {
    throw makeToolError(
      "TASK_CONCURRENCY_LIMIT",
      `Task concurrency limit reached: global=${limits.global}. Wait for an existing task to finish or stop it before starting another.`,
    );
  }
  const kindLimit = limits.perKind?.[kind];
  if (
    kindLimit !== undefined &&
    active.filter((task) => task.kind === kind).length >= kindLimit
  ) {
    throw makeToolError(
      "TASK_CONCURRENCY_LIMIT",
      `Task concurrency limit reached for kind "${kind}": ${kindLimit}. Wait for the existing task to finish or stop it before starting another.`,
    );
  }
}

function mergeConcurrencyLimits(
  base: TaskConcurrencyLimits,
  override: TaskConcurrencyLimits | undefined,
): TaskConcurrencyLimits {
  return {
    global: override?.global ?? base.global,
    perKind: {
      ...(base.perKind ?? {}),
      ...(override?.perKind ?? {}),
    },
  };
}

async function waitForForegroundTask(
  wait: Promise<TaskRecord>,
  timeoutMs: number,
  waitForPromotion: (signal: AbortSignal) => Promise<void>,
): Promise<
  | { kind: "completed"; record: TaskRecord }
  | { kind: "timeout" }
  | { kind: "promote" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promotionAbort = new AbortController();
  try {
    return await Promise.race([
      wait.then((record) => ({ kind: "completed" as const, record })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
      waitForPromotion(promotionAbort.signal).then(() => ({
        kind: "promote" as const,
      })),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    promotionAbort.abort();
  }
}

function taskCreateInlineResult(record: TaskRecord): TaskCreateResult {
  return {
    taskId: record.id,
    mode: "foreground",
    promoted: false,
    awaited: false,
    status: record.status,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

interface ListArgs {
  status?: TaskStatus;
  kind?: string;
  scope: TaskListScope;
}

function parseListArgs(args: unknown): ListArgs {
  if (args === undefined || args === null) return { scope: "run" };
  const record = requireRecord(args, "task");
  const status =
    typeof record.status === "string" && isValidStatus(record.status)
      ? (record.status as TaskStatus)
      : undefined;
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  if (
    record.scope !== undefined &&
    record.scope !== "run" &&
    record.scope !== "all"
  ) {
    throw makeToolError(
      "TASK_ARGUMENTS_INVALID",
      "task list scope must be run or all.",
    );
  }
  const scope = record.scope === "all" ? "all" : "run";
  return { status, kind, scope };
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

interface WaitArgs {
  ids: TaskId[];
  mode: "any" | "all";
}

function parseOutputArgs(args: unknown): OutputArgs {
  const record = requireRecord(args, "task");
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

function parseWaitArgs(args: unknown): WaitArgs {
  const record = requireRecord(args, "task");
  const ids: TaskId[] = [];
  if (record.taskId !== undefined) {
    if (typeof record.taskId !== "string" || record.taskId.length === 0) {
      throw makeToolError(
        "TASK_ARGUMENTS_INVALID",
        "task wait taskId must be a non-empty string when provided.",
      );
    }
    ids.push(record.taskId as unknown as TaskId);
  }
  if (Array.isArray(record.ids)) {
    for (const id of record.ids) {
      if (typeof id !== "string" || id.length === 0) {
        throw makeToolError(
          "TASK_ARGUMENTS_INVALID",
          "task wait ids must be non-empty strings.",
        );
      }
      ids.push(id as unknown as TaskId);
    }
  }
  const uniqueIds = [...new Set(ids)];
  const mode = record.mode === "all" ? "all" : "any";
  return { ids: uniqueIds, mode };
}

async function waitForAllTasks(
  manager: TaskManager,
  records: TaskRecord[],
): Promise<TaskRecord[]> {
  return Promise.all(records.map((record) => waitForTask(manager, record)));
}

async function waitForAnyTask(
  manager: TaskManager,
  records: TaskRecord[],
): Promise<TaskRecord[]> {
  const terminal = records.filter((record) => isTerminal(record.status));
  if (terminal.length > 0) return [terminal[0]!];
  const record = await Promise.race(
    records.map((candidate) => waitForTask(manager, candidate)),
  );
  return [record];
}

async function waitForTask(
  manager: TaskManager,
  record: TaskRecord,
): Promise<TaskRecord> {
  if (isTerminal(record.status)) return record;
  const handle = manager.handle(record.id);
  if (!handle) return record;
  return handle.wait();
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

/**
 * Case- and whitespace-folded task title used as the duplicate key. Returns the
 * empty string when there is no usable title, which callers treat as "cannot
 * dedup" (do not collapse untitled tasks onto each other).
 */
function normalizeTaskTitle(title: string | undefined): string {
  return (title ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
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
