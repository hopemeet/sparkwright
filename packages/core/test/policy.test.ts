import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIDENTIAL_PATHS,
  createDefaultPolicy,
  createLayeredPolicy,
  createPermissionModePolicy,
  createToolGovernancePolicy,
  createWorkspaceMutationPolicy,
  createWorkspaceReadScopePolicy,
  type Policy,
} from "../src/policy.js";

describe("createDefaultPolicy", () => {
  it("requires approval for workspace writes", async () => {
    const policy = createDefaultPolicy();

    const decision = await policy.decide({
      action: "workspace.write",
      metadata: { path: "README.md" },
    });

    expect(decision).toMatchObject({
      action: "workspace.write",
      decision: "requires_approval",
      metadata: { path: "README.md" },
    });
  });

  it("allows non-write actions", async () => {
    const policy = createDefaultPolicy();

    const decision = await policy.decide({ action: "tool.execute" });

    expect(decision.decision).toBe("allow");
  });

  it("accepts a typed resource alongside compatible metadata", async () => {
    const policy = createDefaultPolicy();

    const decision = await policy.decide({
      action: "tool.execute",
      resource: {
        kind: "tool",
        name: "read",
      },
      metadata: {
        toolName: "legacy-read",
      },
    });

    expect(decision).toMatchObject({
      action: "tool.execute",
      decision: "allow",
      metadata: {
        toolName: "legacy-read",
      },
    });
  });
});

describe("createLayeredPolicy", () => {
  it("applies deny before approval before allow", async () => {
    const policy = createLayeredPolicy([
      fixedPolicy("allow"),
      fixedPolicy("requires_approval"),
      fixedPolicy("deny"),
    ]);

    const decision = await policy.decide({ action: "tool.execute" });

    expect(decision).toMatchObject({
      action: "tool.execute",
      decision: "deny",
    });
  });

  it("requires approval when no layer denies", async () => {
    const policy = createLayeredPolicy([
      fixedPolicy("allow"),
      fixedPolicy("requires_approval"),
    ]);

    const decision = await policy.decide({ action: "tool.execute" });

    expect(decision.decision).toBe("requires_approval");
  });
});

describe("createPermissionModePolicy", () => {
  it("keeps default policy behavior in default mode", async () => {
    const policy = createPermissionModePolicy({ mode: "default" });

    const decision = await policy.decide({
      action: "workspace.write",
      metadata: { path: "README.md" },
    });

    expect(decision.decision).toBe("requires_approval");
  });

  it("requires approval for non-read actions in plan mode", async () => {
    const policy = createPermissionModePolicy({ mode: "plan" });

    await expect(
      policy.decide({ action: "workspace.read" }),
    ).resolves.toMatchObject({
      decision: "allow",
    });
    await expect(
      policy.decide({ action: "tool.execute" }),
    ).resolves.toMatchObject({
      decision: "requires_approval",
      reason: "Plan mode requires approval.",
    });
  });

  it("allows workspace writes in accept_edits mode", async () => {
    const policy = createPermissionModePolicy({ mode: "accept_edits" });

    const decision = await policy.decide({
      action: "workspace.write",
      metadata: { path: "README.md" },
    });

    expect(decision).toMatchObject({
      decision: "allow",
      metadata: { path: "README.md" },
    });
  });

  it("turns approval requests into denials in dont_ask mode", async () => {
    const policy = createPermissionModePolicy({ mode: "dont_ask" });

    const decision = await policy.decide({ action: "workspace.write" });

    expect(decision).toMatchObject({
      decision: "deny",
      reason: "Action requires approval, but dont_ask mode cannot prompt.",
    });
  });

  it("preserves deny decisions in bypass_permissions mode", async () => {
    const policy = createPermissionModePolicy({
      mode: "bypass_permissions",
      basePolicy: fixedPolicy("deny"),
    });

    const decision = await policy.decide({ action: "tool.execute" });

    expect(decision.decision).toBe("deny");
  });
});

