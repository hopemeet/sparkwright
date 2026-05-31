// AI maintenance note: Filesystem archive/restore primitives for curator
// hosts. The pure state machine marks records archived; this module performs
// the optional file move. It stays conservative: no deletes, pinned skills
// are refused by default, and only agent-created records are accepted unless
// the caller explicitly opts out.

import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { SkillUsageRecorder } from "@sparkwright/skills";

export interface ArchiveSkillOptions {
  skillPath: string;
  usage: SkillUsageRecorder;
  archiveRoot?: string;
  agentCreatedOnly?: boolean;
  allowPinned?: boolean;
  now?: Date;
}

export interface ArchiveSkillResult {
  name: string;
  from: string;
  /** @reserved Public archive-result field consumed by curator UIs. */
  to: string;
}

export interface RestoreSkillOptions {
  archivedPath: string;
  restoreRoot?: string;
  usage?: SkillUsageRecorder;
}

export async function archiveSkillDirectory(
  name: string,
  options: ArchiveSkillOptions,
): Promise<ArchiveSkillResult> {
  const record = options.usage.get(name);
  if ((options.agentCreatedOnly ?? true) && !record?.agentCreated) {
    throw new Error(`Refusing to archive non-agent-created skill: ${name}`);
  }
  if (!options.allowPinned && record?.pinned) {
    throw new Error(`Refusing to archive pinned skill: ${name}`);
  }

  const source = await resolveSkillDirectory(options.skillPath);
  const archiveRoot = options.archiveRoot ?? join(dirname(source), ".archive");
  await mkdir(archiveRoot, { recursive: true });
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const destination = join(archiveRoot, `${name}-${stamp}`);
  await rename(source, destination);
  options.usage.setState(name, "archived");
  return { name, from: source, to: destination };
}

export async function restoreArchivedSkill(
  name: string,
  options: RestoreSkillOptions,
): Promise<ArchiveSkillResult> {
  const source = resolve(options.archivedPath);
  const restoreRoot = options.restoreRoot ?? dirname(dirname(source));
  await mkdir(restoreRoot, { recursive: true });
  const destination = await firstAvailablePath(join(restoreRoot, name));
  await rename(source, destination);
  options.usage?.setState(name, "active");
  return { name, from: source, to: destination };
}

async function resolveSkillDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  const info = await stat(resolved);
  if (info.isDirectory()) return resolved;
  if (basename(resolved) === "SKILL.md") return dirname(resolved);
  throw new Error(`Skill path must be a directory or SKILL.md: ${path}`);
}

async function firstAvailablePath(base: string): Promise<string> {
  const parent = dirname(base);
  const stem = basename(base);
  const existing = new Set(await readdir(parent).catch(() => []));
  if (!existing.has(stem)) return base;
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.has(basename(candidate))) return candidate;
  }
  throw new Error(`Could not find available restore path for ${base}`);
}
