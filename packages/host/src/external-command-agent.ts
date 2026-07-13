import {
  createId,
  createSpanId,
  defineTool,
  type EventEmitter,
  type ProcessOutputSummary,
  type SandboxSummary,
  type RunHandle,
  type RunId,
  type ToolDefinition,
} from "@sparkwright/core";
import type { AgentProfile } from "@sparkwright/agent-runtime";
import {
  createPlatformShellSandboxRuntime,
  enforceProtectedWriteRootsShellSandbox,
  resolveShellSandboxConfig,
  scopeShellSandboxFilesystem,
  type ResolvedShellSandboxConfig,
  type ShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import {
  DelegateExecutionError,
  assertReadWriteWorkspaceAccessAllowed,
  assertSubagentDepthAllowed,
  assertWorkspaceAccess,
  describeDelegateCapability,
  deriveDelegatePolicyProfile,
  errorCode,
  resolveDelegateProcessWorkspace,
  usesWorkspaceRootTemplate,
  workspaceAccessField,
  type DelegateWorkspaceAccess,
} from "./delegate-capability.js";
import {
  createProcessProgressSampleCollector,
  TracedProcessRunner,
  type ProgressChunk,
} from "./traced-process-runner.js";

export interface ExternalCommandAgentConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  envMode?: "inherit" | "explicit";
  workspaceAccess?: DelegateWorkspaceAccess;
  timeoutMs?: number;
  input?: "argument" | "stdin" | "none";
  maxOutputBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  successExitCodes?: number[];
}

export interface CreateExternalCommandDelegateToolInput {
  getParent: () => RunHandle | undefined;
  profile: AgentProfile;
  toolName: string;
  description: string;
  workspaceRoot: string;
  requiresApproval?: boolean;
  forbidNesting?: boolean;
  maxDepth?: number;
  entrypoint?: "external_command" | "delegates_run";
  allowReadWriteWorkspaceAccess?: boolean;
  sandbox?: ShellSandboxConfig | ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
  skillRoots?: readonly string[];
  configPaths?: readonly string[];
}

export interface ExternalCommandDelegateToolResult {
  childRunId: string;
  spanId: string;
  /** @reserved Public delegate-tool output field consumed by UIs and orchestrators. */
  protocol: "external_command";
  agentId: string;
  /** @reserved Public delegate-tool output field consumed by UIs and orchestrators. */
  agentProfileId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** @reserved Public delegate-tool output field consumed by UIs and orchestrators. */
  stdoutTruncated: boolean;
  /** @reserved Public delegate-tool output field consumed by UIs and orchestrators. */
  stderrTruncated: boolean;
  /** @reserved Backward-compatible aggregate truncation flag. */
  outputTruncated: boolean;
  /** @reserved Public delegate process output summary consumed by trace and diagnostics UIs. */
  output: ProcessOutputSummary;
  /** @reserved Public delegate sandbox status consumed by trace and diagnostics UIs. */
  sandbox?: ExternalCommandSandboxSummary;
  /** @reserved Public delegate progress summary consumed by trace and diagnostics UIs. */
  progressCount: number;
  /** @reserved Public delegate progress summary consumed by trace and diagnostics UIs. */
  progressDropped: number;
  /** @reserved Public delegate progress summary consumed by trace and diagnostics UIs. */
  progressHead: ProgressChunk[];
  /** @reserved Public delegate progress summary consumed by trace and diagnostics UIs. */
  progressTail: ProgressChunk[];
}

export interface ExternalCommandSandboxSummary {
  sandboxed: boolean;
  mode?: string;
  runtime?: string;
  networkMode?: string;
  /** @reserved Public delegate sandbox status consumed by trace and diagnostics UIs. */
  unavailable?: string;
  available?: boolean;
  /** @reserved Public delegate sandbox status consumed by trace and diagnostics UIs. */
  fallbackReason?: string;
  /** @reserved Public delegate sandbox status consumed by trace and diagnostics UIs. */
  enforced?: boolean;
}

