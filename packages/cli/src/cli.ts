import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FileTaskStore,
  FileWorkflowStore,
  FileWorkflowWorkerRegistry,
  FileWorkflowControlInbox,
  FileWorkflowChannelStore,
  type TaskId,
  type TaskOutputChunk,
  type TaskRecord,
  type TaskStatus,
  type WorkflowRunId,
} from "@sparkwright/agent-runtime";
import {
  asSessionId,
  createSessionId,
  createContextItemId,
  createRunId,
  compileRunAccessMode,
  clampAccessMode,
  isRunAccessMode,
  ACCESS_MODES,
  type BackgroundTaskPolicy,
  type RunAccessMode,
  type RunRecord,
  type ContextItem,
} from "@sparkwright/core";
import {
  isTraceLevel,
  type RunInputPayload,
  type TraceLevel,
  type WorkflowRunSnapshot,
} from "@sparkwright/protocol";
import { EventLog, FileRunStore } from "@sparkwright/core/internal";
import {
  CronCommandService,
  CronStore,
  defaultCronRoot,
  runCronJobByRef,
  tickCron,
  type CronJob,
  type CreateJobInput,
  type UpdateJobPatch,
} from "@sparkwright/cron";
import { type SkillGuardFinding, type SkillRoot } from "@sparkwright/skills";
import {
  SkillCommandService,
  loadLayeredSkillReport,
  collectSkillReviewDigest,
  collectSkillStats,
  collectAssetStats,
  dismissSkillSuggestion,
  createSkillCreateProposal,
  createSkillUpdateProposal,
  listSkillHistory,
  listSkillProposals,
  pruneSkillProposals,
  readSkillHistoryDetail,
  readSkillProposal,
  rejectSkillProposal,
  restoreSkillFromHistory,
  runSkillDoctor,
  importSkill,
  readSkillRegistry,
  reconcileSkill,
  scanSkillReconciliation,
  supersedeSkillProposal,
  loadLayeredAgentReport,
  loadLayeredWorkflowAssets,
  loadHostConfig,
  createWorkflowJobSessionId,
  MAX_RUN_IMAGE_INPUT_BYTES,
  SUPPORTED_RUN_IMAGE_INPUT_TYPES,
  buildImageRunInputPart,
  formatToolUseSelectorList,
  createRunInputPayloadFromParts,
  isToolUseSelector,
  projectConfigCandidatePaths,
  readConfigFileObject,
  resolveConfigWriteTarget,
  delegateToolName,
  summarizeRunInputParts,
  distillWorkflowFromSession,
  shadowWorkflowFromSession,
  existingSkillRoots,
  HostRuntime,
  createHostService,
  createHostStartRunRequest,
  resolveSkillRootsForRuntime,
  userConfigCandidatePaths,
  userConfigPath,
  validateRunInput,
  writeConfigFileObject,
  type AgentReport,
  type ApplySkillProposalResult,
  type SkillDoctorReport,
  type SkillHistoryEntry,
  type SkillHistoryDetail,
  type SkillProposalDetail,
  type SkillProposalState,
  type SkillProposalSummary,
  type PruneSkillProposalsResult,
  type RestoreSkillFromHistoryResult,
  type SkillReport,
  type SkillReviewDigest,
  type SkillStatsReport,
  type WorkflowAssetDetail,
  type WorkflowAssetReport,
  type WorkflowDistillReport,
  type WorkflowShadowReport,
} from "@sparkwright/host";
import {
  FileWorkflowServiceStore,
  WorkflowServiceCarrier,
  WorkflowSupervisor,
  type WorkflowServiceHandoff,
} from "@sparkwright/server-runtime";
import { createCliInteractionChannel } from "./cli-approval.js";
import type { CliIO } from "./io.js";
import { writeLine } from "./io.js";
import type { CliRunAccess } from "./run-access.js";
import {
  createCliModel,
  createConfiguredCliTools,
  startDirectCoreRun,
} from "./runners/direct-core-runner.js";
import { resumeHostWorkflowRun, startHostRun } from "./runners/host-runner.js";
import type { CliRunResult, ParsedArgs } from "./commands/contracts.js";
export type { CliRunResult } from "./commands/contracts.js";
import {
  handleRunResumeCommand,
  handleSessionCommand,
  handleSessionResumeCommand,
  handleTraceCommand,
} from "./commands/trace-session.js";
import {
  PROJECT_CONFIG_DEFERRED_TOOLS,
  capabilitiesUsage,
  delegatesUsage,
  formatAgentOrigin,
  formatPatternList,
  handleCapabilitiesCommand,
  handleDelegatesCommand,
} from "./commands/capabilities.js";
import {
  defaultTaskRoot,
  preferredProjectConfigPathForWorkspace,
  preferredUserConfigPath,
  projectConfigPathForWorkspace,
} from "./commands/config-paths.js";
import {
  configUsage,
  doctorUsage,
  findConfigSchemaDir,
  handleConfigCommand,
  handleDoctorCommand,
} from "./commands/config-doctor.js";
import {
  parseNonNegativeInteger,
  parsePositiveInteger,
} from "./parser/numbers.js";
import {
  isPlainObject,
  splitCliWords,
  stringArrayOrUndefined,
} from "./parser/values.js";

export type { CliIO } from "./io.js";

const cliHostService = createHostService();

export async function runCli(
  argv: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    io?: CliIO;
  } = {},
): Promise<CliRunResult> {
  const io = options.io ?? {};
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const helpText = helpForArgs(argv, env);
  if (helpText) {
    writeLine(io.stdout, helpText);
    return { exitCode: 0 };
  }

  if (isVersionArg(argv[0])) {
    writeLine(io.stdout, cliPackageVersion());
    return { exitCode: 0 };
  }

  if (argv[0] === "init") {
    return handleInitCommand(io, env, argv.slice(1), cwd);
  }

  // Shared config (model/providers/etc.) is read once here so the CLI and the
  // host configure from the same effective workspace. We cannot wait for the
  // full parser because config itself may provide default workspace/model
  // values, but an explicit --workspace must decide which project config layer
  // participates in the merge.
  const cfg = await loadHostConfig(workspaceBootstrapRoot(argv, cwd), env);
  for (const e of cfg.errors) {
    writeLine(io.stderr, `config: ${e.file}: ${e.field}: ${e.message}`);
  }
  for (const warning of cfg.warnings) {
    writeLine(
      io.stderr,
      `config warning: ${warning.file}: ${warning.field}: ${warning.message}`,
    );
  }

  const parsed = parseArgs(argv, cwd, {
    model: cfg.config.model,
    accessMode: cfg.config.accessMode,
    accessModeCeiling: cfg.config.accessModeCeiling,
    backgroundTasks: cfg.config.backgroundTasks,
    backgroundTasksCeiling: cfg.config.backgroundTasksCeiling,
    workspace: cfg.config.workspace,
    confidentialDefaults: cfg.config.confidentialDefaults,
    confidentialPaths: cfg.config.confidentialPaths,
    traceLevel: cfg.config.traceLevel,
  });

  if (!parsed.ok) {
    writeLine(io.stderr, parsed.message);
    return { exitCode: 1 };
  }
  if (parsed.value.directCore && !directCoreEnabled(env)) {
    writeLine(
      io.stderr,
      "--direct-core is an internal diagnostics option. Set SPARKWRIGHT_ENABLE_DIRECT_CORE=1 to use it.",
    );
    return { exitCode: 1 };
  }
  if (parsed.value.directCore && parsed.value.workflowName) {
    writeLine(
      io.stderr,
      "--workflow is only supported on the host runtime path; remove --direct-core.",
    );
    return { exitCode: 1 };
  }
  const { command } = parsed.value;

  if (command === "trace") {
    return handleTraceCommand(parsed.value, io);
  }

  if (command === "session") {
    if (parsed.value.subcommand === "resume") {
      return handleSessionResumeCommand(parsed.value, io, env);
    }
    return handleSessionCommand(parsed.value, io, cliHostService);
  }

  if (command === "run" && parsed.value.subcommand === "resume") {
    return handleRunResumeCommand(parsed.value, io, env);
  }

  if (command === "cron") {
    return handleCronCommand(parsed.value, io, env);
  }

  if (command === "tools") {
    return handleToolsCommand(parsed.value, io, env);
  }

  if (command === "tasks") {
    return handleTasksCommand(parsed.value, io);
  }

  if (command === "workflow") {
    return handleWorkflowCommand(parsed.value, io, env);
  }

  if (command === "capabilities") {
    return handleCapabilitiesCommand(parsed.value, io, env, cliHostService);
  }

  if (command === "delegates") {
    return handleDelegatesCommand(parsed.value, io, env);
  }

  if (command === "skills") {
    return handleSkillsCommand(parsed.value, io, env);
  }

  if (command === "agents") {
    return handleAgentsCommand(parsed.value, io, env);
  }

  if (command === "config") {
    return handleConfigCommand(parsed.value, io, env);
  }

  if (command === "doctor") {
    return handleDoctorCommand(parsed.value, io, env);
  }

  const { goal } = parsed.value;
  if (command === "run" && !goal) {
    writeLine(
      io.stderr,
      'Usage: sparkwright run requires a non-empty goal, e.g. sparkwright run "inspect this repo".',
    );
    return { exitCode: 1 };
  }
  if (command !== "run") {
    writeLine(io.stderr, usage(env));
    return { exitCode: 1 };
  }

  const firstRunScaffold = await maybeScaffoldFirstRunUserConfig({
    cfg,
    env,
    io,
  });
  if (firstRunScaffold) return firstRunScaffold;

  maybePrintFirstRunConfigHint({
    cfg,
    cwd: parsed.value.workspaceRoot,
    env,
    io,
  });

  const controlSessionId = parsed.value.workflowName
    ? parsed.value.sessionId
    : undefined;
  const sessionId = parsed.value.workflowName
    ? createWorkflowJobSessionId()
    : (parsed.value.sessionId ?? createSessionId());
  const runInput = { ...parsed.value, sessionId, controlSessionId };
  const validation = await validateCliRunInput(runInput, io, env);
  if (!validation.ok) {
    const tracePath = writeValidationFailureTrace(runInput, validation);
    if (tracePath)
      writeLine(io.stdout, `Validation trace written to ${tracePath}`);
    return { exitCode: 1, tracePath, sessionId };
  }
  const loadedInput = loadCliRunInput(runInput.imagePaths, cwd);
  if (!loadedInput.ok) {
    writeLine(io.stderr, loadedInput.message);
    return { exitCode: 1, sessionId };
  }

  return parsed.value.directCore
    ? startDirectCoreRun(
        {
          ...runInput,
          policyTargetPath:
            runInput.targetPathSource === "cli"
              ? runInput.targetPath
              : undefined,
          contextItems: contextItemsForCliInput(
            runInput.goal,
            loadedInput.input,
          ),
        },
        io,
        env,
      )
    : startHostRun(
        {
          ...runInput,
          controlSessionId: runInput.controlSessionId,
          modelName:
            runInput.modelNameSource === "cli" ? runInput.modelName : undefined,
          workflowName: runInput.workflowName,
          targetPath:
            runInput.targetPathSource === "cli"
              ? runInput.targetPath
              : undefined,
          input: loadedInput.input,
        },
        io,
        env,
      );
}

export async function scaffoldFirstRunUserConfigIfMissing(input: {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  io: CliIO;
}): Promise<CliRunResult | undefined> {
  const cfg = await loadHostConfig(
    workspaceBootstrapRoot(input.argv, input.cwd),
    input.env,
  );
  return maybeScaffoldFirstRunUserConfig({
    cfg,
    env: input.env,
    io: input.io,
  });
}

function directCoreEnabled(env: Record<string, string | undefined>): boolean {
  return env.SPARKWRIGHT_ENABLE_DIRECT_CORE === "1";
}

