// AI maintenance note: ExecutionEnvironment is the *deny-by-default* boundary
// for shell-shaped tools. Add capabilities by composing safer environments,
// not by relaxing checks here. The default LocalProcessEnvironment is
// intentionally minimal — extend it externally.

import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "./tools.js";

export type ShellExecutionStatus = "completed" | "failed" | "denied";

export type ShellSafetyDecisionKind = "allow" | "deny" | "requires_approval";

export interface ShellExecutionRequest {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ShellSafetyContext {
  action: "shell.execute";
  resource: {
    kind: "shell";
    name: string;
    metadata: Record<string, unknown>;
  };
  metadata: Record<string, unknown>;
}

export interface ShellSafetyDecision {
  decision: ShellSafetyDecisionKind;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface ShellExecutionResult {
  status: ShellExecutionStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /**
   * @reserved Public protocol timestamp consumed by embedders and traces.
   */
  startedAt: string;
  /**
   * @reserved Public protocol timestamp consumed by embedders and traces.
   */
  completedAt: string;
  metadata: Record<string, unknown>;
}

/**
 * Live handle to an in-flight shell process. Returned by
 * {@link ExecutionEnvironment.executeShellStreaming} so callers can observe
 * stdout/stderr as it streams, request cancellation, or hand the live process
 * off to a long-running task runner without killing it.
 *
 * The handle is intentionally framework-agnostic: no PID, no platform types.
 * Hosts that need richer process control can extend the `metadata` field.
 *
 * @public
 * @stability experimental v0.1
 */
export interface LiveShellHandle {
  /**
   * Async iterable of stdout chunks. Yields until the process exits.
   * Implementations MUST be safe to iterate exactly once.
   */
  stdout(): AsyncIterable<string>;
  /**
   * Async iterable of stderr chunks. Same single-iteration contract as
   * {@link LiveShellHandle.stdout}.
   */
  stderr(): AsyncIterable<string>;
  /**
   * Request cancellation. Idempotent. Implementations SHOULD send SIGTERM
   * first and escalate to SIGKILL on a grace period of their choosing.
   */
  abort(reason?: string): void;
  /** Implementation-specific metadata (e.g. PID, container id). */
  readonly metadata: Record<string, unknown>;
}

/**
 * Streaming counterpart to {@link ShellExecutionResult}. `handle` is live
 * during execution; `completed` resolves with the final aggregate result once
 * the process exits (or is aborted).
 *
 * @public
 * @stability experimental v0.1
 */
export interface ShellStreamingResult {
  handle: LiveShellHandle;
  /**
   * Resolves with the terminal {@link ShellExecutionResult}. Never rejects —
   * abort and timeout surface as `status` + `metadata.timedOut` / `metadata.aborted`.
   */
  completed: Promise<ShellExecutionResult>;
}

export interface ExecutionEnvironment {
  readonly id: string;
  readonly kind: string;
  readonly capabilities: readonly string[];
  describe(): Record<string, unknown>;
  executeShell(request: ShellExecutionRequest): Promise<ShellExecutionResult>;
  /**
   * Optional streaming entry point. Required for shell-tool's
   * foreground→background promotion path. Hosts that only expose the
   * batch {@link ExecutionEnvironment.executeShell} method MAY omit this;
   * promotion features will then silently degrade to the legacy behavior.
   *
   * @reserved Public field consumed by long-running shell adapters.
   */
  executeShellStreaming?(
    request: ShellExecutionRequest,
  ): Promise<ShellStreamingResult>;
}

export interface LocalProcessEnvironmentOptions {
  id?: string;
  policy?: (
    request: ShellExecutionRequest,
    context: ShellSafetyContext,
  ) => ShellSafetyDecision | Promise<ShellSafetyDecision>;
  executor?: (
    request: ShellExecutionRequest,
    context: ShellSafetyContext,
  ) => ShellExecutionResult | Promise<ShellExecutionResult>;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceShellPolicyOptions {
  /** Primary workspace root. Requests without an explicit cwd run here. */
  workspaceRoot: string;
  /** Additional roots that shell cwd and absolute path arguments may touch. */
  allowedRoots?: readonly string[];
  /** Commands denied before executor dispatch. Compared after basename(). */
  denyCommands?: readonly string[];
  /** Commands that need an outer approval gate. LocalProcessEnvironment denies them. */
  requireApprovalCommands?: readonly string[];
  /** Commands allowed by this environment policy. Empty means read-only defaults. */
  allowCommands?: readonly string[];
  /** When false, commands outside allowCommands require approval. Defaults false. */
  allowUnknownCommands?: boolean;
}

export interface ShellToolOptions {
  name?: string;
  description?: string;
  timeoutMs?: number;
  requiresApproval?: boolean;
}

export class LocalProcessEnvironment implements ExecutionEnvironment {
  readonly id: string;
  readonly kind = "local-process";
  readonly capabilities = ["shell.execute"];

