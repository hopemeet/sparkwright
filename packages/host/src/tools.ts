import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@sparkwright/core";
import type { AgentProfile } from "@sparkwright/agent-runtime";
import {
  createGlobPathsTool as createGlobPathsToolBase,
  createGrepTextTool as createGrepTextToolBase,
} from "@sparkwright/coding-tools";
import {
  createCronTool as createCronToolBase,
  defaultCronRoot,
} from "@sparkwright/cron";
import { type SkillRoot } from "@sparkwright/skills";
import type { CapabilityToolsConfig } from "./config.js";
import { projectSkillRoot } from "./skill-roots.js";
import { loadLayeredSkillReport } from "./skill-report.js";

/**
 * Built-in tool: read a UTF-8 file from the workspace. Safe (no approval).
 *
 * This duplicates the equivalent in @sparkwright/tui temporarily; once the
 * TUI moves to consume the host via @sparkwright/sdk-node it will be
 * dropped from there and live only here.
 */
// read_file paging defaults. The old tool returned a fixed 400-char preview,
// which made the model loop (it never saw past the stub, so it re-read the same
// file). We now return real content, but a naive "return the whole file" is the
// opposite failure: a large file dumps everything into the context budget. So
// the tool pages by line — default window, explicit "hasMore", and a per-call
// character ceiling as a hard backstop against pathologically long lines.
const READ_DEFAULT_LINES = 2000;
const READ_MAX_CHARS = 60_000;

