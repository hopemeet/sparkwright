/**
 * Shared Sparkwright config loader.
 *
 * Both the CLI and the TUI read the same on-disk config so the active model
 * and its provider credentials are configured once. This module owns the
 * canonical file locations and the validation for the *shared* fields (model,
 * providers, permissionMode, workspace). UI-only fields (theme, keybindings,
 * mouse) live in the same file and are validated by the TUI; this loader
 * ignores them.
 *
 * Resolution order (later overrides earlier): user file, project file, then an
 * explicit $SPARKWRIGHT_CONFIG path. The `providers` map merges by key across
 * files, top-level tool config merges with allowed as a tightening
 * intersection, disabled as a tightening union, and defer as a later-layer
 * replacement, capabilities merge by sub-capability, and the security
 * boundaries — shell.sandbox, permissionMode, and
 * confidentialPaths — merge conservatively so later (lower-trust) layers cannot
 * weaken an earlier layer's policy. confidentialDefaults is the explicit
 * later-layer override for the built-in confidential path set.
 * Callers layer CLI flags / env on top.
 */

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  clampBackgroundTaskPolicy,
  clampAccessMode,
  compileRunAccessMode,
  type BackgroundTaskPolicy,
  type RunAccessMode,
  type RunBudget,
  type WorkflowHookMatcher,
  type WorkflowHookName,
} from "@sparkwright/core";
import {
  PERMISSION_MODES,
  type PermissionMode,
  type TraceLevel,
} from "@sparkwright/protocol";
import type {
  AgentProfile,
  AgentProfileWorkflowHookConfig,
} from "@sparkwright/agent-runtime";
import { MAX_FOREGROUND_TIMEOUT_MS } from "@sparkwright/shell-tool";
import type { ShellSandboxConfig } from "@sparkwright/shell-sandbox";
import {
  formatToolUseSelectorList,
  intersectToolUseSelectors,
  isToolUseSelector,
  normalizeToolUseSelector,
} from "./tool-selectors.js";
import { normalizeToolNameList } from "./tool-identities.js";
import {
  booleanSchema,
  integerArray,
  nonEmptyString,
  nonNegativeInteger,
  numberSchema,
  positiveInteger,
  positiveNumber,
  stringArray,
  stringSchema,
  stringRecordSchema,
  APPROVAL_BOOLEAN_CONFIG_KEYS,
  APPROVALS_CONFIG_KEYS,
  AGENT_PROFILE_ACP_METADATA_CONFIG_KEYS,
  AGENT_PROFILE_CONFIG_KEYS,
  AGENT_PROFILE_DELEGATE_TOOL_CONFIG_KEYS,
  AGENT_PROFILE_EXTERNAL_COMMAND_METADATA_CONFIG_KEYS,
  AGENT_PROFILE_WORKFLOW_HOOK_CONFIG_KEYS,
  AGENT_PROFILE_MODES,
  AGENT_PROFILE_OPTIONAL_STRING_CONFIG_KEYS,
  AGENT_PROFILE_TOOL_ARRAY_CONFIG_KEYS,
  AGENT_EXPOSURE_MODES,
  AGENTS_CONFIG_KEYS,
  CAPABILITIES_CONFIG_KEYS,
  CONFIG_GROUP_CONFIG_KEYS,
  CONFIG_GROUP_FIELD_MAP,
  confidentialDefaultsSchema,
  confidentialPathsSchema,
  DELEGATE_TOOL_BOOLEAN_CONFIG_KEYS,
  DELEGATE_TOOL_CONFIG_KEYS,
  DELEGATE_TOOL_OPTIONAL_STRING_CONFIG_KEYS,
  DELEGATE_ENV_MODES,
  DELEGATE_WORKSPACE_ACCESS_MODES,
  EXTERNAL_COMMAND_INPUT_MODES,
  EVENT_HOOK_CONFIG_KEYS,
  EVENT_HOOK_TRIGGERS,
  HOOKS_HTTP_ALLOW_CONFIG_KEYS,
  HOOKS_HTTP_CONFIG_KEYS,
  HOOKS_CONFIG_KEYS,
  MCP_CONFIG_KEYS,
  MCP_DEFAULT_POLICY_CONFIG_KEYS,
  MCP_DEFAULT_POLICY_RISKS,
  MCP_STARTUP_MODES,
  MCP_TOOL_SCHEMA_LOAD_MODES,
  modelSchema,
  MODEL_COST_CONFIG_KEYS,
  PROVIDER_CONFIG_KEYS,
  PROVIDER_MODEL_CONFIG_KEYS,
  RUN_BUDGET_CONFIG_KEYS,
  RUN_BUDGET_POSITIVE_INTEGER_CONFIG_KEYS,
  TASK_BUDGET_CONFIG_KEYS,
  TASK_BUDGET_POSITIVE_INTEGER_CONFIG_KEYS,
  TASK_CONFIG_KEYS,
  TASK_UNKNOWN_COST_POLICIES,
  SHELL_CONFIG_KEYS,
  SHELL_SANDBOX_MODES,
  SHELL_SANDBOX_CONFIG_KEYS,
  SHELL_SANDBOX_FILESYSTEM_CONFIG_KEYS,
  SHELL_SANDBOX_FILESYSTEM_PATH_CONFIG_KEYS,
  SHELL_SANDBOX_NETWORK_MODES,
  SHELL_SANDBOX_NETWORK_CONFIG_KEYS,
  SKILLS_CONFIG_KEYS,
  SKILL_EVOLUTION_CONFIG_KEYS,
  SKILL_EVOLUTION_MODES,
  SKILL_INLINE_SHELL_CONFIG_KEYS,
  TOOLS_CONFIG_KEYS,
  TRACE_LEVEL_CONFIG_VALUES,
  VERIFICATION_AFTER_WRITES_CONFIG_KEYS,
  VERIFICATION_COMMAND_CONFIG_KEYS,
  VERIFICATION_CONFIG_KEYS,
  VERIFICATION_KINDS,
  VERIFICATION_MODES,
  WORKFLOW_HOOK_ACTION_CONFIG_KEYS_BY_TYPE,
  WORKFLOW_HOOK_ACTION_TYPES,
  WORKFLOW_HOOK_AGENT_RESULT_MODES,
  WORKFLOW_HOOK_COMMAND_RESULT_MODES,
  WORKFLOW_HOOK_CONFIG_KEYS,
  WORKFLOW_HOOK_CONTEXT_TYPES,
  WORKFLOW_HOOK_FREQUENCIES,
  WORKFLOW_HOOK_HTTP_METHODS,
  WORKFLOW_HOOK_HTTP_RESULT_MODES,
  WORKFLOW_HOOK_MATCHER_CONFIG_KEYS,
  WORKFLOW_HOOK_NAMES,
  WORKFLOW_HOOK_ON_ERROR_MODES,
  WORKFLOW_HOOK_OUTPUT_INJECTION_MODES,
  WORKFLOW_HOOK_STDIN_MODES,
  WRITE_GUARDRAILS_CONFIG_KEYS,
  maxStepsSchema,
  ACCESS_MODE_CONFIG_VALUES,
  BACKGROUND_TASK_POLICY_CONFIG_VALUES,
  PERMISSION_MODE_CONFIG_VALUES,
  workspaceSchema,
} from "./config-zod-schema.js";
import type {
  ApprovalDefaults,
  AgentExposureMode,
  CapabilityDelegateToolConfig,
  CapabilityEventHookConfig,
  CapabilityHookActionConfig,
  CapabilityHooksConfig,
  CapabilityMcpStartup,
  CapabilityMcpToolSchemaLoad,
  CapabilitySkillEvolutionConfig,
  CapabilitySkillInlineShellConfig,
  CapabilitySkillsConfig,
  CapabilityToolsConfig,
  CapabilityVerificationCommandConfig,
  CapabilityVerificationConfig,
  CapabilityVerificationKind,
  CapabilityVerificationAfterWritesConfig,
  CapabilityWorkflowHookConfig,
  ModelCost,
  ProviderConfig,
  ProviderModelConfig,
  ShellConfig,
  TaskBudgetConfig,
  TaskConfig,
  WriteGuardrailsConfig,
} from "./config-zod-schema.js";
export type {
  ApprovalDefaults,
  AgentExposureMode,
  CapabilityDelegateToolConfig,
  CapabilityEventHookConfig,
  CapabilityHookActionConfig,
  CapabilityHooksConfig,
  CapabilityMcpStartup,
  CapabilityMcpToolSchemaLoad,
  CapabilitySkillEvolutionConfig,
  CapabilitySkillEvolutionMode,
  CapabilitySkillInlineShellConfig,
  CapabilitySkillsConfig,
  CapabilityToolsConfig,
  CapabilityVerificationCommandConfig,
  CapabilityVerificationConfig,
  CapabilityVerificationKind,
  CapabilityVerificationMode,
  CapabilityVerificationAfterWritesConfig,
  CapabilityWorkflowHookConfig,
  CapabilityWorkflowHookFrequency,
  ModelCost,
  ProviderConfig,
  ProviderModelConfig,
  ShellConfig,
  TaskBudgetConfig,
  TaskConfig,
  WriteGuardrailsConfig,
} from "./config-zod-schema.js";

type CapabilityHooksHttpConfig = NonNullable<CapabilityHooksConfig["http"]>;
type CapabilityHooksHttpAllowRule = NonNullable<
  CapabilityHooksHttpConfig["allow"]
>[number];

export const CONFIG_PROJECT_REL = ".sparkwright/config.json";
export const CONFIG_USER_REL = ".config/sparkwright/config.json";
export const CONFIG_ENV_VAR = "SPARKWRIGHT_CONFIG";
export const CONFIG_FILE_BASENAMES = [
  "config.json",
  "config.yaml",
  "config.yml",
] as const;
const CONFIG_USER_DIR_SUBPATH = "sparkwright";
const CONFIG_USER_JSON_SUBPATH = "sparkwright/config.json";

/** Reserved provider key for the built-in offline demo model. */
export const DETERMINISTIC_PROVIDER = "deterministic";
/** AI SDK package assumed when a provider omits `npm`. */
export const DEFAULT_PROVIDER_NPM = "@ai-sdk/openai";
/**
 * AI SDK packages we know how to construct. Each maps to a factory function on
 * the package's module namespace plus the env var consulted for an API key
 * when the provider config omits one. The package is loaded lazily (dynamic
 * import) so it only needs to be installed if actually used.
 */
export const SUPPORTED_PROVIDER_NPMS: Record<
  string,
  { factory: string; apiKeyEnv: string; baseUrlEnv?: string }
> = {
  "@ai-sdk/openai": {
    factory: "createOpenAI",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
  },
  "@ai-sdk/anthropic": {
    factory: "createAnthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  "@ai-sdk/google": {
    factory: "createGoogleGenerativeAI",
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
};

export interface SharedConfig {
  /** Active model in "provider/model" form (or the reserved "deterministic"). */
  model?: string;
  providers?: Record<string, ProviderConfig>;
  /**
   * High-level run autonomy preset (the user-facing access knob). Merges
   * conservatively across layers (project clamps user). The loader derives the
   * internal `permissionMode` from it via `compileRunAccessMode`.
   */
  accessMode?: RunAccessMode;
  /**
   * Project-layer maximum autonomy. Runtime overrides and lower layers are
   * clamped to this ceiling, but more restrictive requests remain effective.
   */
  accessModeCeiling?: RunAccessMode;
  /**
   * Session-level foreground/background task policy. Like accessMode, project
   * config acts as the ceiling and lower layers can only tighten it.
   */
  backgroundTasks?: BackgroundTaskPolicy;
  /** Project-layer maximum foreground/background task capability. */
  backgroundTasksCeiling?: BackgroundTaskPolicy;
  /**
   * Internal compile target derived from `accessMode`. Not a user-facing config
   * field; downstream runtime/CLI consumers read this. Do not parse it from
   * user config.
   */
  permissionMode?: PermissionMode;
  /** Path relative to the config file, or absolute. */
  workspace?: string;
  /**
   * Whether runs include the built-in conservative read-confidentiality globs.
   * Defaults to true when absent. Set false only when the config intentionally
   * owns the full confidential path list.
   */
  confidentialDefaults?: boolean;
  /**
   * Workspace-relative paths/globs whose contents a run must not read. These
   * extend the built-in confidential defaults unless `confidentialDefaults` is
   * set false. Matching `read_file`/`grep` reads are denied at the tool layer.
   */
  confidentialPaths?: string[];
  /**
   * Workspace write guardrails. Overrides the built-in defaults the runtime
   * applies to a run's workspace-mutation policy. Like the other security
   * boundaries, this merges conservatively across layers: a later (lower-trust)
   * layer can only tighten — lower `maxFiles`/`maxDiffLines` win and
   * `allowDeletions: false` wins.
   */
  write?: WriteGuardrailsConfig;
  shell?: ShellConfig;
  /** Preferred top-level tool exposure/loading config. */
  tools?: CapabilityToolsConfig;
  /** Shared routing and budget defaults for model-backed auxiliary tasks. */
  tasks?: Record<string, TaskConfig>;
  capabilities?: CapabilityConfig;
  /**
   * Resource budget for the interactive main run. `maxModelCalls` is the
   * tightest natural step bound; see `resolveMainAgentMaxSteps`. An explicit
   * main agent profile (capabilities.agents) overrides this.
   */
  runBudget?: RunBudget;
  /** Explicit main-run step ceiling. Overrides the derived/backstop value. */
  maxSteps?: number;
  /** Default trace verbosity when an entrypoint does not pass one. */
  traceLevel?: TraceLevel;
  /** Project/user defaults for approval auto-grants (CLI flags still override). */
  approvals?: ApprovalDefaults;
}

export interface CapabilityConfig {
  hooks?: CapabilityHooksConfig;
  verification?: CapabilityVerificationConfig;
  skills?: CapabilitySkillsConfig;
  mcp?: CapabilityMcpConfig;
  agents?: CapabilityAgentsConfig;
}

export interface CapabilityAgentsConfig {
  profiles?: AgentProfile[];
  delegateTools?: CapabilityDelegateToolConfig[];
  /** Optional model for dynamic spawn_agent children; absent inherits the parent model. */
  spawnModel?: string;
  /** Optional default model for configured in-process delegates; profile.model wins. */
  delegateModel?: string;
  /** Direct delegate_* exposure mode. Default indexed. */
  exposure?: AgentExposureMode;
  /** Profile ids or delegate tool names kept as direct delegate_* tools in indexed mode. */
  pinnedDelegates?: string[];
  exposeChildrenAsDelegates?: boolean;
  enableParallelDelegates?: boolean;
  /** Maximum allowed sub-agent depth. 0 disables spawning; absent keeps legacy defaults. */
  maxDepth?: number;
  /** Allow sub-agents to create background agent tasks, bounded by maxDepth. */
  allowNestedBackgroundTasks?: boolean;
}

export type CapabilityMcpServerConfig =
  | {
      type: "stdio";
      name: string;
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      enabled?: boolean;
      toolSchemaLoad?: CapabilityMcpToolSchemaLoad;
    }
  | {
      type: "http";
      name: string;
      url: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      enabled?: boolean;
      toolSchemaLoad?: CapabilityMcpToolSchemaLoad;
    };

export interface CapabilityMcpConfig {
  servers?: CapabilityMcpServerConfig[];
  defaultTimeoutMs?: number;
  namePrefix?: string;
  /**
   * When configured MCP servers are connected. File config defaults to lazy;
   * embedders may opt session-scoped servers into prepare.
   */
  startup?: CapabilityMcpStartup;
  /** Default provider-schema loading behavior for concrete MCP tools. */
  toolSchemaLoad?: CapabilityMcpToolSchemaLoad;
  defaultPolicy?: {
    risk?: "safe" | "risky" | "denied";
    requiresApproval?: boolean;
  };
}

export interface SharedConfigSourceMap {
  model?: string;
  accessMode?: string;
  accessModeCeiling?: string;
  backgroundTasks?: string;
  backgroundTasksCeiling?: string;
  permissionMode?: string;
  workspace?: string;
  confidentialDefaults?: string;
  confidentialPaths?: string;
  write?: string;
  shell?: string;
  tools?: string;
  runBudget?: string;
  maxSteps?: string;
  traceLevel?: string;
  approvals?: string;
  providers?: Record<string, string>;
  tasks?: string;
}

export interface SharedConfigError {
  file: string;
  field: string;
  message: string;
}

export interface SharedConfigWarning {
  file: string;
  field: string;
  message: string;
}

export interface LoadedSharedConfig {
  config: SharedConfig;
  sources: SharedConfigSourceMap;
  attempted: { path: string; loaded: boolean }[];
  errors: SharedConfigError[];
  warnings: SharedConfigWarning[];
}

/**
 * Merge write guardrails conservatively so a later (lower-trust) layer can only
 * tighten the boundary: the smaller `maxFiles`/`maxDiffLines` wins and
 * `allowDeletions: false` wins. Mirrors `mergeShellSandboxConfig`.
 */
function mergeWriteGuardrails(
  previous: WriteGuardrailsConfig | undefined,
  next: WriteGuardrailsConfig | undefined,
): WriteGuardrailsConfig | undefined {
  if (!previous) return next;
  if (!next) return previous;
  return {
    maxFiles: minDefined(previous.maxFiles, next.maxFiles),
    maxDiffLines: minDefined(previous.maxDiffLines, next.maxDiffLines),
    allowDeletions:
      previous.allowDeletions === false || next.allowDeletions === false
        ? false
        : (previous.allowDeletions ?? next.allowDeletions),
  };
}

function minDefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

export function userConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  // Honor XDG_CONFIG_HOME so the location is overridable (Linux convention and
  // hermetic tests); fall back to ~/.config otherwise.
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, CONFIG_USER_JSON_SUBPATH);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_PROJECT_REL);
}

