import { describe, expect, it, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIndex } from "../src/lib/files.js";

describe("FileIndex", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "spark-tui-files-"));
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "node_modules", "foo"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "README.md"), "x");
    await writeFile(join(root, "src", "index.ts"), "x");
    await writeFile(join(root, "src", "lib", "diff.ts"), "x");
    await writeFile(join(root, "node_modules", "foo", "evil.js"), "x");
    await writeFile(join(root, ".git", "HEAD"), "x");
  });

  it("indexes only workspace files and skips node_modules/.git/dotfiles", async () => {
    const idx = new FileIndex(root);
    await idx.ensure(true);
    const all = idx.filter("", 100).map((f) => f.path);
    expect(all).toContain("README.md");
    expect(all).toContain("src/index.ts");
    expect(all).toContain("src/lib/diff.ts");
    expect(all.find((p) => p.includes("node_modules"))).toBeUndefined();
    expect(all.find((p) => p.includes(".git"))).toBeUndefined();
  });

  it("ranks basename-prefix matches above path-contains", async () => {
    const idx = new FileIndex(root);
    await idx.ensure(true);
    const hits = idx.filter("diff");
    expect(hits[0].path).toBe("src/lib/diff.ts");
  });

  it("returns recent files when query is empty", async () => {
    const idx = new FileIndex(root);
    await idx.ensure(true);
    expect(idx.filter("").length).toBeGreaterThan(0);
  });
});
