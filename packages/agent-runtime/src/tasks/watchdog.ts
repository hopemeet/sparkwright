import type { TaskManager } from "./manager.js";
import type { TaskError, TaskRecord } from "./types.js";

/**
 * Result returned by a host-specific task health probe.
 *
 * @public
 * @stability experimental v0.1
 */
export type TaskHealthProbeResult =
  | { ok: true; metadata?: Record<string, unknown> }
  | { ok: false; error: TaskError; metadata?: Record<string, unknown> };

/**
 * Host hook used by {@link TaskWatchdog}. Implementations usually inspect a
 * PID, container id, remote job id, or durable worker lease stored in metadata.
 *
 * @public
 * @stability experimental v0.1
 */
export type TaskHealthProbe = (
  task: TaskRecord,
) => TaskHealthProbeResult | Promise<TaskHealthProbeResult>;

/**
 * Options accepted by {@link TaskWatchdog}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskWatchdogOptions {
  manager: TaskManager;
  /**
   * Maximum wall-clock runtime before a running task is failed. Undefined means
   * no wall-clock deadline.
   */
  wallTimeoutMs?: number;
  /**
   * Maximum time since last output/progress before the watchdog probes health.
   * Undefined disables idle probing.
   */
  idleTimeoutMs?: number;
  /** Optional liveness probe. Idle tasks are not failed unless this says so. */
  probe?: TaskHealthProbe;
  /** Default interval used by {@link TaskWatchdog.start}. */
  intervalMs?: number;
  now?: () => Date;
}

/**
 * One pass of watchdog activity.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskWatchdogSweepResult {
  checked: number;
  probed: number;
  failed: number;
  errors: Array<{ taskId: string; error: TaskError }>;
}

/**
 * Handle returned by {@link TaskWatchdog.start}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskWatchdogHandle {
  stop(): void;
}

/**
 * Options accepted by {@link recoverRunningTasks}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface RecoverRunningTasksOptions {
  manager: TaskManager;
  probe: TaskHealthProbe;
}

/**
 * Conservative watchdog for background tasks. It only fails tasks on hard
 * evidence: wall-clock timeout, or an idle timeout plus a failed health probe.
 *
 * @public
 * @stability experimental v0.1
 */
export class TaskWatchdog {
  private readonly manager: TaskManager;
  private readonly wallTimeoutMs?: number;
  private readonly idleTimeoutMs?: number;
  private readonly probe?: TaskHealthProbe;
  private readonly intervalMs?: number;
  private readonly now: () => Date;

