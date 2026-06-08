import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  asSessionId,
  buildTraceTimelineFile,
  createSessionId,
  createPermissionModePolicy,
  FileSessionStore,
  loadCheckpointFromRunDir,
  loadTraceEventsFile,
  projectSessionReplayToContextItems,
  repairSessionTraceConsistency,
  resumeRunFromCheckpoint,
  summarizeTraceFile,
  validateSessionTraceConsistency,
  type PermissionMode,
  type RunRecord,
  type SessionTraceConsistencyReport,
  type SessionTraceRepairReport,
  type TraceSummary,
  type TraceTimeline,
  type TraceLevel,
} from "@sparkwright/core";
import {
  createSessionFileRunStoreFactory,
  FileRunStore,
  LocalWorkspace,
} from "@sparkwright/core/internal";
import {
  CronStore,
  defaultCronRoot,
  legacyConfigCronRoot,
  runCronJobByRef,
  tickCron,
  type CreateJobInput,
  type UpdateJobPatch,
} from "@sparkwright/cron";
import { type SkillRoot } from "@sparkwright/skills";
import {
  loadLayeredSkillReport,
  loadLayeredAgentReport,
  loadHostConfig,
  existingSkillRoots,
  projectSkillRoot,
  resolveCapabilityDirs,
  resolveSkillRootsForRuntime,
  runConfiguredDelegate,
  userConfigPath,
  type AgentReport,
  type SkillReport,
} from "@sparkwright/host";
import { createCliApprovalResolver } from "./cli-approval.js";
import { formatEvent } from "./event-format.js";
import type { CliIO } from "./io.js";
import { writeLine } from "./io.js";
import {
  createCliModel,
  createConfiguredCliTools,
  startDirectCoreRun,
} from "./runners/direct-core-runner.js";
import { resumeHostRun, startHostRun } from "./runners/host-runner.js";

export type { CliIO } from "./io.js";

export interface CliRunResult {
  exitCode: number;
  tracePath?: string;
  sessionId?: string;
  runState?: string;
  stopReason?: string;
}

