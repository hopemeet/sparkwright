import { join } from "node:path";
import {
  analyzeToolOutcomes,
  completedRunOutcomeFromEvents,
  createDefaultPromptInspector,
  createPermissionModePolicy,
  createRun,
  createSessionFileRunStoreFactory,
  LocalWorkspace,
  wrapPromptBuilderWithInspector,
  type ApprovalResolver,
  type ClassifiedToolFailure,
  type CompletedRunOutcome,
  type ModelAdapter,
  type PermissionMode,
  type SparkwrightEvent,
  type ToolDefinition,
} from "@sparkwright/core";
import { buildAgentPromptBuilder } from "@sparkwright/project-context";
import { assembleCronPrompt } from "./prompt.js";
import type { CronJob } from "./model.js";
import { writeJobOutput } from "./output.js";

export interface RunCronJobOptions {
  rootDir: string;
  model?: ModelAdapter;
  modelFactory?: (job: CronJob) => ModelAdapter | Promise<ModelAdapter>;
  tools?: ToolDefinition[];
  approvalResolver?: ApprovalResolver;
  permissionMode?: PermissionMode;
  skillRoots?: string[];
  /**
   * Fallback workspace for jobs that do not carry their own `job.workspace`.
   * The CLI threads its `--workspace` here so a job without a stored workspace
   * runs (and writes its session/trace) under the caller's workspace instead of
   * the process cwd. A job-level workspace still wins.
   */
  workspaceRoot?: string;
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
  const workspaceRoot = job.workspace ?? options.workspaceRoot ?? process.cwd();
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
  const model = options.modelFactory
    ? await options.modelFactory(job)
    : options.model;
  if (!model) {
    throw new Error("cron run requires a model adapter or modelFactory.");
  }

  const run = createRun({
    goal,
    workspace: new LocalWorkspace(workspaceRoot),
    approvalResolver: options.approvalResolver ?? denyApprovals,
    policy: createPermissionModePolicy({
      mode: options.permissionMode ?? "default",
    }),
    promptBuilder,
    tools: (options.tools ?? []).filter((tool) => tool.name !== "cron"),
    model,
    runStore: createSessionFileRunStoreFactory({
      sessionRootDir,
      sessionId: `cron-${job.id}`,
      agentId: "cron",
      traceLevel: "standard",
    }),
  });

  const result = await run.start();
  const message = result.message ?? result.failure?.message ?? "";
  const verdict = cronRunVerdict({
    state: result.state,
    message,
    events: run.events.all(),
  });
  const tracePath = join(sessionRootDir, `cron-${job.id}`, "trace.jsonl");
  const silent = verdict.message.trimStart().startsWith("[SILENT]");
  const ok = verdict.ok;
  const output =
    ok && verdict.message.trim().length > 0
      ? await writeJobOutput({
          rootDir: options.rootDir,
          jobId: job.id,
          content: verdict.message,
          at: now,
          runId: run.record.id,
        })
      : undefined;

  return {
    ok,
    message: verdict.message,
    outputPath: output?.path,
    runId: run.record.id,
    tracePath,
    silent,
  };
}

const denyApprovals: ApprovalResolver = (request) =>
  Promise.resolve({ approvalId: request.id, decision: "denied" });

function cronRunVerdict(input: {
  state: string;
  message: string;
  events: readonly SparkwrightEvent[];
}): { ok: boolean; message: string } {
  if (input.state !== "completed") {
    return { ok: false, message: input.message };
  }

  const outcome = completedRunOutcomeFromEvents(input.events, input.message);
  if (outcome?.failing) {
    return {
      ok: false,
      message: formatFailingOutcome(outcome),
    };
  }

  const denials = analyzeToolOutcomes(input.events).policyDenials;
  if (denials.length > 0) {
    return {
      ok: false,
      message: formatPolicyDenials(denials),
    };
  }

  return { ok: true, message: input.message };
}

function formatFailingOutcome(outcome: CompletedRunOutcome): string {
  const details = [
    outcome.toolFailures
      ? `${outcome.toolFailures.count} unresolved tool failure${plural(
          outcome.toolFailures.count,
        )}${formatCodes(outcome.toolFailures.codes)}`
      : undefined,
    outcome.commandFailures
      ? `${outcome.commandFailures.count} unresolved verification command failure${plural(
          outcome.commandFailures.count,
        )}${formatLastCommand(outcome.commandFailures.lastCommand)}`
      : undefined,
    outcome.verificationProfileFailures
      ? `${outcome.verificationProfileFailures.count} verification profile failure${plural(
          outcome.verificationProfileFailures.count,
        )}${formatLastId(outcome.verificationProfileFailures.lastId)}`
      : undefined,
  ].filter((detail): detail is string => Boolean(detail));
  const suffix = details.length > 0 ? `: ${details.join("; ")}` : "";
  return `cron run completed with failing outcome (${outcome.kind})${suffix}.`;
}

function formatPolicyDenials(
  denials: readonly ClassifiedToolFailure[],
): string {
  const codes = [
    ...new Set(
      denials
        .map((failure) => failure.code)
        .filter((code): code is string => Boolean(code)),
    ),
  ];
  const toolNames = [
    ...new Set(
      denials
        .map((failure) => failure.toolName)
        .filter((toolName): toolName is string => Boolean(toolName)),
    ),
  ];
  const toolSuffix =
    toolNames.length > 0 ? ` from ${toolNames.slice(0, 3).join(", ")}` : "";
  return `cron run encountered ${denials.length} approval/policy denial${plural(
    denials.length,
  )}${toolSuffix}${formatCodes(codes)}; unattended job did not complete.`;
}

function formatCodes(codes: readonly string[]): string {
  return codes.length > 0 ? ` (${codes.slice(0, 3).join(", ")})` : "";
}

function formatLastCommand(command: string | undefined): string {
  return command ? `; last command: ${command}` : "";
}

function formatLastId(id: string | undefined): string {
  return id ? `; last id: ${id}` : "";
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}
