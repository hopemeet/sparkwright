import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  createArtifactId,
  openSpan,
  runWithSpan,
  type Artifact,
  type EventEmitter,
  type EventType,
  type ProcessInvocationBase,
  type ProcessOutputSummary,
  type RunId,
  type SandboxSummary,
  type ShellExecutionResult,
  type ShellStreamingResult,
  type SpanFrame,
  type SparkwrightEvent,
} from "@sparkwright/core";
import {
  ShellSandboxExecutor,
  createPlatformShellSandboxRuntime,
  type ResolvedShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";

const DEFAULT_PREVIEW_BYTES = 32_000;
const DEFAULT_ARTIFACT_BYTES = 64_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_MAX_PROGRESS_EVENTS = 200;
const DEFAULT_MAX_PROGRESS_LINE_BYTES = 8_192;
const DEFAULT_MAX_PROGRESS_DATA_BYTES = 4_096;
const PROGRESS_POLL_MS = 50;
const TIMEOUT_KILL_GRACE_MS = 500;

export interface ProgressChunk {
  message?: string;
  data?: Record<string, unknown>;
  channel?: "stdout" | "stderr" | "event";
}

export interface ProgressContext {
  invocationId: string;
  frame?: SpanFrame;
  emit<TPayload>(
    type: EventType,
    payload: TPayload,
    metadata?: Record<string, unknown>,
  ): SparkwrightEvent<TPayload>;
}

export interface ProcessOutputChunk {
  channel: "stdout" | "stderr";
  data: string;
}

export interface TracedProcessInput {
  emitter: EventEmitter;
  runId?: RunId;
  name: string;
  kind: ProcessInvocationBase["kind"];
  runtime?: ProcessInvocationBase["runtime"];
  command: string;
  args?: readonly string[];
  cwd: string;
  cwdBase?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs?: number;
  sandbox?: ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
  outputLimits?: {
    previewBytes?: number;
    artifactBytes?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    maxProgressEvents?: number;
    maxProgressLineBytes?: number;
    maxProgressDataBytes?: number;
  };
  /**
   * When true (default), the runner owns an `extension.process.*` lifecycle.
   * When false, callers own lifecycle events and should provide `onProgress`
   * if progress must be routed elsewhere, e.g. to `task.output`.
   */
  emitLifecycle?: boolean;
  spanFrame?: SpanFrame;
  onProgress?: (
    chunk: ProgressChunk,
    context: ProgressContext,
  ) => void | Promise<void>;
}

export interface TracedStreamingProcessInput {
  emitter: EventEmitter;
  runId?: RunId;
  name: string;
  kind: ProcessInvocationBase["kind"];
  runtime?: ProcessInvocationBase["runtime"];
  command?: string;
  args?: readonly string[];
  cwd?: string;
  cwdBase?: string;
  streaming: ShellStreamingResult;
  startedAt?: string | number;
  initialStdout?: string;
  initialStderr?: string;
  sandbox?: SandboxSummary;
  abortSignal?: AbortSignal;
  outputLimits?: TracedProcessInput["outputLimits"];
  spanFrame?: SpanFrame;
  onOutput?: (
    chunk: ProcessOutputChunk,
    context: ProgressContext,
  ) => void | Promise<void>;
  onProgress?: (
    chunk: ProgressChunk,
    context: ProgressContext,
  ) => void | Promise<void>;
}

export interface TracedProcessResult {
  invocationId: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  durationMs: number;
  output: ProcessOutputSummary;
  sandbox?: SandboxSummary;
  progressCount: number;
  progressDropped: number;
  /** @reserved Public process error summary consumed by host adapters. */
  error?: { code: string; message: string };
}

interface RawProcessResult {
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  sandbox?: SandboxSummary;
  error?: { code: string; message: string };
}

interface InboxState {
  dir: string;
  path: string;
  handle: FileHandle;
  offset: number;
  pending: string;
}

export class TracedProcessRunner {
  async run(input: TracedProcessInput): Promise<TracedProcessResult> {
    const invocationId = `proc_${randomUUID().replaceAll("-", "")}`;
    const limits = normalizeLimits(input.outputLimits);
    const base = processBase(input, invocationId);
    const stdout = new OutputCollector(
      limits.previewBytes,
      limits.maxStdoutBytes,
    );
    const stderr = new OutputCollector(
      limits.previewBytes,
      limits.maxStderrBytes,
    );
    let progressCount = 0;
    let progressDropped = 0;
    let sandbox: SandboxSummary | undefined;
    let raw: RawProcessResult | undefined;
    const startedAt = Date.now();
    const emitLifecycle = input.emitLifecycle !== false;
    const lifecycle = emitLifecycle ? openProcessSpan(input, base) : undefined;
    const frame = lifecycle?.frame ?? input.spanFrame;
    const context: ProgressContext = {
      invocationId,
      frame,
      emit: (type, payload, metadata) =>
        emitWithFrame(input.emitter, frame, type, payload, metadata),
    };
    const defaultProgress = (chunk: ProgressChunk): void => {
      if (!emitLifecycle) return;
      // Progress events only need the invocation key to correlate with the
      // span/lifecycle; the full `base` (command/args/cwd) already rides on the
      // started/completed events, so repeating it on every progress sample is
      // pure bloat at debug level.
      context.emit("extension.process.progress", {
        invocationId: base.invocationId,
        ...chunk,
      });
    };
    const onProgress = input.onProgress ?? defaultProgress;
    const inbox = await createInbox();
    const env = {
      ...sanitizeEnv(input.env),
      SPARKWRIGHT_TRACE_PROTOCOL: "extension-jsonl-v1",
      SPARKWRIGHT_TRACE_INVOCATION_ID: invocationId,
      SPARKWRIGHT_TRACE_EVENTS: inbox.path,
    };
    let drainChain = Promise.resolve();
    const queueDrain = (final: boolean): void => {
      drainChain = drainChain
        .then(() =>
          drainInbox(inbox, final, limits, async (chunk) => {
            if (progressCount >= limits.maxProgressEvents) {
              progressDropped += 1;
              return;
            }
            progressCount += 1;
            await onProgress(chunk, context);
          }),
        )
        .then((dropped) => {
          progressDropped += dropped;
        })
        .catch(() => {
          progressDropped += 1;
        });
    };
    const poll = setInterval(() => queueDrain(false), PROGRESS_POLL_MS);

    // The progress inbox lives under the OS temp dir. Under a filesystem-isolated
    // sandbox the child cannot see it unless it is explicitly writable, so add
    // the inbox dir to allowWrite before spawning.
    const execInput = input.sandbox
      ? { ...input, sandbox: withInboxWrite(input.sandbox, inbox.dir) }
      : input;
    try {
      raw = await this.execute(execInput, env, stdout, stderr);
      sandbox = raw.sandbox;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      stderr.append(`${message}\n`);
      raw = {
        exitCode: null,
        signal: null,
        timedOut: false,
        error: { code: "PROCESS_RUNNER_ERROR", message },
      };
    } finally {
      clearInterval(poll);
      queueDrain(true);
      await drainChain;
      await inbox.handle.close().catch(() => undefined);
      await rm(inbox.dir, { recursive: true, force: true });
    }

    const durationMs = Date.now() - startedAt;
    const output = outputSummary(stdout, stderr, limits.previewBytes);
    const artifactIds = emitOutputArtifacts({
      emitter: input.emitter,
      frame,
      runId: input.runId,
      base,
      stdout,
      stderr,
      artifactBytes: limits.artifactBytes,
    });
    if (artifactIds.length > 0) output.artifactIds = artifactIds;
    const result: TracedProcessResult = {
      invocationId,
      exitCode: raw.exitCode,
      signal: raw.signal ?? null,
      timedOut: raw.timedOut,
      durationMs,
      output,
      ...(sandbox ? { sandbox } : {}),
      progressCount,
      progressDropped,
      ...(raw.error ? { error: raw.error } : {}),
    };
    if (lifecycle) {
      const failed =
        raw.error !== undefined ||
        raw.timedOut ||
        raw.exitCode === null ||
        raw.exitCode !== 0;
      lifecycle.close(
        failed ? "extension.process.failed" : "extension.process.completed",
        {
          ...base,
          exitCode: raw.exitCode,
          signal: raw.signal ?? null,
          timedOut: raw.timedOut,
          durationMs,
          output,
          ...(sandbox ? { sandbox } : {}),
          progressCount,
          progressDropped,
          ...(raw.error ? { error: raw.error, errorCode: raw.error.code } : {}),
        },
      );
    }
    return result;
  }

  async observeStreaming(
    input: TracedStreamingProcessInput,
  ): Promise<TracedProcessResult> {
    const invocationId = `proc_${randomUUID().replaceAll("-", "")}`;
    const limits = normalizeLimits(input.outputLimits);
    const base = processBase(input, invocationId);
    const stdout = new OutputCollector(
      limits.previewBytes,
      limits.maxStdoutBytes,
    );
    const stderr = new OutputCollector(
      limits.previewBytes,
      limits.maxStderrBytes,
    );
    let progressCount = 0;
    let progressDropped = 0;
    let raw: RawProcessResult | undefined;
    let sandbox: SandboxSummary | undefined = input.sandbox;
    const startedAt = processStartedAtMs(input.startedAt);
    const context: ProgressContext = {
      invocationId,
      frame: input.spanFrame,
      emit: (type, payload, metadata) =>
        emitWithFrame(input.emitter, input.spanFrame, type, payload, metadata),
    };
    const onProgress = input.onProgress ?? (() => undefined);
    const emitProgress = async (chunk: ProgressChunk): Promise<void> => {
      if (progressCount >= limits.maxProgressEvents) {
        progressDropped += 1;
        return;
      }
      progressCount += 1;
      try {
        await onProgress(chunk, context);
      } catch {
        progressDropped += 1;
      }
    };
    const appendOutput = async (
      channel: ProcessOutputChunk["channel"],
      data: string,
    ): Promise<void> => {
      if (!data) return;
      if (channel === "stdout") stdout.append(data);
      else stderr.append(data);
      await input.onOutput?.({ channel, data }, context);
      await emitProgress({ channel, message: data });
    };
    const abort = (): void => {
      input.streaming.handle.abort("task cancelled");
    };
    input.abortSignal?.addEventListener("abort", abort, { once: true });

    try {
      await appendOutput("stdout", input.initialStdout ?? "");
      await appendOutput("stderr", input.initialStderr ?? "");
      const stdoutDrain = (async () => {
        for await (const chunk of input.streaming.handle.stdout()) {
          await appendOutput("stdout", chunk);
        }
      })();
      const stderrDrain = (async () => {
        for await (const chunk of input.streaming.handle.stderr()) {
          await appendOutput("stderr", chunk);
        }
      })();
      const final = await input.streaming.completed;
      await Promise.allSettled([stdoutDrain, stderrDrain]);
      if (!stdout.text && final.stdout) {
        await appendOutput("stdout", final.stdout);
      }
      if (!stderr.text && final.stderr) {
        await appendOutput("stderr", final.stderr);
      }
      raw = rawFromShellResult(final);
      sandbox = raw.sandbox ?? sandbox;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      stderr.append(`${message}\n`);
      raw = {
        exitCode: null,
        signal: null,
        timedOut: false,
        error: { code: "PROCESS_STREAM_FAILED", message },
      };
    } finally {
      input.abortSignal?.removeEventListener("abort", abort);
    }

    const durationMs = Date.now() - startedAt;
    const output = outputSummary(stdout, stderr, limits.previewBytes);
    const artifactIds = emitOutputArtifacts({
      emitter: input.emitter,
      frame: input.spanFrame,
      runId: input.runId,
      base,
      stdout,
      stderr,
      artifactBytes: limits.artifactBytes,
    });
    if (artifactIds.length > 0) output.artifactIds = artifactIds;
    return {
      invocationId,
      exitCode: raw.exitCode,
      signal: raw.signal ?? null,
      timedOut: raw.timedOut,
      durationMs,
      output,
      ...(sandbox ? { sandbox } : {}),
      progressCount,
      progressDropped,
      ...(raw.error ? { error: raw.error } : {}),
    };
  }

  private async execute(
    input: TracedProcessInput,
    env: NodeJS.ProcessEnv,
    stdout: OutputCollector,
    stderr: OutputCollector,
  ): Promise<RawProcessResult> {
    if (input.sandbox && input.sandbox.mode !== "off") {
      const sandboxed = await this.executeSandboxed(input, env, stdout, stderr);
      if (sandboxed.status === "completed") return sandboxed.result;
      if (input.sandbox.failIfUnavailable) {
        stderr.append(`${sandboxed.reason}\n`);
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          sandbox: sandboxed.sandbox,
          error: {
            code: "PROCESS_SANDBOX_UNAVAILABLE",
            message: sandboxed.reason,
          },
        };
      }
      return this.executeRaw(input, env, stdout, stderr, sandboxed.sandbox);
    }

    return this.executeRaw(input, env, stdout, stderr);
  }

  private async executeSandboxed(
    input: TracedProcessInput,
    env: NodeJS.ProcessEnv,
    stdout: OutputCollector,
    stderr: OutputCollector,
  ): Promise<
    | { status: "completed"; result: RawProcessResult }
    | { status: "fallback"; reason: string; sandbox: SandboxSummary }
  > {
    const sandbox = new ShellSandboxExecutor(
      input.sandboxRuntime ?? createPlatformShellSandboxRuntime(),
    );
    const started = await sandbox.execute(
      {
        command: shellCommand([input.command, ...(input.args ?? [])]),
        cwd: input.cwd,
        env,
        stdin: input.stdin,
        timeoutMs: input.timeoutMs,
        metadata: {
          sandboxMode: input.sandbox!.mode,
          sandboxNetworkMode: input.sandbox!.network.mode,
          sandboxAvailable: true,
          sandboxEnforced: input.sandbox!.failIfUnavailable,
        },
      },
      input.sandbox!,
    );
    if (started.status === "unavailable") {
      return {
        status: "fallback",
        reason: started.reason,
        sandbox: {
          sandboxed: false,
          mode: input.sandbox!.mode,
          runtime: started.runtimeId,
          networkMode: input.sandbox!.network.mode,
          available: false,
          fallbackReason: started.reason,
          enforced: input.sandbox!.failIfUnavailable,
        },
      };
    }
    return {
      status: "completed",
      result: await collectStreamingResult(started.result, stdout, stderr),
    };
  }

  private async executeRaw(
    input: TracedProcessInput,
    env: NodeJS.ProcessEnv,
    stdout: OutputCollector,
    stderr: OutputCollector,
    fallbackSandbox?: SandboxSummary,
  ): Promise<RawProcessResult> {
    return new Promise<RawProcessResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      // eslint-disable-next-line prefer-const -- assigned after spawn; finish closes over it.
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const finish = (result: RawProcessResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({
          ...result,
          timedOut: result.timedOut || timedOut,
          ...((result.sandbox ?? fallbackSandbox)
            ? { sandbox: result.sandbox ?? fallbackSandbox }
            : {}),
        });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(input.command, [...(input.args ?? [])], {
          cwd: input.cwd,
          env,
          stdio: [
            input.stdin !== undefined ? "pipe" : "ignore",
            "pipe",
            "pipe",
          ],
          shell: false,
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        stderr.append(`${message}\n`);
        finish({
          exitCode: 127,
          signal: null,
          timedOut: false,
          error: { code: "PROCESS_START_FAILED", message },
        });
        return;
      }

      timer =
        input.timeoutMs && input.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
              killTimer = setTimeout(() => {
                child.kill("SIGKILL");
                finish({
                  exitCode: null,
                  signal: "SIGKILL",
                  timedOut: true,
                  error: {
                    code: "PROCESS_TIMEOUT",
                    message: "Process timed out.",
                  },
                });
              }, TIMEOUT_KILL_GRACE_MS);
            }, input.timeoutMs)
          : undefined;

      if (input.stdin !== undefined) {
        child.stdin?.on("error", () => undefined);
        try {
          child.stdin?.end(input.stdin, "utf8");
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
          stderr.append(`${message}\n`);
          child.kill("SIGTERM");
          finish({
            exitCode: 127,
            signal: null,
            timedOut,
            error: { code: "PROCESS_STDIN_FAILED", message },
          });
        }
      }

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout.append(
          typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        );
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr.append(
          typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        );
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        stderr.append(`${error.message}\n`);
        finish({
          exitCode: 127,
          signal: null,
          timedOut,
          error: {
            code:
              error.code === "ENOENT"
                ? "PROCESS_COMMAND_NOT_FOUND"
                : "PROCESS_START_FAILED",
            message: error.message,
          },
        });
      });
      child.once("close", (code, signal) => {
        finish({
          exitCode: code,
          signal,
          timedOut,
          ...(timedOut
            ? {
                error: {
                  code: "PROCESS_TIMEOUT",
                  message: "Process timed out.",
                },
              }
            : {}),
        });
      });
    });
  }
}

