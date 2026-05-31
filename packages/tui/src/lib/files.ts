/**
 * Workspace file index for the `@file` mention picker.
 *
 * Indexes once on first request (lazy), then caches in memory; the InputBox
 * calls refresh() opportunistically (e.g. after a run completes, since the
 * agent may have written new files). 5k entries is plenty for any sane repo
 * and keeps `filter()` synchronous and snappy.
 *
 * We don't shell out to `git ls-files` — that would miss untracked files the
 * user just created, and not every workspace is a git repo. Native walk is
 * fast enough at this scale.
 */

import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";

export interface IndexedFile {
  /** Path relative to workspace root, posix-style. */
  path: string;
  /** Last modified ms — used as a weak recency signal in ranking. */
  mtimeMs: number;
}

const MAX_FILES = 5000;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".sparkwright",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

export class FileIndex {
  private files: IndexedFile[] = [];
  private indexing: Promise<void> | null = null;
  private lastIndexedAt = 0;

  constructor(private workspaceRoot: string) {}

  /**
   * Build (or rebuild) the index. Coalesces concurrent callers onto a single
   * walk. Safe to call frequently — repeated calls within MIN_REFRESH_MS are
   * no-ops, so a happy-path "refresh after every run" doesn't re-walk
   * a 5k-file tree five times during a chatty session.
   */
  async ensure(force = false): Promise<void> {
    const MIN_REFRESH_MS = 10_000;
    if (
      !force &&
      this.files.length > 0 &&
      Date.now() - this.lastIndexedAt < MIN_REFRESH_MS
    ) {
      return;
    }
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      const collected: IndexedFile[] = [];
      try {
        await walk(this.workspaceRoot, this.workspaceRoot, collected);
      } catch {
        // Permission errors etc. — best-effort.
      }
      collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
      this.files = collected.slice(0, MAX_FILES);
      this.lastIndexedAt = Date.now();
      this.indexing = null;
    })();
    return this.indexing;
  }

  /**
   * Synchronous filter for the picker. Ranking, in order:
   *   0 — basename starts with query
   *   1 — path starts with query
   *   2 — basename contains query
   *   3 — path contains query
   * Within the same match bucket, files are ordered by frecency (if a
   * `frecency` score map is supplied), then by mtime as a fallback. With no
   * query, results are the top files by frecency, then recent.
   */
  filter(
    query: string,
    limit = 10,
    frecency?: Map<string, number>,
  ): IndexedFile[] {
    const fr = (path: string): number => frecency?.get(path) ?? 0;
    const tie = (a: IndexedFile, b: IndexedFile): number => {
      const fa = fr(a.path);
      const fb = fr(b.path);
      if (fa !== fb) return fb - fa;
      return b.mtimeMs - a.mtimeMs;
    };

    const q = query.trim().toLowerCase();
    if (!q) {
      return [...this.files].sort(tie).slice(0, limit);
    }
    const scored: Array<{ f: IndexedFile; score: number }> = [];
    for (const f of this.files) {
      const path = f.path.toLowerCase();
      const base = basename(path);
      let score = -1;
      if (base.startsWith(q)) score = 0;
      else if (path.startsWith(q)) score = 1;
      else if (base.includes(q)) score = 2;
      else if (path.includes(q)) score = 3;
      if (score >= 0) scored.push({ f, score });
    }
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return tie(a.f, b.f);
    });
    return scored.slice(0, limit).map((s) => s.f);
  }

  size(): number {
    return this.files.length;
  }
}

async function walk(
  root: string,
  dir: string,
  out: IndexedFile[],
): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, {
      withFileTypes: true,
      encoding: "utf8",
    })) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") && entry.name !== ".env.example") {
      // Skip dotfiles and dotdirs by default; users rarely @-reference them
      // and they pollute results. Toggleable later if anyone asks.
      if (entry.isDirectory()) continue;
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const full = join(dir, entry.name);
    try {
      const s = await stat(full);
      out.push({
        path: relative(root, full).split("\\").join("/"),
        mtimeMs: s.mtimeMs,
      });
    } catch {
      // Skip unreadable files.
    }
  }
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}
