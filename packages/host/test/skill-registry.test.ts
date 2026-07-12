import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
});