export function createReadFileTool() {
  return defineTool({
    name: "read_file",
    description:
      "Read a UTF-8 text file from the workspace. Returns up to `limit` lines " +
      "(default 2000) starting at 1-based line `offset` (default 1). For large " +
      "files, read successive windows by passing `offset`; the result reports " +
      "`totalLines` and `hasMore` plus the next offset to use. `path` must be " +
      "a concrete file path; glob patterns are not expanded. Use `glob_paths` " +
      "first when you need to discover files from a pattern.",
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
    policy: { risk: "safe" },
    async execute(args: unknown, ctx) {
      if (!ctx.workspace) throw new Error("Workspace is not configured.");
      const { path, offset, limit } = args as {
        path: string;
        offset?: number;
        limit?: number;
      };
      if (containsGlobPattern(path)) {
        throw toolArgumentsInvalid(
          `read_file does not support glob patterns: ${path}. Use glob_paths to find matching files, then call read_file with a concrete path.`,
        );
      }
      const content = await ctx.workspace.readText(path).catch((error) => {
        if (isNodeErrorCode(error, "EISDIR")) {
          throw toolArgumentsInvalid(
            `read_file expected a file path but ${path} is a directory. Use glob_paths to list files inside it, then call read_file with a concrete file path.`,
          );
        }
        throw error;
      });
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
        bytes: content.length,
        totalLines,
        startLine,
        endLine,
        content: slice,
        hasMore,
        truncated: charCapped,
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

export function createGlobPathsTool(workspaceRoot: string) {
  return createGlobPathsToolBase({ workspaceRoot });
}

/**
 * Built-in read-only tool: search file *contents* for a string or regex.
 * `glob_paths` only matches paths, so finding a symbol by name (e.g. "a
 * function named frobnicate") is impossible by globbing alone — it degenerates
 * into reading every file. grep_text answers that in one call, and belongs in
 * the same read-only discovery set as read_file + glob_paths.
 */
export function createGrepTextTool(workspaceRoot: string) {
  return createGrepTextToolBase({ workspaceRoot });
}

/**
 * Built-in tool: append a heading + body section to a file. Risky — emits
 * approval.requested via core.
 */
export function createAppendFileTool() {
  return defineTool({
    name: "append_file",
    description:
      "Append a short heading + body section to a UTF-8 text file, creating " +
      "the file (and any parent dirs) if it does not exist. Requires approval. " +
      "Pass `heading` as plain text WITHOUT any leading '#': the tool renders " +
      "it as a level-2 heading itself.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        heading: { type: "string" },
        body: { type: "string" },
      },
      required: ["path", "heading", "body"],
      additionalProperties: false,
    },
    policy: { risk: "risky" },
    governance: {
      sideEffects: ["write"],
      idempotency: "conditional",
      dataSensitivity: "internal",
      origin: { kind: "local", name: "sparkwright" },
    },
    async execute(args: unknown, ctx) {
      if (!ctx.workspace) throw new Error("Workspace is not configured.");
      const { path, body } = args as {
        path: string;
        heading: string;
        body: string;
      };
      // Models often pass `heading` already carrying its markdown marker
      // ("## Title"), and we prepend "## " unconditionally — yielding the
      // "## ## Title" double-prefix seen in the C2 trace. Strip any leading
      // '#'/whitespace so the tool owns exactly one level-2 marker regardless
      // of how the caller phrased it.
      const heading = (args as { heading: string }).heading
        .replace(/^\s*#+\s*/, "")
        .trim();
      // A missing file is treated as empty so append_file can CREATE the file.
      // Only ENOENT is swallowed; other read errors (permission, is-a-dir)
      // propagate.
      const current = await ctx.workspace
        .readText(path)
        .catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return "";
          throw err;
        });
      if (current.includes(`## ${heading}`)) {
        ctx.reportWorkspaceWriteSkipped?.({
          path,
          reason: `Heading "${heading}" already present`,
        });
        return { path, changed: false };
      }
      const next = `${current.replace(/\s+$/, "")}\n\n## ${heading}\n\n${body}\n`;
      const write = await ctx.workspace.writeText(path, next, {
        reason: `Append ${heading}`,
      });
      if (write?.diffArtifact) ctx.reportToolArtifact?.(write.diffArtifact);
      return {
        path,
        changed: true,
        diffArtifactId: write?.diffArtifactId,
        writeSummary: write?.summary,
        finalLines: write?.summary.lastLines,
      };
    },
  });
}

export function createCronTool() {
  return createCronToolBase({ rootDir: defaultCronRoot(process.env) });
}

export function createSkillInspectorTool(
  workspaceRoot: string,
  configuredRoots: SkillRoot[] | undefined,
) {
  return defineTool({
    name: "inspect_skills",
    description:
      "List or validate workspace skills. Read-only: never writes. Use this " +
      "to discover skills or check skill health; use manage_skill to create one.",
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
    isReplaySafe: true,
    async execute(args: unknown) {
      const action = parseInspectAction(args, "inspect_skills");
      const roots = resolveSkillRoots(workspaceRoot, configuredRoots);
      return loadLayeredSkillReport(roots, {
        includeMissingRoots: action === "validate",
      });
    },
  });
}

export function createSkillManagerTool(
  workspaceRoot: string,
  _configuredRoots: SkillRoot[] | undefined,
) {
  return defineTool({
    name: "manage_skill",
    description:
      "Create a workspace skill. Writes a SKILL.md under an existing or " +
      "default skill root. Use inspect_skills to list or validate skills.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create"] },
        name: {
          type: "string",
          description:
            "Skill name for create. Use lowercase letters, numbers, and hyphens.",
        },
        description: {
          type: "string",
          description: "Skill description for create.",
        },
        root: {
          type: "string",
          description:
            "Optional skill root for create. Relative paths resolve from the workspace.",
        },
        force: {
          type: "boolean",
          description: "Overwrite an existing SKILL.md when creating.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    policy: { risk: "risky" },
    governance: {
      origin: { kind: "local", name: "sparkwright" },
      sideEffects: ["read", "write"],
      idempotency: "conditional",
    },
    isReplaySafe: false,
    async execute(args: unknown) {
      const input = parseSkillManagerArgs(args);
      if (!input.name || !isSkillName(input.name)) {
        throw new Error(
          "manage_skill create requires a valid lowercase skill name.",
        );
      }
      if (!input.description || input.description.trim().length === 0) {
        throw new Error("manage_skill create requires description.");
      }
      const root = input.root
        ? resolveWorkspacePath(workspaceRoot, input.root)
        : projectSkillRoot(workspaceRoot);
      const skillDir = join(root, input.name);
      const skillPath = join(skillDir, "SKILL.md");
      if ((await pathExists(skillPath)) && !input.force) {
        throw new Error(
          `Skill already exists: ${skillPath}. Pass force=true to overwrite.`,
        );
      }
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        skillPath,
        renderSkillTemplate(input.name, input.description),
        "utf8",
      );
      return {
        action: "create",
        name: input.name,
        path: skillPath,
        changed: true,
      };
    },
  });
}

export function createAgentInspectorTool(workspaceRoot: string) {
  return defineTool({
    name: "inspect_agents",
    description:
      "List or validate project agent profiles in .sparkwright/config.json. " +
      "Read-only: never writes. Use manage_agent to create or remove a profile.",
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
    isReplaySafe: true,
    async execute(args: unknown) {
      const action = parseInspectAction(args, "inspect_agents");
      return loadAgentReport(workspaceRoot, action);
    },
  });
}

