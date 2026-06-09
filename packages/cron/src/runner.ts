import { join } from "node:path";
import {
  createDefaultPromptInspector,
  createPermissionModePolicy,
  createRun,
  createSessionFileRunStoreFactory,
  LocalWorkspace,
  wrapPromptBuilderWithInspector,
  type ApprovalResolver,
  type ModelAdapter,
  type PermissionMode,
  type ToolDefinition,
} from "@sparkwright/core";
import { buildAgentPromptBuilder } from "@sparkwright/project-context";
import { assembleCronPrompt } from "./prompt.js";
import type { CronJob } from "./model.js";
import { writeJobOutput } from "./output.js";

export interface RunCronJobOptions {
  rootDir: string;
  model: ModelAdapter;
  tools?: ToolDefinition[];
  approvalResolver?: ApprovalResolver;
  permissionMode?: PermissionMode;
  skillRoots?: string[];
  now?: Date;
}

export interface RunCronJobResult {
  ok: boolean;
  message: string;
  outputPath?: string;
  runId?: string;
  tracePath?: string;
  silent: boolean;
}

export async function runCronJob(
  job: CronJob,
  options: RunCronJobOptions,
): Promise<RunCronJobResult> {
  const now = options.now ?? new Date();
  const goal = await assembleCronPrompt(job, {
    skillRoots: options.skillRoots,
    now,
  });
  const workspaceRoot = job.workspace ?? process.cwd();
  const sessionRootDir = join(workspaceRoot, ".sparkwright", "sessions");
  const promptBuilder = wrapPromptBuilderWithInspector(
    buildAgentPromptBuilder({
      cwd: workspaceRoot,
      appPrompt:
        "You are the SparkWright cron agent. You run scheduled jobs in fresh sessions and report only the useful result.",
      platform: process.platform,
    }),
    createDefaultPromptInspector({ name: "cron_prompt_inspector" }),
    { onWarn: "pass" },
  );

  const run = createRun({
    goal,
    workspace: new LocalWorkspace(workspaceRoot),
    approvalResolver: options.approvalResolver ?? denyApprovals,
    policy: createPermissionModePolicy({
      mode: options.permissionMode ?? "default",
    }),
    promptBuilder,
    tools: (options.tools ?? []).filter((tool) => tool.name !== "cron"),
    model: options.model,
    runStore: createSessionFileRunStoreFactory({
      sessionRootDir,
      sessionId: `cron-${job.id}`,
      agentId: "cron",
      traceLevel: "standard",
    }),
  });

  const result = await run.start();
  const message = result.message ?? result.failure?.message ?? "";
  const tracePath = join(sessionRootDir, `cron-${job.id}`, "trace.jsonl");
  const silent = message.trimStart().startsWith("[SILENT]");
  const ok = result.state === "completed";
  const output =
    ok && message.trim().length > 0
      ? await writeJobOutput({
          rootDir: options.rootDir,
          jobId: job.id,
          content: message,
          at: now,
          runId: run.record.id,
        })
      : undefined;

  return {
    ok,
    message,
    outputPath: output?.path,
    runId: run.record.id,
    tracePath,
    silent,
  };
}

const denyApprovals: ApprovalResolver = (request) =>
  Promise.resolve({ approvalId: request.id, decision: "denied" });
