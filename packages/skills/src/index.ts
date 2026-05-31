// AI maintenance note: Public entry point for @sparkwright/skills. Two
// surfaces live here: (1) the legacy `prepareSkillsForRun` helpers that bind
// skills into a run's context/tools, and (2) the discovery + matching
// protocol (manifest/loader/matcher/registry/capability) for hosts that want
// to surface skills without committing them to context up front.
//
// The two surfaces deliberately share no internal state — pick whichever
// matches the embedder's loop. Re-exports are grouped at the bottom so
// downstream `import { ... } from "@sparkwright/skills"` keeps working.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  createContextItemId,
  defineTool,
  type ContextItem,
  type EventEmitter,
  type ToolDefinition,
} from "@sparkwright/core";

const SKILL_FILE_NAME = "SKILL.md";
const DEFAULT_MAX_SELECTED_SKILLS = 1;
const DEFAULT_RESOURCE_FILE_LIMIT = 10;
const COMMON_MATCH_WORDS = new Set([
  "and",
  "for",
  "from",
  "into",
  "that",
  "the",
  "this",
  "when",
  "with",
  "asks",
  "skill",
  "skills",
  "agent",
  "agents",
]);

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string[];
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
}

export interface SkillDefinition {
  name: string;
  description: string;
  license?: string;
  compatibility?: string[];
  allowedTools?: string[];
  body: string;
  sourcePath: string;
  contentHash: string;
  metadata: Record<string, unknown>;
}

export interface SkillIndexEntry {
  name: string;
  description: string;
  sourcePath: string;
  contentHash: string;
  version?: string;
  metadata: Record<string, unknown>;
}

export interface SkillLockEntry {
  name: string;
  sourcePath: string;
  contentHash: string;
  version?: string;
  metadata: Record<string, unknown>;
}

export interface SkillLockfile {
  /**
   * @reserved Public lockfile protocol discriminator consumed by embedders.
   */
  schemaVersion: "skill-lockfile.v0.1";
  generatedAt?: string;
  skills: SkillLockEntry[];
}

export type SkillLockSource = Pick<
  SkillIndexEntry,
  "name" | "description" | "sourcePath" | "contentHash" | "metadata"
> & {
  version?: string;
};

export interface CreateSkillLockfileOptions {
  generatedAt?: Date | string;
}

export interface LoadedSkill extends SkillIndexEntry {
  selectionReason: string;
}

export interface PreparedSkills {
  context: ContextItem[];
  tools: ToolDefinition[];
  loadedSkills: LoadedSkill[];
  indexedSkills: SkillIndexEntry[];
}

export interface SkillAccessPolicy {
  allowedSkills?: string[];
  deniedSkills?: string[];
}

export interface PrepareSkillsForRunOptions {
  goal: string;
  skillRoots: string[];
  agent?: SkillAccessPolicy;
  includeLoaderTool?: boolean;
  loadSelectedSkills?: boolean;
  maxSelectedSkills?: number;
  resourceFileLimit?: number;
  /**
   * Optional event emitter (typically `run.events`). When provided, emits
   * `skill.indexed` once after indexing and `skill.loaded` for each selected
   * skill. Without an emitter, the helper stays silent for backward compat.
   */
  emitter?: EventEmitter;
  /** Optional agent id, attached as event metadata when emitting. */
  agentId?: string;
}

export async function prepareSkillsForRun(
  options: PrepareSkillsForRunOptions,
): Promise<PreparedSkills> {
  const skills = filterSkillsForAgent(
    await loadSkills(options.skillRoots),
    options.agent,
  );
  const indexedSkills = skills.map(toSkillIndexEntry);
  const loadSelectedSkills = options.loadSelectedSkills ?? true;
  const selected = selectSkills({
    goal: options.goal,
    skills,
    maxSelectedSkills: options.maxSelectedSkills ?? DEFAULT_MAX_SELECTED_SKILLS,
  });
  const loadedSkills = loadSelectedSkills
    ? selected.map(({ skill, reason }) => ({
        ...toSkillIndexEntry(skill),
        selectionReason: reason,
      }))
    : [];

  const baseMeta = {
    experimental: true,
    schemaVersion: "edge-trace.v0.1",
    sourcePackage: "@sparkwright/skills",
    ...(options.agentId ? { agentId: options.agentId } : {}),
  };

  if (options.emitter) {
    options.emitter.emit(
      "skill.indexed",
      { count: indexedSkills.length },
      {
        ...baseMeta,
        skills: indexedSkills.map((entry) => ({
          name: entry.name,
          version: entry.version,
          sourcePath: entry.sourcePath,
          contentHash: entry.contentHash,
        })),
        skillRoots: options.skillRoots,
      },
    );

    if (loadSelectedSkills) {
      for (const { skill, reason } of selected) {
        options.emitter.emit(
          "skill.loaded",
          { name: skill.name, status: "loaded" },
          {
            ...baseMeta,
            version: versionOf(skill.metadata),
            sourcePath: skill.sourcePath,
            contentHash: skill.contentHash,
            selectionReason: reason,
            mode: "resident_context",
          },
        );
      }
    }
  }

  return {
    context: [
      createSkillIndexContext(indexedSkills),
      ...(loadSelectedSkills
        ? selected.map(({ skill, reason }) =>
            createLoadedSkillContext(skill, reason),
          )
        : []),
    ],
    tools: options.includeLoaderTool
      ? [
          createSkillLoaderTool(skills, {
            resourceFileLimit: options.resourceFileLimit,
          }),
        ]
      : [],
    loadedSkills,
    indexedSkills,
  };
}

