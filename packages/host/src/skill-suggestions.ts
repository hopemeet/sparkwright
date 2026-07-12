import type { SkillProposalSummary } from "./skill-evolution.js";
import type { SkillStatsFinding } from "./skill-stats.js";

export interface SkillEvidenceSuggestion {
  id: string;
  skillName: string;
  severity: "info" | "warning";
  relation: SkillStatsFinding["relation"];
  findingCode: SkillStatsFinding["code"];
  message: string;
  evidence: SkillStatsFinding["evidence"];
  /** Suggestions are advisory: they never create or apply a mutation. */
  action: string;
}

const SUGGESTIBLE_CODES = new Set<SkillStatsFinding["code"]>([
  "SKILL_LOAD_FAILURES",
  "ASSOCIATED_TOOL_FAILURES",
]);

/**
 * Turns trace-derived findings into a bounded human review queue. The output is
 * deterministic and intentionally has no write side effect: a user still
 * authors/reviews a normal Skill prepared change through existing controls.
 */
export function collectSkillEvidenceSuggestions(input: {
  findings: readonly SkillStatsFinding[];
  proposals: readonly SkillProposalSummary[];
}): SkillEvidenceSuggestion[] {
  const activeProposalSkills = new Set(
    input.proposals
      .filter((proposal) => proposal.state === "draft")
      .map((proposal) => proposal.skillName),
  );
  const seen = new Set<string>();
  const suggestions: SkillEvidenceSuggestion[] = [];
  for (const finding of input.findings) {
    if (!SUGGESTIBLE_CODES.has(finding.code)) continue;
    if (activeProposalSkills.has(finding.skillName)) continue;
    const key = `${finding.skillName}|${finding.code}|${finding.packageHash ?? "legacy"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      id: `suggestion:${key}`,
      skillName: finding.skillName,
      severity: finding.severity,
      relation: finding.relation,
      findingCode: finding.code,
      message: finding.message,
      evidence: finding.evidence,
      action:
        finding.code === "SKILL_LOAD_FAILURES"
          ? "Inspect the evidence, then explicitly draft a Skill update if the failure is reproducible."
          : "Inspect the associated failures; correlation alone must not create or apply a Skill change.",
    });
  }
  return suggestions.sort(
    (left, right) =>
      left.skillName.localeCompare(right.skillName) ||
      left.findingCode.localeCompare(right.findingCode),
  );
}
