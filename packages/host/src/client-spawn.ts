import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PermissionMode } from "@sparkwright/protocol";

const require = createRequire(import.meta.url);

export interface HostStdioSpawnInput {
  workspaceRoot: string;
  sessionRootDir: string;
  permissionMode: PermissionMode;
  modelName?: string;
  env?: Record<string, string | undefined>;
}

export interface ResolvedHostStdioSpawn {
  command: string;
  args: string[];
}

export function resolveHostStdioSpawn(
  input: HostStdioSpawnInput,
): ResolvedHostStdioSpawn {
  const env = input.env ?? process.env;
  return {
    command: resolveHostCommand(env),
    args: [
      ...resolveHostExecutableArgs(env),
      "--stdio",
      "--workspace",
      input.workspaceRoot,
      "--session-root",
      input.sessionRootDir,
      "--permission-mode",
      input.permissionMode,
      ...(input.modelName ? ["--model", input.modelName] : []),
    ],
  };
}

export function resolveHostCommand(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.SPARKWRIGHT_HOST_COMMAND ?? process.execPath;
}

export function resolveHostExecutableArgs(
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (env.SPARKWRIGHT_HOST_BIN) return [env.SPARKWRIGHT_HOST_BIN];
  if (env.SPARKWRIGHT_HOST_SOURCE === "1") {
    return [require.resolve("tsx/cli"), resolveHostSourceBin()];
  }
  return [resolveHostBin()];
}

export function resolveHostBin(): string {
  return require.resolve("@sparkwright/host/dist/bin.js");
}

export function resolveHostSourceBin(): string {
  return join(dirname(dirname(resolveHostBin())), "src", "bin.ts");
}
