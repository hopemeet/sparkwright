import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBundleInvocationMessage,
  loadBundlesFromDirectory,
  resolveBundle,
  resolveSlashCommand,
  SkillBundleRegistry,
  SkillRegistry,
  type SkillManifest,
} from "../src/index.js";

function manifest(name: string): SkillManifest {
  return { name, description: `desc ${name}`, instructions: `body of ${name}` };
}

describe("SkillBundleRegistry", () => {
  it("registers + lists + rejects duplicates", () => {
    const r = new SkillBundleRegistry();
    r.register({ name: "be-dev", skills: ["a"] });
    expect(r.size).toBe(1);
    expect(() => r.register({ name: "be-dev", skills: ["b"] })).toThrow();
    r.register({ name: "be-dev", skills: ["b"] }, { overwrite: true });
    expect(r.get("be-dev")?.skills).toEqual(["b"]);
  });
});

describe("resolveBundle", () => {
  it("resolves known + reports missing", () => {
    const skills = new SkillRegistry([manifest("a"), manifest("b")]);
    const r = resolveBundle({ name: "x", skills: ["a", "missing", "b"] }, (n) =>
      skills.get(n),
    );
    expect(r.skills.map((s) => s.name)).toEqual(["a", "b"]);
    expect(r.missing).toEqual(["missing"]);
  });
});

describe("resolveSlashCommand", () => {
  it("prefers bundle over skill on name collision", () => {
    const skills = new SkillRegistry([manifest("research")]);
    const bundles = new SkillBundleRegistry([
      { name: "research", skills: ["research"] },
    ]);
    const r = resolveSlashCommand("/research", { skills, bundles });
    expect(r?.kind).toBe("bundle");
  });

  it("falls back to skill when no bundle matches", () => {
    const skills = new SkillRegistry([manifest("solo")]);
    const r = resolveSlashCommand("/solo", {
      skills,
      bundles: new SkillBundleRegistry(),
    });
    expect(r?.kind).toBe("skill");
  });

  it("normalises slug (spaces, underscores)", () => {
    const skills = new SkillRegistry([manifest("foo-bar")]);
    expect(resolveSlashCommand("/Foo_Bar", { skills })?.kind).toBe("skill");
  });
});

describe("buildBundleInvocationMessage", () => {
  it("includes instruction + each skill body", () => {
    const skills = new SkillRegistry([manifest("a"), manifest("b")]);
    const resolved = resolveBundle(
      { name: "x", skills: ["a", "b"], instruction: "GUIDE" },
      (n) => skills.get(n),
    );
    const msg = buildBundleInvocationMessage(resolved);
    expect(msg.startsWith("GUIDE")).toBe(true);
    expect(msg).toContain("# Skill: a");
    expect(msg).toContain("body of a");
    expect(msg).toContain("body of b");
  });
});

describe("loadBundlesFromDirectory", () => {
  it("loads valid + reports invalid", async () => {
    const dir = await mkdir(join(tmpdir(), `sw-bundles-${Date.now()}`), {
      recursive: true,
    });
    const dirPath = dir!;
    await writeFile(
      join(dirPath, "ok.bundle.json"),
      JSON.stringify({ name: "ok", skills: ["a"] }),
    );
    await writeFile(join(dirPath, "bad.bundle.json"), "not json");
    await writeFile(
      join(dirPath, "ignored.txt"),
      JSON.stringify({ name: "ignored" }),
    );
    const result = await loadBundlesFromDirectory(dirPath);
    expect(result.bundles.map((b) => b.name)).toEqual(["ok"]);
    expect(result.errors.length).toBe(1);
  });

  it("returns empty for missing directory", async () => {
    const r = await loadBundlesFromDirectory(
      join(tmpdir(), `sw-missing-${Date.now()}`),
    );
    expect(r.bundles).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});
