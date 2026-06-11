// AI maintenance note: This factory wires the safety classifier to a core
// ExecutionEnvironment. The tool advertises `risky` + `requiresApproval` so
// SparkWright's policy/approval flow gates execution before this code runs.
// At execute time we still re-evaluate the command so a deny verdict halts
// even if approval was granted on a different (stale) policy snapshot.

import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  createArtifactId,
  defineTool,
  type ExecutionEnvironment,
  type LiveShellHandle,
  type RuntimeContext,
  type ShellExecutionRequest,
  type ShellExecutionResult,
  type ToolDefinition,
} from "@sparkwright/core";

import { parseCommand } from "./command-parser.js";
import {
  evaluateShellSafety,
  type ShellSafetyDecision,
  type ShellSafetyOptions,
  type ShellSafetyResult,
} from "./safety.js";

/**
 * Recommended ceiling for foreground shell execution before promotion to a
 * background task. Reflects the 10-minute convention common in agent-CLI
 * tooling. SparkWright deliberately ships **no default** — hosts must opt in via
 * {@link ShellToolOptions.foregroundTimeoutMs} — but this constant gives every
 * caller a documented anchor so they do not have to invent a number.
 *
 * @public
 * @stability experimental v0.1
 */
export const RECOMMENDED_FOREGROUND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Payload passed to {@link ShellToolOptions.onPromote} when a foreground
 * shell exceeds {@link ShellToolOptions.foregroundTimeoutMs}. Hosts typically
 * adopt the live process by registering it with a TaskManager and returning
 * the resulting task id, letting the agent monitor completion out of band.
 *
 * The process is NOT killed before this callback runs. Returning a `taskId`
 * means the host has taken ownership; returning nothing (or throwing) tells
 * the shell tool to fall back to abort + `timedOut: true`.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ShellPromotionRequest {
  handle: LiveShellHandle;
  /** Resolves with the process result once the adopted shell exits. */
  completed: Promise<ShellExecutionResult>;
  request: ShellExecutionRequest;
  /** Buffered stdout captured so far. */
  partialStdout: string;
  /** Buffered stderr captured so far. */
  partialStderr: string;
  /** ISO-8601 timestamp of the original spawn. */
  startedAt: string;
  /** Effective foreground deadline that just fired, in milliseconds. */
  foregroundTimeoutMs: number;
}

/**
 * Outcome of {@link ShellToolOptions.onPromote}. `taskId` is opaque to the
 * shell tool — the host is responsible for routing follow-up monitoring
 * (e.g. wiring it to a TaskManager so the agent can call `task_output`).
 *
 * @public
 * @stability experimental v0.1
 */
export interface ShellPromotionResult {
  taskId: string;
}

/**
 * Callback signature for foreground→background promotion.
 *
 * @public
 * @stability experimental v0.1
 */
export type ShellPromotionHandler = (
  request: ShellPromotionRequest,
) => ShellPromotionResult | Promise<ShellPromotionResult>;

/**
 * Options accepted by {@link createShellTool}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ShellToolOptions {
  /**
   * Streaming execution environment. The shell tool ALWAYS runs commands via
   * `environment.executeShellStreaming` so the live process can be handed off
   * on timeout. Hosts that only implement the batch `executeShell` cannot use
   * this tool — they should call `environment.executeShell` directly.
   */
  environment: ExecutionEnvironment;
  /**
   * Wall-clock ceiling for foreground execution. When the deadline fires the
   * live process is handed to {@link ShellToolOptions.onPromote} (NOT killed)
   * and the tool returns `{ promoted: true, taskId, ... }`.
   *
   * **No default ship value.** Set this explicitly on every host — see
   * {@link RECOMMENDED_FOREGROUND_TIMEOUT_MS} for the recommended anchor.
   */
  foregroundTimeoutMs: number;
  /**
   * Promotion callback invoked when {@link ShellToolOptions.foregroundTimeoutMs}
   * fires. The host adopts the live process (typically by registering it with
   * `@sparkwright/agent-runtime`'s `TaskManager`) and returns a `taskId`.
   */
  onPromote: ShellPromotionHandler;
  /**
   * Override or extend the built-in safety classification rules.
   */
  safety?: ShellSafetyOptions;
  /**
   * Restrict shell cwd and absolute path arguments to this workspace root.
   * Requests without cwd run in this root when the execution environment honors
   * the request cwd. Add trusted extra roots with `allowedRoots`.
   */
  workspaceRoot?: string;
  /** Additional trusted filesystem roots for cwd and absolute path arguments. */
  allowedRoots?: readonly string[];
  /**
   * Default per-call timeout in milliseconds. Callers may override via input.
   */
  defaultTimeoutMs?: number;
  /**
   * Override the registered tool name (defaults to `"shell"`).
   */
  name?: string;
  /**
   * Override the registered description.
   */
  description?: string;
}

