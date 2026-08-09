import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type CapabilityLayer = "builtin" | "user" | "project";
export type CapabilityKind = "skills" | "agents" | "command" | "workflows";

export interface ResolvedCapabilityDir {
  layer: CapabilityLayer;
  dir: string;
  /** @reserved Public capability-layer field consumed by inspect UIs. */
  readOnly: boolean;
}

export interface ResolveCapabilityDirsOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Include repository-authored capability roots. Defaults to true. */
  includeProject?: boolean;
}

/**
 * Resolve authored capability directories in weak-to-strong precedence order.
 * Later layers shadow earlier layers by capability id/name at the callsite.
 */
export function resolveCapabilityDirs(
  kind: CapabilityKind,
  options: ResolveCapabilityDirsOptions,
): ResolvedCapabilityDir[] {
  const env = options.env ?? process.env;
  const dirs: ResolvedCapabilityDir[] = [
    {
      layer: "builtin",
      dir: join(packageRootFromImportMeta(), "builtin", kind),
      readOnly: true,
    },
    {
      layer: "user",
      dir: join(userConfigBase(env), "sparkwright", kind),
      readOnly: false,
    },
    {
      layer: "project",
      dir: join(options.cwd, ".sparkwright", kind),
      readOnly: false,
    },
  ];
  return options.includeProject === false
    ? dirs.filter((entry) => entry.layer !== "project")
    : dirs;
}

export function userConfigBase(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
}

function packageRootFromImportMeta(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const leaf = basename(currentDir);
  return leaf === "src" || leaf === "dist" ? dirname(currentDir) : currentDir;
}
