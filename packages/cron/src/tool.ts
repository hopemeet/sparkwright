import { defineTool } from "@sparkwright/core";
import type { CronAction, CreateJobInput, UpdateJobPatch } from "./model.js";
import { CronStore } from "./store.js";
import { legacyConfigCronRoot } from "./paths.js";

export interface CreateCronToolOptions {
  rootDir: string;
}

export function createCronTool(options: CreateCronToolOptions) {
  const store = new CronStore({
    rootDir: options.rootDir,
    legacyRootDir: legacyConfigCronRoot(),
  });
  return defineTool({
    name: "cron",
    description:
      "Create, list, update, pause, resume, run, or remove scheduled SparkWright cron jobs. Jobs run in fresh sessions; the cron tool is disabled inside scheduled runs.",
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
            "Create payload: prompt, schedule, and optional name, skills, repeat, deliver, workspace.",
          additionalProperties: true,
        },
        patch: {
          type: "object",
          description:
            "Update payload. Supports name, prompt, schedule, skills, repeat, deliver, workspace.",
          additionalProperties: true,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    async execute(args: unknown) {
      const input = args as {
        action: CronAction;
        ref?: string;
        job?: CreateJobInput;
        patch?: UpdateJobPatch;
      };
      switch (input.action) {
        case "create":
          if (!input.job) throw new Error("cron.create requires job");
          return store.createJob(input.job);
        case "list":
          return { jobs: await store.listJobs() };
        case "update":
          if (!input.ref || !input.patch)
            throw new Error("cron.update requires ref and patch");
          return store.updateJob(input.ref, input.patch);
        case "pause":
          if (!input.ref) throw new Error("cron.pause requires ref");
          return store.pauseJob(input.ref);
        case "resume":
          if (!input.ref) throw new Error("cron.resume requires ref");
          return store.resumeJob(input.ref);
        case "remove":
          if (!input.ref) throw new Error("cron.remove requires ref");
          return store.removeJob(input.ref);
        case "run":
          throw new Error(
            "cron.run is available from the CLI (`sparkwright cron run <ref>`) so scheduled runs do not recursively start from an active agent session.",
          );
        default:
          throw new Error(
            `unknown cron action: ${(input as { action?: string }).action}`,
          );
      }
    },
  });
}
