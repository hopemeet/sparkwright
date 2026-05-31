// AI maintenance note: Filesystem loader for the discovery protocol. Walks a
// directory and accepts three conventions: `*.skill.md`, `*.skill.json`, and
// subdirectories containing `SKILL.md`. Per-file parse failures are *not*
// fatal — they are surfaced via `loadErrors[]` so the registry can still come
// up with the good skills. No glob library; everything is hand-rolled against
// `node:fs/promises`.

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseSkillManifest } from "./manifest.js";
import {
  SKILL_ASSET_CATEGORIES,
  type SkillAssetCategory,
  type SkillLoadError,
  type SkillManifest,
} from "./types.js";

const SKILL_DIR_FILE = "SKILL.md";
const FLAT_MD_SUFFIX = ".skill.md";
const FLAT_JSON_SUFFIX = ".skill.json";

/**
 * Options for {@link loadSkillsFromDirectory}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface LoadSkillsOptions {
  /** Follow nested directories recursively. Default: true. */
  recursive?: boolean;
  /** Maximum directory depth when `recursive` is true. Default: 4. */
  maxDepth?: number;
}

/**
 * Result of {@link loadSkillsFromDirectory}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface LoadSkillsResult {
  skills: SkillManifest[];
  /** @reserved Public field consumed by skill-loading UIs and diagnostics. */
  loadErrors: SkillLoadError[];
}

/**
 * Walk `dir` and load every skill source found. Returns all successfully
 * parsed manifests; per-file errors are reported in `loadErrors`.
 *
 * @public
 * @stability experimental v0.1
 */
export async function loadSkillsFromDirectory(
  dir: string,
  options: LoadSkillsOptions = {},
): Promise<LoadSkillsResult> {
  const root = resolve(dir);
  const recursive = options.recursive ?? true;
  const maxDepth = options.maxDepth ?? 4;

  const sources: string[] = [];
  await collect(root, sources, recursive, maxDepth, 0);

  const skills: SkillManifest[] = [];
  const loadErrors: SkillLoadError[] = [];
  const seen = new Set<string>();

  for (const path of sources.sort((a, b) => a.localeCompare(b))) {
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      const text = await readFile(path, "utf8");
      const manifest = parseSkillManifest(text, path);
      await attachAssets(manifest, path);
      skills.push(manifest);
    } catch (cause) {
      loadErrors.push({
        source: path,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { skills, loadErrors };
}

/**
 * Resolve and populate `assetsDir` + `assets` on a manifest loaded from disk.
 * No-op when the source path is the flat `.skill.md` / `.skill.json` form
 * (assets only make sense alongside a SKILL.md inside a directory).
 *
 * @internal
 */
async function attachAssets(
  manifest: SkillManifest,
  sourcePath: string,
): Promise<void> {
  if (basename(sourcePath) !== SKILL_DIR_FILE) return;
  const dir = dirname(sourcePath);
  manifest.assetsDir = dir;

  const assets: Partial<Record<SkillAssetCategory, string[]>> = {};
  for (const category of SKILL_ASSET_CATEGORIES) {
    const subdir = join(dir, category);
    const files = await collectFiles(subdir);
    if (files.length > 0) {
      assets[category] = files
        .map((f) => relative(dir, f))
        .sort((a, b) => a.localeCompare(b));
    }
  }
  if (Object.keys(assets).length > 0) manifest.assets = assets;
}

async function collectFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile()) {
      out.push(path);
    } else if (entry.isDirectory()) {
      out.push(...(await collectFiles(path)));
    }
  }
  return out;
}

async function collect(
  dir: string,
  out: string[],
  recursive: boolean,
  maxDepth: number,
  depth: number,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Pick up SKILL.md sitting directly under this directory.
  const direct = join(dir, SKILL_DIR_FILE);
  if (await exists(direct)) out.push(direct);

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);

    if (entry.isFile()) {
      if (entry.name === SKILL_DIR_FILE) continue; // already handled
      if (isSkillFileName(entry.name)) out.push(path);
      continue;
    }

    if (entry.isDirectory()) {
      if (!recursive || depth >= maxDepth) {
        const nested = join(path, SKILL_DIR_FILE);
        if (await exists(nested)) out.push(nested);
        continue;
      }
      await collect(path, out, recursive, maxDepth, depth + 1);
    }
  }
}

function isSkillFileName(name: string): boolean {
  return name.endsWith(FLAT_MD_SUFFIX) || name.endsWith(FLAT_JSON_SUFFIX);
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    return false;
  }
}

/**
 * Lower-level helper for callers that already know which file to parse.
 *
 * @public
 * @stability experimental v0.1
 */
export async function loadSkillFromFile(path: string): Promise<SkillManifest> {
  const resolved = resolve(path);
  const text = await readFile(resolved, "utf8");
  const manifest = parseSkillManifest(text, resolved);
  await attachAssets(manifest, resolved);
  return manifest;
}

/** @internal */
export function _suffixesForTesting(): {
  dir: string;
  md: string;
  json: string;
} {
  return { dir: SKILL_DIR_FILE, md: FLAT_MD_SUFFIX, json: FLAT_JSON_SUFFIX };
}

// Silence unused import warning when basename is not used downstream.
void basename;