export function externalCommandConfigFromAgentProfile(
  profile: AgentProfile,
): ExternalCommandAgentConfig | undefined {
  const config = recordField(profile.metadata, "externalCommand");
  if (!config) return undefined;
  if (typeof config.command !== "string" || config.command.length === 0) {
    return undefined;
  }
  return {
    command: config.command,
    args: stringArrayField(config, "args"),
    cwd: stringField(config, "cwd"),
    env: stringRecordField(config, "env"),
    envMode: envModeField(config, "envMode"),
    workspaceAccess: workspaceAccessField(config),
    timeoutMs: numberField(config, "timeoutMs"),
    input: inputModeField(config, "input"),
    maxOutputBytes: numberField(config, "maxOutputBytes"),
    maxStdoutBytes: numberField(config, "maxStdoutBytes"),
    maxStderrBytes: numberField(config, "maxStderrBytes"),
    successExitCodes: numberArrayField(config, "successExitCodes"),
  };
}

export function createExternalCommandDelegateTool(
  input: CreateExternalCommandDelegateToolInput,
): ToolDefinition {
  const config = externalCommandConfigFromAgentProfile(input.profile);
  if (!config) {
    throw new Error(
      `Agent profile ${input.profile.id} does not contain a valid metadata.externalCommand config.`,
    );
  }
  const workspaceAccess = config.workspaceAccess ?? "none";
  const policyProfile = deriveDelegatePolicyProfile({
    risk: "risky",
    configuredRequiresApproval: input.requiresApproval,
    defaultRequiresApproval: true,
    runWriteEnabled: input.allowReadWriteWorkspaceAccess,
  });
  const descriptor = describeDelegateCapability({
    delegate: {
      profileId: input.profile.id,
      toolName: input.toolName,
      requiresApproval: input.requiresApproval,
      forbidNesting: input.forbidNesting,
    },
    profile: input.profile,
    protocol: "external_command",
    command: config.command,
    args: config.args,
    timeoutMs: config.timeoutMs,
    workspaceAccess,
    allowReadWriteWorkspaceAccess: input.allowReadWriteWorkspaceAccess,
    policyProfile,
    outputLimits: {
      stdoutBytes: config.maxStdoutBytes ?? config.maxOutputBytes,
      stderrBytes: config.maxStderrBytes ?? config.maxOutputBytes,
    },
  });
  return defineTool({
    name: input.toolName,
    description: input.description,
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Sub-task to delegate." },
        metadata: {
          type: "object",
          description: "Optional structured metadata for the external command.",
        },
      },
      required: ["goal"],
      additionalProperties: false,
    },
    policy: policyProfile.policy,
    governance: {
      sideEffects: ["external"],
      idempotency: "non_idempotent",
      origin: {
        kind: "hosted",
        name: input.profile.id,
        metadata: { ...descriptor },
      },
    },
    async execute(args: unknown): Promise<ExternalCommandDelegateToolResult> {
      const parent = input.getParent();
      if (!parent) {
        throw new Error(
          `External command delegate tool "${input.toolName}" was invoked but no parent RunHandle is available.`,
        );
      }
      if (
        (input.forbidNesting ?? true) &&
        typeof parent.record.metadata?.parentRunId === "string"
      ) {
        throw new Error(
          `External command delegate tool "${input.toolName}" refused to nest: parent run is itself a sub-agent.`,
        );
      }
      const subagentDepth = assertSubagentDepthAllowed({
        parent,
        maxDepth: input.maxDepth,
        toolName: input.toolName,
      });

      const parsed = parseDelegateArgs(args);
      const spanId = createSpanId();
      const childRunId = createId(`cmd_${sanitizeSegment(input.profile.id)}`);
      const base = {
        childRunId,
        parentRunId: parent.record.id,
        spanId,
        goal: parsed.goal,
      };
      const parentAgentId =
        typeof parent.record.metadata?.agentId === "string"
          ? parent.record.metadata.agentId
          : "main";
      const parentSessionId =
        typeof parent.record.metadata?.sessionId === "string"
          ? parent.record.metadata.sessionId
          : undefined;
      const meta = {
        ...(parentSessionId ? { sessionId: parentSessionId } : {}),
        agentId: parentAgentId,
        childAgentId: input.profile.id,
        agentProfileId: input.profile.id,
        agentName: input.profile.name,
        delegateTool: input.toolName,
        childRunId,
        parentRunId: parent.record.id,
        entrypoint: input.entrypoint ?? "external_command",
        protocol: "external_command",
        workspaceAccess,
        subagentDepth,
      };
      parent.events.emit("subagent.requested", base, meta);
      parent.events.emit("subagent.started", base, meta);
      try {
        assertReadWriteWorkspaceAccessAllowed({
          workspaceAccess,
          toolName: input.toolName,
          allowed: input.allowReadWriteWorkspaceAccess === true,
        });
        if (workspaceAccess === "read_write") {
          parent.events.emit(
            "workspace.write.untracked_access_granted",
            {
              childRunId,
              parentRunId: parent.record.id,
              toolName: input.toolName,
              agentProfileId: input.profile.id,
              protocol: "external_command",
              marker: "untracked-write-capable",
              access: "granted",
            },
            meta,
          );
        }
        const result = await runExternalCommand({
          config,
          workspaceRoot: input.workspaceRoot,
          goal: parsed.goal,
          metadata: parsed.metadata,
          toolName: input.toolName,
          sandbox: input.sandbox,
          sandboxRuntime: input.sandboxRuntime,
          skillRoots: input.skillRoots,
          configPaths: input.configPaths,
          emitter: parent.events,
          runId: parent.record.id,
        });
        const successExitCodes = config.successExitCodes ?? [0];
        if (
          result.exitCode === null ||
          !successExitCodes.includes(result.exitCode)
        ) {
          throw new DelegateExecutionError(
            "DELEGATE_NONZERO_EXIT",
            `External command delegate "${input.toolName}" exited with ${exitStatus(
              result.exitCode,
              result.signal,
            )}.`,
            {
              childRunId,
              agentId: input.profile.id,
              agentProfileId: input.profile.id,
              ...result,
            },
          );
        }
        parent.events.emit(
          "subagent.completed",
          {
            ...base,
            stopReason: "completed",
            result: {
              protocol: "external_command",
              agentProfileId: input.profile.id,
              exitCode: result.exitCode,
              signal: result.signal,
              stdoutChars: result.stdout.length,
              stderrChars: result.stderr.length,
              stdoutTruncated: result.stdoutTruncated,
              stderrTruncated: result.stderrTruncated,
              outputTruncated: result.outputTruncated,
              output: result.output,
              sandbox: result.sandbox,
              progressCount: result.progressCount,
              progressDropped: result.progressDropped,
              progressHead: result.progressHead,
              progressTail: result.progressTail,
            },
          },
          meta,
        );
        return {
          childRunId,
          spanId,
          protocol: "external_command",
          agentId: input.profile.id,
          agentProfileId: input.profile.id,
          ...result,
        };
      } catch (error) {
        parent.events.emit(
          "subagent.failed",
          {
            ...base,
            reason: "failed",
            errorCode: errorCode(error),
            error: error instanceof Error ? error.message : String(error),
          },
          meta,
        );
        throw error;
      }
    },
  });
}