  private readonly policy: NonNullable<
    LocalProcessEnvironmentOptions["policy"]
  >;
  private readonly executor?: LocalProcessEnvironmentOptions["executor"];
  private readonly metadata: Record<string, unknown>;

  constructor(options: LocalProcessEnvironmentOptions = {}) {
    this.id = options.id ?? "local-process";
    this.policy = options.policy ?? denyShellByDefault;
    this.executor = options.executor;
    this.metadata = { ...options.metadata };
  }

  describe(): Record<string, unknown> {
    return {
      id: this.id,
      kind: this.kind,
      capabilities: [...this.capabilities],
      safety: {
        defaultDecision: "deny",
        policyAction: "shell.execute",
        approvalReady: true,
      },
      metadata: { ...this.metadata },
    };
  }

  async executeShell(
    request: ShellExecutionRequest,
  ): Promise<ShellExecutionResult> {
    validateShellRequest(request);

    const context = createShellSafetyContext(this, request);
    const decision = await this.policy(request, context);

    if (decision.decision !== "allow") {
      return createShellResult("denied", {
        stderr: decision.reason,
        metadata: {
          environmentId: this.id,
          safetyDecision: decision.decision,
          safetyReason: decision.reason,
          policy: decision.metadata ?? {},
          request: context.metadata,
        },
      });
    }

    if (!this.executor) {
      return createShellResult("failed", {
        stderr:
          "Shell execution is allowed by policy, but no process executor is configured.",
        metadata: {
          environmentId: this.id,
          safetyDecision: decision.decision,
          safetyReason: decision.reason,
          policy: decision.metadata ?? {},
          request: context.metadata,
        },
      });
    }

    return this.executor(request, context);
  }
}

export function createWorkspaceShellPolicy(
  options: WorkspaceShellPolicyOptions,
): LocalProcessEnvironmentOptions["policy"] {
  return async (request) => {
    const allowedRoots = await Promise.all(
      [options.workspaceRoot, ...(options.allowedRoots ?? [])].map((root) =>
        resolveRealPath(root),
      ),
    );
    const effectiveCwd = await resolveRealPath(
      request.cwd ?? options.workspaceRoot,
    );

    if (!isInsideAnyRoot(allowedRoots, effectiveCwd)) {
      return {
        decision: "deny",
        reason: `Shell cwd escapes allowed roots: ${request.cwd ?? options.workspaceRoot}`,
        metadata: { allowedRoots, cwd: effectiveCwd },
      };
    }

    for (const arg of request.args ?? []) {
      const escaped = await firstEscapedAbsolutePath(allowedRoots, arg);
      if (escaped) {
        return {
          decision: "deny",
          reason: `Shell argument path escapes allowed roots: ${escaped.original}`,
          metadata: { allowedRoots, path: escaped.resolved },
        };
      }
    }

    if (containsShellWriteSyntax(request.command)) {
      return {
        decision: "requires_approval",
        reason:
          "Shell command contains control or redirection syntax and requires approval.",
        metadata: { command: request.command },
      };
    }

    const command = normalizeCommandName(request.command);
    const deny = options.denyCommands ?? DEFAULT_DENY_COMMANDS;
    if (matchesCommand(command, deny)) {
      return {
        decision: "deny",
        reason: `Shell command "${command}" is denied by workspace shell policy.`,
        metadata: { command },
      };
    }

    const requireApproval =
      options.requireApprovalCommands ?? DEFAULT_REQUIRE_APPROVAL_COMMANDS;
    if (matchesCommand(command, requireApproval)) {
      return {
        decision: "requires_approval",
        reason: `Shell command "${command}" requires approval by workspace shell policy.`,
        metadata: { command },
      };
    }

    const allow = options.allowCommands ?? DEFAULT_ALLOW_COMMANDS;
    if (matchesCommand(command, allow)) {
      return {
        decision: "allow",
        reason: `Shell command "${command}" allowed by workspace shell policy.`,
        metadata: { command, cwd: effectiveCwd },
      };
    }

    if (options.allowUnknownCommands === true) {
      return {
        decision: "allow",
        reason: `Shell command "${command}" allowed by allowUnknownCommands.`,
        metadata: { command, cwd: effectiveCwd },
      };
    }

    return {
      decision: "requires_approval",
      reason: `Shell command "${command}" is not on the allow list.`,
      metadata: { command, cwd: effectiveCwd },
    };
  };
}

export function createShellExecutionTool(
  environment: ExecutionEnvironment,
  options: ShellToolOptions = {},
): ToolDefinition<ShellExecutionRequest, ShellExecutionResult> {
  return defineTool<ShellExecutionRequest, ShellExecutionResult>({
    name: options.name ?? "shell.execute",
    description:
      options.description ??
      "Execute a shell command through a governed execution environment.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        stdin: { type: "string" },
        timeoutMs: { type: "integer" },
        metadata: { type: "object" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { enum: ["completed", "failed", "denied"] },
        exitCode: { type: ["integer", "null"] },
        stdout: { type: "string" },
        stderr: { type: "string" },
        startedAt: { type: "string" },
        completedAt: { type: "string" },
        metadata: { type: "object" },
      },
      required: [
        "status",
        "exitCode",
        "stdout",
        "stderr",
        "startedAt",
        "completedAt",
        "metadata",
      ],
      additionalProperties: false,
    },
    timeoutMs: options.timeoutMs,
    policy: {
      risk: "risky",
      requiresApproval: options.requiresApproval ?? true,
    },
    governance: {
      origin: {
        kind: "local",
        name: environment.id,
        metadata: environment.describe(),
      },
      sideEffects: ["external"],
      dataSensitivity: "confidential",
      idempotency: "non_idempotent",
      audit: { level: "metadata" },
    },
    previewArgs(request) {
      return request && typeof request.command === "string"
        ? `$ ${request.command}`
        : undefined;
    },
    execute(request) {
      return environment.executeShell(request);
    },
  });
}

function denyShellByDefault(): ShellSafetyDecision {
  return {
    decision: "deny",
    reason: "Shell execution is denied by default.",
    metadata: { source: "LocalProcessEnvironment.defaultPolicy" },
  };
}

function validateShellRequest(request: ShellExecutionRequest): void {
  if (!request.command.trim()) {
    throw new Error("Shell execution requires a non-empty command.");
  }

  if (
    request.timeoutMs !== undefined &&
    (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
  ) {
    throw new Error("Shell execution timeoutMs must be a positive number.");
  }
}

const DEFAULT_ALLOW_COMMANDS = [
  "cat",
  "find",
  "git",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "sed",
  "tail",
  "wc",
] as const;

const DEFAULT_REQUIRE_APPROVAL_COMMANDS = [
  "bash",
  "cp",
  "mv",
  "node",
  "npm",
  "pnpm",
  "python",
  "python3",
  "sh",
  "tee",
  "yarn",
  "zsh",
] as const;

const DEFAULT_DENY_COMMANDS = [
  "chmod",
  "chown",
  "dd",
  "mkfs",
  "rm",
  "sudo",
  "su",
] as const;

function normalizeCommandName(command: string): string {
  return basename(command.trim().split(/\s+/)[0] ?? "").toLowerCase();
}

function matchesCommand(command: string, commands: readonly string[]): boolean {
  return commands.some((candidate) => candidate.toLowerCase() === command);
}

function containsShellWriteSyntax(command: string): boolean {
  return /(?:^|[^\\])(?:>>?|&&|\|\||;|`|\$\()/.test(command);
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
  // Match a leading-slash path only at a token boundary; the negative
  // lookbehind rejects a '/' embedded in a relative path (preceded by a
  // pathname char) so `notes/demo.md` no longer yields a spurious `/demo.md`
  // absolute-escape candidate. Mirrors shell-tool/src/tool.ts.
  return text.match(/(?<![\w.~/-])\/[^\s"'`$<>|;&)]+/g) ?? [];
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

function createShellSafetyContext(
  environment: LocalProcessEnvironment,
  request: ShellExecutionRequest,
): ShellSafetyContext {
  const requestMetadata = {
    command: request.command,
    args: [...(request.args ?? [])],
    cwd: request.cwd,
    timeoutMs: request.timeoutMs,
    hasStdin: request.stdin !== undefined,
    envKeys: Object.keys(request.env ?? {}).sort(),
    ...request.metadata,
  };

  return {
    action: "shell.execute",
    resource: {
      kind: "shell",
      name: request.command,
      metadata: {
        environmentId: environment.id,
        environmentKind: environment.kind,
      },
    },
    metadata: requestMetadata,
  };
}

function createShellResult(
  status: ShellExecutionStatus,
  input: {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    metadata?: Record<string, unknown>;
  } = {},
): ShellExecutionResult {
  const now = new Date().toISOString();

  return {
    status,
    exitCode: input.exitCode ?? null,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    startedAt: now,
    completedAt: now,
    metadata: input.metadata ?? {},
  };
}