async function createInbox(): Promise<InboxState> {
  const dir = await mkdtemp(join(tmpdir(), "sparkwright-trace-"));
  const path = join(dir, "events.jsonl");
  await writeFile(path, "", { mode: 0o600 });
  // Hold a long-lived read handle and track a byte offset so each poll reads
  // only the newly-appended bytes via positional reads, instead of re-reading
  // the whole (potentially large, noisy) inbox file every tick.
  const handle = await open(path, "r");
  return { dir, path, handle, offset: 0, pending: "" };
}

const INBOX_READ_CHUNK_BYTES = 64 * 1024;

async function drainInbox(
  inbox: InboxState,
  final: boolean,
  limits: NormalizedLimits,
  emit: (chunk: ProgressChunk) => Promise<void>,
): Promise<number> {
  let dropped = 0;
  const parts: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(INBOX_READ_CHUNK_BYTES);
  for (;;) {
    let bytesRead: number;
    try {
      ({ bytesRead } = await inbox.handle.read(
        buffer,
        0,
        buffer.length,
        inbox.offset,
      ));
    } catch {
      return 1;
    }
    if (bytesRead <= 0) break;
    parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
    inbox.offset += bytesRead;
  }
  if (parts.length > 0) {
    inbox.pending += Buffer.concat(parts).toString("utf8");
  }
  const lines = inbox.pending.split(/\r?\n/);
  inbox.pending = final ? "" : (lines.pop() ?? "");
  if (final && inbox.pending.trim()) {
    lines.push(inbox.pending);
    inbox.pending = "";
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > limits.maxProgressLineBytes) {
      dropped += 1;
      continue;
    }
    const parsed = parseProgressLine(line, limits);
    if (!parsed) {
      dropped += 1;
      continue;
    }
    await emit(parsed);
  }
  return dropped;
}

