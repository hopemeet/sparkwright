import {
  createSpanId,
  defineTool,
  type RunHandle,
  type ToolDefinition,
} from "@sparkwright/core";
import type { AgentProfile } from "@sparkwright/agent-runtime";
import { ExternalAcpWorker } from "@sparkwright/acp-client-adapter";
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
      const childRunId = `acp_${sanitizeSegment(input.profile.id)}_${Date.now().toString(36)}`;
      const base = {
        childRunId,
        parentRunId: parent.record.id,
        spanId,
        goal: parsed.goal,
      };
      const meta = {
        agentId: input.profile.id,
        agentProfileId: input.profile.id,
        agentName: input.profile.name,
        delegateTool: input.toolName,
        childRunId,
        parentRunId: parent.record.id,
        entrypoint: input.entrypoint ?? "acp",
        protocol: "acp",
        workspaceAccess,
        subagentDepth,
      };
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
        executionWorkspace = await resolveDelegateProcessWorkspace({
          workspaceRoot: input.workspaceRoot,
          configuredCwd: config.cwd,
          workspaceAccess,
          toolName: input.toolName,
        });
        const worker = new ExternalAcpWorker({
          name: input.profile.name ?? input.profile.id,
          command: config.command,
          args: config.args,
          cwd: executionWorkspace.cwd,
          env: resolveAcpWorkerEnv(config),
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
