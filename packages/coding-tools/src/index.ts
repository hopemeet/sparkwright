import { opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  defineTool,
  type AnchoredEditOperation,
  type RuntimeContext,
  type ToolDefinition,
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
];

export interface CodingToolsOptions {
  /**
   * Workspace root used by discovery tools (`list_dir`, `grep_text`,
   * `glob_paths`). Text reads and writes still execute through
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
  | "edit_anchored_text"
  | "list_dir"
  | "grep_text"
  | "glob_paths";

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
  maxMatches?: number;
  maxLineChars?: number;
}

export interface GrepTextResult {
  pattern: string;
  /** @reserved Public tool-output field consumed by coding UIs. */
  matches: TextMatch[];
  truncated: boolean;
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
    createEditAnchoredTextTool(),
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

export function createEditAnchoredTextTool(): ToolDefinition<
  EditAnchoredTextInput,
  EditAnchoredTextResult
> {
  return defineTool<EditAnchoredTextInput, EditAnchoredTextResult>({
    name: "edit_anchored_text",
    description:
      "Apply verified anchored text edits through the workspace write path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["replace", "delete", "append", "prepend"],
              },
              anchor: { type: "string" },
              lines: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["op", "anchor"],
            additionalProperties: false,
          },
        },
        reason: { type: "string" },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    governance: {
      sideEffects: ["write"],
      idempotency: "conditional",
      dataSensitivity: "internal",
      origin: { kind: "local", name: "@sparkwright/coding-tools" },
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
    async execute(args, ctx) {
      const input = normalizeListDirInput(args, options);
      const walker = await createWorkspaceWalker(ctx, options);
      const entries = await walker.list(input);
      return {
        path: input.path,
        entries: entries.items,
        truncated: entries.truncated,
      };
    },
  });
}

