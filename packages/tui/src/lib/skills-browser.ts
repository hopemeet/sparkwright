import {
  collectSkillStats,
  existingSkillRoots,
  loadHostConfig,
  loadLayeredSkillReport,
  resolveSkillRootsForRuntime,
  type SkillReport,
  type SkillReportEntry,
  type SkillStatsEntry,
  type SkillStatsReport,
} from "@sparkwright/host";

export interface TuiSkillBrowserEntry {
  name: string;
  description: string;
  layer: string;
  sourcePath?: string;
  packageHash: string;
  loadedCount: number;
  explicitLoadCount: number;
  residentLoadCount: number;
  loadFailureCount: number;
  associatedRuns: {
    completed: number;
    failed: number;
    cancelled: number;
  };
  relatedToolFailures: {
    total: number;
    unresolved: number;
  };
}

export interface TuiSkillsBrowserSnapshot {
  sessionsScanned: number;
  sessionLimit: number;
  computedAt: string;
  inventoryIssueCount: number;
  traceIssueCount: number;
  skills: TuiSkillBrowserEntry[];
}

export async function loadTuiSkillsBrowser(
  workspaceRoot: string,
  sessionRootDir: string,
  sessionLimit = 20,
): Promise<TuiSkillsBrowserSnapshot> {
  const loaded = await loadHostConfig(workspaceRoot, process.env);
  const configuredRoots = loaded.config.capabilities?.skills?.roots;
  const resolvedRoots = resolveSkillRootsForRuntime(
    workspaceRoot,
    configuredRoots,
    process.env,
  );
  const roots =
    configuredRoots && configuredRoots.length > 0
      ? resolvedRoots
      : await existingSkillRoots(resolvedRoots);

  const [report, stats] = await Promise.all([
    loadLayeredSkillReport(roots, { includeMissingRoots: "configured" }),
    collectSkillStats({
      workspaceRoot,
      sessionRootDir,
      skillRoots: roots,
      limit: sessionLimit,
    }),
  ]);

  return buildTuiSkillsBrowserSnapshot({ report, stats });
}

export function buildTuiSkillsBrowserSnapshot(input: {
  report: SkillReport;
  stats: SkillStatsReport;
}): TuiSkillsBrowserSnapshot {
  const statsByIdentity = new Map(
    input.stats.skills.map((entry) => [statsIdentity(entry), entry] as const),
  );

  return {
    sessionsScanned: input.stats.sessionsScanned,
    sessionLimit: input.stats.sessionLimit,
    computedAt: input.stats.freshness.computedAt,
    inventoryIssueCount: input.report.errors.length,
    traceIssueCount: input.stats.traceErrors.length,
    skills: input.report.skills.map((skill) => {
      const stats = statsByIdentity.get(reportIdentity(skill));
      return toBrowserEntry(skill, stats);
    }),
  };
}

function toBrowserEntry(
  skill: SkillReportEntry,
  stats: SkillStatsEntry | undefined,
): TuiSkillBrowserEntry {
  return {
    name: skill.name,
    description: skill.description,
    layer: skill.layer ?? "unknown",
    ...(skill.source ? { sourcePath: skill.source } : {}),
    packageHash: skill.packageHash,
    loadedCount: stats?.loadedCount ?? 0,
    explicitLoadCount: stats?.explicitLoadCount ?? 0,
    residentLoadCount: stats?.residentLoadCount ?? 0,
    loadFailureCount: stats?.loadFailures.total ?? 0,
    associatedRuns: stats?.associatedRuns ?? {
      completed: 0,
      failed: 0,
      cancelled: 0,
    },
    relatedToolFailures: {
      total: stats?.associatedToolFailures.total ?? 0,
      unresolved: stats?.associatedToolFailures.unresolved ?? 0,
    },
  };
}

function reportIdentity(skill: SkillReportEntry): string {
  return identityKey(skill.name, skill.layer, skill.packageHash);
}

function statsIdentity(skill: SkillStatsEntry): string {
  return identityKey(skill.name, skill.layer, skill.packageHash);
}

function identityKey(
  name: string,
  layer: string | undefined,
  packageHash: string,
): string {
  return `${name}\u0000${layer ?? "unknown"}\u0000${packageHash}`;
}
