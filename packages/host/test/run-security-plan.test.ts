import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ShellSandboxRuntime } from "@sparkwright/shell-sandbox";
import type { LoadedSharedConfig } from "../src/config.js";
import type { ResolvedRunAccess } from "../src/run-access.js";
import { prepareHostRunSecurityPlan } from "../src/run-security-plan.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("prepareHostRunSecurityPlan", () => {
  it("freezes one canonical access, path, and sandbox plan", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "host-security-plan-"));
    roots.push(workspaceRoot);
    const configuredSkillRoot = join(workspaceRoot, "configured-skills");
    const configPath = join(workspaceRoot, ".sparkwright", "config.yaml");
    const access: ResolvedRunAccess = {
      permissionMode: "default",
      shouldWrite: true,
      backgroundTasks: "enabled",
      accessMode: "ask",
      overriddenLegacyFields: [],
    };
    const loadedConfig = {
      config: {
        confidentialPaths: [".env", "private/**"],
        confidentialDefaults: true,
        shell: {
          sandbox: {
            mode: "enforce",
            filesystem: { allowRead: ["."] },
          },
        },
        capabilities: { skills: { roots: [configuredSkillRoot] } },
      },
      sources: {},
      attempted: [{ path: configPath, loaded: true }],
      errors: [],
      warnings: [],
    } as LoadedSharedConfig;
    const runtime = {
      id: "bubblewrap",
      platform: "linux",
      isAvailable: async () => true,
      execute: async () => {
        throw new Error("not used by plan preparation");
      },
    } as ShellSandboxRuntime;

    const plan = await prepareHostRunSecurityPlan({
      workspaceRoot,
      access,
      loadedConfig,
      requestConfidentialPaths: ["private/**", "secrets/**"],
      requestConfidentialDefaults: false,
      sandboxRuntime: runtime,
    });

    expect(plan.workspaceRoot).toBe(workspaceRoot);
    expect(plan.access).toEqual(access);
    expect(plan.access).not.toBe(access);
    expect(plan.confidentialPaths).toEqual([
      ".env",
      "private/**",
      "secrets/**",
    ]);
    expect(plan.confidentialDefaults).toBe(false);
    expect(plan.skillRoots.at(-1)).toEqual({
      root: configuredSkillRoot,
      layer: "legacy",
    });
    expect(plan.configPaths).toEqual([configPath]);
    expect(plan.shellSandbox.forcedDenyWrite).toContain(configPath);
    expect(plan.shellSandboxStatus).toMatchObject({
      mode: "enforce",
      available: true,
      runtimeId: "bubblewrap",
      filesystemIsolation: "bind-allowlist",
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.access.overriddenLegacyFields)).toBe(true);
    expect(Object.isFrozen(plan.skillRoots)).toBe(true);
    expect(Object.isFrozen(plan.shellSandbox.filesystem.allowRead)).toBe(true);
  });

  it("compiles read-only run access into a fail-closed no-write process sandbox", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "host-security-plan-"));
    roots.push(workspaceRoot);
    const plan = await prepareHostRunSecurityPlan({
      workspaceRoot,
      access: {
        permissionMode: "plan",
        shouldWrite: false,
        backgroundTasks: "disabled",
        accessMode: "read-only",
        overriddenLegacyFields: [],
      },
      loadedConfig: {
        config: { shell: { sandbox: { mode: "off" } } },
        sources: {},
        attempted: [],
        errors: [],
        warnings: [],
      } as LoadedSharedConfig,
      sandboxRuntime: {
        id: "sandbox-exec",
        platform: "darwin",
        isAvailable: async () => true,
        execute: async () => {
          throw new Error("not used by plan preparation");
        },
      },
    });

    expect(plan.shellSandbox).toMatchObject({
      mode: "enforce",
      failIfUnavailable: true,
      filesystem: { allowWrite: [], tmp: true },
    });
    expect(plan.shellSandbox.filesystem.denyWrite).toContain(workspaceRoot);
    expect(plan.shellSandboxStatus.mode).toBe("off");
  });
});
