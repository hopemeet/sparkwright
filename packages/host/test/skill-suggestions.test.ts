import { describe, expect, it } from "vitest";
import { collectSkillEvidenceSuggestions } from "../src/skill-suggestions.js";

const finding = {
  code: "SKILL_LOAD_FAILURES" as const,
  severity: "warning" as const,
  relation: "observed" as const,
  skillKey: "reviewer|project|package:sha256:v2",
  skillName: "reviewer",
  packageHash: "sha256:v2",
  message: "Skill failed to load.",
  evidence: {
    runIds: ["run_1"],
    sessionIds: ["session_1"],
    metrics: { failures: 1 },
  },
};

describe("Skill evidence suggestions", () => {
  it("dedupes evidence and remains advisory", () => {
    const suggestions = collectSkillEvidenceSuggestions({
      findings: [finding, finding],
      proposals: [],
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      skillName: "reviewer",
      findingCode: "SKILL_LOAD_FAILURES",
      action: expect.stringContaining("explicitly draft"),
    });
    expect(suggestions[0]).not.toHaveProperty("proposalId");
  });

  it("suppresses a suggestion when the Skill already has a live draft", () => {
    expect(
      collectSkillEvidenceSuggestions({
        findings: [finding],
        proposals: [{ skillName: "reviewer", state: "draft" } as never],
      }),
    ).toEqual([]);
  });

  it("does not suggest non-actionable identity or evolution bookkeeping findings", () => {
    expect(
      collectSkillEvidenceSuggestions({
        findings: [{ ...finding, code: "LEGACY_SKILL_IDENTITY" }],
        proposals: [],
      }),
    ).toEqual([]);
  });
});
