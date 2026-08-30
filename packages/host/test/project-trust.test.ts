import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectTrustManager,
  isProjectScopeTrusted,
} from "../src/project-trust.js";

describe("ProjectTrustManager", () => {
  it("pins project capability content per scope and invalidates only changed scopes", async () => {
    const fixture = await projectTrustFixture();
    try {
      await writeCapability(
        fixture.workspace,
        "command/review.md",
        "review v1",
      );
      await writeCapability(
        fixture.workspace,
        "skills/test/SKILL.md",
        "skill v1",
      );

      const before = await fixture.manager.inspect(fixture.workspace);
      expect(before.status).toBe("untrusted");
      expect(scope(before, "commands")).toMatchObject({
        status: "untrusted",
        fileCount: 1,
      });
      expect(scope(before, "skills")).toMatchObject({ status: "untrusted" });

      const granted = await fixture.manager.grant({
        workspaceRoot: fixture.workspace,
        expectedManifestHash: before.manifestHash,
        scopes: ["commands"],
      });
      expect(granted.ok).toBe(true);
      if (!granted.ok) return;
      expect(scope(granted.snapshot, "commands")?.status).toBe("trusted");
      expect(scope(granted.snapshot, "skills")?.status).toBe("untrusted");
      expect(isProjectScopeTrusted(granted.snapshot, "commands")).toBe(true);
      expect(isProjectScopeTrusted(granted.snapshot, "skills")).toBe(false);

      await writeCapability(
        fixture.workspace,
        "command/review.md",
        "review v2",
      );
      const changed = await fixture.manager.inspect(fixture.workspace);
      expect(changed.status).toBe("changed");
      expect(scope(changed, "commands")?.status).toBe("changed");
      expect(scope(changed, "skills")?.status).toBe("untrusted");

      const staleGrant = await fixture.manager.grant({
        workspaceRoot: fixture.workspace,
        expectedManifestHash: before.manifestHash,
        scopes: ["commands"],
      });
      expect(staleGrant).toMatchObject({ ok: false, code: "conflict" });

      const refreshed = await fixture.manager.grant({
        workspaceRoot: fixture.workspace,
        expectedManifestHash: changed.manifestHash,
        scopes: ["commands"],
      });
      expect(refreshed.ok).toBe(true);
      const revoked = await fixture.manager.revoke({
        workspaceRoot: fixture.workspace,
        scopes: ["commands"],
      });
      expect(revoked.ok).toBe(true);
      if (revoked.ok) {
        expect(scope(revoked.snapshot, "commands")?.status).toBe("untrusted");
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("stores no capability bodies outside the workspace with private file mode", async () => {
    const fixture = await projectTrustFixture();
    try {
      const secretMarker = "do-not-copy-this-project-command";
      await writeCapability(
        fixture.workspace,
        "command/private.md",
        secretMarker,
      );
      const snapshot = await fixture.manager.inspect(fixture.workspace);
      await fixture.manager.grant({
        workspaceRoot: fixture.workspace,
        expectedManifestHash: snapshot.manifestHash,
      });

      const stateText = await readFile(fixture.statePath, "utf8");
      const stateInfo = await stat(fixture.statePath);
      expect(fixture.statePath.startsWith(fixture.workspace)).toBe(false);
      expect(stateInfo.mode & 0o777).toBe(0o600);
      expect(stateText).not.toContain(secretMarker);
      expect(stateText).toContain("sha256:");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses the canonical workspace root and keeps separate worktrees isolated", async () => {
    const fixture = await projectTrustFixture();
    const secondWorkspace = join(fixture.root, "worktree-b");
    const workspaceAlias = join(fixture.root, "workspace-alias");
    try {
      await mkdir(secondWorkspace, { recursive: true });
      await writeCapability(fixture.workspace, "command/check.md", "same body");
      await writeCapability(secondWorkspace, "command/check.md", "same body");
      await symlink(fixture.workspace, workspaceAlias, "dir");

      const original = await fixture.manager.inspect(fixture.workspace);
      const alias = await fixture.manager.inspect(workspaceAlias);
      expect(alias.workspaceId).toBe(original.workspaceId);
      expect(alias.canonicalWorkspaceRoot).toBe(
        original.canonicalWorkspaceRoot,
      );

      await fixture.manager.grant({
        workspaceRoot: workspaceAlias,
        expectedManifestHash: alias.manifestHash,
      });
      expect((await fixture.manager.inspect(fixture.workspace)).status).toBe(
        "trusted",
      );
      expect((await fixture.manager.inspect(secondWorkspace)).status).toBe(
        "untrusted",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks inside project capability scopes", async () => {
    const fixture = await projectTrustFixture();
    try {
      const outside = join(fixture.root, "outside.md");
      const commandDir = join(fixture.workspace, ".sparkwright", "command");
      await mkdir(commandDir, { recursive: true });
      await writeFile(outside, "external command", "utf8");
      await symlink(outside, join(commandDir, "linked.md"));

      const snapshot = await fixture.manager.inspect(fixture.workspace);
      expect(snapshot.status).toBe("invalid");
      expect(scope(snapshot, "commands")).toMatchObject({
        status: "invalid",
        reason: "symlink_not_allowed",
      });
      await expect(
        fixture.manager.grant({
          workspaceRoot: fixture.workspace,
          expectedManifestHash: snapshot.manifestHash,
          scopes: ["commands"],
        }),
      ).resolves.toMatchObject({ ok: false, code: "invalid_payload" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not require config trust for safety-only settings", async () => {
    const fixture = await projectTrustFixture();
    try {
      await writeCapability(
        fixture.workspace,
        "config.json",
        JSON.stringify({
          policy: {
            confidentialPaths: ["private/**"],
            confidentialDefaults: true,
            write: { maxFiles: 2 },
            sandbox: {
              mode: "enforce",
              failIfUnavailable: true,
              filesystem: { denyRead: ["private/**"], tmp: false },
              network: { mode: "deny" },
            },
          },
          run: { accessMode: "read-only", backgroundTasks: "disabled" },
          tools: { allowed: ["read_file"], disabled: ["bash"] },
          capabilities: { web: { security: "hardened" } },
          ui: { theme: "mono" },
        }),
      );

      const snapshot = await fixture.manager.inspect(fixture.workspace);

      expect(snapshot.status).toBe("not_required");
      expect(scope(snapshot, "config")?.status).toBe("not_present");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires config trust for settings that can relax or activate behavior", async () => {
    const fixture = await projectTrustFixture();
    try {
      for (const config of [
        { tools: { defer: ["mcp"] } },
        { policy: { confidentialDefaults: false } },
        {
          policy: {
            sandbox: { filesystem: { allowRead: ["/"] } },
          },
        },
      ]) {
        await writeCapability(
          fixture.workspace,
          "config.json",
          JSON.stringify(config),
        );
        const snapshot = await fixture.manager.inspect(fixture.workspace);
        expect(scope(snapshot, "config")?.status).toBe("untrusted");
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

function scope(
  snapshot: Awaited<ReturnType<ProjectTrustManager["inspect"]>>,
  name: "config" | "commands" | "skills" | "agents" | "workflows",
) {
  return snapshot.scopes.find((entry) => entry.scope === name);
}

async function writeCapability(
  workspace: string,
  relativePath: string,
  body: string,
): Promise<void> {
  const path = join(workspace, ".sparkwright", relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body, "utf8");
}

async function projectTrustFixture(): Promise<{
  root: string;
  workspace: string;
  statePath: string;
  manager: ProjectTrustManager;
}> {
  const root = await mkdtemp(join(tmpdir(), "sparkwright-project-trust-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state", "sparkwright", "project-trust.json");
  await mkdir(workspace, { recursive: true });
  return {
    root,
    workspace,
    statePath,
    manager: new ProjectTrustManager({ statePath }),
  };
}
