import { join } from "node:path";
import {
  FileSessionStore,
  loadTraceEventsFile,
  type SparkwrightEvent,
} from "@sparkwright/core";
import type { SkillRoot } from "@sparkwright/skills";
import {
  loadLayeredSkillReport,
  type SkillReportEntry,
} from "./skill-report.js";

export interface SkillStatsOptions {
  workspaceRoot: string;
  sessionRootDir: string;
  skillRoots: readonly SkillRoot[];
  limit?: number;
  skillName?: string;
}

export interface SkillStatsReport {
  workspaceRoot: string;
  sessionRootDir: string;
  sessionLimit: number;
  sessionsScanned: number;
  tracesScanned: number;
  traceErrors: Array<{ sessionId: string; path: string; message: string }>;
  skills: SkillStatsEntry[];
}

export interface SkillStatsEntry {
  name: string;
  layer?: SkillRoot["layer"];
  sourcePath?: string;
  contentHash?: string;
  shadowedBy?: string;
  shadows?: string[];

  indexedCount: number;
  loadedCount: number;
  loadFailureCount: number;
  explicitLoadCount: number;

  runIds: string[];
  sessionIds: string[];

  associatedRuns: {
    completed: number;
    failed: number;
    cancelled: number;
  };

  associatedToolFailures: {
    total: number;
    unresolved: number;
    byTool: Record<string, number>;
  };
}

interface MutableSkillStatsEntry extends SkillStatsEntry {
  runIdSet: Set<string>;
  sessionIdSet: Set<string>;
}

interface RunStats {
  runId: string;
  sessionId?: string;
  loadedSkillNames: Set<string>;
  failedByTool: Record<string, number>;
  toolFailureTotal: number;
  unresolvedToolFailureTotal: number;
  terminal?: "completed" | "failed" | "cancelled";
}

const DEFAULT_SESSION_LIMIT = 20;

