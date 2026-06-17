import { join } from "node:path";
import type {
  PermissionMode,
  RunResumeRequestPayload,
  RunStartRequestPayload,
  TraceLevel,
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
  modelName?: string;
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
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    shouldWrite: input.shouldWrite,
    traceLevel: input.traceLevel,
    ...(input.modelName ? { model: input.modelName } : {}),
  };
}

export function createHostStartRunRequest(input: {
  goal: string;
  sessionId?: string;
  modelName?: string;
  modelNameSource?: HostClientModelSource;
  permissionMode?: PermissionMode;
  traceLevel: TraceLevel;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  shouldWrite: boolean;
  metadata: Record<string, unknown>;
}): RunStartRequestPayload {
  return {
    goal: input.goal,
    sessionId: input.sessionId,
    model: resolveHostRequestModel(input),
    permissionMode: input.permissionMode,
    traceLevel: input.traceLevel,
    targetPath: input.targetPath,
    ...(input.confidentialPaths && input.confidentialPaths.length > 0
      ? { confidentialPaths: [...input.confidentialPaths] }
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
  permissionMode?: PermissionMode;
  traceLevel: TraceLevel;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  shouldWrite: boolean;
  metadata: Record<string, unknown>;
}): RunResumeRequestPayload {
  return {
    runId: input.runId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    fromTrace: input.fromTrace,
    force: input.force,
    model: resolveHostRequestModel(input),
    permissionMode: input.permissionMode,
    traceLevel: input.traceLevel,
    targetPath: input.targetPath,
    ...(input.confidentialPaths && input.confidentialPaths.length > 0
      ? { confidentialPaths: [...input.confidentialPaths] }
      : {}),
    shouldWrite: input.shouldWrite,
    metadata: input.metadata,
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
