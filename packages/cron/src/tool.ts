import { defineTool } from "@sparkwright/core";
import type { CreateJobInput, UpdateJobPatch } from "./model.js";
import { CronCommandService } from "./service.js";

export interface CreateCronToolOptions {
  rootDir: string;
}

export function createCronTool(options: CreateCronToolOptions) {
  return defineTool({
    name: "cron",
    description:
      "Create, list, status/inspect, update, pause, resume, or remove scheduled SparkWright cron jobs. Jobs run in fresh sessions; starting cron runs is only available from the CLI.",
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
            "status",
            "inspect",
            "remove",
          ],
        },
        ref: {
          type: "string",
          description:
            "Job id or exact job name for update/pause/resume/status/inspect/remove.",
        },
        job: createJobSchema,
        patch: updatePatchSchema,
      },
      required: ["action"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    governance: {
      origin: { kind: "local", name: "@sparkwright/cron" },
      sideEffects: ["read", "external"],
      idempotency: "conditional",
    },
    policyForArgs(args) {
      return cronToolPolicyForArgs(args);
    },
    isReplaySafe: false,
    isReadOnly(args) {
      const action = actionFromUnknown(args);
      return action !== undefined && isReadAction(action);
    },
    isDestructive(args) {
      const action = actionFromUnknown(args);
      return action === "remove";
    },
    previewArgs(args) {
      const action = actionFromUnknown(args);
      if (!action) return undefined;
      if (action === "create" && isRecord(args)) {
        const job = args.job;
        if (isRecord(job) && typeof job.name === "string") {
          return `create ${job.name}`;
        }
      }
      if (isRecord(args) && typeof args.ref === "string") {
        return `${action} ${args.ref}`;
      }
      return action;
    },
    async execute(args: unknown, ctx) {
      const input = parseCronToolInput(args);
      const service = new CronCommandService({
        rootDir: options.rootDir,
        mutationReporter:
          input.action === "list" || input.action === "status"
            ? undefined
            : ctx,
      });
      switch (input.action) {
        case "create":
          return service.createJob(input.job, {
            conflictPolicy: "idempotent",
          });
        case "list":
          return service.listJobs();
        case "update":
          return service.updateJob(input.ref, input.patch);
        case "pause":
          return service.pauseJob(input.ref);
        case "resume":
          return service.resumeJob(input.ref);
        case "remove":
          return service.removeJob(input.ref);
        case "status":
          return service.statusJob(input.ref);
      }
    },
  });
}

const repeatSchema = {
  type: "object",
  properties: {
    times: {
      anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
      description:
        "Number of successful runs before completion; null means forever.",
    },
  },
  additionalProperties: false,
};

const createJobSchema = {
  type: "object",
  description:
    "Create payload. schedule must be a string such as 'every 1h', '30m', an ISO timestamp, or a five-field cron expression.",
  properties: {
    name: { type: "string" },
    prompt: { type: "string" },
    schedule: { type: "string" },
    skills: { type: "array", items: { type: "string" } },
    repeat: repeatSchema,
    workspace: { type: "string" },
  },
  required: ["prompt", "schedule"],
  additionalProperties: false,
};

