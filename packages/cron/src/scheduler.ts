import { join } from "node:path";
import type { CronJob } from "./model.js";
import { withFileLock } from "./lock.js";
import { runCronJob, type RunCronJobOptions } from "./runner.js";
import { CronStore } from "./store.js";
import { legacyConfigCronRoot } from "./paths.js";

export interface CronSchedulerOptions extends Omit<
  RunCronJobOptions,
  "rootDir"
> {
  rootDir: string;
  store?: CronStore;
  now?: Date;
}

export interface CronTickResult {
  attempted: number;
  completed: number;
  skippedBecauseLocked: boolean;
  /** @reserved Public scheduler-tick field consumed by cron diagnostics. */
  skippedBecauseJobLocked?: number;
}

export async function tickCron(
  options: CronSchedulerOptions,
): Promise<CronTickResult> {
  const lockPath = join(options.rootDir, "tick.lock");
  const result = await withFileLock(lockPath, async () => {
    const store =
      options.store ??
      new CronStore({
        rootDir: options.rootDir,
        legacyRootDir: legacyConfigCronRoot(),
      });
    const now = options.now ?? new Date();
    const due = await store.getDueJobs(now);
    let completed = 0;
    let skippedBecauseJobLocked = 0;
    for (const job of due) {
      const result = await executeCronJob(store, job, options, now);
      if (result.skippedBecauseLocked) skippedBecauseJobLocked += 1;
      else completed += 1;
    }
    return {
      attempted: due.length,
      completed,
      skippedBecauseLocked: false,
      skippedBecauseJobLocked,
    };
  });
  return result ?? { attempted: 0, completed: 0, skippedBecauseLocked: true };
}

export async function runCronJobByRef(
  ref: string,
  options: CronSchedulerOptions,
): Promise<{ job: CronJob; result: Awaited<ReturnType<typeof runCronJob>> }> {
  const store =
    options.store ??
    new CronStore({
      rootDir: options.rootDir,
      legacyRootDir: legacyConfigCronRoot(),
    });
  const job = await store.getJob(ref);
  const now = options.now ?? new Date();
  const result = await executeCronJob(store, job, options, now);
  return { job, result: result.result };
}

async function executeCronJob(
  store: CronStore,
  job: CronJob,
  options: CronSchedulerOptions,
  now: Date,
): Promise<{
  result: Awaited<ReturnType<typeof runCronJob>>;
  skippedBecauseLocked: boolean;
}> {
  const lockPath = join(options.rootDir, "jobs", `${job.id}.lock`);
  const locked = await withFileLock(lockPath, async () => {
    await store.advanceNextRun(job.id, now);
    try {
      const result = await runCronJob(job, options);
      await store.markJobRun(
        job.id,
        result.ok
          ? {
              ok: true,
              runId: result.runId,
              tracePath: result.tracePath,
              outputPath: result.outputPath,
            }
          : {
              ok: false,
              error: result.message,
              runId: result.runId,
              tracePath: result.tracePath,
              outputPath: result.outputPath,
            },
        now,
      );
      return { result, skippedBecauseLocked: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.markJobRun(job.id, { ok: false, error: message }, now);
      return {
        result: {
          ok: false,
          message,
          silent: false,
        },
        skippedBecauseLocked: false,
      };
    }
  });
  if (locked) return locked;
  return {
    result: {
      ok: false,
      message: `cron job is already running: ${job.id}`,
      silent: true,
    },
    skippedBecauseLocked: true,
  };
}
