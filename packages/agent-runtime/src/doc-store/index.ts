// AI maintenance note: shared file-backed document-store primitives. Keep this
// module free of workflow/task semantics so session-root stores can compose it.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import {
  atomicWriteText as atomicWriteTextCore,
  atomicWriteTextSync as atomicWriteTextSyncCore,
} from "@sparkwright/core/internal";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import process from "node:process";
import { basename, dirname, extname, join, resolve } from "node:path";

/**
 * Atomic document write options shared by snapshot stores.
 *
 * @public
 * @stability experimental v0.1
 */
export interface AtomicDocumentWriteOptions {
  /** File mode used when creating the temporary file. */
  mode?: number;
  /** fsync the temporary file before rename, then best-effort fsync the dir. */
  durable?: boolean;
  /** Number of rename attempts for transient Windows EPERM/EACCES failures. */
  renameAttempts?: number;
  /** Base delay for retry backoff in milliseconds. */
  renameRetryDelayMs?: number;
}

/**
 * A corrupt or invalid JSON document entry skipped during a directory scan.
 *
 * @public
 * @stability experimental v0.1
 */
export interface JsonDocumentInvalidEntry {
  /** Absolute path to the skipped entry. */
  path: string;
  /** Stable diagnostic family. */
  code: "read_failed" | "invalid_json" | "invalid_document";
  /** Human-readable cause. */
  reason: string;
}

/**
 * One parsed JSONL append-log entry.
 *
 * @public
 * @stability experimental v0.1
 */
export interface JsonDocumentLogEntry<T> {
  /** Zero-based sequence within the log file. */
  sequence: number;
  /** One-based line number in the log file. */
  line: number;
  /** Absolute file path for diagnostics and evidence refs. */
  path: string;
  /** Parsed and optionally validated value. */
  value: T;
}

/**
 * A corrupt or invalid JSONL append-log row skipped during a log scan.
 *
 * @public
 * @stability experimental v0.1
 */
export interface JsonDocumentLogInvalidEntry extends JsonDocumentInvalidEntry {
  /** One-based line number in the log file. */
  line: number;
}

/**
 * One parsed JSON document entry from a file-backed document directory.
 *
 * @public
 * @stability experimental v0.1
 */
export interface JsonDocumentEntry<T> {
  /** Entry id derived from the filename unless overridden. */
  id: string;
  /** Absolute file path for diagnostics and evidence refs. */
  path: string;
  /** Parsed and optionally validated value. */
  value: T;
}

/**
 * Options for scanning a directory of JSON document files.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ReadJsonDocumentDirOptions<T> {
  /** Directory to scan. Missing directories return an empty result. */
  dir: string;
  /** File extension to include. Defaults to `.json`. */
  extension?: string;
  /** Parse/validate hook. Throw to skip with an invalid-document diagnostic. */
  parse?: (raw: unknown, context: { id: string; path: string }) => T;
  /** Override entry id derivation. Return undefined to skip without a diagnostic. */
  idFromFileName?: (fileName: string) => string | undefined;
}

/**
 * Result from a corrupt-entry-tolerant JSON document directory scan.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ReadJsonDocumentDirResult<T> {
  entries: Array<JsonDocumentEntry<T>>;
  invalidEntries: JsonDocumentInvalidEntry[];
}

/**
 * Options for reading a JSONL append log.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ReadJsonDocumentLogOptions<T> {
  /** JSONL log file path. Missing files return an empty result. */
  path: string;
  /** Parse/validate hook. Throw to skip with an invalid-document diagnostic. */
  parse?: (
    raw: unknown,
    context: { sequence: number; line: number; path: string },
  ) => T;
}

/**
 * Result from a corrupt-entry-tolerant JSONL append-log scan.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ReadJsonDocumentLogResult<T> {
  entries: Array<JsonDocumentLogEntry<T>>;
  invalidEntries: JsonDocumentLogInvalidEntry[];
}

/**
 * Options for appending to a JSONL document log.
 *
 * @public
 * @stability experimental v0.1
 */
