// AI maintenance note: Shared types for the Skill discovery and
// description-matching protocol. These are the public shapes that other
// modules in this package (manifest, loader, matcher, registry, capability)
// agree on. Keep these decoupled from any I/O — they describe data only.
//
// The protocol is intentionally small and deterministic: a manifest carries
// enough metadata for a host to decide *whether* to surface a skill, and a
// matcher returns ranked candidates from a query string. Execution is never
// part of this surface; embedders wire matches into their own loop.

/**
 * Signal that may cause a host to consult the skill registry.
 *
 * @public
 * @stability experimental v0.1
 */
export type SkillTriggerSignal =
  | "user_message"
  | "tool_result"
  | "explicit_invoke";

/**
 * Declarative description of a skill the model may load on demand.
 *
 * A manifest is data only — it does not carry runtime behavior. Host code is
 * responsible for translating `instructions` into context and for honoring
 * `allowedTools` / `requiredCapabilities` against its own policy layer.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SkillManifest {
  /** Lowercase, hyphenated identifier, unique within a registry. */
  name: string;
  /** Short human-facing summary used by the matcher. */
  description: string;
  /** Body of the skill — the prompt fragment the model should receive. */
  instructions: string;
  /** Optional keyword hints that boost matcher scoring. */
  triggers?: string[];
  /** Optional one-line examples shown to the model alongside the description. */
  examples?: string[];
  /** Allow-list of tool names this skill is expected to use. */
  allowedTools?: string[];
  /** Capability identifiers (free-form) the host must provide to enable this skill. */
  requiredCapabilities?: string[];
  /** Optional semantic version string. */
  version?: string;
  /** Optional package license identifier or short license text. */
  license?: string;
  /** Optional compatibility labels used by diagnostics and migration tooling. */
  compatibility?: string[];
  /** Filesystem source path, if loaded from disk. */
  source?: string;
  /**
   * Filesystem directory that holds the skill's optional support files
   * (typically the directory containing `SKILL.md`). Set by the loader; left
   * undefined for in-memory manifests.
   */
  assetsDir?: string;
  /**
   * Convention-named asset categories discovered next to the skill. Keys are
   * the canonical category names (`references`, `templates`, `scripts`);
   * values are file paths relative to `assetsDir`, sorted ascending.
   * Categories without files are omitted.
   */
  assets?: Partial<Record<SkillAssetCategory, string[]>>;
  /** Arbitrary additional metadata preserved from the source. */
  metadata?: Record<string, unknown>;
}

/**
 * Canonical asset subdirectories Sparkwright understands next to a `SKILL.md`.
 * - `references/` — condensed knowledge banks, quoted docs, reproduction recipes
 * - `templates/`  — starter files meant to be copied + modified
 * - `scripts/`    — statically re-runnable actions (verification, probes)
 *
 * @public
 * @stability experimental v0.1
 */
export type SkillAssetCategory = "references" | "templates" | "scripts";

/** @public */
export const SKILL_ASSET_CATEGORIES: readonly SkillAssetCategory[] = [
  "references",
  "templates",
  "scripts",
];

/**
 * A scored match returned by {@link import("./matcher.js").matchSkills}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SkillMatch {
  skill: SkillManifest;
  /** Non-negative score; higher is a better match. Zero means no overlap. */
  score: number;
  /**
   * Tokens that contributed to the score, useful for trace UIs.
   *
   * @reserved Public field consumed by skill-match trace UIs.
   */
  matchedKeywords: string[];
}

/**
 * Error emitted by {@link import("./loader.js").loadSkillsFromDirectory}
 * when a single skill source fails to parse. Other skills in the directory
 * are loaded normally.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SkillLoadError {
  source: string;
  message: string;
}
