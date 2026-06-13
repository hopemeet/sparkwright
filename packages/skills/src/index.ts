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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  createContextItemId,
  defineTool,
  type ContextItem,
  type EventEmitter,
  type ToolDefinition,
} from "@sparkwright/core";
import { defaultTokenize } from "./matcher.js";

const SKILL_FILE_NAME = "SKILL.md";
const DEFAULT_MAX_SELECTED_SKILLS = 1;
const DEFAULT_RESOURCE_FILE_LIMIT = 10;

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
  /** Optional keyword hints that boost relevance scoring. */
  triggers?: string[];
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
  /** Optional keyword hints that boost relevance scoring. */
  triggers?: string[];
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
  skillRoots: SkillRootInput[];
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
  /**
   * Include skills flagged `metadata.devOnly: true`. Off by default so test or
   * development skills never reach a production run's candidate set. The host
   * enables this from an opt-in env flag.
   */
  includeDevSkills?: boolean;
}

export type SkillRootLayer = "builtin" | "user" | "project" | "legacy";

export interface SkillRoot {
  root: string;
  layer?: SkillRootLayer;
}

export type SkillRootInput = string | SkillRoot;

export async function prepareSkillsForRun(
  options: PrepareSkillsForRunOptions,
): Promise<PreparedSkills> {
  const baseMeta = {
    experimental: true,
    schemaVersion: "edge-trace.v0.1",
    sourcePackage: "@sparkwright/skills",
    ...(options.agentId ? { agentId: options.agentId } : {}),
  };
  const skills = excludeDevSkills(
    filterSkillsForAgent(
      await loadSkillsForRun(options.skillRoots, (source, message) => {
        options.emitter?.emit(
          "skill.failed",
          { source, message },
          { ...baseMeta, phase: "load" },
        );
      }),
      options.agent,
    ),
    options.includeDevSkills ?? false,
  );
  const indexedSkills = skills.map(toSkillIndexEntry);
  const rankedIndexedSkills = rankIndexedSkillsByGoal(
    indexedSkills,
    options.goal,
  );
  const loadSelectedSkills = options.loadSelectedSkills ?? true;
  // Matching only feeds the resident-context path; skip it entirely under
  // on-demand loading, where `selected` is never read.
  const selected = loadSelectedSkills
    ? selectSkills({
        goal: options.goal,
        skills,
        maxSelectedSkills:
          options.maxSelectedSkills ?? DEFAULT_MAX_SELECTED_SKILLS,
      })
    : [];
  const loadedSkills = loadSelectedSkills
    ? selected.map(({ skill, reason }) => ({
        ...toSkillIndexEntry(skill),
        selectionReason: reason,
      }))
    : [];

  if (options.emitter) {
    options.emitter.emit(
      "skill.indexed",
      { count: indexedSkills.length },
      {
        ...baseMeta,
        skills: rankedIndexedSkills.map((entry, index) => ({
          rank: index + 1,
          name: entry.name,
          version: entry.version,
          sourcePath: entry.sourcePath,
          contentHash: entry.contentHash,
          relevance: entry.relevance,
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
      createSkillIndexContext(rankedIndexedSkills),
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

async function loadSkillsForRun(
  skillRoots: SkillRootInput[],
  onError?: (source: string, message: string) => void,
): Promise<SkillDefinition[]> {
  const loadedByRoot = await Promise.all(
    skillRoots.map(async (input, rootIndex) => {
      const root = normalizeSkillRoot(input);
      let skillFiles: string[];
      try {
        skillFiles = (await findSkillFiles(root.root)).sort((left, right) =>
          left.localeCompare(right),
        );
      } catch (error) {
        onError?.(root.root, errorMessage(error));
        return { rootIndex, skills: [] };
      }

      const loaded = await Promise.all(
        skillFiles.map(async (path) => {
          try {
            return await loadSkill(path, { layer: root.layer });
          } catch (error) {
            onError?.(path, errorMessage(error));
            return undefined;
          }
        }),
      );
      return {
        rootIndex,
        skills: loaded.filter(
          (skill): skill is SkillDefinition => skill !== undefined,
        ),
      };
    }),
  );

  const byName = new Map<string, SkillDefinition>();
  for (const { skills } of loadedByRoot.sort(
    (left, right) => left.rootIndex - right.rootIndex,
  )) {
    for (const skill of skills) byName.set(skill.name, skill);
  }

  return [...byName.values()].sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadSkills(
  skillRoots: SkillRootInput[],
): Promise<SkillDefinition[]> {
  return loadSkillsForRun(skillRoots, (_source, message) => {
    throw new Error(message);
  });
}

export async function loadSkill(
  path: string,
  options: { layer?: SkillRootLayer } = {},
): Promise<SkillDefinition> {
  const sourcePath = resolve(path);
  const content = await readFile(sourcePath, "utf8");
  const skill = parseSkill(content, sourcePath);
  if (!options.layer) return skill;
  skill.metadata = {
    ...skill.metadata,
    sparkwrightLayer: options.layer,
    ...(options.layer === "builtin" ? { trust: "builtin" } : {}),
  };
  return skill;
}

function normalizeSkillRoot(input: SkillRootInput): SkillRoot {
  return typeof input === "string" ? { root: input } : input;
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
  const triggers = stringArrayField(parsed.frontmatter.triggers);

  return {
    name,
    description,
    license: optionalStringField(parsed.frontmatter.license),
    compatibility,
    allowedTools,
    triggers,
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
      const score = scoreSkillAgainstGoal(
        goalTokens,
        input.goal,
        skill.name,
        skill.description,
        skill.triggers,
      );

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

/**
 * Deterministic goal/skill relevance score shared by the resident-context
 * selector and the on-demand index ranker. Name hits weigh more than
 * description hits, with a bonus when the goal literally names the skill.
 */
function scoreSkillAgainstGoal(
  goalTokens: Set<string>,
  goal: string,
  name: string,
  description: string,
  triggers: readonly string[] = [],
): number {
  const nameScore = countMatches(goalTokens, tokenize(name)) * 3;
  // Triggers carry the concrete operational nouns users actually type (e.g.
  // "trace", "resume") that the abstract description often omits. Weighted
  // between name and description, mirroring the resident-path matcher.
  const triggerTokens = new Set(triggers.flatMap((t) => [...tokenize(t)]));
  const triggerScore = countMatches(goalTokens, triggerTokens) * 2;
  const descriptionScore = countMatches(goalTokens, tokenize(description));
  const exactNameScore = goal.toLowerCase().includes(name.toLowerCase())
    ? 5
    : 0;
  return nameScore + triggerScore + descriptionScore + exactNameScore;
}

/**
 * Order the on-demand skill index by deterministic relevance to the goal and
 * tag each entry. Unlike {@link selectSkills} this drops nothing — the model
 * still sees every skill — but it surfaces the likely-relevant ones first and
 * flags the rest as `low` so a weak model is less prone to grabbing an
 * out-of-domain skill. Falls back to a fully `low`-tagged list (name-ordered)
 * when the goal yields no tokens (e.g. an unsupported script).
 */
export function rankIndexedSkillsByGoal(
  skills: SkillIndexEntry[],
  goal: string,
): Array<SkillIndexEntry & { relevance: "relevant" | "low" }> {
  const goalTokens = tokenize(goal);
  return skills
    .map((skill) => ({
      skill,
      score: scoreSkillAgainstGoal(
        goalTokens,
        goal,
        skill.name,
        skill.description,
        skill.triggers,
      ),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.skill.name.localeCompare(right.skill.name),
    )
    .map(({ skill, score }) => ({
      ...skill,
      relevance: score > 0 ? ("relevant" as const) : ("low" as const),
    }));
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

/**
 * A skill flagged `metadata.devOnly: true` is a development/test fixture (for
 * example a smoke-test skill). It must not enter a production run's candidate
 * set, where it wastes context and can mis-trigger. `loadSkills` itself stays
 * unfiltered so `list_skills`/CLI listing can still see it.
 */
export function isDevSkill(skill: Pick<SkillDefinition, "metadata">): boolean {
  return skill.metadata?.devOnly === true;
}

export function excludeDevSkills(
  skills: SkillDefinition[],
  includeDevSkills: boolean,
): SkillDefinition[] {
  if (includeDevSkills) return skills;
  return skills.filter((skill) => !isDevSkill(skill));
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
): ToolDefinition<{ name: string; resource?: string }> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  // Names whose body has already been loaded this run. A second load of the
  // same skill cannot add information — the body is already resident in
  // context — so we short-circuit it cheaply (no file I/O) and tell the model
  // it already has it, on the FIRST repeat rather than waiting for the
  // doom-loop nudge after a wasted round-trip.
  const loadedNames = new Set<string>();
  const resourceFileLimit =
    options.resourceFileLimit ?? DEFAULT_RESOURCE_FILE_LIMIT;

  if (!Number.isInteger(resourceFileLimit) || resourceFileLimit < 0) {
    throw new Error("resourceFileLimit must be a non-negative integer.");
  }

  return defineTool<{ name: string; resource?: string }>({
    name: "skill_load",
    description:
      "Load a Sparkwright skill body ONLY when the current task clearly falls within a skill's stated scope. Match against the skill description, not just a shared keyword — do not load a skill for tasks outside its domain. Prefer answering directly when no skill clearly applies. To read one of a loaded skill's reference files, call this tool again with that skill's name plus the file's skill-relative path as `resource`.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        resource: {
          type: "string",
          description:
            "Optional skill-relative path of a reference file to read (as listed in the loaded skill's <skill_files>). Returns that file's content.",
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

      if (args.resource !== undefined) {
        return await readSkillResource(skill, args.resource);
      }

      if (loadedNames.has(skill.name)) {
        return {
          status: "already_loaded",
          name: skill.name,
          message:
            `Skill \`${skill.name}\` is already loaded; its body is in ` +
            `context. Use it directly — do not load it again.`,
        };
      }

      // Resource files are reported skill-relative (never as absolute host
      // paths): they live outside the workspace, so an absolute path both leaks
      // the host layout and lures the model into a workspace-escaping read_file
      // call. The model reads them back through this tool's `resource` argument.
      const resourceFiles = await listSkillResourceFiles(
        skill,
        resourceFileLimit,
      );
      loadedNames.add(skill.name);

      return {
        status: "loaded",
        name: skill.name,
        description: skill.description,
        sourcePath: skill.sourcePath,
        contentHash: skill.contentHash,
        version: versionOf(skill.metadata),
        content: createSkillToolOutput(skill, resourceFiles),
        resourceFiles,
      };
    },
  });
}

export function createSkillIndexContext(
  skills: Array<SkillIndexEntry & { relevance?: "relevant" | "low" }>,
): ContextItem {
  const hasRelevance = skills.some((skill) => skill.relevance !== undefined);
  return {
    id: createContextItemId(),
    type: "system",
    source: {
      kind: "skill_index",
    },
    content: JSON.stringify(
      {
        kind: "skill_index",
        ...(hasRelevance
          ? {
              // Ordering is a hint, never a gate: the keyword ranker is a weak
              // lexical matcher and routinely misses skills the model would
              // recognize as relevant. Load whenever the task plausibly falls
              // in a skill's scope, and never answer about a skill's own
              // subject from memory.
              note: "Skills are listed most-relevant-first for the current goal, but this order is only a weak hint — do not skip a skill just because it appears lower. Load a skill via skill_load whenever the task plausibly falls within its described scope. Never answer questions about a skill's own subject (e.g. this tool's own commands, flags, config, or recovery steps) from memory: load the matching skill and verify against it first, and do not invent commands or flags.",
            }
          : {}),
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
    .map((path) => normalizePath(relative(root, path)))
    .sort((left, right) => left.localeCompare(right));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
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
    ...(skill.triggers && skill.triggers.length > 0
      ? { triggers: skill.triggers }
      : {}),
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

/**
 * Reads a skill reference file by its skill-relative path, on behalf of the
 * `skill_load` tool's `resource` argument. The resolved path is contained to
 * the skill's own directory, so a model cannot use it to read arbitrary host
 * files (e.g. via `..` or an absolute path).
 */
async function readSkillResource(
  skill: SkillDefinition,
  resource: string,
): Promise<Record<string, unknown>> {
  if (skill.sourcePath === "<built-in>") {
    return {
      status: "resource_not_found",
      name: skill.name,
      resource,
      message: "This skill is built in and has no readable reference files.",
    };
  }
  const baseDirectory = resolve(dirname(skill.sourcePath));
  const requested = resolve(baseDirectory, resource);
  if (
    requested !== baseDirectory &&
    !requested.startsWith(baseDirectory + sep)
  ) {
    return {
      status: "resource_denied",
      name: skill.name,
      resource,
      message: `Resource path escapes the skill directory: ${resource}`,
    };
  }
  let content: string;
  try {
    content = await readFile(requested, "utf8");
  } catch {
    return {
      status: "resource_not_found",
      name: skill.name,
      resource,
      message: `Reference file not found in skill \`${skill.name}\`: ${resource}`,
    };
  }
  return {
    status: "resource",
    name: skill.name,
    resource: normalizePath(relative(baseDirectory, requested)),
    content,
  };
}

function createSkillToolOutput(
  skill: SkillDefinition,
  resourceFiles: string[],
): string {
  const fileSection =
    resourceFiles.length > 0
      ? [
          "",
          "This skill ships reference files. To read one, call skill_load " +
            "again with this skill's name and the file's skill-relative path " +
            "as `resource` (for example: skill_load with name " +
            `"${skill.name}" and resource "${resourceFiles[0]}"). These files ` +
            "live outside the workspace — do NOT pass them to read_file or " +
            "prepend a working directory.",
          "",
          "<skill_files>",
          ...resourceFiles.map((file) => `<file>${file}</file>`),
          "</skill_files>",
        ]
      : [];
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.body.trim(),
    "",
    "This skill's body is now loaded — do NOT call skill_load again just to " +
      "reload the body.",
    ...fileSection,
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

// Single source of truth for tokenization: defer to the matcher's
// Unicode-aware tokenizer (Latin words + CJK bigrams) and wrap in a Set for
// the deterministic overlap scoring below.
function tokenize(value: string): Set<string> {
  return new Set(defaultTokenize(value));
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