export function createAgentManagerTool(workspaceRoot: string) {
  return defineTool({
    name: "manage_agent",
    description:
      "Create or remove project agent profiles in .sparkwright/config.json. " +
      "To create, pass action='create' with a unique id and a prompt (the " +
      "system prompt used when the profile is spawned). Use inspect_agents to " +
      "list or validate profiles.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "remove"],
        },
        id: {
          type: "string",
          description: "Agent profile id for create/remove.",
        },
        name: { type: "string" },
        description: { type: "string" },
        mode: { type: "string", enum: ["primary", "child", "all"] },
        prompt: {
          type: "string",
          description: "System prompt used when this profile is spawned.",
        },
        allowedTools: {
          type: "array",
          items: { type: "string" },
        },
        deniedTools: {
          type: "array",
          items: { type: "string" },
        },
        maxSteps: { type: "integer", minimum: 1 },
        delegateToolName: {
          type: "string",
          description:
            "Optional delegate tool name to expose this profile to the main agent.",
        },
        force: {
          type: "boolean",
          description: "Replace an existing profile with the same id.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    policy: { risk: "risky" },
    governance: {
      origin: { kind: "local", name: "sparkwright" },
      sideEffects: ["read", "write"],
      idempotency: "conditional",
    },
    isReplaySafe: false,
    async execute(args: unknown) {
      const input = parseAgentManagerArgs(args);
      const config = await readProjectConfig(workspaceRoot);
      const agents = getAgentConfigShape(config.data);

      if (!input.id || !isAgentId(input.id)) {
        throw new Error("manage_agent requires a valid agent id.");
      }

      if (input.action === "remove") {
        const beforeProfiles = agents.profiles.length;
        agents.profiles = agents.profiles.filter(
          (profile) => profile.id !== input.id,
        );
        agents.delegateTools = agents.delegateTools.filter(
          (tool) => tool.profileId !== input.id,
        );
        if (agents.profiles.length === beforeProfiles) {
          throw new Error(`Agent profile not found: ${input.id}`);
        }
        setAgentConfigShape(config.data, agents);
        await writeProjectConfig(config.path, config.data);
        return {
          action: "remove",
          id: input.id,
          path: config.path,
          changed: true,
          agents,
          errors: validateAgentConfigShape(agents),
        };
      }

      if (!input.prompt || input.prompt.trim().length === 0) {
        throw new Error("manage_agent create requires prompt.");
      }
      const existingIndex = agents.profiles.findIndex(
        (profile) => profile.id === input.id,
      );
      if (existingIndex >= 0 && !input.force) {
        throw new Error(
          `Agent profile already exists: ${input.id}. Pass force=true to replace it.`,
        );
      }
      const mode = input.mode ?? "child";
      const profile: AgentProfile = {
        id: input.id,
        name: input.name ?? input.id,
        ...(input.description ? { description: input.description } : {}),
        mode,
        prompt: input.prompt.trim(),
        experimental: {
          mode,
          prompt: input.prompt.trim(),
        },
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        ...(input.deniedTools ? { deniedTools: input.deniedTools } : {}),
        ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
      };
      if (existingIndex >= 0) {
        agents.profiles[existingIndex] = profile;
      } else {
        agents.profiles.push(profile);
      }
      if (input.delegateToolName) {
        agents.delegateTools = agents.delegateTools.filter(
          (tool) =>
            tool.profileId !== input.id &&
            tool.toolName !== input.delegateToolName,
        );
        agents.delegateTools.push({
          profileId: input.id,
          toolName: input.delegateToolName,
          requiresApproval: true,
          forbidNesting: true,
          ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
        });
      }
      const errors = validateAgentConfigShape(agents);
      if (errors.length > 0) {
        throw new Error(
          `manage_agent create produced invalid config: ${JSON.stringify(errors)}`,
        );
      }
      setAgentConfigShape(config.data, agents);
      await writeProjectConfig(config.path, config.data);
      return {
        action: "create",
        id: input.id,
        path: config.path,
        changed: true,
        profile,
        agents,
        errors,
      };
    },
  });
}

export function applyToolConfig<T extends ToolDefinition>(
  tools: T[],
  config: CapabilityToolsConfig | undefined,
): T[] {
  if (!config) return tools;
  return tools
    .filter((tool) => {
      if (matchesAnyToolPattern(tool.name, config.disabled)) return false;
      if (config.enabled !== undefined) {
        return matchesAnyToolPattern(tool.name, config.enabled);
      }
      return true;
    })
    .map((tool) => {
      if (
        tool.alwaysLoad === true ||
        !matchesAnyToolPattern(tool.name, config.defer)
      ) {
        return tool;
      }
      return { ...tool, deferLoading: true };
    }) as T[];
}

