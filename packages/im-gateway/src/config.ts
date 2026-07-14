import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  /** Local workspace whose durable workflow channel stores this gateway serves. */
  workspaceRoot?: string;
  telegram?: TelegramGatewayConfig;
}

export function defaultConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(configBase(env), "sparkwright", "im-gateway.json");
}

export function defaultDataDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(stateBase(env), "sparkwright", "im-gateway");
}

export async function loadConfig(path?: string): Promise<ImGatewayConfig> {
  const raw = await readFile(resolveConfigPathForRead(path), "utf8");
  return JSON.parse(raw) as ImGatewayConfig;
}

export async function writeConfig(
  config: ImGatewayConfig,
  path = defaultConfigPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
}

export function resolveConfigPathForRead(
  path?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return path ?? defaultConfigPath(env);
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
