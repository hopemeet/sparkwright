import { opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineTool,
  type AnchoredEditOperation,
  type RuntimeContext,
  type ToolDefinition,
  type ToolInputValidationResult,
} from "@sparkwright/core";

const DEFAULT_MAX_READ_CHARS = 200_000;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_MAX_PATHS = 500;
const DEFAULT_MAX_LINE_CHARS = 500;
// Cap user-supplied regex source length to bound RegExp compilation and to
// make catastrophic-backtracking patterns expensive to construct. Plain text
// search is not affected.
const MAX_REGEX_PATTERN_CHARS = 1_000;
const DEFAULT_EXCLUDE_GLOBS = [
  ".git/**",
  "**/.git/**",
  "node_modules/**",
  "**/node_modules/**",
  ".sparkwright/sessions",
  ".sparkwright/sessions/**",
  "**/.sparkwright/sessions",
  "**/.sparkwright/sessions/**",
  ".sparkwright/runs",
  ".sparkwright/runs/**",
  "**/.sparkwright/runs",
  "**/.sparkwright/runs/**",
];

// Build output and tooling caches that almost always pollute file discovery
// (a `glob`/`grep` over source should not return the compiled
// mirror of that source). Excluded by default; callers that genuinely need to
// inspect generated output opt back in with `includeBuildOutput: true`.
const DEFAULT_BUILD_OUTPUT_EXCLUDE_GLOBS = [
  "dist/**",
  "**/dist/**",
  "build/**",
  "**/build/**",
  "coverage/**",
  "**/coverage/**",
];

/**
 * Compose the default exclude set. `.git`/`node_modules` are always excluded;
 * build output is excluded unless the caller opts in with `includeBuildOutput`.
 */
function defaultExcludeGlobs(includeBuildOutput: boolean): string[] {
  return includeBuildOutput
    ? [...DEFAULT_EXCLUDE_GLOBS]
    : [...DEFAULT_EXCLUDE_GLOBS, ...DEFAULT_BUILD_OUTPUT_EXCLUDE_GLOBS];
}

export interface CodingToolsOptions {
  /**
   * Workspace root used by discovery tools (`list_dir`, `grep`,
   * `glob`). Text reads and writes still execute through
   * `RuntimeContext.workspace`.
   */
  workspaceRoot?: string | ((ctx: RuntimeContext) => string | Promise<string>);
  maxReadChars?: number;
  maxEntries?: number;
  maxMatches?: number;
  maxPaths?: number;
  maxLineChars?: number;
  includeHidden?: boolean;
  exclude?: string[];
}

export type CodingToolName =
  | "read_text"
  | "read_anchored_text"
  | "write_file"
  | "edit_anchored_text"
  | "apply_patch"
  | "list_dir"
  | "grep"
  | "glob";

export interface ReadTextInput {
  path: string;
  startLine?: number;
  endLine?: number;
  maxChars?: number;
}

export interface ReadTextResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  truncated: boolean;
}

export type ReadAnchoredTextInput = ReadTextInput;

export interface ReadAnchoredTextResult {
  path: string;
  anchorSetId: string;
  lineCount: number;
  content: string;
  lines: Array<{
    line: number;
    anchor: string;
    content: string;
  }>;
  metadata: Record<string, unknown>;
  truncated: boolean;
}

export interface EditAnchoredTextInput {
  path: string;
  edits: AnchoredEditOperation[];
  reason?: string;
}

export interface EditAnchoredTextResult {
  path: string;
  /** @reserved Public tool-output field consumed by coding UIs. */
  changed: boolean;
  content: string;
  anchors: Array<{
    anchor: string;
    line: number;
    op: AnchoredEditOperation["op"];
  }>;
}

export interface ApplyPatchInput {
  path: string;
  /** A unified diff. File headers (`---`/`+++`) are optional; hunks required. */
  patch: string;
  reason?: string;
}

export interface ApplyPatchResult {
  path: string;
  /** @reserved Public tool-output field consumed by coding UIs. */
  changed: boolean;
  content: string;
  /** @reserved Public tool-output field consumed by coding UIs. */
  hunksApplied: number;
}

export interface WriteFileInput {
  path: string;
  content: string;
  reason?: string;
  /** Refuse to replace an existing file when false. Default true. */
  overwrite?: boolean;
}

export interface WriteFileResult {
  path: string;
  /** @reserved Public tool-output field consumed by coding UIs. */
  changed: boolean;
  created: boolean;
  bytes: number;
  lineCount: number;
}

export interface ListDirInput {
  path?: string;
  recursive?: boolean;
  includeHidden?: boolean;
  maxEntries?: number;
}

export interface ListDirResult {
  path: string;
  entries: DirectoryEntry[];
  truncated: boolean;
  entriesReturned: number;
  entryLimitHit: boolean;
}

export interface DirectoryEntry {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
}

export interface GrepTextInput {
  pattern: string;
  path?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  includeHidden?: boolean;
  include?: string[];
  exclude?: string[];
  /** Search build output (dist/build/coverage) too. Default false. */
  includeBuildOutput?: boolean;
  maxMatches?: number;
  maxLineChars?: number;
}

export interface GrepTextResult {
  pattern: string;
  /** @reserved Public tool-output field consumed by coding UIs. */
  matches: TextMatch[];
  truncated: boolean;
  truncationReason?: GrepTextTruncationReason;
  filesScanned: number;
  filesMatched: number;
  matchesReturned: number;
  fileLimitHit: boolean;
  matchLimitHit: boolean;
  scope: GrepTextScope;
  effectiveInclude: string[];
}

export type GrepTextTruncationReason =
  | "file_limit"
  | "match_limit"
  | "file_and_match_limit";

export interface GrepTextScope {
  path: string;
  include: string[];
  exclude: string[];
  includeHidden: boolean;
  includeBuildOutput: boolean;
  regex: boolean;
  caseSensitive: boolean;
  maxMatches: number;
  maxLineChars: number;
  maxPaths: number;
}

export interface TextMatch {
  path: string;
  line: number;
  /** @reserved Public tool-output field consumed by coding UIs. */
  column: number;
  text: string;
}

export interface GlobPathsInput {
  patterns: string | string[];
  path?: string;
  includeHidden?: boolean;
  exclude?: string[];
  /** Include build output (dist/build/coverage) in results. Default false. */
  includeBuildOutput?: boolean;
  maxPaths?: number;
  offset?: number;
}

export interface GlobPathsResult {
  patterns: string[];
  paths: string[];
  truncated: boolean;
  offset: number;
  nextOffset?: number;
  totalPaths?: number;
  hasMore: boolean;
}

