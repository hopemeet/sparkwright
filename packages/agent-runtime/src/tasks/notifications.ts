// AI maintenance note: ActorNotificationSink is the bridge that turns a
// background actor transition into something the *agent loop* can observe on
// its next turn. The runtime intentionally does not couple this to any specific
// transport.
//
// Lifecycle: TaskManager calls sink.deliver(...) exactly once per task, AFTER
// the record has been moved to a terminal status. Deliveries are best-effort at
// the manager boundary; sinks may still throw validation, capacity, or
// transport/storage errors. TaskManager classifies typed permanent actor errors
// as non-retryable, logs to `onSinkError` when supplied, and continues — task
// state is the source of truth, the sink is just a hint.

import type {
  TaskError,
  TaskId,
  TaskProgressUpdate,
  TaskRecord,
  TaskStatus,
} from "./types.js";
import type { WorkflowWaitState } from "../workflows/types.js";

/**
 * Actor kinds with implemented notification producers and consumers. Add a
 * kind only in the same change that adds its typed notification union and
 * delivery semantics; this is not a reservation for a generic actor bus.
 */
export type InternalActorKind = "task" | "workflow";

export interface ActorRef {
  kind: InternalActorKind;
  id: string;
  /** Owning or parent run scope, when the actor is nested under a run. */
  runId?: string;
  sessionId?: string;
}

export interface ActorRouteHint {
  parentRunId?: string;
  targetRunId?: string;
  sessionId?: string;
}

export type ActorNotificationType =
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting"
  | "progress"
  | "output";

export type ActorNotificationQos = "lossy" | "reliable";

export interface ActorNotificationInputBase<TPayload> {
  source: ActorRef;
  routeHint?: ActorRouteHint;
  type: ActorNotificationType;
  /** Optional producer correlation id. Not a storage id or dedup key. */
  correlationId?: string;
  payload: TPayload;
  outputRef?: string;
  suggestedContext?: boolean;
}

export interface ActorNotificationBase<
  TPayload,
> extends ActorNotificationInputBase<TPayload> {
  /** Inbox/outbox-assigned storage identity, not a producer dedup key. */
  id: string;
  sequence: number;
  qos: ActorNotificationQos;
  createdAt: string;
}

export interface TaskNotificationPayloadBase {
  taskId: TaskId;
  parentRunId: TaskRecord["parentRunId"];
  kind: string;
  title?: string;
  summary: string;
  /** Task terminal-notification timestamp, preserved from the task producer. */
  deliveredAt: string;
}

export interface TaskCompletedNotificationPayload extends TaskNotificationPayloadBase {
  status: "completed";
  result?: unknown;
}

export interface TaskFailedNotificationPayload extends TaskNotificationPayloadBase {
  status: "failed";
  error: TaskError;
}

export interface TaskCancelledNotificationPayload extends TaskNotificationPayloadBase {
  status: "cancelled";
}

export interface TaskProgressNotificationPayload {
  taskId: TaskId;
  parentRunId: TaskRecord["parentRunId"];
  kind: string;
  title?: string;
  progress: TaskProgressUpdate;
  summary?: string;
}

export interface TaskOutputNotificationPayload {
  taskId: TaskId;
  parentRunId: TaskRecord["parentRunId"];
  kind: string;
  title?: string;
  outputRef: string;
  summary?: string;
}

type TaskActorRef = ActorRef & { kind: "task" };

export type TaskCompletedNotificationInput =
  ActorNotificationInputBase<TaskCompletedNotificationPayload> & {
    source: TaskActorRef;
    type: "completed";
  };

export type TaskFailedNotificationInput =
  ActorNotificationInputBase<TaskFailedNotificationPayload> & {
    source: TaskActorRef;
    type: "failed";
  };

export type TaskCancelledNotificationInput =
  ActorNotificationInputBase<TaskCancelledNotificationPayload> & {
    source: TaskActorRef;
    type: "cancelled";
  };

export type TaskProgressNotificationInput =
  ActorNotificationInputBase<TaskProgressNotificationPayload> & {
    source: TaskActorRef;
    type: "progress";
  };

export type TaskOutputNotificationInput =
  ActorNotificationInputBase<TaskOutputNotificationPayload> & {
    source: TaskActorRef;
    type: "output";
  };