export function configResolutionOrder(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): { path: string; label: string }[] {
  const order = configLayerResolutionOrder(cwd, env).flatMap((layer) =>
    layer.candidates.map((path) => ({ path, label: layer.label })),
  );
  return order;
}

type ConfigLayerLabel = "user" | "project" | "env";

interface ConfigLayerResolution {
  label: ConfigLayerLabel;
  candidates: string[];
}

function configLayerResolutionOrder(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): ConfigLayerResolution[] {
  const order: ConfigLayerResolution[] = [
    { label: "user", candidates: userConfigCandidatePaths(env) },
    { label: "project", candidates: projectConfigCandidatePaths(cwd) },
  ];
  const explicit = env[CONFIG_ENV_VAR];
  if (explicit) {
    order.push({
      candidates: [isAbsolute(explicit) ? explicit : resolve(cwd, explicit)],
      label: "env",
    });
  }
  return order;
}

export function userConfigCandidatePaths(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return CONFIG_FILE_BASENAMES.map((name) =>
    join(base, CONFIG_USER_DIR_SUBPATH, name),
  );
}

export function projectConfigCandidatePaths(cwd: string): string[] {
  const dir = join(cwd, ".sparkwright");
  return CONFIG_FILE_BASENAMES.map((name) => join(dir, name));
}

export type ConfigFileFormat = "json" | "yaml";

export interface ConfigFileObject {
  exists: boolean;
  value: Record<string, unknown>;
  format: ConfigFileFormat;
}

export function configFileFormatForPath(path: string): ConfigFileFormat {
  const lower = path.toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml") ? "yaml" : "json";
}

export function serializeConfigFileObject(
  path: string,
  value: Record<string, unknown>,
): string {
  const format = configFileFormatForPath(path);
  const serialized =
    format === "yaml"
      ? stringifyYaml(value, { lineWidth: 0 })
      : JSON.stringify(value, null, 2);
  return serialized.endsWith("\n") ? serialized : `${serialized}\n`;
}

async function readConfigFile(
  path: string,
): Promise<
  | { kind: "ok"; value: unknown }
  | { kind: "missing" }
  | { kind: "error"; message: string }
> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "missing" };
    return {
      kind: "error",
      message: `read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const format = configFileFormatForPath(path);
  try {
    return {
      kind: "ok",
      value: format === "yaml" ? parseYaml(raw) : JSON.parse(raw),
    };
  } catch (err) {
    return {
      kind: "error",
      message: `invalid ${format.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function readConfigFileObject(
  path: string,
): Promise<ConfigFileObject> {
  const result = await readConfigFile(path);
  if (result.kind === "missing") {
    return {
      exists: false,
      value: {},
      format: configFileFormatForPath(path),
    };
  }
  if (result.kind === "error") {
    throw new Error(result.message);
  }
  if (!isRecord(result.value)) {
    throw new Error(`${path} must contain a config object.`);
  }
  return {
    exists: true,
    value: result.value,
    format: configFileFormatForPath(path),
  };
}

export async function writeConfigFileObject(
  path: string,
  value: Record<string, unknown>,
  options: { privateFile?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeConfigFileObject(path, value), {
    ...(options.privateFile !== false ? { mode: 0o600 } : {}),
  });
  if (options.privateFile !== false) {
    await chmod(path, 0o600);
  }
}

export async function resolveConfigWriteTarget(
  defaultJsonPath: string,
): Promise<{ path: string; exists: boolean }> {
  const candidates = configSiblingCandidatePaths(defaultJsonPath);
  const existing = await existingConfigCandidatePaths(candidates);
  if (existing.length > 1) {
    throw new Error(
      `Multiple config files found next to ${defaultJsonPath}: ${existing.join(", ")}. Keep one before writing config.`,
    );
  }
  return {
    path: existing[0] ?? defaultJsonPath,
    exists: existing.length === 1,
  };
}

function configSiblingCandidatePaths(defaultJsonPath: string): string[] {
  const dir = dirname(defaultJsonPath);
  return CONFIG_FILE_BASENAMES.map((name) => join(dir, name));
}

async function existingConfigCandidatePaths(
  paths: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (info.isFile()) out.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        out.push(path);
      }
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOption<T extends string>(
  value: unknown,
  options: readonly T[],
): value is T {
  return (
    typeof value === "string" && (options as readonly string[]).includes(value)
  );
}

function isHttpUrlString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

interface ConfigValueSchema<T> {
  safeParse(raw: unknown): { success: true; data: T } | { success: false };
}

function validateZodValue<T>(
  schema: ConfigValueSchema<T>,
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
  message: string,
): T | undefined {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  errors.push({ file: filePath, field, message });
  return undefined;
}

function validateStringArray(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): string[] | undefined {
  return validateZodValue(
    stringArray,
    raw,
    field,
    filePath,
    errors,
    "must be an array of strings",
  );
}

function validateOptionalBoolean(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): boolean | undefined {
  return validateZodValue(
    booleanSchema,
    raw,
    field,
    filePath,
    errors,
    "must be a boolean",
  );
}

function validateOptionalNonNegativeInteger(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): number | undefined {
  return validateZodValue(
    nonNegativeInteger,
    raw,
    field,
    filePath,
    errors,
    "must be a non-negative integer",
  );
}

function validateOptionalPositiveInteger(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): number | undefined {
  return validateZodValue(
    positiveInteger,
    raw,
    field,
    filePath,
    errors,
    "must be a positive integer",
  );
}

function validateOptionalPositiveNumber(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): number | undefined {
  return validateZodValue(
    positiveNumber,
    raw,
    field,
    filePath,
    errors,
    "must be a positive number",
  );
}

function validateCapabilitySkills(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): CapabilitySkillsConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "capabilities.skills",
      message: "must be an object",
    });
    return undefined;
  }
  const out: CapabilitySkillsConfig = {};
  const allowed = new Set<string>(SKILLS_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `capabilities.skills.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.roots !== undefined) {
    out.roots = validateStringArray(
      raw.roots,
      "capabilities.skills.roots",
      filePath,
      errors,
    );
  }
  if (raw.includeLoaderTool !== undefined) {
    out.includeLoaderTool = validateOptionalBoolean(
      raw.includeLoaderTool,
      "capabilities.skills.includeLoaderTool",
      filePath,
      errors,
    );
  }
  if (raw.loadSelectedSkills !== undefined) {
    out.loadSelectedSkills = validateOptionalBoolean(
      raw.loadSelectedSkills,
      "capabilities.skills.loadSelectedSkills",
      filePath,
      errors,
    );
  }
  if (raw.maxSelectedSkills !== undefined) {
    out.maxSelectedSkills = validateOptionalNonNegativeInteger(
      raw.maxSelectedSkills,
      "capabilities.skills.maxSelectedSkills",
      filePath,
      errors,
    );
  }
  if (raw.resourceFileLimit !== undefined) {
    out.resourceFileLimit = validateOptionalNonNegativeInteger(
      raw.resourceFileLimit,
      "capabilities.skills.resourceFileLimit",
      filePath,
      errors,
    );
  }
  if (raw.allowedSkills !== undefined) {
    out.allowedSkills = validateStringArray(
      raw.allowedSkills,
      "capabilities.skills.allowedSkills",
      filePath,
      errors,
    );
  }
  if (raw.deniedSkills !== undefined) {
    out.deniedSkills = validateStringArray(
      raw.deniedSkills,
      "capabilities.skills.deniedSkills",
      filePath,
      errors,
    );
  }
  if (raw.evolution !== undefined) {
    const evolution = validateCapabilitySkillEvolution(
      raw.evolution,
      filePath,
      errors,
    );
    if (evolution) out.evolution = evolution;
  }
  if (raw.inlineShell !== undefined) {
    const inlineShell = validateCapabilitySkillInlineShell(
      raw.inlineShell,
      filePath,
      errors,
    );
    if (inlineShell) out.inlineShell = inlineShell;
  }
  return out;
}

function validateCapabilitySkillEvolution(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): CapabilitySkillEvolutionConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "capabilities.skills.evolution",
      message: "must be an object",
    });
    return undefined;
  }
  const out: CapabilitySkillEvolutionConfig = {};
  const allowed = new Set<string>(SKILL_EVOLUTION_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `capabilities.skills.evolution.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.mode !== undefined) {
    if (isStringOption(raw.mode, SKILL_EVOLUTION_MODES)) {
      out.mode = raw.mode;
    } else {
      errors.push({
        file: filePath,
        field: "capabilities.skills.evolution.mode",
        message: `must be one of ${SKILL_EVOLUTION_MODES.join(" | ")}`,
      });
    }
  }
  return out;
}

function validateCapabilitySkillInlineShell(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): CapabilitySkillInlineShellConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "capabilities.skills.inlineShell",
      message: "must be an object",
    });
    return undefined;
  }
  const out: CapabilitySkillInlineShellConfig = {};
  const allowed = new Set<string>(SKILL_INLINE_SHELL_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `capabilities.skills.inlineShell.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.enabled !== undefined) {
    out.enabled = validateOptionalBoolean(
      raw.enabled,
      "capabilities.skills.inlineShell.enabled",
      filePath,
      errors,
    );
  }
  if (raw.timeoutMs !== undefined) {
    out.timeoutMs = validateOptionalPositiveInteger(
      raw.timeoutMs,
      "capabilities.skills.inlineShell.timeoutMs",
      filePath,
      errors,
    );
  }
  if (raw.maxOutputChars !== undefined) {
    out.maxOutputChars = validateOptionalPositiveInteger(
      raw.maxOutputChars,
      "capabilities.skills.inlineShell.maxOutputChars",
      filePath,
      errors,
    );
  }
  return out;
}

function validateToolsConfig(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityToolsConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field,
      message: "must be an object",
    });
    return undefined;
  }
  const out: CapabilityToolsConfig = {};
  const allowed = new Set<string>(TOOLS_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.use !== undefined) {
    out.use = validateToolUseSelectorArray(
      raw.use,
      `${field}.use`,
      filePath,
      errors,
    );
  }
  if (raw.allowed !== undefined) {
    out.allowed = validateToolNameArray(
      raw.allowed,
      `${field}.allowed`,
      filePath,
      errors,
    );
  }
  if (raw.disabled !== undefined) {
    out.disabled = validateToolNameArray(
      raw.disabled,
      `${field}.disabled`,
      filePath,
      errors,
    );
  }
  if (raw.defer !== undefined) {
    out.defer = validateToolNameArray(
      raw.defer,
      `${field}.defer`,
      filePath,
      errors,
    );
  }
  return out;
}

function validateToolNameArray(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): string[] | undefined {
  const values = validateStringArray(raw, field, filePath, errors);
  if (!values) return undefined;
  const invalid = values.find((value) => value.includes("*"));
  if (invalid !== undefined) {
    errors.push({
      file: filePath,
      field,
      message: `must contain concrete tool names; wildcard patterns are not supported (${invalid})`,
    });
    return undefined;
  }
  return normalizeToolNameList(values);
}

function validateToolUseSelectorArray(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): string[] | undefined {
  const values = validateStringArray(raw, field, filePath, errors);
  if (!values) return undefined;
  const invalid = values.find((value) => !isToolUseSelector(value));
  if (invalid !== undefined) {
    errors.push({
      file: filePath,
      field,
      message: `unknown tool selector "${invalid}" (allowed: ${formatToolUseSelectorList()})`,
    });
    return undefined;
  }
  return uniquePreservingOrder(values.map(normalizeToolUseSelector));
}

function uniquePreservingOrder(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function validateCapabilityHooks(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityHooksConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "capabilities.hooks",
      message: "must be an object",
    });
    return undefined;
  }
  const out: CapabilityHooksConfig = {};
  const allowed = new Set<string>(HOOKS_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `capabilities.hooks.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.http !== undefined) {
    const http = validateHooksHttpConfig(raw.http, filePath, errors);
    if (http) out.http = http;
  }
  if (raw.workflow !== undefined) {
    if (Array.isArray(raw.workflow)) {
      out.workflow = raw.workflow
        .map((hook, i) => validateWorkflowHookConfig(hook, i, filePath, errors))
        .filter((hook): hook is CapabilityWorkflowHookConfig => !!hook);
    } else {
      errors.push({
        file: filePath,
        field: "capabilities.hooks.workflow",
        message: "must be an array",
      });
    }
  }
  if (raw.events !== undefined) {
    if (Array.isArray(raw.events)) {
      out.events = raw.events
        .map((hook, i) => validateEventHookConfig(hook, i, filePath, errors))
        .filter((hook): hook is CapabilityEventHookConfig => !!hook);
    } else {
      errors.push({
        file: filePath,
        field: "capabilities.hooks.events",
        message: "must be an array",
      });
    }
  }
  return out;
}

