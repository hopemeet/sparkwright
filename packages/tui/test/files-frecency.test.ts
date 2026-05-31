import { describe, expect, it, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIndex } from "../src/lib/files.js";

describe("FileIndex frecency tie-breaking", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "spark-files-fr-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "alpha.ts"), "x");
    await writeFile(join(root, "src", "alposx.ts"), "x");
  });

  it("orders same-bucket matches by frecency score", async () => {
    const idx = new FileIndex(root);
    await idx.ensure(true);
    // Both match "alp" as basename-prefix (bucket 0). Boost alposx via frecency.
    const frecency = new Map<string, number>([["src/alposx.ts", 99]]);
    const hits = idx.filter("alp", 10, frecency);
    expect(hits[0].path).toBe("src/alposx.ts");
  });

  it("empty query returns frecency-favored files first", async () => {
    const idx = new FileIndex(root);
    await idx.ensure(true);
    const frecency = new Map<string, number>([["src/alpha.ts", 50]]);
    const hits = idx.filter("", 10, frecency);
    expect(hits[0].path).toBe("src/alpha.ts");
  });
});