export async function loadSkills(
  skillRoots: string[],
): Promise<SkillDefinition[]> {
  const skillFiles = (
    await Promise.all(skillRoots.map((root) => findSkillFiles(root)))
  )
    .flat()
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(skillFiles.map((path) => loadSkill(path)));
}

export async function loadSkill(path: string): Promise<SkillDefinition> {
  const sourcePath = resolve(path);
  const content = await readFile(sourcePath, "utf8");
  return parseSkill(content, sourcePath);
}

export function parseSkill(
  content: string,
  sourcePath = SKILL_FILE_NAME,
): SkillDefinition {
  const parsed = parseSkillMarkdown(content);
  const name = stringField(parsed.frontmatter.name, "name", sourcePath);
  const description = stringField(
    parsed.frontmatter.description,
    "description",
    sourcePath,
  );
  validateSkillIdentity(name, description, sourcePath);
  const metadata = recordField(parsed.frontmatter.metadata);
  const compatibility = stringArrayField(parsed.frontmatter.compatibility);
  const allowedTools = stringArrayField(parsed.frontmatter["allowed-tools"]);

  return {
    name,
    description,
    license: optionalStringField(parsed.frontmatter.license),
    compatibility,
    allowedTools,
    body: parsed.body.trim(),
    sourcePath,
    contentHash: sha256(content),
    metadata,
  };
}

export function selectSkills(input: {
  goal: string;
  skills: SkillDefinition[];
  maxSelectedSkills?: number;
}): Array<{ skill: SkillDefinition; reason: string; score: number }> {
  const maxSelectedSkills =
    input.maxSelectedSkills ?? DEFAULT_MAX_SELECTED_SKILLS;

  if (!Number.isInteger(maxSelectedSkills) || maxSelectedSkills < 0) {
    throw new Error("maxSelectedSkills must be a non-negative integer.");
  }

  if (maxSelectedSkills === 0) return [];

  const goalTokens = tokenize(input.goal);
  const scored = input.skills
    .map((skill) => {
      const nameTokens = tokenize(skill.name);
      const descriptionTokens = tokenize(skill.description);
      const nameScore = countMatches(goalTokens, nameTokens) * 3;
      const descriptionScore = countMatches(goalTokens, descriptionTokens);
      const exactNameScore = input.goal
        .toLowerCase()
        .includes(skill.name.toLowerCase())
        ? 5
        : 0;
      const score = nameScore + descriptionScore + exactNameScore;

      return {
        skill,
        score,
        reason:
          score > 0
            ? `Matched goal against skill name or description.`
            : `No deterministic match.`,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.skill.name.localeCompare(right.skill.name),
    );

  return scored.slice(0, maxSelectedSkills);
}

export function filterSkillsForAgent(
  skills: SkillDefinition[],
  policy: SkillAccessPolicy = {},
): SkillDefinition[] {
  const allowed = patternSet(policy.allowedSkills);
  const denied = patternSet(policy.deniedSkills);

  return skills.filter((skill) => {
    if (matchesPatternSet(skill.name, denied)) return false;
    if (allowed.length === 0) return true;
    return matchesPatternSet(skill.name, allowed);
  });
}

export function createSkillLockfile(
  skills: readonly SkillLockSource[],
  options: CreateSkillLockfileOptions = {},
): SkillLockfile {
  const generatedAt =
    options.generatedAt instanceof Date
      ? options.generatedAt.toISOString()
      : options.generatedAt;

  return {
    schemaVersion: "skill-lockfile.v0.1",
    ...(generatedAt ? { generatedAt } : {}),
    skills: skills
      .map((skill) => {
        const version = skill.version ?? versionOf(skill.metadata);
        return {
          name: skill.name,
          sourcePath: skill.sourcePath,
          contentHash: skill.contentHash,
          ...(version ? { version } : {}),
          metadata: { ...skill.metadata },
        };
      })
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.sourcePath.localeCompare(right.sourcePath),
      ),
  };
}

export const lockSkills = createSkillLockfile;

export function createSkillLoaderTool(
  skills: SkillDefinition[],
  options: { resourceFileLimit?: number } = {},
): ToolDefinition<{ name: string }> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const resourceFileLimit =
    options.resourceFileLimit ?? DEFAULT_RESOURCE_FILE_LIMIT;

  if (!Number.isInteger(resourceFileLimit) || resourceFileLimit < 0) {
    throw new Error("resourceFileLimit must be a non-negative integer.");
  }

  return defineTool<{ name: string }>({
    name: "skill.load",
    description:
      "Load a Sparkwright skill body when the task matches one of the available skill descriptions.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    policy: {
      risk: "safe",
    },
    governance: {
      sideEffects: ["read"],
      idempotency: "idempotent",
      dataSensitivity: "internal",
      audit: {
        level: "metadata",
      },
    },
    async execute(args) {
      const skill = byName.get(args.name);

      if (!skill) {
        return {
          status: "not_found",
          requestedName: args.name,
          availableSkills: [...byName.keys()].sort(),
        };
      }

      const resourceFiles = await listSkillResourceFiles(
        skill,
        resourceFileLimit,
      );

      return {
        status: "loaded",
        name: skill.name,
        description: skill.description,
        sourcePath: skill.sourcePath,
        baseDirectory: dirname(skill.sourcePath),
        contentHash: skill.contentHash,
        version: versionOf(skill.metadata),
        content: createSkillToolOutput(skill, resourceFiles),
        resourceFiles,
      };
    },
  });
}

