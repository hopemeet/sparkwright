/**
 * Frecency tracking for the @file picker. "Frecency" = frequency × recency:
 * a file picked often and recently ranks above one picked once long ago.
 *
 * Persisted at `<workspace>/.sparkwright/tui-frecency.json` as
 *   { "<relPath>": { frequency, lastPicked } }
 *
 * The score formula matches the common frecency heuristic:
 *   score = frequency / (1 + daysSinceLastPick)
 * so a file's weight decays smoothly with age but never to exactly zero.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_ENTRIES = 1000;
const MS_PER_DAY = 86_400_000;

interface FrecencyEntry {
  frequency: number;
  lastPicked: number;
}

function fileFor(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "tui-frecency.json");
}

export interface Frecency {
  /** Compute a score for a path; 0 if never picked. */
  score(path: string): number;
  /** Record a pick and persist (best-effort). */
  bump(path: string): Promise<void>;
  /** Snapshot of scores for all known paths (for ranking ties). */
  scores(): Map<string, number>;
}

export async function loadFrecency(workspaceRoot: string): Promise<Frecency> {
  let map: Record<string, FrecencyEntry> = {};
  const file = fileFor(workspaceRoot);
  try {
    const body = await readFile(file, "utf8");
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (
          v &&
          typeof v === "object" &&
          typeof (v as FrecencyEntry).frequency === "number" &&
          typeof (v as FrecencyEntry).lastPicked === "number"
        ) {
          map[k] = v as FrecencyEntry;
        }
      }
    }
  } catch {
    map = {};
  }

  const scoreOf = (entry: FrecencyEntry | undefined): number => {
    if (!entry) return 0;
    const days = (Date.now() - entry.lastPicked) / MS_PER_DAY;
    return entry.frequency / (1 + Math.max(0, days));
  };

  return {
    score: (path) => scoreOf(map[path]),
    scores: () => {
      const out = new Map<string, number>();
      for (const [k, v] of Object.entries(map)) out.set(k, scoreOf(v));
      return out;
    },
    bump: async (path) => {
      const prev = map[path];
      map[path] = {
        frequency: (prev?.frequency ?? 0) + 1,
        lastPicked: Date.now(),
      };
      // Prune the least-frecent entries if we blow the cap.
      const keys = Object.keys(map);
      if (keys.length > MAX_ENTRIES) {
        const ranked = keys
          .map((k) => ({ k, s: scoreOf(map[k]) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, MAX_ENTRIES);
        const kept: Record<string, FrecencyEntry> = {};
        for (const { k } of ranked) kept[k] = map[k];
        map = kept;
      }
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(map, null, 2) + "\n", "utf8");
      } catch {
        // best-effort
      }
    },
  };
}
