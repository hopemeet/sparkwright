import {
  createId,
  createSpanId,
  defineTool,
  type SandboxSummary,
  type RunHandle,
  type ToolDefinition,
} from "@sparkwright/core";
import {
  agentInvocationEventBase,
  agentInvocationMetadata,
  prepareAgentInvocation,
  type AgentProfile,
} from "@sparkwright/agent-runtime";
import { ExternalAcpWorker } from "@sparkwright/acp-client-adapter";
import {
  createPlatformShellSandboxRuntime,
  enforceProtectedWriteRootsShellSandbox,
  prepareSandboxedProcessLaunch,
  resolveShellSandboxConfig,
  scopeShellSandboxFilesystem,
  type ResolvedShellSandboxConfig,
  type ShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import {
  assertReadWriteWorkspaceAccessAllowed,
  assertSubagentDepthAllowed,
  DelegateExecutionError,
  describeDelegateCapability,
  deriveDelegatePolicyProfile,
  errorCode,
  resolveDelegateProcessWorkspace,
  workspaceAccessField,
  type DelegateWorkspaceAccess,
} from "./delegate-capability.js";

export interface AcpChildAgentConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  envMode?: "inherit" | "explicit";
  workspaceAccess?: DelegateWorkspaceAccess;
  timeoutMs?: number;
}

export interface CreateAcpDelegateToolInput {
  getParent: () => RunHandle | undefined;
  profile: AgentProfile;
  toolName: string;
  description: string;
  workspaceRoot: string;
  requiresApproval?: boolean;
  forbidNesting?: boolean;
  maxDepth?: number;
  entrypoint?: "acp" | "delegates_run";
  allowReadWriteWorkspaceAccess?: boolean;
  sandbox?: ShellSandboxConfig | ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
  skillRoots?: readonly string[];
  configPaths?: readonly string[];
}

export interface AcpDelegateToolResult {
  childRunId: string;
  spanId: string;
  /** @reserved Public delegate-tool output field consumed by UIs and orchestrators. */
  protocol: "acp";
  agentId: string;
  /** @reserved Public delegate-tool output field consumed by UIs and orchestrators. */
  agentProfileId: string;
  stopReason: string;
  message?: string;
  toolCalls: number;
  updates: unknown[];
  sandbox?: SandboxSummary;
}

export function acpConfigFromAgentProfile(
  profile: AgentProfile,
): AcpChildAgentConfig | undefined {
  const acp = recordField(profile.metadata, "acp");
  if (!acp) return undefined;
  if (acp.transport !== "stdio") return undefined;
  if (typeof acp.command !== "string" || acp.command.length === 0) {
    return undefined;
  }
  return {
    transport: "stdio",
    command: acp.command,
    args: stringArrayField(acp, "args"),
    cwd: stringField(acp, "cwd"),
    env: stringRecordField(acp, "env"),
    envMode: envModeField(acp, "envMode"),
    workspaceAccess: workspaceAccessField(acp),
    timeoutMs: numberField(acp, "timeoutMs"),
  };
}

