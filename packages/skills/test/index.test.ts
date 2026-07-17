import { access, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createRunId } from "@sparkwright/core";
import {
  createSkillLockfile,
  createSkillLoaderTool,
  createLoadedSkillContext,
  computeAssetPackageHash,
  filterSkillsForAgent,
  isDevSkill,
  listSkillResourceFiles,
  listAssetPackageFiles,
  lockSkills,
  loadSkill,
  loadSkills,
  markdownAssetContentHash,
  parseSkillManifest,
  prepareSkillsForRun,
  rankIndexedSkillsByGoal,
  selectSkills,
  snapshotAssetPackage,
  assetPackagePathsOverlap,
  type SkillDefinition,
  type SkillIndexEntry,
} from "../src/index.js";

function definitionFromMarkdown(
  content: string,
  sourcePath = "SKILL.md",
): SkillDefinition {
  const manifest = parseSkillManifest(content, sourcePath);
  const metadata: Record<string, unknown> = { ...(manifest.metadata ?? {}) };
  if (manifest.version && metadata.version === undefined) {
    metadata.version = manifest.version;
  }
  return {
    name: manifest.name,
    description: manifest.description,
    license: manifest.license,
    compatibility: manifest.compatibility,
    allowedTools: manifest.allowedTools,
    version: manifest.version,
    triggers: manifest.triggers,
    body: manifest.instructions,
    sourcePath,
    contentHash: markdownAssetContentHash(content),
    packageHash: `sha256:${markdownAssetContentHash(content)}`,
    packageHashPolicyVersion: 2,
    metadata,
  };
}

