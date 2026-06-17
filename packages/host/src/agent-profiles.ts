// AI maintenance note: Markdown-authored agent profiles. A `.sparkwright/agents/*.md`
// file is an ergonomic alternative to a `capabilities.agents.profiles[]` entry in
// config.json — nicer for long role prompts. Discovery + mapping live here at the
// host edge; the canonical AgentProfile shape lives in @sparkwright/agent-runtime.
// Explicit config.json entries win over same-id markdown files (see
// docs/PROJECT_CONFIG_SURFACE.md, Decision 1). Advanced fields (policy, runBudget)
// stay in config.json; markdown frontmatter covers the common case.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentMode, AgentProfile } from "@sparkwright/agent-runtime";
import { resolveCapabilityDirs } from "./layers.js";

const AGENT_MODES = new Set<AgentMode>(["primary", "child", "all"]);

/**
 * Discover and parse `<workspaceRoot>/.sparkwright/agents/*.md` into profiles.
 * Missing dir → empty list. Unreadable files are skipped.
 */
export async function discoverProjectAgentProfiles(
  workspaceRoot: string,
): Promise<AgentProfile[]> {
  const dir = join(workspaceRoot, ".sparkwright", "agents");
  return discoverAgentProfilesInDir(dir);
}

export async function discoverLayeredAgentProfiles(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
): Promise<AgentProfile[]> {
  const byId = new Map<string, AgentProfile>();
  for (const dir of resolveCapabilityDirs("agents", {
    cwd: workspaceRoot,
    env,
  })) {
    for (const profile of await discoverAgentProfilesInDir(dir.dir)) {
      byId.set(profile.id, profile);
    }
  }
  return [...byId.values()];
}

async function discoverAgentProfilesInDir(
  dir: string,
): Promise<AgentProfile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: AgentProfile[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const raw = await readFile(join(dir, entry), "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    out.push(parseAgentProfileFile(basename(entry, ".md"), raw));
  }
  return out;
}

/**
 * Merge markdown-authored profiles (weak) under config profiles (strong) by id.
 * A config entry with the same id wins wholesale — config is the precise layer.
 */
export function mergeAgentProfilesById(
  weak: readonly AgentProfile[],
  strong: readonly AgentProfile[],
): AgentProfile[] {
  const byId = new Map<string, AgentProfile>();
  for (const profile of weak) byId.set(profile.id, profile);
  for (const profile of strong) byId.set(profile.id, profile);
  return [...byId.values()];
}

/**
 * Resolve the effective agent profile list for a workspace: markdown files
 * folded under config.json profiles, config winning ties by id.
 */
export async function resolveAgentProfiles(
  workspaceRoot: string,
  configProfiles: readonly AgentProfile[] | undefined,
): Promise<AgentProfile[]> {
  const markdown = await discoverLayeredAgentProfiles(workspaceRoot);
  return mergeAgentProfilesById(markdown, configProfiles ?? []);
}

/** Parse one agent markdown file (`id` = filename) into an AgentProfile. */
export function parseAgentProfileFile(id: string, raw: string): AgentProfile {
  const { frontmatter, body } = splitAgentFrontmatter(raw);
  const profile: AgentProfile = { id };

  const name = scalar(frontmatter, "name");
  if (name) profile.name = name;
  const description = scalar(frontmatter, "description");
  if (description) profile.description = description;

  const allowedTools = list(frontmatter, "allowedtools");
  if (allowedTools.length > 0) profile.allowedTools = allowedTools;
  const deniedTools = list(frontmatter, "deniedtools");
  if (deniedTools.length > 0) profile.deniedTools = deniedTools;

  const maxSteps = integer(frontmatter, "maxsteps");
  if (maxSteps !== undefined) profile.maxSteps = maxSteps;

  const mode = agentMode(frontmatter, "mode");
  const model = scalar(frontmatter, "model");
  const prompt = body.length > 0 ? body : undefined;

  if (mode) profile.mode = mode;
  if (model) profile.model = model;
  if (prompt) profile.prompt = prompt;

  return profile;
}

interface Frontmatter {
  [key: string]: string;
}

/** Split a leading `---`..`---` block; recognized keys only, no YAML dependency. */
export function splitAgentFrontmatter(raw: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(
    normalized,
  );
  if (!match) return { frontmatter: {}, body: normalized.trim() };
  const frontmatter: Frontmatter = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    frontmatter[kv[1]!.toLowerCase()] = kv[2]!.trim();
  }
  return { frontmatter, body: match[2]!.trim() };
}

function scalar(fm: Frontmatter, key: string): string | undefined {
  const value = fm[key];
  if (value === undefined) return undefined;
  const stripped = stripQuotes(value);
  return stripped.length > 0 ? stripped : undefined;
}

function list(fm: Frontmatter, key: string): string[] {
  const value = fm[key];
  if (value === undefined) return [];
  const inner = value.replace(/^\[(.*)\]$/, "$1");
  return inner
    .split(",")
    .map((item) => stripQuotes(item.trim()))
    .filter((item) => item.length > 0);
}

function integer(fm: Frontmatter, key: string): number | undefined {
  const value = scalar(fm, key);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function agentMode(fm: Frontmatter, key: string): AgentMode | undefined {
  const value = scalar(fm, key);
  return value && AGENT_MODES.has(value as AgentMode)
    ? (value as AgentMode)
    : undefined;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
