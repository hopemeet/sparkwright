import { describe, expect, it } from "vitest";
import { createHostRunPolicy } from "../src/run-policy.js";

const replacementDiff =
  "--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n";

describe("createHostRunPolicy", () => {
  it("uses the same untargeted write defaults for every Host-shaped runner", async () => {
    const policy = createHostRunPolicy({
      permissionMode: "bypass_permissions",
      shouldWrite: true,
    });

    for (const path of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
      await expect(writeDecision(policy, path)).resolves.toMatchObject({
        decision: "allow",
      });
    }
    await expect(writeDecision(policy, "e.ts")).resolves.toMatchObject({
      decision: "deny",
      reason: "Workspace write exceeds the run file budget of 4.",
    });
  });

  it("keeps mutation state fresh per factory call", async () => {
    const first = createHostRunPolicy({
      permissionMode: "bypass_permissions",
      shouldWrite: true,
      writeGuardrails: { maxFiles: 1 },
    });
    const second = createHostRunPolicy({
      permissionMode: "bypass_permissions",
      shouldWrite: true,
      writeGuardrails: { maxFiles: 1 },
    });

    await expect(writeDecision(first, "first.ts")).resolves.toMatchObject({
      decision: "allow",
    });
    await expect(writeDecision(first, "second.ts")).resolves.toMatchObject({
      decision: "deny",
    });
    await expect(writeDecision(second, "second.ts")).resolves.toMatchObject({
      decision: "allow",
    });
  });

  it("applies explicit target and configured deletion clamps", async () => {
    const policy = createHostRunPolicy({
      permissionMode: "bypass_permissions",
      shouldWrite: true,
      targetPath: "README.md",
      writeGuardrails: { allowDeletions: false },
    });

    await expect(writeDecision(policy, "other.md")).resolves.toMatchObject({
      decision: "deny",
      reason: "Workspace write is outside the allowed target scope: other.md",
    });
    await expect(writeDecision(policy, "README.md")).resolves.toMatchObject({
      decision: "deny",
      reason: "Workspace write deletions are not allowed for this run.",
    });
  });
});

function writeDecision(
  policy: ReturnType<typeof createHostRunPolicy>,
  path: string,
) {
  return policy.decide({
    action: "workspace.write",
    metadata: { path, diff: replacementDiff },
  });
}