function loadCliRunInput(
  imagePaths: readonly string[],
  cwd: string,
): { ok: true; input?: RunInputPayload } | { ok: false; message: string } {
  if (imagePaths.length === 0) return { ok: true };
  const parts: NonNullable<RunInputPayload["parts"]> = [];
  for (const imagePath of imagePaths) {
    const resolved = resolve(cwd, imagePath);
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolved);
    } catch (error) {
      return {
        ok: false,
        message: `Could not read image ${imagePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const imagePart = buildImageRunInputPart({
      sourcePath: imagePath,
      resolvedPath: resolved,
      bytes,
    });
    if (!imagePart.ok && imagePart.reason === "too_large") {
      return {
        ok: false,
        message: `Image is too large (${imagePart.byteLength} bytes): ${imagePath}. Limit is ${MAX_RUN_IMAGE_INPUT_BYTES} bytes.`,
      };
    }
    if (!imagePart.ok) {
      return {
        ok: false,
        message: `Unsupported image type for ${imagePath}. Use ${SUPPORTED_RUN_IMAGE_INPUT_TYPES}.`,
      };
    }
    parts.push(imagePart.part);
  }

  return {
    ok: true,
    input: createRunInputPayloadFromParts(parts),
  };
}

function contextItemsForCliInput(
  goal: string,
  input: RunInputPayload | undefined,
): ContextItem[] {
  const parts = input?.parts ?? [];
  if (parts.length === 0) return [];
  return [
    {
      id: createContextItemId(),
      type: "user",
      source: { kind: "user_input", uri: "cli.run" },
      content: `User request attachments for: ${goal}`,
      parts,
      metadata: {
        layer: "runtime",
        stability: "turn",
        multimodal: true,
        ...summarizeRunInputParts(parts),
      },
    },
  ];
}

function maybePrintFirstRunConfigHint(input: {
  cfg: Awaited<ReturnType<typeof loadHostConfig>>;
  cwd: string;
  env: Record<string, string | undefined>;
  io: CliIO;
}): void {
  if (input.io.stdinIsTTY !== true) return;
  if (input.cfg.errors.length > 0) return;
  if (input.cfg.attempted.some((entry) => entry.loaded)) return;

  const user = preferredUserConfigPath(input.env);
  const project = preferredProjectConfigPathForWorkspace(input.cwd);
  writeLine(
    input.io.stderr,
    [
      "No Sparkwright config found yet.",
      ...(user ? [`User config: ${user}`] : []),
      ...(project ? [`Project config: ${project}`] : []),
      "Create one with `sparkwright init` or `sparkwright init --project`.",
      "Inspect config with `sparkwright config inspect --format text`.",
    ].join("\n"),
  );
}

async function maybeScaffoldFirstRunUserConfig(input: {
  cfg: Awaited<ReturnType<typeof loadHostConfig>>;
  env: Record<string, string | undefined>;
  io: CliIO;
}): Promise<CliRunResult | undefined> {
  if (input.io.stdinIsTTY !== true) return undefined;
  if (input.cfg.errors.length > 0) return undefined;
  if (input.cfg.attempted.some((entry) => entry.loaded)) return undefined;

  try {
    const result = await createUserConfigTemplateFile(input.env);
    if (result.status !== "created") return undefined;
    writeLine(
      input.io.stderr,
      [
        "No Sparkwright config found yet.",
        `Created user config: ${result.path}`,
        'Next: set "identity.providers.openai.apiKey" or export OPENAI_API_KEY, then rerun your command.',
        "For repo-specific settings later, run `sparkwright init --project` inside that workspace.",
        "Inspect config with `sparkwright config inspect --format text`.",
      ].join("\n"),
    );
    return { exitCode: 0 };
  } catch (error) {
    writeLine(
      input.io.stderr,
      [
        "No Sparkwright config found yet.",
        `Failed to create user config: ${error instanceof Error ? error.message : String(error)}`,
        "Create one manually with `sparkwright init`.",
      ].join("\n"),
    );
    return { exitCode: 1 };
  }
}

async function validateCliRunInput(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const validation = await validateRunInput({
    workspaceRoot: parsed.workspaceRoot,
    targetPath: parsed.targetPath,
    requireTargetExists: parsed.targetPathSource === "cli",
    modelName: parsed.modelNameSource === "cli" ? parsed.modelName : undefined,
    validateModel: parsed.modelNameSource === "cli",
    env,
  });
  for (const warning of validation.warnings) {
    writeLine(io.stderr, `Warning: ${warning}`);
  }
  for (const error of validation.errors) {
    writeLine(io.stderr, error);
  }
  return validation;
}

function writeValidationFailureTrace(
  parsed: ParsedArgs & { sessionId: string },
  validation: { errors: string[]; warnings: string[] },
): string | undefined {
  if (
    parsed.sessionRootDirSource === "default" &&
    validation.errors.some((error) => error.startsWith("Workspace "))
  ) {
    return undefined;
  }
  try {
    const now = new Date().toISOString();
    const runId = createRunId();
    const run: RunRecord = {
      id: runId,
      goal: parsed.goal,
      state: "failed",
      stopReason: "validation_failed",
      createdAt: now,
      updatedAt: now,
      metadata: {
        source: "cli",
        agentId: "main",
        workspaceRoot: parsed.workspaceRoot,
        targetPath: parsed.targetPath,
      },
    };
    const store = new FileRunStore(run, {
      sessionRootDir: parsed.sessionRootDir,
      sessionId: parsed.sessionId,
      agentId: "main",
      traceLevel: parsed.traceLevel,
    });
    const events = new EventLog(runId);
    const metadata = { sessionId: parsed.sessionId, agentId: "main" };
    store.append(events.emit("run.created", { goal: parsed.goal }, metadata));
    store.append(
      events.emit(
        "validation.failed",
        {
          stage: "input",
          hookName: "run_input",
          result: {
            ok: false,
            findings: validation.errors.map((message) => ({
              severity: "error",
              code: validationCodeForMessage(message),
              message,
            })),
          },
          warnings: validation.warnings,
        },
        metadata,
      ),
    );
    store.append(
      events.emit(
        "run.failed",
        {
          reason: "validation_failed",
          code: "RUN_INPUT_VALIDATION_FAILED",
          message: validation.errors.join("\n"),
        },
        metadata,
      ),
    );
    store.finish(run, {
      signal: "failed",
      state: "failed",
      stopReason: "validation_failed",
      message: validation.errors.join("\n"),
      failure: {
        category: "validation",
        code: "RUN_INPUT_VALIDATION_FAILED",
        message: validation.errors.join("\n"),
      },
      metadata: {},
    });
    return store.tracePath;
  } catch {
    return undefined;
  }
}

function validationCodeForMessage(message: string): string {
  if (message.startsWith("Workspace does not exist"))
    return "WORKSPACE_NOT_FOUND";
  if (message.startsWith("Workspace is not a directory"))
    return "WORKSPACE_NOT_DIRECTORY";
  if (message.startsWith("Target does not exist")) return "TARGET_NOT_FOUND";
  if (message.startsWith("Target is not a file")) return "TARGET_NOT_FILE";
  if (message.startsWith("Target must stay inside"))
    return "TARGET_OUTSIDE_WORKSPACE";
  if (message.startsWith("Target must be a workspace-relative"))
    return "TARGET_NOT_RELATIVE";
  if (message.startsWith("Target path must not be empty"))
    return "TARGET_EMPTY";
  return "RUN_INPUT_INVALID";
}

interface ConfigDefaults {
  model?: string;
  accessMode?: RunAccessMode;
  accessModeCeiling?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  backgroundTasksCeiling?: BackgroundTaskPolicy;
  workspace?: string;
  confidentialPaths?: string[];
  confidentialDefaults?: boolean;
  traceLevel?: TraceLevel;
}

function workspaceBootstrapRoot(argv: string[], cwd: string): string {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--workspace") continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) return cwd;
    return value;
  }
  return cwd;
}

function parseArgs(
  argv: string[],
  cwd: string,
  defaults: ConfigDefaults = {},
): { ok: true; value: ParsedArgs } | { ok: false; message: string } {
  const args = [...argv];
  const knownCommands = new Set([
    "run",
    "trace",
    "session",
    "cron",
    "tools",
    "tasks",
    "workflow",
    "capabilities",
    "delegates",
    "skills",
    "agents",
    "config",
    "doctor",
  ]);
  const command = knownCommands.has(args[0] ?? "")
    ? (args.shift() ?? "run")
    : "run";
  let subcommand: string | undefined;
  if (
    command === "trace" ||
    command === "session" ||
    command === "cron" ||
    command === "tools" ||
    command === "tasks" ||
    command === "workflow" ||
    command === "capabilities" ||
    command === "delegates" ||
    command === "skills" ||
    command === "agents" ||
    command === "config" ||
    command === "doctor"
  ) {
    subcommand = args.shift();
  } else if (command === "run" && args[0] === "resume") {
    // `sparkwright run resume <run-id>` — distinct from the freeform
    // `sparkwright run "<goal>"` path.
    subcommand = args.shift();
  }
  let traceLevel: TraceLevel = defaults.traceLevel ?? "standard";
  let workspaceRoot = defaults.workspace ?? cwd;
  let workspaceRootSource: ParsedArgs["workspaceRootSource"] =
    defaults.workspace ? "config" : "default";
  let sessionRootDir: string | undefined;
  let sessionRootDirSource: ParsedArgs["sessionRootDirSource"] = "default";
  let targetPath = "README.md";
  let targetPathSource: ParsedArgs["targetPathSource"] = "default";
  const confidentialPaths: string[] = [...(defaults.confidentialPaths ?? [])];
  const confidentialDefaults = defaults.confidentialDefaults ?? true;
  const imagePaths: string[] = [];
  let accessMode: RunAccessMode = defaults.accessMode ?? "read-only";
  const backgroundTasks = defaults.backgroundTasks;
  let modelName: string | undefined = defaults.model;
  let modelNameSource: ParsedArgs["modelNameSource"] = defaults.model
    ? "config"
    : undefined;
  let workflowName: string | undefined;
  let sessionId: string | undefined;
  let format: ParsedArgs["format"] = "json";
  let eventType: string | undefined;
  let runId: string | undefined;
  let skillName: string | undefined;
  let skillKey: string | undefined;
  let packageHash: string | undefined;
  let contains: string | undefined;
  let limit: number | undefined;
  let afterSequence: number | undefined;
  let beforeSequence: number | undefined;
  let jsonl = false;
  let apply = false;
  let force = false;
  let fromTrace = false;
  let directCore = false;
  let verbose = false;
  let resolveMcp = false;
  let llm = false;
  let compaction = false;
  let detach = false;
  let delegateGoal: string | undefined;

  const applyRequestedAccessMode = (requested: RunAccessMode): void => {
    const effective =
      clampAccessMode(defaults.accessModeCeiling, requested) ?? requested;
    accessMode = effective;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--detach") {
      detach = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--trace-level") {
      const value = args[index + 1];
      if (!isTraceLevel(value))
        return {
          ok: false,
          message: "Usage: --trace-level must be one of: standard, debug",
        };
      traceLevel = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--workspace") {
      const value = args[index + 1];
      if (!value)
        return { ok: false, message: "Usage: --workspace requires a path" };
      workspaceRoot = resolve(cwd, value);
      workspaceRootSource = "cli";
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--session-root") {
      const value = args[index + 1];
      if (!value)
        return {
          ok: false,
          message: "Usage: --session-root requires a path",
        };
      sessionRootDir = value;
      sessionRootDirSource = "cli";
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--target") {
      const value = args[index + 1];
      if (!value)
        return {
          ok: false,
          message: "Usage: --target requires a workspace-relative path",
        };
      targetPath = value;
      targetPathSource = "cli";
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--confidential") {
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        return {
          ok: false,
          message:
            "Usage: --confidential requires a workspace-relative path or glob",
        };
      // Repeatable and comma-separated; both append to the confidential set.
      for (const entry of value.split(",")) {
        const trimmed = entry.trim();
        if (trimmed) confidentialPaths.push(trimmed);
      }
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--image") {
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        return {
          ok: false,
          message: "Usage: --image requires a local image path",
        };
      for (const entry of value.split(",")) {
        const trimmed = entry.trim();
        if (trimmed) imagePaths.push(trimmed);
      }
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--access-mode") {
      const value = args[index + 1];
      if (!isRunAccessMode(value)) {
        return {
          ok: false,
          message: `Usage: --access-mode must be one of: ${ACCESS_MODES.join(", ")}`,
        };
      }
      applyRequestedAccessMode(value);
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--model") {
      const value = args[index + 1];
      if (!value)
        return { ok: false, message: "Usage: --model requires a model name" };
      modelName = value;
      modelNameSource = "cli";
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--workflow") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        return { ok: false, message: "Usage: --workflow requires a name" };
      }
      workflowName = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--session-id") {
      const value = args[index + 1];
      if (!value)
        return { ok: false, message: "Usage: --session-id requires an id" };
      try {
        sessionId = asSessionId(value);
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--format") {
      const value = args[index + 1];
      if (value !== "json" && value !== "text") {
        return { ok: false, message: "Usage: --format must be json or text" };
      }
      format = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--llm") {
      llm = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--compaction") {
      compaction = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--type") {
      const value = args[index + 1];
      if (!value)
        return { ok: false, message: "Usage: --type requires a value" };
      eventType = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--run-id") {
      const value = args[index + 1];
      if (!value)
        return { ok: false, message: "Usage: --run-id requires an id" };
      runId = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--skill") {
      const value = args[index + 1];
      if (!value)
        return { ok: false, message: "Usage: --skill requires a name" };
      skillName = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--skill-key") {
      const value = args[index + 1];
      if (!value)
        return { ok: false, message: "Usage: --skill-key requires a key" };
      skillKey = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--package-hash") {
      const value = args[index + 1];
      if (!value)
        return {
          ok: false,
          message: "Usage: --package-hash requires a hash",
        };
      packageHash = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--contains") {
      const value = args[index + 1];
      if (!value)
        return { ok: false, message: "Usage: --contains requires text" };
      contains = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--last") {
      const value = parsePositiveInteger(args[index + 1]);
      if (value === undefined)
        return {
          ok: false,
          message: "Usage: --last requires a positive integer",
        };
      limit = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--limit") {
      const value = parsePositiveInteger(args[index + 1]);
      if (value === undefined)
        return {
          ok: false,
          message: "Usage: --limit requires a positive integer",
        };
      limit = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--after-sequence") {
      const value = parseNonNegativeInteger(args[index + 1]);
      if (value === undefined)
        return {
          ok: false,
          message: "Usage: --after-sequence requires a non-negative integer",
        };
      afterSequence = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--before-sequence") {
      const value = parseNonNegativeInteger(args[index + 1]);
      if (value === undefined)
        return {
          ok: false,
          message: "Usage: --before-sequence requires a non-negative integer",
        };
      beforeSequence = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--jsonl") {
      jsonl = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--apply") {
      apply = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--dry-run") {
      apply = false;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--force") {
      force = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--from-trace") {
      fromTrace = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--direct-core") {
      directCore = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--resolve-mcp") {
      resolveMcp = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--goal") {
      const value = args[index + 1];
      if (!value) return { ok: false, message: "Usage: --goal requires text" };
      delegateGoal = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--session") {
      const value = args[index + 1];
      if (!value)
        return { ok: false, message: "Usage: --session requires a session id" };
      sessionId = value;
      args.splice(index, 2);
      index -= 1;
      continue;
    }
  }

  if (
    command === "run" ||
    command === "delegates" ||
    (command === "session" && subcommand === "resume")
  ) {
    const unknownOption = args.find((arg) => arg.startsWith("--"));
    if (unknownOption) {
      return { ok: false, message: `Unknown option: ${unknownOption}` };
    }
  }

  const target = args[0];

  if (
    command === "trace" &&
    subcommand !== "summary" &&
    subcommand !== "events" &&
    subcommand !== "timeline" &&
    subcommand !== "report" &&
    subcommand !== "verify"
  ) {
    return {
      ok: false,
      message:
        "Usage: sparkwright trace <summary|events|timeline|report|verify> <trace.jsonl>",
    };
  }

  if (
    command === "session" &&
    subcommand !== "summary" &&
    subcommand !== "inspect" &&
    subcommand !== "check" &&
    subcommand !== "repair" &&
    subcommand !== "compact" &&
    subcommand !== "resume"
  ) {
    return {
      ok: false,
      message:
        "Usage: sparkwright session <summary|inspect|check|repair|compact|resume> <session-id> [goal] [--workspace path] [--session-root path] [--model provider/model] [--llm] [--compaction]",
    };
  }

  if (
    command === "tools" &&
    subcommand !== "allow" &&
    subcommand !== "disable" &&
    subcommand !== "defer"
  ) {
    return {
      ok: false,
      message: "Usage: sparkwright tools <allow|disable|defer> <tool-name ...>",
    };
  }

  if (
    command === "tasks" &&
    subcommand !== "list" &&
    subcommand !== "get" &&
    subcommand !== "output"
  ) {
    return {
      ok: false,
      message:
        "Usage: sparkwright tasks <list|get|output> [task-id] [--workspace path] [--root-dir path] [--status status] [--kind kind]",
    };
  }

  if (
    command === "workflow" &&
    subcommand !== "list" &&
    subcommand !== "start" &&
    subcommand !== "service" &&
    subcommand !== "stop" &&
    subcommand !== "inspect" &&
    subcommand !== "resume" &&
    subcommand !== "distill" &&
    subcommand !== "shadow" &&
    subcommand !== "stats"
  ) {
    return {
      ok: false,
      message:
        "Usage: sparkwright workflow <list|start|service|stop|inspect|resume|distill|shadow> [workflow-name-or-run-id] [--workspace path] [--format json|text]",
    };
  }

  if (command === "capabilities" && subcommand !== "inspect") {
    return {
      ok: false,
      message:
        "Usage: sparkwright capabilities inspect [--workspace path] [--model provider/model] [--resolve-mcp] [--format json|text]",
    };
  }

  if (command === "delegates" && subcommand !== "run") {
    return {
      ok: false,
      message:
        'Usage: sparkwright delegates run <external-delegate-tool> "goal" [--workspace path] [--access-mode read-only|ask|accept-edits|bypass] [--format json|text]',
    };
  }

  if (
    command === "skills" &&
    subcommand !== "list" &&
    subcommand !== "create" &&
    subcommand !== "validate" &&
    subcommand !== "review" &&
    subcommand !== "stats" &&
    subcommand !== "doctor" &&
    subcommand !== "proposals" &&
    subcommand !== "history" &&
    subcommand !== "restore" &&
    subcommand !== "reconcile"
  ) {
    return {
      ok: false,
      message:
        "Usage: sparkwright skills <list|create|validate|review|stats|doctor|proposals|history|restore> [name] [--description text]",
    };
  }

  if (
    command === "agents" &&
    subcommand !== "list" &&
    subcommand !== "create" &&
    subcommand !== "validate" &&
    subcommand !== "stats"
  ) {
    return {
      ok: false,
      message:
        "Usage: sparkwright agents <list|create|validate|stats> [id] [--prompt text]",
    };
  }

  if (
    command === "config" &&
    subcommand !== "path" &&
    subcommand !== "validate" &&
    subcommand !== "inspect" &&
    subcommand !== "explain" &&
    subcommand !== "example"
  ) {
    return { ok: false, message: configUsage() };
  }

  if (command === "doctor" && subcommand !== "paths") {
    return { ok: false, message: doctorUsage() };
  }

  const goal =
    command === "session" && subcommand === "resume"
      ? args.slice(1).join(" ").trim()
      : command === "run" && subcommand === "resume"
        ? "" // checkpoint supplies the original goal
        : command === "delegates" && subcommand === "run"
          ? (delegateGoal ?? args.slice(1).join(" ").trim())
          : args.join(" ").trim();
  if (command === "run" && subcommand === "resume" && !args[0]) {
    return {
      ok: false,
      message:
        "Usage: sparkwright run resume <run-id> [--session <session-id>] [--workspace path] [--session-root path] [--force] [--from-trace]",
    };
  }
  if (command === "run" && subcommand === "resume") {
    runId = args[0];
  }

  const cronRefCommand =
    command === "cron" &&
    (subcommand === "update" ||
      subcommand === "pause" ||
      subcommand === "resume" ||
      subcommand === "remove" ||
      subcommand === "status" ||
      subcommand === "run");
  const effectiveGoal =
    command === "cron"
      ? (cronRefCommand ? args.slice(1) : args).join("\0")
      : command === "tools" ||
          command === "tasks" ||
          command === "workflow" ||
          command === "capabilities" ||
          command === "delegates" ||
          command === "skills" ||
          command === "agents"
        ? args.join("\0")
        : goal;

  workspaceRoot = resolve(cwd, workspaceRoot);
  const resolvedSessionRootDir =
    sessionRootDir !== undefined
      ? resolve(cwd, sessionRootDir)
      : join(workspaceRoot, ".sparkwright", "sessions");

  const runAccess: CliRunAccess = {
    accessMode,
    backgroundTasks,
  };

  return {
    ok: true,
    value: {
      command,
      subcommand,
      goal: effectiveGoal,
      target,
      traceLevel,
      workspaceRoot,
      workspaceRootSource,
      sessionRootDir: resolvedSessionRootDir,
      sessionRootDirSource,
      targetPath,
      targetPathSource,
      confidentialPaths,
      confidentialDefaults,
      imagePaths,
      accessMode,
      backgroundTasks,
      runAccess,
      modelName,
      modelNameSource,
      workflowName,
      sessionId,
      format,
      eventType,
      runId,
      skillName,
      skillKey,
      packageHash,
      contains,
      limit,
      afterSequence,
      beforeSequence,
      jsonl,
      apply,
      force,
      fromTrace,
      directCore,
      verbose,
      resolveMcp,
      llm,
      compaction,
      detach,
      delegateGoal,
    },
  };
}

async function handleToolsCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  const subcommand = parsed.subcommand;
  if (
    subcommand !== "allow" &&
    subcommand !== "disable" &&
    subcommand !== "defer"
  ) {
    writeLine(io.stderr, toolsUsage());
    return { exitCode: 1 };
  }

  const patterns = splitCliWords(parsed.goal);
  if (patterns.length === 0) {
    writeLine(
      io.stderr,
      `Usage: sparkwright tools ${subcommand} <tool-name...>`,
    );
    return { exitCode: 1 };
  }
  if (patterns.some((pattern) => pattern.includes("*"))) {
    writeLine(
      io.stderr,
      "Wildcard tool patterns are not supported. Use concrete tool names; configure MCP schema loading with capabilities.mcp.toolSchemaLoad.",
    );
    return { exitCode: 1 };
  }

  try {
    const target =
      parsed.workspaceRootSource === "cli"
        ? {
            path: projectConfigPathForWorkspace(parsed.workspaceRoot),
            privateFile: false,
          }
        : { path: userConfigPath(env), privateFile: true };
    const loaded = await readConfigObject(target.path);
    const before = getToolsConfig(loaded.value);

    const next = updateToolsConfig(before, subcommand, patterns);
    setToolsConfig(loaded.value, next);
    await writeConfigObject(loaded.path, loaded.value, {
      privateFile: target.privateFile,
    });
    writeLine(
      io.stdout,
      formatToolsConfig({
        path: loaded.path,
        exists: true,
        tools: next,
        format: parsed.format,
      }),
    );
    return { exitCode: 0 };
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1 };
  }
}

async function handleTasksCommand(
  parsed: ParsedArgs,
  io: CliIO,
): Promise<CliRunResult> {
  const subcommand = parsed.subcommand;
  if (
    subcommand !== "list" &&
    subcommand !== "get" &&
    subcommand !== "output"
  ) {
    writeLine(io.stderr, tasksUsage());
    return { exitCode: 1 };
  }

  const args = parseTaskArgs(parsed.goal);
  if (!args.ok) {
    writeLine(io.stderr, args.message);
    return { exitCode: 1 };
  }

  const rootDir = args.value.rootDir ?? defaultTaskRoot(parsed.workspaceRoot);
  const store = new FileTaskStore({ rootDir, createRoot: false });

  try {
    if (subcommand === "list") {
      const tasks = store.list({
        status: args.value.status,
        kind: args.value.kind,
        parentRunId: parsed.runId,
      });
      writeLine(
        io.stdout,
        formatTaskList({ rootDir, tasks, format: parsed.format }),
      );
      return { exitCode: 0 };
    }

    const taskId = args.value.taskId ?? parsed.target;
    if (!taskId) {
      writeLine(io.stderr, `Usage: sparkwright tasks ${subcommand} <task-id>`);
      return { exitCode: 1 };
    }
    const id = taskId as unknown as TaskId;
    const record = store.get(id);
    if (!record) {
      writeLine(io.stderr, `Task not found: ${taskId}`);
      return { exitCode: 1 };
    }

    if (subcommand === "get") {
      writeLine(io.stdout, JSON.stringify(record, null, 2));
      return { exitCode: 0 };
    }

    const maxChunks = args.value.maxChunks ?? parsed.limit ?? 200;
    const fromSequence = args.value.fromSequence ?? 0;
    const chunks = await readTaskOutput(store, id, {
      fromSequence,
      maxChunks,
    });
    const nextSequence =
      chunks.length > 0
        ? chunks[chunks.length - 1]!.sequence + 1
        : fromSequence;
    writeLine(
      io.stdout,
      JSON.stringify(
        {
          taskId,
          chunks,
          nextSequence,
          complete: isTerminalTaskStatus(record.status),
          status: record.status,
          error: record.error,
          lastOutputAt: record.lastOutputAt,
        },
        null,
        2,
      ),
    );
    return { exitCode: 0 };
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1 };
  }
}

interface TaskParsedArgs {
  rootDir?: string;
  taskId?: string;
  status?: TaskStatus;
  kind?: string;
  fromSequence?: number;
  maxChunks?: number;
}

function parseTaskArgs(
  input: string,
): { ok: true; value: TaskParsedArgs } | { ok: false; message: string } {
  let args: string[];
  try {
    args = input.includes("\0")
      ? input.split("\0").filter(Boolean)
      : splitShellLike(input);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const out: TaskParsedArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--root-dir") {
      if (!next)
        return { ok: false, message: "Usage: --root-dir requires a path" };
      out.rootDir = next;
      i += 1;
    } else if (arg === "--status") {
      if (!isTaskStatus(next)) {
        return {
          ok: false,
          message:
            "Usage: --status must be one of: pending, running, completed, failed, cancelled",
        };
      }
      out.status = next;
      i += 1;
    } else if (arg === "--kind") {
      if (!next) return { ok: false, message: "Usage: --kind requires text" };
      out.kind = next;
      i += 1;
    } else if (arg === "--from-sequence") {
      const value = parseNonNegativeInteger(next);
      if (value === undefined) {
        return {
          ok: false,
          message: "Usage: --from-sequence requires a non-negative integer",
        };
      }
      out.fromSequence = value;
      i += 1;
    } else if (arg === "--max-chunks") {
      const value = parsePositiveInteger(next);
      if (value === undefined) {
        return {
          ok: false,
          message: "Usage: --max-chunks requires a positive integer",
        };
      }
      out.maxChunks = value;
      i += 1;
    } else if (arg?.startsWith("--")) {
      return { ok: false, message: `Unknown tasks option: ${arg}` };
    } else if (!out.taskId) {
      out.taskId = arg;
    } else {
      return { ok: false, message: `Unexpected tasks argument: ${arg}` };
    }
  }
  return { ok: true, value: out };
}

function isTaskStatus(value: string | undefined): value is TaskStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

async function readTaskOutput(
  store: FileTaskStore,
  id: TaskId,
  options: { fromSequence: number; maxChunks: number },
): Promise<TaskOutputChunk[]> {
  const chunks: TaskOutputChunk[] = [];
  for await (const chunk of store.loadOutput(id, options.fromSequence)) {
    chunks.push(chunk);
    if (chunks.length >= options.maxChunks) break;
  }
  return chunks;
}

function formatTaskList(input: {
  rootDir: string;
  tasks: TaskRecord[];
  format: ParsedArgs["format"];
}): string {
  if (input.format === "json") {
    return JSON.stringify(
      {
        rootDir: input.rootDir,
        tasks: input.tasks,
      },
      null,
      2,
    );
  }
  const lines = [`rootDir: ${input.rootDir}`];
  if (input.tasks.length === 0) {
    lines.push("tasks: (none)");
    return lines.join("\n");
  }
  lines.push(`tasks: ${input.tasks.length}`);
  for (const task of input.tasks) {
    lines.push(
      `- ${task.id} ${task.status} ${task.kind}${task.title ? ` (${task.title})` : ""}`,
    );
  }
  return lines.join("\n");
}

async function handleWorkflowCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  const subcommand = parsed.subcommand;
  if (
    subcommand !== "list" &&
    subcommand !== "start" &&
    subcommand !== "service" &&
    subcommand !== "stop" &&
    subcommand !== "inspect" &&
    subcommand !== "resume" &&
    subcommand !== "distill" &&
    subcommand !== "shadow" &&
    subcommand !== "stats"
  ) {
    writeLine(io.stderr, workflowUsage());
    return { exitCode: 1 };
  }

  try {
    if (subcommand === "stats") {
      const report = await collectAssetStats({
        workspaceRoot: parsed.workspaceRoot,
        sessionRootDir: parsed.sessionRootDir,
        artifactKind: "workflow",
      });
      writeLine(
        io.stdout,
        parsed.format === "json"
          ? JSON.stringify(report, null, 2)
          : formatAssetStatsReport(report),
      );
      return { exitCode: report.errors.length > 0 ? 1 : 0 };
    }
    if (subcommand === "service") {
      return handleWorkflowServiceCommand(parsed, io, env);
    }

    if (subcommand === "start") {
      const [workflowName, ...goalParts] = splitCliWords(parsed.goal);
      const goal = goalParts.join(" ").trim();
      if (!workflowName || !goal) {
        writeLine(
          io.stderr,
          "Usage: sparkwright workflow start <workflow-name> <goal...>",
        );
        return { exitCode: 1 };
      }
      if (parsed.detach) {
        return startDetachedWorkflow({
          parsed,
          workflowName,
          goal,
          io,
        });
      }
      return startHostRun(
        {
          goal,
          workspaceRoot: parsed.workspaceRoot,
          sessionRootDir: parsed.sessionRootDir,
          runAccess: parsed.runAccess,
          modelName: parsed.modelName,
          workflowName,
          sessionId: parsed.sessionId ?? `session_${Date.now().toString(36)}`,
          targetPath: parsed.targetPath,
          confidentialPaths: parsed.confidentialPaths,
          confidentialDefaults: parsed.confidentialDefaults,
          traceLevel: parsed.traceLevel,
          input: undefined,
          verbose: parsed.verbose,
        },
        io,
        env,
      );
    }

    if (subcommand === "resume") {
      const workflowRunId = firstCliWord(parsed.goal);
      if (!workflowRunId) {
        writeLine(
          io.stderr,
          "Usage: sparkwright workflow resume <workflow-run-id>",
        );
        return { exitCode: 1 };
      }
      return resumeHostWorkflowRun(
        {
          workflowRunId,
          workspaceRoot: parsed.workspaceRoot,
          sessionRootDir: parsed.sessionRootDir,
          runAccess: parsed.runAccess,
          modelName: parsed.modelName,
          sessionId: parsed.sessionId,
          targetPath: parsed.targetPath,
          confidentialPaths: parsed.confidentialPaths,
          confidentialDefaults: parsed.confidentialDefaults,
          traceLevel: parsed.traceLevel,
          verbose: parsed.verbose,
        },
        io,
        env,
      );
    }

    if (subcommand === "stop") {
      const workflowRunId = firstCliWord(parsed.goal) as WorkflowRunId;
      if (!workflowRunId) {
        writeLine(
          io.stderr,
          "Usage: sparkwright workflow stop <workflow-run-id>",
        );
        return { exitCode: 1 };
      }
      const rootDir = join(
        parsed.workspaceRoot,
        ".sparkwright",
        "workflow-runs",
      );
      const workflowStore = new FileWorkflowStore({
        rootDir,
        createRoot: false,
      });
      const record = workflowStore.get(workflowRunId);
      if (!record) {
        writeLine(io.stderr, `Workflow not found: ${workflowRunId}`);
        return { exitCode: 1 };
      }
      const channels = new FileWorkflowChannelStore({ rootDir });
      const controls = new FileWorkflowControlInbox({ rootDir });
      const now = new Date();
      const source = {
        kind: "cli" as const,
        principalId: process.env.USER ?? "local-user",
        authenticatedBy: "local-cli",
        channelId: `cli-${process.pid}`,
      };
      const binding = await channels.bind({
        bindingId: `workflow_binding_cli_${randomUUID().replaceAll("-", "")}`,
        workspaceId: parsed.workspaceRoot,
        workflowRunId: record.id,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        source,
        allowedCommandKinds: ["cancel"],
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
      });
      const accepted = await channels.acceptControl({
        inbox: controls,
        bindingId: binding.bindingId,
        workflowRunId: record.id,
        workspaceId: parsed.workspaceRoot,
        sessionId: record.sessionId,
        source,
        idempotencyKey: `cli-cancel-${record.id}-${record.generation}`,
        expected: {
          generation: record.generation,
          status: record.status,
          ...(record.wait?.id ? { waitId: record.wait.id } : {}),
        },
        command: { kind: "cancel", reason: "workflow stop" },
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      });
      if (accepted.status === "conflict") {
        writeLine(io.stderr, "Workflow stop idempotency conflict.");
        return { exitCode: 1 };
      }
      const runtime = cliHostService.createRuntime({
        workspaceRoot: parsed.workspaceRoot,
        sessionRootDir: parsed.sessionRootDir,
        emit: () => {},
      });
      const processed = await runtime.processWorkflowControlCommand({
        workflowRunId: record.id,
        sessionId: record.sessionId,
        commandId: accepted.envelope.commandId,
      });
      if (!processed.ok) {
        writeLine(io.stderr, processed.error.message);
        return { exitCode: 1 };
      }
      writeLine(
        io.stdout,
        `Workflow stop ${processed.status}: ${record.id} (${processed.code ?? "accepted"})`,
      );
      return {
        exitCode:
          processed.status === "applied" || processed.status === "accepted"
            ? 0
            : 1,
      };
    }

    if (subcommand === "distill") {
      const sessionId = firstCliWord(parsed.goal);
      if (!sessionId) {
        writeLine(
          io.stderr,
          "Usage: sparkwright workflow distill <session-id>",
        );
        return { exitCode: 1 };
      }
      const report = await distillWorkflowFromSession({
        sessionRootDir: parsed.sessionRootDir,
        sessionId,
      });
      writeLine(
        io.stdout,
        parsed.format === "json"
          ? JSON.stringify(report, null, 2)
          : formatWorkflowDistillReport(report),
      );
      return { exitCode: report.ok ? 0 : 1 };
    }

    if (subcommand === "shadow") {
      const [workflowName, sessionId] = splitCliWords(parsed.goal);
      if (!workflowName || !sessionId) {
        writeLine(
          io.stderr,
          "Usage: sparkwright workflow shadow <workflow-name> <session-id>",
        );
        return { exitCode: 1 };
      }
      const report = await shadowWorkflowFromSession({
        workspaceRoot: parsed.workspaceRoot,
        sessionRootDir: parsed.sessionRootDir,
        workflowName,
        sessionId,
        env,
      });
      writeLine(
        io.stdout,
        parsed.format === "json"
          ? JSON.stringify(report, null, 2)
          : formatWorkflowShadowReport(report),
      );
      return { exitCode: report.ok ? 0 : 1 };
    }

    const report = await loadLayeredWorkflowAssets(parsed.workspaceRoot, env);
    if (subcommand === "list") {
      const runtime = cliHostService.createRuntime({
        workspaceRoot: parsed.workspaceRoot,
        sessionRootDir: parsed.sessionRootDir,
        defaultModel: parsed.modelName,
        defaultAccessMode: parsed.runAccess.accessMode,
        defaultTraceLevel: parsed.traceLevel,
        emit: () => {},
      });
      const listed = await runtime.listWorkflowRuns({
        sessionId: parsed.sessionId,
        limit: parsed.limit,
      });
      if (!listed.ok) {
        writeLine(io.stderr, listed.error.message);
        return { exitCode: 1 };
      }
      writeLine(
        io.stdout,
        parsed.format === "json"
          ? JSON.stringify(
              {
                ...report,
                workflowRuns: listed.workflows,
                invalidWorkflowRunEntries: listed.invalidEntries ?? [],
              },
              null,
              2,
            )
          : formatWorkflowListReport({
              assets: report,
              runs: listed.workflows,
              invalidEntries: listed.invalidEntries ?? [],
            }),
      );
      return {
        exitCode:
          report.errors.length > 0 || (listed.invalidEntries?.length ?? 0) > 0
            ? 1
            : 0,
      };
    }

    const name = firstCliWord(parsed.goal);
    if (!name) {
      writeLine(
        io.stderr,
        "Usage: sparkwright workflow inspect <workflow-name>",
      );
      return { exitCode: 1 };
    }
    const asset = report.assets.find((entry) => entry.assetName === name);
    if (!asset) {
      writeLine(io.stderr, `Workflow not found: ${name}`);
      return { exitCode: 1 };
    }
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(asset, null, 2)
        : formatWorkflowInspectReport(asset),
    );
    return { exitCode: report.errors.length > 0 ? 1 : 0 };
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1 };
  }
}

function workflowServiceRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "workflow-service");
}

async function startDetachedWorkflow(input: {
  parsed: ParsedArgs;
  workflowName: string;
  goal: string;
  io: CliIO;
}): Promise<CliRunResult> {
  const { parsed, workflowName, goal, io } = input;
  const now = new Date();
  const store = new FileWorkflowServiceStore({
    rootDir: workflowServiceRoot(parsed.workspaceRoot),
  });
  const instance = store.readInstance();
  if (
    !instance ||
    instance.state !== "ready" ||
    instance.workspaceId !== parsed.workspaceRoot ||
    Date.parse(instance.expiresAt) <= now.getTime()
  ) {
    writeLine(
      io.stderr,
      "Workflow service is not ready. Run `sparkwright workflow service run --workspace <path>` under a service manager.",
    );
    return { exitCode: 1 };
  }
  const handoffId = `handoff_${randomUUID().replaceAll("-", "")}`;
  const sessionId = createWorkflowJobSessionId();
  await store.publishHandoff({
    handoffId,
    idempotencyKey: handoffId,
    workspaceId: parsed.workspaceRoot,
    workflowName,
    goal,
    jobSessionId: sessionId,
    ...(parsed.sessionId ? { controlSessionId: parsed.sessionId } : {}),
    ...(parsed.modelName ? { modelName: parsed.modelName } : {}),
    accessMode: parsed.accessMode,
    traceLevel: parsed.traceLevel,
    targetPath: parsed.targetPath,
    confidentialPaths: parsed.confidentialPaths,
    confidentialDefaults: parsed.confidentialDefaults,
    source: { kind: "cli", principalId: `pid:${process.pid}` },
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const outcome = store.readOutcome(handoffId);
    if (outcome) {
      if (outcome.status === "accepted") {
        writeLine(
          io.stdout,
          `Workflow detached: ${outcome.workflowRunId ?? "accepted"} session=${outcome.sessionId ?? sessionId}`,
        );
        return { exitCode: 0, sessionId: outcome.sessionId ?? sessionId };
      }
      writeLine(
        io.stderr,
        outcome.message ?? outcome.code ?? "Workflow handoff rejected",
      );
      return { exitCode: 1, sessionId };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  writeLine(
    io.stderr,
    `Workflow service did not accept handoff ${handoffId} before timeout.`,
  );
  return { exitCode: 1, sessionId };
}

async function handleWorkflowServiceCommand(
  parsed: ParsedArgs,
  io: CliIO,
  _env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  const action = firstCliWord(parsed.goal);
  const store = new FileWorkflowServiceStore({
    rootDir: workflowServiceRoot(parsed.workspaceRoot),
  });
  if (action === "status") {
    const instance = store.readInstance();
    const live = Boolean(
      instance &&
      instance.workspaceId === parsed.workspaceRoot &&
      instance.state === "ready" &&
      Date.parse(instance.expiresAt) > Date.now(),
    );
    writeLine(
      io.stdout,
      JSON.stringify({ live, instance: instance ?? null }, null, 2),
    );
    return { exitCode: live ? 0 : 1 };
  }
  if (action === "drain") {
    const instance = store.readInstance();
    if (
      !instance ||
      instance.workspaceId !== parsed.workspaceRoot ||
      Date.parse(instance.expiresAt) <= Date.now()
    ) {
      writeLine(io.stderr, "Workflow service is not live.");
      return { exitCode: 1 };
    }
    await store.requestDrain(instance.instanceId);
    writeLine(
      io.stdout,
      `Workflow service drain requested: ${instance.instanceId}`,
    );
    return { exitCode: 0 };
  }
  if (action !== "run") {
    writeLine(
      io.stderr,
      "Usage: sparkwright workflow service <run|status|drain> [--workspace path]",
    );
    return { exitCode: 1 };
  }
  const instance = await store.acquireInstance({
    workspaceId: parsed.workspaceRoot,
    ttlMs: 5_000,
  });
  if (!instance) {
    writeLine(
      io.stderr,
      "A live workflow service already owns this workspace.",
    );
    return { exitCode: 1 };
  }
  const runtimes = new Map<string, HostRuntime>();
  const adapter = {
    recover: async (handoff: WorkflowServiceHandoff) => {
      const runtime = cliHostService.createRuntime({
        workspaceRoot: parsed.workspaceRoot,
        sessionRootDir: parsed.sessionRootDir,
        emit: () => {},
      });
      const listed = await runtime.listWorkflowRuns({ limit: 10_000 });
      if (!listed.ok) return undefined;
      const found = listed.workflows.find(
        (record) => record.metadata?.serviceHandoffId === handoff.handoffId,
      );
      if (!found) return undefined;
      if (!found.sessionId) {
        throw new Error(
          `Recovered workflow ${found.id} is missing its durable job session.`,
        );
      }
      return { workflowRunId: found.id, sessionId: found.sessionId };
    },
    accept: async (handoff: WorkflowServiceHandoff) => {
      const runtime = cliHostService.createRuntime({
        workspaceRoot: parsed.workspaceRoot,
        sessionRootDir: parsed.sessionRootDir,
        defaultModel: handoff.modelName,
        defaultAccessMode: handoff.accessMode,
        defaultTraceLevel: handoff.traceLevel,
        emit: (event) => {
          if (event.kind === "run.completed" || event.kind === "run.failed") {
            runtimes.delete(handoff.handoffId);
          }
        },
      });
      runtimes.set(handoff.handoffId, runtime);
      const workflowRunId = `workflow_service_${createHash("sha256")
        .update(`${handoff.workspaceId}\0${handoff.handoffId}`)
        .digest("hex")
        .slice(0, 32)}` as WorkflowRunId;
      const started = await runtime.startDetachedWorkflowRun(
        createHostStartRunRequest({
          goal: handoff.goal,
          sessionId: handoff.jobSessionId,
          controlSessionId: handoff.controlSessionId,
          accessMode: handoff.accessMode,
          targetPath: handoff.targetPath,
          traceLevel: handoff.traceLevel,
          modelName: handoff.modelName,
          modelNameSource: "request",
          workflowName: handoff.workflowName,
          confidentialPaths: handoff.confidentialPaths,
          confidentialDefaults: handoff.confidentialDefaults,
          metadata: {
            source: "workflow-service",
            serviceHandoffId: handoff.handoffId,
          },
        }),
        workflowRunId,
      );
      if (!started.ok || !started.workflowRunId) {
        runtimes.delete(handoff.handoffId);
        throw new Error(
          started.ok
            ? "workflow start did not return workflowRunId"
            : started.error.message,
        );
      }
      return {
        workflowRunId: started.workflowRunId,
        sessionId: started.sessionId ?? handoff.jobSessionId,
      };
    },
  };
  const carrier = new WorkflowServiceCarrier({
    store,
    instance,
    adapter,
    maxConcurrent: 4,
  });
  if (!(await carrier.start())) {
    writeLine(
      io.stderr,
      "Workflow service lost its instance lease during startup.",
    );
    return { exitCode: 1 };
  }
  const workflowStore = new FileWorkflowStore({
    rootDir: join(parsed.workspaceRoot, ".sparkwright", "workflow-runs"),
  });
  const workflowControls = new FileWorkflowControlInbox({
    rootDir: join(parsed.workspaceRoot, ".sparkwright", "workflow-runs"),
  });
  const controlRuntimes = new Map<string, HostRuntime>();
  const workerRegistry = new FileWorkflowWorkerRegistry({
    rootDir: join(parsed.workspaceRoot, ".sparkwright", "workflow-workers"),
  });
  const worker = await workerRegistry.register({
    workerId: "workflow-service",
    instanceId: instance.record().instanceId,
    workspaceId: parsed.workspaceRoot,
    ttlMs: 5_000,
  });
  const supervisor = new WorkflowSupervisor({
    store: workflowStore,
    worker,
    maxClaims: 4,
    adapter: {
      runClaimed: async ({ record, writer, signal }) => {
        if (signal.aborted) return "interrupted";
        let resolveTerminal: (() => void) | undefined;
        const terminal = new Promise<void>((resolveDone) => {
          resolveTerminal = resolveDone;
        });
        const runtime = cliHostService.createRuntime({
          workspaceRoot: parsed.workspaceRoot,
          sessionRootDir: parsed.sessionRootDir,
          defaultModel: parsed.modelName,
          defaultAccessMode: parsed.accessMode,
          defaultTraceLevel: parsed.traceLevel,
          emit: (event) => {
            if (event.kind === "run.completed" || event.kind === "run.failed") {
              resolveTerminal?.();
            }
          },
        });
        const resumed = await runtime.resumeClaimedWorkflowRun(
          { workflowRunId: record.id, sessionId: record.sessionId },
          writer,
        );
        if (!resumed.ok) throw new Error(resumed.error.message);
        const abort = () => runtime.cancelRun(resumed.runId);
        signal.addEventListener("abort", abort, { once: true });
        try {
          await terminal;
        } finally {
          signal.removeEventListener("abort", abort);
        }
        const fresh = await writer.readFresh();
        return fresh?.status === "waiting" ? "waiting" : "terminal";
      },
    },
  });
  writeLine(
    io.stdout,
    `Workflow service ready for ${parsed.workspaceRoot} (foreground).`,
  );
  let stopping = false;
  let heartbeatLost = false;
  const heartbeatTimer = setInterval(() => {
    void Promise.all([instance.heartbeat(), supervisor.heartbeat(5_000)])
      .then(([serviceAlive, workerAlive]) => {
        if (!serviceAlive || !workerAlive) heartbeatLost = true;
      })
      .catch(() => {
        heartbeatLost = true;
      });
  }, 1_000);
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (
      !stopping &&
      !heartbeatLost &&
      !store.drainRequested(instance.record().instanceId)
    ) {
      await carrier.runOnce();
      for (const record of workflowStore.list().records) {
        for (const envelope of workflowControls.pending(record.id)) {
          if (controlRuntimes.has(envelope.commandId)) continue;
          const runtime = cliHostService.createRuntime({
            workspaceRoot: parsed.workspaceRoot,
            sessionRootDir: parsed.sessionRootDir,
            defaultModel: parsed.modelName,
            defaultAccessMode: parsed.accessMode,
            defaultTraceLevel: parsed.traceLevel,
            emit: (event) => {
              if (
                event.kind === "run.completed" ||
                event.kind === "run.failed"
              ) {
                controlRuntimes.delete(envelope.commandId);
              }
            },
          });
          const processed =
            await runtime.processAcceptedWorkflowControl(envelope);
          if (processed.ok && processed.runId) {
            controlRuntimes.set(envelope.commandId, runtime);
          }
        }
      }
      await supervisor.runOnce();
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    const drained = await carrier.drain();
    const supervisorDrain = await supervisor.drain({ abort: true });
    if (!drained.drained || !supervisorDrain.drained) {
      writeLine(
        io.stderr,
        `Workflow service interrupted with ${drained.active + supervisorDrain.remainingWorkflowRunIds.length} active workflow(s).`,
      );
    }
    await carrier.stop();
    await supervisor.stop();
    return { exitCode: drained.drained && supervisorDrain.drained ? 0 : 1 };
  } finally {
    clearInterval(heartbeatTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function formatWorkflowListReport(input: {
  assets: WorkflowAssetReport;
  runs: WorkflowRunSnapshot[];
  invalidEntries: Array<{ path: string; code: string; reason: string }>;
}): string {
  const lines = [`workflow runs: ${input.runs.length}`];
  for (const run of input.runs) {
    lines.push(
      `  workflow-run: ${run.id} ${run.status} asset=${run.assetName}${run.currentNodeId ? ` node=${run.currentNodeId}` : ""}${run.sessionId ? ` session=${run.sessionId}` : ""}`,
    );
  }
  for (const invalid of input.invalidEntries) {
    lines.push(
      `  invalid-run: ${invalid.path}: ${invalid.code}: ${invalid.reason}`,
    );
  }
  lines.push(`workflow assets: ${input.assets.assets.length}`);
  for (const root of input.assets.roots) {
    lines.push(
      `  root: ${root.layer} ${root.exists ? "exists" : "missing"} ${root.path}`,
    );
  }
  for (const asset of input.assets.assets) {
    lines.push(
      `  workflow: ${asset.assetName}${asset.version ? ` version=${asset.version}` : ""} nodes=${asset.nodeCount} layer=${asset.layer} source=${asset.sourcePath}`,
    );
  }
  for (const shadow of input.assets.shadows) {
    lines.push(
      `  shadow: ${shadow.assetName} kept=${shadow.keptSource} shadowed=${shadow.shadowedSource}`,
    );
  }
  for (const error of input.assets.errors) {
    lines.push(`  error: ${error.layer} ${error.sourcePath}: ${error.message}`);
  }
  return lines.join("\n");
}

function formatWorkflowInspectReport(asset: WorkflowAssetDetail): string {
  const lines = [
    `workflow: ${asset.assetName}`,
    `source: ${asset.sourcePath}`,
    `layer: ${asset.layer}`,
    `contentHash: ${asset.contentHash}`,
    `version: ${asset.version ?? "(none)"}`,
    `nodes: ${asset.definition.nodes.length}`,
  ];
  if (asset.description) lines.push(`description: ${asset.description}`);
  if (asset.configPath) lines.push(`config: ${asset.configPath}`);
  for (const node of asset.definition.nodes) {
    lines.push(
      `  node: ${node.id} execute=${node.execute ?? "model"} bodyChars=${node.body.length}`,
    );
  }
  return lines.join("\n");
}

function formatWorkflowDistillReport(report: WorkflowDistillReport): string {
  const header = [
    `# Distilled Workflow Draft`,
    `session: ${report.sessionId}`,
    `trace: ${report.tracePath}`,
    `asset: ${report.assetName}`,
    `events: ${report.eventCount}`,
    `status: ${report.ok ? "ok" : "needs-review"}`,
    ...(report.goal ? [`goal: ${report.goal}`] : []),
    ...(report.terminalState ? [`terminal: ${report.terminalState}`] : []),
    ...(report.warnings.length > 0
      ? ["warnings:", ...report.warnings.map((warning) => `- ${warning}`)]
      : []),
    "",
  ];
  return [...header, report.markdown].join("\n");
}

