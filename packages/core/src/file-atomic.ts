// AI maintenance note: core-level file atomic helpers live below runtime
// packages so core-owned session stores can share the same implementation as
// higher-level doc-store wrappers without depending on those wrappers.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { dirname, join, resolve } from "node:path";

export interface AtomicTextWriteOptions {
  /** File mode used when creating the temporary file. */
  mode?: number;
  /** fsync the temporary file before rename, then best-effort fsync the dir. */
  durable?: boolean;
  /** Number of rename attempts for transient Windows EPERM/EACCES failures. */
  renameAttempts?: number;
  /** Base delay for retry backoff in milliseconds. */
  renameRetryDelayMs?: number;
}

const DEFAULT_RENAME_ATTEMPTS = 10;
const DEFAULT_RENAME_RETRY_DELAY_MS = 20;

export async function atomicWriteText(
  path: string,
  content: string,
  options: AtomicTextWriteOptions = {},
): Promise<void> {
  const target = resolve(path);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = temporaryPath(target);
  try {
    if (options.durable) {
      const handle = await open(tmp, "w", options.mode);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else if (options.mode !== undefined) {
      await writeFile(tmp, content, { encoding: "utf8", mode: options.mode });
    } else {
      await writeFile(tmp, content, "utf8");
    }
    await renameWithRetry(tmp, target, options);
    if (options.durable) {
      await syncDirectoryBestEffort(dir);
    }
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw cause;
  }
}

export function atomicWriteTextSync(
  path: string,
  content: string,
  options: AtomicTextWriteOptions = {},
): void {
  const target = resolve(path);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = temporaryPath(target);
  let fd: number | undefined;
  try {
    if (options.durable) {
      fd = openSync(tmp, "w", options.mode);
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } else if (options.mode !== undefined) {
      writeFileSync(tmp, content, { encoding: "utf8", mode: options.mode });
    } else {
      writeFileSync(tmp, content, "utf8");
    }
    renameWithRetrySync(tmp, target, options);
    if (options.durable) {
      syncDirectoryBestEffortSync(dir);
    }
  } catch (cause) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures while preserving the original write error.
      }
    }
    rmSync(tmp, { force: true });
    throw cause;
  }
}

async function renameWithRetry(
  tmp: string,
  target: string,
  options: AtomicTextWriteOptions,
): Promise<void> {
  let lastError: unknown;
  const attempts = options.renameAttempts ?? DEFAULT_RENAME_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(tmp, target);
      return;
    } catch (cause) {
      lastError = cause;
      if (!isRetryableRenameError(cause)) break;
      await delay(renameDelayMs(attempt, options));
    }
  }
  throw lastError;
}

function renameWithRetrySync(
  tmp: string,
  target: string,
  options: AtomicTextWriteOptions,
): void {
  let lastError: unknown;
  const attempts = options.renameAttempts ?? DEFAULT_RENAME_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(tmp, target);
      return;
    } catch (cause) {
      lastError = cause;
      if (!isRetryableRenameError(cause)) break;
      sleepSync(renameDelayMs(attempt, options));
    }
  }
  throw lastError;
}

function renameDelayMs(
  attempt: number,
  options: AtomicTextWriteOptions,
): number {
  return (
    (options.renameRetryDelayMs ?? DEFAULT_RENAME_RETRY_DELAY_MS) *
    (attempt + 1)
  );
}

function isRetryableRenameError(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EEXIST";
}

function temporaryPath(target: string): string {
  return join(
    dirname(target),
    `.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
}

async function syncDirectoryBestEffort(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not available on every platform/filesystem.
  }
}

function syncDirectoryBestEffortSync(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is not available on every platform/filesystem.
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
