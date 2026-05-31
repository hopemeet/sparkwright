// AI maintenance note: Optional file-backed MemoryStore. Core intentionally
// ships only the protocol; this package is the local-agent reference
// implementation with production-oriented guardrails: frozen snapshots, char
// budgets, content-policy scan, external-drift detection, lock directory, and
// atomic replace writes.

import {
  constants,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertSafePathSegment,
  createDefaultContentPolicy,
  redactSensitiveText,
  type ContentPolicy,
  type MemoryEntry,
  type MemoryStore,
} from "@sparkwright/core";

const FORMAT_HEADER = "<!-- sparkwright-memory-store:v0.1 -->";
const DEFAULT_MEMORY_LIMIT = 2_200;
const DEFAULT_USER_LIMIT = 1_375;

export interface FileMemoryStoreOptions {
  /** Directory containing MEMORY.md / USER.md. */
  dir: string;
  /** Optional filename map. Defaults to MEMORY.md and USER.md. */
  files?: Partial<Record<string, string>>;
  /** Character limits by kind. Defaults: memory=2200, user=1375. */
  charLimits?: Partial<Record<string, number>>;
  /** Content policy applied before writes. */
  policy?: ContentPolicy;
  /** Redact common secrets before persistence. Default true. */
  redactSecrets?: boolean;
  /** Lock acquisition timeout. Default 2000ms. */
  lockWaitMs?: number;
}

export class MemoryFileDriftError extends Error {
  readonly path: string;
  readonly backupPath: string;

  constructor(path: string, backupPath: string) {
    super(
      `Memory file changed outside FileMemoryStore: ${path}. A backup was saved at ${backupPath}.`,
    );
    this.name = "MemoryFileDriftError";
    this.path = path;
    this.backupPath = backupPath;
  }
}

export class MemoryFilePolicyError extends Error {
  readonly ruleIds: string[];

  constructor(ruleIds: string[]) {
    super(`Memory write blocked by content policy: ${ruleIds.join(", ")}`);
    this.name = "MemoryFilePolicyError";
    this.ruleIds = ruleIds;
  }
}

export class MemoryFileLimitError extends Error {
  constructor(kind: string, limit: number) {
    super(`Memory file '${kind}' exceeds ${limit} characters.`);
    this.name = "MemoryFileLimitError";
  }
}

export class FileMemoryStore implements MemoryStore {
  private readonly dir: string;
  private readonly files: Record<string, string>;
  private readonly charLimits: Record<string, number>;
  private readonly policy: ContentPolicy;
  private readonly redactSecrets: boolean;
  private readonly lockWaitMs: number;
  private readonly sessionSnapshots = new Map<string, string>();

  constructor(options: FileMemoryStoreOptions) {
    this.dir = resolve(options.dir);
    this.files = {
      memory: "MEMORY.md",
      user: "USER.md",
      ...(options.files ?? {}),
    };
    validateFileMap(this.files);
    this.charLimits = {
      memory: DEFAULT_MEMORY_LIMIT,
      user: DEFAULT_USER_LIMIT,
      ...(options.charLimits ?? {}),
    };
    this.policy = options.policy ?? createDefaultContentPolicy();
    this.redactSecrets = options.redactSecrets ?? true;
    this.lockWaitMs = options.lockWaitMs ?? 2_000;
  }

  async remember(
    entry: Omit<MemoryEntry, "id" | "createdAt">,
  ): Promise<MemoryEntry> {
    const kind = this.kindFor(entry.tags);
    const path = this.pathFor(kind);
    const value = this.normalizeValue(entry.value);
    const verdict = this.policy.evaluate(value, "memory_write");
    if (!verdict.allowed) {
      throw new MemoryFilePolicyError(verdict.blocks.map((b) => b.ruleId));
    }

    return this.withLock(path, async () => {
      const entries = await this.readCanonicalEntries(path);
      const next: MemoryEntry = {
        id: createMemoryId(),
        key: entry.key,
        value: this.redactSecrets ? redactSensitiveText(value) : value,
        createdAt: new Date().toISOString(),
        tags: normalizeTags([kind, ...(entry.tags ?? [])]),
      };
      const updated = [...entries, next];
      await this.writeEntries(path, kind, updated);
      return next;
    });
  }

