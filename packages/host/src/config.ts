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
 * files, capabilities merge by sub-capability, and the security boundaries —
 * shell.sandbox, permissionMode, and confidentialPaths — merge conservatively
 * so later (lower-trust) layers cannot weaken an earlier layer's policy.
 * Callers layer CLI flags / env on top.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  PermissionMode,
  RunBudget,
  TraceLevel,
  WorkflowHookMatcher,
  WorkflowHookName,
} from "@sparkwright/core";
import type { AgentProfile } from "@sparkwright/agent-runtime";
import type { ShellSandboxConfig } from "@sparkwright/shell-sandbox";

export const CONFIG_PROJECT_REL = ".sparkwright/config.json";
export const CONFIG_USER_REL = ".config/sparkwright/config.json";
export const CONFIG_ENV_VAR = "SPARKWRIGHT_CONFIG";
const CONFIG_USER_SUBPATH = "sparkwright/config.json";

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

export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ProviderModelConfig {
  cost?: ModelCost;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface ProviderConfig {
  npm?: string;
  baseURL?: string;
  apiKey?: string;
  providerOptions?: Record<string, Record<string, unknown>>;
  models?: Record<string, ProviderModelConfig>;
}

export interface SharedConfig {
  /** Active model in "provider/model" form (or the reserved "deterministic"). */
  model?: string;
  providers?: Record<string, ProviderConfig>;
  permissionMode?: PermissionMode;
  /** Path relative to the config file, or absolute. */
  workspace?: string;
  /**
   * Workspace-relative paths/globs whose contents a run must not read. Opt-in
   * read-confidentiality: matching `read_file`/`grep` reads are denied at
   * the tool layer. Empty/absent leaves the default permissive behavior.
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

export interface WriteGuardrailsConfig {
  /** Maximum distinct files a run may write. */
  maxFiles?: number;
  /** Maximum changed diff lines per write. */
  maxDiffLines?: number;
  /** Whether in-place edits may remove lines. */
  allowDeletions?: boolean;
}

export interface ApprovalDefaults {
  /** Auto-approve commands the safety classifier rates safe. */
  shellSafe?: boolean;
  /** Auto-approve workspace edits. */
  edits?: boolean;
  /** Auto-approve everything the policy allows (use with care). */
  all?: boolean;
}

export interface ShellConfig {
  sandbox?: ShellSandboxConfig;
}

export interface CapabilityConfig {
  tools?: CapabilityToolsConfig;
  hooks?: CapabilityHooksConfig;
  verification?: CapabilityVerificationConfig;
  skills?: CapabilitySkillsConfig;
  mcp?: CapabilityMcpConfig;
  agents?: CapabilityAgentsConfig;
}

export interface CapabilityToolsConfig {
  /**
   * Optional allowlist of tool-name patterns prepared for a run. Omit to allow
   * all host-assembled tools before other filters apply.
   */
  enabled?: string[];
  /** Tool-name patterns removed from the prepared run tool set. */
  disabled?: string[];
  /** Tool-name patterns prepared as deferred schemas when supported. */
  defer?: string[];
}

export type CapabilityHookActionConfig =
  | {
      type: "block";
      reason: string;
    }
  | {
      type: "context";
      content: string;
      contextType?: "system" | "user" | "summary";
    }
  | {
      type: "command";
      command: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
      blockOnFailure?: boolean;
      injectOutput?: "always" | "onFailure" | "never";
      maxOutputBytes?: number;
      stdin?: "none" | "json";
    };

export type CapabilityWorkflowHookFrequency = "always" | "oncePerTurn";

export interface CapabilityWorkflowHookConfig {
  name: string;
  description?: string;
  hook: WorkflowHookName;
  enabled?: boolean;
  frequency?: CapabilityWorkflowHookFrequency;
  matcher?: WorkflowHookMatcher;
  onError?: "continue" | "block";
  action: CapabilityHookActionConfig;
}

export interface CapabilityHooksConfig {
  workflow?: CapabilityWorkflowHookConfig[];
}

export type CapabilityVerificationMode = "off" | "suggest" | "require";

export type CapabilityVerificationKind =
  | "lint"
  | "typecheck"
  | "test"
  | "check"
  | "custom";

export interface CapabilityVerificationCommandConfig {
  id: string;
  kind?: CapabilityVerificationKind;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CapabilityVerificationAfterWritesConfig {
  profile?: string;
  frequency?: CapabilityWorkflowHookFrequency;
  injectOutput?: "always" | "onFailure" | "never";
}

export interface CapabilityVerificationStopGateConfig {
  enabled?: boolean;
  requireCleanAfterLastWrite?: boolean;
}

export interface CapabilityVerificationConfig {
  mode?: CapabilityVerificationMode;
  defaultProfile?: string;
  profiles?: Record<string, CapabilityVerificationCommandConfig[]>;
  afterWrites?: CapabilityVerificationAfterWritesConfig;
  stopGate?: CapabilityVerificationStopGateConfig;
}

export interface CapabilityAgentsConfig {
  profiles?: AgentProfile[];
  delegateTools?: CapabilityDelegateToolConfig[];
}

export interface CapabilityDelegateToolConfig {
  profileId: string;
  toolName?: string;
  description?: string;
  requiresApproval?: boolean;
  forbidNesting?: boolean;
  maxSteps?: number;
}

export interface CapabilitySkillsConfig {
  /** Skill root directories. Relative paths resolve from the config file. */
  roots?: string[];
  includeLoaderTool?: boolean;
  loadSelectedSkills?: boolean;
  maxSelectedSkills?: number;
  resourceFileLimit?: number;
  allowedSkills?: string[];
  deniedSkills?: string[];
  evolution?: CapabilitySkillEvolutionConfig;
}

export type CapabilitySkillEvolutionMode = "off" | "notice" | "draft" | "apply";

export interface CapabilitySkillEvolutionConfig {
  mode?: CapabilitySkillEvolutionMode;
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
    }
  | {
      type: "http";
      name: string;
      url: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      enabled?: boolean;
    };

export interface CapabilityMcpConfig {
  servers?: CapabilityMcpServerConfig[];
  defaultTimeoutMs?: number;
  namePrefix?: string;
  defaultPolicy?: {
    risk?: "safe" | "risky" | "denied";
    requiresApproval?: boolean;
  };
}

export interface SharedConfigSourceMap {
  model?: string;
  permissionMode?: string;
  workspace?: string;
  confidentialPaths?: string;
  write?: string;
  shell?: string;
  runBudget?: string;
  maxSteps?: string;
  traceLevel?: string;
  approvals?: string;
  providers?: Record<string, string>;
}

export interface SharedConfigError {
  file: string;
  field: string;
  message: string;
}

export interface LoadedSharedConfig {
  config: SharedConfig;
  sources: SharedConfigSourceMap;
  attempted: { path: string; loaded: boolean }[];
  errors: SharedConfigError[];
}

const VALID_PERMISSION_MODES: PermissionMode[] = [
  "plan",
  "default",
  "accept_edits",
  "dont_ask",
  "bypass_permissions",
];

/**
 * Permissiveness ranking for `permissionMode` (lower = more restrictive). Used
 * to merge layers conservatively: a later (lower-trust) layer may tighten the
 * mode but never relax it — mirroring how shell.sandbox merges. This blocks a
 * project config from escalating a user's mode to the auto-allow modes
 * `accept_edits`/`bypass_permissions`. The relative order of the human-gated
 * modes (plan/dont_ask/default) carries no security weight; only the auto-allow
 * modes ranking above them matters.
 */
const PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  dont_ask: 1,
  default: 2,
  accept_edits: 3,
  bypass_permissions: 4,
};

function stricterPermissionMode(
  previous: PermissionMode | undefined,
  next: PermissionMode | undefined,
): PermissionMode | undefined {
  if (previous === undefined) return next;
  if (next === undefined) return previous;
  // On equal rank the later layer wins; otherwise keep the more restrictive.
  return PERMISSION_MODE_RANK[next] <= PERMISSION_MODE_RANK[previous]
    ? next
    : previous;
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
  return join(base, CONFIG_USER_SUBPATH);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_PROJECT_REL);
}

