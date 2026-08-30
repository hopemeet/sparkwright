import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  parse as parseYaml,
  parseDocument as parseYamlDocument,
  stringify as stringifyYaml,
} from "yaml";
import { atomicWriteText } from "@sparkwright/agent-runtime";
import { withExclusiveFileLock } from "../provider-credential-store.js";
import {
  CONFIG_ENV_VAR,
  CONFIG_FILE_BASENAMES,
  CONFIG_PROJECT_REL,
  CONFIG_USER_DIR_SUBPATH,
  CONFIG_USER_JSON_SUBPATH,
} from "./contracts.js";

export type ConfigLayerLabel = "user" | "project" | "env";

export interface ConfigLayerResolution {
  label: ConfigLayerLabel;
  candidates: string[];
}

export type ConfigFileFormat = "json" | "yaml";

export interface ConfigFileObject {
  exists: boolean;
  value: Record<string, unknown>;
  format: ConfigFileFormat;
}

export type ConfigFileReadResult =
  | { kind: "ok"; value: unknown }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function userConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
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
  return configLayerResolutionOrder(cwd, env).flatMap((layer) =>
    layer.candidates.map((path) => ({ path, label: layer.label })),
  );
}

export function configLayerResolutionOrder(
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

export async function readConfigFile(
  path: string,
): Promise<ConfigFileReadResult> {
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
  if (result.kind === "error") throw new Error(result.message);
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
  if (options.privateFile !== false) await chmod(path, 0o600);
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

/**
 * Remove one explicitly selected legacy provider API key without rewriting
 * unrelated YAML comments. The exact expected value is checked while holding
 * a cross-process lock so a concurrent config edit cannot be overwritten.
 */
export async function removeLegacyProviderApiKey(input: {
  path: string;
  providerId: string;
  expectedSecret: string;
}): Promise<{ removed: true; path: string }> {
  return await withExclusiveFileLock(`${input.path}.lock`, async () => {
    const raw = await readFile(input.path, "utf8");
    const info = await stat(input.path);
    const format = configFileFormatForPath(input.path);
    let serialized: string;
    if (format === "yaml") {
      const document = parseYamlDocument(raw);
      if (document.errors.length > 0) {
        throw new Error(`${input.path} is not valid YAML.`);
      }
      const canonicalPath = [
        "identity",
        "providers",
        input.providerId,
        "apiKey",
      ];
      const legacyPath = ["providers", input.providerId, "apiKey"];
      const selectedPath =
        document.getIn(canonicalPath) !== undefined
          ? canonicalPath
          : document.getIn(legacyPath) !== undefined
            ? legacyPath
            : undefined;
      if (!selectedPath) {
        throw new Error(
          `Provider "${input.providerId}" no longer has a legacy apiKey in ${input.path}.`,
        );
      }
      if (document.getIn(selectedPath) !== input.expectedSecret) {
        throw new Error(
          `Provider "${input.providerId}" apiKey changed during migration; no config was modified.`,
        );
      }
      document.deleteIn(selectedPath);
      serialized = document.toString({ lineWidth: 0 });
    } else {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed))
        throw new Error(`${input.path} must contain an object.`);
      const canonicalProviders = isRecord(parsed.identity)
        ? parsed.identity.providers
        : undefined;
      const providers = isRecord(canonicalProviders)
        ? canonicalProviders
        : parsed.providers;
      const provider = isRecord(providers)
        ? providers[input.providerId]
        : undefined;
      if (!isRecord(provider) || provider.apiKey === undefined) {
        throw new Error(
          `Provider "${input.providerId}" no longer has a legacy apiKey in ${input.path}.`,
        );
      }
      if (provider.apiKey !== input.expectedSecret) {
        throw new Error(
          `Provider "${input.providerId}" apiKey changed during migration; no config was modified.`,
        );
      }
      delete provider.apiKey;
      serialized = `${JSON.stringify(parsed, null, 2)}\n`;
    }
    await atomicWriteText(input.path, serialized, {
      mode: info.mode & 0o777,
      durable: true,
    });
    return { removed: true as const, path: input.path };
  });
}

function configSiblingCandidatePaths(defaultJsonPath: string): string[] {
  const dir = dirname(defaultJsonPath);
  return CONFIG_FILE_BASENAMES.map((name) => join(dir, name));
}

export async function existingConfigCandidatePaths(
  paths: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (info.isFile()) out.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") out.push(path);
    }
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