function validateHooksHttpConfig(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityHooksHttpConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "capabilities.hooks.http",
      message: "must be an object",
    });
    return undefined;
  }
  validateKnownKeys(
    raw,
    "capabilities.hooks.http",
    filePath,
    errors,
    new Set<string>(HOOKS_HTTP_CONFIG_KEYS),
  );
  const out: CapabilityHooksHttpConfig = {};
  if (raw.enabled !== undefined) {
    out.enabled = validateOptionalBoolean(
      raw.enabled,
      "capabilities.hooks.http.enabled",
      filePath,
      errors,
    );
  }
  if (raw.allow !== undefined) {
    if (!Array.isArray(raw.allow)) {
      errors.push({
        file: filePath,
        field: "capabilities.hooks.http.allow",
        message: "must be an array",
      });
    } else {
      out.allow = raw.allow
        .map((entry, i) =>
          validateHooksHttpAllowRule(
            entry,
            `capabilities.hooks.http.allow.${i}`,
            filePath,
            errors,
          ),
        )
        .filter((entry): entry is CapabilityHooksHttpAllowRule => !!entry);
    }
  }
  if (raw.allowPrivateNetwork !== undefined) {
    out.allowPrivateNetwork = validateOptionalBoolean(
      raw.allowPrivateNetwork,
      "capabilities.hooks.http.allowPrivateNetwork",
      filePath,
      errors,
    );
  }
  return out;
}

function validateHooksHttpAllowRule(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityHooksHttpAllowRule | undefined {
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  validateKnownKeys(
    raw,
    field,
    filePath,
    errors,
    new Set<string>(HOOKS_HTTP_ALLOW_CONFIG_KEYS),
  );
  const hasOrigin = raw.origin !== undefined;
  const hasHostname = raw.hostname !== undefined;
  if (hasOrigin === hasHostname) {
    errors.push({
      file: filePath,
      field,
      message: "must specify exactly one of origin or hostname",
    });
    return undefined;
  }
  if (hasOrigin) {
    if (!isHttpUrlString(raw.origin)) {
      errors.push({
        file: filePath,
        field: `${field}.origin`,
        message: "must be an http(s) origin",
      });
      return undefined;
    }
    return { origin: raw.origin };
  }
  if (typeof raw.hostname !== "string" || raw.hostname.length === 0) {
    errors.push({
      file: filePath,
      field: `${field}.hostname`,
      message: "must be a non-empty string",
    });
    return undefined;
  }
  return { hostname: raw.hostname };
}

function validateWorkflowHookConfig(
  raw: unknown,
  index: number,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityWorkflowHookConfig | undefined {
  const field = `capabilities.hooks.workflow.${index}`;
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const allowed = new Set<string>(WORKFLOW_HOOK_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    errors.push({
      file: filePath,
      field: `${field}.name`,
      message: "must be a non-empty string",
    });
    return undefined;
  }
  if (!isStringOption(raw.hook, WORKFLOW_HOOK_NAMES)) {
    errors.push({
      file: filePath,
      field: `${field}.hook`,
      message: `must be one of ${WORKFLOW_HOOK_NAMES.join(" | ")}`,
    });
    return undefined;
  }
  const action = validateWorkflowHookAction(
    raw.action,
    field,
    filePath,
    errors,
  );
  if (!action) return undefined;
  const out: CapabilityWorkflowHookConfig = {
    name: raw.name,
    hook: raw.hook as WorkflowHookName,
    action,
  };
  if (raw.description !== undefined) {
    if (typeof raw.description === "string") {
      out.description = raw.description;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.description`,
        message: "must be a string",
      });
    }
  }
  if (raw.enabled !== undefined) {
    out.enabled = validateOptionalBoolean(
      raw.enabled,
      `${field}.enabled`,
      filePath,
      errors,
    );
  }
  if (raw.onError !== undefined) {
    if (isStringOption(raw.onError, WORKFLOW_HOOK_ON_ERROR_MODES)) {
      out.onError = raw.onError;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.onError`,
        message: "must be continue or block",
      });
    }
  }
  if (raw.frequency !== undefined) {
    if (isStringOption(raw.frequency, WORKFLOW_HOOK_FREQUENCIES)) {
      out.frequency = raw.frequency;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.frequency`,
        message: "must be always or oncePerTurn",
      });
    }
  }
  if (raw.matcher !== undefined) {
    const matcher = validateWorkflowHookMatcher(
      raw.matcher,
      `${field}.matcher`,
      filePath,
      errors,
    );
    if (matcher) out.matcher = matcher;
  }
  return out;
}

function validateEventHookConfig(
  raw: unknown,
  index: number,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityEventHookConfig | undefined {
  const field = `capabilities.hooks.events.${index}`;
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const allowed = new Set<string>(EVENT_HOOK_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    errors.push({
      file: filePath,
      field: `${field}.name`,
      message: "must be a non-empty string",
    });
    return undefined;
  }
  const trigger = validateEventHookTrigger(
    raw.trigger,
    field,
    filePath,
    errors,
  );
  if (!trigger) return undefined;
  const action = validateEventHookAction(raw.action, field, filePath, errors);
  if (!action) return undefined;
  const out: CapabilityEventHookConfig = {
    name: raw.name,
    trigger,
    action,
  };
  if (raw.description !== undefined) {
    if (typeof raw.description === "string") {
      out.description = raw.description;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.description`,
        message: "must be a string",
      });
    }
  }
  if (raw.enabled !== undefined) {
    out.enabled = validateOptionalBoolean(
      raw.enabled,
      `${field}.enabled`,
      filePath,
      errors,
    );
  }
  if (raw.matcher !== undefined) {
    const matcher = validateWorkflowHookMatcher(
      raw.matcher,
      `${field}.matcher`,
      filePath,
      errors,
    );
    if (matcher) out.matcher = matcher;
  }
  return out;
}

function validateEventHookTrigger(
  raw: unknown,
  parentField: string,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityEventHookConfig["trigger"] | undefined {
  const field = `${parentField}.trigger`;
  const values = Array.isArray(raw) ? raw : [raw];
  if (
    values.length === 0 ||
    !values.every((value) => isStringOption(value, EVENT_HOOK_TRIGGERS))
  ) {
    errors.push({
      file: filePath,
      field,
      message: `must be one of ${EVENT_HOOK_TRIGGERS.join(" | ")} or an array of those values`,
    });
    return undefined;
  }
  return Array.isArray(raw)
    ? (values as CapabilityEventHookConfig["trigger"])
    : (values[0] as CapabilityEventHookConfig["trigger"]);
}

function validateWorkflowHookAction(
  raw: unknown,
  parentField: string,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityHookActionConfig | undefined {
  return validateHookAction(raw, parentField, filePath, errors, [
    "block",
    "context",
    "command",
    "http",
    "agent",
  ]);
}

function validateEventHookAction(
  raw: unknown,
  parentField: string,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityEventHookConfig["action"] | undefined {
  return validateHookAction(raw, parentField, filePath, errors, [
    "command",
    "http",
    "agent",
  ]) as CapabilityEventHookConfig["action"] | undefined;
}

function validateAgentProfileWorkflowHooks(
  raw: unknown,
  field: string,
  profileId: string,
  filePath: string,
  errors: SharedConfigError[],
): AgentProfile["hooks"] | undefined {
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  validateKnownKeys(
    raw,
    field,
    filePath,
    errors,
    new Set<string>(WORKFLOW_HOOK_NAMES),
  );
  const hooks: AgentProfileWorkflowHookConfig[] = [];
  for (const hookName of WORKFLOW_HOOK_NAMES) {
    const entriesRaw = raw[hookName];
    if (entriesRaw === undefined) continue;
    if (!Array.isArray(entriesRaw)) {
      errors.push({
        file: filePath,
        field: `${field}.${hookName}`,
        message: "must be an array",
      });
      continue;
    }
    entriesRaw.forEach((entry, index) => {
      const hook = validateAgentProfileWorkflowHookEntry(
        entry,
        `${field}.${hookName}.${index}`,
        profileId,
        hookName as WorkflowHookName,
        index,
        filePath,
        errors,
      );
      if (hook) hooks.push(hook);
    });
  }
  if (hooks.length === 0) {
    errors.push({
      file: filePath,
      field,
      message: "must contain at least one valid workflow hook",
    });
    return undefined;
  }
  return hooks;
}

function validateAgentProfileWorkflowHookEntry(
  raw: unknown,
  field: string,
  profileId: string,
  hook: WorkflowHookName,
  index: number,
  filePath: string,
  errors: SharedConfigError[],
): AgentProfileWorkflowHookConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  validateKnownKeys(
    raw,
    field,
    filePath,
    errors,
    new Set<string>(AGENT_PROFILE_WORKFLOW_HOOK_CONFIG_KEYS),
  );
  const action = validateAgentProfileWorkflowHookAction(
    raw.action,
    field,
    filePath,
    errors,
  );
  if (!action) return undefined;
  const out: AgentProfileWorkflowHookConfig = {
    name: `${profileId}.${hook}.${index}`,
    hook,
    action,
  };
  if (raw.name !== undefined) {
    if (typeof raw.name === "string" && raw.name.length > 0) {
      out.name = raw.name;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.name`,
        message: "must be a non-empty string",
      });
    }
  }
  if (raw.description !== undefined) {
    if (typeof raw.description === "string") {
      out.description = raw.description;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.description`,
        message: "must be a string",
      });
    }
  }
  if (raw.enabled !== undefined) {
    const enabled = validateOptionalBoolean(
      raw.enabled,
      `${field}.enabled`,
      filePath,
      errors,
    );
    if (enabled !== undefined) out.enabled = enabled;
  }
  if (raw.onError !== undefined) {
    if (isStringOption(raw.onError, WORKFLOW_HOOK_ON_ERROR_MODES)) {
      out.onError = raw.onError;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.onError`,
        message: "must be continue or block",
      });
    }
  }
  if (raw.frequency !== undefined) {
    if (isStringOption(raw.frequency, WORKFLOW_HOOK_FREQUENCIES)) {
      out.frequency = raw.frequency;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.frequency`,
        message: "must be always or oncePerTurn",
      });
    }
  }
  if (raw.matcher !== undefined) {
    const matcher = validateAgentProfileWorkflowHookMatcher(
      raw.matcher,
      `${field}.matcher`,
      filePath,
      errors,
    );
    if (!matcher) return undefined;
    out.matcher = matcher;
  }
  return out;
}

function validateAgentProfileWorkflowHookAction(
  raw: unknown,
  parentField: string,
  filePath: string,
  errors: SharedConfigError[],
): AgentProfileWorkflowHookConfig["action"] | undefined {
  return validateHookAction(raw, parentField, filePath, errors, [
    "block",
    "context",
    "command",
    "http",
  ]) as AgentProfileWorkflowHookConfig["action"] | undefined;
}

function validateAgentProfileWorkflowHookMatcher(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): WorkflowHookMatcher | undefined {
  if (typeof raw === "string") {
    const toolName = raw.trim();
    if (toolName.length > 0) return { toolName };
    errors.push({
      file: filePath,
      field,
      message: "must be a non-empty string or matcher object",
    });
    return undefined;
  }
  const matcher = validateWorkflowHookMatcher(raw, field, filePath, errors);
  if (!matcher) return undefined;
  if (Object.keys(matcher).length === 0) {
    errors.push({
      file: filePath,
      field,
      message: "must include at least one matcher field",
    });
    return undefined;
  }
  return matcher;
}

