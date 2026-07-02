// AI maintenance note: TaskNotificationSink is the bridge that turns a
// background task's terminal transition into something the *agent loop* can
// observe on its next turn. The runtime intentionally does not couple this to
// any specific transport — hosts wire the sink to whatever they use to inject
// "user-role" content (e.g. message-queue attachment in streaming-runtime,
// XML-tag injection in a CLI-style frontend).
//
// Lifecycle: TaskManager calls sink.deliver(...) exactly once per task, AFTER
// the record has been moved to a terminal status. Deliveries are best-effort;
// if the sink throws, TaskManager logs to its `onSinkError` hook (if set) and
// continues — task state is the source of truth, the sink is just a hint.

import type {
  TaskError,
  TaskId,
  TaskProgressUpdate,
  TaskRecord,
  TaskStatus,
} from "./types.js";

export type InternalActorKind = "run" | "agent" | "task" | "workflow";

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

export type WorkflowActorNotificationInput =
  | WorkflowCompletedNotificationInput
  | WorkflowFailedNotificationInput
  | WorkflowProgressNotificationInput;

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

export type WorkflowActorNotification =
  | WorkflowCompletedActorNotification
  | WorkflowFailedActorNotification
  | WorkflowProgressActorNotification;

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
 * Payload handed to {@link TaskNotificationSink.deliver}. Everything the agent
 * needs to construct a follow-up turn without re-fetching the record.
 *
 * `outputRef` is intentionally string-typed and opaque — hosts that spill
 * output to disk pass a file path; hosts that keep output in memory pass a
 * `taskId` the agent will hand to `task_output`.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskNotification {
  taskId: TaskId;
  parentRunId: TaskRecord["parentRunId"];
  /**
   * Optional routing hint for sub-agent fan-out: when set, the notification
   * is targeted at a specific child run / agent loop rather than the parent.
   */
  targetRunId?: string;
  status: TaskTerminalStatus;
  kind: string;
  title?: string;
  /** Human-readable one-line summary suitable for embedding in a turn. */
  summary: string;
  /** Final result, present when status === "completed". */
  result?: unknown;
  /** Error descriptor, present when status === "failed". */
  error?: TaskError;
  /** Opaque pointer to buffered output (file path, taskId, URL — host's choice). */
  outputRef?: string;
  /** ISO-8601 timestamp of the terminal transition. */
  deliveredAt: string;
}

/**
 * Delivery surface for terminal task notifications. Implementations decide
 * how to surface the notification to the agent loop — queue it for the next
 * turn, render as XML, push over a websocket, etc.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskNotificationSink {
  deliver(notification: TaskNotification): void | Promise<void>;
}

/**
 * Options for {@link InMemoryTaskNotificationQueue}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface InMemoryTaskNotificationQueueOptions {
  /**
   * Optional bounded capacity. Reliable terminal notifications are never
   * silently dropped; lossy actor notifications may drop the oldest lossy
   * buffered entry. Default is unbounded.
   */
  maxBufferedNotifications?: number;
}

export interface TaskNotificationReadyWaitOptions {
  signal?: AbortSignal;
  predicate?: (notification: TaskNotification) => boolean;
}

/**
 * Default sink implementation: buffers notifications in memory until a
 * consumer (the agent loop) calls {@link InMemoryTaskNotificationQueue.drain}.
 * Suitable for single-process hosts. Multi-process / distributed hosts should
 * implement their own {@link TaskNotificationSink}.
 *
 * @public
 * @stability experimental v0.1
 */
