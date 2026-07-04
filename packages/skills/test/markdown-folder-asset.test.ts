import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverMarkdownFolderAssets,
  loadMarkdownFolderAsset,
  markdownAssetContentHash,
  splitMarkdownFrontmatter,
} from "../src/markdown-folder-asset.js";

describe("markdown-folder-asset", () => {
  it("splits frontmatter, body, hash, and version identity without schema knowledge", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-md-asset-"));
    const dir = join(root, "bugfix");
    await mkdir(dir, { recursive: true });
    const source = [
      "---",
      "name: Bug Fix",
      "version: 1",
      "metadata:",
      "  owner: platform",
      "---",
      "Patch the issue.",
    ].join("\n");
    await writeFile(join(dir, "workflow.md"), source, "utf8");

    const asset = await loadMarkdownFolderAsset({
      dir,
      fileName: "workflow.md",
    });

    expect(asset).toMatchObject({
      assetName: "bugfix",
      fileName: "workflow.md",
      body: "Patch the issue.",
      contentHash: markdownAssetContentHash(source),
      version: "1",
    });
    expect(asset.frontmatter).toMatchObject({
      name: "Bug Fix",
      metadata: { owner: "platform" },
    });
  });

  it("discovers folder assets under a root in stable order", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-md-assets-"));
    await mkdir(join(root, "z"), { recursive: true });
    await mkdir(join(root, "a"), { recursive: true });
    await writeFile(join(root, "z", "workflow.md"), "Z", "utf8");
    await writeFile(join(root, "a", "workflow.md"), "A", "utf8");

    const assets = await discoverMarkdownFolderAssets({
      root,
      fileName: "workflow.md",
    });

    expect(assets.map((asset) => asset.assetName)).toEqual(["a", "z"]);
  });

  it("lets callers provide owner-specific frontmatter parsing", () => {
    const split = splitMarkdownFrontmatter(
      ["---", "Name: Demo", "---", "Body"].join("\n"),
      {
        parseFrontmatter(raw) {
          return Object.fromEntries(
            raw
              .split(/\r?\n/)
              .map((line) => line.split(":"))
              .map(([key, value]) => [key!.toLowerCase(), value!.trim()]),
          );
        },
      },
    );

    expect(split.frontmatter).toEqual({ name: "Demo" });
    expect(split.body).toBe("Body");
  });
});