function formatWorkflowShadowReport(report: WorkflowShadowReport): string {
  const lines = [
    `# Workflow Shadow Report`,
    `workflow: ${report.workflowName}`,
    `session: ${report.sessionId}`,
    `trace: ${report.tracePath}`,
    `source: ${report.asset.sourcePath}`,
    `packageHash: ${report.asset.packageHash}`,
    `packageHashPolicyVersion: ${report.asset.packageHashPolicyVersion}`,
    `events: ${report.eventCount}`,
    `status: ${report.ok ? "ok" : "needs-review"}`,
    `checks: matched=${report.summary.matched} missing=${report.summary.missing} unobserved=${report.summary.unobserved}`,
    ...(report.goal ? [`goal: ${report.goal}`] : []),
    ...(report.terminalState ? [`terminal: ${report.terminalState}`] : []),
  ];
  if (report.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  lines.push("coverage:");
  for (const check of report.checks) {
    lines.push(`- ${check.status} ${check.kind} ${check.id}: ${check.message}`);
  }
  return lines.join("\n");
}

function firstCliWord(input: string): string | undefined {
  const args = input.includes("\0")
    ? input.split("\0").filter(Boolean)
    : splitCliWords(input);
  return args[0];
}

type ToolConfigAction = "allow" | "disable" | "defer";

interface ToolsConfigShape {
  use?: string[];
  allowed?: string[];
  disabled?: string[];
  defer?: string[];
}

function updateToolsConfig(
  current: ToolsConfigShape,
  action: ToolConfigAction,
  patterns: string[],
): ToolsConfigShape {
  const next: ToolsConfigShape = {
    use: current.use ? [...current.use] : undefined,
    allowed: current.allowed ? [...current.allowed] : undefined,
    disabled: current.disabled ? [...current.disabled] : undefined,
    defer: current.defer ? [...current.defer] : undefined,
  };
  if (action === "allow") {
    next.allowed = addUnique(next.allowed ?? [], patterns);
  } else if (action === "disable") {
    next.disabled = addUnique(next.disabled ?? [], patterns);
  } else {
    next.defer = addUnique(next.defer ?? [], patterns);
  }
  return pruneEmptyToolConfig(next);
}

function pruneEmptyToolConfig(config: ToolsConfigShape): ToolsConfigShape {
  return {
    ...(config.use !== undefined ? { use: config.use } : {}),
    ...(config.allowed !== undefined ? { allowed: config.allowed } : {}),
    ...(config.disabled && config.disabled.length > 0
      ? { disabled: config.disabled }
      : {}),
    ...(config.defer !== undefined ? { defer: config.defer } : {}),
  };
}

function addUnique(current: string[], additions: string[]): string[] {
  const seen = new Set(current);
  for (const entry of additions) {
    if (!seen.has(entry)) {
      current.push(entry);
      seen.add(entry);
    }
  }
  return current;
}

async function readConfigObject(path: string): Promise<{
  path: string;
  exists: boolean;
  value: Record<string, unknown>;
}> {
  const target = await resolveConfigWriteTarget(path);
  const loaded = await readConfigFileObject(target.path);
  return { path: target.path, exists: loaded.exists, value: loaded.value };
}

async function writeConfigObject(
  path: string,
  value: Record<string, unknown>,
  options: { privateFile?: boolean } = {},
): Promise<void> {
  await writeConfigFileObject(path, value, options);
}

function getToolsConfig(config: Record<string, unknown>): ToolsConfigShape {
  if (isPlainObject(config.tools)) {
    return {
      use: stringArrayOrUndefined(config.tools.use),
      allowed: stringArrayOrUndefined(config.tools.allowed),
      disabled: stringArrayOrUndefined(config.tools.disabled),
      defer: stringArrayOrUndefined(config.tools.defer),
    };
  }
  return {};
}

function setToolsConfig(
  config: Record<string, unknown>,
  tools: ToolsConfigShape,
): void {
  config.tools = { ...tools };
}

function formatToolsConfig(input: {
  path: string;
  exists: boolean;
  tools: ToolsConfigShape;
  format: "json" | "text";
}): string {
  if (input.format === "json") {
    return JSON.stringify(
      {
        path: input.path,
        exists: input.exists,
        tools: input.tools,
      },
      null,
      2,
    );
  }
  return [
    `config: ${input.path}${input.exists ? "" : " (not created yet)"}`,
    `use: ${formatPatternList(input.tools.use, "(all)")}`,
    `allowed: ${formatPatternList(input.tools.allowed, "(all)")}`,
    `disabled: ${formatPatternList(input.tools.disabled, "(none)")}`,
    `defer: ${formatPatternList(input.tools.defer, "(none)")}`,
  ].join("\n");
}

async function handleSkillsCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  const subcommand = parsed.subcommand;
  if (
    subcommand !== "list" &&
    subcommand !== "create" &&
    subcommand !== "validate" &&
    subcommand !== "review" &&
    subcommand !== "stats" &&
    subcommand !== "doctor" &&
    subcommand !== "proposals" &&
    subcommand !== "history" &&
    subcommand !== "restore" &&
    subcommand !== "reconcile"
  ) {
    writeLine(io.stderr, skillsUsage());
    return { exitCode: 1 };
  }

  try {
    if (subcommand === "create") {
      return await handleSkillsCreate(parsed, io);
    }

    if (subcommand === "proposals") {
      return await handleSkillProposalsCommand(parsed, io, env);
    }

    if (subcommand === "history") {
      return await handleSkillHistoryCommand(parsed, io);
    }

    if (subcommand === "restore") {
      return await handleSkillRestoreCommand(parsed, io);
    }

    if (subcommand === "reconcile") {
      return await handleSkillReconcileCommand(parsed, io);
    }

    const roots = await resolveSkillRootsForCli(parsed.workspaceRoot, env);
    if (subcommand === "review") {
      const [reviewAction, suggestionId] = splitCliWords(parsed.goal);
      if (reviewAction === "dismiss") {
        if (!suggestionId) {
          throw new Error("skills review dismiss requires a suggestion id.");
        }
        await dismissSkillSuggestion({
          workspaceRoot: parsed.workspaceRoot,
          suggestionId,
        });
        writeLine(io.stdout, `dismissed suggestion: ${suggestionId}`);
        return { exitCode: 0 };
      }
      const digest = await collectSkillReviewDigest({
        workspaceRoot: parsed.workspaceRoot,
        sessionRootDir: parsed.sessionRootDir,
        skillRoots: roots,
        limit: parsed.limit,
        skillName: parsed.skillName,
        skillKey: parsed.skillKey,
        packageHash: parsed.packageHash,
      });
      if (parsed.format === "json") {
        writeLine(io.stdout, JSON.stringify(digest, null, 2));
      } else {
        writeLine(io.stdout, formatSkillReviewDigest(digest));
      }
      return { exitCode: 0 };
    }

    if (subcommand === "stats") {
      const stats = await collectSkillStats({
        workspaceRoot: parsed.workspaceRoot,
        sessionRootDir: parsed.sessionRootDir,
        skillRoots: roots,
        limit: parsed.limit,
        skillName: parsed.skillName,
        skillKey: parsed.skillKey,
        packageHash: parsed.packageHash,
      });
      if (parsed.format === "json") {
        writeLine(io.stdout, JSON.stringify(stats, null, 2));
      } else {
        writeLine(io.stdout, formatSkillStatsReport(stats));
      }
      return { exitCode: 0 };
    }

    if (subcommand === "doctor") {
      const doctor = await runSkillDoctor({ skillRoots: roots });
      if (parsed.format === "json") {
        writeLine(io.stdout, JSON.stringify(doctor, null, 2));
      } else {
        writeLine(io.stdout, formatSkillDoctorReport(doctor));
      }
      return { exitCode: doctor.status === "blocked" ? 1 : 0 };
    }

    const report = await loadLayeredSkillReport(roots, {
      includeMissingRoots: subcommand === "validate",
    });
    if (parsed.format === "json") {
      writeLine(io.stdout, JSON.stringify(report, null, 2));
    } else {
      writeLine(io.stdout, formatSkillReport(report));
    }
    return {
      exitCode: subcommand === "validate" && report.errors.length > 0 ? 1 : 0,
    };
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1 };
  }
}

