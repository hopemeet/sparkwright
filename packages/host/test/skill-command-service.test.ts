import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillCommandService } from "../src/index.js";

describe("SkillCommandService", () => {
  it("prepares, approves, and applies one managed create transaction", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-skill-command-"),
    );
    try {
      const service = new SkillCommandService(workspace);
      const prepared = await service.prepareCreate({
        name: "code-reviewer",
        description: "Review code changes",
      });

      expect(prepared).toMatchObject({
        changed: true,
        existing: false,
        revised: false,
        eligibility: "review_required",
        contentMode: "template",
        proposal: {
          state: "draft",
          preparedState: "ready",
          skillName: "code-reviewer",
        },
      });
      await expect(
        access(join(workspace, ".sparkwright", "skills", "code-reviewer")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const { approval, applied } = await service.approveAndApply(
        prepared.proposal.id,
      );

      expect(approval.effectHash).toBe(prepared.proposal.effectHash);
      expect(applied.proposal).toMatchObject({
        state: "applied",
        preparedState: "applied",
      });
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

  it("deduplicates create preparation across runs in one session", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-skill-command-"),
    );
    try {
      const service = new SkillCommandService(workspace);
      const first = await service.prepareCreate({
        name: "session-skill",
        description: "Initial guidance",
        content:
          "---\nname: session-skill\ndescription: Initial guidance\n---\n\nFirst.\n",
        provenance: { runId: "run_one", sessionId: "session_one" },
      });
      const revised = await service.prepareCreate({
        name: "session-skill",
        description: "Revised guidance",
        content:
          "---\nname: session-skill\ndescription: Revised guidance\n---\n\nSecond.\n",
        provenance: { runId: "run_two", sessionId: "session_one" },
      });

      expect(revised).toMatchObject({
        existing: true,
        revised: true,
        changed: true,
        proposal: {
          id: first.proposal.id,
          revision: 2,
        },
      });
      expect(revised.proposal.effectHash).not.toBe(first.proposal.effectHash);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