export function createAcpDelegateTool(
  input: CreateAcpDelegateToolInput,
): ToolDefinition {
  const config = acpConfigFromAgentProfile(input.profile);
  if (!config) {
    throw new Error(
      `Agent profile ${input.profile.id} does not contain a valid metadata.acp config.`,
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
    protocol: "acp",
    command: config.command,
    args: config.args,
    timeoutMs: config.timeoutMs,
    workspaceAccess,
    allowReadWriteWorkspaceAccess: input.allowReadWriteWorkspaceAccess,
    policyProfile,
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
          description: "Optional structured metadata for the external worker.",
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
    async execute(args: unknown): Promise<AcpDelegateToolResult> {
      const parent = input.getParent();
      if (!parent) {
        throw new Error(
          `ACP delegate tool "${input.toolName}" was invoked but no parent RunHandle is available.`,
        );
      }
      if (
        (input.forbidNesting ?? true) &&
        typeof parent.record.metadata?.parentRunId === "string"
      ) {
        throw new Error(
          `ACP delegate tool "${input.toolName}" refused to nest: parent run is itself a sub-agent.`,
        );
      }
      const subagentDepth = assertSubagentDepthAllowed({
        parent,
        maxDepth: input.maxDepth,
        toolName: input.toolName,
      });
      const parsed = parseDelegateArgs(args);
      const spanId = createSpanId();
      const childRunId = createId(`acp_${sanitizeSegment(input.profile.id)}`);
      const parentAgentId =
        typeof parent.record.metadata?.agentId === "string"
          ? parent.record.metadata.agentId
          : "main";
      const parentSessionId =
        typeof parent.record.metadata?.sessionId === "string"
          ? parent.record.metadata.sessionId
          : undefined;
      const invocation = prepareAgentInvocation({
        goal: parsed.goal,
        protocol: "acp",
        sessionId: parentSessionId,
        parentRunId: parent.record.id,
        childRunId,
        spanId,
        agentId: parentAgentId,
        childAgentId: input.profile.id,
        agentProfileId: input.profile.id,
        agentName: input.profile.name,
        agentAssetIdentity: input.profile.assetIdentity,
        delegateTool: input.toolName,
        entrypoint: input.entrypoint ?? "acp",
        subagentDepth,
        governance: { workspaceAccess },
      });
      const base = agentInvocationEventBase(invocation);
      const meta = agentInvocationMetadata(invocation);
      parent.events.emit("subagent.requested", base, meta);
      parent.events.emit("subagent.started", base, meta);
      let executionWorkspace:
        | Awaited<ReturnType<typeof resolveDelegateProcessWorkspace>>
        | undefined;
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
              protocol: "acp",
              marker: "untracked-write-capable",
              access: "granted",
            },
            meta,
          );
        }
        executionWorkspace = await resolveDelegateProcessWorkspace({
          workspaceRoot: input.workspaceRoot,
          configuredCwd: config.cwd,
          workspaceAccess,
          toolName: input.toolName,
        });
        const workerLaunch = await prepareAcpWorkerLaunch({
          command: config.command,
          args: config.args,
          cwd: executionWorkspace.cwd,
          env: resolveAcpWorkerEnv(config),
          workspaceRoot: input.workspaceRoot,
          workspaceAccess,
          sandbox: input.sandbox,
          sandboxRuntime: input.sandboxRuntime,
          skillRoots: input.skillRoots,
          configPaths: input.configPaths,
        });
        const worker = new ExternalAcpWorker({
          name: input.profile.name ?? input.profile.id,
          command: workerLaunch.command,
          args: [...workerLaunch.args],
          cwd: workerLaunch.cwd,
          env: workerLaunch.env,
          cleanup: workerLaunch.cleanup,
          timeoutMs: config.timeoutMs,
        });
        const result = await worker.run({
          cwd:
            workspaceAccess === "read_write"
              ? input.workspaceRoot
              : executionWorkspace.cwd,
          goal: parsed.goal,
          metadata: parsed.metadata,
        });
        const output: AcpDelegateToolResult = {
          childRunId,
          spanId,
          protocol: "acp",
          agentId: input.profile.id,
          agentProfileId: input.profile.id,
          stopReason: result.stopReason,
          message: result.text,
          toolCalls: result.toolCallCount,
          updates: result.updates.slice(-20),
          sandbox: workerLaunch.sandbox,
        };
        parent.events.emit(
          "subagent.completed",
          {
            ...base,
            stopReason: result.stopReason,
            result: {
              protocol: "acp",
              agentProfileId: input.profile.id,
              stopReason: result.stopReason,
              messageChars: result.text.length,
              toolCalls: result.toolCallCount,
              sandbox: workerLaunch.sandbox,
            },
          },
          meta,
        );
        return output;
      } catch (error) {
        const wrapped = wrapAcpDelegateError(error);
        parent.events.emit(
          "subagent.failed",
          {
            ...base,
            reason: "failed",
            errorCode: errorCode(wrapped),
            error: wrapped.message,
          },
          meta,
        );
        throw wrapped;
      } finally {
        await executionWorkspace?.cleanup();
      }
    },
  });
}

