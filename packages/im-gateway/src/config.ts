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
  sessionRouting?: {
    groupSessionsPerUser?: boolean;
    threadSessionsPerUser?: boolean;
  };
  telegram?: TelegramGatewayConfig;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".sparkwright", "im-gateway.json");
}

export function defaultDataDir(): string {
  return join(homedir(), ".sparkwright", "im-gateway");
}

export async function loadConfig(
  path = defaultConfigPath(),
): Promise<ImGatewayConfig> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as ImGatewayConfig;
}

export async function writeConfig(
  config: ImGatewayConfig,
  path = defaultConfigPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
}