function containsGlobPattern(path: string): boolean {
  return /[*?[]/.test(path);
}

function matchesAnyToolPattern(
  toolName: string,
  patterns: readonly string[] | undefined,
): boolean {
  return Boolean(
    patterns?.some((pattern) => matchesToolPattern(toolName, pattern)),
  );
}

function matchesToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === toolName) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(toolName);
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
 * Shared parser for the read-only inspector tools (`inspect_skills`,
 * `inspect_agents`). They only accept `list`/`validate`, which carry no write
 * side effects, so policy can allow them without an approval prompt.
 */
function parseInspectAction(
  args: unknown,
  toolName: string,
): "list" | "validate" {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${toolName} expects an object argument.`);
  }
  const action = (args as Record<string, unknown>).action;
  if (action !== "list" && action !== "validate") {
    throw new Error(`${toolName} action must be list or validate.`);
  }
  return action;
}

function parseSkillManagerArgs(args: unknown): {
  action: "create";
  name?: string;
  description?: string;
  root?: string;
  force?: boolean;
} {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("manage_skill expects an object argument.");
  }
  const record = args as Record<string, unknown>;
  const action = record.action;
  if (action !== "create") {
    throw new Error("manage_skill action must be create.");
  }
  return {
    action,
    ...(typeof record.name === "string" ? { name: record.name.trim() } : {}),
    ...(typeof record.description === "string"
      ? { description: record.description.trim() }
      : {}),
    ...(typeof record.root === "string" ? { root: record.root } : {}),
    ...(typeof record.force === "boolean" ? { force: record.force } : {}),
  };
}

function renderSkillTemplate(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    'version: "1.0.0"',
    "metadata:",
    '  version: "1.0.0"',
    "---",
    "",
    `Use this skill when the user asks for ${description}`,
    "",
  ].join("\n");
}

function isSkillName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
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
  const path = join(workspaceRoot, ".sparkwright", "config.json");
  try {
    return {
      path,
      exists: true,
      data: JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, exists: false, data: {} };
    }
    throw error;
  }
}

async function writeProjectConfig(
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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

function setAgentConfigShape(
  config: Record<string, unknown>,
  agents: AgentConfigShape,
): void {
  const capabilities = isPlainObject(config.capabilities)
    ? config.capabilities
    : {};
  capabilities.agents = {
    profiles: agents.profiles,
    ...(agents.delegateTools.length > 0
      ? { delegateTools: agents.delegateTools }
      : {}),
  };
  config.capabilities = capabilities;
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
    const mode = profile.experimental?.mode ?? profile.mode;
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

/** Read-only agent profile report shared by `inspect_agents`. */
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

function parseAgentManagerArgs(args: unknown): {
  action: "create" | "remove";
  id?: string;
  name?: string;
  description?: string;
  mode?: "primary" | "child" | "all";
  prompt?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  maxSteps?: number;
  delegateToolName?: string;
  force?: boolean;
} {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("manage_agent expects an object argument.");
  }
  const record = args as Record<string, unknown>;
  const action = record.action;
  if (action !== "create" && action !== "remove") {
    throw new Error("manage_agent action must be create or remove.");
  }
  const mode = record.mode;
  if (
    mode !== undefined &&
    mode !== "primary" &&
    mode !== "child" &&
    mode !== "all"
  ) {
    throw new Error("manage_agent mode must be primary, child, or all.");
  }
  const maxSteps = record.maxSteps;
  if (
    maxSteps !== undefined &&
    (!Number.isInteger(maxSteps) || (maxSteps as number) < 1)
  ) {
    throw new Error("manage_agent maxSteps must be a positive integer.");
  }
  return {
    action,
    ...(typeof record.id === "string" ? { id: record.id.trim() } : {}),
    ...(typeof record.name === "string" ? { name: record.name.trim() } : {}),
    ...(typeof record.description === "string"
      ? { description: record.description.trim() }
      : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(typeof record.prompt === "string"
      ? { prompt: record.prompt.trim() }
      : {}),
    ...(record.allowedTools !== undefined
      ? { allowedTools: stringArrayArg(record.allowedTools, "allowedTools") }
      : {}),
    ...(record.deniedTools !== undefined
      ? { deniedTools: stringArrayArg(record.deniedTools, "deniedTools") }
      : {}),
    ...(maxSteps !== undefined ? { maxSteps: maxSteps as number } : {}),
    ...(typeof record.delegateToolName === "string"
      ? { delegateToolName: record.delegateToolName.trim() }
      : {}),
    ...(typeof record.force === "boolean" ? { force: record.force } : {}),
  };
}

function stringArrayArg(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`manage_agent ${field} must be an array of strings.`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function isAgentId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
