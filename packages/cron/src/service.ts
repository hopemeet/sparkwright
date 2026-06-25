import { resolve } from "node:path";
import type {
  CapabilityMutationEvent,
  RuntimeContext,
} from "@sparkwright/core";
import type { CreateJobInput, CronJob, UpdateJobPatch } from "./model.js";
import { parseSchedule } from "./schedule.js";
import { CronStore, defaultJobName } from "./store.js";

export type CronCreateConflictPolicy = "unique" | "idempotent";

export interface CronCommandServiceOptions {
  rootDir: string;
  store?: CronStore;
  mutationReporter?: Pick<RuntimeContext, "reportCapabilityMutationCompleted">;
}

export interface CronCommandOptions {
  now?: Date;
}

export interface CronCreateOptions extends CronCommandOptions {
  conflictPolicy?: CronCreateConflictPolicy;
}

export interface CronCreateResult {
  action: "create";
  changed: boolean;
  status: "created" | "already_exists";
  job: CronJob;
}

export interface CronMutationResult {
  action: "update" | "pause" | "resume" | "remove";
  changed: boolean;
  job: CronJob;
}

export interface CronStatusResult {
  action: "status";
  changed: false;
  job: CronJob;
}

export interface CronListResult {
  action: "list";
  changed: false;
  jobs: CronJob[];
}

export type CronCommandResult =
  | CronCreateResult
  | CronMutationResult
  | CronStatusResult
  | CronListResult;

export class CronCommandService {
  readonly rootDir: string;
  readonly store: CronStore;
  private readonly mutationReporter:
    | Pick<RuntimeContext, "reportCapabilityMutationCompleted">
    | undefined;

  constructor(options: CronCommandServiceOptions) {
    this.rootDir = options.rootDir;
    this.store = options.store ?? new CronStore({ rootDir: options.rootDir });
    this.mutationReporter = options.mutationReporter;
  }

  async listJobs(): Promise<CronListResult> {
    return {
      action: "list",
      changed: false,
      jobs: await this.store.listJobs(),
    };
  }

  async createJob(
    input: CreateJobInput,
    options: CronCreateOptions = {},
  ): Promise<CronCreateResult> {
    const now = options.now ?? new Date();
    const conflictPolicy = options.conflictPolicy ?? "unique";
    const normalized = normalizeCreateInput(input, now);
    if (conflictPolicy === "idempotent") {
      const existing = (await this.store.listJobs()).find(
        (job) => job.name.toLowerCase() === normalized.name.toLowerCase(),
      );
      if (existing) {
        if (jobMatchesCreateInput(existing, normalized)) {
          return {
            action: "create",
            changed: false,
            status: "already_exists",
            job: existing,
          };
        }
        throw new Error(
          `cron job already exists with different config: ${existing.name}`,
        );
      }
    }

    const job = await this.store.createJob(input, now);
    this.reportMutation("cron.create", job, `Create cron job ${job.name}`);
    return { action: "create", changed: true, status: "created", job };
  }

  async updateJob(
    ref: string,
    patch: UpdateJobPatch,
    options: CronCommandOptions = {},
  ): Promise<CronMutationResult> {
    const job = await this.store.updateJob(ref, patch, options.now);
    this.reportMutation("cron.update", job, `Update cron job ${job.name}`);
    return { action: "update", changed: true, job };
  }

  async pauseJob(
    ref: string,
    options: CronCommandOptions = {},
  ): Promise<CronMutationResult> {
    const job = await this.store.pauseJob(ref, options.now ?? new Date());
    this.reportMutation("cron.pause", job, `Pause cron job ${job.name}`);
    return { action: "pause", changed: true, job };
  }

  async resumeJob(
    ref: string,
    options: CronCommandOptions = {},
  ): Promise<CronMutationResult> {
    const job = await this.store.resumeJob(ref, options.now ?? new Date());
    this.reportMutation("cron.resume", job, `Resume cron job ${job.name}`);
    return { action: "resume", changed: true, job };
  }

  async removeJob(ref: string): Promise<CronMutationResult> {
    const job = await this.store.removeJob(ref);
    this.reportMutation("cron.remove", job, `Remove cron job ${job.name}`);
    return { action: "remove", changed: true, job };
  }

  async statusJob(ref: string): Promise<CronStatusResult> {
    return {
      action: "status",
      changed: false,
      job: await this.store.getJob(ref),
    };
  }

  private reportMutation(
    action: CapabilityMutationEvent["action"],
    job: CronJob,
    reason: string,
  ): void {
    this.mutationReporter?.reportCapabilityMutationCompleted?.({
      action,
      path: this.store.jobsPath,
      reason,
      fileCount: 1,
      files: [{ relativePath: "jobs.json" }],
      metadata: {
        kind: "cron",
        jobId: job.id,
        jobName: job.name,
        state: job.state,
        enabled: job.enabled,
      },
    });
  }
}

interface NormalizedCreateInput {
  name: string;
  prompt: string;
  scheduleDisplay: string;
  skills: string[];
  repeatTimes: number | null;
  workspace?: string;
}

function normalizeCreateInput(
  input: CreateJobInput,
  now: Date,
): NormalizedCreateInput {
  const parsed = parseSchedule(input.schedule, now);
  const prompt = input.prompt.trim();
  return {
    name: input.name?.trim() || defaultJobName(prompt),
    prompt,
    scheduleDisplay: parsed.display,
    skills: normalizeStringArray(input.skills),
    repeatTimes: normalizeRepeatTimes(input.repeat?.times),
    ...(input.workspace ? { workspace: resolve(input.workspace) } : {}),
  };
}

function jobMatchesCreateInput(
  job: CronJob,
  input: NormalizedCreateInput,
): boolean {
  return (
    job.prompt === input.prompt &&
    job.scheduleDisplay === input.scheduleDisplay &&
    arraysEqual(job.skills, input.skills) &&
    job.repeat.times === input.repeatTimes &&
    (job.workspace ?? undefined) === input.workspace
  );
}

function normalizeStringArray(value: readonly string[] | undefined): string[] {
  return [...new Set((value ?? []).map((v) => v.trim()).filter(Boolean))];
}

function normalizeRepeatTimes(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("repeat.times must be a positive integer or null");
  }
  return value;
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
