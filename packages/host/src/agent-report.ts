import type { AgentMode, AgentProfile } from "@sparkwright/agent-runtime";
import { resolveCapabilityDirs, type CapabilityLayer } from "./layers.js";
import { discoverAgentProfileFileEntriesInDir } from "./agent-profiles.js";

export type AgentReportLayer = CapabilityLayer | "config";

export interface AgentReportEntry {
  id: string;
  name?: string;
  mode?: AgentMode;
  layer: AgentReportLayer;
  root?: string;
  source?: string;
}

export interface AgentShadowDiagnostic {
  id: string;
  shadowed: AgentReportEntry;
  shadowedBy: AgentReportEntry;
}

/**
 * Two profiles in the *same* layer resolve to the same id (an ambiguous
 * basename collision, e.g. `review/foo.md` and `audit/foo.md`). Unlike a
 * cross-layer shadow this is not legitimate layering: discovery fails closed
 * (keeps the first, drops the rest) and surfaces it here.
 */
export interface AgentCollisionDiagnostic {
  id: string;
  kept: AgentReportEntry;
  dropped: AgentReportEntry;
}

export interface AgentReport {
  roots: string[];
  profiles: AgentReportEntry[];
  shadows: AgentShadowDiagnostic[];
  collisions: AgentCollisionDiagnostic[];
  errors: Array<{ source: string; message: string }>;
}

export async function loadLayeredAgentReport(
  workspaceRoot: string,
  configProfiles: readonly AgentProfile[] | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<AgentReport> {
  const roots = resolveCapabilityDirs("agents", { cwd: workspaceRoot, env });
  const errors: AgentReport["errors"] = [];
  const shadows: AgentShadowDiagnostic[] = [];
  const collisions: AgentCollisionDiagnostic[] = [];
  const byId = new Map<string, AgentReportEntry>();

  for (const root of roots) {
    await loadAgentReportDir(root, byId, shadows, collisions, errors);
  }

  for (const profile of configProfiles ?? []) {
    addEntry(byId, shadows, collisions, toReportEntry(profile, "config"));
  }

  return {
    roots: roots.map((root) => root.dir),
    profiles: [...byId.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    shadows,
    collisions,
    errors,
  };
}

async function loadAgentReportDir(
  root: { dir: string; layer: CapabilityLayer },
  byId: Map<string, AgentReportEntry>,
  shadows: AgentShadowDiagnostic[],
  collisions: AgentCollisionDiagnostic[],
  errors: AgentReport["errors"],
): Promise<void> {
  const entries = await discoverAgentProfileFileEntriesInDir(root.dir, {
    onError(source, error) {
      errors.push({
        source,
        message: error instanceof Error ? error.message : String(error),
      });
    },
    onFileCollision(collision) {
      collisions.push({
        id: collision.id,
        kept: toReportEntry(
          collision.kept.profile,
          root.layer,
          root.dir,
          collision.kept.source,
        ),
        dropped: toReportEntry(
          collision.dropped.profile,
          root.layer,
          root.dir,
          collision.dropped.source,
        ),
      });
    },
  });
  for (const entry of entries) {
    addEntry(
      byId,
      shadows,
      collisions,
      toReportEntry(entry.profile, root.layer, root.dir, entry.source),
    );
  }
}

function addEntry(
  byId: Map<string, AgentReportEntry>,
  shadows: AgentShadowDiagnostic[],
  collisions: AgentCollisionDiagnostic[],
  entry: AgentReportEntry,
): void {
  const existing = byId.get(entry.id);
  if (!existing) {
    byId.set(entry.id, entry);
    return;
  }
  if (existing.layer === entry.layer) {
    // Same layer → ambiguous collision. Fail closed (keep the first), matching
    // discoverAgentProfilesInDir, rather than silently overwriting.
    collisions.push({ id: entry.id, kept: existing, dropped: entry });
    return;
  }
  // Different layers → legitimate shadowing; the stronger layer wins.
  shadows.push({ id: entry.id, shadowed: existing, shadowedBy: entry });
  byId.set(entry.id, entry);
}

function toReportEntry(
  profile: AgentProfile,
  layer: AgentReportLayer,
  root?: string,
  source?: string,
): AgentReportEntry {
  return {
    id: profile.id,
    name: profile.name,
    mode: profile.mode,
    layer,
    ...(root ? { root } : {}),
    ...(source ? { source } : {}),
  };
}