describe("createToolGovernancePolicy", () => {
  it("denies tool execution outside the agent allowlist", async () => {
    const policy = createToolGovernancePolicy({ agentId: "writer" });

    const decision = await policy.decide({
      action: "tool.execute",
      metadata: {
        governance: {
          allowedAgents: ["reviewer"],
        },
      },
    });

    expect(decision).toMatchObject({
      decision: "deny",
      reason: "Tool is outside the agent allowlist.",
      metadata: {
        agentId: "writer",
        allowedAgents: ["reviewer"],
      },
    });
  });

  it("requires approval for write, network, or external side effects", async () => {
    const policy = createToolGovernancePolicy({
      agentId: "writer",
      roles: ["engineer"],
    });

    const decision = await policy.decide({
      action: "tool.execute",
      resource: {
        kind: "tool",
        name: "deploy",
        metadata: {
          governance: {
            allowedAgents: ["writer"],
            allowedRoles: ["engineer"],
            sideEffects: ["network", "external"],
          },
        },
      },
    });

    expect(decision).toMatchObject({
      decision: "requires_approval",
      reason: "Tool side effects require approval by governance policy.",
      metadata: {
        sideEffects: ["network", "external"],
      },
    });
  });

  it("allows read-only governed tools for matching roles", async () => {
    const policy = createToolGovernancePolicy({
      agentId: "researcher",
      roles: ["engineer"],
    });

    const decision = await policy.decide({
      action: "tool.execute",
      metadata: {
        governance: {
          allowedAgents: ["researcher"],
          allowedRoles: ["engineer"],
          sideEffects: ["read"],
        },
      },
    });

    expect(decision.decision).toBe("allow");
  });
});

