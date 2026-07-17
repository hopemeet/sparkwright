import type { Dirent } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
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
import {
  listSkillHistory,
  listSkillProposals,
  type SkillHistoryEntry,
  type SkillHistoryKind,
  type SkillProposalKind,
  type SkillProposalState,
  type SkillProposalSummary,
} from "./skill-evolution.js";

export type SkillStatsQueryScope =
  | "human_diagnostics"
  | "evolution_evidence"
  | "post_apply_verification";

export interface SkillStatsQuery {
  /** @reserved Public skill-stats query field consumed by diagnostics UIs. */
  scope: SkillStatsQueryScope;
  sessionLimit: number;
  skillName?: string;
  skillKey?: string;
  packageHash?: string;
  /** @reserved Public skill-stats query field consumed by diagnostics UIs. */
  includeResidentLoads: boolean;
  /** @reserved Public skill-stats query field consumed by diagnostics UIs. */
  includeExplicitLoads: boolean;
  useProjectionCache: boolean;
}

export interface SkillStatsOptions {
  workspaceRoot: string;
  sessionRootDir: string;
  skillRoots: readonly SkillRoot[];
  limit?: number;
  skillName?: string;
  skillKey?: string;
  packageHash?: string;
  useProjectionCache?: boolean;
  projectionCacheDir?: string;
}

export interface SkillStatsReport {
  workspaceRoot: string;
  sessionRootDir: string;
  sessionLimit: number;
  query: SkillStatsQuery;
  window: SkillStatsWindow;
  freshness: SkillStatsFreshness;
  projectionCache: SkillStatsProjectionCacheInfo;
  catalog: SkillStatsCatalogInfo;
  sessionsScanned: number;
  tracesScanned: number;
  traceErrors: Array<{ sessionId: string; path: string; message: string }>;
  findings: SkillStatsFinding[];
  skills: SkillStatsEntry[];
}

export interface SkillStatsWindow {
  trace: {
    sessionLimit: number;
    sessionsScanned: number;
    firstSessionUpdatedAt?: string;
    lastSessionUpdatedAt?: string;
    firstEventAt?: string;
    lastEventAt?: string;
    runCount: number;
    terminalRunCount: number;
    openRunCount: number;
  };
  evolution: {
    proposalsScanned: number;
    historyScanned: number;
    firstCreatedAt?: string;
    lastCreatedAt?: string;
    lastClosedAt?: string;
  };
}

export interface SkillStatsFreshness {
  computedAt: string;
  /** @reserved Public skill-stats freshness field consumed by diagnostics UIs. */
  latestTraceEventAt?: string;
  latestEvolutionAt?: string;
  latestEvidenceAt?: string;
}

export interface SkillStatsProjectionCacheInfo {
  enabled: boolean;
  cacheDir: string;
  hits: number;
  misses: number;
  writes: number;
  errors: Array<{ sessionId: string; path: string; message: string }>;
}

export interface SkillStatsCatalogInfo {
  enabled: boolean;
  used: boolean;
  path: string;
  candidateSessions: number;
  selectedSessions: number;
  hits: number;
  misses: number;
  writes: number;
  errors: Array<{ path: string; message: string }>;
}

export type SkillStatsFindingSeverity = "info" | "warning";
export type SkillStatsFindingRelation = "associated" | "observed";
export type SkillStatsFindingCode =
  | "SKILL_LOAD_FAILURES"
  | "ASSOCIATED_TOOL_FAILURES"
  | "SKILL_EVOLUTION_ACTIVITY";

export interface SkillStatsFinding {
  code: SkillStatsFindingCode;
  severity: SkillStatsFindingSeverity;
  relation: SkillStatsFindingRelation;
  skillKey: string;
  skillName: string;
  packageHash: string;
  message: string;
  evidence: {
    runIds: string[];
    sessionIds: string[];
    metrics: Record<string, number | string>;
  };
}

export interface SkillStatsEntry {
  skillKey: string;
  name: string;
  layer?: SkillRoot["layer"] | "unknown";
  sourcePath?: string;
  packageHash: string;
  packageHashPolicyVersion: 2;
  shadowedBy?: string;
  shadows?: string[];
  firstEventAt?: string;
  lastEventAt?: string;
  sampleRunIds: string[];
  failureRunIds: string[];

  indexedCount: number;
  loadedCount: number;
  residentLoadCount: number;
  explicitLoadCount: number;
  /**
   * Back-compat summary of `loadFailures.total`. New callers should prefer the
   * classified `loadFailures` object.
   */
  loadFailureCount: number;
  loadFailures: {
    total: number;
    byMode: Record<string, number>;
    byStatus: Record<string, number>;
  };

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
    byCode: Record<string, number>;
    beforeFirstLoad: number;
    afterFirstLoad: number;
  };

  evolution: {
    proposals: {
      total: number;
      asBase: number;
      asAfter: number;
      byState: Partial<Record<SkillProposalState, number>>;
      byKind: Partial<Record<SkillProposalKind, number>>;
      ids: string[];
      latestCreatedAt?: string;
      latestClosedAt?: string;
    };
    history: {
      total: number;
      asBefore: number;
      asAfter: number;
      byKind: Partial<Record<SkillHistoryKind, number>>;
      ids: string[];
      latestCreatedAt?: string;
    };
  };
}

interface MutableSkillStatsEntry extends SkillStatsEntry {
  runIdSet: Set<string>;
  sessionIdSet: Set<string>;
  sampleRunIdSet: Set<string>;
  failureRunIdSet: Set<string>;
}

interface SkillIdentity {
  name: string;
  layer?: SkillRoot["layer"] | "unknown";
  sourcePath?: string;
  packageHash: string;
  packageHashPolicyVersion: 2;
}

interface SkillStatsTarget {
  skillName?: string;
  skillKey?: string;
  packageHash?: string;
}

interface LoadedSkillInRun {
  identity: SkillIdentity;
  firstLoadOrder: number;
}

interface ToolFailureInRun {
  order: number;
  timestamp: string;
  toolName?: string;
  code?: string;
}

interface RunStats {
  runId: string;
  sessionId?: string;
  indexedByName: Map<string, SkillIdentity>;
  loadedBySkillKey: Map<string, LoadedSkillInRun>;
  toolFailures: ToolFailureInRun[];
  unresolvedToolFailureTotal: number;
  terminal?: "completed" | "failed" | "cancelled";
  terminalTimestamp?: string;
}

interface TraceFileFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

interface SessionProjectionWindow {
  firstEventAt?: string;
  lastEventAt?: string;
  runCount: number;
  terminalRunCount: number;
  openRunCount: number;
}

interface SkillStatsSessionProjectionV1 {
  schemaVersion: typeof SESSION_PROJECTION_SCHEMA_VERSION;
  algorithmVersion: typeof SESSION_PROJECTION_ALGORITHM_VERSION;
  sessionId: string;
  traceFingerprints: TraceFileFingerprint[];
  window: SessionProjectionWindow;
  skills: SkillStatsEntry[];
  computedAt: string;
}

interface SkillStatsCatalogSessionRef {
  sessionId: string;
  updatedAt: string;
  traceFingerprints: TraceFileFingerprint[];
}

interface SkillStatsCatalogSkillRef {
  skillKey: string;
  name: string;
  layer?: SkillRoot["layer"] | "unknown";
  packageHash: string;
  packageHashPolicyVersion: 2;
  sessionIds: string[];
  firstEventAt?: string;
  lastEventAt?: string;
}

interface SkillStatsCatalogV1 {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  algorithmVersion: typeof CATALOG_ALGORITHM_VERSION;
  sessionProjectionAlgorithmVersion: typeof SESSION_PROJECTION_ALGORITHM_VERSION;
  sessionRootDir: string;
  sessionLimit: number;
  sessions: SkillStatsCatalogSessionRef[];
  skillKeys: Record<string, SkillStatsCatalogSkillRef>;
  skillNames: Record<string, string[]>;
  packageHashes: Record<string, string[]>;
  computedAt: string;
}