function validateHookAction(
  raw: unknown,
  parentField: string,
  filePath: string,
  errors: SharedConfigError[],
  allowedTypes: readonly CapabilityHookActionConfig["type"][],
): CapabilityHookActionConfig | undefined {
  const field = `${parentField}.action`;
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const type = raw.type;
  if (
    !isStringOption(type, WORKFLOW_HOOK_ACTION_TYPES) ||
    !allowedTypes.includes(type)
  ) {
    errors.push({
      file: filePath,
      field: `${field}.type`,
      message: `must be ${allowedTypes.join(", or ")}`,
    });
    return undefined;
  }
  validateKnownKeys(
    raw,
    field,
    filePath,
    errors,
    new Set<string>(WORKFLOW_HOOK_ACTION_CONFIG_KEYS_BY_TYPE[type]),
  );
  if (type === "block") {
    if (typeof raw.reason !== "string" || raw.reason.length === 0) {
      errors.push({
        file: filePath,
        field: `${field}.reason`,
        message: "must be a non-empty string",
      });
      return undefined;
    }
    return { type, reason: raw.reason };
  }
  if (type === "context") {
    if (typeof raw.content !== "string" || raw.content.length === 0) {
      errors.push({
        file: filePath,
        field: `${field}.content`,
        message: "must be a non-empty string",
      });
      return undefined;
    }
    const contextType = raw.contextType;
    const parsedContextType =
      contextType === undefined
        ? undefined
        : isStringOption(contextType, WORKFLOW_HOOK_CONTEXT_TYPES)
          ? contextType
          : undefined;
    if (contextType !== undefined && parsedContextType === undefined) {
      errors.push({
        file: filePath,
        field: `${field}.contextType`,
        message: "must be system, user, or summary",
      });
      return undefined;
    }
    return {
      type,
      content: raw.content,
      ...(parsedContextType ? { contextType: parsedContextType } : {}),
    };
  }
  if (type === "http") {
    if (!isHttpUrlString(raw.url)) {
      errors.push({
        file: filePath,
        field: `${field}.url`,
        message: "must be an http(s) URL",
      });
      return undefined;
    }
    const method = raw.method;
    const parsedMethod =
      method === undefined
        ? undefined
        : isStringOption(method, WORKFLOW_HOOK_HTTP_METHODS)
          ? method
          : undefined;
    if (method !== undefined && parsedMethod === undefined) {
      errors.push({
        file: filePath,
        field: `${field}.method`,
        message: `must be one of ${WORKFLOW_HOOK_HTTP_METHODS.join(" | ")}`,
      });
      return undefined;
    }
    return {
      type,
      url: raw.url,
      ...(parsedMethod ? { method: parsedMethod } : {}),
      ...(raw.headers !== undefined
        ? {
            headers: validateStringRecord(
              raw.headers,
              `${field}.headers`,
              filePath,
              errors,
            ),
          }
        : {}),
      ...(raw.body !== undefined
        ? typeof raw.body === "string"
          ? { body: raw.body }
          : (errors.push({
              file: filePath,
              field: `${field}.body`,
              message: "must be a string",
            }),
            {})
        : {}),
      ...(raw.timeoutMs !== undefined
        ? {
            timeoutMs: validateOptionalPositiveInteger(
              raw.timeoutMs,
              `${field}.timeoutMs`,
              filePath,
              errors,
            ),
          }
        : {}),
      ...(raw.blockOnFailure !== undefined
        ? {
            blockOnFailure: validateOptionalBoolean(
              raw.blockOnFailure,
              `${field}.blockOnFailure`,
              filePath,
              errors,
            ),
          }
        : {}),
      ...(raw.injectOutput !== undefined
        ? isStringOption(raw.injectOutput, WORKFLOW_HOOK_OUTPUT_INJECTION_MODES)
          ? { injectOutput: raw.injectOutput }
          : (errors.push({
              file: filePath,
              field: `${field}.injectOutput`,
              message: "must be always, onFailure, or never",
            }),
            {})
        : {}),
      ...(raw.resultMode !== undefined
        ? isStringOption(raw.resultMode, WORKFLOW_HOOK_HTTP_RESULT_MODES)
          ? { resultMode: raw.resultMode }
          : (errors.push({
              file: filePath,
              field: `${field}.resultMode`,
              message: "must be status or responseJson",
            }),
            {})
        : {}),
    };
  }

  if (type === "agent") {
    const agentId =
      typeof raw.agentId === "string" && raw.agentId.length > 0
        ? raw.agentId
        : undefined;
    const toolName =
      typeof raw.toolName === "string" && raw.toolName.length > 0
        ? raw.toolName
        : undefined;
    if (!agentId && !toolName) {
      errors.push({
        file: filePath,
        field: `${field}.agentId`,
        message: "agent actions require agentId or toolName",
      });
      return undefined;
    }
    if (typeof raw.goal !== "string" || raw.goal.length === 0) {
      errors.push({
        file: filePath,
        field: `${field}.goal`,
        message: "must be a non-empty string",
      });
      return undefined;
    }
    const metadata =
      raw.metadata === undefined
        ? undefined
        : isRecord(raw.metadata)
          ? raw.metadata
          : undefined;
    if (raw.metadata !== undefined && metadata === undefined) {
      errors.push({
        file: filePath,
        field: `${field}.metadata`,
        message: "must be an object",
      });
      return undefined;
    }
    return {
      type,
      ...(agentId ? { agentId } : {}),
      ...(toolName ? { toolName } : {}),
      goal: raw.goal,
      ...(metadata ? { metadata } : {}),
      ...(raw.resultMode !== undefined
        ? isStringOption(raw.resultMode, WORKFLOW_HOOK_AGENT_RESULT_MODES)
          ? { resultMode: raw.resultMode }
          : (errors.push({
              file: filePath,
              field: `${field}.resultMode`,
              message: "must be context or workflowResult",
            }),
            {})
        : {}),
      ...(raw.injectOutput !== undefined
        ? isStringOption(raw.injectOutput, WORKFLOW_HOOK_OUTPUT_INJECTION_MODES)
          ? { injectOutput: raw.injectOutput }
          : (errors.push({
              file: filePath,
              field: `${field}.injectOutput`,
              message: "must be always, onFailure, or never",
            }),
            {})
        : {}),
    };
  }

  if (typeof raw.command !== "string" || raw.command.length === 0) {
    errors.push({
      file: filePath,
      field: `${field}.command`,
      message: "must be a non-empty string",
    });
    return undefined;
  }
  return {
    type,
    command: raw.command,
    ...(raw.args !== undefined
      ? {
          args: validateStringArray(
            raw.args,
            `${field}.args`,
            filePath,
            errors,
          ),
        }
      : {}),
    ...(raw.cwd !== undefined
      ? typeof raw.cwd === "string"
        ? { cwd: raw.cwd }
        : (errors.push({
            file: filePath,
            field: `${field}.cwd`,
            message: "must be a string",
          }),
          {})
      : {}),
    ...(raw.timeoutMs !== undefined
      ? {
          timeoutMs: validateOptionalPositiveInteger(
            raw.timeoutMs,
            `${field}.timeoutMs`,
            filePath,
            errors,
          ),
        }
      : {}),
    ...(raw.blockOnFailure !== undefined
      ? {
          blockOnFailure: validateOptionalBoolean(
            raw.blockOnFailure,
            `${field}.blockOnFailure`,
            filePath,
            errors,
          ),
        }
      : {}),
    ...(raw.injectOutput !== undefined
      ? isStringOption(raw.injectOutput, WORKFLOW_HOOK_OUTPUT_INJECTION_MODES)
        ? { injectOutput: raw.injectOutput }
        : (errors.push({
            file: filePath,
            field: `${field}.injectOutput`,
            message: "must be always, onFailure, or never",
          }),
          {})
      : {}),
    ...(raw.stdin !== undefined
      ? isStringOption(raw.stdin, WORKFLOW_HOOK_STDIN_MODES)
        ? { stdin: raw.stdin }
        : (errors.push({
            file: filePath,
            field: `${field}.stdin`,
            message: "must be none or json",
          }),
          {})
      : {}),
    ...(raw.resultMode !== undefined
      ? isStringOption(raw.resultMode, WORKFLOW_HOOK_COMMAND_RESULT_MODES)
        ? { resultMode: raw.resultMode }
        : (errors.push({
            file: filePath,
            field: `${field}.resultMode`,
            message: "must be exitCode or stdoutJson",
          }),
          {})
      : {}),
    ...(raw.maxOutputBytes !== undefined
      ? {
          maxOutputBytes: validateOptionalPositiveInteger(
            raw.maxOutputBytes,
            `${field}.maxOutputBytes`,
            filePath,
            errors,
          ),
        }
      : {}),
  };
}

function validateWorkflowHookMatcher(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): WorkflowHookMatcher | undefined {
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const allowed = new Set<string>(WORKFLOW_HOOK_MATCHER_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  const matcher: WorkflowHookMatcher = {};
  for (const key of allowed) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value === "string") {
      matcher[key as keyof WorkflowHookMatcher] = value;
      continue;
    }
    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      matcher[key as keyof WorkflowHookMatcher] = value;
      continue;
    }
    errors.push({
      file: filePath,
      field: `${field}.${key}`,
      message: "must be a string or array of strings",
    });
  }
  return matcher;
}

function validateCapabilityVerification(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityVerificationConfig | undefined {
  const field = "capabilities.verification";
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const allowed = new Set<string>(VERIFICATION_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }

  const out: CapabilityVerificationConfig = {};
  if (raw.mode !== undefined) {
    if (isStringOption(raw.mode, VERIFICATION_MODES)) {
      out.mode = raw.mode;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.mode`,
        message: "must be off, suggest, or require",
      });
    }
  }
  if (raw.defaultProfile !== undefined) {
    if (typeof raw.defaultProfile === "string" && raw.defaultProfile.length) {
      out.defaultProfile = raw.defaultProfile;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.defaultProfile`,
        message: "must be a non-empty string",
      });
    }
  }
  if (raw.profiles !== undefined) {
    const profiles = validateVerificationProfiles(
      raw.profiles,
      `${field}.profiles`,
      filePath,
      errors,
    );
    if (profiles) out.profiles = profiles;
  }
  if (raw.afterWrites !== undefined) {
    const afterWrites = validateVerificationAfterWrites(
      raw.afterWrites,
      `${field}.afterWrites`,
      filePath,
      errors,
    );
    if (afterWrites) out.afterWrites = afterWrites;
  }

  validateVerificationProfileReferences(out, field, filePath, errors);
  return out;
}

function validateVerificationProfiles(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): Record<string, CapabilityVerificationCommandConfig[]> | undefined {
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const profiles: Record<string, CapabilityVerificationCommandConfig[]> = {};
  for (const [profile, value] of Object.entries(raw)) {
    const profileField = `${field}.${profile}`;
    if (!profile) {
      errors.push({
        file: filePath,
        field,
        message: "profile names must be non-empty strings",
      });
      continue;
    }
    if (!Array.isArray(value)) {
      errors.push({
        file: filePath,
        field: profileField,
        message: "must be an array",
      });
      continue;
    }
    profiles[profile] = value
      .map((command, index) =>
        validateVerificationCommand(
          command,
          `${profileField}.${index}`,
          filePath,
          errors,
        ),
      )
      .filter(
        (command): command is CapabilityVerificationCommandConfig => !!command,
      );
  }
  return profiles;
}

function validateVerificationCommand(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityVerificationCommandConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const allowed = new Set<string>(VERIFICATION_COMMAND_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    errors.push({
      file: filePath,
      field: `${field}.id`,
      message: "must be a non-empty string",
    });
    return undefined;
  }
  if (typeof raw.command !== "string" || raw.command.length === 0) {
    errors.push({
      file: filePath,
      field: `${field}.command`,
      message: "must be a non-empty string",
    });
    return undefined;
  }
  const out: CapabilityVerificationCommandConfig = {
    id: raw.id,
    command: raw.command,
  };
  if (raw.kind !== undefined) {
    if (isVerificationKind(raw.kind)) out.kind = raw.kind;
    else {
      errors.push({
        file: filePath,
        field: `${field}.kind`,
        message: "must be lint, typecheck, test, check, or custom",
      });
    }
  }
  if (raw.args !== undefined) {
    out.args = validateStringArray(raw.args, `${field}.args`, filePath, errors);
  }
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd === "string" && raw.cwd.length > 0) out.cwd = raw.cwd;
    else {
      errors.push({
        file: filePath,
        field: `${field}.cwd`,
        message: "must be a non-empty string",
      });
    }
  }
  if (raw.timeoutMs !== undefined) {
    out.timeoutMs = validateOptionalPositiveInteger(
      raw.timeoutMs,
      `${field}.timeoutMs`,
      filePath,
      errors,
    );
  }
  if (raw.maxOutputBytes !== undefined) {
    out.maxOutputBytes = validateOptionalPositiveInteger(
      raw.maxOutputBytes,
      `${field}.maxOutputBytes`,
      filePath,
      errors,
    );
  }
  return out;
}

function validateVerificationAfterWrites(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityVerificationAfterWritesConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const allowed = new Set<string>(VERIFICATION_AFTER_WRITES_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  const out: CapabilityVerificationAfterWritesConfig = {};
  if (raw.profile !== undefined) {
    if (typeof raw.profile === "string" && raw.profile.length > 0) {
      out.profile = raw.profile;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.profile`,
        message: "must be a non-empty string",
      });
    }
  }
  if (raw.injectOutput !== undefined) {
    if (
      isStringOption(raw.injectOutput, WORKFLOW_HOOK_OUTPUT_INJECTION_MODES)
    ) {
      out.injectOutput = raw.injectOutput;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.injectOutput`,
        message: "must be always, onFailure, or never",
      });
    }
  }
  return out;
}

function validateVerificationProfileReferences(
  config: CapabilityVerificationConfig,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  const profiles = config.profiles ?? {};
  for (const [name, fieldSuffix] of [
    [config.defaultProfile, "defaultProfile"],
    [config.afterWrites?.profile, "afterWrites.profile"],
  ] as const) {
    if (!name) continue;
    if (!profiles[name]) {
      errors.push({
        file: filePath,
        field: `${field}.${fieldSuffix}`,
        message: `references unknown verification profile "${name}"`,
      });
    }
  }
}

function isVerificationKind(
  value: unknown,
): value is CapabilityVerificationKind {
  return isStringOption(value, VERIFICATION_KINDS);
}

function validateCapabilities(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "capabilities",
      message: "must be an object",
    });
    return undefined;
  }
  const out: CapabilityConfig = {};
  const allowed = new Set<string>(CAPABILITIES_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      const removedToolsMessage =
        key === "tools"
          ? "legacy capabilities.tools has been removed; use top-level tools.use/tools.allowed/tools.disabled/tools.defer instead"
          : undefined;
      errors.push({
        file: filePath,
        field: `capabilities.${key}`,
        message:
          removedToolsMessage ??
          `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.hooks !== undefined) {
    const hooks = validateCapabilityHooks(raw.hooks, filePath, errors);
    if (hooks) out.hooks = hooks;
  }
  if (raw.verification !== undefined) {
    const verification = validateCapabilityVerification(
      raw.verification,
      filePath,
      errors,
    );
    if (verification) out.verification = verification;
  }
  if (raw.skills !== undefined) {
    const skills = validateCapabilitySkills(raw.skills, filePath, errors);
    if (skills) out.skills = skills;
  }
  if (raw.mcp !== undefined) {
    const mcp = validateCapabilityMcp(raw.mcp, filePath, errors);
    if (mcp) out.mcp = mcp;
  }
  if (raw.agents !== undefined) {
    const agents = validateCapabilityAgents(raw.agents, filePath, errors);
    if (agents) out.agents = agents;
  }
  return out;
}

function stripProjectHttpHooks(
  capabilities: CapabilityConfig,
  filePath: string,
  errors: SharedConfigError[],
): void {
  const hooks = capabilities.hooks;
  if (hooks) {
    if (hooks.http !== undefined) {
      errors.push({
        file: filePath,
        field: "capabilities.hooks.http",
        message:
          "HTTP hook transport policy cannot be configured in project config; move it to user config or SPARKWRIGHT_CONFIG",
      });
      delete hooks.http;
    }
    if (hooks.workflow) {
      hooks.workflow = hooks.workflow.filter((hook, i) => {
        if (hook.action.type !== "http") return true;
        errors.push({
          file: filePath,
          field: `capabilities.hooks.workflow.${i}.action.type`,
          message:
            "http hook actions cannot be configured in project config; move the hook to user config or SPARKWRIGHT_CONFIG",
        });
        return false;
      });
    }
    if (hooks.events) {
      hooks.events = hooks.events.filter((hook, i) => {
        if (hook.action.type !== "http") return true;
        errors.push({
          file: filePath,
          field: `capabilities.hooks.events.${i}.action.type`,
          message:
            "http hook actions cannot be configured in project config; move the hook to user config or SPARKWRIGHT_CONFIG",
        });
        return false;
      });
    }
  }
  const profiles = capabilities.agents?.profiles;
  if (profiles) {
    profiles.forEach((profile, profileIndex) => {
      if (!profile.hooks) return;
      const hookIndexes = new Map<WorkflowHookName, number>();
      profile.hooks = profile.hooks.filter((hook) => {
        const hookIndex = hookIndexes.get(hook.hook) ?? 0;
        hookIndexes.set(hook.hook, hookIndex + 1);
        if (hook.action.type !== "http") return true;
        errors.push({
          file: filePath,
          field: `capabilities.agents.profiles.${profileIndex}.hooks.${hook.hook}.${hookIndex}.action.type`,
          message:
            "http hook actions cannot be configured in project config; move the hook to user config or SPARKWRIGHT_CONFIG",
        });
        return false;
      });
      if (profile.hooks.length === 0) {
        delete profile.hooks;
      }
    });
  }
}

function validateWriteGuardrails(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): WriteGuardrailsConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "write",
      message: "must be an object",
    });
    return undefined;
  }
  const out: WriteGuardrailsConfig = {};
  const allowed = new Set<string>(WRITE_GUARDRAILS_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `write.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.maxFiles !== undefined) {
    out.maxFiles = validateOptionalPositiveInteger(
      raw.maxFiles,
      "write.maxFiles",
      filePath,
      errors,
    );
  }
  if (raw.maxDiffLines !== undefined) {
    out.maxDiffLines = validateOptionalPositiveInteger(
      raw.maxDiffLines,
      "write.maxDiffLines",
      filePath,
      errors,
    );
  }
  if (raw.allowDeletions !== undefined) {
    out.allowDeletions = validateOptionalBoolean(
      raw.allowDeletions,
      "write.allowDeletions",
      filePath,
      errors,
    );
  }
  return out;
}

function validateRunBudget(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): RunBudget | undefined {
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const out: RunBudget = {};
  const allowed = new Set<string>(RUN_BUDGET_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  for (const key of RUN_BUDGET_POSITIVE_INTEGER_CONFIG_KEYS) {
    if (raw[key] !== undefined) {
      out[key] = validateOptionalPositiveInteger(
        raw[key],
        `${field}.${key}`,
        filePath,
        errors,
      );
    }
  }
  if (raw.maxCostUsd !== undefined) {
    out.maxCostUsd = validateOptionalPositiveNumber(
      raw.maxCostUsd,
      `${field}.maxCostUsd`,
      filePath,
      errors,
    );
  }
  return out;
}

function validateTasksConfig(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): Record<string, TaskConfig> | undefined {
  const tasks: Record<string, TaskConfig> = {};
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "tasks",
      message: "must be an object",
    });
    return undefined;
  }
  for (const [name, value] of Object.entries(raw)) {
    const field = `tasks.${name}`;
    if (!isRecord(value)) {
      errors.push({ file: filePath, field, message: "must be an object" });
      continue;
    }
    const allowed = new Set<string>(TASK_CONFIG_KEYS);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        errors.push({
          file: filePath,
          field: `${field}.${key}`,
          message: `unknown field (allowed: ${[...allowed].join(", ")})`,
        });
      }
    }
    const task: TaskConfig = {};
    if (value.enabled !== undefined) {
      task.enabled = validateOptionalBoolean(
        value.enabled,
        `${field}.enabled`,
        filePath,
        errors,
      );
    }
    if (value.model !== undefined) {
      const model = validateZodValue(
        modelSchema,
        value.model,
        `${field}.model`,
        filePath,
        errors,
        "must be a non-empty model reference",
      );
      if (model !== undefined) task.model = model;
    }
    if (value.budget !== undefined) {
      const budget = validateTaskBudget(
        value.budget,
        `${field}.budget`,
        filePath,
        errors,
      );
      if (budget) task.budget = budget;
    }
    tasks[name] = task;
  }
  return tasks;
}