interface ParsedArgs {
  command: string;
  subcommand?: string;
  goal: string;
  target?: string;
  traceLevel: TraceLevel;
  workspaceRoot: string;
  targetPath: string;
  shouldWrite: boolean;
  approveAll: boolean;
  permissionMode: PermissionMode;
  /** Model reference in "provider/model" form, or the reserved "deterministic". */
  modelName?: string;
  modelNameSource?: "config" | "cli";
  sessionId?: string;
  format: "json" | "text";
  eventType?: string;
  runId?: string;
  contains?: string;
  limit?: number;
  afterSequence?: number;
  beforeSequence?: number;
  jsonl: boolean;
  apply: boolean;
  force: boolean;
  fromTrace: boolean;
  directCore: boolean;
  delegateGoal?: string;
}

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

  const helpText = helpForArgs(argv);
  if (helpText) {
    writeLine(io.stdout, helpText);
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

  const parsed = parseArgs(argv, cwd, {
    model: cfg.config.model,
    permissionMode: cfg.config.permissionMode,
    workspace: cfg.config.workspace,
  });

  if (!parsed.ok) {
    writeLine(io.stderr, parsed.message);
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
    return handleSessionCommand(parsed.value, io);
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

  if (command === "capabilities") {
    return handleCapabilitiesCommand(parsed.value, io, env);
  }

  if (command === "delegates") {
    return handleDelegatesCommand(parsed.value, io, env);
  }

  if (command === "skills") {
    return handleSkillsCommand(parsed.value, io, env);
  }

  if (command === "agents") {
    return handleAgentsCommand(parsed.value, io);
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
    writeLine(io.stderr, usage());
    return { exitCode: 1 };
  }

  return parsed.value.directCore
    ? startDirectCoreRun(
        {
          ...parsed.value,
          sessionId: parsed.value.sessionId ?? createSessionId(),
          contextItems: [],
        },
        io,
        env,
      )
    : startHostRun(
        {
          ...parsed.value,
          modelName:
            parsed.value.modelNameSource === "cli"
              ? parsed.value.modelName
              : undefined,
          sessionId: parsed.value.sessionId ?? createSessionId(),
        },
        io,
        env,
      );
}

interface ConfigDefaults {
  model?: string;
  permissionMode?: PermissionMode;
  workspace?: string;
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
    "capabilities",
    "delegates",
    "skills",
    "agents",
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
    command === "capabilities" ||
    command === "delegates" ||
    command === "skills" ||
    command === "agents"
  ) {
    subcommand = args.shift();
  } else if (command === "run" && args[0] === "resume") {
    // `sparkwright run resume <run-id>` — distinct from the freeform
    // `sparkwright run "<goal>"` path.
    subcommand = args.shift();
  }
  let traceLevel: TraceLevel = "standard";
  let workspaceRoot = defaults.workspace ?? cwd;
  let targetPath = "README.md";
  let shouldWrite = false;
  let approveAll = false;
  let permissionMode: PermissionMode = defaults.permissionMode ?? "default";
  let modelName: string | undefined = defaults.model;
  let modelNameSource: ParsedArgs["modelNameSource"] = defaults.model
    ? "config"
    : undefined;
  let sessionId: string | undefined;
  let format: ParsedArgs["format"] = "json";
  let eventType: string | undefined;
  let runId: string | undefined;
  let contains: string | undefined;
  let limit: number | undefined;
  let afterSequence: number | undefined;
  let beforeSequence: number | undefined;
  let jsonl = false;
  let apply = false;
  let force = false;
  let fromTrace = false;
  let directCore = false;
  let delegateGoal: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--trace-level") {
      const value = args[index + 1];
      if (!isTraceLevel(value))
        return {
          ok: false,
          message:
            "Usage: --trace-level must be one of: minimal, standard, debug",
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
      workspaceRoot = value;
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
      args.splice(index, 2);
      index -= 1;
      continue;
    }

    if (arg === "--write") {
      shouldWrite = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--yes") {
      approveAll = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (arg === "--permission-mode") {
      const value = args[index + 1];
      if (!isPermissionMode(value)) {
        return {
          ok: false,
          message:
            "Usage: --permission-mode must be one of: plan, default, accept_edits, dont_ask, bypass_permissions",
        };
      }
      permissionMode = value;
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

    if (arg === "--contains") {
      const value = args[index + 1];
      if (!value)
        return { ok: false, message: "Usage: --contains requires text" };
      contains = value;
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

  const target = args[0];

  if (
    command === "trace" &&
    subcommand !== "summary" &&
    subcommand !== "events" &&
    subcommand !== "timeline"
  ) {
    return {
      ok: false,
      message:
        "Usage: sparkwright trace <summary|events|timeline> <trace.jsonl>",
    };
  }

  if (
    command === "session" &&
    subcommand !== "summary" &&
    subcommand !== "check" &&
    subcommand !== "repair" &&
    subcommand !== "resume"
  ) {
    return {
      ok: false,
      message:
        "Usage: sparkwright session <summary|check|repair|resume> <session-id> [goal] [--workspace path]",
    };
  }

  if (
    command === "tools" &&
    subcommand !== "list" &&
    subcommand !== "enable" &&
    subcommand !== "disable" &&
    subcommand !== "defer"
  ) {
    return {
      ok: false,
      message:
        "Usage: sparkwright tools <list|enable|disable|defer> [tool-pattern ...]",
    };
  }

  if (command === "capabilities" && subcommand !== "inspect") {
    return {
      ok: false,
      message:
        "Usage: sparkwright capabilities inspect [--workspace path] [--format json|text]",
    };
  }

  if (command === "delegates" && subcommand !== "run") {
    return {
      ok: false,
      message:
        'Usage: sparkwright delegates run <toolName> "goal" [--workspace path] [--yes] [--format json|text]',
    };
  }

  if (
    command === "skills" &&
    subcommand !== "list" &&
    subcommand !== "create" &&
    subcommand !== "validate"
  ) {
    return {
      ok: false,
      message:
        "Usage: sparkwright skills <list|create|validate> [name] [--description text]",
    };
  }

  if (
    command === "agents" &&
    subcommand !== "list" &&
    subcommand !== "create" &&
    subcommand !== "validate"
  ) {
    return {
      ok: false,
      message:
        "Usage: sparkwright agents <list|create|validate> [id] [--prompt text]",
    };
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
        "Usage: sparkwright run resume <run-id> [--session <session-id>] [--workspace path] [--force] [--from-trace]",
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
      subcommand === "run");
  const effectiveGoal =
    command === "cron"
      ? (cronRefCommand ? args.slice(1) : args).join("\0")
      : command === "tools" ||
          command === "capabilities" ||
          command === "delegates" ||
          command === "skills" ||
          command === "agents"
        ? args.join("\0")
        : goal;

  return {
    ok: true,
    value: {
      command,
      subcommand,
      goal: effectiveGoal,
      target,
      traceLevel,
      workspaceRoot,
      targetPath,
      shouldWrite,
      approveAll,
      permissionMode,
      modelName,
      modelNameSource,
      sessionId,
      format,
      eventType,
      runId,
      contains,
      limit,
      afterSequence,
      beforeSequence,
      jsonl,
      apply,
      force,
      fromTrace,
      directCore,
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
    subcommand !== "list" &&
    subcommand !== "enable" &&
    subcommand !== "disable" &&
    subcommand !== "defer"
  ) {
    writeLine(io.stderr, toolsUsage());
    return { exitCode: 1 };
  }

  const patterns = splitCliWords(parsed.goal);
  if (subcommand !== "list" && patterns.length === 0) {
    writeLine(io.stderr, `Usage: sparkwright tools ${subcommand} <pattern...>`);
    return { exitCode: 1 };
  }

  try {
    const path = userConfigPath(env);
    const loaded = await readUserConfigObject(path);
    const before = getToolsConfig(loaded.value);

    if (subcommand === "list") {
      writeLine(
        io.stdout,
        formatToolsConfig({
          path,
          exists: loaded.exists,
          tools: before,
          format: parsed.format,
        }),
      );
      return { exitCode: 0 };
    }

    const next = updateToolsConfig(before, subcommand, patterns);
    setToolsConfig(loaded.value, next);
    await writeUserConfigObject(path, loaded.value);
    writeLine(
      io.stdout,
      formatToolsConfig({
        path,
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

type ToolConfigAction = "enable" | "disable" | "defer";

interface ToolsConfigShape {
  enabled?: string[];
  disabled?: string[];
  defer?: string[];
}

function updateToolsConfig(
  current: ToolsConfigShape,
  action: ToolConfigAction,
  patterns: string[],
): ToolsConfigShape {
  const next: ToolsConfigShape = {
    enabled: current.enabled ? [...current.enabled] : undefined,
    disabled: current.disabled ? [...current.disabled] : undefined,
    defer: current.defer ? [...current.defer] : undefined,
  };
  if (action === "enable") {
    next.enabled = addUnique(next.enabled ?? [], patterns);
    next.disabled = removeEntries(next.disabled, patterns);
  } else if (action === "disable") {
    next.disabled = addUnique(next.disabled ?? [], patterns);
    next.enabled = removeEntries(next.enabled, patterns);
  } else {
    next.defer = addUnique(next.defer ?? [], patterns);
  }
  return pruneEmptyToolConfig(next);
}

function pruneEmptyToolConfig(config: ToolsConfigShape): ToolsConfigShape {
  return {
    ...(config.enabled && config.enabled.length > 0
      ? { enabled: config.enabled }
      : {}),
    ...(config.disabled && config.disabled.length > 0
      ? { disabled: config.disabled }
      : {}),
    ...(config.defer && config.defer.length > 0 ? { defer: config.defer } : {}),
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

function removeEntries(
  current: string[] | undefined,
  removals: string[],
): string[] | undefined {
  if (!current) return undefined;
  const remove = new Set(removals);
  return current.filter((entry) => !remove.has(entry));
}

async function readUserConfigObject(path: string): Promise<{
  exists: boolean;
  value: Record<string, unknown>;
}> {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error(`${path} must contain a JSON object.`);
    }
    return { exists: true, value: parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, value: {} };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${path}: ${error.message}`);
    }
    throw error;
  }
}

async function writeUserConfigObject(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

function getToolsConfig(config: Record<string, unknown>): ToolsConfigShape {
  const capabilities = config.capabilities;
  if (!isPlainObject(capabilities)) return {};
  const tools = capabilities.tools;
  if (!isPlainObject(tools)) return {};
  return {
    enabled: stringArrayOrUndefined(tools.enabled),
    disabled: stringArrayOrUndefined(tools.disabled),
    defer: stringArrayOrUndefined(tools.defer),
  };
}

function setToolsConfig(
  config: Record<string, unknown>,
  tools: ToolsConfigShape,
): void {
  const capabilities = isPlainObject(config.capabilities)
    ? config.capabilities
    : {};
  capabilities.tools = tools;
  config.capabilities = capabilities;
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
    `enabled: ${formatPatternList(input.tools.enabled, "(all)")}`,
    `disabled: ${formatPatternList(input.tools.disabled, "(none)")}`,
    `defer: ${formatPatternList(input.tools.defer, "(none)")}`,
  ].join("\n");
}

function formatPatternList(
  values: string[] | undefined,
  emptyLabel: string,
): string {
  return values && values.length > 0 ? values.join(", ") : emptyLabel;
}

interface CapabilityInspectReport {
  workspace: string;
  config: {
    errors: Array<{ file: string; field: string; message: string }>;
  };
  tools: ToolsConfigShape;
  skills: SkillReport;
  agents: AgentReport & {
    delegateTools: Array<{ profileId: string; toolName?: string }>;
  };
  mcp: {
    servers: Array<{ name: string; type: string; enabled: boolean }>;
    defaultTimeoutMs?: number;
    namePrefix?: string;
  };
  cron: {
    stateRoot: string;
    legacyStateRoot: string;
  };
  command: {
    dirs: Array<{ layer: string; path: string; exists: boolean }>;
  };
}

async function handleCapabilitiesCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  if (parsed.subcommand !== "inspect") {
    writeLine(io.stderr, capabilitiesUsage());
    return { exitCode: 1 };
  }

  try {
    const report = await loadCapabilityInspectReport(parsed.workspaceRoot, env);
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(report, null, 2)
        : formatCapabilityInspectReport(report),
    );
    return { exitCode: report.config.errors.length > 0 ? 1 : 0 };
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1 };
  }
}

async function handleDelegatesCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  if (parsed.subcommand !== "run") {
    writeLine(io.stderr, delegatesUsage());
    return { exitCode: 1 };
  }

  const words = splitCliWords(parsed.goal);
  const toolName = words[0];
  const goal = parsed.delegateGoal ?? words.slice(1).join(" ").trim();
  if (!toolName || !goal) {
    writeLine(io.stderr, delegatesUsage());
    return { exitCode: 1 };
  }

  const result = await runConfiguredDelegate({
    workspaceRoot: parsed.workspaceRoot,
    toolName,
    goal,
    env,
    sessionId: parsed.sessionId ?? createSessionId(),
    traceLevel: parsed.traceLevel,
    approvalResolver: createCliApprovalResolver({
      approveAll: parsed.approveAll,
      io,
    }),
  });

  if (!result.ok) {
    writeLine(io.stderr, result.message);
    if (parsed.format === "json") {
      writeLine(io.stdout, JSON.stringify(result, null, 2));
    }
    return { exitCode: 1 };
  }

  writeLine(
    io.stdout,
    parsed.format === "json"
      ? JSON.stringify(result, null, 2)
      : formatDelegateRunResult(result),
  );
  return {
    exitCode: 0,
    tracePath: result.tracePath,
    sessionId: result.sessionId,
  };
}

function formatDelegateRunResult(
  result: Extract<
    Awaited<ReturnType<typeof runConfiguredDelegate>>,
    { ok: true }
  >,
): string {
  const lines = [
    `delegate.completed ${result.toolName} -> ${result.profileId} (${result.protocol})`,
  ];
  if (result.sessionId) {
    lines.push(`sessionId: ${result.sessionId}`);
  }
  if (result.tracePath) {
    lines.push(`trace: ${result.tracePath}`);
  }
  const output = result.output;
  if (isPlainObject(output)) {
    if (typeof output.exitCode === "number") {
      lines.push(`exitCode: ${output.exitCode}`);
    }
    if (typeof output.stopReason === "string") {
      lines.push(`stopReason: ${output.stopReason}`);
    }
    if (typeof output.stdout === "string" && output.stdout.length > 0) {
      lines.push("stdout:", output.stdout.trimEnd());
    }
    if (typeof output.stderr === "string" && output.stderr.length > 0) {
      lines.push("stderr:", output.stderr.trimEnd());
    }
    if (typeof output.message === "string" && output.message.length > 0) {
      lines.push("message:", output.message.trimEnd());
    }
  } else {
    lines.push(JSON.stringify(output, null, 2));
  }
  return lines.join("\n");
}

async function loadCapabilityInspectReport(
  workspaceRoot: string,
  env: Record<string, string | undefined>,
): Promise<CapabilityInspectReport> {
  const loaded = await loadHostConfig(workspaceRoot, env);
  const capabilities = loaded.config.capabilities;
  const skillRoots = resolveSkillRootsForRuntime(
    workspaceRoot,
    capabilities?.skills?.roots,
    env,
  );
  const skills = await loadLayeredSkillReport(skillRoots, {
    includeMissingRoots: false,
  });
  const agents = await loadLayeredAgentReport(
    workspaceRoot,
    capabilities?.agents?.profiles,
    env,
  );

  const commandDirs = await Promise.all(
    resolveCapabilityDirs("command", { cwd: workspaceRoot, env }).map(
      async (dir) => ({
        layer: dir.layer,
        path: dir.dir,
        exists: await pathExists(dir.dir),
      }),
    ),
  );

  return {
    workspace: workspaceRoot,
    config: { errors: loaded.errors },
    tools: capabilities?.tools ?? {},
    skills,
    agents: {
      ...agents,
      delegateTools: (capabilities?.agents?.delegateTools ?? []).map(
        (tool) => ({
          profileId: tool.profileId,
          toolName: tool.toolName,
        }),
      ),
    },
    mcp: {
      servers: (capabilities?.mcp?.servers ?? []).map((server) => ({
        name: server.name,
        type: server.type,
        enabled: server.enabled !== false,
      })),
      defaultTimeoutMs: capabilities?.mcp?.defaultTimeoutMs,
      namePrefix: capabilities?.mcp?.namePrefix,
    },
    cron: {
      stateRoot: defaultCronRoot(env),
      legacyStateRoot: legacyConfigCronRoot(env),
    },
    command: { dirs: commandDirs },
  };
}

async function pathExists(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function formatCapabilityInspectReport(
  report: CapabilityInspectReport,
): string {
  const lines = [
    `workspace: ${report.workspace}`,
    `tools: enabled=${formatPatternList(report.tools.enabled, "(all)")}; disabled=${formatPatternList(report.tools.disabled, "(none)")}; defer=${formatPatternList(report.tools.defer, "(none)")}`,
    `skills: ${report.skills.skills.length} effective, ${report.skills.roots.length} roots, ${report.skills.shadows.length} shadows, ${report.skills.errors.length} errors`,
  ];
  for (const root of report.skills.roots) lines.push(`  root: ${root}`);
  for (const skill of report.skills.skills) {
    lines.push(`  - ${skill.name}${skill.layer ? ` (${skill.layer})` : ""}`);
  }
  lines.push(
    `agents: ${report.agents.profiles.length} effective, ${report.agents.roots.length} roots, ${report.agents.shadows.length} shadows, ${report.agents.errors.length} errors, ${report.agents.delegateTools.length} delegate tools`,
  );
  for (const agent of report.agents.profiles) {
    lines.push(
      `  - ${agent.id}${agent.name ? ` (${agent.name})` : ""}: ${agent.layer}`,
    );
  }
  if (report.agents.shadows.length > 0) {
    lines.push(`agent shadows: ${report.agents.shadows.length}`);
    for (const shadow of report.agents.shadows) {
      lines.push(
        `  - ${shadow.id}: ${formatAgentOrigin(
          shadow.shadowed,
        )} shadowed by ${formatAgentOrigin(shadow.shadowedBy)}`,
      );
    }
  }
  lines.push(`mcp: ${report.mcp.servers.length} servers`);
  for (const server of report.mcp.servers) {
    lines.push(
      `  - ${server.name}: ${server.type}${server.enabled ? "" : " disabled"}`,
    );
  }
  lines.push(`cron state: ${report.cron.stateRoot}`);
  lines.push(`cron legacy state: ${report.cron.legacyStateRoot}`);
  lines.push("command dirs:");
  for (const dir of report.command.dirs) {
    lines.push(
      `  - ${dir.layer}: ${dir.path}${dir.exists ? "" : " (optional, missing)"}`,
    );
  }
  if (report.config.errors.length > 0) {
    lines.push(`config errors: ${report.config.errors.length}`);
    for (const error of report.config.errors) {
      lines.push(`  - ${error.file}: ${error.field}: ${error.message}`);
    }
  }
  return lines.join("\n");
}

function formatAgentOrigin(agent: {
  layer?: string;
  source?: string;
  root?: string;
}): string {
  return `${agent.layer ?? "unknown"}:${agent.source ?? agent.root ?? "config"}`;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitCliWords(input: string): string[] {
  if (input.includes("\0")) {
    return input
      .split("\0")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return input
    .split(/\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
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
    subcommand !== "validate"
  ) {
    writeLine(io.stderr, skillsUsage());
    return { exitCode: 1 };
  }

  try {
    if (subcommand === "create") {
      return handleSkillsCreate(parsed, io);
    }

    const roots = await resolveSkillRootsForCli(parsed.workspaceRoot, env);
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

async function handleSkillsCreate(
  parsed: ParsedArgs,
  io: CliIO,
): Promise<CliRunResult> {
  const input = parseSkillsCreateArgs(splitCliWords(parsed.goal));
  if (!input.ok) {
    writeLine(io.stderr, input.message);
    return { exitCode: 1 };
  }
  const root = input.value.root
    ? isAbsolute(input.value.root)
      ? input.value.root
      : resolve(parsed.workspaceRoot, input.value.root)
    : projectSkillRoot(parsed.workspaceRoot);
  const skillDir = join(root, input.value.name);
  const skillPath = join(skillDir, "SKILL.md");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");

  if (existsSync(skillPath) && !parsed.force) {
    writeLine(
      io.stderr,
      `Skill already exists: ${skillPath}. Re-run with --force to overwrite.`,
    );
    return { exitCode: 1 };
  }

  await mkdir(skillDir, { recursive: true });
  await writeFile(
    skillPath,
    renderSkillTemplate(input.value.name, input.value.description),
    "utf8",
  );
  // Display with forward slashes so output is stable across platforms
  // (Windows would otherwise print backslashes).
  writeLine(io.stdout, `Created ${skillPath.split(sep).join("/")}`);
  return { exitCode: 0 };
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
  if (!name || !isSkillName(name)) {
    return {
      ok: false,
      message:
        "Usage: sparkwright skills create <name> --description <text> [--root path]",
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

function renderSkillTemplate(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    'version: "1.0.0"',
    "metadata:",
    '  version: "1.0.0"',
    "---",
    "",
    `Use this skill when the user asks for ${description}`,
    "",
  ].join("\n");
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
): Promise<CliRunResult> {
  const subcommand = parsed.subcommand;
  if (
    subcommand !== "list" &&
    subcommand !== "create" &&
    subcommand !== "validate"
  ) {
    writeLine(io.stderr, agentsUsage());
    return { exitCode: 1 };
  }

  const configPath = projectConfigPathForWorkspace(parsed.workspaceRoot);
  try {
    const loaded = await readUserConfigObject(configPath);
    const agents = getAgentsConfig(loaded.value);

    if (subcommand === "create") {
      const input = parseAgentsCreateArgs(splitCliWords(parsed.goal));
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
      await writeUserConfigObject(configPath, loaded.value);
      writeLine(io.stdout, `Updated ${configPath}`);
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

    const report = validateAgentConfig(agents);
    if (parsed.format === "json") {
      writeLine(
        io.stdout,
        JSON.stringify(
          {
            path: configPath,
            exists: loaded.exists,
            agents,
            errors: report.errors,
          },
          null,
          2,
        ),
      );
    } else {
      writeLine(
        io.stdout,
        formatAgentReport({
          path: configPath,
          exists: loaded.exists,
          agents,
          errors: report.errors,
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

interface AgentProfileConfigShape {
  id: string;
  name?: string;
  description?: string;
  mode?: "primary" | "child" | "all";
  prompt?: string;
  allowedTools?: string[];
  deniedTools?: string[];
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
}

function parseAgentsCreateArgs(args: string[]):
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
        "Usage: sparkwright agents create <id> --prompt <text> [--name text] [--allow tool] [--max-steps n] [--delegate tool_name]",
    };
  }

  let name: string | undefined;
  let description: string | undefined;
  let mode: AgentProfileConfigShape["mode"] = "child";
  let prompt: string | undefined;
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
    prompt: prompt.trim(),
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
  };
  config.capabilities = capabilities;
}

function validateAgentConfig(agents: AgentsConfigShape): {
  errors: Array<{ field: string; message: string }>;
} {
  const errors: Array<{ field: string; message: string }> = [];
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
  errors: Array<{ field: string; message: string }>;
}): string {
  const lines = [
    `config: ${input.path}${input.exists ? "" : " (not created yet)"}`,
    `agents: ${input.agents.profiles.length}`,
  ];
  for (const profile of input.agents.profiles) {
    lines.push(
      `- ${profile.id}${profile.name ? ` (${profile.name})` : ""}${profile.mode ? ` · ${profile.mode}` : ""}`,
    );
    if (profile.allowedTools?.length) {
      lines.push(`  allow: ${profile.allowedTools.join(", ")}`);
    }
    if (profile.deniedTools?.length) {
      lines.push(`  deny: ${profile.deniedTools.join(", ")}`);
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
  if (input.errors.length > 0) {
    lines.push(`errors: ${input.errors.length}`);
    for (const error of input.errors) {
      lines.push(`- ${error.field}: ${error.message}`);
    }
  }
  return lines.join("\n");
}

function isAgentId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function projectConfigPathForWorkspace(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "config.json");
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
    legacyRootDir: legacyConfigCronRoot(env),
  });

  try {
    if (subcommand === "list") {
      const jobs = await store.listJobs();
      writeLine(io.stdout, JSON.stringify({ rootDir, jobs }, null, 2));
      return { exitCode: 0 };
    }

    if (subcommand === "create") {
      const jobInput = cronCreateInput(cron.value);
      if (!jobInput.ok) {
        writeLine(io.stderr, jobInput.message);
        return { exitCode: 1 };
      }
      const job = await store.createJob(jobInput.value);
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
      const job = await store.updateJob(ref, patch.value);
      writeLine(io.stdout, JSON.stringify(job, null, 2));
      return { exitCode: 0 };
    }

    if (subcommand === "pause") {
      writeLine(io.stdout, JSON.stringify(await store.pauseJob(ref), null, 2));
      return { exitCode: 0 };
    }

    if (subcommand === "resume") {
      writeLine(io.stdout, JSON.stringify(await store.resumeJob(ref), null, 2));
      return { exitCode: 0 };
    }

    if (subcommand === "remove") {
      writeLine(io.stdout, JSON.stringify(await store.removeJob(ref), null, 2));
      return { exitCode: 0 };
    }

    if (subcommand === "run") {
      const model = await createCliModel({
        modelRef: parsed.modelName,
        cwd: parsed.workspaceRoot,
        env,
        targetPath: parsed.targetPath,
        shouldWrite: parsed.shouldWrite,
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
        tools: await createConfiguredCliTools(parsed.workspaceRoot, env),
        approvalResolver: createCliApprovalResolver({
          approveAll: parsed.approveAll,
          io,
        }),
        permissionMode: parsed.permissionMode,
        skillRoots: cron.value.skillRoots,
      });
      writeLine(
        io.stdout,
        JSON.stringify({ jobId: job.id, jobName: job.name, result }, null, 2),
      );
      return { exitCode: result.ok ? 0 : 1 };
    }

    const model = await createCliModel({
      modelRef: parsed.modelName,
      cwd: parsed.workspaceRoot,
      env,
      targetPath: parsed.targetPath,
      shouldWrite: parsed.shouldWrite,
      goal: "cron tick",
    });
    if (!model.ok) {
      writeLine(io.stderr, model.message);
      return { exitCode: 1 };
    }
    const result = await tickCron({
      rootDir,
      store,
      model: model.adapter,
      tools: await createConfiguredCliTools(parsed.workspaceRoot, env),
      approvalResolver: createCliApprovalResolver({
        approveAll: parsed.approveAll,
        io,
      }),
      permissionMode: parsed.permissionMode,
      skillRoots: cron.value.skillRoots,
    });
    writeLine(io.stdout, JSON.stringify(result, null, 2));
    return { exitCode: 0 };
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
  deliver?: "local" | "origin";
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
    } else if (arg === "--deliver") {
      if (next !== "local" && next !== "origin") {
        return {
          ok: false,
          message: "Usage: --deliver must be local or origin",
        };
      }
      out.deliver = next;
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
      ...(args.deliver ? { deliver: args.deliver } : {}),
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
  if (args.deliver !== undefined) patch.deliver = args.deliver;
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
  | "run"
  | "tick" {
  return (
    value === "list" ||
    value === "create" ||
    value === "update" ||
    value === "pause" ||
    value === "resume" ||
    value === "remove" ||
    value === "run" ||
    value === "tick"
  );
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
    'Usage: sparkwright cron create --schedule "every 1h" --prompt "task" [--name name] [--skill name] [--repeat n|forever]',
    "       sparkwright cron list",
    "       sparkwright cron update <job-id-or-name> [--schedule text] [--prompt text] [--name text]",
    "       sparkwright cron pause|resume|remove <job-id-or-name>",
    "       sparkwright cron run <job-id-or-name> [--model provider/model] [--yes]",
    "       sparkwright cron tick [--model provider/model] [--yes]",
  ].join("\n");
}

function helpForArgs(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined;
  if (isHelpArg(argv[0])) return usage();

  const command = argv[0];
  if (!isHelpArg(argv[1])) return undefined;

  if (command === "init") {
    return [
      "Usage: sparkwright init",
      "       sparkwright init --project",
    ].join("\n");
  }
  if (command === "run") {
    return 'Usage: sparkwright run "your goal" [--workspace path] [--target README.md] [--write] [--yes] [--permission-mode mode] [--session-id id] [--model provider/model] [--direct-core]';
  }
  if (command === "trace") {
    return "Usage: sparkwright trace <summary|events|timeline> <trace.jsonl>";
  }
  if (command === "session") {
    return "Usage: sparkwright session <summary|check|repair|resume> <session-id> [goal] [--workspace path]";
  }
  if (command === "cron") return cronUsage();
  if (command === "tools") return toolsUsage();
  if (command === "capabilities") return capabilitiesUsage();
  if (command === "delegates") return delegatesUsage();
  if (command === "skills") return skillsUsage();
  if (command === "agents") return agentsUsage();
  return undefined;
}

function isHelpArg(value: string | undefined): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

async function handleTraceCommand(
  parsed: ParsedArgs,
  io: CliIO,
): Promise<CliRunResult> {
  if (!parsed.target) {
    writeLine(
      io.stderr,
      "Usage: sparkwright trace <summary|events|timeline> <trace.jsonl>",
    );
    return { exitCode: 1 };
  }
  if (parsed.subcommand === "timeline") {
    const timeline = await buildTraceTimelineFile(parsed.target, {
      type: parsed.eventType,
      runId: parsed.runId,
      contains: parsed.contains,
    });
    writeLine(
      io.stdout,
      parsed.format === "text"
        ? formatTraceTimeline(timeline)
        : JSON.stringify(timeline, null, 2),
    );
    return { exitCode: 0 };
  }
  if (parsed.subcommand === "events") {
    const loaded = await loadTraceEventsFile(parsed.target, {
      type: parsed.eventType,
      runId: parsed.runId,
      contains: parsed.contains,
    });
    const events = loaded
      .filter(
        (event) =>
          (parsed.afterSequence === undefined ||
            event.sequence > parsed.afterSequence) &&
          (parsed.beforeSequence === undefined ||
            event.sequence < parsed.beforeSequence),
      )
      .slice(0, parsed.limit);
    writeLine(
      io.stdout,
      parsed.jsonl
        ? events.map((event) => JSON.stringify(event)).join("\n")
        : parsed.format === "text"
          ? events.map(formatEvent).join("\n")
          : JSON.stringify(events, null, 2),
    );
    return { exitCode: 0 };
  }
  const summary = await summarizeTraceFile(parsed.target);
  writeLine(
    io.stdout,
    parsed.format === "text"
      ? formatTraceSummary(summary)
      : JSON.stringify(summary, null, 2),
  );
  return { exitCode: 0 };
}

async function handleSessionCommand(
  parsed: ParsedArgs,
  io: CliIO,
): Promise<CliRunResult> {
  if (!parsed.target) {
    writeLine(
      io.stderr,
      "Usage: sparkwright session <summary|check|repair|resume> <session-id> [goal] [--workspace path]",
    );
    return { exitCode: 1 };
  }
  let sessionId: string;
  try {
    sessionId = asSessionId(parsed.target);
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1, sessionId: parsed.target };
  }

  const sessionDir = join(
    parsed.workspaceRoot,
    ".sparkwright",
    "sessions",
    sessionId,
  );

  if (parsed.subcommand === "summary") {
    const summary = await summarizeTraceFile(join(sessionDir, "trace.jsonl"));
    writeLine(
      io.stdout,
      parsed.format === "text"
        ? formatTraceSummary(summary)
        : JSON.stringify(summary, null, 2),
    );
    return { exitCode: 0, sessionId };
  }

  if (parsed.subcommand === "repair") {
    const report = await repairSessionTraceConsistency({
      sessionDir,
      apply: parsed.apply,
    });
    writeLine(
      io.stdout,
      parsed.format === "text"
        ? formatRepairReport(report)
        : JSON.stringify(report, null, 2),
    );
    return { exitCode: 0, sessionId };
  }

  const report = await validateSessionTraceConsistency({ sessionDir });
  writeLine(
    io.stdout,
    parsed.format === "text"
      ? formatConsistencyReport(report)
      : JSON.stringify(report, null, 2),
  );
  return { exitCode: report.ok ? 0 : 1, sessionId };
}

async function handleSessionResumeCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  if (!parsed.target || !parsed.goal) {
    writeLine(
      io.stderr,
      "Usage: sparkwright session resume <session-id> <goal> [--workspace path]",
    );
    return { exitCode: 1 };
  }
  let sessionId: string;
  try {
    sessionId = asSessionId(parsed.target);
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1, sessionId: parsed.target };
  }

  const sessionRootDir = join(parsed.workspaceRoot, ".sparkwright", "sessions");
  const sessionStore = new FileSessionStore({ rootDir: sessionRootDir });
  const session = await sessionStore.get(sessionId);
  if (!session) {
    writeLine(io.stderr, `Session not found: ${sessionId}`);
    return { exitCode: 1, sessionId };
  }

  const tracePath = join(sessionRootDir, session.id, "trace.jsonl");
  const runStore = {
    async *loadEvents(runId: string) {
      yield* await loadTraceEventsFile(tracePath, { runId });
    },
  };
  const contextItems = await projectSessionReplayToContextItems({
    session,
    runStore,
    title: "Prior session context",
  });

  const runInput = {
    ...parsed,
    sessionId: session.id,
    contextItems,
  };
  return parsed.directCore
    ? startDirectCoreRun(runInput, io, env)
    : startHostRun(
        {
          ...runInput,
          modelName:
            parsed.modelNameSource === "cli" ? parsed.modelName : undefined,
        },
        io,
        env,
      );
}

async function handleRunResumeCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  if (!parsed.runId) {
    writeLine(
      io.stderr,
      "Usage: sparkwright run resume <run-id> [--session <session-id>] [--workspace path] [--force] [--from-trace]",
    );
    return { exitCode: 1 };
  }

  if (!parsed.directCore) {
    return resumeHostRun(
      {
        runId: parsed.runId,
        workspaceRoot: parsed.workspaceRoot,
        shouldWrite: parsed.shouldWrite,
        approveAll: parsed.approveAll,
        permissionMode: parsed.permissionMode,
        modelName:
          parsed.modelNameSource === "cli" ? parsed.modelName : undefined,
        sessionId: parsed.sessionId,
        targetPath: parsed.targetPath,
        traceLevel: parsed.traceLevel,
        fromTrace: parsed.fromTrace,
        force: parsed.force,
      },
      io,
      env,
    );
  }

  // Locate the run directory. Two layouts are supported:
  //   - session-scoped: <workspace>/.sparkwright/sessions/<sid>/agents/main/runs/<rid>/
  //   - legacy:        <workspace>/.sparkwright/runs/<rid>/
  const sessionsRoot = join(parsed.workspaceRoot, ".sparkwright", "sessions");
  const legacyRunDir = join(
    parsed.workspaceRoot,
    ".sparkwright",
    "runs",
    parsed.runId,
  );
  let runDir: string | undefined;
  let resolvedSessionId: string | undefined;

  if (parsed.sessionId) {
    runDir = join(
      sessionsRoot,
      parsed.sessionId,
      "agents",
      "main",
      "runs",
      parsed.runId,
    );
    resolvedSessionId = parsed.sessionId;
  } else {
    // Scan sessions/*/agents/*/runs/<runId>/ for a match.
    const { readdir } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    if (existsSync(sessionsRoot)) {
      const sessions = await readdir(sessionsRoot, { withFileTypes: true });
      for (const sessionEntry of sessions) {
        if (!sessionEntry.isDirectory()) continue;
        const agentsDir = join(sessionsRoot, sessionEntry.name, "agents");
        if (!existsSync(agentsDir)) continue;
        const agents = await readdir(agentsDir, { withFileTypes: true });
        for (const agentEntry of agents) {
          if (!agentEntry.isDirectory()) continue;
          const candidate = join(
            agentsDir,
            agentEntry.name,
            "runs",
            parsed.runId,
          );
          if (existsSync(candidate)) {
            runDir = candidate;
            resolvedSessionId = sessionEntry.name;
            break;
          }
        }
        if (runDir) break;
      }
    }
    if (!runDir && existsSync(legacyRunDir)) {
      runDir = legacyRunDir;
    }
  }

  if (!runDir) {
    writeLine(
      io.stderr,
      `Could not find run directory for ${parsed.runId} under ${parsed.workspaceRoot}/.sparkwright. ` +
        `Pass --session <session-id> to disambiguate.`,
    );
    return { exitCode: 1 };
  }

  const checkpoint = loadCheckpointFromRunDir(runDir, {
    fallbackFromTrace: parsed.fromTrace,
  });
  if (!checkpoint) {
    writeLine(
      io.stderr,
      `No checkpoint.json under ${runDir}. ` +
        `Re-run with --from-trace to reconstruct one from the trace (best-effort, requires --force).`,
    );
    return { exitCode: 1 };
  }

  const model = await createCliModel({
    modelRef: parsed.modelName,
    cwd: parsed.workspaceRoot,
    env,
    targetPath: parsed.targetPath,
    shouldWrite: parsed.shouldWrite,
    goal: checkpoint.run.goal,
  });
  if (!model.ok) {
    writeLine(io.stderr, model.message);
    return { exitCode: 1 };
  }

  const workspace = new LocalWorkspace(parsed.workspaceRoot);
  const approvalResolver = createCliApprovalResolver({
    approveAll: parsed.approveAll,
    io,
  });
  const policy = createPermissionModePolicy({ mode: parsed.permissionMode });
  const tools = await createConfiguredCliTools(parsed.workspaceRoot, env);

  // Wire a FileRunStore pointing at the same run dir so the resumed run's
  // new events append to the existing trace (keeps replay/inspection coherent).
  let store: FileRunStore | undefined;
  const runStoreFactory =
    resolvedSessionId !== undefined
      ? createSessionFileRunStoreFactory({
          sessionRootDir: sessionsRoot,
          sessionId: resolvedSessionId,
          agentId: "main",
          traceLevel: parsed.traceLevel,
        })
      : (record: RunRecord) =>
          new FileRunStore(record, {
            rootDir: join(parsed.workspaceRoot, ".sparkwright", "runs"),
            traceLevel: parsed.traceLevel,
          });

  let run;
  try {
    run = resumeRunFromCheckpoint(checkpoint, {
      force: parsed.force || !checkpoint.resumability.complete,
      workspace,
      approvalResolver,
      policy,
      tools,
      model: model.adapter,
      runStore: (record) => {
        store = runStoreFactory(record);
        return store;
      },
    });
  } catch (err) {
    writeLine(io.stderr, err instanceof Error ? err.message : String(err));
    return { exitCode: 1, sessionId: resolvedSessionId };
  }

  for (const event of run.events.all()) {
    writeLine(io.stdout, formatEvent(event));
  }
  run.events.subscribe((event) => writeLine(io.stdout, formatEvent(event)));

  try {
    const result = await run.start();
    return {
      exitCode: result.signal === "completed" ? 0 : 1,
      tracePath: store?.tracePath,
      sessionId: resolvedSessionId,
      runState: result.state,
      stopReason: result.stopReason,
    };
  } finally {
    writeLine(
      io.stdout,
      `Resumed run ${run.record.state}${run.record.stopReason ? ` (${run.record.stopReason})` : ""}`,
    );
  }
}

function formatTraceSummary(summary: TraceSummary): string {
  const topTypes = Object.entries(summary.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, count]) => `${type}:${count}`)
    .join(", ");
  const topErrors = Object.entries(summary.errorCodes ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => `${code}:${count}`)
    .join(", ");
  return [
    `events: ${summary.eventCount}`,
    `runs: ${summary.runIds.length}`,
    `sessions: ${summary.sessionIds.join(", ") || "(none)"}`,
    `agents: ${summary.agentIds.join(", ") || "(none)"}`,
    `artifacts: ${summary.artifactCount}`,
    `errors: ${summary.errorCount}`,
    `top errors: ${topErrors || "(none)"}`,
    `tokens: ${summary.usage.totalTokens}`,
    `top event types: ${topTypes || "(none)"}`,
  ].join("\n");
}

function formatTraceTimeline(timeline: TraceTimeline): string {
  const lines = [
    `events: ${timeline.eventCount}`,
    `runs: ${timeline.runIds.length}`,
    `durationMs: ${timeline.durationMs ?? 0}`,
    `phases: ${timeline.phases.length}`,
  ];
  for (const phase of timeline.phases.slice(0, 80)) {
    const duration =
      phase.durationMs === undefined ? "pending" : `${phase.durationMs}ms`;
    lines.push(
      `[${phase.startSequence}${phase.endSequence ? `-${phase.endSequence}` : ""}] ${phase.status} ${phase.category} ${phase.label} (${duration})`,
    );
  }
  if (timeline.phases.length > 80) {
    lines.push(`... ${timeline.phases.length - 80} more phase(s)`);
  }
  return lines.join("\n");
}

function formatConsistencyReport(
  report: SessionTraceConsistencyReport,
): string {
  const lines = [
    `status: ${report.ok ? "ok" : "failed"}`,
    `session: ${report.sessionId ?? "(unknown)"}`,
    `runs: ${report.runIds.length}`,
    `findings: ${report.findings.length}`,
  ];
  for (const finding of report.findings) {
    lines.push(`${finding.severity} ${finding.code}: ${finding.message}`);
  }
  return lines.join("\n");
}

function formatRepairReport(report: SessionTraceRepairReport): string {
  const lines = [
    `mode: ${report.applied ? "applied" : "dry-run"}`,
    `actions: ${report.actions.length}`,
  ];
  for (const action of report.actions) {
    lines.push(`${action.kind} ${action.path}: ${action.reason}`);
  }
  if (report.after) {
    lines.push(`after: ${report.after.ok ? "ok" : "failed"}`);
  }
  return lines.join("\n");
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = parseNonNegativeInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(
  value: string | undefined,
): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

// NOTE: templates intentionally omit a top-level "$schema" until the schema is
// published at a stable URL; pointing at an unhosted URL would make editors fail
// to fetch it. The config schema still *allows* "$schema" (see
// schemas/config.schema.json) so users can opt in once it is hosted.
const CONFIG_TEMPLATE = {
  model: "openai/gpt-5.4-mini",
  providers: {
    openai: {
      baseURL: "https://api.openai.com/v1",
      apiKey: "REPLACE_WITH_YOUR_API_KEY",
      models: {
        "gpt-5.4-mini": {},
        "gpt-5.4": {},
      },
    },
    anthropic: {
      npm: "@ai-sdk/anthropic",
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "REPLACE_WITH_YOUR_API_KEY",
      models: {
        "claude-sonnet-4-6": {},
        "claude-haiku-4-5": {},
      },
    },
    google: {
      npm: "@ai-sdk/google",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "REPLACE_WITH_YOUR_API_KEY",
      models: {
        "gemini-3.1-pro": {},
        "gemini-3-flash": {},
      },
    },
  },
};

/**
 * Scaffold for `<workspace>/.sparkwright/config.json`. Unlike the user template
 * this carries NO secrets — provider keys stay in the user-level file — so it is
 * safe to commit and travel with the repository. Seeds the project skills root
 * and the convention command/agents dirs as the project config surface.
 */
const PROJECT_CONFIG_TEMPLATE = {
  permissionMode: "default",
  capabilities: {
    tools: {
      disabled: ["shell"],
      defer: ["mcp_*"],
    },
    skills: {
      includeLoaderTool: true,
      loadSelectedSkills: false,
      resourceFileLimit: 8,
    },
    mcp: {
      servers: [],
    },
  },
};

const PROJECT_CAPABILITY_DIRS = ["skills", "agents", "command"] as const;

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

async function scaffoldUserConfig(
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  const { writeFile, mkdir, chmod } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const path = userConfigPath(env);

  if (existsSync(path)) {
    writeLine(io.stdout, `Config already exists: ${path}`);
    writeLine(io.stdout, "Edit it directly, or delete it and re-run init.");
    return { exitCode: 0 };
  }

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, {
      mode: 0o600,
    });
    // mkdir/umask can leave looser perms; force 600 since this holds a secret.
    await chmod(path, 0o600);
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
    'Next: set the "apiKey" for the provider you want, then run `sparkwright tui`.',
  );
  writeLine(
    io.stdout,
    'The template seeds openai, anthropic, and google — switch with "model": "<provider>/<model>", e.g. "anthropic/claude-haiku-4-5".',
  );
  return { exitCode: 0 };
}

async function scaffoldProjectConfig(
  io: CliIO,
  cwd: string,
): Promise<CliRunResult> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const path = projectConfigPathForWorkspace(cwd);
  const configExists = existsSync(path);

  try {
    // No secret here, so no forced 600: this file is meant to be committed.
    await mkdir(dirname(path), { recursive: true });
    if (!configExists) {
      await writeFile(
        path,
        `${JSON.stringify(PROJECT_CONFIG_TEMPLATE, null, 2)}\n`,
      );
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
    "Created project capability directories: .sparkwright/skills, .sparkwright/agents, .sparkwright/command",
  );
  writeLine(
    io.stdout,
    "Next: sparkwright capabilities inspect --workspace . --format text",
  );
  return { exitCode: 0 };
}

function usage(): string {
  return [
    "Usage: sparkwright init             # scaffold ~/.config/sparkwright/config.json",
    "       sparkwright init --project   # scaffold committable <workspace>/.sparkwright/config.json",
    "       sparkwright capabilities inspect [--workspace path] [--format json|text]",
    '       sparkwright delegates run <toolName> "goal" [--workspace path] [--yes] [--session-id id] [--trace-level minimal|standard|debug] [--format json|text]',
    "       sparkwright tools list [--format json|text]",
    "       sparkwright tools enable|disable|defer <tool-pattern...>",
    "       sparkwright skills list|validate [--workspace path] [--format json|text]",
    '       sparkwright skills create <name> --description "what it does" [--workspace path] [--root path] [--force]',
    "       sparkwright agents list|validate [--workspace path] [--format json|text]",
    '       sparkwright agents create <id> --prompt "what it should do" [--allow tool] [--delegate tool_name] [--workspace path] [--force]',
    '       sparkwright run "your goal" [--workspace path] [--target README.md] [--write] [--yes] [--permission-mode mode] [--session-id id] [--model provider/model] [--direct-core]',
    "       sparkwright trace summary <trace.jsonl> [--format json|text]",
    "       sparkwright trace events <trace.jsonl> [--type event.type] [--run-id id] [--contains text] [--limit n] [--jsonl] [--format json|text]",
    "       sparkwright trace timeline <trace.jsonl> [--run-id id] [--format json|text]",
    "       sparkwright session <summary|check|repair> <session-id> [--workspace path] [--format json|text] [--apply]",
    '       sparkwright session resume <session-id> "next goal" [--workspace path] [--target README.md] [--write] [--yes] [--permission-mode mode]',
    "       sparkwright run resume <run-id> [--session <session-id>] [--workspace path] [--force] [--from-trace] [--model provider/model]",
  ].join("\n");
}

function toolsUsage(): string {
  return [
    "Usage: sparkwright tools list [--format json|text]",
    "       sparkwright tools enable <tool-pattern...>",
    "       sparkwright tools disable <tool-pattern...>",
    "       sparkwright tools defer <tool-pattern...>",
  ].join("\n");
}

function capabilitiesUsage(): string {
  return "Usage: sparkwright capabilities inspect [--workspace path] [--format json|text]";
}

function delegatesUsage(): string {
  return 'Usage: sparkwright delegates run <toolName> "goal" [--workspace path] [--goal text] [--yes] [--session-id id] [--trace-level minimal|standard|debug] [--format json|text]';
}

function skillsUsage(): string {
  return [
    "Usage: sparkwright skills list [--workspace path] [--format json|text]",
    "       sparkwright skills validate [--workspace path] [--format json|text]",
    '       sparkwright skills create <name> --description "what it does" [--workspace path] [--root path] [--force]',
  ].join("\n");
}

function agentsUsage(): string {
  return [
    "Usage: sparkwright agents list [--workspace path] [--format json|text]",
    "       sparkwright agents validate [--workspace path] [--format json|text]",
    '       sparkwright agents create <id> --prompt "what it should do" [--name text] [--allow tool] [--deny tool] [--delegate tool_name] [--max-steps n] [--workspace path] [--force]',
  ].join("\n");
}

function isPermissionMode(value: string | undefined): value is PermissionMode {
  return (
    value === "plan" ||
    value === "default" ||
    value === "accept_edits" ||
    value === "dont_ask" ||
    value === "bypass_permissions"
  );
}

function isTraceLevel(value: string | undefined): value is TraceLevel {
  return value === "minimal" || value === "standard" || value === "debug";
}
