import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPACTION_SAFETY_PREFIX,
  asSessionId,
  createRunId,
  loadSessionCompactArtifact,
  sessionCompactArtifactToContextItem,
  writeSessionCompactArtifact,
} from "../src/index.js";

describe("session compact artifacts", () => {
  it("round-trips a compact artifact and projects it to safe context", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-compact-"));
    try {
      const sessionId = asSessionId("session_compact_test");
      const runId = createRunId();
      const path = await writeSessionCompactArtifact({
        sessionRootDir: root,
        artifact: {
          schemaVersion: "session-compact.v1",
          sessionId,
          createdAt: "2026-06-14T00:00:00.000Z",
          throughRunId: runId,
          compactedRunCount: 1,
          sourceRunIds: [runId],
          content: "User asked for a TUI refactor; assistant completed it.",
          originalCharCount: 1000,
          summaryCharCount: 56,
        },
      });

      expect(path.endsWith("compact.json")).toBe(true);
      const artifact = await loadSessionCompactArtifact({
        sessionRootDir: root,
        sessionId,
      });
      expect(artifact).toMatchObject({
        sessionId,
        throughRunId: runId,
        compactedRunCount: 1,
      });
      expect(artifact).not.toBeNull();
      if (!artifact) return;

      const item = sessionCompactArtifactToContextItem(artifact);
      expect(item.type).toBe("summary");
      expect(item.content).toContain(COMPACTION_SAFETY_PREFIX);
      expect(item.metadata).toMatchObject({
        sessionId,
        throughRunId: runId,
        compactedRunCount: 1,
        compactionSafetyPrefix: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
