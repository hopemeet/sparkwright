import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRunId,
  EventLog,
  openSpan,
  type ShellExecutionResult,
  type ShellStreamingResult,
} from "@sparkwright/core";
import {
  resolveShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import {
  ProcessTelemetryParser,
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

function createStreamingResult(input: {
  stdout?: readonly string[];
  stderr?: readonly string[];
  metadata?: Record<string, unknown>;
  status?: ShellExecutionResult["status"];
  exitCode?: number | null;
}): ShellStreamingResult {
  return {
    handle: {
      stdout: () => asyncIterable(input.stdout ?? []),
      stderr: () => asyncIterable(input.stderr ?? []),
      abort: () => undefined,
      metadata: {},
    },
    completed: Promise.resolve(
      shellResult({
        stdout: (input.stdout ?? []).join(""),
        stderr: (input.stderr ?? []).join(""),
        metadata: input.metadata,
        status: input.status,
        exitCode: input.exitCode,
      }),
    ),
  };
}

async function* asyncIterable(
  chunks: readonly string[],
): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

function shellResult(input: {
  stdout?: string;
  stderr?: string;
  metadata?: Record<string, unknown>;
  status?: ShellExecutionResult["status"];
  exitCode?: number | null;
}): ShellExecutionResult {
  const now = new Date().toISOString();
  return {
    status: input.status ?? "completed",
    exitCode: input.exitCode ?? 0,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    startedAt: now,
    completedAt: now,
    metadata: input.metadata ?? {},
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ProcessTelemetryParser", () => {
  const limits = {
    maxProgressLineBytes: 8_192,
    maxProgressDataBytes: 4_096,
  };

  it("parses LF, CRLF, final flush, and holds partial lines", () => {
    const parser = new ProcessTelemetryParser({ limits });

    expect(parser.push("plain half")).toMatchObject({
      forwardableText: "",
      progressChunks: [],
    });
    expect(parser.push("\n")).toMatchObject({
      forwardableText: "plain half\n",
      progressChunks: [],
    });
    expect(
      parser.push('SPARKWRIGHT_EVENT: {"type":"progress","message":"lf"}\n')
        .progressChunks,
    ).toEqual([{ channel: "event", message: "lf" }]);
    expect(
      parser.push('SPARKWRIGHT_EVENT: {"type":"progress","message":"crlf"}\r\n')
        .progressChunks,
    ).toEqual([{ channel: "event", message: "crlf" }]);
    expect(
      parser.push('SPARKWRIGHT_EVENT: {"type":"progress","message":"final"}')
        .progressChunks,
    ).toEqual([]);
    expect(parser.flush().progressChunks).toEqual([
      { channel: "event", message: "final" },
    ]);
  });

  it("drops malformed and unsupported token records while forwarding non-line-start tokens", () => {
    const parser = new ProcessTelemetryParser({
      limits: {
        maxProgressLineBytes: 8_192,
        maxProgressDataBytes: 12,
      },
    });

    const nonLineStart =
      'prefix SPARKWRIGHT_EVENT: {"type":"progress","message":"no"}\n';
    expect(parser.push(nonLineStart)).toMatchObject({
      forwardableText: nonLineStart,
      progressChunks: [],
      droppedSamples: [],
    });
    expect(parser.push("SPARKWRIGHT_EVENT: not-json\n").droppedSamples).toEqual(
      [expect.objectContaining({ reason: "invalid_json" })],
    );
    expect(
      parser.push('SPARKWRIGHT_EVENT: {"type":"metric"}\n').droppedSamples,
    ).toEqual([expect.objectContaining({ reason: "unsupported_type" })]);
    expect(
      parser.push(
        'SPARKWRIGHT_EVENT: {"type":"progress","data":{"value":"this is too long"}}\n',
      ).droppedSamples,
    ).toEqual([expect.objectContaining({ reason: "data_too_large" })]);
    const lineLimitedParser = new ProcessTelemetryParser({
      limits: {
        maxProgressLineBytes: 40,
        maxProgressDataBytes: 4_096,
      },
    });
    expect(
      lineLimitedParser.push(
        `SPARKWRIGHT_EVENT: ${JSON.stringify({
          type: "progress",
          message: "line is too long for this test",
        })}\n`,
      ).droppedSamples,
    ).toEqual([expect.objectContaining({ reason: "line_too_large" })]);
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

  it("runs newline-delimited JSON-RPC over stdout/stdin and keeps telemetry on stderr", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = new TracedProcessRunner();
    const seen: string[] = [];
    const script = [
      "const readline = require('node:readline');",
      "let id = 1;",
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(method, params) { console.log(JSON.stringify({ jsonrpc: '2.0', id: id++, method, params })); }",
      "rl.on('line', (line) => {",
      "  const msg = JSON.parse(line);",
      "  if (msg.id === 1) send('getEvidence', { nodeId: 'build' });",
      "  else if (msg.id === 2) {",
      "    console.error('SPARKWRIGHT_EVENT: ' + JSON.stringify({ type: 'progress', message: 'script telemetry', data: { evidence: msg.result.length } }));",
      "    send('complete', { result: 'ok' });",
      "  } else if (msg.id === 3) process.exit(0);",
      "});",
      "send('initialize', { nodeId: 'build' });",
    ].join("\n");

    const result = await runner.runJsonRpc({
      emitter: events,
      runId,
      name: "workflow-script",
      kind: "custom",
      runtime: "node",
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      onRequest(request) {
        seen.push(request.method);
        if (request.method === "initialize") {
          return { protocol: "workflow-node-api.v1" };
        }
        if (request.method === "getEvidence") {
          return [{ kind: "fact", ref: "fact:1" }];
        }
        if (request.method === "complete") {
          return { accepted: true };
        }
        throw new Error(`unexpected method ${request.method}`);
      },
    });

    expect(result).toMatchObject({
      exitCode: 0,
      rpcRequests: 3,
      rpcErrors: 0,
      progressCount: 1,
    });
    expect(seen).toEqual(["initialize", "getEvidence", "complete"]);
    expect(
      events.all().filter((event) => event.type.startsWith("extension.")),
    ).toEqual([
      expect.objectContaining({ type: "extension.process.started" }),
      expect.objectContaining({
        type: "extension.process.progress",
        payload: expect.objectContaining({
          message: "script telemetry",
          data: { evidence: 1 },
        }),
      }),
      expect.objectContaining({ type: "extension.process.completed" }),
    ]);
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

  it("routes stderr token progress through the lifecycle span", async () => {
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
          "process.stderr.write(",
          "  process.env.SPARKWRIGHT_EVENT_TOKEN + ': ' +",
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
    expect(result.output.stderrPreview).toBeUndefined();
  });

  it("drops malformed, oversized, and over-limit stderr token records without leaking them", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = new TracedProcessRunner();

    const result = await runner.run({
      emitter: events,
      runId,
      name: "progress-drops",
      kind: "custom",
      command: process.execPath,
      args: [
        "-e",
        [
          "const token = process.env.SPARKWRIGHT_EVENT_TOKEN;",
          "const write = (text) => process.stderr.write(token + ': ' + text + '\\n');",
          "write('not-json');",
          "write(JSON.stringify({ type: 'metric', message: 'future' }));",
          "write(JSON.stringify({ type: 'progress', message: 'too big', data: { long: 'abcdefghijklmnop' } }));",
          "write(JSON.stringify({ type: 'progress', message: 'one' }));",
          "write(JSON.stringify({ type: 'progress', message: 'two' }));",
        ].join("\n"),
      ],
      cwd: process.cwd(),
      outputLimits: {
        maxProgressEvents: 1,
        maxProgressDataBytes: 16,
      },
    });

    expect(result).toMatchObject({
      progressCount: 1,
      progressDropped: 4,
      output: { stderrBytes: 0 },
    });
    expect(result).not.toHaveProperty("progressDroppedSamples");
    expect(JSON.stringify(result.output)).not.toContain("SPARKWRIGHT_EVENT");
    const completed = events
      .all()
      .find((event) => event.type === "extension.process.completed");
    expect(completed?.payload).toMatchObject({
      progressCount: 1,
      progressDropped: 4,
      progressDroppedSamples: [
        expect.objectContaining({ reason: "invalid_json" }),
        expect.objectContaining({ reason: "unsupported_type" }),
        expect.objectContaining({ reason: "data_too_large" }),
        expect.objectContaining({ reason: "limit_exceeded" }),
      ],
    });
  });

  it("flushes final stderr telemetry and awaits async progress before completing", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = new TracedProcessRunner();

    const result = await runner.run({
      emitter: events,
      runId,
      name: "final-progress",
      kind: "custom",
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stderr.write(",
          "  process.env.SPARKWRIGHT_EVENT_TOKEN + ': ' +",
          "  JSON.stringify({ type: 'progress', message: 'final' }));",
        ].join("\n"),
      ],
      cwd: process.cwd(),
      onProgress: async (chunk, context) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        context.emit("extension.process.progress", {
          invocationId: context.invocationId,
          ...chunk,
        });
      },
    });

    expect(result.progressCount).toBe(1);
    const processEvents = events
      .all()
      .filter((event) => event.type.startsWith("extension.process."));
    expect(processEvents.map((event) => event.type)).toEqual([
      "extension.process.started",
      "extension.process.progress",
      "extension.process.completed",
    ]);
    expect(processEvents[1]?.payload).toMatchObject({ message: "final" });
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
          "process.stderr.write(",
          "  process.env.SPARKWRIGHT_EVENT_TOKEN + ': ' +",
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
    expect(JSON.stringify(result.output)).not.toContain("SPARKWRIGHT_EVENT");
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

  it("terminates a raw process when its owner loses the execution lease", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = new TracedProcessRunner();
    const abort = new AbortController();
    const startedAt = Date.now();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const pending = runner.run({
      emitter: events,
      runId,
      name: "lease-owned",
      kind: "custom",
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      cwd: process.cwd(),
      abortSignal: abort.signal,
      onStarted: markStarted,
    });
    await started;
    abort.abort(new Error("workspace lease lost"));

    const result = await pending;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result).toMatchObject({
      timedOut: false,
      error: { code: "PROCESS_ABORTED" },
    });
    expect(
      events.all().find((event) => event.type === "extension.process.failed"),
    ).toMatchObject({
      payload: expect.objectContaining({ errorCode: "PROCESS_ABORTED" }),
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

  it("parses sandbox stderr progress without adding an inbox allowWrite path", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-runner-"));
    try {
      const captured: {
        allowWrite?: readonly string[];
        env?: NodeJS.ProcessEnv;
      } = {};
      const runtime: ShellSandboxRuntime = {
        id: "test-recording",
        platform: process.platform,
        isAvailable: async () => true,
        execute: async (request, config) => {
          captured.allowWrite = config.filesystem.allowWrite;
          captured.env = request.env;
          return createStreamingResult({
            stdout: ["ok\n"],
            stderr: [
              'SPARKWRIGHT_EVENT: {"type":"progress","message":"sandbox"}\n',
            ],
            metadata: {
              sandboxed: true,
              sandboxMode: "enforce",
              sandboxRuntime: "test-recording",
              sandboxNetworkMode: "deny",
              sandboxAvailable: true,
              sandboxEnforced: true,
            },
          });
        },
      };
      const runId = createRunId();
      const events = new EventLog(runId);
      const runner = new TracedProcessRunner();

      const result = await runner.run({
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

      expect(result.progressCount).toBe(1);
      expect(result.output).toMatchObject({
        stdoutPreview: "ok\n",
        stderrBytes: 0,
      });
      expect(captured.allowWrite).toBeDefined();
      expect(
        captured.allowWrite?.some((path) =>
          path.includes("sparkwright-trace-"),
        ),
      ).toBe(false);
      expect(captured.env).toMatchObject({
        SPARKWRIGHT_PROCESS_PROTOCOL: "stdio-v1",
        SPARKWRIGHT_EVENT_TOKEN: "SPARKWRIGHT_EVENT",
      });
      expect(captured.env).not.toHaveProperty("SPARKWRIGHT_TRACE_EVENTS");
      expect(captured.env).not.toHaveProperty("SPARKWRIGHT_TRACE_PROTOCOL");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("holds streaming stderr partial lines and strips tokens from live output surfaces", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner = new TracedProcessRunner();
    const firstChunkSeen = deferred<void>();
    const releaseRest = deferred<void>();
    const completed = deferred<ShellExecutionResult>();
    const output: Array<{ channel: string; data: string }> = [];
    const progress: Array<{ channel?: string; message?: string }> = [];
    const streaming: ShellStreamingResult = {
      handle: {
        stdout: () => asyncIterable([]),
        async *stderr() {
          firstChunkSeen.resolve();
          yield "held";
          await releaseRest.promise;
          yield '\nSPARKWRIGHT_EVENT: {"type":"progress","message":"structured"}\nvisible';
        },
        abort: () => undefined,
        metadata: {},
      },
      completed: completed.promise,
    };

    const observed = runner.observeStreaming({
      emitter: events,
      runId,
      name: "live",
      kind: "task",
      streaming,
      onOutput: (chunk) => {
        output.push(chunk);
      },
      onProgress: (chunk) => {
        progress.push(chunk);
      },
    });

    await firstChunkSeen.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output).toEqual([]);

    releaseRest.resolve();
    completed.resolve(shellResult({ stderr: "ignored aggregate stderr" }));
    const result = await observed;

    expect(result.output.stderrPreview).toBe("held\nvisible");
    expect(JSON.stringify(result.output)).not.toContain("SPARKWRIGHT_EVENT");
    expect(output).toEqual([
      { channel: "stderr", data: "held\n" },
      { channel: "stderr", data: "visible" },
    ]);
    expect(JSON.stringify(output)).not.toContain("SPARKWRIGHT_EVENT");
    expect(progress).toEqual(
      expect.arrayContaining([
        { channel: "stderr", message: "held\n" },
        { channel: "event", message: "structured" },
        { channel: "stderr", message: "visible" },
      ]),
    );
    expect(JSON.stringify(progress)).not.toContain("SPARKWRIGHT_EVENT");
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
