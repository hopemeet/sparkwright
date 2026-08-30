import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  BackgroundTaskPolicy,
  CapabilityInspectRequestPayload,
  RunInputPayload,
  RunResumeRequestPayload,
  RunStartRequestPayload,
  RunAccessMode,
  TraceLevel,
  WorkflowListRequestPayload,
  WorkflowResumeRequestPayload,
} from "@sparkwright/protocol";
import { ACCESS_MODES } from "@sparkwright/protocol";
import {
  buildAccessMetadata,
  resolveRunAccessFields,
  type ResolvedRunAccess,
  type RunAccessResolutionOptions,
} from "./run-access.js";

export type HostClientSource = "cli" | "tui" | "acp" | string;
export type HostClientModelSource = "config" | "request" | "cli";

export function createWorkflowJobSessionId(): string {
  return `session_workflow_${randomUUID().replaceAll("-", "")}`;
}

export interface HostClientRunAccessInput extends RunAccessResolutionOptions {
  accessMode?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
}

export interface HostClientResolvedRunAccess extends ResolvedRunAccess {
  metadata: Record<string, unknown>;
}

export interface HostClientRunMetadataInput {
  source: HostClientSource;
  targetPath?: string;
  accessMode: RunAccessMode;
  traceLevel: TraceLevel;
  sessionId?: string;
  workspaceRoot?: string;
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

export function resolveHostClientRunAccess(
  input: HostClientRunAccessInput,
): HostClientResolvedRunAccess {
  const resolved = resolveRunAccessFields(
    {
      accessMode: input.accessMode,
      backgroundTasks: input.backgroundTasks,
    },
    {
      defaultAccessMode: input.defaultAccessMode,
      accessModeCeiling: input.accessModeCeiling,
      defaultBackgroundTasks: input.defaultBackgroundTasks,
      backgroundTasksCeiling: input.backgroundTasksCeiling,
    },
  );
  return {
    ...resolved,
    metadata: buildAccessMetadata(resolved),
  };
}

export function clampHostClientAccessMode(
  ceiling: RunAccessMode | undefined,
  requested: RunAccessMode,
): RunAccessMode {
  return (
    resolveHostClientRunAccess({
      accessMode: requested,
      accessModeCeiling: ceiling,
    }).accessMode ?? requested
  );
}

export function nextHostClientAccessMode(
  mode: RunAccessMode,
  ceiling?: RunAccessMode,
): RunAccessMode {
  const allowed =
    ceiling === undefined
      ? [...ACCESS_MODES]
      : ACCESS_MODES.filter(
          (candidate) =>
            clampHostClientAccessMode(ceiling, candidate) === candidate,
        );
  const current = clampHostClientAccessMode(ceiling, mode);
  const index = allowed.indexOf(current);
  return allowed[(index + 1) % allowed.length] ?? allowed[0]!;
}

export function createHostClientRunMetadata(
  input: HostClientRunMetadataInput,
): Record<string, unknown> {
  return {
    source: input.source,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    accessMode: input.accessMode,
    ...(input.backgroundTasks
      ? { backgroundTasks: input.backgroundTasks }
      : {}),
    ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    traceLevel: input.traceLevel,
    ...(input.modelName ? { model: input.modelName } : {}),
    ...(input.workflowName ? { workflow: input.workflowName } : {}),
  };
}

export function createHostStartRunRequest(input: {
  goal: string;
  sessionId?: string;
  controlSessionId?: string;
  modelName?: string;
  modelNameSource?: HostClientModelSource;
  workflowName?: string;
  accessMode: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  traceLevel: TraceLevel;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  confidentialDefaults?: boolean;
  metadata: Record<string, unknown>;
  input?: RunInputPayload;
}): RunStartRequestPayload {
  return {
    goal: input.goal,
    ...(input.input ? { input: input.input } : {}),
    sessionId: input.sessionId,
    ...(input.controlSessionId
      ? { controlSessionId: input.controlSessionId }
      : {}),
    model: resolveHostRequestModel(input),
    workflow: input.workflowName,
    accessMode: input.accessMode,
    backgroundTasks: input.backgroundTasks,
    traceLevel: input.traceLevel,
    targetPath: input.targetPath,
    ...(input.confidentialPaths && input.confidentialPaths.length > 0
      ? { confidentialPaths: [...input.confidentialPaths] }
      : {}),
    ...(input.confidentialDefaults === false
      ? { confidentialDefaults: false }
      : {}),
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
  accessMode: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  traceLevel: TraceLevel;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  confidentialDefaults?: boolean;
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
    traceLevel: input.traceLevel,
    targetPath: input.targetPath,
    ...(input.confidentialPaths && input.confidentialPaths.length > 0
      ? { confidentialPaths: [...input.confidentialPaths] }
      : {}),
    ...(input.confidentialDefaults === false
      ? { confidentialDefaults: false }
      : {}),
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
  accessMode: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  traceLevel: TraceLevel;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  confidentialDefaults?: boolean;
  metadata: Record<string, unknown>;
}): WorkflowResumeRequestPayload {
  return {
    workflowRunId: input.workflowRunId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    model: resolveHostRequestModel(input),
    accessMode: input.accessMode,
    backgroundTasks: input.backgroundTasks,
    traceLevel: input.traceLevel,
    targetPath: input.targetPath,
    ...(input.confidentialPaths && input.confidentialPaths.length > 0
      ? { confidentialPaths: [...input.confidentialPaths] }
      : {}),
    ...(input.confidentialDefaults === false
      ? { confidentialDefaults: false }
      : {}),
    metadata: input.metadata,
  };
}

export function createHostCapabilityInspectRequest(input: {
  sessionId?: string;
  modelName?: string;
  modelNameSource?: HostClientModelSource;
  accessMode?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
}): CapabilityInspectRequestPayload {
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    model: resolveHostRequestModel(input),
    ...(input.accessMode ? { accessMode: input.accessMode } : {}),
    ...(input.backgroundTasks
      ? { backgroundTasks: input.backgroundTasks }
      : {}),
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
