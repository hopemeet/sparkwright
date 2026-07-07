import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { atomicWriteText } from "@sparkwright/agent-runtime";
import type {
  CreateJobInput,
  CronJob,
  CronStoreData,
  UpdateJobPatch,
} from "./model.js";
import {
  computeNextRun,
  jobIsDue,
  parseSchedule,
  shouldFastForward,
} from "./schedule.js";

const STORE_FILE = "jobs.json";

export interface CronStoreOptions {
  rootDir: string;
}

export class AmbiguousJobReferenceError extends Error {
  constructor(ref: string) {
    super(`Ambiguous cron job reference: ${ref}`);
    this.name = "AmbiguousJobReferenceError";
  }
}

export class CronStore {
  readonly rootDir: string;
  readonly jobsPath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CronStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.jobsPath = join(this.rootDir, STORE_FILE);
  }

  async listJobs(): Promise<CronJob[]> {
    return (await this.load()).jobs;
  }

  async createJob(input: CreateJobInput, now = new Date()): Promise<CronJob> {
    if (!input.prompt.trim()) throw new Error("prompt must not be empty");
    const parsed = parseSchedule(input.schedule, now);
    return this.withMutation(async (data) => {
      const createdAt = now.toISOString();
      const job: CronJob = {
        id: createJobId(),
        name: uniqueName(
          input.name?.trim() || defaultJobName(input.prompt),
          data.jobs,
        ),
        prompt: input.prompt.trim(),
        schedule: parsed.schedule,
        scheduleDisplay: parsed.display,
        skills: normalizeStringArray(input.skills),
        repeat: {
          times: normalizeRepeatTimes(input.repeat?.times),
          completed: 0,
        },
        state: "scheduled",
        enabled: true,
        nextRunAt: computeNextRun(parsed.schedule, now),
        runningSince: null,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        lastRunId: null,
        lastTracePath: null,
        lastOutputPath: null,
        ...(input.workspace ? { workspace: resolve(input.workspace) } : {}),
        createdAt,
        updatedAt: createdAt,
      };
      data.jobs.push(job);
      return job;
    });
  }

  async updateJob(
    ref: string,
    patch: UpdateJobPatch,
    now = new Date(),
  ): Promise<CronJob> {
    return this.withMutation(async (data) => {
      const job = resolveJobRef(data.jobs, ref);
      if (patch.name !== undefined) job.name = patch.name.trim();
      if (patch.prompt !== undefined) {
        if (!patch.prompt.trim()) throw new Error("prompt must not be empty");
        job.prompt = patch.prompt.trim();
      }
      if (patch.schedule !== undefined) {
        const parsed = parseSchedule(patch.schedule, now);
        job.schedule = parsed.schedule;
        job.scheduleDisplay = parsed.display;
        job.nextRunAt = computeNextRun(parsed.schedule, now);
        if (job.state === "completed" || job.state === "error") {
          job.state = "scheduled";
          job.enabled = true;
          job.runningSince = null;
          job.repeat.completed = 0;
        }
      }
      if (patch.skills !== undefined) {
        job.skills = normalizeStringArray(patch.skills);
      }
      if (patch.repeat !== undefined) {
        job.repeat = {
          times:
            patch.repeat.times === undefined
              ? job.repeat.times
              : normalizeRepeatTimes(patch.repeat.times),
          completed:
            patch.repeat.completed === undefined
              ? job.repeat.completed
              : normalizeCompleted(patch.repeat.completed),
        };
      }
      if (patch.workspace !== undefined) {
        if (patch.workspace === null) delete job.workspace;
        else job.workspace = resolve(patch.workspace);
      }
      job.updatedAt = now.toISOString();
      return job;
    });
  }

  async pauseJob(ref: string, now = new Date()): Promise<CronJob> {
    return this.setEnabled(ref, false, "paused", now);
  }

  async resumeJob(ref: string, now = new Date()): Promise<CronJob> {
    return this.withMutation(async (data) => {
      const job = resolveJobRef(data.jobs, ref);
      job.enabled = true;
      job.state = "scheduled";
      job.runningSince = null;
      if (
        job.repeat.times !== null &&
        job.repeat.completed >= job.repeat.times
      ) {
        job.repeat.completed = 0;
      }
      job.nextRunAt = computeNextRun(job.schedule, now);
      job.updatedAt = now.toISOString();
      return job;
    });
  }

  async removeJob(ref: string): Promise<CronJob> {
    return this.withMutation(async (data) => {
      const job = resolveJobRef(data.jobs, ref);
      data.jobs = data.jobs.filter((candidate) => candidate.id !== job.id);
      return job;
    });
  }

  async getJob(ref: string): Promise<CronJob> {
    return resolveJobRef((await this.load()).jobs, ref);
  }

  async getDueJobs(now = new Date()): Promise<CronJob[]> {
    await this.fastForwardMissedJobs(now);
    const data = await this.load();
    return data.jobs.filter((job) => jobIsDue(job, now));
  }

  async advanceNextRun(id: string, now = new Date()): Promise<CronJob> {
    return this.withMutation(async (data) => {
      const job = resolveJobRef(data.jobs, id);
      if (job.schedule.kind !== "once") {
        job.nextRunAt = computeNextRun(job.schedule, now);
      }
      job.state = "running";
      job.runningSince = now.toISOString();
      job.updatedAt = now.toISOString();
      return job;
    });
  }

  async markJobRun(
    id: string,
    input:
      | {
          ok: true;
          runId?: string;
          tracePath?: string;
          outputPath?: string;
        }
      | {
          ok: false;
          error: string;
          runId?: string;
          tracePath?: string;
          outputPath?: string;
        },
    now = new Date(),
  ): Promise<CronJob | null> {
    return this.withMutation(async (data) => {
      const job = resolveJobRef(data.jobs, id);
      job.lastRunAt = now.toISOString();
      job.lastStatus = input.ok ? "ok" : "error";
      job.lastError = input.ok ? null : input.error;
      job.runningSince = null;
      if (input.runId !== undefined) job.lastRunId = input.runId;
      if (input.tracePath !== undefined) job.lastTracePath = input.tracePath;
      if (input.outputPath !== undefined) job.lastOutputPath = input.outputPath;
      job.repeat.completed += 1;
      if (!input.ok) job.state = "error";
      else if (
        job.schedule.kind === "once" ||
        (job.repeat.times !== null && job.repeat.completed >= job.repeat.times)
      ) {
        job.state = "completed";
        job.enabled = false;
        job.nextRunAt = null;
      } else {
        job.state = "scheduled";
      }
      job.updatedAt = now.toISOString();
      return job;
    });
  }

  async load(): Promise<CronStoreData> {
    try {
      const raw = await readFile(this.jobsPath, "utf8");
      return parseStoreData(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyStore();
      }
      if (error instanceof SyntaxError) {
        const backup = `${this.jobsPath}.corrupt-${Date.now()}`;
        await mkdir(dirname(this.jobsPath), { recursive: true });
        await rename(this.jobsPath, backup);
        throw new Error(`cron store JSON is invalid; moved it to ${backup}`);
      }
      throw error;
    }
  }

  private async fastForwardMissedJobs(now: Date): Promise<void> {
    await this.withMutation(async (data) => {
      for (const job of data.jobs) {
        if (!shouldFastForward(job, now)) continue;
        job.nextRunAt = computeNextRun(job.schedule, now);
        job.updatedAt = now.toISOString();
      }
      return undefined;
    });
  }

  private async setEnabled(
    ref: string,
    enabled: boolean,
    state: CronJob["state"],
    now: Date,
  ): Promise<CronJob> {
    return this.withMutation(async (data) => {
      const job = resolveJobRef(data.jobs, ref);
      job.enabled = enabled;
      job.state = state;
      job.updatedAt = now.toISOString();
      return job;
    });
  }

  private async withMutation<T>(
    fn: (data: CronStoreData) => Promise<T> | T,
  ): Promise<T> {
    const next = this.queue.then(async () => {
      const data = await this.load();
      const result = await fn(data);
      await this.save(data);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async save(data: CronStoreData): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await chmodIfPossible(this.rootDir, 0o700);
    const json = `${JSON.stringify(data, null, 2)}\n`;
    await atomicWriteText(this.jobsPath, json, { durable: true, mode: 0o600 });
    await chmodIfPossible(this.jobsPath, 0o600);
  }
}

export function resolveJobRef(jobs: readonly CronJob[], ref: string): CronJob {
  const exact = jobs.find((job) => job.id === ref);
  if (exact) return exact;
  const lowered = ref.toLowerCase();
  const matches = jobs.filter((job) => job.name.toLowerCase() === lowered);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new AmbiguousJobReferenceError(ref);
  throw new Error(`cron job not found: ${ref}`);
}

function emptyStore(): CronStoreData {
  return { schemaVersion: "sparkwright-cron.v1", jobs: [] };
}

function parseStoreData(raw: unknown): CronStoreData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cron store must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== "sparkwright-cron.v1" || !Array.isArray(obj.jobs)) {
    throw new Error("unsupported cron store schema");
  }
  return obj as unknown as CronStoreData;
}

function createJobId(): string {
  return randomBytes(6).toString("hex");
}

export function defaultJobName(prompt: string): string {
  return (
    prompt
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 48)
      .replace(/[^\w .-]+/g, "")
      .trim() || "scheduled job"
  );
}

function uniqueName(name: string, jobs: readonly CronJob[]): string {
  const existing = new Set(jobs.map((job) => job.name.toLowerCase()));
  if (!existing.has(name.toLowerCase())) return name;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${name} ${i}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`could not create a unique job name for ${name}`);
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

function normalizeCompleted(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("repeat.completed must be a non-negative integer");
  }
  return value;
}

async function chmodIfPossible(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, mode);
  } catch {
    // Best effort: not all filesystems honor POSIX permissions.
  }
}

export async function removeStoreFileForTests(rootDir: string): Promise<void> {
  await unlink(join(resolve(rootDir), STORE_FILE)).catch(() => undefined);
}