function validateTaskBudget(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): TaskBudgetConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const out: TaskBudgetConfig = {};
  const allowed = new Set<string>(TASK_BUDGET_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  for (const key of TASK_BUDGET_POSITIVE_INTEGER_CONFIG_KEYS) {
    if (raw[key] !== undefined) {
      out[key] = validateOptionalPositiveInteger(
        raw[key],
        `${field}.${key}`,
        filePath,
        errors,
      );
    }
  }
  if (raw.maxCostUsd !== undefined) {
    out.maxCostUsd = validateOptionalPositiveNumber(
      raw.maxCostUsd,
      `${field}.maxCostUsd`,
      filePath,
      errors,
    );
  }
  if (raw.unknownCostPolicy !== undefined) {
    if (isStringOption(raw.unknownCostPolicy, TASK_UNKNOWN_COST_POLICIES)) {
      out.unknownCostPolicy = raw.unknownCostPolicy;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.unknownCostPolicy`,
        message: "must be skip or token_cap_only",
      });
    }
  }
  return out;
}

function validateApprovals(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): ApprovalDefaults | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "approvals",
      message: "must be an object",
    });
    return undefined;
  }
  const out: ApprovalDefaults = {};
  const allowed = new Set<string>(APPROVALS_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `approvals.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  for (const key of APPROVAL_BOOLEAN_CONFIG_KEYS) {
    if (raw[key] !== undefined) {
      out[key] = validateOptionalBoolean(
        raw[key],
        `approvals.${key}`,
        filePath,
        errors,
      );
    }
  }
  if (raw.cronMode !== undefined) {
    if (isStringOption(raw.cronMode, PERMISSION_MODE_CONFIG_VALUES)) {
      out.cronMode = raw.cronMode;
    } else {
      errors.push({
        file: filePath,
        field: "approvals.cronMode",
        message: `must be one of ${PERMISSION_MODES.join(" | ")}`,
      });
    }
  }
  return out;
}

function validateShellConfig(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): ShellConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "shell",
      message: "must be an object",
    });
    return undefined;
  }
  const out: ShellConfig = {};
  const allowed = new Set<string>(SHELL_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `shell.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.sandbox !== undefined) {
    const sandbox = validateShellSandboxConfig(raw.sandbox, filePath, errors);
    if (sandbox) out.sandbox = sandbox;
  }
  if (raw.foregroundTimeoutMs !== undefined) {
    const foregroundTimeoutMs = validateOptionalPositiveInteger(
      raw.foregroundTimeoutMs,
      "shell.foregroundTimeoutMs",
      filePath,
      errors,
    );
    if (foregroundTimeoutMs !== undefined) {
      if (foregroundTimeoutMs > MAX_FOREGROUND_TIMEOUT_MS) {
        errors.push({
          file: filePath,
          field: "shell.foregroundTimeoutMs",
          message: `must be <= ${MAX_FOREGROUND_TIMEOUT_MS}`,
        });
      } else {
        out.foregroundTimeoutMs = foregroundTimeoutMs;
      }
    }
  }
  return out;
}

function validateShellSandboxConfig(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): ShellSandboxConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "shell.sandbox",
      message: "must be an object",
    });
    return undefined;
  }
  const out: ShellSandboxConfig = {};
  const allowed = new Set<string>(SHELL_SANDBOX_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `shell.sandbox.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.mode !== undefined) {
    if (isStringOption(raw.mode, SHELL_SANDBOX_MODES)) {
      out.mode = raw.mode;
    } else {
      errors.push({
        file: filePath,
        field: "shell.sandbox.mode",
        message: "must be off, warn, or enforce",
      });
    }
  }
  if (raw.failIfUnavailable !== undefined) {
    out.failIfUnavailable = validateOptionalBoolean(
      raw.failIfUnavailable,
      "shell.sandbox.failIfUnavailable",
      filePath,
      errors,
    );
  }
  if (raw.filesystem !== undefined) {
    const filesystem = validateShellSandboxFilesystem(
      raw.filesystem,
      filePath,
      errors,
    );
    if (filesystem) out.filesystem = filesystem;
  }
  if (raw.network !== undefined) {
    const network = validateShellSandboxNetwork(raw.network, filePath, errors);
    if (network) out.network = network;
  }
  return out;
}

function validateShellSandboxFilesystem(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): NonNullable<ShellSandboxConfig["filesystem"]> | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "shell.sandbox.filesystem",
      message: "must be an object",
    });
    return undefined;
  }
  const out: NonNullable<ShellSandboxConfig["filesystem"]> = {};
  const allowed = new Set<string>(SHELL_SANDBOX_FILESYSTEM_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `shell.sandbox.filesystem.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  for (const key of SHELL_SANDBOX_FILESYSTEM_PATH_CONFIG_KEYS) {
    if (raw[key] !== undefined) {
      out[key] = validateStringArray(
        raw[key],
        `shell.sandbox.filesystem.${key}`,
        filePath,
        errors,
      );
    }
  }
  if (raw.tmp !== undefined) {
    out.tmp = validateOptionalBoolean(
      raw.tmp,
      "shell.sandbox.filesystem.tmp",
      filePath,
      errors,
    );
  }
  return out;
}

function validateShellSandboxNetwork(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): NonNullable<ShellSandboxConfig["network"]> | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "shell.sandbox.network",
      message: "must be an object",
    });
    return undefined;
  }
  const out: NonNullable<ShellSandboxConfig["network"]> = {};
  const allowed = new Set<string>(SHELL_SANDBOX_NETWORK_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `shell.sandbox.network.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.mode !== undefined) {
    if (isStringOption(raw.mode, SHELL_SANDBOX_NETWORK_MODES)) {
      out.mode = raw.mode;
    } else {
      errors.push({
        file: filePath,
        field: "shell.sandbox.network.mode",
        message: "must be allow or deny",
      });
    }
  }
  return out;
}

function validateStringRecord(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): Record<string, string> | undefined {
  return validateZodValue(
    stringRecordSchema,
    raw,
    field,
    filePath,
    errors,
    "must be an object with string values",
  );
}

function mergeShellConfig(
  previous: ShellConfig | undefined,
  next: ShellConfig,
): ShellConfig {
  return {
    ...(previous ?? {}),
    ...next,
    sandbox:
      previous?.sandbox || next.sandbox
        ? mergeShellSandboxConfig(previous?.sandbox, next.sandbox)
        : undefined,
  };
}

const SHELL_SANDBOX_MODE_RANK = {
  off: 0,
  warn: 1,
  enforce: 2,
} as const satisfies Record<NonNullable<ShellSandboxConfig["mode"]>, number>;

function mergeShellSandboxConfig(
  previous: ShellSandboxConfig | undefined,
  next: ShellSandboxConfig | undefined,
): ShellSandboxConfig | undefined {
  if (!previous) return next;
  if (!next) return previous;

  return {
    mode: stricterSandboxMode(previous.mode, next.mode),
    failIfUnavailable:
      previous.failIfUnavailable === true || next.failIfUnavailable === true
        ? true
        : (previous.failIfUnavailable ?? next.failIfUnavailable),
    filesystem: mergeShellSandboxFilesystem(
      previous.filesystem,
      next.filesystem,
    ),
    network: mergeShellSandboxNetwork(previous.network, next.network),
  };
}

function stricterSandboxMode(
  previous: ShellSandboxConfig["mode"],
  next: ShellSandboxConfig["mode"],
): ShellSandboxConfig["mode"] {
  if (!previous) return next;
  if (!next) return previous;
  return SHELL_SANDBOX_MODE_RANK[next] > SHELL_SANDBOX_MODE_RANK[previous]
    ? next
    : previous;
}

function mergeShellSandboxFilesystem(
  previous: ShellSandboxConfig["filesystem"],
  next: ShellSandboxConfig["filesystem"],
): ShellSandboxConfig["filesystem"] {
  if (!previous) return next;
  if (!next) return previous;
  return {
    allowRead: mergeUniqueStrings(previous.allowRead, next.allowRead),
    allowWrite: mergeUniqueStrings(previous.allowWrite, next.allowWrite),
    denyRead: mergeUniqueStrings(previous.denyRead, next.denyRead),
    denyWrite: mergeUniqueStrings(previous.denyWrite, next.denyWrite),
    tmp:
      previous.tmp === false || next.tmp === false
        ? false
        : (previous.tmp ?? next.tmp),
  };
}

function mergeShellSandboxNetwork(
  previous: ShellSandboxConfig["network"],
  next: ShellSandboxConfig["network"],
): ShellSandboxConfig["network"] {
  if (!previous) return next;
  if (!next) return previous;
  if (previous.mode === "deny" || next.mode === "deny") {
    return { mode: "deny" };
  }
  return { mode: previous.mode ?? next.mode };
}

