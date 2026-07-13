export const PREPARED_AGENT_INVOCATION_SCHEMA_VERSION =
  "prepared-agent-invocation.v1" as const;

export type SubAgentEntrypoint =
  | "run"
  | "spawn_agent"
  | "agent_task"
  | "delegate"
  | "delegate_parallel"
  | "delegates_run"
  | "acp"
  | "external_command";

export type AgentInvocationProtocol = "in_process" | "acp" | "external_command";

export type AgentInvocationWorkspaceAccess =
  | "none"
  | "read_only"
  | "read_write";

export interface AgentAssetIdentity {
  readonly artifactKind: "agent";
  readonly layer: string;
  readonly logicalName: string;
  readonly packageHashPolicyVersion: 2;
  readonly packageHash: string;
}

export interface PreparedAgentInvocationGovernance {
  readonly workspaceAccess?: AgentInvocationWorkspaceAccess;
  /** @reserved Supervisor admission fact; Host governance will populate it during migration. */
  readonly concurrency?: "serial" | "concurrent";
  readonly approval?: "not_required" | "required" | "resolved";
}

/**
 * Immutable, transport-neutral facts known before an Agent invocation starts.
 * This is deliberately data-only: execution handles, models, tools, policies,
 * event emitters, and lifecycle transitions belong to the runtime/supervisor.
 */
export interface PreparedAgentInvocation {
  readonly schemaVersion: typeof PREPARED_AGENT_INVOCATION_SCHEMA_VERSION;
  /** @reserved Pre-start lifecycle state consumed by the upcoming AgentSupervisor. */
  readonly admissionState: "admission_pending";
  readonly goal: string;
  readonly protocol: AgentInvocationProtocol;
  readonly sessionId?: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly spanId: string;
  readonly taskId?: string;
  readonly childAgentId?: string;
  readonly agentId?: string;
  readonly agentProfileId?: string;
  readonly agentName?: string;
  readonly agentAssetIdentity?: AgentAssetIdentity;
  readonly delegateTool?: string;
  readonly subagentDepth: number;
  readonly entrypoint: SubAgentEntrypoint;
  readonly governance?: PreparedAgentInvocationGovernance;
}

export type PrepareAgentInvocationInput = Omit<
  PreparedAgentInvocation,
  "schemaVersion" | "admissionState"
>;

export function prepareAgentInvocation(
  input: PrepareAgentInvocationInput,
): PreparedAgentInvocation {
  assertNonEmptyInvocationField(input.goal, "goal");
  assertNonEmptyInvocationField(input.parentRunId, "parentRunId");
  assertNonEmptyInvocationField(input.childRunId, "childRunId");
  assertNonEmptyInvocationField(input.spanId, "spanId");
  if (!Number.isInteger(input.subagentDepth) || input.subagentDepth < 1) {
    throw new Error(
      "PreparedAgentInvocation subagentDepth must be a positive integer.",
    );
  }
  return {
    schemaVersion: PREPARED_AGENT_INVOCATION_SCHEMA_VERSION,
    admissionState: "admission_pending",
    ...input,
    ...(input.governance ? { governance: { ...input.governance } } : {}),
  };
}

/** Parent-visible lifecycle payload shared by every Agent transport. */
export function agentInvocationEventBase(
  invocation: PreparedAgentInvocation,
): Record<string, unknown> {
  return removeUndefined({
    childRunId: invocation.childRunId,
    parentRunId: invocation.parentRunId,
    spanId: invocation.spanId,
    goal: invocation.goal,
    taskId: invocation.taskId,
  });
}

/** Parent-visible lifecycle metadata shared by every Agent transport. */
export function agentInvocationMetadata(
  invocation: PreparedAgentInvocation,
): Record<string, unknown> {
  return removeUndefined({
    sessionId: invocation.sessionId,
    agentId: invocation.agentId,
    taskId: invocation.taskId,
    childAgentId: invocation.childAgentId,
    agentProfileId: invocation.agentProfileId,
    agentName: invocation.agentName,
    agentAssetIdentity: invocation.agentAssetIdentity,
    delegateTool: invocation.delegateTool,
    subagentDepth: invocation.subagentDepth,
    entrypoint: invocation.entrypoint,
    protocol: invocation.protocol,
    workspaceAccess: invocation.governance?.workspaceAccess,
    childRunId: invocation.childRunId,
    parentRunId: invocation.parentRunId,
  });
}

export function isSubAgentEntrypoint(
  value: unknown,
): value is SubAgentEntrypoint {
  return (
    value === "run" ||
    value === "spawn_agent" ||
    value === "agent_task" ||
    value === "delegate" ||
    value === "delegate_parallel" ||
    value === "delegates_run" ||
    value === "acp" ||
    value === "external_command"
  );
}

function assertNonEmptyInvocationField(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`PreparedAgentInvocation ${field} must be non-empty.`);
  }
}

function removeUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