const updatePatchSchema = {
  type: "object",
  description:
    "Update payload. schedule must be a string such as 'every 1h', '30m', an ISO timestamp, or a five-field cron expression.",
  properties: {
    name: { type: "string" },
    prompt: { type: "string" },
    schedule: { type: "string" },
    skills: { type: "array", items: { type: "string" } },
    repeat: repeatSchema,
    workspace: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  additionalProperties: false,
};

type CronToolAction =
  | "create"
  | "list"
  | "update"
  | "pause"
  | "resume"
  | "status"
  | "remove";

function parseCronToolInput(args: unknown): {
  action: CronToolAction;
  ref: string;
  job: CreateJobInput;
  patch: UpdateJobPatch;
} {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw toolArgumentsInvalid("cron expects an object argument.");
  }
  const record = args as Record<string, unknown>;
  if (typeof record.action !== "string") {
    throw toolArgumentsInvalid("cron action must be a string.");
  }
  const action = normalizeAction(record.action);
  switch (action) {
    case "create":
      return {
        action,
        ref: "",
        job: parseCreateJob(record.job),
        patch: {},
      };
    case "list":
      return { action, ref: "", job: emptyCreateJob(), patch: {} };
    case "update":
      return {
        action,
        ref: requiredRef(record.ref, "cron.update"),
        job: emptyCreateJob(),
        patch: parseUpdatePatch(record.patch),
      };
    case "pause":
    case "resume":
    case "remove":
    case "status":
      return {
        action,
        ref: requiredRef(record.ref, `cron.${action}`),
        job: emptyCreateJob(),
        patch: {},
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAction(action: string): CronToolAction {
  switch (action) {
    case "create":
    case "list":
    case "update":
    case "pause":
    case "resume":
    case "status":
    case "remove":
      return action;
    case "inspect":
      return "status";
    case "run":
      throw toolArgumentsInvalid(
        "cron.run is available from the CLI (`sparkwright cron run <ref>`) and is not exposed as an in-session cron tool action.",
      );
    default:
      throw toolArgumentsInvalid(`unknown cron action: ${action}`);
  }
}

function parseCreateJob(value: unknown): CreateJobInput {
  if (!isRecord(value)) throw toolArgumentsInvalid("cron.create requires job.");
  assertAllowedKeys(value, "cron.create.job", [
    "name",
    "prompt",
    "schedule",
    "skills",
    "repeat",
    "workspace",
  ]);
  const prompt = requiredString(value.prompt, "cron.create.job.prompt");
  const schedule = requiredString(value.schedule, "cron.create.job.schedule");
  return {
    prompt,
    schedule,
    ...(value.name !== undefined
      ? { name: requiredString(value.name, "cron.create.job.name") }
      : {}),
    ...(value.skills !== undefined
      ? { skills: stringArray(value.skills, "cron.create.job.skills") }
      : {}),
    ...(value.repeat !== undefined
      ? { repeat: parseRepeat(value.repeat, "cron.create.job.repeat") }
      : {}),
    ...(value.workspace !== undefined
      ? {
          workspace: requiredString(
            value.workspace,
            "cron.create.job.workspace",
          ),
        }
      : {}),
  };
}

function parseUpdatePatch(value: unknown): UpdateJobPatch {
  if (!isRecord(value)) {
    throw toolArgumentsInvalid("cron.update requires patch.");
  }
  assertAllowedKeys(value, "cron.update.patch", [
    "name",
    "prompt",
    "schedule",
    "skills",
    "repeat",
    "workspace",
  ]);
  const patch: UpdateJobPatch = {};
  if (value.name !== undefined) {
    patch.name = requiredString(value.name, "cron.update.patch.name");
  }
  if (value.prompt !== undefined) {
    patch.prompt = requiredString(value.prompt, "cron.update.patch.prompt");
  }
  if (value.schedule !== undefined) {
    patch.schedule = requiredString(
      value.schedule,
      "cron.update.patch.schedule",
    );
  }
  if (value.skills !== undefined) {
    patch.skills = stringArray(value.skills, "cron.update.patch.skills");
  }
  if (value.repeat !== undefined) {
    patch.repeat = parseRepeat(value.repeat, "cron.update.patch.repeat");
  }
  if (value.workspace !== undefined) {
    patch.workspace =
      value.workspace === null
        ? null
        : requiredString(value.workspace, "cron.update.patch.workspace");
  }
  if (Object.keys(patch).length === 0) {
    throw toolArgumentsInvalid(
      "cron.update requires at least one patch field.",
    );
  }
  return patch;
}

function parseRepeat(value: unknown, path: string): { times?: number | null } {
  if (!isRecord(value))
    throw toolArgumentsInvalid(`${path} must be an object.`);
  assertAllowedKeys(value, path, ["times"]);
  if (value.times === undefined) return {};
  if (value.times === null) return { times: null };
  if (
    typeof value.times !== "number" ||
    !Number.isSafeInteger(value.times) ||
    value.times <= 0
  ) {
    throw toolArgumentsInvalid(
      `${path}.times must be a positive integer or null.`,
    );
  }
  return { times: value.times };
}

function requiredRef(value: unknown, label: string): string {
  return requiredString(value, `${label}.ref`);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw toolArgumentsInvalid(`${path} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw toolArgumentsInvalid(`${path} must be an array of strings.`);
  }
  return value;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw toolArgumentsInvalid(
      `${path} has unsupported field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`,
    );
  }
}

function emptyCreateJob(): CreateJobInput {
  return { prompt: "", schedule: "" };
}

function actionFromUnknown(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.action !== "string") return undefined;
  return value.action === "inspect" ? "status" : value.action;
}

function isReadAction(action: string): boolean {
  return action === "list" || action === "status" || action === "inspect";
}

function cronToolPolicyForArgs(args: unknown) {
  const action = actionFromUnknown(args);
  if (action && isReadAction(action)) {
    return {
      policy: { risk: "safe" as const },
      governance: {
        origin: { kind: "local" as const, name: "@sparkwright/cron" },
        sideEffects: ["read" as const],
        idempotency: "idempotent" as const,
      },
    };
  }
  return {
    policy: { risk: "risky" as const, requiresApproval: true },
    governance: {
      origin: { kind: "local" as const, name: "@sparkwright/cron" },
      sideEffects: ["read" as const, "external" as const],
      idempotency:
        action === "create"
          ? ("conditional" as const)
          : ("non_idempotent" as const),
    },
  };
}

function toolArgumentsInvalid(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "TOOL_ARGUMENTS_INVALID" });
}