type NormalizedGlobPathsInput = Omit<Required<GlobPathsInput>, "patterns"> & {
  patterns: string[];
};

export function createCodingTools(
  options: CodingToolsOptions = {},
): ToolDefinition[] {
  return [
    createReadTextTool(options),
    createReadAnchoredTextTool(options),
    createWriteFileTool(),
    createEditAnchoredTextTool(),
    createApplyPatchTool(),
    createListDirTool(options),
    createGrepTextTool(options),
    createGlobPathsTool(options),
  ];
}

export function createReadTextTool(
  options: CodingToolsOptions = {},
): ToolDefinition<ReadTextInput, ReadTextResult> {
  return defineTool<ReadTextInput, ReadTextResult>({
    name: "read_text",
    description: "Read a UTF-8 text file from the configured workspace.",
    inputSchema: readTextInputSchema,
    policy: { risk: "safe" },
    governance: readGovernance(),
    resultPresentation: {
      kind: "file_read",
      preserveFields: [
        "path",
        "content",
        "startLine",
        "endLine",
        "lineCount",
        "truncated",
      ],
      paginationFields: ["startLine", "endLine"],
      artifactPolicy: "when_large",
    },
    previewArgs(args) {
      return previewPathWindow(args, "startLine", "endLine");
    },
    async validateInput(args, ctx) {
      const input = normalizeReadTextInput(args, options);
      return validateExistingFileInput("read_text", input.path, ctx, options);
    },
    async execute(args, ctx) {
      const workspace = requireWorkspace(ctx);
      const input = normalizeReadTextInput(args, options);
      const content = await workspace.readText(input.path);
      const sliced = sliceText(content, input);
      return {
        path: await canonicalOutputPath(ctx, input.path),
        content: sliced.content,
        startLine: sliced.startLine,
        endLine: sliced.endLine,
        lineCount: sliced.lineCount,
        truncated: sliced.truncated,
      };
    },
  });
}

export function createReadAnchoredTextTool(
  options: CodingToolsOptions = {},
): ToolDefinition<ReadAnchoredTextInput, ReadAnchoredTextResult> {
  return defineTool<ReadAnchoredTextInput, ReadAnchoredTextResult>({
    name: "read_anchored_text",
    description:
      "Read a UTF-8 text file with stable per-line anchors for verified edits.",
    inputSchema: readTextInputSchema,
    policy: { risk: "safe" },
    governance: readGovernance(),
    resultPresentation: {
      kind: "file_read",
      preserveFields: [
        "path",
        "anchorSetId",
        "lineCount",
        "content",
        "lines",
        "metadata",
        "truncated",
      ],
      paginationFields: ["startLine", "endLine"],
      artifactPolicy: "when_large",
    },
    previewArgs(args) {
      return previewPathWindow(args, "startLine", "endLine");
    },
    async validateInput(args, ctx) {
      const input = normalizeReadTextInput(args, options);
      return validateExistingFileInput(
        "read_anchored_text",
        input.path,
        ctx,
        options,
      );
    },
    async execute(args, ctx) {
      const workspace = requireWorkspace(ctx);
      const input = normalizeReadTextInput(args, options);
      const anchored = await workspace.readAnchoredText(input.path);
      const selected = sliceAnchoredLines(anchored.lines, input);
      const content = selected.lines
        .map((line) => `${line.anchor}| ${line.content}`)
        .join("\n");
      const maxChars =
        input.maxChars ?? options.maxReadChars ?? DEFAULT_MAX_READ_CHARS;
      const bounded = limitString(content, maxChars);

      return {
        path: anchored.path,
        anchorSetId: anchored.anchorSetId,
        lineCount: anchored.lineCount,
        content: bounded.content,
        lines: selected.lines.map((line) => ({
          line: line.line,
          anchor: line.anchor,
          content: line.content,
        })),
        metadata: anchored.metadata,
        truncated: selected.truncated || bounded.truncated,
      };
    },
  });
}

export function createWriteFileTool(): ToolDefinition<
  WriteFileInput,
  WriteFileResult
> {
  return defineTool<WriteFileInput, WriteFileResult>({
    name: "write_file",
    description:
      "Create or replace a UTF-8 text file through the workspace write path. " +
      "Use this for new files or full-file replacement; parent directories are created automatically.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        content: {
          type: "string",
          description: "Complete UTF-8 file content.",
        },
        reason: { type: "string", description: "Why this write is needed." },
        overwrite: {
          type: "boolean",
          description:
            "When false, fail if the target already exists. Default true.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    governance: {
      sideEffects: ["write"],
      idempotency: "conditional",
      dataSensitivity: "internal",
      origin: {
        kind: "local",
        name: "@sparkwright/coding-tools",
        metadata: { managedWorkspaceWrite: true },
      },
    },
    previewArgs(args) {
      return previewString(previewRecord(args).path);
    },
    validateInput(args) {
      const input = normalizeWriteFileInput(args);
      return validateWritablePathInput("write_file", input.path);
    },
    isConcurrencySafe: () => false,
    async execute(args, ctx) {
      const workspace = requireWorkspace(ctx);
      const input = normalizeWriteFileInput(args);
      const before = await workspace.readText(input.path).catch((error) => {
        if (isNodeErrorCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (before !== undefined && input.overwrite === false) {
        throw toolArgumentsInvalid(
          `write_file target already exists: ${input.path}`,
        );
      }
      const changed = before !== input.content;
      if (changed) {
        await workspace.writeText(input.path, input.content, {
          reason: input.reason,
        });
      }
      return {
        path: await canonicalOutputPath(ctx, input.path),
        changed,
        created: before === undefined,
        bytes: input.content.length,
        lineCount:
          input.content.length === 0 ? 0 : splitLines(input.content).length,
      };
    },
  });
}

export function createEditAnchoredTextTool(): ToolDefinition<
  EditAnchoredTextInput,
  EditAnchoredTextResult
> {
  return defineTool<EditAnchoredTextInput, EditAnchoredTextResult>({
    name: "edit_anchored_text",
    description:
      "Apply verified per-line anchored text edits through the workspace write path. `replace` replaces only the anchored line; to replace a block, include delete edits for the old interior lines or use apply_patch.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["replace", "delete", "append", "prepend"],
                description:
                  "Line operation. `replace` affects only the single line named by `anchor`; it does not replace a surrounding function or block.",
              },
              anchor: {
                type: "string",
                description:
                  "Exact line anchor from read_anchored_text, for example `12#ABCD`.",
              },
              lines: {
                type: "array",
                items: { type: "string" },
                description: "Replacement or inserted lines. Omit for delete.",
              },
            },
            required: ["op", "anchor"],
            additionalProperties: false,
          },
        },
        reason: { type: "string", description: "Why this edit is needed." },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    governance: {
      sideEffects: ["write"],
      idempotency: "conditional",
      dataSensitivity: "internal",
      origin: {
        kind: "local",
        name: "@sparkwright/coding-tools",
        metadata: { managedWorkspaceWrite: true },
      },
    },
    previewArgs(args) {
      const r = previewRecord(args);
      const path = previewString(r.path);
      const editCount = Array.isArray(r.edits)
        ? ` · ${r.edits.length} edits`
        : "";
      return path ? `${path}${editCount}` : undefined;
    },
    async validateInput(args, ctx) {
      const input = normalizeEditAnchoredTextInput(args);
      return validateExistingFileInput(
        "edit_anchored_text",
        input.path,
        ctx,
        {},
      );
    },
    isConcurrencySafe: () => false,
    async execute(args, ctx) {
      const workspace = requireWorkspace(ctx);
      const input = normalizeEditAnchoredTextInput(args);
      const before = await workspace.readText(input.path);
      const result = await workspace.editAnchoredText(input.path, input.edits, {
        reason: input.reason,
      });
      return {
        path: await canonicalOutputPath(ctx, input.path),
        changed: before !== result.content,
        content: result.content,
        anchors: result.anchors,
      };
    },
  });
}

