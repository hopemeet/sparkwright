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

interface SkillSuggestionState {
  schemaVersion: 1;
  dismissed: Record<string, { dismissedAt: string; expiresAt: string }>;
}

export async function dismissSkillSuggestion(input: {
  workspaceRoot: string;
  suggestionId: string;
  cooldownMs?: number;
}): Promise<void> {
  const state = await readSkillSuggestionState(input.workspaceRoot);
  const dismissedAt = new Date();
  state.dismissed[input.suggestionId] = {
    dismissedAt: dismissedAt.toISOString(),
    expiresAt: new Date(
      dismissedAt.getTime() + (input.cooldownMs ?? 7 * 24 * 60 * 60 * 1000),
    ).toISOString(),
  };
  await atomicWriteText(
    skillSuggestionStatePath(input.workspaceRoot),
    `${JSON.stringify(state, null, 2)}\n`,
    { durable: true },
  );
}

export async function activeDismissedSkillSuggestionIds(
  workspaceRoot: string,
  now = new Date(),
): Promise<Set<string>> {
  const state = await readSkillSuggestionState(workspaceRoot);
  return new Set(
    Object.entries(state.dismissed)
      .filter(([, value]) => Date.parse(value.expiresAt) > now.getTime())
      .map(([id]) => id),
  );
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
  suppressedSuggestionIds?: ReadonlySet<string>;
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
    const key = `${finding.skillName}|${finding.code}|${finding.packageHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const suggestionId = `suggestion:${key}`;
    if (input.suppressedSuggestionIds?.has(suggestionId)) continue;
    suggestions.push({
      id: suggestionId,
      skillName: finding.skillName,
      severity: finding.severity,
      relation: finding.relation,
      findingCode: finding.code,
      message: finding.message,
      evidence: finding.evidence,
      action:
        finding.code === "SKILL_LOAD_FAILURES"
          ? "Inspect the evidence and package-aligned history; consider rollback when the failures began with this package, otherwise explicitly draft a Skill update."
          : "Inspect the associated failures; correlation alone must not create or apply a Skill change.",
    });
  }
  return suggestions.sort(
    (left, right) =>
      left.skillName.localeCompare(right.skillName) ||
      left.findingCode.localeCompare(right.findingCode),
  );
}

function skillSuggestionStatePath(workspaceRoot: string): string {
  return join(
    workspaceRoot,
    ".sparkwright",
    "skill-suggestions",
    "v1",
    "state.json",
  );
}

async function readSkillSuggestionState(
  workspaceRoot: string,
): Promise<SkillSuggestionState> {
  const raw = await readFile(
    skillSuggestionStatePath(workspaceRoot),
    "utf8",
  ).catch(() => undefined);
  if (!raw) return { schemaVersion: 1, dismissed: {} };
  const parsed = JSON.parse(raw) as SkillSuggestionState;
  if (parsed.schemaVersion !== 1 || typeof parsed.dismissed !== "object") {
    throw new Error("Invalid Skill suggestion state.");
  }
  return parsed;
}
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "@sparkwright/agent-runtime";