async function handleSkillReconcileCommand(
  parsed: ParsedArgs,
  io: CliIO,
): Promise<CliRunResult> {
  const args = splitCliWords(parsed.goal);
  const action = args.shift();
  try {
    if (action === "scan") {
      const findings = await scanSkillReconciliation(parsed.workspaceRoot);
      writeLine(
        io.stdout,
        parsed.format === "json"
          ? JSON.stringify(findings, null, 2)
          : findings.length === 0
            ? "reconciliation findings: 0"
            : findings
                .map(
                  (finding) =>
                    `- ${finding.kind} ${finding.skillName ?? finding.artifactId ?? "unknown"}`,
                )
                .join("\n"),
      );
      return { exitCode: 0 };
    }
    if (action === "list") {
      const registry = await readSkillRegistry(parsed.workspaceRoot);
      writeLine(
        io.stdout,
        parsed.format === "json"
          ? JSON.stringify(registry, null, 2)
          : registry.artifacts.length === 0
            ? "registry artifacts: 0"
            : registry.artifacts
                .map(
                  (artifact) =>
                    `- ${artifact.artifactId} ${artifact.status} ${artifact.activePath ?? "(none)"}`,
                )
                .join("\n"),
      );
      return { exitCode: 0 };
    }
    const kind = action;
    if (
      kind !== "adopt" &&
      kind !== "move" &&
      kind !== "copy" &&
      kind !== "reidentify" &&
      kind !== "orphan" &&
      kind !== "import"
    ) {
      throw new Error(
        "Usage: sparkwright skills reconcile <scan|list|adopt|move|copy|reidentify|orphan|import> ...",
      );
    }
    const first = args.shift();
    const second = args.shift();
    if (kind === "import") {
      if (!first || !second) {
        throw new Error("import requires <skill-name> <source-path>.");
      }
      const imported = await importSkill({
        workspaceRoot: parsed.workspaceRoot,
        skillName: first,
        sourcePath: second,
      });
      writeLine(
        io.stdout,
        parsed.format === "json"
          ? JSON.stringify(imported, null, 2)
          : `imported ${first}: ${imported.receipt.artifactId}`,
      );
      return { exitCode: 0 };
    }
    const receipt = await reconcileSkill({
      workspaceRoot: parsed.workspaceRoot,
      kind,
      ...(kind === "adopt" ? { skillName: first } : {}),
      ...(kind === "move" || kind === "reidentify"
        ? { artifactId: first, skillName: second }
        : {}),
      ...(kind === "copy"
        ? { sourceArtifactId: first, skillName: second }
        : {}),
      ...(kind === "orphan" ? { artifactId: first } : {}),
    });
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(receipt, null, 2)
        : `reconciled ${receipt.kind}: ${receipt.artifactId}`,
    );
    return { exitCode: 0 };
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1 };
  }
}

async function handleSkillProposalsCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  const args = splitCliWords(parsed.goal);
  const action = args.shift();
  if (action === "list") {
    const runFilter = readFlagValue(args, "--run");
    // `--session` is parsed globally into parsed.sessionId, so read it there
    // rather than from the subcommand args.
    const sessionFilter = parsed.sessionId;
    let proposals = await listSkillProposals(parsed.workspaceRoot);
    if (runFilter) {
      proposals = proposals.filter((p) => p.provenance?.runId === runFilter);
    }
    if (sessionFilter) {
      proposals = proposals.filter(
        (p) => p.provenance?.sessionId === sessionFilter,
      );
    }
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(proposals, null, 2)
        : formatSkillProposalList(proposals),
    );
    return { exitCode: 0 };
  }

  if (action === "show") {
    const id = args.shift();
    if (!id) {
      writeLine(io.stderr, "Usage: sparkwright skills proposals show <id>");
      return { exitCode: 1 };
    }
    const proposal = await readSkillProposal(parsed.workspaceRoot, id);
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(proposal, null, 2)
        : formatSkillProposalDetail(proposal),
    );
    return { exitCode: 0 };
  }

  if (action === "apply") {
    const id = args.shift();
    if (!id) {
      writeLine(io.stderr, "Usage: sparkwright skills proposals apply <id>");
      return { exitCode: 1 };
    }
    const { applied: result } = await new SkillCommandService(
      parsed.workspaceRoot,
    ).approveAndApply(id, { force: parsed.force });
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(result, null, 2)
        : formatSkillProposalApplyResult(result),
    );
    return { exitCode: 0 };
  }

  if (action === "reject") {
    const input = parseSkillProposalRejectArgs(args);
    if (!input.ok) {
      writeLine(io.stderr, input.message);
      return { exitCode: 1 };
    }
    const proposal = await rejectSkillProposal({
      workspaceRoot: parsed.workspaceRoot,
      proposalId: input.value.id,
      reason: input.value.reason,
    });
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(proposal, null, 2)
        : formatSkillProposalDetail(proposal),
    );
    return { exitCode: 0 };
  }

  if (action === "supersede") {
    const input = parseSkillProposalSupersedeArgs(args);
    if (!input.ok) {
      writeLine(io.stderr, input.message);
      return { exitCode: 1 };
    }
    const proposal = await supersedeSkillProposal({
      workspaceRoot: parsed.workspaceRoot,
      proposalId: input.value.id,
      supersededBy: input.value.supersededBy,
      reason: input.value.reason,
    });
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(proposal, null, 2)
        : formatSkillProposalDetail(proposal),
    );
    return { exitCode: 0 };
  }

  if (action === "prune") {
    const input = parseSkillProposalPruneArgs(args);
    if (!input.ok) {
      writeLine(io.stderr, input.message);
      return { exitCode: 1 };
    }
    const result = await pruneSkillProposals({
      workspaceRoot: parsed.workspaceRoot,
      states: input.value.states,
      olderThanMs: input.value.olderThanMs,
      apply: parsed.apply,
    });
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(result, null, 2)
        : formatSkillProposalPruneResult(result),
    );
    return { exitCode: 0 };
  }

  if (action === "create") {
    const input = parseSkillProposalDescriptionArgs(args, "create");
    if (!input.ok) {
      writeLine(io.stderr, input.message);
      return { exitCode: 1 };
    }
    const proposal = await createSkillCreateProposal({
      workspaceRoot: parsed.workspaceRoot,
      name: input.value.name,
      description: input.value.description,
    });
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(proposal, null, 2)
        : `Created proposal ${proposal.id} at ${proposal.path.split(sep).join("/")}`,
    );
    return { exitCode: 0 };
  }

  if (action === "update") {
    const input = parseSkillProposalDescriptionArgs(args, "update");
    if (!input.ok) {
      writeLine(io.stderr, input.message);
      return { exitCode: 1 };
    }
    const roots = await resolveSkillRootsForCli(parsed.workspaceRoot, env);
    const proposal = await createSkillUpdateProposal({
      workspaceRoot: parsed.workspaceRoot,
      skillRoots: roots,
      name: input.value.name,
      description: input.value.description,
    });
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(proposal, null, 2)
        : `Created proposal ${proposal.id} at ${proposal.path.split(sep).join("/")}`,
    );
    return { exitCode: 0 };
  }

  writeLine(io.stderr, skillProposalsUsage());
  return { exitCode: 1 };
}

