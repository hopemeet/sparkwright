import { isAbsolute, resolve } from "node:path";
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
  createEditAnchoredTextTool as createEditAnchoredTextToolBase,
  createGlobPathsTool as createGlobPathsToolBase,
  createGrepTextTool as createGrepTextToolBase,
  createListDirTool as createListDirToolBase,
  createReadAnchoredTextTool as createReadAnchoredTextToolBase,
  createWriteFileTool as createWriteFileToolBase,
} from "@sparkwright/coding-tools";
import {
  createCronTool as createCronToolBase,
  defaultCronRoot,
} from "@sparkwright/cron";
import { type SkillRoot } from "@sparkwright/skills";
import {
  canonicalWorkspacePath,
  writeCapabilityText,
  type CapabilityWriteResult,
} from "./capability-mutation.js";
import {
  projectConfigPath,
  readConfigFileObject,
  resolveConfigWriteTarget,
  serializeConfigFileObject,
  type CapabilityToolsConfig,
} from "./config.js";
import {
  formatToolUseSelectorList,
  isToolUseSelector,
} from "./tool-selectors.js";
import {
  createSkillCreateProposal,
  createSkillUpdateProposal,
  listSkillProposals,
  type SkillProposalProvenance,
  type SkillProposalSummary,
} from "./skill-evolution.js";
import { delegateToolName } from "./delegate-capability.js";
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
      "a concrete file path; glob patterns are not expanded. Use `glob` " +
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
    async execute(args: unknown, ctx) {
      if (!ctx.workspace) throw new Error("Workspace is not configured.");
      const { path: rawPath, offset, limit } = readFileToolInput(args);
      const path = await normalizeWorkspacePathArg(rawPath, ctx.workspace);
      if (containsGlobPattern(path)) {
        throw toolArgumentsInvalid(
          `read_file does not support glob patterns: ${rawPath}. Use glob to find matching files, then call read_file with a concrete path.`,
        );
      }
      const content = await ctx.workspace.readText(path).catch((error) => {
        if (isNodeErrorCode(error, "EISDIR")) {
          throw toolArgumentsInvalid(
            `read_file expected a file path but ${path} is a directory. Use glob to list files inside it, then call read_file with a concrete file path.`,
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

function readFileToolInput(args: unknown): {
  path: string;
  offset?: number;
  limit?: number;
} {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw toolArgumentsInvalid("read_file input must be an object.");
  }
  const record = args as Record<string, unknown>;
  if (typeof record.path !== "string" || record.path.trim().length === 0) {
    throw toolArgumentsInvalid("read_file requires a non-empty string path.");
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
 * set as read_file + glob + grep.
 */
export function createListDirTool(workspaceRoot: string) {
  return createListDirToolBase({ workspaceRoot });
}

/**
 * Built-in read-only tool: search file *contents* for a string or regex.
 * `glob` only matches paths, so finding a symbol by name (e.g. "a
 * function named frobnicate") is impossible by globbing alone — it degenerates
 * into reading every file. grep answers that in one call, and belongs in
 * the same read-only discovery set as read_file + glob.
 */
export function createGrepTextTool(workspaceRoot: string) {
  return createGrepTextToolBase({ workspaceRoot });
}

/**
 * Built-in read-only tool: read a file with stable line anchors used by
 * edit_anchored_text. Expose both tools together so models do not invent
 * anchors from plain read_file output.
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

/**
 * Built-in write tool: apply verified anchored edits (replace/delete/append/
 * prepend relative to a unique text anchor) through the workspace write path.
 * Supports in-place line replacement — needed for "make one minimal fix" tasks
 * where appending a new section would leave the incorrect text behind. The
 * write itself is still scope- and approval-gated inside Workspace.writeText,
 * so this preserves the --target / --yes contract.
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
      "to discover current skills or check skill health; use create_skill to draft a create proposal.",
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
      const action = parseInspectAction(args, "list_skills");
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
    name: "create_skill",
    description:
      "Draft a proposal to create a project Skill. This does not apply the " +
      "proposal or write the current Skill package; a human must review and " +
      "apply it through the Skill proposal flow. Use list_skills to list or " +
      "validate current skills.",
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
            "Optional project skill root. Omit for the default .sparkwright/skills root.",
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
    previewArgs(args) {
      const r = previewRecord(args);
      const action = previewString(r.action);
      const name = previewString(r.name);
      const preview = [action, name].filter(Boolean).join(" ");
      return preview || undefined;
    },
    isReplaySafe: false,
    async execute(args: unknown, ctx) {
      const input = parseSkillManagerArgs(args);
      if (!input.name || !isSkillName(input.name)) {
        throw new Error(
          "create_skill create requires a valid lowercase skill name.",
        );
      }
      if (!input.description || input.description.trim().length === 0) {
        throw new Error("create_skill create requires description.");
      }
      resolveSkillCreateRoot(workspaceRoot, input.root);
      const provenance = skillProposalProvenanceFromContext(
        ctx,
        input.description,
      );
      const existing = await findExistingRunSkillDraft(
        workspaceRoot,
        input.name,
        provenance.runId,
        "create",
      );
      if (existing) {
        return skillDraftToolOutput(existing, false);
      }
      const proposal = await createSkillCreateProposal({
        workspaceRoot,
        name: input.name,
        description: input.description,
        provenance,
        mutationReporter: ctx,
      });
      return skillDraftToolOutput(proposal, true);
    },
  });
}

export function createSkillUpdateTool(
  workspaceRoot: string,
  configuredRoots: SkillRoot[] | undefined,
) {
  return defineTool({
    name: "update_skill",
    description:
      "Draft an evolution proposal for an existing skill. Creates a proposal only; " +
      "it does not apply the update. Use list_skills first to find the skill. " +
      "Pass `body` with the full revised SKILL.md to propose real authored " +
      "content; omit it to record only the intent as a stub.",
    deferLoading: true,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["draft"] },
        name: {
          type: "string",
          description:
            "Existing skill name. Use lowercase letters, numbers, and hyphens.",
        },
        description: {
          type: "string",
          description: "Short reason and intent for the proposed evolution.",
        },
        body: {
          type: "string",
          description:
            "Full revised SKILL.md content (frontmatter + body). Its frontmatter " +
            "name must match `name`. When provided, this becomes the proposed " +
            "content instead of an intent stub.",
        },
      },
      required: ["action", "name", "description"],
      additionalProperties: false,
    },
    policy: { risk: "risky" },
    governance: {
      origin: { kind: "local", name: "sparkwright" },
      sideEffects: ["read", "write"],
      idempotency: "conditional",
    },
    previewArgs(args) {
      const r = previewRecord(args);
      const action = previewString(r.action);
      const name = previewString(r.name);
      const preview = [action, name].filter(Boolean).join(" ");
      return preview || undefined;
    },
    isReplaySafe: false,
    async execute(args: unknown, ctx) {
      const input = parseSkillUpdateArgs(args);
      const roots = resolveSkillRoots(workspaceRoot, configuredRoots);
      const body = input.body;
      const provenance = skillProposalProvenanceFromContext(
        ctx,
        input.description,
      );
      // One draft per skill per run, by design: a model that loops on
      // update_skill (re-phrasing the description each time) must not spawn N
      // proposals. We dedupe on runId+skillName intentionally — not on content —
      // so a second call in the same run returns the first draft instead of
      // proliferating. The result carries `existing: true` so the caller can see
      // no new proposal was created.
      const existing = await findExistingRunSkillDraft(
        workspaceRoot,
        input.name,
        provenance.runId,
      );
      if (existing) {
        return skillDraftToolOutput(existing, false);
      }
      const proposalInput = {
        workspaceRoot,
        skillRoots: roots,
        name: input.name,
        description: input.description,
        ...(body ? { applyEdit: () => body } : {}),
        provenance,
        mutationReporter: ctx,
      };
      const proposal = await createSkillUpdateProposal(proposalInput);

      return skillDraftToolOutput(proposal, true);
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
    isReplaySafe: true,
    async execute(args: unknown) {
      const action = parseInspectAction(args, "list_agents");
      return loadAgentReport(workspaceRoot, action);
    },
  });
}

export function createAgentManagerTool(workspaceRoot: string) {
  return defineTool({
    name: "create_agent",
    description:
      "Create, update, replace, or remove project agent profiles in the project Sparkwright config. " +
      "Use action='create' with a unique id and prompt for new profiles; repeated identical creates are idempotent. " +
      "Use action='update' to patch fields on an existing profile. Use action='replace' with replaceReason to intentionally replace an existing profile. " +
      "Profiles are inspectable by default; pass delegateToolName (for example delegate_reviewer) when " +
      "the main agent should be able to call the profile as a delegate tool. Use list_agents to list or validate profiles.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "replace", "remove"],
        },
        id: {
          type: "string",
          description: "Agent profile id.",
        },
        name: { type: "string" },
        description: { type: "string" },
        mode: {
          type: "string",
          enum: ["primary", "child", "all"],
          description:
            "Use child/all for reusable delegate profiles. primary profiles shape the main run and are not callable as child delegates.",
        },
        prompt: {
          type: "string",
          description:
            "System prompt used when this profile is spawned. Required for create/replace; optional for update.",
        },
        use: {
          type: "array",
          description:
            "Optional high-level tool selectors such as workspace.read.",
          items: { type: "string" },
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
            "Optional delegate tool name to expose this child/all profile to the main agent.",
        },
        removeDelegateTool: {
          type: "boolean",
          description:
            "For action='update', remove delegate tools that point at this profile.",
        },
        replaceReason: {
          type: "string",
          description:
            "Required for action='replace'; concise reason why replacing the existing profile is intentional.",
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
    async execute(args: unknown, ctx) {
      if (!ctx.workspace) throw new Error("Workspace is not configured.");
      const input = parseAgentManagerArgs(args);
      const config = await readProjectConfig(workspaceRoot);
      const agents = getAgentConfigShape(config.data);

      if (!input.id || !isAgentId(input.id)) {
        throw new Error("create_agent requires a valid agent id.");
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
        const write = await writeProjectConfig(ctx, config.path, config.data);
        ctx.reportCapabilityMutationCompleted?.({
          action: "remove_agent_profile",
          path: write.path,
          reason: `Remove Agent profile ${input.id}`,
          fileCount: 1,
          files: [{ relativePath: write.path }],
          metadata: { kind: "agent", id: input.id },
        });
        return {
          action: "remove",
          id: input.id,
          path: write.path,
          changed: true,
          diffArtifactId: write.diffArtifactId,
          writeSummary: write.summary,
          agents,
          errors: validateAgentConfigShape(agents),
        };
      }

      const existingIndex = agents.profiles.findIndex(
        (profile) => profile.id === input.id,
      );

      if (input.action === "update" && existingIndex < 0) {
        throw new Error(`Agent profile not found for update: ${input.id}`);
      }
      if (input.action === "replace" && existingIndex < 0) {
        throw new Error(`Agent profile not found for replace: ${input.id}`);
      }
      if (input.action === "replace" && !input.replaceReason) {
        throw new Error("create_agent replace requires replaceReason.");
      }
      if (
        (input.action === "create" || input.action === "replace") &&
        (!input.prompt || input.prompt.trim().length === 0)
      ) {
        throw new Error(`create_agent ${input.action} requires prompt.`);
      }

      const nextAgents = cloneAgentConfigShape(agents);
      const existingProfile =
        existingIndex >= 0 ? agents.profiles[existingIndex] : undefined;
      const effectiveAction =
        input.action === "create" && existingIndex >= 0 && input.force
          ? "replace"
          : input.action;
      const profile =
        effectiveAction === "update"
          ? patchAgentProfile(existingProfile!, input)
          : buildAgentProfile(input);

      if (existingIndex >= 0) {
        nextAgents.profiles[existingIndex] = profile;
      } else if (effectiveAction === "create") {
        nextAgents.profiles.push(profile);
      }

      if (effectiveAction === "replace") {
        removeDelegateToolsForProfile(nextAgents, input.id);
        if (input.delegateToolName) {
          setDelegateToolForProfile(nextAgents, {
            profileId: input.id,
            toolName: input.delegateToolName,
            maxSteps: input.maxSteps,
          });
        }
      } else if (effectiveAction === "update") {
        if (input.removeDelegateTool) {
          removeDelegateToolsForProfile(nextAgents, input.id);
        }
        if (input.delegateToolName) {
          setDelegateToolForProfile(nextAgents, {
            profileId: input.id,
            toolName: input.delegateToolName,
            maxSteps: input.maxSteps ?? profile.maxSteps,
          });
        } else if (input.maxSteps !== undefined && !input.removeDelegateTool) {
          nextAgents.delegateTools = nextAgents.delegateTools.map((tool) =>
            tool.profileId === input.id
              ? { ...tool, maxSteps: input.maxSteps }
              : tool,
          );
        }
      } else if (input.delegateToolName) {
        setDelegateToolForProfile(nextAgents, {
          profileId: input.id,
          toolName: input.delegateToolName,
          maxSteps: input.maxSteps,
        });
      }
      const errors = validateAgentConfigShape(nextAgents);
      if (errors.length > 0) {
        throw new Error(
          `create_agent ${input.action} produced invalid config: ${JSON.stringify(errors)}`,
        );
      }

      if (existingIndex >= 0 && agentConfigShapesEqual(agents, nextAgents)) {
        const path = await canonicalWorkspacePath(ctx, config.path);
        ctx.reportWorkspaceWriteSkipped?.({
          path,
          reason:
            input.action === "create"
              ? `Agent profile ${input.id} already matches requested config.`
              : `Agent profile ${input.id} already matches requested ${input.action}.`,
        });
        return {
          action: input.action,
          id: input.id,
          path,
          changed: false,
          status: input.action === "create" ? "already_exists" : "unchanged",
          profile,
          ...agentCallabilityFields(profile, agents),
          agents,
          errors,
        };
      }

      if (input.action === "create" && existingIndex >= 0 && !input.force) {
        throw new Error(
          `Agent profile already exists with different config: ${input.id}. Use action="update" to patch fields, action="replace" with replaceReason to replace it, or pass legacy force=true only when replacement is intentional.`,
        );
      }

      setAgentConfigShape(config.data, nextAgents);
      const write = await writeProjectConfig(ctx, config.path, config.data);
      const mutationAction =
        effectiveAction === "replace"
          ? "replace_agent_profile"
          : existingIndex >= 0
            ? "update_agent_profile"
            : "create_agent_profile";
      ctx.reportCapabilityMutationCompleted?.({
        action: mutationAction,
        path: write.path,
        reason:
          effectiveAction === "replace"
            ? `Replace Agent profile ${input.id}: ${input.replaceReason ?? "legacy force"}`
            : `${existingIndex >= 0 ? "Update" : "Create"} Agent profile ${input.id}`,
        fileCount: 1,
        files: [{ relativePath: write.path }],
        metadata: {
          kind: "agent",
          id: input.id,
          action: effectiveAction,
          ...(input.replaceReason
            ? { replaceReason: input.replaceReason }
            : {}),
          ...(input.delegateToolName
            ? { delegateToolName: input.delegateToolName }
            : {}),
        },
      });
      return {
        action: input.action,
        id: input.id,
        path: write.path,
        changed: true,
        diffArtifactId: write.diffArtifactId,
        writeSummary: write.summary,
        profile,
        ...agentCallabilityFields(profile, nextAgents),
        agents: nextAgents,
        errors,
      };
    },
  });
}

export function applyToolConfig<T extends ToolDefinition>(
  tools: T[],
  config: CapabilityToolsConfig | undefined,
): T[] {
  const deferPatterns = config?.defer ?? DEFAULT_DEFERRED_TOOLS;
  if (!config) {
    return tools.map((tool) => applyDefaultDefer(tool, deferPatterns)) as T[];
  }
  return tools
    .filter((tool) => isToolNameAllowed(tool.name, config.allowed))
    .filter((tool) => !isToolNameListed(tool.name, config.disabled))
    .map((tool) => {
      if (
        tool.alwaysLoad === true ||
        !isToolNameListed(tool.name, deferPatterns)
      ) {
        return tool;
      }
      return { ...tool, deferLoading: true };
    }) as T[];
}

export const DEFAULT_DEFERRED_TOOLS = [
  "todo_write",
  "read_anchored_text",
  "edit_anchored_text",
  "create_skill",
  "create_agent",
  "cron",
];

function applyDefaultDefer<T extends ToolDefinition>(
  tool: T,
  names: readonly string[],
): T {
  if (tool.alwaysLoad === true || !isToolNameListed(tool.name, names)) {
    return tool;
  }
  return { ...tool, deferLoading: true };
}

function containsGlobPattern(path: string): boolean {
  return /[*?[]/.test(path);
}

function isToolNameListed(
  toolName: string,
  names: readonly string[] | undefined,
): boolean {
  return Boolean(names?.includes(toolName));
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

function resolveSkillCreateRoot(
  workspaceRoot: string,
  root: string | undefined,
): string {
  const projectRoot = projectSkillRoot(workspaceRoot);
  const value = root?.trim();
  if (!value || value === ".") return projectRoot;

  const resolved = resolveWorkspacePath(workspaceRoot, value);
  if (resolved !== projectRoot) {
    throw toolArgumentsInvalid(
      "create_skill root must be omitted or point to the project Skill root .sparkwright/skills.",
    );
  }
  return projectRoot;
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

function parseSkillManagerArgs(args: unknown): {
  action: "create";
  name?: string;
  description?: string;
  root?: string;
} {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw toolArgumentsInvalid("create_skill expects an object argument.");
  }
  const record = args as Record<string, unknown>;
  const action = record.action;
  if (action !== "create") {
    throw toolArgumentsInvalid("create_skill action must be create.");
  }
  if ("force" in record) {
    throw toolArgumentsInvalid(
      "create_skill no longer accepts force; review the proposal and apply with force if needed.",
    );
  }
  return {
    action,
    ...(typeof record.name === "string" ? { name: record.name.trim() } : {}),
    ...(typeof record.description === "string"
      ? { description: record.description.trim() }
      : {}),
    ...(typeof record.root === "string" ? { root: record.root } : {}),
  };
}

function skillProposalProvenanceFromContext(
  ctx: { run?: { id?: string; metadata?: Record<string, unknown> } },
  rationale: string,
): SkillProposalProvenance {
  const sessionId =
    typeof ctx.run?.metadata?.sessionId === "string"
      ? ctx.run.metadata.sessionId
      : undefined;
  return {
    runId: ctx.run?.id,
    sessionId,
    rationale,
  };
}

async function findExistingRunSkillDraft(
  workspaceRoot: string,
  skillName: string,
  runId: string | undefined,
  kind: "create" | "update" = "update",
): Promise<SkillProposalSummary | undefined> {
  if (!runId) return undefined;
  const proposals = await listSkillProposals(workspaceRoot);
  return proposals.find(
    (proposal) =>
      proposal.kind === kind &&
      proposal.state === "draft" &&
      proposal.skillName === skillName &&
      proposal.provenance?.runId === runId,
  );
}

function skillDraftToolOutput(
  proposal: SkillProposalSummary,
  changed: boolean,
) {
  return {
    action: "draft",
    changed,
    proposalId: proposal.id,
    proposalPath: proposal.path,
    state: proposal.state,
    kind: proposal.kind,
    skillName: proposal.skillName,
    sourceLayer: proposal.sourceLayer,
    sourcePath: proposal.sourcePath,
    targetPath: proposal.targetPath,
    basePackageHash: proposal.basePackageHash,
    afterPackageHash: proposal.afterPackageHash,
    ...(proposal.guardFindings
      ? { guardFindings: proposal.guardFindings }
      : {}),
    summary: changed
      ? proposal.summary
      : `${proposal.summary} Existing draft proposal returned; no new proposal was created.`,
    existing: !changed,
  };
}

function parseSkillUpdateArgs(args: unknown): {
  action: "draft";
  name: string;
  description: string;
  body?: string;
} {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw toolArgumentsInvalid("update_skill expects an object argument.");
  }
  const record = args as Record<string, unknown>;
  const action = record.action;
  if (action !== "draft") {
    throw toolArgumentsInvalid("update_skill action must be draft.");
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!isSkillName(name)) {
    throw toolArgumentsInvalid(
      "update_skill draft requires a valid lowercase skill name.",
    );
  }
  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  if (description.length === 0) {
    throw toolArgumentsInvalid("update_skill draft requires description.");
  }
  const body =
    typeof record.body === "string" && record.body.trim().length > 0
      ? record.body
      : undefined;
  return {
    action,
    name,
    description,
    body,
  };
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

async function writeProjectConfig(
  ctx: RuntimeContext,
  path: string,
  data: Record<string, unknown>,
): Promise<CapabilityWriteResult> {
  return writeCapabilityText(
    ctx,
    path,
    serializeConfigFileObject(path, data),
    "Update project agent capability config",
  );
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

function cloneAgentConfigShape(agents: AgentConfigShape): AgentConfigShape {
  return {
    profiles: agents.profiles.map((profile) => ({
      ...profile,
      ...(profile.use ? { use: [...profile.use] } : {}),
      ...(profile.allowedTools
        ? { allowedTools: [...profile.allowedTools] }
        : {}),
      ...(profile.deniedTools ? { deniedTools: [...profile.deniedTools] } : {}),
      ...(profile.delegateTool
        ? { delegateTool: { ...profile.delegateTool } }
        : {}),
    })),
    delegateTools: agents.delegateTools.map((tool) => ({ ...tool })),
  };
}

function agentConfigShapesEqual(
  left: AgentConfigShape,
  right: AgentConfigShape,
): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function setAgentConfigShape(
  config: Record<string, unknown>,
  agents: AgentConfigShape,
): void {
  const capabilities = isPlainObject(config.capabilities)
    ? config.capabilities
    : {};
  const existingAgents = isPlainObject(capabilities.agents)
    ? capabilities.agents
    : {};
  const nextAgents: Record<string, unknown> = {
    ...existingAgents,
    profiles: agents.profiles,
  };
  if (agents.delegateTools.length > 0) {
    nextAgents.delegateTools = agents.delegateTools;
  } else {
    delete nextAgents.delegateTools;
  }
  capabilities.agents = nextAgents;
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

function agentCallabilityFields(
  profile: AgentProfile,
  agents: AgentConfigShape,
): {
  callable: boolean;
  callability: {
    callable: boolean;
    mode: AgentProfile["mode"];
    reason: string;
    delegateToolName?: string;
    suggestedDelegateToolName?: string;
  };
} {
  const mode = profile.mode ?? "child";
  const childEligible = mode === "child" || mode === "all";
  const delegate =
    agents.delegateTools.find((tool) => tool.profileId === profile.id) ??
    (profile.delegateTool
      ? { profileId: profile.id, ...profile.delegateTool }
      : undefined);
  const resolvedDelegateToolName = delegate
    ? delegateToolName(delegate)
    : undefined;
  if (resolvedDelegateToolName && childEligible) {
    return {
      callable: true,
      callability: {
        callable: true,
        mode,
        delegateToolName: resolvedDelegateToolName,
        reason: `Main agents can call this profile through ${resolvedDelegateToolName}.`,
      },
    };
  }

  const suggestedDelegateToolName = delegateToolName({ profileId: profile.id });
  const reason = resolvedDelegateToolName
    ? `This profile has delegate tool ${resolvedDelegateToolName}, but mode=${mode} is not eligible for child/delegate runs; use mode=child or mode=all.`
    : mode === "primary"
      ? `This primary profile shapes the main run and is not exposed as a delegate tool; use mode=child or mode=all with delegateToolName=${suggestedDelegateToolName} if the main agent should call it.`
      : `This profile is inspectable but not callable because no delegate tool exposes it; set delegateToolName=${suggestedDelegateToolName} if the main agent should call it.`;

  return {
    callable: false,
    callability: {
      callable: false,
      mode,
      reason,
      ...(resolvedDelegateToolName
        ? { delegateToolName: resolvedDelegateToolName }
        : { suggestedDelegateToolName }),
    },
  };
}

type AgentManagerAction = "create" | "update" | "replace" | "remove";

interface AgentManagerInput {
  action: AgentManagerAction;
  id?: string;
  name?: string;
  description?: string;
  mode?: "primary" | "child" | "all";
  prompt?: string;
  use?: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  maxSteps?: number;
  delegateToolName?: string;
  removeDelegateTool?: boolean;
  replaceReason?: string;
  force?: boolean;
}

function buildAgentProfile(input: AgentManagerInput): AgentProfile {
  const prompt = input.prompt?.trim();
  if (!input.id || !prompt) {
    throw new Error(`create_agent ${input.action} requires id and prompt.`);
  }
  const profile: AgentProfile = {
    id: input.id,
    name: input.name && input.name.length > 0 ? input.name : input.id,
    mode: input.mode ?? "child",
    prompt,
  };
  if (input.description) profile.description = input.description;
  if (input.use !== undefined) profile.use = input.use;
  if (input.allowedTools !== undefined)
    profile.allowedTools = input.allowedTools;
  if (input.deniedTools !== undefined) profile.deniedTools = input.deniedTools;
  if (input.maxSteps !== undefined) profile.maxSteps = input.maxSteps;
  return profile;
}

function patchAgentProfile(
  existing: AgentProfile,
  input: AgentManagerInput,
): AgentProfile {
  const profile: AgentProfile = { ...existing };
  if (input.name !== undefined) {
    profile.name = input.name.length > 0 ? input.name : existing.id;
  }
  if (input.description !== undefined) {
    if (input.description.length > 0) profile.description = input.description;
    else delete profile.description;
  }
  if (input.mode !== undefined) profile.mode = input.mode;
  if (input.prompt !== undefined) {
    if (input.prompt.trim().length === 0) {
      throw new Error("create_agent update prompt must not be empty.");
    }
    profile.prompt = input.prompt.trim();
  }
  if (input.use !== undefined) profile.use = input.use;
  if (input.allowedTools !== undefined) {
    profile.allowedTools = input.allowedTools;
  }
  if (input.deniedTools !== undefined) {
    profile.deniedTools = input.deniedTools;
  }
  if (input.maxSteps !== undefined) profile.maxSteps = input.maxSteps;
  return profile;
}

function removeDelegateToolsForProfile(
  agents: AgentConfigShape,
  profileId: string,
): void {
  agents.delegateTools = agents.delegateTools.filter(
    (tool) => tool.profileId !== profileId,
  );
}

function setDelegateToolForProfile(
  agents: AgentConfigShape,
  input: { profileId: string; toolName: string; maxSteps?: number },
): void {
  agents.delegateTools = agents.delegateTools.filter(
    (tool) =>
      tool.profileId !== input.profileId && tool.toolName !== input.toolName,
  );
  agents.delegateTools.push({
    profileId: input.profileId,
    toolName: input.toolName,
    requiresApproval: true,
    forbidNesting: true,
    ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
  });
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

function parseAgentManagerArgs(args: unknown): AgentManagerInput {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw toolArgumentsInvalid("create_agent expects an object argument.");
  }
  const record = args as Record<string, unknown>;
  const action = record.action;
  if (
    action !== "create" &&
    action !== "update" &&
    action !== "replace" &&
    action !== "remove"
  ) {
    throw toolArgumentsInvalid(
      "create_agent action must be create, update, replace, or remove.",
    );
  }
  const mode = record.mode;
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
  const maxSteps = record.maxSteps;
  if (
    maxSteps !== undefined &&
    (!Number.isInteger(maxSteps) || (maxSteps as number) < 1)
  ) {
    throw toolArgumentsInvalid(
      "create_agent maxSteps must be a positive integer.",
    );
  }
  const delegateTool =
    typeof record.delegateToolName === "string"
      ? record.delegateToolName.trim()
      : undefined;
  const replaceReason =
    typeof record.replaceReason === "string"
      ? record.replaceReason.trim()
      : undefined;
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
    ...(record.use !== undefined
      ? { use: toolUseSelectorArrayArg(record.use, "use") }
      : {}),
    ...(record.allowedTools !== undefined
      ? { allowedTools: stringArrayArg(record.allowedTools, "allowedTools") }
      : {}),
    ...(record.deniedTools !== undefined
      ? { deniedTools: stringArrayArg(record.deniedTools, "deniedTools") }
      : {}),
    ...(maxSteps !== undefined ? { maxSteps: maxSteps as number } : {}),
    ...(delegateTool ? { delegateToolName: delegateTool } : {}),
    ...(typeof record.removeDelegateTool === "boolean"
      ? { removeDelegateTool: record.removeDelegateTool }
      : {}),
    ...(replaceReason ? { replaceReason } : {}),
    ...(typeof record.force === "boolean" ? { force: record.force } : {}),
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
