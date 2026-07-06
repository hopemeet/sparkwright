import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
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
  prepareSandboxedProcessInvocation,
  type ResolvedShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";

const DEFAULT_PREVIEW_BYTES = 32_000;
const DEFAULT_ARTIFACT_BYTES = 64_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_MAX_PROGRESS_EVENTS = 200;
const DEFAULT_MAX_PROGRESS_LINE_BYTES = 8_192;
const DEFAULT_MAX_PROGRESS_DATA_BYTES = 4_096;
const PROCESS_PROTOCOL = "stdio-v1";
const PROCESS_EVENT_TOKEN = "SPARKWRIGHT_EVENT";
const DROPPED_SAMPLE_LIMIT = 5;
const DROPPED_SAMPLE_PREVIEW_BYTES = 240;
const TIMEOUT_KILL_GRACE_MS = 500;

export interface ProgressChunk {
  message?: string;
  data?: Record<string, unknown>;
  channel?: "stdout" | "stderr" | "event";
}

export interface ProcessProgressSampleSummary {
  progressCount: number;
  progressDropped: number;
  progressHead: ProgressChunk[];
  progressTail: ProgressChunk[];
}

export type ProcessTelemetryDroppedReason =
  | "invalid_json"
  | "unsupported_type"
  | "line_too_large"
  | "data_too_large"
  | "limit_exceeded";

export interface ProcessTelemetryDroppedSample {
  reason: ProcessTelemetryDroppedReason;
  preview: string;
}

export interface ProcessTelemetryParseResult {
  forwardableText: string;
  progressChunks: ProgressChunk[];
  droppedSamples: ProcessTelemetryDroppedSample[];
}