async function handleSkillHistoryCommand(
  parsed: ParsedArgs,
  io: CliIO,
): Promise<CliRunResult> {
  const args = splitCliWords(parsed.goal);
  const action = args[0];
  if (action === "show" || action === "diff") {
    const name = args[1];
    const historyId = args[2];
    if (!name || !historyId) {
      writeLine(
        io.stderr,
        `Usage: sparkwright skills history ${action} <skill-name> <history-id>`,
      );
      return { exitCode: 1 };
    }
    const detail = await readSkillHistoryDetail(
      parsed.workspaceRoot,
      name,
      historyId,
    );
    if (action === "diff") {
      writeLine(
        io.stdout,
        parsed.format === "json"
          ? JSON.stringify(
              {
                id: detail.id,
                skillName: detail.skillName,
                proposalId: detail.proposalId,
                patchDiff: detail.patchDiff,
              },
              null,
              2,
            )
          : detail.patchDiff.trimEnd(),
      );
      return { exitCode: 0 };
    }
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(detail, null, 2)
        : formatSkillHistoryDetail(detail),
    );
    return { exitCode: 0 };
  }

  const name = args[0];
  if (!name) {
    writeLine(io.stderr, "Usage: sparkwright skills history <skill-name>");
    return { exitCode: 1 };
  }
  const history = await listSkillHistory(parsed.workspaceRoot, name);
  writeLine(
    io.stdout,
    parsed.format === "json"
      ? JSON.stringify(history, null, 2)
      : formatSkillHistory(history),
  );
  return { exitCode: 0 };
}

async function handleSkillRestoreCommand(
  parsed: ParsedArgs,
  io: CliIO,
): Promise<CliRunResult> {
  const input = parseSkillRestoreArgs(splitCliWords(parsed.goal));
  if (!input.ok) {
    writeLine(io.stderr, input.message);
    return { exitCode: 1 };
  }
  const result = await restoreSkillFromHistory({
    workspaceRoot: parsed.workspaceRoot,
    skillName: input.value.name,
    historyId: input.value.version,
    side: input.value.side,
    apply: parsed.apply,
  });
  writeLine(
    io.stdout,
    parsed.format === "json"
      ? JSON.stringify(result, null, 2)
      : formatSkillRestoreResult(result),
  );
  return { exitCode: 0 };
}

async function handleSkillsCreate(
  parsed: ParsedArgs,
  io: CliIO,
): Promise<CliRunResult> {
  const input = parseSkillsCreateArgs(splitCliWords(parsed.goal));
  if (!input.ok) {
    writeLine(io.stderr, input.message);
    return { exitCode: 1 };
  }
  if (parsed.force) {
    writeLine(
      io.stderr,
      "skills create no longer accepts --force; prepare the proposal, review its final effect, then apply it.",
    );
    return { exitCode: 1 };
  }
  const { proposal } = await new SkillCommandService(
    parsed.workspaceRoot,
  ).prepareCreate({
    name: input.value.name,
    description: input.value.description,
    root: input.value.root,
  });
  writeLine(
    io.stdout,
    parsed.format === "json"
      ? JSON.stringify(proposal, null, 2)
      : `Prepared proposal ${proposal.id} at ${proposal.path
          .split(sep)
          .join(
            "/",
          )}. Review and apply it with: sparkwright skills proposals apply ${proposal.id}`,
  );
  return { exitCode: 0 };
}

function parseSkillProposalDescriptionArgs(
  args: string[],
  action: "create" | "update",
):
  | { ok: true; value: { name: string; description: string } }
  | { ok: false; message: string } {
  const rest = [...args];
  const name = rest.shift();
  if (!name || !isSkillName(name)) {
    return {
      ok: false,
      message: `Usage: sparkwright skills proposals ${action} <name> --description <text>`,
    };
  }
  let description: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--description") {
      description = rest[i + 1];
      i += 1;
      continue;
    }
    return {
      ok: false,
      message: `Unknown skills proposals ${action} option: ${arg}`,
    };
  }
  if (!description || description.trim().length === 0) {
    return {
      ok: false,
      message: `Usage: skills proposals ${action} requires --description`,
    };
  }
  return {
    ok: true,
    value: { name, description: description.trim() },
  };
}

function parseSkillProposalRejectArgs(
  args: string[],
):
  | { ok: true; value: { id: string; reason: string } }
  | { ok: false; message: string } {
  const rest = [...args];
  const id = rest.shift();
  if (!id) {
    return {
      ok: false,
      message:
        "Usage: sparkwright skills proposals reject <id> --reason <text>",
    };
  }
  let reason: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--reason") {
      reason = rest[i + 1];
      i += 1;
      continue;
    }
    return {
      ok: false,
      message: `Unknown skills proposals reject option: ${arg}`,
    };
  }
  if (!reason || reason.trim().length === 0) {
    return {
      ok: false,
      message: "Usage: skills proposals reject requires --reason",
    };
  }
  return { ok: true, value: { id, reason: reason.trim() } };
}

function parseSkillProposalSupersedeArgs(
  args: string[],
):
  | { ok: true; value: { id: string; supersededBy: string; reason?: string } }
  | { ok: false; message: string } {
  const rest = [...args];
  const id = rest.shift();
  if (!id) {
    return {
      ok: false,
      message:
        "Usage: sparkwright skills proposals supersede <id> --by <new-id>",
    };
  }
  let supersededBy: string | undefined;
  let reason: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--by") {
      supersededBy = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--reason") {
      reason = rest[i + 1];
      i += 1;
      continue;
    }
    return {
      ok: false,
      message: `Unknown skills proposals supersede option: ${arg}`,
    };
  }
  if (!supersededBy || supersededBy.trim().length === 0) {
    return {
      ok: false,
      message: "Usage: skills proposals supersede requires --by",
    };
  }
  return {
    ok: true,
    value: {
      id,
      supersededBy: supersededBy.trim(),
      reason: reason?.trim(),
    },
  };
}

function parseSkillProposalPruneArgs(args: string[]):
  | {
      ok: true;
      value: {
        states?: SkillProposalState[];
        olderThanMs?: number;
      };
    }
  | { ok: false; message: string } {
  const states: SkillProposalState[] = [];
  let olderThanMs: number | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--state") {
      const parsed = parsePruneStateList(args[i + 1]);
      if (!parsed.ok) return parsed;
      states.push(...parsed.value);
      i += 1;
      continue;
    }
    if (arg === "--older-than") {
      const parsed = parseDurationMs(args[i + 1]);
      if (!parsed.ok) return parsed;
      olderThanMs = parsed.value;
      i += 1;
      continue;
    }
    return {
      ok: false,
      message: `Unknown skills proposals prune option: ${arg}`,
    };
  }
  return {
    ok: true,
    value: {
      ...(states.length > 0 ? { states: [...new Set(states)] } : {}),
      ...(olderThanMs !== undefined ? { olderThanMs } : {}),
    },
  };
}

function parsePruneStateList(
  value: string | undefined,
): { ok: true; value: SkillProposalState[] } | { ok: false; message: string } {
  if (!value || value.startsWith("--")) {
    return {
      ok: false,
      message: "Usage: skills proposals prune --state requires a value",
    };
  }
  const states = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (states.length === 0) {
    return {
      ok: false,
      message: "Usage: skills proposals prune --state requires a value",
    };
  }
  const allowed: SkillProposalState[] = [
    "rejected",
    "stale",
    "superseded",
    "failed",
  ];
  for (const state of states) {
    if (!allowed.includes(state as SkillProposalState)) {
      return {
        ok: false,
        message: `Usage: skills proposals prune --state must be one of: ${allowed.join(", ")}`,
      };
    }
  }
  return { ok: true, value: states as SkillProposalState[] };
}

function parseDurationMs(
  value: string | undefined,
): { ok: true; value: number } | { ok: false; message: string } {
  if (!value || value.startsWith("--")) {
    return {
      ok: false,
      message: "Usage: skills proposals prune --older-than requires a duration",
    };
  }
  const match = /^(\d+)([smhd]?)$/u.exec(value.trim());
  if (!match) {
    return {
      ok: false,
      message:
        "Usage: skills proposals prune --older-than must be a duration like 30d, 12h, 45m, or 60s",
    };
  }
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return {
      ok: false,
      message: "Usage: skills proposals prune --older-than must be positive",
    };
  }
  const unit = match[2] || "d";
  const factor =
    unit === "s"
      ? 1000
      : unit === "m"
        ? 60 * 1000
        : unit === "h"
          ? 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
  return { ok: true, value: amount * factor };
}

function parseSkillRestoreArgs(args: string[]):
  | {
      ok: true;
      value: { name: string; version: string; side: "before" | "after" };
    }
  | { ok: false; message: string } {
  const rest = [...args];
  const name = rest.shift();
  if (!name || !isSkillName(name)) {
    return {
      ok: false,
      message:
        "Usage: sparkwright skills restore <skill-name> --version <history-id> [--to before|after]",
    };
  }
  let version: string | undefined;
  let side: "before" | "after" = "after";
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--version") {
      version = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--to") {
      const value = rest[i + 1];
      if (value !== "before" && value !== "after") {
        return {
          ok: false,
          message: "Usage: skills restore --to must be 'before' or 'after'",
        };
      }
      side = value;
      i += 1;
      continue;
    }
    return {
      ok: false,
      message: `Unknown skills restore option: ${arg}`,
    };
  }
  if (!version || version.trim().length === 0) {
    return {
      ok: false,
      message: "Usage: skills restore requires --version",
    };
  }
  return { ok: true, value: { name, version: version.trim(), side } };
}

async function resolveSkillRootsForCli(
  workspaceRoot: string,
  env: Record<string, string | undefined>,
): Promise<SkillRoot[]> {
  const cfg = await loadHostConfig(workspaceRoot, env);
  const roots = cfg.config.capabilities?.skills?.roots;
  const resolved = resolveSkillRootsForRuntime(workspaceRoot, roots, env);
  return roots && roots.length > 0
    ? resolved
    : await existingSkillRoots(resolved);
}

function parseSkillsCreateArgs(
  args: string[],
):
  | { ok: true; value: { name: string; description: string; root?: string } }
  | { ok: false; message: string } {
  const rest = [...args];
  const name = rest.shift();
  if (!name) {
    return {
      ok: false,
      message:
        "Usage: sparkwright skills create <name> --description <text> [--root .sparkwright/skills]",
    };
  }
  if (!isSkillName(name)) {
    return {
      ok: false,
      message: `Invalid skill name "${name}": use lowercase letters, digits, and hyphens (kebab-case), e.g. "my-skill".`,
    };
  }
  let description: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--description") {
      description = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--root") {
      root = rest[i + 1];
      i += 1;
      continue;
    }
    return { ok: false, message: `Unknown skills create option: ${arg}` };
  }
  if (!description || description.trim().length === 0) {
    return {
      ok: false,
      message: "Usage: skills create requires --description",
    };
  }
  return {
    ok: true,
    value: {
      name,
      description: description.trim(),
      ...(root ? { root } : {}),
    },
  };
}

function isSkillName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function formatSkillReport(report: SkillReport): string {
  const lines = [
    `roots: ${report.roots.join(", ")}`,
    `skills: ${report.skills.length}`,
  ];
  for (const skill of report.skills) {
    lines.push(
      `- ${skill.name}${skill.version ? `@${skill.version}` : ""}: ${skill.description}`,
    );
    if (skill.layer) lines.push(`  layer: ${skill.layer}`);
    if (skill.source) lines.push(`  source: ${skill.source}`);
  }
  if (report.shadows.length > 0) {
    lines.push(`shadows: ${report.shadows.length}`);
    for (const shadow of report.shadows) {
      lines.push(
        `- ${shadow.name}: ${formatSkillOrigin(
          shadow.shadowed,
        )} shadowed by ${formatSkillOrigin(shadow.shadowedBy)}`,
      );
    }
  }
  if (report.errors.length > 0) {
    lines.push(`errors: ${report.errors.length}`);
    for (const error of report.errors) {
      lines.push(`- ${error.source}: ${error.message}`);
    }
  }
  return lines.join("\n");
}

function formatSkillReviewDigest(digest: SkillReviewDigest): string {
  const lines = [
    `review items: ${digest.items.length}`,
    `freshness: computed=${digest.generatedAt}, latest evidence=${digest.freshness.latestEvidenceAt ?? "none"}`,
    `stats: sessions=${digest.stats.sessionsScanned}/${digest.sessionLimit}, traces=${digest.stats.tracesScanned}, findings=${digest.stats.findingsScanned}`,
    `proposals: drafts=${digest.proposals.drafts}/${digest.proposals.scanned}, intent stubs=${digest.proposals.intentStubs}, templates=${digest.proposals.templates}`,
  ];
  if (digest.items.length === 0) {
    lines.push("(none)");
  }
  for (const item of digest.items) {
    lines.push(
      `- ${item.severity} ${item.kind} ${item.skillName}: ${item.message}`,
    );
    if (item.proposalId && item.proposalKind) {
      lines.push(
        `  proposal: ${item.proposalId} (${item.proposalKind}, ${formatSkillProposalContentMode(
          {
            kind: item.proposalKind,
            contentMode: item.contentMode,
          },
        )})`,
      );
    }
    if (item.findingCode) {
      lines.push(
        `  finding: ${item.findingCode} (${item.relation ?? "observed"})`,
      );
    }
    if (item.evidence) {
      lines.push(
        `  evidence: runs=${item.evidence.runIds.length}, sessions=${item.evidence.sessionIds.length}, metrics=${formatReviewMetricPairs(item.evidence.metrics)}`,
      );
    }
    lines.push(`  action: ${item.action}`);
  }
  lines.push(
    "note: review digest combines trace-based skill stats with draft proposals; usage sidecar data is not required.",
  );
  lines.push(
    "note: associated tool failures are correlation, not causal claims.",
  );
  return lines.join("\n");
}

function formatReviewMetricPairs(
  metrics: Record<string, number | string>,
): string {
  const entries = Object.entries(metrics);
  return entries.length > 0
    ? entries.map(([key, value]) => `${key}=${value}`).join(", ")
    : "none";
}

function formatSkillStatsReport(report: SkillStatsReport): string {
  const lines = [
    `sessions scanned: ${report.sessionsScanned}/${report.sessionLimit}`,
    `traces scanned: ${report.tracesScanned}`,
    `window: runs=${report.window.trace.runCount}, terminal=${report.window.trace.terminalRunCount}, open=${report.window.trace.openRunCount}`,
    `freshness: computed=${report.freshness.computedAt}, latest evidence=${report.freshness.latestEvidenceAt ?? "none"}`,
    `projection cache: enabled=${report.projectionCache.enabled}, hits=${report.projectionCache.hits}, misses=${report.projectionCache.misses}, writes=${report.projectionCache.writes}, errors=${report.projectionCache.errors.length}`,
    `catalog: enabled=${report.catalog.enabled}, used=${report.catalog.used}, hits=${report.catalog.hits}, misses=${report.catalog.misses}, writes=${report.catalog.writes}, selected=${report.catalog.selectedSessions}/${report.catalog.candidateSessions}, errors=${report.catalog.errors.length}`,
    `skills: ${report.skills.length}`,
    `findings: ${report.findings.length}`,
  ];
  if (
    report.query.skillName ||
    report.query.skillKey ||
    report.query.packageHash
  ) {
    lines.push(
      `target: skill=${report.query.skillName ?? "any"}, skillKey=${report.query.skillKey ?? "any"}, package=${report.query.packageHash ?? "any"}`,
    );
  }
  if (report.window.trace.firstEventAt || report.window.trace.lastEventAt) {
    lines.push(
      `trace event window: first=${report.window.trace.firstEventAt ?? "none"}, last=${report.window.trace.lastEventAt ?? "none"}`,
    );
  }
  if (
    report.window.evolution.proposalsScanned > 0 ||
    report.window.evolution.historyScanned > 0
  ) {
    lines.push(
      `evolution window: proposals=${report.window.evolution.proposalsScanned}, history=${report.window.evolution.historyScanned}, latest=${report.freshness.latestEvolutionAt ?? "none"}`,
    );
  }
  if (report.skills.length === 0) {
    lines.push("(none)");
  }
  for (const skill of report.skills) {
    lines.push(`- ${skill.name}${skill.layer ? ` (${skill.layer})` : ""}`);
    lines.push(
      `  package: v${skill.packageHashPolicyVersion} ${skill.packageHash}`,
    );
    if (skill.sourcePath) lines.push(`  source: ${skill.sourcePath}`);
    if (skill.shadowedBy) lines.push(`  shadowed by: ${skill.shadowedBy}`);
    if (skill.shadows && skill.shadows.length > 0) {
      lines.push(`  shadows: ${skill.shadows.join(", ")}`);
    }
    lines.push(
      `  indexed: ${skill.indexedCount}, loaded: ${skill.loadedCount}, resident loads: ${skill.residentLoadCount}, explicit loads: ${skill.explicitLoadCount}, load failures: ${skill.loadFailures.total}`,
    );
    const loadFailureModes = Object.entries(skill.loadFailures.byMode);
    const loadFailureStatuses = Object.entries(skill.loadFailures.byStatus);
    if (loadFailureModes.length > 0 || loadFailureStatuses.length > 0) {
      lines.push(
        `  load failure detail: modes=${formatCountPairs(loadFailureModes)}, statuses=${formatCountPairs(loadFailureStatuses)}`,
      );
    }
    lines.push(
      `  runs: ${skill.runIds.length}, sessions: ${skill.sessionIds.length}`,
    );
    lines.push(
      `  associated runs: completed=${skill.associatedRuns.completed}, failed=${skill.associatedRuns.failed}, cancelled=${skill.associatedRuns.cancelled}`,
    );
    lines.push(
      `  associated tool failures: ${skill.associatedToolFailures.total} total, ${skill.associatedToolFailures.unresolved} unresolved, before load=${skill.associatedToolFailures.beforeFirstLoad}, after load=${skill.associatedToolFailures.afterFirstLoad}`,
    );
    const failedTools = Object.entries(skill.associatedToolFailures.byTool);
    if (failedTools.length > 0) {
      lines.push(
        `  failed tools: ${failedTools
          .map(([tool, count]) => `${tool}=${count}`)
          .join(", ")}`,
      );
    }
    const failureCodes = Object.entries(skill.associatedToolFailures.byCode);
    if (failureCodes.length > 0) {
      lines.push(`  failure codes: ${formatCountPairs(failureCodes)}`);
    }
    const proposalRollup = skill.evolution.proposals;
    if (proposalRollup.total > 0) {
      lines.push(
        `  proposals: ${proposalRollup.total} total, base=${proposalRollup.asBase}, after=${proposalRollup.asAfter}, states=${formatCountPairs(Object.entries(proposalRollup.byState))}, kinds=${formatCountPairs(Object.entries(proposalRollup.byKind))}`,
      );
    }
    const historyRollup = skill.evolution.history;
    if (historyRollup.total > 0) {
      lines.push(
        `  history: ${historyRollup.total} total, before=${historyRollup.asBefore}, after=${historyRollup.asAfter}, kinds=${formatCountPairs(Object.entries(historyRollup.byKind))}`,
      );
    }
  }
  if (report.findings.length > 0) {
    lines.push("finding detail:");
    for (const finding of report.findings) {
      lines.push(
        `- ${finding.severity} ${finding.relation} ${finding.code} ${finding.skillName}: ${finding.message}`,
      );
    }
  }
  if (report.traceErrors.length > 0) {
    lines.push(`trace errors: ${report.traceErrors.length}`);
    for (const error of report.traceErrors) {
      lines.push(`- ${error.sessionId}: ${error.message}`);
    }
  }
  if (report.projectionCache.errors.length > 0) {
    lines.push(
      `projection cache errors: ${report.projectionCache.errors.length}`,
    );
    for (const error of report.projectionCache.errors) {
      lines.push(`- ${error.sessionId}: ${error.message}`);
    }
  }
  if (report.catalog.errors.length > 0) {
    lines.push(`catalog errors: ${report.catalog.errors.length}`);
    for (const error of report.catalog.errors) {
      lines.push(`- ${error.path}: ${error.message}`);
    }
  }
  lines.push(
    "note: tool failures are associated with loaded skills, not causal claims.",
  );
  return lines.join("\n");
}

