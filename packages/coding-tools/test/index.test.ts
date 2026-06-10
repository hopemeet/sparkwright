import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createRunId,
  LocalWorkspace,
  type RuntimeContext,
  type ToolDefinition,
} from "@sparkwright/core";
import {
  applyUnifiedDiff,
  createCodingTools,
  type ApplyPatchInput,
  type ApplyPatchResult,
  type DirectoryEntry,
  type EditAnchoredTextInput,
  type EditAnchoredTextResult,
  type GlobPathsInput,
  type GlobPathsResult,
  type GrepTextInput,
  type GrepTextResult,
  type ListDirInput,
  type ListDirResult,
  type ReadAnchoredTextInput,
  type ReadAnchoredTextResult,
  type ReadTextInput,
  type ReadTextResult,
} from "../src/index.js";

describe("coding tools", () => {
  it("creates the official coding tool set", () => {
    expect(createCodingTools().map((tool) => tool.name)).toEqual([
      "read_text",
      "read_anchored_text",
      "edit_anchored_text",
      "apply_patch",
      "list_dir",
      "grep_text",
      "glob_paths",
    ]);
  });

  it("reads bounded text through the runtime workspace", async () => {
    const { ctx } = await createWorkspace({
      "README.md": "# Title\nfirst\nsecond\nthird\n",
    });
    const tool = getTool<ReadTextInput, ReadTextResult>(
      createCodingTools(),
      "read_text",
    );

    const result = await tool.execute(
      { path: "README.md", startLine: 2, endLine: 3 },
      ctx,
    );

    expect(result).toMatchObject({
      path: "README.md",
      content: "first\nsecond",
      startLine: 2,
      endLine: 3,
      lineCount: 4,
      truncated: true,
    });
  });

  it("reads anchors and applies anchored edits through the workspace", async () => {
    const { root, ctx } = await createWorkspace({
      "README.md": "alpha\nbeta\ngamma\n",
    });
    const tools = createCodingTools({ workspaceRoot: root });
    const readAnchored = getTool<ReadAnchoredTextInput, ReadAnchoredTextResult>(
      tools,
      "read_anchored_text",
    );
    const editAnchored = getTool<EditAnchoredTextInput, EditAnchoredTextResult>(
      tools,
      "edit_anchored_text",
    );

    const anchored = await readAnchored.execute({ path: "README.md" }, ctx);
    const beta = anchored.lines.find((line) => line.content === "beta");

    expect(beta?.anchor).toMatch(/2#[A-Z0-9]{4}/);

    const result = await editAnchored.execute(
      {
        path: "README.md",
        reason: "replace beta",
        edits: [
          {
            op: "replace",
            anchor: beta!.anchor,
            lines: ["bravo"],
          },
        ],
      },
      ctx,
    );

    expect(result.changed).toBe(true);
    expect(result.anchors).toEqual([
      {
        anchor: beta!.anchor,
        line: 2,
        op: "replace",
      },
    ]);
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "alpha\nbravo\ngamma\n",
    );
  });

  it("applies a unified-diff patch through the workspace", async () => {
    const { root, ctx } = await createWorkspace({
      "app.ts": "one\ntwo\nthree\nfour\n",
    });
    const tool = getTool<ApplyPatchInput, ApplyPatchResult>(
      createCodingTools({ workspaceRoot: root }),
      "apply_patch",
    );

    const result = await tool.execute(
      {
        path: "app.ts",
        reason: "rename two",
        patch: [
          "--- a/app.ts",
          "+++ b/app.ts",
          "@@ -1,4 +1,4 @@",
          " one",
          "-two",
          "+TWO",
          " three",
          " four",
          "",
        ].join("\n"),
      },
      ctx,
    );

    expect(result).toMatchObject({ changed: true, hunksApplied: 1 });
    await expect(readFile(join(root, "app.ts"), "utf8")).resolves.toBe(
      "one\nTWO\nthree\nfour\n",
    );
  });

  describe("applyUnifiedDiff", () => {
    it("matches hunk context with trailing-whitespace tolerance", () => {
      const before = "alpha   \nbeta\n";
      const patch = [
        "@@ -1,2 +1,2 @@",
        " alpha", // file has trailing spaces; fuzzy match succeeds
        "-beta",
        "+BETA",
        "",
      ].join("\n");
      const { content, hunksApplied } = applyUnifiedDiff(before, patch);
      expect(content).toBe("alpha   \nBETA\n");
      expect(hunksApplied).toBe(1);
    });

    it("applies multiple hunks in order via a running cursor", () => {
      const before = "a\nb\nc\nd\ne\nf\n";
      const patch = [
        "@@ -1,1 +1,1 @@",
        "-a",
        "+A",
        "@@ -5,1 +5,1 @@",
        "-e",
        "+E",
        "",
      ].join("\n");
      const { content, hunksApplied } = applyUnifiedDiff(before, patch);
      expect(content).toBe("A\nb\nc\nd\nE\nf\n");
      expect(hunksApplied).toBe(2);
    });

    it("inserts pure-addition hunks at the hinted line", () => {
      const before = "a\nb\n";
      const patch = ["@@ -1,0 +2,1 @@", "+inserted", ""].join("\n");
      const { content } = applyUnifiedDiff(before, patch);
      expect(content).toBe("a\ninserted\nb\n");
    });

    it("rejects a hunk that does not match instead of guessing", () => {
      const before = "one\ntwo\n";
      const patch = ["@@ -1,1 +1,1 @@", "-nonexistent", "+x", ""].join("\n");
      expect(() => applyUnifiedDiff(before, patch)).toThrow(/did not match/);
    });

    it("throws when the patch has no hunks", () => {
      expect(() => applyUnifiedDiff("a\n", "--- a\n+++ b\n")).toThrow(
        /no hunks/,
      );
    });
  });

  it("lists workspace directories with hidden files excluded by default", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const value = 1;\n",
      ".secret": "hidden\n",
      "README.md": "# Demo\n",
    });
    const tool = getTool<ListDirInput, ListDirResult>(
      createCodingTools({ workspaceRoot: root }),
      "list_dir",
    );

    const result = await tool.execute({ path: ".", recursive: true }, ctx);
    const entries = result.entries.map((entry) => pickEntry(entry));

    expect(entries).toEqual([
      { path: "src", type: "directory" },
      { path: "README.md", type: "file" },
      { path: "src/index.ts", type: "file" },
    ]);
  });

  it("greps text files using workspace reads", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const answer = 42;\n",
      "src/other.ts": "const label = 'Answer';\n",
      "README.md": "no match here\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep_text",
    );

    const result = await tool.execute(
      {
        pattern: "answer",
        path: "src",
        caseSensitive: false,
        include: ["**/*.ts"],
      },
      ctx,
    );

    expect(result.matches).toEqual([
      {
        path: "src/index.ts",
        line: 1,
        column: 14,
        text: "export const answer = 42;",
      },
      {
        path: "src/other.ts",
        line: 1,
        column: 16,
        text: "const label = 'Answer';",
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("treats an empty include array as no filter, not match-nothing", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const answer = 42;\n",
      "README.md": "answer in docs\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep_text",
    );

    const result = await tool.execute({ pattern: "answer", include: [] }, ctx);

    expect(result.matches.map((match) => match.path).sort()).toEqual([
      "README.md",
      "src/index.ts",
    ]);
  });

  it("rejects grep_text file paths with recovery guidance", async () => {
    const { root, ctx } = await createWorkspace({
      "README.md": "# Demo\nrelease:check\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep_text",
    );

    await expect(
      tool.execute({ pattern: "release:check", path: "README.md" }, ctx),
    ).rejects.toMatchObject({
      code: "TOOL_ARGUMENTS_INVALID",
      message: expect.stringContaining("path is not a directory"),
    });
    await expect(
      tool.execute({ pattern: "release:check", path: "README.md" }, ctx),
    ).rejects.toThrow("Use path='.'");
  });

  it("matches workspace-relative glob paths", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const value = 1;\n",
      "src/index.test.ts": "import { value } from './index.js';\n",
      "README.md": "# Demo\n",
    });
    const tool = getTool<GlobPathsInput, GlobPathsResult>(
      createCodingTools({ workspaceRoot: root }),
      "glob_paths",
    );

    const result = await tool.execute(
      { patterns: ["src/**/*.ts"], exclude: ["**/*.test.ts"] },
      ctx,
    );

    expect(result).toEqual({
      patterns: ["src/**/*.ts"],
      paths: ["src/index.ts"],
      truncated: false,
      offset: 0,
      totalPaths: 1,
      hasMore: false,
    });
  });

  it("expands brace alternation in glob patterns", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const value = 1;\n",
      "src/index.js": "module.exports = 1;\n",
      "src/types.d.ts": "export declare const value: number;\n",
      "README.md": "# Demo\n",
    });
    const tool = getTool<GlobPathsInput, GlobPathsResult>(
      createCodingTools({ workspaceRoot: root }),
      "glob_paths",
    );

    const result = await tool.execute(
      { patterns: ["src/**/*.{ts,js,d.ts}"] },
      ctx,
    );

    expect(result).toMatchObject({
      paths: ["src/index.js", "src/index.ts", "src/types.d.ts"],
      totalPaths: 3,
      hasMore: false,
    });
  });

  it("excludes build output by default and opts back in with includeBuildOutput", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const value = 1;\n",
      "dist/index.js": "module.exports = 1;\n",
      "packages/a/src/a.ts": "export const a = 1;\n",
      "packages/a/dist/a.js": "module.exports = 1;\n",
      "coverage/lcov.info": "TN:\n",
    });
    const tool = getTool<GlobPathsInput, GlobPathsResult>(
      createCodingTools({ workspaceRoot: root }),
      "glob_paths",
    );

    // Default: dist/coverage mirrors are filtered out, leaving only source.
    const defaultResult = await tool.execute(
      { patterns: ["**/*.{ts,js}", "**/*.info"] },
      ctx,
    );
    expect(defaultResult.paths).toEqual([
      "packages/a/src/a.ts",
      "src/index.ts",
    ]);

    // Opt-in: the generated mirror and coverage artifacts come back.
    const withBuild = await tool.execute(
      { patterns: ["**/*.{ts,js}", "**/*.info"], includeBuildOutput: true },
      ctx,
    );
    expect(withBuild.paths).toEqual([
      "coverage/lcov.info",
      "dist/index.js",
      "packages/a/dist/a.js",
      "packages/a/src/a.ts",
      "src/index.ts",
    ]);
  });

  it("treats unbalanced braces as literal characters", async () => {
    const { root, ctx } = await createWorkspace({
      "weird{name.ts": "export const value = 1;\n",
      "src/index.ts": "export const value = 1;\n",
    });
    const tool = getTool<GlobPathsInput, GlobPathsResult>(
      createCodingTools({ workspaceRoot: root }),
      "glob_paths",
    );

    const result = await tool.execute({ patterns: ["weird{name.ts"] }, ctx);

    expect(result).toMatchObject({
      paths: ["weird{name.ts"],
      totalPaths: 1,
      hasMore: false,
    });
  });

  it("normalizes absolute glob paths inside the workspace", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const value = 1;\n",
      "src/index.test.ts": "import { value } from './index.js';\n",
    });
    const tool = getTool<GlobPathsInput, GlobPathsResult>(
      createCodingTools({ workspaceRoot: root }),
      "glob_paths",
    );

    const result = await tool.execute(
      { patterns: [`${root}/src/**/*.ts`], exclude: ["**/*.test.ts"] },
      ctx,
    );

    expect(result).toMatchObject({
      patterns: ["src/**/*.ts"],
      paths: ["src/index.ts"],
      totalPaths: 1,
      hasMore: false,
    });
  });

  it("normalizes an absolute discovery path inside the workspace", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const value = 1;\n",
      "README.md": "# Demo\n",
    });
    const tool = getTool<GlobPathsInput, GlobPathsResult>(
      createCodingTools({ workspaceRoot: root }),
      "glob_paths",
    );

    const result = await tool.execute(
      { path: `${root}/src`, patterns: ["src/*.ts"] },
      ctx,
    );

    expect(result).toMatchObject({
      patterns: ["src/*.ts"],
      paths: ["src/index.ts"],
      totalPaths: 1,
      hasMore: false,
    });
  });

  it("paginates glob path results with nextOffset", async () => {
    const { root, ctx } = await createWorkspace({
      "src/a.ts": "a\n",
      "src/b.ts": "b\n",
      "src/c.ts": "c\n",
    });
    const tool = getTool<GlobPathsInput, GlobPathsResult>(
      createCodingTools({ workspaceRoot: root }),
      "glob_paths",
    );

    const first = await tool.execute(
      { patterns: "src/*.ts", maxPaths: 2 },
      ctx,
    );
    const second = await tool.execute(
      { patterns: "src/*.ts", maxPaths: 2, offset: first.nextOffset },
      ctx,
    );

    expect(first).toMatchObject({
      paths: ["src/a.ts", "src/b.ts"],
      offset: 0,
      nextOffset: 2,
      totalPaths: 3,
      hasMore: true,
      truncated: true,
    });
    expect(second).toMatchObject({
      paths: ["src/c.ts"],
      offset: 2,
      totalPaths: 3,
      hasMore: false,
      truncated: false,
    });
  });

  it("does not recurse through a symlink that escapes the workspace", async () => {
    const { root, ctx } = await createWorkspace({
      "inside/keep.txt": "ok\n",
    });
    // Create a symlink inside the workspace that points at the system /etc.
    // The walker should report it as a `symlink` and refuse to recurse into
    // it (both because dirent type is not "directory", and because the
    // realpath defence would reject the escape).
    await symlink("/etc", join(root, "escape"));
    const tool = getTool<ListDirInput, ListDirResult>(
      createCodingTools({ workspaceRoot: root }),
      "list_dir",
    );

    const result = await tool.execute({ path: ".", recursive: true }, ctx);
    const paths = result.entries.map((entry) => entry.path);
    // The symlink itself is visible at the root, but no /etc descendants are.
    expect(paths).toContain("escape");
    expect(paths.some((p) => p.startsWith("escape/"))).toBe(false);
    expect(paths).toContain("inside/keep.txt");
  });

  it("rejects oversized regex patterns in grep_text", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "value = 1\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep_text",
    );
    const huge = "a".repeat(2000);
    await expect(
      tool.execute({ pattern: huge, regex: true, path: "src" }, ctx),
    ).rejects.toThrow(/ReDoS|exceeds/);
  });

  it("sorts list_dir entries with directories first, then by stable type order", async () => {
    const { root, ctx } = await createWorkspace({
      "a-dir/keep.txt": "x\n",
      "b-file.txt": "y\n",
    });
    // Add a symlink so the type-order branch is exercised.
    await symlink("a-dir/keep.txt", join(root, "c-link"));
    const tool = getTool<ListDirInput, ListDirResult>(
      createCodingTools({ workspaceRoot: root }),
      "list_dir",
    );

    const result = await tool.execute({ path: "." }, ctx);
    const order = result.entries.map((entry) => ({
      path: entry.path,
      type: entry.type,
    }));
    // directory (0) < file (1) < symlink (2)
    expect(order).toEqual([
      { path: "a-dir", type: "directory" },
      { path: "b-file.txt", type: "file" },
      { path: "c-link", type: "symlink" },
    ]);
  });

  it("rejects discovery paths that escape the workspace", async () => {
    const { root, ctx } = await createWorkspace({
      "README.md": "# Demo\n",
    });
    const tool = getTool<ListDirInput, ListDirResult>(
      createCodingTools({ workspaceRoot: root }),
      "list_dir",
    );

    await expect(tool.execute({ path: "../" }, ctx)).rejects.toThrow(
      "Path escapes workspace root",
    );
  });

  it("normalizes an absolute grep_text path inside the workspace", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const value = 1;\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep_text",
    );

    // A model routinely reuses the absolute path it saw in the skill/file
    // index; grep_text must accept an in-workspace absolute path the same way
    // read_text and glob_paths do, rather than rejecting it as an escape.
    const result = await tool.execute(
      { pattern: "value", path: `${root}/src` },
      ctx,
    );

    expect(result.matches.map((match) => match.path)).toContain("src/index.ts");
  });

  it("normalizes an absolute list_dir path inside the workspace", async () => {
    const { root, ctx } = await createWorkspace({
      "README.md": "# Demo\n",
      "src/index.ts": "export const value = 1;\n",
    });
    const tool = getTool<ListDirInput, ListDirResult>(
      createCodingTools({ workspaceRoot: root }),
      "list_dir",
    );

    const result = await tool.execute({ path: root }, ctx);

    expect(result.path).toBe(".");
    expect(result.entries.map((entry) => entry.path)).toContain("README.md");
  });
});

async function createWorkspace(files: Record<string, string>) {
  const rawRoot = await mkdtemp(join(tmpdir(), "sparkwright-coding-tools-"));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(rawRoot, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  const root = await realpath(rawRoot);

  const ctx: RuntimeContext = {
    run: {
      id: createRunId(),
      goal: "test",
      state: "running",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metadata: {},
    },
    workspace: new LocalWorkspace(root),
  };

  return { root, ctx };
}

function getTool<TArgs, TResult>(
  tools: ToolDefinition[],
  name: string,
): ToolDefinition<TArgs, TResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool as ToolDefinition<TArgs, TResult>;
}

function pickEntry(entry: DirectoryEntry) {
  return {
    path: entry.path,
    type: entry.type,
  };
}