/**
 * Input accepted by the shell tool.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ShellToolInput {
  command: string;
  timeoutMs?: number;
  cwd?: string;
}

/**
 * Output returned by the shell tool.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ShellToolOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  decision: ShellSafetyDecision;
  reason: string;
  /** @reserved Public shell-output field consumed by artifact-aware UIs. */
  stdoutArtifactId?: string;
  /** @reserved Public shell-output field consumed by artifact-aware UIs. */
  stderrArtifactId?: string;
  /** @reserved Public shell-output field consumed by artifact-aware UIs. */
  outputTruncated?: boolean;
  /**
   * True when the foreground deadline fired and the live process was handed
   * to {@link ShellToolOptions.onPromote} instead of being killed. When set,
   * `taskId` carries the host-assigned identifier and `stdout` / `stderr`
   * hold only the partial output captured up to the promotion point.
   */
  promoted?: boolean;
  /** Host-assigned task id returned by the promotion callback. */
  taskId?: string;
  /** @reserved Public shell sandbox status consumed by trace and diagnostics UIs. */
  sandbox?: ShellToolSandboxOutput;
}

export interface ShellToolSandboxOutput {
  sandboxed: boolean;
  mode?: string;
  runtime?: string;
  networkMode?: string;
  unavailable?: string;
  available?: boolean;
  fallbackReason?: string;
  enforced?: boolean;
}

const DEFAULT_NAME = "shell";
const DEFAULT_DESCRIPTION =
  "Execute a shell command after safety classification and policy approval.";

/**
 * Create the opt-in shell tool. The returned definition advertises `risky`
 * with `requiresApproval`, so the core's policy layer gates the call before
 * execution. At execute time the safety classifier is re-applied; deny
 * verdicts surface as failures regardless of approval state.
 *
 * @public
 * @stability experimental v0.1
 */
export function createShellTool(
  options: ShellToolOptions,
): ToolDefinition<ShellToolInput, ShellToolOutput> {
  validateShellToolOptions(options);
  return defineTool<ShellToolInput, ShellToolOutput>({
    name: options.name ?? DEFAULT_NAME,
    description: options.description ?? DEFAULT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer" },
        cwd: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        stdout: { type: "string" },
        stderr: { type: "string" },
        exitCode: { type: ["integer", "null"] },
        timedOut: { type: "boolean" },
        decision: { type: "string" },
        reason: { type: "string" },
        stdoutArtifactId: { type: "string" },
        stderrArtifactId: { type: "string" },
        outputTruncated: { type: "boolean" },
        promoted: { type: "boolean" },
        taskId: { type: "string" },
        sandbox: {
          type: "object",
          properties: {
            sandboxed: { type: "boolean" },
            mode: { type: "string" },
            runtime: { type: "string" },
            networkMode: { type: "string" },
            unavailable: { type: "string" },
            available: { type: "boolean" },
            fallbackReason: { type: "string" },
            enforced: { type: "boolean" },
          },
          required: ["sandboxed"],
          additionalProperties: false,
        },
      },
      required: [
        "stdout",
        "stderr",
        "exitCode",
        "timedOut",
        "decision",
        "reason",
      ],
      additionalProperties: false,
    },
    timeoutMs: options.defaultTimeoutMs,
    policy: { risk: "risky", requiresApproval: true },
    governance: {
      sideEffects: ["write", "external"],
      idempotency: "non_idempotent",
      dataSensitivity: "confidential",
      origin: { kind: "local", name: "@sparkwright/shell-tool" },
    },
    resultSize: { maxChars: SHELL_INLINE_CHARS },
    resultPresentation: {
      kind: "shell_output",
      preserveFields: [
        "exitCode",
        "timedOut",
        "stderr",
        "stdoutArtifactId",
        "stderrArtifactId",
        "outputTruncated",
      ],
      artifactPolicy: "when_large",
    },
    isConcurrencySafe: () => false,
    async execute(args, ctx) {
      const input = normalizeShellInput(args);
      await assertShellPathScope(input, options);
      const verdict: ShellSafetyResult = evaluateShellSafety(
        input.command,
        options.safety,
      );

      if (verdict.decision === "deny") {
        throw new ShellSafetyError(verdict);
      }

      const parsed = parseCommand(input.command);
      const request: ShellExecutionRequest = {
        command: parsed.leadingProgram || input.command,
        args: parsed.argv.slice(1),
        cwd: input.cwd ?? options.workspaceRoot,
        timeoutMs: input.timeoutMs ?? options.defaultTimeoutMs,
        metadata: {
          rawCommand: input.command,
          safetyDecision: verdict.decision,
          safetyReason: verdict.reason,
        },
      };

      const output = await runWithPromotion({
        environment: options.environment,
        request,
        verdict,
        foregroundTimeoutMs: options.foregroundTimeoutMs,
        onPromote: options.onPromote,
      });
      return materializeLargeShellOutput(output, {
        command: input.command,
        ctx,
      });
    },
  });
}