describe("skills", () => {
  it("loads skill directories from a root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-"));
    await mkdir(join(root, "reviewer"));
    await writeFile(
      join(root, "reviewer", "SKILL.md"),
      `---
name: reviewer
description: Reviews code changes.
---
Review carefully.
`,
    );

    const skills = await loadSkills([root]);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.sourcePath).toBe(join(root, "reviewer", "SKILL.md"));
    expect(skills[0]).toMatchObject({
      packageHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      packageHashPolicyVersion: 2,
    });
  });

  it("loads nested SKILL.md packages during run preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-nested-"));
    await mkdir(join(root, "nested", "deep"), { recursive: true });
    await writeFile(
      join(root, "nested", "deep", "SKILL.md"),
      `---
name: deep-skill
description: Handles deeply nested skill packages.
---
Deep body.
`,
    );

    const prepared = await prepareSkillsForRun({
      goal: "deep skill",
      skillRoots: [root],
      loadSelectedSkills: false,
    });

    expect(prepared.indexedSkills.map((skill) => skill.name)).toEqual([
      "deep-skill",
    ]);
  });

  it("enumerates v2 asset packages consistently with exclusions and limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-asset-package-v2-"));
    const packageDir = join(root, "workflow");
    await mkdir(join(packageDir, "scripts"), { recursive: true });
    await mkdir(join(packageDir, "nested"), { recursive: true });
    await mkdir(join(packageDir, "node_modules", "ignored"), {
      recursive: true,
    });
    await writeFile(join(packageDir, "workflow.md"), "# workflow\n");
    await writeFile(join(packageDir, "config.yaml"), "retries: 1\n");
    await writeFile(join(packageDir, "scripts", "run.sh"), "echo run\n");
    await writeFile(join(packageDir, "nested", "fixture.txt"), "fixture\n");
    await writeFile(join(packageDir, "node_modules", "ignored", "dep.js"), "x");
    await writeFile(join(packageDir, ".DS_Store"), "ignored");
    await writeFile(join(packageDir, "nested", "swap.swp"), "ignored");

    const spec = { rootPath: packageDir, entryPath: "workflow.md" };
    const before = await computeAssetPackageHash(spec);
    expect(before.packageHashPolicyVersion).toBe(2);
    expect(before.files.map((file) => file.relativePath)).toEqual([
      "config.yaml",
      "nested/fixture.txt",
      "scripts/run.sh",
      "workflow.md",
    ]);

    await writeFile(join(packageDir, "nested", "fixture.txt"), "changed\n");
    const after = await computeAssetPackageHash(spec);
    expect(after.packageHash).not.toBe(before.packageHash);

    const snapshotDir = join(root, "snapshot");
    const snapshot = await snapshotAssetPackage(spec, snapshotDir);
    expect(snapshot.packageHash).toBe(after.packageHash);
    await expect(listAssetPackageFiles(spec)).resolves.toEqual(after.files);
    await expect(
      access(join(snapshotDir, "node_modules")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed for v2 unsafe paths and package limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-asset-package-v2-"));
    const packageDir = join(root, "skill");
    await mkdir(packageDir);
    await writeFile(join(packageDir, "SKILL.md"), "# skill\n");
    await writeFile(join(packageDir, "large.txt"), "1234");

    await expect(
      computeAssetPackageHash({
        rootPath: packageDir,
        entryPath: "SKILL.md",
        limits: { maxFileBytes: 3 },
      }),
    ).rejects.toThrow(/file exceeds byte limit/);
    await expect(
      computeAssetPackageHash({
        rootPath: packageDir,
        entryPath: "SKILL.md",
        limits: { maxTotalBytes: 3 },
      }),
    ).rejects.toThrow(/exceeds byte limit/);
    await expect(
      computeAssetPackageHash({
        rootPath: packageDir,
        entryPath: "../SKILL.md",
      }),
    ).rejects.toThrow(/must stay inside/);
    await expect(
      snapshotAssetPackage(
        { rootPath: packageDir, entryPath: "SKILL.md" },
        join(packageDir, "snapshot"),
      ),
    ).rejects.toThrow(/disjoint from its source root/);
    await expect(
      snapshotAssetPackage(
        { rootPath: packageDir, entryPath: "SKILL.md" },
        root,
      ),
    ).rejects.toThrow(/disjoint from its source root/);
    await expect(access(join(packageDir, "SKILL.md"))).resolves.toBeUndefined();

    await symlink(join(packageDir, "SKILL.md"), join(packageDir, "link.md"));
    await expect(
      computeAssetPackageHash({ rootPath: packageDir, entryPath: "SKILL.md" }),
    ).rejects.toThrow(/cannot contain a symlink/);
  });

  it("treats Windows cross-volume snapshot paths as disjoint", () => {
    expect(
      assetPackagePathsOverlap(
        "C:\\assets\\skill",
        "D:\\snapshots\\skill",
        win32,
      ),
    ).toBe(false);
    expect(
      assetPackagePathsOverlap(
        "C:\\assets\\skill",
        "C:\\assets\\skill\\snapshot",
        win32,
      ),
    ).toBe(true);
    expect(
      assetPackagePathsOverlap("C:\\assets", "C:\\assets\\skill", win32),
    ).toBe(true);
  });

  it("lets stronger roots shadow weaker skills with the same name", async () => {
    const weak = await mkdtemp(join(tmpdir(), "sparkwright-skills-weak-"));
    const strong = await mkdtemp(join(tmpdir(), "sparkwright-skills-strong-"));
    await mkdir(join(weak, "reviewer"));
    await mkdir(join(strong, "reviewer"));
    await writeFile(
      join(weak, "reviewer", "SKILL.md"),
      `---
name: reviewer
description: Weak reviewer.
---
Weak body.
`,
    );
    await writeFile(
      join(strong, "reviewer", "SKILL.md"),
      `---
name: reviewer
description: Strong reviewer.
---
Strong body.
`,
    );

    const skills = await loadSkills([
      { root: weak, layer: "builtin" },
      { root: strong, layer: "project" },
    ]);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      description: "Strong reviewer.",
      body: "Strong body.",
      metadata: { sparkwrightLayer: "project" },
    });
  });

  it("selects skills deterministically from the goal", () => {
    const dingtalk = definitionFromMarkdown(`---
name: dingtalk-notifier
description: Sends DingTalk group notifications.
---
Notify safely.
`);
    const reviewer = definitionFromMarkdown(`---
name: code-reviewer
description: Reviews code changes.
---
Review safely.
`);

    const selected = selectSkills({
      goal: "send a dingtalk notification to the group",
      skills: [reviewer, dingtalk],
    });

    expect(selected.map((entry) => entry.skill.name)).toEqual([
      "dingtalk-notifier",
    ]);
  });

  it("prepares skill index and selected skill context for a run", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-"));
    await mkdir(join(root, "dingtalk"));
    await writeFile(
      join(root, "dingtalk", "SKILL.md"),
      `---
name: dingtalk-notifier
description: Sends DingTalk group notifications.
metadata:
  version: 1.2.3
---
Use DingTalk only when notification is requested.
`,
    );

    const prepared = await prepareSkillsForRun({
      goal: "send a DingTalk notification",
      skillRoots: [root],
    });

    expect(prepared.tools).toEqual([]);
    expect(prepared.indexedSkills).toHaveLength(1);
    expect(prepared.loadedSkills).toMatchObject([
      {
        name: "dingtalk-notifier",
        version: "1.2.3",
      },
    ]);
    expect(prepared.context).toHaveLength(2);
    expect(prepared.context[0]?.metadata.layer).toBe("skill_index");
    expect(prepared.context[0]?.content).not.toContain(root);
    expect(prepared.context[0]?.content).not.toContain("sourcePath");
    expect(prepared.context[0]?.content).not.toContain("contentHash");
    expect(prepared.context[1]?.metadata).toMatchObject({
      layer: "resident",
      skillName: "dingtalk-notifier",
      skillVersion: "1.2.3",
    });
  });

  it("excludes devOnly skills from a run unless explicitly included", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-dev-"));
    await mkdir(join(root, "real"));
    await writeFile(
      join(root, "real", "SKILL.md"),
      `---
name: real-skill
description: A production skill that should always load.
---
Body.
`,
    );
    await mkdir(join(root, "tester"));
    await writeFile(
      join(root, "tester", "SKILL.md"),
      `---
name: spark-tester
description: Test skill. Use for skill smoke tests and verifying skills load.
metadata:
  devOnly: true
---
Body.
`,
    );

    // loadSkills stays unfiltered so list_skills / CLI listing still see it.
    const all = await loadSkills([root]);
    expect(all.map((s) => s.name).sort()).toEqual([
      "real-skill",
      "spark-tester",
    ]);
    expect(isDevSkill(all.find((s) => s.name === "spark-tester")!)).toBe(true);
    expect(isDevSkill(all.find((s) => s.name === "real-skill")!)).toBe(false);

    // By default the run candidate set hides the devOnly skill.
    const prepared = await prepareSkillsForRun({
      goal: "run a spark tester skill smoke test",
      skillRoots: [root],
    });
    expect(prepared.indexedSkills.map((s) => s.name)).toEqual(["real-skill"]);
    expect(prepared.loadedSkills.map((s) => s.name)).not.toContain(
      "spark-tester",
    );

    // Opt-in restores it (dev/test environments).
    const withDev = await prepareSkillsForRun({
      goal: "run a spark tester skill smoke test",
      skillRoots: [root],
      includeDevSkills: true,
    });
    expect(withDev.indexedSkills.map((s) => s.name).sort()).toEqual([
      "real-skill",
      "spark-tester",
    ]);
  });

  it("can prepare only the skill index and a loader tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-"));
    await mkdir(join(root, "dingtalk"));
    await writeFile(
      join(root, "dingtalk", "SKILL.md"),
      `---
name: dingtalk-notifier
description: Sends DingTalk group notifications.
---
Use DingTalk only when notification is requested.
`,
    );

    const prepared = await prepareSkillsForRun({
      goal: "send a DingTalk notification",
      skillRoots: [root],
      includeLoaderTool: true,
      loadSelectedSkills: false,
    });

    expect(prepared.context).toHaveLength(1);
    expect(prepared.loadedSkills).toEqual([]);
    expect(prepared.tools.map((tool) => tool.name)).toEqual(["skill_load"]);
  });

  it("emits skill.indexed and skill.loaded when an emitter is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-emit-"));
    await mkdir(join(root, "reviewer"));
    await writeFile(
      join(root, "reviewer", "SKILL.md"),
      `---
name: code-reviewer
description: Reviews source code changes.
metadata:
  version: 1.0.0
---
Body
`,
    );

    const captured: Array<{
      type: string;
      payload: unknown;
      metadata: Record<string, unknown>;
    }> = [];
    const emitter = {
      emit(
        type: string,
        payload: unknown,
        metadata: Record<string, unknown> = {},
      ) {
        captured.push({ type, payload, metadata });
        return {
          id: "evt_test",
          runId: "",
          type: type as never,
          timestamp: new Date().toISOString(),
          sequence: 0,
          payload,
          metadata,
        } as never;
      },
    };

    await prepareSkillsForRun({
      goal: "review code",
      skillRoots: [root],
      emitter: emitter as never,
      agentId: "reviewer",
    });

    const types = captured.map((entry) => entry.type);
    expect(types).toContain("skill.indexed");
    expect(types).toContain("skill.loaded");
    const indexed = captured.find((e) => e.type === "skill.indexed")!;
    expect((indexed.payload as { count: number }).count).toBeGreaterThan(0);
    expect(indexed.metadata.sourcePackage).toBe("@sparkwright/skills");
    const indexedSkills = indexed.metadata.skills as Array<{
      name: string;
      packageHash: string;
      packageHashPolicyVersion: 2;
    }>;
    expect(indexedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "code-reviewer",
          packageHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          packageHashPolicyVersion: 2,
        }),
      ]),
    );
  });

  it("skips invalid skills during run preparation and emits skill.failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-bad-"));
    await mkdir(join(root, "good"));
    await mkdir(join(root, "bad"));
    await writeFile(
      join(root, "good", "SKILL.md"),
      `---
name: good-skill
description: Handles good requests.
---
Good body.
`,
    );
    await writeFile(
      join(root, "bad", "SKILL.md"),
      `---
name: bad-skill
---
Bad body.
`,
    );

    const captured: Array<{ type: string; payload: unknown }> = [];
    const emitter = {
      emit(type: string, payload: unknown) {
        captured.push({ type, payload });
        return {
          id: "evt_test",
          runId: "",
          type: type as never,
          timestamp: new Date().toISOString(),
          sequence: 0,
          payload,
        } as never;
      },
    };

    const prepared = await prepareSkillsForRun({
      goal: "good request",
      skillRoots: [root],
      emitter: emitter as never,
    });

    expect(prepared.indexedSkills.map((skill) => skill.name)).toEqual([
      "good-skill",
    ]);
    expect(captured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "skill.failed",
          payload: expect.objectContaining({
            source: join(root, "bad", "SKILL.md"),
          }),
        }),
        expect.objectContaining({
          type: "skill.indexed",
          payload: { count: 1 },
        }),
      ]),
    );
  });

  it("filters skills by agent access policy", () => {
    const notifier = definitionFromMarkdown(`---
name: dingtalk-notifier
description: Sends DingTalk group notifications.
---
Notify safely.
`);
    const reviewer = definitionFromMarkdown(`---
name: code-reviewer
description: Reviews code changes.
---
Review safely.
`);

    expect(
      filterSkillsForAgent([notifier, reviewer], {
        allowedSkills: ["*"],
        deniedSkills: ["dingtalk-notifier"],
      }).map((skill) => skill.name),
    ).toEqual(["code-reviewer"]);

    expect(
      filterSkillsForAgent([notifier, reviewer], {
        allowedSkills: ["code-reviewer"],
      }).map((skill) => skill.name),
    ).toEqual(["code-reviewer"]);
  });

  it("creates a deterministic serializable skill lockfile", () => {
    const dingtalk = definitionFromMarkdown(
      `---
name: dingtalk-notifier
description: Sends DingTalk group notifications.
metadata:
  version: 1.2.3
---
Notify safely.
`,
      "/skills/dingtalk/SKILL.md",
    );
    const reviewer = definitionFromMarkdown(
      `---
name: code-reviewer
description: Reviews code changes.
metadata:
  owner: platform
---
Review safely.
`,
      "/skills/reviewer/SKILL.md",
    );

    const lockfile = createSkillLockfile([dingtalk, reviewer], {
      generatedAt: new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(lockfile).toEqual({
      schemaVersion: "skill-lockfile.v0.1",
      generatedAt: "2026-01-02T03:04:05.000Z",
      skills: [
        {
          name: "code-reviewer",
          sourcePath: "/skills/reviewer/SKILL.md",
          packageHash: reviewer.packageHash,
          packageHashPolicyVersion: 2,
          metadata: {
            owner: "platform",
          },
        },
        {
          name: "dingtalk-notifier",
          sourcePath: "/skills/dingtalk/SKILL.md",
          packageHash: dingtalk.packageHash,
          packageHashPolicyVersion: 2,
          version: "1.2.3",
          metadata: {
            version: "1.2.3",
          },
        },
      ],
    });
    expect(JSON.parse(JSON.stringify(lockfile))).toEqual(lockfile);
  });

  it("locks indexed skills without recomputing version metadata", () => {
    const lockfile = lockSkills([
      {
        name: "code-reviewer",
        description: "Reviews code changes.",
        sourcePath: "/skills/reviewer/SKILL.md",
        packageHash: "sha256:abc123",
        packageHashPolicyVersion: 2,
        version: "indexed-version",
        metadata: {
          version: "metadata-version",
        },
      },
    ]);

    expect(lockfile.skills).toEqual([
      {
        name: "code-reviewer",
        sourcePath: "/skills/reviewer/SKILL.md",
        packageHash: "sha256:abc123",
        packageHashPolicyVersion: 2,
        version: "indexed-version",
        metadata: {
          version: "metadata-version",
        },
      },
    ]);
  });

  it("loads a skill body through the skill loader tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-"));
    await mkdir(join(root, "reviewer", "references"), { recursive: true });
    await writeFile(
      join(root, "reviewer", "SKILL.md"),
      `---
name: code-reviewer
description: Reviews code changes.
allowed-tools: read create_agent
metadata:
  version: 1.0.0
---
Review only the requested change.
`,
    );
    await writeFile(join(root, "reviewer", "references", "rules.md"), "Rules");

    const [skill] = await loadSkills([root]);
    expect(skill).toBeDefined();

    const tool = createSkillLoaderTool([skill!]);
    const output = await tool.execute(
      { name: "code-reviewer" },
      {
        run: {
          id: createRunId(),
          goal: "review",
          state: "running",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          metadata: {},
        },
      },
    );

    const absoluteFile = join(
      root,
      "reviewer",
      "references",
      "rules.md",
    ).replace(/\\/g, "/");
    expect(output).toMatchObject({
      status: "loaded",
      name: "code-reviewer",
      version: "1.0.0",
      toolDependencies: ["read", "create_agent"],
      // Resource files are reported skill-relative, never as absolute host
      // paths (which leak the host layout and lure a workspace-escaping read).
      resourceFiles: ["references/rules.md"],
    });
    expect(output).not.toHaveProperty("baseDirectory");
    expect(JSON.stringify(output)).toContain(
      "Review only the requested change",
    );
    const loaded = output as { content: string };
    expect(loaded.content).toContain("<file>references/rules.md</file>");
    expect(loaded.content).not.toContain(absoluteFile);
    // Directs the model to read references via the resource argument, not by
    // passing an absolute host path to a file-reading tool.
    expect(loaded.content).toContain("resource");
    expect(loaded.content).not.toContain(root);
  });

  it("preprocesses skill bodies when loadSkill opts in", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-"));
    const skillDir = join(root, "dynamic");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: dynamic
description: Dynamic preprocessing.
---
dir=\${SPARKWRIGHT_SKILL_DIR}
value=!\`printf source\`
`,
    );

    const skill = await loadSkill(join(skillDir, "SKILL.md"), {
      preprocess: {
        inlineShell: true,
        inlineShellRunner: async ({ cwd, command }) => {
          expect(cwd).toBe(skillDir);
          expect(command).toBe("printf source");
          return "expanded";
        },
      },
    });

    expect(skill.body).toContain(`dir=${skillDir}`);
    expect(skill.body).toContain("value=expanded");
  });

  it("reads a skill reference file through the resource argument", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-"));
    await mkdir(join(root, "reviewer", "references"), { recursive: true });
    await writeFile(
      join(root, "reviewer", "SKILL.md"),
      `---
name: code-reviewer
description: Reviews code changes.
metadata:
  version: 1.0.0
---
Review only the requested change.
`,
    );
    await writeFile(
      join(root, "reviewer", "references", "rules.md"),
      "Rule one.\nRule two.\n",
    );

    const [skill] = await loadSkills([root]);
    const tool = createSkillLoaderTool([skill!]);
    const ctx = {
      run: {
        id: createRunId(),
        goal: "review",
        state: "running" as const,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        metadata: {},
      },
    };

    const ok = await tool.execute(
      { name: "code-reviewer", resource: "references/rules.md" },
      ctx,
    );
    expect(ok).toMatchObject({
      status: "resource",
      name: "code-reviewer",
      resource: "references/rules.md",
      content: "Rule one.\nRule two.\n",
    });

    const repeated = await tool.execute(
      { name: "code-reviewer", resource: "references/rules.md" },
      ctx,
    );
    expect(repeated).toMatchObject({
      status: "already_loaded",
      name: "code-reviewer",
      resource: "references/rules.md",
      samePackageHash: true,
    });
    expect(repeated).not.toHaveProperty("content");

    const aliasedRepeat = await tool.execute(
      { name: "code-reviewer", resource: "references/./rules.md" },
      ctx,
    );
    expect(aliasedRepeat).toMatchObject({
      status: "already_loaded",
      resource: "references/rules.md",
    });

    const emptyResource = await tool.execute(
      { name: "code-reviewer", resource: "" },
      ctx,
    );
    expect(emptyResource).toMatchObject({
      status: "loaded",
      name: "code-reviewer",
    });

    // Containment: a traversal path must not read outside the skill directory.
    const escaped = await tool.execute(
      { name: "code-reviewer", resource: "../../../../etc/hosts" },
      ctx,
    );
    expect(escaped).toMatchObject({ status: "resource_denied" });
    expect(escaped).not.toHaveProperty("content");

    const missing = await tool.execute(
      { name: "code-reviewer", resource: "references/missing.md" },
      ctx,
    );
    expect(missing).toMatchObject({
      status: "resource_not_found",
      availableResources: ["references/rules.md"],
    });
    expect(missing).toHaveProperty(
      "message",
      expect.stringContaining("Available reference files"),
    );
  });

  it("short-circuits a repeated skill load as already_loaded", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-"));
    await mkdir(join(root, "reviewer"), { recursive: true });
    await writeFile(
      join(root, "reviewer", "SKILL.md"),
      `---
name: code-reviewer
description: Reviews code changes.
---
Review only the requested change.
`,
    );

    const [skill] = await loadSkills([root]);
    const tool = createSkillLoaderTool([skill!]);
    const ctx = {
      run: {
        id: createRunId(),
        goal: "review",
        state: "running" as const,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        metadata: {},
      },
    };

    const first = await tool.execute({ name: "code-reviewer" }, ctx);
    expect(first).toMatchObject({ status: "loaded" });

    const second = await tool.execute({ name: "code-reviewer" }, ctx);
    expect(second).toMatchObject({
      status: "already_loaded",
      name: "code-reviewer",
    });
    // The body is not re-sent on the repeat.
    expect(JSON.stringify(second)).not.toContain(
      "Review only the requested change",
    );
  });

  it("lists skill resource files without SKILL.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-"));
    await mkdir(join(root, "writer", "assets"), { recursive: true });
    await writeFile(
      join(root, "writer", "SKILL.md"),
      `---
name: writer
description: Writes docs.
---
Write clearly.
`,
    );
    await writeFile(join(root, "writer", "assets", "style.md"), "Style");

    const [skill] = await loadSkills([root]);

    await expect(listSkillResourceFiles(skill!)).resolves.toEqual([
      "assets/style.md",
    ]);
  });

  it("does not let SKILL.md consume the resource file limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-skills-"));
    await mkdir(join(root, "writer", "assets"), { recursive: true });
    await writeFile(
      join(root, "writer", "SKILL.md"),
      `---
name: writer
description: Writes docs.
---
Write clearly.
`,
    );
    await writeFile(join(root, "writer", "assets", "style.md"), "Style");

    const [skill] = await loadSkills([root]);

    await expect(listSkillResourceFiles(skill!, 1)).resolves.toEqual([
      "assets/style.md",
    ]);
  });

  it("creates traceable loaded skill context", () => {
    const skill = definitionFromMarkdown(`---
name: code-reviewer
description: Reviews code changes.
metadata:
  version: 2
---
Review only the requested change.
`);

    const context = createLoadedSkillContext(skill, "Matched goal.");

    expect(context.type).toBe("system");
    expect(context.source).toEqual({
      kind: "skill",
    });
    expect(context.content).toContain("Review only the requested change.");
    expect(context.metadata).toMatchObject({
      layer: "resident",
      stability: "session",
      skillName: "code-reviewer",
      skillVersion: "2",
      skillSourcePath: "SKILL.md",
      selectionReason: "Matched goal.",
    });
  });
});