async function runExternalCommand(input: {
  config: ExternalCommandAgentConfig;
  workspaceRoot: string;
  goal: string;
  metadata?: Record<string, unknown>;
  toolName: string;
  sandbox?: ShellSandboxConfig | ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
  skillRoots?: readonly string[];
  configPaths?: readonly string[];
  emitter: EventEmitter;
  runId: RunId;
}): Promise<
  Pick<
    ExternalCommandDelegateToolResult,
    | "exitCode"
    | "signal"
    | "stdout"
    | "stderr"
    | "stdoutTruncated"
    | "stderrTruncated"
    | "outputTruncated"
    | "output"
    | "sandbox"
    | "progressCount"
    | "progressDropped"
    | "progressHead"
    | "progressTail"
  >
> {
  const inputMode = input.config.input ?? "argument";
  const workspaceAccess = input.config.workspaceAccess ?? "none";
  if (
    workspaceAccess !== "read_write" &&
    usesWorkspaceRootTemplate(input.config.args)
  ) {
    assertWorkspaceAccess({
      workspaceAccess,
      toolName: input.toolName,
      reason: "workspaceRoot",
    });
  }
  const context = {
    goal: input.goal,
    metadataJson: JSON.stringify(input.metadata ?? {}),
    workspaceRoot: input.workspaceRoot,
  };
  const configuredArgs = (input.config.args ?? []).map((arg) =>
    renderTemplate(arg, context),
  );
  const args =
    inputMode === "argument" &&
    !containsGoalPlaceholder(input.config.args ?? [])
      ? [...configuredArgs, input.goal]
      : configuredArgs;
  const executionWorkspace = await resolveDelegateProcessWorkspace({
    workspaceRoot: input.workspaceRoot,
    configuredCwd: input.config.cwd,
    workspaceAccess,
    toolName: input.toolName,
  });

  try {
    const stdoutLimit =
      input.config.maxStdoutBytes ?? input.config.maxOutputBytes ?? 64_000;
    const stderrLimit =
      input.config.maxStderrBytes ?? input.config.maxOutputBytes ?? 64_000;
    const previewBytes = Math.max(stdoutLimit, stderrLimit);
    const sandboxConfig =
      input.sandbox && "forcedDenyWrite" in input.sandbox
        ? input.sandbox
        : resolveShellSandboxConfig({
            workspaceRoot: input.workspaceRoot,
            config: input.sandbox,
            skillRoots: input.skillRoots,
            extraForcedDenyWrite: input.configPaths,
          });
    const sandboxRuntime =
      input.sandboxRuntime ?? createPlatformShellSandboxRuntime();
    const effectiveSandboxConfig = await delegateSandboxConfig({
      config: sandboxConfig,
      workspaceAccess,
      workspaceRoot: input.workspaceRoot,
      executionCwd: executionWorkspace.cwd,
      command: input.config.command,
      args,
      runtime: sandboxRuntime,
    });
    const stdin =
      inputMode === "stdin"
        ? renderStdin(input.goal, input.metadata)
        : undefined;
    const runner = new TracedProcessRunner();
    const progress = createProcessProgressSampleCollector();
    const result = await runner.run({
      emitter: input.emitter,
      runId: input.runId,
      name: input.toolName,
      kind: "external_agent",
      runtime: "custom",
      command: input.config.command,
      args,
      cwd: executionWorkspace.cwd,
      env: buildCommandEnv(input.config),
      stdin,
      timeoutMs: input.config.timeoutMs,
      sandbox: effectiveSandboxConfig,
      sandboxRuntime,
      emitLifecycle: false,
      onProgress: (chunk) => {
        progress.record(chunk);
      },
      outputLimits: {
        previewBytes,
        artifactBytes: input.config.maxOutputBytes ?? previewBytes,
        maxStdoutBytes: stdoutLimit,
        maxStderrBytes: stderrLimit,
      },
    });

    const sandbox = externalSandboxSummary(result.sandbox);
    if (
      result.error?.code === "PROCESS_COMMAND_NOT_FOUND" ||
      result.error?.code === "PROCESS_START_FAILED"
    ) {
      throw new DelegateExecutionError(
        result.error.code === "PROCESS_COMMAND_NOT_FOUND"
          ? "DELEGATE_COMMAND_NOT_FOUND"
          : "DELEGATE_COMMAND_START_FAILED",
        `External command "${input.config.command}" failed to start: ${result.error.message}`,
        { command: input.config.command, sandbox },
      );
    }
    if (result.timedOut) {
      throw new DelegateExecutionError(
        "DELEGATE_TIMEOUT",
        "External command delegate timed out.",
        { timeoutMs: input.config.timeoutMs, sandbox },
      );
    }
    if (
      result.exitCode === null &&
      sandbox?.enforced === true &&
      typeof sandbox.fallbackReason === "string"
    ) {
      throw new DelegateExecutionError(
        "DELEGATE_EXECUTION_FAILED",
        sandbox.fallbackReason,
        { sandbox },
      );
    }

    return {
      exitCode: result.exitCode,
      signal: result.signal as NodeJS.Signals | null,
      stdout: truncateBytes(result.output.stdoutPreview ?? "", stdoutLimit),
      stderr: truncateBytes(result.output.stderrPreview ?? "", stderrLimit),
      stdoutTruncated:
        result.output.stdoutTruncated ||
        result.output.stdoutBytes > stdoutLimit,
      stderrTruncated:
        result.output.stderrTruncated ||
        result.output.stderrBytes > stderrLimit,
      outputTruncated:
        result.output.stdoutTruncated || result.output.stderrTruncated,
      output: result.output,
      sandbox,
      ...progress.summary({
        progressCount: result.progressCount,
        progressDropped: result.progressDropped,
      }),
    };
  } finally {
    await executionWorkspace.cleanup();
  }
}