describe("createWorkspaceMutationPolicy", () => {
  it("denies workspace writes when the run is read-only", async () => {
    const policy = createWorkspaceMutationPolicy({
      allowWorkspaceWrites: false,
    });

    const decision = await policy.decide({
      action: "workspace.write",
      metadata: { path: "README.md" },
    });

    expect(decision).toMatchObject({
      decision: "deny",
      reason: "Workspace writes require an explicit write-enabled run.",
      metadata: { path: "README.md" },
    });
  });

  it("denies write-side-effect tools when the run is read-only", async () => {
    const policy = createWorkspaceMutationPolicy({
      allowWorkspaceWrites: false,
    });

    const decision = await policy.decide({
      action: "tool.execute",
      metadata: {
        toolName: "append_file",
        governance: {
          sideEffects: ["write"],
        },
      },
    });

    expect(decision).toMatchObject({
      decision: "deny",
      reason:
        "Tools with write side effects require an explicit write-enabled run.",
      metadata: {
        toolName: "append_file",
        sideEffects: ["write"],
      },
    });
  });

  it("denies managed workspace write tools when the run is read-only", async () => {
    const policy = createWorkspaceMutationPolicy({
      allowWorkspaceWrites: false,
    });

    const decision = await policy.decide({
      action: "tool.execute",
      metadata: {
        toolName: "apply_patch",
        governance: {
          sideEffects: ["write"],
          origin: {
            kind: "local",
            name: "@sparkwright/coding-tools",
            metadata: { managedWorkspaceWrite: true },
          },
        },
      },
    });

    expect(decision).toMatchObject({
      decision: "deny",
      reason:
        "Tools with write side effects require an explicit write-enabled run.",
      metadata: {
        toolName: "apply_patch",
        sideEffects: ["write"],
      },
    });
  });

  it("allows read-only tools when the run is read-only", async () => {
    const policy = createWorkspaceMutationPolicy({
      allowWorkspaceWrites: false,
    });

    const decision = await policy.decide({
      action: "tool.execute",
      metadata: {
        governance: {
          sideEffects: ["read"],
        },
      },
    });

    expect(decision.decision).toBe("allow");
  });

  it("denies writes outside the allowed target scope", async () => {
    const policy = createWorkspaceMutationPolicy({
      allowWorkspaceWrites: true,
      allowedPaths: ["README.md"],
    });

    const decision = await policy.decide({
      action: "workspace.write",
      metadata: {
        path: "package.json",
        diff: "--- a/package.json\n+++ b/package.json\n@@ -1,1 +1,2 @@\n {}\n+{}\n",
      },
    });

    expect(decision).toMatchObject({
      decision: "deny",
      reason:
        "Workspace write is outside the allowed target scope: package.json",
    });
  });

  it("denies writes that exceed the distinct file budget", async () => {
    const policy = createWorkspaceMutationPolicy({
      allowWorkspaceWrites: true,
      maxWriteFiles: 1,
    });

    expect(
      await policy.decide({
        action: "workspace.write",
        metadata: {
          path: "README.md",
          diff: "--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,2 @@\n # Demo\n+note\n",
        },
      }),
    ).toMatchObject({ decision: "allow" });

    expect(
      await policy.decide({
        action: "workspace.write",
        metadata: {
          path: "package.json",
          diff: "--- a/package.json\n+++ b/package.json\n@@ -1,1 +1,2 @@\n {}\n+{}\n",
        },
      }),
    ).toMatchObject({
      decision: "deny",
      reason: "Workspace write exceeds the run file budget of 1.",
      metadata: {
        guidance: expect.stringContaining(
          "Do not retry another workspace write",
        ),
      },
    });
  });

  it("denies oversized diffs and deletions when configured", async () => {
    const policy = createWorkspaceMutationPolicy({
      allowWorkspaceWrites: true,
      maxDiffLines: 1,
      allowDeletions: false,
    });

    expect(
      await policy.decide({
        action: "workspace.write",
        metadata: {
          path: "README.md",
          diff: "--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,3 @@\n # Demo\n+one\n+two\n",
        },
      }),
    ).toMatchObject({
      decision: "deny",
      reason: "Workspace write exceeds the diff budget of 1 changed lines.",
    });

    const deletionPolicy = createWorkspaceMutationPolicy({
      allowWorkspaceWrites: true,
      maxDiffLines: 10,
      allowDeletions: false,
    });

    expect(
      await deletionPolicy.decide({
        action: "workspace.write",
        metadata: {
          path: "README.md",
          diff: "--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        },
      }),
    ).toMatchObject({
      decision: "deny",
      reason: "Workspace write deletions are not allowed for this run.",
    });
  });
});

describe("createWorkspaceReadScopePolicy", () => {
  it("is a no-op when no confidential paths are configured", async () => {
    const policy = createWorkspaceReadScopePolicy({ confidentialPaths: [] });

    const decision = await policy.decide({
      action: "workspace.read",
      metadata: { path: "docs/private-notes.md" },
    });

    expect(decision.decision).toBe("allow");
  });

  it("denies reads of an exactly listed confidential file", async () => {
    const policy = createWorkspaceReadScopePolicy({
      confidentialPaths: ["docs/private-notes.md"],
    });

    const decision = await policy.decide({
      action: "workspace.read",
      metadata: { path: "docs/private-notes.md" },
    });

    expect(decision).toMatchObject({
      decision: "deny",
      metadata: {
        path: "docs/private-notes.md",
        pattern: "docs/private-notes.md",
      },
    });
  });

  it("allows reads of non-confidential files", async () => {
    const policy = createWorkspaceReadScopePolicy({
      confidentialPaths: ["docs/private-notes.md"],
    });

    const decision = await policy.decide({
      action: "workspace.read",
      metadata: { path: "README.md" },
    });

    expect(decision.decision).toBe("allow");
  });

  it("treats a bare directory as a prefix covering everything beneath it", async () => {
    const policy = createWorkspaceReadScopePolicy({
      confidentialPaths: ["secrets"],
    });

    expect(
      (
        await policy.decide({
          action: "workspace.read",
          metadata: { path: "secrets/key.pem" },
        })
      ).decision,
    ).toBe("deny");
    expect(
      (
        await policy.decide({
          action: "workspace.read",
          metadata: { path: "secrets" },
        })
      ).decision,
    ).toBe("deny");
    expect(
      (
        await policy.decide({
          action: "workspace.read",
          metadata: { path: "secretsXYZ/key.pem" },
        })
      ).decision,
    ).toBe("allow");
  });

  it("supports * and ** glob patterns", async () => {
    const single = createWorkspaceReadScopePolicy({
      confidentialPaths: ["docs/*.env"],
    });
    expect(
      (
        await single.decide({
          action: "workspace.read",
          metadata: { path: "docs/prod.env" },
        })
      ).decision,
    ).toBe("deny");
    // `*` does not cross a path segment.
    expect(
      (
        await single.decide({
          action: "workspace.read",
          metadata: { path: "docs/nested/prod.env" },
        })
      ).decision,
    ).toBe("allow");

    const deep = createWorkspaceReadScopePolicy({
      confidentialPaths: ["**/secret.txt"],
    });
    expect(
      (
        await deep.decide({
          action: "workspace.read",
          metadata: { path: "a/b/secret.txt" },
        })
      ).decision,
    ).toBe("deny");
  });

  it("default confidential patterns cover common secret files", async () => {
    const policy = createWorkspaceReadScopePolicy({
      confidentialPaths: DEFAULT_CONFIDENTIAL_PATHS,
    });

    for (const path of [
      ".env",
      "apps/api/.env.local",
      "config/client_secret.json",
      "tokens/api_token.txt",
      ".ssh/config",
      ".aws/credentials",
    ]) {
      expect(
        await policy.decide({ action: "workspace.read", metadata: { path } }),
      ).toMatchObject({ decision: "deny" });
    }

    expect(
      await policy.decide({
        action: "workspace.read",
        metadata: { path: "README.md" },
      }),
    ).toMatchObject({ decision: "allow" });
  });

  it("ignores non-read actions", async () => {
    const policy = createWorkspaceReadScopePolicy({
      confidentialPaths: ["docs/private-notes.md"],
    });

    const decision = await policy.decide({
      action: "workspace.write",
      metadata: { path: "docs/private-notes.md" },
    });

    expect(decision.decision).toBe("allow");
  });
});

function fixedPolicy(decision: "allow" | "deny" | "requires_approval"): Policy {
  return {
    decide(input) {
      return {
        action: input.action,
        decision,
        reason: `${decision} by test policy.`,
        metadata: input.metadata ?? {},
      };
    },
  };
}
