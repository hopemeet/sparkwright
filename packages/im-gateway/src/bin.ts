#!/usr/bin/env node
import { join } from "node:path";
import {
  defaultConfigPath,
  defaultDataDir,
  loadConfig,
  writeConfig,
  type ImGatewayConfig,
} from "./config.js";
import { ImGateway } from "./gateway.js";
import { SparkwrightBridge } from "./sparkwright-bridge.js";
import { GatewayStore } from "./store.js";
import { TelegramAdapter } from "./adapters/telegram.js";

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? "help";
  if (command === "setup") {
    await setup(argv.slice(1));
    return;
  }
  if (command === "run") {
    await run(argv.slice(1));
    return;
  }
  printHelp();
}

async function setup(args: string[]): Promise<void> {
  const token =
    readFlag(args, "--telegram-token") ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("missing --telegram-token or TELEGRAM_BOT_TOKEN");
  }
  const path = readFlag(args, "--config") ?? defaultConfigPath();
  const existing = await loadConfigIfExists(path);
  const config: ImGatewayConfig = {
    ...existing,
    hostUrl: readFlag(args, "--host-url") ?? existing.hostUrl,
    model: readFlag(args, "--model") ?? existing.model,
    telegram: {
      ...existing.telegram,
      token,
      allowedChatIds:
        csv(readFlag(args, "--allowed-chat-ids")) ??
        existing.telegram?.allowedChatIds,
      allowedUserIds:
        csv(readFlag(args, "--allowed-user-ids")) ??
        existing.telegram?.allowedUserIds,
    },
  };
  await writeConfig(config, path);
  console.log(`Wrote ${path}`);
}

async function run(args: string[]): Promise<void> {
  const path = readFlag(args, "--config") ?? defaultConfigPath();
  const config = await loadConfig(path);
  if (!config.telegram?.token) {
    throw new Error(`telegram token missing in ${path}`);
  }
  const dataDir = config.dataDir ?? defaultDataDir();
  const gateway = new ImGateway({
    adapters: [
      new TelegramAdapter({
        token: config.telegram.token,
        allowedChatIds: config.telegram.allowedChatIds,
        allowedUserIds: config.telegram.allowedUserIds,
        pollingTimeoutSeconds: config.telegram.pollingTimeoutSeconds,
      }),
    ],
    bridge: new SparkwrightBridge({ hostUrl: config.hostUrl }),
    store: new GatewayStore(join(dataDir, "state.json")),
    sessionRouting: config.sessionRouting,
    model: config.model,
  });

  const stop = async () => {
    await gateway.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await gateway.start();
  await new Promise(() => undefined);
}

function printHelp(): void {
  console.log(`sparkwright-im-gateway

Commands:
  setup --telegram-token <token> [--host-url ws://127.0.0.1:...] [--allowed-user-ids 123,456]
  run [--config ~/.sparkwright/im-gateway.json]
`);
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function loadConfigIfExists(path: string): Promise<ImGatewayConfig> {
  try {
    return await loadConfig(path);
  } catch {
    return {};
  }
}

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
