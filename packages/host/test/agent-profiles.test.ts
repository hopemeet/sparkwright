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
        "allowedTools: [read_file, glob_paths]",
        "maxSteps: 5",
        "---",
        "You triage issues.",
      ].join("\n"),
    );
    expect(profile.id).toBe("triage");
    expect(profile.name).toBe("Triage");
    expect(profile.allowedTools).toEqual(["read_file", "glob_paths"]);
    expect(profile.maxSteps).toBe(5);
    expect(profile.experimental?.mode).toBe("child");
    expect(profile.experimental?.model).toBe("openai/m");
    expect(profile.experimental?.prompt).toBe("You triage issues.");
  });

  it("ignores an invalid mode and non-positive maxSteps", () => {
    const profile = parseAgentProfileFile(
      "x",
      "---\nmode: bogus\nmaxSteps: 0\n---\nbody",
    );
    expect(profile.mode).toBeUndefined();
    expect(profile.maxSteps).toBeUndefined();
    expect(profile.experimental?.prompt).toBe("body");
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
});
