// AI maintenance note: Skill bundles are aliases that name a set of skills
// to load together. The shape is intentionally tiny — just a discriminated
// inventory layer. Resolution is pure (bundle → skill manifests) so hosts
// can decide what to do with the result (inject them all into context,
// expose them as a single "/foo" slash command, etc.).
//
// Conflict rule: when a bundle and a single skill share the same name, the
// BUNDLE wins. Embedders that don't like this can call `getSkill` directly.

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SkillManifest } from "./types.js";

/**
 * Declarative bundle definition. Source format is a small JSON / YAML-ish
 * frontmatter file (`<bundle>.bundle.json` or `.yaml`), but the in-memory
 * shape is the canonical contract.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SkillBundle {
  /** Lowercase, hyphenated identifier. */
  name: string;
  /** Short human-facing summary. */
  description?: string;
  /** Names of skills to load together, in order. */
  skills: string[];
  /** Optional extra instruction injected before the bundled skill bodies. */
  instruction?: string;
  /** Filesystem source path, if loaded from disk. */
  source?: string;
}

/**
 * Result of {@link resolveBundle}. Missing skills are surfaced so the host
 * can decide whether to fail or warn.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ResolvedBundle {
  bundle: SkillBundle;
  skills: SkillManifest[];
  missing: string[];
}

/**
 * In-memory registry of bundles. Mirrors the shape of `SkillRegistry` but for
 * compound entries.
 *
 * @public
 * @stability experimental v0.1
 */
export class SkillBundleRegistry {
  private readonly byName = new Map<string, SkillBundle>();

  constructor(initial: readonly SkillBundle[] = []) {
    for (const bundle of initial) this.register(bundle);
  }

  register(bundle: SkillBundle, options: { overwrite?: boolean } = {}): void {
    if (this.byName.has(bundle.name) && !options.overwrite) {
      throw new Error(`Bundle already registered: ${bundle.name}`);
    }
    this.byName.set(bundle.name, bundle);
  }

  unregister(name: string): boolean {
    return this.byName.delete(name);
  }

  get(name: string): SkillBundle | undefined {
    return this.byName.get(name);
  }

  list(): SkillBundle[] {
    return [...this.byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  get size(): number {
    return this.byName.size;
  }
}

/**
 * Resolve a bundle's `skills[]` list against a lookup function. Missing
 * skill names are collected in `missing` rather than throwing so the host
 * can decide on policy.
 *
 * @public
 * @stability experimental v0.1
 */
export function resolveBundle(
  bundle: SkillBundle,
  lookup: (name: string) => SkillManifest | undefined,
): ResolvedBundle {
  const skills: SkillManifest[] = [];
  const missing: string[] = [];
  for (const name of bundle.skills) {
    const skill = lookup(name);
    if (skill) skills.push(skill);
    else missing.push(name);
  }
  return { bundle, skills, missing };
}

/**
 * Resolve a slash-style command (`/foo`) against a bundle registry first,
 * then a skill registry — bundles win on name collision. Returns `undefined`
 * if neither side matches.
 *
 * @public
 * @stability experimental v0.1
 */
export function resolveSlashCommand<S extends { name: string }>(
  command: string,
  options: {
    bundles?: SkillBundleRegistry;
    skills?: Iterable<S> | { get(name: string): S | undefined };
  },
):
  | { kind: "bundle"; bundle: SkillBundle }
  | { kind: "skill"; skill: S }
  | undefined {
  const name = command.startsWith("/") ? command.slice(1) : command;
  const slug = slugify(name);

  const bundle = options.bundles?.get(slug);
  if (bundle) return { kind: "bundle", bundle };

  if (options.skills) {
    const getter = (options.skills as { get?: (n: string) => S | undefined })
      .get;
    if (typeof getter === "function") {
      const skill = getter.call(options.skills, slug);
      if (skill) return { kind: "skill", skill };
    } else {
      for (const skill of options.skills as Iterable<S>) {
        if (skill.name === slug) return { kind: "skill", skill };
      }
    }
  }
  return undefined;
}

/**
 * Build the user-facing message produced by invoking a bundle: the optional
 * instruction followed by each loaded skill body. Hosts inject this as a
 * single user turn so the skills land in context together.
 *
 * @public
 * @stability experimental v0.1
 */
export function buildBundleInvocationMessage(resolved: ResolvedBundle): string {
  const parts: string[] = [];
  if (resolved.bundle.instruction) parts.push(resolved.bundle.instruction);
  for (const skill of resolved.skills) {
    parts.push(`# Skill: ${skill.name}\n${skill.instructions.trim()}`);
  }
  return parts.join("\n\n");
}

/**
 * Walk a directory and load every `*.bundle.json` file. JSON only for v0.1 —
 * adding YAML would require an external dependency that the rest of this
 * package goes out of its way to avoid.
 *
 * @public
 * @stability experimental v0.1
 */
export async function loadBundlesFromDirectory(dir: string): Promise<{
  bundles: SkillBundle[];
  errors: Array<{ source: string; message: string }>;
}> {
  const root = resolve(dir);
  const bundles: SkillBundle[] = [];
  const errors: Array<{ source: string; message: string }> = [];

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { bundles, errors };
    }
    throw cause;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".bundle.json")) continue;
    const path = join(root, entry.name);
    try {
      const text = await readFile(path, "utf8");
      const parsed = parseBundleJson(text, path);
      bundles.push(parsed);
    } catch (cause) {
      errors.push({
        source: path,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { bundles, errors };
}

function parseBundleJson(text: string, source: string): SkillBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `Bundle is not valid JSON (${source}): ${(cause as Error).message}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Bundle JSON must be an object (${source}).`);
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(
      `Bundle name must use lowercase letters, numbers, and hyphens (max 64 chars) (${source}).`,
    );
  }
  const skillsRaw = record.skills;
  if (
    !Array.isArray(skillsRaw) ||
    skillsRaw.some((s) => typeof s !== "string")
  ) {
    throw new Error(
      `Bundle '${name}' must have a string[] skills field (${source}).`,
    );
  }
  const out: SkillBundle = {
    name,
    skills: (skillsRaw as string[]).map((s) => s.trim()).filter(Boolean),
    source,
  };
  if (typeof record.description === "string")
    out.description = record.description;
  if (typeof record.instruction === "string")
    out.instruction = record.instruction;
  return out;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-");
}