export type TaskActorNotificationInput =
  | TaskCompletedNotificationInput
  | TaskFailedNotificationInput
  | TaskCancelledNotificationInput
  | TaskProgressNotificationInput
  | TaskOutputNotificationInput;

export type TaskTerminalActorNotificationInput =
  | TaskCompletedNotificationInput
  | TaskFailedNotificationInput
  | TaskCancelledNotificationInput;

export type TaskCompletedActorNotification =
  ActorNotificationBase<TaskCompletedNotificationPayload> & {
    source: TaskActorRef;
    type: "completed";
    qos: "reliable";
  };

export type TaskFailedActorNotification =
  ActorNotificationBase<TaskFailedNotificationPayload> & {
    source: TaskActorRef;
    type: "failed";
    qos: "reliable";
  };

export type TaskCancelledActorNotification =
  ActorNotificationBase<TaskCancelledNotificationPayload> & {
    source: TaskActorRef;
    type: "cancelled";
    qos: "reliable";
  };

export type TaskProgressActorNotification =
  ActorNotificationBase<TaskProgressNotificationPayload> & {
    source: TaskActorRef;
    type: "progress";
    qos: "lossy";
  };

export type TaskOutputActorNotification =
  ActorNotificationBase<TaskOutputNotificationPayload> & {
    source: TaskActorRef;
    type: "output";
    qos: "lossy";
  };

export type TaskActorNotification =
  | TaskCompletedActorNotification
  | TaskFailedActorNotification
  | TaskCancelledActorNotification
  | TaskProgressActorNotification
  | TaskOutputActorNotification;

export type TaskTerminalActorNotification =
  | TaskCompletedActorNotification
  | TaskFailedActorNotification
  | TaskCancelledActorNotification;

export interface WorkflowNotificationPayloadBase {
  /** @reserved Public workflow actor identity carried for the future workflow runtime. */
  workflowId: string;
  name?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowCompletedNotificationPayload extends WorkflowNotificationPayloadBase {
  result?: unknown;
}

export interface WorkflowFailedNotificationPayload extends WorkflowNotificationPayloadBase {
  error: TaskError;
}

export interface WorkflowProgressNotificationPayload extends WorkflowNotificationPayloadBase {
  progress?: TaskProgressUpdate;
  message?: string;
}

export interface WorkflowWaitingNotificationPayload extends WorkflowNotificationPayloadBase {
  wait: WorkflowWaitState;
}

type WorkflowActorRef = ActorRef & { kind: "workflow" };

export type WorkflowCompletedNotificationInput =
  ActorNotificationInputBase<WorkflowCompletedNotificationPayload> & {
    source: WorkflowActorRef;
    type: "completed";
  };

export type WorkflowFailedNotificationInput =
  ActorNotificationInputBase<WorkflowFailedNotificationPayload> & {
    source: WorkflowActorRef;
    type: "failed";
  };

export type WorkflowProgressNotificationInput =
  ActorNotificationInputBase<WorkflowProgressNotificationPayload> & {
    source: WorkflowActorRef;
    type: "progress";
  };

export type WorkflowWaitingNotificationInput =
  ActorNotificationInputBase<WorkflowWaitingNotificationPayload> & {
    source: WorkflowActorRef;
    type: "waiting";
  };

export type WorkflowActorNotificationInput =
  | WorkflowCompletedNotificationInput
  | WorkflowFailedNotificationInput
  | WorkflowProgressNotificationInput
  | WorkflowWaitingNotificationInput;

export type WorkflowCompletedActorNotification =
  ActorNotificationBase<WorkflowCompletedNotificationPayload> & {
    source: WorkflowActorRef;
    type: "completed";
    qos: "reliable";
  };

export type WorkflowFailedActorNotification =
  ActorNotificationBase<WorkflowFailedNotificationPayload> & {
    source: WorkflowActorRef;
    type: "failed";
    qos: "reliable";
  };

export type WorkflowProgressActorNotification =
  ActorNotificationBase<WorkflowProgressNotificationPayload> & {
    source: WorkflowActorRef;
    type: "progress";
    qos: "lossy";
  };

export type WorkflowWaitingActorNotification =
  ActorNotificationBase<WorkflowWaitingNotificationPayload> & {
    source: WorkflowActorRef;
    type: "waiting";
    qos: "reliable";
  };

export type WorkflowActorNotification =
  | WorkflowCompletedActorNotification
  | WorkflowFailedActorNotification
  | WorkflowProgressActorNotification
  | WorkflowWaitingActorNotification;

export type AnyActorNotificationInput =
  | TaskActorNotificationInput
  | WorkflowActorNotificationInput;

export type AnyActorNotification =
  | TaskActorNotification
  | WorkflowActorNotification;

export type DeliveryResult =
  | { status: "accepted"; acceptedCount: number; droppedCount?: number }
  | {
      status: "dropped";
      reason: "capacity";
      droppedCount: number;
    };

export interface ActorNotificationSink {
  deliver(
    input: AnyActorNotificationInput,
  ): DeliveryResult | Promise<DeliveryResult>;
}

export type ActorNotificationPredicate = (
  notification: AnyActorNotification,
) => boolean;

export interface ActorInbox {
  peek(
    predicate?: ActorNotificationPredicate,
  ): readonly AnyActorNotification[] | Promise<readonly AnyActorNotification[]>;
  drain(
    predicate?: ActorNotificationPredicate,
  ): AnyActorNotification[] | Promise<AnyActorNotification[]>;
  waitUntilAvailable(options?: {
    signal?: AbortSignal;
    predicate?: ActorNotificationPredicate;
  }): Promise<void>;
}

export class ActorNotificationValidationError extends Error {
  readonly code = "INVALID_ROUTE";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "ActorNotificationValidationError";
  }
}

