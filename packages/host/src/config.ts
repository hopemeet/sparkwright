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
 * files; every other field is wholesale-overridden. Callers layer CLI flags /
 * env on top.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { PermissionMode } from "@sparkwright/core";
import type { AgentProfile } from "@sparkwright/agent-runtime";

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
}

export interface ProviderConfig {
  npm?: string;
  baseURL?: string;
  apiKey?: string;
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
   * read-confidentiality: matching `read_file`/`grep_text` reads are denied at
   * the tool layer. Empty/absent leaves the default permissive behavior.
   */
  confidentialPaths?: string[];
  capabilities?: CapabilityConfig;
}

export interface CapabilityConfig {
  tools?: CapabilityToolsConfig;
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
  const allowed = new Set(["tools", "skills", "mcp", "agents"]);
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
  const obj = raw;

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
    // Providers merge by key (a later file adds/overrides individual entries);
    // every other field is wholesale-overridden.
    const { providers, ...rest } = v.config;
    Object.assign(merged, rest);
    if (providers) {
      merged.providers = { ...(merged.providers ?? {}), ...providers };
    }
    const { providers: providerSources, ...fieldSources } = v.sources;
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
  return {
    kind: "configured",
    providerKey,
    modelId,
    npm,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    cost: provider.models?.[modelId]?.cost,
  };
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