async function prepareAcpWorkerLaunch(input: {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  workspaceRoot: string;
  workspaceAccess: DelegateWorkspaceAccess;
  sandbox?: ShellSandboxConfig | ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
  skillRoots?: readonly string[];
  configPaths?: readonly string[];
}): Promise<{
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cleanup?: () => Promise<void>;
  sandbox: SandboxSummary;
}> {
  const baseSandbox =
    input.sandbox && "forcedDenyWrite" in input.sandbox
      ? input.sandbox
      : resolveShellSandboxConfig({
          workspaceRoot: input.workspaceRoot,
          config: input.sandbox,
          skillRoots: input.skillRoots,
          extraForcedDenyWrite: input.configPaths,
        });
  const runtime = input.sandboxRuntime ?? createPlatformShellSandboxRuntime();
  const sandbox =
    input.workspaceAccess === "read_write"
      ? baseSandbox
      : await enforceProtectedWriteRootsShellSandbox(
          scopeShellSandboxFilesystem(baseSandbox, {
            allowRead: [
              input.cwd,
              ...[input.command, ...(input.args ?? [])].filter((value) =>
                value.startsWith("/"),
              ),
            ],
            allowWrite: [input.cwd],
          }),
          {
            runtime,
            protectedRoots: [input.workspaceRoot],
          },
        );
  const decision = await prepareSandboxedProcessLaunch(
    runtime,
    {
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
      metadata: { protocol: "acp" },
    },
    sandbox,
  );
  if (decision.status === "unavailable") {
    throw new DelegateExecutionError(
      "DELEGATE_EXECUTION_FAILED",
      decision.reason,
      {
        sandbox: {
          sandboxed: false,
          mode: sandbox.mode,
          runtime: decision.runtimeId,
          networkMode: sandbox.network.mode,
          available: false,
          fallbackReason: decision.reason,
          enforced: true,
        },
      },
    );
  }
  return {
    ...decision.invocation,
    sandbox: {
      sandboxed: decision.status === "sandboxed",
      mode: sandbox.mode,
      runtime: decision.runtimeId,
      networkMode: sandbox.network.mode,
      available: decision.available,
      ...(decision.status === "unsandboxed" && decision.reason
        ? { fallbackReason: decision.reason }
        : {}),
      enforced: decision.enforced,
    },
  };
}

function wrapAcpDelegateError(error: unknown): Error {
  if (error instanceof DelegateExecutionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("timed out")) {
    return new DelegateExecutionError("DELEGATE_TIMEOUT", message);
  }
  if (message.includes("failed to start") && message.includes("ENOENT")) {
    return new DelegateExecutionError("DELEGATE_COMMAND_NOT_FOUND", message);
  }
  if (message.includes("failed to start")) {
    return new DelegateExecutionError("DELEGATE_COMMAND_START_FAILED", message);
  }
  return error instanceof Error ? error : new Error(message);
}

function parseDelegateArgs(input: unknown): {
  goal: string;
  metadata?: Record<string, unknown>;
} {
  if (!input || typeof input !== "object") {
    throw new Error("ACP delegate arguments must be an object.");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.goal !== "string" || record.goal.trim().length === 0) {
    throw new Error("ACP delegate arguments.goal must be a non-empty string.");
  }
  const metadata = recordField(record, "metadata");
  return { goal: record.goal, ...(metadata ? { metadata } : {}) };
}

function recordField(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = (value as Record<string, unknown>)[key];
  return item && typeof item === "object"
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

function envModeField(
  record: Record<string, unknown>,
  key: string,
): "inherit" | "explicit" | undefined {
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

function resolveAcpWorkerEnv(
  config: Pick<AcpChildAgentConfig, "env" | "envMode">,
): NodeJS.ProcessEnv {
  if (config.envMode === "inherit") {
    return config.env ? { ...process.env, ...config.env } : process.env;
  }
  return { ...minimalProcessEnv(), ...(config.env ?? {}) };
}

function minimalProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "COMSPEC"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function sanitizeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return normalized.length > 0 ? normalized : "worker";
}
