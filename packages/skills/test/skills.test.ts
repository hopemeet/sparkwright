import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSkillsFromDirectory,
  matchSkills,
  parseSkillManifest,
  skillsToCapabilities,
  SkillRegistry,
  type SkillManifest,
} from "../src/index.js";

const sample = (overrides: Partial<SkillManifest> = {}): SkillManifest => ({
  name: "code-reviewer",
  description: "Reviews source code changes for risk and test coverage.",
  instructions: "Read the diff and summarize risk.",
  triggers: ["review", "diff", "risk"],
  ...overrides,
});

describe("parseSkillManifest", () => {
  it("parses a JSON manifest", () => {
    const json = JSON.stringify({
      name: "json-skill",
      description: "A skill from JSON.",
      instructions: "Do the thing.",
      triggers: ["thing"],
      version: "1.0.0",
    });
    const manifest = parseSkillManifest(json, "/tmp/json-skill.skill.json");
    expect(manifest.name).toBe("json-skill");
    expect(manifest.triggers).toEqual(["thing"]);
    expect(manifest.source).toBe("/tmp/json-skill.skill.json");
  });

  it("parses a markdown frontmatter manifest", () => {
    const md = `---
name: fm-skill
description: A skill from frontmatter.
triggers: review, diff
version: 0.2.1
---
Step 1: read the diff.
Step 2: summarize risk.
`;
    const manifest = parseSkillManifest(md, "/skills/fm/SKILL.md");
    expect(manifest.name).toBe("fm-skill");
    expect(manifest.triggers).toEqual(["review", "diff"]);
    expect(manifest.instructions).toContain("read the diff");
    expect(manifest.version).toBe("0.2.1");
  });

  it("rejects manifests missing required fields", () => {
    expect(() =>
      parseSkillManifest(JSON.stringify({ name: "x", description: "y" })),
    ).toThrow(/instructions/);
  });

  it("rejects invalid skill names", () => {
    expect(() =>
      parseSkillManifest(
        JSON.stringify({
          name: "Bad Name",
          description: "x",
          instructions: "y",
        }),
      ),
    ).toThrow(/lowercase/);
  });
});

describe("loadSkillsFromDirectory", () => {
  it("loads SKILL.md, *.skill.md, and *.skill.json, and records errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "sw-skills-loader-"));

    // Sub-dir style.
    await mkdir(join(root, "reviewer"));
    await writeFile(
      join(root, "reviewer", "SKILL.md"),
      `---
name: reviewer
description: Reviews code.
---
Do the review.
`,
    );

    // Flat .skill.md style.
    await writeFile(
      join(root, "notify.skill.md"),
      `---
name: notify
description: Sends a notification.
instructions: Notify the channel.
---
`,
    );

    // Flat .skill.json style.
    await writeFile(
      join(root, "json.skill.json"),
      JSON.stringify({
        name: "json-skill",
        description: "From JSON.",
        instructions: "Do JSON things.",
      }),
    );

    // Broken file to exercise loadErrors.
    await writeFile(join(root, "broken.skill.md"), "not frontmatter");

    const result = await loadSkillsFromDirectory(root);
    const names = result.skills.map((s) => s.name).sort();
    expect(names).toEqual(["json-skill", "notify", "reviewer"]);
    expect(result.loadErrors).toHaveLength(1);
    expect(result.loadErrors[0]?.source).toContain("broken.skill.md");
  });
});

describe("matchSkills", () => {
  it("scores and orders matches deterministically", () => {
    const skills: SkillManifest[] = [
      sample({ name: "code-reviewer" }),
      sample({
        name: "dingtalk-notifier",
        description: "Sends DingTalk group notifications.",
        triggers: ["notify", "dingtalk"],
        instructions: "Notify.",
      }),
      sample({
        name: "test-writer",
        description: "Writes unit tests for new code.",
        triggers: ["tests", "coverage"],
        instructions: "Write tests.",
      }),
    ];

    const matches = matchSkills("please review the diff for risk", skills);
    expect(matches[0]?.skill.name).toBe("code-reviewer");
    expect(matches[0]?.score).toBeGreaterThan(0);
    expect(matches[0]?.matchedKeywords).toContain("review");
    // Notifier has no overlap with the query.
    expect(
      matches.find((m) => m.skill.name === "dingtalk-notifier"),
    ).toBeUndefined();
  });

  it("respects the limit option", () => {
    const skills: SkillManifest[] = [
      sample({ name: "a-skill", description: "review thing" }),
      sample({ name: "b-skill", description: "review thing" }),
      sample({ name: "c-skill", description: "review thing" }),
    ];
    const matches = matchSkills("review", skills, { limit: 2 });
    expect(matches).toHaveLength(2);
  });

  it("accepts a custom tokenizer", () => {
    const skills: SkillManifest[] = [
      sample({ name: "uppercased", description: "FOO BAR" }),
    ];
    const matches = matchSkills("FOO", skills, {
      tokenize: (input) => input.split(/\s+/),
    });
    expect(matches[0]?.matchedKeywords).toContain("FOO");
  });
});

describe("SkillRegistry", () => {
  it("throws on duplicate registration", () => {
    const reg = new SkillRegistry([sample()]);
    expect(() => reg.register(sample())).toThrow(/already registered/);
  });

  it("allows overwrite when requested", () => {
    const reg = new SkillRegistry([sample()]);
    reg.register(sample({ description: "Updated description." }), {
      overwrite: true,
    });
    expect(reg.get("code-reviewer")?.description).toBe("Updated description.");
  });

  it("matches via the registry", () => {
    const reg = new SkillRegistry([
      sample(),
      sample({
        name: "notify",
        description: "Sends notifications.",
        triggers: ["notify"],
        instructions: "Notify.",
      }),
    ]);
    const matches = reg.match("review the diff");
    expect(matches[0]?.skill.name).toBe("code-reviewer");
  });
});

describe("skillsToCapabilities", () => {
  it("projects manifests into CapabilityDescriptors", () => {
    const caps = skillsToCapabilities([
      sample({ source: "/skills/x/SKILL.md" }),
    ]);
    expect(caps).toHaveLength(1);
    const [cap] = caps;
    expect(cap!.kind).toBe("skill");
    expect(cap!.origin.kind).toBe("skill");
    expect(cap!.origin.name).toBe("/skills/x/SKILL.md");
    expect(cap!.id).toBe("skill:code-reviewer");
    expect(cap!.tags).toEqual(["review", "diff", "risk"]);
    expect(cap!.description).toContain("Reviews source code");
  });
});
