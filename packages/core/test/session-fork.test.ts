import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events.js";
import { createRunId, type RunId } from "../src/ids.js";
import {
  FileSessionStore,
  InMemorySessionStore,
  forkSession,
} from "../src/session.js";
import { FileRunStore } from "../src/trace-store.js";
import { validateSessionTraceConsistency } from "../src/trace-session-consistency.js";
import type { RunRecord, RunResult } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("forkSession", () => {
  it("clones logical history and records structured lineage", async () => {
    const store = new InMemorySessionStore();
    const source = await store.create();
    const runA = createRunId();
    const runB = createRunId();
    await store.append(source.id, runA);
    await store.append(source.id, runB);

    const result = await forkSession({ sourceSessionId: source.id, store });

    expect(result.forked.id).not.toBe(source.id);
    expect(result.forked.runIds).toEqual([runA, runB]);
    expect(result.copiedRunCount).toBe(2);
    expect(result.forked.metadata?.lineage).toEqual({
      parentSessionId: source.id,
      forkPoint: null,
    });
  });

  it("branches before or after a stable run boundary", async () => {
    const store = new InMemorySessionStore();
    const source = await store.create();
    const runA = createRunId();
    const runB = createRunId();
    await store.append(source.id, runA);
    await store.append(source.id, runB);

    const before = await forkSession({
      sourceSessionId: source.id,
      forkPoint: { runId: runB, position: "before" },
      store,
    });
    const after = await forkSession({
      sourceSessionId: source.id,
      forkPoint: { runId: runB, position: "after" },
      store,
    });

    expect(before.forked.runIds).toEqual([runA]);
    expect(after.forked.runIds).toEqual([runA, runB]);
  });

  it("rejects a missing source or a run outside the source session", async () => {
    const store = new InMemorySessionStore();
    const source = await store.create();
    await expect(
      forkSession({ sourceSessionId: "missing", store }),
    ).rejects.toThrow(/not found/);
    await expect(
      forkSession({
        sourceSessionId: source.id,
        forkPoint: { runId: createRunId(), position: "after" },
        store,
      }),
    ).rejects.toThrow(/not part of session/);
  });

  it("materializes a self-contained file snapshot with rewritten identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-fork-"));
    tempDirs.push(root);
    const store = new FileSessionStore({ rootDir: root });
    const source = await store.create({ id: "session_source" });
    const runA = await persistCompletedRun(store, root, source.id, "first");
    const childRun = await persistCompletedRun(
      store,
      root,
      source.id,
      "child detail",
      "researcher",
    );
    const runB = await persistCompletedRun(store, root, source.id, "second");

    const result = await forkSession({
      sourceSessionId: source.id,
      forkPoint: { runId: runA, position: "after" },
      store,
    });
    const forkDir = join(root, result.forked.id);
    const copiedRun = JSON.parse(
      await readFile(
        join(forkDir, "agents", "main", "runs", runA, "run.json"),
        "utf8",
      ),
    ) as RunRecord;
    const trace = (await readFile(join(forkDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const consistency = await validateSessionTraceConsistency({
      sessionDir: forkDir,
    });

    expect(result.forked.runIds).toEqual([runA, childRun]);
    expect(result.forked.runIds).not.toContain(runB);
    await expect(
      readFile(
        join(forkDir, "agents", "researcher", "runs", childRun, "result.json"),
        "utf8",
      ),
    ).resolves.toContain("child detail");
    expect(copiedRun.metadata.sessionId).toBe(result.forked.id);
    expect(trace.length).toBeGreaterThan(0);
    expect(
      trace.every(
        (event) =>
          (event.metadata as Record<string, unknown>).sessionId ===
            result.forked.id &&
          (event.runId === runA || event.runId === childRun),
      ),
    ).toBe(true);
    expect(consistency.ok).toBe(true);
  });
});

async function persistCompletedRun(
  sessionStore: FileSessionStore,
  sessionRootDir: string,
  sessionId: string,
  goal: string,
  agentId = "main",
): Promise<RunId> {
  const runId = createRunId();
  await sessionStore.append(sessionId, runId);
  const now = new Date().toISOString();
  const run: RunRecord = {
    id: runId,
    goal,
    state: "running",
    createdAt: now,
    updatedAt: now,
    metadata: { sessionId, agentId },
  };
  const events = new EventLog(runId);
  const runStore = new FileRunStore(run, {
    sessionRootDir,
    sessionId,
    agentId,
  });
  runStore.append(events.emit("run.created", { goal }));
  runStore.append(events.emit("run.started", { goal }));
  runStore.append(events.emit("model.completed", { step: 1, message: goal }));
  runStore.append(events.emit("run.completed", { message: goal }));
  const completed: RunRecord = {
    ...run,
    state: "completed",
    updatedAt: new Date().toISOString(),
  };
  const result: RunResult = {
    signal: "completed",
    state: "completed",
    message: goal,
    assessment: {
      schemaVersion: "run-assessment.v1",
      health: "clean",
      issues: [],
      verification: [],
    },
    metadata: {},
  };
  runStore.finish(completed, result);
  return runId;
}
