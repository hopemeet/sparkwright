import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { SkillRoot } from "@sparkwright/skills";
import { resolveCapabilityDirs } from "./layers.js";

/**
 * Skill roots prepared in weak-to-strong order. Explicitly configured roots
 * stay strongest so workspace overrides remain deterministic.
 */
export function resolveSkillRootsForRuntime(
  workspaceRoot: string,
  configuredRoots: readonly string[] | undefined,
  env: Record<string, string | undefined> = process.env,
): SkillRoot[] {
  const layered = resolveCapabilityDirs("skills", {
    cwd: workspaceRoot,
    env,
  }).map((dir) => ({ root: dir.dir, layer: dir.layer }));

  if (!configuredRoots || configuredRoots.length === 0) return layered;

  return [
    ...layered,
    ...configuredRoots.map((root) => ({
      root,
      layer: "configured" as const,
    })),
  ];
}

export function projectSkillRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "skills");
}

export function skillRootPaths(roots: readonly SkillRoot[]): string[] {
  return roots.map((root) => root.root);
}

export async function existingSkillRoots(
  roots: readonly SkillRoot[],
): Promise<SkillRoot[]> {
  const out: SkillRoot[] = [];
  for (const root of roots) {
    try {
      const info = await stat(root.root);
      if (info.isDirectory() || info.isFile()) out.push(root);
    } catch {
      // Missing optional layers are normal; explicit validation surfaces them.
    }
  }
  return out;
}
