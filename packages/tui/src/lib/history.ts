/**
 * Persistent prompt history. One entry per submitted goal, newest-last,
 * deduplicated against the immediate previous entry. Stored at
 * `<workspace>/.sparkwright/tui-history.jsonl`, capped at MAX entries.
 *
 * Lazy: we don't block the UI on load; the InputBox calls loadHistory() on
 * mount and works fine with an empty array until the file resolves.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX = 200;

export interface HistoryEntry {
  ts: number;
  text: string;
}

function fileFor(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "tui-history.jsonl");
}

export async function loadHistory(
  workspaceRoot: string,
): Promise<HistoryEntry[]> {
  try {
    const body = await readFile(fileFor(workspaceRoot), "utf8");
    const out: HistoryEntry[] = [];
    for (const line of body.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as HistoryEntry;
        if (parsed && typeof parsed.text === "string") out.push(parsed);
      } catch {
        // Skip malformed lines silently — history is best-effort.
      }
    }
    return out.slice(-MAX);
  } catch {
    return [];
  }
}

export async function appendHistory(
  workspaceRoot: string,
  text: string,
  existing: HistoryEntry[],
): Promise<HistoryEntry[]> {
  const last = existing[existing.length - 1];
  if (last && last.text === text) return existing;
  const entry: HistoryEntry = { ts: Date.now(), text };
  const next = existing.concat(entry).slice(-MAX);
  const file = fileFor(workspaceRoot);
  try {
    await mkdir(dirname(file), { recursive: true });
    // Rewrite from scratch each time — small files, atomic-ish, avoids
    // unbounded growth without an explicit prune pass.
    const body = next.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(file, body, "utf8");
  } catch {
    // History persistence is best-effort; the in-memory list still updates.
  }
  return next;
}