const SHELL_INLINE_CHARS = 4_000;

function materializeLargeShellOutput(
  output: ShellToolOutput,
  input: { command: string; ctx: RuntimeContext },
): ShellToolOutput {
  let next = output;
  if (output.stdout.length > SHELL_INLINE_CHARS) {
    const artifactId = createArtifactId();
    input.ctx.reportToolArtifact?.({
      id: artifactId,
      runId: input.ctx.run.id,
      type: "log",
      name: "shell stdout",
      content: output.stdout,
      metadata: {
        command: input.command,
        stream: "stdout",
        length: output.stdout.length,
      },
    });
    next = {
      ...next,
      stdout: summarizeStream(output.stdout, {
        limit: SHELL_INLINE_CHARS,
        preferTail: output.exitCode !== 0 || output.timedOut,
      }),
      stdoutArtifactId: artifactId,
      outputTruncated: true,
    };
  }
  if (output.stderr.length > SHELL_INLINE_CHARS) {
    const artifactId = createArtifactId();
    input.ctx.reportToolArtifact?.({
      id: artifactId,
      runId: input.ctx.run.id,
      type: "log",
      name: "shell stderr",
      content: output.stderr,
      metadata: {
        command: input.command,
        stream: "stderr",
        length: output.stderr.length,
      },
    });
    next = {
      ...next,
      stderr: summarizeStream(output.stderr, {
        limit: SHELL_INLINE_CHARS,
        preferTail: true,
      }),
      stderrArtifactId: artifactId,
      outputTruncated: true,
    };
  }
  return next;
}

function summarizeStream(
  value: string,
  options: { limit: number; preferTail: boolean },
): string {
  if (value.length <= options.limit) return value;
  const marker = `\n...[truncated ${value.length - options.limit} chars; full output saved as artifact]...\n`;
  const available = Math.max(1, options.limit - marker.length);
  if (options.preferTail) {
    return marker + value.slice(-available);
  }
  return value.slice(0, available) + marker;
}

function validateShellToolOptions(options: ShellToolOptions): void {
  if (!options.environment) {
    throw new Error(
      "@sparkwright/shell-tool: `environment` is required. Provide an ExecutionEnvironment that implements executeShellStreaming.",
    );
  }
  if (typeof options.environment.executeShellStreaming !== "function") {
    throw new Error(
      "@sparkwright/shell-tool: `environment.executeShellStreaming` is required. The shell tool no longer supports the legacy batch executeShell path; implement streaming or use environment.executeShell directly.",
    );
  }
  if (
    typeof options.foregroundTimeoutMs !== "number" ||
    !Number.isFinite(options.foregroundTimeoutMs) ||
    options.foregroundTimeoutMs <= 0
  ) {
    throw new Error(
      "@sparkwright/shell-tool: `foregroundTimeoutMs` is required and must be a positive number. Use RECOMMENDED_FOREGROUND_TIMEOUT_MS (10 min) as a starting point.",
    );
  }
  if (typeof options.onPromote !== "function") {
    throw new Error(
      "@sparkwright/shell-tool: `onPromote` is required. Wire it to your TaskManager so timed-out shells can continue as background tasks.",
    );
  }
}

