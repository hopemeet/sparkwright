import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog, type SparkwrightEvent } from "../src/events.js";
import { createArtifactId, createRunId, type ArtifactId } from "../src/ids.js";
import type { RunRecord } from "../src/types.js";
import {
  createSessionRunStoreFactory,
  FileSessionStore,
} from "../src/session.js";
import {
  createSessionFileRunStoreFactory,
  buildTraceTimelineJsonl,
  createTraceRedactor,
  FileRunStore,
  filterTraceEvent,
  loadTraceEventsJsonl,
  MemoryTrace,
  repairSessionTraceConsistency,
  restoreTranscriptPrompts,
  serializeEventJsonl,
  summarizeTraceJsonl,
  validateSessionTraceConsistency,
} from "../src/trace.js";

describe("trace", () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("serializes an event as one JSONL line", () => {
    const log = new EventLog(createRunId());
    const event = log.emit("run.created", { goal: "test" });
    const line = serializeEventJsonl(event);

    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      id: event.id,
      runId: event.runId,
      type: "run.created",
      sequence: 1,
      payload: { goal: "test" },
      metadata: {},
    });
  });

  it("preserves append order in memory", () => {
    const log = new EventLog(createRunId());
    const trace = new MemoryTrace();

    trace.append(log.emit("run.created", {}));
    trace.append(log.emit("run.started", {}));

    const lines = trace
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number; type: string });

    expect(lines).toEqual([
      expect.objectContaining({ sequence: 1, type: "run.created" }),
      expect.objectContaining({ sequence: 2, type: "run.started" }),
    ]);
  });

  it("persists run metadata and JSONL trace to a run directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, { rootDir: root });

    store.append(log.emit("run.created", { goal: run.goal }));
    store.append(log.emit("run.started", {}));

    const trace = await readFile(store.tracePath, "utf8");
    const runJson = JSON.parse(
      await readFile(join(store.runDir, "run.json"), "utf8"),
    ) as RunRecord;

    expect(runJson.id).toBe(run.id);
    expect(trace.trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(trace.trim().split("\n")[0])).toMatchObject({
      type: "run.created",
      sequence: 1,
    });
  });

  it("collapses stream chunks into one model.stream.text timing marker at standard level", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-stream-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, { rootDir: root });

    store.append(log.emit("model.stream.started", { step: 1 }));
    store.append(
      log.emit("model.stream.chunk", { type: "text_delta", text: "Hel" }),
    );
    store.append(
      log.emit("model.stream.chunk", { type: "text_delta", text: "lo " }),
    );
    store.append(
      log.emit("model.stream.chunk", { type: "text_delta", text: "world" }),
    );
    store.append(log.emit("model.stream.completed", { step: 1 }));

    const lines = (await readFile(store.tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SparkwrightEvent);

    // started → text → completed; no individual chunks persisted.
    expect(lines.map((l) => l.type)).toEqual([
      "model.stream.started",
      "model.stream.text",
      "model.stream.completed",
    ]);
    const text = lines[1];
    // The marker carries timing telemetry only — the streamed text itself is
    // no longer duplicated here (it lives on model.completed).
    expect(text.payload).toMatchObject({
      step: 1,
      chunkCount: 3,
    });
    const payload = text.payload as Record<string, unknown>;
    expect(payload.text).toBeUndefined();
    expect(payload.firstTokenAt).toBeDefined();
    expect(payload.lastTokenAt).toBeDefined();
  });

  it("keeps raw stream chunks at debug level", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-stream-debug-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, { rootDir: root, traceLevel: "debug" });

    store.append(log.emit("model.stream.started", { step: 1 }));
    store.append(
      log.emit("model.stream.chunk", { type: "text_delta", text: "a" }),
    );
    store.append(
      log.emit("model.stream.chunk", { type: "text_delta", text: "b" }),
    );
    store.append(log.emit("model.stream.completed", { step: 1 }));

    const types = (await readFile(store.tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as SparkwrightEvent).type);

    expect(types).toEqual([
      "model.stream.started",
      "model.stream.chunk",
      "model.stream.chunk",
      "model.stream.completed",
    ]);
  });

  it("buffers events when disk append fails and flushes on next success", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-degraded-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);

    const errors: unknown[] = [];
    const store = new FileRunStore(run, {
      rootDir: root,
      degradationBufferLimit: 10,
      onAppendError: (info) => errors.push(info),
    });

    // Simulate disk failure for the first two appends by monkey-patching
    // the internal write method via prototype access on `store`.
    let failuresRemaining = 2;
    const realWrite = (
      store as unknown as {
        writeEventToDisk: (e: SparkwrightEvent) => void;
      }
    ).writeEventToDisk.bind(store);
    (
      store as unknown as {
        writeEventToDisk: (e: SparkwrightEvent) => void;
      }
    ).writeEventToDisk = (event: SparkwrightEvent) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw Object.assign(new Error("ENOSPC: no space left"), {
          code: "ENOSPC",
        });
      }
      realWrite(event);
    };

    // Two failures, then one success that should flush all three in order.
    store.append(log.emit("run.created", { goal: run.goal }));
    store.append(log.emit("run.started", {}));
    expect(store.degradedBufferSize).toBe(2);
    expect(errors).toHaveLength(2);

    store.append(
      log.emit("prompt.built", {
        step: 1,
        messageCount: 0,
        stableMessageCount: 0,
        messages: [],
        sections: [],
      }),
    );

    expect(store.degradedBufferSize).toBe(0);
    const trace = await readFile(store.tracePath, "utf8");
    const lines = trace.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ type: "run.created" });
    expect(JSON.parse(lines[1])).toMatchObject({ type: "run.started" });
    expect(JSON.parse(lines[2])).toMatchObject({ type: "prompt.built" });
  });

  it("dedups the repeated system prefix in the transcript and restores it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-transcript-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, {
      sessionRootDir: root,
      sessionId: "s1",
    });

    const system = [
      { role: "system", content: "Contract A", stability: "stable" },
      { role: "system", content: "Tools: read_file", stability: "session" },
    ];
    const promptEvent = (step: number, goal: string) =>
      log.emit("prompt.built", {
        step,
        messageCount: system.length + 1,
        stableMessageCount: 1,
        messages: [
          ...system,
          { role: "user", content: goal, stability: "turn" },
        ],
        sections: [],
      });

    store.append(log.emit("run.created", { goal: run.goal }));
    store.append(promptEvent(1, "first goal"));
    store.append(promptEvent(2, "second goal"));

    const transcript = await readFile(
      join(root, "s1", "transcript.jsonl"),
      "utf8",
    );
    const entries = transcript
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const prompts = entries.filter((e) => e.type === "prompt");

    // Every prompt — including the first — strips the 2 system messages and
    // references the shared blob; none carries the prefix inline.
    const hash = prompts[0].systemRef;
    expect(typeof hash).toBe("string");
    for (const prompt of prompts) {
      expect((prompt.messages as unknown[]).length).toBe(1);
      expect(prompt.systemRef).toBe(hash);
      expect(prompt.systemPrefixLength).toBe(2);
      expect(prompt.systemHash).toBeUndefined();
    }

    // The prefix lives once in blobs/<hash>.json.
    const blobsDir = join(root, "s1", "blobs");
    const blob = JSON.parse(
      await readFile(join(blobsDir, `${hash as string}.json`), "utf8"),
    );
    expect(blob).toEqual(system);

    // Rehydration from the blobs dir restores both prompts' full message arrays.
    const restored = restoreTranscriptPrompts(entries, { blobsDir }).filter(
      (e) => e.type === "prompt",
    );
    expect(restored[0].messages).toEqual([
      ...system,
      { role: "user", content: "first goal", stability: "turn" },
    ]);
    expect(restored[1].messages).toEqual([
      ...system,
      { role: "user", content: "second goal", stability: "turn" },
    ]);
  });

  it("dedups the system prefix across separate runs in one session", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-transcript-xrun-"));
    tempDirs.push(root);

    const system = [
      { role: "system", content: "Contract A", stability: "stable" },
      { role: "system", content: "Tools: read_file", stability: "session" },
    ];
    const promptEvent = (log: EventLog, step: number, goal: string) =>
      log.emit("prompt.built", {
        step,
        messageCount: system.length + 1,
        stableMessageCount: 1,
        messages: [
          ...system,
          { role: "user", content: goal, stability: "turn" },
        ],
        sections: [],
      });

    // Two runs, two FileRunStore instances (as the session factory creates),
    // writing to the same session transcript.
    const run1 = createRunRecord();
    const log1 = new EventLog(run1.id);
    const store1 = new FileRunStore(run1, {
      sessionRootDir: root,
      sessionId: "s1",
    });
    store1.append(promptEvent(log1, 1, "run1 goal"));

    const run2 = createRunRecord();
    const log2 = new EventLog(run2.id);
    const store2 = new FileRunStore(run2, {
      sessionRootDir: root,
      sessionId: "s1",
    });
    store2.append(promptEvent(log2, 1, "run2 goal"));

    const prompts = (
      await readFile(join(root, "s1", "transcript.jsonl"), "utf8")
    )
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "prompt");

    // The regression: run2's first prompt must reference the prefix, not
    // re-embed it, even though it is a fresh store instance.
    expect(prompts).toHaveLength(2);
    expect(prompts[0].systemRef).toBe(prompts[1].systemRef);
    expect((prompts[1].messages as unknown[]).length).toBe(1);

    // Exactly one blob file written for the shared prefix.
    const { readdir } = await import("node:fs/promises");
    const blobs = await readdir(join(root, "s1", "blobs"));
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toBe(`${prompts[0].systemRef as string}.json`);
  });

  it("bindStorageDegradationEvents emits paired degraded/recovered events", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-degraded-bridge-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);

    const observed: { type: string; payload: unknown }[] = [];
    log.subscribe((event) => {
      if (
        event.type === "storage.degraded" ||
        event.type === "storage.recovered"
      ) {
        observed.push({ type: event.type, payload: event.payload });
      }
    });

    const { bindStorageDegradationEvents } = await import("../src/trace.js");
    const hooks = bindStorageDegradationEvents({ events: log });
    const store = new FileRunStore(run, {
      rootDir: root,
      degradationBufferLimit: 10,
      ...hooks,
    });

    // Cause two failures, then let the next write succeed.
    let failures = 2;
    const realWrite = (
      store as unknown as {
        writeEventToDisk: (e: SparkwrightEvent) => void;
      }
    ).writeEventToDisk.bind(store);
    (
      store as unknown as {
        writeEventToDisk: (e: SparkwrightEvent) => void;
      }
    ).writeEventToDisk = (event: SparkwrightEvent) => {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }
      realWrite(event);
    };

    store.append(log.emit("run.created", { goal: run.goal }));
    store.append(log.emit("run.started", {}));
    store.append(
      log.emit("prompt.built", {
        step: 1,
        messageCount: 0,
        stableMessageCount: 0,
        messages: [],
        sections: [],
      }),
    );

    // Exactly one degraded + one recovered (no flood across the two failures).
    expect(observed.map((o) => o.type)).toEqual([
      "storage.degraded",
      "storage.recovered",
    ]);
    expect(observed[0]?.payload).toMatchObject({
      errorCode: "ENOSPC",
      bufferedCount: 1,
      firstFailedEventType: "run.created",
    });
    // flushedCount = events drained from the buffer (the 2 that failed).
    // The 3rd event that triggered the drain writes directly after.
    expect(observed[1]?.payload).toMatchObject({ flushedCount: 2 });
  });

  it("FileRunStore.saveCheckpoint round-trips via loadCheckpointFromRunDir", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-checkpoint-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const store = new FileRunStore(run, { rootDir: root });
    const { loadCheckpointFromRunDir } = await import("../src/trace.js");

    // Loading from a pristine run dir returns undefined.
    expect(loadCheckpointFromRunDir(store.runDir)).toBeUndefined();

    const checkpoint = {
      schemaVersion: "run-checkpoint.v1" as const,
      run,
      loop: {
        step: 4,
        turnCount: 3,
        context: [],
        repeatedToolCallCount: 0,
        transition: { reason: "next_turn" as const },
      },
      model: { activeIndex: 0, fallbackCount: 0 },
      recovery: { outputRecoveriesUsed: 0, maxOutputRecoveries: 3 },
      budget: {
        configured: undefined,
        usage: {
          elapsedMs: 1000,
          modelCalls: 4,
          toolCalls: 2,
          tokens: 500,
          costUsd: 0.01,
        },
      },
      queues: {
        commandCount: 0,
        pendingPrefetch: false,
        pendingSummary: false,
      },
      resumability: { complete: true, reasons: [] },
      createdAt: "2026-01-01T00:01:00.000Z",
      metadata: { tag: "saved" },
    };

    store.saveCheckpoint(checkpoint);
    const loaded = loadCheckpointFromRunDir(store.runDir);
    expect(loaded).toEqual(checkpoint);
    // Path also reachable directly.
    expect(store.checkpointPath).toBe(join(store.runDir, "checkpoint.json"));
  });

  it("autoCheckpointEveryNSteps persists a fresh checkpoint on the configured cadence", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-auto-cp-"));
    tempDirs.push(root);
    const { createRun, defineTool, loadCheckpointFromRunDir } =
      await import("../src/index.js");

    const noop = defineTool({
      name: "noop",
      description: "Returns immediately so the loop advances another step.",
      inputSchema: { type: "object" },
      async execute() {
        return { ok: true };
      },
    });

    let modelCalls = 0;
    const run = createRun({
      goal: "auto checkpoint cadence",
      maxSteps: 5,
      autoCheckpointEveryNSteps: 2,
      tools: [noop],
      model: {
        async complete() {
          modelCalls += 1;
          // Force the loop to advance through several steps by requesting a
          // noop tool call each turn, then finalize after enough iterations.
          if (modelCalls >= 3) return { message: "done" };
          return { toolCalls: [{ toolName: "noop", arguments: {} }] };
        },
      },
      runStore: (record) => new FileRunStore(record, { rootDir: root }),
    });

    await run.start();

    const reloaded = loadCheckpointFromRunDir(join(root, run.record.id));
    expect(reloaded).toBeDefined();
    expect(reloaded?.metadata).toMatchObject({ auto: true });
    // At least one auto-checkpoint cycle should have fired by step 2.
    expect(
      (reloaded?.metadata as { step?: number }).step ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });

  it("reconstructs a best-effort checkpoint from trace when checkpoint.json is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-trace-recover-"));
    tempDirs.push(root);
    const {
      createRun,
      defineTool,
      loadCheckpointFromRunDir,
      resumeRunFromCheckpoint,
    } = await import("../src/index.js");

    const noop = defineTool({
      name: "noop",
      description: "Advances the loop another step.",
      inputSchema: { type: "object" },
      async execute() {
        return { ok: true };
      },
    });

    let modelCalls = 0;
    const run = createRun({
      goal: "trace fallback recovery",
      maxSteps: 5,
      tools: [noop],
      model: {
        async complete() {
          modelCalls += 1;
          if (modelCalls >= 3) return { message: "done" };
          return { toolCalls: [{ toolName: "noop", arguments: {} }] };
        },
      },
      runStore: (record) => new FileRunStore(record, { rootDir: root }),
    });
    await run.start();

    const runDir = join(root, run.record.id);
    // No explicit checkpoint persisted.
    expect(loadCheckpointFromRunDir(runDir)).toBeUndefined();

    const reconstructed = loadCheckpointFromRunDir(runDir, {
      fallbackFromTrace: true,
    });
    expect(reconstructed).toBeDefined();
    expect(reconstructed?.resumability.complete).toBe(false);
    expect(reconstructed?.resumability.reasons).toContain(
      "reconstructed_from_trace",
    );
    // Counters reflect what actually happened.
    expect(reconstructed?.budget.usage.modelCalls).toBe(3);
    expect(reconstructed?.budget.usage.toolCalls).toBeGreaterThanOrEqual(2);
    expect(reconstructed?.run.id).toBe(run.record.id);
    // The completed run is terminal — resume must refuse even with force.
    // (The non-terminal-but-incomplete path is covered by the P4 tests.)
    expect(() =>
      resumeRunFromCheckpoint(reconstructed!, {
        force: true,
        model: {
          async complete() {
            return { message: "x" };
          },
        },
      }),
    ).toThrow(/already terminal/);
  });

  it("resumeRunFromCheckpoint(force) accepts a reconstructed checkpoint of a non-terminal run", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-trace-resume-"));
    tempDirs.push(root);
    const { loadCheckpointFromRunDir, resumeRunFromCheckpoint } =
      await import("../src/index.js");

    // Build a run dir from scratch with a non-terminal run.json + minimal trace.
    const runId = createRunId();
    const runDir = join(root, runId);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(runDir, { recursive: true });
    const runRecord = {
      id: runId,
      goal: "synthetic non-terminal",
      state: "running",
      createdAt: "2026-02-02T00:00:00.000Z",
      updatedAt: "2026-02-02T00:00:10.000Z",
      metadata: {},
    };
    await writeFile(
      join(runDir, "run.json"),
      `${JSON.stringify(runRecord, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(runDir, "trace.jsonl"),
      [
        JSON.stringify({
          id: "evt_1",
          runId,
          sequence: 1,
          type: "model.completed",
          timestamp: "2026-02-02T00:00:02.000Z",
          payload: { step: 1 },
        }),
        JSON.stringify({
          id: "evt_2",
          runId,
          sequence: 2,
          type: "tool.completed",
          timestamp: "2026-02-02T00:00:05.000Z",
          payload: { step: 1 },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const reconstructed = loadCheckpointFromRunDir(runDir, {
      fallbackFromTrace: true,
    });
    expect(reconstructed?.budget.usage.modelCalls).toBe(1);
    expect(reconstructed?.budget.usage.toolCalls).toBe(1);
    expect(reconstructed?.loop.step).toBe(2); // resumed AFTER last seen step

    // Now actually resume it (force required since resumability.complete=false).
    let observedStep = 0;
    const run = resumeRunFromCheckpoint(reconstructed!, {
      force: true,
      model: {
        async complete(input) {
          observedStep = input.step;
          return { message: "completed-from-fallback" };
        },
      },
    });
    const result = await run.start();
    expect(result.signal).toBe("completed");
    expect(observedStep).toBe(2);
    expect(run.record.id).toBe(runId);
  });

  it("RunHandle.persistCheckpoint writes via the wired runStore", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-persist-"));
    tempDirs.push(root);
    const { createRun, resumeRunFromCheckpoint, loadCheckpointFromRunDir } =
      await import("../src/index.js");

    let stepSeen = 0;
    const run = createRun({
      goal: "persist checkpoint",
      model: {
        async complete(input) {
          stepSeen = input.step;
          return { message: "done" };
        },
      },
      runStore: (record) => new FileRunStore(record, { rootDir: root }),
    });

    // Persist a checkpoint mid-flight (here: pre-start; loop.step=0). Just
    // exercises the save path; resumability flag will be honored by P4.
    const ck = run.persistCheckpoint({ marker: "pre-start" });
    expect(ck.metadata).toEqual({ marker: "pre-start" });

    await run.start();

    const runDir = join(root, run.record.id);
    const reloaded = loadCheckpointFromRunDir(runDir);
    expect(reloaded?.run.id).toBe(run.record.id);
    expect(reloaded?.metadata).toEqual({ marker: "pre-start" });
    expect(stepSeen).toBe(1);

    // Sanity: resumeRunFromCheckpoint accepts the saved file. The checkpoint
    // we saved was pre-start (state=created, loop.step=0) which is still
    // resumable.
    const resumed = resumeRunFromCheckpoint(reloaded!, {
      model: {
        async complete() {
          return { message: "resumed-ok" };
        },
      },
    });
    const res = await resumed.start();
    expect(res.signal).toBe("completed");
    expect(resumed.record.id).toBe(run.record.id);
  });

  it("drops oldest events when the degradation buffer overflows", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sparkwright-degraded-overflow-"),
    );
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);

    const errors: { droppedCount: number }[] = [];
    const store = new FileRunStore(run, {
      rootDir: root,
      degradationBufferLimit: 2,
      onAppendError: (info) => errors.push(info),
    });

    (
      store as unknown as {
        writeEventToDisk: (e: SparkwrightEvent) => void;
      }
    ).writeEventToDisk = () => {
      throw Object.assign(new Error("EROFS"), { code: "EROFS" });
    };

    store.append(log.emit("run.created", { goal: run.goal }));
    store.append(log.emit("run.started", {}));
    store.append(log.emit("run.started", {})); // overflow → 1 dropped

    expect(store.degradedBufferSize).toBe(2);
    expect(errors.at(-1)?.droppedCount).toBe(1);
  });

  it("persists session and agent traces when a session id is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-sessions-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, {
      sessionRootDir: root,
      sessionId: "session_trace",
      agentId: "agent_a",
    });

    store.append(
      log.emit("prompt.built", {
        step: 1,
        messageCount: 1,
        stableMessageCount: 1,
        messages: [{ role: "system", content: "Full system prompt" }],
        sections: [],
      }),
    );
    store.append(
      log.emit("model.completed", {
        step: 1,
        message: "done",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      }),
    );

    const sessionDir = join(root, "session_trace");
    const sessionTrace = await readFile(
      join(sessionDir, "trace.jsonl"),
      "utf8",
    );
    const agentTrace = await readFile(
      join(sessionDir, "agents", "agent_a", "trace.jsonl"),
      "utf8",
    );
    const transcript = await readFile(
      join(sessionDir, "transcript.jsonl"),
      "utf8",
    );
    const sessionJson = JSON.parse(
      await readFile(join(sessionDir, "session.json"), "utf8"),
    ) as { runIds: string[]; agents: string[] };
    const sessionEvents = sessionTrace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { metadata: Record<string, unknown> });

    expect(store.tracePath).toBe(join(sessionDir, "trace.jsonl"));
    expect(store.runDir).toBe(
      join(sessionDir, "agents", "agent_a", "runs", run.id),
    );
    expect(sessionTrace).toBe(agentTrace);
    expect(sessionEvents[0]?.metadata).toMatchObject({
      sessionId: "session_trace",
      agentId: "agent_a",
    });
    // The stable system prefix is no longer repeated verbatim in the standard
    // trace — it is dereferenced to a hash. The full text lives in the
    // (deduped) transcript instead.
    expect(sessionTrace).not.toContain("Full system prompt");
    expect(sessionTrace).toContain("systemPrefixRef");
    expect(sessionTrace).toContain("totalTokens");
    expect(transcript).toContain('"type":"prompt"');
    expect(transcript).toContain('"type":"assistant"');
    expect(sessionJson).toMatchObject({
      runIds: [run.id],
      agents: ["agent_a"],
    });
  });

  it("uses run metadata agentId for session agent directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-sessions-"));
    tempDirs.push(root);
    const run = createRunRecord({
      agentId: "reviewer",
      agentName: "Reviewer",
    });
    const store = new FileRunStore(run, {
      sessionRootDir: root,
      sessionId: "session_trace",
    });

    const agentJson = JSON.parse(
      await readFile(
        join(root, "session_trace", "agents", "reviewer", "agent.json"),
        "utf8",
      ),
    ) as { id: string; metadata: Record<string, unknown> };

    expect(store.agentId).toBe("reviewer");
    expect(store.runDir).toBe(
      join(root, "session_trace", "agents", "reviewer", "runs", run.id),
    );
    expect(agentJson).toMatchObject({
      id: "reviewer",
      metadata: {
        agentName: "Reviewer",
      },
    });
  });

  it("rejects unsafe session and agent ids before creating paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();

    expect(
      () =>
        new FileRunStore(run, {
          sessionRootDir: root,
          sessionId: "../escape",
          agentId: "main",
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new FileRunStore(run, {
          sessionRootDir: root,
          sessionId: "session_safe",
          agentId: "../escape",
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new FileRunStore(createRunRecord({ agentId: "../escape" }), {
          sessionRootDir: root,
          sessionId: "session_safe",
        }),
    ).toThrow(TypeError);
  });

  it("creates session-scoped file run stores from a factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-sessions-"));
    tempDirs.push(root);
    const run = createRunRecord({ agentId: "planner" });
    const factory = createSessionFileRunStoreFactory({
      sessionRootDir: root,
      sessionId: "session_factory",
      traceLevel: "debug",
    });

    const store = factory(run);

    expect(store.traceLevel).toBe("debug");
    expect(store.tracePath).toBe(join(root, "session_factory", "trace.jsonl"));
    expect(store.agentId).toBe("planner");
    expect(store.runDir).toBe(
      join(root, "session_factory", "agents", "planner", "runs", run.id),
    );
  });

  it("loads persisted run events from JSONL traces", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, {
      rootDir: root,
      traceLevel: "debug",
      redact: false,
    });

    store.append(log.emit("run.created", { goal: run.goal }));
    appendFileSync(store.tracePath, "\n", "utf8");
    store.append(log.emit("run.started", { attempt: 1 }));

    const events = await collect(store.loadEvents(run.id));

    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "run.started",
    ]);
    expect(events[0]).toMatchObject({
      runId: run.id,
      sequence: 1,
      payload: { goal: run.goal },
    });
  });

  it("summarizes trace JSONL into derived analytics", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("run.created", { goal: run.goal }, { sessionId: "s1" }),
      log.emit("tool.requested", { toolName: "read_file" }),
      log.emit("model.completed", {
        usage: {
          inputTokens: 3,
          outputTokens: 5,
          totalTokens: 8,
          estimatedCostUsd: 0.01,
        },
      }),
      log.emit("artifact.created", {
        id: "artifact_1",
        type: "text",
        name: "note",
        metadata: {},
      }),
      log.emit("run.completed", { state: "completed" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    expect(summary).toMatchObject({
      eventCount: 5,
      runIds: [run.id],
      sessionIds: ["s1"],
      byType: {
        "run.created": 1,
        "tool.requested": 1,
        "model.completed": 1,
        "artifact.created": 1,
        "run.completed": 1,
      },
      terminalStates: { completed: 1 },
      toolCalls: { read_file: 1 },
      artifactCount: 1,
      errorCount: 0,
      errorCodes: {},
      usage: {
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 8,
        estimatedCostUsd: 0.01,
      },
    });
  });

  it("counts each tool call once across requested + started events", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("run.created", { goal: run.goal }, { sessionId: "s1" }),
      log.emit("tool.requested", { toolName: "read_file" }),
      log.emit("tool.started", { toolName: "read_file" }),
      log.emit("tool.completed", { toolName: "read_file" }),
      log.emit("run.completed", { state: "completed" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    expect(summary.toolCalls).toEqual({ read_file: 1 });
  });

  it("classifies approval denials separately from unexpected errors", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("workspace.write.denied", {
        proposalId: "write_1",
        path: "README.md",
        reason: "approval_denied",
      }),
      log.emit("tool.failed", {
        toolCallId: "call_1",
        status: "failed",
        error: { code: "APPROVAL_DENIED", message: "denied" },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    expect(summary.errorCount).toBe(0);
    expect(summary.errorCodes).toEqual({});
    expect(summary.expectedDenialCount).toBe(2);
    expect(summary.expectedDenialCodes).toEqual({
      "workspace.write.denied": 1,
      APPROVAL_DENIED: 1,
    });
  });

  it("does not double count cumulative usage snapshots in summaries", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("model.completed", {
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      }),
      log.emit("usage.updated", {
        tokens: { input: 3, output: 5, total: 8 },
        totalTokens: 8,
      }),
      log.emit("model.completed", { totalTokens: 4 }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    expect(summary.usage.totalTokens).toBe(12);
    expect(summary.usage.inputTokens).toBe(3);
    expect(summary.usage.outputTokens).toBe(5);
  });

  it("uses latest usage snapshots when model usage is unavailable", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("usage.updated", { totalTokens: 3 }),
      log.emit("usage.updated", { totalTokens: 7 }),
    ]
      .map(serializeEventJsonl)
      .join("");

    expect(summarizeTraceJsonl(jsonl).usage.totalTokens).toBe(7);
  });

  it("filters trace events from JSONL", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("run.created", { goal: run.goal }),
      log.emit("tool.failed", { toolName: "read_file", error: "boom" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    expect(
      loadTraceEventsJsonl(jsonl, { type: "tool.failed", contains: "boom" }),
    ).toHaveLength(1);
    expect(loadTraceEventsJsonl(jsonl, { contains: "missing" })).toHaveLength(
      0,
    );
  });

  it("builds a trace timeline from event pairs", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const events = [
      log.emit("run.created", { goal: run.goal }, { sessionId: "s1" }),
      log.emit("run.started", { attempt: 1 }, { sessionId: "s1" }),
      log.emit("model.requested", { step: 1 }, { sessionId: "s1" }),
      log.emit("model.stream.started", { step: 1 }, { sessionId: "s1" }),
      log.emit(
        "model.stream.chunk",
        { type: "text_delta", text: "done" },
        { sessionId: "s1" },
      ),
      log.emit("model.stream.completed", { step: 1 }, { sessionId: "s1" }),
      log.emit(
        "model.completed",
        { step: 1, message: "done" },
        { sessionId: "s1" },
      ),
      log.emit(
        "tool.started",
        { toolCallId: "tool_1", toolName: "read_file" },
        { sessionId: "s1", agentId: "main" },
      ),
      log.emit(
        "tool.completed",
        { toolCallId: "tool_1", status: "ok" },
        { sessionId: "s1", agentId: "main" },
      ),
      log.emit("run.completed", { state: "completed" }, { sessionId: "s1" }),
    ];
    const timeline = buildTraceTimelineJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(timeline).toMatchObject({
      eventCount: 10,
      runIds: [run.id],
      sessionIds: ["s1"],
      agentIds: ["main"],
    });
    expect(timeline.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "run",
          status: "completed",
          startSequence: 1,
          endSequence: 10,
        }),
        expect.objectContaining({
          category: "model",
          status: "completed",
          eventTypes: ["model.requested", "model.completed"],
        }),
        expect.objectContaining({
          category: "tool",
          status: "completed",
          label: "tool read_file",
        }),
      ]),
    );
    expect(
      timeline.phases.map((phase) => phase.eventTypes).flat(),
    ).not.toContain("model.stream.chunk");
  });

  it("uses semantic phase keys before spans in trace timelines", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const span = (spanId: string) => ({
      __span: { traceId: "trace_1", spanId },
    });
    const events = [
      log.emit("run.created", { goal: run.goal }),
      log.emit("run.started", {}, span("span_run")),
      log.emit("model.turn.started", {}, span("span_turn_1")),
      log.emit("model.requested", { step: 1 }, span("span_model_1")),
      log.emit(
        "model.completed",
        { step: 1, message: "ok" },
        span("span_model_1"),
      ),
      log.emit("model.turn.completed", {}, span("span_turn_1")),
      log.emit(
        "workspace.anchored_edit.requested",
        { path: "README.md" },
        span("span_edit_1"),
      ),
      log.emit(
        "workspace.anchored_edit.verified",
        { path: "README.md" },
        span("span_edit_1"),
      ),
      log.emit("run.completed", { reason: "final_answer" }, span("span_run")),
    ];

    const timeline = buildTraceTimelineJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(timeline.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "run",
          status: "completed",
          startSequence: 1,
          endSequence: 9,
        }),
        expect.objectContaining({
          category: "model",
          status: "completed",
          eventTypes: ["model.requested", "model.completed"],
        }),
        expect.objectContaining({
          category: "workspace",
          status: "completed",
          eventTypes: [
            "workspace.anchored_edit.requested",
            "workspace.anchored_edit.verified",
          ],
        }),
      ]),
    );
    expect(timeline.phases).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          eventTypes: expect.arrayContaining(["run.started"]),
        }),
        expect.objectContaining({
          eventTypes: expect.arrayContaining(["model.turn.completed"]),
        }),
        expect.objectContaining({
          status: "pending",
          eventTypes: expect.arrayContaining([
            "workspace.anchored_edit.requested",
          ]),
        }),
      ]),
    );
  });

  it("validates session trace consistency", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-sessions-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const sessionRootDir = root;
    const factory = createSessionRunStoreFactory({
      sessionStore: new FileSessionStore({ rootDir: sessionRootDir }),
      sessionId: "session_check",
      runStoreFactory: createSessionFileRunStoreFactory({
        sessionRootDir,
        sessionId: "session_check",
        agentId: "main",
        traceLevel: "debug",
      }),
    });
    const store = factory(run);

    await store.append(log.emit("run.created", { goal: run.goal }));
    run.state = "completed";
    run.stopReason = "final_answer";
    await store.append(log.emit("run.completed", { state: "completed" }));
    await store.finish(run, {
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
      metadata: {},
    });

    const report = await validateSessionTraceConsistency({
      sessionDir: join(root, "session_check"),
    });

    expect(report).toMatchObject({
      ok: true,
      sessionId: "session_check",
      runIds: [run.id],
    });
    expect(report.findings).toEqual([]);
  });

  it("repairs derived session metadata from trace evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-sessions-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const sessionRootDir = root;
    const factory = createSessionRunStoreFactory({
      sessionStore: new FileSessionStore({ rootDir: sessionRootDir }),
      sessionId: "session_repair",
      runStoreFactory: createSessionFileRunStoreFactory({
        sessionRootDir,
        sessionId: "session_repair",
        agentId: "main",
      }),
    });
    const store = factory(run);
    await store.append(log.emit("run.created", { goal: run.goal }));
    await store.finish(run, {
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
      metadata: {},
    });
    const sessionPath = join(root, "session_repair", "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      sessionPath,
      `${JSON.stringify(
        {
          ...session,
          runIds: [],
          agents: [],
          eventCount: 999,
          updatedAt: "2000-01-01T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const dryRun = await repairSessionTraceConsistency({
      sessionDir: join(root, "session_repair"),
    });
    const applied = await repairSessionTraceConsistency({
      sessionDir: join(root, "session_repair"),
      apply: true,
    });

    expect(dryRun.applied).toBe(false);
    expect(dryRun.actions).toHaveLength(1);
    expect(applied.after?.ok).toBe(true);
    expect(JSON.parse(await readFile(sessionPath, "utf8"))).toMatchObject({
      runIds: [run.id],
      agents: ["main"],
      eventCount: 2,
      updatedAt: expect.not.stringMatching(/^2000-/),
    });
  });

  it("persists final run state and result evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const store = new FileRunStore(run, { rootDir: root });

    run.state = "completed";
    run.stopReason = "final_answer";
    run.updatedAt = new Date().toISOString();
    store.finish(run, {
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
      message: "done",
      metadata: {
        message: "done",
      },
    });

    const runJson = JSON.parse(
      await readFile(join(store.runDir, "run.json"), "utf8"),
    ) as RunRecord;
    const resultJson = JSON.parse(await readFile(store.resultPath, "utf8")) as {
      signal: string;
      state: string;
      stopReason: string;
    };

    expect(runJson).toMatchObject({
      state: "completed",
      stopReason: "final_answer",
    });
    expect(resultJson).toMatchObject({
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
    });
  });

  it("persists artifact files and metadata when artifact events are appended", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, { rootDir: root });
    const artifactId = createArtifactId();

    store.append(
      log.emit("artifact.created", {
        id: artifactId,
        runId: run.id,
        type: "diff",
        name: "README.md diff",
        content: "--- a/README.md\n+++ b/README.md\n",
        metadata: {
          targetPath: "README.md",
        },
      }),
    );

    const artifactPath = join(store.artifactsDir, `${artifactId}.diff`);
    const metadataPath = join(store.artifactsDir, `${artifactId}.json`);

    expect(existsSync(artifactPath)).toBe(true);
    expect(existsSync(metadataPath)).toBe(true);
    await expect(readFile(artifactPath, "utf8")).resolves.toContain(
      "--- a/README.md",
    );
    await expect(readFile(metadataPath, "utf8")).resolves.toContain(
      "README.md diff",
    );
  });

  it("rejects unsafe artifact ids before materializing artifact files", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, { rootDir: root });

    expect(() =>
      store.append(
        log.emit("artifact.created", {
          id: "../escape" as unknown as ArtifactId,
          runId: run.id,
          type: "log",
          name: "unsafe",
          content: "unsafe",
          metadata: {},
        }),
      ),
    ).toThrow(TypeError);
  });

  it("redacts artifact content and metadata by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, { rootDir: root });
    const artifactId = createArtifactId();

    store.append(
      log.emit("artifact.created", {
        id: artifactId,
        runId: run.id,
        type: "log",
        name: "provider log",
        content:
          "Authorization: Bearer token-secret-12345\napi key sk-testsecret12345",
        metadata: {
          apiKey: "sk-metadatasecret12345",
          note: "safe metadata",
        },
      }),
    );

    const artifactPath = join(store.artifactsDir, `${artifactId}.log`);
    const metadataPath = join(store.artifactsDir, `${artifactId}.json`);
    const artifactContent = await readFile(artifactPath, "utf8");
    const metadataContent = await readFile(metadataPath, "utf8");

    expect(artifactContent).not.toContain("token-secret");
    expect(artifactContent).not.toContain("sk-testsecret");
    expect(metadataContent).not.toContain("sk-metadatasecret");
    expect(metadataContent).toContain("safe metadata");
    expect(`${artifactContent}\n${metadataContent}`).toContain("[redacted]");
  });

  it("filters debug traces without changing event payloads", () => {
    const log = new EventLog(createRunId());
    const event = log.emit("model.completed", {
      message: "full response",
      toolCalls: [{ toolName: "echo", arguments: { text: "hello" } }],
    });

    expect(filterTraceEvent(event, "debug")).toBe(event);
  });

  it("summarizes payloads for standard traces", () => {
    const log = new EventLog(createRunId());
    const event = log.emit("tool.completed", {
      toolCallId: "call_1",
      status: "completed",
      output: {
        text: "x".repeat(600),
      },
      artifacts: [],
    });

    const filtered = filterTraceEvent(event, "standard");

    expect(filtered.payload).toMatchObject({
      toolCallId: "call_1",
      status: "completed",
      output: {
        text: {
          type: "string",
          length: 600,
        },
      },
    });
  });

  it("keeps model diagnostics in standard traces", () => {
    const log = new EventLog(createRunId());
    const event = log.emit("model.completed", {
      message: "done",
      usage: { totalTokens: 7 },
      trace: {
        attempt: 1,
        maxAttempts: 3,
        retryCount: 0,
        streaming: true,
        durationMs: 120,
        ttftMs: 30,
        ttltMs: 120,
        requestStartedAt: "2026-01-01T00:00:00.000Z",
        requestCompletedAt: "2026-01-01T00:00:00.120Z",
        outputTokensPerSecond: 10,
        toolCallCount: 0,
      },
    });

    const filtered = filterTraceEvent(event, "standard");

    expect(filtered.payload).toMatchObject({
      trace: {
        attempt: 1,
        durationMs: 120,
        ttftMs: 30,
        outputTokensPerSecond: 10,
      },
    });
  });

  it("keeps only execution skeleton for minimal traces", () => {
    const log = new EventLog(createRunId());
    const event = log.emit("model.completed", {
      message: "full response",
      toolCalls: [{ toolName: "echo", arguments: { text: "secret" } }],
    });

    const filtered = filterTraceEvent(event, "minimal");

    expect(filtered.payload).toEqual({
      hasMessage: true,
      toolCallCount: 1,
    });
  });

  it("applies trace level filtering to file-backed traces", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, {
      rootDir: root,
      traceLevel: "minimal",
      redact: false,
    });

    store.append(
      log.emit("model.completed", {
        message: "full response",
        toolCalls: [{ toolName: "echo", arguments: { text: "secret" } }],
        usage: { totalTokens: 3 },
      }),
    );

    const trace = await readFile(store.tracePath, "utf8");
    const persisted = JSON.parse(trace) as { payload: unknown };

    expect(persisted.payload).toEqual({
      hasMessage: true,
      toolCallCount: 1,
      totalTokens: 3,
    });
    expect(trace).not.toContain("full response");
    expect(trace).not.toContain("secret");
  });

  it("keeps workspace write proposal ids in minimal traces", () => {
    const runId = createRunId();
    const log = new EventLog(runId);
    const event = log.emit("workspace.write.requested", {
      id: "write_1",
      runId,
      path: "README.md",
      content: "# Updated\n",
      diff: "--- a/README.md\n+++ b/README.md\n",
      reason: "test write",
      createdAt: new Date().toISOString(),
      metadata: {},
    });

    const filtered = filterTraceEvent(event, "minimal");

    expect(filtered.payload).toEqual({
      id: "write_1",
      path: "README.md",
      reason: "test write",
    });
  });

  it("keeps anchored edit evidence in minimal traces", () => {
    const log = new EventLog(createRunId());
    const event = log.emit("workspace.anchored_edit.rejected", {
      path: "README.md",
      edits: [
        {
          op: "replace",
          anchor: "2#ABCD",
          lines: ["updated"],
        },
      ],
      reason: "Anchor hash does not match current line: 2#ABCD",
      error: {
        code: "ANCHOR_HASH_MISMATCH",
        message: "Anchor hash does not match current line: 2#ABCD",
      },
    });

    const filtered = filterTraceEvent(event, "minimal");

    expect(filtered.payload).toEqual({
      path: "README.md",
      reason: "Anchor hash does not match current line: 2#ABCD",
      errorCode: "ANCHOR_HASH_MISMATCH",
    });
  });

  it("keeps validation evidence in minimal traces", () => {
    const log = new EventLog(createRunId());
    const event = log.emit("validation.failed", {
      hookName: "final-answer-policy",
      stage: "final_output",
      result: {
        status: "failed",
        findings: [
          {
            code: "FINAL_TOO_LOOSE",
            message: "Final answer is not specific enough.",
          },
        ],
      },
      metadata: {
        large: "x".repeat(600),
      },
    });

    const filtered = filterTraceEvent(event, "minimal");

    expect(filtered.payload).toEqual({
      hookName: "final-answer-policy",
      stage: "final_output",
      status: "failed",
      findingCount: 1,
    });
  });

  it("summarizes validation findings in standard traces", () => {
    const log = new EventLog(createRunId());
    const event = log.emit("validation.failed", {
      hookName: "tool-output-policy",
      stage: "tool_result",
      result: {
        status: "failed",
        findings: [
          {
            code: "BAD_TOOL_OUTPUT",
            message: "x".repeat(600),
            severity: "error",
            metadata: {
              nested: "kept small",
            },
          },
        ],
      },
      metadata: {
        toolName: "unchecked",
      },
    });

    const filtered = filterTraceEvent(event, "standard");

    expect(filtered.payload).toMatchObject({
      hookName: "tool-output-policy",
      stage: "tool_result",
      result: {
        status: "failed",
        findings: [
          {
            code: "BAD_TOOL_OUTPUT",
            message: {
              type: "string",
              length: 600,
            },
            severity: "error",
          },
        ],
      },
      metadata: {
        toolName: "unchecked",
      },
    });
  });

  it("applies redactors after trace level filtering", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, {
      rootDir: root,
      traceLevel: "debug",
      redactor(event) {
        return {
          ...event,
          payload: {
            redacted: true,
          },
        };
      },
    });

    store.append(log.emit("model.completed", { message: "secret" }));

    const trace = await readFile(store.tracePath, "utf8");
    expect(JSON.parse(trace)).toMatchObject({
      type: "model.completed",
      payload: {
        redacted: true,
      },
    });
  });

  it("redacts common secrets from file-backed traces by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, {
      rootDir: root,
      traceLevel: "debug",
    });

    store.append(
      log.emit(
        "model.completed",
        {
          message: "Bearer token-abc12345 and sk-testsecret12345",
          config: {
            apiKey: "sk-testsecret67890",
            nested: {
              password: "open-sesame",
            },
          },
        },
        {
          authorization: "Bearer token-secret",
        },
      ),
    );

    const trace = await readFile(store.tracePath, "utf8");
    const persisted = JSON.parse(trace) as {
      payload: unknown;
      metadata: unknown;
    };

    expect(JSON.stringify(persisted)).not.toContain("sk-testsecret");
    expect(JSON.stringify(persisted)).not.toContain("open-sesame");
    expect(JSON.stringify(persisted)).not.toContain("token-secret");
    expect(JSON.stringify(persisted)).toContain("[redacted]");
  });

  it("does not redact ordinary token accounting fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, { rootDir: root });

    store.append(
      log.emit("usage.updated", {
        tokens: 42,
        totalTokens: 42,
        byModel: {
          "test-model": {
            inputTokens: 20,
            outputTokens: 22,
          },
        },
      }),
    );

    const trace = await readFile(store.tracePath, "utf8");
    const persisted = JSON.parse(trace) as { payload: unknown };

    expect(persisted.payload).toMatchObject({
      tokens: 42,
      totalTokens: 42,
      byModel: {
        "test-model": {
          inputTokens: 20,
          outputTokens: 22,
        },
      },
    });
  });

  it("redacts GitHub tokens, AWS access keys, JWTs, and sensitive key names", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, {
      rootDir: root,
      traceLevel: "debug",
    });

    const sampleJwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0" +
      ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

    store.append(
      log.emit(
        "model.completed",
        {
          message: `token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZaAbBcCdDeE and key: AKIAIOSFODNN7EXAMPLE jwt: ${sampleJwt}`,
          config: {
            private_key: "-----BEGIN PRIVATE KEY-----\nMIIE...",
            client_secret: "super-secret-client-value",
            access_key: "raw-access-key-value",
          },
        },
        {},
      ),
    );

    const trace = await readFile(store.tracePath, "utf8");
    const persisted = JSON.parse(trace) as {
      payload: unknown;
      metadata: unknown;
    };
    const serialized = JSON.stringify(persisted);

    // GitHub PAT (classic) redacted
    expect(serialized).not.toContain(
      "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZaAbBcCdDeE",
    );
    // AWS Access Key ID redacted
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    // JWT redacted
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    // Sensitive key names redacted
    expect(serialized).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(serialized).not.toContain("super-secret-client-value");
    expect(serialized).not.toContain("raw-access-key-value");
    expect(serialized).toContain("[redacted]");
  });

  it("can create custom trace redactors", () => {
    const log = new EventLog(createRunId());
    const event = log.emit("tool.completed", {
      output: {
        sessionSecret: "value",
        visible: "keep",
      },
    });
    const redactor = createTraceRedactor({
      replacement: "<hidden>",
      keyPatterns: [/sessionSecret/],
      valuePatterns: [],
    });

    expect(redactor(event).payload).toMatchObject({
      output: {
        sessionSecret: "<hidden>",
        visible: "keep",
      },
    });
  });

  // Regression: re-opening a FileRunStore for a finished run used to
  // overwrite run.json back to the stale (running) state at construction
  // time, leaving result.json and run.json in conflicting states.
  it("preserves run.json when a FileRunStore is reopened", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-reopen-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, {
      sessionId: "session_reopen_a",
      sessionRootDir: root,
    });
    store.append(log.emit("run.created", { goal: run.goal }));
    const completed = { ...run, state: "completed" as const };
    store.finish(completed, {
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
      message: "done",
      metadata: {},
    });

    const runJsonPath = join(
      root,
      "session_reopen_a",
      "agents",
      "main",
      "runs",
      run.id,
      "run.json",
    );
    const persisted = JSON.parse(await readFile(runJsonPath, "utf8")) as {
      state: string;
    };
    expect(persisted.state).toBe("completed");

    // Reopen with the original (stale) record — must NOT clobber.
    new FileRunStore(run, {
      sessionId: "session_reopen_a",
      sessionRootDir: root,
    });
    const after = JSON.parse(await readFile(runJsonPath, "utf8")) as {
      state: string;
    };
    expect(after.state).toBe("completed");
  });

  // Regression: SESSION_EVENTS_UNREADABLE used to be a hard error when
  // a FileRunStore ran without a paired FileSessionStore.
  it("treats a missing session events.jsonl as a warning, not an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-missing-events-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, {
      sessionId: "session_no_events",
      sessionRootDir: root,
    });
    store.append(log.emit("run.created", { goal: run.goal }));
    store.append(
      log.emit("run.completed", {
        state: "completed",
        stopReason: "final_answer",
      }),
    );
    store.finish(run, {
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
      message: "ok",
      metadata: {},
    });

    const report = await validateSessionTraceConsistency({
      sessionDir: join(root, "session_no_events"),
    });
    expect(report.ok).toBe(true);
    expect(
      report.findings.find((f) => f.code === "SESSION_EVENTS_MISSING"),
    ).toMatchObject({ severity: "warning" });
    expect(
      report.findings.find((f) => f.code === "SESSION_EVENTS_UNREADABLE"),
    ).toBeUndefined();
  });

  // Regression: standard-level model.completed used to leak full content
  // when the message was a structured object instead of a plain string.
  it("summarises structured message bodies at the standard trace level", () => {
    const log = new EventLog(createRunId());
    const event = log.emit("model.completed", {
      step: 1,
      message: { role: "assistant", content: "X".repeat(5000) },
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const filtered = filterTraceEvent(event, "standard");
    const size = JSON.stringify(filtered).length;
    expect(size).toBeLessThan(2000);
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function createRunRecord(metadata: Record<string, unknown> = {}): RunRecord {
  const now = new Date().toISOString();

  return {
    id: createRunId(),
    goal: "test",
    state: "running",
    createdAt: now,
    updatedAt: now,
    metadata,
  };
}