function formatCountPairs(entries: Array<[string, number]>): string {
  return entries.length > 0
    ? entries.map(([key, count]) => `${key}=${count}`).join(", ")
    : "none";
}

function formatSkillDoctorReport(report: SkillDoctorReport): string {
  const lines = [
    `status: ${report.status}`,
    `skills: ${report.skills.length}`,
    `findings: ${report.findings.length}`,
    `blockers: ${report.blockerCount}`,
    `warnings: ${report.warningCount}`,
  ];
  for (const skill of report.skills) {
    lines.push(`- ${skill.name}${skill.layer ? ` (${skill.layer})` : ""}`);
    if (skill.sourcePath) lines.push(`  source: ${skill.sourcePath}`);
    lines.push(
      `  package: v${skill.packageHashPolicyVersion} ${skill.packageHash}`,
    );
    if (skill.shadowedBy) lines.push(`  shadowed by: ${skill.shadowedBy}`);
    if (skill.shadows && skill.shadows.length > 0) {
      lines.push(`  shadows: ${skill.shadows.join(", ")}`);
    }
  }
  if (report.findings.length > 0) {
    lines.push("findings:");
    for (const finding of report.findings) {
      const subject = finding.skillName
        ? ` ${finding.skillName}`
        : finding.source
          ? ` ${finding.source}`
          : "";
      lines.push(
        `- ${finding.severity} ${finding.code}${subject}: ${finding.message}`,
      );
    }
  }
  return lines.join("\n");
}

function formatSkillProposalList(proposals: SkillProposalSummary[]): string {
  const lines = [`proposals: ${proposals.length}`];
  if (proposals.length === 0) lines.push("(none)");
  for (const proposal of proposals) {
    lines.push(
      `- ${proposal.id}: ${proposal.state} ${proposal.kind} ${proposal.skillName}`,
    );
    lines.push(`  created: ${proposal.createdAt}`);
    if (proposal.sourceLayer || proposal.sourcePath) {
      lines.push(
        `  source: ${proposal.sourceLayer ?? "unknown"}:${proposal.sourcePath ?? "unknown"}`,
      );
    }
    if (proposal.basePackageHash) {
      lines.push(`  base package: ${proposal.basePackageHash}`);
    }
    lines.push(`  after package: ${proposal.afterPackageHash}`);
    lines.push(`  content: ${formatSkillProposalContentMode(proposal)}`);
    if (proposal.closedAt) lines.push(`  closed: ${proposal.closedAt}`);
    if (proposal.supersededBy) {
      lines.push(`  superseded by: ${proposal.supersededBy}`);
    }
    if (proposal.statusReason) lines.push(`  reason: ${proposal.statusReason}`);
  }
  return lines.join("\n");
}

function formatSkillProposalDetail(proposal: SkillProposalDetail): string {
  return [
    `id: ${proposal.id}`,
    `state: ${proposal.state}`,
    `kind: ${proposal.kind}`,
    `skill: ${proposal.skillName}`,
    `source: ${proposal.sourceLayer ?? "none"}:${proposal.sourcePath ?? "none"}`,
    `target: ${proposal.targetPath}`,
    `base package: ${proposal.basePackageHash ?? "none"}`,
    `after package: ${proposal.afterPackageHash}`,
    `content: ${formatSkillProposalContentMode(proposal)}`,
    `closed: ${proposal.closedAt ?? "none"}`,
    `superseded by: ${proposal.supersededBy ?? "none"}`,
    `reason: ${proposal.statusReason ?? "none"}`,
    `provenance: ${formatProvenance(proposal.provenance)}`,
    formatGuardFindingsLine(proposal.guardFindings),
    "",
    proposal.proposalMarkdown.trimEnd(),
    "",
    "patch:",
    proposal.patchDiff.trimEnd(),
  ].join("\n");
}

function formatSkillProposalContentMode(
  proposal: Pick<SkillProposalSummary, "kind" | "contentMode">,
): string {
  switch (proposal.contentMode) {
    case "authored":
      return "authored";
    case "intent_stub":
      return "intent-only update stub";
    case "template":
      return "generated create template";
    default:
      return proposal.kind === "update"
        ? "unknown update content"
        : "unknown create content";
  }
}

function formatSkillProposalApplyResult(
  result: ApplySkillProposalResult,
): string {
  return [
    `applied: ${result.proposal.id}`,
    `skill: ${result.proposal.skillName}`,
    `target: ${result.proposal.targetPath}`,
    `history: ${result.history.id}`,
    `base package: ${result.history.beforePackageHash ?? "none"}`,
    `after package: ${result.history.afterPackageHash}`,
    `doctor: ${result.doctor.status}`,
    formatGuardFindingsLine(result.guardFindings),
  ].join("\n");
}

/** Read `--flag value` from a positional arg list; returns trimmed value or undefined. */
function readFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function formatProvenance(
  provenance:
    | { runId?: string; sessionId?: string; rationale?: string }
    | undefined,
): string {
  if (!provenance) return "none";
  const parts: string[] = [];
  if (provenance.sessionId) parts.push(`session=${provenance.sessionId}`);
  if (provenance.runId) parts.push(`run=${provenance.runId}`);
  if (provenance.rationale) parts.push(`rationale=${provenance.rationale}`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

function formatGuardFindingsLine(
  findings: readonly SkillGuardFinding[] | undefined,
): string {
  if (!findings || findings.length === 0) return "guard: ok (no findings)";
  const dangerous = findings.filter((f) => f.severity === "dangerous").length;
  const detail = findings.map((f) => `${f.severity}:${f.ruleId}`).join(", ");
  return `guard: ${findings.length} finding${findings.length === 1 ? "" : "s"}${dangerous > 0 ? ` (${dangerous} dangerous — apply needs force)` : ""} [${detail}]`;
}

function formatSkillProposalPruneResult(
  result: PruneSkillProposalsResult,
): string {
  const lines = [
    `mode: ${result.applied ? "applied" : "dry-run"}`,
    `states: ${result.states.join(", ")}`,
    `candidates: ${result.candidates.length}`,
    `deleted: ${result.deleted.length}`,
  ];
  if (result.cutoff) lines.push(`cutoff: ${result.cutoff}`);
  for (const proposal of result.candidates) {
    const action = result.applied ? "deleted" : "would delete";
    lines.push(
      `- ${action} ${proposal.id}: ${proposal.state} ${proposal.kind} ${proposal.skillName}`,
    );
  }
  return lines.join("\n");
}

function formatSkillHistory(history: SkillHistoryEntry[]): string {
  const lines = [`history: ${history.length}`];
  if (history.length === 0) lines.push("(none)");
  for (const entry of history) {
    lines.push(`- ${entry.id}: ${entry.kind} ${entry.skillName}`);
    lines.push(`  proposal: ${entry.proposalId}`);
    lines.push(`  created: ${entry.createdAt}`);
    lines.push(`  base package: ${entry.beforePackageHash ?? "none"}`);
    lines.push(`  after package: ${entry.afterPackageHash}`);
  }
  return lines.join("\n");
}

function formatSkillHistoryDetail(detail: SkillHistoryDetail): string {
  return [
    `id: ${detail.id}`,
    `skill: ${detail.skillName}`,
    `kind: ${detail.kind}`,
    `proposal: ${detail.proposalId}`,
    `created: ${detail.createdAt}`,
    `target: ${detail.targetPath}`,
    `before package: ${detail.beforePackageHash ?? "none"}`,
    `after package: ${detail.afterPackageHash}`,
    `before: ${detail.beforePath}`,
    `after: ${detail.afterPath}`,
    "",
    "patch:",
    detail.patchDiff.trimEnd(),
  ].join("\n");
}

function formatSkillRestoreResult(
  result: RestoreSkillFromHistoryResult,
): string {
  const lines = [
    `mode: ${result.applied ? "applied" : "dry-run"}`,
    `skill: ${result.skillName}`,
    `target: ${result.targetPath}`,
    `source history: ${result.sourceHistory.id} (${result.side})`,
    `current package: ${result.currentPackageHash ?? "none"}`,
    `restore package: ${result.restorePackageHash}`,
  ];
  if (result.restoreHistory) {
    lines.push(`restore history: ${result.restoreHistory.id}`);
  }
  if (result.doctor) lines.push(`doctor: ${result.doctor.status}`);
  return lines.join("\n");
}

function formatSkillOrigin(skill: {
  layer?: string;
  source?: string;
  root?: string;
}): string {
  return `${skill.layer ?? "unknown"}:${skill.source ?? skill.root ?? "unknown"}`;
}

async function handleAgentsCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  const subcommand = parsed.subcommand;
  if (
    subcommand !== "list" &&
    subcommand !== "create" &&
    subcommand !== "validate" &&
    subcommand !== "stats"
  ) {
    writeLine(io.stderr, agentsUsage());
    return { exitCode: 1 };
  }

  try {
    if (subcommand === "stats") {
      const report = await collectAssetStats({
        workspaceRoot: parsed.workspaceRoot,
        sessionRootDir: parsed.sessionRootDir,
        artifactKind: "agent",
      });
      writeLine(
        io.stdout,
        parsed.format === "json"
          ? JSON.stringify(report, null, 2)
          : formatAssetStatsReport(report),
      );
      return { exitCode: report.errors.length > 0 ? 1 : 0 };
    }
    const configPath = projectConfigPathForWorkspace(parsed.workspaceRoot);
    const loaded = await readConfigObject(configPath);
    const agents = getAgentsConfig(loaded.value);

    if (subcommand === "create") {
      const input = parseAgentsCreateArgs(
        splitCliWords(parsed.goal),
        parsed.modelName,
      );
      if (!input.ok) {
        writeLine(io.stderr, input.message);
        return { exitCode: 1 };
      }
      if (
        agents.profiles.some((profile) => profile.id === input.value.profile.id)
      ) {
        if (!parsed.force) {
          writeLine(
            io.stderr,
            `Agent already exists: ${input.value.profile.id}. Re-run with --force to overwrite.`,
          );
          return { exitCode: 1 };
        }
        agents.profiles = agents.profiles.filter(
          (profile) => profile.id !== input.value.profile.id,
        );
      }
      agents.profiles.push(input.value.profile);
      if (input.value.delegateTool) {
        agents.delegateTools = agents.delegateTools.filter(
          (tool) => tool.profileId !== input.value.delegateTool?.profileId,
        );
        agents.delegateTools.push(input.value.delegateTool);
      }
      setAgentsConfig(loaded.value, agents);
      await writeConfigObject(loaded.path, loaded.value);
      writeLine(io.stdout, `Updated ${loaded.path}`);
      writeLine(
        io.stdout,
        `Agent profile "${input.value.profile.id}" is now defined.`,
      );
      if (input.value.delegateTool) {
        writeLine(
          io.stdout,
          `Callable delegate tool: ${input.value.delegateTool.toolName ?? `delegate_${input.value.profile.id}`} -> ${input.value.profile.id}`,
        );
      } else {
        writeLine(
          io.stdout,
          "This profile is inspectable but not callable by the main agent until you add --delegate or configure capabilities.agents.delegateTools.",
        );
      }
      writeLine(
        io.stdout,
        "Next: sparkwright agents validate --workspace . && sparkwright capabilities inspect --workspace . --format text",
      );
      return { exitCode: 0 };
    }

    const report =
      subcommand === "validate"
        ? await buildAgentValidationReport(parsed.workspaceRoot, agents, env)
        : validateAgentConfig(agents);
    if (parsed.format === "json") {
      writeLine(
        io.stdout,
        JSON.stringify(
          {
            path: loaded.path,
            exists: loaded.exists,
            agents,
            errors: report.errors,
            ...(report.agentReport ? { agentReport: report.agentReport } : {}),
          },
          null,
          2,
        ),
      );
    } else {
      writeLine(
        io.stdout,
        formatAgentReport({
          path: loaded.path,
          exists: loaded.exists,
          agents,
          errors: report.errors,
          agentReport: report.agentReport,
        }),
      );
    }
    return {
      exitCode: subcommand === "validate" && report.errors.length > 0 ? 1 : 0,
    };
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1 };
  }
}

function formatAssetStatsReport(report: {
  observationsScanned: number;
  sessionsScanned: number;
  workflowRecordsScanned: number;
  entries: Array<{
    identity: {
      artifactKind: string;
      logicalName: string;
      packageHashPolicyVersion: number;
      packageHash: string;
    };
    observations: number;
    completed: number;
    failed: number;
  }>;
}): string {
  const lines = [
    `observations scanned: ${report.observationsScanned}`,
    `sessions scanned: ${report.sessionsScanned}`,
    `workflow records scanned: ${report.workflowRecordsScanned}`,
  ];
  for (const entry of report.entries) {
    lines.push(
      `- ${entry.identity.artifactKind}:${entry.identity.logicalName} v${entry.identity.packageHashPolicyVersion} ${entry.identity.packageHash} observations=${entry.observations} completed=${entry.completed} failed=${entry.failed}`,
    );
  }
  return lines.join("\n");
}

interface AgentProfileConfigShape {
  id: string;
  name?: string;
  description?: string;
  mode?: "primary" | "child" | "all";
  model?: string;
  prompt?: string;
  use?: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  delegateTool?: {
    toolName?: string;
    description?: string;
    requiresApproval?: boolean;
    forbidNesting?: boolean;
    maxSteps?: number;
  };
  maxSteps?: number;
  metadata?: Record<string, unknown>;
}

interface AgentDelegateToolConfigShape {
  profileId: string;
  toolName?: string;
  description?: string;
  requiresApproval?: boolean;
  forbidNesting?: boolean;
  maxSteps?: number;
}

interface AgentsConfigShape {
  profiles: AgentProfileConfigShape[];
  delegateTools: AgentDelegateToolConfigShape[];
  spawnModel?: string;
  delegateModel?: string;
  exposure?: "indexed" | "all";
  pinnedDelegates?: string[];
  enableParallelDelegates?: boolean;
  maxDepth?: number;
}

interface AgentValidationError {
  field: string;
  message: string;
}

interface AgentValidationReport {
  errors: AgentValidationError[];
  agentReport?: AgentReport;
}

