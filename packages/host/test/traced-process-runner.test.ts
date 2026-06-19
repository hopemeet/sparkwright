import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunId, EventLog, openSpan } from "@sparkwright/core";
import { TracedProcessRunner } from "../src/traced-process-runner.js";

describe("TracedProcessRunner", () => {
  it("emits an extension process lifecycle for successful commands", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = new TracedProcessRunner();

    const result = await runner.run({
      emitter: events,
      runId,
      name: "smoke",
      kind: "custom",
      command: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: process.cwd(),
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      output: {
        stdoutPreview: "ok\n",
        stdoutBytes: 3,
        stdoutTruncated: false,
      },
    });
    const processEvents = events
      .all()
      .filter((event) => event.type.startsWith("extension.process."));
    expect(processEvents.map((event) => event.type)).toEqual([
      "extension.process.started",
      "extension.process.completed",
    ]);
    expect(processEvents[0]?.spanId).toBeDefined();
    expect(processEvents[1]?.spanId).toBe(processEvents[0]?.spanId);
  });

  it("routes inbox progress through the lifecycle span", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = new TracedProcessRunner();

    const result = await runner.run({
      emitter: events,
      runId,
      name: "progress",
      kind: "custom",
      command: process.execPath,
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          "fs.appendFileSync(process.env.SPARKWRIGHT_TRACE_EVENTS,",
          "  JSON.stringify({ type: 'progress', message: 'half', data: { files: 2 } }) + '\\n');",
        ].join("\n"),
      ],
      cwd: process.cwd(),
    });

    expect(result.progressCount).toBe(1);
    const started = events
      .all()
      .find((event) => event.type === "extension.process.started");
    const progress = events
      .all()
      .find((event) => event.type === "extension.process.progress");
    expect(progress).toMatchObject({
      payload: {
        invocationId: result.invocationId,
        message: "half",
        data: { files: 2 },
      },
      spanId: started?.spanId,
    });
  });

  it("lets callers route progress without extension lifecycle events", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const taskSpan = openSpan(events, {
      startType: "task.started",
      payload: { taskId: "task_1" },
    });
    const runner = new TracedProcessRunner();

    const result = await runner.run({
      emitter: events,
      runId,
      name: "task-process",
      kind: "task",
      emitLifecycle: false,
      spanFrame: taskSpan.frame,
      command: process.execPath,
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          "fs.appendFileSync(process.env.SPARKWRIGHT_TRACE_EVENTS,",
          "  JSON.stringify({ type: 'progress', message: 'chunk' }) + '\\n');",
        ].join("\n"),
      ],
      cwd: process.cwd(),
      onProgress: (chunk, context) => {
        context.emit("task.output", {
          taskId: "task_1",
          channel: "event",
          data: chunk.message,
        });
      },
    });
    taskSpan.close("task.completed", {
      taskId: "task_1",
      output: result.output,
    });

    expect(
      events.all().some((event) => event.type.startsWith("extension.")),
    ).toBe(false);
    const taskOutput = events
      .all()
      .find((event) => event.type === "task.output");
    expect(taskOutput).toMatchObject({
      payload: { taskId: "task_1", channel: "event", data: "chunk" },
      spanId: taskSpan.frame.spanId,
    });
  });

  it("pairs spawn failures with extension.process.failed", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = new TracedProcessRunner();

    const result = await runner.run({
      emitter: events,
      runId,
      name: "missing",
      kind: "custom",
      command: join("/definitely-missing", "sparkwright-nope"),
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(127);
    const processEvents = events
      .all()
      .filter((event) => event.type.startsWith("extension.process."));
    expect(processEvents.map((event) => event.type)).toEqual([
      "extension.process.started",
      "extension.process.failed",
    ]);
    expect(processEvents[1]).toMatchObject({
      spanId: processEvents[0]?.spanId,
      payload: expect.objectContaining({
        errorCode: "PROCESS_COMMAND_NOT_FOUND",
      }),
    });
  });

  it("force-kills raw processes that ignore timeout termination", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = new TracedProcessRunner();
    const startedAt = Date.now();

    const result = await runner.run({
      emitter: events,
      runId,
      name: "stubborn",
      kind: "custom",
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      cwd: process.cwd(),
      timeoutMs: 50,
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result).toMatchObject({
      timedOut: true,
      error: { code: "PROCESS_TIMEOUT" },
    });
    expect(
      events.all().find((event) => event.type === "extension.process.failed"),
    ).toMatchObject({
      payload: expect.objectContaining({ errorCode: "PROCESS_TIMEOUT" }),
    });
  });

  it("emits artifacts for output beyond the artifact threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-runner-"));
    try {
      const runId = createRunId();
      const events = new EventLog(runId);
      const runner = new TracedProcessRunner();

      const result = await runner.run({
        emitter: events,
        runId,
        name: "artifact",
        kind: "custom",
        command: process.execPath,
        args: ["-e", "process.stdout.write('abcdefghijklmnop')"],
        cwd: root,
        outputLimits: {
          previewBytes: 4,
          artifactBytes: 5,
          maxStdoutBytes: 32,
        },
      });

      expect(result.output).toMatchObject({
        stdoutPreview: "abcd",
        stdoutBytes: 16,
        stdoutTruncated: true,
        artifactIds: [expect.stringMatching(/^artifact_/)],
      });
      expect(events.all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "artifact.created",
            payload: expect.objectContaining({
              type: "log",
              content: "abcdefghijklmnop",
            }),
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
