import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "./event-type.js";

/**
 * Read a past session's committed event log from disk.
 *
 * The host persists every run event as one JSON object per line in
 * `<sessionRoot>/<id>/trace.jsonl`. Each line is the same
 * shape the host streams over `run.event` (`{ id, runId, type, sequence,
 * payload, … }`), so the lines can be replayed straight into the EventStore to
 * reconstruct a session's transcript when the user switches to it.
 *
 * Returns `[]` when the session has no trace yet or the file can't be read —
 * switching to a fresh/empty session should show an empty transcript, not throw.
 */
export async function loadSessionEvents(
  sessionRootDir: string,
  sessionId: string,
): Promise<RunEvent[]> {
  const path = join(sessionRootDir, sessionId, "trace.jsonl");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const events: RunEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as RunEvent);
    } catch {
      // A torn final line (process killed mid-append) shouldn't blank the
      // whole transcript — skip it and keep the rest.
    }
  }
  return events;
}