interface MutableTraceWindow {
  firstSessionUpdatedAt?: string;
  lastSessionUpdatedAt?: string;
  firstEventAt?: string;
  lastEventAt?: string;
  runCount: number;
  terminalRunCount: number;
  openRunCount: number;
}

interface EvolutionRollupResult {
  proposalsScanned: number;
  historyScanned: number;
  firstCreatedAt?: string;
  lastCreatedAt?: string;
  lastClosedAt?: string;
}

const DEFAULT_SESSION_LIMIT = 20;
const DEFAULT_SKILL_SAMPLE_LIMIT = 20;
const UNKNOWN_LAYER = "unknown";
const SESSION_PROJECTION_SCHEMA_VERSION = "skill-stats-session.v2";
const SESSION_PROJECTION_ALGORITHM_VERSION = "skill-stats-trace-v4";
const CATALOG_SCHEMA_VERSION = "skill-stats-catalog.v2";
const CATALOG_ALGORITHM_VERSION = "skill-stats-catalog-v2";
const DEFAULT_USE_PROJECTION_CACHE = true;

export async function collectSkillStats(
  options: SkillStatsOptions,
): Promise<SkillStatsReport> {
  const sessionLimit = options.limit ?? DEFAULT_SESSION_LIMIT;
  const useProjectionCache =
    options.useProjectionCache ?? DEFAULT_USE_PROJECTION_CACHE;
  const computedAt = new Date().toISOString();
  const cacheDir =
    options.projectionCacheDir ??
    join(options.workspaceRoot, ".sparkwright", "skill-stats");
  const catalogPath = skillStatsCatalogPath(cacheDir);
  const projectionCache: SkillStatsProjectionCacheInfo = {
    enabled: useProjectionCache,
    cacheDir,
    hits: 0,
    misses: 0,
    writes: 0,
    errors: [],
  };
  const catalog: SkillStatsCatalogInfo = {
    enabled: useProjectionCache,
    used: false,
    path: catalogPath,
    candidateSessions: 0,
    selectedSessions: 0,
    hits: 0,
    misses: 0,
    writes: 0,
    errors: [],
  };
  const query: SkillStatsQuery = {
    scope: "human_diagnostics",
    sessionLimit,
    ...(options.skillName ? { skillName: options.skillName } : {}),
    ...(options.skillKey ? { skillKey: options.skillKey } : {}),
    ...(options.packageHash ? { packageHash: options.packageHash } : {}),
    includeResidentLoads: true,
    includeExplicitLoads: true,
    useProjectionCache,
  };
  const report = await loadLayeredSkillReport(options.skillRoots, {
    includeMissingRoots: "configured",
  });
  const byKey = new Map<string, MutableSkillStatsEntry>();

  const store = new FileSessionStore({ rootDir: options.sessionRootDir });
  const sessions = await store.list({ limit: sessionLimit });
  catalog.candidateSessions = sessions.length;
  let sessionsToScan = sessions;
  let shouldWriteCatalog = useProjectionCache;
  const target = skillStatsTarget(options);
  if (target && useProjectionCache) {
    catalog.used = true;
    const catalogSessionRefs = await currentCatalogSessionRefs(
      options.sessionRootDir,
      sessions,
      catalog,
    );
    const cachedCatalog = await readSkillStatsCatalog(
      catalogPath,
      {
        sessionRootDir: options.sessionRootDir,
        sessionLimit,
        sessions: catalogSessionRefs,
      },
      catalog,
    );
    if (cachedCatalog) {
      catalog.hits += 1;
      shouldWriteCatalog = false;
      const selectedSessionIds = selectCatalogSessionIds(cachedCatalog, target);
      sessionsToScan = sessions.filter((session) =>
        selectedSessionIds.has(session.id),
      );
    } else {
      catalog.misses += 1;
    }
  }
  catalog.selectedSessions = sessionsToScan.length;
  const traceErrors: SkillStatsReport["traceErrors"] = [];
  let tracesScanned = 0;
  const scannedProjections: SkillStatsSessionProjectionV1[] = [];
  const traceWindow: MutableTraceWindow = {
    runCount: 0,
    terminalRunCount: 0,
    openRunCount: 0,
  };

  for (const session of sessionsToScan) {
    traceWindow.firstSessionUpdatedAt = earliestIso(
      traceWindow.firstSessionUpdatedAt,
      session.updatedAt,
    );
    traceWindow.lastSessionUpdatedAt = latestIso(
      traceWindow.lastSessionUpdatedAt,
      session.updatedAt,
    );
    const projection = await loadOrBuildSessionProjection({
      sessionRootDir: options.sessionRootDir,
      sessionId: session.id,
      cacheDir,
      useProjectionCache,
      computedAt,
      traceErrors,
      projectionCache,
    });
    scannedProjections.push(projection);
    tracesScanned += projection.traceFingerprints.length;
    mergeSessionProjection(byKey, projection);
    mergeTraceWindow(traceWindow, projection.window);
  }

  if (shouldWriteCatalog && scannedProjections.length === sessions.length) {
    await writeSkillStatsCatalog(
      catalogPath,
      buildSkillStatsCatalog({
        sessionRootDir: options.sessionRootDir,
        sessionLimit,
        sessions,
        projections: scannedProjections,
        computedAt,
      }),
      catalog,
    );
  }

  applyCurrentSkillReport(byKey, report.skills, report.shadows);
  const evolutionWindow = await applyEvolutionRollup(
    byKey,
    options.workspaceRoot,
  );

  const skills = [...byKey.values()]
    .map(finalizeEntry)
    .filter((entry) => matchesSkillStatsTarget(entry, target))
    .sort(compareSkillEntries);
  const findings = analyzeSkillStats(skills);
  const window: SkillStatsWindow = {
    trace: {
      sessionLimit,
      sessionsScanned: sessionsToScan.length,
      ...(traceWindow.firstSessionUpdatedAt
        ? { firstSessionUpdatedAt: traceWindow.firstSessionUpdatedAt }
        : {}),
      ...(traceWindow.lastSessionUpdatedAt
        ? { lastSessionUpdatedAt: traceWindow.lastSessionUpdatedAt }
        : {}),
      ...(traceWindow.firstEventAt
        ? { firstEventAt: traceWindow.firstEventAt }
        : {}),
      ...(traceWindow.lastEventAt
        ? { lastEventAt: traceWindow.lastEventAt }
        : {}),
      runCount: traceWindow.runCount,
      terminalRunCount: traceWindow.terminalRunCount,
      openRunCount: traceWindow.openRunCount,
    },
    evolution: evolutionWindow,
  };
  const latestEvolutionAt = latestIso(
    evolutionWindow.lastCreatedAt,
    evolutionWindow.lastClosedAt,
  );
  const freshness: SkillStatsFreshness = {
    computedAt,
    ...(window.trace.lastEventAt
      ? { latestTraceEventAt: window.trace.lastEventAt }
      : {}),
    ...(latestEvolutionAt ? { latestEvolutionAt } : {}),
    ...(latestIso(window.trace.lastEventAt, latestEvolutionAt)
      ? {
          latestEvidenceAt: latestIso(
            window.trace.lastEventAt,
            latestEvolutionAt,
          ),
        }
      : {}),
  };

  return {
    workspaceRoot: options.workspaceRoot,
    sessionRootDir: options.sessionRootDir,
    sessionLimit,
    query,
    window,
    freshness,
    projectionCache,
    catalog,
    sessionsScanned: sessionsToScan.length,
    tracesScanned,
    traceErrors,
    findings,
    skills,
  };
}