export function createSkillIndexContext(
  skills: SkillIndexEntry[],
): ContextItem {
  return {
    id: createContextItemId(),
    type: "system",
    source: {
      kind: "skill_index",
    },
    content: JSON.stringify(
      {
        kind: "skill_index",
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          version: skill.version,
          sourcePath: skill.sourcePath,
          contentHash: skill.contentHash,
        })),
      },
      null,
      2,
    ),
    metadata: {
      layer: "skill_index",
      stability: "session",
      priority: 80,
      skillCount: skills.length,
    },
  };
}

export function createLoadedSkillContext(
  skill: SkillDefinition,
  selectionReason: string,
): ContextItem {
  return {
    id: createContextItemId(),
    type: "system",
    source: {
      kind: "skill",
      path: skill.sourcePath,
    },
    content: [
      `Skill: ${skill.name}`,
      `Description: ${skill.description}`,
      `Selection reason: ${selectionReason}`,
      "",
      skill.body,
    ].join("\n"),
    metadata: {
      layer: "resident",
      stability: "session",
      priority: 90,
      skillName: skill.name,
      skillVersion: versionOf(skill.metadata),
      skillSourcePath: skill.sourcePath,
      skillContentHash: skill.contentHash,
      selectionReason,
    },
  };
}

export async function listSkillResourceFiles(
  skill: SkillDefinition,
  limit = DEFAULT_RESOURCE_FILE_LIMIT,
): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("limit must be a non-negative integer.");
  }

  if (limit === 0 || skill.sourcePath === "<built-in>") return [];

  const root = dirname(skill.sourcePath);
  const files: string[] = [];
  await collectSkillFiles(root, files, limit + 1);
  return files
    .filter((path) => basename(path) !== SKILL_FILE_NAME)
    .slice(0, limit)
    .map((path) => relative(root, path))
    .sort((left, right) => left.localeCompare(right));
}

function parseSkillMarkdown(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith("---\n")) {
    throw new Error("Skill must start with YAML frontmatter.");
  }

  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("Skill frontmatter must be closed with ---.");
  }

  return {
    frontmatter: parseFrontmatter(content.slice(4, end)),
    body: content.slice(end + 4),
  };
}

