import {
  clampBackgroundTaskPolicy,
  clampAccessMode,
  compileRunAccessMode,
  type BackgroundTaskPolicy,
  type PermissionMode,
  type RunAccessMode,
} from "@sparkwright/core";
import type {
  CapabilityInspectRequestPayload,
  RunResumeRequestPayload,
  RunStartRequestPayload,
} from "@sparkwright/protocol";

export interface RunAccessPayloadFields {
  accessMode?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
}

export interface RunAccessResolutionOptions {
  defaultAccessMode?: RunAccessMode;
  accessModeCeiling?: RunAccessMode;
  defaultBackgroundTasks?: BackgroundTaskPolicy;
  backgroundTasksCeiling?: BackgroundTaskPolicy;
}

/**
 * Canonical access input plus its internal runtime projection. Consumers may
 * use the compiled fields, but they must never accept them as independent run
 * inputs.
 */
export interface ResolvedRunAccess {
  accessMode: RunAccessMode;
  permissionMode: PermissionMode;
  shouldWrite: boolean;
  requestedAccessMode?: RunAccessMode;
  accessModeCeiling?: RunAccessMode;
  backgroundTasks: BackgroundTaskPolicy;
  requestedBackgroundTasks?: BackgroundTaskPolicy;
  backgroundTasksCeiling?: BackgroundTaskPolicy;
}

export function resolveRunAccessFields(
  payload:
    | RunAccessPayloadFields
    | CapabilityInspectRequestPayload
    | RunStartRequestPayload
    | RunResumeRequestPayload,
  opts: RunAccessResolutionOptions,
): ResolvedRunAccess {
  const requestedAccessMode =
    payload.accessMode ?? opts.defaultAccessMode ?? "read-only";
  const accessMode =
    clampAccessMode(opts.accessModeCeiling, requestedAccessMode) ??
    requestedAccessMode;
  const backgroundTasks =
    clampBackgroundTaskPolicy(
      opts.backgroundTasksCeiling,
      payload.backgroundTasks ?? opts.defaultBackgroundTasks,
    ) ?? "enabled";

  return {
    ...compileRunAccessMode(accessMode),
    accessMode,
    ...(requestedAccessMode !== accessMode ? { requestedAccessMode } : {}),
    ...(opts.accessModeCeiling !== undefined
      ? { accessModeCeiling: opts.accessModeCeiling }
      : {}),
    backgroundTasks,
    ...(payload.backgroundTasks !== undefined &&
    payload.backgroundTasks !== backgroundTasks
      ? { requestedBackgroundTasks: payload.backgroundTasks }
      : {}),
    ...(opts.backgroundTasksCeiling !== undefined
      ? { backgroundTasksCeiling: opts.backgroundTasksCeiling }
      : {}),
  };
}

export function buildAccessMetadata(
  resolved: ResolvedRunAccess,
): Record<string, unknown> {
  return {
    accessMode: resolved.accessMode,
    ...(resolved.requestedAccessMode !== undefined &&
    resolved.requestedAccessMode !== resolved.accessMode
      ? { requestedAccessMode: resolved.requestedAccessMode }
      : {}),
    ...(resolved.accessModeCeiling !== undefined
      ? { accessModeCeiling: resolved.accessModeCeiling }
      : {}),
    ...(resolved.backgroundTasks !== "enabled" ||
    resolved.requestedBackgroundTasks !== undefined ||
    resolved.backgroundTasksCeiling !== undefined
      ? {
          backgroundTasks: resolved.backgroundTasks,
          ...(resolved.requestedBackgroundTasks !== undefined &&
          resolved.requestedBackgroundTasks !== resolved.backgroundTasks
            ? { requestedBackgroundTasks: resolved.requestedBackgroundTasks }
            : {}),
          ...(resolved.backgroundTasksCeiling !== undefined
            ? { backgroundTasksCeiling: resolved.backgroundTasksCeiling }
            : {}),
        }
      : {}),
  };
}