async function delegateSandboxConfig(input: {
  config: ResolvedShellSandboxConfig;
  workspaceAccess: DelegateWorkspaceAccess;
  workspaceRoot: string;
  executionCwd: string;
  command: string;
  args: readonly string[];
  runtime: Pick<ShellSandboxRuntime, "id" | "platform">;
}): Promise<ResolvedShellSandboxConfig> {
  if (input.workspaceAccess === "read_write") {
    return input.config;
  }
  const scoped = scopeShellSandboxFilesystem(input.config, {
    allowRead: [
      input.executionCwd,
      ...absoluteArgPaths([input.command, ...input.args]),
    ],
    allowWrite: [input.executionCwd],
  });
  return enforceProtectedWriteRootsShellSandbox(scoped, {
    runtime: input.runtime,
    protectedRoots: [input.workspaceRoot],
  });
}

function absoluteArgPaths(values: readonly string[]): string[] {
  return values.filter((value) => value.startsWith("/"));
}

function externalSandboxSummary(
  summary: SandboxSummary | undefined,
): ExternalCommandSandboxSummary | undefined {
  if (!summary) return undefined;
  return {
    ...summary,
    ...(summary.available === false && summary.fallbackReason
      ? { unavailable: summary.fallbackReason }
      : {}),
  };
}

