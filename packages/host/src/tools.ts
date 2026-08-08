import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineTool,
  type RuntimeContext,
  type ToolDefinition,
  type WorkspaceRuntime,
} from "@sparkwright/core";
import type { AgentProfile } from "@sparkwright/agent-runtime";
import {
  createApplyPatchTool as createApplyPatchToolBase,
  createCreateFileTool as createCreateFileToolBase,
  createEditAnchoredTextTool as createEditAnchoredTextToolBase,
  createGlobPathsTool as createGlobPathsToolBase,
  createGrepTextTool as createGrepTextToolBase,
  createListDirTool as createListDirToolBase,
  createReadAnchoredTextTool as createReadAnchoredTextToolBase,
  createReplaceFileTool as createReplaceFileToolBase,
  createWriteFileTool as createWriteFileToolBase,
} from "@sparkwright/coding-tools";
import {
  createCronTool as createCronToolBase,
  defaultCronRoot,
} from "@sparkwright/cron";
import { type SkillRoot } from "@sparkwright/skills";
import {
  canonicalWorkspacePath,
  readWorkspaceTextIfExists,
  removeCapabilityFile,
  writeCapabilityText,
} from "./capability-mutation.js";
import {
  isValidModelRefSyntax,
  loadHostConfig,
  resolveModelSelection,
} from "./config/config-implementation.js";
import {
  projectConfigPath,
  readConfigFileObject,
  resolveConfigWriteTarget,
} from "./config/file-io.js";
import type { CapabilityToolsConfig } from "./config-zod-schema.js";
import {
  formatToolUseSelectorList,
  isToolUseSelector,
} from "./tool-selectors.js";
import {
  DEFAULT_ADVANCED_TOOL_NAMES,
  normalizeToolNameList,
  shouldDeferToolByDefault,
} from "./tool-identities.js";
import { projectSkillRoot } from "./skill-roots.js";
import { loadLayeredSkillReport } from "./skill-report.js";
import {
  discoverAgentProfileFileEntriesInDir,
  markdownAgentIdentity,
  parseAgentProfileFile,
} from "./agent-profiles.js";

/** Built-in tool: read a UTF-8 file from the workspace. Safe (no approval). */
// read paging defaults. The old tool returned a fixed 400-char preview,
// which made the model loop (it never saw past the stub, so it re-read the same
// file). We now return real content, but the returned window must still fit the
// model-visible observation budget in core. So the tool pages by line — default
// window, explicit "hasMore", and a per-call character ceiling that keeps each
// normal page fully visible after observation formatting.
const READ_DEFAULT_LINES = 2000;
const READ_MAX_CHARS = 6_000;