export interface AppendJsonDocumentLogOptions {
  /** File mode used when creating the log file. */
  mode?: number;
  /** fsync the log file after append, then best-effort fsync the dir. */
  durable?: boolean;
}

/**
 * Durable single-writer lease state persisted as JSON.
 *
 * @public
 * @stability experimental v0.1
 */
export interface FileDocumentLeaseRecord {
  schemaVersion: "sparkwright-doc-lease.v1";
  token: string;
  owner: string;
  acquiredAt: string;
  ttlMs?: number;
  expiresAt?: string;
}

/**
 * Options for acquiring a file-backed document lease.
 *
 * @public
 * @stability experimental v0.1
 */
export interface AcquireFileDocumentLeaseOptions {
  /** Absolute or relative path to the lease directory. */
  path: string;
  /** Human-readable owner for diagnostics. */
  owner?: string;
  /** Optional lease TTL. Expired leases may be stolen by a new writer. */
  ttlMs?: number;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

/**
 * Handle returned by a successful single-writer lease acquisition.
 *
 * @public
 * @stability experimental v0.1
 */
export interface FileDocumentLease {
  path: string;
  token: string;
  owner: string;
  record(): FileDocumentLeaseRecord;
  refresh(ttlMs?: number): Promise<boolean>;
  release(): Promise<boolean>;
}

export async function atomicWriteText(
  path: string,
  content: string,
  options: AtomicDocumentWriteOptions = {},
): Promise<void> {
  await atomicWriteTextCore(path, content, options);
}

/**
 * Durably publishes a new immutable document without replacing an existing
 * entry. Returns false when another writer already published the path.
 */
export async function publishExclusiveJsonDocument(
  path: string,
  value: unknown,
  options: Pick<AtomicDocumentWriteOptions, "mode" | "durable"> = {},
): Promise<boolean> {
  const target = resolve(path);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  let handle;
  try {
    handle = await open(target, "wx", options.mode ?? 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (options.durable !== false) await handle.sync();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
    await rm(target, { force: true }).catch(() => undefined);
    throw cause;
  } finally {
    await handle?.close();
  }
  if (options.durable !== false) await syncDirectoryBestEffort(dir);
  return true;
}

export function atomicWriteTextSync(
  path: string,
  content: string,
  options: AtomicDocumentWriteOptions = {},
): void {
  atomicWriteTextSyncCore(path, content, options);
}

export async function writeJsonDocument(
  path: string,
  value: unknown,
  options: AtomicDocumentWriteOptions = {},
): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function writeJsonDocumentSync(
  path: string,
  value: unknown,
  options: AtomicDocumentWriteOptions = {},
): void {
  atomicWriteTextSync(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function appendJsonDocumentLog(
  path: string,
  value: unknown,
  options: AppendJsonDocumentLogOptions = {},
): Promise<void> {
  const target = resolve(path);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const line = `${JSON.stringify(value)}\n`;
  if (options.durable) {
    const handle = await open(target, "a", options.mode);
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectoryBestEffort(dir);
    return;
  }
  if (options.mode !== undefined) {
    await appendFile(target, line, { encoding: "utf8", mode: options.mode });
  } else {
    await appendFile(target, line, "utf8");
  }
}

export function appendJsonDocumentLogSync(
  path: string,
  value: unknown,
  options: AppendJsonDocumentLogOptions = {},
): void {
  const target = resolve(path);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const line = `${JSON.stringify(value)}\n`;
  let fd: number | undefined;
  if (options.durable) {
    try {
      fd = openSync(target, "a", options.mode);
      writeFileSync(fd, line, "utf8");
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    syncDirectoryBestEffortSync(dir);
    return;
  }
  if (options.mode !== undefined) {
    appendFileSync(target, line, { encoding: "utf8", mode: options.mode });
  } else {
    appendFileSync(target, line, "utf8");
  }
}

export async function readJsonDocumentLog<T = unknown>(
  options: ReadJsonDocumentLogOptions<T>,
): Promise<ReadJsonDocumentLogResult<T>> {
  const path = resolve(options.path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], invalidEntries: [] };
    }
    throw cause;
  }
  return parseJsonDocumentLog(text, path, options.parse);
}

export function readJsonDocumentLogSync<T = unknown>(
  options: ReadJsonDocumentLogOptions<T>,
): ReadJsonDocumentLogResult<T> {
  const path = resolve(options.path);
  if (!existsSync(path)) return { entries: [], invalidEntries: [] };
  return parseJsonDocumentLog(readFileSync(path, "utf8"), path, options.parse);
}

function parseJsonDocumentLog<T>(
  text: string,
  path: string,
  parse?: (
    raw: unknown,
    context: { sequence: number; line: number; path: string },
  ) => T,
): ReadJsonDocumentLogResult<T> {
  const result: ReadJsonDocumentLogResult<T> = {
    entries: [],
    invalidEntries: [],
  };
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    if (rawLine.trim().length === 0) continue;
    const line = index + 1;
    const sequence = result.entries.length;
    let raw: unknown;
    try {
      raw = JSON.parse(rawLine) as unknown;
    } catch (cause) {
      result.invalidEntries.push({
        ...jsonDocumentInvalidEntry(path, cause, "invalid_json"),
        line,
      });
      continue;
    }
    try {
      const value = parse ? parse(raw, { sequence, line, path }) : (raw as T);
      result.entries.push({ sequence, line, path, value });
    } catch (cause) {
      result.invalidEntries.push({
        ...jsonDocumentInvalidEntry(path, cause, "invalid_document"),
        line,
      });
    }
  }
  return result;
}

export async function readJsonDocumentDir<T = unknown>(
  options: ReadJsonDocumentDirOptions<T>,
): Promise<ReadJsonDocumentDirResult<T>> {
  const dir = resolve(options.dir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], invalidEntries: [] };
    }
    throw cause;
  }
  const result: ReadJsonDocumentDirResult<T> = {
    entries: [],
    invalidEntries: [],
  };
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile() || isTemporaryDocumentFile(entry.name)) continue;
    const id = jsonDocumentEntryId(entry.name, options);
    if (id === undefined) continue;
    const path = join(dir, entry.name);
    try {
      let rawText: string;
      try {
        rawText = await readFile(path, "utf8");
      } catch (cause) {
        result.invalidEntries.push(jsonDocumentReadFailedEntry(path, cause));
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(rawText) as unknown;
      } catch (cause) {
        result.invalidEntries.push(
          jsonDocumentInvalidEntry(path, cause, "invalid_json"),
        );
        continue;
      }
      const value = options.parse
        ? options.parse(raw, { id, path })
        : (raw as T);
      result.entries.push({ id, path, value });
    } catch (cause) {
      result.invalidEntries.push(
        jsonDocumentInvalidEntry(path, cause, "invalid_document"),
      );
    }
  }
  return result;
}