function buildCommandEnv(
  config: ExternalCommandAgentConfig,
): NodeJS.ProcessEnv {
  if (config.envMode === "explicit") {
    return { ...(config.env ?? {}) };
  }
  // Inherit mode. A delegate that was granted read_write workspace access has
  // already been explicitly trusted by the parent run (`--write`), so its
  // inherited environment is left intact. But a locked-down delegate
  // (workspaceAccess "none", the default) runs in a throwaway cwd and must not
  // be able to exfiltrate the parent's credentials: we still hand it a working
  // environment (PATH/HOME/etc.) but redact env vars that look like secrets.
  // Authors can re-add a specific value through the explicit `env` map below,
  // which always overlays the inherited (and now redacted) base.
  const workspaceAccess = config.workspaceAccess ?? "none";
  const inherited =
    workspaceAccess === "read_write"
      ? { ...process.env }
      : redactSecretEnv(process.env);
  return { ...inherited, ...(config.env ?? {}) };
}

/**
 * Returns a copy of `env` with credential-looking variables removed. Used to
 * keep sandboxed (`workspaceAccess: "none"`) delegates from inheriting the
 * parent process's secrets while still receiving the benign environment a
 * subprocess needs to run (PATH, HOME, locale, …).
 *
 * @internal Exported for unit tests; not part of the public host API.
 */
