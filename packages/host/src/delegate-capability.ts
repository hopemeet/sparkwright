import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentProfile } from "@sparkwright/agent-runtime";
import type { CapabilityDelegateToolConfig } from "./config.js";

export type DelegateProtocol = "acp" | "external_command";
export type DelegateWorkspaceAccess = "none" | "read_write";
export type DelegateFailureCode =
  | "DELEGATE_APPROVAL_DENIED"
  | "DELEGATE_WORKSPACE_ACCESS_DENIED"
  | "DELEGATE_TIMEOUT"
  | "DELEGATE_COMMAND_NOT_FOUND"
  | "DELEGATE_COMMAND_START_FAILED"
  | "DELEGATE_NONZERO_EXIT"
  | "DELEGATE_EXECUTION_FAILED";

export interface DelegateCapabilityDescriptor {
  toolName: string;
  profileId: string;
  /** @reserved Public capability-inspection field consumed by host protocol clients. */
  profileName?: string;
  protocol: DelegateProtocol;
  risk: "risky";
  requiresApproval: boolean;
  forbidNesting: boolean;
  sideEffects: string[];
  workspaceAccess: DelegateWorkspaceAccess;
  /** @reserved Public capability-inspection field consumed by permission UIs. */
  shellAccess: false;
  /** @reserved Public capability-inspection field consumed by permission UIs. */
  processSpawn: true;
  command: string;
  args: string[];
  timeoutMs?: number;
  outputLimits?: {
    stdoutBytes?: number;
    stderrBytes?: number;
  };
}

export interface DelegateResultSummary {
  protocol: DelegateProtocol;
  /** @reserved Public delegate-result identity field consumed by trace and orchestration UIs. */
  agentProfileId: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stopReason?: string;
  /** @reserved Public delegate-result metric consumed by trace and orchestration UIs. */
  messageChars?: number;
  toolCalls?: number;
  /** @reserved Public delegate-result metric consumed by trace and orchestration UIs. */
  stdoutChars?: number;
  /** @reserved Public delegate-result metric consumed by trace and orchestration UIs. */
  stderrChars?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  outputTruncated?: boolean;
}

export class DelegateExecutionError extends Error {
  readonly code: DelegateFailureCode;
  readonly metadata?: Record<string, unknown>;

  constructor(
    code: DelegateFailureCode,
    message: string,
    metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DelegateExecutionError";
    this.code = code;
    this.metadata = metadata;
  }
}

export function delegateToolName(
  delegate: Pick<CapabilityDelegateToolConfig, "profileId" | "toolName">,
): string {
  return (
    delegate.toolName ?? `delegate_${sanitizeToolSegment(delegate.profileId)}`
  );
}

export function describeDelegateCapability(input: {
  delegate: CapabilityDelegateToolConfig;
  profile: AgentProfile;
  protocol: DelegateProtocol;
  command: string;
  args?: string[];
  timeoutMs?: number;
  workspaceAccess?: DelegateWorkspaceAccess;
  outputLimits?: DelegateCapabilityDescriptor["outputLimits"];
}): DelegateCapabilityDescriptor {
  return {
    toolName: delegateToolName(input.delegate),
    profileId: input.profile.id,
    profileName: input.profile.name,
    protocol: input.protocol,
    risk: "risky",
    requiresApproval: input.delegate.requiresApproval ?? true,
    forbidNesting: input.delegate.forbidNesting ?? true,
    sideEffects: ["external"],
    workspaceAccess: input.workspaceAccess ?? "none",
    shellAccess: false,
    processSpawn: true,
    command: input.command,
    args: input.args ?? [],
    timeoutMs: input.timeoutMs,
    outputLimits: input.outputLimits,
  };
}

export function describeExternalDelegateCapability(input: {
  delegate: CapabilityDelegateToolConfig;
  profile: AgentProfile;
}): DelegateCapabilityDescriptor | undefined {
  const acp = recordField(input.profile.metadata, "acp");
  if (
    acp?.transport === "stdio" &&
    typeof acp.command === "string" &&
    acp.command.length > 0
  ) {
    return describeDelegateCapability({
      delegate: input.delegate,
      profile: input.profile,
      protocol: "acp",
      command: acp.command,
      args: stringArrayField(acp, "args"),
      timeoutMs: numberField(acp, "timeoutMs"),
      workspaceAccess: workspaceAccessField(acp) ?? "none",
    });
  }
  const externalCommand = recordField(
    input.profile.metadata,
    "externalCommand",
  );
  if (
    typeof externalCommand?.command === "string" &&
    externalCommand.command.length > 0
  ) {
    const maxOutputBytes = numberField(externalCommand, "maxOutputBytes");
    return describeDelegateCapability({
      delegate: input.delegate,
      profile: input.profile,
      protocol: "external_command",
      command: externalCommand.command,
      args: stringArrayField(externalCommand, "args"),
      timeoutMs: numberField(externalCommand, "timeoutMs"),
      workspaceAccess: workspaceAccessField(externalCommand) ?? "none",
      outputLimits: {
        stdoutBytes:
          numberField(externalCommand, "maxStdoutBytes") ?? maxOutputBytes,
        stderrBytes:
          numberField(externalCommand, "maxStderrBytes") ?? maxOutputBytes,
      },
    });
  }
  return undefined;
}