function parseProgressLine(
  line: string,
  limits: NormalizedLimits,
): ProgressChunk | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.type !== "progress") return undefined;
  const chunk: ProgressChunk = {};
  if (typeof raw.message === "string") chunk.message = raw.message;
  if (
    raw.channel === "stdout" ||
    raw.channel === "stderr" ||
    raw.channel === "event"
  ) {
    chunk.channel = raw.channel;
  }
  if (isRecord(raw.data)) {
    const data = sanitizeProgressData(raw.data);
    if (
      Buffer.byteLength(JSON.stringify(data), "utf8") <=
      limits.maxProgressDataBytes
    ) {
      chunk.data = data;
    } else {
      chunk.data = { truncated: true };
    }
  }
  return chunk;
}

async function collectStreamingResult(
  streaming: ShellStreamingResult,
  stdout: OutputCollector,
  stderr: OutputCollector,
): Promise<RawProcessResult> {
  const stdoutDrain = (async () => {
    for await (const chunk of streaming.handle.stdout()) stdout.append(chunk);
  })();
  const stderrDrain = (async () => {
    for await (const chunk of streaming.handle.stderr()) stderr.append(chunk);
  })();
  const final = await streaming.completed;
  await Promise.allSettled([stdoutDrain, stderrDrain]);
  if (!stdout.text && final.stdout) stdout.append(final.stdout);
  if (!stderr.text && final.stderr) stderr.append(final.stderr);
  const timedOut = final.metadata.timedOut === true;
  return {
    exitCode: final.exitCode,
    signal: null,
    timedOut,
    sandbox: sandboxSummary(final.metadata),
    ...(final.status === "failed" || timedOut
      ? {
          error: {
            code: timedOut ? "PROCESS_TIMEOUT" : "PROCESS_FAILED",
            message: final.stderr || "Process failed.",
          },
        }
      : {}),
  };
}

