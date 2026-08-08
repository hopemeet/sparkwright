import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectSkill } from "../src/index.js";

describe("createProjectSkill", () => {
  it("creates one deterministic project Skill without managed-change state", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-skill-create-"),
    );
    try {
      const result = await createProjectSkill({
        workspaceRoot: workspace,
        name: "code-reviewer",
        description: "Review code changes safely.",
      });

      expect(result).toMatchObject({
        name: "code-reviewer",
        packageHashPolicyVersion: 2,
        fileCount: 1,
      });
      await expect(readFile(result.manifestPath, "utf8")).resolves.toContain(
        "name: code-reviewer",
      );
      await expect(
        access(join(workspace, ".sparkwright", "skill-evolution")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(workspace, ".sparkwright", "skill-registry")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("never overwrites an existing Skill directory", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-skill-create-"),
    );
    const target = join(workspace, ".sparkwright", "skills", "code-reviewer");
    const existing = join(target, "existing.txt");
    try {
      await mkdir(target, { recursive: true });
      await writeFile(existing, "keep me", "utf8");

      await expect(
        createProjectSkill({
          workspaceRoot: workspace,
          name: "code-reviewer",
          description: "Review code changes safely.",
        }),
      ).rejects.toThrow(/Project Skill already exists/u);
      await expect(readFile(existing, "utf8")).resolves.toBe("keep me");
      await expect(access(join(target, "SKILL.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("publishes only one manifest when duplicate creates race", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-skill-create-"),
    );
    try {
      const input = {
        workspaceRoot: workspace,
        name: "code-reviewer",
        description: "Review code changes safely.",
      };
      const outcomes = await Promise.allSettled([
        createProjectSkill(input),
        createProjectSkill(input),
      ]);

      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.status === "rejected"),
      ).toHaveLength(1);
      await expect(
        readFile(
          join(
            workspace,
            ".sparkwright",
            "skills",
            "code-reviewer",
            "SKILL.md",
          ),
          "utf8",
        ),
      ).resolves.toContain("name: code-reviewer");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects roots outside the project Skill directory", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-skill-create-"),
    );
    try {
      await expect(
        createProjectSkill({
          workspaceRoot: workspace,
          name: "code-reviewer",
          description: "Review code changes safely.",
          root: "external-skills",
        }),
      ).rejects.toThrow(/only supports the project root/u);
      await expect(
        access(join(workspace, "external-skills")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