export class ActorNotificationInvalidError extends Error {
  readonly code = "INVALID_ACTOR_NOTIFICATION";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "ActorNotificationInvalidError";
  }
}

export class ActorNotificationUnsupportedError extends Error {
  readonly code = "UNSUPPORTED_ACTOR_NOTIFICATION";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "ActorNotificationUnsupportedError";
  }
}

export class ActorNotificationCapacityError extends Error {
  readonly code = "ACTOR_INBOX_CAPACITY";
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "ActorNotificationCapacityError";
  }
}

/**
 * Terminal task statuses delivered to a sink. `pending` and `running` are
 * intentionally excluded — notifications fire only on terminal transitions.
 *
 * @public
 * @stability experimental v0.1
 */
export type TaskTerminalStatus = "completed" | "failed" | "cancelled";

/**
 * Options for {@link InMemoryActorNotificationQueue}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface InMemoryActorNotificationQueueOptions {
  /**
   * Optional bounded capacity. Reliable terminal notifications are never
   * silently dropped; lossy actor notifications may drop the oldest lossy
   * buffered entry. Default is unbounded.
   */
  maxBufferedNotifications?: number;
}

/**
 * In-memory actor sink/inbox used by single-process hosts and tests.
 *
 * @public
 * @stability experimental v0.1
 */