function openProcessSpan(
  input: TracedProcessInput,
  base: ProcessInvocationBase,
): ReturnType<typeof openSpan> {
  const open = () =>
    openSpan(input.emitter, {
      startType: "extension.process.started",
      payload: base,
    });
  return input.spanFrame ? runWithSpan(input.spanFrame, open) : open();
}

function emitWithFrame<TPayload>(
  emitter: EventEmitter,
  frame: SpanFrame | undefined,
  type: EventType,
  payload: TPayload,
  metadata?: Record<string, unknown>,
): SparkwrightEvent<TPayload> {
  if (!frame) return emitter.emit(type, payload, metadata);
  return runWithSpan(frame, () => emitter.emit(type, payload, metadata));
}

function emitOutputArtifacts(input: {
  emitter: EventEmitter;
  frame?: SpanFrame;
  runId?: RunId;
  base: ProcessInvocationBase;
  stdout: OutputCollector;
  stderr: OutputCollector;
  artifactBytes: number;
}): string[] {
  if (!input.runId) return [];
  const artifacts: Artifact[] = [];
  if (input.stdout.bytes > input.artifactBytes) {
    artifacts.push(
      outputArtifact(input.runId, input.base, "stdout", input.stdout),
    );
  }
  if (input.stderr.bytes > input.artifactBytes) {
    artifacts.push(
      outputArtifact(input.runId, input.base, "stderr", input.stderr),
    );
  }
  for (const artifact of artifacts) {
    emitWithFrame(input.emitter, input.frame, "artifact.created", artifact);
  }
  return artifacts.map((artifact) => artifact.id);
}