export function createApplyPatchTool(): ToolDefinition<
  ApplyPatchInput,
  ApplyPatchResult
> {
  return defineTool<ApplyPatchInput, ApplyPatchResult>({
    name: "apply_patch",
    description:
      "Apply a unified-diff patch to a file through the workspace write path. " +
      "Hunk context is matched with whitespace tolerance; ambiguous or " +
      "non-matching hunks are rejected rather than guessed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        patch: { type: "string" },
        reason: { type: "string" },
      },
      required: ["path", "patch"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    governance: {
      sideEffects: ["write"],
      idempotency: "conditional",
      dataSensitivity: "internal",
      origin: {
        kind: "local",
        name: "@sparkwright/coding-tools",
        metadata: { managedWorkspaceWrite: true },
      },
    },
    previewArgs(args) {
      return previewString(previewRecord(args).path);
    },
    async validateInput(args, ctx) {
      const input = normalizeApplyPatchInput(args);
      return validateExistingFileInput("apply_patch", input.path, ctx, {});
    },
    isConcurrencySafe: () => false,
    async execute(args, ctx) {
      const workspace = requireWorkspace(ctx);
      const input = normalizeApplyPatchInput(args);
      const before = await workspace.readText(input.path);
      const { content, hunksApplied } = applyUnifiedDiff(before, input.patch);
      if (content !== before) {
        await workspace.writeText(input.path, content, {
          reason: input.reason,
        });
      }
      return {
        path: await canonicalOutputPath(ctx, input.path),
        changed: content !== before,
        content,
        hunksApplied,
      };
    },
  });
}

function normalizeApplyPatchInput(args: ApplyPatchInput): ApplyPatchInput {
  assertRecord(args, "apply_patch input");
  const path = normalizeFileUrlPath(readString(args, "path"));
  const patch = readString(args, "patch");
  if (patch.trim() === "") {
    throw toolArgumentsInvalid("patch must be a non-empty string.");
  }
  const reason = typeof args.reason === "string" ? args.reason : undefined;
  return { path, patch, reason };
}

function normalizeWriteFileInput(args: WriteFileInput): WriteFileInput {
  assertRecord(args, "write_file input");
  const path = normalizeFileUrlPath(readString(args, "path"));
  const content = readStringAllowEmpty(args, "content");
  return {
    path,
    content,
    reason:
      typeof args.reason === "string" && args.reason.length > 0
        ? args.reason
        : undefined,
    overwrite: args.overwrite === false ? false : true,
  };
}

interface PatchLine {
  kind: " " | "-" | "+";
  text: string;
}

interface PatchHunk {
  /** 1-based source start line from the `@@` header, used as a search hint. */
  oldStart: number;
  /** The hunk body in order, markers preserved. */
  body: PatchLine[];
  /** Lines expected in the source (context + removed), in order. */
  source: string[];
}

/**
 * Apply a unified diff to `content`, returning the patched content and the
 * number of hunks applied. Hunks are located in order from a running cursor;
 * each is matched first exactly, then with trailing-whitespace tolerance.
 * A hunk that matches nowhere throws — the tool never applies a partial or
 * guessed patch.
 */
export function applyUnifiedDiff(
  content: string,
  patch: string,
): { content: string; hunksApplied: number } {
  const hunks = parseUnifiedDiff(patch);
  if (hunks.length === 0) {
    throw new Error("patch contains no hunks.");
  }

  const { lines, trailingNewline } = toLines(content);
  let cursor = 0;
  let applied = 0;

  for (const hunk of hunks) {
    const at = locateHunk(lines, hunk, cursor);
    if (at === -1) {
      throw new Error(
        `Patch hunk near line ${hunk.oldStart} did not match the file.`,
      );
    }
    // Build the replacement, reusing the file's own context lines so a fuzzy
    // match never reformats an untouched line.
    const replacement: string[] = [];
    let srcPtr = at;
    for (const line of hunk.body) {
      if (line.kind === " ") {
        replacement.push(lines[srcPtr]);
        srcPtr += 1;
      } else if (line.kind === "-") {
        srcPtr += 1;
      } else {
        replacement.push(line.text);
      }
    }
    lines.splice(at, hunk.source.length, ...replacement);
    cursor = at + replacement.length;
    applied += 1;
  }

  return { content: fromLines(lines, trailingNewline), hunksApplied: applied };
}

function parseUnifiedDiff(patch: string): PatchHunk[] {
  const lines = patch.split("\n");
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;

  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      // The line range is only a search hint — hunks are located by context
      // (see locateHunk), so we do not require it. Models routinely emit a
      // bare "@@" (or the "*** Begin Patch / *** Update File" envelope) with no
      // ranges; accept that and fall back to scanning from the running cursor.
      const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
      current = {
        oldStart: match ? Number(match[1]) : 0,
        body: [],
        source: [],
      };
      hunks.push(current);
      continue;
    }
    // Ignore file headers and any preamble before the first hunk.
    if (!current) continue;
    if (raw.startsWith("---") || raw.startsWith("+++")) continue;

    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === " ") {
      current.body.push({ kind: " ", text });
      current.source.push(text);
    } else if (marker === "-") {
      current.body.push({ kind: "-", text });
      current.source.push(text);
    } else if (marker === "+") {
      current.body.push({ kind: "+", text });
    } else if (raw === "\\ No newline at end of file") {
      // Trailing-newline marker; ignored for matching purposes.
      continue;
    }
    // Any other line (including a bare empty line — canonical diffs encode a
    // blank context line as a single space) ends the current hunk's body.
    else {
      current = undefined;
    }
  }

  return hunks;
}