export function readJsonDocumentDirSync<T = unknown>(
  options: ReadJsonDocumentDirOptions<T>,
): ReadJsonDocumentDirResult<T> {
  const dir = resolve(options.dir);
  if (!existsSync(dir)) return { entries: [], invalidEntries: [] };
  const result: ReadJsonDocumentDirResult<T> = {
    entries: [],
    invalidEntries: [],
  };
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile() || isTemporaryDocumentFile(entry.name)) continue;
    const id = jsonDocumentEntryId(entry.name, options);
    if (id === undefined) continue;
    const path = join(dir, entry.name);
    try {
      let rawText: string;
      try {
        rawText = readFileSync(path, "utf8");
      } catch (cause) {
        result.invalidEntries.push(jsonDocumentReadFailedEntry(path, cause));
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(rawText) as unknown;
      } catch (cause) {
        result.invalidEntries.push(
          jsonDocumentInvalidEntry(path, cause, "invalid_json"),
        );
        continue;
      }
      const value = options.parse
        ? options.parse(raw, { id, path })
        : (raw as T);
      result.entries.push({ id, path, value });
    } catch (cause) {
      result.invalidEntries.push(
        jsonDocumentInvalidEntry(path, cause, "invalid_document"),
      );
    }
  }
  return result;
}