export class InMemoryActorNotificationQueue
  implements ActorNotificationSink, ActorInbox
{
  private readonly actorBuffer: AnyActorNotification[] = [];
  private nextActorSequence = 1;
  private readonly actorReadyWaiters: Array<{
    predicate?: ActorNotificationPredicate;
    resolve: () => void;
    reject: (cause: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private readonly cap?: number;

  constructor(options: InMemoryActorNotificationQueueOptions = {}) {
    if (options.maxBufferedNotifications !== undefined) {
      if (
        !Number.isInteger(options.maxBufferedNotifications) ||
        options.maxBufferedNotifications <= 0
      ) {
        throw new Error(
          "maxBufferedNotifications must be a positive integer when set.",
        );
      }
      this.cap = options.maxBufferedNotifications;
    }
  }

  deliver(input: AnyActorNotificationInput): DeliveryResult {
    const accepted = acceptActorNotificationInput(input, {
      id: createInMemoryActorNotificationId(),
      sequence: this.nextActorSequence++,
    });
    const result = this.pushAcceptedActor(accepted);
    this.resolveActorReadyWaiters();
    return result;
  }

  /** Snapshot of currently-buffered notifications without consuming them. */
  peek(
    predicate?: ActorNotificationPredicate,
  ): readonly AnyActorNotification[] {
    return this.actorBuffer.filter(
      (notification) => !predicate || predicate(notification),
    );
  }

  /** Atomically remove and return buffered notifications. */
  drain(predicate?: ActorNotificationPredicate): AnyActorNotification[] {
    const matched: AnyActorNotification[] = [];
    const remaining: AnyActorNotification[] = [];
    for (const notification of this.actorBuffer) {
      if (!predicate || predicate(notification)) matched.push(notification);
      else remaining.push(notification);
    }
    this.actorBuffer.length = 0;
    this.actorBuffer.push(...remaining);
    return matched;
  }

  waitUntilAvailable(
    options: {
      signal?: AbortSignal;
      predicate?: ActorNotificationPredicate;
    } = {},
  ): Promise<void> {
    if (this.hasActorBuffered(options.predicate)) return Promise.resolve();
    if (options.signal?.aborted) return Promise.reject(makeAbortError());

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: options.predicate,
        resolve,
        reject,
        signal: options.signal,
        onAbort: undefined as (() => void) | undefined,
      };
      waiter.onAbort = () => {
        this.removeActorReadyWaiter(waiter);
        reject(makeAbortError());
      };
      options.signal?.addEventListener("abort", waiter.onAbort, {
        once: true,
      });
      this.actorReadyWaiters.push(waiter);
    });
  }

  private pushAcceptedActor(
    notification: AnyActorNotification,
  ): DeliveryResult {
    this.actorBuffer.push(notification);
    if (this.cap === undefined || this.actorBuffer.length <= this.cap) {
      return { status: "accepted", acceptedCount: 1 };
    }
    const dropped = this.dropOldestLossyUntilWithinCapacity();
    if (this.actorBuffer.length > this.cap) {
      this.removeActorsById(new Set([notification.id]));
      throw new ActorNotificationCapacityError(
        "Reliable actor notification capacity exceeded.",
      );
    }
    if (this.actorBuffer.includes(notification)) {
      return {
        status: "accepted",
        acceptedCount: 1,
        ...(dropped > 0 ? { droppedCount: dropped } : {}),
      };
    }
    return { status: "dropped", reason: "capacity", droppedCount: dropped };
  }

  private dropOldestLossyUntilWithinCapacity(): number {
    if (this.cap === undefined) return 0;
    let dropped = 0;
    while (this.actorBuffer.length > this.cap) {
      const index = this.actorBuffer.findIndex(
        (notification) => notification.qos === "lossy",
      );
      if (index < 0) break;
      const [removed] = this.actorBuffer.splice(index, 1);
      if (removed) {
        dropped += 1;
      }
    }
    return dropped;
  }

  private hasActorBuffered(predicate?: ActorNotificationPredicate): boolean {
    return predicate
      ? this.actorBuffer.some(predicate)
      : this.actorBuffer.length > 0;
  }

  private resolveActorReadyWaiters(): void {
    for (const waiter of [...this.actorReadyWaiters]) {
      if (!this.hasActorBuffered(waiter.predicate)) continue;
      this.removeActorReadyWaiter(waiter);
      waiter.resolve();
    }
  }

  private removeActorReadyWaiter(waiter: {
    signal?: AbortSignal;
    onAbort?: () => void;
  }): void {
    const index = this.actorReadyWaiters.indexOf(
      waiter as (typeof this.actorReadyWaiters)[number],
    );
    if (index >= 0) this.actorReadyWaiters.splice(index, 1);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  private removeActorsById(ids: Set<string>): void {
    if (ids.size === 0) return;
    for (let index = this.actorBuffer.length - 1; index >= 0; index -= 1) {
      if (ids.has(this.actorBuffer[index]!.id)) {
        this.actorBuffer.splice(index, 1);
      }
    }
  }
}

function makeAbortError(): Error {
  const error = new Error("Task notification wait aborted.");
  error.name = "AbortError";
  return error;
}

export function qosForActorNotificationType(
  type: ActorNotificationType,
): ActorNotificationQos {
  return type === "progress" || type === "output" ? "lossy" : "reliable";
}

export function isNonRetryableActorNotificationError(cause: unknown): boolean {
  if (!isRecord(cause) || cause.retryable !== false) return false;
  const code = cause.code;
  return (
    code === "INVALID_ROUTE" ||
    code === "INVALID_ACTOR_NOTIFICATION" ||
    code === "UNSUPPORTED_ACTOR_NOTIFICATION"
  );
}

