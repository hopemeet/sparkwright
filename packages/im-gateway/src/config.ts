import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface TelegramGatewayConfig {
  token: string;
  allowedChatIds?: string[];
  allowedUserIds?: string[];
  pollingTimeoutSeconds?: number;
}

export interface ImGatewayConfig {
  hostUrl?: string;
  /** Model reference "provider/model" (e.g. "openai/gpt-4o-mini"). */
  model?: string;
  dataDir?: string;
  sessionRouting?: {
    groupSessionsPerUser?: boolean;
    threadSessionsPerUser?: boolean;
  };
  telegram?: TelegramGatewayConfig;
}

export interface ImGatewayMigrationOptions {
  env?: Record<string, string | undefined>;
  fromConfigPath?: string;
  toConfigPath?: string;
  copyState?: boolean;
  fromDataDir?: string;
  toDataDir?: string;
  force?: boolean;
}

export interface ImGatewayMigrationResult {
  config: {
    from: string;
    to: string;
    migrated: boolean;
  };
  state?: {
    from: string;
    to: string;
    migrated: boolean;
    reason?: "missing-source" | "not-requested";
  };
}

export function defaultConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(configBase(env), "sparkwright", "im-gateway.json");
}

export function legacyConfigPath(): string {
  return join(homedir(), ".sparkwright", "im-gateway.json");
}

export function defaultDataDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(stateBase(env), "sparkwright", "im-gateway");
}

export function legacyDataDir(): string {
  return join(homedir(), ".sparkwright", "im-gateway");
}

export async function loadConfig(path?: string): Promise<ImGatewayConfig> {
  const resolved = await resolveConfigPathForRead(path);
  const raw = await readFile(resolved.path, "utf8");
  return JSON.parse(raw) as ImGatewayConfig;
}

export async function writeConfig(
  config: ImGatewayConfig,
  path = defaultConfigPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
}

export async function resolveConfigPathForRead(
  path?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ path: string; legacy: boolean }> {
  if (path) return { path, legacy: path === legacyConfigPath() };

  const next = defaultConfigPath(env);
  try {
    await readFile(next, "utf8");
    return { path: next, legacy: false };
  } catch (error) {
    const legacy = legacyConfigPath();
    try {
      await readFile(legacy, "utf8");
      return { path: legacy, legacy: true };
    } catch {
      throw error;
    }
  }
}

export async function migrateLegacyPaths(
  options: ImGatewayMigrationOptions = {},
): Promise<ImGatewayMigrationResult> {
  const env = options.env ?? process.env;
  const fromConfig = options.fromConfigPath ?? legacyConfigPath();
  const toConfig = options.toConfigPath ?? defaultConfigPath(env);
  if (!options.force && (await pathExists(toConfig))) {
    throw new Error(`target config already exists: ${toConfig}`);
  }

  const config = await loadConfig(fromConfig);
  await writeConfig(config, toConfig);

  if (!options.copyState) {
    return {
      config: { from: fromConfig, to: toConfig, migrated: true },
      state: {
        from: options.fromDataDir ?? legacyDataDir(),
        to: options.toDataDir ?? defaultDataDir(env),
        migrated: false,
        reason: "not-requested",
      },
    };
  }

  const fromData = options.fromDataDir ?? legacyDataDir();
  const toData = options.toDataDir ?? defaultDataDir(env);
  if (!(await pathExists(fromData))) {
    return {
      config: { from: fromConfig, to: toConfig, migrated: true },
      state: {
        from: fromData,
        to: toData,
        migrated: false,
        reason: "missing-source",
      },
    };
  }
  if (!options.force && (await pathExists(toData))) {
    throw new Error(`target data dir already exists: ${toData}`);
  }
  await mkdir(dirname(toData), { recursive: true });
  await cp(fromData, toData, {
    recursive: true,
    force: options.force ?? false,
    errorOnExist: !(options.force ?? false),
  });
  return {
    config: { from: fromConfig, to: toConfig, migrated: true },
    state: { from: fromData, to: toData, migrated: true },
  };
}

function configBase(env: Record<string, string | undefined>): string {
  return env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
}

function stateBase(env: Record<string, string | undefined>): string {
  return env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
    ? env.XDG_STATE_HOME
    : join(homedir(), ".local", "state");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