export function workspaceAccessField(
  record: Record<string, unknown>,
): DelegateWorkspaceAccess | undefined {
  return record.workspaceAccess === "read_write" ? "read_write" : undefined;
}

export function validateWorkspaceAccess(
  value: unknown,
  field: string,
  addError: (field: string, message: string) => void,
): void {
  if (value !== undefined && value !== "none" && value !== "read_write") {
    addError(field, "must be none or read_write");
  }
}

export function assertWorkspaceAccess(input: {
  workspaceAccess: DelegateWorkspaceAccess;
  toolName: string;
  reason: "cwd" | "workspaceRoot";
}): void {
  if (input.workspaceAccess === "read_write") return;
  const detail =
    input.reason === "cwd"
      ? "metadata cwd"
      : "{{workspaceRoot}} argument expansion";
  throw new DelegateExecutionError(
    "DELEGATE_WORKSPACE_ACCESS_DENIED",
    `Delegate tool "${input.toolName}" requires workspaceAccess "read_write" before using ${detail}.`,
    { toolName: input.toolName, reason: input.reason },
  );
}

export function assertReadWriteWorkspaceAccessAllowed(input: {
  workspaceAccess: DelegateWorkspaceAccess;
  toolName: string;
  allowed: boolean;
}): void {
  if (input.workspaceAccess !== "read_write" || input.allowed) return;
  throw new DelegateExecutionError(
    "DELEGATE_WORKSPACE_ACCESS_DENIED",
    `Delegate tool "${input.toolName}" requests workspaceAccess "read_write", but the parent run has not enabled workspace writes.`,
    {
      toolName: input.toolName,
      workspaceAccess: input.workspaceAccess,
      reason: "parent_write_disabled",
    },
  );
}

export async function resolveDelegateProcessWorkspace(input: {
  workspaceRoot: string;
  configuredCwd?: string;
  workspaceAccess: DelegateWorkspaceAccess;
  toolName: string;
}): Promise<{ cwd: string; cleanup(): Promise<void> }> {
  if (input.workspaceAccess === "read_write") {
    return {
      cwd: input.configuredCwd
        ? resolve(input.workspaceRoot, input.configuredCwd)
        : input.workspaceRoot,
      async cleanup() {},
    };
  }
  if (input.configuredCwd) {
    assertWorkspaceAccess({
      workspaceAccess: input.workspaceAccess,
      toolName: input.toolName,
      reason: "cwd",
    });
  }
  const cwd = await mkdtemp(join(tmpdir(), "sparkwright-delegate-"));
  return {
    cwd,
    async cleanup() {
      // `maxRetries`/`retryDelay` let Node retry the recursive remove on
      // Windows, where a just-exited delegate child can still briefly hold a
      // handle on the temp dir and make the first `rmdir` throw EBUSY/EPERM.
      await rm(cwd, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    },
  };
}

export function usesWorkspaceRootTemplate(
  values: string[] | undefined,
): boolean {
  return (values ?? []).some((value) => value.includes("{{workspaceRoot}}"));
}

export function errorCode(error: unknown): DelegateFailureCode {
  if (error instanceof DelegateExecutionError) return error.code;
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    const code = (error as { code: string }).code;
    if (isDelegateFailureCode(code)) return code;
  }
  return "DELEGATE_EXECUTION_FAILED";
}

export function sanitizeToolSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return normalized.length > 0 ? normalized : "agent";
}

function isDelegateFailureCode(value: string): value is DelegateFailureCode {
  return (
    value === "DELEGATE_APPROVAL_DENIED" ||
    value === "DELEGATE_WORKSPACE_ACCESS_DENIED" ||
    value === "DELEGATE_TIMEOUT" ||
    value === "DELEGATE_COMMAND_NOT_FOUND" ||
    value === "DELEGATE_COMMAND_START_FAILED" ||
    value === "DELEGATE_NONZERO_EXIT" ||
    value === "DELEGATE_EXECUTION_FAILED"
  );
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

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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