export function acceptActorNotificationInput(
  input: AnyActorNotificationInput,
  options: { id: string; sequence: number; createdAt?: string },
): AnyActorNotification {
  const routeHint = normalizeActorRoute(input);
  validateActorNotificationInput(input, routeHint);
  const accepted = {
    source: { ...input.source },
    ...(routeHint ? { routeHint } : {}),
    type: input.type,
    ...(input.correlationId !== undefined
      ? { correlationId: input.correlationId }
      : {}),
    payload: input.payload,
    ...(input.outputRef !== undefined ? { outputRef: input.outputRef } : {}),
    ...(input.suggestedContext !== undefined
      ? { suggestedContext: input.suggestedContext }
      : {}),
    id: options.id,
    sequence: options.sequence,
    qos: qosForActorNotificationType(input.type),
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  return accepted as AnyActorNotification;
}

function validateActorNotificationInput(
  input: AnyActorNotificationInput,
  routeHint?: ActorRouteHint,
): void {
  const source = input.source as ActorRef;
  const sourceKind: unknown = (source as { kind?: unknown }).kind;
  assertActorFieldId(source.id, "source.id");
  if (sourceKind === "task") {
    validateTaskActorNotificationInput(
      input as TaskActorNotificationInput,
      routeHint,
    );
    return;
  }
  if (sourceKind === "workflow") {
    validateWorkflowActorNotificationInput(
      input as WorkflowActorNotificationInput,
      routeHint,
    );
    return;
  }
  throw new ActorNotificationInvalidError(
    `Actor notification source kind ${String(sourceKind)} is not supported by the current actor notification input union.`,
  );
}

function validateTaskActorNotificationInput(
  input: TaskActorNotificationInput,
  routeHint?: ActorRouteHint,
): void {
  const payload = input.payload;
  if (!isRecord(payload)) {
    throw new ActorNotificationInvalidError(
      "Task notification payload must be an object.",
    );
  }
  assertActorPayloadIdMatchesSource(
    input.source,
    payload.taskId,
    "payload.taskId",
  );
  const parentRunId = assertActorFieldId(
    payload.parentRunId,
    "payload.parentRunId",
  );
  if (routeHint?.parentRunId === undefined) {
    throw new ActorNotificationInvalidError(
      "Task actor notifications require source.runId or routeHint.parentRunId.",
    );
  }
  if (routeHint.parentRunId !== parentRunId) {
    throw new ActorNotificationInvalidError(
      "payload.parentRunId must match the normalized actor route parentRunId.",
    );
  }
  if (
    (input.type === "completed" ||
      input.type === "failed" ||
      input.type === "cancelled") &&
    payload.status !== input.type
  ) {
    throw new ActorNotificationInvalidError(
      "Task terminal payload status must match the actor notification type.",
    );
  }
}

function validateWorkflowActorNotificationInput(
  input: WorkflowActorNotificationInput,
  _routeHint?: ActorRouteHint,
): void {
  const payload = input.payload;
  if (!isRecord(payload)) {
    throw new ActorNotificationInvalidError(
      "Workflow notification payload must be an object.",
    );
  }
  assertActorPayloadIdMatchesSource(
    input.source,
    payload.workflowId,
    "payload.workflowId",
  );
  if (input.type === "waiting") {
    const wait = payload.wait;
    if (!isRecord(wait)) {
      throw new ActorNotificationInvalidError(
        "Workflow waiting payload requires wait.",
      );
    }
    if (
      wait.kind !== "input" &&
      wait.kind !== "task" &&
      wait.kind !== "approval"
    ) {
      throw new ActorNotificationInvalidError(
        "Workflow waiting payload wait.kind must be input, task, or approval.",
      );
    }
  }
}

function assertActorPayloadIdMatchesSource(
  source: ActorRef,
  payloadId: unknown,
  field: string,
): void {
  const id = assertActorFieldId(payloadId, field);
  if (id !== source.id) {
    throw new ActorNotificationInvalidError(
      `${field} must match source.id for ${source.kind} actor notifications.`,
    );
  }
}

function assertActorFieldId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ActorNotificationInvalidError(
      `${field} must be a non-empty string.`,
    );
  }
  return value;
}

