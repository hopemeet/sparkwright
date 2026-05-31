import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFrecency } from "../src/lib/frecency.js";

describe("frecency", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spark-frecency-"));
  });

  it("returns 0 for unknown paths", async () => {
    const fr = await loadFrecency(root);
    expect(fr.score("a.ts")).toBe(0);
  });

  it("bumps increase score and persist", async () => {
    const fr = await loadFrecency(root);
    await fr.bump("a.ts");
    expect(fr.score("a.ts")).toBeGreaterThan(0);

    const reloaded = await loadFrecency(root);
    expect(reloaded.score("a.ts")).toBeGreaterThan(0);
  });

  it("more frequent picks rank higher", async () => {
    const fr = await loadFrecency(root);
    await fr.bump("a.ts");
    await fr.bump("a.ts");
    await fr.bump("a.ts");
    await fr.bump("b.ts");
    expect(fr.score("a.ts")).toBeGreaterThan(fr.score("b.ts"));
  });

  it("scores() returns a map of all tracked paths", async () => {
    const fr = await loadFrecency(root);
    await fr.bump("a.ts");
    await fr.bump("b.ts");
    const scores = fr.scores();
    expect(scores.has("a.ts")).toBe(true);
    expect(scores.has("b.ts")).toBe(true);
  });
});
