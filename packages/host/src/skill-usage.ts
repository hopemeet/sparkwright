import { join } from "node:path";
import type { SparkwrightEvent } from "@sparkwright/core";
import {
  FileSkillUsageRecorder,
  type SkillUsageLoadMode,
  type SkillUsageRecorder,
} from "@sparkwright/skills";

export const SKILL_USAGE_FILE_NAME = "skill-usage.json";

export function skillUsagePath(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", SKILL_USAGE_FILE_NAME);
}

export function createSkillUsageRecorder(
  workspaceRoot: string,
): SkillUsageRecorder | null {
  try {
    return new FileSkillUsageRecorder({ path: skillUsagePath(workspaceRoot) });
  } catch {
    return null;
  }
}

export function observeSkillUsageEvent(
  recorder: SkillUsageRecorder | null | undefined,
  event: SparkwrightEvent,
): void {
  if (!recorder || event.type !== "skill.loaded") return;
  const payload = recordObject(event.payload);
  const name = stringValue(payload, "name");
  if (!name) return;
  const mode = skillLoadMode(event.metadata);
  if (!mode) return;
  try {
    recorder.recordUse(name, dateFromIso(event.timestamp), mode);
  } catch {
    // Usage is advisory in v1; a stale or locked sidecar must not break runs.
  }
}

export function recordSkillPatch(
  workspaceRoot: string,
  skillName: string,
  at: Date | string = new Date(),
): void {
  const recorder = createSkillUsageRecorder(workspaceRoot);
  if (!recorder) return;
  try {
    recorder.recordPatch(skillName, typeof at === "string" ? new Date(at) : at);
  } catch {
    // Usage is advisory in v1; mutation success must not depend on telemetry.
  }
}

function skillLoadMode(
  metadata: Record<string, unknown> | undefined,
): SkillUsageLoadMode | undefined {
  const mode = stringValue(metadata, "mode");
  return mode === "on_demand_tool" || mode === "resident_context"
    ? mode
    : undefined;
}

function dateFromIso(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
