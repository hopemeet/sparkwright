import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentMode, AgentProfile } from "@sparkwright/agent-runtime";
import { resolveCapabilityDirs, type CapabilityLayer } from "./layers.js";
import { parseAgentProfileFile } from "./agent-profiles.js";

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

export interface AgentReport {
  roots: string[];
  profiles: AgentReportEntry[];
  shadows: AgentShadowDiagnostic[];
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
  const byId = new Map<string, AgentReportEntry>();

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".md")) continue;
      const source = join(root.dir, entry);
      const raw = await readFile(source, "utf8").catch((error: unknown) => {
        errors.push({
          source,
          message: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      });
      if (raw === undefined) continue;
      addEntry(
        byId,
        shadows,
        toReportEntry(
          parseAgentProfileFile(basename(entry, ".md"), raw),
          root.layer,
          root.dir,
          source,
        ),
      );
    }
  }

  for (const profile of configProfiles ?? []) {
    addEntry(byId, shadows, toReportEntry(profile, "config"));
  }

  return {
    roots: roots.map((root) => root.dir),
    profiles: [...byId.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    shadows,
    errors,
  };
}

function addEntry(
  byId: Map<string, AgentReportEntry>,
  shadows: AgentShadowDiagnostic[],
  entry: AgentReportEntry,
): void {
  const existing = byId.get(entry.id);
  if (existing) {
    shadows.push({ id: entry.id, shadowed: existing, shadowedBy: entry });
  }
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