export function createReadFileTool() {
  return defineTool({
    name: "read",
    description:
      "Read a UTF-8 text file from the workspace. Returns up to `limit` lines " +
      "(default 2000), bounded by an internal character budget, starting at " +
      "1-based line `offset` (default 1). For large files, read successive " +
      "windows by passing `offset`; the result reports `totalLines`, " +
      "`hasMore`, and the exact `nextOffset` to use. `path` must be a " +
      "concrete file path; glob patterns are not expanded. Use `glob` first " +
      "when you need to discover files from a pattern, and `grep` when you " +
      "need to find text inside large files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: {
          type: "number",
          description: "1-based line to start at. Default 1.",
        },
        limit: {
          type: "number",
          description: `Max lines to return. Default ${READ_DEFAULT_LINES}.`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    delegation: "child",
    policy: { risk: "safe" },
    governance: {
      origin: { kind: "local", name: "@sparkwright/coding-tools" },
      sideEffects: ["read"],
    },
    previewArgs(args) {
      const r = previewRecord(args);
      const path = previewString(r.path);
      if (!path) return undefined;
      const offset =
        typeof r.offset === "number" && Number.isFinite(r.offset)
          ? `:${r.offset}`
          : "";
      const limit =
        typeof r.limit === "number" && Number.isFinite(r.limit)
          ? ` +${r.limit}`
          : "";
      return `${path}${offset}${limit}`;
    },
    async validateInput(args: unknown, ctx) {
      if (!ctx.workspace) {
        return {
          ok: false,
          code: "TOOL_ARGUMENTS_INVALID",
          message: "Workspace is not configured.",
          metadata: { reason: "missing_workspace" },
        };
      }
      const { path: rawPath } = readFileToolInput(args);
      await normalizeWorkspacePathArg(rawPath, ctx.workspace);
      return { ok: true };
    },
    async execute(args: unknown, ctx) {
      if (!ctx.workspace) throw new Error("Workspace is not configured.");
      const { path: rawPath, offset, limit } = readFileToolInput(args);
      const path = await normalizeWorkspacePathArg(rawPath, ctx.workspace);
      const observation = await (
        ctx.workspace.readTextWithRevision
          ? ctx.workspace.readTextWithRevision(path)
          : ctx.workspace.readText(path).then((content) => ({ content }))
      ).catch((error) => {
        if (isNodeErrorCode(error, "EISDIR")) {
          throw toolArgumentsInvalid(
            `read expected a file path but ${path} is a directory. Use glob to list files inside it, then call read with a concrete file path.`,
          );
        }
        throw error;
      });
      const content = observation.content;
      const lines = content.split("\n");
      const totalLines = lines.length;
      const startLine = Math.max(1, Math.floor(offset ?? 1));
      const windowLines = Math.max(1, Math.floor(limit ?? READ_DEFAULT_LINES));
      const startIdx = startLine - 1;

      // Offset past EOF: return an empty window rather than erroring, so the
      // model can tell it has walked off the end.
      if (startIdx >= totalLines) {
        return {
          path,
          bytes: content.length,
          totalLines,
          startLine,
          endLine: startLine - 1,
          content: "",
          hasMore: false,
          ...(rawPath !== path ? { inputPath: rawPath } : {}),
          note: `offset ${startLine} is past end of file (${totalLines} lines).`,
        };
      }

      let endIdx = Math.min(totalLines, startIdx + windowLines);
      let slice = lines.slice(startIdx, endIdx).join("\n");

      // Char backstop: a window of "few" but very long lines (e.g. a minified
      // bundle) can still be huge. Trim to a line boundary within the budget.
      // `midLineCut` is the pathological case — a SINGLE line longer than the
      // whole budget, where there's no line boundary to trim to, so the line
      // itself is returned partial and line-offset paging can't recover the
      // rest. We must say so rather than report a clean, complete window.
      let charCapped = false;
      let midLineCut = false;
      if (slice.length > READ_MAX_CHARS) {
        const cut = slice.slice(0, READ_MAX_CHARS);
        const lastNl = cut.lastIndexOf("\n");
        if (lastNl > 0) {
          slice = cut.slice(0, lastNl);
        } else {
          slice = cut;
          midLineCut = true;
        }
        endIdx = startIdx + (slice === "" ? 1 : slice.split("\n").length);
        charCapped = true;
      }

      const returnedLines = slice === "" ? 0 : slice.split("\n").length;
      const endLine = startIdx + returnedLines;
      // midLineCut → the last line is partial, so there's always "more" even if
      // we've reached the last line index.
      const hasMore = endIdx < totalLines || midLineCut;
      let note: string | undefined;
      if (midLineCut) {
        note = `Line ${startLine} exceeds the ${READ_MAX_CHARS}-char limit; returned its first ${slice.length} chars. The rest of this line is not retrievable by line offset.`;
      } else if (hasMore) {
        note = charCapped
          ? `Returned lines ${startLine}-${endLine} (capped at ${READ_MAX_CHARS} chars). File has ${totalLines} lines — continue with offset ${endLine + 1}.`
          : `Returned lines ${startLine}-${endLine} of ${totalLines} — continue with offset ${endLine + 1}.`;
      }

      return {
        path,
        ...(rawPath !== path ? { inputPath: rawPath } : {}),
        bytes: content.length,
        totalLines,
        startLine,
        endLine,
        content: slice,
        hasMore,
        ...(hasMore && !midLineCut ? { nextOffset: endLine + 1 } : {}),
        truncated: charCapped,
        ...("revision" in observation &&
        typeof observation.revision === "string"
          ? { revision: observation.revision }
          : {}),
        ...(ctx.workspaceState
          ? { stateEpoch: ctx.workspaceState.currentEpoch() }
          : {}),
        ...(note ? { note } : {}),
      };
    },
  });
}

function toolArgumentsInvalid(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "TOOL_ARGUMENTS_INVALID" });
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function readFileToolInput(args: unknown): {
  path: string;
  offset?: number;
  limit?: number;
} {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw toolArgumentsInvalid("read input must be an object.");
  }
  const record = args as Record<string, unknown>;
  if (typeof record.path !== "string" || record.path.trim().length === 0) {
    throw toolArgumentsInvalid("read requires a non-empty string path.");
  }
  return {
    path: record.path.trim(),
    offset: readOptionalPositiveNumber(record, "offset"),
    limit: readOptionalPositiveNumber(record, "limit"),
  };
}