async function sessionTracePaths(
  sessionRootDir: string,
  sessionId: string,
): Promise<string[]> {
  const sessionDir = join(sessionRootDir, sessionId);
  const paths = [join(sessionDir, "trace.jsonl")];
  const agentsDir = join(sessionDir, "agents");
  let agents: Dirent[];
  try {
    agents = await readdir(agentsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return paths;
    throw error;
  }
  for (const entry of agents
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    paths.push(join(agentsDir, entry.name, "trace.jsonl"));
  }
  return paths;
}

async function loadOrBuildSessionProjection(input: {
  sessionRootDir: string;
  sessionId: string;
  cacheDir: string;
  useProjectionCache: boolean;
  computedAt: string;
  traceErrors: SkillStatsReport["traceErrors"];
  projectionCache: SkillStatsProjectionCacheInfo;
}): Promise<SkillStatsSessionProjectionV1> {
  const tracePaths = await sessionTracePaths(
    input.sessionRootDir,
    input.sessionId,
  );
  const traceFingerprints: TraceFileFingerprint[] = [];
  for (const tracePath of tracePaths) {
    try {
      traceFingerprints.push(await traceFileFingerprint(tracePath));
    } catch (error) {
      input.traceErrors.push({
        sessionId: input.sessionId,
        path: tracePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const cachePath = sessionProjectionCachePath(input.cacheDir, input.sessionId);
  if (input.useProjectionCache) {
    const cached = await readSessionProjectionCache(
      cachePath,
      input.sessionId,
      traceFingerprints,
      input.projectionCache,
    );
    if (cached) {
      input.projectionCache.hits += 1;
      return cached;
    }
    input.projectionCache.misses += 1;
  }

  const seenEventIds = new Set<string>();
  const sessionEvents: SparkwrightEvent[] = [];
  for (const tracePath of traceFingerprints.map(
    (fingerprint) => fingerprint.path,
  )) {
    let events: SparkwrightEvent[];
    try {
      events = await loadTraceEventsFile(tracePath);
    } catch (error) {
      input.traceErrors.push({
        sessionId: input.sessionId,
        path: tracePath,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const event of events) {
      if (seenEventIds.has(event.id)) continue;
      seenEventIds.add(event.id);
      sessionEvents.push(event);
    }
  }

  const byKey = new Map<string, MutableSkillStatsEntry>();
  collectTraceStats(byKey, sessionEvents, input.sessionId);
  const projection: SkillStatsSessionProjectionV1 = {
    schemaVersion: SESSION_PROJECTION_SCHEMA_VERSION,
    algorithmVersion: SESSION_PROJECTION_ALGORITHM_VERSION,
    sessionId: input.sessionId,
    traceFingerprints,
    window: sessionProjectionWindow(sessionEvents),
    skills: [...byKey.values()].map(finalizeEntry).sort(compareSkillEntries),
    computedAt: input.computedAt,
  };

  if (input.useProjectionCache) {
    await writeSessionProjectionCache(
      cachePath,
      projection,
      input.sessionId,
      input.projectionCache,
    );
  }

  return projection;
}

async function traceFileFingerprint(
  path: string,
): Promise<TraceFileFingerprint> {
  const info = await stat(path);
  return {
    path,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

async function currentCatalogSessionRefs(
  sessionRootDir: string,
  sessions: readonly { id: string; updatedAt: string }[],
  catalog: SkillStatsCatalogInfo,
): Promise<SkillStatsCatalogSessionRef[]> {
  const refs: SkillStatsCatalogSessionRef[] = [];
  for (const session of sessions) {
    const traceFingerprints: TraceFileFingerprint[] = [];
    let tracePaths: string[];
    try {
      tracePaths = await sessionTracePaths(sessionRootDir, session.id);
    } catch (error) {
      catalog.errors.push({
        path: join(sessionRootDir, session.id),
        message: error instanceof Error ? error.message : String(error),
      });
      tracePaths = [];
    }
    for (const tracePath of tracePaths) {
      try {
        traceFingerprints.push(await traceFileFingerprint(tracePath));
      } catch (error) {
        catalog.errors.push({
          path: tracePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    refs.push({
      sessionId: session.id,
      updatedAt: session.updatedAt,
      traceFingerprints,
    });
  }
  return refs;
}

async function readSkillStatsCatalog(
  path: string,
  expected: {
    sessionRootDir: string;
    sessionLimit: number;
    sessions: readonly SkillStatsCatalogSessionRef[];
  },
  catalog: SkillStatsCatalogInfo,
): Promise<SkillStatsCatalogV1 | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      catalog.errors.push({
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return undefined;
  }
  if (!isSkillStatsCatalog(raw)) return undefined;
  if (
    raw.sessionRootDir !== expected.sessionRootDir ||
    raw.sessionLimit !== expected.sessionLimit ||
    !sameCatalogSessions(raw.sessions, expected.sessions)
  ) {
    return undefined;
  }
  return raw;
}

async function writeSkillStatsCatalog(
  path: string,
  value: SkillStatsCatalogV1,
  catalog: SkillStatsCatalogInfo,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
    catalog.writes += 1;
  } catch (error) {
    catalog.errors.push({
      path,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function skillStatsCatalogPath(cacheDir: string): string {
  return join(cacheDir, "catalog.json");
}

function buildSkillStatsCatalog(input: {
  sessionRootDir: string;
  sessionLimit: number;
  sessions: readonly { id: string; updatedAt: string }[];
  projections: readonly SkillStatsSessionProjectionV1[];
  computedAt: string;
}): SkillStatsCatalogV1 {
  const projectionsBySession = new Map(
    input.projections.map((projection) => [projection.sessionId, projection]),
  );
  const skillKeys = new Map<
    string,
    SkillStatsCatalogSkillRef & {
      sessionIdSet: Set<string>;
    }
  >();
  for (const projection of input.projections) {
    for (const skill of projection.skills) {
      let ref = skillKeys.get(skill.skillKey);
      if (!ref) {
        ref = {
          skillKey: skill.skillKey,
          name: skill.name,
          ...(skill.layer ? { layer: skill.layer } : {}),
          packageHash: skill.packageHash,
          packageHashPolicyVersion: skill.packageHashPolicyVersion,
          sessionIds: [],
          sessionIdSet: new Set(),
        };
        skillKeys.set(skill.skillKey, ref);
      }
      ref.sessionIdSet.add(projection.sessionId);
      ref.firstEventAt = earliestIso(ref.firstEventAt, skill.firstEventAt);
      ref.lastEventAt = latestIso(ref.lastEventAt, skill.lastEventAt);
    }
  }

  const skillKeyRecords: Record<string, SkillStatsCatalogSkillRef> = {};
  const skillNames: Record<string, string[]> = {};
  const packageHashes: Record<string, string[]> = {};
  for (const [key, ref] of [...skillKeys.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const sessionIds = [...ref.sessionIdSet].sort();
    skillKeyRecords[key] = {
      skillKey: ref.skillKey,
      name: ref.name,
      ...(ref.layer ? { layer: ref.layer } : {}),
      packageHash: ref.packageHash,
      packageHashPolicyVersion: ref.packageHashPolicyVersion,
      sessionIds,
      ...(ref.firstEventAt ? { firstEventAt: ref.firstEventAt } : {}),
      ...(ref.lastEventAt ? { lastEventAt: ref.lastEventAt } : {}),
    };
    skillNames[ref.name] = sortedUnique([...(skillNames[ref.name] ?? []), key]);
    packageHashes[ref.packageHash] = sortedUnique([
      ...(packageHashes[ref.packageHash] ?? []),
      key,
    ]);
  }

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    algorithmVersion: CATALOG_ALGORITHM_VERSION,
    sessionProjectionAlgorithmVersion: SESSION_PROJECTION_ALGORITHM_VERSION,
    sessionRootDir: input.sessionRootDir,
    sessionLimit: input.sessionLimit,
    sessions: input.sessions.map((session) => {
      const projection = projectionsBySession.get(session.id);
      return {
        sessionId: session.id,
        updatedAt: session.updatedAt,
        traceFingerprints: projection?.traceFingerprints ?? [],
      };
    }),
    skillKeys: skillKeyRecords,
    skillNames: sortStringArrayRecord(skillNames),
    packageHashes: sortStringArrayRecord(packageHashes),
    computedAt: input.computedAt,
  };
}

function selectCatalogSessionIds(
  catalog: SkillStatsCatalogV1,
  target: SkillStatsTarget,
): Set<string> {
  const keys = catalogSkillKeysForTarget(catalog, target);
  const sessionIds = new Set<string>();
  for (const key of keys) {
    const ref = catalog.skillKeys[key];
    if (!ref) continue;
    for (const sessionId of ref.sessionIds) sessionIds.add(sessionId);
  }
  return sessionIds;
}

function catalogSkillKeysForTarget(
  catalog: SkillStatsCatalogV1,
  target: SkillStatsTarget,
): string[] {
  let keys: string[];
  if (target.skillKey) {
    keys = catalog.skillKeys[target.skillKey] ? [target.skillKey] : [];
  } else if (target.skillName) {
    keys = catalog.skillNames[target.skillName] ?? [];
  } else if (target.packageHash) {
    keys = catalog.packageHashes[target.packageHash] ?? [];
  } else {
    keys = Object.keys(catalog.skillKeys);
  }
  if (target.packageHash) {
    keys = keys.filter(
      (key) => catalog.skillKeys[key]?.packageHash === target.packageHash,
    );
  }
  if (target.skillName) {
    keys = keys.filter(
      (key) => catalog.skillKeys[key]?.name === target.skillName,
    );
  }
  return sortedUnique(keys);
}

async function readSessionProjectionCache(
  path: string,
  sessionId: string,
  traceFingerprints: readonly TraceFileFingerprint[],
  projectionCache: SkillStatsProjectionCacheInfo,
): Promise<SkillStatsSessionProjectionV1 | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      projectionCache.errors.push({
        sessionId,
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return undefined;
  }
  if (!isSessionProjectionCache(raw)) return undefined;
  const parsed = raw;
  if (
    parsed.schemaVersion !== SESSION_PROJECTION_SCHEMA_VERSION ||
    parsed.algorithmVersion !== SESSION_PROJECTION_ALGORITHM_VERSION ||
    parsed.sessionId !== sessionId ||
    !sameTraceFingerprints(parsed.traceFingerprints, traceFingerprints)
  ) {
    return undefined;
  }
  return parsed;
}

function isSessionProjectionCache(
  value: unknown,
): value is SkillStatsSessionProjectionV1 {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.traceFingerprints)) return false;
  if (!Array.isArray(value.skills)) return false;
  if (!isRecord(value.window)) return false;
  return (
    value.schemaVersion === SESSION_PROJECTION_SCHEMA_VERSION &&
    value.algorithmVersion === SESSION_PROJECTION_ALGORITHM_VERSION &&
    typeof value.sessionId === "string" &&
    typeof value.computedAt === "string" &&
    value.traceFingerprints.every(isTraceFileFingerprint) &&
    isSessionProjectionWindow(value.window) &&
    value.skills.every(isCachedSkillStatsEntry)
  );
}

function isTraceFileFingerprint(value: unknown): value is TraceFileFingerprint {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.size === "number" &&
    typeof value.mtimeMs === "number"
  );
}

function isSessionProjectionWindow(
  value: unknown,
): value is SessionProjectionWindow {
  return (
    isRecord(value) &&
    (value.firstEventAt === undefined ||
      typeof value.firstEventAt === "string") &&
    (value.lastEventAt === undefined ||
      typeof value.lastEventAt === "string") &&
    typeof value.runCount === "number" &&
    typeof value.terminalRunCount === "number" &&
    typeof value.openRunCount === "number"
  );
}

function isCachedSkillStatsEntry(value: unknown): value is SkillStatsEntry {
  return (
    isRecord(value) &&
    typeof value.skillKey === "string" &&
    typeof value.name === "string" &&
    typeof value.packageHash === "string" &&
    value.packageHashPolicyVersion === 2 &&
    typeof value.indexedCount === "number" &&
    typeof value.loadedCount === "number" &&
    typeof value.residentLoadCount === "number" &&
    typeof value.explicitLoadCount === "number" &&
    (value.firstEventAt === undefined ||
      typeof value.firstEventAt === "string") &&
    (value.lastEventAt === undefined ||
      typeof value.lastEventAt === "string") &&
    Array.isArray(value.sampleRunIds) &&
    value.sampleRunIds.every((runId) => typeof runId === "string") &&
    Array.isArray(value.failureRunIds) &&
    value.failureRunIds.every((runId) => typeof runId === "string") &&
    typeof value.loadFailureCount === "number" &&
    isRecord(value.loadFailures) &&
    typeof value.loadFailures.total === "number" &&
    isNumberRecord(value.loadFailures.byMode) &&
    isNumberRecord(value.loadFailures.byStatus) &&
    Array.isArray(value.runIds) &&
    value.runIds.every((runId) => typeof runId === "string") &&
    Array.isArray(value.sessionIds) &&
    value.sessionIds.every(
      (cachedSessionId) => typeof cachedSessionId === "string",
    ) &&
    isRecord(value.associatedRuns) &&
    typeof value.associatedRuns.completed === "number" &&
    typeof value.associatedRuns.failed === "number" &&
    typeof value.associatedRuns.cancelled === "number" &&
    isRecord(value.associatedToolFailures) &&
    typeof value.associatedToolFailures.total === "number" &&
    typeof value.associatedToolFailures.unresolved === "number" &&
    isNumberRecord(value.associatedToolFailures.byTool) &&
    isNumberRecord(value.associatedToolFailures.byCode) &&
    typeof value.associatedToolFailures.beforeFirstLoad === "number" &&
    typeof value.associatedToolFailures.afterFirstLoad === "number" &&
    isRecord(value.evolution) &&
    isRecord(value.evolution.proposals) &&
    isRecord(value.evolution.history)
  );
}

function isSkillStatsCatalog(value: unknown): value is SkillStatsCatalogV1 {
  return (
    isRecord(value) &&
    value.schemaVersion === CATALOG_SCHEMA_VERSION &&
    value.algorithmVersion === CATALOG_ALGORITHM_VERSION &&
    value.sessionProjectionAlgorithmVersion ===
      SESSION_PROJECTION_ALGORITHM_VERSION &&
    typeof value.sessionRootDir === "string" &&
    typeof value.sessionLimit === "number" &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isCatalogSessionRef) &&
    isRecord(value.skillKeys) &&
    Object.values(value.skillKeys).every(isCatalogSkillRef) &&
    isStringArrayRecord(value.skillNames) &&
    isStringArrayRecord(value.packageHashes) &&
    typeof value.computedAt === "string"
  );
}

function isCatalogSessionRef(
  value: unknown,
): value is SkillStatsCatalogSessionRef {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.traceFingerprints) &&
    value.traceFingerprints.every(isTraceFileFingerprint)
  );
}

function isCatalogSkillRef(value: unknown): value is SkillStatsCatalogSkillRef {
  return (
    isRecord(value) &&
    typeof value.skillKey === "string" &&
    typeof value.name === "string" &&
    (value.layer === undefined ||
      value.layer === "builtin" ||
      value.layer === "user" ||
      value.layer === "project" ||
      value.layer === "legacy" ||
      value.layer === UNKNOWN_LAYER) &&
    typeof value.packageHash === "string" &&
    value.packageHashPolicyVersion === 2 &&
    Array.isArray(value.sessionIds) &&
    value.sessionIds.every((sessionId) => typeof sessionId === "string") &&
    (value.firstEventAt === undefined ||
      typeof value.firstEventAt === "string") &&
    (value.lastEventAt === undefined || typeof value.lastEventAt === "string")
  );
}

async function writeSessionProjectionCache(
  path: string,
  projection: SkillStatsSessionProjectionV1,
  sessionId: string,
  projectionCache: SkillStatsProjectionCacheInfo,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
    projectionCache.writes += 1;
  } catch (error) {
    projectionCache.errors.push({
      sessionId,
      path,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function sessionProjectionCachePath(
  cacheDir: string,
  sessionId: string,
): string {
  return join(cacheDir, "sessions", `${safeCacheSegment(sessionId)}.json`);
}

function safeCacheSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function sameTraceFingerprints(
  left: readonly TraceFileFingerprint[],
  right: readonly TraceFileFingerprint[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sessionProjectionWindow(
  events: readonly SparkwrightEvent[],
): SessionProjectionWindow {
  let firstEventAt: string | undefined;
  let lastEventAt: string | undefined;
  const runIds = new Set<string>();
  const terminalRunIds = new Set<string>();
  for (const event of events) {
    firstEventAt = earliestIso(firstEventAt, event.timestamp);
    lastEventAt = latestIso(lastEventAt, event.timestamp);
    runIds.add(event.runId);
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      terminalRunIds.add(event.runId);
    }
  }
  return {
    ...(firstEventAt ? { firstEventAt } : {}),
    ...(lastEventAt ? { lastEventAt } : {}),
    runCount: runIds.size,
    terminalRunCount: terminalRunIds.size,
    openRunCount: Math.max(0, runIds.size - terminalRunIds.size),
  };
}

function mergeSessionProjection(
  byKey: Map<string, MutableSkillStatsEntry>,
  projection: SkillStatsSessionProjectionV1,
): void {
  for (const skill of projection.skills) {
    mergeSkillStatsEntry(byKey, skill);
  }
}

function mergeSkillStatsEntry(
  byKey: Map<string, MutableSkillStatsEntry>,
  source: SkillStatsEntry,
): void {
  const target = ensureEntry(byKey, identityFromStatsEntry(source));
  target.indexedCount += source.indexedCount;
  target.loadedCount += source.loadedCount;
  target.residentLoadCount += source.residentLoadCount;
  target.explicitLoadCount += source.explicitLoadCount;
  target.firstEventAt = earliestIso(target.firstEventAt, source.firstEventAt);
  target.lastEventAt = latestIso(target.lastEventAt, source.lastEventAt);
  for (const runId of source.sampleRunIds) {
    addBoundedSet(target.sampleRunIdSet, runId, DEFAULT_SKILL_SAMPLE_LIMIT);
  }
  for (const runId of source.failureRunIds) {
    addBoundedSet(target.failureRunIdSet, runId, DEFAULT_SKILL_SAMPLE_LIMIT);
  }
  target.loadFailureCount += source.loadFailureCount;
  target.loadFailures.total += source.loadFailures.total;
  mergeRecordCounts(target.loadFailures.byMode, source.loadFailures.byMode);
  mergeRecordCounts(target.loadFailures.byStatus, source.loadFailures.byStatus);

  for (const runId of source.runIds) target.runIdSet.add(runId);
  for (const sessionId of source.sessionIds) target.sessionIdSet.add(sessionId);

  target.associatedRuns.completed += source.associatedRuns.completed;
  target.associatedRuns.failed += source.associatedRuns.failed;
  target.associatedRuns.cancelled += source.associatedRuns.cancelled;
  target.associatedToolFailures.total += source.associatedToolFailures.total;
  target.associatedToolFailures.unresolved +=
    source.associatedToolFailures.unresolved;
  target.associatedToolFailures.beforeFirstLoad +=
    source.associatedToolFailures.beforeFirstLoad;
  target.associatedToolFailures.afterFirstLoad +=
    source.associatedToolFailures.afterFirstLoad;
  mergeRecordCounts(
    target.associatedToolFailures.byTool,
    source.associatedToolFailures.byTool,
  );
  mergeRecordCounts(
    target.associatedToolFailures.byCode,
    source.associatedToolFailures.byCode,
  );

  const targetProposals = target.evolution.proposals;
  const sourceProposals = source.evolution.proposals;
  targetProposals.total += sourceProposals.total;
  targetProposals.asBase += sourceProposals.asBase;
  targetProposals.asAfter += sourceProposals.asAfter;
  mergeRecordCounts(targetProposals.byState, sourceProposals.byState);
  mergeRecordCounts(targetProposals.byKind, sourceProposals.byKind);
  targetProposals.ids = sortedUnique([
    ...targetProposals.ids,
    ...sourceProposals.ids,
  ]);
  targetProposals.latestCreatedAt = latestIso(
    targetProposals.latestCreatedAt,
    sourceProposals.latestCreatedAt,
  );
  targetProposals.latestClosedAt = latestIso(
    targetProposals.latestClosedAt,
    sourceProposals.latestClosedAt,
  );

  const targetHistory = target.evolution.history;
  const sourceHistory = source.evolution.history;
  targetHistory.total += sourceHistory.total;
  targetHistory.asBefore += sourceHistory.asBefore;
  targetHistory.asAfter += sourceHistory.asAfter;
  mergeRecordCounts(targetHistory.byKind, sourceHistory.byKind);
  targetHistory.ids = sortedUnique([
    ...targetHistory.ids,
    ...sourceHistory.ids,
  ]);
  targetHistory.latestCreatedAt = latestIso(
    targetHistory.latestCreatedAt,
    sourceHistory.latestCreatedAt,
  );

  if (source.shadowedBy && !target.shadowedBy)
    target.shadowedBy = source.shadowedBy;
  if (source.shadows && source.shadows.length > 0) {
    target.shadows = sortedUnique([
      ...(target.shadows ?? []),
      ...source.shadows,
    ]);
  }
}

function mergeTraceWindow(
  window: MutableTraceWindow,
  projection: SessionProjectionWindow,
): void {
  if (projection.firstEventAt) {
    window.firstEventAt = earliestIso(
      window.firstEventAt,
      projection.firstEventAt,
    );
  }
  if (projection.lastEventAt) {
    window.lastEventAt = latestIso(window.lastEventAt, projection.lastEventAt);
  }
  window.runCount += projection.runCount;
  window.terminalRunCount += projection.terminalRunCount;
  window.openRunCount += projection.openRunCount;
}

async function applyEvolutionRollup(
  byKey: Map<string, MutableSkillStatsEntry>,
  workspaceRoot: string,
): Promise<EvolutionRollupResult> {
  const proposals = await listSkillProposals(workspaceRoot);
  const result: EvolutionRollupResult = {
    proposalsScanned: proposals.length,
    historyScanned: 0,
  };
  for (const proposal of proposals) {
    recordProposalRollup(byKey, proposal);
    result.firstCreatedAt = earliestIso(
      result.firstCreatedAt,
      proposal.createdAt,
    );
    result.lastCreatedAt = latestIso(result.lastCreatedAt, proposal.createdAt);
    if (proposal.closedAt) {
      result.lastClosedAt = latestIso(result.lastClosedAt, proposal.closedAt);
    }
  }

  const historyNames = sortedUnique([
    ...[...byKey.values()].map((entry) => entry.name),
    ...proposals.map((proposal) => proposal.skillName),
  ]);
  for (const skillName of historyNames) {
    const history = await listSkillHistory(workspaceRoot, skillName).catch(
      () => [],
    );
    result.historyScanned += history.length;
    for (const entry of history) {
      recordHistoryRollup(byKey, entry);
      result.firstCreatedAt = earliestIso(
        result.firstCreatedAt,
        entry.createdAt,
      );
      result.lastCreatedAt = latestIso(result.lastCreatedAt, entry.createdAt);
    }
  }
  return result;
}

function recordProposalRollup(
  byKey: Map<string, MutableSkillStatsEntry>,
  proposal: SkillProposalSummary,
): void {
  for (const entry of entriesByName(byKey, proposal.skillName)) {
    if (!entry.packageHash) continue;
    const asBase = proposal.basePackageHash === entry.packageHash;
    const asAfter = proposal.afterPackageHash === entry.packageHash;
    if (!asBase && !asAfter) continue;

    const rollup = entry.evolution.proposals;
    if (!rollup.ids.includes(proposal.id)) {
      rollup.ids.push(proposal.id);
      rollup.total += 1;
      incrementRecord(rollup.byState, proposal.state);
      incrementRecord(rollup.byKind, proposal.kind);
      rollup.latestCreatedAt = latestIso(
        rollup.latestCreatedAt,
        proposal.createdAt,
      );
      if (proposal.closedAt) {
        rollup.latestClosedAt = latestIso(
          rollup.latestClosedAt,
          proposal.closedAt,
        );
      }
    }
    if (asBase) rollup.asBase += 1;
    if (asAfter) rollup.asAfter += 1;
  }
}

function recordHistoryRollup(
  byKey: Map<string, MutableSkillStatsEntry>,
  history: SkillHistoryEntry,
): void {
  for (const entry of entriesByName(byKey, history.skillName)) {
    if (!entry.packageHash) continue;
    const asBefore = history.beforePackageHash === entry.packageHash;
    const asAfter = history.afterPackageHash === entry.packageHash;
    if (!asBefore && !asAfter) continue;

    const rollup = entry.evolution.history;
    if (!rollup.ids.includes(history.id)) {
      rollup.ids.push(history.id);
      rollup.total += 1;
      incrementRecord(rollup.byKind, history.kind);
      rollup.latestCreatedAt = latestIso(
        rollup.latestCreatedAt,
        history.createdAt,
      );
    }
    if (asBefore) rollup.asBefore += 1;
    if (asAfter) rollup.asAfter += 1;
  }
}

function collectTraceStats(
  byKey: Map<string, MutableSkillStatsEntry>,
  events: readonly SparkwrightEvent[],
  fallbackSessionId?: string,
): void {
  const runs = new Map<string, RunStats>();

  for (const [index, event] of events.entries()) {
    const run = ensureRun(runs, event, fallbackSessionId);
    const order = eventOrder(event, index);
    if (event.type === "skill.indexed") {
      collectSkillIndexed(byKey, run, event);
      continue;
    }
    if (event.type === "skill.failed") {
      collectSkillFailed(byKey, run, event);
      continue;
    }
    if (event.type === "skill.loaded") {
      collectSkillLoaded(byKey, run, event, order);
      continue;
    }
    if (event.type === "tool.failed") {
      collectToolFailed(run, event, order);
      continue;
    }
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      run.terminal = event.type.replace("run.", "") as RunStats["terminal"];
      run.terminalTimestamp = event.timestamp;
      const unresolved = unresolvedToolFailureTotal(event);
      if (unresolved !== undefined) run.unresolvedToolFailureTotal = unresolved;
    }
  }

  for (const run of runs.values()) {
    for (const loaded of run.loadedBySkillKey.values()) {
      const entry = ensureEntry(byKey, loaded.identity);
      if (run.terminal) entry.associatedRuns[run.terminal] += 1;
      entry.associatedToolFailures.unresolved += run.unresolvedToolFailureTotal;
      for (const failure of run.toolFailures) {
        recordSkillEvent(entry, run, failure.timestamp, true);
        entry.associatedToolFailures.total += 1;
        if (failure.order < loaded.firstLoadOrder) {
          entry.associatedToolFailures.beforeFirstLoad += 1;
        } else {
          entry.associatedToolFailures.afterFirstLoad += 1;
        }
        if (failure.toolName) {
          incrementRecord(
            entry.associatedToolFailures.byTool,
            failure.toolName,
          );
        }
        if (failure.code) {
          incrementRecord(entry.associatedToolFailures.byCode, failure.code);
        }
      }
      if (run.unresolvedToolFailureTotal > 0 && run.terminalTimestamp) {
        recordSkillEvent(entry, run, run.terminalTimestamp, true);
      }
      if (
        (run.terminal === "failed" || run.terminal === "cancelled") &&
        run.terminalTimestamp
      ) {
        recordSkillEvent(entry, run, run.terminalTimestamp, true);
      }
    }
  }
}

function collectSkillIndexed(
  byKey: Map<string, MutableSkillStatsEntry>,
  run: RunStats,
  event: SparkwrightEvent,
): void {
  // The skill list rides on the event metadata; the payload only carries a
  // `count`. (See the emitter in @sparkwright/skills.)
  if (!Array.isArray(event.metadata.skills)) return;
  for (const rawSkill of event.metadata.skills) {
    if (!isRecord(rawSkill) || typeof rawSkill.name !== "string") continue;
    const identity = identityFromRawSkill(rawSkill);
    if (!identity) continue;
    run.indexedByName.set(identity.name, identity);
    const entry = ensureEntry(byKey, identity);
    entry.indexedCount += 1;
    recordRunAndSession(entry, run);
    recordSkillEvent(entry, run, event.timestamp);
  }
}

function collectSkillFailed(
  byKey: Map<string, MutableSkillStatsEntry>,
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

  const identity = identityForNamedEvent(name, event, run, source);
  if (!identity) return;
  const entry = ensureEntry(byKey, identity);
  const mode = stringValue(event.metadata.mode) ?? "unknown";
  const status = stringValue(event.payload.status) ?? "load_failed";
  recordLoadFailure(entry, mode, status);
  if (mode === "on_demand_tool") entry.explicitLoadCount += 1;
  recordRunAndSession(entry, run);
  recordSkillEvent(entry, run, event.timestamp, true);
}

function collectSkillLoaded(
  byKey: Map<string, MutableSkillStatsEntry>,
  run: RunStats,
  event: SparkwrightEvent,
  order: number,
): void {
  if (!isRecord(event.payload)) return;
  const name = stringValue(event.payload.name);
  if (!name) return;

  const identity = identityForNamedEvent(name, event, run);
  if (!identity) return;
  const entry = ensureEntry(byKey, identity);
  const mode = stringValue(event.metadata.mode) ?? "unknown";
  entry.loadedCount += 1;
  if (mode === "on_demand_tool") entry.explicitLoadCount += 1;
  if (mode === "resident_context") entry.residentLoadCount += 1;
  recordRunAndSession(entry, run);
  recordSkillEvent(entry, run, event.timestamp);

  const existing = run.loadedBySkillKey.get(entry.skillKey);
  if (!existing || order < existing.firstLoadOrder) {
    run.loadedBySkillKey.set(entry.skillKey, {
      identity,
      firstLoadOrder: order,
    });
  }
}

function collectToolFailed(
  run: RunStats,
  event: SparkwrightEvent,
  order: number,
): void {
  if (!isRecord(event.payload)) return;
  const toolName =
    stringValue(event.payload.toolName) ?? stringValue(event.payload.name);
  const code = toolFailureCode(event.payload);
  run.toolFailures.push({
    order,
    timestamp: event.timestamp,
    ...(toolName ? { toolName } : {}),
    ...(code ? { code } : {}),
  });
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
      indexedByName: new Map(),
      loadedBySkillKey: new Map(),
      toolFailures: [],
      unresolvedToolFailureTotal: 0,
    };
    runs.set(event.runId, run);
  } else if (!run.sessionId) {
    run.sessionId = stringValue(event.metadata.sessionId) ?? fallbackSessionId;
  }
  return run;
}

function applyCurrentSkillReport(
  byKey: Map<string, MutableSkillStatsEntry>,
  skills: readonly SkillReportEntry[],
  shadows: readonly {
    shadowed: SkillReportEntry;
    shadowedBy: SkillReportEntry;
  }[],
): void {
  for (const skill of skills) {
    const entries = entriesByName(byKey, skill.name);
    if (entries.length === 0) {
      ensureEntry(byKey, identityFromReportEntry(skill));
      continue;
    }
    for (const entry of entries) {
      if (!entry.layer && skill.layer) entry.layer = skill.layer;
      if (!entry.sourcePath && skill.source) entry.sourcePath = skill.source;
    }
  }

  for (const shadow of shadows) {
    const effective = entriesByName(byKey, shadow.shadowedBy.name);
    const targets =
      effective.length > 0
        ? effective
        : [ensureEntry(byKey, identityFromReportEntry(shadow.shadowedBy))];
    for (const entry of targets) {
      entry.shadows = sortedUnique([
        ...(entry.shadows ?? []),
        formatSkillOrigin(shadow.shadowed),
      ]);
      entry.shadowedBy = formatSkillOrigin(shadow.shadowedBy);
    }
  }
}

function ensureEntry(
  byKey: Map<string, MutableSkillStatsEntry>,
  identity: SkillIdentity,
): MutableSkillStatsEntry {
  const key = skillKey(identity);
  let entry = byKey.get(key);
  if (!entry) {
    entry = {
      skillKey: key,
      name: identity.name,
      ...(identity.layer ? { layer: identity.layer } : {}),
      ...(identity.sourcePath ? { sourcePath: identity.sourcePath } : {}),
      packageHash: identity.packageHash,
      packageHashPolicyVersion: identity.packageHashPolicyVersion,
      sampleRunIds: [],
      failureRunIds: [],
      indexedCount: 0,
      loadedCount: 0,
      residentLoadCount: 0,
      explicitLoadCount: 0,
      loadFailureCount: 0,
      loadFailures: { total: 0, byMode: {}, byStatus: {} },
      runIds: [],
      sessionIds: [],
      associatedRuns: { completed: 0, failed: 0, cancelled: 0 },
      associatedToolFailures: {
        total: 0,
        unresolved: 0,
        byTool: {},
        byCode: {},
        beforeFirstLoad: 0,
        afterFirstLoad: 0,
      },
      evolution: {
        proposals: {
          total: 0,
          asBase: 0,
          asAfter: 0,
          byState: {},
          byKind: {},
          ids: [],
        },
        history: {
          total: 0,
          asBefore: 0,
          asAfter: 0,
          byKind: {},
          ids: [],
        },
      },
      runIdSet: new Set(),
      sessionIdSet: new Set(),
      sampleRunIdSet: new Set(),
      failureRunIdSet: new Set(),
    };
    byKey.set(key, entry);
  }
  if (identity.layer && !entry.layer) entry.layer = identity.layer;
  if (identity.sourcePath && !entry.sourcePath)
    entry.sourcePath = identity.sourcePath;
  return entry;
}

function recordLoadFailure(
  entry: MutableSkillStatsEntry,
  mode: string,
  status: string,
): void {
  entry.loadFailureCount += 1;
  entry.loadFailures.total += 1;
  incrementRecord(entry.loadFailures.byMode, mode);
  incrementRecord(entry.loadFailures.byStatus, status);
}

function recordRunAndSession(
  entry: MutableSkillStatsEntry,
  run: RunStats,
): void {
  entry.runIdSet.add(run.runId);
  if (run.sessionId) entry.sessionIdSet.add(run.sessionId);
}

function recordSkillEvent(
  entry: MutableSkillStatsEntry,
  run: RunStats,
  timestamp: string,
  failure = false,
): void {
  entry.firstEventAt = earliestIso(entry.firstEventAt, timestamp);
  entry.lastEventAt = latestIso(entry.lastEventAt, timestamp);
  addBoundedSet(entry.sampleRunIdSet, run.runId, DEFAULT_SKILL_SAMPLE_LIMIT);
  if (failure) {
    addBoundedSet(entry.failureRunIdSet, run.runId, DEFAULT_SKILL_SAMPLE_LIMIT);
  }
}

function finalizeEntry(entry: MutableSkillStatsEntry): SkillStatsEntry {
  return {
    skillKey: entry.skillKey,
    name: entry.name,
    ...(entry.layer ? { layer: entry.layer } : {}),
    ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}),
    packageHash: entry.packageHash,
    packageHashPolicyVersion: entry.packageHashPolicyVersion,
    ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy } : {}),
    ...(entry.shadows && entry.shadows.length > 0
      ? { shadows: sortedUnique(entry.shadows) }
      : {}),
    ...(entry.firstEventAt ? { firstEventAt: entry.firstEventAt } : {}),
    ...(entry.lastEventAt ? { lastEventAt: entry.lastEventAt } : {}),
    sampleRunIds: [...entry.sampleRunIdSet],
    failureRunIds: [...entry.failureRunIdSet],
    indexedCount: entry.indexedCount,
    loadedCount: entry.loadedCount,
    residentLoadCount: entry.residentLoadCount,
    explicitLoadCount: entry.explicitLoadCount,
    loadFailureCount: entry.loadFailureCount,
    loadFailures: {
      total: entry.loadFailures.total,
      byMode: sortRecord(entry.loadFailures.byMode),
      byStatus: sortRecord(entry.loadFailures.byStatus),
    },
    runIds: [...entry.runIdSet].sort(),
    sessionIds: [...entry.sessionIdSet].sort(),
    associatedRuns: { ...entry.associatedRuns },
    associatedToolFailures: {
      total: entry.associatedToolFailures.total,
      unresolved: entry.associatedToolFailures.unresolved,
      byTool: sortRecord(entry.associatedToolFailures.byTool),
      byCode: sortRecord(entry.associatedToolFailures.byCode),
      beforeFirstLoad: entry.associatedToolFailures.beforeFirstLoad,
      afterFirstLoad: entry.associatedToolFailures.afterFirstLoad,
    },
    evolution: {
      proposals: {
        total: entry.evolution.proposals.total,
        asBase: entry.evolution.proposals.asBase,
        asAfter: entry.evolution.proposals.asAfter,
        byState: sortRecord(entry.evolution.proposals.byState),
        byKind: sortRecord(entry.evolution.proposals.byKind),
        ids: sortedUnique(entry.evolution.proposals.ids),
        ...(entry.evolution.proposals.latestCreatedAt
          ? { latestCreatedAt: entry.evolution.proposals.latestCreatedAt }
          : {}),
        ...(entry.evolution.proposals.latestClosedAt
          ? { latestClosedAt: entry.evolution.proposals.latestClosedAt }
          : {}),
      },
      history: {
        total: entry.evolution.history.total,
        asBefore: entry.evolution.history.asBefore,
        asAfter: entry.evolution.history.asAfter,
        byKind: sortRecord(entry.evolution.history.byKind),
        ids: sortedUnique(entry.evolution.history.ids),
        ...(entry.evolution.history.latestCreatedAt
          ? { latestCreatedAt: entry.evolution.history.latestCreatedAt }
          : {}),
      },
    },
  };
}

function analyzeSkillStats(
  skills: readonly SkillStatsEntry[],
): SkillStatsFinding[] {
  const findings: SkillStatsFinding[] = [];
  for (const skill of skills) {
    const baseEvidence = () => ({
      runIds: skill.runIds,
      sessionIds: skill.sessionIds,
    });
    if (skill.loadFailures.total > 0) {
      findings.push({
        code: "SKILL_LOAD_FAILURES",
        severity: "warning",
        relation: "observed",
        skillKey: skill.skillKey,
        skillName: skill.name,
        packageHash: skill.packageHash,
        message: "Skill load failures were observed in the scanned evidence.",
        evidence: {
          ...baseEvidence(),
          metrics: {
            total: skill.loadFailures.total,
            modes: formatMetricCounts(skill.loadFailures.byMode),
            statuses: formatMetricCounts(skill.loadFailures.byStatus),
          },
        },
      });
    }
    if (skill.associatedToolFailures.total > 0) {
      findings.push({
        code: "ASSOCIATED_TOOL_FAILURES",
        severity: "info",
        relation: "associated",
        skillKey: skill.skillKey,
        skillName: skill.name,
        packageHash: skill.packageHash,
        message:
          "Tool failures occurred in runs that loaded this skill; this is an associated signal, not a causal claim.",
        evidence: {
          ...baseEvidence(),
          metrics: {
            total: skill.associatedToolFailures.total,
            unresolved: skill.associatedToolFailures.unresolved,
            beforeFirstLoad: skill.associatedToolFailures.beforeFirstLoad,
            afterFirstLoad: skill.associatedToolFailures.afterFirstLoad,
            tools: formatMetricCounts(skill.associatedToolFailures.byTool),
            codes: formatMetricCounts(skill.associatedToolFailures.byCode),
          },
        },
      });
    }
    const evolutionTotal =
      skill.evolution.proposals.total + skill.evolution.history.total;
    if (evolutionTotal > 0) {
      findings.push({
        code: "SKILL_EVOLUTION_ACTIVITY",
        severity: "info",
        relation: "observed",
        skillKey: skill.skillKey,
        skillName: skill.name,
        packageHash: skill.packageHash,
        message:
          "Skill evolution proposals or history entries reference this package version.",
        evidence: {
          ...baseEvidence(),
          metrics: {
            proposals: skill.evolution.proposals.total,
            history: skill.evolution.history.total,
          },
        },
      });
    }
  }
  return findings.sort(compareSkillStatsFindings);
}

function compareSkillStatsFindings(
  left: SkillStatsFinding,
  right: SkillStatsFinding,
): number {
  const severityOrder: Record<SkillStatsFindingSeverity, number> = {
    warning: 0,
    info: 1,
  };
  return (
    severityOrder[left.severity] - severityOrder[right.severity] ||
    left.skillName.localeCompare(right.skillName) ||
    left.code.localeCompare(right.code) ||
    left.skillKey.localeCompare(right.skillKey)
  );
}

function identityFromStatsEntry(entry: SkillStatsEntry): SkillIdentity {
  return {
    name: entry.name,
    ...(entry.layer ? { layer: entry.layer } : {}),
    ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}),
    packageHash: entry.packageHash,
    packageHashPolicyVersion: entry.packageHashPolicyVersion,
  };
}

function skillStatsTarget(
  options: SkillStatsOptions,
): SkillStatsTarget | undefined {
  if (!options.skillName && !options.skillKey && !options.packageHash) {
    return undefined;
  }
  return {
    ...(options.skillName ? { skillName: options.skillName } : {}),
    ...(options.skillKey ? { skillKey: options.skillKey } : {}),
    ...(options.packageHash ? { packageHash: options.packageHash } : {}),
  };
}

function matchesSkillStatsTarget(
  entry: SkillStatsEntry,
  target: SkillStatsTarget | undefined,
): boolean {
  if (!target) return true;
  if (target.skillName && entry.name !== target.skillName) return false;
  if (target.skillKey && entry.skillKey !== target.skillKey) return false;
  if (target.packageHash && entry.packageHash !== target.packageHash) {
    return false;
  }
  return true;
}

function identityFromRawSkill(
  rawSkill: Record<string, unknown>,
): SkillIdentity | undefined {
  const name = String(rawSkill.name);
  const sourcePath = stringValue(rawSkill.sourcePath);
  const packageHash = stringValue(rawSkill.packageHash);
  const layer = skillLayer(rawSkill.layer);
  if (!packageHash || rawSkill.packageHashPolicyVersion !== 2) return undefined;
  return {
    name,
    ...(layer ? { layer } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    packageHash,
    packageHashPolicyVersion: 2,
  };
}

function identityForNamedEvent(
  name: string,
  event: SparkwrightEvent,
  run: RunStats,
  sourcePath?: string,
): SkillIdentity | undefined {
  const packageHash = stringValue(event.metadata.packageHash);
  const layer = skillLayer(event.metadata.layer);
  const indexed = run.indexedByName.get(name);
  if (packageHash && event.metadata.packageHashPolicyVersion === 2) {
    if (indexed?.packageHash === packageHash) {
      return {
        ...indexed,
        ...(layer && !indexed.layer ? { layer } : {}),
        ...(sourcePath && !indexed.sourcePath ? { sourcePath } : {}),
      };
    }
    return {
      name,
      ...(layer ? { layer } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      packageHash,
      packageHashPolicyVersion: 2,
    };
  }

  if (indexed) {
    return {
      ...indexed,
      ...(sourcePath && !indexed.sourcePath ? { sourcePath } : {}),
    };
  }

  return undefined;
}

function identityFromReportEntry(skill: SkillReportEntry): SkillIdentity {
  return {
    name: skill.name,
    ...(skill.layer ? { layer: skill.layer } : { layer: UNKNOWN_LAYER }),
    ...(skill.source ? { sourcePath: skill.source } : {}),
    packageHash: skill.packageHash,
    packageHashPolicyVersion: skill.packageHashPolicyVersion,
  };
}

function skillKey(identity: SkillIdentity): string {
  const layer = identity.layer ?? UNKNOWN_LAYER;
  return `skill|${layer}|${identity.name}|v${identity.packageHashPolicyVersion}|${identity.packageHash}`;
}

function entriesByName(
  byKey: Map<string, MutableSkillStatsEntry>,
  name: string,
): MutableSkillStatsEntry[] {
  return [...byKey.values()].filter((entry) => entry.name === name);
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

function toolFailureCode(payload: Record<string, unknown>): string | undefined {
  if (isRecord(payload.error)) {
    const nested = stringValue(payload.error.code);
    if (nested) return nested;
  }
  return stringValue(payload.errorCode);
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

function eventOrder(event: SparkwrightEvent, index: number): number {
  return typeof event.sequence === "number" && Number.isFinite(event.sequence)
    ? event.sequence
    : index + 1;
}

function compareSkillEntries(
  left: SkillStatsEntry,
  right: SkillStatsEntry,
): number {
  return (
    left.name.localeCompare(right.name) ||
    (left.layer ?? "").localeCompare(right.layer ?? "") ||
    left.skillKey.localeCompare(right.skillKey)
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortStringArrayRecord(
  input: Record<string, readonly string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, values]) => [key, sortedUnique(values)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sortRecord(input: Record<string, number>): Record<string, number>;
function sortRecord<T extends string>(
  input: Partial<Record<T, number>>,
): Partial<Record<T, number>>;
function sortRecord(
  input: Record<string, number | undefined>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function formatMetricCounts(input: Record<string, number>): string;
function formatMetricCounts<T extends string>(
  input: Partial<Record<T, number>>,
): string;
function formatMetricCounts(input: Record<string, number | undefined>): string {
  const entries = Object.entries(sortRecord(input));
  return entries.length > 0
    ? entries.map(([key, count]) => `${key}=${count}`).join(", ")
    : "none";
}

function mergeRecordCounts(
  target: Record<string, number>,
  source: Record<string, number>,
): void;
function mergeRecordCounts<T extends string>(
  target: Partial<Record<T, number>>,
  source: Partial<Record<T, number>>,
): void;
function mergeRecordCounts(
  target: Record<string, number | undefined>,
  source: Record<string, number | undefined>,
): void {
  for (const [key, count] of Object.entries(source)) {
    if (typeof count !== "number") continue;
    target[key] = (target[key] ?? 0) + count;
  }
}

function addBoundedSet(set: Set<string>, value: string, limit: number): void {
  if (set.has(value) || set.size < limit) set.add(value);
}

function incrementRecord(record: Record<string, number>, key: string): void;
function incrementRecord<T extends string>(
  record: Partial<Record<T, number>>,
  key: T,
): void;
function incrementRecord(
  record: Record<string, number | undefined>,
  key: string,
): void {
  record[key] = (record[key] ?? 0) + 1;
}

function earliestIso(current: string | undefined, candidate: string): string;
function earliestIso(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined;
function earliestIso(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  if (!candidate) return current;
  return !current || candidate.localeCompare(current) < 0 ? candidate : current;
}

function latestIso(current: string | undefined, candidate: string): string;
function latestIso(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined;
function latestIso(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  if (!candidate) return current;
  return !current || candidate.localeCompare(current) > 0 ? candidate : current;
}

function sameCatalogSessions(
  left: readonly SkillStatsCatalogSessionRef[],
  right: readonly SkillStatsCatalogSessionRef[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function skillLayer(value: unknown): SkillRoot["layer"] | undefined {
  return value === "builtin" ||
    value === "user" ||
    value === "project" ||
    value === "legacy"
    ? value
    : undefined;
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "number")
  );
}

function isStringArrayRecord(
  value: unknown,
): value is Record<string, string[]> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        Array.isArray(entry) && entry.every((item) => typeof item === "string"),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
