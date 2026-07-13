import { resolve } from "node:path";
import type { SkillRoot } from "@sparkwright/skills";
import {
  createPlatformShellSandboxRuntime,
  describeShellSandboxStatus,
  resolveShellSandboxConfig,
  type ResolvedShellSandboxConfig,
  type ShellSandboxRuntime,
  type ShellSandboxStatus,
} from "@sparkwright/shell-sandbox";
import type { LoadedSharedConfig } from "./config.js";
import type { ResolvedRunAccess } from "./run-access.js";
import { resolveSkillRootsForRuntime } from "./skill-roots.js";

/**
 * Immutable, side-effect-free inputs shared by Host capability inspection and
 * one run's mutable runtime assembly. Process lifecycles, prepared tools, and
 * per-run policy state deliberately do not belong here.
 */
export interface HostRunSecurityPlan {
  readonly workspaceRoot: string;
  readonly access: Omit<
    Readonly<ResolvedRunAccess>,
    "overriddenLegacyFields"
  > & {
    readonly overriddenLegacyFields: readonly string[];
  };
  readonly confidentialPaths?: readonly string[];
  readonly confidentialDefaults?: boolean;
  readonly skillRoots: readonly Readonly<SkillRoot>[];
  readonly configPaths: readonly string[];
  readonly shellSandbox: ResolvedShellSandboxConfig;
  readonly shellSandboxStatus: ShellSandboxStatus;
}

export async function prepareHostRunSecurityPlan(input: {
  workspaceRoot: string;
  access: ResolvedRunAccess;
  loadedConfig: LoadedSharedConfig;
  requestConfidentialPaths?: readonly string[];
  requestConfidentialDefaults?: boolean;
  sandboxRuntime?: ShellSandboxRuntime;
}): Promise<HostRunSecurityPlan> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const configPaths = Object.freeze(
    input.loadedConfig.attempted.map((entry) => entry.path),
  );
  const skillRoots = Object.freeze(
    resolveSkillRootsForRuntime(
      workspaceRoot,
      input.loadedConfig.config.capabilities?.skills?.roots,
    ).map((root) => Object.freeze({ ...root })),
  );
  const shellSandbox = freezeResolvedShellSandbox(
    resolveShellSandboxConfig({
      workspaceRoot,
      config: input.loadedConfig.config.shell?.sandbox,
      skillRoots: skillRoots.map((root) => root.root),
      extraForcedDenyWrite: configPaths,
    }),
  );
  const shellSandboxStatus = Object.freeze(
    await describeShellSandboxStatus(
      shellSandbox,
      input.sandboxRuntime ?? createPlatformShellSandboxRuntime(),
    ),
  );
  const confidentialPaths = mergeUniquePaths(
    input.loadedConfig.config.confidentialPaths,
    input.requestConfidentialPaths,
  );
  const access = Object.freeze({
    ...input.access,
    overriddenLegacyFields: Object.freeze([
      ...input.access.overriddenLegacyFields,
    ]),
  });

  return Object.freeze({
    workspaceRoot,
    access,
    ...(confidentialPaths ? { confidentialPaths } : {}),
    confidentialDefaults:
      input.requestConfidentialDefaults ??
      input.loadedConfig.config.confidentialDefaults,
    skillRoots,
    configPaths,
    shellSandbox,
    shellSandboxStatus,
  });
}

function mergeUniquePaths(
  ...groups: Array<readonly string[] | undefined>
): readonly string[] | undefined {
  const paths = [...new Set(groups.flatMap((group) => group ?? []))];
  return paths.length > 0 ? Object.freeze(paths) : undefined;
}

function freezeResolvedShellSandbox(
  sandbox: ResolvedShellSandboxConfig,
): ResolvedShellSandboxConfig {
  return Object.freeze({
    ...sandbox,
    filesystem: Object.freeze({
      ...sandbox.filesystem,
      allowRead: Object.freeze([...sandbox.filesystem.allowRead]),
      allowWrite: Object.freeze([...sandbox.filesystem.allowWrite]),
      denyRead: Object.freeze([...sandbox.filesystem.denyRead]),
      denyWrite: Object.freeze([...sandbox.filesystem.denyWrite]),
    }),
    network: Object.freeze({ ...sandbox.network }),
    forcedDenyWrite: Object.freeze([...sandbox.forcedDenyWrite]),
  });
}