function parseAgentsCreateArgs(
  args: string[],
  modelRef?: string,
):
  | {
      ok: true;
      value: {
        profile: AgentProfileConfigShape;
        delegateTool?: AgentDelegateToolConfigShape;
      };
    }
  | { ok: false; message: string } {
  const rest = [...args];
  const id = rest.shift();
  if (!id || !isAgentId(id)) {
    return {
      ok: false,
      message:
        "Usage: sparkwright agents create <id> --prompt <text> [--name text] [--model provider/model] [--use selector] [--allow tool] [--max-steps n] [--delegate tool_name]",
    };
  }

  let name: string | undefined;
  let description: string | undefined;
  let mode: AgentProfileConfigShape["mode"] = "child";
  let prompt: string | undefined;
  const use: string[] = [];
  const allowedTools: string[] = [];
  const deniedTools: string[] = [];
  let maxSteps: number | undefined;
  let delegateToolName: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--name") {
      name = requireFollowingValue(rest, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--description") {
      description = requireFollowingValue(rest, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--mode") {
      const value = requireFollowingValue(rest, i, arg);
      if (value !== "primary" && value !== "child" && value !== "all") {
        return { ok: false, message: "--mode must be primary, child, or all" };
      }
      mode = value;
      i += 1;
      continue;
    }
    if (arg === "--prompt") {
      prompt = requireFollowingValue(rest, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--use") {
      const selector = requireFollowingValue(rest, i, arg);
      if (!isToolUseSelector(selector)) {
        return {
          ok: false,
          message: `--use must be one of ${formatToolUseSelectorList()}`,
        };
      }
      use.push(selector);
      i += 1;
      continue;
    }
    if (arg === "--allow") {
      allowedTools.push(requireFollowingValue(rest, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--deny") {
      deniedTools.push(requireFollowingValue(rest, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--max-steps") {
      const raw = requireFollowingValue(rest, i, arg);
      maxSteps = parsePositiveInteger(raw);
      if (maxSteps === undefined) {
        return {
          ok: false,
          message: "--max-steps requires a positive integer",
        };
      }
      i += 1;
      continue;
    }
    if (arg === "--delegate") {
      delegateToolName = requireFollowingValue(rest, i, arg);
      i += 1;
      continue;
    }
    return { ok: false, message: `Unknown agents create option: ${arg}` };
  }

  if (!prompt || prompt.trim().length === 0) {
    return { ok: false, message: "Usage: agents create requires --prompt" };
  }

  const profile: AgentProfileConfigShape = {
    id,
    name: name ?? id,
    ...(description ? { description } : {}),
    mode,
    ...(modelRef ? { model: modelRef } : {}),
    prompt: prompt.trim(),
    ...(use.length > 0 ? { use } : {}),
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    ...(deniedTools.length > 0 ? { deniedTools } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
  };

  return {
    ok: true,
    value: {
      profile,
      ...(delegateToolName
        ? {
            delegateTool: {
              profileId: id,
              toolName: delegateToolName,
              requiresApproval: true,
              forbidNesting: true,
              ...(maxSteps !== undefined ? { maxSteps } : {}),
            },
          }
        : {}),
    },
  };
}

function requireFollowingValue(
  args: string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function getAgentsConfig(config: Record<string, unknown>): AgentsConfigShape {
  const capabilities = config.capabilities;
  if (!isPlainObject(capabilities)) return { profiles: [], delegateTools: [] };
  const agents = capabilities.agents;
  if (!isPlainObject(agents)) return { profiles: [], delegateTools: [] };
  return {
    profiles: Array.isArray(agents.profiles)
      ? agents.profiles.filter(isPlainObject).map(recordToAgentProfile)
      : [],
    delegateTools: Array.isArray(agents.delegateTools)
      ? agents.delegateTools.filter(isPlainObject).map(recordToDelegateTool)
      : [],
    ...(typeof agents.spawnModel === "string"
      ? { spawnModel: agents.spawnModel }
      : {}),
    ...(typeof agents.delegateModel === "string"
      ? { delegateModel: agents.delegateModel }
      : {}),
    ...(agents.exposure === "indexed" || agents.exposure === "all"
      ? { exposure: agents.exposure }
      : {}),
    ...(Array.isArray(agents.pinnedDelegates)
      ? {
          pinnedDelegates: agents.pinnedDelegates.filter(
            (delegate): delegate is string => typeof delegate === "string",
          ),
        }
      : {}),
    ...(typeof agents.enableParallelDelegates === "boolean"
      ? { enableParallelDelegates: agents.enableParallelDelegates }
      : {}),
    ...(typeof agents.maxDepth === "number" && Number.isFinite(agents.maxDepth)
      ? { maxDepth: agents.maxDepth }
      : {}),
  };
}

function recordToAgentProfile(
  record: Record<string, unknown>,
): AgentProfileConfigShape {
  return { ...(record as unknown as AgentProfileConfigShape) };
}

function recordToDelegateTool(
  record: Record<string, unknown>,
): AgentDelegateToolConfigShape {
  return { ...(record as unknown as AgentDelegateToolConfigShape) };
}

function setAgentsConfig(
  config: Record<string, unknown>,
  agents: AgentsConfigShape,
): void {
  const capabilities = isPlainObject(config.capabilities)
    ? config.capabilities
    : {};
  capabilities.agents = {
    profiles: agents.profiles,
    ...(agents.delegateTools.length > 0
      ? { delegateTools: agents.delegateTools }
      : {}),
    ...(agents.spawnModel !== undefined
      ? { spawnModel: agents.spawnModel }
      : {}),
    ...(agents.delegateModel !== undefined
      ? { delegateModel: agents.delegateModel }
      : {}),
    ...(agents.exposure !== undefined ? { exposure: agents.exposure } : {}),
    ...(agents.pinnedDelegates !== undefined
      ? { pinnedDelegates: agents.pinnedDelegates }
      : {}),
    ...(agents.enableParallelDelegates !== undefined
      ? { enableParallelDelegates: agents.enableParallelDelegates }
      : {}),
    ...(agents.maxDepth !== undefined ? { maxDepth: agents.maxDepth } : {}),
  };
  config.capabilities = capabilities;
}

async function buildAgentValidationReport(
  workspaceRoot: string,
  agents: AgentsConfigShape,
  env: Record<string, string | undefined> = process.env,
): Promise<AgentValidationReport> {
  const configReport = validateAgentConfig(agents);
  const agentReport = await loadLayeredAgentReport(
    workspaceRoot,
    agents.profiles,
    env,
  );
  const collisionErrors = agentReport.collisions.map((collision, index) => ({
    field: `agentReport.collisions.${index}`,
    message:
      `same-layer agent id collision for "${collision.id}": ` +
      `kept ${formatAgentOrigin(collision.kept)}, dropped ${formatAgentOrigin(
        collision.dropped,
      )} (fail-closed)`,
  }));
  const readErrors = agentReport.errors.map((error, index) => ({
    field: `agentReport.errors.${index}`,
    message: `${error.source}: ${error.message}`,
  }));
  return {
    errors: [...configReport.errors, ...collisionErrors, ...readErrors],
    agentReport,
  };
}

function validateAgentConfig(agents: AgentsConfigShape): AgentValidationReport {
  const errors: AgentValidationError[] = [];
  const ids = new Set<string>();
  for (const [index, profile] of agents.profiles.entries()) {
    const field = `profiles.${index}`;
    if (!isAgentId(profile.id)) {
      errors.push({
        field: `${field}.id`,
        message: "must be a valid agent id",
      });
    } else if (ids.has(profile.id)) {
      errors.push({ field: `${field}.id`, message: "duplicate agent id" });
    } else {
      ids.add(profile.id);
    }
    if (
      profile.mode !== undefined &&
      profile.mode !== "primary" &&
      profile.mode !== "child" &&
      profile.mode !== "all"
    ) {
      errors.push({
        field: `${field}.mode`,
        message: "must be primary, child, or all",
      });
    }
    if (
      profile.use !== undefined &&
      (!isStringArray(profile.use) ||
        profile.use.some((selector) => !isToolUseSelector(selector)))
    ) {
      errors.push({
        field: `${field}.use`,
        message: `must be an array of tool selectors (${formatToolUseSelectorList()})`,
      });
    }
    if (
      profile.allowedTools !== undefined &&
      !isStringArray(profile.allowedTools)
    ) {
      errors.push({
        field: `${field}.allowedTools`,
        message: "must be an array of strings",
      });
    }
    if (
      profile.deniedTools !== undefined &&
      !isStringArray(profile.deniedTools)
    ) {
      errors.push({
        field: `${field}.deniedTools`,
        message: "must be an array of strings",
      });
    }
    if (
      profile.maxSteps !== undefined &&
      (!Number.isInteger(profile.maxSteps) || profile.maxSteps < 1)
    ) {
      errors.push({
        field: `${field}.maxSteps`,
        message: "must be a positive integer",
      });
    }
  }
  for (const [index, tool] of agents.delegateTools.entries()) {
    if (!ids.has(tool.profileId)) {
      errors.push({
        field: `delegateTools.${index}.profileId`,
        message: "must reference an existing profile id",
      });
    }
  }
  return { errors };
}

function formatAgentReport(input: {
  path: string;
  exists: boolean;
  agents: AgentsConfigShape;
  errors: AgentValidationError[];
  agentReport?: AgentReport;
}): string {
  const lines = [
    `config: ${input.path}${input.exists ? "" : " (not created yet)"}`,
    `agents: ${input.agents.profiles.length}`,
  ];
  for (const profile of input.agents.profiles) {
    lines.push(
      `- ${profile.id}${profile.name ? ` (${profile.name})` : ""}${profile.mode ? ` · ${profile.mode}` : ""}`,
    );
    if (typeof profile.model === "string" && profile.model.length > 0) {
      lines.push(`  model: ${profile.model}`);
    }
    if (profile.use?.length) {
      lines.push(`  use: ${profile.use.join(", ")}`);
    }
    if (profile.allowedTools?.length) {
      lines.push(`  allow: ${profile.allowedTools.join(", ")}`);
    }
    if (profile.deniedTools?.length) {
      lines.push(`  deny: ${profile.deniedTools.join(", ")}`);
    }
    if (profile.delegateTool) {
      lines.push(
        `  delegate: ${delegateToolName({ profileId: profile.id, ...profile.delegateTool })}`,
      );
    }
  }
  if (input.agents.delegateTools.length > 0) {
    lines.push(`delegateTools: ${input.agents.delegateTools.length}`);
    for (const tool of input.agents.delegateTools) {
      lines.push(
        `- ${tool.toolName ?? `delegate_${tool.profileId}`} -> ${tool.profileId}`,
      );
    }
  }
  if (input.agentReport) {
    lines.push(
      `discovered agents: ${input.agentReport.profiles.length} effective, ${input.agentReport.roots.length} roots, ${input.agentReport.shadows.length} shadows, ${input.agentReport.collisions.length} collisions, ${input.agentReport.errors.length} errors`,
    );
    if (input.agentReport.shadows.length > 0) {
      lines.push(`shadows: ${input.agentReport.shadows.length}`);
      for (const shadow of input.agentReport.shadows) {
        lines.push(
          `- ${shadow.id}: ${formatAgentOrigin(
            shadow.shadowed,
          )} shadowed by ${formatAgentOrigin(shadow.shadowedBy)}`,
        );
      }
    }
    if (input.agentReport.collisions.length > 0) {
      lines.push(`collisions: ${input.agentReport.collisions.length}`);
      for (const collision of input.agentReport.collisions) {
        lines.push(
          `- ${collision.id}: kept ${formatAgentOrigin(
            collision.kept,
          )}, dropped ${formatAgentOrigin(collision.dropped)} (fail-closed)`,
        );
      }
    }
    if (input.agentReport.errors.length > 0) {
      lines.push(`agent report errors: ${input.agentReport.errors.length}`);
      for (const error of input.agentReport.errors) {
        lines.push(`- ${error.source}: ${error.message}`);
      }
    }
  }
  if (input.errors.length > 0) {
    lines.push(`errors: ${input.errors.length}`);
    for (const error of input.errors) {
      lines.push(`- ${error.field}: ${error.message}`);
    }
  }
  return lines.join("\n");
}

function isAgentId(value: unknown): value is string {
  // `:` is accepted for explicit namespaced ids (e.g. review:foo). Ids stay
  // flat by default; the path is never auto-derived into the id.
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

async function handleCronCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  const subcommand = parsed.subcommand;
  if (!subcommand || !isCronSubcommand(subcommand)) {
    writeLine(io.stderr, cronUsage());
    return { exitCode: 1 };
  }

  const cron = parseCronArgs(parsed.goal);
  if (!cron.ok) {
    writeLine(io.stderr, cron.message);
    return { exitCode: 1 };
  }

  const rootDir = cron.value.rootDir ?? defaultCronRoot(env);
  const store = new CronStore({
    rootDir,
  });
  const cronService = new CronCommandService({ rootDir, store });

  try {
    if (subcommand === "list") {
      const result = await cronService.listJobs();
      writeLine(
        io.stdout,
        JSON.stringify({ rootDir, jobs: result.jobs }, null, 2),
      );
      return { exitCode: 0 };
    }

    if (subcommand === "create") {
      const jobInput = cronCreateInput(cron.value);
      if (!jobInput.ok) {
        writeLine(io.stderr, jobInput.message);
        return { exitCode: 1 };
      }
      const result = await cronService.createJob(jobInput.value, {
        conflictPolicy: "unique",
      });
      const job = result.job;
      if (result.nameAdjusted) {
        writeLine(
          io.stderr,
          `Cron job "${result.requestedName}" already exists; created as "${job.name}".`,
        );
      }
      writeLine(io.stdout, JSON.stringify(job, null, 2));
      return { exitCode: 0 };
    }

    const ref = parsed.target;
    if (!ref) {
      writeLine(
        io.stderr,
        `Usage: sparkwright cron ${subcommand} <job-id-or-name>`,
      );
      return { exitCode: 1 };
    }

    if (subcommand === "update") {
      const patch = cronUpdatePatch(cron.value);
      if (!patch.ok) {
        writeLine(io.stderr, patch.message);
        return { exitCode: 1 };
      }
      const result = await cronService.updateJob(ref, patch.value);
      writeLine(io.stdout, JSON.stringify(result.job, null, 2));
      return { exitCode: 0 };
    }

    if (subcommand === "pause") {
      const result = await cronService.pauseJob(ref);
      writeLine(io.stdout, JSON.stringify(result.job, null, 2));
      return { exitCode: 0 };
    }

    if (subcommand === "resume") {
      const result = await cronService.resumeJob(ref);
      writeLine(io.stdout, JSON.stringify(result.job, null, 2));
      return { exitCode: 0 };
    }

    if (subcommand === "remove") {
      const result = await cronService.removeJob(ref);
      writeLine(io.stdout, JSON.stringify(result.job, null, 2));
      return { exitCode: 0 };
    }

    if (subcommand === "status") {
      const result = await cronService.statusJob(ref);
      writeLine(
        io.stdout,
        JSON.stringify(formatCronStatus(result.job), null, 2),
      );
      return { exitCode: 0 };
    }

    if (subcommand === "run") {
      const { shouldWrite } = compileRunAccessMode(parsed.accessMode);
      const model = await createCliModel({
        modelRef: parsed.modelName,
        cwd: parsed.workspaceRoot,
        env,
        targetPath: parsed.targetPath,
        shouldWrite,
        goal: `cron run ${ref}`,
      });
      if (!model.ok) {
        writeLine(io.stderr, model.message);
        return { exitCode: 1 };
      }
      const { job, result } = await runCronJobByRef(ref, {
        rootDir,
        store,
        model: model.adapter,
        workspaceRoot: parsed.workspaceRoot,
        tools: await createConfiguredCliTools(parsed.workspaceRoot, env),
        interactionChannel: createCliInteractionChannel({
          accessMode: parsed.accessMode,
          io,
        }),
        accessMode: parsed.accessMode,
        skillRoots: cron.value.skillRoots,
      });
      writeLine(
        io.stdout,
        JSON.stringify({ jobId: job.id, jobName: job.name, result }, null, 2),
      );
      return { exitCode: result.ok ? 0 : 1 };
    }

    const { shouldWrite } = compileRunAccessMode(parsed.accessMode);
    const cronTickModelInput = {
      modelRef: parsed.modelName,
      cwd: parsed.workspaceRoot,
      env,
      targetPath: parsed.targetPath,
      shouldWrite,
      goal: "cron tick",
    };
    const model = await createCliModel(cronTickModelInput);
    if (!model.ok) {
      writeLine(io.stderr, model.message);
      return { exitCode: 1 };
    }
    const result = await tickCron({
      rootDir,
      store,
      workspaceRoot: parsed.workspaceRoot,
      modelFactory: async () => {
        const fresh = await createCliModel(cronTickModelInput);
        if (!fresh.ok) throw new Error(fresh.message);
        return fresh.adapter;
      },
      tools: await createConfiguredCliTools(parsed.workspaceRoot, env),
      interactionChannel: createCliInteractionChannel({
        accessMode: parsed.accessMode,
        io,
      }),
      accessMode: parsed.accessMode,
      skillRoots: cron.value.skillRoots,
    });
    writeLine(io.stdout, JSON.stringify(result, null, 2));
    return { exitCode: result.failed > 0 ? 1 : 0 };
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1 };
  }
}

interface CronParsedArgs {
  rootDir?: string;
  name?: string;
  prompt?: string;
  schedule?: string;
  skills?: string[];
  skillRoots?: string[];
  repeatTimes?: number | null;
  workspace?: string | null;
}

function parseCronArgs(
  input: string,
): { ok: true; value: CronParsedArgs } | { ok: false; message: string } {
  let args: string[];
  try {
    args = input.includes("\0")
      ? input.split("\0").filter(Boolean)
      : splitShellLike(input);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const out: CronParsedArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--root-dir") {
      if (!next)
        return { ok: false, message: "Usage: --root-dir requires a path" };
      out.rootDir = next;
      i += 1;
    } else if (arg === "--name") {
      if (!next) return { ok: false, message: "Usage: --name requires text" };
      out.name = next;
      i += 1;
    } else if (arg === "--prompt") {
      if (!next) return { ok: false, message: "Usage: --prompt requires text" };
      out.prompt = next;
      i += 1;
    } else if (arg === "--schedule") {
      if (!next)
        return { ok: false, message: "Usage: --schedule requires text" };
      out.schedule = next;
      i += 1;
    } else if (arg === "--skill") {
      if (!next)
        return { ok: false, message: "Usage: --skill requires a name" };
      out.skills = [...(out.skills ?? []), ...splitComma(next)];
      i += 1;
    } else if (arg === "--skill-root") {
      if (!next)
        return { ok: false, message: "Usage: --skill-root requires a path" };
      out.skillRoots = [...(out.skillRoots ?? []), next];
      i += 1;
    } else if (arg === "--repeat") {
      if (!next)
        return {
          ok: false,
          message: "Usage: --repeat requires a positive integer or forever",
        };
      out.repeatTimes = next === "forever" ? null : parsePositiveInteger(next);
      if (out.repeatTimes === undefined) {
        return {
          ok: false,
          message: "Usage: --repeat requires a positive integer or forever",
        };
      }
      i += 1;
    } else if (arg === "--job-workspace") {
      if (!next)
        return { ok: false, message: "Usage: --job-workspace requires a path" };
      out.workspace = next;
      i += 1;
    } else if (arg === "--clear-job-workspace") {
      out.workspace = null;
    } else if (arg.trim()) {
      return { ok: false, message: `Unknown cron option: ${arg}` };
    }
  }
  return { ok: true, value: out };
}

function cronCreateInput(
  args: CronParsedArgs,
): { ok: true; value: CreateJobInput } | { ok: false; message: string } {
  if (!args.prompt)
    return { ok: false, message: "Usage: cron create requires --prompt" };
  if (!args.schedule)
    return { ok: false, message: "Usage: cron create requires --schedule" };
  return {
    ok: true,
    value: {
      prompt: args.prompt,
      schedule: args.schedule,
      ...(args.name ? { name: args.name } : {}),
      ...(args.skills ? { skills: args.skills } : {}),
      ...(args.repeatTimes !== undefined
        ? { repeat: { times: args.repeatTimes } }
        : {}),
      ...(typeof args.workspace === "string"
        ? { workspace: args.workspace }
        : {}),
    },
  };
}

function cronUpdatePatch(
  args: CronParsedArgs,
): { ok: true; value: UpdateJobPatch } | { ok: false; message: string } {
  const patch: UpdateJobPatch = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.prompt !== undefined) patch.prompt = args.prompt;
  if (args.schedule !== undefined) patch.schedule = args.schedule;
  if (args.skills !== undefined) patch.skills = args.skills;
  if (args.repeatTimes !== undefined)
    patch.repeat = { times: args.repeatTimes };
  if (args.workspace !== undefined) patch.workspace = args.workspace;
  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      message: "Usage: cron update requires at least one patch option",
    };
  }
  return { ok: true, value: patch };
}

function isCronSubcommand(
  value: string,
): value is
  | "list"
  | "create"
  | "update"
  | "pause"
  | "resume"
  | "remove"
  | "status"
  | "run"
  | "tick" {
  return (
    value === "list" ||
    value === "create" ||
    value === "update" ||
    value === "pause" ||
    value === "resume" ||
    value === "remove" ||
    value === "status" ||
    value === "run" ||
    value === "tick"
  );
}

function formatCronStatus(job: CronJob): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled,
    state: job.state,
    schedule: job.scheduleDisplay,
    nextRunAt: job.nextRunAt,
    runningSince: job.runningSince ?? null,
    lastRunAt: job.lastRunAt,
    lastStatus: job.lastStatus,
    lastError: job.lastError,
    lastRunId: job.lastRunId ?? null,
    lastTracePath: job.lastTracePath ?? null,
    lastOutputPath: job.lastOutputPath ?? null,
    repeat: job.repeat,
    workspace: job.workspace ?? null,
  };
}