export async function collectSkillStats(
  options: SkillStatsOptions,
): Promise<SkillStatsReport> {
  const sessionLimit = options.limit ?? DEFAULT_SESSION_LIMIT;
  const report = await loadLayeredSkillReport(options.skillRoots, {
    includeMissingRoots: "configured",
  });
  const byName = new Map<string, MutableSkillStatsEntry>();

  for (const skill of report.skills) {
    ensureEntry(byName, skill.name, {
      layer: skill.layer,
      sourcePath: skill.source,
    });
  }

  for (const shadow of report.shadows) {
    const effective = ensureEntry(byName, shadow.shadowedBy.name, {
      layer: shadow.shadowedBy.layer,
      sourcePath: shadow.shadowedBy.source,
    });
    effective.shadows = sortedUnique([
      ...(effective.shadows ?? []),
      formatSkillOrigin(shadow.shadowed),
    ]);

    const shadowed = ensureEntry(byName, shadow.shadowed.name, {
      layer: shadow.shadowed.layer,
      sourcePath: shadow.shadowed.source,
    });
    shadowed.shadowedBy = formatSkillOrigin(shadow.shadowedBy);
  }

  for (const error of report.errors) {
    const name = inferSkillNameFromSource(error.source);
    if (!name) continue;
    const entry = ensureEntry(byName, name, { sourcePath: error.source });
    entry.loadFailureCount += 1;
  }

  const store = new FileSessionStore({ rootDir: options.sessionRootDir });
  const sessions = await store.list({ limit: sessionLimit });
  const traceErrors: SkillStatsReport["traceErrors"] = [];
  let tracesScanned = 0;

  for (const session of sessions) {
    const tracePath = join(options.sessionRootDir, session.id, "trace.jsonl");
    let events: SparkwrightEvent[];
    try {
      events = await loadTraceEventsFile(tracePath);
      tracesScanned += 1;
    } catch (error) {
      traceErrors.push({
        sessionId: session.id,
        path: tracePath,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    collectTraceStats(byName, events, session.id);
  }

  const skills = [...byName.values()]
    .map(finalizeEntry)
    .filter((entry) => !options.skillName || entry.name === options.skillName)
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    workspaceRoot: options.workspaceRoot,
    sessionRootDir: options.sessionRootDir,
    sessionLimit,
    sessionsScanned: sessions.length,
    tracesScanned,
    traceErrors,
    skills,
  };
}

function collectTraceStats(
  byName: Map<string, MutableSkillStatsEntry>,
  events: readonly SparkwrightEvent[],
  fallbackSessionId?: string,
): void {
  const runs = new Map<string, RunStats>();

  for (const event of events) {
    const run = ensureRun(runs, event, fallbackSessionId);
    if (event.type === "skill.indexed") {
      collectSkillIndexed(byName, run, event);
      continue;
    }
    if (event.type === "skill.failed") {
      collectSkillFailed(byName, run, event);
      continue;
    }
    if (event.type === "skill.loaded") {
      collectSkillLoaded(byName, run, event);
      continue;
    }
    if (event.type === "tool.failed") {
      collectToolFailed(run, event);
      continue;
    }
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      run.terminal = event.type.replace("run.", "") as RunStats["terminal"];
      const unresolved = unresolvedToolFailureTotal(event);
      if (unresolved !== undefined) run.unresolvedToolFailureTotal = unresolved;
    }
  }

  for (const run of runs.values()) {
    for (const name of run.loadedSkillNames) {
      const entry = ensureEntry(byName, name);
      if (run.terminal) entry.associatedRuns[run.terminal] += 1;
      entry.associatedToolFailures.total += run.toolFailureTotal;
      entry.associatedToolFailures.unresolved += run.unresolvedToolFailureTotal;
      for (const [tool, count] of Object.entries(run.failedByTool)) {
        entry.associatedToolFailures.byTool[tool] =
          (entry.associatedToolFailures.byTool[tool] ?? 0) + count;
      }
    }
  }
}

function collectSkillIndexed(
  byName: Map<string, MutableSkillStatsEntry>,
  run: RunStats,
  event: SparkwrightEvent,
): void {
  // The skill list rides on the event metadata; the payload only carries a
  // `count`. (See the emitter in @sparkwright/skills.)
  if (!Array.isArray(event.metadata.skills)) return;
  for (const rawSkill of event.metadata.skills) {
    if (!isRecord(rawSkill) || typeof rawSkill.name !== "string") continue;
    const entry = ensureEntry(byName, rawSkill.name, {
      sourcePath: stringValue(rawSkill.sourcePath),
      contentHash: stringValue(rawSkill.contentHash),
    });
    entry.indexedCount += 1;
    recordRunAndSession(entry, run);
  }
}

function collectSkillFailed(
  byName: Map<string, MutableSkillStatsEntry>,
  run: RunStats,
  event: SparkwrightEvent,
): void {
  if (!isRecord(event.payload)) return;
  const source = stringValue(event.payload.source);
  const name =
    stringValue(event.payload.name) ??
    stringValue(event.payload.requestedName) ??
    (source ? inferSkillNameFromSource(source) : undefined);
  if (!name) return;
  const entry = ensureEntry(byName, name, { sourcePath: source });
  entry.loadFailureCount += 1;
  if (event.metadata.mode === "on_demand_tool") entry.explicitLoadCount += 1;
  recordRunAndSession(entry, run);
}

function collectSkillLoaded(
  byName: Map<string, MutableSkillStatsEntry>,
  run: RunStats,
  event: SparkwrightEvent,
): void {
  if (!isRecord(event.payload)) return;
  const name = stringValue(event.payload.name);
  if (!name) return;
  // `name`/`status` live on the payload, but provenance (contentHash) and
  // `mode` ride on the metadata.
  const entry = ensureEntry(byName, name, {
    contentHash: stringValue(event.metadata.contentHash),
  });
  entry.loadedCount += 1;
  if (event.metadata.mode === "on_demand_tool") entry.explicitLoadCount += 1;
  recordRunAndSession(entry, run);
  run.loadedSkillNames.add(name);
}

function collectToolFailed(run: RunStats, event: SparkwrightEvent): void {
  if (!isRecord(event.payload)) return;
  const toolName =
    stringValue(event.payload.toolName) ?? stringValue(event.payload.name);
  run.toolFailureTotal += 1;
  if (toolName) {
    run.failedByTool[toolName] = (run.failedByTool[toolName] ?? 0) + 1;
  }
}

function ensureRun(
  runs: Map<string, RunStats>,
  event: SparkwrightEvent,
  fallbackSessionId?: string,
): RunStats {
  let run = runs.get(event.runId);
  if (!run) {
    run = {
      runId: event.runId,
      sessionId: stringValue(event.metadata.sessionId) ?? fallbackSessionId,
      loadedSkillNames: new Set(),
      failedByTool: {},
      toolFailureTotal: 0,
      unresolvedToolFailureTotal: 0,
    };
    runs.set(event.runId, run);
  } else if (!run.sessionId) {
    run.sessionId = stringValue(event.metadata.sessionId) ?? fallbackSessionId;
  }
  return run;
}

function ensureEntry(
  byName: Map<string, MutableSkillStatsEntry>,
  name: string,
  data: Partial<
    Pick<SkillStatsEntry, "layer" | "sourcePath" | "contentHash">
  > = {},
): MutableSkillStatsEntry {
  let entry = byName.get(name);
  if (!entry) {
    entry = {
      name,
      indexedCount: 0,
      loadedCount: 0,
      loadFailureCount: 0,
      explicitLoadCount: 0,
      runIds: [],
      sessionIds: [],
      associatedRuns: { completed: 0, failed: 0, cancelled: 0 },
      associatedToolFailures: { total: 0, unresolved: 0, byTool: {} },
      runIdSet: new Set(),
      sessionIdSet: new Set(),
    };
    byName.set(name, entry);
  }
  if (data.layer && !entry.layer) entry.layer = data.layer;
  if (data.sourcePath && !entry.sourcePath) entry.sourcePath = data.sourcePath;
  if (data.contentHash && !entry.contentHash)
    entry.contentHash = data.contentHash;
  return entry;
}

function recordRunAndSession(
  entry: MutableSkillStatsEntry,
  run: RunStats,
): void {
  entry.runIdSet.add(run.runId);
  if (run.sessionId) entry.sessionIdSet.add(run.sessionId);
}

function finalizeEntry(entry: MutableSkillStatsEntry): SkillStatsEntry {
  return {
    name: entry.name,
    ...(entry.layer ? { layer: entry.layer } : {}),
    ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}),
    ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
    ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy } : {}),
    ...(entry.shadows && entry.shadows.length > 0
      ? { shadows: sortedUnique(entry.shadows) }
      : {}),
    indexedCount: entry.indexedCount,
    loadedCount: entry.loadedCount,
    loadFailureCount: entry.loadFailureCount,
    explicitLoadCount: entry.explicitLoadCount,
    runIds: [...entry.runIdSet].sort(),
    sessionIds: [...entry.sessionIdSet].sort(),
    associatedRuns: { ...entry.associatedRuns },
    associatedToolFailures: {
      total: entry.associatedToolFailures.total,
      unresolved: entry.associatedToolFailures.unresolved,
      byTool: sortRecord(entry.associatedToolFailures.byTool),
    },
  };
}

function unresolvedToolFailureTotal(
  event: SparkwrightEvent,
): number | undefined {
  if (!isRecord(event.payload)) return undefined;
  const outcome = event.payload.toolOutcome;
  if (!isRecord(outcome) || !isRecord(outcome.unresolved)) return undefined;
  return typeof outcome.unresolved.total === "number"
    ? outcome.unresolved.total
    : undefined;
}

function inferSkillNameFromSource(source: string): string | undefined {
  const normalized = source.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const last = parts.at(-1);
  if (!last) return undefined;
  if (last === "SKILL.md") return parts.at(-2);
  if (last.endsWith(".skill.md")) return last.slice(0, -".skill.md".length);
  if (last.endsWith(".skill.json")) return last.slice(0, -".skill.json".length);
  return undefined;
}

function formatSkillOrigin(skill: SkillReportEntry): string {
  return `${skill.layer ?? "unknown"}:${skill.source ?? skill.root}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortRecord(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