export class InMemoryTaskNotificationQueue implements TaskNotificationSink {
  private readonly taskBuffer: Array<{
    notification: TaskNotification;
    actorId: string;
  }> = [];
  private readonly actorBuffer: AnyActorNotification[] = [];
  private nextActorSequence = 1;
  private readonly waiters: Array<(items: TaskNotification[]) => void> = [];
  private readonly readyWaiters: Array<{
    predicate?: (notification: TaskNotification) => boolean;
    resolve: () => void;
    reject: (cause: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private readonly actorReadyWaiters: Array<{
    predicate?: ActorNotificationPredicate;
    resolve: () => void;
    reject: (cause: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private readonly cap?: number;
  private readonly actorSink: ActorNotificationSink = {
    deliver: (input) => this.deliverActor(input),
  };
  private readonly actorInbox: ActorInbox = {
    peek: (predicate) => this.peekActor(predicate),
    drain: (predicate) => this.drainActor(predicate),
    waitUntilAvailable: (options = {}) => this.waitUntilActorAvailable(options),
  };

  constructor(options: InMemoryTaskNotificationQueueOptions = {}) {
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

  asActorSink(): ActorNotificationSink {
    return this.actorSink;
  }

  asActorInbox(): ActorInbox {
    return this.actorInbox;
  }

  deliver(notification: TaskNotification): void {
    const accepted = acceptActorNotificationInput(
      actorNotificationInputFromTaskNotification(notification),
      {
        id: createInMemoryActorNotificationId(),
        sequence: this.nextActorSequence++,
      },
    );
    this.pushAcceptedActor(accepted);
    this.taskBuffer.push({ notification, actorId: accepted.id });
    this.resolveAllReadyWaiters();
    const waiter = this.waiters.shift();
    if (waiter) waiter(this.drainAll());
  }

  /** Snapshot of currently-buffered notifications without consuming them. */
  peek(): readonly TaskNotification[] {
    return this.taskBuffer.map((entry) => entry.notification);
  }

  /** Atomically remove and return buffered notifications. */
  drain(
    predicate?: (notification: TaskNotification) => boolean,
  ): TaskNotification[] {
    return this.drainAll(predicate);
  }

  /**
   * Resolve as soon as at least one notification is buffered. Used by agent
   * loops that block between turns waiting for background work.
   */
  waitForNext(): Promise<TaskNotification[]> {
    if (this.taskBuffer.length > 0) {
      return Promise.resolve(this.drainAll());
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Resolve when at least one buffered notification is available, without
   * consuming it. This is the revival wait primitive; `drain()` remains the
   * single consumer used at step-start injection.
   */
  waitUntilAvailable(
    options: TaskNotificationReadyWaitOptions = {},
  ): Promise<void> {
    if (this.hasBuffered(options.predicate)) return Promise.resolve();
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
        this.removeReadyWaiter(waiter);
        reject(makeAbortError());
      };
      options.signal?.addEventListener("abort", waiter.onAbort, {
        once: true,
      });
      this.readyWaiters.push(waiter);
    });
  }

  private drainAll(
    predicate?: (notification: TaskNotification) => boolean,
  ): TaskNotification[] {
    if (!predicate) {
      const entries = [...this.taskBuffer];
      this.taskBuffer.length = 0;
      this.removeActorsById(new Set(entries.map((entry) => entry.actorId)));
      return entries.map((entry) => entry.notification);
    }
    const matched: Array<{
      notification: TaskNotification;
      actorId: string;
    }> = [];
    const remaining: Array<{
      notification: TaskNotification;
      actorId: string;
    }> = [];
    for (const item of this.taskBuffer) {
      if (predicate(item.notification)) matched.push(item);
      else remaining.push(item);
    }
    this.taskBuffer.length = 0;
    this.taskBuffer.push(...remaining);
    this.removeActorsById(new Set(matched.map((entry) => entry.actorId)));
    return matched.map((entry) => entry.notification);
  }

  private hasBuffered(
    predicate?: (notification: TaskNotification) => boolean,
  ): boolean {
    return predicate
      ? this.taskBuffer.some((entry) => predicate(entry.notification))
      : this.taskBuffer.length > 0;
  }

  private peekActor(
    predicate?: ActorNotificationPredicate,
  ): readonly AnyActorNotification[] {
    return this.actorBuffer.filter(
      (notification) => !predicate || predicate(notification),
    );
  }

  private drainActor(
    predicate?: ActorNotificationPredicate,
  ): AnyActorNotification[] {
    const matched: AnyActorNotification[] = [];
    const remaining: AnyActorNotification[] = [];
    for (const notification of this.actorBuffer) {
      if (!predicate || predicate(notification)) matched.push(notification);
      else remaining.push(notification);
    }
    this.actorBuffer.length = 0;
    this.actorBuffer.push(...remaining);
    this.removeTaskNotificationsByActorId(
      new Set(matched.map((notification) => notification.id)),
    );
    return matched;
  }

  private waitUntilActorAvailable(
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

  private deliverActor(input: AnyActorNotificationInput): DeliveryResult {
    const accepted = acceptActorNotificationInput(input, {
      id: createInMemoryActorNotificationId(),
      sequence: this.nextActorSequence++,
    });
    const result = this.pushAcceptedActor(accepted);
    if (result.status === "dropped") return result;
    const taskNotification = taskNotificationFromActorNotification(accepted);
    if (taskNotification) {
      this.taskBuffer.push({
        notification: taskNotification,
        actorId: accepted.id,
      });
      this.resolveAllReadyWaiters();
      const waiter = this.waiters.shift();
      if (waiter) waiter(this.drainAll());
    } else {
      this.resolveAllReadyWaiters();
    }
    return result;
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
        this.removeTaskNotificationsByActorId(new Set([removed.id]));
      }
    }
    return dropped;
  }

  private hasActorBuffered(predicate?: ActorNotificationPredicate): boolean {
    return predicate
      ? this.actorBuffer.some(predicate)
      : this.actorBuffer.length > 0;
  }

  private resolveReadyWaiters(): void {
    for (const waiter of [...this.readyWaiters]) {
      if (!this.hasBuffered(waiter.predicate)) continue;
      this.removeReadyWaiter(waiter);
      waiter.resolve();
    }
  }

  private resolveActorReadyWaiters(): void {
    for (const waiter of [...this.actorReadyWaiters]) {
      if (!this.hasActorBuffered(waiter.predicate)) continue;
      this.removeActorReadyWaiter(waiter);
      waiter.resolve();
    }
  }

  private resolveAllReadyWaiters(): void {
    this.resolveReadyWaiters();
    this.resolveActorReadyWaiters();
  }

  private removeReadyWaiter(waiter: {
    signal?: AbortSignal;
    onAbort?: () => void;
  }): void {
    const index = this.readyWaiters.indexOf(
      waiter as (typeof this.readyWaiters)[number],
    );
    if (index >= 0) this.readyWaiters.splice(index, 1);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
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

  private removeTaskNotificationsByActorId(ids: Set<string>): void {
    if (ids.size === 0) return;
    for (let index = this.taskBuffer.length - 1; index >= 0; index -= 1) {
      if (ids.has(this.taskBuffer[index]!.actorId)) {
        this.taskBuffer.splice(index, 1);
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
  return (
    isRecord(cause) &&
    cause.code === "INVALID_ROUTE" &&
    cause.retryable === false
  );
}

export function acceptActorNotificationInput(
  input: AnyActorNotificationInput,
  options: { id: string; sequence: number; createdAt?: string },
): AnyActorNotification {
  const routeHint = normalizeActorRoute(input);
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

export function actorNotificationInputFromTaskNotification(
  notification: TaskNotification,
):
  | TaskCompletedNotificationInput
  | TaskFailedNotificationInput
  | TaskCancelledNotificationInput {
  const source: TaskActorRef = {
    kind: "task",
    id: notification.taskId,
    runId: notification.parentRunId,
  };
  const routeHint: ActorRouteHint = {
    parentRunId: notification.parentRunId,
    ...(notification.targetRunId
      ? { targetRunId: notification.targetRunId }
      : {}),
  };
  const basePayload: TaskNotificationPayloadBase = {
    taskId: notification.taskId,
    parentRunId: notification.parentRunId,
    kind: notification.kind,
    ...(notification.title ? { title: notification.title } : {}),
    summary: notification.summary,
    deliveredAt: notification.deliveredAt,
  };
  if (notification.status === "completed") {
    return {
      source,
      routeHint,
      type: "completed",
      payload: {
        ...basePayload,
        status: "completed",
        ...(notification.result !== undefined
          ? { result: notification.result }
          : {}),
      },
      ...(notification.outputRef ? { outputRef: notification.outputRef } : {}),
    };
  }
  if (notification.status === "failed") {
    return {
      source,
      routeHint,
      type: "failed",
      payload: {
        ...basePayload,
        status: "failed",
        error: notification.error ?? {
          code: "TASK_FAILED",
          message: "Task failed without an error payload.",
        },
      },
      ...(notification.outputRef ? { outputRef: notification.outputRef } : {}),
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
    ...(notification.outputRef ? { outputRef: notification.outputRef } : {}),
  };
}

export function taskNotificationFromActorNotification(
  notification: AnyActorNotification,
): TaskNotification | undefined {
  if (notification.source.kind !== "task") return undefined;
  if (
    notification.type !== "completed" &&
    notification.type !== "failed" &&
    notification.type !== "cancelled"
  ) {
    return undefined;
  }
  const payload = notification.payload as
    | TaskCompletedNotificationPayload
    | TaskFailedNotificationPayload
    | TaskCancelledNotificationPayload;
  const parentRunId = (notification.routeHint?.parentRunId ??
    payload.parentRunId) as TaskRecord["parentRunId"];
  if (notification.type === "completed") {
    return {
      taskId: payload.taskId,
      parentRunId,
      targetRunId: notification.routeHint?.targetRunId,
      status: "completed",
      kind: payload.kind,
      title: payload.title,
      summary: payload.summary,
      result: (payload as TaskCompletedNotificationPayload).result,
      outputRef: notification.outputRef,
      deliveredAt: payload.deliveredAt,
    };
  }
  if (notification.type === "failed") {
    return {
      taskId: payload.taskId,
      parentRunId,
      targetRunId: notification.routeHint?.targetRunId,
      status: "failed",
      kind: payload.kind,
      title: payload.title,
      summary: payload.summary,
      error: (payload as TaskFailedNotificationPayload).error,
      outputRef: notification.outputRef,
      deliveredAt: payload.deliveredAt,
    };
  }
  return {
    taskId: payload.taskId,
    parentRunId,
    targetRunId: notification.routeHint?.targetRunId,
    status: "cancelled",
    kind: payload.kind,
    title: payload.title,
    summary: payload.summary,
    outputRef: notification.outputRef,
    deliveredAt: payload.deliveredAt,
  };
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
 * Build a {@link TaskNotification} from a terminal {@link TaskRecord}. The
 * runtime uses this helper internally; it is exported so custom sinks can
 * reconstruct the payload from stored records during replay.
 *
 * @public
 * @stability experimental v0.1
 */
export function notificationFromRecord(
  record: TaskRecord,
  options: { targetRunId?: string; outputRef?: string } = {},
): TaskNotification {
  if (!isTerminalStatus(record.status)) {
    throw new Error(
      `notificationFromRecord: record is not terminal (status=${record.status}).`,
    );
  }
  return {
    taskId: record.id,
    parentRunId: record.parentRunId,
    targetRunId: options.targetRunId,
    status: record.status,
    kind: record.kind,
    title: record.title,
    summary: summarize(record),
    result: record.result,
    error: record.error,
    outputRef: options.outputRef,
    deliveredAt: new Date().toISOString(),
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
