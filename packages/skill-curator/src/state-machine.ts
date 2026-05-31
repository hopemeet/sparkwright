// AI maintenance note: Pure lifecycle state machine. Operates on the
// SkillUsageRecorder — no I/O, no LLM. Intentionally conservative:
//   - never auto-deletes (callers archive explicitly)
//   - never touches pinned skills
//   - never touches non-agent-created skills (those belong to the user)
//
// Recency anchor: max(lastUsedAt, lastPatchedAt, createdAt-by-implication).
// If neither timestamp is present the skill is treated as "just created"
// (active, immune to staleness this cycle).

import type { SkillUsageRecord, SkillUsageRecorder } from "@sparkwright/skills";

/**
 * Options for {@link applyAutomaticTransitions}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface AutomaticTransitionsOptions {
  /** Number of days without use before active → stale. Default: 30. */
  staleAfterDays?: number;
  /** Number of days without use before stale → archived. Default: 90. */
  archiveAfterDays?: number;
  /** Current time, for deterministic tests. */
  now?: Date;
  /**
   * Only auto-transition agent-created records. Default: true. Set false when
   * the recorder is shared with user-created skills the curator must avoid.
   */
  agentCreatedOnly?: boolean;
}

/**
 * Counts returned by {@link applyAutomaticTransitions}, suitable for logging
 * or trace events.
 *
 * @public
 * @stability experimental v0.1
 */
export interface AutomaticTransitionsResult {
  checked: number;
  markedStale: number;
  archived: number;
  reactivated: number;
}

/**
 * Walk every record in the recorder and move active → stale → archived
 * based on activity timestamps. Pinned and (by default) user-authored
 * records are skipped. Returns transition counts.
 *
 * @public
 * @stability experimental v0.1
 */
export function applyAutomaticTransitions(
  recorder: SkillUsageRecorder,
  options: AutomaticTransitionsOptions = {},
): AutomaticTransitionsResult {
  const now = options.now ?? new Date();
  const staleAfter = (options.staleAfterDays ?? 30) * 24 * 60 * 60 * 1000;
  const archiveAfter = (options.archiveAfterDays ?? 90) * 24 * 60 * 60 * 1000;
  const agentOnly = options.agentCreatedOnly ?? true;

  const out: AutomaticTransitionsResult = {
    checked: 0,
    markedStale: 0,
    archived: 0,
    reactivated: 0,
  };

  for (const record of recorder.list()) {
    if (record.pinned) continue;
    if (agentOnly && !record.agentCreated) continue;
    out.checked += 1;

    const anchor = activityAnchor(record);
    if (anchor === undefined) continue; // no timestamps yet — leave alone
    const age = now.getTime() - anchor;

    if (age >= archiveAfter && record.state !== "archived") {
      recorder.setState(record.name, "archived");
      out.archived += 1;
    } else if (age >= staleAfter && record.state === "active") {
      recorder.setState(record.name, "stale");
      out.markedStale += 1;
    } else if (age < staleAfter && record.state === "stale") {
      recorder.setState(record.name, "active");
      out.reactivated += 1;
    }
  }

  return out;
}

function activityAnchor(r: SkillUsageRecord): number | undefined {
  const candidates = [r.lastUsedAt, r.lastPatchedAt]
    .filter((t): t is string => typeof t === "string")
    .map((t) => Date.parse(t))
    .filter((n) => !Number.isNaN(n));
  if (candidates.length === 0) return undefined;
  return Math.max(...candidates);
}
