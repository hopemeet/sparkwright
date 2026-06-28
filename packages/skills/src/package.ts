import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const SKILL_FILE_NAME = "SKILL.md";
const PACKAGE_DIRS = ["references", "templates", "scripts"] as const;

export interface SkillPackageFile {
  relativePath: string;
  absolutePath: string;
  size: number;
}

export interface SkillPackageHash {
  /** @reserved Hash algorithm discriminator for serialized package hashes consumed by readers, not by an in-process TS reader. */
  algorithm: "sha256";
  value: string;
  packageHash: string;
  files: SkillPackageFile[];
}

export interface SkillPackageHashOptions {
  /**
   * Optional guardrail for callers that hash untrusted or very large packages.
   * The default direct hash path has no limit.
   */
  maxFiles?: number;
  /**
   * Optional guardrail on total package bytes read for hashing. The default
   * direct hash path has no limit.
   */
  maxBytes?: number;
}

export interface SkillPackageHasher {
  compute(
    skillDir: string,
    options?: SkillPackageHashOptions,
  ): Promise<SkillPackageHash>;
  clear(): void;
  readonly size: number;
}

export interface SnapshotSkillPackageResult {
  /** @reserved Snapshot provenance returned for callers/diagnostics, not by an in-process TS reader. */
  sourceDir: string;
  /** @reserved Snapshot provenance returned for callers/diagnostics, not by an in-process TS reader. */
  targetDir: string;
  files: SkillPackageFile[];
}

interface SkillPackageFileStat extends SkillPackageFile {
  mtimeMs: number;
  ctimeMs: number;
}

interface CachedSkillPackageHash {
  fingerprint: string;
  result: SkillPackageHash;
}

export async function computeSkillPackageHash(
  skillDir: string,
  options: SkillPackageHashOptions = {},
): Promise<SkillPackageHash> {
  const root = resolve(skillDir);
  const files = await listSkillPackageFilesWithStats(root);
  assertPackageHashLimits(files, options, root);
  return computeSkillPackageHashFromFiles(files);
}

export function createSkillPackageHasher(
  defaultOptions: SkillPackageHashOptions = {},
): SkillPackageHasher {
  const cache = new Map<string, CachedSkillPackageHash>();
  return {
    async compute(
      skillDir: string,
      options: SkillPackageHashOptions = {},
    ): Promise<SkillPackageHash> {
      const root = resolve(skillDir);
      const files = await listSkillPackageFilesWithStats(root);
      const mergedOptions = { ...defaultOptions, ...options };
      assertPackageHashLimits(files, mergedOptions, root);
      const fingerprint = skillPackageFingerprint(files);
      const cached = cache.get(root);
      if (cached?.fingerprint === fingerprint) {
        return cloneSkillPackageHash(cached.result);
      }
      const result = await computeSkillPackageHashFromFiles(files);
      cache.set(root, { fingerprint, result });
      return cloneSkillPackageHash(result);
    },
    clear() {
      cache.clear();
    },
    get size() {
      return cache.size;
    },
  };
}

async function computeSkillPackageHashFromFiles(
  files: readonly SkillPackageFileStat[],
): Promise<SkillPackageHash> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(await readFile(file.absolutePath));
    hash.update("\0");
  }
  const value = hash.digest("hex");
  return {
    algorithm: "sha256",
    value,
    packageHash: `sha256:${value}`,
    files: files.map(publicPackageFile),
  };
}

export async function listSkillPackageFiles(
  skillDir: string,
): Promise<SkillPackageFile[]> {
  return (await listSkillPackageFilesWithStats(skillDir)).map(
    publicPackageFile,
  );
}

