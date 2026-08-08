import { link, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  computeAssetPackageHash,
  parseSkillManifest,
  type AssetPackageIdentity,
} from "@sparkwright/skills";
import { projectSkillRoot } from "./skill-roots.js";

export interface CreateProjectSkillInput {
  workspaceRoot: string;
  name: string;
  description: string;
  root?: string;
}

export interface CreateProjectSkillResult extends AssetPackageIdentity {
  name: string;
  path: string;
  manifestPath: string;
}

/**
 * Create one deterministic project Skill scaffold without proposal, registry,
 * history, or model-authored mutation state. The target directory is reserved
 * with an exclusive mkdir, so an existing Skill is never overwritten.
 */
export async function createProjectSkill(
  input: CreateProjectSkillInput,
): Promise<CreateProjectSkillResult> {
  const name = input.name.trim();
  const description = input.description.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) {
    throw new Error(
      "Skill name must use lowercase letters, numbers, and hyphens (max 64 chars).",
    );
  }
  if (!description) throw new Error("Skill description is required.");

  const root = projectSkillRoot(input.workspaceRoot);
  if (
    input.root &&
    resolve(input.workspaceRoot, input.root) !== resolve(root)
  ) {
    throw new Error(
      "Skill creation only supports the project root .sparkwright/skills.",
    );
  }

  const content = renderProjectSkillTemplate(name, description);
  const targetDir = join(root, name);
  const manifestPath = join(targetDir, "SKILL.md");
  parseSkillManifest(content, manifestPath);

  await mkdir(root, { recursive: true });
  const stagingDir = await mkdtemp(join(dirname(root), ".skill-create-"));
  const stagedManifestPath = join(stagingDir, "SKILL.md");
  let targetReserved = false;
  let published = false;
  try {
    await writeFile(stagedManifestPath, content, {
      encoding: "utf8",
      flag: "wx",
    });
    const identity = await computeAssetPackageHash({
      rootPath: stagingDir,
      entryPath: "SKILL.md",
    });

    try {
      await mkdir(targetDir);
      targetReserved = true;
      // Staging and target share the same .sparkwright filesystem. link()
      // publishes atomically and fails with EEXIST instead of replacing a
      // concurrently created manifest, closing the final no-overwrite race.
      await link(stagedManifestPath, manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Project Skill already exists: ${targetDir}`);
      }
      throw error;
    }
    published = true;

    return {
      name,
      path: targetDir,
      manifestPath,
      packageHash: identity.packageHash,
      packageHashPolicyVersion: identity.packageHashPolicyVersion,
      fileCount: identity.fileCount,
      totalBytes: identity.totalBytes,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (targetReserved && !published) {
      // Only remove an empty directory reserved by this call. If another
      // process wrote anything into it, leave that data untouched.
      await rmdir(targetDir).catch(() => {});
    }
  }
}

function renderProjectSkillTemplate(name: string, description: string): string {
  const title = name
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${title}`,
    "",
    description,
    "",
  ].join("\n");
}
