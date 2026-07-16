import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog, type SparkwrightEvent } from "../src/events.js";
import {
  createArtifactId,
  createRunId,
  createTraceId,
  type ArtifactId,
} from "../src/ids.js";
import type { RunRecord } from "../src/types.js";
import {
  createSessionRunStoreFactory,
  FileSessionStore,
} from "../src/session.js";
import {
  createSessionFileRunStoreFactory,
  buildTraceReportJsonl,
  buildTraceTimelineJsonl,
  createTraceRedactor,
  FileRunStore,
  type FileRunStoreOptions,
  filterTraceEvent,
  loadTraceEventsJsonl,
  MemoryTrace,
  repairSessionTraceConsistency,
  restoreTranscriptPrompts,
  serializeEventJsonl,
  summarizeTraceJsonl,
  validateSessionTraceConsistency,
  verifyTraceJsonl,
} from "../src/trace.js";

const TEST_SESSION_ID = "session_trace_test";

function sessionStoreOptions(
  sessionRootDir: string,
  options: Omit<FileRunStoreOptions, "sessionRootDir" | "sessionId"> = {},
): FileRunStoreOptions {
  return {
    sessionRootDir,
    sessionId: TEST_SESSION_ID,
    ...options,
  };
}

function sessionRunDir(sessionRootDir: string, runId: string): string {
  return join(sessionRootDir, TEST_SESSION_ID, "agents", "main", "runs", runId);
}

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

  it("normalizes legacy trace events that omit metadata", () => {
    const jsonl =
      [
        {
          id: "evt_legacy_1",
          runId: "run_legacy",
          type: "run.created",
          timestamp: "2026-01-01T00:00:00.000Z",
          sequence: 1,
          payload: { goal: "legacy" },
        },
        {
          id: "evt_legacy_2",
          runId: "run_legacy",
          type: "run.completed",
          timestamp: "2026-01-01T00:00:01.000Z",
          sequence: 2,
          payload: { state: "completed" },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n";

    const events = loadTraceEventsJsonl(jsonl);
    const report = buildTraceReportJsonl(jsonl);

    expect(events.map((event) => event.metadata)).toEqual([{}, {}]);
    expect(report).toMatchObject({
      verdict: "ok",
      summary: { eventCount: 2 },
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
    const store = new FileRunStore(run, sessionStoreOptions(root));

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
    const store = new FileRunStore(run, sessionStoreOptions(root));

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

  it("keeps folded streams ordered when background task events interleave", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-stream-task-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, {
      sessionRootDir: root,
      sessionId: "session_stream_task",
      agentId: "main",
    });

    store.append(log.emit("model.stream.started", { step: 1 }));
    store.append(
      log.emit("model.stream.chunk", { type: "text_delta", text: "a" }),
    );
    store.append(
      log.emit("task.output", {
        taskId: "task_background",
        channel: "stdout",
        data: "1\n",
      }),
    );
    store.append(
      log.emit("model.stream.chunk", { type: "text_delta", text: "b" }),
    );
    store.append(
      log.emit("task.output", {
        taskId: "task_background",
        channel: "stdout",
        data: "2\n",
      }),
    );
    store.append(log.emit("model.stream.completed", { step: 1 }));

    const sessionJsonl = await readFile(store.tracePath, "utf8");
    const agentJsonl = await readFile(store.agentTracePath!, "utf8");
    const events = sessionJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SparkwrightEvent);

    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "model.stream.started"],
      [2, "model.stream.text"],
      [3, "task.output"],
      [4, "model.stream.text"],
      [5, "task.output"],
      [6, "model.stream.completed"],
    ]);
    expect(agentJsonl).toBe(sessionJsonl);
    expect(
      verifyTraceJsonl(sessionJsonl).findings.filter(
        (finding) => finding.code === "TRACE_SEQUENCE_INVALID",
      ),
    ).toEqual([]);
  });

  it("keeps raw stream chunks at debug level", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-stream-debug-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(
      run,
      sessionStoreOptions(root, { traceLevel: "debug" }),
    );

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

  it("summarizes extension process progress at standard level", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-process-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, sessionStoreOptions(root));

    store.append(
      log.emit("extension.process.started", {
        invocationId: "proc_1",
        name: "hook",
        kind: "workflow_hook",
        runtime: "custom",
      }),
    );
    store.append(
      log.emit("extension.process.progress", {
        invocationId: "proc_1",
        message: "first",
        data: { files: 1 },
      }),
    );
    store.append(
      log.emit("extension.process.progress", {
        invocationId: "proc_1",
        message: "second",
        data: { files: 2 },
      }),
    );
    store.append(
      log.emit("extension.process.completed", {
        invocationId: "proc_1",
        name: "hook",
        kind: "workflow_hook",
        runtime: "custom",
        exitCode: 0,
        progressDropped: 3,
        progressDroppedSamples: [
          { reason: "invalid_json", preview: "SPARKWRIGHT_EVENT: not json" },
        ],
      }),
    );

    const lines = (await readFile(store.tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SparkwrightEvent);

    expect(lines.map((line) => line.type)).toEqual([
      "extension.process.started",
      "extension.process.completed",
    ]);
    expect(lines[1]?.payload).toMatchObject({
      progressCount: 2,
      progressDropped: 3,
      progressHead: [
        expect.objectContaining({ message: "first" }),
        expect.objectContaining({ message: "second" }),
      ],
      progressTail: [],
    });
    expect(lines[1]?.payload).not.toHaveProperty("progressDroppedSamples");
  });

  it("keeps process progress dropped samples at debug trace level", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-process-debug-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(
      run,
      sessionStoreOptions(root, { traceLevel: "debug" }),
    );

    store.append(
      log.emit("extension.process.started", {
        invocationId: "proc_1",
        name: "hook",
        kind: "workflow_hook",
        runtime: "custom",
      }),
    );
    store.append(
      log.emit("extension.process.completed", {
        invocationId: "proc_1",
        name: "hook",
        kind: "workflow_hook",
        runtime: "custom",
        exitCode: 0,
        progressDropped: 1,
        progressDroppedSamples: [
          { reason: "invalid_json", preview: "SPARKWRIGHT_EVENT: not json" },
        ],
      }),
    );

    const lines = (await readFile(store.tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SparkwrightEvent);

    expect(lines[1]?.payload).toMatchObject({
      progressDropped: 1,
      progressDroppedSamples: [
        { reason: "invalid_json", preview: "SPARKWRIGHT_EVENT: not json" },
      ],
    });
  });

  it("verify tolerates the sequence gap from folded standard-level progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-process-verify-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, sessionStoreOptions(root));

    store.append(log.emit("run.started", {}));
    store.append(
      log.emit("extension.process.started", {
        invocationId: "proc_1",
        name: "hook",
        kind: "workflow_hook",
        runtime: "custom",
      }),
    );
    // Two progress events fold into the completed event's progressCount,
    // dropping sequences 3 and 4 from the persisted standard trace.
    store.append(
      log.emit("extension.process.progress", {
        invocationId: "proc_1",
        message: "first",
      }),
    );
    store.append(
      log.emit("extension.process.progress", {
        invocationId: "proc_1",
        message: "second",
      }),
    );
    store.append(
      log.emit("extension.process.completed", {
        invocationId: "proc_1",
        name: "hook",
        kind: "workflow_hook",
        runtime: "custom",
        exitCode: 0,
      }),
    );
    store.append(log.emit("run.completed", { state: "completed" }));

    const jsonl = await readFile(store.tracePath, "utf8");
    // Persisted file skips the two folded progress sequences (2 -> 5).
    const sequences = jsonl
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as SparkwrightEvent).sequence);
    expect(sequences).toEqual([1, 2, 5, 6]);

    const report = verifyTraceJsonl(jsonl);
    expect(
      report.findings.filter((f) => f.code === "TRACE_SEQUENCE_INVALID"),
    ).toEqual([]);
  });

  it("verify still flags a genuine sequence gap that progress folding cannot explain", async () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const started = log.emit("extension.process.started", {
      invocationId: "proc_1",
      name: "hook",
      kind: "workflow_hook",
      runtime: "custom",
    });
    // progressCount of 1 explains a single-sequence gap; this completed event
    // jumps by two, so verify must still report the break.
    const completed: SparkwrightEvent = {
      ...log.emit("extension.process.completed", {
        invocationId: "proc_1",
        name: "hook",
        kind: "workflow_hook",
        runtime: "custom",
        exitCode: 0,
        progressCount: 1,
      }),
      sequence: started.sequence + 3,
    };
    const jsonl = `${serializeEventJsonl(started)}${serializeEventJsonl(completed)}`;

    const report = verifyTraceJsonl(jsonl);
    expect(
      report.findings.some((f) => f.code === "TRACE_SEQUENCE_INVALID"),
    ).toBe(true);
  });

  it("verify does not treat bare progressCount as folded progress evidence", async () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const started = log.emit("extension.process.started", {
      invocationId: "proc_1",
      name: "hook",
      kind: "workflow_hook",
      runtime: "custom",
    });
    const completed: SparkwrightEvent = {
      ...log.emit("extension.process.completed", {
        invocationId: "proc_1",
        name: "hook",
        kind: "workflow_hook",
        runtime: "custom",
        exitCode: 0,
        progressCount: 1,
      }),
      sequence: started.sequence + 2,
    };
    const jsonl = `${serializeEventJsonl(started)}${serializeEventJsonl(completed)}`;

    const report = verifyTraceJsonl(jsonl);
    expect(
      report.findings.some((f) => f.code === "TRACE_SEQUENCE_INVALID"),
    ).toBe(true);
  });

  it("keeps extension process progress at debug level", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-process-debug-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(
      run,
      sessionStoreOptions(root, { traceLevel: "debug" }),
    );

    store.append(
      log.emit("extension.process.started", {
        invocationId: "proc_1",
        name: "hook",
        kind: "workflow_hook",
        runtime: "custom",
      }),
    );
    store.append(
      log.emit("extension.process.progress", {
        invocationId: "proc_1",
        message: "first",
      }),
    );
    store.append(
      log.emit("extension.process.completed", {
        invocationId: "proc_1",
        name: "hook",
        kind: "workflow_hook",
        runtime: "custom",
        exitCode: 0,
      }),
    );

    const types = (await readFile(store.tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as SparkwrightEvent).type);

    expect(types).toEqual([
      "extension.process.started",
      "extension.process.progress",
      "extension.process.completed",
    ]);
  });

  it("groups extension processes in the trace timeline", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const timeline = buildTraceTimelineJsonl(
      [
        log.emit("extension.process.started", {
          invocationId: "proc_1",
          name: "pre-check",
          kind: "workflow_hook",
          runtime: "custom",
        }),
        log.emit("extension.process.completed", {
          invocationId: "proc_1",
          name: "pre-check",
          kind: "workflow_hook",
          runtime: "custom",
          exitCode: 0,
        }),
      ]
        .map(serializeEventJsonl)
        .join(""),
    );

    expect(timeline.phases).toEqual([
      expect.objectContaining({
        category: "extension",
        label: "extension workflow_hook:pre-check",
        status: "completed",
      }),
    ]);
  });

  it("buffers events when disk append fails and flushes on next success", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-degraded-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);

    const errors: unknown[] = [];
    const store = new FileRunStore(run, {
      ...sessionStoreOptions(root),
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
      { role: "system", content: "Tools: read", stability: "session" },
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
      { role: "system", content: "Tools: read", stability: "session" },
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
      ...sessionStoreOptions(root),
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
    const store = new FileRunStore(run, sessionStoreOptions(root));
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
      runStore: (record) => new FileRunStore(record, sessionStoreOptions(root)),
    });

    await run.start();

    const reloaded = loadCheckpointFromRunDir(
      sessionRunDir(root, run.record.id),
    );
    expect(reloaded).toBeDefined();
    expect(reloaded?.metadata).toMatchObject({ auto: true });
    // At least one auto-checkpoint cycle should have fired by step 2.
    expect(
      (reloaded?.metadata as { step?: number }).step ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(reloaded?.eventSequence ?? 0).toBeGreaterThan(0);
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
      runStore: (record) => new FileRunStore(record, sessionStoreOptions(root)),
    });
    await run.start();

    const runDir = sessionRunDir(root, run.record.id);
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

    // Build a canonical session run with a non-terminal run.json and agent trace.
    const runId = createRunId();
    const runDir = sessionRunDir(root, runId);
    const agentTracePath = join(
      root,
      TEST_SESSION_ID,
      "agents",
      "main",
      "trace.jsonl",
    );
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
      agentTracePath,
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
    expect(reconstructed?.eventSequence).toBe(2);

    // Now actually resume it (force required since resumability.complete=false).
    let observedStep = 0;
    const run = resumeRunFromCheckpoint(reconstructed!, {
      force: true,
      runStore: (record) => new FileRunStore(record, sessionStoreOptions(root)),
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
    const report = verifyTraceJsonl(await readFile(agentTracePath, "utf8"));
    expect(report.findings).toEqual([]);
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
      runStore: (record) => new FileRunStore(record, sessionStoreOptions(root)),
    });

    // Persist a checkpoint mid-flight (here: pre-start; loop.step=0). Just
    // exercises the save path; resumability flag will be honored by P4.
    const ck = run.persistCheckpoint({ marker: "pre-start" });
    expect(ck.metadata).toEqual({ marker: "pre-start" });

    await run.start();

    const runDir = sessionRunDir(root, run.record.id);
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
      ...sessionStoreOptions(root),
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
    const tracePointer = JSON.parse(
      await readFile(join(store.runDir, "trace-pointer.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(tracePointer).toMatchObject({
      schemaVersion: "trace-pointer.v1",
      runId: run.id,
      sessionId: "session_trace",
      agentId: "agent_a",
      tracePath: "../../../../trace.jsonl",
      agentTracePath: "../../trace.jsonl",
    });
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
      ...sessionStoreOptions(root),
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
      log.emit("tool.requested", { toolName: "read" }),
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
      toolCalls: { read: 1 },
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

  it("builds a human-oriented trace report from noisy successful runs", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const events: SparkwrightEvent[] = [
      log.emit("run.created", { goal: run.goal }, { sessionId: "s1" }),
    ];

    for (let i = 0; i < 25; i += 1) {
      events.push(
        log.emit("model.completed", {
          step: i + 1,
          usage: {
            inputTokens: 10,
            outputTokens: 1,
            totalTokens: 11,
          },
        }),
      );
    }
    for (let i = 0; i < 85; i += 1) {
      events.push(
        log.emit("tool.requested", {
          id: `call_${i}`,
          toolName: i % 2 === 0 ? "read" : "grep",
          arguments: { path: i % 2 === 0 ? "README.md" : "packages" },
        }),
      );
    }
    for (let i = 0; i < 1000; i += 1) {
      events.push(
        log.emit("workspace.read", {
          path: i < 20 ? "packages/core/src/trace.ts" : `packages/file-${i}.ts`,
        }),
      );
    }
    events.push(log.emit("run.completed", { state: "completed" }));

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.verdict).toBe("passed_with_issues");
    expect(report.summary).toMatchObject({
      modelCalls: 25,
      toolCalls: 85,
      totalTokens: 275,
      workspaceWrites: 0,
      approvalsRequested: 0,
    });
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "EXCESSIVE_TOOL_CALLS",
        "EXCESSIVE_MODEL_CALLS",
        "WORKSPACE_READ_NOISE",
        "DUPLICATE_WORKSPACE_READS",
        "REPEATED_TOOL_REQUESTS",
        "COST_UNAVAILABLE",
      ]),
    );
    expect(report.topDuplicateReads).toMatchObject({
      "packages/core/src/trace.ts": 20,
    });
  });

  it("attributes workspace read noise to enclosing tool spans", () => {
    const runId = createRunId();
    const log = new EventLog(runId);
    const events: SparkwrightEvent[] = [
      log.emit("run.created", { goal: "span attribution" }),
      withTestSpan(
        log.emit("tool.requested", {
          id: "call_grep",
          toolName: "grep",
          arguments: { pattern: "needle" },
        }),
        "span_grep",
      ),
    ];

    for (let i = 0; i < 6; i += 1) {
      events.push(
        withTestSpan(
          log.emit("workspace.read", { path: `src/file-${i}.ts` }),
          "span_grep",
        ),
      );
    }

    events.push(
      withTestSpan(
        log.emit("tool.completed", {
          id: "call_grep",
          toolName: "grep",
          output: { matches: [] },
        }),
        "span_grep",
      ),
      withTestSpan(
        log.emit("tool.requested", {
          id: "call_read",
          toolName: "read_text",
          arguments: { path: "src/index.ts" },
        }),
        "span_read",
      ),
      withTestSpan(
        log.emit("workspace.read", { path: "src/index.ts" }),
        "span_read",
      ),
      withTestSpan(
        log.emit("workspace.read", { path: "src/other.ts" }),
        "span_read",
      ),
      withTestSpan(
        log.emit("tool.completed", {
          id: "call_read",
          toolName: "read_text",
          output: { path: "src/index.ts" },
        }),
        "span_read",
      ),
      log.emit("run.completed", { state: "completed" }),
    );

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );
    const finding = report.findings.find(
      (item) => item.code === "WORKSPACE_READ_NOISE",
    );

    expect(finding?.evidence).toEqual(
      expect.arrayContaining([
        "workspace reads by tool: grep:6, read_text:2",
        "scan reads by tool: grep:6",
        "explicit file reads by tool: read_text:2",
      ]),
    );
  });

  it("reports traces that are missing a terminal run event", () => {
    const runId = createRunId();
    const log = new EventLog(runId);
    const events: SparkwrightEvent[] = [
      log.emit("run.created", { goal: "missing terminal" }),
      log.emit("tool.requested", {
        id: "call_1",
        toolName: "bash",
        arguments: { command: "pwd", timeoutMs: 0 },
      }),
    ];

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.verdict).toBe("failed");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          code: "TRACE_TERMINAL_EVENT_COUNT_INVALID",
          evidence: [`${runId}: terminalCount=0`],
        }),
      ]),
    );
  });

  it("sorts trace report findings by severity and code", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const events: SparkwrightEvent[] = [
      log.emit("run.created", { goal: "sort findings" }),
      log.emit("model.completed", {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    ];

    for (let i = 0; i < 85; i += 1) {
      events.push(
        log.emit("tool.requested", {
          id: `read_${i}`,
          toolName: "read",
          arguments: { path: "README.md" },
        }),
      );
    }
    for (let i = 0; i < 10; i += 1) {
      events.push(log.emit("workspace.read", { path: "README.md" }));
    }
    events.push(log.emit("run.completed", { state: "completed" }));

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.findings.map((finding) => finding.code)).toEqual([
      "DUPLICATE_WORKSPACE_READS",
      "EXCESSIVE_TOOL_CALLS",
      "REPEATED_TOOL_REQUESTS",
      "COST_UNAVAILABLE",
    ]);
  });

  it("reports multi-agent auditability findings from structured trace facts", () => {
    const log = new EventLog(createRunId());
    const events: SparkwrightEvent[] = [
      log.emit("run.created", { goal: "audit agents" }, { sessionId: "s1" }),
      log.emit(
        "subagent.completed",
        {
          childRunId: "run_child_1",
          parentRunId: "run_parent",
          terminalState: "truncated",
          truncated: true,
        },
        {
          agentName: "reviewer",
          childRunId: "run_child_1",
          parentRunId: "run_parent",
          subagentDepth: 1,
        },
      ),
      log.emit("approval.requested", {
        id: "approval_1",
        action: "tool.execute",
        summary: "delegate_review",
      }),
      log.emit("approval.resolved", {
        approvalId: "approval_1",
        decision: "denied",
      }),
      log.emit("approval.requested", {
        id: "approval_2",
        action: "tool.execute",
        summary: "delegate_review",
      }),
      log.emit("approval.resolved", {
        approvalId: "approval_2",
        decision: "denied",
      }),
      ...Array.from({ length: 3 }, (_, index) =>
        log.emit("tool.failed", {
          toolCallId: `dup_${index}`,
          toolName: "delegate_review",
          status: "failed",
          error: {
            code: "DUPLICATE_TOOL_CALL_SKIPPED",
            message: "still running",
            metadata: { duplicateKind: "in_flight_duplicate" },
          },
        }),
      ),
      log.emit("workspace.write.untracked_access_granted", {
        childRunId: "cmd_writer",
        parentRunId: "run_parent",
        toolName: "delegate_external",
        agentProfileId: "writer",
        marker: "untracked-write-capable",
        access: "granted",
      }),
      log.emit("run.completed", { state: "completed" }),
    ];

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          code: "SUBAGENT_INCOMPLETE",
          evidence: expect.arrayContaining([
            expect.stringContaining("reviewer truncated"),
          ]),
        }),
        expect.objectContaining({
          severity: "high",
          code: "REPEATED_APPROVAL_DENIALS",
          evidence: ["2x delegate_review"],
        }),
        expect.objectContaining({
          severity: "medium",
          code: "IN_FLIGHT_DUPLICATE_STORM",
          evidence: ["3x delegate_review in-flight duplicate"],
        }),
        expect.objectContaining({
          severity: "medium",
          code: "UNTRACKED_WRITE_CAPABLE_BOUNDARY",
          evidence: expect.arrayContaining([
            expect.stringContaining("delegate_external"),
          ]),
        }),
      ]),
    );
  });

  it("downgrades incomplete sub-agent severity only when parent verifies after child write", () => {
    const parentRunId = createRunId();
    const parentLog = new EventLog(parentRunId);
    const childRunId = createRunId();
    const childLog = new EventLog(childRunId);
    const events: SparkwrightEvent[] = [
      parentLog.emit("run.created", { goal: "delegate and verify" }),
      childLog.emit("workspace.write.completed", {
        path: "src/cart.ts",
        bytes: 42,
      }),
      parentLog.emit(
        "subagent.completed",
        {
          childRunId,
          parentRunId,
          terminalState: "step_limit",
          stepLimitReached: true,
          workspaceWrites: 1,
        },
        {
          agentName: "writer",
          childRunId,
          parentRunId,
          subagentDepth: 1,
        },
      ),
      parentLog.emit("tool.requested", {
        id: "verify",
        toolName: "bash",
        arguments: { command: "npm test" },
      }),
      parentLog.emit("tool.completed", {
        toolCallId: "verify",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 0, timedOut: false },
      }),
      parentLog.emit("run.completed", { state: "completed" }),
    ];

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "medium",
          code: "SUBAGENT_INCOMPLETE",
          evidence: expect.arrayContaining([
            expect.stringContaining("verifiedAfterChildWrite"),
          ]),
        }),
      ]),
    );
    expect(
      report.findings.some(
        (finding) =>
          finding.code === "SUBAGENT_INCOMPLETE" && finding.severity === "high",
      ),
    ).toBe(false);
    // The child's `workspace.write.completed` carries the child runId but has no
    // `run.created`/`run.*` terminal in this trace; it must not be mistaken for a
    // run with a missing terminal.
    expect(
      report.findings.some(
        (finding) => finding.code === "TRACE_TERMINAL_EVENT_COUNT_INVALID",
      ),
    ).toBe(false);
  });

  it("keeps incomplete sub-agent severity high when verification predates the child write", () => {
    const parentRunId = createRunId();
    const parentLog = new EventLog(parentRunId);
    const childRunId = createRunId();
    const childLog = new EventLog(childRunId);
    const events: SparkwrightEvent[] = [
      parentLog.emit("run.created", { goal: "delegate and verify" }),
      parentLog.emit("tool.requested", {
        id: "verify",
        toolName: "bash",
        arguments: { command: "npm test" },
      }),
      parentLog.emit("tool.completed", {
        toolCallId: "verify",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 0, timedOut: false },
      }),
      childLog.emit("workspace.write.completed", {
        path: "src/cart.ts",
        bytes: 42,
      }),
      parentLog.emit(
        "subagent.completed",
        {
          childRunId,
          parentRunId,
          terminalState: "step_limit",
          stepLimitReached: true,
          workspaceWrites: 1,
        },
        {
          agentName: "writer",
          childRunId,
          parentRunId,
          subagentDepth: 1,
        },
      ),
      parentLog.emit("run.completed", { state: "completed" }),
    ];

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          code: "SUBAGENT_INCOMPLETE",
        }),
      ]),
    );
  });

  it("keeps sandboxed untracked write-capable boundaries at medium severity", () => {
    const log = new EventLog(createRunId());
    const jsonl = [
      log.emit("run.created", { goal: "promote shell" }),
      log.emit("workspace.write.untracked_access_granted", {
        taskId: "task_writer",
        parentRunId: "run_parent",
        toolName: "bash",
        protocol: "promoted_shell",
        marker: "untracked-write-capable",
        access: "granted",
        sandboxMode: "enforce",
        filesystemIsolation: "bind-allowlist",
        sandboxAvailable: true,
      }),
      log.emit("run.completed", { state: "completed" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const report = buildTraceReportJsonl(jsonl);

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "medium",
          code: "UNTRACKED_WRITE_CAPABLE_BOUNDARY",
          evidence: expect.arrayContaining([
            expect.stringContaining("protocol promoted_shell"),
            expect.stringContaining("fs bind-allowlist"),
          ]),
        }),
      ]),
    );
  });

  it("does not report an in-flight duplicate storm for one skipped duplicate", () => {
    const log = new EventLog(createRunId());
    const jsonl = [
      log.emit("run.created", { goal: "one duplicate" }),
      log.emit("tool.failed", {
        toolCallId: "dup_1",
        toolName: "read",
        status: "failed",
        error: {
          code: "DUPLICATE_TOOL_CALL_SKIPPED",
          message: "still running",
          metadata: { duplicateKind: "in_flight_duplicate" },
        },
      }),
      log.emit("run.completed", { state: "completed" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const report = buildTraceReportJsonl(jsonl);

    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "IN_FLIGHT_DUPLICATE_STORM",
    );
  });

  it("reports a destructive mutation that succeeded then returned not-found on the same target", () => {
    const log = new EventLog(createRunId());
    const jsonl = [
      log.emit("run.created", { goal: "Delete the testcron job" }),
      log.emit("tool.requested", {
        id: "call_remove_ok",
        toolName: "cron",
        arguments: { action: "remove", ref: "c26560f10002" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_remove_ok",
        toolName: "cron",
        status: "completed",
        output: { action: "remove", changed: true },
      }),
      log.emit("tool.requested", {
        id: "call_remove_again",
        toolName: "cron",
        arguments: { action: "remove", ref: "c26560f10002", job: { name: "" } },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_remove_again",
        toolName: "cron",
        status: "failed",
        error: {
          code: "TOOL_EXECUTION_FAILED",
          message: "cron job not found: c26560f10002",
        },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const report = buildTraceReportJsonl(jsonl);

    // The post-deletion not-found must NOT show up as an unresolved failure...
    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "UNRESOLVED_TOOL_FAILURES",
    );
    // ...and the high-signal pattern must be surfaced explicitly.
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "medium",
          code: "DESTRUCTIVE_MUTATION_THEN_NOT_FOUND",
          evidence: expect.arrayContaining([
            expect.stringContaining("cron::ref::c26560f10002"),
          ]),
        }),
      ]),
    );
  });

  it("recomputes over raw events so a stale persisted snapshot does not mask the new classification", () => {
    const log = new EventLog(createRunId());
    // The run was recorded BEFORE the destructive-mutation classifier existed,
    // so its persisted run.completed.toolOutcome lacks `mutationFollowups` and
    // still counts the post-deletion not-found as unresolved. Because the raw
    // events retain tool.requested arguments, the report must recompute and
    // surface the correct classification instead of trusting the stale snapshot.
    const jsonl = [
      log.emit("run.created", { goal: "Delete the testcron job" }),
      log.emit("tool.requested", {
        id: "call_remove_ok",
        toolName: "cron",
        arguments: { action: "remove", ref: "c26560f10002" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_remove_ok",
        toolName: "cron",
        status: "completed",
        output: { action: "remove", changed: true },
      }),
      log.emit("tool.requested", {
        id: "call_remove_again",
        toolName: "cron",
        arguments: { action: "remove", ref: "c26560f10002" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_remove_again",
        toolName: "cron",
        status: "failed",
        error: {
          code: "TOOL_EXECUTION_FAILED",
          message: "cron job not found: c26560f10002",
        },
      }),
      log.emit("run.completed", {
        reason: "final_answer",
        // Stale snapshot shape from before the classifier change.
        toolOutcome: {
          unresolved: { total: 1, byCode: { TOOL_EXECUTION_FAILED: 1 } },
          recovered: { total: 0, byCode: {} },
        },
      }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const report = buildTraceReportJsonl(jsonl);

    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "UNRESOLVED_TOOL_FAILURES",
    );
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DESTRUCTIVE_MUTATION_THEN_NOT_FOUND",
        }),
      ]),
    );
  });

  it("falls back to the persisted snapshot when raw events stripped tool.requested arguments", () => {
    const log = new EventLog(createRunId());
    // A compacted trace whose tool.requested events no longer carry arguments
    // cannot be reclassified, so the persisted snapshot (here: already recovered)
    // remains authoritative and the report must not invent an unresolved failure.
    const jsonl = [
      log.emit("run.created", { goal: "Read a busy file" }),
      log.emit("tool.requested", { id: "call_read", toolName: "read" }),
      log.emit("tool.failed", {
        toolCallId: "call_read",
        toolName: "read",
        status: "failed",
        error: { code: "EBUSY", message: "resource busy" },
      }),
      log.emit("run.completed", {
        reason: "final_answer",
        toolOutcome: {
          unresolved: { total: 0, byCode: {} },
          recovered: { total: 1, byCode: { EBUSY: 1 } },
        },
      }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const report = buildTraceReportJsonl(jsonl);

    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "UNRESOLVED_TOOL_FAILURES",
    );
  });

  it("does not let an args-bearing run force a recompute that misclassifies a stripped run in a mixed trace", () => {
    const log = new EventLog(createRunId());
    // Mixed multi-run trace: a newer run still carries request arguments, but an
    // older/compacted run stripped them and recorded its EBUSY failure as
    // recovered. Recompute is only safe when EVERY failed call retains its
    // request args, so the stripped run's recovery must be preserved rather than
    // flipped to unresolved by the presence of the other run's arguments.
    const jsonl = [
      // Newer run with request arguments (clean).
      log.emit("run.created", { goal: "newer run with args" }),
      log.emit("tool.requested", {
        id: "call_ok",
        toolName: "read",
        arguments: { path: "x.txt" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_ok",
        toolName: "read",
        status: "completed",
        output: { path: "x.txt" },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
      // Older/compacted run: request args stripped, persisted snapshot recovered.
      log.emit("run.created", { goal: "older compacted run" }),
      log.emit("tool.requested", { id: "call_busy", toolName: "read" }),
      log.emit("tool.failed", {
        toolCallId: "call_busy",
        toolName: "read",
        status: "failed",
        error: { code: "EBUSY", message: "resource busy" },
      }),
      log.emit("run.completed", {
        reason: "final_answer",
        toolOutcome: {
          unresolved: { total: 0, byCode: {} },
          recovered: { total: 1, byCode: { EBUSY: 1 } },
        },
      }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const report = buildTraceReportJsonl(jsonl);

    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "UNRESOLVED_TOOL_FAILURES",
    );
  });

  it("reports repeated failing shell commands without lowering max steps", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const events: SparkwrightEvent[] = [
      log.emit("run.created", { goal: "verify" }, { sessionId: "s1" }),
    ];

    for (let i = 0; i < 2; i += 1) {
      events.push(
        log.emit("tool.requested", {
          id: `call_${i}`,
          toolName: "bash",
          arguments: { command: "npm test -- --runInBand" },
        }),
        log.emit("tool.completed", {
          toolCallId: `call_${i}`,
          toolName: "bash",
          status: "completed",
          output: { exitCode: 1, timedOut: false },
        }),
      );
    }
    events.push(log.emit("run.completed", { state: "completed" }));

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.verdict).toBe("failed");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNRESOLVED_VERIFICATION_FAILURES",
        }),
        expect.objectContaining({
          code: "REPEATED_COMMAND_FAILURES",
          evidence: ["2x npm test -- --runInBand (exit 1)"],
        }),
      ]),
    );
  });

  it("reports low net progress across many model and tool calls", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const events: SparkwrightEvent[] = [
      log.emit("run.created", { goal: "fix a small bug" }, { sessionId: "s1" }),
    ];

    for (let i = 0; i < 9; i += 1) {
      events.push(
        log.emit("model.requested", { step: i }),
        log.emit("model.completed", { step: i, message: `step ${i}` }),
        log.emit("tool.requested", {
          id: `read_${i}`,
          toolName: "read",
          arguments: { path: "src/foo.ts" },
        }),
        log.emit("tool.completed", {
          toolCallId: `read_${i}`,
          toolName: "read",
          status: "completed",
          output: { path: "src/foo.ts" },
        }),
        log.emit("workspace.read", { path: "src/foo.ts" }),
      );
      if (i === 2) {
        events.push(
          log.emit("workspace.write.completed", {
            path: "src/foo.ts",
            bytes: 42,
          }),
        );
      }
    }
    events.push(log.emit("run.completed", { state: "completed" }));

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.verdict).toBe("passed_with_issues");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LOW_NET_PROGRESS",
          evidence: expect.arrayContaining([
            "9 model call(s)",
            "9 tool call(s)",
            "1 unique written file(s)",
            "duplicate reads: src/foo.ts:9",
          ]),
        }),
      ]),
    );
  });

  it("does not add parent and child calls together for low net progress", () => {
    const parent = createRunRecord();
    const child = createRunRecord();
    const parentLog = new EventLog(parent.id);
    const childLog = new EventLog(child.id);
    const events: SparkwrightEvent[] = [
      parentLog.emit(
        "run.created",
        { goal: "review with a background child" },
        {
          sessionId: "s1",
          agentId: "main",
        },
      ),
      childLog.emit(
        "run.created",
        { goal: "independent child review" },
        {
          sessionId: "s1",
          agentId: "child_reader",
        },
      ),
    ];

    for (let i = 0; i < 5; i += 1) {
      events.push(
        parentLog.emit(
          "model.requested",
          { step: i },
          {
            sessionId: "s1",
            agentId: "main",
          },
        ),
        parentLog.emit(
          "model.completed",
          { step: i, message: `parent ${i}` },
          {
            sessionId: "s1",
            agentId: "main",
          },
        ),
        parentLog.emit(
          "tool.requested",
          {
            id: `parent_read_${i}`,
            toolName: "read",
            arguments: { path: `docs/${i}.md` },
          },
          {
            sessionId: "s1",
            agentId: "main",
          },
        ),
        parentLog.emit(
          "tool.completed",
          {
            toolCallId: `parent_read_${i}`,
            toolName: "read",
            status: "completed",
            output: { path: `docs/${i}.md` },
          },
          {
            sessionId: "s1",
            agentId: "main",
          },
        ),
      );
    }

    for (let i = 0; i < 3; i += 1) {
      events.push(
        childLog.emit(
          "model.requested",
          { step: i },
          {
            sessionId: "s1",
            agentId: "child_reader",
          },
        ),
        childLog.emit(
          "model.completed",
          { step: i, message: `child ${i}` },
          {
            sessionId: "s1",
            agentId: "child_reader",
          },
        ),
        childLog.emit(
          "tool.requested",
          {
            id: `child_read_${i}`,
            toolName: "read",
            arguments: { path: `docs/${i}.md` },
          },
          {
            sessionId: "s1",
            agentId: "child_reader",
          },
        ),
        childLog.emit(
          "tool.completed",
          {
            toolCallId: `child_read_${i}`,
            toolName: "read",
            status: "completed",
            output: { path: `docs/${i}.md` },
          },
          {
            sessionId: "s1",
            agentId: "child_reader",
          },
        ),
      );
    }

    events.push(
      parentLog.emit(
        "subagent.completed",
        {
          childRunId: child.id,
          parentRunId: parent.id,
          terminalState: "completed",
          finality: "complete",
        },
        {
          sessionId: "s1",
          agentId: "main",
          childAgentId: "child_reader",
        },
      ),
      childLog.emit(
        "run.completed",
        { state: "completed" },
        {
          sessionId: "s1",
          agentId: "child_reader",
        },
      ),
      parentLog.emit(
        "run.completed",
        { state: "completed" },
        {
          sessionId: "s1",
          agentId: "main",
        },
      ),
    );

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(
      report.findings.some((finding) => finding.code === "LOW_NET_PROGRESS"),
    ).toBe(false);
  });

  it("does not add parent and child calls together for repeated tool requests", () => {
    const parent = createRunRecord();
    const child = createRunRecord();
    const parentLog = new EventLog(parent.id);
    const childLog = new EventLog(child.id);
    const readArgs = { path: "README.md" };
    const events: SparkwrightEvent[] = [
      parentLog.emit(
        "run.created",
        { goal: "review with a background child" },
        {
          sessionId: "s1",
          agentId: "main",
        },
      ),
      childLog.emit(
        "run.created",
        { goal: "independent child review" },
        {
          sessionId: "s1",
          agentId: "child_reader",
        },
      ),
      parentLog.emit(
        "tool.requested",
        {
          id: "parent_read_1",
          toolName: "read",
          arguments: readArgs,
        },
        {
          sessionId: "s1",
          agentId: "main",
        },
      ),
      childLog.emit(
        "tool.requested",
        {
          id: "child_read_1",
          toolName: "read",
          arguments: readArgs,
        },
        {
          sessionId: "s1",
          agentId: "child_reader",
        },
      ),
      parentLog.emit(
        "tool.requested",
        {
          id: "parent_read_2",
          toolName: "read",
          arguments: readArgs,
        },
        {
          sessionId: "s1",
          agentId: "main",
        },
      ),
      parentLog.emit(
        "subagent.completed",
        {
          childRunId: child.id,
          parentRunId: parent.id,
          terminalState: "completed",
          finality: "complete",
        },
        {
          sessionId: "s1",
          agentId: "main",
          childAgentId: "child_reader",
        },
      ),
      childLog.emit(
        "run.completed",
        { state: "completed" },
        {
          sessionId: "s1",
          agentId: "child_reader",
        },
      ),
      parentLog.emit(
        "run.completed",
        { state: "completed" },
        {
          sessionId: "s1",
          agentId: "main",
        },
      ),
    ];

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(
      report.findings.some(
        (finding) => finding.code === "REPEATED_TOOL_REQUESTS",
      ),
    ).toBe(false);
  });

  it("reports repeated tool requests for the child run that actually repeated them", () => {
    const parent = createRunRecord();
    const child = createRunRecord();
    const parentLog = new EventLog(parent.id);
    const childLog = new EventLog(child.id);
    const readArgs = { path: "README.md" };
    const events: SparkwrightEvent[] = [
      parentLog.emit(
        "run.created",
        { goal: "ask a child to inspect" },
        {
          sessionId: "s1",
          agentId: "main",
        },
      ),
      childLog.emit(
        "run.created",
        { goal: "child repeats a read" },
        {
          sessionId: "s1",
          agentId: "child_reader",
        },
      ),
    ];

    for (let i = 0; i < 3; i += 1) {
      events.push(
        childLog.emit(
          "tool.requested",
          {
            id: `child_read_${i}`,
            toolName: "read",
            arguments: readArgs,
          },
          {
            sessionId: "s1",
            agentId: "child_reader",
          },
        ),
      );
    }

    events.push(
      parentLog.emit(
        "subagent.completed",
        {
          childRunId: child.id,
          parentRunId: parent.id,
          terminalState: "completed",
          finality: "complete",
        },
        {
          sessionId: "s1",
          agentId: "main",
          childAgentId: "child_reader",
        },
      ),
      childLog.emit(
        "run.completed",
        { state: "completed" },
        {
          sessionId: "s1",
          agentId: "child_reader",
        },
      ),
      parentLog.emit(
        "run.completed",
        { state: "completed" },
        {
          sessionId: "s1",
          agentId: "main",
        },
      ),
    );

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "REPEATED_TOOL_REQUESTS",
          evidence: expect.arrayContaining([
            `run ${child.id}`,
            "agent child_reader",
            '3x read {"path":"README.md"}',
          ]),
        }),
      ]),
    );
  });

  it("reports equivalent task_create calls after a prior task completed", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const taskPayload = {
      goal: "inspect agent skill failures",
      prompt: "find root cause",
    };
    const events: SparkwrightEvent[] = [
      log.emit("run.created", { goal: "debug repeated tasks" }),
      log.emit("tool.requested", {
        id: "create_1",
        toolName: "task_create",
        arguments: {
          kind: "agent",
          mode: "awaited",
          payload: taskPayload,
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "create_1",
        toolName: "task_create",
        output: {
          taskId: "task_1",
          mode: "awaited",
          awaited: true,
          nextAction: {
            tool: "task",
            taskId: "task_1",
            action: "wait",
          },
        },
      }),
      log.emit("task.completed", {
        taskId: "task_1",
        status: "completed",
      }),
      log.emit("tool.requested", {
        id: "create_2",
        toolName: "task_create",
        arguments: {
          kind: "agent",
          mode: "background",
          payload: taskPayload,
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "create_2",
        toolName: "task_create",
        output: {
          taskId: "task_2",
          mode: "background",
          awaited: false,
          nextAction: {
            tool: "task",
            taskId: "task_2",
            action: "get",
          },
        },
      }),
      log.emit("run.completed", { state: "completed" }),
    ];

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "medium",
          code: "REPEATED_TASK_CREATE_LIFECYCLE",
          evidence: expect.arrayContaining([
            expect.stringContaining("task_create kind=agent"),
            "prior task_create returned nextAction",
            expect.stringContaining("task task_1 completed"),
          ]),
        }),
      ]),
    );
  });

  it("advises when a service-classified shell task exits naturally", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const events = [
      log.emit("run.created", { goal: "run a finite command" }),
      log.emit("task.completed", {
        taskId: "task_finite_service",
        kind: "shell.background",
        command: "python3 finite.py",
        lifetime: "service",
        result: { exitCode: 0 },
      }),
      log.emit("task.completed", {
        taskId: "task_finite_job",
        kind: "shell.background",
        command: "python3 other.py",
        lifetime: "job",
        result: { exitCode: 0 },
      }),
      log.emit("run.completed", { state: "completed" }),
    ];

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.verdict).toBe("ok");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "info",
          code: "FINITE_SERVICE_TASK",
          evidence: expect.arrayContaining([
            expect.stringContaining("task_finite_service"),
          ]),
        }),
      ]),
    );
  });

  it("reports equivalent task_create calls after a prior agent-task subagent completed", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const taskPayload = {
      goal: "inspect agent skill failures",
      prompt: "find root cause",
    };
    const events: SparkwrightEvent[] = [
      log.emit("run.created", { goal: "debug repeated agent tasks" }),
      log.emit("tool.requested", {
        id: "create_1",
        toolName: "task_create",
        arguments: {
          kind: "agent",
          mode: "awaited",
          payload: taskPayload,
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "create_1",
        toolName: "task_create",
        output: {
          taskId: "task_1",
          mode: "awaited",
          awaited: true,
          nextAction: {
            tool: "task",
            taskId: "task_1",
            action: "wait",
          },
        },
      }),
      log.emit(
        "subagent.completed",
        {
          taskId: "task_1",
          childRunId: "run_child_1",
          parentRunId: run.id,
          terminalState: "completed",
          finality: "complete",
        },
        {
          taskId: "task_1",
          childAgentId: "dynamic_task_reader",
          entrypoint: "agent_task",
        },
      ),
      log.emit("tool.requested", {
        id: "create_2",
        toolName: "task_create",
        arguments: {
          kind: "agent",
          mode: "awaited",
          payload: taskPayload,
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "create_2",
        toolName: "task_create",
        output: {
          taskId: "task_2",
          mode: "awaited",
          awaited: true,
          nextAction: {
            tool: "task",
            taskId: "task_2",
            action: "wait",
          },
        },
      }),
      log.emit("run.completed", { state: "completed" }),
    ];

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "medium",
          code: "REPEATED_TASK_CREATE_LIFECYCLE",
          evidence: expect.arrayContaining([
            expect.stringContaining("task_create kind=agent"),
            expect.stringContaining("task task_1 completed via sub-agent"),
          ]),
        }),
      ]),
    );
  });

  it("does not report repeated task_create lifecycle when the prior task failed", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const taskPayload = {
      goal: "inspect agent skill failures",
      prompt: "find root cause",
    };
    const events: SparkwrightEvent[] = [
      log.emit("run.created", { goal: "debug failed repeated tasks" }),
      log.emit("tool.requested", {
        id: "create_1",
        toolName: "task_create",
        arguments: {
          kind: "agent",
          payload: taskPayload,
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "create_1",
        toolName: "task_create",
        output: {
          taskId: "task_1",
          mode: "awaited",
          awaited: true,
          nextAction: {
            tool: "task",
            taskId: "task_1",
            action: "wait",
          },
        },
      }),
      log.emit("task.failed", {
        taskId: "task_1",
        status: "failed",
      }),
      log.emit("tool.requested", {
        id: "create_2",
        toolName: "task_create",
        arguments: {
          kind: "agent",
          payload: taskPayload,
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "create_2",
        toolName: "task_create",
        output: {
          taskId: "task_2",
          mode: "awaited",
          awaited: true,
          nextAction: {
            tool: "task",
            taskId: "task_2",
            action: "wait",
          },
        },
      }),
      log.emit("run.completed", { state: "completed" }),
    ];

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(
      report.findings.some(
        (finding) => finding.code === "REPEATED_TASK_CREATE_LIFECYCLE",
      ),
    ).toBe(false);
  });

  it("reports low net progress for the child run that actually crossed the threshold", () => {
    const parent = createRunRecord();
    const child = createRunRecord();
    const parentLog = new EventLog(parent.id);
    const childLog = new EventLog(child.id);
    const events: SparkwrightEvent[] = [
      parentLog.emit(
        "run.created",
        { goal: "ask a child to inspect" },
        {
          sessionId: "s1",
          agentId: "main",
        },
      ),
      parentLog.emit(
        "model.requested",
        { step: 0 },
        {
          sessionId: "s1",
          agentId: "main",
        },
      ),
      parentLog.emit(
        "model.completed",
        { step: 0, message: "spawn child" },
        {
          sessionId: "s1",
          agentId: "main",
        },
      ),
      childLog.emit(
        "run.created",
        { goal: "child loops through reads" },
        {
          sessionId: "s1",
          agentId: "child_reader",
        },
      ),
    ];

    for (let i = 0; i < 8; i += 1) {
      events.push(
        childLog.emit(
          "model.requested",
          { step: i },
          {
            sessionId: "s1",
            agentId: "child_reader",
          },
        ),
        childLog.emit(
          "model.completed",
          { step: i, message: `child ${i}` },
          {
            sessionId: "s1",
            agentId: "child_reader",
          },
        ),
        childLog.emit(
          "tool.requested",
          {
            id: `child_read_${i}`,
            toolName: "read",
            arguments: { path: `src/file-${i}.ts` },
          },
          {
            sessionId: "s1",
            agentId: "child_reader",
          },
        ),
        childLog.emit(
          "tool.completed",
          {
            toolCallId: `child_read_${i}`,
            toolName: "read",
            status: "completed",
            output: { path: `src/file-${i}.ts` },
          },
          {
            sessionId: "s1",
            agentId: "child_reader",
          },
        ),
      );
    }

    events.push(
      parentLog.emit(
        "subagent.completed",
        {
          childRunId: child.id,
          parentRunId: parent.id,
          terminalState: "completed",
          finality: "complete",
        },
        {
          sessionId: "s1",
          agentId: "main",
          childAgentId: "child_reader",
        },
      ),
      childLog.emit(
        "run.completed",
        { state: "completed" },
        {
          sessionId: "s1",
          agentId: "child_reader",
        },
      ),
      parentLog.emit(
        "run.completed",
        { state: "completed" },
        {
          sessionId: "s1",
          agentId: "main",
        },
      ),
    );

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LOW_NET_PROGRESS",
          evidence: expect.arrayContaining([
            `run ${child.id}`,
            "agent child_reader",
            "8 model call(s)",
            "8 tool call(s)",
          ]),
        }),
      ]),
    );
  });

  it("does not treat sequential paginated reads as duplicate low progress", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const events: SparkwrightEvent[] = [
      log.emit(
        "run.created",
        { goal: "read a large file sequentially" },
        { sessionId: "s1" },
      ),
    ];

    for (let i = 0; i < 6; i += 1) {
      events.push(
        log.emit("model.requested", { step: i + 1 }),
        log.emit("model.completed", { step: i + 1, message: `step ${i}` }),
      );
      if (i >= 5) continue;
      const startLine = i * 1000 + 1;
      const endLine = startLine + 999;
      events.push(
        log.emit("tool.requested", {
          id: `read_${i}`,
          toolName: "read",
          arguments: { path: "PROJECT_NOTES.md", offset: startLine },
        }),
        log.emit("tool.completed", {
          toolCallId: `read_${i}`,
          toolName: "read",
          status: "completed",
          output: {
            path: "PROJECT_NOTES.md",
            startLine,
            endLine,
            hasMore: true,
            nextOffset: endLine + 1,
          },
        }),
        log.emit("workspace.read", { path: "PROJECT_NOTES.md" }),
      );
    }
    events.push(log.emit("run.completed", { state: "completed" }));

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.topDuplicateReads).toMatchObject({
      "PROJECT_NOTES.md": 5,
    });
    expect(
      report.findings.some((finding) => finding.code === "LOW_NET_PROGRESS"),
    ).toBe(false);
  });

  it("does not flag low net progress for a short run that verified late", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const events: SparkwrightEvent[] = [
      log.emit("run.created", { goal: "fix a small bug" }, { sessionId: "s1" }),
    ];

    // Four model calls: write once, read twice, then verify. Verification runs
    // several calls after the last write, but the run is too short to be "many
    // cycles" — it must not produce a LOW_NET_PROGRESS finding.
    events.push(
      log.emit("model.requested", { step: 0 }),
      log.emit("model.completed", { step: 0, message: "write" }),
      log.emit("workspace.write.completed", { path: "src/foo.ts", bytes: 42 }),
    );
    for (let i = 1; i < 3; i += 1) {
      events.push(
        log.emit("model.requested", { step: i }),
        log.emit("model.completed", { step: i, message: `read ${i}` }),
        log.emit("tool.completed", {
          toolCallId: `read_${i}`,
          toolName: "read",
          status: "completed",
          output: { path: `src/bar${i}.ts` },
        }),
      );
    }
    events.push(
      log.emit("model.requested", { step: 3 }),
      log.emit("model.completed", { step: 3, message: "verify" }),
      log.emit("tool.requested", {
        id: "verify",
        toolName: "bash",
        arguments: { command: "make test" },
      }),
      log.emit("tool.completed", {
        toolCallId: "verify",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 0, timedOut: false },
      }),
      log.emit("run.completed", { state: "completed" }),
    );

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(
      report.findings.some((finding) => finding.code === "LOW_NET_PROGRESS"),
    ).toBe(false);
  });

  it("flags delayed verification with a non-npm command across enough cycles", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const events: SparkwrightEvent[] = [
      log.emit("run.created", { goal: "fix a small bug" }, { sessionId: "s1" }),
    ];

    // Write once, then drift through several read/think cycles before verifying
    // with `make test` — proving both the model-call gate and that the
    // verification matcher recognizes non-npm runners.
    events.push(
      log.emit("model.requested", { step: 0 }),
      log.emit("model.completed", { step: 0, message: "write" }),
      log.emit("workspace.write.completed", { path: "src/foo.ts", bytes: 42 }),
    );
    for (let i = 1; i < 5; i += 1) {
      events.push(
        log.emit("model.requested", { step: i }),
        log.emit("model.completed", { step: i, message: `read ${i}` }),
        log.emit("tool.completed", {
          toolCallId: `read_${i}`,
          toolName: "read",
          status: "completed",
          output: { path: `src/bar${i}.ts` },
        }),
      );
    }
    events.push(
      log.emit("model.requested", { step: 5 }),
      log.emit("model.completed", { step: 5, message: "verify" }),
      log.emit("tool.requested", {
        id: "verify",
        toolName: "bash",
        arguments: { command: "make test" },
      }),
      log.emit("tool.completed", {
        toolCallId: "verify",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 0, timedOut: false },
      }),
      log.emit("run.completed", { state: "completed" }),
    );

    const report = buildTraceReportJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LOW_NET_PROGRESS",
          evidence: expect.arrayContaining([
            "verification ran 5 model call(s) after the last write: make test",
          ]),
        }),
      ]),
    );
  });

  it("reports unresolved verification command failures as high severity", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("run.created", { goal: "fix and verify" }, { sessionId: "s1" }),
      log.emit("tool.completed", {
        toolCallId: "call_shell",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 1, timedOut: false },
      }),
      log.emit("run.completed", {
        state: "completed",
        reason: "final_answer",
        commandOutcome: {
          total: 1,
          byExitCode: { "1": 1 },
          verification: {
            total: 1,
            unresolved: 1,
            lastCommand: "npm test",
            lastExitCode: 1,
            lastTimedOut: false,
          },
        },
      }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const report = buildTraceReportJsonl(jsonl);

    expect(report.verdict).toBe("failed");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          code: "UNRESOLVED_VERIFICATION_FAILURES",
          evidence: expect.arrayContaining([
            "1 unresolved verification failure(s)",
            "last command: npm test",
            "last exit code: 1",
          ]),
        }),
      ]),
    );
  });

  it("does not warn for verification command failures that later pass", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("run.created", { goal: "fix and verify" }, { sessionId: "s1" }),
      log.emit("tool.completed", {
        toolCallId: "call_fail",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 1, timedOut: false },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_pass",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 0, timedOut: false },
      }),
      log.emit("run.completed", {
        state: "completed",
        reason: "final_answer",
        commandOutcome: {
          total: 1,
          byExitCode: { "1": 1 },
          verification: {
            total: 1,
            unresolved: 0,
            lastFailureCommand: "npm test",
            lastFailureExitCode: 1,
            lastFailureTimedOut: false,
            lastSuccessfulVerificationCommand: "npm test",
          },
        },
      }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const report = buildTraceReportJsonl(jsonl);

    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "COMMAND_FAILURES",
    );
  });

  it("reports node -e probe failures separately from recovered verification", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit(
        "run.created",
        { goal: "fix and verify with npm test" },
        { sessionId: "s1" },
      ),
      log.emit("tool.requested", {
        id: "probe",
        toolName: "bash",
        arguments: {
          command:
            'node -e "console.error(\\"probe failed\\"); process.exit(7)"',
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "probe",
        toolName: "bash",
        status: "completed",
        output: {
          exitCode: 7,
          timedOut: false,
          stdout: "",
          stderr: "probe failed\n",
        },
      }),
      log.emit("tool.requested", {
        id: "fail",
        toolName: "bash",
        arguments: { command: "npm test" },
      }),
      log.emit("tool.completed", {
        toolCallId: "fail",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 1, timedOut: false, stdout: "", stderr: "fail" },
      }),
      log.emit("tool.requested", {
        id: "pass",
        toolName: "bash",
        arguments: { command: "npm test" },
      }),
      log.emit("tool.completed", {
        toolCallId: "pass",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" },
      }),
      log.emit("run.completed", {
        state: "completed",
        commandOutcome: {
          total: 2,
          byExitCode: { "7": 1, "1": 1 },
          verification: {
            total: 2,
            unresolved: 1,
            lastCommand:
              'node -e "console.error(\\"probe failed\\"); process.exit(7)"',
            lastExitCode: 7,
            lastTimedOut: false,
            lastFailureCommand: "npm test",
            lastFailureExitCode: 1,
            lastFailureTimedOut: false,
            lastSuccessfulVerificationCommand: "npm test",
          },
        },
      }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const report = buildTraceReportJsonl(jsonl);

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "COMMAND_FAILURES",
          evidence: expect.arrayContaining([
            "2 command failure(s)",
            "1:1, 7:1",
            "last successful verification: npm test",
            "last verification failure: npm test",
          ]),
        }),
      ]),
    );
    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "UNRESOLVED_VERIFICATION_FAILURES",
    );
  });

  it("does not fail reports for recovered skill-load companion failures", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("run.created", { goal: "use a skill" }, { sessionId: "s1" }),
      log.emit("tool.requested", {
        id: "call_load_1",
        toolName: "skill_load",
        arguments: { name: "reviewer" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_load_1",
        toolName: "skill_load",
        status: "failed",
        error: { code: "SKILL_LOAD_FAILED", message: "missing resource" },
      }),
      log.emit("skill.failed", {
        toolCallId: "call_load_1",
        name: "reviewer",
        status: "resource_not_found",
        message: "missing resource",
      }),
      log.emit("tool.requested", {
        id: "call_load_2",
        toolName: "skill_load",
        arguments: { name: "reviewer" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_load_2",
        toolName: "skill_load",
        status: "completed",
        output: { status: "loaded", name: "reviewer" },
      }),
      log.emit("run.completed", { state: "completed" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);
    const report = buildTraceReportJsonl(jsonl);

    expect(summary.errorCount).toBe(1);
    expect(summary.toolFailures).toMatchObject({
      total: 1,
      unresolved: { total: 0, byCode: {} },
      recovered: { total: 1, byCode: { SKILL_LOAD_FAILED: 1 } },
    });
    expect(report.verdict).toBe("passed_with_issues");
    expect(report.findings.map((finding) => finding.code)).toContain(
      "RECOVERED_TOOL_FAILURES",
    );
    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "TRACE_ERRORS",
    );
  });

  it("does not double count non-skill companion failures tied to tool failures", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("run.created", { goal: "recover from a bad read" }),
      log.emit("tool.requested", {
        id: "call_bad_read",
        toolName: "read",
        arguments: { path: "missing.md" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_bad_read",
        toolName: "read",
        status: "failed",
        error: { code: "ENOENT", message: "missing" },
      }),
      log.emit("subagent.failed", {
        toolCallId: "call_bad_read",
        errorCode: "ENOENT",
        message: "synthetic companion failure",
      }),
      log.emit("tool.requested", {
        id: "call_good_read",
        toolName: "read",
        arguments: { path: "README.md" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_good_read",
        toolName: "read",
        status: "completed",
        output: { path: "README.md" },
      }),
      log.emit("run.completed", { state: "completed" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);
    const report = buildTraceReportJsonl(jsonl);

    expect(summary.errorCount).toBe(1);
    expect(summary.toolFailures.recovered.total).toBe(1);
    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "TRACE_ERRORS",
    );
  });

  it("surfaces unclassified failed terminal events in trace reports", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("run.created", { goal: "background task" }),
      log.emit("task.failed", {
        taskId: "task_1",
        errorCode: "TASK_EXIT_NONZERO",
        message: "background task exited 1",
      }),
      log.emit("run.completed", { state: "completed" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const report = buildTraceReportJsonl(jsonl);

    expect(report.verdict).toBe("failed");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          code: "TRACE_ERRORS",
          evidence: expect.arrayContaining([
            "1 reportable failure event(s)",
            "TASK_EXIT_NONZERO:1",
            expect.stringContaining("task.failed · TASK_EXIT_NONZERO"),
          ]),
        }),
      ]),
    );
  });

  it("keeps foreground untracked workspace mutation guards as expected denials", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("run.created", { goal: "foreground shell guard" }),
      log.emit("tool.requested", {
        id: "call_shell",
        toolName: "bash",
        arguments: { command: "echo x > leak.txt" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_shell",
        toolName: "bash",
        status: "failed",
        error: {
          code: "UNTRACKED_WORKSPACE_MUTATION",
          message: "changed workspace files",
        },
      }),
      log.emit("run.completed", { state: "completed" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);
    const report = buildTraceReportJsonl(jsonl);

    expect(summary.expectedDenialCodes).toMatchObject({
      UNTRACKED_WORKSPACE_MUTATION: 1,
    });
    expect(summary.toolFailures.unresolved.total).toBe(0);
    expect(summary.safety.shell.untrackedWorkspaceMutations).toBe(1);
    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "TRACE_ERRORS",
    );
    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "UNRESOLVED_TOOL_FAILURES",
    );
  });

  it("summarizes capability mutation events", () => {
    const log = new EventLog(createRunId());
    const jsonl = [
      log.emit("run.created", { goal: "draft skill proposal" }),
      log.emit("capability.mutation.completed", {
        action: "replace_skill_package",
        path: ".sparkwright/skill-evolution/proposals/skillprop_1/after/demo",
        sourcePath: ".sparkwright/skills/demo",
        fileCount: 2,
      }),
      log.emit("run.completed", { state: "completed" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    expect(summary.byType["capability.mutation.completed"]).toBe(1);
    expect(summary.safety.capabilityMutations.completed).toBe(1);
  });

  it("classifies tool outcomes from standard payloads", () => {
    const run = createRunRecord();
    // The verdict computed over full events: the failure on a.txt is NOT
    // recovered, because the later success is on a *different* file (b.txt) and
    // EBUSY is not a not-found code.
    const toolOutcome = {
      unresolved: { total: 1, byCode: { EBUSY: 1 } },
      recovered: { total: 0, byCode: {} },
    };
    const buildEvents = (withVerdict: boolean) => {
      const log = new EventLog(run.id);
      const events = [
        log.emit("run.created", { goal: run.goal }, { sessionId: "s1" }),
        log.emit("tool.requested", {
          id: "call_fail",
          toolName: "read",
          arguments: { path: "a.txt" },
        }),
        log.emit("tool.failed", {
          toolCallId: "call_fail",
          toolName: "read",
          status: "failed",
          error: { code: "EBUSY", message: "resource busy" },
        }),
        log.emit("tool.requested", {
          id: "call_ok",
          toolName: "read",
          arguments: { path: "b.txt" },
        }),
        log.emit("tool.completed", {
          toolCallId: "call_ok",
          toolName: "read",
          status: "completed",
          output: { path: "b.txt", content: "ok" },
        }),
        log.emit(
          "run.completed",
          withVerdict ? { reason: "final_answer", toolOutcome } : {},
        ),
      ];
      return summarizeTraceJsonl(
        events
          .map((event) => filterTraceEvent(event, "standard"))
          .map(serializeEventJsonl)
          .join(""),
      );
    };

    const withVerdict = buildEvents(true);
    expect(withVerdict.toolFailures.unresolved.total).toBe(1);
    expect(withVerdict.toolFailures.recovered.total).toBe(0);

    const withoutVerdict = buildEvents(false);
    expect(withoutVerdict.toolFailures.recovered.total).toBe(0);
    expect(withoutVerdict.toolFailures.unresolved.total).toBe(1);
  });

  it("reads the persisted command outcome on a standard trace", () => {
    const run = createRunRecord();
    const commandOutcome = {
      total: 1,
      byExitCode: { "254": 1 },
      verification: {
        total: 1,
        unresolved: 1,
        lastCommand: "npm test",
        lastExitCode: 254,
        lastTimedOut: false,
        lastFailureCommand: "npm test",
        lastFailureExitCode: 254,
        lastFailureTimedOut: false,
      },
    };
    const log = new EventLog(run.id);
    const standardJsonl = [
      log.emit("run.created", { goal: run.goal }, { sessionId: "s1" }),
      log.emit("tool.completed", {
        toolCallId: "call_1",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 254, stdout: "EXIT:254\n", timedOut: false },
      }),
      log.emit("run.completed", { reason: "final_answer", commandOutcome }),
    ]
      .map((event) => filterTraceEvent(event, "standard"))
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(standardJsonl);

    expect(summary.commandFailures.total).toBe(1);
    expect(summary.commandFailures.byExitCode).toEqual({ "254": 1 });
    expect(summary.commandFailures.verification).toMatchObject({
      total: 1,
      unresolved: 1,
      lastCommand: "npm test",
      lastExitCode: 254,
      lastFailureCommand: "npm test",
      lastFailureExitCode: 254,
    });
  });

  it("prefers the persisted fact ledger over command outcome snapshots", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const standardJsonl = [
      log.emit("run.created", { goal: "verify" }, { sessionId: "s1" }),
      log.emit("run.completed", {
        reason: "final_answer",
        commandOutcome: {
          total: 1,
          byExitCode: { "1": 1 },
          verification: { total: 1, unresolved: 1 },
        },
        factLedger: {
          schemaVersion: "fact-ledger.v1",
          writeEpoch: 1,
          commands: [
            {
              id: "cmd:shell:2:call_1",
              source: "shell_tool",
              initiator: "model-initiated",
              sequence: 2,
              writeEpoch: 0,
              stale: true,
              toolCallId: "call_1",
              toolName: "bash",
              command: "npm test",
              commandKey: "npm test",
              exitCode: 1,
              timedOut: false,
              verificationRelevant: true,
            },
          ],
          verificationResults: [],
          writes: [{ id: "write:3", sequence: 3, writeEpoch: 1 }],
        },
      }),
    ]
      .map((event) => filterTraceEvent(event, "standard"))
      .map(serializeEventJsonl)
      .join("");

    expect(summarizeTraceJsonl(standardJsonl).commandFailures.total).toBe(0);
  });

  it("aggregates persisted fact ledgers across runs", () => {
    const failed = new EventLog(createRunId());
    const clean = new EventLog(createRunId());
    const standardJsonl = [
      failed.emit("run.created", { goal: "verify" }, { sessionId: "s1" }),
      failed.emit("run.completed", {
        reason: "final_answer",
        factLedger: {
          schemaVersion: "fact-ledger.v1",
          writeEpoch: 0,
          commands: [
            {
              id: "cmd:shell:2:call_1",
              source: "shell_tool",
              initiator: "model-initiated",
              sequence: 2,
              writeEpoch: 0,
              stale: false,
              toolCallId: "call_1",
              toolName: "bash",
              command: "npm test",
              commandKey: "npm test",
              exitCode: 1,
              timedOut: false,
              verificationRelevant: true,
            },
          ],
          verificationResults: [],
          writes: [],
        },
      }),
      clean.emit("run.created", { goal: "inspect" }, { sessionId: "s1" }),
      clean.emit("run.completed", {
        reason: "final_answer",
        factLedger: {
          schemaVersion: "fact-ledger.v1",
          writeEpoch: 0,
          commands: [],
          verificationResults: [],
          writes: [],
        },
      }),
    ]
      .map((event) => filterTraceEvent(event, "standard"))
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(standardJsonl);

    expect(summary.commandFailures.total).toBe(1);
    expect(summary.commandFailures.byExitCode).toEqual({ "1": 1 });
    expect(summary.commandFailures.verification).toMatchObject({
      total: 1,
      unresolved: 1,
      lastCommand: "npm test",
      lastExitCode: 1,
    });
  });

  it("counts verifier-launched workflow command failures from persisted fact ledgers", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const standardJsonl = [
      log.emit(
        "run.created",
        { goal: "run workflow verifier" },
        { sessionId: "s1" },
      ),
      log.emit("run.completed", {
        reason: "final_answer",
        factLedger: {
          schemaVersion: "fact-ledger.v1",
          writeEpoch: 0,
          commands: [
            {
              id: "cmd:workflow:2:focused",
              source: "workflow_hook",
              initiator: "verifier-launched",
              sequence: 2,
              writeEpoch: 0,
              stale: false,
              hookName: "workflow:release-check-focused",
              nodeId: "verify",
              verifierId: "focused",
              verificationSource: "workflow_command",
              command: "npm run test:focused",
              commandKey: "npm run test:focused",
              exitCode: 1,
              timedOut: false,
              verificationRelevant: true,
            },
          ],
          verificationResults: [
            {
              id: "verification:focused",
              commandFactId: "cmd:workflow:2:focused",
              sequence: 2,
              writeEpoch: 0,
              stale: false,
              hookName: "workflow:release-check-focused",
              nodeId: "verify",
              verifierId: "focused",
              verificationSource: "workflow_command",
              expect: { exitCode: 0 },
              satisfied: false,
              exitCode: 1,
              timedOut: false,
            },
          ],
          writes: [],
        },
      }),
    ]
      .map((event) => filterTraceEvent(event, "standard"))
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(standardJsonl);

    expect(summary.commandFailures).toMatchObject({
      total: 1,
      byExitCode: { "1": 1 },
      verification: {
        total: 1,
        unresolved: 1,
        lastCommand: "npm run test:focused",
        lastExitCode: 1,
        lastFailureCommand: "npm run test:focused",
        lastFailureExitCode: 1,
      },
    });
  });

  it("treats a parseable fact ledger as authoritative over command outcome", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const standardJsonl = [
      log.emit("run.created", { goal: run.goal }, { sessionId: "s1" }),
      log.emit("run.completed", {
        reason: "final_answer",
        commandOutcome: {
          total: 1,
          byExitCode: { "1": 1 },
          verification: { total: 1, unresolved: 1 },
        },
        factLedger: {
          schemaVersion: "fact-ledger.v1",
          writeEpoch: 0,
          commands: [],
          verificationResults: [],
          writes: [],
        },
      }),
    ]
      .map((event) => filterTraceEvent(event, "standard"))
      .map(serializeEventJsonl)
      .join("");

    expect(summarizeTraceJsonl(standardJsonl).commandFailures.total).toBe(0);
  });

  it("keeps command failures on standard traces without a persisted outcome", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const standardJsonl = [
      log.emit("run.created", { goal: "verify" }, { sessionId: "s1" }),
      log.emit("tool.completed", {
        toolCallId: "call_1",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 254, stdout: "EXIT:254\n", timedOut: false },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]
      .map((event) => filterTraceEvent(event, "standard"))
      .map(serializeEventJsonl)
      .join("");

    expect(summarizeTraceJsonl(standardJsonl).commandFailures.total).toBe(1);
  });

  it("counts an approval denial the same at standard and debug trace levels", () => {
    const run = createRunRecord();
    const buildJsonl = (level: "standard" | "debug") => {
      const log = new EventLog(run.id);
      return [
        log.emit("run.created", { goal: run.goal }, { sessionId: "s1" }),
        log.emit("tool.requested", {
          id: "call_1",
          toolName: "append_file",
          arguments: { path: "README.md", content: "x" },
        }),
        log.emit("tool.failed", {
          toolCallId: "call_1",
          toolName: "append_file",
          status: "failed",
          error: { code: "TOOL_APPROVAL_DENIED", message: "approval denied" },
        }),
        log.emit("run.completed", { state: "completed" }),
      ]
        .map((event) => filterTraceEvent(event, level))
        .map(serializeEventJsonl)
        .join("");
    };

    const standard = summarizeTraceJsonl(buildJsonl("standard"));
    const debug = summarizeTraceJsonl(buildJsonl("debug"));

    expect(standard.expectedDenialCount).toBe(1);
    expect(standard.expectedDenialCodes).toEqual({ TOOL_APPROVAL_DENIED: 1 });
    expect(standard.toolFailures.unresolved.total).toBe(0);
    expect(debug.expectedDenialCount).toBe(standard.expectedDenialCount);
    expect(debug.toolFailures.unresolved.total).toBe(
      standard.toolFailures.unresolved.total,
    );
  });

  it("records error codes for run.failed and validation.failed events", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("run.created", { goal: run.goal }, { sessionId: "s1" }),
      log.emit("validation.failed", {
        stage: "input",
        hookName: "run_input",
        result: {
          status: "failed",
          findings: [{ code: "TARGET_OUTSIDE_WORKSPACE", severity: "error" }],
        },
      }),
      log.emit("run.failed", {
        reason: "validation",
        code: "RUN_INPUT_VALIDATION_FAILED",
        message: "Target must stay inside the workspace",
      }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    // errorCount and errorCodes must agree: a boundary rejection is no longer
    // counted (errors: 2) while its codes go unreported (top errors: none).
    expect(summary.errorCount).toBe(2);
    expect(summary.errorCodes).toEqual({
      TARGET_OUTSIDE_WORKSPACE: 1,
      RUN_INPUT_VALIDATION_FAILED: 1,
    });
  });

  it("counts each tool call once across requested + started events", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("run.created", { goal: run.goal }, { sessionId: "s1" }),
      log.emit("tool.requested", { toolName: "read" }),
      log.emit("tool.started", { toolName: "read" }),
      log.emit("tool.completed", { toolName: "read" }),
      log.emit("run.completed", { state: "completed" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    expect(summary.toolCalls).toEqual({ read: 1 });
  });

  it("summarizes shell command failures and verification failures", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("run.created", {
        goal: "Fix the CLI and verify by running it",
      }),
      log.emit("tool.requested", {
        id: "call_probe",
        toolName: "bash",
        arguments: { command: "python3 --version" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_probe",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 0, timedOut: false },
      }),
      log.emit("tool.requested", {
        id: "call_verify",
        toolName: "bash",
        arguments: { command: "python3 -m greettool.cli --name Ada" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_verify",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 1, timedOut: false },
      }),
      log.emit("run.completed", { state: "completed" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    expect(summary.commandFailures).toMatchObject({
      total: 1,
      byExitCode: { "1": 1 },
      verification: {
        total: 1,
        unresolved: 1,
        lastCommand: "python3 -m greettool.cli --name Ada",
        lastExitCode: 1,
        lastTimedOut: false,
      },
    });
  });

  it("summarizes approval and safety signals", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("approval.requested", {
        id: "approval_write",
        action: "workspace.write",
        summary: "Write README.md",
        details: { path: "README.md" },
      }),
      log.emit("approval.resolved", {
        approvalId: "approval_write",
        decision: "approved",
        message: "Approved by policy.",
        autoApproved: true,
      }),
      log.emit("approval.requested", {
        id: "approval_shell",
        action: "tool.execute",
        summary: "Run tool bash",
        details: { toolName: "bash" },
      }),
      log.emit("approval.resolved", {
        approvalId: "approval_shell",
        decision: "denied",
        message: "Non-interactive stdin.",
      }),
      log.emit("workspace.write.requested", {
        proposalId: "write_1",
        path: "README.md",
      }),
      log.emit("workspace.write.completed", {
        proposalId: "write_1",
        path: "README.md",
      }),
      log.emit("workspace.read.denied", {
        path: ".env",
        reason: "Read denied: .env is a confidential path for this run.",
      }),
      log.emit("tool.requested", {
        id: "call_shell",
        toolName: "bash",
        arguments: { command: "python -m venv .venv" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_shell",
        toolName: "bash",
        status: "failed",
        error: {
          code: "UNTRACKED_WORKSPACE_MUTATION",
          message: "changed workspace files",
        },
      }),
      log.emit("run.completed", { state: "completed" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    expect(summary.safety).toMatchObject({
      approvals: {
        requested: 2,
        resolved: 2,
        approved: 1,
        denied: 1,
        autoApproved: 1,
        shell: 1,
        workspaceWrite: 1,
      },
      workspaceWrites: {
        requested: 1,
        completed: 1,
        denied: 0,
        skipped: 0,
      },
      shell: {
        requested: 1,
        approvals: 1,
        commandFailures: 0,
        untrackedWorkspaceMutations: 1,
      },
      confidentialReadsDenied: 1,
    });
  });

  it("classifies policy and approval denials separately from unexpected errors", () => {
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
      log.emit("tool.failed", {
        toolCallId: "call_2",
        status: "failed",
        error: { code: "TOOL_DENIED", message: "write disabled" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_3",
        status: "failed",
        error: {
          code: "TOOL_BLOCKED_BY_WORKFLOW_HOOK",
          message: "blocked by configured hook",
        },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    expect(summary.errorCount).toBe(0);
    expect(summary.errorCodes).toEqual({});
    expect(summary.expectedDenialCount).toBe(4);
    expect(summary.expectedDenialCodes).toEqual({
      "workspace.write.denied": 1,
      APPROVAL_DENIED: 1,
      TOOL_DENIED: 1,
      TOOL_BLOCKED_BY_WORKFLOW_HOOK: 1,
    });
  });

  it("counts repeated skipped calls after expected denials as expected denials", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const repeatedArgs = { command: "pwd && node -v" };
    const jsonl = [
      log.emit("tool.requested", {
        id: "call_1",
        toolName: "bash",
        arguments: repeatedArgs,
      }),
      log.emit("tool.failed", {
        toolCallId: "call_1",
        status: "failed",
        error: { code: "TOOL_DENIED", message: "tool denied by policy" },
      }),
      log.emit("tool.requested", {
        id: "call_2",
        toolName: "bash",
        arguments: repeatedArgs,
      }),
      log.emit("tool.failed", {
        toolCallId: "call_2",
        status: "failed",
        error: {
          code: "REPEATED_TOOL_CALL_SKIPPED",
          message: "skipped repeated call",
        },
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
      TOOL_DENIED: 1,
      REPEATED_TOOL_CALL_SKIPPED: 1,
    });
    expect(summary.toolFailures).toMatchObject({
      total: 2,
      unresolved: { total: 0, byCode: {} },
      recovered: { total: 0, byCode: {} },
    });
  });

  it("classifies recovered repeated tool calls separately from errors", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("tool.requested", {
        id: "call_1",
        toolName: "read",
        arguments: { path: "README.md" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_1",
        status: "completed",
        output: { path: "README.md" },
      }),
      log.emit("tool.requested", {
        id: "call_2",
        toolName: "read",
        arguments: { path: "README.md" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_2",
        status: "failed",
        error: { code: "REPEATED_TOOL_CALL_SKIPPED", message: "skipped" },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    expect(summary.errorCount).toBe(0);
    expect(summary.errorCodes).toEqual({});
    expect(summary.toolFailures).toMatchObject({
      total: 1,
      byCode: { REPEATED_TOOL_CALL_SKIPPED: 1 },
      unresolved: { total: 0, byCode: {} },
      recovered: {
        total: 1,
        byCode: { REPEATED_TOOL_CALL_SKIPPED: 1 },
      },
    });
  });

  it("classifies empty task monitor placeholders as recovered after concrete monitoring", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("tool.requested", {
        id: "call_wait_empty",
        toolName: "task",
        arguments: { action: "wait", taskId: "", ids: [], mode: "all" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_wait_empty",
        toolName: "task",
        status: "failed",
        error: {
          code: "TASK_ARGUMENTS_INVALID",
          message: "task wait requires at least one task id.",
        },
      }),
      log.emit("tool.requested", {
        id: "call_wait_ok",
        toolName: "task",
        arguments: {
          action: "wait",
          taskId: "task_123",
          ids: ["task_123"],
          mode: "all",
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_wait_ok",
        toolName: "task",
        status: "completed",
        output: {
          mode: "all",
          complete: true,
          taskIds: ["task_123"],
          terminalTaskIds: ["task_123"],
        },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);
    const report = buildTraceReportJsonl(jsonl);

    expect(summary.errorCount).toBe(0);
    expect(summary.toolFailures).toMatchObject({
      total: 1,
      unresolved: { total: 0, byCode: {} },
      recovered: { total: 1, byCode: { TASK_ARGUMENTS_INVALID: 1 } },
    });
    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "UNRESOLVED_TOOL_FAILURES",
    );
    expect(report.findings.map((finding) => finding.code)).toContain(
      "RECOVERED_TOOL_FAILURES",
    );
  });

  it("classifies failed file edits as recovered after a later write to the same path", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("tool.requested", {
        id: "call_bad_anchor",
        toolName: "edit_anchored_text",
        arguments: { path: "NOTES.md", edits: [] },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_bad_anchor",
        status: "failed",
        error: { code: "ANCHOR_INVALID", message: "invalid anchor" },
      }),
      log.emit("tool.requested", {
        id: "call_patch",
        toolName: "edit",
        arguments: { path: "NOTES.md", patch: "@@\n+fixed\n" },
      }),
      log.emit("workspace.write.requested", {
        id: "write_1",
        path: "NOTES.md",
        content: "fixed\n",
        diff: "@@\n+fixed\n",
        reason: "fix notes",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      log.emit("workspace.write.completed", {
        proposalId: "write_1",
        path: "NOTES.md",
      }),
      log.emit("tool.completed", {
        toolCallId: "call_patch",
        status: "completed",
        output: { path: "NOTES.md" },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    expect(summary.errorCount).toBe(0);
    expect(summary.errorCodes).toEqual({});
    expect(summary.toolFailures).toMatchObject({
      total: 1,
      byCode: { ANCHOR_INVALID: 1 },
      unresolved: { total: 0, byCode: {} },
      recovered: {
        total: 1,
        byCode: { ANCHOR_INVALID: 1 },
      },
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

  it("summarizes cost estimation status and unavailable reasons", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const jsonl = [
      log.emit("model.completed", {
        usage: {
          inputTokens: 3,
          outputTokens: 5,
          totalTokens: 8,
          costStatus: "unavailable",
          costUnavailableReason: "missing_pricing",
        },
      }),
      log.emit("model.completed", {
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          costUsd: 0.001,
          costStatus: "estimated",
        },
      }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const summary = summarizeTraceJsonl(jsonl);

    expect(summary.usage.totalTokens).toBe(20);
    expect(summary.usage.estimatedCostUsd).toBeCloseTo(0.001);
    expect(summary.usage.costStatus).toBe("partial");
    expect(summary.usage.costUnavailableReasons).toEqual({
      missing_pricing: 1,
    });
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
      log.emit("tool.failed", { toolName: "read", error: "boom" }),
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
        { toolCallId: "tool_1", toolName: "read" },
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
          label: "tool read",
        }),
      ]),
    );
    expect(
      timeline.phases.map((phase) => phase.eventTypes).flat(),
    ).not.toContain("model.stream.chunk");
  });

  it("orders timeline phases by aggregate projection before file order", () => {
    const traceId = createTraceId();
    const timestamp = "2026-02-02T00:00:00.000Z";
    const firstLog = new EventLog(createRunId());
    const secondLog = new EventLog(createRunId());
    const later = firstLog.emit(
      "workspace.read",
      { path: "later.md" },
      { agentId: "main" },
    );
    const earlier = secondLog.emit(
      "workspace.read",
      { path: "earlier.md" },
      { agentId: "main" },
    );
    for (const event of [later, earlier]) {
      event.traceId = traceId;
      event.timestamp = timestamp;
    }
    later.monotonicUs = 200;
    earlier.monotonicUs = 100;

    const timeline = buildTraceTimelineJsonl(
      [later, earlier].map(serializeEventJsonl).join(""),
    );

    expect(timeline.phases.map((phase) => phase.label)).toEqual([
      "workspace earlier.md",
      "workspace later.md",
    ]);
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

  it("reconciles open phases when a run has a terminal failure", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const events = [
      log.emit("run.created", { goal: run.goal }),
      log.emit("run.started", {}),
      log.emit("model.requested", { step: 1 }),
      log.emit("model.stream.failed", { step: 1, error: "auth failed" }),
      log.emit("model.turn.completed", { step: 1 }),
      log.emit("run.failed", {
        reason: "model_auth_failed",
        code: "MODEL_COMPLETION_FAILED",
        message: "auth failed",
      }),
    ];

    const timeline = buildTraceTimelineJsonl(
      events.map(serializeEventJsonl).join(""),
    );
    const modelPhase = timeline.phases.find(
      (phase) => phase.category === "model" && phase.label === "model step 1",
    );

    expect(modelPhase).toMatchObject({
      status: "failed",
      startSequence: 3,
      endSequence: 6,
      eventTypes: ["model.requested", "run.failed"],
    });
    expect(timeline.phases).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          eventTypes: expect.arrayContaining(["model.requested"]),
        }),
      ]),
    );
  });

  it("keeps open phases pending when a trace has no run terminal event", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const events = [
      log.emit("run.created", { goal: run.goal }),
      log.emit("run.started", {}),
      log.emit("model.requested", { step: 1 }),
      log.emit("model.stream.failed", { step: 1, error: "auth failed" }),
    ];

    const timeline = buildTraceTimelineJsonl(
      events.map(serializeEventJsonl).join(""),
    );
    const modelPhase = timeline.phases.find(
      (phase) => phase.category === "model" && phase.label === "model step 1",
    );

    expect(modelPhase).toMatchObject({
      status: "pending",
      startSequence: 3,
      eventTypes: ["model.requested"],
    });
  });

  it("pairs subagent lifecycle events by child run id before spans in trace timelines", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const span = (spanId: string) => ({
      __span: { traceId: "trace_1", spanId },
    });
    const child = {
      childRunId: "cmd_doc_reviewer_1",
      parentRunId: run.id,
    };
    const events = [
      log.emit("run.created", { goal: run.goal }),
      log.emit("subagent.requested", child, span("span_subagent_request")),
      log.emit("subagent.started", child, span("span_subagent_child")),
      log.emit(
        "subagent.completed",
        { ...child, stopReason: "completed" },
        span("span_subagent_child"),
      ),
      log.emit("run.completed", { state: "completed" }),
    ];

    const timeline = buildTraceTimelineJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(timeline.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          eventTypes: [
            "subagent.requested",
            "subagent.started",
            "subagent.completed",
          ],
          startSequence: 2,
          endSequence: 4,
        }),
      ]),
    );
    expect(timeline.phases).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          eventTypes: expect.arrayContaining(["subagent.requested"]),
        }),
      ]),
    );
  });

  it("pairs interaction requested and resolved events by request id", () => {
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const events = [
      log.emit("run.created", { goal: run.goal }),
      log.emit("run.started", {}),
      log.emit("interaction.requested", {
        kind: "approval",
        request: {
          id: "approval_1",
          runId: run.id,
          action: "tool.execute",
          summary: "Run tool bash",
          details: {},
          createdAt: "2026-06-11T00:00:00.000Z",
          status: "pending",
        },
      }),
      log.emit("interaction.resolved", {
        kind: "approval",
        response: { approvalId: "approval_1", decision: "approved" },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ];

    const timeline = buildTraceTimelineJsonl(
      events.map(serializeEventJsonl).join(""),
    );

    expect(timeline.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          eventTypes: ["interaction.requested", "interaction.resolved"],
        }),
      ]),
    );
    expect(timeline.phases).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          eventTypes: expect.arrayContaining(["interaction.requested"]),
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

  it("flags a workspace path-escape tool failure as an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-sessions-escape-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const factory = createSessionRunStoreFactory({
      sessionStore: new FileSessionStore({ rootDir: root }),
      sessionId: "session_escape",
      runStoreFactory: createSessionFileRunStoreFactory({
        sessionRootDir: root,
        sessionId: "session_escape",
        agentId: "main",
        traceLevel: "debug",
      }),
    });
    const store = factory(run);

    await store.append(log.emit("run.created", { goal: run.goal }));
    await store.append(
      log.emit("tool.requested", {
        id: "call_escape",
        toolName: "read",
        arguments: { path: "link.txt" },
      }),
    );
    await store.append(log.emit("tool.started", { toolCallId: "call_escape" }));
    await store.append(
      log.emit("tool.failed", {
        toolCallId: "call_escape",
        toolName: "read",
        status: "failed",
        error: {
          code: "WORKSPACE_PATH_ESCAPED",
          message: "Path escapes workspace root: link.txt",
        },
      }),
    );
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
      sessionDir: join(root, "session_escape"),
    });

    // A structurally valid session is still not "ok" when a tool tried to
    // escape the workspace root, even though the boundary blocked the write.
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "WORKSPACE_PATH_ESCAPE_ATTEMPT",
          metadata: expect.objectContaining({ count: 1 }),
        }),
      ]),
    );
    // The escape is reported once, not also double-counted as a generic
    // unresolved tool failure.
    expect(
      report.findings.filter((f) => f.code === "UNRESOLVED_TOOL_FAILURE"),
    ).toEqual([]);
  });

  it("surfaces an unresolved tool failure as a non-failing warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-sessions-enoent-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const factory = createSessionRunStoreFactory({
      sessionStore: new FileSessionStore({ rootDir: root }),
      sessionId: "session_enoent",
      runStoreFactory: createSessionFileRunStoreFactory({
        sessionRootDir: root,
        sessionId: "session_enoent",
        agentId: "main",
        traceLevel: "debug",
      }),
    });
    const store = factory(run);

    await store.append(log.emit("run.created", { goal: run.goal }));
    await store.append(
      log.emit("tool.requested", {
        id: "call_enoent",
        toolName: "read",
        arguments: { path: "missing.txt" },
      }),
    );
    await store.append(log.emit("tool.started", { toolCallId: "call_enoent" }));
    await store.append(
      log.emit("tool.failed", {
        toolCallId: "call_enoent",
        toolName: "read",
        status: "failed",
        error: { code: "ENOENT", message: "ENOENT: no such file" },
      }),
    );
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
      sessionDir: join(root, "session_enoent"),
    });

    // A benign exploratory probe surfaces as a warning but does not fail the
    // check (so recovered/benign runs are not misreported as broken).
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          code: "UNRESOLVED_TOOL_FAILURE",
          metadata: expect.objectContaining({ byCode: { ENOENT: 1 } }),
        }),
      ]),
    );
  });

  it("flags a delegated sub-agent that never produced a terminal result", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-sessions-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const factory = createSessionRunStoreFactory({
      sessionStore: new FileSessionStore({ rootDir: root }),
      sessionId: "session_orphan",
      runStoreFactory: createSessionFileRunStoreFactory({
        sessionRootDir: root,
        sessionId: "session_orphan",
        agentId: "main",
        traceLevel: "debug",
      }),
    });
    const store = factory(run);

    await store.append(log.emit("run.created", { goal: run.goal }));
    // Requested + started, but no subagent.completed / subagent.failed.
    const subPayload = {
      childRunId: "cmd_doc_reviewer_x",
      parentRunId: run.id,
    };
    const subMeta = { agentProfileId: "doc_reviewer" };
    await store.append(log.emit("subagent.requested", subPayload, subMeta));
    await store.append(log.emit("subagent.started", subPayload, subMeta));
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
      sessionDir: join(root, "session_orphan"),
    });

    // Lost child result is a warning (not an error): the session still "ok"s,
    // but the orphaned delegation and its profile are surfaced for triage.
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          code: "SUBAGENT_NOT_TERMINATED",
          metadata: expect.objectContaining({
            childRunId: "cmd_doc_reviewer_x",
            parentRunId: run.id,
            agentProfileId: "doc_reviewer",
          }),
        }),
      ]),
    );
  });

  it("accepts a delegated sub-agent that reached a terminal result", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-sessions-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const factory = createSessionRunStoreFactory({
      sessionStore: new FileSessionStore({ rootDir: root }),
      sessionId: "session_child_ok",
      runStoreFactory: createSessionFileRunStoreFactory({
        sessionRootDir: root,
        sessionId: "session_child_ok",
        agentId: "main",
        traceLevel: "debug",
      }),
    });
    const store = factory(run);

    const subPayload = {
      childRunId: "cmd_doc_reviewer_y",
      parentRunId: run.id,
    };
    const subMeta = { agentProfileId: "doc_reviewer" };
    await store.append(log.emit("run.created", { goal: run.goal }));
    await store.append(log.emit("subagent.requested", subPayload, subMeta));
    await store.append(log.emit("subagent.started", subPayload, subMeta));
    await store.append(
      log.emit(
        "subagent.completed",
        { ...subPayload, stopReason: "completed" },
        subMeta,
      ),
    );
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
      sessionDir: join(root, "session_child_ok"),
    });

    expect(report.ok).toBe(true);
    expect(
      report.findings.filter((f) => f.code === "SUBAGENT_NOT_TERMINATED"),
    ).toEqual([]);
  });

  it("accepts collapsed stream text ranges in session trace sequence checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-sessions-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const sessionRootDir = root;
    const factory = createSessionRunStoreFactory({
      sessionStore: new FileSessionStore({ rootDir: sessionRootDir }),
      sessionId: "session_stream_compacted",
      runStoreFactory: createSessionFileRunStoreFactory({
        sessionRootDir,
        sessionId: "session_stream_compacted",
        agentId: "main",
        traceLevel: "standard",
      }),
    });
    const store = factory(run);

    await store.append(log.emit("run.created", { goal: run.goal }));
    await store.append(log.emit("run.started", {}));
    await store.append(log.emit("model.stream.started", { step: 1 }));
    await store.append(
      log.emit("model.stream.chunk", { type: "text_delta", text: "a" }),
    );
    await store.append(
      log.emit("model.stream.chunk", { type: "text_delta", text: "b" }),
    );
    await store.append(log.emit("model.stream.completed", { step: 1 }));
    run.state = "completed";
    run.stopReason = "final_answer";
    await store.append(log.emit("run.completed", { state: "completed" }));
    await store.finish(run, {
      signal: "completed",
      state: "completed",
      stopReason: "final_answer",
      metadata: {},
    });

    const trace = await readFile(
      join(root, "session_stream_compacted", "trace.jsonl"),
      "utf8",
    );
    const traceEvents = trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SparkwrightEvent);
    expect(traceEvents.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 6, 7,
    ]);

    const report = await validateSessionTraceConsistency({
      sessionDir: join(root, "session_stream_compacted"),
    });

    expect(report.ok).toBe(true);
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
    const store = new FileRunStore(run, sessionStoreOptions(root));

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
    const store = new FileRunStore(run, sessionStoreOptions(root));
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
    const store = new FileRunStore(run, sessionStoreOptions(root));

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
    const store = new FileRunStore(run, sessionStoreOptions(root));
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

  it("summarizes large tool output for standard traces", () => {
    const log = new EventLog(createRunId());
    const event = log.emit("tool.completed", {
      toolCallId: "call_1",
      toolName: "echo",
      status: "completed",
      output: { text: "x".repeat(600) },
      artifacts: [],
    });

    const standard = filterTraceEvent(event, "standard");

    expect(standard.payload).toMatchObject({
      toolCallId: "call_1",
      toolName: "echo",
      status: "completed",
    });
  });

  it("applies standard filtering to file-backed traces", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-store-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, {
      ...sessionStoreOptions(root),
      traceLevel: "standard",
      redact: false,
    });

    store.append(
      log.emit("tool.completed", {
        toolCallId: "call_1",
        toolName: "echo",
        status: "completed",
        output: { text: "x".repeat(600) },
        artifacts: [],
      }),
    );

    const trace = await readFile(store.tracePath, "utf8");
    const persisted = JSON.parse(trace) as { payload: unknown };

    expect(store.traceLevel).toBe("standard");
    expect(persisted.payload).toMatchObject({
      toolCallId: "call_1",
      toolName: "echo",
      status: "completed",
      output: {
        text: {
          type: "string",
          length: 600,
        },
      },
    });
  });

  it("keeps workspace write proposal summaries in standard traces", () => {
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

    const filtered = filterTraceEvent(event, "standard");

    expect(filtered.payload).toEqual({
      id: "write_1",
      runId,
      path: "README.md",
      reason: "test write",
      diffSummary: "--- a/README.md\n+++ b/README.md\n",
      createdAt: expect.any(String),
      metadata: {},
    });
  });

  it("keeps anchored edit evidence in standard traces", () => {
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

    const filtered = filterTraceEvent(event, "standard");

    expect(filtered.payload).toMatchObject({
      path: "README.md",
      reason: "Anchor hash does not match current line: 2#ABCD",
      error: {
        code: "ANCHOR_HASH_MISMATCH",
      },
    });
  });

  it("keeps validation evidence in standard traces", () => {
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

    const filtered = filterTraceEvent(event, "standard");

    expect(filtered.payload).toMatchObject({
      hookName: "final-answer-policy",
      stage: "final_output",
      result: {
        status: "failed",
        findings: [
          {
            code: "FINAL_TOO_LOOSE",
          },
        ],
      },
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
      ...sessionStoreOptions(root),
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
      ...sessionStoreOptions(root),
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
    const store = new FileRunStore(run, sessionStoreOptions(root));

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
      ...sessionStoreOptions(root),
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

  it("verifies a complete single-run trace", () => {
    const log = new EventLog(createRunId());
    const jsonl = [
      log.emit("run.created", { goal: "verify" }),
      log.emit("run.started", {}),
      log.emit("run.completed", { reason: "final_answer" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const report = verifyTraceJsonl(jsonl);

    expect(report.ok).toBe(true);
    expect(report.eventCount).toBe(3);
    expect(report.findings).toEqual([]);
  });

  it("does not require workspace write skipped events to pair with write requests", () => {
    const log = new EventLog(createRunId());
    const jsonl = [
      log.emit("run.created", { goal: "verify skipped write" }),
      log.emit("run.started", {}),
      log.emit("workspace.write.skipped", {
        path: "NOTES.md",
        reason: "desired content already present",
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]
      .map(serializeEventJsonl)
      .join("");

    const report = verifyTraceJsonl(jsonl);

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("verifies traces with collapsed stream text sequence ranges", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-stream-verify-"));
    tempDirs.push(root);
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const store = new FileRunStore(run, sessionStoreOptions(root));

    store.append(log.emit("run.created", { goal: run.goal }));
    store.append(log.emit("run.started", {}));
    store.append(log.emit("model.stream.started", { step: 1 }));
    store.append(
      log.emit("model.stream.chunk", { type: "text_delta", text: "a" }),
    );
    store.append(
      log.emit("model.stream.chunk", { type: "text_delta", text: "b" }),
    );
    store.append(log.emit("model.stream.completed", { step: 1 }));
    store.append(log.emit("run.completed", { reason: "final_answer" }));

    const report = verifyTraceJsonl(await readFile(store.tracePath, "utf8"));

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("checks monotonic ordering per trace id, not across appended traces", () => {
    const first = new EventLog(createRunId());
    const second = new EventLog(createRunId());
    const firstStart = first.emit("run.created", { goal: "first" });
    const firstDone = first.emit("run.completed", { reason: "final_answer" });
    const secondStart = second.emit("run.created", { goal: "second" });
    const secondDone = second.emit("run.completed", {
      reason: "final_answer",
    });
    secondStart.monotonicUs = 1;
    secondDone.monotonicUs = 2;

    const report = verifyTraceJsonl(
      [firstStart, firstDone, secondStart, secondDone]
        .map(serializeEventJsonl)
        .join(""),
    );

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("allows cross-run append order to differ from aggregate projection order", () => {
    const parent = new EventLog(createRunId());
    const child = new EventLog(createRunId());
    const parentStart = parent.emit("run.created", { goal: "parent" });
    const parentDone = parent.emit("run.completed", {
      reason: "final_answer",
    });
    const childStart = child.emit("run.created", { goal: "child" });
    const childDone = child.emit("run.completed", { reason: "final_answer" });
    parentStart.timestamp = "2026-02-02T00:00:00.000Z";
    parentDone.timestamp = "2026-02-02T00:00:01.000Z";
    childStart.timestamp = "2026-02-02T00:00:02.000Z";
    childDone.timestamp = "2026-02-02T00:00:03.000Z";

    const report = verifyTraceJsonl(
      [parentStart, childStart, childDone, parentDone]
        .map(serializeEventJsonl)
        .join(""),
    );

    expect(report.ok).toBe(true);
    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "TRACE_PROJECTION_ORDER_INVALID",
    );
    expect(report.findings.map((finding) => finding.code)).not.toContain(
      "TRACE_SEQUENCE_INVALID",
    );
  });

  it("checks monotonic ordering per agent within a shared-trace multi-agent run", () => {
    // Parent ("main") and child/delegate ("reviewer") agents share one traceId
    // but run in independent execution contexts with their own monotonic clocks.
    // Their events interleave in file order, so the child's smaller monotonicUs
    // must not be flagged as a backward move against the parent's timeline.
    const parent = new EventLog(createRunId());
    const child = new EventLog(createRunId());
    const parentStart = parent.emit("run.created", { goal: "parent" });
    const parentDone = parent.emit("run.completed", { reason: "final_answer" });
    const childStart = child.emit("run.created", { goal: "child" });
    const childDone = child.emit("run.completed", { reason: "final_answer" });

    const sharedTraceId = createTraceId();
    for (const event of [parentStart, parentDone]) {
      event.traceId = sharedTraceId;
      event.metadata = { ...event.metadata, agentId: "main" };
    }
    for (const event of [childStart, childDone]) {
      event.traceId = sharedTraceId;
      event.metadata = { ...event.metadata, agentId: "reviewer" };
    }
    parentStart.monotonicUs = 100;
    parentDone.monotonicUs = 300;
    childStart.monotonicUs = 5;
    childDone.monotonicUs = 10;

    // File order: parent start, child start, child done, parent done.
    const report = verifyTraceJsonl(
      [parentStart, childStart, childDone, parentDone]
        .map(serializeEventJsonl)
        .join(""),
    );

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("still flags a backward monotonicUs move within the same agent", () => {
    const log = new EventLog(createRunId());
    const start = log.emit("run.created", { goal: "regress" });
    const done = log.emit("run.completed", { reason: "final_answer" });
    const sharedTraceId = createTraceId();
    for (const event of [start, done]) {
      event.traceId = sharedTraceId;
      event.metadata = { ...event.metadata, agentId: "main" };
    }
    start.monotonicUs = 200;
    done.monotonicUs = 100;

    const report = verifyTraceJsonl(
      [start, done].map(serializeEventJsonl).join(""),
    );

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain(
      "TRACE_MONOTONIC_ORDER_INVALID",
    );
  });

  it("flags half-written traces and missing terminal events", () => {
    const log = new EventLog(createRunId());
    const event = log.emit("run.created", { goal: "verify" });

    const report = verifyTraceJsonl(JSON.stringify(event));

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "TRACE_FINAL_NEWLINE_MISSING",
        "TRACE_TERMINAL_EVENT_COUNT_INVALID",
      ]),
    );
  });

  it("treats a mid-flight cancel (run.cancelled + run.completed) as one terminal", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "essay" }),
      log.emit("run.started", {}),
      log.emit("run.cancelled", { reason: "manual_cancelled" }),
      log.emit("run.completed", {
        reason: "manual_cancelled",
        state: "cancelled",
      }),
    ];
    const report = verifyTraceJsonl(events.map(serializeEventJsonl).join(""));
    expect(report.findings.map((f) => f.code)).not.toContain(
      "TRACE_TERMINAL_EVENT_COUNT_INVALID",
    );
  });

  it("treats a cancel-before-start (run.cancelled only) as one terminal", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "x" }),
      log.emit("run.cancelled", { reason: "manual_cancelled" }),
    ];
    const report = verifyTraceJsonl(events.map(serializeEventJsonl).join(""));
    expect(report.findings.map((f) => f.code)).not.toContain(
      "TRACE_TERMINAL_EVENT_COUNT_INVALID",
    );
  });

  it("still flags a genuine double terminal (two run.completed)", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "x" }),
      log.emit("run.completed", { reason: "final_answer" }),
      log.emit("run.completed", { reason: "final_answer" }),
    ];
    const report = verifyTraceJsonl(events.map(serializeEventJsonl).join(""));
    expect(report.findings.map((f) => f.code)).toContain(
      "TRACE_TERMINAL_EVENT_COUNT_INVALID",
    );
  });
});

function withTestSpan<TPayload>(
  event: SparkwrightEvent<TPayload>,
  spanId: string,
  parentSpanId?: string,
): SparkwrightEvent<TPayload> {
  return {
    ...event,
    spanId: spanId as SparkwrightEvent["spanId"],
    parentSpanId: parentSpanId as SparkwrightEvent["parentSpanId"],
  };
}

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