function normalizeActorRoute(
  input: AnyActorNotificationInput,
): ActorRouteHint | undefined {
  assertRouteId(input.source.runId, "source.runId");
  assertRouteId(input.source.sessionId, "source.sessionId");
  assertRouteId(input.routeHint?.parentRunId, "routeHint.parentRunId");
  assertRouteId(input.routeHint?.targetRunId, "routeHint.targetRunId");
  assertRouteId(input.routeHint?.sessionId, "routeHint.sessionId");

  const routeHint: ActorRouteHint = { ...input.routeHint };
  if (
    routeHint.parentRunId !== undefined &&
    input.source.runId !== undefined &&
    routeHint.parentRunId !== input.source.runId
  ) {
    throw new ActorNotificationValidationError(
      "routeHint.parentRunId must match source.runId when both are set.",
    );
  }
  if (
    routeHint.sessionId !== undefined &&
    input.source.sessionId !== undefined &&
    routeHint.sessionId !== input.source.sessionId
  ) {
    throw new ActorNotificationValidationError(
      "routeHint.sessionId must match source.sessionId when both are set.",
    );
  }
  if (routeHint.parentRunId === undefined && input.source.runId !== undefined) {
    routeHint.parentRunId = input.source.runId;
  }
  if (
    routeHint.sessionId === undefined &&
    input.source.sessionId !== undefined
  ) {
    routeHint.sessionId = input.source.sessionId;
  }
  return Object.keys(routeHint).length > 0 ? routeHint : undefined;
}

function assertRouteId(value: string | undefined, field: string): void {
  if (value !== undefined && value.trim().length === 0) {
    throw new ActorNotificationValidationError(`${field} must be non-empty.`);
  }
}

function createInMemoryActorNotificationId(): string {
  return `actor_notice_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Build a terminal task actor input from a terminal {@link TaskRecord}.
 *
 * @public
 * @stability experimental v0.1
 */
export function taskNotificationInputFromRecord(
  record: TaskRecord,
  options: { targetRunId?: string; outputRef?: string } = {},
): TaskTerminalActorNotificationInput {
  if (!isTerminalStatus(record.status)) {
    throw new Error(
      `taskNotificationInputFromRecord: record is not terminal (status=${record.status}).`,
    );
  }
  const source: TaskActorRef = {
    kind: "task",
    id: record.id,
    runId: record.parentRunId,
  };
  const routeHint: ActorRouteHint = {
    parentRunId: record.parentRunId,
    ...(options.targetRunId ? { targetRunId: options.targetRunId } : {}),
  };
  const basePayload: TaskNotificationPayloadBase = {
    taskId: record.id,
    parentRunId: record.parentRunId,
    kind: record.kind,
    ...(record.title ? { title: record.title } : {}),
    summary: summarize(record),
    deliveredAt: new Date().toISOString(),
  };
  const outputRef = options.outputRef ? { outputRef: options.outputRef } : {};
  if (record.status === "completed") {
    return {
      source,
      routeHint,
      type: "completed",
      payload: {
        ...basePayload,
        status: "completed",
        ...(record.result !== undefined ? { result: record.result } : {}),
      },
      ...outputRef,
    };
  }
  if (record.status === "failed") {
    return {
      source,
      routeHint,
      type: "failed",
      payload: {
        ...basePayload,
        status: "failed",
        error: record.error ?? {
          code: "TASK_FAILED",
          message: "Task failed without an error payload.",
        },
      },
      ...outputRef,
    };
  }
  return {
    source,
    routeHint,
    type: "cancelled",
    payload: {
      ...basePayload,
      status: "cancelled",
    },
    ...outputRef,
  };
}

function summarize(record: TaskRecord): string {
  const label = record.title ?? record.kind;
  switch (record.status) {
    case "completed":
      return `Task ${label} completed.`;
    case "failed":
      return `Task ${label} failed: ${record.error?.message ?? "unknown error"}`;
    case "cancelled":
      return `Task ${label} cancelled.`;
    default:
      // Unreachable — guarded by isTerminalStatus above.
      return `Task ${label} reached status ${record.status as TaskStatus}.`;
  }
}

function isTerminalStatus(status: TaskStatus): status is TaskTerminalStatus {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}