/**
 * Find where a hunk's source block sits in `lines`, scanning from `from`.
 * Pure-insertion hunks (no source lines) anchor at the header's hint line,
 * clamped to the cursor. Returns -1 when no acceptable location is found.
 */
function locateHunk(lines: string[], hunk: PatchHunk, from: number): number {
  if (hunk.source.length === 0) {
    // Pure insertion: `@@ -L,0 ... @@` inserts after 1-based line L, i.e. at
    // 0-based index L. Clamp into [cursor, end].
    return Math.max(from, Math.min(hunk.oldStart, lines.length));
  }

  const exact = findBlock(lines, hunk.source, from, false);
  if (exact !== -1) return exact;
  return findBlock(lines, hunk.source, from, true);
}

function findBlock(
  lines: string[],
  block: string[],
  from: number,
  fuzzy: boolean,
): number {
  const last = lines.length - block.length;
  for (let start = Math.max(0, from); start <= last; start += 1) {
    let matched = true;
    for (let i = 0; i < block.length; i += 1) {
      if (!linesEqual(lines[start + i], block[i], fuzzy)) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

function linesEqual(a: string, b: string, fuzzy: boolean): boolean {
  if (a === b) return true;
  return fuzzy && a.trimEnd() === b.trimEnd();
}

function toLines(content: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  if (content === "") return { lines: [], trailingNewline: false };
  const trailingNewline = content.endsWith("\n");
  const body = trailingNewline ? content.slice(0, -1) : content;
  return { lines: body.split("\n"), trailingNewline };
}

function fromLines(lines: string[], trailingNewline: boolean): string {
  const body = lines.join("\n");
  return trailingNewline && lines.length > 0 ? `${body}\n` : body;
}

export function createListDirTool(
  options: CodingToolsOptions = {},
): ToolDefinition<ListDirInput, ListDirResult> {
  return defineTool<ListDirInput, ListDirResult>({
    name: "list_dir",
    description: "List files and directories within the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
        includeHidden: { type: "boolean" },
        maxEntries: { type: "integer" },
      },
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    governance: readGovernance(),
    resultPresentation: {
      kind: "file_discovery",
      preserveFields: [
        "path",
        "entries",
        "truncated",
        "entriesReturned",
        "entryLimitHit",
      ],
      artifactPolicy: "never",
    },
    previewArgs(args) {
      const r = previewRecord(args);
      const path = previewString(r.path) || ".";
      const recursive = r.recursive === true ? " recursive" : "";
      return `${path}${recursive}`;
    },
    async execute(args, ctx) {
      const root = await resolveWorkspaceRoot(ctx, options);
      const input = normalizeListDirInput(args, options, root);
      const walker = new WorkspaceWalker(root, ctx);
      const entries = await walker.list(input);
      return {
        path: input.path,
        entries: entries.items,
        truncated: entries.truncated,
        entriesReturned: entries.items.length,
        entryLimitHit: entries.truncated,
      };
    },
  });
}

export function createGrepTextTool(
  options: CodingToolsOptions = {},
): ToolDefinition<GrepTextInput, GrepTextResult> {
  return defineTool<GrepTextInput, GrepTextResult>({
    name: "grep",
    description:
      "Search UTF-8 workspace text files for a string or regex. Skips .git, " +
      "node_modules, and build output (dist/build/coverage) by default; pass " +
      "includeBuildOutput: true to search generated files too.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        regex: { type: "boolean" },
        caseSensitive: { type: "boolean" },
        includeHidden: { type: "boolean" },
        include: {
          type: "array",
          items: { type: "string" },
        },
        exclude: {
          type: "array",
          items: { type: "string" },
        },
        includeBuildOutput: { type: "boolean" },
        maxMatches: { type: "integer" },
        maxLineChars: { type: "integer" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    governance: readGovernance(),
    resultPresentation: {
      kind: "text_search",
      preserveFields: [
        "pattern",
        "matches",
        "truncated",
        "truncationReason",
        "filesScanned",
        "filesMatched",
        "matchesReturned",
        "fileLimitHit",
        "matchLimitHit",
        "scope",
        "effectiveInclude",
      ],
      artifactPolicy: "never",
    },
    previewArgs(args) {
      const r = previewRecord(args);
      const pattern = previewString(r.pattern);
      const path = previewString(r.path) || previewString(r.include);
      return [pattern, path ? `in ${path}` : undefined]
        .filter((part): part is string => Boolean(part))
        .join(" ");
    },
    async validateInput(args, ctx) {
      const input = normalizeGrepTextInput(args, options, undefined);
      if (input.regex) {
        try {
          new RegExp(input.pattern);
        } catch (cause) {
          return {
            ok: false,
            code: "TOOL_ARGUMENTS_INVALID",
            message:
              cause instanceof Error
                ? `Invalid grep regex pattern: ${cause.message}`
                : "Invalid grep regex pattern.",
            metadata: { reason: "invalid_regex", pattern: input.pattern },
          };
        }
      }
      if (ctx.workspace || options.workspaceRoot) {
        const root = await resolveWorkspaceRoot(ctx, options).catch(
          () => undefined,
        );
        if (root) {
          try {
            normalizeGrepTextInput(args, options, root);
          } catch (cause) {
            return validationFailureFromCause(cause, "grep");
          }
        }
      }
      return { ok: true };
    },
    async execute(args, ctx) {
      const workspace = requireWorkspace(ctx);
      const root = await resolveWorkspaceRoot(ctx, options);
      const input = normalizeGrepTextInput(args, options, root);
      const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
      const scope = grepTextScope(input, maxPaths);
      const walker = new WorkspaceWalker(root, ctx);
      const files = await walker.files({
        path: input.path,
        includeHidden: input.includeHidden,
        include: input.include,
        exclude: input.exclude,
        maxPaths,
      });
      const matcher = createTextMatcher(input);
      const matches: TextMatch[] = [];
      const matchedFiles = new Set<string>();
      const fileLimitHit = files.truncated;
      let filesScanned = 0;

      for (const path of files.paths) {
        checkAbort(ctx);
        filesScanned += 1;
        let content: string;
        try {
          content = await workspace.readText(path);
        } catch {
          continue;
        }
        for (const match of searchContent(path, content, matcher, input)) {
          matches.push(match);
          matchedFiles.add(path);
          if (matches.length >= input.maxMatches) {
            return grepTextResult({
              input,
              matches,
              scope,
              filesScanned,
              filesMatched: matchedFiles.size,
              fileLimitHit,
              matchLimitHit: true,
            });
          }
        }
      }

      return grepTextResult({
        input,
        matches,
        scope,
        filesScanned,
        filesMatched: matchedFiles.size,
        fileLimitHit,
        matchLimitHit: false,
      });
    },
  });
}

export function createGlobPathsTool(
  options: CodingToolsOptions = {},
): ToolDefinition<GlobPathsInput, GlobPathsResult> {
  return defineTool<GlobPathsInput, GlobPathsResult>({
    name: "glob",
    description:
      "Find workspace-relative paths matching glob patterns. Skips .git, " +
      "node_modules, and build output (dist/build/coverage) by default; pass " +
      "includeBuildOutput: true to include generated files too.",
    inputSchema: {
      type: "object",
      properties: {
        patterns: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        path: { type: "string" },
        includeHidden: { type: "boolean" },
        exclude: {
          type: "array",
          items: { type: "string" },
        },
        includeBuildOutput: { type: "boolean" },
        maxPaths: { type: "integer" },
        offset: { type: "integer" },
      },
      required: ["patterns"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    governance: readGovernance(),
    resultPresentation: {
      kind: "file_discovery",
      preserveFields: ["patterns", "paths", "truncated", "hasMore"],
      paginationFields: ["offset", "nextOffset"],
      artifactPolicy: "never",
    },
    previewArgs(args) {
      const r = previewRecord(args);
      const patterns = previewStringArray(r.patterns);
      return patterns.length > 0 ? patterns.slice(0, 3).join(", ") : undefined;
    },
    async validateInput(args, ctx) {
      const input = normalizeGlobPathsInput(args, options, undefined);
      const emptyPattern = input.patterns.find(
        (pattern) => pattern.trim().length === 0,
      );
      if (emptyPattern !== undefined) {
        return {
          ok: false,
          code: "TOOL_ARGUMENTS_INVALID",
          message: "glob patterns must not be empty strings.",
          metadata: { reason: "empty_pattern" },
        };
      }
      if (ctx.workspace || options.workspaceRoot) {
        const root = await resolveWorkspaceRoot(ctx, options).catch(
          () => undefined,
        );
        if (root) {
          try {
            normalizeGlobPathsInput(args, options, root);
          } catch (cause) {
            return validationFailureFromCause(cause, "glob");
          }
        }
      }
      return { ok: true };
    },
    async execute(args, ctx) {
      const root = await resolveWorkspaceRoot(ctx, options);
      const input = normalizeGlobPathsInput(args, options, root);
      const walker = new WorkspaceWalker(root, ctx);
      const result = await walker.glob(input);
      return {
        patterns: input.patterns,
        paths: result.paths,
        truncated: result.truncated,
        offset: result.offset,
        ...(result.nextOffset !== undefined
          ? { nextOffset: result.nextOffset }
          : {}),
        totalPaths: result.totalPaths,
        hasMore: result.hasMore,
      };
    },
  });
}

const readTextInputSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    startLine: { type: "integer" },
    endLine: { type: "integer" },
    maxChars: { type: "integer" },
  },
  required: ["path"],
  additionalProperties: false,
};

function previewPathWindow(
  args: unknown,
  startKey: string,
  endKey: string,
): string | undefined {
  const r = previewRecord(args);
  const path = previewString(r.path);
  if (!path) return undefined;
  const start = previewNumber(r[startKey]);
  const end = previewNumber(r[endKey]);
  const range =
    start !== undefined && end !== undefined
      ? `:${start}-${end}`
      : start !== undefined
        ? `:${start}`
        : "";
  return `${path}${range}`;
}

function previewRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function previewString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function previewNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function previewStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readGovernance() {
  return {
    sideEffects: ["read" as const],
    idempotency: "idempotent" as const,
    dataSensitivity: "internal" as const,
    origin: { kind: "local" as const, name: "@sparkwright/coding-tools" },
  };
}

function requireWorkspace(ctx: RuntimeContext) {
  if (!ctx.workspace) throw new Error("Workspace is not configured.");
  return ctx.workspace;
}

function grepTextScope(
  input: Required<GrepTextInput>,
  maxPaths: number,
): GrepTextScope {
  return {
    path: input.path,
    include: [...input.include],
    exclude: [...input.exclude],
    includeHidden: input.includeHidden,
    includeBuildOutput: input.includeBuildOutput,
    regex: input.regex,
    caseSensitive: input.caseSensitive,
    maxMatches: input.maxMatches,
    maxLineChars: input.maxLineChars,
    maxPaths,
  };
}

function grepTextResult(args: {
  input: Required<GrepTextInput>;
  matches: TextMatch[];
  scope: GrepTextScope;
  filesScanned: number;
  filesMatched: number;
  fileLimitHit: boolean;
  matchLimitHit: boolean;
}): GrepTextResult {
  const truncated = args.fileLimitHit || args.matchLimitHit;
  return {
    pattern: args.input.pattern,
    matches: args.matches,
    truncated,
    truncationReason: grepTextTruncationReason(
      args.fileLimitHit,
      args.matchLimitHit,
    ),
    filesScanned: args.filesScanned,
    filesMatched: args.filesMatched,
    matchesReturned: args.matches.length,
    fileLimitHit: args.fileLimitHit,
    matchLimitHit: args.matchLimitHit,
    scope: args.scope,
    effectiveInclude: [...args.input.include],
  };
}

function grepTextTruncationReason(
  fileLimitHit: boolean,
  matchLimitHit: boolean,
): GrepTextTruncationReason | undefined {
  if (fileLimitHit && matchLimitHit) return "file_and_match_limit";
  if (fileLimitHit) return "file_limit";
  if (matchLimitHit) return "match_limit";
  return undefined;
}

function validationFailureFromCause(
  cause: unknown,
  toolName: string,
): ToolInputValidationResult {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code =
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : "TOOL_ARGUMENTS_INVALID";
  return {
    ok: false,
    code,
    message,
    metadata: { toolName },
  };
}

async function validateExistingFileInput(
  toolName: string,
  path: string,
  ctx: RuntimeContext,
  options: CodingToolsOptions,
): Promise<ToolInputValidationResult> {
  const root = await resolveWorkspaceRoot(ctx, options).catch(() => undefined);
  if (!root) return { ok: true };
  try {
    normalizeWorkspacePath(path, root);
  } catch (cause) {
    return validationFailureFromCause(cause, toolName);
  }

  return { ok: true };
}

function validateWritablePathInput(
  toolName: string,
  path: string,
): ToolInputValidationResult {
  if (path === "." || path.endsWith("/")) {
    return {
      ok: false,
      code: "TOOL_ARGUMENTS_INVALID",
      message: `${toolName} target must be a file path, not a directory path: ${path}.`,
      metadata: { reason: "directory_path", path },
    };
  }
  return { ok: true };
}

async function canonicalOutputPath(
  ctx: RuntimeContext,
  path: string,
): Promise<string> {
  if (ctx.workspace?.canonicalPath) return ctx.workspace.canonicalPath(path);
  return normalizeWorkspacePath(path);
}

function normalizeReadTextInput(
  args: ReadTextInput,
  options: CodingToolsOptions,
): Required<ReadTextInput> {
  assertRecord(args, "read_text input");
  const path = normalizeFileUrlPath(readString(args, "path"));
  const startLine = readOptionalPositiveInteger(args, "startLine") ?? 1;
  const endLine =
    readOptionalPositiveInteger(args, "endLine") ?? Number.MAX_SAFE_INTEGER;
  const maxChars =
    readOptionalPositiveInteger(args, "maxChars") ??
    options.maxReadChars ??
    DEFAULT_MAX_READ_CHARS;
  if (endLine < startLine) {
    throw toolArgumentsInvalid(
      "endLine must be greater than or equal to startLine.",
    );
  }
  return { path, startLine, endLine, maxChars };
}

function normalizeEditAnchoredTextInput(
  args: EditAnchoredTextInput,
): EditAnchoredTextInput {
  assertRecord(args, "edit_anchored_text input");
  const path = normalizeFileUrlPath(readString(args, "path"));
  const editsValue = args.edits as unknown;
  if (!Array.isArray(editsValue) || editsValue.length === 0) {
    throw toolArgumentsInvalid("edits must be a non-empty array.");
  }

  const edits = editsValue.map((edit, index) => {
    assertRecord(edit, `edits[${index}]`);
    const op = readString(edit, "op");
    const anchor = readString(edit, "anchor");
    if (!["replace", "delete", "append", "prepend"].includes(op)) {
      throw toolArgumentsInvalid(`Unsupported edit op: ${op}`);
    }
    if (op === "delete") return { op, anchor } satisfies AnchoredEditOperation;
    const lines = edit.lines;
    if (
      !Array.isArray(lines) ||
      !lines.every((line) => typeof line === "string")
    ) {
      throw toolArgumentsInvalid(
        `edits[${index}].lines must be an array of strings.`,
      );
    }
    return { op, anchor, lines } as AnchoredEditOperation;
  });

  return {
    path,
    edits,
    reason:
      typeof args.reason === "string" && args.reason.length > 0
        ? args.reason
        : undefined,
  };
}

function normalizeListDirInput(
  args: ListDirInput,
  options: CodingToolsOptions,
  workspaceRoot?: string,
): Required<ListDirInput> {
  const input = args ?? {};
  assertRecord(input, "list_dir input");
  return {
    path: normalizeWorkspacePath(
      typeof input.path === "string" && input.path.length > 0
        ? input.path
        : ".",
      workspaceRoot,
    ),
    recursive: input.recursive === true,
    includeHidden:
      typeof input.includeHidden === "boolean"
        ? input.includeHidden
        : (options.includeHidden ?? false),
    maxEntries:
      readOptionalPositiveInteger(input, "maxEntries") ??
      options.maxEntries ??
      DEFAULT_MAX_ENTRIES,
  };
}

function normalizeGrepTextInput(
  args: GrepTextInput,
  options: CodingToolsOptions,
  workspaceRoot?: string,
): Required<GrepTextInput> {
  assertRecord(args, "grep input");
  const pattern = readString(args, "pattern");
  if (pattern.length === 0) {
    throw toolArgumentsInvalid("pattern must not be empty.");
  }
  return {
    pattern,
    path: normalizeWorkspacePath(
      typeof args.path === "string" && args.path.length > 0 ? args.path : ".",
      workspaceRoot,
    ),
    regex: args.regex === true,
    caseSensitive: args.caseSensitive ?? true,
    includeHidden: args.includeHidden ?? options.includeHidden ?? false,
    include: emptyToDefault(readOptionalStringArray(args, "include"), ["**/*"]),
    includeBuildOutput: args.includeBuildOutput === true,
    exclude: [
      ...defaultExcludeGlobs(args.includeBuildOutput === true),
      ...(options.exclude ?? []),
      ...(readOptionalStringArray(args, "exclude") ?? []),
    ],
    maxMatches:
      readOptionalPositiveInteger(args, "maxMatches") ??
      options.maxMatches ??
      DEFAULT_MAX_MATCHES,
    maxLineChars:
      readOptionalPositiveInteger(args, "maxLineChars") ??
      options.maxLineChars ??
      DEFAULT_MAX_LINE_CHARS,
  };
}

function normalizeGlobPathsInput(
  args: GlobPathsInput,
  options: CodingToolsOptions,
  workspaceRoot?: string,
): NormalizedGlobPathsInput {
  assertRecord(args, "glob input");
  const patternsValue = args.patterns;
  const patterns =
    typeof patternsValue === "string"
      ? [patternsValue]
      : Array.isArray(patternsValue) &&
          patternsValue.every((pattern) => typeof pattern === "string")
        ? patternsValue
        : undefined;
  if (!patterns || patterns.length === 0) {
    throw toolArgumentsInvalid(
      "patterns must be a string or a non-empty string array.",
    );
  }
  return {
    patterns: workspaceRoot
      ? patterns.map((pattern) =>
          normalizeWorkspacePath(pattern, workspaceRoot),
        )
      : patterns,
    path: normalizeWorkspacePath(
      typeof args.path === "string" && args.path.length > 0 ? args.path : ".",
      workspaceRoot,
    ),
    includeHidden: args.includeHidden ?? options.includeHidden ?? false,
    includeBuildOutput: args.includeBuildOutput === true,
    exclude: [
      ...defaultExcludeGlobs(args.includeBuildOutput === true),
      ...(options.exclude ?? []),
      ...(readOptionalStringArray(args, "exclude") ?? []),
    ],
    maxPaths:
      readOptionalPositiveInteger(args, "maxPaths") ??
      options.maxPaths ??
      DEFAULT_MAX_PATHS,
    offset: readOptionalNonNegativeInteger(args, "offset") ?? 0,
  };
}

function sliceText(content: string, input: Required<ReadTextInput>) {
  const lines = splitLines(content);
  const startIndex = input.startLine - 1;
  const endIndex = Math.min(input.endLine, lines.length);
  const selected = lines.slice(startIndex, endIndex);
  const bounded = limitString(selected.join("\n"), input.maxChars);
  return {
    content: bounded.content,
    startLine: input.startLine,
    endLine: endIndex,
    lineCount: lines.length,
    truncated: bounded.truncated || input.endLine < lines.length,
  };
}

function sliceAnchoredLines(
  lines: ReadAnchoredTextResult["lines"],
  input: Required<ReadTextInput>,
) {
  const startIndex = input.startLine - 1;
  const endIndex = Math.min(input.endLine, lines.length);
  return {
    lines: lines.slice(startIndex, endIndex),
    truncated: input.endLine < lines.length,
  };
}

function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function limitString(content: string, maxChars: number) {
  if (content.length <= maxChars) return { content, truncated: false };
  return { content: content.slice(0, maxChars), truncated: true };
}

async function resolveWorkspaceRoot(
  ctx: RuntimeContext,
  options: CodingToolsOptions,
): Promise<string> {
  const configured =
    typeof options.workspaceRoot === "function"
      ? await options.workspaceRoot(ctx)
      : options.workspaceRoot;
  const inferred = configured ?? inferWorkspaceRoot(ctx);
  if (!inferred) {
    throw new Error("workspaceRoot is required for list_dir, grep, and glob.");
  }
  return realpath(resolve(inferred));
}

function inferWorkspaceRoot(ctx: RuntimeContext): string | undefined {
  const workspace = ctx.workspace as { root?: unknown } | undefined;
  return typeof workspace?.root === "string" ? workspace.root : undefined;
}

class WorkspaceWalker {
  constructor(
    private readonly root: string,
    private readonly ctx: RuntimeContext,
  ) {}

  async list(input: Required<ListDirInput>) {
    const start = await this.resolveExistingDirectory(input.path);
    const entries: DirectoryEntry[] = [];
    let truncated = false;

    for await (const entry of this.walk(start, {
      recursive: input.recursive,
      includeHidden: input.includeHidden,
    })) {
      entries.push(entry);
      if (entries.length >= input.maxEntries) {
        truncated = true;
        break;
      }
    }

    entries.sort(compareEntries);
    return { items: entries, truncated };
  }

  async files(input: {
    path: string;
    includeHidden: boolean;
    include: string[];
    exclude: string[];
    maxPaths: number;
  }) {
    const start = await this.resolveExistingPath(input.path);
    const includeMatchers = input.include.map(globMatcher);
    const excludeMatchers = input.exclude.map(globMatcher);
    const paths: string[] = [];
    let truncated = false;

    if (start.type === "file") {
      return { paths: [this.toWorkspacePath(start.fullPath)], truncated };
    }

    for await (const entry of this.walk(start.fullPath, {
      recursive: true,
      includeHidden: input.includeHidden,
    })) {
      if (entry.type !== "file") continue;
      // An empty include set means "no include filter" (match every file),
      // not "match nothing"; `matchesAny([])` is false, so guard the case.
      if (
        includeMatchers.length > 0 &&
        !matchesAny(entry.path, includeMatchers)
      )
        continue;
      if (matchesAny(entry.path, excludeMatchers)) continue;
      paths.push(entry.path);
      if (paths.length >= input.maxPaths) {
        truncated = true;
        break;
      }
    }

    paths.sort((left, right) => left.localeCompare(right));
    return { paths, truncated };
  }

  async glob(input: NormalizedGlobPathsInput) {
    const start = await this.resolveExistingDirectory(input.path);
    const includeMatchers = input.patterns.map(globMatcher);
    const excludeMatchers = input.exclude.map(globMatcher);
    const paths: string[] = [];

    for await (const entry of this.walk(start, {
      recursive: true,
      includeHidden: input.includeHidden,
    })) {
      if (!matchesAny(entry.path, includeMatchers)) continue;
      if (matchesAny(entry.path, excludeMatchers)) continue;
      paths.push(entry.path);
    }

    paths.sort((left, right) => left.localeCompare(right));
    const totalPaths = paths.length;
    const page = paths.slice(input.offset, input.offset + input.maxPaths);
    const nextOffset =
      input.offset + page.length < totalPaths
        ? input.offset + page.length
        : undefined;
    return {
      paths: page,
      truncated: nextOffset !== undefined,
      offset: input.offset,
      nextOffset,
      totalPaths,
      hasMore: nextOffset !== undefined,
    };
  }

  private async *walk(
    start: string,
    options: { recursive: boolean; includeHidden: boolean },
  ): AsyncGenerator<DirectoryEntry> {
    checkAbort(this.ctx);
    const dir = await opendir(start);
    for await (const dirent of dir) {
      checkAbort(this.ctx);
      if (!options.includeHidden && isHiddenName(dirent.name)) continue;

      const fullPath = resolve(start, dirent.name);
      const path = this.toWorkspacePath(fullPath);
      const type = dirent.isDirectory()
        ? "directory"
        : dirent.isFile()
          ? "file"
          : dirent.isSymbolicLink()
            ? "symlink"
            : "other";
      const entry: DirectoryEntry = {
        path,
        name: dirent.name,
        type,
      };

      if (type === "file") {
        const fileStat = await stat(fullPath).catch(() => undefined);
        if (fileStat?.isFile()) entry.size = fileStat.size;
      }

      yield entry;

      if (options.recursive && type === "directory") {
        // Defensive: even though Node's default `opendir` reports symlinks
        // as type "symlink" (not "directory"), we still resolve and re-check
        // the target before recursing. This guards against a future change
        // of opendir options (or filesystem quirks) silently allowing
        // recursion through a symlink that escapes the workspace root.
        let real: string;
        try {
          real = await realpath(fullPath);
        } catch {
          continue;
        }
        try {
          assertInsideRoot(this.root, real, fullPath);
        } catch {
          continue;
        }
        yield* this.walk(real, options);
      }
    }
  }

  private async resolveExistingDirectory(path: string): Promise<string> {
    const target = await this.resolveExistingPath(path);
    if (target.type !== "directory") {
      throw toolArgumentsInvalid(
        `Workspace discovery path is not a directory: ${path}. ` +
          "Use path='.' with include/exclude or glob patterns to narrow discovery, " +
          "or call a file-read tool when you already have a concrete file path.",
      );
    }
    return target.fullPath;
  }

  private async resolveExistingPath(
    path: string,
  ): Promise<{ fullPath: string; type: "directory" | "file" | "other" }> {
    const fullPath = resolve(this.root, path);
    const resolved = await realpath(fullPath);
    assertInsideRoot(this.root, resolved, path);
    const targetStat = await stat(resolved);
    const type = targetStat.isDirectory()
      ? "directory"
      : targetStat.isFile()
        ? "file"
        : "other";
    return { fullPath: resolved, type };
  }

  private toWorkspacePath(fullPath: string): string {
    assertInsideRoot(this.root, fullPath, fullPath);
    const path = relative(this.root, fullPath).split(sep).join("/");
    return path.length > 0 ? path : ".";
  }
}

function toolArgumentsInvalid(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "TOOL_ARGUMENTS_INVALID" });
}

function normalizeWorkspacePath(path: string, workspaceRoot?: string): string {
  const decoded = normalizeFileUrlPath(path);
  if (workspaceRoot && (isAbsolute(decoded) || /^[A-Za-z]:/.test(decoded))) {
    const rel = relative(workspaceRoot, decoded);
    if (
      rel === "" ||
      (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel))
    ) {
      return normalizeWorkspacePath(rel || ".");
    }
  }
  const normalized = decoded.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw toolArgumentsInvalid(`Path escapes workspace root: ${path}`);
  }
  const parts = normalized.split("/").filter(Boolean);
  const output: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (output.length === 0) {
        throw toolArgumentsInvalid(`Path escapes workspace root: ${path}`);
      }
      output.pop();
      continue;
    }
    output.push(part);
  }
  return output.length > 0 ? output.join("/") : ".";
}

