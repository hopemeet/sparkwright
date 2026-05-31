// AI maintenance note: In-memory registry for the discovery protocol. The
// registry is *only* an inventory — it has no execute method, no policy
// evaluation, no I/O. Hosts assemble a registry once at run setup and pass
// matches to their loop in whatever shape they prefer. Duplicate names throw
// unless the caller opts in to `overwrite: true`; this keeps drift visible.

import { matchSkills, type MatchSkillsOptions } from "./matcher.js";
import type { SkillManifest, SkillMatch } from "./types.js";

/**
 * Options for {@link SkillRegistry.register}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface RegisterSkillOptions {
  /** When true, replace an existing skill with the same name. Default false. */
  overwrite?: boolean;
}

/**
 * In-memory inventory of {@link SkillManifest}s.
 *
 * @public
 * @stability experimental v0.1
 */
export class SkillRegistry {
  private readonly byName = new Map<string, SkillManifest>();

  constructor(initial: readonly SkillManifest[] = []) {
    for (const skill of initial) this.register(skill);
  }

  /** Register a skill. Throws if `skill.name` already exists. */
  register(skill: SkillManifest, options: RegisterSkillOptions = {}): void {
    if (this.byName.has(skill.name) && !options.overwrite) {
      throw new Error(`Skill already registered: ${skill.name}`);
    }
    this.byName.set(skill.name, skill);
  }

  /** Remove a skill by name. Returns true if a skill was removed. */
  unregister(name: string): boolean {
    return this.byName.delete(name);
  }

  /** Look up a skill by name. */
  get(name: string): SkillManifest | undefined {
    return this.byName.get(name);
  }

  /** List all registered skills, sorted by name. */
  list(): SkillManifest[] {
    return [...this.byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** Score `query` against the registered skills. */
  match(query: string, options?: MatchSkillsOptions): SkillMatch[] {
    return matchSkills(query, this.list(), options);
  }

  /** Number of registered skills. */
  get size(): number {
    return this.byName.size;
  }
}