export function redactSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isSecretEnvKey(key)) out[key] = value;
  }
  return out;
}

/**
 * Heuristic match for credential-bearing environment variable names. Errs on
 * the side of redaction: a sandboxed reviewer rarely needs provider tokens, and
 * a false positive can always be re-supplied via the delegate's explicit `env`
 * map. Never matches PATH/HOME/locale-style names.
 *
 * @internal Exported for unit tests.
 */
export function isSecretEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  // Common credential tokens anywhere in the name.
  if (
    /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|APIKEY|PRIVATE_KEY|ACCESS_KEY|SESSION_KEY|AUTH)/.test(
      k,
    )
  ) {
    return true;
  }
  // Whole-word *_KEY / API_KEY suffix (so MONKEY / KEYBOARD do not match).
  if (/(^|_)(API_KEY|KEY)$/.test(k)) return true;
  // Known secret-bearing provider/service prefixes.
  if (
    /^(AWS|AZURE|GCP|GOOGLE_CLOUD|OPENAI|ANTHROPIC|GEMINI|COHERE|MISTRAL|HF|HUGGINGFACE|GITHUB|GH|GITLAB|NPM|PYPI|SLACK|STRIPE|TWILIO|SENDGRID|CLOUDFLARE|HEROKU|VAULT|DOCKERHUB)_/.test(
      k,
    )
  ) {
    return true;
  }
  return false;
}

function parseDelegateArgs(input: unknown): {
  goal: string;
  metadata?: Record<string, unknown>;
} {
  if (!input || typeof input !== "object") {
    throw new Error("External command delegate arguments must be an object.");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.goal !== "string" || record.goal.trim().length === 0) {
    throw new Error(
      "External command delegate arguments.goal must be a non-empty string.",
    );
  }
  const metadata = recordField(record, "metadata");
  return { goal: record.goal, ...(metadata ? { metadata } : {}) };
}

function renderStdin(
  goal: string,
  metadata: Record<string, unknown> | undefined,
): string {
  if (!metadata || Object.keys(metadata).length === 0) return goal;
  return `${goal}\n\nMetadata:\n${JSON.stringify(metadata, null, 2)}`;
}

function renderTemplate(
  value: string,
  context: { goal: string; metadataJson: string; workspaceRoot: string },
): string {
  return value
    .replaceAll("{{goal}}", context.goal)
    .replaceAll("{{metadataJson}}", context.metadataJson)
    .replaceAll("{{workspaceRoot}}", context.workspaceRoot);
}

function containsGoalPlaceholder(values: string[]): boolean {
  return values.some((value) => value.includes("{{goal}}"));
}

function exitStatus(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (signal) return `signal ${signal}`;
  return `exit code ${exitCode ?? "unknown"}`;
}

function truncateBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, Math.max(0, maxBytes)).toString("utf8");
}

function recordField(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = (value as Record<string, unknown>)[key];
  return item && typeof item === "object" && !Array.isArray(item)
    ? (item as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function numberArrayField(
  record: Record<string, unknown>,
  key: string,
): number[] | undefined {
  const value = record[key];
  return Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isInteger(item))
    ? value
    : undefined;
}

function inputModeField(
  record: Record<string, unknown>,
  key: string,
): ExternalCommandAgentConfig["input"] | undefined {
  const value = record[key];
  return value === "argument" || value === "stdin" || value === "none"
    ? value
    : undefined;
}

function envModeField(
  record: Record<string, unknown>,
  key: string,
): ExternalCommandAgentConfig["envMode"] | undefined {
  const value = record[key];
  return value === "inherit" || value === "explicit" ? value : undefined;
}

function stringArrayField(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function stringRecordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, item]) => typeof item === "string")) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function sanitizeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return normalized.length > 0 ? normalized : "worker";
}