function outputArtifact(
  runId: RunId,
  base: ProcessInvocationBase,
  channel: "stdout" | "stderr",
  output: OutputCollector,
): Artifact {
  return {
    id: createArtifactId(),
    runId,
    type: "log",
    name: `${base.name}-${channel}.log`,
    content: output.text,
    metadata: {
      source: "traced_process",
      invocationId: base.invocationId,
      processName: base.name,
      processKind: base.kind,
      channel,
      bytes: output.bytes,
      truncated: output.contentTruncated,
    },
  };
}

function outputSummary(
  stdout: OutputCollector,
  stderr: OutputCollector,
  previewBytes: number,
): ProcessOutputSummary {
  return {
    ...(stdout.preview ? { stdoutPreview: stdout.preview } : {}),
    ...(stderr.preview ? { stderrPreview: stderr.preview } : {}),
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutTruncated: stdout.bytes > previewBytes || stdout.contentTruncated,
    stderrTruncated: stderr.bytes > previewBytes || stderr.contentTruncated,
  };
}

class OutputCollector {
  private readonly previewChunks: string[] = [];
  private readonly contentChunks: string[] = [];
  // Running UTF-8 byte counts kept incrementally so `append` stays O(chunk)
  // instead of re-`join`ing the whole accumulator on every write (which made
  // line-buffered output quadratic in total size).
  private previewBytes = 0;
  private contentBytes = 0;
  bytes = 0;
  contentTruncated = false;

