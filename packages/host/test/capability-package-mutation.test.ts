import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileCapabilityPackageWriter } from "../src/capability-package-mutation.js";

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sparkwright-host-pkg-mut-"));
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

describe("capability package mutation", () => {
  it("rejects mutation targets outside the workspace", async () => {
    const workspace = await makeWorkspace();
    const writer = createFileCapabilityPackageWriter(workspace);
    try {
      await expect(writer.writeText("../outside.txt", "x")).rejects.toThrow(
        /escapes workspace/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("copies skill packages with assets and removes stale target files", async () => {
    const workspace = await makeWorkspace();
    const mutations: unknown[] = [];
    const writer = createFileCapabilityPackageWriter(workspace, {
      reportCapabilityMutationCompleted(payload) {
        mutations.push(payload);
      },
    });
    try {
      const source = join(workspace, "source-skill");
      const target = join(workspace, "target-skill");
      await mkdir(join(source, "references"), { recursive: true });
      await mkdir(target, { recursive: true });
      await writeFile(join(source, "SKILL.md"), skillMarkdown("source-skill"));
      await writeFile(join(source, "references", "guide.md"), "guide\n");
      await writeFile(join(target, "stale.txt"), "stale\n");

      const result = await writer.replaceWithSkillPackage(source, target);

      expect(result).toMatchObject({
        action: "replace_skill_package",
        path: target,
      });
      expect(result.files?.map((file) => file.relativePath)).toEqual([
        "SKILL.md",
        "references/guide.md",
      ]);
      expect(mutations).toContainEqual(
        expect.objectContaining({
          action: "replace_skill_package",
          path: target,
          sourcePath: source,
          fileCount: 2,
          files: expect.arrayContaining([
            expect.objectContaining({ relativePath: "SKILL.md" }),
            expect.objectContaining({ relativePath: "references/guide.md" }),
          ]),
        }),
      );
      await expect(
        readFile(join(target, "references", "guide.md"), "utf8"),
      ).resolves.toBe("guide\n");
      await expect(readFile(join(target, "stale.txt"), "utf8")).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