  async recall(query: {
    key?: string;
    tags?: string[];
    limit?: number;
  }): Promise<MemoryEntry[]> {
    const kinds = query.tags?.length
      ? uniqueKinds(query.tags, this.files)
      : [...Object.keys(this.files)];
    const all = (
      await Promise.all(
        kinds.map((kind) => this.readEntries(this.pathFor(kind))),
      )
    ).flat();
    const tags = query.tags ?? [];
    return all
      .filter((entry) => !query.key || entry.key === query.key)
      .filter((entry) => tags.every((tag) => (entry.tags ?? []).includes(tag)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, query.limit ?? all.length);
  }

  async forget(id: string): Promise<void> {
    for (const kind of Object.keys(this.files)) {
      const path = this.pathFor(kind);
      await this.withLock(path, async () => {
        const entries = await this.readCanonicalEntries(path);
        const updated = entries.filter((entry) => entry.id !== id);
        if (updated.length !== entries.length) {
          await this.writeEntries(path, kind, updated);
        }
      });
    }
  }

  async snapshotForSystemPrompt(kind = "memory"): Promise<string> {
    const existing = this.sessionSnapshots.get(kind);
    if (existing !== undefined) return existing;
    const text = await readTextIfExists(this.pathFor(kind));
    const snapshot = renderSnapshot(parseEntries(text));
    this.sessionSnapshots.set(kind, snapshot);
    return snapshot;
  }

  clearSessionSnapshots(): void {
    this.sessionSnapshots.clear();
  }

  /**
   * Invalidate the cached snapshot for a single kind so the next
   * {@link snapshotForSystemPrompt} call re-reads from disk.
   *
   * Snapshots are intentionally session-stable to preserve prompt-cache
   * hit rate. Callers that need fresh memory inside the same session (e.g.
   * after a `remember()` whose value the next turn must see) should invoke
   * this manually rather than rely on automatic invalidation.
   */
  invalidateSnapshot(kind = "memory"): void {
    this.sessionSnapshots.delete(kind);
  }

  private kindFor(tags: string[] | undefined): string {
    for (const tag of tags ?? []) {
      if (this.files[tag]) return tag;
    }
    return "memory";
  }

  private pathFor(kind: string): string {
    return join(this.dir, this.files[kind] ?? `${kind.toUpperCase()}.md`);
  }

  private normalizeValue(value: unknown): string {
    if (typeof value === "string") return value.trim();
    return JSON.stringify(value, null, 2);
  }

  private async readEntries(path: string): Promise<MemoryEntry[]> {
    return parseEntries(await readTextIfExists(path));
  }

  private async readCanonicalEntries(path: string): Promise<MemoryEntry[]> {
    const raw = await readTextIfExists(path);
    const entries = parseEntries(raw);
    const canonical = formatEntries(entries);
    if (raw.trim() !== "" && raw !== canonical) {
      const backup = `${path}.bak.${Date.now()}`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(backup, raw, "utf8");
      throw new MemoryFileDriftError(path, backup);
    }
    return entries;
  }

  private async writeEntries(
    path: string,
    kind: string,
    entries: readonly MemoryEntry[],
  ): Promise<void> {
    const body = formatEntries(entries);
    const limit = this.charLimits[kind] ?? DEFAULT_MEMORY_LIMIT;
    if (body.length > limit) throw new MemoryFileLimitError(kind, limit);
    await atomicWrite(path, body);
  }

  private async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const release = await acquireLock(`${path}.lock`, this.lockWaitMs);
    try {
      await mkdir(dirname(path), { recursive: true });
      return await fn();
    } finally {
      await release();
    }
  }
}

function validateFileMap(files: Record<string, string>): void {
  for (const [kind, file] of Object.entries(files)) {
    assertSafePathSegment(kind, "memory kind");
    assertSafePathSegment(file, `memory file for '${kind}'`);
  }
}

function formatEntries(entries: readonly MemoryEntry[]): string {
  const lines = [FORMAT_HEADER, ""];
  for (const entry of entries) {
    const tags = (entry.tags ?? []).join(",");
    lines.push(
      `<!-- entry id="${escapeAttr(entry.id)}" key="${escapeAttr(entry.key)}" createdAt="${escapeAttr(entry.createdAt)}" tags="${escapeAttr(tags)}" -->`,
      String(entry.value).trim(),
      "<!-- /entry -->",
      "",
    );
  }
  return lines.join("\n");
}

function parseEntries(raw: string): MemoryEntry[] {
  if (raw.trim() === "") return [];
  const entries: MemoryEntry[] = [];
  const re =
    /<!-- entry id="([^"]+)" key="([^"]+)" createdAt="([^"]+)" tags="([^"]*)" -->\n([\s\S]*?)\n<!-- \/entry -->/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    entries.push({
      id: unescapeAttr(match[1]!),
      key: unescapeAttr(match[2]!),
      createdAt: unescapeAttr(match[3]!),
      tags: match[4] ? unescapeAttr(match[4]).split(",").filter(Boolean) : [],
      value: match[5]!.trim(),
    });
  }
  return entries;
}

function renderSnapshot(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return "";
  return entries
    .map((entry) => `- ${entry.key}: ${String(entry.value).trim()}`)
    .join("\n");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function uniqueKinds(
  tags: readonly string[],
  files: Record<string, string>,
): string[] {
  const kinds = tags.filter((tag) => Boolean(files[tag]));
  return kinds.length > 0 ? normalizeTags(kinds) : Object.keys(files);
}

function createMemoryId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return "";
    throw cause;
  }
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Random suffix avoids EEXIST when two writers hit the same millisecond
  // and avoids being blocked by a stale `.tmp` left over from a crash.
  const suffix = `${Date.now()}.${randomBytes(6).toString("hex")}`;
  const tmp = join(dirname(path), `.${basename(path)}.${suffix}.tmp`);
  const handle = await open(
    tmp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  let closed = false;
  try {
    await handle.writeFile(text, "utf8");
    await handle.close();
    closed = true;
    await rename(tmp, path);
  } catch (cause) {
    if (!closed) {
      try {
        await handle.close();
      } catch {
        // already closed
      }
    }
    await rm(tmp, { force: true });
    throw cause;
  }
}

async function acquireLock(
  lockPath: string,
  waitMs: number,
): Promise<() => Promise<void>> {
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockPath, { recursive: false });
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (cause) {
      if (!isErrno(cause, "EEXIST")) throw cause;
      if (Date.now() - started >= waitMs) {
        throw new Error(`Timed out acquiring memory lock: ${lockPath}`);
      }
      await sleep(25);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrno(cause: unknown, code: string): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === code
  );
}