async function normalizeWorkspacePathArg(
  path: string,
  workspace: WorkspaceRuntime,
): Promise<string> {
  const decoded = normalizeFileUrlPath(path);
  try {
    return typeof workspace.canonicalPath === "function"
      ? await workspace.canonicalPath(decoded)
      : normalizeRelativeWorkspacePath(decoded);
  } catch (error) {
    if (
      isNodeErrorCode(error, "WORKSPACE_PATH_ESCAPED") ||
      /Path escapes workspace root/.test(errorMessage(error))
    ) {
      throw toolArgumentsInvalid(`Path escapes workspace root: ${path}`);
    }
    throw error;
  }
}

function normalizeFileUrlPath(path: string): string {
  if (!path.startsWith("file://")) return path;
  try {
    return fileURLToPath(path);
  } catch {
    throw toolArgumentsInvalid(`Invalid file URL path: ${path}`);
  }
}

function normalizeRelativeWorkspacePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw toolArgumentsInvalid(`Path escapes workspace root: ${path}`);
  }
  const output: string[] = [];
  for (const part of normalized.split("/").filter(Boolean)) {
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

function readOptionalPositiveNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw toolArgumentsInvalid(`${key} must be a positive number.`);
  }
  return value;
}

function previewRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function previewString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGlobPathsTool(workspaceRoot: string) {
  return createGlobPathsToolBase({ workspaceRoot });
}

/**
 * Built-in read-only tool: enumerate the files and directories under a
 * workspace path. `glob` matches paths by pattern, but a model that just
 * wants to see "what is in this directory" had to glob `*` and over-fetch;
 * list_dir answers that directly and belongs in the same read-only discovery
 * set as read + glob + grep.
 */
export function createListDirTool(workspaceRoot: string) {
  return createListDirToolBase({ workspaceRoot });
}

/**
 * Built-in read-only tool: search file *contents* for a string or regex.
 * `glob` only matches paths, so finding a symbol by name (e.g. "a
 * function named frobnicate") is impossible by globbing alone — it degenerates
 * into reading every file. grep answers that in one call, and belongs in
 * the same read-only discovery set as read + glob.
 */
export function createGrepTextTool(workspaceRoot: string) {
  return createGrepTextToolBase({ workspaceRoot });
}

/**
 * Built-in read-only tool: read a file with stable line anchors used by
 * edit_anchored_text. Expose both tools together so models do not invent
 * anchors from plain read output.
 */
export function createReadAnchoredTextTool() {
  return createReadAnchoredTextToolBase();
}

/**
 * Built-in write tool: create or replace a whole UTF-8 file through the
 * workspace write path. Parent directories are handled by the workspace
 * runtime, and policy/approval/diff events stay centralized there.
 */
export function createWriteFileTool() {
  return createWriteFileToolBase();
}

/** Revision-aware create that refuses to overwrite an existing path. */
export function createCreateFileTool() {
  return createCreateFileToolBase();
}

/** Revision-aware whole-file replacement guarded by expectedRevision. */
export function createReplaceFileTool() {
  return createReplaceFileToolBase();
}

/**
 * Built-in write tool: apply verified anchored edits (replace/delete/append/
 * prepend relative to a unique text anchor) through the workspace write path.
 * Supports in-place line replacement — needed for "make one minimal fix" tasks
 * where appending a new section would leave the incorrect text behind. The
 * write itself is still scope- and approval-gated inside Workspace.writeText,
 * so this preserves the target-path and access-policy contract.
 */
export function createEditAnchoredTextTool() {
  return createEditAnchoredTextToolBase();
}

/**
 * Built-in write tool: apply a unified diff. Same workspace write path (and
 * therefore the same scope/approval gating) as edit_anchored_text; offered
 * alongside it because models reach for one or the other depending on the edit.
 */
export function createApplyPatchTool() {
  return createApplyPatchToolBase();
}

export function createCronTool() {
  return createCronToolBase({ rootDir: defaultCronRoot(process.env) });
}

export function createSkillInspectorTool(
  workspaceRoot: string,
  configuredRoots: SkillRoot[] | undefined,
) {
  return defineTool({
    name: "list_skills",
    description:
      "List or validate workspace skills. Read-only: never writes. Use this " +
      "to discover current skills or check skill health.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "validate"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    governance: {
      origin: { kind: "local", name: "sparkwright" },
      sideEffects: ["read"],
      idempotency: "idempotent",
    },
    async execute(args: unknown) {
      const action = parseInspectAction(args, "list_skills");
      const roots = resolveSkillRoots(workspaceRoot, configuredRoots);
      return loadLayeredSkillReport(roots, {
        includeMissingRoots: action === "validate",
      });
    },
  });
}

