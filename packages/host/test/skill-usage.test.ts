import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SparkwrightEvent } from "@sparkwright/core";
import { FileSkillUsageRecorder } from "@sparkwright/skills";
import { describe, expect, it } from "vitest";
import {
  createSkillUsageRecorder,
  observeSkillUsageEvent,
  recordSkillPatch,
  skillUsagePath,
} from "../src/index.js";

function skillLoadedEvent(
  name: string,
  mode: "on_demand_tool" | "resident_context",
): SparkwrightEvent {
  return {
    id: "evt_skill_usage" as SparkwrightEvent["id"],
    runId: "run_skill_usage" as SparkwrightEvent["runId"],
    type: "skill.loaded",
    timestamp: "2026-06-13T00:00:01.000Z",
    sequence: 1,
    payload: { name, status: "loaded" },
    metadata: { mode },
  };
}

describe("skill usage sidecar", () => {
  it("records load modes and patch observations in the host sidecar", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-host-usage-"));
    try {
      const recorder = createSkillUsageRecorder(workspace);
      observeSkillUsageEvent(
        recorder,
        skillLoadedEvent("code-reviewer", "on_demand_tool"),
      );
      observeSkillUsageEvent(
        recorder,
        skillLoadedEvent("code-reviewer", "resident_context"),
      );
      recordSkillPatch(workspace, "code-reviewer", "2026-06-13T00:00:02.000Z");

      const persisted = new FileSkillUsageRecorder({
        path: skillUsagePath(workspace),
      });
      expect(persisted.get("code-reviewer")).toMatchObject({
        useCount: 2,
        explicitLoadCount: 1,
        residentLoadCount: 1,
        patchCount: 1,
        lastUsedAt: "2026-06-13T00:00:01.000Z",
        lastPatchedAt: "2026-06-13T00:00:02.000Z",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
