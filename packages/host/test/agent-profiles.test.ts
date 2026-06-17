import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverProjectAgentProfiles,
  mergeAgentProfilesById,
  parseAgentProfileFile,
  resolveAgentProfiles,
} from "../src/agent-profiles.js";
import { loadLayeredAgentReport } from "../src/agent-report.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sparkwright-agent-md-"));
}

async function writeAgent(
  root: string,
  name: string,
  contents: string,
): Promise<void> {
  const dir = join(root, ".sparkwright", "agents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), contents, "utf8");
}

describe("parseAgentProfileFile", () => {
  it("maps frontmatter and body onto an AgentProfile", () => {
    const profile = parseAgentProfileFile(
      "triage",
      [
        "---",
        "name: Triage",
        "description: routes issues",
        "mode: child",
        "model: openai/m",
        "allowedTools: [read_file, glob]",
        "maxSteps: 5",
        "---",
        "You triage issues.",
      ].join("\n"),
    );
    expect(profile.id).toBe("triage");
    expect(profile.name).toBe("Triage");
    expect(profile.allowedTools).toEqual(["read_file", "glob"]);
    expect(profile.maxSteps).toBe(5);
    expect(profile.mode).toBe("child");
    expect(profile.model).toBe("openai/m");
    expect(profile.prompt).toBe("You triage issues.");
  });

  it("ignores an invalid mode and non-positive maxSteps", () => {
    const profile = parseAgentProfileFile(
      "x",
      "---\nmode: bogus\nmaxSteps: 0\n---\nbody",
    );
    expect(profile.mode).toBeUndefined();
    expect(profile.maxSteps).toBeUndefined();
    expect(profile.prompt).toBe("body");
  });
});

describe("mergeAgentProfilesById", () => {
  it("lets the strong (config) layer win ties by id", () => {
    const merged = mergeAgentProfilesById(
      [
        { id: "a", name: "md-a" },
        { id: "b", name: "md-b" },
      ],
      [{ id: "a", name: "config-a" }],
    );
    expect(merged).toEqual([
      { id: "a", name: "config-a" },
      { id: "b", name: "md-b" },
    ]);
  });
});

describe("discovery + resolve", () => {
  it("returns empty when no agents dir exists", async () => {
    const root = await tempWorkspace();
    expect(await discoverProjectAgentProfiles(root)).toEqual([]);
  });

  it("discovers markdown agents and folds them under config (config wins)", async () => {
    const root = await tempWorkspace();
    await writeAgent(
      root,
      "triage",
      "---\nname: md-triage\nmode: child\n---\nprompt",
    );
    await writeAgent(root, "mdonly", "---\nname: only-md\n---\nbody");

    const resolved = await resolveAgentProfiles(root, [
      { id: "triage", name: "config-triage" },
    ]);
    const byId = Object.fromEntries(resolved.map((p) => [p.id, p]));
    expect(byId.triage?.name).toBe("config-triage"); // config wins
    expect(byId.mdonly?.name).toBe("only-md"); // md-only survives
  });

  it("layers user markdown under project markdown before config profiles", async () => {
    const root = await tempWorkspace();
    const xdg = await mkdtemp(join(tmpdir(), "sparkwright-agent-xdg-"));
    await mkdir(join(xdg, "sparkwright", "agents"), { recursive: true });
    await writeFile(
      join(xdg, "sparkwright", "agents", "triage.md"),
      "---\nname: user-triage\n---\nuser prompt",
      "utf8",
    );
    await writeAgent(root, "triage", "---\nname: project-triage\n---\nprompt");

    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const markdownOnly = await resolveAgentProfiles(root, undefined);
      expect(
        markdownOnly.find((profile) => profile.id === "triage")?.name,
      ).toBe("project-triage");

      const resolved = await resolveAgentProfiles(root, [
        { id: "triage", name: "config-triage" },
      ]);
      expect(resolved.find((profile) => profile.id === "triage")?.name).toBe(
        "config-triage",
      );
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });
});

describe("loadLayeredAgentReport", () => {
  it("reports agent provenance and shadowed profiles", async () => {
    const root = await tempWorkspace();
    const xdg = await mkdtemp(join(tmpdir(), "sparkwright-agent-report-xdg-"));
    await mkdir(join(xdg, "sparkwright", "agents"), { recursive: true });
    await writeFile(
      join(xdg, "sparkwright", "agents", "reviewer.md"),
      "---\nname: user-reviewer\n---\nuser prompt",
      "utf8",
    );
    await writeAgent(
      root,
      "reviewer",
      "---\nname: project-reviewer\n---\nproject prompt",
    );

    const report = await loadLayeredAgentReport(
      root,
      [{ id: "reviewer", name: "config-reviewer", mode: "child" }],
      { XDG_CONFIG_HOME: xdg },
    );

    expect(report.profiles).toEqual([
      expect.objectContaining({
        id: "reviewer",
        name: "config-reviewer",
        layer: "config",
        mode: "child",
      }),
    ]);
    expect(report.shadows).toEqual([
      expect.objectContaining({
        id: "reviewer",
        shadowed: expect.objectContaining({ layer: "user" }),
        shadowedBy: expect.objectContaining({ layer: "project" }),
      }),
      expect.objectContaining({
        id: "reviewer",
        shadowed: expect.objectContaining({ layer: "project" }),
        shadowedBy: expect.objectContaining({ layer: "config" }),
      }),
    ]);
    expect(report.errors).toEqual([]);
  });
});
