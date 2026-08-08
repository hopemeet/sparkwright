import { describe, expect, it } from "vitest";
import type {
  SkillReport,
  SkillStatsEntry,
  SkillStatsReport,
} from "@sparkwright/host";
import { buildTuiSkillsBrowserSnapshot } from "../src/lib/skills-browser.js";

describe("skills browser projection", () => {
  it("joins recent usage to the current package identity", () => {
    const report: SkillReport = {
      roots: ["/work/.sparkwright/skills"],
      shadows: [],
      errors: [],
      skills: [
        {
          name: "demo-skill",
          description: "Current demo Skill.",
          layer: "project",
          root: "/work/.sparkwright/skills",
          source: "/work/.sparkwright/skills/demo-skill/SKILL.md",
          packageHash: "sha256:current",
          packageHashPolicyVersion: 2,
        },
      ],
    };
    const stats = statsReport([
      statsEntry("sha256:old", 99),
      statsEntry("sha256:current", 5),
    ]);
    const snapshot = buildTuiSkillsBrowserSnapshot({
      report,
      stats,
    });

    expect(snapshot.sessionsScanned).toBe(12);
    expect(snapshot.skills).toEqual([
      expect.objectContaining({
        name: "demo-skill",
        layer: "project",
        loadedCount: 5,
        explicitLoadCount: 4,
        residentLoadCount: 1,
      }),
    ]);
  });
});

function statsReport(skills: SkillStatsEntry[]): SkillStatsReport {
  return {
    workspaceRoot: "/work",
    sessionRootDir: "/work/.sparkwright/sessions",
    sessionLimit: 20,
    query: {
      scope: "human_diagnostics",
      sessionLimit: 20,
      includeResidentLoads: true,
      includeExplicitLoads: true,
      useProjectionCache: true,
    },
    window: {
      trace: {
        sessionLimit: 20,
        sessionsScanned: 12,
        runCount: 8,
        terminalRunCount: 8,
        openRunCount: 0,
      },
    },
    freshness: { computedAt: "2026-08-01T00:00:00.000Z" },
    projectionCache: {
      enabled: true,
      cacheDir: "/work/.sparkwright/skill-stats",
      hits: 12,
      misses: 0,
      writes: 0,
      errors: [],
    },
    catalog: {
      enabled: true,
      used: false,
      path: "/work/.sparkwright/skill-stats/catalog.json",
      candidateSessions: 12,
      selectedSessions: 12,
      hits: 0,
      misses: 0,
      writes: 0,
      errors: [],
    },
    sessionsScanned: 12,
    tracesScanned: 12,
    traceErrors: [],
    findings: [],
    skills,
  };
}

function statsEntry(packageHash: string, loadedCount: number): SkillStatsEntry {
  return {
    skillKey: `skill|project|demo-skill|v2|${packageHash}`,
    name: "demo-skill",
    layer: "project",
    packageHash,
    packageHashPolicyVersion: 2,
    sampleRunIds: [],
    failureRunIds: [],
    indexedCount: 10,
    loadedCount,
    explicitLoadCount: Math.max(0, loadedCount - 1),
    residentLoadCount: loadedCount > 0 ? 1 : 0,
    loadFailures: { total: 0, byMode: {}, byStatus: {} },
    runIds: [],
    sessionIds: [],
    associatedRuns: { completed: 4, failed: 0, cancelled: 1 },
    associatedToolFailures: {
      total: 3,
      unresolved: 1,
      byTool: { bash: 3 },
      byCode: {},
      beforeFirstLoad: 0,
      afterFirstLoad: 3,
    },
  };
}