export async function acquireFileDocumentLease(
  options: AcquireFileDocumentLeaseOptions,
): Promise<FileDocumentLease | null> {
  const leaseDir = resolve(options.path);
  const now = options.now ?? (() => new Date());
  const owner = options.owner ?? `${hostname()}:${process.pid}`;
  const token = randomUUID();
  await mkdir(leaseDir, { recursive: true });

  if (!(await removeExpiredLeaseEntries(leaseDir, now))) {
    return null;
  }
  if ((await readActiveLeaseEntries(leaseDir, now)).length > 0) {
    return null;
  }

  const record = makeLeaseRecord({ owner, token, ttlMs: options.ttlMs, now });
  const entryPath = leaseEntryPath(leaseDir, token);
  const acquired = await tryWriteNewLease(entryPath, record);
  if (!acquired) return null;
  await syncDirectoryBestEffort(leaseDir);

  if (!(await removeExpiredLeaseEntries(leaseDir, now))) {
    await rm(entryPath, { force: true });
    await syncDirectoryBestEffort(leaseDir);
    return null;
  }
  const winner = selectLeaseWinner(await readActiveLeaseEntries(leaseDir, now));
  if (!winner || winner.record.token !== token) {
    await rm(entryPath, { force: true });
    await syncDirectoryBestEffort(leaseDir);
    return null;
  }

  return createLeaseHandle(leaseDir, entryPath, record, now);
}

async function tryWriteNewLease(
  path: string,
  record: FileDocumentLeaseRecord,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw cause;
  } finally {
    await handle?.close();
  }
}

function createLeaseHandle(
  leaseDir: string,
  entryPath: string,
  initialRecord: FileDocumentLeaseRecord,
  now: () => Date,
): FileDocumentLease {
  let current = initialRecord;
  return {
    path: leaseDir,
    token: initialRecord.token,
    owner: initialRecord.owner,
    record: () => ({ ...current }),
    refresh: async (ttlMs?: number) => {
      const onDisk = await readLeaseRecord(entryPath);
      if (!onDisk || onDisk.token !== current.token) return false;
      if (leaseExpired(onDisk, now)) return false;
      const winner = selectLeaseWinner(
        await readActiveLeaseEntries(leaseDir, now),
      );
      if (!winner || winner.record.token !== current.token) return false;
      const nextTtlMs = ttlMs ?? current.ttlMs;
      current = makeLeaseRecord({
        owner: current.owner,
        token: current.token,
        ttlMs: nextTtlMs,
        now,
      });
      await writeJsonDocument(entryPath, current, {
        mode: 0o600,
        durable: true,
      });
      return true;
    },
    release: async () => {
      const onDisk = await readLeaseRecord(entryPath);
      if (!onDisk || onDisk.token !== current.token) return false;
      await rm(entryPath, { force: true });
      await syncDirectoryBestEffort(leaseDir);
      return true;
    },
  };
}

async function removeExpiredLeaseEntries(
  leaseDir: string,
  now: () => Date,
): Promise<boolean> {
  const scan = await readJsonDocumentDir<FileDocumentLeaseRecord>({
    dir: leaseDir,
    parse: parseLeaseRecord,
  });
  let removed = false;
  for (const invalid of scan.invalidEntries) {
    if (await staleByMtime(invalid.path, now)) {
      await rm(invalid.path, { force: true });
      removed = true;
      continue;
    }
    return false;
  }
  for (const entry of scan.entries) {
    if (!leaseExpired(entry.value, now)) continue;
    await rm(entry.path, { force: true });
    removed = true;
  }
  if (removed) {
    await syncDirectoryBestEffort(leaseDir);
  }
  return true;
}