describe("rankIndexedSkillsByGoal", () => {
  const entry = (overrides: Partial<SkillIndexEntry>): SkillIndexEntry => ({
    name: "skill",
    description: "",
    sourcePath: `/skills/${overrides.name ?? "skill"}/SKILL.md`,
    contentHash: "hash",
    packageHash: "sha256:hash",
    packageHashPolicyVersion: 2,
    metadata: {},
    ...overrides,
  });

  const index: SkillIndexEntry[] = [
    entry({
      name: "manual",
      description: "Operational manual for SparkWright.",
    }),
    entry({
      name: "login-tester",
      description: "测试用户登录与认证流程",
    }),
  ];

  it("floats the plausible match to the top for a CJK goal (order-only hint)", () => {
    const ranked = rankIndexedSkillsByGoal(index, "帮我测试登录功能");
    expect(ranked[0]?.name).toBe("login-tester");
  });

  it("never tags relevance — the label is gone, relevance is the reader's call", () => {
    const ranked = rankIndexedSkillsByGoal(index, "帮我测试登录功能");
    expect(ranked.every((s) => !("relevance" in s))).toBe(true);
  });

  it("drops nothing — every indexed skill survives ranking", () => {
    const ranked = rankIndexedSkillsByGoal(index, "帮我测试登录功能");
    expect(ranked.map((s) => s.name).sort()).toEqual([
      "login-tester",
      "manual",
    ]);
  });

  it("orders by name when the goal has no matchable tokens", () => {
    const ranked = rankIndexedSkillsByGoal(index, "!!! ???");
    expect(ranked.map((s) => s.name)).toEqual(["login-tester", "manual"]);
  });

  it("scores triggers so a description-only miss still floats to the top", () => {
    const withTriggers: SkillIndexEntry[] = [
      entry({
        name: "manual",
        // Description deliberately omits the concrete nouns the user types.
        description: "Operational manual for running SparkWright.",
        triggers: ["trace", "session", "resume"],
      }),
      entry({ name: "login-tester", description: "测试用户登录与认证流程" }),
    ];
    const ranked = rankIndexedSkillsByGoal(
      withTriggers,
      "trace 文件坏了怎么修复、怎么 resume session？",
    );
    expect(ranked[0]?.name).toBe("manual");
  });
});
