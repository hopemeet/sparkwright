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

export const PACKAGE_HASH_POLICY_VERSION = 2 as const;
export const DEFAULT_ASSET_PACKAGE_MAX_FILES = 512;
export const DEFAULT_ASSET_PACKAGE_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_ASSET_PACKAGE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const EXCLUDED_DIRECTORIES = new Set([".git", ".sparkwright", "node_modules"]);
const EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db"]);
const CASE_FOLDING_PLATFORM =
  process.platform === "darwin" || process.platform === "win32";

export interface AssetPackageLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface AssetPackageSpec {
  rootPath: string;
  /** Required non-excluded regular file, relative to `rootPath`. */
  entryPath: string;
  limits?: Partial<AssetPackageLimits>;
}

export interface AssetPackageFile {
  relativePath: string;
  absolutePath: string;
  size: number;
}

export interface AssetPackageIdentity {
  packageHashPolicyVersion: typeof PACKAGE_HASH_POLICY_VERSION;
  packageHash: string;
  fileCount: number;
  totalBytes: number;
}

export interface AssetPackageHash extends AssetPackageIdentity {
  algorithm: "sha256";
  value: string;
  files: AssetPackageFile[];
}

export interface SnapshotAssetPackageResult extends AssetPackageIdentity {
  sourceDir: string;
  targetDir: string;
  files: AssetPackageFile[];
}

interface AssetPackageFileStat extends AssetPackageFile {
  mtimeMs: number;
  ctimeMs: number;
}

export function assetPackageLimits(
  limits: Partial<AssetPackageLimits> = {},
): AssetPackageLimits {
  return {
    maxFiles: limits.maxFiles ?? DEFAULT_ASSET_PACKAGE_MAX_FILES,
    maxFileBytes: limits.maxFileBytes ?? DEFAULT_ASSET_PACKAGE_MAX_FILE_BYTES,
    maxTotalBytes:
      limits.maxTotalBytes ?? DEFAULT_ASSET_PACKAGE_MAX_TOTAL_BYTES,
  };
}

export async function listAssetPackageFiles(
  spec: AssetPackageSpec,
): Promise<AssetPackageFile[]> {
  return (await listAssetPackageFilesWithStats(spec)).map(publicPackageFile);
}

export async function computeAssetPackageHash(
  spec: AssetPackageSpec,
): Promise<AssetPackageHash> {
  const files = await listAssetPackageFilesWithStats(spec);
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
    packageHashPolicyVersion: PACKAGE_HASH_POLICY_VERSION,
    fileCount: files.length,
    totalBytes: totalBytes(files),
    files: files.map(publicPackageFile),
  };
}

export async function snapshotAssetPackage(
  spec: AssetPackageSpec,
  targetDir: string,
): Promise<SnapshotAssetPackageResult> {
  const root = resolve(spec.rootPath);
  const target = resolve(targetDir);
  if (target === root || !relative(root, target).startsWith("..")) {
    throw new Error(
      "Asset package snapshot target must be outside its source root.",
    );
  }
  const files = await listAssetPackageFilesWithStats(spec);
  await rm(target, { recursive: true, force: true });
  for (const file of files) {
    const destination = join(target, file.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file.absolutePath, destination);
  }
  return {
    sourceDir: root,
    targetDir: target,
    packageHashPolicyVersion: PACKAGE_HASH_POLICY_VERSION,
    packageHash: await hashSnapshotFiles(target, files),
    fileCount: files.length,
    totalBytes: totalBytes(files),
    files: files.map(publicPackageFile),
  };
}

async function listAssetPackageFilesWithStats(
  spec: AssetPackageSpec,
): Promise<AssetPackageFileStat[]> {
  const root = resolve(spec.rootPath);
  const entryPath = validateEntryPath(spec.entryPath);
  const rootInfo = await lstat(root).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Asset package root must be a real directory: ${root}`);
  }
  const files: AssetPackageFileStat[] = [];
  await collectPackageFiles(root, root, files, assetPackageLimits(spec.limits));
  files.sort((left, right) =>
    compareRelativePath(left.relativePath, right.relativePath),
  );
  assertNoCaseFoldCollisions(files);
  if (!files.some((file) => file.relativePath === entryPath)) {
    throw new Error(
      `Asset package entry must be an included regular file: ${entryPath}`,
    );
  }
  return files;
}

async function collectPackageFiles(
  root: string,
  dir: string,
  files: AssetPackageFileStat[],
  limits: AssetPackageLimits,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    compareRelativePath(left.name, right.name),
  )) {
    const absolutePath = join(dir, entry.name);
    const relativePath = packageRelativePath(root, absolutePath);
    const info = await lstat(absolutePath);
    if (isExcluded(relativePath, info.isDirectory())) continue;
    if (info.isSymbolicLink()) {
      throw new Error(
        `Asset package cannot contain a symlink: ${relativePath}`,
      );
    }
    if (info.isDirectory()) {
      await collectPackageFiles(root, absolutePath, files, limits);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(
        `Asset package entry must be a regular file or directory: ${relativePath}`,
      );
    }
    if (info.size > limits.maxFileBytes) {
      throw new Error(
        `Asset package file exceeds byte limit (${info.size} > ${limits.maxFileBytes}): ${relativePath}`,
      );
    }
    files.push({
      relativePath,
      absolutePath,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
    });
    if (files.length > limits.maxFiles) {
      throw new Error(
        `Asset package exceeds file limit (${files.length} > ${limits.maxFiles}): ${root}`,
      );
    }
    if (totalBytes(files) > limits.maxTotalBytes) {
      throw new Error(
        `Asset package exceeds byte limit (${totalBytes(files)} > ${limits.maxTotalBytes}): ${root}`,
      );
    }
  }
}

function validateEntryPath(entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(
      `Asset package entry path must stay inside the package: ${entryPath}`,
    );
  }
  return normalized;
}

function packageRelativePath(root: string, absolutePath: string): string {
  const normalized = relative(root, absolutePath).replace(/\\/g, "/");
  if (
    normalized === "" ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Asset package path escapes root: ${absolutePath}`);
  }
  return normalized;
}

function isExcluded(relativePath: string, isDirectory: boolean): boolean {
  const segments = relativePath.split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment)))
    return true;
  if (isDirectory) return false;
  const basename = segments.at(-1)!;
  return (
    EXCLUDED_FILES.has(basename) ||
    basename.endsWith(".swp") ||
    basename.endsWith(".tmp") ||
    basename.endsWith("~")
  );
}

function assertNoCaseFoldCollisions(
  files: readonly AssetPackageFileStat[],
): void {
  if (!CASE_FOLDING_PLATFORM) return;
  const seen = new Map<string, string>();
  for (const file of files) {
    const folded = file.relativePath.toLowerCase();
    const prior = seen.get(folded);
    if (prior && prior !== file.relativePath) {
      throw new Error(
        `Asset package paths collide on a case-folding platform: ${prior}, ${file.relativePath}`,
      );
    }
    seen.set(folded, file.relativePath);
  }
}

async function hashSnapshotFiles(
  targetDir: string,
  sourceFiles: readonly AssetPackageFileStat[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const file of sourceFiles) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(await readFile(join(targetDir, file.relativePath)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function totalBytes(files: readonly AssetPackageFile[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

function compareRelativePath(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function publicPackageFile(file: AssetPackageFile): AssetPackageFile {
  return {
    relativePath: file.relativePath,
    absolutePath: file.absolutePath,
    size: file.size,
  };
}