export interface ProcessTelemetryParserOptions {
  limits: {
    maxProgressLineBytes: number;
    maxProgressDataBytes: number;
  };
  token?: string;
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

export function createProcessProgressSampleCollector(
  options: {
    headLimit?: number;
    tailLimit?: number;
  } = {},
): {
  record(chunk: ProgressChunk): void;
  summary(input: {
    progressCount: number;
    progressDropped: number;
  }): ProcessProgressSampleSummary;
} {
  const headLimit = options.headLimit ?? 5;
  const tailLimit = options.tailLimit ?? 5;
  const progressHead: ProgressChunk[] = [];
  const progressTail: ProgressChunk[] = [];
  return {
    record(chunk) {
      const sample = cloneProgressChunk(chunk);
      if (progressHead.length < headLimit) {
        progressHead.push(sample);
        return;
      }
      progressTail.push(sample);
      if (progressTail.length > tailLimit) {
        progressTail.shift();
      }
    },
    summary(input) {
      return {
        progressCount: input.progressCount,
        progressDropped: input.progressDropped,
        progressHead: progressHead.map(cloneProgressChunk),
        progressTail: progressTail.map(cloneProgressChunk),
      };
    },
  };
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

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcHandler = (
  request: JsonRpcRequest,
  context: ProgressContext,
) => unknown | Promise<unknown>;

export interface TracedJsonRpcProcessInput extends Omit<
  TracedProcessInput,
  "stdin"
> {
  onRequest: JsonRpcHandler;
  protocol?: string;
}

export interface TracedJsonRpcProcessResult extends TracedProcessResult {
  rpcRequests: number;
  rpcErrors: number;
}

interface RawProcessResult {
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  sandbox?: SandboxSummary;
  error?: { code: string; message: string };
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
    const progress = createProgressEmitter({
      limits,
      context,
      onProgress: input.onProgress ?? defaultProgress,
    });
    const env = {
      ...sanitizeEnv(input.env),
      SPARKWRIGHT_PROCESS_PROTOCOL: PROCESS_PROTOCOL,
      SPARKWRIGHT_EVENT_TOKEN: PROCESS_EVENT_TOKEN,
    };
    try {
      raw = await this.execute(input, env, stdout, stderr, progress);
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
      progressCount: progress.count,
      progressDropped: progress.dropped,
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
          progressCount: progress.count,
          progressDropped: progress.dropped,
          ...(progress.droppedSamples.length > 0
            ? { progressDroppedSamples: progress.droppedSamples }
            : {}),
          ...(raw.error ? { error: raw.error, errorCode: raw.error.code } : {}),
        },
      );
    }
    return result;
  }

  async runJsonRpc(
    input: TracedJsonRpcProcessInput,
  ): Promise<TracedJsonRpcProcessResult> {
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
    let sandbox: SandboxSummary | undefined;
    let raw:
      | (RawProcessResult & { rpcRequests: number; rpcErrors: number })
      | undefined;
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
      context.emit("extension.process.progress", {
        invocationId: base.invocationId,
        ...chunk,
      });
    };
    const progress = createProgressEmitter({
      limits,
      context,
      onProgress: input.onProgress ?? defaultProgress,
    });
    const env = {
      ...sanitizeEnv(input.env),
      SPARKWRIGHT_PROCESS_PROTOCOL: PROCESS_PROTOCOL,
      SPARKWRIGHT_NODE_API_PROTOCOL: input.protocol ?? "workflow-node-api.v1",
      SPARKWRIGHT_EVENT_TOKEN: PROCESS_EVENT_TOKEN,
    };
    try {
      raw = await this.executeJsonRpc(
        input,
        env,
        stdout,
        stderr,
        progress,
        context,
      );
      sandbox = raw.sandbox;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      stderr.append(`${message}\n`);
      raw = {
        exitCode: null,
        signal: null,
        timedOut: false,
        rpcRequests: 0,
        rpcErrors: 1,
        error: { code: "PROCESS_JSON_RPC_ERROR", message },
      };
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
    const result: TracedJsonRpcProcessResult = {
      invocationId,
      exitCode: raw.exitCode,
      signal: raw.signal ?? null,
      timedOut: raw.timedOut,
      durationMs,
      output,
      ...(sandbox ? { sandbox } : {}),
      progressCount: progress.count,
      progressDropped: progress.dropped,
      rpcRequests: raw.rpcRequests,
      rpcErrors: raw.rpcErrors,
      ...(raw.error ? { error: raw.error } : {}),
    };
    if (lifecycle) {
      const failed =
        raw.error !== undefined ||
        raw.timedOut ||
        raw.exitCode === null ||
        raw.exitCode !== 0 ||
        raw.rpcErrors > 0;
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
          progressCount: progress.count,
          progressDropped: progress.dropped,
          rpcRequests: raw.rpcRequests,
          rpcErrors: raw.rpcErrors,
          ...(progress.droppedSamples.length > 0
            ? { progressDroppedSamples: progress.droppedSamples }
            : {}),
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
    const progress = createProgressEmitter({ limits, context, onProgress });
    const stderrTelemetry = new ProcessTelemetryParser({ limits });
    let sawStdout = Boolean(input.initialStdout);
    let sawStderr = Boolean(input.initialStderr);
    const appendOutput = async (
      channel: ProcessOutputChunk["channel"],
      data: string,
    ): Promise<void> => {
      if (!data) return;
      if (channel === "stdout") stdout.append(data);
      else stderr.append(data);
      await input.onOutput?.({ channel, data }, context);
      await progress.emit({ channel, message: data }, data);
    };
    const appendStderrTelemetry = async (data: string): Promise<void> => {
      if (!data) return;
      sawStderr = true;
      const parsed = stderrTelemetry.push(data);
      await appendParsedStderr(parsed, appendOutput, progress);
    };
    const abort = (): void => {
      input.streaming.handle.abort("task cancelled");
    };
    input.abortSignal?.addEventListener("abort", abort, { once: true });

    try {
      await appendOutput("stdout", input.initialStdout ?? "");
      await appendStderrTelemetry(input.initialStderr ?? "");
      const stdoutDrain = (async () => {
        for await (const chunk of input.streaming.handle.stdout()) {
          sawStdout = true;
          await appendOutput("stdout", chunk);
        }
      })();
      const stderrDrain = (async () => {
        for await (const chunk of input.streaming.handle.stderr()) {
          await appendStderrTelemetry(chunk);
        }
      })();
      const final = await input.streaming.completed;
      await Promise.allSettled([stdoutDrain, stderrDrain]);
      await appendParsedStderr(stderrTelemetry.flush(), appendOutput, progress);
      if (!sawStdout && final.stdout) {
        await appendOutput("stdout", final.stdout);
      }
      if (!sawStderr && final.stderr) {
        await appendStderrTelemetry(final.stderr);
        await appendParsedStderr(
          stderrTelemetry.flush(),
          appendOutput,
          progress,
        );
      }
      raw = rawFromShellResult(final, stderr.text);
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
      progressCount: progress.count,
      progressDropped: progress.dropped,
      ...(raw.error ? { error: raw.error } : {}),
    };
  }

  private async execute(
    input: TracedProcessInput,
    env: NodeJS.ProcessEnv,
    stdout: OutputCollector,
    stderr: OutputCollector,
    progress: ProgressEmitter,
  ): Promise<RawProcessResult> {
    if (input.sandbox && input.sandbox.mode !== "off") {
      const sandboxed = await this.executeSandboxed(
        input,
        env,
        stdout,
        stderr,
        progress,
      );
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
      return this.executeRaw(
        input,
        env,
        stdout,
        stderr,
        progress,
        sandboxed.sandbox,
      );
    }

    return this.executeRaw(input, env, stdout, stderr, progress);
  }

  private async executeSandboxed(
    input: TracedProcessInput,
    env: NodeJS.ProcessEnv,
    stdout: OutputCollector,
    stderr: OutputCollector,
    progress: ProgressEmitter,
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
      result: await collectStreamingResult(
        started.result,
        stdout,
        stderr,
        progress,
      ),
    };
  }

  private async executeRaw(
    input: TracedProcessInput,
    env: NodeJS.ProcessEnv,
    stdout: OutputCollector,
    stderr: OutputCollector,
    progress: ProgressEmitter,
    fallbackSandbox?: SandboxSummary,
  ): Promise<RawProcessResult> {
    return new Promise<RawProcessResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      // eslint-disable-next-line prefer-const -- assigned after spawn; finish closes over it.
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const telemetry = new ProcessTelemetryParser({ limits: progress.limits });
      let stderrChain = Promise.resolve();
      const appendStderr = (text: string): void => {
        if (!text) return;
        stderrChain = stderrChain
          .then(async () => {
            const parsed = telemetry.push(text);
            stderr.append(parsed.forwardableText);
            await progress.emitParsed(parsed);
          })
          .catch(() => {
            progress.recordDropped("invalid_json", text);
          });
      };
      const finish = (result: RawProcessResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        stderrChain = stderrChain
          .then(async () => {
            const parsed = telemetry.flush();
            stderr.append(parsed.forwardableText);
            await progress.emitParsed(parsed);
          })
          .catch(() => {
            progress.recordDropped("invalid_json", "");
          })
          .then(() => {
            resolve({
              ...result,
              timedOut: result.timedOut || timedOut,
              ...((result.sandbox ?? fallbackSandbox)
                ? { sandbox: result.sandbox ?? fallbackSandbox }
                : {}),
            });
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
        appendStderr(
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

  private async executeJsonRpc(
    input: TracedJsonRpcProcessInput,
    env: NodeJS.ProcessEnv,
    stdout: OutputCollector,
    stderr: OutputCollector,
    progress: ProgressEmitter,
    context: ProgressContext,
  ): Promise<RawProcessResult & { rpcRequests: number; rpcErrors: number }> {
    let prepared:
      | {
          command: string;
          args: readonly string[];
          cwd: string;
          env?: NodeJS.ProcessEnv;
          cleanup?: () => Promise<void>;
          sandbox?: SandboxSummary;
        }
      | undefined;
    if (input.sandbox && input.sandbox.mode !== "off") {
      const runtime =
        input.sandboxRuntime ?? createPlatformShellSandboxRuntime();
      if (await runtime.isAvailable()) {
        const invocation = await prepareSandboxedProcessInvocation(
          runtime,
          {
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            env,
            metadata: {
              sandboxMode: input.sandbox.mode,
              sandboxNetworkMode: input.sandbox.network.mode,
              sandboxAvailable: true,
              sandboxEnforced: input.sandbox.failIfUnavailable,
            },
          },
          input.sandbox,
        );
        prepared = {
          command: invocation.command,
          args: invocation.args,
          cwd: invocation.cwd,
          env: invocation.env,
          cleanup: invocation.cleanup,
          sandbox: {
            sandboxed: true,
            mode: input.sandbox.mode,
            runtime: runtime.id,
            networkMode: input.sandbox.network.mode,
            available: true,
            enforced: input.sandbox.failIfUnavailable,
          },
        };
      } else if (input.sandbox.failIfUnavailable) {
        const message = `Shell sandbox runtime "${runtime.id}" is unavailable on ${runtime.platform}.`;
        stderr.append(`${message}\n`);
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          rpcRequests: 0,
          rpcErrors: 1,
          sandbox: {
            sandboxed: false,
            mode: input.sandbox.mode,
            runtime: runtime.id,
            networkMode: input.sandbox.network.mode,
            available: false,
            fallbackReason: message,
            enforced: true,
          },
          error: {
            code: "PROCESS_SANDBOX_UNAVAILABLE",
            message,
          },
        };
      } else {
        const message = `Shell sandbox runtime "${runtime.id}" is unavailable on ${runtime.platform}.`;
        prepared = {
          command: input.command,
          args: input.args ?? [],
          cwd: input.cwd,
          env,
          sandbox: {
            sandboxed: false,
            mode: input.sandbox.mode,
            runtime: runtime.id,
            networkMode: input.sandbox.network.mode,
            available: false,
            fallbackReason: message,
            enforced: false,
          },
        };
      }
    } else {
      prepared = {
        command: input.command,
        args: input.args ?? [],
        cwd: input.cwd,
        env,
      };
    }

    return new Promise<
      RawProcessResult & { rpcRequests: number; rpcErrors: number }
    >((resolve) => {
      let settled = false;
      let timedOut = false;
      let rpcRequests = 0;
      let rpcErrors = 0;
      let stdoutBuffer = "";
      let stdoutChain = Promise.resolve();
      let stderrChain = Promise.resolve();
      // eslint-disable-next-line prefer-const -- assigned after spawn; finish closes over it.
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const telemetry = new ProcessTelemetryParser({ limits: progress.limits });
      const appendStderr = (text: string): void => {
        if (!text) return;
        stderrChain = stderrChain
          .then(async () => {
            const parsed = telemetry.push(text);
            stderr.append(parsed.forwardableText);
            await progress.emitParsed(parsed);
          })
          .catch(() => {
            progress.recordDropped("invalid_json", text);
          });
      };
      const writeResponse = (
        child: ReturnType<typeof spawn>,
        value: unknown,
      ): void => {
        child.stdin?.write(`${JSON.stringify(value)}\n`, "utf8");
      };
      const respondError = (
        child: ReturnType<typeof spawn>,
        id: JsonRpcRequest["id"],
        error: JsonRpcErrorObject,
      ): void => {
        if (id === undefined) return;
        writeResponse(child, {
          jsonrpc: "2.0",
          id: id ?? null,
          error,
        });
      };
      const handleLine = async (
        child: ReturnType<typeof spawn>,
        line: string,
      ): Promise<void> => {
        const text = line.trim();
        if (!text) return;
        let raw: unknown;
        try {
          raw = JSON.parse(text) as unknown;
        } catch {
          rpcErrors += 1;
          stdout.append(`${line}\n`);
          return;
        }
        const request = normalizeJsonRpcRequest(raw);
        if (!request) {
          rpcErrors += 1;
          stdout.append(`${line}\n`);
          return;
        }
        rpcRequests += 1;
        try {
          const result = await input.onRequest(request, context);
          if (request.id !== undefined) {
            writeResponse(child, {
              jsonrpc: "2.0",
              id: request.id ?? null,
              result: result ?? null,
            });
          }
        } catch (cause) {
          rpcErrors += 1;
          respondError(child, request.id, {
            code: -32000,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      };
      const appendStdout = (
        child: ReturnType<typeof spawn>,
        text: string,
      ): void => {
        if (!text) return;
        stdoutBuffer += text;
        for (;;) {
          const newlineIndex = stdoutBuffer.indexOf("\n");
          if (newlineIndex < 0) break;
          const line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          stdoutChain = stdoutChain.then(() => handleLine(child, line));
        }
      };
      const finish = (result: RawProcessResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (stdoutBuffer) {
          const line = stdoutBuffer;
          stdoutBuffer = "";
          stdoutChain = stdoutChain.then(() => {
            rpcErrors += 1;
            stdout.append(line);
          });
        }
        stderrChain = stderrChain.then(async () => {
          const parsed = telemetry.flush();
          stderr.append(parsed.forwardableText);
          await progress.emitParsed(parsed);
        });
        Promise.allSettled([stdoutChain, stderrChain])
          .then(() => prepared?.cleanup?.())
          .then(() => {
            resolve({
              ...result,
              timedOut: result.timedOut || timedOut,
              ...((result.sandbox ?? prepared?.sandbox)
                ? { sandbox: result.sandbox ?? prepared?.sandbox }
                : {}),
              rpcRequests,
              rpcErrors,
            });
          });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(prepared!.command, [...prepared!.args], {
          cwd: prepared!.cwd,
          env: prepared!.env,
          stdio: ["pipe", "pipe", "pipe"],
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

      child.stdin?.on("error", () => undefined);
      child.stdout?.on("data", (chunk: Buffer | string) => {
        appendStdout(
          child,
          typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        );
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        appendStderr(
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

interface ProgressEmitter {
  readonly limits: NormalizedLimits;
  readonly count: number;
  readonly dropped: number;
  readonly droppedSamples: ProcessTelemetryDroppedSample[];
  emit(chunk: ProgressChunk, preview?: string): Promise<void>;
  emitParsed(parsed: ProcessTelemetryParseResult): Promise<void>;
  recordDropped(reason: ProcessTelemetryDroppedReason, preview: string): void;
}

function createProgressEmitter(input: {
  limits: NormalizedLimits;
  context: ProgressContext;
  onProgress: (
    chunk: ProgressChunk,
    context: ProgressContext,
  ) => void | Promise<void>;
}): ProgressEmitter {
  let count = 0;
  let dropped = 0;
  const droppedSamples: ProcessTelemetryDroppedSample[] = [];
  const recordDropped = (
    reason: ProcessTelemetryDroppedReason,
    preview: string,
  ): void => {
    dropped += 1;
    if (droppedSamples.length >= DROPPED_SAMPLE_LIMIT) return;
    droppedSamples.push({
      reason,
      preview: truncateUtf8(preview, DROPPED_SAMPLE_PREVIEW_BYTES),
    });
  };
  return {
    limits: input.limits,
    get count() {
      return count;
    },
    get dropped() {
      return dropped;
    },
    get droppedSamples() {
      return droppedSamples;
    },
    async emit(chunk, preview) {
      if (count >= input.limits.maxProgressEvents) {
        recordDropped("limit_exceeded", preview ?? safeJsonStringify(chunk));
        return;
      }
      count += 1;
      try {
        await input.onProgress(chunk, input.context);
      } catch {
        dropped += 1;
      }
    },
    async emitParsed(parsed) {
      for (const sample of parsed.droppedSamples) {
        recordDropped(sample.reason, sample.preview);
      }
      for (const chunk of parsed.progressChunks) {
        await this.emit(chunk, safeJsonStringify(chunk));
      }
    },
    recordDropped,
  };
}

async function appendParsedStderr(
  parsed: ProcessTelemetryParseResult,
  appendOutput: (
    channel: ProcessOutputChunk["channel"],
    data: string,
  ) => Promise<void>,
  progress: ProgressEmitter,
): Promise<void> {
  if (parsed.forwardableText) {
    await appendOutput("stderr", parsed.forwardableText);
  }
  await progress.emitParsed(parsed);
}

export class ProcessTelemetryParser {
  private pending = "";
  private readonly tokenPrefix: string;

  constructor(private readonly options: ProcessTelemetryParserOptions) {
    this.tokenPrefix = `${options.token ?? PROCESS_EVENT_TOKEN}:`;
  }

  push(chunk: string): ProcessTelemetryParseResult {
    if (!chunk) return emptyTelemetryResult();
    this.pending += chunk;
    return this.drainCompleteLines();
  }

  flush(): ProcessTelemetryParseResult {
    if (!this.pending) return emptyTelemetryResult();
    const pending = this.pending;
    this.pending = "";
    return this.processLine(pending);
  }

  private drainCompleteLines(): ProcessTelemetryParseResult {
    let forwardableText = "";
    const progressChunks: ProgressChunk[] = [];
    const droppedSamples: ProcessTelemetryDroppedSample[] = [];
    for (;;) {
      const newlineIndex = this.pending.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = this.pending.slice(0, newlineIndex + 1);
      this.pending = this.pending.slice(newlineIndex + 1);
      const parsed = this.processLine(line);
      forwardableText += parsed.forwardableText;
      progressChunks.push(...parsed.progressChunks);
      droppedSamples.push(...parsed.droppedSamples);
    }
    return { forwardableText, progressChunks, droppedSamples };
  }

  private processLine(line: string): ProcessTelemetryParseResult {
    const body = line.endsWith("\n")
      ? line.slice(0, line.endsWith("\r\n") ? -2 : -1)
      : line;
    if (!body.startsWith(this.tokenPrefix)) {
      return {
        forwardableText: line,
        progressChunks: [],
        droppedSamples: [],
      };
    }
    const preview = truncateUtf8(body, DROPPED_SAMPLE_PREVIEW_BYTES);
    if (
      Buffer.byteLength(body, "utf8") > this.options.limits.maxProgressLineBytes
    ) {
      return droppedTelemetryResult("line_too_large", preview);
    }
    const jsonText = body.slice(this.tokenPrefix.length).trimStart();
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText) as unknown;
    } catch {
      return droppedTelemetryResult("invalid_json", preview);
    }
    const normalized = normalizeTelemetryRecord(
      raw,
      this.options.limits,
      preview,
    );
    if ("sample" in normalized) {
      return {
        forwardableText: "",
        progressChunks: [],
        droppedSamples: [normalized.sample],
      };
    }
    return {
      forwardableText: "",
      progressChunks: [normalized.chunk],
      droppedSamples: [],
    };
  }
}

function normalizeTelemetryRecord(
  raw: unknown,
  limits: ProcessTelemetryParserOptions["limits"],
  preview: string,
): { chunk: ProgressChunk } | { sample: ProcessTelemetryDroppedSample } {
  if (!isRecord(raw) || raw.type !== "progress") {
    return { sample: { reason: "unsupported_type", preview } };
  }
  const chunk: ProgressChunk = {
    channel: "event",
    message:
      typeof raw.message === "string" && raw.message ? raw.message : "progress",
  };
  if (isRecord(raw.data)) {
    const data = sanitizeProgressData(raw.data);
    if (
      Buffer.byteLength(JSON.stringify(data), "utf8") >
      limits.maxProgressDataBytes
    ) {
      return { sample: { reason: "data_too_large", preview } };
    }
    chunk.data = data;
  }
  return { chunk };
}

function cloneProgressChunk(chunk: ProgressChunk): ProgressChunk {
  return {
    ...(chunk.message ? { message: chunk.message } : {}),
    ...(chunk.channel ? { channel: chunk.channel } : {}),
    ...(chunk.data ? { data: { ...chunk.data } } : {}),
  };
}

function normalizeJsonRpcRequest(raw: unknown): JsonRpcRequest | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.jsonrpc !== "2.0" || typeof raw.method !== "string") {
    return undefined;
  }
  if (
    raw.id !== undefined &&
    raw.id !== null &&
    typeof raw.id !== "string" &&
    typeof raw.id !== "number"
  ) {
    return undefined;
  }
  return {
    jsonrpc: "2.0",
    ...(raw.id !== undefined ? { id: raw.id } : {}),
    method: raw.method,
    ...(raw.params !== undefined ? { params: raw.params } : {}),
  };
}

function emptyTelemetryResult(): ProcessTelemetryParseResult {
  return { forwardableText: "", progressChunks: [], droppedSamples: [] };
}

function droppedTelemetryResult(
  reason: ProcessTelemetryDroppedReason,
  preview: string,
): ProcessTelemetryParseResult {
  return {
    forwardableText: "",
    progressChunks: [],
    droppedSamples: [{ reason, preview }],
  };
}

async function collectStreamingResult(
  streaming: ShellStreamingResult,
  stdout: OutputCollector,
  stderr: OutputCollector,
  progress: ProgressEmitter,
): Promise<RawProcessResult> {
  const telemetry = new ProcessTelemetryParser({ limits: progress.limits });
  let sawStdout = false;
  let sawStderr = false;
  const stdoutDrain = (async () => {
    for await (const chunk of streaming.handle.stdout()) {
      sawStdout = true;
      stdout.append(chunk);
    }
  })();
  const stderrDrain = (async () => {
    for await (const chunk of streaming.handle.stderr()) {
      sawStderr = true;
      const parsed = telemetry.push(chunk);
      stderr.append(parsed.forwardableText);
      await progress.emitParsed(parsed);
    }
  })();
  const final = await streaming.completed;
  await Promise.allSettled([stdoutDrain, stderrDrain]);
  const flushed = telemetry.flush();
  stderr.append(flushed.forwardableText);
  await progress.emitParsed(flushed);
  if (!sawStdout && final.stdout) stdout.append(final.stdout);
  if (!sawStderr && final.stderr) {
    const parsed = telemetry.push(final.stderr);
    stderr.append(parsed.forwardableText);
    await progress.emitParsed(parsed);
    const finalFlush = telemetry.flush();
    stderr.append(finalFlush.forwardableText);
    await progress.emitParsed(finalFlush);
  }
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
            message: stderr.text || "Process failed.",
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

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
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

function rawFromShellResult(
  final: ShellExecutionResult,
  sanitizedStderr = final.stderr,
): RawProcessResult {
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
            message: sanitizedStderr || "Process failed.",
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