function mergeUniqueStrings(
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined,
): string[] | undefined {
  if (!previous) return next ? [...next] : undefined;
  if (!next) return [...previous];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...previous, ...next]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function intersectUniqueStrings(
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined,
): string[] | undefined {
  if (previous === undefined) return next ? [...next] : undefined;
  if (next === undefined) return [...previous];
  const nextSet = new Set(next);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of previous) {
    if (!nextSet.has(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function mergeToolConfig(
  previous: CapabilityToolsConfig | undefined,
  next: CapabilityToolsConfig | undefined,
): CapabilityToolsConfig | undefined {
  if (!previous) return next ? { ...next } : undefined;
  if (!next) return { ...previous };
  return pruneToolConfig({
    // Tool selectors are a tightening boundary, so layers intersect by the
    // concrete tool sets they imply (`mcp` ∩ `mcp:demo` = `mcp:demo`).
    use: intersectToolUseSelectors(previous.use, next.use),
    // Allowed tools are a tightening boundary, so layers intersect.
    allowed: intersectUniqueStrings(previous.allowed, next.allowed),
    // Disabled tools are a tightening boundary, so layers union.
    disabled: mergeUniqueStrings(previous.disabled, next.disabled),
    // Defer is a loading preference, not a safety boundary. A later explicit
    // value replaces the prior one so users can remove a default defer entry.
    defer:
      next.defer !== undefined
        ? [...next.defer]
        : previous.defer
          ? [...previous.defer]
          : undefined,
  });
}

function pruneToolConfig(config: CapabilityToolsConfig): CapabilityToolsConfig {
  return {
    ...(config.use !== undefined ? { use: config.use } : {}),
    ...(config.allowed !== undefined ? { allowed: config.allowed } : {}),
    ...(config.disabled && config.disabled.length > 0
      ? { disabled: config.disabled }
      : {}),
    ...(config.defer !== undefined ? { defer: config.defer } : {}),
  };
}

function validateMcpServer(
  raw: unknown,
  index: number,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityMcpServerConfig | undefined {
  const field = `capabilities.mcp.servers.${index}`;
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const type = raw.type;
  const name = raw.name;
  if (type !== "stdio" && type !== "http") {
    errors.push({
      file: filePath,
      field: `${field}.type`,
      message: "must be stdio or http",
    });
    return undefined;
  }
  if (typeof name !== "string" || name.length === 0) {
    errors.push({
      file: filePath,
      field: `${field}.name`,
      message: "must be a non-empty string",
    });
    return undefined;
  }
  const common = {
    name,
    ...(raw.timeoutMs !== undefined
      ? {
          timeoutMs: validateOptionalPositiveInteger(
            raw.timeoutMs,
            `${field}.timeoutMs`,
            filePath,
            errors,
          ),
        }
      : {}),
    ...(raw.enabled !== undefined
      ? {
          enabled: validateOptionalBoolean(
            raw.enabled,
            `${field}.enabled`,
            filePath,
            errors,
          ),
        }
      : {}),
    ...(raw.toolSchemaLoad !== undefined
      ? {
          toolSchemaLoad: validateMcpToolSchemaLoad(
            raw.toolSchemaLoad,
            `${field}.toolSchemaLoad`,
            filePath,
            errors,
          ),
        }
      : {}),
  };
  if (type === "stdio") {
    if (typeof raw.command !== "string" || raw.command.length === 0) {
      errors.push({
        file: filePath,
        field: `${field}.command`,
        message: "must be a non-empty string",
      });
      return undefined;
    }
    return {
      type,
      ...common,
      command: raw.command,
      ...(raw.args !== undefined
        ? {
            args: validateStringArray(
              raw.args,
              `${field}.args`,
              filePath,
              errors,
            ),
          }
        : {}),
      ...(raw.cwd !== undefined
        ? typeof raw.cwd === "string"
          ? { cwd: raw.cwd }
          : (errors.push({
              file: filePath,
              field: `${field}.cwd`,
              message: "must be a string",
            }),
            {})
        : {}),
      ...(raw.env !== undefined
        ? {
            env: validateStringRecord(
              raw.env,
              `${field}.env`,
              filePath,
              errors,
            ),
          }
        : {}),
    };
  }
  if (typeof raw.url !== "string" || !/^https?:\/\//i.test(raw.url)) {
    errors.push({
      file: filePath,
      field: `${field}.url`,
      message: "must be an http(s) URL",
    });
    return undefined;
  }
  return {
    type,
    ...common,
    url: raw.url,
    ...(raw.headers !== undefined
      ? {
          headers: validateStringRecord(
            raw.headers,
            `${field}.headers`,
            filePath,
            errors,
          ),
        }
      : {}),
  };
}

function validateMcpToolSchemaLoad(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityMcpToolSchemaLoad | undefined {
  if (isStringOption(raw, MCP_TOOL_SCHEMA_LOAD_MODES)) {
    return raw;
  }
  errors.push({
    file: filePath,
    field,
    message: "must be eager or defer",
  });
  return undefined;
}

function validateMcpStartup(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityMcpStartup | undefined {
  if (isStringOption(raw, MCP_STARTUP_MODES)) {
    return raw;
  }
  errors.push({
    file: filePath,
    field,
    message: "must be lazy, prepare, or eager",
  });
  return undefined;
}

function validateCapabilityMcp(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityMcpConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "capabilities.mcp",
      message: "must be an object",
    });
    return undefined;
  }
  const out: CapabilityMcpConfig = {};
  const allowed = new Set<string>(MCP_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `capabilities.mcp.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.servers !== undefined) {
    if (Array.isArray(raw.servers)) {
      out.servers = raw.servers
        .map((server, i) => validateMcpServer(server, i, filePath, errors))
        .filter((server): server is CapabilityMcpServerConfig => !!server);
    } else {
      errors.push({
        file: filePath,
        field: "capabilities.mcp.servers",
        message: "must be an array",
      });
    }
  }
  if (raw.defaultTimeoutMs !== undefined) {
    out.defaultTimeoutMs = validateOptionalPositiveInteger(
      raw.defaultTimeoutMs,
      "capabilities.mcp.defaultTimeoutMs",
      filePath,
      errors,
    );
  }
  if (raw.namePrefix !== undefined) {
    if (typeof raw.namePrefix === "string") out.namePrefix = raw.namePrefix;
    else
      errors.push({
        file: filePath,
        field: "capabilities.mcp.namePrefix",
        message: "must be a string",
      });
  }
  if (raw.startup !== undefined) {
    out.startup = validateMcpStartup(
      raw.startup,
      "capabilities.mcp.startup",
      filePath,
      errors,
    );
  }
  if (raw.toolSchemaLoad !== undefined) {
    out.toolSchemaLoad = validateMcpToolSchemaLoad(
      raw.toolSchemaLoad,
      "capabilities.mcp.toolSchemaLoad",
      filePath,
      errors,
    );
  }
  if (raw.defaultPolicy !== undefined) {
    if (isRecord(raw.defaultPolicy)) {
      const policy: NonNullable<CapabilityMcpConfig["defaultPolicy"]> = {};
      validateKnownKeys(
        raw.defaultPolicy,
        "capabilities.mcp.defaultPolicy",
        filePath,
        errors,
        new Set<string>(MCP_DEFAULT_POLICY_CONFIG_KEYS),
      );
      const risk = raw.defaultPolicy.risk;
      if (risk !== undefined) {
        if (isStringOption(risk, MCP_DEFAULT_POLICY_RISKS)) policy.risk = risk;
        else
          errors.push({
            file: filePath,
            field: "capabilities.mcp.defaultPolicy.risk",
            message: "must be safe, risky, or denied",
          });
      }
      if (raw.defaultPolicy.requiresApproval !== undefined) {
        policy.requiresApproval = validateOptionalBoolean(
          raw.defaultPolicy.requiresApproval,
          "capabilities.mcp.defaultPolicy.requiresApproval",
          filePath,
          errors,
        );
      }
      out.defaultPolicy = policy;
    } else {
      errors.push({
        file: filePath,
        field: "capabilities.mcp.defaultPolicy",
        message: "must be an object",
      });
    }
  }
  return out;
}

function validateAgentProfile(
  raw: unknown,
  index: number,
  filePath: string,
  errors: SharedConfigError[],
): AgentProfile | undefined {
  const field = `capabilities.agents.profiles.${index}`;
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    errors.push({
      file: filePath,
      field: `${field}.id`,
      message: "must be a non-empty string",
    });
    return undefined;
  }
  validateKnownKeys(
    raw,
    field,
    filePath,
    errors,
    new Set<string>(AGENT_PROFILE_CONFIG_KEYS),
  );
  const profile: AgentProfile = { id: raw.id };
  for (const key of AGENT_PROFILE_OPTIONAL_STRING_CONFIG_KEYS) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] === "string") profile[key] = raw[key];
      else
        errors.push({
          file: filePath,
          field: `${field}.${key}`,
          message: "must be a string",
        });
    }
  }
  if (raw.mode !== undefined) {
    if (isStringOption(raw.mode, AGENT_PROFILE_MODES)) profile.mode = raw.mode;
    else
      errors.push({
        file: filePath,
        field: `${field}.mode`,
        message: "must be primary, child, or all",
      });
  }
  if (raw.model !== undefined) profile.model = raw.model;
  if (raw.use !== undefined) {
    profile.use = validateToolUseSelectorArray(
      raw.use,
      `${field}.use`,
      filePath,
      errors,
    );
  }
  for (const key of AGENT_PROFILE_TOOL_ARRAY_CONFIG_KEYS) {
    if (raw[key] !== undefined) {
      profile[key] = validateToolNameArray(
        raw[key],
        `${field}.${key}`,
        filePath,
        errors,
      );
    }
  }
  if (raw.triggers !== undefined) {
    profile.triggers = validateStringArray(
      raw.triggers,
      `${field}.triggers`,
      filePath,
      errors,
    );
  }
  if (raw.when !== undefined) {
    if (isRecord(raw.when)) {
      validateKnownKeys(
        raw.when,
        `${field}.when`,
        filePath,
        errors,
        new Set(["keywords"]),
      );
      if (raw.when.keywords !== undefined) {
        const keywords = validateStringArray(
          raw.when.keywords,
          `${field}.when.keywords`,
          filePath,
          errors,
        );
        if (keywords !== undefined) profile.when = { keywords };
      }
    } else {
      errors.push({
        file: filePath,
        field: `${field}.when`,
        message: "must be an object",
      });
    }
  }
  if (raw.delegateTool !== undefined) {
    if (isRecord(raw.delegateTool)) {
      profile.delegateTool = validateAgentProfileDelegateTool(
        raw.delegateTool,
        `${field}.delegateTool`,
        filePath,
        errors,
      );
    } else {
      errors.push({
        file: filePath,
        field: `${field}.delegateTool`,
        message: "must be an object",
      });
    }
  }
  if (raw.exposeAsDelegate !== undefined) {
    const parsed = validateOptionalBoolean(
      raw.exposeAsDelegate,
      `${field}.exposeAsDelegate`,
      filePath,
      errors,
    );
    if (parsed !== undefined) profile.exposeAsDelegate = parsed;
  }
  if (raw.hooks !== undefined) {
    const hooks = validateAgentProfileWorkflowHooks(
      raw.hooks,
      `${field}.hooks`,
      raw.id,
      filePath,
      errors,
    );
    if (hooks) {
      profile.hooks = hooks;
    }
  }
  if (raw.policy !== undefined) {
    if (Array.isArray(raw.policy) && raw.policy.every(isRecord)) {
      profile.policy = raw.policy as unknown as AgentProfile["policy"];
    } else {
      errors.push({
        file: filePath,
        field: `${field}.policy`,
        message: "must be an array of objects",
      });
    }
  }
  if (raw.maxSteps !== undefined) {
    profile.maxSteps = validateOptionalPositiveInteger(
      raw.maxSteps,
      `${field}.maxSteps`,
      filePath,
      errors,
    );
  }
  if (raw.runBudget !== undefined) {
    if (isRecord(raw.runBudget))
      profile.runBudget = raw.runBudget as AgentProfile["runBudget"];
    else
      errors.push({
        file: filePath,
        field: `${field}.runBudget`,
        message: "must be an object",
      });
  }
  if (raw.metadata !== undefined) {
    if (isRecord(raw.metadata)) {
      validateAgentProfileMetadata(
        raw.metadata,
        `${field}.metadata`,
        filePath,
        errors,
      );
      profile.metadata = raw.metadata;
    } else
      errors.push({
        file: filePath,
        field: `${field}.metadata`,
        message: "must be an object",
      });
  }
  return profile;
}

function validateAgentProfileDelegateTool(
  raw: Record<string, unknown>,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): AgentProfile["delegateTool"] {
  validateKnownKeys(
    raw,
    field,
    filePath,
    errors,
    new Set<string>(AGENT_PROFILE_DELEGATE_TOOL_CONFIG_KEYS),
  );
  const out: NonNullable<AgentProfile["delegateTool"]> = {};
  for (const key of DELEGATE_TOOL_OPTIONAL_STRING_CONFIG_KEYS) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] === "string" && raw[key].length > 0) {
        out[key] = raw[key];
      } else {
        errors.push({
          file: filePath,
          field: `${field}.${key}`,
          message: "must be a non-empty string",
        });
      }
    }
  }
  for (const key of DELEGATE_TOOL_BOOLEAN_CONFIG_KEYS) {
    if (raw[key] !== undefined) {
      const parsed = validateOptionalBoolean(
        raw[key],
        `${field}.${key}`,
        filePath,
        errors,
      );
      if (parsed !== undefined) out[key] = parsed;
    }
  }
  if (raw.maxSteps !== undefined) {
    out.maxSteps = validateOptionalPositiveInteger(
      raw.maxSteps,
      `${field}.maxSteps`,
      filePath,
      errors,
    );
  }
  return out;
}

function validateAgentProfileMetadata(
  metadata: Record<string, unknown>,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  if (metadata.acp !== undefined) {
    if (!isRecord(metadata.acp)) {
      errors.push({
        file: filePath,
        field: `${field}.acp`,
        message: "must be an object",
      });
    } else {
      validateAcpMetadata(metadata.acp, `${field}.acp`, filePath, errors);
    }
  }
  if (metadata.externalCommand !== undefined) {
    if (!isRecord(metadata.externalCommand)) {
      errors.push({
        file: filePath,
        field: `${field}.externalCommand`,
        message: "must be an object",
      });
    } else {
      validateExternalCommandMetadata(
        metadata.externalCommand,
        `${field}.externalCommand`,
        filePath,
        errors,
      );
    }
  }
}

function validateAcpMetadata(
  acp: Record<string, unknown>,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  validateKnownKeys(
    acp,
    field,
    filePath,
    errors,
    new Set<string>(AGENT_PROFILE_ACP_METADATA_CONFIG_KEYS),
  );
  if (acp.transport !== "stdio") {
    errors.push({
      file: filePath,
      field: `${field}.transport`,
      message: 'must be "stdio"',
    });
  }
  validateRequiredString(acp.command, `${field}.command`, filePath, errors);
  validateOptionalStringArray(acp.args, `${field}.args`, filePath, errors);
  validateOptionalString(acp.cwd, `${field}.cwd`, filePath, errors);
  validateOptionalStringRecord(acp.env, `${field}.env`, filePath, errors);
  if (
    acp.envMode !== undefined &&
    !isStringOption(acp.envMode, DELEGATE_ENV_MODES)
  ) {
    errors.push({
      file: filePath,
      field: `${field}.envMode`,
      message: "must be inherit or explicit",
    });
  }
  validateOptionalWorkspaceAccess(
    acp.workspaceAccess,
    `${field}.workspaceAccess`,
    filePath,
    errors,
  );
  validateOptionalNumber(acp.timeoutMs, `${field}.timeoutMs`, filePath, errors);
}

function validateExternalCommandMetadata(
  command: Record<string, unknown>,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  validateKnownKeys(
    command,
    field,
    filePath,
    errors,
    new Set<string>(AGENT_PROFILE_EXTERNAL_COMMAND_METADATA_CONFIG_KEYS),
  );
  validateRequiredString(command.command, `${field}.command`, filePath, errors);
  validateOptionalStringArray(command.args, `${field}.args`, filePath, errors);
  validateOptionalString(command.cwd, `${field}.cwd`, filePath, errors);
  validateOptionalStringRecord(command.env, `${field}.env`, filePath, errors);
  validateOptionalWorkspaceAccess(
    command.workspaceAccess,
    `${field}.workspaceAccess`,
    filePath,
    errors,
  );
  validateOptionalNumber(
    command.timeoutMs,
    `${field}.timeoutMs`,
    filePath,
    errors,
  );
  validateOptionalNumber(
    command.maxOutputBytes,
    `${field}.maxOutputBytes`,
    filePath,
    errors,
  );
  validateOptionalNumber(
    command.maxStdoutBytes,
    `${field}.maxStdoutBytes`,
    filePath,
    errors,
  );
  validateOptionalNumber(
    command.maxStderrBytes,
    `${field}.maxStderrBytes`,
    filePath,
    errors,
  );
  if (
    command.envMode !== undefined &&
    !isStringOption(command.envMode, DELEGATE_ENV_MODES)
  ) {
    errors.push({
      file: filePath,
      field: `${field}.envMode`,
      message: "must be inherit or explicit",
    });
  }
  if (
    command.input !== undefined &&
    !isStringOption(command.input, EXTERNAL_COMMAND_INPUT_MODES)
  ) {
    errors.push({
      file: filePath,
      field: `${field}.input`,
      message: "must be argument, stdin, or none",
    });
  }
  validateOptionalIntegerArray(
    command.successExitCodes,
    `${field}.successExitCodes`,
    filePath,
    errors,
  );
}

function validateOptionalWorkspaceAccess(
  value: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  if (
    value !== undefined &&
    !isStringOption(value, DELEGATE_WORKSPACE_ACCESS_MODES)
  ) {
    errors.push({
      file: filePath,
      field,
      message: "must be none or read_write",
    });
  }
}

function validateKnownKeys(
  record: Record<string, unknown>,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
  allowed: Set<string>,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
}

function validateRequiredString(
  value: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  if (!nonEmptyString.safeParse(value).success) {
    errors.push({
      file: filePath,
      field,
      message: "must be a non-empty string",
    });
  }
}

function validateOptionalString(
  value: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  if (value !== undefined && !stringSchema.safeParse(value).success) {
    errors.push({ file: filePath, field, message: "must be a string" });
  }
}

function validateOptionalNumber(
  value: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  if (value !== undefined && !numberSchema.safeParse(value).success) {
    errors.push({ file: filePath, field, message: "must be a number" });
  }
}

function validateOptionalStringArray(
  value: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  if (value !== undefined && !stringArray.safeParse(value).success) {
    errors.push({
      file: filePath,
      field,
      message: "must be an array of strings",
    });
  }
}

function validateOptionalIntegerArray(
  value: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  if (value !== undefined && !integerArray.safeParse(value).success) {
    errors.push({
      file: filePath,
      field,
      message: "must be an array of integers",
    });
  }
}

function validateOptionalStringRecord(
  value: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  if (value === undefined) return;
  if (!stringRecordSchema.safeParse(value).success) {
    errors.push({
      file: filePath,
      field,
      message: "must be an object with string values",
    });
  }
}

function validateCapabilityAgents(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityAgentsConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "capabilities.agents",
      message: "must be an object",
    });
    return undefined;
  }
  const out: CapabilityAgentsConfig = {};
  const allowed = new Set<string>(AGENTS_CONFIG_KEYS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `capabilities.agents.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.profiles !== undefined) {
    if (Array.isArray(raw.profiles)) {
      out.profiles = raw.profiles
        .map((profile, i) => validateAgentProfile(profile, i, filePath, errors))
        .filter((profile): profile is AgentProfile => !!profile);
    } else {
      errors.push({
        file: filePath,
        field: "capabilities.agents.profiles",
        message: "must be an array",
      });
    }
  }
  if (raw.delegateTools !== undefined) {
    if (Array.isArray(raw.delegateTools)) {
      out.delegateTools = raw.delegateTools
        .map((tool, i) => validateDelegateTool(tool, i, filePath, errors))
        .filter((tool): tool is CapabilityDelegateToolConfig => !!tool);
    } else {
      errors.push({
        file: filePath,
        field: "capabilities.agents.delegateTools",
        message: "must be an array",
      });
    }
  }
  if (raw.spawnModel !== undefined) {
    const model = validateZodValue(
      modelSchema,
      raw.spawnModel,
      "capabilities.agents.spawnModel",
      filePath,
      errors,
      "must be a non-empty model reference",
    );
    if (model !== undefined) out.spawnModel = model;
  }
  if (raw.delegateModel !== undefined) {
    const model = validateZodValue(
      modelSchema,
      raw.delegateModel,
      "capabilities.agents.delegateModel",
      filePath,
      errors,
      "must be a non-empty model reference",
    );
    if (model !== undefined) out.delegateModel = model;
  }
  if (raw.exposure !== undefined) {
    if (isStringOption(raw.exposure, AGENT_EXPOSURE_MODES)) {
      out.exposure = raw.exposure;
    } else {
      errors.push({
        file: filePath,
        field: "capabilities.agents.exposure",
        message: `must be one of ${AGENT_EXPOSURE_MODES.join(" | ")}`,
      });
    }
  }
  if (raw.pinnedDelegates !== undefined) {
    validateOptionalStringArray(
      raw.pinnedDelegates,
      "capabilities.agents.pinnedDelegates",
      filePath,
      errors,
    );
    const parsed = stringArray.safeParse(raw.pinnedDelegates);
    if (parsed.success) {
      out.pinnedDelegates = [...parsed.data];
    }
  }
  if (raw.exposeChildrenAsDelegates !== undefined) {
    const parsed = validateOptionalBoolean(
      raw.exposeChildrenAsDelegates,
      "capabilities.agents.exposeChildrenAsDelegates",
      filePath,
      errors,
    );
    if (parsed !== undefined) out.exposeChildrenAsDelegates = parsed;
  }
  if (raw.enableParallelDelegates !== undefined) {
    const parsed = validateOptionalBoolean(
      raw.enableParallelDelegates,
      "capabilities.agents.enableParallelDelegates",
      filePath,
      errors,
    );
    if (parsed !== undefined) out.enableParallelDelegates = parsed;
  }
  if (raw.maxDepth !== undefined) {
    out.maxDepth = validateOptionalNonNegativeInteger(
      raw.maxDepth,
      "capabilities.agents.maxDepth",
      filePath,
      errors,
    );
  }
  return out;
}

function validateDelegateTool(
  raw: unknown,
  index: number,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityDelegateToolConfig | undefined {
  const field = `capabilities.agents.delegateTools.${index}`;
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  validateKnownKeys(
    raw,
    field,
    filePath,
    errors,
    new Set<string>(DELEGATE_TOOL_CONFIG_KEYS),
  );
  if (typeof raw.profileId !== "string" || raw.profileId.length === 0) {
    errors.push({
      file: filePath,
      field: `${field}.profileId`,
      message: "must be a non-empty string",
    });
    return undefined;
  }
  const out: CapabilityDelegateToolConfig = { profileId: raw.profileId };
  for (const key of DELEGATE_TOOL_OPTIONAL_STRING_CONFIG_KEYS) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] === "string" && raw[key].length > 0) {
        out[key] = raw[key];
      } else {
        errors.push({
          file: filePath,
          field: `${field}.${key}`,
          message: "must be a non-empty string",
        });
      }
    }
  }
  for (const key of DELEGATE_TOOL_BOOLEAN_CONFIG_KEYS) {
    if (raw[key] !== undefined) {
      out[key] = validateOptionalBoolean(
        raw[key],
        `${field}.${key}`,
        filePath,
        errors,
      );
    }
  }
  if (raw.maxSteps !== undefined) {
    out.maxSteps = validateOptionalPositiveInteger(
      raw.maxSteps,
      `${field}.maxSteps`,
      filePath,
      errors,
    );
  }
  return out;
}