function splitComma(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitShellLike(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (quote) throw new Error("unterminated quote in cron arguments");
  if (current) parts.push(current);
  return parts;
}

function cronUsage(): string {
  return [
    'Usage: sparkwright cron create --schedule "every 1h" --prompt "task" [--name name] [--skill name] [--repeat n|forever] [--job-workspace path]',
    "       sparkwright cron list",
    "       sparkwright cron update <job-id-or-name> [--schedule text] [--prompt text] [--name text] [--job-workspace path|--clear-job-workspace]",
    "       sparkwright cron pause|resume|remove|status <job-id-or-name>",
    "       sparkwright cron run <job-id-or-name> [--model provider/model] [--access-mode read-only|ask|accept-edits|bypass]",
    "       sparkwright cron tick [--model provider/model] [--access-mode read-only|ask|accept-edits|bypass]",
  ].join("\n");
}

function helpForArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): string | undefined {
  if (argv.length === 0) return undefined;
  if (isHelpArg(argv[0])) return usage(env);

  const command = argv[0];
  const runResumeHelp =
    command === "run" &&
    argv[1] === "resume" &&
    argv.slice(2).some((arg) => isHelpArg(arg));
  const supportsNestedHelp = new Set([
    "agents",
    "capabilities",
    "config",
    "cron",
    "delegates",
    "doctor",
    "session",
    "skills",
    "tasks",
    "tools",
    "trace",
    "workflow",
  ]);
  if (
    !isHelpArg(argv[1]) &&
    !(
      supportsNestedHelp.has(command) &&
      argv.slice(2).some((arg) => isHelpArg(arg))
    ) &&
    !runResumeHelp
  )
    return undefined;

  if (command === "init") {
    return [
      "Usage: sparkwright init",
      "       sparkwright init --project",
    ].join("\n");
  }
  if (command === "run") {
    if (runResumeHelp) return runResumeUsage();
    return runUsage(env);
  }
  if (command === "trace") {
    return "Usage: sparkwright trace <summary|events|timeline|report|verify> <trace.jsonl>";
  }
  if (command === "tui") {
    return "Usage: sparkwright tui [--workspace path] [--session-root path] [--model provider/model] [--access-mode read-only|ask|accept-edits|bypass] [--trace-level standard|debug] [--session-id id]";
  }
  if (command === "acp") {
    return "Usage: sparkwright acp [--workspace path] [--session-root path] [--model provider/model] [--access-mode read-only|ask|accept-edits|bypass] [--trace-level standard|debug]";
  }
  if (command === "session") {
    return "Usage: sparkwright session <summary|inspect|check|repair|compact|resume> <session-id> [goal] [--workspace path] [--session-root path] [--model provider/model] [--llm] [--compaction]";
  }
  if (command === "cron") return cronUsage();
  if (command === "tools") return toolsUsage();
  if (command === "tasks") return tasksUsage();
  if (command === "workflow") return workflowUsage();
  if (command === "capabilities") return capabilitiesUsage();
  if (command === "delegates") return delegatesUsage();
  if (command === "skills") return skillsUsage();
  if (command === "agents") return agentsUsage();
  if (command === "config") return configUsage();
  if (command === "doctor") return doctorUsage();
  return undefined;
}

function isHelpArg(value: string | undefined): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

function runResumeUsage(): string {
  return "Usage: sparkwright run resume <run-id> [--session <session-id>] [--workspace path] [--session-root path] [--force] [--from-trace]";
}

function isVersionArg(value: string | undefined): boolean {
  return value === "--version" || value === "-v";
}

function cliPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  return typeof packageJson.version === "string"
    ? packageJson.version
    : "(unknown)";
}

function renderConfigSchemaDirective(): string {
  return `# yaml-language-server: $schema=${pathToFileURL(join(findConfigSchemaDir(), "config.schema.json")).href}`;
}

function renderUserConfigTemplate(): string {
  return [
    renderConfigSchemaDirective(),
    "# Personal Sparkwright config. Keep API keys here; do not commit this file.",
    "# Created by `sparkwright init` or the first interactive run.",
    "identity:",
    "  model: openai/gpt-5.4-mini",
    "  providers:",
    "    openai:",
    "      baseURL: https://api.openai.com/v1",
    "      apiKey: REPLACE_WITH_YOUR_API_KEY",
    "      models:",
    "        gpt-5.4-mini: {}",
    "        gpt-5.4: {}",
    "",
    "    # anthropic:",
    "    #   npm: '@ai-sdk/anthropic'",
    "    #   baseURL: https://api.anthropic.com/v1",
    "    #   apiKey: REPLACE_WITH_YOUR_API_KEY",
    "    #   models:",
    "    #     claude-sonnet-4-6: {}",
    "    #     claude-haiku-4-5: {}",
    "",
    "    # google:",
    "    #   npm: '@ai-sdk/google'",
    "    #   baseURL: https://generativelanguage.googleapis.com/v1beta",
    "    #   apiKey: REPLACE_WITH_YOUR_API_KEY",
    "    #   models:",
    "    #     gemini-3.1-pro: {}",
    "    #     gemini-3-flash: {}",
    "",
    "# policy:",
    "#   confidentialDefaults: true",
    "#   write:",
    "#     maxFiles: 10",
    "#     allowDeletions: true",
    "#   confidentialPaths: ['.env', '.env.*', 'secrets/**']",
    "",
    "run:",
    "  accessMode: ask",
    "  traceLevel: standard",
    "  budget:",
    "    maxModelCalls: 80",
    "    maxCostUsd: 2.0",
    "",
    "# tasks:",
    "#   compaction:",
    "#     enabled: false",
    "#     # model defaults to identity.model when unset",
    "#     # model: openai/gpt-5.4-mini",
    "#     budget:",
    "#       maxSourceChars: 60000",
    "#       maxOutputTokens: 1600",
    "#       unknownCostPolicy: skip",
    "",
    "ui:",
    "  theme: dark",
    "  mouse: true",
    "",
    "# tools:",
    "#   use: [workspace.read, workspace.write, bash, planning, skills, agents, mcp]",
    "",
    "# capabilities:",
    "#   agents:",
    "#     # Optional: dynamic spawn_agent children. If unset, they inherit identity.model.",
    "#     # spawnModel: openai/gpt-5.4-mini",
    "#     # Optional: configured in-process delegates when Agent.md/profile model is unset.",
    "#     # delegateModel: openai/gpt-5.4-mini",
    "",
  ].join("\n");
}

function renderProjectConfigTemplate(): string {
  return [
    renderConfigSchemaDirective(),
    "# Project Sparkwright config. Safe to commit; keep provider keys in your user config.",
    "# Unset tools.use means all tools. Set it to a tightening selector whitelist.",
    "tools:",
    "  use: [workspace.read, workspace.write, bash, planning, skills]",
    `  defer: [${PROJECT_CONFIG_DEFERRED_TOOLS.join(", ")}]`,
    "",
    "policy:",
    "  write:",
    "    maxFiles: 5",
    "    maxDiffLines: 200",
    "    allowDeletions: true",
    "",
    "run:",
    "  accessMode: ask",
    "  budget:",
    "    maxModelCalls: 80",
    "    maxCostUsd: 2.0",
    "capabilities:",
    "  skills:",
    "    includeLoaderTool: true",
    "    loadSelectedSkills: false",
    "    resourceFileLimit: 8",
    "  agents:",
    "    maxDepth: 1",
    "  mcp:",
    "    startup: lazy",
    "    toolSchemaLoad: defer",
    "    servers: []",
    "",
  ].join("\n");
}

const PROJECT_CAPABILITY_DIRS = [
  "skills",
  "agents",
  "command",
  "workflows",
] as const;

/**
 * Scaffold the shared user config so first-time setup is "edit one file" rather
 * than "export a wall of env vars". With `--project`, scaffold the committable
 * project config surface at `<workspace>/.sparkwright/config.json` instead.
 * Never overwrites an existing file.
 */
async function handleInitCommand(
  io: CliIO,
  env: Record<string, string | undefined>,
  argv: readonly string[],
  cwd: string,
): Promise<CliRunResult> {
  const project = argv.includes("--project");
  return project ? scaffoldProjectConfig(io, cwd) : scaffoldUserConfig(io, env);
}

async function initConfigTarget(
  defaultJsonPath: string,
  defaultYamlPath: string,
): Promise<{ path: string; exists: boolean }> {
  const target = await resolveConfigWriteTarget(defaultJsonPath);
  return target.exists ? target : { path: defaultYamlPath, exists: false };
}

async function createUserConfigTemplateFile(
  env: Record<string, string | undefined>,
): Promise<{ status: "created" | "exists"; path: string }> {
  const { writeFile, mkdir, chmod } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const target = await initConfigTarget(
    userConfigPath(env),
    userConfigCandidatePaths(env)[1]!,
  );
  if (target.exists) {
    return { status: "exists", path: target.path };
  }

  await mkdir(dirname(target.path), { recursive: true });
  await writeFile(target.path, renderUserConfigTemplate(), {
    mode: 0o600,
  });
  // mkdir/umask can leave looser perms; force 600 since this holds a secret.
  await chmod(target.path, 0o600);
  return { status: "created", path: target.path };
}

async function scaffoldUserConfig(
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  let path = "";
  try {
    const result = await createUserConfigTemplateFile(env);
    path = result.path;

    if (result.status === "exists") {
      writeLine(io.stdout, `Config already exists: ${path}`);
      writeLine(io.stdout, "Edit it directly, or delete it and re-run init.");
      return { exitCode: 0 };
    }
  } catch (error) {
    writeLine(
      io.stderr,
      `Failed to write ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: 1 };
  }

  writeLine(io.stdout, `Created ${path}`);
  writeLine(
    io.stdout,
    'Next: set "identity.providers.<provider>.apiKey", then run `sparkwright tui`.',
  );
  writeLine(
    io.stdout,
    'The template enables openai by default and includes commented anthropic/google examples — switch with "identity.model: <provider>/<model>".',
  );
  return { exitCode: 0 };
}

async function scaffoldProjectConfig(
  io: CliIO,
  cwd: string,
): Promise<CliRunResult> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  let path = "";
  let configExists = false;

  try {
    const target = await initConfigTarget(
      projectConfigPathForWorkspace(cwd),
      projectConfigCandidatePaths(cwd)[1]!,
    );
    path = target.path;
    configExists = target.exists;
    // No secret here, so no forced 600: this file is meant to be committed.
    await mkdir(dirname(path), { recursive: true });
    if (!configExists) {
      await writeFile(path, renderProjectConfigTemplate());
    }
    for (const dir of PROJECT_CAPABILITY_DIRS) {
      await mkdir(join(dirname(path), dir), { recursive: true });
    }
  } catch (error) {
    writeLine(
      io.stderr,
      `Failed to scaffold project config at ${dirname(path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: 1 };
  }

  writeLine(
    io.stdout,
    configExists ? `Project config already exists: ${path}` : `Created ${path}`,
  );
  writeLine(
    io.stdout,
    "This file is safe to commit — it holds no secrets. Provider keys stay in your user config (`sparkwright init`).",
  );
  writeLine(
    io.stdout,
    "Created project capability directories: .sparkwright/skills, .sparkwright/agents, .sparkwright/command, .sparkwright/workflows",
  );
  writeLine(
    io.stdout,
    "Next: sparkwright capabilities inspect --workspace . --format text",
  );
  return { exitCode: 0 };
}

function runUsage(_env: Record<string, string | undefined>): string {
  return 'Usage: sparkwright run "your goal" [--image path] [--workspace path] [--session-root path] [--target README.md] [--confidential path-or-glob] [--access-mode read-only|ask|accept-edits|bypass] [--session-id id] [--model provider/model] [--workflow name]';
}

function usage(_env: Record<string, string | undefined>): string {
  return [
    "Usage: sparkwright init             # scaffold ~/.config/sparkwright/config.yaml",
    "       sparkwright init --project   # scaffold committable <workspace>/.sparkwright/config.yaml",
    "       sparkwright --version|-v      # print CLI package version",
    "       sparkwright tui [--workspace path] [--session-root path] [--model provider/model] [--access-mode read-only|ask|accept-edits|bypass] [--trace-level standard|debug] [--session-id id]",
    "       sparkwright acp [--workspace path] [--session-root path] [--model provider/model] [--access-mode read-only|ask|accept-edits|bypass] [--trace-level standard|debug]",
    "       sparkwright capabilities inspect [--workspace path] [--model provider/model] [--resolve-mcp] [--format json|text]",
    "       sparkwright doctor paths [--workspace path] [--session-root path] [--format json|text]",
    '       sparkwright cron create --schedule "every 1h" --prompt "task" [--name name]',
    "       sparkwright cron list|status|run|tick",
    "       sparkwright tasks list|get|output [--workspace path] [--root-dir path]",
    "       sparkwright workflow list|start|inspect|resume|distill [workflow-name-or-run-id] [--workspace path] [--format json|text]",
    '       sparkwright delegates run <external-delegate-tool> "goal" [--workspace path] [--access-mode read-only|ask|accept-edits|bypass] [--session-id id] [--trace-level standard|debug] [--format json|text]',
    "       sparkwright tools allow|disable|defer <tool-name...> [--workspace path]",
    "       sparkwright skills list|validate|review|restore [--workspace path] [--format json|text]",
    "       sparkwright skills review [--workspace path] [--session-root path] [--last n] [--skill name] [--skill-key key] [--package-hash hash] [--format json|text]",
    "       sparkwright skills stats [--workspace path] [--session-root path] [--last n] [--skill name] [--skill-key key] [--package-hash hash] [--format json|text]",
    "       sparkwright skills doctor [--workspace path] [--format json|text]",
    "       sparkwright skills reconcile scan|list|adopt|move|copy|reidentify|orphan [--workspace path] [--format json|text]",
    "       sparkwright skills proposals list|show|create|update|apply|reject|supersede|prune [--workspace path] [--format json|text]",
    "       sparkwright skills history <skill-name> [--workspace path] [--format json|text]",
    '       sparkwright skills create <name> --description "what it does" [--workspace path] [--root .sparkwright/skills]',
    "       sparkwright agents list|validate [--workspace path] [--format json|text]",
    '       sparkwright agents create <id> --prompt "what it should do" [--use selector] [--allow tool] [--delegate tool_name] [--workspace path] [--force]',
    '       sparkwright run "your goal" [--image path] [--workspace path] [--session-root path] [--target README.md] [--confidential path-or-glob] [--access-mode read-only|ask|accept-edits|bypass] [--session-id id] [--model provider/model] [--workflow name] [--verbose]',
    "       sparkwright trace summary <trace.jsonl> [--format json|text]",
    "       sparkwright trace events <trace.jsonl> [--type event.type] [--run-id id] [--contains text] [--limit n] [--jsonl] [--format json|text]",
    "       sparkwright trace timeline <trace.jsonl> [--run-id id] [--format json|text]",
    "       sparkwright trace report <trace.jsonl> [--format json|text]",
    "       sparkwright trace verify <trace.jsonl> [--format json|text]",
    "       sparkwright session <summary|inspect|check|repair|compact> <session-id> [--workspace path] [--session-root path] [--format json|text] [--apply] [--compaction]",
    '       sparkwright session resume <session-id> "next goal" [--workspace path] [--session-root path] [--target README.md] [--access-mode read-only|ask|accept-edits|bypass] [--model provider/model] [--verbose]',
    "       sparkwright run resume <run-id> [--session <session-id>] [--workspace path] [--session-root path] [--force] [--from-trace] [--model provider/model] [--verbose]",
  ].join("\n");
}

function toolsUsage(): string {
  return [
    "Usage: sparkwright tools allow <tool-name...> [--workspace path]",
    "       sparkwright tools disable <tool-name...> [--workspace path]",
    "       sparkwright tools defer <tool-name...> [--workspace path]",
  ].join("\n");
}

function tasksUsage(): string {
  return [
    "Usage: sparkwright tasks list [--workspace path] [--root-dir path] [--status status] [--kind kind] [--run-id id] [--format json|text]",
    "       sparkwright tasks get <task-id> [--workspace path] [--root-dir path]",
    "       sparkwright tasks output <task-id> [--workspace path] [--root-dir path] [--from-sequence n] [--max-chunks n]",
  ].join("\n");
}

function workflowUsage(): string {
  return [
    "Usage: sparkwright workflow list [--workspace path] [--format json|text]",
    "       sparkwright workflow start <workflow-name> <goal...> [--workspace path] [--model provider/model] [--detach]",
    "       sparkwright workflow service <run|status|drain> [--workspace path]",
    "       sparkwright workflow stop <workflow-run-id> [--workspace path]",
    "       sparkwright workflow inspect <workflow-name> [--workspace path] [--format json|text]",
    "       sparkwright workflow resume <workflow-run-id> [--workspace path] [--session <session-id>] [--model provider/model]",
    "       sparkwright workflow distill <session-id> [--workspace path] [--session-root path] [--format json|text]",
    "       sparkwright workflow shadow <workflow-name> <session-id> [--workspace path] [--session-root path] [--format json|text]",
    "       sparkwright workflow stats [--workspace path] [--session-root path] [--format json|text]",
  ].join("\n");
}

function skillsUsage(): string {
  return [
    "Usage: sparkwright skills list [--workspace path] [--format json|text]",
    "       sparkwright skills validate [--workspace path] [--format json|text]",
    "       sparkwright skills review [--workspace path] [--session-root path] [--last n] [--skill name] [--skill-key key] [--package-hash hash] [--format json|text]",
    "       sparkwright skills review dismiss <suggestion-id> [--workspace path]",
    "       sparkwright skills stats [--workspace path] [--session-root path] [--last n] [--skill name] [--skill-key key] [--package-hash hash] [--format json|text]",
    "       sparkwright skills doctor [--workspace path] [--format json|text]",
    "       sparkwright skills proposals list [--run <run-id>] [--session <session-id>] [--workspace path] [--format json|text]",
    "       sparkwright skills proposals show <id> [--workspace path] [--format json|text]",
    "       sparkwright skills proposals apply <id> [--force] [--workspace path] [--format json|text]",
    '       sparkwright skills proposals reject <id> --reason "why" [--workspace path] [--format json|text]',
    '       sparkwright skills proposals supersede <id> --by <new-id> [--reason "why"] [--workspace path] [--format json|text]',
    "       sparkwright skills proposals prune [--state rejected,stale,superseded,failed] [--older-than 30d] [--dry-run|--apply] [--workspace path] [--format json|text]",
    "       sparkwright skills history <skill-name> [--workspace path] [--format json|text]",
    "       sparkwright skills history show <skill-name> <history-id> [--workspace path] [--format json|text]",
    "       sparkwright skills history diff <skill-name> <history-id> [--workspace path] [--format json|text]",
    "       sparkwright skills restore <skill-name> --version <history-id> [--to before|after] [--dry-run|--apply] [--workspace path] [--format json|text]",
    '       sparkwright skills proposals create <name> --description "what it does" [--workspace path] [--format json|text]',
    '       sparkwright skills proposals update <name> --description "what should change" [--workspace path] [--format json|text]',
    '       sparkwright skills create <name> --description "what it does" [--workspace path] [--root .sparkwright/skills]',
  ].join("\n");
}

function skillProposalsUsage(): string {
  return [
    "Usage: sparkwright skills proposals list [--run <run-id>] [--session <session-id>] [--workspace path] [--format json|text]",
    "       sparkwright skills proposals show <id> [--workspace path] [--format json|text]",
    "       sparkwright skills proposals apply <id> [--force] [--workspace path] [--format json|text]",
    '       sparkwright skills proposals reject <id> --reason "why" [--workspace path] [--format json|text]',
    '       sparkwright skills proposals supersede <id> --by <new-id> [--reason "why"] [--workspace path] [--format json|text]',
    "       sparkwright skills proposals prune [--state rejected,stale,superseded,failed] [--older-than 30d] [--dry-run|--apply] [--workspace path] [--format json|text]",
    '       sparkwright skills proposals create <name> --description "what it does" [--workspace path] [--format json|text]',
    '       sparkwright skills proposals update <name> --description "what should change" [--workspace path] [--format json|text]',
  ].join("\n");
}

function agentsUsage(): string {
  return [
    "Usage: sparkwright agents list [--workspace path] [--format json|text]",
    "       sparkwright agents validate [--workspace path] [--format json|text]",
    "       sparkwright agents stats [--workspace path] [--session-root path] [--format json|text]",
    '       sparkwright agents create <id> --prompt "what it should do" [--name text] [--model provider/model] [--use selector] [--allow tool] [--deny tool] [--delegate tool_name] [--max-steps n] [--workspace path] [--force]',
  ].join("\n");
}