function normalizeFileUrlPath(path: string): string {
  if (!path.startsWith("file://")) return path;
  try {
    return fileURLToPath(path);
  } catch {
    throw toolArgumentsInvalid(`Invalid file URL path: ${path}`);
  }
}

function assertInsideRoot(root: string, target: string, originalPath: string) {
  const rel = relative(root, target);
  if (
    rel === "" ||
    (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel))
  ) {
    return;
  }
  throw toolArgumentsInvalid(`Path escapes workspace root: ${originalPath}`);
}

const TYPE_ORDER: Record<DirectoryEntry["type"], number> = {
  directory: 0,
  file: 1,
  symlink: 2,
  other: 3,
};

function compareEntries(left: DirectoryEntry, right: DirectoryEntry) {
  const diff = TYPE_ORDER[left.type] - TYPE_ORDER[right.type];
  if (diff !== 0) return diff;
  return left.path.localeCompare(right.path);
}

function createTextMatcher(input: Required<GrepTextInput>) {
  if (!input.regex) {
    const needle = input.caseSensitive
      ? input.pattern
      : input.pattern.toLocaleLowerCase();
    return (line: string) => {
      const haystack = input.caseSensitive ? line : line.toLocaleLowerCase();
      const column = haystack.indexOf(needle);
      return column >= 0 ? column + 1 : undefined;
    };
  }

  if (input.pattern.length > MAX_REGEX_PATTERN_CHARS) {
    throw new Error(
      `regex pattern exceeds ${MAX_REGEX_PATTERN_CHARS} characters; refusing to compile (ReDoS guard).`,
    );
  }
  const flags = input.caseSensitive ? "" : "i";
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, flags);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invalid regex pattern: ${message}`);
  }
  return (line: string) => {
    const match = regex.exec(line);
    return match?.index === undefined ? undefined : match.index + 1;
  };
}

function* searchContent(
  path: string,
  content: string,
  matcher: (line: string) => number | undefined,
  input: Required<GrepTextInput>,
): Generator<TextMatch> {
  const lines = splitLines(content);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const column = matcher(line);
    if (column === undefined) continue;
    yield {
      path,
      line: index + 1,
      column,
      text: limitString(line, input.maxLineChars).content,
    };
  }
}

function globMatcher(pattern: string) {
  const regex = globToRegExp(pattern);
  return (path: string) => regex.test(path);
}

function matchesAny(path: string, matchers: Array<(path: string) => boolean>) {
  return matchers.some((matcher) => matcher(path));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  const normalized = pattern.replace(/\\/g, "/");
  // Brace alternation (e.g. `*.{ts,js}`) is only translated when the braces are
  // balanced; otherwise a stray `{` is treated literally so we never emit an
  // invalid regex (which would silently match nothing).
  const expandBraces = hasBalancedBraces(normalized);
  let braceDepth = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (expandBraces) {
      if (char === "{") {
        braceDepth += 1;
        source += "(?:";
        continue;
      }
      if (char === "}" && braceDepth > 0) {
        braceDepth -= 1;
        source += ")";
        continue;
      }
      if (char === "," && braceDepth > 0) {
        source += "|";
        continue;
      }
    }
    source += escapeRegExp(char ?? "");
  }
  source += "$";
  return new RegExp(source);
}

function hasBalancedBraces(pattern: string): boolean {
  let depth = 0;
  for (const char of pattern) {
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw toolArgumentsInvalid(`${label} must be an object.`);
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw toolArgumentsInvalid(`${key} must be a non-empty string.`);
  }
  return value;
}

function readStringAllowEmpty(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw toolArgumentsInvalid(`${key} must be a string.`);
  }
  return value;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function readOptionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw toolArgumentsInvalid(`${key} must be a positive integer.`);
  }
  return value;
}

function readOptionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw toolArgumentsInvalid(`${key} must be a non-negative integer.`);
  }
  return value;
}

// Treat `undefined`, an explicit empty array, and model-produced blank entries
// identically: all mean "no constraint", so fall back to the default rather
// than collapsing to a match-nothing filter.
function emptyToDefault(
  value: string[] | undefined,
  fallback: string[],
): string[] {
  return value && value.length > 0 ? value : fallback;
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw toolArgumentsInvalid(`${key} must be an array of strings.`);
  }
  return value.filter((item) => item.trim().length > 0);
}

function checkAbort(ctx: RuntimeContext) {
  if (ctx.abortSignal?.aborted) {
    throw new Error("Tool execution aborted.");
  }
}
