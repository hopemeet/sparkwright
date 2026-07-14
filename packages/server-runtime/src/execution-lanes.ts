import { createId } from "@sparkwright/core";

export interface ExecutionStartContext {
  executionId: string;
  sessionId: string;
  signal: AbortSignal;
}

export interface ExecutionHandle<TMessage = unknown, TTerminal = unknown> {
  readonly rootRunId: string;
  currentRunId(): string;
  tryInject(message: TMessage): "accepted" | "closed";
  cancel(reason?: string): void;
  readonly completion: Promise<TTerminal>;
}

export interface ExecutionDriver<
  TInput,
  TMessage = unknown,
  TTerminal = unknown,
> {
  start(
    input: TInput,
    context: ExecutionStartContext,
  ): Promise<ExecutionHandle<TMessage, TTerminal>>;
}

export interface ExecutionLaneCoordinatorConfig {
  maxActiveExecutions: number;
  maxQueuedPerLane: number;
  maxQueuedTotal: number;
}

export type ExecutionStartResult =
  | {
      status: "started";
      commandId: string;
      executionId: string;
      rootRunId: string;
    }
  | {
      status: "failed" | "cancelled";
      commandId: string;
      executionId: string;
      message?: string;
    };

export type ExecutionSubmission =
  | {
      status: "accepted";
      commandId: string;
      executionId: string;
      result: Promise<ExecutionStartResult>;
    }
  | {
      status: "conflict" | "capacity";
      message: string;
    };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface QueuedCommand<TInput> {
  laneKey: string;
  commandId: string;
  executionId: string;
  sessionId: string;
  input: TInput;
  deferred: Deferred<ExecutionStartResult>;
  abortController: AbortController;
  settled: boolean;
}

interface ActiveExecution<TInput, TMessage, TTerminal> {
  command: QueuedCommand<TInput>;
  handle?: ExecutionHandle<TMessage, TTerminal>;
  starting: boolean;
  completed: boolean;
}

interface Lane<TInput, TMessage, TTerminal> {
  queue: Array<QueuedCommand<TInput>>;
  active?: ActiveExecution<TInput, TMessage, TTerminal>;
  runnable: boolean;
}

interface IdempotencyEntry {
  digest: string;
  submission: Extract<ExecutionSubmission, { status: "accepted" }>;
}

const DEFAULT_CONFIG: ExecutionLaneCoordinatorConfig = {
  maxActiveExecutions: 4,
  maxQueuedPerLane: 16,
  maxQueuedTotal: 128,
};

/** In-memory, transport-neutral single-process interactive lane scheduler. */
export class ExecutionLaneCoordinator<
  TInput,
  TMessage = unknown,
  TTerminal = unknown,