async function listSkillPackageFilesWithStats(
  skillDir: string,
): Promise<SkillPackageFileStat[]> {
  const root = resolve(skillDir);
  await requireRegularFile(join(root, SKILL_FILE_NAME), SKILL_FILE_NAME);
  const files: SkillPackageFileStat[] = [
    await packageFileWithStats(root, join(root, SKILL_FILE_NAME)),
  ];

  for (const dir of PACKAGE_DIRS) {
    const absoluteDir = join(root, dir);
    const info = await lstat(absoluteDir).catch(() => undefined);
    if (!info) continue;
    if (!info.isDirectory()) {
      throw new Error(`Skill package entry must be a directory: ${dir}`);
    }
    files.push(...(await collectPackageFiles(root, absoluteDir)));
  }

  return files.sort((left, right) =>
    compareRelativePath(left.relativePath, right.relativePath),
  );
}

export async function snapshotSkillPackage(
  skillDir: string,
  targetDir: string,
): Promise<SnapshotSkillPackageResult> {
  const sourceDir = resolve(skillDir);
  const resolvedTargetDir = resolve(targetDir);
  const files = await listSkillPackageFiles(sourceDir);

  await rm(resolvedTargetDir, { recursive: true, force: true });
  for (const file of files) {
    const target = join(resolvedTargetDir, file.relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file.absolutePath, target);
  }

  return {
    sourceDir,
    targetDir: resolvedTargetDir,
    files,
  };
}

async function collectPackageFiles(
  root: string,
  dir: string,
): Promise<SkillPackageFileStat[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: SkillPackageFileStat[] = [];

  for (const entry of entries.sort((left, right) =>
    compareRelativePath(left.name, right.name),
  )) {
    const absolutePath = join(dir, entry.name);
    const relativePath = normalizeRelativePath(relative(root, absolutePath));
    if (entry.isDirectory()) {
      files.push(...(await collectPackageFiles(root, absolutePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Skill package entry must be a regular file or directory: ${relativePath}`,
      );
    }
    files.push(await packageFileWithStats(root, absolutePath));
  }

  return files;
}

async function packageFileWithStats(
  root: string,
  absolutePath: string,
): Promise<SkillPackageFileStat> {
  const info = await requireRegularFile(
    absolutePath,
    normalizeRelativePath(relative(root, absolutePath)),
  );
  return {
    relativePath: normalizeRelativePath(relative(root, absolutePath)),
    absolutePath,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

async function requireRegularFile(
  path: string,
  label: string,
): Promise<{ size: number; mtimeMs: number; ctimeMs: number }> {
  const info = await lstat(path);
  if (!info.isFile()) {
    throw new Error(`Skill package entry must be a regular file: ${label}`);
  }
  return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function compareRelativePath(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertPackageHashLimits(
  files: readonly SkillPackageFileStat[],
  options: SkillPackageHashOptions,
  skillDir: string,
): void {
  if (options.maxFiles !== undefined && files.length > options.maxFiles) {
    throw new Error(
      `Skill package exceeds file limit (${files.length} > ${options.maxFiles}): ${skillDir}`,
    );
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (options.maxBytes !== undefined && totalBytes > options.maxBytes) {
    throw new Error(
      `Skill package exceeds byte limit (${totalBytes} > ${options.maxBytes}): ${skillDir}`,
    );
  }
}

function skillPackageFingerprint(
  files: readonly SkillPackageFileStat[],
): string {
  return files
    .map((file) =>
      [
        file.relativePath,
        file.size,
        Number.isFinite(file.mtimeMs) ? file.mtimeMs : 0,
        Number.isFinite(file.ctimeMs) ? file.ctimeMs : 0,
      ].join("\0"),
    )
    .join("\0\0");
}

function publicPackageFile(file: SkillPackageFile): SkillPackageFile {
  return {
    relativePath: file.relativePath,
    absolutePath: file.absolutePath,
    size: file.size,
  };
}

function cloneSkillPackageHash(result: SkillPackageHash): SkillPackageHash {
  return {
    algorithm: result.algorithm,
    value: result.value,
    packageHash: result.packageHash,
    files: result.files.map(publicPackageFile),
  };
}
