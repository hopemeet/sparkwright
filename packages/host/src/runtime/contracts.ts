import type { BackgroundTaskPolicy, RunAccessMode } from "@sparkwright/core";
import type { McpServerConfig } from "@sparkwright/mcp-adapter";
import type {
  HostEvent,
  ProtocolError,
  RunInputPart,
  RunResumeRequestPayload,
  RunStartRequestPayload,
  TraceLevel,
} from "@sparkwright/protocol";
import type { ExecutionHandle } from "@sparkwright/server-runtime";
import type { WorkspaceContext } from "../workspace-context.js";
import type { WorkspaceLeaseCoordinator } from "../workspace-lease-coordinator.js";

export interface RuntimeOptions {
  /** Workspace root for all runs spawned through this runtime. */
  workspaceRoot: string;
  /** Session/trace storage root. Defaults to <workspaceRoot>/.sparkwright/sessions. */
  sessionRootDir?: string;
  /** Default model reference ("provider/model") when run.start omits one. */
  defaultModel?: string;
  /** Default high-level access mode when run.start does not specify one. */
  defaultAccessMode?: RunAccessMode;
  /** Project/runtime ceiling for requested high-level access modes. */
  accessModeCeiling?: RunAccessMode;
  /** Default session foreground/background task policy. */
  defaultBackgroundTasks?: BackgroundTaskPolicy;
  /** Project/runtime ceiling for foreground/background task policy. */
  backgroundTasksCeiling?: BackgroundTaskPolicy;
  /** Default trace level when run.start does not specify one. */
  defaultTraceLevel?: TraceLevel;
  /** Session-scoped MCP servers supplied by an embedding protocol (for example ACP). */
  extraMcpServers?: readonly McpServerConfig[];
  /** Called to deliver host events to the client. */
  emit: (event: HostEvent) => void;
  /** @internal Process-scoped workspace mutation coordinator override. */
  workspaceLeaseCoordinator?: WorkspaceLeaseCoordinator;
  /** @internal Workspace-scoped durable owner injected by HostService. */
  workspaceContext?: WorkspaceContext;
  /** @internal Canonical process lane path injected by HostService. */
  executionCoordinator?: HostExecutionCoordinatorPort;
  /** @internal Finite live approval wait; defaults to five minutes. */
  approvalTimeoutMs?: number;
}

export interface HostExecutionMessageInput {
  content: string;
  parts?: readonly RunInputPart[];
  metadata?: Record<string, unknown>;
}

export interface HostExecutionMessage extends HostExecutionMessageInput {
  runId: string;
}

export type HostStartRunOutcome =
  | {
      ok: true;
      runId: string;
      sessionId: string;
      workflowRunId?: string;
    }
  | { ok: false; error: ProtocolError };

export type HostResumeRunOutcome =
  | {
      ok: true;
      runId: string;
      resumedFromRunId: string;
      sessionId?: string;
    }
  | { ok: false; error: ProtocolError };

export type HostRunControlOutcome =
  | { ok: true }
  | { ok: false; error: ProtocolError };

export interface HostExecutionIdentity {
  executionId: string;
  sessionId?: string;
  currentRunId?: string;
  runIds: readonly string[];
}

/** Narrow execution surface driven by the process-scoped lane coordinator. */
export interface HostExecutionCoordinatorRuntime {
  startRunDirect(
    payload: RunStartRequestPayload,
    executionId?: string,
  ): Promise<HostStartRunOutcome>;
  resumeRunDirect(
    payload: RunResumeRequestPayload,
    executionId?: string,
    resolvedSessionId?: string,
  ): Promise<HostResumeRunOutcome>;
  injectRunMessageDirect(
    runId: string,
    input: HostExecutionMessageInput,
  ): HostRunControlOutcome;
  cancelRunDirect(runId: string, reason?: string): HostRunControlOutcome;
  resolveResumeSession(
    payload: RunResumeRequestPayload,
  ): Promise<
    { ok: true; sessionId: string } | { ok: false; error: ProtocolError }
  >;
  executionIdentity(): HostExecutionIdentity | undefined;
  executionLaneKey(sessionId: string): string;
  executionDriverHandle(
    executionId: string,
  ): ExecutionHandle<HostExecutionMessage, unknown> | undefined;
}

export interface HostExecutionIdentityView {
  executionIdentity(): HostExecutionIdentity | undefined;
}

export interface HostExecutionCoordinatorPort {
  startRun(
    runtime: HostExecutionCoordinatorRuntime,
    payload: RunStartRequestPayload,
  ): Promise<HostStartRunOutcome>;
  resumeRun(
    runtime: HostExecutionCoordinatorRuntime,
    payload: RunResumeRequestPayload,
  ): Promise<HostResumeRunOutcome>;
  injectRunMessage(
    runtime: HostExecutionCoordinatorRuntime,
    runId: string,
    input: HostExecutionMessageInput,
  ): HostRunControlOutcome;
  cancelRun(
    runtime: HostExecutionCoordinatorRuntime,
    runId: string,
    reason?: string,
  ): HostRunControlOutcome;
}
