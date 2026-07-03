// AI maintenance note: Pluggable usage telemetry for the skill discovery
// protocol. The recorder is an injectable interface so embedders can persist
// to whatever store they like (sqlite, file, vector DB). The package ships a
// thin in-memory implementation suitable for tests and short-lived agents;
// downstream products should provide durable storage.

/**
 * Lifecycle state of a skill in the registry, used by tooling that prunes /
 * surfaces only "active" skills (see {@link import("./matcher.js").matchSkills}
 * `excludeStates`). Embedders drive transitions via {@link SkillUsageRecorder.setState}.
 *
 * @public
 * @stability experimental v0.1
 */
export type SkillUsageState = "active" | "stale" | "archived";
export type SkillUsageLoadMode = "on_demand_tool" | "resident_context";

/**
 * Telemetry snapshot for a single skill. Timestamps are ISO 8601 strings.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SkillUsageRecord {
  name: string;
  useCount: number;
  explicitLoadCount?: number;
  residentLoadCount?: number;
  patchCount: number;
  lastUsedAt?: string;
  lastPatchedAt?: string;
  state: SkillUsageState;
}

/**
 * Recorder of skill usage events. Implementations decide on durability and
 * concurrency. The interface is sync to keep matcher / scoring hot paths
 * cheap; persistent backends should buffer writes internally.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SkillUsageRecorder {
  /** Bump useCount + lastUsedAt for the named skill. */
  recordUse(name: string, at?: Date, mode?: SkillUsageLoadMode): void;
  /** Bump patchCount + lastPatchedAt (called on edit / patch / write_file). */
  recordPatch(name: string, at?: Date): void;
  /** Drop the record entirely (e.g. on archive). */
  forget(name: string): void;
  /** Set lifecycle state (e.g. demote to stale / archive). */
  setState(name: string, state: SkillUsageState): void;
  /** Read a single record, or undefined if untracked. */
  get(name: string): SkillUsageRecord | undefined;
  /** Snapshot all known records. */
  list(): SkillUsageRecord[];
}

/**
 * In-memory {@link SkillUsageRecorder}. Default for tests and ephemeral
 * agents; persists nothing across process restarts.
 *
 * @public
 * @stability experimental v0.1
 */
export class InMemorySkillUsageRecorder implements SkillUsageRecorder {
  private readonly byName = new Map<string, SkillUsageRecord>();

  recordUse(
    name: string,
    at: Date = new Date(),
    mode?: SkillUsageLoadMode,
  ): void {
    const r = this.ensure(name);
    r.useCount += 1;
    r.lastUsedAt = at.toISOString();
    recordLoadMode(r, mode);
    // Touching a stale skill reactivates it; archived stays archived until
    // an explicit setState.
    if (r.state === "stale") r.state = "active";
  }

  recordPatch(name: string, at: Date = new Date()): void {
    const r = this.ensure(name);
    r.patchCount += 1;
    r.lastPatchedAt = at.toISOString();
  }

  forget(name: string): void {
    this.byName.delete(name);
  }

  setState(name: string, state: SkillUsageState): void {
    this.ensure(name).state = state;
  }

  get(name: string): SkillUsageRecord | undefined {
    const r = this.byName.get(name);
    return r ? { ...r } : undefined;
  }

  list(): SkillUsageRecord[] {
    return [...this.byName.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private ensure(name: string): SkillUsageRecord {
    let r = this.byName.get(name);
    if (!r) {
      r = {
        name,
        useCount: 0,
        explicitLoadCount: 0,
        residentLoadCount: 0,
        patchCount: 0,
        state: "active",
      };
      this.byName.set(name, r);
    }
    return r;
  }
}

export function recordLoadMode(
  record: SkillUsageRecord,
  mode: SkillUsageLoadMode | undefined,
): void {
  if (mode === "on_demand_tool") {
    record.explicitLoadCount = (record.explicitLoadCount ?? 0) + 1;
  } else if (mode === "resident_context") {
    record.residentLoadCount = (record.residentLoadCount ?? 0) + 1;
  }
}

/**
 * Compute a recency boost in [0, 1] from a `lastUsedAt` ISO timestamp. Decays
 * exponentially with the given half-life (default: 14 days). Used by
 * {@link import("./matcher.js").matchSkills} when given a usage recorder.
 *
 * @public
 * @stability experimental v0.1
 */
export function recencyBoost(
  lastUsedAt: string | undefined,
  now: Date = new Date(),
  halfLifeMs: number = 14 * 24 * 60 * 60 * 1000,
): number {
  if (!lastUsedAt) return 0;
  const last = Date.parse(lastUsedAt);
  if (Number.isNaN(last)) return 0;
  const age = Math.max(0, now.getTime() - last);
  return Math.pow(0.5, age / halfLifeMs);
}