> {
  private readonly config: ExecutionLaneCoordinatorConfig;
  private readonly lanes = new Map<string, Lane<TInput, TMessage, TTerminal>>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly runnableLaneKeys: string[] = [];
  private activeCount = 0;
  private queuedCount = 0;
  private scheduling = false;

  constructor(
    private readonly driver: ExecutionDriver<TInput, TMessage, TTerminal>,
    config: Partial<ExecutionLaneCoordinatorConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    for (const [name, value] of Object.entries(this.config)) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer.`);
      }
    }
  }

  submit(input: {
    laneKey: string;
    sessionId: string;
    commandId?: string;
    idempotencyKey?: string;
    digest: string;
    input: TInput;
  }): ExecutionSubmission {
    const scope = input.idempotencyKey
      ? `${input.laneKey}\0${input.idempotencyKey}`
      : undefined;
    const prior = scope ? this.idempotency.get(scope) : undefined;
    if (prior) {
      return prior.digest === input.digest
        ? prior.submission
        : {
            status: "conflict",
            message:
              "idempotency key was reused with a different command digest",
          };
    }
    const lane = this.lanes.get(input.laneKey) ?? {
      queue: [],
      runnable: false,
    };
    this.lanes.set(input.laneKey, lane);
    const canStartImmediately =
      !lane.active && this.activeCount < this.config.maxActiveExecutions;
    if (
      !canStartImmediately &&
      lane.queue.length >= this.config.maxQueuedPerLane
    ) {
      return { status: "capacity", message: "lane queue capacity exceeded" };
    }
    if (
      !canStartImmediately &&
      this.queuedCount >= this.config.maxQueuedTotal
    ) {
      return { status: "capacity", message: "total queue capacity exceeded" };
    }
    const commandId = input.commandId ?? (createId("command") as string);
    const executionId = createId("execution") as string;
    const deferred = createDeferred<ExecutionStartResult>();
    const command: QueuedCommand<TInput> = {
      laneKey: input.laneKey,
      commandId,
      executionId,
      sessionId: input.sessionId,
      input: input.input,
      deferred,
      abortController: new AbortController(),
      settled: false,
    };
    lane.queue.push(command);
    this.queuedCount += 1;
    this.markRunnable(input.laneKey, lane);
    const submission: Extract<ExecutionSubmission, { status: "accepted" }> = {
      status: "accepted",
      commandId,
      executionId,
      result: deferred.promise,
    };
    if (scope)
      this.idempotency.set(scope, { digest: input.digest, submission });
    this.schedule();
    return submission;
  }

  tryInject(input: {
    laneKey: string;
    message: TMessage;
  }): "accepted" | "closed" | "not_found" {
    const active = this.lanes.get(input.laneKey)?.active;
    if (!active?.handle) return active?.starting ? "closed" : "not_found";
    return active.handle.tryInject(input.message);
  }

  cancelExecution(executionId: string, reason?: string): boolean {
    for (const lane of this.lanes.values()) {
      if (lane.active?.command.executionId !== executionId) continue;
      lane.active.command.abortController.abort(reason);
      lane.active.handle?.cancel(reason);
      return true;
    }
    return false;
  }

  cancelLane(laneKey: string, reason = "lane cancelled"): number {
    const lane = this.lanes.get(laneKey);
    if (!lane) return 0;
    let cancelled = 0;
    if (lane.active) {
      lane.active.command.abortController.abort(reason);
      lane.active.handle?.cancel(reason);
      cancelled += 1;
    }
    for (const command of lane.queue.splice(0)) {
      this.queuedCount -= 1;
      command.abortController.abort(reason);
      this.settle(command, {
        status: "cancelled",
        commandId: command.commandId,
        executionId: command.executionId,
        message: reason,
      });
      cancelled += 1;
    }
    lane.runnable = false;
    return cancelled;
  }

  snapshot(): { active: number; queued: number; lanes: number } {
    return {
      active: this.activeCount,
      queued: this.queuedCount,
      lanes: this.lanes.size,
    };
  }

  private markRunnable(
    laneKey: string,
    lane: Lane<TInput, TMessage, TTerminal>,
  ): void {
    if (lane.runnable || lane.active || lane.queue.length === 0) return;
    lane.runnable = true;
    this.runnableLaneKeys.push(laneKey);
  }

  private schedule(): void {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      while (
        this.activeCount < this.config.maxActiveExecutions &&
        this.runnableLaneKeys.length > 0
      ) {
        const laneKey = this.runnableLaneKeys.shift()!;
        const lane = this.lanes.get(laneKey);
        if (!lane) continue;
        lane.runnable = false;
        if (lane.active || lane.queue.length === 0) continue;
        const command = lane.queue.shift()!;
        this.queuedCount -= 1;
        const active: ActiveExecution<TInput, TMessage, TTerminal> = {
          command,
          starting: true,
          completed: false,
        };
        lane.active = active;
        this.activeCount += 1;
        void this.startOutsideScheduler(laneKey, lane, active);
      }
    } finally {
      this.scheduling = false;
    }
  }

  private async startOutsideScheduler(
    laneKey: string,
    lane: Lane<TInput, TMessage, TTerminal>,
    active: ActiveExecution<TInput, TMessage, TTerminal>,
  ): Promise<void> {
    const command = active.command;
    try {
      const handle = await this.driver.start(command.input, {
        executionId: command.executionId,
        sessionId: command.sessionId,
        signal: command.abortController.signal,
      });
      if (lane.active !== active || active.completed) {
        handle.cancel("execution no longer owns lane");
        return;
      }
      active.starting = false;
      active.handle = handle;
      this.settle(command, {
        status: "started",
        commandId: command.commandId,
        executionId: command.executionId,
        rootRunId: handle.rootRunId,
      });
      void handle.completion.then(
        () => this.completeActive(laneKey, lane, active),
        () => this.completeActive(laneKey, lane, active),
      );
    } catch (cause) {
      this.settle(command, {
        status: command.abortController.signal.aborted ? "cancelled" : "failed",
        commandId: command.commandId,
        executionId: command.executionId,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      this.completeActive(laneKey, lane, active);
    }
  }

  private completeActive(
    laneKey: string,
    lane: Lane<TInput, TMessage, TTerminal>,
    active: ActiveExecution<TInput, TMessage, TTerminal>,
  ): void {
    if (active.completed) return;
    active.completed = true;
    if (lane.active === active) lane.active = undefined;
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.markRunnable(laneKey, lane);
    this.schedule();
  }

  private settle(
    command: QueuedCommand<TInput>,
    result: ExecutionStartResult,
  ): void {
    if (command.settled) return;
    command.settled = true;
    command.deferred.resolve(result);
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