/** Validate one provider entry. Bad sub-fields are dropped with an error. */
function validateProvider(
  raw: unknown,
  key: string,
  filePath: string,
  errors: SharedConfigError[],
): ProviderConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: `providers.${key}`,
      message: "must be an object",
    });
    return undefined;
  }
  const provider: ProviderConfig = {};
  validateKnownKeys(
    raw,
    `providers.${key}`,
    filePath,
    errors,
    new Set<string>(PROVIDER_CONFIG_KEYS),
  );
  if (raw.npm !== undefined) {
    if (typeof raw.npm === "string" && raw.npm.length > 0)
      provider.npm = raw.npm;
    else
      errors.push({
        file: filePath,
        field: `providers.${key}.npm`,
        message: "must be a non-empty string",
      });
  }
  if (raw.baseURL !== undefined) {
    if (typeof raw.baseURL === "string" && /^https?:\/\//i.test(raw.baseURL))
      provider.baseURL = raw.baseURL;
    else
      errors.push({
        file: filePath,
        field: `providers.${key}.baseURL`,
        message: "must be an http(s) URL",
      });
  }
  if (raw.apiKey !== undefined) {
    if (typeof raw.apiKey === "string" && raw.apiKey.length > 0)
      provider.apiKey = raw.apiKey;
    else
      errors.push({
        file: filePath,
        field: `providers.${key}.apiKey`,
        message: "must be a non-empty string",
      });
  }
  if (raw.providerOptions !== undefined) {
    const providerOptions = validateProviderOptions(
      raw.providerOptions,
      `providers.${key}.providerOptions`,
      filePath,
      errors,
    );
    if (providerOptions) provider.providerOptions = providerOptions;
  }
  if (raw.models !== undefined) {
    if (isRecord(raw.models)) {
      const models: Record<string, ProviderModelConfig> = {};
      for (const [modelId, entry] of Object.entries(raw.models)) {
        const modelField = `providers.${key}.models.${modelId}`;
        if (!isRecord(entry)) {
          errors.push({
            file: filePath,
            field: modelField,
            message: "must be an object",
          });
          continue;
        }
        const modelConfig: ProviderModelConfig = {};
        validateKnownKeys(
          entry,
          modelField,
          filePath,
          errors,
          new Set<string>(PROVIDER_MODEL_CONFIG_KEYS),
        );
        if (entry.cost !== undefined) {
          if (isRecord(entry.cost)) {
            const cost: ModelCost = {};
            const costField = `${modelField}.cost`;
            validateKnownKeys(
              entry.cost,
              costField,
              filePath,
              errors,
              new Set<string>(MODEL_COST_CONFIG_KEYS),
            );
            for (const field of MODEL_COST_CONFIG_KEYS) {
              const v = entry.cost[field];
              if (v === undefined) continue;
              if (typeof v === "number") cost[field] = v;
              else
                errors.push({
                  file: filePath,
                  field: `${costField}.${field}`,
                  message: "must be a number",
                });
            }
            modelConfig.cost = cost;
          } else {
            errors.push({
              file: filePath,
              field: `providers.${key}.models.${modelId}.cost`,
              message: "must be an object",
            });
          }
        }
        if (entry.providerOptions !== undefined) {
          const providerOptions = validateProviderOptions(
            entry.providerOptions,
            `providers.${key}.models.${modelId}.providerOptions`,
            filePath,
            errors,
          );
          if (providerOptions) modelConfig.providerOptions = providerOptions;
        }
        models[modelId] = modelConfig;
      }
      provider.models = models;
    } else {
      errors.push({
        file: filePath,
        field: `providers.${key}.models`,
        message: "must be an object",
      });
    }
  }
  return provider;
}

function validateProviderOptions(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): Record<string, Record<string, unknown>> | undefined {
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }

  const out: Record<string, Record<string, unknown>> = {};
  for (const [providerKey, providerOptions] of Object.entries(raw)) {
    if (!isRecord(providerOptions)) {
      errors.push({
        file: filePath,
        field: `${field}.${providerKey}`,
        message: "must be an object",
      });
      continue;
    }
    out[providerKey] = providerOptions;
  }
  return out;
}

/**
 * Flatten the grouped config form into the flat shape the field validators
 * expect. Both the grouped key and an old flat alias may appear; the grouped
 * value wins and the conflict is reported. Unknown keys inside a known group are
 * errors (groups are new, so we can be strict without breaking old configs).
 *
 * Exported so the TUI config reader can normalize the same grouped form before
 * reading its UI-facing fields; it shares this single source of truth rather
 * than re-implementing the mapping.
 */
export function normalizeGroupedConfig(
  raw: Record<string, unknown>,
  filePath: string,
  errors: SharedConfigError[],
): Record<string, unknown> {
  const flat: Record<string, unknown> = { ...raw };

  const assign = (flatKey: string, value: unknown, groupedField: string) => {
    if (Object.prototype.hasOwnProperty.call(raw, flatKey)) {
      errors.push({
        file: filePath,
        field: groupedField,
        message: `conflicts with top-level "${flatKey}"; the grouped value is used`,
      });
    }
    flat[flatKey] = value;
  };

  for (const [group, fieldMap] of Object.entries(
    CONFIG_GROUP_FIELD_MAP,
  ) as Array<[keyof typeof CONFIG_GROUP_FIELD_MAP, Record<string, string>]>) {
    const groupValue = raw[group];
    if (groupValue === undefined) continue;
    delete flat[group];
    if (!isRecord(groupValue)) {
      errors.push({
        file: filePath,
        field: group,
        message: "must be an object",
      });
      continue;
    }
    const knownSub = new Set<string>(CONFIG_GROUP_CONFIG_KEYS[group]);
    for (const subKey of Object.keys(groupValue)) {
      if (group === "policy" && subKey === "permissionMode") {
        errors.push({
          file: filePath,
          field: "policy.permissionMode",
          message:
            'removed; use run.accessMode ("read-only", "ask", "accept-edits", or "bypass")',
        });
        continue;
      }
      if (group === "ui" && subKey === "tuiPermissionMode") {
        errors.push({
          file: filePath,
          field: "ui.tuiPermissionMode",
          message:
            "removed; use run.accessMode for configured run autonomy or the TUI runtime mode switch for temporary changes",
        });
        continue;
      }
      if (!knownSub.has(subKey)) {
        errors.push({
          file: filePath,
          field: `${group}.${subKey}`,
          message: `unknown field (allowed: ${[...knownSub].join(", ")})`,
        });
        continue;
      }
      const flatKey = fieldMap[subKey]!;
      if (group === "policy" && subKey === "sandbox") {
        assign("shell", { sandbox: groupValue.sandbox }, "policy.sandbox");
        continue;
      }
      assign(flatKey, groupValue[subKey], `${group}.${subKey}`);
    }
  }
  return flat;
}

/**
 * Validate the shared fields of one parsed config object. Unknown keys are
 * ignored (they may be UI-only fields owned by the TUI). Wrong types produce
 * an error and the field is dropped.
 */
function validateShared(
  raw: unknown,
  origin: string,
  filePath: string,
  layer: ConfigLayerLabel = "env",
): {
  config: SharedConfig;
  sources: SharedConfigSourceMap;
  errors: SharedConfigError[];
} {
  const errors: SharedConfigError[] = [];
  const config: SharedConfig = {};
  const sources: SharedConfigSourceMap = {};

  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "(root)",
      message: "must be an object",
    });
    return { config, sources, errors };
  }
  const obj = normalizeGroupedConfig(raw, filePath, errors);

  if (Object.prototype.hasOwnProperty.call(obj, "permissionMode")) {
    errors.push({
      file: filePath,
      field: "permissionMode",
      message:
        'removed; use run.accessMode ("read-only", "ask", "accept-edits", or "bypass")',
    });
  }
  if (Object.prototype.hasOwnProperty.call(obj, "tuiPermissionMode")) {
    errors.push({
      file: filePath,
      field: "tuiPermissionMode",
      message:
        "removed; use run.accessMode for configured run autonomy or the TUI runtime mode switch for temporary changes",
    });
  }

  if (obj.model !== undefined) {
    const model = validateZodValue(
      modelSchema,
      obj.model,
      "model",
      filePath,
      errors,
      "must be a non-empty string",
    );
    if (model !== undefined) {
      config.model = model;
      sources.model = origin;
    }
  }
  if (obj.providers !== undefined) {
    if (isRecord(obj.providers)) {
      const providers: Record<string, ProviderConfig> = {};
      for (const [key, value] of Object.entries(obj.providers)) {
        if (key === DETERMINISTIC_PROVIDER) {
          errors.push({
            file: filePath,
            field: `providers.${key}`,
            message: `"${DETERMINISTIC_PROVIDER}" is a reserved built-in provider and cannot be declared`,
          });
          continue;
        }
        const provider = validateProvider(value, key, filePath, errors);
        if (provider) {
          providers[key] = provider;
          sources.providers = { ...(sources.providers ?? {}), [key]: origin };
        }
      }
      config.providers = providers;
    } else {
      errors.push({
        file: filePath,
        field: "providers",
        message: "must be an object",
      });
    }
  }
  if (obj.accessMode !== undefined) {
    if (isStringOption(obj.accessMode, ACCESS_MODE_CONFIG_VALUES)) {
      config.accessMode = obj.accessMode;
      // permissionMode is an internal compile target, never user-parsed.
      config.permissionMode = compileRunAccessMode(
        obj.accessMode,
      ).permissionMode;
      sources.accessMode = origin;
      sources.permissionMode = origin;
    } else {
      errors.push({
        file: filePath,
        field: "accessMode",
        message: `must be one of ${ACCESS_MODE_CONFIG_VALUES.join(" | ")}`,
      });
    }
  }
  if (obj.backgroundTasks !== undefined) {
    if (
      isStringOption(obj.backgroundTasks, BACKGROUND_TASK_POLICY_CONFIG_VALUES)
    ) {
      config.backgroundTasks = obj.backgroundTasks;
      sources.backgroundTasks = origin;
    } else {
      errors.push({
        file: filePath,
        field: "backgroundTasks",
        message: `must be one of ${BACKGROUND_TASK_POLICY_CONFIG_VALUES.join(" | ")}`,
      });
    }
  }
  if (obj.workspace !== undefined) {
    const workspace = validateZodValue(
      workspaceSchema,
      obj.workspace,
      "workspace",
      filePath,
      errors,
      "must be a non-empty string",
    );
    if (workspace !== undefined) {
      config.workspace = workspace;
      sources.workspace = origin;
    }
  }
  if (obj.confidentialPaths !== undefined) {
    const confidentialPaths = validateZodValue(
      confidentialPathsSchema,
      obj.confidentialPaths,
      "confidentialPaths",
      filePath,
      errors,
      "must be an array of non-empty strings",
    );
    if (confidentialPaths !== undefined) {
      config.confidentialPaths = confidentialPaths;
      sources.confidentialPaths = origin;
    }
  }
  if (obj.confidentialDefaults !== undefined) {
    const confidentialDefaults = validateZodValue(
      confidentialDefaultsSchema,
      obj.confidentialDefaults,
      "confidentialDefaults",
      filePath,
      errors,
      "must be a boolean",
    );
    if (confidentialDefaults !== undefined) {
      config.confidentialDefaults = confidentialDefaults;
      sources.confidentialDefaults = origin;
    }
  }
  if (obj.write !== undefined) {
    const write = validateWriteGuardrails(obj.write, filePath, errors);
    if (write) {
      config.write = write;
      sources.write = origin;
    }
  }
  if (obj.runBudget !== undefined) {
    const runBudget = validateRunBudget(
      obj.runBudget,
      "runBudget",
      filePath,
      errors,
    );
    if (runBudget) {
      config.runBudget = runBudget;
      sources.runBudget = origin;
    }
  }
  if (obj.maxSteps !== undefined) {
    const maxSteps = validateZodValue(
      maxStepsSchema,
      obj.maxSteps,
      "maxSteps",
      filePath,
      errors,
      "must be a positive integer",
    );
    if (maxSteps !== undefined) {
      config.maxSteps = maxSteps;
      sources.maxSteps = origin;
    }
  }
  if (obj.traceLevel !== undefined) {
    if (isStringOption(obj.traceLevel, TRACE_LEVEL_CONFIG_VALUES)) {
      config.traceLevel = obj.traceLevel;
      sources.traceLevel = origin;
    } else {
      errors.push({
        file: filePath,
        field: "traceLevel",
        message: "must be one of standard | debug",
      });
    }
  }
  if (obj.approvals !== undefined) {
    const approvals = validateApprovals(obj.approvals, filePath, errors);
    if (approvals) {
      config.approvals = approvals;
      sources.approvals = origin;
    }
  }
  if (obj.shell !== undefined) {
    const shell = validateShellConfig(obj.shell, filePath, errors);
    if (shell) {
      config.shell = shell;
      sources.shell = origin;
    }
  }
  if (obj.tools !== undefined) {
    const tools = validateToolsConfig(obj.tools, "tools", filePath, errors);
    if (tools) {
      config.tools = tools;
      sources.tools = origin;
    }
  }
  if (obj.tasks !== undefined) {
    const tasks = validateTasksConfig(obj.tasks, filePath, errors);
    if (tasks) {
      config.tasks = tasks;
      sources.tasks = origin;
    }
  }
  if (obj.capabilities !== undefined) {
    const capabilities = validateCapabilities(
      obj.capabilities,
      filePath,
      errors,
    );
    if (capabilities) {
      if (layer === "project") {
        stripProjectHttpHooks(capabilities, filePath, errors);
      }
      config.capabilities = capabilities;
    }
  }
  return { config, sources, errors };
}