  constructor(
    private readonly previewLimit: number,
    private readonly contentLimit: number,
  ) {}

  append(text: string): void {
    if (!text) return;
    const textBytes = Buffer.byteLength(text, "utf8");
    this.bytes += textBytes;
    this.previewBytes += appendBounded(
      this.previewChunks,
      text,
      textBytes,
      this.previewBytes,
      this.previewLimit,
    );
    const added = appendBounded(
      this.contentChunks,
      text,
      textBytes,
      this.contentBytes,
      this.contentLimit,
    );
    this.contentBytes += added;
    if (added < textBytes) this.contentTruncated = true;
  }

  get preview(): string {
    return this.previewChunks.join("");
  }

  get text(): string {
    return this.contentChunks.join("");
  }
}

/**
 * Append `text` to `chunks` without exceeding `maxBytes`, given the caller's
 * running `currentBytes` count. Returns the number of UTF-8 bytes actually
 * appended so the caller can update its counter without re-measuring the whole
 * buffer.
 */
function appendBounded(
  chunks: string[],
  text: string,
  textBytes: number,
  currentBytes: number,
  maxBytes: number,
): number {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) return 0;
  if (textBytes <= remaining) {
    chunks.push(text);
    return textBytes;
  }
  // Slicing on a byte boundary can split a multibyte char; re-measure the
  // decoded string so the running counter stays accurate.
  const sliceText = Buffer.from(text, "utf8")
    .subarray(0, remaining)
    .toString("utf8");
  chunks.push(sliceText);
  return Buffer.byteLength(sliceText, "utf8");
}