function parseFrontmatter(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let currentObject: Record<string, unknown> | undefined;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const nestedMatch = /^ {2}([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (nestedMatch && currentObject) {
      currentObject[nestedMatch[1]] = parseScalar(nestedMatch[2] ?? "");
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      throw new Error(`Unsupported skill frontmatter line: ${line}`);
    }

    const [, key, value = ""] = match;
    if (value === "") {
      currentObject = {};
      root[key] = currentObject;
    } else {
      currentObject = undefined;
      root[key] = parseScalar(value);
    }
  }

  return root;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  const quoted = /^["'](.*)["']$/.exec(trimmed);
  if (quoted) return quoted[1];

  return trimmed;
}

async function findSkillFiles(root: string): Promise<string[]> {
  const fullRoot = resolve(root);
  const rootStats = await stat(fullRoot);

  if (!rootStats.isDirectory()) {
    if (basename(fullRoot) !== SKILL_FILE_NAME) {
      throw new Error(`Skill path is not a ${SKILL_FILE_NAME} file: ${root}`);
    }
    return [fullRoot];
  }

  const directSkill = join(fullRoot, SKILL_FILE_NAME);
  if (await exists(directSkill)) return [directSkill];

  const entries = await readdir(fullRoot, { withFileTypes: true });
  const nested = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(fullRoot, entry.name, SKILL_FILE_NAME));
  const existing = await Promise.all(
    nested.map(async (path) => ((await exists(path)) ? path : undefined)),
  );

  return existing.filter((path): path is string => path !== undefined);
}

async function collectSkillFiles(
  root: string,
  files: string[],
  limit: number,
): Promise<void> {
  if (files.length >= limit) return;

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (files.length >= limit) return;

    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectSkillFiles(path, files, limit);
      continue;
    }

    if (entry.isFile()) files.push(path);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}

function toSkillIndexEntry(skill: SkillDefinition): SkillIndexEntry {
  return {
    name: skill.name,
    description: skill.description,
    sourcePath: skill.sourcePath,
    contentHash: skill.contentHash,
    version: versionOf(skill.metadata),
    metadata: skill.metadata,
  };
}

function stringField(
  value: unknown,
  field: string,
  sourcePath: string,
): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new Error(`Skill ${field} must be a non-empty string: ${sourcePath}`);
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return value
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map(String).filter((item) => item.trim() !== "");
  }
  throw new Error("Skill string-list fields must be strings or arrays.");
}

function validateSkillIdentity(
  name: string,
  description: string,
  sourcePath: string,
): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(
      `Skill name must use lowercase letters, numbers, and hyphens, max 64 chars: ${sourcePath}`,
    );
  }

  if (description.length > 1024) {
    throw new Error(
      `Skill description must be at most 1024 characters: ${sourcePath}`,
    );
  }
}

function recordField(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Skill metadata must be an object when provided.");
}

function versionOf(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.version;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function createSkillToolOutput(
  skill: SkillDefinition,
  resourceFiles: string[],
): string {
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.body.trim(),
    "",
    `Base directory for this skill: ${dirname(skill.sourcePath)}`,
    "Relative paths in this skill are resolved from the base directory.",
    "",
    "<skill_files>",
    ...resourceFiles.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n");
}

function patternSet(patterns: string[] | undefined): string[] {
  return [...new Set(patterns ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function matchesPatternSet(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pattern === "*" || pattern === value);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !COMMON_MATCH_WORDS.has(token)),
  );
}

function countMatches(left: Set<string>, right: Set<string>): number {
  let matches = 0;
  for (const token of right) {
    if (left.has(token)) matches += 1;
  }
  return matches;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// -----------------------------------------------------------------------------
// Discovery + description-matching protocol (v0.1, experimental)
// -----------------------------------------------------------------------------

export type {
  SkillManifest,
  SkillMatch,
  SkillTriggerSignal,
  SkillLoadError,
  SkillAssetCategory,
} from "./types.js";
export { SKILL_ASSET_CATEGORIES } from "./types.js";
export {
  parseSkillManifest,
  parseSkillManifestObject,
  type SkillManifestInput,
} from "./manifest.js";
export {
  loadSkillsFromDirectory,
  loadSkillFromFile,
  type LoadSkillsOptions,
  type LoadSkillsResult,
} from "./loader.js";
export {
  matchSkills,
  defaultTokenize,
  type MatchSkillsOptions,
} from "./matcher.js";
export { SkillRegistry, type RegisterSkillOptions } from "./registry.js";
export {
  skillToCapability,
  skillsToCapabilities,
  type SkillCapabilityOptions,
} from "./capability.js";
export {
  InMemorySkillUsageRecorder,
  recencyBoost,
  type SkillUsageRecord,
  type SkillUsageRecorder,
  type SkillUsageState,
} from "./usage.js";
export {
  FileSkillUsageRecorder,
  type FileSkillUsageRecorderOptions,
} from "./usage-file.js";
export {
  inspectSkill,
  type InspectSkillOptions,
  type SkillFindingSeverity,
  type SkillGuardDecision,
  type SkillGuardDecisionKind,
  type SkillGuardFinding,
  type SkillTrustLevel,
} from "./guard.js";
export {
  preprocessSkillContent,
  substituteTemplateVars,
  expandInlineShell,
  type PreprocessSkillOptions,
} from "./preprocess.js";
export {
  SkillBundleRegistry,
  resolveBundle,
  resolveSlashCommand,
  buildBundleInvocationMessage,
  loadBundlesFromDirectory,
  type SkillBundle,
  type ResolvedBundle,
} from "./bundles.js";
