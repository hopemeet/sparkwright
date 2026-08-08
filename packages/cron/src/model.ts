export type Schedule =
  | { kind: "once"; runAt: string }
  | { kind: "interval"; minutes: number }
  | { kind: "cron"; expr: string };

export type JobState =
  | "scheduled"
  | "paused"
  | "running"
  | "completed"
  | "error";

export type JobStatus = "ok" | "error";

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  schedule: Schedule;
  scheduleDisplay: string;
  skills: string[];
  repeat: { times: number | null; completed: number };
  state: JobState;
  enabled: boolean;
  nextRunAt: string | null;
  runningSince?: string | null;
  lastRunAt: string | null;
  lastStatus: JobStatus | null;
  lastError: string | null;
  lastRunId?: string | null;
  lastTracePath?: string | null;
  lastOutputPath?: string | null;
  workspace?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CronStoreData {
  schemaVersion: "sparkwright-cron.v1";
  jobs: CronJob[];
}

export interface CreateJobInput {
  name?: string;
  prompt: string;
  schedule: string;
  skills?: string[];
  repeat?: { times?: number | null };
  workspace?: string;
}

export interface UpdateJobPatch {
  name?: string;
  prompt?: string;
  schedule?: string;
  skills?: string[];
  repeat?: { times?: number | null; completed?: number };
  workspace?: string | null;
}

export type CronAction =
  | "create"
  | "list"
  | "update"
  | "pause"
  | "resume"
  | "run"
  | "status"
  | "remove";
