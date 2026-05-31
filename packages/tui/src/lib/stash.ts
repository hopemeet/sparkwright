/**
 * Persisted prompt drafts. Unlike history (which is appended on submit), the
 * stash captures the *unsubmitted* in-progress draft so the user gets it
 * back after a crash, accidental ctrl+c, or even a graceful quit.
 *
 * Two surfaces:
 *  - "current draft" — the latest in-flight text. One slot. Saved on a
 *    debounce as the user types (above MIN_CHARS). Loaded on InputBox mount
 *    and offered as initial value when the input would otherwise be empty.
 *  - "stash list" — N most recently stashed drafts (snapshot whenever the
 *    current draft is overwritten / cleared). `/stash` browses it.
 *
 * Stored at `<workspace>/.sparkwright/tui-stash.json`:
 *   { current: { text, ts } | null, list: [{ text, ts }, ...] }
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_LIST = 20;
export const MIN_DRAFT_CHARS = 20;

export interface DraftEntry {
  text: string;
  ts: number;
}

export interface StashFile {
  current: DraftEntry | null;
  list: DraftEntry[];
}

function fileFor(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "tui-stash.json");
}

export async function loadStash(workspaceRoot: string): Promise<StashFile> {
  try {
    const body = await readFile(fileFor(workspaceRoot), "utf8");
    const parsed = JSON.parse(body) as Partial<StashFile>;
    const current = sanitizeEntry(parsed.current);
    const list = Array.isArray(parsed.list)
      ? (parsed.list.map(sanitizeEntry).filter(Boolean) as DraftEntry[]).slice(
          -MAX_LIST,
        )
      : [];
    return { current, list };
  } catch {
    return { current: null, list: [] };
  }
}

/**
 * Write the current draft. If `text` is empty / shorter than MIN_DRAFT_CHARS,
 * snapshots the previous current into `list` (if any) and clears current.
 * Returns the new stash state for in-memory mirroring.
 */
export async function saveDraft(
  workspaceRoot: string,
  text: string,
  prev: StashFile,
): Promise<StashFile> {
  const next: StashFile = { current: prev.current, list: prev.list };
  if (text.length >= MIN_DRAFT_CHARS) {
    next.current = { text, ts: Date.now() };
  } else if (prev.current && prev.current.text !== text) {
    // Draft shrank below threshold or was cleared; archive the previous one
    // unless it's already the most recent list entry.
    const last = prev.list[prev.list.length - 1];
    if (!last || last.text !== prev.current.text) {
      next.list = [...prev.list, prev.current].slice(-MAX_LIST);
    }
    next.current = null;
  }
  await persist(workspaceRoot, next);
  return next;
}

/**
 * Called on submit to clear the current draft (the submitted text moved to
 * history). Returns the new state.
 */
export async function clearDraftOnSubmit(
  workspaceRoot: string,
  prev: StashFile,
): Promise<StashFile> {
  if (!prev.current) return prev;
  const next: StashFile = { current: null, list: prev.list };
  await persist(workspaceRoot, next);
  return next;
}

async function persist(workspaceRoot: string, state: StashFile): Promise<void> {
  const file = fileFor(workspaceRoot);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort.
  }
}

function sanitizeEntry(raw: unknown): DraftEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { text?: unknown; ts?: unknown };
  if (typeof r.text !== "string" || r.text.length === 0) return null;
  const ts = typeof r.ts === "number" ? r.ts : Date.now();
  return { text: r.text, ts };
}
