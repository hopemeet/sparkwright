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
  { factory: string; apiKeyEnv: string }
> = {
  "@ai-sdk/openai": { factory: "createOpenAI", apiKeyEnv: "OPENAI_API_KEY" },
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
}

export interface SharedConfigSourceMap {
  model?: string;
  permissionMode?: string;
  workspace?: string;
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
        if (provider) providers[key] = provider;
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
    // Providers merge by key (a later file adds/overrides individual entries);
    // every other field is wholesale-overridden.
    const { providers, ...rest } = v.config;
    Object.assign(merged, rest);
    if (providers) {
      merged.providers = { ...(merged.providers ?? {}), ...providers };
    }
    Object.assign(sources, v.sources);
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
