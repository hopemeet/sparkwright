/**
 * Per-session human labels stored locally — host protocol doesn't carry these
 * today, so we sidecar them in `<workspace>/.sparkwright/session-labels.json`.
 * When/if the host grows a session.rename method, this module becomes a thin
 * cache and migrating is mechanical.
 *
 * Format on disk:
 *   { "<sessionId>": "<label>", ... }
 *
 * Labels are short free-form strings (cap 80 chars). Empty or whitespace-only
 * labels delete the entry.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_LABEL_LENGTH = 80;

function fileFor(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "session-labels.json");
}

export interface SessionLabels {
  /** Read-only snapshot of the current label map. */
  get(): Record<string, string>;
  /** Get one label, or undefined. */
  getOne(sessionId: string): string | undefined;
  /** Set or clear a label. Empty string clears. Persists immediately. */
  set(sessionId: string, label: string): Promise<void>;
  /** Reload from disk after an external label change. */
  refresh(): Promise<void>;
}

export async function loadSessionLabels(
  workspaceRoot: string,
): Promise<SessionLabels> {
  let map: Record<string, string> = {};
  const file = fileFor(workspaceRoot);

  const refresh = async (): Promise<void> => {
    try {
      const body = await readFile(file, "utf8");
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string" && v.trim().length > 0) {
            next[k] = v.slice(0, MAX_LABEL_LENGTH);
          }
        }
        map = next;
      }
    } catch {
      // Missing or malformed — treat as empty.
      map = {};
    }
  };

  await refresh();

  return {
    get: () => ({ ...map }),
    getOne: (sessionId) => map[sessionId],
    refresh,
    set: async (sessionId, raw) => {
      const label = raw.trim().slice(0, MAX_LABEL_LENGTH);
      const next = { ...map };
      if (label.length === 0) delete next[sessionId];
      else next[sessionId] = label;
      map = next;
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
      } catch {
        // Best-effort; in-memory copy still updated so UI reflects intent.
      }
    },
  };
}