export function configResolutionOrder(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): { path: string; label: string }[] {
  const order = [
    { path: userConfigPath(env), label: "user" },
    { path: projectConfigPath(cwd), label: "project" },
  ];
  const explicit = env[CONFIG_ENV_VAR];
  if (explicit) {
    order.push({
      path: isAbsolute(explicit) ? explicit : resolve(cwd, explicit),
      label: "env",
    });
  }
  return order;
}

async function readJson(
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
  try {
    return { kind: "ok", value: JSON.parse(raw) };
  } catch (err) {
    return {
      kind: "error",
      message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStringArray(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): string[] | undefined {
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) {
    return raw;
  }
  errors.push({
    file: filePath,
    field,
    message: "must be an array of strings",
  });
  return undefined;
}

function validateOptionalBoolean(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  errors.push({ file: filePath, field, message: "must be a boolean" });
  return undefined;
}

function validateOptionalNonNegativeInteger(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): number | undefined {
  if (Number.isInteger(raw) && (raw as number) >= 0) return raw as number;
  errors.push({
    file: filePath,
    field,
    message: "must be a non-negative integer",
  });
  return undefined;
}

function validateOptionalPositiveInteger(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): number | undefined {
  if (Number.isInteger(raw) && (raw as number) >= 1) return raw as number;
  errors.push({
    file: filePath,
    field,
    message: "must be a positive integer",
  });
  return undefined;
}

function validateOptionalPositiveNumber(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  errors.push({
    file: filePath,
    field,
    message: "must be a positive number",
  });
  return undefined;
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
  const allowed = new Set([
    "roots",
    "includeLoaderTool",
    "loadSelectedSkills",
    "maxSelectedSkills",
    "resourceFileLimit",
    "allowedSkills",
    "deniedSkills",
    "evolution",
  ]);
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
  return out;
}

const VALID_SKILL_EVOLUTION_MODES: CapabilitySkillEvolutionMode[] = [
  "off",
  "notice",
  "draft",
  "apply",
];

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
  const allowed = new Set(["mode"]);
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
    if (
      typeof raw.mode === "string" &&
      (VALID_SKILL_EVOLUTION_MODES as string[]).includes(raw.mode)
    ) {
      out.mode = raw.mode as CapabilitySkillEvolutionMode;
    } else {
      errors.push({
        file: filePath,
        field: "capabilities.skills.evolution.mode",
        message: `must be one of ${VALID_SKILL_EVOLUTION_MODES.join(" | ")}`,
      });
    }
  }
  return out;
}

