import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  importSkill,
  readSkillOrigin,
  readSkillRegistry,
  reconcileSkill,
  scanSkillReconciliation,
} from "../src/skill-registry.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sparkwright-skill-registry-"));
}

async function writeSkill(
  root: string,
  name: string,
  text = "# Skill\n",
): Promise<void> {
  const path = join(root, ".sparkwright", "skills", name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), text);
}

describe("Skill registry reconciliation", () => {
  it("scans read-only and records adopt separately from managed mutation receipts", async () => {
    const root = await workspace();
    await writeSkill(root, "reviewer");
    await expect(scanSkillReconciliation(root)).resolves.toMatchObject([
      { kind: "unregistered", skillName: "reviewer" },
    ]);
    const receipt = await reconcileSkill({
      workspaceRoot: root,
      kind: "adopt",
      skillName: "reviewer",
    });
    expect(receipt).toMatchObject({
      kind: "adopt",
      currentPath: "reviewer",
      packageHashPolicyVersion: 2,
    });
    expect(receipt).not.toHaveProperty("effectHash");
    expect(receipt).not.toHaveProperty("approval");
    await expect(scanSkillReconciliation(root)).resolves.toEqual([]);
    expect((await readSkillRegistry(root)).artifacts).toHaveLength(1);
  });

  it("keeps copy and reidentify as explicit new identity decisions", async () => {
    const root = await workspace();
    await writeSkill(root, "source");
    const source = await reconcileSkill({
      workspaceRoot: root,
      kind: "adopt",
      skillName: "source",
    });
    await writeSkill(root, "copy");
    const copied = await reconcileSkill({
      workspaceRoot: root,
      kind: "copy",
      skillName: "copy",
      sourceArtifactId: source.artifactId,
    });
    expect(copied.artifactId).not.toBe(source.artifactId);
    expect(copied.derivedFrom).toBe(source.artifactId);
    await writeFile(
      join(root, ".sparkwright", "skills", "source", "SKILL.md"),
      "# Replacement\n",
    );
    const replacement = await reconcileSkill({
      workspaceRoot: root,
      kind: "reidentify",
      skillName: "source",
      artifactId: source.artifactId,
    });
    expect(replacement.artifactId).not.toBe(source.artifactId);
    expect(
      (await readSkillRegistry(root)).artifacts.find(
        (entry) => entry.artifactId === source.artifactId,
      ),
    ).toMatchObject({ status: "orphaned" });
  });

  it("records missing assets as read-only findings before an explicit orphan", async () => {
    const root = await workspace();
    await writeSkill(root, "reviewer");
    const adopted = await reconcileSkill({
      workspaceRoot: root,
      kind: "adopt",
      skillName: "reviewer",
    });
    await writeFile(
      join(root, ".sparkwright", "skills", "reviewer", "SKILL.md"),
      "# Drift\n",
    );
    await expect(scanSkillReconciliation(root)).resolves.toMatchObject([
      { kind: "drift", artifactId: adopted.artifactId },
    ]);
    const orphan = await reconcileSkill({
      workspaceRoot: root,
      kind: "orphan",
      artifactId: adopted.artifactId,
    });
    expect(orphan).toMatchObject({ kind: "orphan", previousPath: "reviewer" });
    const receiptText = await readFile(
      join(
        root,
        ".sparkwright",
        "skill-registry",
        "v1",
        "reconciliation",
        `${orphan.receiptId}.json`,
      ),
      "utf8",
    );
    expect(receiptText).toContain('"kind": "orphan"');
  });

  it("rejects duplicate active-path ownership and preserves concurrent updates", async () => {
    const root = await workspace();
    await writeSkill(root, "one");
    await writeSkill(root, "two");
    await reconcileSkill({
      workspaceRoot: root,
      kind: "adopt",
      skillName: "one",
    });
    await expect(
      reconcileSkill({ workspaceRoot: root, kind: "adopt", skillName: "one" }),
    ).rejects.toThrow(/already owned/);

    await Promise.all([
      reconcileSkill({ workspaceRoot: root, kind: "adopt", skillName: "two" }),
      (async () => {
        await writeSkill(root, "three");
        return reconcileSkill({
          workspaceRoot: root,
          kind: "adopt",
          skillName: "three",
        });
      })(),
    ]);
    const registry = await readSkillRegistry(root);
    expect(registry.revision).toBe(3);
    expect(registry.artifacts.map((entry) => entry.activePath).sort()).toEqual([
      "one",
      "three",
      "two",
    ]);
  });

  it("imports a validated package with an external origin record", async () => {
    const root = await workspace();
    const sourceRoot = await workspace();
    const source = join(sourceRoot, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# Imported\n");
    await writeFile(join(source, "extra.txt"), "included\n");
    const imported = await importSkill({
      workspaceRoot: root,
      skillName: "imported",
      sourcePath: source,
      updatePolicy: "notify",
    });
    await expect(
      readFile(
        join(root, ".sparkwright", "skills", "imported", "extra.txt"),
        "utf8",
      ),
    ).resolves.toBe("included\n");
    await expect(
      readSkillOrigin(root, imported.receipt.artifactId),
    ).resolves.toMatchObject({ updatePolicy: "notify", kind: "local-path" });
  });

  it("recovers registry, receipt, and origin from one pending transaction", async () => {
    const root = await workspace();
    await writeSkill(root, "imported");
    await writeSkill(root, "next");
    const artifactId = "skill_pending_import";
    const receiptId = "skillrecon_pending_import";
    const now = new Date().toISOString();
    const transactionDir = join(root, ".sparkwright", "skill-registry", "v1");
    await mkdir(transactionDir, { recursive: true });
    await writeFile(
      join(transactionDir, "reconciliation.pending.json"),
      `${JSON.stringify(
        {
          registry: {
            schemaVersion: 1,
            revision: 1,
            artifacts: [
              {
                artifactId,
                activePath: "imported",
                packageHash: "sha256:pending",
                packageHashPolicyVersion: 2,
                status: "active",
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
          receipt: {
            schemaVersion: 1,
            receiptId,
            kind: "adopt",
            artifactId,
            observedPackageHash: "sha256:pending",
            packageHashPolicyVersion: 2,
            currentPath: "imported",
            reconciledAt: now,
          },
          origin: {
            schemaVersion: 1,
            artifactId,
            kind: "local-path",
            locator: { redacted: "source" },
            importedAt: now,
            importedPackageHash: "sha256:pending",
            packageHashPolicyVersion: 2,
            updatePolicy: "frozen",
          },
        },
        null,
        2,
      )}\n`,
    );
    await reconcileSkill({
      workspaceRoot: root,
      kind: "adopt",
      skillName: "next",
    });
    await expect(readSkillOrigin(root, artifactId)).resolves.toMatchObject({
      importedPackageHash: "sha256:pending",
    });
    await expect(
      readFile(
        join(transactionDir, "reconciliation", `${receiptId}.json`),
        "utf8",
      ),
    ).resolves.toContain(receiptId);
  });
});
