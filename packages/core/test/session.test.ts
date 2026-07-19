import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSessionRunStoreFactory,
  FileSessionStore,
  InMemorySessionStore,
  ensureSessionRunMembership,
  projectSessionReplayToContextItems,
  projectSessionReplayToTranscript,
  replaySessionEventsFromRunStore,
  type RunStoreReplayPayload,
  type SessionEvent,
} from "../src/session.js";
import type { SparkwrightEvent } from "../src/events.js";
import { asSessionId, createSessionId, type RunId } from "../src/ids.js";
import type { RunStore } from "../src/storage.js";
import type { Artifact, RunRecord, RunResult } from "../src/types.js";
import { createSessionFileRunStoreFactory } from "../src/trace.js";

describe("session", () => {
  it("keeps an append-only session event stream", async () => {
    const store = new InMemorySessionStore();
    const runId = "run_session_1" as unknown as RunId;

    const session = await store.create({
      id: "session_1",
      metadata: { owner: "test" },
    });
    const updated = await store.append(session.id, runId);
    await store.appendEvent(session.id, {
      type: "session.event_appended",
      payload: { note: "checkpoint" },
      metadata: { source: "test" },
    });

    const events = await collect(store.loadEvents(session.id));

    expect(session).toMatchObject({
      id: "session_1",
      eventCount: 1,
      runIds: [],
    });
    expect(updated).toMatchObject({
      eventCount: 2,
      runIds: [runId],
    });
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "session.run_appended",
      "session.event_appended",
    ]);
    expect((await store.get(session.id))?.eventCount).toBe(3);
  });

  it("returns defensive copies of records and events", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create({ id: "session_copy" });
    const firstRead = await store.get(session.id);

    firstRead?.runIds.push("run_mutated" as unknown as RunId);
    const firstEvent = (await collect(store.loadEvents(session.id)))[0];
    firstEvent.metadata.changed = true;

    expect((await store.get(session.id))?.runIds).toEqual([]);
    expect((await collect(store.loadEvents(session.id)))[0].metadata).toEqual(
      {},
    );
  });

  it("persists append-only sessions to files", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-sessions-"));
    const runId = "run_file_1" as unknown as RunId;

    try {
      const store = new FileSessionStore({ rootDir: root });
      const session = await store.create({
        id: "session_file",
        metadata: { owner: "file-test" },
      });
      await store.append(session.id, runId);
      await store.appendEvent(session.id, {
        type: "session.event_appended",
        payload: { note: "saved" },
        metadata: { source: "test" },
      });

      const reloaded = new FileSessionStore({ rootDir: root });
      const record = await reloaded.get(session.id);
      const events = await collect(reloaded.loadEvents(session.id));

      expect(record).toMatchObject({
        id: "session_file",
        runIds: [runId],
        eventCount: 3,
        metadata: { owner: "file-test" },
      });
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(events.map((event) => event.type)).toEqual([
        "session.created",
        "session.run_appended",
        "session.event_appended",
      ]);
      expect(events[2]).toMatchObject({
        payload: { note: "saved" },
        metadata: { source: "test" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists file-backed sessions by most recently updated", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-sessions-"));

    try {
      const store = new FileSessionStore({ rootDir: root });
      await store.create({
        id: "session_old",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await store.create({
        id: "session_new",
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      });

      expect(
        (await store.list({ limit: 1 })).map((session) => session.id),
      ).toEqual(["session_new"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays RunStore events in session run order", async () => {
    const runA = "run_a" as unknown as RunId;
    const runB = "run_b" as unknown as RunId;
    const runStore: Pick<RunStore, "loadEvents"> = {
      async *loadEvents(runId) {
        const eventsByRun = new Map<RunId, SparkwrightEvent[]>([
          [
            runA,
            [event(runA, 1, "run.started"), event(runA, 2, "model.completed")],
          ],
          [runB, [event(runB, 1, "run.completed")]],
        ]);

        yield* eventsByRun.get(runId) ?? [];
      },
    };

    const replayed: Array<SessionEvent<RunStoreReplayPayload>> = await collect(
      replaySessionEventsFromRunStore({
        session: { id: asSessionId("session_replay"), runIds: [runA, runB] },
        runStore,
        metadata: { reason: "test" },
      }),
    );

    expect(replayed.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(replayed.map((item) => item.payload.event.type)).toEqual([
      "run.started",
      "model.completed",
      "run.completed",
    ]);
    expect(replayed.map((item) => item.payload.runId)).toEqual([
      runA,
      runA,
      runB,
    ]);
    expect(replayed.every((item) => item.sessionId === "session_replay")).toBe(
      true,
    );
    expect(replayed.every((item) => item.metadata.reason === "test")).toBe(
      true,
    );
  });

  it("projects session replay into context items", async () => {
    const runA = "run_ctx" as unknown as RunId;
    const runStore: Pick<RunStore, "loadEvents"> = {
      async *loadEvents(runId) {
        yield event(runId, 1, "run.started");
        yield {
          ...event(runId, 2, "run.completed"),
          payload: { state: "completed", stopReason: "final_answer" },
        };
      },
    };

    const context = await projectSessionReplayToContextItems({
      session: { id: asSessionId("session_ctx"), runIds: [runA] },
      runStore,
    });

    expect(context).toHaveLength(1);
    expect(context[0]).toMatchObject({
      type: "summary",
      source: { kind: "session_replay" },
      metadata: {
        layer: "runtime",
        stability: "session",
        sessionId: "session_ctx",
        eventCount: 2,
      },
    });
    expect(context[0]?.content).toContain("run.completed");
  });

  it("projects session replay into a transcript", async () => {
    const runA = "run_transcript" as unknown as RunId;
    const runStore: Pick<RunStore, "loadEvents"> = {
      async *loadEvents(runId) {
        yield {
          ...event(runId, 1, "run.created"),
          payload: { goal: "inspect repository" },
        };
        yield {
          ...event(runId, 2, "model.completed"),
          payload: { message: "I inspected it." },
        };
      },
    };

    const transcript = await projectSessionReplayToTranscript({
      session: { id: asSessionId("session_transcript"), runIds: [runA] },
      runStore,
    });

    expect(transcript.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(transcript.text).toContain("inspect repository");
    expect(transcript.text).toContain("I inspected it.");
  });

  it("requires RunStore.loadEvents for replay", async () => {
    const replayed = replaySessionEventsFromRunStore({
      session: { id: asSessionId("session_missing_loader"), runIds: [] },
      runStore: {},
    });

    await expect(collect(replayed)).rejects.toThrow(
      "RunStore.loadEvents is required",
    );
  });

  it("brands generated session ids with the session prefix", () => {
    expect(createSessionId()).toMatch(/^session_/);
  });

  it("ensures session run membership without duplicating run ids", async () => {
    const store = new InMemorySessionStore();
    const run = runRecord("run_member" as unknown as RunId);

    await ensureSessionRunMembership({
      sessionStore: store,
      sessionId: "session_member",
      run,
      metadata: { owner: "membership-test" },
    });
    await ensureSessionRunMembership({
      sessionStore: store,
      sessionId: "session_member",
      run,
    });

    const session = await store.get("session_member");
    const events = await collect(store.loadEvents("session_member"));
    expect(session?.runIds).toEqual([run.id]);
    expect(session?.metadata).toMatchObject({ owner: "membership-test" });
    expect(events.map((item) => item.type)).toEqual([
      "session.created",
      "session.run_appended",
    ]);
  });

  it("wraps run stores with session membership persistence", async () => {
    const sessionStore = new InMemorySessionStore();
    const persisted: SparkwrightEvent[] = [];
    const finished: Array<{ run: RunRecord; result: RunResult }> = [];
    const run = runRecord("run_wrapped" as unknown as RunId);
    const factory = createSessionRunStoreFactory({
      sessionStore,
      sessionId: "session_wrapped",
      runStoreFactory: () => ({
        append(event) {
          persisted.push(event);
        },
        finish(run, result) {
          finished.push({ run, result });
        },
      }),
    });

    const runStore = factory(run);
    await runStore.append(event(run.id, 1, "run.created"));
    await runStore.finish(run, {
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
      assessment: {
        schemaVersion: "run-assessment.v1",
        health: "clean",
        issues: [],
        verification: [],
      },
      metadata: {},
    });

    expect((await sessionStore.get("session_wrapped"))?.runIds).toEqual([
      run.id,
    ]);
    expect(persisted.map((item) => item.type)).toEqual(["run.created"]);
    expect(finished).toHaveLength(1);
  });

  it("persists session membership before writing artifacts", async () => {
    const sessionStore = new InMemorySessionStore();
    const written: Artifact[] = [];
    const run = runRecord("run_artifact_wrapped" as unknown as RunId);
    const factory = createSessionRunStoreFactory({
      sessionStore,
      sessionId: "session_artifact_wrapped",
      runStoreFactory: () => ({
        append() {},
        finish() {},
        writeArtifact(artifact) {
          written.push(artifact);
        },
      }),
    });

    const runStore = factory(run);
    await runStore.writeArtifact?.({
      id: "artifact_test" as Artifact["id"],
      runId: run.id,
      type: "text",
      name: "note.txt",
      content: "hello",
      metadata: {},
    });

    expect(
      (await sessionStore.get("session_artifact_wrapped"))?.runIds,
    ).toEqual([run.id]);
    expect(written).toHaveLength(1);
  });

  it("composes FileSessionStore with session-scoped FileRunStore safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-session-run-"));
    try {
      const sessionStore = new FileSessionStore({ rootDir: root });
      const run = runRecord("run_file_wrapped" as unknown as RunId);
      const factory = createSessionRunStoreFactory({
        sessionStore,
        sessionId: "session_file_wrapped",
        runStoreFactory: createSessionFileRunStoreFactory({
          sessionRootDir: root,
          sessionId: "session_file_wrapped",
          agentId: "main",
        }),
      });

      const runStore = factory(run);
      await runStore.append(event(run.id, 1, "run.created"));
      await runStore.finish(run, {
        signal: "completed",
        state: "completed",
        stopReason: "final_answer",
        assessment: {
          schemaVersion: "run-assessment.v1",
          health: "clean",
          issues: [],
          verification: [],
        },
        metadata: {},
      });

      const session = await sessionStore.get("session_file_wrapped");
      const sessionEvents = await collect(
        sessionStore.loadEvents("session_file_wrapped"),
      );
      const trace = await readFile(
        join(root, "session_file_wrapped", "trace.jsonl"),
        "utf8",
      );

      expect(session).toMatchObject({
        runIds: [run.id],
        eventCount: 2,
      });
      expect(sessionEvents.map((item) => item.type)).toEqual([
        "session.created",
        "session.run_appended",
      ]);
      expect(trace).toContain('"type":"run.created"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Regression: SessionStore.append used to silently allow duplicates,
  // breaking "exactly once" membership semantics for any caller bypassing
  // `ensureSessionRunMembership`.
  it("dedupes runIds on InMemorySessionStore.append", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create({ id: "session_dedupe_mem" });
    const runId = "run_dup_1" as unknown as RunId;
    await store.append(session.id, runId);
    const after = await store.append(session.id, runId);
    expect(after.runIds).toEqual([runId]);
    const events = await collect(store.loadEvents(session.id));
    expect(
      events.filter((e) => e.type === "session.run_appended"),
    ).toHaveLength(1);
  });

  it("dedupes runIds on FileSessionStore.append", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-dedupe-"));
    try {
      const store = new FileSessionStore({ rootDir: root });
      const session = await store.create({ id: "session_dedupe_file" });
      const runId = "run_dup_2" as unknown as RunId;
      await store.append(session.id, runId);
      const after = await store.append(session.id, runId);
      expect(after.runIds).toEqual([runId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent FileSessionStore event appends", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-session-queue-"));
    try {
      const store = new FileSessionStore({ rootDir: root });
      const session = await store.create({ id: "session_queue_file" });
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          store.appendEvent(session.id, {
            type: "session.event_appended",
            payload: { index },
          }),
        ),
      );

      const after = await store.get(session.id);
      const events = await collect(store.loadEvents(session.id));
      expect(after?.eventCount).toBe(11);
      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: 11 }, (_, index) => index + 1),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent FileSessionStore session creation by id", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-session-create-"));
    try {
      const store = new FileSessionStore({ rootDir: root });
      const sessionId = asSessionId("session_concurrent_create");
      const runA = runRecord("run_concurrent_a" as unknown as RunId);
      const runB = runRecord("run_concurrent_b" as unknown as RunId);

      await Promise.all([
        ensureSessionRunMembership({
          sessionStore: store,
          sessionId,
          run: runA,
        }),
        ensureSessionRunMembership({
          sessionStore: store,
          sessionId,
          run: runB,
        }),
      ]);

      const session = await store.get(sessionId);
      const events = await collect(store.loadEvents(sessionId));
      expect(session?.runIds.sort()).toEqual([runA.id, runB.id].sort());
      expect(
        events.filter((event) => event.type === "session.created"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "session.run_appended"),
      ).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Regression: lazy-constructing the inner run store on loadEvents() had
  // write side effects (bumped session.json updatedAt, rewrote run.json).
  it("loadEvents does not lazily construct the inner store", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-loadevents-ro-"));
    try {
      const sessionStore = new FileSessionStore({ rootDir: root });
      const sessionId = createSessionId();
      await sessionStore.create({ id: sessionId });
      const run = runRecord("run_load_ro" as unknown as RunId);

      const innerCalls: number[] = [];
      const factory = createSessionRunStoreFactory({
        sessionStore,
        sessionId,
        runStoreFactory: () => {
          innerCalls.push(1);
          return {
            async append() {},
            async finish() {},
            async *loadEvents() {},
          } as RunStore;
        },
      });
      const store = factory(run);
      // No writes yet.
      const items: SparkwrightEvent[] = [];
      if (store.loadEvents) {
        for await (const item of store.loadEvents(run.id)) items.push(item);
      }
      expect(items).toEqual([]);
      expect(innerCalls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function event(
  runId: RunId,
  sequence: number,
  type: SparkwrightEvent["type"],
): SparkwrightEvent {
  return {
    id: `evt_${String(sequence)}` as SparkwrightEvent["id"],
    runId,
    type,
    timestamp: `2026-01-01T00:00:0${String(sequence)}.000Z`,
    sequence,
    payload: {},
    metadata: {},
  };
}

function runRecord(runId: RunId): RunRecord {
  return {
    id: runId,
    goal: "test",
    state: "created",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
  };
}
