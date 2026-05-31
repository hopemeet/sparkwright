import { join } from "node:path";
import type { CronJob } from "./model.js";
import { withFileLock } from "./lock.js";
import { runCronJob, type RunCronJobOptions } from "./runner.js";
import { CronStore } from "./store.js";

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
}

export async function tickCron(
  options: CronSchedulerOptions,
): Promise<CronTickResult> {
  const lockPath = join(options.rootDir, "tick.lock");
  const result = await withFileLock(lockPath, async () => {
    const store = options.store ?? new CronStore({ rootDir: options.rootDir });
    const now = options.now ?? new Date();
    const due = await store.getDueJobs(now);
    let completed = 0;
    for (const job of due) {
      await processDueJob(store, job, options, now);
      completed += 1;
    }
    return { attempted: due.length, completed, skippedBecauseLocked: false };
  });
  return result ?? { attempted: 0, completed: 0, skippedBecauseLocked: true };
}

export async function runCronJobByRef(
  ref: string,
  options: CronSchedulerOptions,
): Promise<{ job: CronJob; result: Awaited<ReturnType<typeof runCronJob>> }> {
  const store = options.store ?? new CronStore({ rootDir: options.rootDir });
  const job = await store.getJob(ref);
  const now = options.now ?? new Date();
  await store.advanceNextRun(job.id, now);
  const result = await runCronJob(job, options);
  await store.markJobRun(
    job.id,
    result.ok ? { ok: true } : { ok: false, error: result.message },
    now,
  );
  return { job, result };
}

async function processDueJob(
  store: CronStore,
  job: CronJob,
  options: CronSchedulerOptions,
  now: Date,
): Promise<void> {
  await store.advanceNextRun(job.id, now);
  try {
    const result = await runCronJob(job, options);
    await store.markJobRun(
      job.id,
      result.ok ? { ok: true } : { ok: false, error: result.message },
      now,
    );
  } catch (error) {
    await store.markJobRun(job.id, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