export function createAgentInspectorTool(workspaceRoot: string) {
  return defineTool({
    name: "list_agents",
    description:
      "List or validate project agent profiles in the project Sparkwright config. " +
      "Read-only: never writes. Use create_agent to create, update, replace, or remove a profile.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "validate"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    governance: {
      origin: { kind: "local", name: "sparkwright" },
      sideEffects: ["read"],
      idempotency: "idempotent",
    },
    async execute(args: unknown) {
      const action = parseInspectAction(args, "list_agents");
      return loadAgentReport(workspaceRoot, action);
    },
  });
}

export function createMarkdownAgentManagerTool(workspaceRoot: string) {
  return defineTool({
    name: "create_agent",
    description:
      "Create, update, replace, or remove one Markdown Agent at .sparkwright/agents/<name>.md. " +
      "The canonical name is also the filename stem; omit default mode/maxSteps and redundant deny rules. " +
      "The final Markdown is parsed, semantically summarized, approval-gated as a workspace write, atomically written, then rediscovered for callability. " +
      "This does not mutate config-backed agent profiles or create proposal/history records.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "replace", "remove"],
        },
        name: {
          type: "string",
          description:
            "Canonical Agent name and filename stem, for example code-reviewer. The created file is .sparkwright/agents/<name>.md.",
        },
        description: { type: "string" },
        mode: { type: "string", enum: ["primary", "child", "all"] },
        prompt: { type: "string" },
        model: {
          oneOf: [
            { type: "string", enum: ["inherit"] },
            {
              type: "string",
              pattern: "^(deterministic|[^/\\s]+/[^\\s]+)$",
            },
          ],
          description:
            'Use "inherit" to inherit the effective parent/default model; it is normalized away and never persisted. Otherwise pass an explicit "provider/model" ref or "deterministic".',
        },
        use: { type: "array", items: { type: "string" } },
        allowedTools: { type: "array", items: { type: "string" } },
        deniedTools: { type: "array", items: { type: "string" } },
        maxSteps: { type: "integer", minimum: 1 },
        replaceReason: { type: "string" },
      },
      required: ["action", "name"],
      additionalProperties: false,
    },
    policy: { risk: "risky" },
    governance: {
      origin: { kind: "local", name: "sparkwright" },
      sideEffects: ["read", "write"],
      idempotency: "conditional",
    },
    async execute(args: unknown, ctx) {
      if (!ctx.workspace) throw new Error("Workspace is not configured.");
      if (isPlainObject(args) && args.action === "remove")
        return removeMarkdownAgent(ctx, parseMarkdownAgentRemoveArgs(args));
      return writeMarkdownAgent(
        ctx,
        workspaceRoot,
        parseMarkdownAgentArgs(args),
      );
    },
  });
}

export function applyToolConfig<T extends ToolDefinition>(
  tools: T[],
  config: CapabilityToolsConfig | undefined,
): T[] {
  const normalizedConfig = config
    ? {
        ...config,
        allowed: normalizeToolNameList(config.allowed),
        disabled: normalizeToolNameList(config.disabled),
        defer: normalizeToolNameList(config.defer),
      }
    : undefined;
  const useDefaultDefer = normalizedConfig?.defer === undefined;
  const deferPatterns = normalizedConfig?.defer ?? DEFAULT_DEFERRED_TOOLS;
  if (!normalizedConfig) {
    return tools.map((tool) =>
      applyDefaultDefer(tool, deferPatterns, true),
    ) as T[];
  }
  return tools
    .filter((tool) => isToolNameAllowed(tool.name, normalizedConfig.allowed))
    .filter((tool) => !isToolNameListed(tool.name, normalizedConfig.disabled))
    .map((tool) => {
      if (!shouldDeferTool(tool, deferPatterns, useDefaultDefer)) {
        return tool;
      }
      return { ...tool, deferLoading: true };
    }) as T[];
}

export const DEFAULT_DEFERRED_TOOLS = [...DEFAULT_ADVANCED_TOOL_NAMES];

function applyDefaultDefer<T extends ToolDefinition>(
  tool: T,
  names: readonly string[],
  useDefaultTier: boolean,
): T {
  if (!shouldDeferTool(tool, names, useDefaultTier)) {
    return tool;
  }
  return { ...tool, deferLoading: true };
}