/** Load + merge the shared config fields across the resolution order. */
export async function loadHostConfig(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<LoadedSharedConfig> {
  const order = configLayerResolutionOrder(cwd, env);
  const merged: SharedConfig = {};
  const sources: SharedConfigSourceMap = {};
  const attempted: LoadedSharedConfig["attempted"] = [];
  const errors: SharedConfigError[] = [];
  const warnings: SharedConfigWarning[] = [];

  for (const { candidates, label } of order) {
    const existing = await existingConfigCandidatePaths(candidates);
    if (existing.length === 0) {
      for (const path of candidates) attempted.push({ path, loaded: false });
      continue;
    }

    const path = existing[0]!;
    if (existing.length > 1) {
      errors.push({
        file: path,
        field: "(root)",
        message: `multiple config files found for ${label} layer: ${existing.join(", ")}; loading ${path}`,
      });
    }

    const r = await readConfigFile(path);
    if (r.kind === "missing") {
      for (const candidate of candidates) {
        attempted.push({ path: candidate, loaded: false });
      }
      continue;
    }
    if (r.kind === "error") {
      for (const candidate of candidates) {
        attempted.push({ path: candidate, loaded: false });
      }
      errors.push({ file: path, field: "(root)", message: r.message });
      continue;
    }
    for (const candidate of candidates) {
      attempted.push({ path: candidate, loaded: candidate === path });
    }
    const v = validateShared(r.value, `${label}:${path}`, path, label);
    errors.push(...v.errors);
    if (v.config.workspace !== undefined) {
      v.config.workspace = isAbsolute(v.config.workspace)
        ? v.config.workspace
        : resolve(dirname(path), v.config.workspace);
    }
    const capabilities = v.config.capabilities;
    const roots = capabilities?.skills?.roots;
    if (roots) {
      v.config.capabilities = {
        ...capabilities,
        skills: {
          ...capabilities.skills,
          roots: roots.map((root) =>
            isAbsolute(root) ? root : resolve(dirname(path), root),
          ),
        },
      };
    }
    const servers = v.config.capabilities?.mcp?.servers;
    if (servers) {
      v.config.capabilities = {
        ...v.config.capabilities,
        mcp: {
          ...v.config.capabilities?.mcp,
          servers: servers.map((server) =>
            server.type === "stdio" && server.cwd
              ? {
                  ...server,
                  cwd: isAbsolute(server.cwd)
                    ? server.cwd
                    : resolve(dirname(path), server.cwd),
                }
              : server,
          ),
        },
      };
    }
    // Providers merge by key (a later file adds/overrides individual entries),
    // top-level tools merge by explicit set semantics, capabilities merge by
    // sub-capability (skills/mcp/agents), and shell.sandbox merges
    // conservatively so a project cannot downgrade a user-defined sandbox
    // boundary. Within a sub-capability the later layer still
    // wholesale-overrides. Every other field is wholesale-overridden.
    const {
      providers,
      capabilities: layerCapabilities,
      shell: layerShell,
      tools: layerTools,
      accessMode: layerAccessMode,
      backgroundTasks: layerBackgroundTasks,
      // permissionMode is derived from accessMode; never merged from a layer.
      permissionMode: _layerPermissionMode,
      confidentialDefaults: layerConfidentialDefaults,
      confidentialPaths: layerConfidentialPaths,
      write: layerWrite,
      ...rest
    } = v.config;
    void _layerPermissionMode;
    Object.assign(merged, rest);
    if (providers) {
      merged.providers = { ...(merged.providers ?? {}), ...providers };
    }
    if (layerShell) {
      merged.shell = mergeShellConfig(merged.shell, layerShell);
    }
    if (layerCapabilities) {
      merged.capabilities = {
        ...(merged.capabilities ?? {}),
        ...layerCapabilities,
      };
    }
    if (layerTools) {
      merged.tools = mergeToolConfig(merged.tools, layerTools);
      sources.tools = v.sources.tools;
    }
    // accessMode is special: the project layer is the authoritative ceiling,
    // while user/env layers are requests. A project accessMode clamps lower
    // layers down but never raises a more restrictive request.
    if (layerAccessMode !== undefined) {
      if (label === "project") {
        merged.accessModeCeiling = layerAccessMode;
        sources.accessModeCeiling = v.sources.accessMode;
      }
      const requested =
        label === "project"
          ? (merged.accessMode ?? layerAccessMode)
          : layerAccessMode;
      const effective =
        clampAccessMode(merged.accessModeCeiling, requested) ?? requested;
      if (effective !== requested && merged.accessModeCeiling !== undefined) {
        warnings.push({
          file: path,
          field: "accessMode",
          message: `requested ${requested} was clamped to project ceiling ${merged.accessModeCeiling}`,
        });
      }
      const previous = merged.accessMode;
      merged.accessMode = effective;
      if (merged.accessMode !== previous || sources.accessMode === undefined) {
        sources.accessMode =
          effective === requested
            ? label === "project" && previous !== undefined
              ? sources.accessMode
              : v.sources.accessMode
            : sources.accessModeCeiling;
      }
      if (merged.accessMode !== undefined) {
        merged.permissionMode = compileRunAccessMode(
          merged.accessMode,
        ).permissionMode;
        sources.permissionMode = sources.accessMode;
      }
    }
    if (layerBackgroundTasks !== undefined) {
      if (label === "project") {
        merged.backgroundTasksCeiling = layerBackgroundTasks;
        sources.backgroundTasksCeiling = v.sources.backgroundTasks;
      }
      const requested =
        label === "project"
          ? (merged.backgroundTasks ?? layerBackgroundTasks)
          : layerBackgroundTasks;
      const effective =
        clampBackgroundTaskPolicy(merged.backgroundTasksCeiling, requested) ??
        requested;
      if (
        effective !== requested &&
        merged.backgroundTasksCeiling !== undefined
      ) {
        warnings.push({
          file: path,
          field: "backgroundTasks",
          message: `requested ${requested} was clamped to project ceiling ${merged.backgroundTasksCeiling}`,
        });
      }
      const previous = merged.backgroundTasks;
      merged.backgroundTasks = effective;
      if (
        merged.backgroundTasks !== previous ||
        sources.backgroundTasks === undefined
      ) {
        sources.backgroundTasks =
          effective === requested
            ? label === "project" && previous !== undefined
              ? sources.backgroundTasks
              : v.sources.backgroundTasks
            : sources.backgroundTasksCeiling;
      }
    }
    if (layerConfidentialPaths !== undefined) {
      merged.confidentialPaths = mergeUniqueStrings(
        merged.confidentialPaths,
        layerConfidentialPaths,
      );
      sources.confidentialPaths = v.sources.confidentialPaths;
    }
    if (layerConfidentialDefaults !== undefined) {
      merged.confidentialDefaults = layerConfidentialDefaults;
      sources.confidentialDefaults = v.sources.confidentialDefaults;
    }
    if (layerWrite !== undefined) {
      merged.write = mergeWriteGuardrails(merged.write, layerWrite);
      sources.write = v.sources.write;
    }
    const { providers: providerSources, ...fieldSources } = v.sources;
    // These security-boundary sources are tracked above to reflect the layer
    // that actually won the conservative merge, not just the last to set them.
    delete fieldSources.accessMode;
    delete fieldSources.accessModeCeiling;
    delete fieldSources.backgroundTasks;
    delete fieldSources.backgroundTasksCeiling;
    delete fieldSources.permissionMode;
    delete fieldSources.confidentialDefaults;
    delete fieldSources.confidentialPaths;
    delete fieldSources.write;
    Object.assign(sources, fieldSources);
    if (providerSources) {
      sources.providers = { ...(sources.providers ?? {}), ...providerSources };
    }
  }

  return { config: merged, sources, attempted, errors, warnings };
}

export interface ParsedModelRef {
  providerKey: string;
  modelId: string;
}

/** Split a "provider/model" reference. No slash → modelId is empty. */
export function parseModelRef(ref: string): ParsedModelRef {
  const i = ref.indexOf("/");
  if (i < 0) return { providerKey: ref, modelId: "" };
  return { providerKey: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

export type ModelSelection =
  | { kind: "deterministic" }
  | {
      kind: "configured";
      providerKey: string;
      modelId: string;
      npm: string;
      baseURL?: string;
      apiKey?: string;
      cost?: ModelCost;
      providerOptions?: Record<string, Record<string, unknown>>;
    }
  | { kind: "error"; message: string };

/**
 * Resolve a "provider/model" reference against the providers map. Returns the
 * provider's npm/baseURL/apiKey/cost so callers can construct the adapter.
 * Does not consult env — callers layer OPENAI_BASE_URL/OPENAI_API_KEY on top.
 */
export function resolveModelSelection(
  config: SharedConfig,
  ref: string | undefined,
): ModelSelection {
  if (!ref) {
    return {
      kind: "error",
      message:
        'No model configured. Set "model" (e.g. "openai/gpt-example") in config or pass --model.',
    };
  }
  const { providerKey, modelId } = parseModelRef(ref);
  if (providerKey === DETERMINISTIC_PROVIDER) return { kind: "deterministic" };
  if (!modelId) {
    return {
      kind: "error",
      message: `Model "${ref}" must be in the form "provider/model" (e.g. "openai/gpt-example").`,
    };
  }
  const provider = config.providers?.[providerKey];
  if (!provider) {
    return {
      kind: "error",
      message: `Unknown provider "${providerKey}" in model "${ref}". Define it under "providers" in your config.`,
    };
  }
  const npm = provider.npm ?? DEFAULT_PROVIDER_NPM;
  if (!SUPPORTED_PROVIDER_NPMS[npm]) {
    const supported = Object.keys(SUPPORTED_PROVIDER_NPMS).join(", ");
    return {
      kind: "error",
      message: `Provider "${providerKey}" uses npm "${npm}", which is not supported (supported: ${supported}).`,
    };
  }
  const configuredModelIds = Object.keys(provider.models ?? {});
  if (configuredModelIds.length > 0 && !configuredModelIds.includes(modelId)) {
    return {
      kind: "error",
      message: `Model "${ref}" is not configured for provider "${providerKey}". Available models: ${configuredModelIds.join(", ")}.`,
    };
  }
  return {
    kind: "configured",
    providerKey,
    modelId,
    npm,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    cost: provider.models?.[modelId]?.cost,
    providerOptions: mergeProviderOptions(
      provider.providerOptions,
      provider.models?.[modelId]?.providerOptions,
    ),
  };
}

function mergeProviderOptions(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
  modelProviderOptions: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!providerOptions) return modelProviderOptions;
  if (!modelProviderOptions) return providerOptions;
  const merged: Record<string, Record<string, unknown>> = {};
  for (const key of new Set([
    ...Object.keys(providerOptions),
    ...Object.keys(modelProviderOptions),
  ])) {
    merged[key] = {
      ...(providerOptions[key] ?? {}),
      ...(modelProviderOptions[key] ?? {}),
    };
  }
  return merged;
}

/** Map a config `cost` block to the core ModelPricing shape. */
export function costToPricing(cost: ModelCost | undefined):
  | {
      inputPerMTokUsd?: number;
      outputPerMTokUsd?: number;
      cacheReadPerMTokUsd?: number;
      cacheCreationPerMTokUsd?: number;
    }
  | undefined {
  if (!cost) return undefined;
  const pricing: {
    inputPerMTokUsd?: number;
    outputPerMTokUsd?: number;
    cacheReadPerMTokUsd?: number;
    cacheCreationPerMTokUsd?: number;
  } = {};
  if (cost.input !== undefined) pricing.inputPerMTokUsd = cost.input;
  if (cost.output !== undefined) pricing.outputPerMTokUsd = cost.output;
  if (cost.cacheRead !== undefined)
    pricing.cacheReadPerMTokUsd = cost.cacheRead;
  if (cost.cacheWrite !== undefined)
    pricing.cacheCreationPerMTokUsd = cost.cacheWrite;
  return pricing;
}
