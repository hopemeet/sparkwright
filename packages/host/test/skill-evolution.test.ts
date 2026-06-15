import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeSkillPackageHash } from "@sparkwright/skills";
import {
  applySkillProposal,
  createSkillCreateProposal,
  createSkillUpdateProposal,
  loadLayeredSkillReport,
  resolveSkillRootsForRuntime,
} from "../src/index.js";

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sparkwright-host-skill-"));
}

function skillMarkdown(name: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} description`,
    "---",
    "",
    "Body.",
    "",
  ].join("\n");
}

describe("skill roots", () => {
  it("keeps the project skill root when legacy roots are configured", async () => {
    const workspace = await makeWorkspace();
    try {
      const roots = resolveSkillRootsForRuntime(workspace, ["legacy-skills"], {
        XDG_CONFIG_HOME: join(workspace, "xdg"),
      });

      expect(roots.map((root) => root.layer)).toEqual([
        "builtin",
        "user",
        "project",
        "legacy",
      ]);
      expect(roots.find((root) => root.layer === "project")?.root).toBe(
        join(workspace, ".sparkwright", "skills"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("skill proposal application", () => {
  it("applies update proposals with full package assets and history", async () => {
    const workspace = await makeWorkspace();
    try {
      const sourceRoot = join(workspace, "user-skills");
      const sourceSkill = join(sourceRoot, "asset-skill");
      await mkdir(join(sourceSkill, "references"), { recursive: true });
      await writeFile(join(sourceSkill, "SKILL.md"), skillMarkdown("asset-skill"));
      await writeFile(join(sourceSkill, "references", "guide.md"), "guide\n");

      const proposal = await createSkillUpdateProposal({
        workspaceRoot: workspace,
        skillRoots: [{ root: sourceRoot, layer: "user" }],
        name: "asset-skill",
        description: "Record asset handling guidance",
        applyEdit(content) {
          return content.replace("Body.", "Updated body.");
        },
      });

      await expect(
        readFile(
          join(proposal.path, "after", "asset-skill", "references", "guide.md"),
          "utf8",
        ),
      ).resolves.toBe("guide\n");

      const applied = await applySkillProposal(workspace, proposal.id);

      await expect(
        readFile(
          join(
            workspace,
            ".sparkwright",
            "skills",
            "asset-skill",
            "SKILL.md",
          ),
          "utf8",
        ),
      ).resolves.toContain("Updated body.");
      await expect(
        readFile(
          join(
            workspace,
            ".sparkwright",
            "skills",
            "asset-skill",
            "references",
            "guide.md",
          ),
          "utf8",
        ),
      ).resolves.toBe("guide\n");
      await expect(
        readFile(
          join(
            applied.history.path,
            "after",
            "asset-skill",
            "references",
            "guide.md",
          ),
          "utf8",
        ),
      ).resolves.toBe("guide\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects proposals whose metadata target path was tampered", async () => {
    const workspace = await makeWorkspace();
    try {
      const proposal = await createSkillCreateProposal({
        workspaceRoot: workspace,
        name: "safe-skill",
        description: "Safe skill",
      });
      const metadataPath = join(proposal.path, "metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
        targetPath: string;
      };
      metadata.targetPath = join(workspace, "outside-target");
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

      await expect(applySkillProposal(workspace, proposal.id)).rejects.toThrow(
        /target path mismatch/,
      );
      await expect(
        readFile(join(workspace, "outside-target", "SKILL.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects proposals whose SKILL.md name does not match metadata", async () => {
    const workspace = await makeWorkspace();
    try {
      const proposal = await createSkillCreateProposal({
        workspaceRoot: workspace,
        name: "safe-skill",
        description: "Safe skill",
      });
      const afterDir = join(proposal.path, "after", "safe-skill");
      await writeFile(join(afterDir, "SKILL.md"), skillMarkdown("other-skill"));
      const hash = await computeSkillPackageHash(afterDir);
      const metadataPath = join(proposal.path, "metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
        afterPackageHash: string;
      };
      metadata.afterPackageHash = hash.packageHash;
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

      await expect(applySkillProposal(workspace, proposal.id)).rejects.toThrow(
        /content name mismatch/,
      );
      await expect(
        readFile(
          join(workspace, ".sparkwright", "skills", "safe-skill", "SKILL.md"),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports only package-style SKILL.md files used by runtime", async () => {
    const workspace = await makeWorkspace();
    try {
      const root = join(workspace, "skills");
      await mkdir(join(root, "one"), { recursive: true });
      await mkdir(join(root, "nested", "deep"), { recursive: true });
      await mkdir(join(root, "bad"), { recursive: true });
      await writeFile(join(root, "one", "SKILL.md"), skillMarkdown("one"));
      await writeFile(
        join(root, "nested", "deep", "SKILL.md"),
        skillMarkdown("deep"),
      );
      await writeFile(join(root, "bad", "SKILL.md"), "not frontmatter");
      await writeFile(
        join(root, "flat.skill.json"),
        JSON.stringify({
          name: "flat",
          description: "Flat manifest",
          instructions: "Flat instructions",
        }),
      );
      await writeFile(join(root, "broken.skill.md"), "not frontmatter");

      const report = await loadLayeredSkillReport(
        [{ root, layer: "project" }],
        { includeMissingRoots: false },
      );

      expect(report.skills.map((skill) => skill.name)).toEqual([
        "deep",
        "one",
      ]);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]?.source).toBe(join(root, "bad", "SKILL.md"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