function shouldDeferTool(
  tool: ToolDefinition,
  names: readonly string[],
  useDefaultTier: boolean,
): boolean {
  if (tool.alwaysLoad === true) return false;
  if (tool.deferLoading === true) return true;
  if (isToolNameListed(tool.name, names)) return true;
  return useDefaultTier && shouldDeferToolByDefault(tool);
}

function isToolNameListed(
  toolName: string,
  names: readonly string[] | undefined,
): boolean {
  if (!names) return false;
  return names.includes(toolName);
}

function isToolNameAllowed(
  toolName: string,
  names: readonly string[] | undefined,
): boolean {
  return names === undefined || isToolNameListed(toolName, names);
}

function resolveSkillRoots(
  workspaceRoot: string,
  configuredRoots: SkillRoot[] | undefined,
): SkillRoot[] {
  const roots =
    configuredRoots && configuredRoots.length > 0
      ? configuredRoots
      : [{ root: projectSkillRoot(workspaceRoot), layer: "project" as const }];
  return roots.map((root) => ({
    ...root,
    root: resolveWorkspacePath(workspaceRoot, root.root),
  }));
}

function resolveWorkspacePath(workspaceRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

/**
 * Shared parser for the read-only inspector tools (`list_skills`,
 * `list_agents`). They only accept `list`/`validate`, which carry no write
 * side effects, so policy can allow them without an approval prompt.
 */
function parseInspectAction(
  args: unknown,
  toolName: string,
): "list" | "validate" {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw toolArgumentsInvalid(`${toolName} expects an object argument.`);
  }
  const action = (args as Record<string, unknown>).action;
  if (action !== "list" && action !== "validate") {
    throw toolArgumentsInvalid(`${toolName} action must be list or validate.`);
  }
  return action;
}

type AgentConfigShape = {
  profiles: AgentProfile[];
  delegateTools: Array<{
    profileId: string;
    toolName?: string;
    description?: string;
    requiresApproval?: boolean;
    forbidNesting?: boolean;
    maxSteps?: number;
  }>;
};

async function readProjectConfig(workspaceRoot: string): Promise<{
  path: string;
  exists: boolean;
  data: Record<string, unknown>;
}> {
  const target = await resolveConfigWriteTarget(
    projectConfigPath(workspaceRoot),
  );
  const loaded = await readConfigFileObject(target.path);
  return {
    path: target.path,
    exists: loaded.exists,
    data: loaded.value,
  };
}

function getAgentConfigShape(
  config: Record<string, unknown>,
): AgentConfigShape {
  const capabilities = isPlainObject(config.capabilities)
    ? config.capabilities
    : {};
  const agents = isPlainObject(capabilities.agents) ? capabilities.agents : {};
  return {
    profiles: Array.isArray(agents.profiles)
      ? agents.profiles.filter(isPlainObject).map((profile) => ({
          ...(profile as unknown as AgentProfile),
        }))
      : [],
    delegateTools: Array.isArray(agents.delegateTools)
      ? agents.delegateTools.filter(isPlainObject).map((tool) => ({
          ...(tool as AgentConfigShape["delegateTools"][number]),
        }))
      : [],
  };
}

function validateAgentConfigShape(
  agents: AgentConfigShape,
): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];
  const ids = new Set<string>();
  for (const [index, profile] of agents.profiles.entries()) {
    const field = `profiles.${index}`;
    if (!isAgentId(profile.id)) {
      errors.push({
        field: `${field}.id`,
        message: "must be a valid agent id",
      });
    } else if (ids.has(profile.id)) {
      errors.push({ field: `${field}.id`, message: "duplicate agent id" });
    } else {
      ids.add(profile.id);
    }
    const mode = profile.mode;
    if (
      mode !== undefined &&
      mode !== "primary" &&
      mode !== "child" &&
      mode !== "all"
    ) {
      errors.push({
        field: `${field}.mode`,
        message: "must be primary, child, or all",
      });
    }
    if (
      profile.use !== undefined &&
      (!isStringArray(profile.use) ||
        profile.use.some((selector) => !isToolUseSelector(selector)))
    ) {
      errors.push({
        field: `${field}.use`,
        message: `must be an array of tool selectors (${formatToolUseSelectorList()})`,
      });
    }
    if (
      profile.allowedTools !== undefined &&
      !isStringArray(profile.allowedTools)
    ) {
      errors.push({
        field: `${field}.allowedTools`,
        message: "must be an array of strings",
      });
    }
    if (
      profile.deniedTools !== undefined &&
      !isStringArray(profile.deniedTools)
    ) {
      errors.push({
        field: `${field}.deniedTools`,
        message: "must be an array of strings",
      });
    }
    if (
      profile.maxSteps !== undefined &&
      (!Number.isInteger(profile.maxSteps) || profile.maxSteps < 1)
    ) {
      errors.push({
        field: `${field}.maxSteps`,
        message: "must be a positive integer",
      });
    }
    validateInlineDelegateTool(
      profile.delegateTool,
      `${field}.delegateTool`,
      errors,
    );
  }
  for (const [index, tool] of agents.delegateTools.entries()) {
    if (!ids.has(tool.profileId)) {
      errors.push({
        field: `delegateTools.${index}.profileId`,
        message: "must reference an existing profile id",
      });
    }
  }
  return errors;
}