async function readActiveLeaseEntries(
  leaseDir: string,
  now: () => Date,
): Promise<LeaseEntry[]> {
  const scan = await readJsonDocumentDir<FileDocumentLeaseRecord>({
    dir: leaseDir,
    parse: parseLeaseRecord,
  });
  return scan.entries
    .filter((entry) => !leaseExpired(entry.value, now))
    .map((entry) => ({ path: entry.path, record: entry.value }));
}

async function readLeaseRecord(
  path: string,
): Promise<FileDocumentLeaseRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parseLeaseRecord(raw);
  } catch {
    return undefined;
  }
}

function makeLeaseRecord(input: {
  owner: string;
  token: string;
  ttlMs?: number;
  now: () => Date;
}): FileDocumentLeaseRecord {
  const acquiredAt = input.now();
  return {
    schemaVersion: "sparkwright-doc-lease.v1",
    token: input.token,
    owner: input.owner,
    acquiredAt: acquiredAt.toISOString(),
    ...(input.ttlMs !== undefined
      ? {
          ttlMs: input.ttlMs,
          expiresAt: new Date(acquiredAt.getTime() + input.ttlMs).toISOString(),
        }
      : {}),
  };
}

interface LeaseEntry {
  path: string;
  record: FileDocumentLeaseRecord;
}

function parseLeaseRecord(raw: unknown): FileDocumentLeaseRecord {
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { schemaVersion?: unknown }).schemaVersion !==
      "sparkwright-doc-lease.v1" ||
    typeof (raw as { token?: unknown }).token !== "string" ||
    typeof (raw as { owner?: unknown }).owner !== "string" ||
    typeof (raw as { acquiredAt?: unknown }).acquiredAt !== "string"
  ) {
    throw new Error("lease record must be a sparkwright-doc-lease.v1 object");
  }
  const ttlMs = (raw as { ttlMs?: unknown }).ttlMs;
  const expiresAt = (raw as { expiresAt?: unknown }).expiresAt;
  return {
    schemaVersion: "sparkwright-doc-lease.v1",
    token: (raw as { token: string }).token,
    owner: (raw as { owner: string }).owner,
    acquiredAt: (raw as { acquiredAt: string }).acquiredAt,
    ...(typeof ttlMs === "number" ? { ttlMs } : {}),
    ...(typeof expiresAt === "string" ? { expiresAt } : {}),
  };
}

function leaseEntryPath(leaseDir: string, token: string): string {
  return join(leaseDir, `${token}.json`);
}

function leaseExpired(
  record: FileDocumentLeaseRecord,
  now: () => Date,
): boolean {
  return (
    record.expiresAt !== undefined &&
    Date.parse(record.expiresAt) <= now().getTime()
  );
}

function selectLeaseWinner(entries: LeaseEntry[]): LeaseEntry | undefined {
  return [...entries].sort((left, right) => {
    const timeDelta =
      Date.parse(left.record.acquiredAt) - Date.parse(right.record.acquiredAt);
    if (timeDelta !== 0) return timeDelta;
    return left.record.token.localeCompare(right.record.token);
  })[0];
}

async function staleByMtime(path: string, now: () => Date): Promise<boolean> {
  try {
    const stats = await stat(path);
    return now().getTime() - stats.mtimeMs > 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

function jsonDocumentEntryId<T>(
  fileName: string,
  options: ReadJsonDocumentDirOptions<T>,
): string | undefined {
  if (isTemporaryDocumentFile(fileName)) return undefined;
  const extension = options.extension ?? ".json";
  if (extname(fileName) !== extension) return undefined;
  return options.idFromFileName
    ? options.idFromFileName(fileName)
    : basename(fileName, extension);
}

function jsonDocumentInvalidEntry(
  path: string,
  cause: unknown,
  code: JsonDocumentInvalidEntry["code"],
): JsonDocumentInvalidEntry {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return { path, code, reason };
}

function jsonDocumentReadFailedEntry(
  path: string,
  cause: unknown,
): JsonDocumentInvalidEntry {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return { path, code: "read_failed", reason };
}

function isTemporaryDocumentFile(fileName: string): boolean {
  return fileName.startsWith(".tmp-");
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