interface NormalizedLimits {
  previewBytes: number;
  artifactBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxProgressEvents: number;
  maxProgressLineBytes: number;
  maxProgressDataBytes: number;
}

function normalizeLimits(
  limits: TracedProcessInput["outputLimits"] = {},
): NormalizedLimits {
  return {
    previewBytes: positive(limits.previewBytes, DEFAULT_PREVIEW_BYTES),
    artifactBytes: positive(limits.artifactBytes, DEFAULT_ARTIFACT_BYTES),
    maxStdoutBytes: positive(limits.maxStdoutBytes, DEFAULT_MAX_OUTPUT_BYTES),
    maxStderrBytes: positive(limits.maxStderrBytes, DEFAULT_MAX_OUTPUT_BYTES),
    maxProgressEvents: positive(
      limits.maxProgressEvents,
      DEFAULT_MAX_PROGRESS_EVENTS,
    ),
    maxProgressLineBytes: positive(
      limits.maxProgressLineBytes,
      DEFAULT_MAX_PROGRESS_LINE_BYTES,
    ),
    maxProgressDataBytes: positive(
      limits.maxProgressDataBytes,
      DEFAULT_MAX_PROGRESS_DATA_BYTES,
    ),
  };
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Best-effort mapping from a command to a {@link ProcessInvocationBase}
 * runtime label so timeline views can show `extension python:...` instead of a
 * generic `custom`. Falls back to `custom` for anything unrecognized.
 */
export function inferProcessRuntime(
  command: string,
): ProcessInvocationBase["runtime"] {
  const base =
    command
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.(exe|cmd|bat)$/, "") ?? "";
  if (base === "bash" || base === "sh" || base === "zsh" || base === "dash") {
    return "shell";
  }
  if (base === "python" || /^python[0-9.]*$/.test(base)) return "python";
  if (base === "node" || base === "nodejs") return "node";
  if (base === "tsx") return "tsx";
  return "custom";
}