  constructor(options: TaskWatchdogOptions) {
    this.manager = options.manager;
    this.wallTimeoutMs = validateOptionalMs(
      "wallTimeoutMs",
      options.wallTimeoutMs,
    );
    this.idleTimeoutMs = validateOptionalMs(
      "idleTimeoutMs",
      options.idleTimeoutMs,
    );
    this.probe = options.probe;
    this.intervalMs = validateOptionalMs("intervalMs", options.intervalMs);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Run sweeps at a fixed interval until stopped. Errors are forwarded to the
   * optional callback so one bad probe does not kill the watchdog loop.
   */
  start(
    options: {
      intervalMs?: number;
      onSweep?(result: TaskWatchdogSweepResult): void;
      onError?(cause: unknown): void;
    } = {},
  ): TaskWatchdogHandle {
    const intervalMs = validateOptionalMs(
      "intervalMs",
      options.intervalMs ?? this.intervalMs,
    );
    if (intervalMs === undefined) {
      throw new Error(
        "TaskWatchdog.start requires intervalMs either in the constructor or start options.",
      );
    }
    const timer = setInterval(() => {
      this.sweep()
        .then(options.onSweep)
        .catch(options.onError ?? (() => {}));
    }, intervalMs);
    return {
      stop: () => clearInterval(timer),
    };
  }

  async sweep(): Promise<TaskWatchdogSweepResult> {
    const current = this.now();
    const result: TaskWatchdogSweepResult = {
      checked: 0,
      probed: 0,
      failed: 0,
      errors: [],
    };

    for (const task of this.manager.store.list({ status: "running" })) {
      result.checked += 1;
      const wallError = this.wallTimeoutError(task, current);
      if (wallError) {
        await this.fail(task, wallError, result);
        continue;
      }

      if (!this.shouldProbeIdleTask(task, current)) {
        continue;
      }

      this.manager.store.update(task.id, {
        lastHealthCheckAt: current.toISOString(),
      });
      if (!this.probe) {
        continue;
      }

      result.probed += 1;
      try {
        const probe = await this.probe(task);
        if (!probe.ok) {
          await this.fail(task, probe.error, result);
        }
      } catch (cause) {
        await this.fail(
          task,
          {
            code: "TASK_HEALTH_CHECK_FAILED",
            message: errorMessage(cause),
          },
          result,
        );
      }
    }

    return result;
  }

  private wallTimeoutError(task: TaskRecord, now: Date): TaskError | undefined {
    if (this.wallTimeoutMs === undefined) return undefined;
    const anchor = task.startedAt ?? task.createdAt;
    if (now.getTime() - Date.parse(anchor) <= this.wallTimeoutMs) {
      return undefined;
    }
    return {
      code: "TASK_WALL_TIMEOUT",
      message: `Task exceeded wall timeout of ${this.wallTimeoutMs}ms.`,
      metadata: { wallTimeoutMs: this.wallTimeoutMs },
    };
  }

  private shouldProbeIdleTask(task: TaskRecord, now: Date): boolean {
    if (this.idleTimeoutMs === undefined) return false;
    const anchor = task.lastProgressAt ?? task.lastOutputAt ?? task.startedAt;
    if (!anchor) return false;
    return now.getTime() - Date.parse(anchor) > this.idleTimeoutMs;
  }

  private async fail(
    task: TaskRecord,
    error: TaskError,
    result: TaskWatchdogSweepResult,
  ): Promise<void> {
    const failed = await this.manager.fail(task.id, error);
    if (failed.status === "failed") {
      result.failed += 1;
      result.errors.push({ taskId: String(task.id), error });
    }
  }
}

function validateOptionalMs(
  label: string,
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer when set.`);
  }
  return value;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : "Task health check failed.";
}

/**
 * Probe every currently running task and fail the ones that are no longer
 * alive. Intended for host startup after reopening a durable TaskStore.
 *
 * @public
 * @stability experimental v0.1
 */
export async function recoverRunningTasks(
  options: RecoverRunningTasksOptions,
): Promise<TaskWatchdogSweepResult> {
  const result: TaskWatchdogSweepResult = {
    checked: 0,
    probed: 0,
    failed: 0,
    errors: [],
  };
  for (const task of options.manager.store.list({ status: "running" })) {
    result.checked += 1;
    result.probed += 1;
    try {
      const probe = await options.probe(task);
      options.manager.store.update(task.id, {
        lastHealthCheckAt: new Date().toISOString(),
      });
      if (!probe.ok) {
        const failed = await options.manager.fail(task.id, probe.error);
        if (failed.status === "failed") {
          result.failed += 1;
          result.errors.push({ taskId: String(task.id), error: probe.error });
        }
      }
    } catch (cause) {
      const error: TaskError = {
        code: "TASK_HEALTH_CHECK_FAILED",
        message: errorMessage(cause),
      };
      const failed = await options.manager.fail(task.id, error);
      if (failed.status === "failed") {
        result.failed += 1;
        result.errors.push({ taskId: String(task.id), error });
      }
    }
  }
  return result;
}

/**
 * Minimal PID-based liveness probe. Reads `task.metadata.pid` and checks it
 * with `process.kill(pid, 0)`.
 *
 * @public
 * @stability experimental v0.1
 */
export const pidTaskHealthProbe: TaskHealthProbe = (task) => {
  const pid = task.metadata.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return {
      ok: false,
      error: {
        code: "TASK_PROCESS_MISSING",
        message: "Task metadata does not contain a valid pid.",
      },
    };
  }
  try {
    process.kill(pid, 0);
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: {
        code: "TASK_PROCESS_MISSING",
        message: `Process ${pid} no longer exists.`,
        metadata: { pid },
      },
    };
  }
};