interface PromotionRunContext {
  environment: ExecutionEnvironment;
  request: ShellExecutionRequest;
  verdict: ShellSafetyResult;
  foregroundTimeoutMs: number;
  onPromote: ShellPromotionHandler;
}

async function runWithPromotion(
  ctx: PromotionRunContext,
): Promise<ShellToolOutput> {
  const startedAt = new Date().toISOString();
  const streaming = await ctx.environment.executeShellStreaming!(ctx.request);
  const { handle, completed } = streaming;

  // Drive the iterators explicitly so we can release ownership on promotion.
  // An async iterable normally has at most one consumer; if we kept iterating
  // after handing the handle to the host, both sides would race the same
  // underlying stream.
  const stdoutIter = handle.stdout()[Symbol.asyncIterator]();
  const stderrIter = handle.stderr()[Symbol.asyncIterator]();
  let stdout = "";
  let stderr = "";
  const collectFrom = async (
    iter: AsyncIterator<string>,
    append: (chunk: string) => void,
  ) => {
    for (;;) {
      const { value, done } = await iter.next();
      if (done) return;
      append(value);
    }
  };
  const collectStdout = collectFrom(stdoutIter, (c) => {
    stdout += c;
  });
  const collectStderr = collectFrom(stderrIter, (c) => {
    stderr += c;
  });
  // Errors from stream iteration are surfaced through `completed`; we swallow
  // here so an aborted reader does not become an unhandled rejection.
  collectStdout.catch(() => {});
  collectStderr.catch(() => {});

  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timerId = setTimeout(() => resolve("timeout"), ctx.foregroundTimeoutMs);
  });

  const race = await Promise.race([
    completed.then(
      (r): { kind: "completed"; result: ShellExecutionResult } => ({
        kind: "completed",
        result: r,
      }),
    ),
    timeoutPromise.then((): { kind: "timeout" } => ({ kind: "timeout" })),
  ]);

  if (race.kind === "completed") {
    if (timerId) clearTimeout(timerId);
    await Promise.allSettled([collectStdout, collectStderr]);
    const timedOut =
      typeof race.result.metadata?.timedOut === "boolean"
        ? (race.result.metadata.timedOut as boolean)
        : false;
    return {
      stdout: race.result.stdout || stdout,
      stderr: race.result.stderr || stderr,
      exitCode: race.result.exitCode,
      timedOut,
      decision: ctx.verdict.decision,
      reason: ctx.verdict.reason,
      sandbox: shellSandboxOutput(race.result.metadata),
    };
  }

  // Timeout fired first: hand the live process to the promotion callback.
  try {
    const promotion = await ctx.onPromote({
      handle,
      completed,
      request: ctx.request,
      partialStdout: stdout,
      partialStderr: stderr,
      startedAt,
      foregroundTimeoutMs: ctx.foregroundTimeoutMs,
    });
    // Release our iterators so the host becomes the sole consumer of the
    // handle. Without this, two consumers race the same stream and bytes
    // are lost to whichever side wins each chunk.
    await Promise.allSettled([
      stdoutIter.return?.(undefined as never) ?? Promise.resolve(),
      stderrIter.return?.(undefined as never) ?? Promise.resolve(),
    ]);
    // Detach from completion — the host now owns lifecycle.
    completed.catch(() => {});
    return {
      stdout,
      stderr,
      exitCode: null,
      timedOut: false,
      decision: ctx.verdict.decision,
      reason: ctx.verdict.reason,
      promoted: true,
      taskId: promotion.taskId,
      sandbox: shellSandboxOutput(handle.metadata),
    };
  } catch {
    // Promotion failed: fall back to abort + timedOut for safety.
    handle.abort("shell-tool: promotion handler failed");
    const final = await completed;
    await Promise.allSettled([collectStdout, collectStderr]);
    return {
      stdout: final.stdout || stdout,
      stderr: final.stderr || stderr,
      exitCode: final.exitCode,
      timedOut: true,
      decision: ctx.verdict.decision,
      reason: ctx.verdict.reason,
      sandbox: shellSandboxOutput(final.metadata),
    };
  }
}

