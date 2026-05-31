import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { InMemorySkillUsageRecorder } from "@sparkwright/skills";
import {
  applyAutomaticTransitions,
  archiveSkillDirectory,
  CURATOR_DRY_RUN_BANNER,
  isBackgroundReview,
  markIfBackgroundReview,
  parseCuratorReport,
  renderCuratorPrompt,
  restoreArchivedSkill,
  runBackgroundReview,
} from "../src/index.js";

describe("applyAutomaticTransitions", () => {
  it("moves untouched agent-created skills active → stale → archived", () => {
    const r = new InMemorySkillUsageRecorder();
    const now = new Date("2026-06-01T00:00:00Z");
    const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
    const midOld = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
    r.recordUse("dead", old);
    r.markAgentCreated("dead");
    r.recordUse("aging", midOld);
    r.markAgentCreated("aging");
    r.recordUse("fresh", now);
    r.markAgentCreated("fresh");

    const result = applyAutomaticTransitions(r, { now });
    expect(result.archived).toBe(1);
    expect(result.markedStale).toBe(1);
    expect(r.get("dead")?.state).toBe("archived");
    expect(r.get("aging")?.state).toBe("stale");
    expect(r.get("fresh")?.state).toBe("active");
  });

  it("reactivates a stale skill that got recent use", () => {
    const r = new InMemorySkillUsageRecorder();
    const now = new Date("2026-06-01T00:00:00Z");
    r.recordUse("revived", now);
    r.markAgentCreated("revived");
    r.setState("revived", "stale");
    const result = applyAutomaticTransitions(r, { now });
    expect(result.reactivated).toBe(1);
    expect(r.get("revived")?.state).toBe("active");
  });

  it("skips pinned skills", () => {
    const r = new InMemorySkillUsageRecorder();
    const now = new Date("2026-06-01T00:00:00Z");
    const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
    r.recordUse("important", old);
    r.markAgentCreated("important");
    r.setPinned("important", true);
    const result = applyAutomaticTransitions(r, { now });
    expect(result.archived).toBe(0);
    expect(r.get("important")?.state).toBe("active");
  });

  it("skips non-agent-created skills by default", () => {
    const r = new InMemorySkillUsageRecorder();
    const now = new Date("2026-06-01T00:00:00Z");
    const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
    r.recordUse("user-skill", old);
    const result = applyAutomaticTransitions(r, { now });
    expect(result.archived).toBe(0);
    expect(r.get("user-skill")?.state).toBe("active");
  });
});

describe("runBackgroundReview / markIfBackgroundReview", () => {
  it("isBackgroundReview reflects scope", async () => {
    expect(isBackgroundReview()).toBe(false);
    await runBackgroundReview(async () => {
      expect(isBackgroundReview()).toBe(true);
    });
    expect(isBackgroundReview()).toBe(false);
  });

  it("marks agent-created only inside a review scope", async () => {
    const r = new InMemorySkillUsageRecorder();
    r.recordUse("foreground-skill");
    expect(markIfBackgroundReview(r, "foreground-skill")).toBe(false);
    expect(r.get("foreground-skill")?.agentCreated).toBe(false);

    await runBackgroundReview(
      async () => {
        r.recordUse("review-skill");
        expect(markIfBackgroundReview(r, "review-skill")).toBe(true);
      },
      { sessionId: "rev-1" },
    );
    expect(r.get("review-skill")?.agentCreated).toBe(true);
    expect(r.get("review-skill")?.metadata?.origin).toBe("background_review");
  });
});

describe("renderCuratorPrompt", () => {
  it("includes the dry-run banner when requested", () => {
    const prompt = renderCuratorPrompt({ candidates: [], dryRun: true });
    expect(prompt.startsWith(CURATOR_DRY_RUN_BANNER)).toBe(true);
  });

  it("renders candidate rows", () => {
    const r = new InMemorySkillUsageRecorder();
    r.recordUse("a", new Date("2026-01-01T00:00:00Z"));
    r.markAgentCreated("a");
    const prompt = renderCuratorPrompt({ candidates: r.list() });
    expect(prompt).toContain("| 1 |");
    expect(prompt).toContain("a |");
  });

  it("emits a placeholder when no candidates", () => {
    expect(renderCuratorPrompt({ candidates: [] })).toContain(
      "(no agent-created skills tracked)",
    );
  });
});

describe("parseCuratorReport", () => {
  it("parses a well-formed structured block", () => {
    const text = `
Some human prose first.

\`\`\`yaml
consolidations:
  - from: old-a
    into: umbrella-x
    reason: "shared workflow"
  - from: old-b
    into: umbrella-x
    reason: overlapping triggers
prunings:
  - name: stale-z
    reason: obsolete config
\`\`\`
`;
    const r = parseCuratorReport(text);
    expect(r.errors).toEqual([]);
    expect(r.consolidations).toHaveLength(2);
    expect(r.consolidations[0]).toEqual({
      from: "old-a",
      into: "umbrella-x",
      reason: "shared workflow",
    });
    expect(r.prunings).toEqual([
      { name: "stale-z", reason: "obsolete config" },
    ]);
  });

  it("reports missing block as an error", () => {
    const r = parseCuratorReport("no yaml here");
    expect(r.errors[0]).toContain("not found");
  });

  it("flags malformed entries", () => {
    const text = "```yaml\nconsolidations:\n  - from: only-from\n```";
    const r = parseCuratorReport(text);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("handles empty lists", () => {
    const text = "```yaml\nconsolidations: []\nprunings: []\n```";
    const r = parseCuratorReport(text);
    expect(r.errors).toEqual([]);
    expect(r.consolidations).toEqual([]);
    expect(r.prunings).toEqual([]);
  });
});

describe("archiveSkillDirectory / restoreArchivedSkill", () => {
  it("archives only agent-created skills and restores them", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-curator-"));
    const skillDir = join(root, "old-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: old-skill\n---\n");

    const usage = new InMemorySkillUsageRecorder();
    usage.recordUse("old-skill", new Date("2026-01-01T00:00:00Z"));
    usage.markAgentCreated("old-skill");

    const archived = await archiveSkillDirectory("old-skill", {
      skillPath: skillDir,
      usage,
      now: new Date("2026-02-01T00:00:00Z"),
    });
    expect(usage.get("old-skill")?.state).toBe("archived");
    expect((await stat(archived.to)).isDirectory()).toBe(true);

    const restored = await restoreArchivedSkill("old-skill", {
      archivedPath: archived.to,
      restoreRoot: root,
      usage,
    });
    expect(restored.to).toBe(skillDir);
    expect(usage.get("old-skill")?.state).toBe("active");
  });

  it("refuses to archive pinned skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-curator-"));
    const skillDir = join(root, "pinned");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: pinned\n---\n");
    const usage = new InMemorySkillUsageRecorder();
    usage.recordUse("pinned");
    usage.markAgentCreated("pinned");
    usage.setPinned("pinned", true);

    await expect(
      archiveSkillDirectory("pinned", { skillPath: skillDir, usage }),
    ).rejects.toThrow("pinned");
  });
});
