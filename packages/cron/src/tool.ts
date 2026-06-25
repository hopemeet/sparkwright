import { defineTool } from "@sparkwright/core";
import type { CronAction, CreateJobInput, UpdateJobPatch } from "./model.js";
import { CronStore } from "./store.js";

export interface CreateCronToolOptions {
  rootDir: string;
}

export function createCronTool(options: CreateCronToolOptions) {
  const store = new CronStore({
    rootDir: options.rootDir,
  });
  return defineTool({
    name: "cron",
    description:
      "Create, list, inspect, update, pause, resume, run, or remove scheduled SparkWright cron jobs. Jobs run in fresh sessions; the cron tool is disabled inside scheduled runs.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "list",
            "update",
            "pause",
            "resume",
            "run",
            "status",
            "remove",
          ],
        },
        ref: {
          type: "string",
          description:
            "Job id or exact job name for update/pause/resume/run/remove.",
        },
        job: {
          type: "object",
          description:
            "Create payload: prompt, schedule, and optional name, skills, repeat, workspace.",
          additionalProperties: true,
        },
        patch: {
          type: "object",
          description:
            "Update payload. Supports name, prompt, schedule, skills, repeat, workspace.",
          additionalProperties: true,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    async execute(args: unknown) {
      const input = parseCronToolInput(args);
      switch (input.action) {
        case "create":
          if (!input.job)
            throw toolArgumentsInvalid("cron.create requires job");
          return store.createJob(input.job);
        case "list":
          return { jobs: await store.listJobs() };
        case "update":
          if (!input.ref || !input.patch)
            throw toolArgumentsInvalid("cron.update requires ref and patch");
          return store.updateJob(input.ref, input.patch);
        case "pause":
          if (!input.ref) throw toolArgumentsInvalid("cron.pause requires ref");
          return store.pauseJob(input.ref);
        case "resume":
          if (!input.ref)
            throw toolArgumentsInvalid("cron.resume requires ref");
          return store.resumeJob(input.ref);
        case "remove":
          if (!input.ref)
            throw toolArgumentsInvalid("cron.remove requires ref");
          return store.removeJob(input.ref);
        case "status":
          if (!input.ref)
            throw toolArgumentsInvalid("cron.status requires ref");
          return store.getJob(input.ref);
        case "run":
          throw new Error(
            "cron.run is available from the CLI (`sparkwright cron run <ref>`) so scheduled runs do not recursively start from an active agent session.",
          );
        default:
          throw toolArgumentsInvalid(
            `unknown cron action: ${(input as { action?: string }).action}`,
          );
      }
    },
  });
}

function parseCronToolInput(args: unknown): {
  action: CronAction;
  ref?: string;
  job?: CreateJobInput;
  patch?: UpdateJobPatch;
} {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw toolArgumentsInvalid("cron expects an object argument.");
  }
  const record = args as Record<string, unknown>;
  if (typeof record.action !== "string") {
    throw toolArgumentsInvalid("cron action must be a string.");
  }
  return {
    action: record.action as CronAction,
    ...(typeof record.ref === "string" ? { ref: record.ref } : {}),
    ...(isRecord(record.job)
      ? { job: record.job as unknown as CreateJobInput }
      : {}),
    ...(isRecord(record.patch)
      ? { patch: record.patch as unknown as UpdateJobPatch }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolArgumentsInvalid(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "TOOL_ARGUMENTS_INVALID" });
}
