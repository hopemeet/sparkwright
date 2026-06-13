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

export interface SnapshotSkillPackageResult {
  /** @reserved Snapshot provenance returned for callers/diagnostics, not by an in-process TS reader. */
  sourceDir: string;
  /** @reserved Snapshot provenance returned for callers/diagnostics, not by an in-process TS reader. */
  targetDir: string;
  files: SkillPackageFile[];
}

export async function computeSkillPackageHash(
  skillDir: string,
): Promise<SkillPackageHash> {
  const files = await listSkillPackageFiles(skillDir);
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
    files,
  };
}

export async function listSkillPackageFiles(
  skillDir: string,
): Promise<SkillPackageFile[]> {
  const root = resolve(skillDir);
  await requireRegularFile(join(root, SKILL_FILE_NAME), SKILL_FILE_NAME);
  const files: SkillPackageFile[] = [
    await packageFile(root, join(root, SKILL_FILE_NAME)),
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
): Promise<SkillPackageFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: SkillPackageFile[] = [];

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
    files.push(await packageFile(root, absolutePath));
  }

  return files;
}

async function packageFile(
  root: string,
  absolutePath: string,
): Promise<SkillPackageFile> {
  const info = await requireRegularFile(
    absolutePath,
    normalizeRelativePath(relative(root, absolutePath)),
  );
  return {
    relativePath: normalizeRelativePath(relative(root, absolutePath)),
    absolutePath,
    size: info.size,
  };
}

async function requireRegularFile(
  path: string,
  label: string,
): Promise<{ size: number }> {
  const info = await lstat(path);
  if (!info.isFile()) {
    throw new Error(`Skill package entry must be a regular file: ${label}`);
  }
  return { size: info.size };
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function compareRelativePath(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
