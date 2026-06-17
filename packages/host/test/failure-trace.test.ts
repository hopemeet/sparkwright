import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordHostClientStartFailure } from "../src/failure-trace.js";

describe("host client start failure trace", () => {
  it("records a failed client-start trace with stable metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-host-failure-"));
    try {
      const result = await recordHostClientStartFailure({
        resumeRunId: "run_missing",
        message: "host failed to start",
        sessionRootDir: root,
        source: "cli",
        sessionId: "session_failure_test",
        traceLevel: "standard",
        targetPath: "README.md",
        shouldWrite: false,
        metadata: { client: "test" },
      });

      expect(result.sessionId).toBe("session_failure_test");
      expect(result.runId).toBeTruthy();
      expect(result.tracePath).toBe(
        join(root, "session_failure_test", "trace.jsonl"),
      );

      const events = (await readJsonl(result.tracePath ?? "")).map(
        (event) => event as { type: string; payload?: Record<string, unknown> },
      );
      expect(events[0]).toMatchObject({
        type: "run.created",
        payload: { goal: "resume run_missing" },
      });
      expect(events.at(-1)).toMatchObject({
        type: "run.failed",
        payload: {
          reason: "host_start_failed",
          code: "HOST_START_FAILED",
          metadata: {
            source: "cli",
            failurePhase: "host_start",
            targetPath: "README.md",
            shouldWrite: false,
            traceLevel: "standard",
            client: "test",
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function readJsonl(path: string): Promise<unknown[]> {
  const content = await readFile(path, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