function processBase(
  input: {
    name: string;
    kind: ProcessInvocationBase["kind"];
    runtime?: ProcessInvocationBase["runtime"];
    command?: string;
    args?: readonly string[];
    cwd?: string;
    cwdBase?: string;
  },
  invocationId: string,
): ProcessInvocationBase {
  return {
    invocationId,
    name: input.name,
    kind: input.kind,
    runtime: input.runtime ?? "custom",
    ...(input.command ? { commandPreview: input.command } : {}),
    argsPreview:
      input.kind === "skill_script"
        ? summarizeSkillScriptArgs(input.args ?? [])
        : [...(input.args ?? [])],
    ...(input.cwd ? { cwd: displayCwd(input.cwd, input.cwdBase) } : {}),
  };
}

function summarizeSkillScriptArgs(args: readonly string[]): string[] {
  const text = args.join("\0");
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return [
    `<skill_script args sha256:${hash} bytes:${Buffer.byteLength(text, "utf8")}>`,
  ];
}

function displayCwd(cwd: string, base: string | undefined): string {
  if (!base) return cwd;
  const resolvedBase = resolve(base);
  const resolvedCwd = resolve(cwd);
  const rel = relative(resolvedBase, resolvedCwd);
  if (!rel) return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`)) return cwd;
  return rel;
}

function processStartedAtMs(startedAt: string | number | undefined): number {
  if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
    return startedAt;
  }
  if (typeof startedAt === "string") {
    const parsed = Date.parse(startedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function withInboxWrite(
  sandbox: ResolvedShellSandboxConfig,
  inboxDir: string,
): ResolvedShellSandboxConfig {
  if (sandbox.filesystem.allowWrite.includes(inboxDir)) return sandbox;
  return {
    ...sandbox,
    filesystem: {
      ...sandbox.filesystem,
      allowWrite: [...sandbox.filesystem.allowWrite, inboxDir],
    },
  };
}

function sanitizeEnv(
  env: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env ?? process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function sandboxSummary(
  metadata: Record<string, unknown> | undefined,
): SandboxSummary | undefined {
  if (!metadata || typeof metadata.sandboxed !== "boolean") return undefined;
  return {
    sandboxed: metadata.sandboxed,
    ...(typeof metadata.sandboxMode === "string"
      ? { mode: metadata.sandboxMode }
      : {}),
    ...(typeof metadata.sandboxRuntime === "string"
      ? { runtime: metadata.sandboxRuntime }
      : {}),
    ...(typeof metadata.sandboxNetworkMode === "string"
      ? { networkMode: metadata.sandboxNetworkMode }
      : {}),
    ...(typeof metadata.sandboxAvailable === "boolean"
      ? { available: metadata.sandboxAvailable }
      : {}),
    ...(typeof metadata.sandboxFallbackReason === "string"
      ? { fallbackReason: metadata.sandboxFallbackReason }
      : {}),
    ...(typeof metadata.sandboxEnforced === "boolean"
      ? { enforced: metadata.sandboxEnforced }
      : {}),
  };
}

function rawFromShellResult(final: ShellExecutionResult): RawProcessResult {
  const timedOut = final.metadata.timedOut === true;
  return {
    exitCode: final.exitCode,
    signal: null,
    timedOut,
    sandbox: sandboxSummary(final.metadata),
    ...(final.status === "failed" ||
    final.status === "denied" ||
    timedOut ||
    final.exitCode !== 0
      ? {
          error: {
            code: timedOut
              ? "PROCESS_TIMEOUT"
              : final.status === "denied"
                ? "PROCESS_DENIED"
                : "PROCESS_FAILED",
            message: final.stderr || "Process failed.",
          },
        }
      : {}),
  };
}

function shellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sanitizeProgressData(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return sanitizeRecord(value, depth);
}

function sanitizeUnknown(value: unknown, depth: number): unknown {
  if (depth >= 6) return "[truncated]";
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 1000
      ? `${value.slice(0, 1000)}...[truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeUnknown(item, depth + 1));
  }
  if (isRecord(value)) return sanitizeRecord(value, depth + 1);
  return String(value);
}

function sanitizeRecord(
  value: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 50)) {
    out[key] = sanitizeUnknown(nested, depth + 1);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