export function createGrepTextTool(
  options: CodingToolsOptions = {},
): ToolDefinition<GrepTextInput, GrepTextResult> {
  return defineTool<GrepTextInput, GrepTextResult>({
    name: "grep_text",
    description: "Search UTF-8 workspace text files for a string or regex.",
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
        maxMatches: { type: "integer" },
        maxLineChars: { type: "integer" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    governance: readGovernance(),
    async execute(args, ctx) {
      const workspace = requireWorkspace(ctx);
      const input = normalizeGrepTextInput(args, options);
      const walker = await createWorkspaceWalker(ctx, options);
      const files = await walker.files({
        path: input.path,
        includeHidden: input.includeHidden,
        include: input.include,
        exclude: input.exclude,
        maxPaths: options.maxPaths ?? DEFAULT_MAX_PATHS,
      });
      const matcher = createTextMatcher(input);
      const matches: TextMatch[] = [];
      let truncated = files.truncated;

      for (const path of files.paths) {
        checkAbort(ctx);
        let content: string;
        try {
          content = await workspace.readText(path);
        } catch {
          continue;
        }
        for (const match of searchContent(path, content, matcher, input)) {
          matches.push(match);
          if (matches.length >= input.maxMatches) {
            truncated = true;
            return { pattern: input.pattern, matches, truncated };
          }
        }
      }

      return { pattern: input.pattern, matches, truncated };
    },
  });
}

export function createGlobPathsTool(
  options: CodingToolsOptions = {},
): ToolDefinition<GlobPathsInput, GlobPathsResult> {
  return defineTool<GlobPathsInput, GlobPathsResult>({
    name: "glob_paths",
    description: "Find workspace-relative paths matching glob patterns.",
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
  const path = readString(args, "path");
  const startLine = readOptionalPositiveInteger(args, "startLine") ?? 1;
  const endLine =
    readOptionalPositiveInteger(args, "endLine") ?? Number.MAX_SAFE_INTEGER;
  const maxChars =
    readOptionalPositiveInteger(args, "maxChars") ??
    options.maxReadChars ??
    DEFAULT_MAX_READ_CHARS;
  if (endLine < startLine) {
    throw new Error("endLine must be greater than or equal to startLine.");
  }
  return { path, startLine, endLine, maxChars };
}

function normalizeEditAnchoredTextInput(
  args: EditAnchoredTextInput,
): EditAnchoredTextInput {
  assertRecord(args, "edit_anchored_text input");
  const path = readString(args, "path");
  const editsValue = args.edits as unknown;
  if (!Array.isArray(editsValue) || editsValue.length === 0) {
    throw new Error("edits must be a non-empty array.");
  }

  const edits = editsValue.map((edit, index) => {
    assertRecord(edit, `edits[${index}]`);
    const op = readString(edit, "op");
    const anchor = readString(edit, "anchor");
    if (!["replace", "delete", "append", "prepend"].includes(op)) {
      throw new Error(`Unsupported edit op: ${op}`);
    }
    if (op === "delete") return { op, anchor } satisfies AnchoredEditOperation;
    const lines = edit.lines;
    if (
      !Array.isArray(lines) ||
      !lines.every((line) => typeof line === "string")
    ) {
      throw new Error(`edits[${index}].lines must be an array of strings.`);
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
): Required<ListDirInput> {
  const input = args ?? {};
  assertRecord(input, "list_dir input");
  return {
    path: normalizeWorkspacePath(
      typeof input.path === "string" && input.path.length > 0
        ? input.path
        : ".",
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
): Required<GrepTextInput> {
  assertRecord(args, "grep_text input");
  const pattern = readString(args, "pattern");
  if (pattern.length === 0) throw new Error("pattern must not be empty.");
  return {
    pattern,
    path: normalizeWorkspacePath(
      typeof args.path === "string" && args.path.length > 0 ? args.path : ".",
    ),
    regex: args.regex === true,
    caseSensitive: args.caseSensitive ?? true,
    includeHidden: args.includeHidden ?? options.includeHidden ?? false,
    include: readOptionalStringArray(args, "include") ?? ["**/*"],
    exclude: [
      ...DEFAULT_EXCLUDE_GLOBS,
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
  assertRecord(args, "glob_paths input");
  const patternsValue = args.patterns;
  const patterns =
    typeof patternsValue === "string"
      ? [patternsValue]
      : Array.isArray(patternsValue) &&
          patternsValue.every((pattern) => typeof pattern === "string")
        ? patternsValue
        : undefined;
  if (!patterns || patterns.length === 0) {
    throw new Error("patterns must be a string or a non-empty string array.");
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
    exclude: [
      ...DEFAULT_EXCLUDE_GLOBS,
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

async function createWorkspaceWalker(
  ctx: RuntimeContext,
  options: CodingToolsOptions,
) {
  const root = await resolveWorkspaceRoot(ctx, options);
  return new WorkspaceWalker(root, ctx);
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
    throw new Error(
      "workspaceRoot is required for list_dir, grep_text, and glob_paths.",
    );
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
    const start = await this.resolveExisting(input.path);
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
    const start = await this.resolveExisting(input.path);
    const includeMatchers = input.include.map(globMatcher);
    const excludeMatchers = input.exclude.map(globMatcher);
    const paths: string[] = [];
    let truncated = false;

    for await (const entry of this.walk(start, {
      recursive: true,
      includeHidden: input.includeHidden,
    })) {
      if (entry.type !== "file") continue;
      if (!matchesAny(entry.path, includeMatchers)) continue;
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
    const start = await this.resolveExisting(input.path);
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

  private async resolveExisting(path: string): Promise<string> {
    const fullPath = resolve(this.root, path);
    const resolved = await realpath(fullPath);
    assertInsideRoot(this.root, resolved, path);
    const targetStat = await stat(resolved);
    if (!targetStat.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${path}`);
    }
    return resolved;
  }

  private toWorkspacePath(fullPath: string): string {
    assertInsideRoot(this.root, fullPath, fullPath);
    const path = relative(this.root, fullPath).split(sep).join("/");
    return path.length > 0 ? path : ".";
  }
}

function normalizeWorkspacePath(path: string, workspaceRoot?: string): string {
  if (workspaceRoot && (isAbsolute(path) || /^[A-Za-z]:/.test(path))) {
    const rel = relative(workspaceRoot, path);
    if (
      rel === "" ||
      (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel))
    ) {
      return normalizeWorkspacePath(rel || ".");
    }
  }
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Path escapes workspace root: ${path}`);
  }
  const parts = normalized.split("/").filter(Boolean);
  const output: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (output.length === 0) {
        throw new Error(`Path escapes workspace root: ${path}`);
      }
      output.pop();
      continue;
    }
    output.push(part);
  }
  return output.length > 0 ? output.join("/") : ".";
}

function assertInsideRoot(root: string, target: string, originalPath: string) {
  const rel = relative(root, target);
  if (
    rel === "" ||
    (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel))
  ) {
    return;
  }
  throw new Error(`Path escapes workspace root: ${originalPath}`);
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
    source += escapeRegExp(char ?? "");
  }
  source += "$";
  return new RegExp(source);
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
    throw new Error(`${label} must be an object.`);
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function readOptionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new Error(`${key} must be a positive integer.`);
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
    throw new Error(`${key} must be a non-negative integer.`);
  }
  return value;
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
    throw new Error(`${key} must be an array of strings.`);
  }
  return value;
}

function checkAbort(ctx: RuntimeContext) {
  if (ctx.abortSignal?.aborted) {
    throw new Error("Tool execution aborted.");
  }
}
