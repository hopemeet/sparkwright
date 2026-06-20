import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunId, EventLog, openSpan } from "@sparkwright/core";
import {
  resolveShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import {
  TracedProcessRunner,
  inferProcessRuntime,
} from "../src/traced-process-runner.js";

describe("inferProcessRuntime", () => {
  it("maps common interpreters to runtime labels", () => {
    expect(inferProcessRuntime("bash")).toBe("shell");
    expect(inferProcessRuntime("/bin/sh")).toBe("shell");
    expect(inferProcessRuntime("/usr/bin/python3")).toBe("python");
    expect(inferProcessRuntime("python3.12")).toBe("python");
    expect(inferProcessRuntime("/usr/local/bin/node")).toBe("node");
    expect(inferProcessRuntime("tsx")).toBe("tsx");
    expect(inferProcessRuntime("./scripts/check")).toBe("custom");
    expect(inferProcessRuntime("C:\\Python\\python.exe")).toBe("python");
  });
});

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

  it("redacts skill_script argument previews to a stable summary", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = new TracedProcessRunner();

    await runner.run({
      emitter: events,
      runId,
      name: "skill-inline-shell",
      kind: "skill_script",
      runtime: "shell",
      command: "bash",
      args: ["-c", "echo FAKE_INLINE_SECRET_VALUE"],
      cwd: join(process.cwd(), "packages"),
      cwdBase: process.cwd(),
    });

    const started = events
      .all()
      .find((event) => event.type === "extension.process.started");
    expect(started).toMatchObject({
      payload: expect.objectContaining({
        argsPreview: [
          expect.stringMatching(
            /^<skill_script args sha256:[a-f0-9]{16} bytes:\d+>$/,
          ),
        ],
        cwd: "packages",
      }),
    });
    expect(JSON.stringify(started?.payload)).not.toContain(
      "FAKE_INLINE_SECRET_VALUE",
    );
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
    // Progress payload stays lean — the command/args base lives on the
    // started/completed events, not on every progress sample.
    expect(progress?.payload).not.toHaveProperty("commandPreview");
    expect(progress?.payload).not.toHaveProperty("argsPreview");
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

  it("marks content truncated and stores the capped output in the artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-runner-"));
    try {
      const runId = createRunId();
      const events = new EventLog(runId);
      const runner = new TracedProcessRunner();

      const result = await runner.run({
        emitter: events,
        runId,
        name: "capped",
        kind: "custom",
        command: process.execPath,
        // Write in many small chunks so the (previously quadratic) collector is
        // exercised across the maxStdoutBytes boundary.
        args: [
          "-e",
          "for (let i = 0; i < 50; i++) process.stdout.write('abcd');",
        ],
        cwd: root,
        outputLimits: {
          previewBytes: 8,
          artifactBytes: 4,
          maxStdoutBytes: 20,
        },
      });

      expect(result.output).toMatchObject({
        stdoutPreview: "abcdabcd",
        stdoutBytes: 200,
        stdoutTruncated: true,
      });
      const artifact = events
        .all()
        .find((event) => event.type === "artifact.created");
      // Content is capped at maxStdoutBytes, not the full 200 bytes emitted.
      expect((artifact?.payload as { content: string }).content).toBe(
        "abcd".repeat(5),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adds the progress inbox dir to sandbox allowWrite so the child can reach it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-runner-"));
    try {
      const captured: { allowWrite?: readonly string[] } = {};
      const runtime: ShellSandboxRuntime = {
        id: "test-recording",
        platform: process.platform,
        isAvailable: async () => true,
        execute: async (_request, config) => {
          captured.allowWrite = config.filesystem.allowWrite;
          throw new Error("captured");
        },
      };
      const runId = createRunId();
      const events = new EventLog(runId);
      const runner = new TracedProcessRunner();

      await runner.run({
        emitter: events,
        runId,
        name: "sandboxed",
        kind: "custom",
        command: process.execPath,
        args: ["-e", "console.log('ok')"],
        cwd: root,
        sandbox: resolveShellSandboxConfig({
          workspaceRoot: root,
          config: { mode: "enforce" },
        }),
        sandboxRuntime: runtime,
      });

      expect(captured.allowWrite).toBeDefined();
      expect(
        captured.allowWrite?.some((path) =>
          path.includes("sparkwright-trace-"),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
