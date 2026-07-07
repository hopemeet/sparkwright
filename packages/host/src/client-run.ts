import { join } from "node:path";
import type {
  BackgroundTaskPolicy,
  CapabilityInspectRequestPayload,
  PermissionMode,
  RunInputPayload,
  RunResumeRequestPayload,
  RunStartRequestPayload,
  RunAccessMode,
  TraceLevel,
  WorkflowListRequestPayload,
  WorkflowResumeRequestPayload,
} from "@sparkwright/protocol";

export type HostClientSource = "cli" | "tui" | "acp" | string;
export type HostClientModelSource = "config" | "request" | "cli";

export interface HostClientRunMetadataInput {
  source: HostClientSource;
  targetPath?: string;
  shouldWrite: boolean;
  traceLevel: TraceLevel;
  sessionId?: string;
  workspaceRoot?: string;
  permissionMode?: PermissionMode;
  accessMode?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  modelName?: string;
  workflowName?: string;
}

export function resolveHostRequestModel(input: {
  modelName?: string;
  modelNameSource?: HostClientModelSource;
}): string | undefined {
  return input.modelNameSource === "config" ? undefined : input.modelName;
}

export function createHostClientRunMetadata(
  input: HostClientRunMetadataInput,
): Record<string, unknown> {
  return {
    source: input.source,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.accessMode ? { accessMode: input.accessMode } : {}),
    ...(input.backgroundTasks
      ? { backgroundTasks: input.backgroundTasks }
      : {}),
    ...(!input.accessMode && input.permissionMode
      ? { permissionMode: input.permissionMode }
      : {}),
    ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    shouldWrite: input.shouldWrite,
    traceLevel: input.traceLevel,
    ...(input.modelName ? { model: input.modelName } : {}),
    ...(input.workflowName ? { workflow: input.workflowName } : {}),
  };
}

export function createHostStartRunRequest(input: {
  goal: string;
  sessionId?: string;
  modelName?: string;
  modelNameSource?: HostClientModelSource;
  workflowName?: string;
  accessMode?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  permissionMode?: PermissionMode;
  traceLevel: TraceLevel;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  confidentialDefaults?: boolean;
  shouldWrite: boolean;
  metadata: Record<string, unknown>;
  input?: RunInputPayload;
}): RunStartRequestPayload {
  return {
    goal: input.goal,
    ...(input.input ? { input: input.input } : {}),
    sessionId: input.sessionId,
    model: resolveHostRequestModel(input),
    workflow: input.workflowName,
    accessMode: input.accessMode,
    backgroundTasks: input.backgroundTasks,
    permissionMode: input.accessMode ? undefined : input.permissionMode,
    traceLevel: input.traceLevel,
    targetPath: input.targetPath,
    ...(input.confidentialPaths && input.confidentialPaths.length > 0
      ? { confidentialPaths: [...input.confidentialPaths] }
      : {}),
    ...(input.confidentialDefaults === false
      ? { confidentialDefaults: false }
      : {}),
    shouldWrite: input.shouldWrite,
    metadata: input.metadata,
  };
}

export function createHostResumeRunRequest(input: {
  runId: string;
  sessionId?: string;
  fromTrace: boolean;
  force: boolean;
  modelName?: string;
  modelNameSource?: HostClientModelSource;
  accessMode?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  permissionMode?: PermissionMode;
  traceLevel: TraceLevel;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  confidentialDefaults?: boolean;
  shouldWrite: boolean;
  metadata: Record<string, unknown>;
}): RunResumeRequestPayload {
  return {
    runId: input.runId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    fromTrace: input.fromTrace,
    force: input.force,
    model: resolveHostRequestModel(input),
    accessMode: input.accessMode,
    backgroundTasks: input.backgroundTasks,
    permissionMode: input.accessMode ? undefined : input.permissionMode,
    traceLevel: input.traceLevel,
    targetPath: input.targetPath,
    ...(input.confidentialPaths && input.confidentialPaths.length > 0
      ? { confidentialPaths: [...input.confidentialPaths] }
      : {}),
    ...(input.confidentialDefaults === false
      ? { confidentialDefaults: false }
      : {}),
    shouldWrite: input.shouldWrite,
    metadata: input.metadata,
  };
}

export function createHostWorkflowListRequest(input: {
  sessionId?: string;
  status?: WorkflowListRequestPayload["status"];
  limit?: number;
}): WorkflowListRequestPayload {
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
}

export function createHostWorkflowResumeRequest(input: {
  workflowRunId: string;
  sessionId?: string;
  modelName?: string;
  modelNameSource?: HostClientModelSource;
  accessMode?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  permissionMode?: PermissionMode;
  traceLevel: TraceLevel;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  confidentialDefaults?: boolean;
  shouldWrite: boolean;
  metadata: Record<string, unknown>;
}): WorkflowResumeRequestPayload {
  return {
    workflowRunId: input.workflowRunId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    model: resolveHostRequestModel(input),
    accessMode: input.accessMode,
    backgroundTasks: input.backgroundTasks,
    permissionMode: input.accessMode ? undefined : input.permissionMode,
    traceLevel: input.traceLevel,
    targetPath: input.targetPath,
    ...(input.confidentialPaths && input.confidentialPaths.length > 0
      ? { confidentialPaths: [...input.confidentialPaths] }
      : {}),
    ...(input.confidentialDefaults === false
      ? { confidentialDefaults: false }
      : {}),
    shouldWrite: input.shouldWrite,
    metadata: input.metadata,
  };
}

export function createHostCapabilityInspectRequest(input: {
  sessionId?: string;
  modelName?: string;
  modelNameSource?: HostClientModelSource;
}): CapabilityInspectRequestPayload {
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    model: resolveHostRequestModel(input),
  };
}

export function tracePathForSession(input: {
  sessionRootDir: string;
  sessionId?: string;
}): string | undefined {
  return input.sessionId
    ? join(input.sessionRootDir, input.sessionId, "trace.jsonl")
    : undefined;
}