function validateInlineDelegateTool(
  delegateTool: AgentProfile["delegateTool"] | undefined,
  field: string,
  errors: Array<{ field: string; message: string }>,
): void {
  if (delegateTool === undefined) return;
  if (!isPlainObject(delegateTool)) {
    errors.push({ field, message: "must be an object" });
    return;
  }
  if (
    delegateTool.toolName !== undefined &&
    (typeof delegateTool.toolName !== "string" ||
      delegateTool.toolName.length === 0)
  ) {
    errors.push({ field: `${field}.toolName`, message: "must be a string" });
  }
  if (
    delegateTool.description !== undefined &&
    typeof delegateTool.description !== "string"
  ) {
    errors.push({
      field: `${field}.description`,
      message: "must be a string",
    });
  }
  if (
    delegateTool.requiresApproval !== undefined &&
    typeof delegateTool.requiresApproval !== "boolean"
  ) {
    errors.push({
      field: `${field}.requiresApproval`,
      message: "must be a boolean",
    });
  }
  if (
    delegateTool.forbidNesting !== undefined &&
    typeof delegateTool.forbidNesting !== "boolean"
  ) {
    errors.push({
      field: `${field}.forbidNesting`,
      message: "must be a boolean",
    });
  }
  const maxSteps = delegateTool.maxSteps;
  if (maxSteps !== undefined) {
    if (
      typeof maxSteps !== "number" ||
      !Number.isInteger(maxSteps) ||
      maxSteps < 1
    ) {
      errors.push({
        field: `${field}.maxSteps`,
        message: "must be a positive integer",
      });
    }
  }
}

type MarkdownAgentAction = "create" | "update" | "replace";

interface MarkdownAgentInput {
  action: MarkdownAgentAction;
  id: string;
  description?: string;
  mode?: "primary" | "child" | "all";
  prompt: string;
  model?: string;
  use?: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  maxSteps?: number;
  replaceReason?: string;
}

interface MarkdownAgentRemoveInput {
  action: "remove";
  id: string;
}

function parseMarkdownAgentRemoveArgs(
  args: Record<string, unknown>,
): MarkdownAgentRemoveInput {
  const id = typeof args.name === "string" ? args.name.trim() : "";
  if (!isAgentId(id)) {
    throw toolArgumentsInvalid(
      "create_agent remove requires a valid Markdown Agent name.",
    );
  }
  return { action: "remove", id };
}

function parseMarkdownAgentArgs(args: unknown): MarkdownAgentInput {
  if (!isPlainObject(args)) {
    throw toolArgumentsInvalid("create_agent expects an object argument.");
  }
  const action = args.action;
  if (action !== "create" && action !== "update" && action !== "replace") {
    throw toolArgumentsInvalid(
      "create_agent action must be create, update, or replace.",
    );
  }
  const id = typeof args.name === "string" ? args.name.trim() : "";
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!isAgentId(id) || !prompt) {
    throw toolArgumentsInvalid(
      "create_agent requires a valid name and non-empty prompt.",
    );
  }
  if (action === "replace" && typeof args.replaceReason !== "string") {
    throw toolArgumentsInvalid("create_agent replace requires replaceReason.");
  }
  const mode = args.mode;
  if (
    mode !== undefined &&
    mode !== "primary" &&
    mode !== "child" &&
    mode !== "all"
  ) {
    throw toolArgumentsInvalid(
      "create_agent mode must be primary, child, or all.",
    );
  }
  const maxSteps = args.maxSteps;
  if (
    maxSteps !== undefined &&
    (typeof maxSteps !== "number" ||
      !Number.isInteger(maxSteps) ||
      maxSteps < 1)
  ) {
    throw toolArgumentsInvalid(
      "create_agent maxSteps must be a positive integer.",
    );
  }
  const requestedModel =
    typeof args.model === "string" && args.model.trim()
      ? args.model.trim()
      : undefined;
  const model = requestedModel === "inherit" ? undefined : requestedModel;
  assertMarkdownAgentModelRef(model);
  return {
    action,
    id,
    prompt,
    ...(typeof args.description === "string"
      ? { description: args.description.trim() }
      : {}),
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    ...(args.use !== undefined
      ? { use: toolUseSelectorArrayArg(args.use, "use") }
      : {}),
    ...(args.allowedTools !== undefined
      ? { allowedTools: stringArrayArg(args.allowedTools, "allowedTools") }
      : {}),
    ...(args.deniedTools !== undefined
      ? { deniedTools: stringArrayArg(args.deniedTools, "deniedTools") }
      : {}),
    ...(typeof maxSteps === "number" ? { maxSteps } : {}),
    ...(typeof args.replaceReason === "string"
      ? { replaceReason: args.replaceReason.trim() }
      : {}),
  };
}

