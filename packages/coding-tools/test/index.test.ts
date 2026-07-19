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
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createRunId,
  type RuntimeContext,
  type ToolDefinition,
} from "@sparkwright/core";
import { LocalWorkspace } from "@sparkwright/core/internal";
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
  type WriteFileInput,
  type WriteFileResult,
} from "../src/index.js";

describe("coding tools", () => {
  it("creates the official coding tool set", () => {
    expect(createCodingTools().map((tool) => tool.name)).toEqual([
      "read_text",
      "read_anchored_text",
      "write",
      "edit_anchored_text",
      "edit",
      "list_dir",
      "grep",
      "glob",
    ]);
  });

  it("declares result presentation hints for read and discovery tools", () => {
    const tools = new Map(createCodingTools().map((tool) => [tool.name, tool]));

    expect(tools.get("read_text")?.resultPresentation).toMatchObject({
      kind: "file_read",
      preserveFields: expect.arrayContaining(["path", "content", "truncated"]),
    });
    expect(tools.get("list_dir")?.resultPresentation).toMatchObject({
      kind: "file_discovery",
      preserveFields: expect.arrayContaining([
        "entries",
        "entriesReturned",
        "entryLimitHit",
      ]),
    });
    expect(tools.get("grep")?.resultPresentation).toMatchObject({
      kind: "text_search",
      preserveFields: expect.arrayContaining([
        "matches",
        "filesScanned",
        "matchesReturned",
        "scope",
      ]),
    });
    expect(tools.get("glob")?.resultPresentation).toMatchObject({
      kind: "file_discovery",
    });
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

  it("normalizes file URL read_text paths", async () => {
    const { root, ctx } = await createWorkspace({
      "docs/README.md": "# Docs\n",
    });
    const tool = getTool<ReadTextInput, ReadTextResult>(
      createCodingTools(),
      "read_text",
    );

    const result = await tool.execute(
      { path: pathToFileURL(join(root, "docs/README.md")).href },
      ctx,
    );

    expect(result).toMatchObject({
      path: "docs/README.md",
      content: "# Docs",
    });
  });

  it("reports coding tool input validation failures as tool argument errors", async () => {
    const { root, ctx } = await createWorkspace({
      "README.md": "# Demo\n",
    });
    const tools = createCodingTools({ workspaceRoot: root });
    const readText = getTool<ReadTextInput, ReadTextResult>(tools, "read_text");
    const editAnchored = getTool<EditAnchoredTextInput, EditAnchoredTextResult>(
      tools,
      "edit_anchored_text",
    );
    const globPaths = getTool<GlobPathsInput, GlobPathsResult>(tools, "glob");

    await expect(
      readText.execute({ path: "README.md", startLine: 3, endLine: 1 }, ctx),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
    await expect(
      editAnchored.execute({ path: "README.md", edits: [] }, ctx),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
    await expect(
      globPaths.execute({ patterns: [] }, ctx),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
  });

  it("declares semantic validateInput checks on coding tools", async () => {
    const { root, ctx } = await createWorkspace({
      "app/[slug]/page.tsx": "export default function Page() {}\n",
      "docs/README.md": "# Docs\n",
      "src/index.ts": "export const value = 1;\n",
    });
    const tools = createCodingTools({ workspaceRoot: root });
    const readText = getTool<ReadTextInput, ReadTextResult>(tools, "read_text");
    const writeFile = getTool<WriteFileInput, WriteFileResult>(tools, "write");
    const grep = getTool<GrepTextInput, GrepTextResult>(tools, "grep");
    const glob = getTool<GlobPathsInput, GlobPathsResult>(tools, "glob");

    expect(readText.validateInput).toBeDefined();
    expect(writeFile.validateInput).toBeDefined();
    expect(grep.validateInput).toBeDefined();
    expect(glob.validateInput).toBeDefined();
    const readValidation = await Promise.resolve(
      readText.validateInput!({ path: "app/[slug]/page.tsx" }, ctx),
    );
    const writeValidation = await Promise.resolve(
      writeFile.validateInput!(
        { path: "docs/", content: "replacement\n" },
        ctx,
      ),
    );
    const literalWildcardWriteValidation = await Promise.resolve(
      writeFile.validateInput!(
        { path: "src/literal*?.txt", content: "literal\n" },
        ctx,
      ),
    );
    const grepValidation = await Promise.resolve(
      grep.validateInput!({ pattern: "(", regex: true }, ctx),
    );
    const globValidation = await Promise.resolve(
      glob.validateInput!({ patterns: [""], path: "src" }, ctx),
    );
    const bracketPathGlobValidation = await Promise.resolve(
      glob.validateInput!({ patterns: ["*.tsx"], path: "app/[slug]" }, ctx),
    );
    const bracketRead = await readText.execute(
      { path: "app/[slug]/page.tsx" },
      ctx,
    );

    expect(readValidation).toMatchObject({
      ok: true,
    });
    expect(writeValidation).toMatchObject({
      ok: false,
      code: "TOOL_ARGUMENTS_INVALID",
      metadata: { reason: "directory_path", path: "docs/" },
    });
    expect(literalWildcardWriteValidation).toMatchObject({ ok: true });
    expect(grepValidation).toMatchObject({
      ok: false,
      code: "TOOL_ARGUMENTS_INVALID",
      metadata: { reason: "invalid_regex", pattern: "(" },
    });
    expect(globValidation).toMatchObject({
      ok: false,
      code: "TOOL_ARGUMENTS_INVALID",
      metadata: { reason: "empty_pattern" },
    });
    expect(bracketPathGlobValidation).toMatchObject({ ok: true });
    expect(bracketRead.content).toContain("Page");
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
      "edit",
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

  it("creates a nested UTF-8 file through the workspace write path", async () => {
    const { root, ctx } = await createWorkspace({});
    const tool = getTool<WriteFileInput, WriteFileResult>(
      createCodingTools({ workspaceRoot: root }),
      "write",
    );

    const result = await tool.execute(
      {
        path: "notes/demo.md",
        content: "# Demo\n\nhello\n",
        reason: "create note",
      },
      ctx,
    );

    expect(result).toMatchObject({
      path: "notes/demo.md",
      changed: true,
      created: true,
      bytes: "# Demo\n\nhello\n".length,
      lineCount: 3,
    });
    await expect(readFile(join(root, "notes/demo.md"), "utf8")).resolves.toBe(
      "# Demo\n\nhello\n",
    );
  });

  it("allows empty file content and can refuse to overwrite", async () => {
    const { root, ctx } = await createWorkspace({
      "existing.txt": "keep\n",
    });
    const tool = getTool<WriteFileInput, WriteFileResult>(
      createCodingTools({ workspaceRoot: root }),
      "write",
    );

    const created = await tool.execute(
      { path: "empty.txt", content: "", reason: "touch empty file" },
      ctx,
    );
    expect(created).toMatchObject({
      path: "empty.txt",
      changed: true,
      created: true,
      bytes: 0,
      lineCount: 0,
    });
    await expect(readFile(join(root, "empty.txt"), "utf8")).resolves.toBe("");

    await expect(
      tool.execute(
        { path: "existing.txt", content: "replace\n", overwrite: false },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
    await expect(readFile(join(root, "existing.txt"), "utf8")).resolves.toBe(
      "keep\n",
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
    expect(result).toMatchObject({
      entriesReturned: 3,
      entryLimitHit: false,
    });
  });

  it("greps text files using workspace reads", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const answer = 42;\n",
      "src/other.ts": "const label = 'Answer';\n",
      "README.md": "no match here\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep",
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
    expect(result).toMatchObject({
      truncated: false,
      filesScanned: 2,
      filesMatched: 2,
      matchesReturned: 2,
      fileLimitHit: false,
      matchLimitHit: false,
      effectiveInclude: ["**/*.ts"],
      scope: {
        path: "src",
        include: ["**/*.ts"],
        includeHidden: false,
        includeBuildOutput: false,
        regex: false,
        caseSensitive: false,
        maxMatches: 200,
        maxLineChars: 500,
        maxPaths: 500,
      },
    });
  });

  it("treats an empty include array as no filter, not match-nothing", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const answer = 42;\n",
      "README.md": "answer in docs\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep",
    );

    const result = await tool.execute({ pattern: "answer", include: [] }, ctx);

    expect(result.matches.map((match) => match.path).sort()).toEqual([
      "README.md",
      "src/index.ts",
    ]);
  });

  it("treats blank grep include entries as no filter", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const answer = 42;\n",
      "README.md": "answer in docs\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep",
    );

    const result = await tool.execute(
      { pattern: "answer", include: [""] },
      ctx,
    );

    expect(result).toMatchObject({
      effectiveInclude: ["**/*"],
      filesScanned: 2,
      matchesReturned: 2,
    });
    expect(result.matches.map((match) => match.path).sort()).toEqual([
      "README.md",
      "src/index.ts",
    ]);
  });

  it("reports grep match-limit truncation metadata", async () => {
    const { root, ctx } = await createWorkspace({
      "src/a.ts": "needle one\nneedle two\n",
      "src/b.ts": "needle three\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep",
    );

    const result = await tool.execute(
      { pattern: "needle", path: "src", maxMatches: 1 },
      ctx,
    );

    expect(result).toMatchObject({
      truncated: true,
      truncationReason: "match_limit",
      filesScanned: 1,
      filesMatched: 1,
      matchesReturned: 1,
      fileLimitHit: false,
      matchLimitHit: true,
    });
  });

  it("searches a concrete grep file path", async () => {
    const { root, ctx } = await createWorkspace({
      "README.md": "# Demo\nrelease:check\n",
      "src/other.md": "release:check\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep",
    );

    const result = await tool.execute(
      { pattern: "release:check", path: "README.md" },
      ctx,
    );

    expect(result.matches.map((match) => match.path)).toEqual(["README.md"]);
  });

  it("normalizes file URL grep paths inside the workspace", async () => {
    const { root, ctx } = await createWorkspace({
      "docs/README.md": "# Demo\nrelease:check\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep",
    );

    const result = await tool.execute(
      {
        pattern: "release:check",
        path: pathToFileURL(join(root, "docs/README.md")).href,
      },
      ctx,
    );

    expect(result.matches.map((match) => match.path)).toEqual([
      "docs/README.md",
    ]);
  });

  it("matches workspace-relative glob paths", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const value = 1;\n",
      "src/index.test.ts": "import { value } from './index.js';\n",
      "README.md": "# Demo\n",
    });
    const tool = getTool<GlobPathsInput, GlobPathsResult>(
      createCodingTools({ workspaceRoot: root }),
      "glob",
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
      "glob",
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
      "glob",
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

  it("excludes runtime session state from glob and grep by default", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const marker = 'source-only';\n",
      ".sparkwright/sessions/session_1/trace.jsonl":
        '{"type":"tool.completed","payload":"source-only"}\n',
      ".sparkwright/sessions/session_1/agents/main/runs/run_1/result.json":
        '{"summary":"source-only"}\n',
    });
    const tools = createCodingTools({ workspaceRoot: root });
    const glob = getTool<GlobPathsInput, GlobPathsResult>(tools, "glob");
    const grep = getTool<GrepTextInput, GrepTextResult>(tools, "grep");

    const globResult = await glob.execute(
      {
        patterns: ["**/*"],
        includeHidden: true,
        includeBuildOutput: true,
      },
      ctx,
    );
    expect(globResult.paths).toContain("src/index.ts");
    expect(globResult.paths).not.toContain(".sparkwright/sessions");
    expect(globResult.paths).not.toContain(
      ".sparkwright/sessions/session_1/trace.jsonl",
    );
    expect(globResult.paths).not.toContain(
      ".sparkwright/sessions/session_1/agents/main/runs/run_1/result.json",
    );

    const result = await grep.execute(
      {
        pattern: "source-only",
        includeHidden: true,
        includeBuildOutput: true,
      },
      ctx,
    );
    expect(result.matches.map((match) => match.path)).toEqual(["src/index.ts"]);
  });

  it("treats unbalanced braces as literal characters", async () => {
    const { root, ctx } = await createWorkspace({
      "weird{name.ts": "export const value = 1;\n",
      "src/index.ts": "export const value = 1;\n",
    });
    const tool = getTool<GlobPathsInput, GlobPathsResult>(
      createCodingTools({ workspaceRoot: root }),
      "glob",
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
      "glob",
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
      "glob",
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
      "glob",
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

  it("rejects oversized regex patterns in grep", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "value = 1\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep",
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
    await expect(tool.execute({ path: "../" }, ctx)).rejects.toMatchObject({
      code: "TOOL_ARGUMENTS_INVALID",
    });
  });

  it("normalizes an absolute grep path inside the workspace", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const value = 1;\n",
    });
    const tool = getTool<GrepTextInput, GrepTextResult>(
      createCodingTools({ workspaceRoot: root }),
      "grep",
    );

    // A model routinely reuses the absolute path it saw in the skill/file
    // index; grep must accept an in-workspace absolute path the same way
    // read_text and glob do, rather than rejecting it as an escape.
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

  it("normalizes an equivalent absolute workspace path through a symlink alias", async () => {
    const { root, ctx } = await createWorkspace({
      "src/index.ts": "export const value = 1;\n",
    });
    const aliasParent = await mkdtemp(
      join(tmpdir(), "sparkwright-coding-tools-alias-"),
    );
    const aliasRoot = join(aliasParent, "workspace");
    await symlink(root, aliasRoot, "dir");
    const tools = createCodingTools({ workspaceRoot: root });
    const glob = getTool<GlobPathsInput, GlobPathsResult>(tools, "glob");
    const grep = getTool<GrepTextInput, GrepTextResult>(tools, "grep");
    const list = getTool<ListDirInput, ListDirResult>(tools, "list_dir");

    await expect(
      glob.validateInput!(
        {
          path: aliasRoot,
          patterns: [`${aliasRoot}/src/**/*.ts`],
        },
        ctx,
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      grep.validateInput!({ pattern: "value", path: `${aliasRoot}/src` }, ctx),
    ).resolves.toMatchObject({ ok: true });

    const globResult = await glob.execute(
      { patterns: [`${aliasRoot}/src/**/*.ts`] },
      ctx,
    );
    const listResult = await list.execute({ path: `${aliasRoot}/src` }, ctx);

    expect(globResult).toMatchObject({
      patterns: ["src/**/*.ts"],
      paths: ["src/index.ts"],
    });
    expect(listResult.path).toBe("src");
    expect(listResult.entries.map((entry) => entry.path)).toContain(
      "src/index.ts",
    );
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
