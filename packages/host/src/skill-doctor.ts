import type { SkillRoot } from "@sparkwright/skills";
import {
  loadLayeredSkillReport,
  type SkillReportEntry,
} from "./skill-report.js";

export type SkillDoctorSeverity = "info" | "warning" | "blocker";
export type SkillDoctorStatus = "ok" | "ok_with_warnings" | "blocked";

export interface SkillDoctorFinding {
  severity: SkillDoctorSeverity;
  code: string;
  message: string;
  skillName?: string;
  source?: string;
  layer?: SkillRoot["layer"];
}

export interface SkillDoctorEntry {
  name: string;
  layer?: SkillRoot["layer"];
  sourcePath?: string;
  packageHash: string;
  packageHashPolicyVersion: 2;
  shadowedBy?: string;
  shadows?: string[];
}

export interface SkillDoctorReport {
  status: SkillDoctorStatus;
  roots: string[];
  skills: SkillDoctorEntry[];
  findings: SkillDoctorFinding[];
  blockerCount: number;
  warningCount: number;
}

export interface RunSkillDoctorOptions {
  skillRoots: readonly SkillRoot[];
}

export async function runSkillDoctor(
  options: RunSkillDoctorOptions,
): Promise<SkillDoctorReport> {
  const report = await loadLayeredSkillReport(options.skillRoots, {
    includeMissingRoots: "configured",
  });
  const findings: SkillDoctorFinding[] = [];
  const byName = new Map<string, SkillDoctorEntry>();

  for (const skill of report.skills) {
    byName.set(skill.name, doctorEntryForSkill(skill));
  }

  for (const error of report.errors) {
    findings.push({
      severity: "blocker",
      code: error.message.startsWith("Asset package ")
        ? "SKILL_PACKAGE_INVALID"
        : "SKILL_LOAD_FAILED",
      message: error.message,
      source: error.source,
    });
  }

  for (const shadow of report.shadows) {
    const effective = byName.get(shadow.shadowedBy.name);
    if (effective) {
      effective.shadows = sortedUnique([
        ...(effective.shadows ?? []),
        formatSkillOrigin(shadow.shadowed),
      ]);
    }

    const shadowed = byName.get(shadow.shadowed.name);
    if (shadowed) shadowed.shadowedBy = formatSkillOrigin(shadow.shadowedBy);

    findings.push({
      severity: "info",
      code: "SKILL_SHADOWED",
      message: `${formatSkillOrigin(shadow.shadowed)} shadowed by ${formatSkillOrigin(
        shadow.shadowedBy,
      )}`,
      skillName: shadow.name,
      source: shadow.shadowedBy.source,
      layer: shadow.shadowedBy.layer,
    });
  }

  for (const skill of report.skills) {
    if (skill.layer !== "configured") continue;
    findings.push({
      severity: "warning",
      code: "CONFIGURED_SKILL_EFFECTIVE",
      message:
        "Effective Skill comes from a configured root; evolution updates should create a project shadow/fork proposal instead of editing the configured root.",
      skillName: skill.name,
      source: skill.source,
      layer: skill.layer,
    });
  }

  for (const root of options.skillRoots) {
    if (root.layer !== "configured") continue;
    findings.push({
      severity: "info",
      code: "CONFIGURED_ROOT_READ_ONLY",
      message:
        "Configured skill root is treated as a read-only override for managed Skill evolution.",
      source: root.root,
      layer: root.layer,
    });
  }

  const skills = [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const blockerCount = findings.filter(
    (finding) => finding.severity === "blocker",
  ).length;
  const warningCount = findings.filter(
    (finding) => finding.severity === "warning",
  ).length;

  return {
    status:
      blockerCount > 0
        ? "blocked"
        : warningCount > 0
          ? "ok_with_warnings"
          : "ok",
    roots: report.roots,
    skills,
    findings,
    blockerCount,
    warningCount,
  };
}

function doctorEntryForSkill(skill: SkillReportEntry): SkillDoctorEntry {
  const entry: SkillDoctorEntry = {
    name: skill.name,
    packageHash: skill.packageHash,
    packageHashPolicyVersion: skill.packageHashPolicyVersion,
    ...(skill.layer ? { layer: skill.layer } : {}),
    ...(skill.source ? { sourcePath: skill.source } : {}),
  };

  return entry;
}

function formatSkillOrigin(skill: SkillReportEntry): string {
  return `${skill.layer ?? "unknown"}:${skill.source ?? skill.root}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