async function writeMarkdownAgent(
  ctx: RuntimeContext,
  workspaceRoot: string,
  input: MarkdownAgentInput,
) {
  const path = join(".sparkwright", "agents", `${input.id}.md`);
  const before = await readWorkspaceTextIfExists(ctx, path);
  if (input.action === "create" && before !== undefined) {
    throw new Error(
      `Markdown Agent already exists: ${input.id}. Use update or replace.`,
    );
  }
  if (input.action === "update" && before === undefined) {
    throw new Error(`Markdown Agent not found for update: ${input.id}`);
  }
  const content = markdownAgentDocument(input);
  const profile = parseAgentProfileFile(input.id, content);
  if (profile.id !== input.id || !profile.prompt) {
    throw new Error("create_agent produced an invalid Markdown Agent profile.");
  }
  if (profile.model !== undefined && typeof profile.model !== "string") {
    throw toolArgumentsInvalid(
      "create_agent produced a non-string Markdown Agent model reference.",
    );
  }
  assertMarkdownAgentModelRef(profile.model as string | undefined);
  await assertMarkdownAgentModelResolvable(
    workspaceRoot,
    profile.model as string | undefined,
  );
  const config = await readProjectConfig(workspaceRoot);
  if (
    getAgentConfigShape(config.data).profiles.some(
      (entry) => entry.id === input.id,
    )
  ) {
    throw new Error(
      `Markdown Agent ${input.id} is shadowed by an explicit config profile; update config deliberately or choose another id.`,
    );
  }
  if (before === content) {
    const canonicalPath = await canonicalWorkspacePath(ctx, path);
    ctx.reportWorkspaceWriteSkipped?.({
      path: canonicalPath,
      reason: `Markdown Agent ${input.id} already matches the requested final file.`,
    });
    return markdownAgentResult(input, canonicalPath, profile, false);
  }
  const write = await writeCapabilityText(
    ctx,
    path,
    content,
    `${input.action === "replace" ? "Replace" : input.action === "update" ? "Update" : "Create"} Markdown Agent ${input.id}`,
  );
  const collisions: string[] = [];
  const entries = await discoverAgentProfileFileEntriesInDir(
    join(workspaceRoot, ".sparkwright", "agents"),
    {
      onCollision: (collision) => collisions.push(collision.id),
    },
  );
  const expectedSource = resolve(workspaceRoot, path);
  const discoveredEntry = entries.find(
    (entry) => entry.profile.id === input.id && entry.source === expectedSource,
  );
  if (
    collisions.includes(input.id) ||
    !discoveredEntry ||
    !discoveredEntry.profile.prompt
  ) {
    throw new Error(
      `Markdown Agent ${input.id} was written but its exact file is not uniquely callable after rediscovery.`,
    );
  }
  const callable = discoveredEntry.profile;
  ctx.reportCapabilityMutationCompleted?.({
    action: `${input.action}_markdown_agent`,
    path: write.path,
    reason: `Write Markdown Agent ${input.id}`,
    fileCount: 1,
    files: [{ relativePath: write.path }],
    metadata: {
      kind: "agent",
      id: input.id,
      identity: markdownAgentIdentity(input.id, content),
    },
  });
  return {
    ...markdownAgentResult(input, write.path, callable, true),
    diffArtifactId: write.diffArtifactId,
    writeSummary: write.summary,
  };
}