function validateCapabilityTools(
  raw: unknown,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityToolsConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({
      file: filePath,
      field: "capabilities.tools",
      message: "must be an object",
    });
    return undefined;
  }
  const out: CapabilityToolsConfig = {};
  const allowed = new Set(["enabled", "disabled", "defer"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `capabilities.tools.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.enabled !== undefined) {
    out.enabled = validateStringArray(
      raw.enabled,
      "capabilities.tools.enabled",
      filePath,
      errors,
    );
  }
  if (raw.disabled !== undefined) {
    out.disabled = validateStringArray(
      raw.disabled,
      "capabilities.tools.disabled",
      filePath,
      errors,
    );
  }
  if (raw.defer !== undefined) {
    out.defer = validateStringArray(
      raw.defer,
      "capabilities.tools.defer",
      filePath,
      errors,
    );
  }
  return out;
}

const WORKFLOW_HOOK_NAMES: WorkflowHookName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "ModelOutput",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "RuntimeSignal",
];

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
  const allowed = new Set(["workflow"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `capabilities.hooks.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
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
  return out;
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
  const allowed = new Set([
    "name",
    "description",
    "hook",
    "enabled",
    "frequency",
    "matcher",
    "onError",
    "action",
  ]);
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
  if (
    typeof raw.hook !== "string" ||
    !(WORKFLOW_HOOK_NAMES as string[]).includes(raw.hook)
  ) {
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
    if (raw.onError === "continue" || raw.onError === "block") {
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
    if (raw.frequency === "always" || raw.frequency === "oncePerTurn") {
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

function validateWorkflowHookAction(
  raw: unknown,
  parentField: string,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityHookActionConfig | undefined {
  const field = `${parentField}.action`;
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const type = raw.type;
  if (type !== "block" && type !== "context" && type !== "command") {
    errors.push({
      file: filePath,
      field: `${field}.type`,
      message: "must be block, context, or command",
    });
    return undefined;
  }
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
    if (
      contextType !== undefined &&
      contextType !== "system" &&
      contextType !== "user" &&
      contextType !== "summary"
    ) {
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
      ...(contextType ? { contextType } : {}),
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
      ? raw.injectOutput === "always" ||
        raw.injectOutput === "onFailure" ||
        raw.injectOutput === "never"
        ? { injectOutput: raw.injectOutput }
        : (errors.push({
            file: filePath,
            field: `${field}.injectOutput`,
            message: "must be always, onFailure, or never",
          }),
          {})
      : {}),
    ...(raw.stdin !== undefined
      ? raw.stdin === "none" || raw.stdin === "json"
        ? { stdin: raw.stdin }
        : (errors.push({
            file: filePath,
            field: `${field}.stdin`,
            message: "must be none or json",
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
  const allowed = new Set([
    "toolName",
    "eventType",
    "signal",
    "status",
    "pathGlob",
    "excludePathGlob",
  ]);
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
  const allowed = new Set([
    "mode",
    "defaultProfile",
    "profiles",
    "afterWrites",
    "stopGate",
  ]);
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
    if (
      raw.mode === "off" ||
      raw.mode === "suggest" ||
      raw.mode === "require"
    ) {
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
  if (raw.stopGate !== undefined) {
    const stopGate = validateVerificationStopGate(
      raw.stopGate,
      `${field}.stopGate`,
      filePath,
      errors,
    );
    if (stopGate) out.stopGate = stopGate;
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
  const allowed = new Set([
    "id",
    "kind",
    "command",
    "args",
    "cwd",
    "timeoutMs",
    "maxOutputBytes",
  ]);
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
  const allowed = new Set(["profile", "frequency", "injectOutput"]);
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
  if (raw.frequency !== undefined) {
    if (raw.frequency === "always" || raw.frequency === "oncePerTurn") {
      out.frequency = raw.frequency;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.frequency`,
        message: "must be always or oncePerTurn",
      });
    }
  }
  if (raw.injectOutput !== undefined) {
    if (
      raw.injectOutput === "always" ||
      raw.injectOutput === "onFailure" ||
      raw.injectOutput === "never"
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

function validateVerificationStopGate(
  raw: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): CapabilityVerificationStopGateConfig | undefined {
  if (!isRecord(raw)) {
    errors.push({ file: filePath, field, message: "must be an object" });
    return undefined;
  }
  const allowed = new Set(["enabled", "requireCleanAfterLastWrite"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  const out: CapabilityVerificationStopGateConfig = {};
  if (raw.enabled !== undefined) {
    out.enabled = validateOptionalBoolean(
      raw.enabled,
      `${field}.enabled`,
      filePath,
      errors,
    );
  }
  if (raw.requireCleanAfterLastWrite !== undefined) {
    out.requireCleanAfterLastWrite = validateOptionalBoolean(
      raw.requireCleanAfterLastWrite,
      `${field}.requireCleanAfterLastWrite`,
      filePath,
      errors,
    );
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
  return (
    value === "lint" ||
    value === "typecheck" ||
    value === "test" ||
    value === "check" ||
    value === "custom"
  );
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
  const allowed = new Set([
    "tools",
    "hooks",
    "verification",
    "skills",
    "mcp",
    "agents",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `capabilities.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  if (raw.tools !== undefined) {
    const tools = validateCapabilityTools(raw.tools, filePath, errors);
    if (tools) out.tools = tools;
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
  const allowed = new Set(["maxFiles", "maxDiffLines", "allowDeletions"]);
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
  const integerKeys = [
    "maxDurationMs",
    "maxModelCalls",
    "maxToolCalls",
    "maxTokens",
  ] as const;
  const allowed = new Set<string>([...integerKeys, "maxCostUsd"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  for (const key of integerKeys) {
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
  const allowed = new Set(["shellSafe", "edits", "all"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `approvals.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  for (const key of ["shellSafe", "edits", "all"] as const) {
    if (raw[key] !== undefined) {
      out[key] = validateOptionalBoolean(
        raw[key],
        `approvals.${key}`,
        filePath,
        errors,
      );
    }
  }
  return out;
}

const VALID_TRACE_LEVELS: TraceLevel[] = ["minimal", "standard", "debug"];

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
  const allowed = new Set(["sandbox"]);
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
  const allowed = new Set([
    "mode",
    "failIfUnavailable",
    "filesystem",
    "network",
  ]);
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
    if (raw.mode === "off" || raw.mode === "warn" || raw.mode === "enforce") {
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
  const allowed = new Set([
    "allowRead",
    "allowWrite",
    "denyRead",
    "denyWrite",
    "tmp",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `shell.sandbox.filesystem.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  for (const key of [
    "allowRead",
    "allowWrite",
    "denyRead",
    "denyWrite",
  ] as const) {
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
  const allowed = new Set(["mode"]);
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
    if (raw.mode === "allow" || raw.mode === "deny") {
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
  if (
    isRecord(raw) &&
    Object.values(raw).every((entry) => typeof entry === "string")
  ) {
    return raw as Record<string, string>;
  }
  errors.push({
    file: filePath,
    field,
    message: "must be an object with string values",
  });
  return undefined;
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
  const allowed = new Set([
    "servers",
    "defaultTimeoutMs",
    "namePrefix",
    "defaultPolicy",
  ]);
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
  if (raw.defaultPolicy !== undefined) {
    if (isRecord(raw.defaultPolicy)) {
      const policy: NonNullable<CapabilityMcpConfig["defaultPolicy"]> = {};
      const risk = raw.defaultPolicy.risk;
      if (risk !== undefined) {
        if (risk === "safe" || risk === "risky" || risk === "denied")
          policy.risk = risk;
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
  const allowed = new Set([
    "id",
    "name",
    "description",
    "experimental",
    "mode",
    "model",
    "prompt",
    "allowedTools",
    "deniedTools",
    "policy",
    "maxSteps",
    "runBudget",
    "metadata",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push({
        file: filePath,
        field: `${field}.${key}`,
        message: `unknown field (allowed: ${[...allowed].join(", ")})`,
      });
    }
  }
  const profile: AgentProfile = { id: raw.id };
  for (const key of ["name", "description", "prompt"] as const) {
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
    if (raw.mode === "primary" || raw.mode === "child" || raw.mode === "all")
      profile.mode = raw.mode;
    else
      errors.push({
        file: filePath,
        field: `${field}.mode`,
        message: "must be primary, child, or all",
      });
  }
  if (raw.experimental !== undefined) {
    if (isRecord(raw.experimental)) {
      const experimental: AgentProfile["experimental"] = {};
      const allowedExperimental = new Set(["mode", "model", "prompt"]);
      for (const key of Object.keys(raw.experimental)) {
        if (!allowedExperimental.has(key)) {
          errors.push({
            file: filePath,
            field: `${field}.experimental.${key}`,
            message: "unknown field",
          });
        }
      }
      if (raw.experimental.mode !== undefined) {
        if (
          raw.experimental.mode === "primary" ||
          raw.experimental.mode === "child" ||
          raw.experimental.mode === "all"
        ) {
          experimental.mode = raw.experimental.mode;
        } else {
          errors.push({
            file: filePath,
            field: `${field}.experimental.mode`,
            message: "must be primary, child, or all",
          });
        }
      }
      if (raw.experimental.model !== undefined) {
        experimental.model = raw.experimental.model;
      }
      if (raw.experimental.prompt !== undefined) {
        if (typeof raw.experimental.prompt === "string") {
          experimental.prompt = raw.experimental.prompt;
        } else {
          errors.push({
            file: filePath,
            field: `${field}.experimental.prompt`,
            message: "must be a string",
          });
        }
      }
      profile.experimental = experimental;
    } else {
      errors.push({
        file: filePath,
        field: `${field}.experimental`,
        message: "must be an object",
      });
    }
  }
  if (raw.model !== undefined) profile.model = raw.model;
  for (const key of ["allowedTools", "deniedTools"] as const) {
    if (raw[key] !== undefined) {
      profile[key] = validateStringArray(
        raw[key],
        `${field}.${key}`,
        filePath,
        errors,
      );
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
    new Set([
      "transport",
      "command",
      "args",
      "cwd",
      "env",
      "envMode",
      "workspaceAccess",
      "timeoutMs",
    ]),
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
    acp.envMode !== "inherit" &&
    acp.envMode !== "explicit"
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
    new Set([
      "command",
      "args",
      "cwd",
      "env",
      "envMode",
      "workspaceAccess",
      "timeoutMs",
      "input",
      "maxOutputBytes",
      "maxStdoutBytes",
      "maxStderrBytes",
      "successExitCodes",
    ]),
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
    command.envMode !== "inherit" &&
    command.envMode !== "explicit"
  ) {
    errors.push({
      file: filePath,
      field: `${field}.envMode`,
      message: "must be inherit or explicit",
    });
  }
  if (
    command.input !== undefined &&
    command.input !== "argument" &&
    command.input !== "stdin" &&
    command.input !== "none"
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
  if (value !== undefined && value !== "none" && value !== "read_write") {
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
  if (typeof value !== "string" || value.length === 0) {
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
  if (value !== undefined && typeof value !== "string") {
    errors.push({ file: filePath, field, message: "must be a string" });
  }
}

function validateOptionalNumber(
  value: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  if (value !== undefined && typeof value !== "number") {
    errors.push({ file: filePath, field, message: "must be a number" });
  }
}

function validateOptionalStringArray(
  value: unknown,
  field: string,
  filePath: string,
  errors: SharedConfigError[],
): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
  ) {
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
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      !value.every(
        (item) => typeof item === "number" && Number.isInteger(item),
      ))
  ) {
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
  if (
    !isRecord(value) ||
    !Object.values(value).every((item) => typeof item === "string")
  ) {
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
  const allowed = new Set(["profiles", "delegateTools"]);
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
  if (typeof raw.profileId !== "string" || raw.profileId.length === 0) {
    errors.push({
      file: filePath,
      field: `${field}.profileId`,
      message: "must be a non-empty string",
    });
    return undefined;
  }
  const out: CapabilityDelegateToolConfig = { profileId: raw.profileId };
  for (const key of ["toolName", "description"] as const) {
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
  for (const key of ["requiresApproval", "forbidNesting"] as const) {
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
        if (!isRecord(entry)) {
          errors.push({
            file: filePath,
            field: `providers.${key}.models.${modelId}`,
            message: "must be an object",
          });
          continue;
        }
        const modelConfig: ProviderModelConfig = {};
        if (entry.cost !== undefined) {
          if (isRecord(entry.cost)) {
            const cost: ModelCost = {};
            for (const field of [
              "input",
              "output",
              "cacheRead",
              "cacheWrite",
            ] as const) {
              const v = entry.cost[field];
              if (v === undefined) continue;
              if (typeof v === "number") cost[field] = v;
              else
                errors.push({
                  file: filePath,
                  field: `providers.${key}.models.${modelId}.cost.${field}`,
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
 * Map each grouped key to the flat internal field it normalizes to. The grouped
 * form (`identity`/`policy`/`run`/`ui`) is the preferred on-disk surface; the
 * loader flattens it into the historical flat `SharedConfig` so consumers are
 * untouched and the old flat keys keep working as aliases. `policy.sandbox`
 * remaps structurally to `shell.sandbox` and is handled specially below;
 * `capabilities` is already its own group and passes through unchanged.
 */
const CONFIG_GROUP_FIELD_MAP: Record<string, Record<string, string>> = {
  identity: { model: "model", providers: "providers" },
  policy: {
    permissionMode: "permissionMode",
    confidentialPaths: "confidentialPaths",
    write: "write",
  },
  run: {
    budget: "runBudget",
    maxSteps: "maxSteps",
    traceLevel: "traceLevel",
    approvals: "approvals",
  },
  ui: { theme: "theme", mouse: "mouse", keybindings: "keybindings" },
};

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

  for (const [group, fieldMap] of Object.entries(CONFIG_GROUP_FIELD_MAP)) {
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
    const knownSub = new Set([
      ...Object.keys(fieldMap),
      ...(group === "policy" ? ["sandbox"] : []),
    ]);
    for (const subKey of Object.keys(groupValue)) {
      if (!knownSub.has(subKey)) {
        errors.push({
          file: filePath,
          field: `${group}.${subKey}`,
          message: `unknown field (allowed: ${[...knownSub].join(", ")})`,
        });
        continue;
      }
      if (group === "policy" && subKey === "sandbox") {
        assign("shell", { sandbox: groupValue.sandbox }, "policy.sandbox");
        continue;
      }
      assign(fieldMap[subKey], groupValue[subKey], `${group}.${subKey}`);
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
      message: "must be a JSON object",
    });
    return { config, sources, errors };
  }
  const obj = normalizeGroupedConfig(raw, filePath, errors);

  if (obj.model !== undefined) {
    if (typeof obj.model === "string" && obj.model.length > 0) {
      config.model = obj.model;
      sources.model = origin;
    } else {
      errors.push({
        file: filePath,
        field: "model",
        message: "must be a non-empty string",
      });
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
        message: "must be a JSON object",
      });
    }
  }
  if (obj.permissionMode !== undefined) {
    if (
      typeof obj.permissionMode === "string" &&
      (VALID_PERMISSION_MODES as string[]).includes(obj.permissionMode)
    ) {
      config.permissionMode = obj.permissionMode as PermissionMode;
      sources.permissionMode = origin;
    } else {
      errors.push({
        file: filePath,
        field: "permissionMode",
        message: `must be one of ${VALID_PERMISSION_MODES.join(" | ")}`,
      });
    }
  }
  if (obj.workspace !== undefined) {
    if (typeof obj.workspace === "string" && obj.workspace.length > 0) {
      config.workspace = obj.workspace;
      sources.workspace = origin;
    } else {
      errors.push({
        file: filePath,
        field: "workspace",
        message: "must be a non-empty string",
      });
    }
  }
  if (obj.confidentialPaths !== undefined) {
    if (
      Array.isArray(obj.confidentialPaths) &&
      obj.confidentialPaths.every(
        (entry) => typeof entry === "string" && entry.length > 0,
      )
    ) {
      config.confidentialPaths = obj.confidentialPaths as string[];
      sources.confidentialPaths = origin;
    } else {
      errors.push({
        file: filePath,
        field: "confidentialPaths",
        message: "must be an array of non-empty strings",
      });
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
    const maxSteps = validateOptionalPositiveInteger(
      obj.maxSteps,
      "maxSteps",
      filePath,
      errors,
    );
    if (maxSteps !== undefined) {
      config.maxSteps = maxSteps;
      sources.maxSteps = origin;
    }
  }
  if (obj.traceLevel !== undefined) {
    if ((VALID_TRACE_LEVELS as string[]).includes(obj.traceLevel as string)) {
      config.traceLevel = obj.traceLevel as TraceLevel;
      sources.traceLevel = origin;
    } else {
      errors.push({
        file: filePath,
        field: "traceLevel",
        message: `must be one of ${VALID_TRACE_LEVELS.join(" | ")}`,
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
  if (obj.capabilities !== undefined) {
    const capabilities = validateCapabilities(
      obj.capabilities,
      filePath,
      errors,
    );
    if (capabilities) config.capabilities = capabilities;
  }
  return { config, sources, errors };
}

/** Load + merge the shared config fields across the resolution order. */
export async function loadHostConfig(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<LoadedSharedConfig> {
  const order = configResolutionOrder(cwd, env);
  const merged: SharedConfig = {};
  const sources: SharedConfigSourceMap = {};
  const attempted: LoadedSharedConfig["attempted"] = [];
  const errors: SharedConfigError[] = [];

  for (const { path, label } of order) {
    const r = await readJson(path);
    if (r.kind === "missing") {
      attempted.push({ path, loaded: false });
      continue;
    }
    if (r.kind === "error") {
      attempted.push({ path, loaded: false });
      errors.push({ file: path, field: "(root)", message: r.message });
      continue;
    }
    attempted.push({ path, loaded: true });
    const v = validateShared(r.value, `${label}:${path}`, path);
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
    // capabilities merge by sub-capability (tools/skills/mcp/agents), and
    // shell.sandbox merges conservatively so a project cannot downgrade a
    // user-defined sandbox boundary. Within a sub-capability the later layer
    // still wholesale-overrides. Every other field is wholesale-overridden.
    const {
      providers,
      capabilities: layerCapabilities,
      shell: layerShell,
      permissionMode: layerPermissionMode,
      confidentialPaths: layerConfidentialPaths,
      write: layerWrite,
      ...rest
    } = v.config;
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
    // permissionMode and confidentialPaths are security boundaries: merge them
    // conservatively (like shell.sandbox) so a later, lower-trust layer (e.g. a
    // project config) can only tighten — never weaken — an earlier layer's
    // policy. permissionMode keeps the stricter mode; confidentialPaths unions.
    if (layerPermissionMode !== undefined) {
      const previous = merged.permissionMode;
      merged.permissionMode = stricterPermissionMode(
        previous,
        layerPermissionMode,
      );
      if (merged.permissionMode !== previous) {
        sources.permissionMode = v.sources.permissionMode;
      }
    }
    if (layerConfidentialPaths !== undefined) {
      merged.confidentialPaths = mergeUniqueStrings(
        merged.confidentialPaths,
        layerConfidentialPaths,
      );
      sources.confidentialPaths = v.sources.confidentialPaths;
    }
    if (layerWrite !== undefined) {
      merged.write = mergeWriteGuardrails(merged.write, layerWrite);
      sources.write = v.sources.write;
    }
    const { providers: providerSources, ...fieldSources } = v.sources;
    // These security-boundary sources are tracked above to reflect the layer
    // that actually won the conservative merge, not just the last to set them.
    delete fieldSources.permissionMode;
    delete fieldSources.confidentialPaths;
    delete fieldSources.write;
    Object.assign(sources, fieldSources);
    if (providerSources) {
      sources.providers = { ...(sources.providers ?? {}), ...providerSources };
    }
  }

  return { config: merged, sources, attempted, errors };
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
