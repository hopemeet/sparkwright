import { stat } from "node:fs/promises";
import {
  loadSkillsFromDirectory,
  type SkillLoadError,
  type SkillManifest,
  type SkillRoot,
} from "@sparkwright/skills";

export interface SkillReportEntry {
  name: string;
  description: string;
  version?: string;
  source?: string;
  layer?: SkillRoot["layer"];
  root: string;
}

export interface SkillShadowDiagnostic {
  name: string;
  shadowed: SkillReportEntry;
  shadowedBy: SkillReportEntry;
}

export interface SkillReport {
  roots: string[];
  skills: SkillReportEntry[];
  shadows: SkillShadowDiagnostic[];
  errors: SkillLoadError[];
}

export async function loadLayeredSkillReport(
  roots: readonly SkillRoot[],
  options: { includeMissingRoots: boolean | "configured" },
): Promise<SkillReport> {
  const errors: SkillLoadError[] = [];
  const shadows: SkillShadowDiagnostic[] = [];
  const byName = new Map<string, SkillReportEntry>();

  for (const root of roots) {
    try {
      const info = await stat(root.root);
      if (!info.isDirectory()) {
        errors.push({
          source: root.root,
          message: "skill root is not a directory",
        });
        continue;
      }
    } catch (error) {
      if (shouldReportMissingRoot(root, options.includeMissingRoots)) {
        errors.push({
          source: root.root,
          message:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "skill root does not exist"
              : error instanceof Error
                ? error.message
                : String(error),
        });
      }
      continue;
    }

    const loaded = await loadSkillsFromDirectory(root.root);
    errors.push(...loaded.loadErrors);
    for (const skill of loaded.skills) {
      const entry = toReportEntry(skill, root);
      const existing = byName.get(entry.name);
      if (existing) {
        shadows.push({
          name: entry.name,
          shadowed: existing,
          shadowedBy: entry,
        });
      }
      byName.set(entry.name, entry);
    }
  }

  return {
    roots: roots.map((root) => root.root),
    skills: [...byName.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    shadows,
    errors,
  };
}

function shouldReportMissingRoot(
  root: SkillRoot,
  includeMissingRoots: boolean | "configured",
): boolean {
  if (includeMissingRoots === true) return true;
  if (includeMissingRoots === false) return false;
  return root.layer === "legacy";
}

function toReportEntry(
  skill: SkillManifest,
  root: SkillRoot,
): SkillReportEntry {
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    source: skill.source,
    layer: root.layer,
    root: root.root,
  };
}