async function removeMarkdownAgent(
  ctx: RuntimeContext,
  input: MarkdownAgentRemoveInput,
) {
  const path = join(".sparkwright", "agents", `${input.id}.md`);
  const before = await readWorkspaceTextIfExists(ctx, path);
  if (before === undefined) {
    throw new Error(`Markdown Agent not found for remove: ${input.id}`);
  }
  const write = await removeCapabilityFile(
    ctx,
    path,
    `Remove Markdown Agent ${input.id}`,
  );
  if ((await readWorkspaceTextIfExists(ctx, path)) !== undefined) {
    throw new Error(`Markdown Agent ${input.id} still exists after removal.`);
  }
  ctx.reportCapabilityMutationCompleted?.({
    action: "remove_markdown_agent",
    path: write.path,
    reason: `Remove Markdown Agent ${input.id}`,
    fileCount: 1,
    files: [{ relativePath: write.path }],
    metadata: {
      kind: "agent",
      id: input.id,
      identity: markdownAgentIdentity(input.id, before),
    },
  });
  return {
    action: input.action,
    name: input.id,
    path: write.path,
    changed: true,
    diffArtifactId: write.diffArtifactId,
    writeSummary: write.summary,
  };
}

function assertMarkdownAgentModelRef(model: string | undefined): void {
  if (!model) return;
  if (isValidModelRefSyntax(model)) return;
  throw toolArgumentsInvalid(
    `create_agent model "${model}" must be in "provider/model" form. ` +
      'Pass model="inherit" (or omit model) to inherit the parent/default model.',
  );
}

async function assertMarkdownAgentModelResolvable(
  workspaceRoot: string,
  model: string | undefined,
): Promise<void> {
  if (!model) return;
  const loaded = await loadHostConfig(workspaceRoot);
  const selection = resolveModelSelection(loaded.config, model);
  if (selection.kind !== "error") return;
  throw toolArgumentsInvalid(
    `create_agent model "${model}" is not callable in the current configuration: ${selection.message} ` +
      'Pass model="inherit" (or omit model) to inherit the parent/default model.',
  );
}

function markdownAgentResult(
  input: MarkdownAgentInput,
  path: string,
  profile: AgentProfile,
  changed: boolean,
) {
  const { id: _internalId, ...publicProfile } = profile;
  return {
    action: input.action,
    name: input.id,
    path,
    changed,
    profile: {
      ...publicProfile,
      name: input.id,
    },
    semanticSummary: {
      mode: profile.mode ?? "child",
      model: profile.model,
      allowedTools: profile.allowedTools ?? [],
      deniedTools: profile.deniedTools ?? [],
      use: profile.use ?? [],
      maxSteps: profile.maxSteps,
      identity: markdownAgentIdentity(input.id, markdownAgentDocument(input)),
    },
    callability: {
      callable: Boolean(profile.prompt),
      mode: profile.mode ?? "child",
    },
  };
}

function markdownAgentDocument(input: MarkdownAgentInput): string {
  const lines = ["---", `name: ${yamlScalar(input.id)}`];
  if (input.description)
    lines.push(`description: ${yamlScalar(input.description)}`);
  if (input.model) lines.push(`model: ${yamlScalar(input.model)}`);
  if (input.mode) lines.push(`mode: ${input.mode}`);
  if (input.use?.length)
    lines.push(`use: [${input.use.map(yamlScalar).join(", ")}]`);
  if (input.allowedTools?.length)
    lines.push(
      `allowedTools: [${input.allowedTools.map(yamlScalar).join(", ")}]`,
    );
  if (input.deniedTools?.length)
    lines.push(
      `deniedTools: [${input.deniedTools.map(yamlScalar).join(", ")}]`,
    );
  if (input.maxSteps) lines.push(`maxSteps: ${input.maxSteps}`);
  lines.push("---", "", input.prompt, "");
  return lines.join("\n");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** Read-only agent profile report shared by `list_agents`. */
async function loadAgentReport(
  workspaceRoot: string,
  action: "list" | "validate",
) {
  const config = await readProjectConfig(workspaceRoot);
  const agents = getAgentConfigShape(config.data);
  return {
    action,
    path: config.path,
    exists: config.exists,
    agents,
    errors: validateAgentConfigShape(agents),
  };
}

function toolUseSelectorArrayArg(value: unknown, field: string): string[] {
  const selectors = stringArrayArg(value, field);
  const invalid = selectors.find((selector) => !isToolUseSelector(selector));
  if (invalid) {
    throw toolArgumentsInvalid(
      `create_agent ${field} contains unknown selector "${invalid}" (allowed: ${formatToolUseSelectorList()}).`,
    );
  }
  return selectors;
}

function stringArrayArg(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw toolArgumentsInvalid(
      `create_agent ${field} must be an array of strings.`,
    );
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function isAgentId(value: unknown): value is string {
  // `:` is accepted for explicit namespaced ids (e.g. review:foo). Ids stay
  // flat by default; the path is never auto-derived into the id.
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