function shellSandboxOutput(
  metadata: Record<string, unknown> | undefined,
): ShellToolSandboxOutput | undefined {
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
    ...(typeof metadata.sandboxUnavailable === "string"
      ? { unavailable: metadata.sandboxUnavailable }
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

/**
 * Error raised when the safety classifier denies a command at execute time.
 * Carries the original decision so embedders can surface a structured failure.
 *
 * @public
 * @stability experimental v0.1
 */
export class ShellSafetyError extends Error {
  readonly decision: ShellSafetyDecision;
  readonly reason: string;
  readonly code = "shell_safety_denied";

  constructor(verdict: ShellSafetyResult) {
    super(`Shell command denied: ${verdict.reason}`);
    this.name = "ShellSafetyError";
    this.decision = verdict.decision;
    this.reason = verdict.reason;
  }
}

function normalizeShellInput(
  args: ShellToolInput,
): Required<Pick<ShellToolInput, "command">> &
  Pick<ShellToolInput, "cwd" | "timeoutMs"> {
  assertRecord(args, "shell input");
  const command = readString(args, "command");
  const cwd =
    typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
  const timeoutMs = readOptionalPositiveInteger(args, "timeoutMs");
  return { command, cwd, timeoutMs };
}

async function assertShellPathScope(
  input: Required<Pick<ShellToolInput, "command">> &
    Pick<ShellToolInput, "cwd" | "timeoutMs">,
  options: ShellToolOptions,
): Promise<void> {
  if (!options.workspaceRoot) return;

  const roots = await Promise.all(
    [options.workspaceRoot, ...(options.allowedRoots ?? [])].map((root) =>
      resolveRealPath(root),
    ),
  );
  const cwd = await resolveRealPath(input.cwd ?? options.workspaceRoot);
  if (!isInsideAnyRoot(roots, cwd)) {
    throw new ShellSafetyError({
      decision: "deny",
      reason: `Shell cwd escapes allowed roots: ${input.cwd ?? options.workspaceRoot}`,
    });
  }

  const parsed = parseCommand(input.command);
  for (const arg of parsed.argv.slice(1)) {
    const escaped = await firstEscapedAbsolutePath(roots, arg);
    if (escaped) {
      throw new ShellSafetyError({
        decision: "deny",
        reason: `Shell argument path escapes allowed roots: ${escaped.original}`,
      });
    }
  }
}

async function resolveRealPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

function isInsideAnyRoot(roots: readonly string[], target: string): boolean {
  return roots.some((root) => {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

async function firstEscapedAbsolutePath(
  roots: readonly string[],
  text: string,
): Promise<{ original: string; resolved: string } | undefined> {
  for (const path of absolutePathCandidates(text)) {
    const resolved = await resolveRealPath(path);
    if (!isInsideAnyRoot(roots, resolved)) {
      return { original: path, resolved };
    }
  }
  return undefined;
}

function absolutePathCandidates(text: string): string[] {
  // Match a leading-slash path only at a token boundary. The negative
  // lookbehind rejects a '/' that sits *inside* a relative path (the char
  // before it is a pathname char: word char, '.', '~', '-', or another '/'),
  // so `notes/demo.md` no longer yields a spurious `/demo.md` absolute-escape
  // candidate (the false positive that denied file creation in the C2 trace).
  // Real absolute paths (`/etc/passwd`, `--out=/etc/x`) still match because the
  // '/' is at the start or follows a non-pathname delimiter like '='.
  return text.match(/(?<![\w.~/-])\/[^\s"'`$<>|;&)]+/g) ?? [];
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function readOptionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value;
}
