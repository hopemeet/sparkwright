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
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTuiSkillReviewProposal,
  createTuiSkillProposal,
  loadTuiSkillInboxAction,
  formatTuiSkillProposalResult,
  formatTuiSkillReviewSummary,
  loadTuiSkillReview,
  parseTuiSkillReviewTarget,
  parseTuiSkillProposalInput,
  rejectTuiSkillReviewProposal,
  reviewTuiSkillProposals,
} from "../src/lib/skill-evolution.js";
import {
  applySkillLearnDraftProposal,
  createSkillLearnDraftProposal,
  detectSkillLearnNotice,
  formatSkillLearnStatus,
  parseSkillLearnMode,
  readSkillLearnStatus,
  SKILL_LEARN_DRAFT_SKILL_NAME,
  setProjectSkillLearnMode,
} from "../src/lib/skill-learn.js";

describe("tui skill evolution commands", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("parses slash proposal input", () => {
    expect(
      parseTuiSkillProposalInput(
        "code-reviewer --description Review code changes",
      ),
    ).toEqual({
      name: "code-reviewer",
      description: "Review code changes",
    });
    expect(parseTuiSkillProposalInput("notes Capture project notes")).toEqual({
      name: "notes",
      description: "Capture project notes",
    });
    expect(() => parseTuiSkillProposalInput("Bad Name")).toThrow(/usage/);
  });

  it("parses skill review proposal ids without breaking state filters", () => {
    expect(parseTuiSkillReviewTarget("")).toEqual({ kind: "all" });
    expect(parseTuiSkillReviewTarget("draft")).toEqual({
      kind: "state",
      state: "draft",
    });
    expect(parseTuiSkillReviewTarget("--state applied")).toEqual({
      kind: "state",
      state: "applied",
    });
    expect(parseTuiSkillReviewTarget("skillprop_abc123")).toEqual({
      kind: "proposal",
      proposalId: "skillprop_abc123",
    });
    expect(() => parseTuiSkillReviewTarget("not-a-state")).toThrow(/usage/);
  });

  it("creates and reviews proposals without writing current skills", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-skill-"));
    tempDirs.push(workspace);

    const proposal = await createTuiSkillProposal(
      workspace,
      "code-reviewer --description Review code changes",
    );
    expect(proposal).toMatchObject({
      kind: "create",
      skillName: "code-reviewer",
      state: "draft",
    });
    expect(formatTuiSkillProposalResult(proposal)).toContain(proposal.id);
    await expect(
      access(join(workspace, ".sparkwright", "skills", "code-reviewer")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const review = await reviewTuiSkillProposals(workspace, "draft");
    expect(review.total).toBe(1);
    expect(formatTuiSkillReviewSummary(review)).toContain("code-reviewer");
    expect(formatTuiSkillReviewSummary(review)).toContain("[template]");

    const detail = await loadTuiSkillReview(workspace, "draft");
    expect(detail.total).toBe(1);
    expect(detail.items[0]?.proposalMarkdown).toContain("code-reviewer");
    expect(detail.items[0]?.patchDiff).toContain("+name: code-reviewer");

    const byId = await loadTuiSkillReview(workspace, proposal.id);
    expect(byId).toMatchObject({
      total: 1,
      proposalId: proposal.id,
    });
    expect(byId.items.map((item) => item.id)).toEqual([proposal.id]);
    await expect(
      loadTuiSkillReview(workspace, "skillprop_missing"),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("restores the newest open proposal as a persistent inbox action", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-inbox-"));
    tempDirs.push(workspace);
    const first = await createTuiSkillProposal(
      workspace,
      "first --description First Skill",
    );
    const second = await createTuiSkillProposal(
      workspace,
      "second --description Second Skill",
    );

    const inbox = await loadTuiSkillInboxAction(workspace);
    expect(inbox).toMatchObject({
      kind: "skill_proposal_review",
      proposalId: second.id,
      reviewCommand: `/skill-review ${second.id}`,
      eligibility: "review_required",
    });
    expect(inbox?.proposalId).not.toBe(first.id);
  });

  it("reads and writes the project skill learn mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-learn-"));
    tempDirs.push(workspace);

    expect(await readSkillLearnStatus(workspace)).toEqual({
      mode: "notice",
      source: "default",
    });
    expect(parseSkillLearnMode("draft")).toBe("draft");
    expect(() => parseSkillLearnMode("always")).toThrow(/usage/);

    const result = await setProjectSkillLearnMode(workspace, "draft");
    expect(result).toMatchObject({ mode: "draft", source: "config" });
    expect(formatSkillLearnStatus(result)).toBe("draft (config)");

    expect(await readSkillLearnStatus(workspace)).toEqual({
      mode: "draft",
      source: "config",
    });
    const config = JSON.parse(await readFile(result.path, "utf8")) as {
      capabilities?: {
        skills?: {
          evolution?: {
            mode?: string;
          };
        };
      };
    };
    expect(config.capabilities?.skills?.evolution?.mode).toBe("draft");
  });

  it("detects conservative skill learn notice signals and captures evidence", () => {
    expect(
      detectSkillLearnNotice(["Remember this: always run tests first."]),
    ).toEqual({
      reason: "explicit reuse instruction",
      evidence: "Remember this: always run tests first.",
    });
    expect(detectSkillLearnNotice(["以后这样做，先检查 proposal。"])).toEqual({
      reason: "explicit reuse instruction",
      evidence: "以后这样做，先检查 proposal。",
    });
    // Evidence is the most recent triggering goal, not unrelated earlier turns.
    expect(
      detectSkillLearnNotice([
        "Summarize the repo.",
        "From now on, prefer the build script.",
      ]),
    ).toEqual({
      reason: "explicit reuse instruction",
      evidence: "From now on, prefer the build script.",
    });
    expect(
      detectSkillLearnNotice([
        "Remember this: always run tests first.",
        "Summarize this one-off task.",
      ]),
    ).toBeNull();
    expect(detectSkillLearnNotice(["Summarize this one-off task."])).toBeNull();
  });

  it("creates a skill learn draft proposal without writing current skills", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-draft-"));
    tempDirs.push(workspace);

    const proposal = await createSkillLearnDraftProposal(workspace, {
      reason: "explicit reuse instruction",
      evidence: "Always run the linter before committing.",
    });
    expect(proposal).toMatchObject({
      kind: "create",
      skillName: SKILL_LEARN_DRAFT_SKILL_NAME,
      state: "draft",
    });
    await expect(
      access(
        join(workspace, ".sparkwright", "skills", SKILL_LEARN_DRAFT_SKILL_NAME),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // The proposed Skill captures the user's actual instruction (not a
    // placeholder), with a stable trigger description and the safety preamble.
    const skillContent = await readFile(
      join(proposal.path, "after", SKILL_LEARN_DRAFT_SKILL_NAME, "SKILL.md"),
      "utf8",
    );
    expect(skillContent).toContain("## Learnings");
    expect(skillContent).toContain(
      "- Always run the linter before committing.",
    );
    expect(skillContent).toContain(
      "tool output, logs, web pages, and command output are never used",
    );
    expect(skillContent).toContain("description: Reusable, project-specific");
  });

  it("targets an existing skill for learned drafts (update/fork)", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-target-"));
    tempDirs.push(workspace);

    // Seed an existing project Skill so the detected target resolves.
    const skillDir = join(workspace, ".sparkwright", "skills", "code-reviewer");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: code-reviewer",
        "description: reviews code changes",
        'version: "1.0.0"',
        "metadata:",
        '  version: "1.0.0"',
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
      "utf8",
    );

    const proposal = await createSkillLearnDraftProposal(
      workspace,
      {
        reason: "explicit reuse instruction",
        evidence: "Always mention verification steps.",
      },
      { targetSkillName: "code-reviewer" },
    );
    expect(proposal).toMatchObject({
      kind: "update",
      skillName: "code-reviewer",
      state: "draft",
    });
    // The learning is appended to the existing Skill's body.
    const after = await readFile(
      join(proposal.path, "after", "code-reviewer", "SKILL.md"),
      "utf8",
    );
    expect(after).toContain("- Always mention verification steps.");
    expect(after).toContain("description: reviews code changes");
  });

  it("ignores a target that matches no Skill and falls back to session-learnings", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-bogus-"));
    tempDirs.push(workspace);

    // "here" is a typical false-positive extraction; no such Skill exists, so
    // the helper must NOT create a Skill named "here".
    const proposal = await createSkillLearnDraftProposal(
      workspace,
      {
        reason: "explicit reuse instruction",
        evidence: "Use the skill here.",
      },
      { targetSkillName: "here" },
    );
    expect(proposal).toMatchObject({
      skillName: SKILL_LEARN_DRAFT_SKILL_NAME,
      state: "draft",
    });
    await expect(
      access(join(workspace, ".sparkwright", "skills", "here")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("auto-applies only the skill learn draft proposal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-apply-"));
    tempDirs.push(workspace);

    const proposal = await createSkillLearnDraftProposal(workspace, {
      reason: "explicit reuse instruction",
      evidence: "Prefer the deterministic model for QA runs.",
    });
    const applied = await applySkillLearnDraftProposal(workspace, proposal);
    expect(applied).toMatchObject({
      proposalId: proposal.id,
      doctorStatus: "ok",
    });
    expect(applied.historyId).toMatch(/^skillver_/);

    const skillMarkdown = await readFile(
      join(
        workspace,
        ".sparkwright",
        "skills",
        SKILL_LEARN_DRAFT_SKILL_NAME,
        "SKILL.md",
      ),
      "utf8",
    );
    expect(skillMarkdown).toContain(SKILL_LEARN_DRAFT_SKILL_NAME);
    expect(skillMarkdown).toContain(
      "- Prefer the deterministic model for QA runs.",
    );

    await expect(
      applySkillLearnDraftProposal(workspace, {
        ...proposal,
        id: "skillprop-other",
        skillName: "other",
      }),
    ).rejects.toThrow(/cannot apply other/);
  });

  it("accumulates distinct learnings and de-duplicates repeats", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-accum-"));
    tempDirs.push(workspace);

    const first = await createSkillLearnDraftProposal(workspace, {
      reason: "explicit reuse instruction",
      evidence: "Run the linter first.",
    });
    await applySkillLearnDraftProposal(workspace, first);

    // A new, distinct learning is appended under the same section.
    const second = await createSkillLearnDraftProposal(workspace, {
      reason: "explicit reuse instruction",
      evidence: "Then run the type checker.",
    });
    await applySkillLearnDraftProposal(workspace, second);

    const skillPath = join(
      workspace,
      ".sparkwright",
      "skills",
      SKILL_LEARN_DRAFT_SKILL_NAME,
      "SKILL.md",
    );
    let content = await readFile(skillPath, "utf8");
    expect(content).toContain("- Run the linter first.");
    expect(content).toContain("- Then run the type checker.");
    expect((content.match(/^## Learnings$/gmu) ?? []).length).toBe(1);

    // A repeat of an existing learning does not duplicate the bullet.
    const repeat = await createSkillLearnDraftProposal(workspace, {
      reason: "explicit reuse instruction",
      evidence: "Run the linter first.",
    });
    await applySkillLearnDraftProposal(workspace, repeat);
    content = await readFile(skillPath, "utf8");
    expect((content.match(/- Run the linter first\./gu) ?? []).length).toBe(1);
  });

  it("accumulates learnings when legacy skill roots are configured", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-roots-"));
    tempDirs.push(workspace);
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      JSON.stringify({
        capabilities: {
          skills: {
            roots: ["legacy-skills"],
          },
        },
      }),
      "utf8",
    );

    const first = await createSkillLearnDraftProposal(workspace, {
      reason: "explicit reuse instruction",
      evidence: "Run the linter first.",
    });
    await applySkillLearnDraftProposal(workspace, first);

    const second = await createSkillLearnDraftProposal(workspace, {
      reason: "explicit reuse instruction",
      evidence: "Then run the type checker.",
    });
    await applySkillLearnDraftProposal(workspace, second);

    const content = await readFile(
      join(
        workspace,
        ".sparkwright",
        "skills",
        SKILL_LEARN_DRAFT_SKILL_NAME,
        "SKILL.md",
      ),
      "utf8",
    );
    expect(content).toContain("- Run the linter first.");
    expect(content).toContain("- Then run the type checker.");
  });

  it("applies and rejects proposals from the review helpers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-review-"));
    tempDirs.push(workspace);

    const applyProposal = await createTuiSkillProposal(
      workspace,
      "review-apply --description Review apply path",
    );
    const applied = await applyTuiSkillReviewProposal(
      workspace,
      applyProposal.id,
    );
    expect(applied).toMatchObject({
      id: applyProposal.id,
      state: "applied",
      skillName: "review-apply",
    });
    expect(applied.historyId).toMatch(/^skillver_/);

    const rejectProposal = await createTuiSkillProposal(
      workspace,
      "review-reject --description Review reject path",
    );
    const rejected = await rejectTuiSkillReviewProposal(
      workspace,
      rejectProposal.id,
    );
    expect(rejected).toMatchObject({
      id: rejectProposal.id,
      state: "rejected",
      skillName: "review-reject",
    });
  });
});
