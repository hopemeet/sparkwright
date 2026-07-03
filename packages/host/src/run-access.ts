import {
  clampBackgroundTaskPolicy,
  clampAccessMode,
  compileRunAccessMode,
  type BackgroundTaskPolicy,
  type PermissionMode,
  type RunAccessMode,
} from "@sparkwright/core";
import type {
  RunStartRequestPayload,
  RunResumeRequestPayload,
} from "@sparkwright/protocol";

export interface ResolvedRunAccess {
  permissionMode: PermissionMode;
  shouldWrite: boolean;
  accessMode?: RunAccessMode;
  requestedAccessMode?: RunAccessMode;
  accessModeCeiling?: RunAccessMode;
  backgroundTasks: BackgroundTaskPolicy;
  requestedBackgroundTasks?: BackgroundTaskPolicy;
  backgroundTasksCeiling?: BackgroundTaskPolicy;
  /** Legacy fields that `accessMode` overrode because they conflicted. */
  overriddenLegacyFields: string[];
}

export function payloadAllowsWorkspaceWrites(
  payload: RunStartRequestPayload | RunResumeRequestPayload,
  permissionMode: PermissionMode,
  defaultShouldWrite?: boolean,
): boolean {
  if (payload.shouldWrite !== undefined) return payload.shouldWrite;
  if (payload.metadata?.shouldWrite !== undefined) {
    return payload.metadata.shouldWrite === true;
  }
  if (defaultShouldWrite !== undefined) return defaultShouldWrite;
  // Legacy SDK clients may omit shouldWrite. Preserve the old host behavior
  // unless an entrypoint or embedder sets an explicit default.
  if (permissionMode === "plan") return false;
  return true;
}

/**
 * Resolve the effective run access fields from a run.start/run.resume payload.
 *
 * `accessMode` is the high-level autonomy knob. When present it is the single
 * source of truth: it compiles to `permissionMode` + `shouldWrite`, and a
 * conflicting legacy `permissionMode`/`shouldWrite` is ignored (recorded as a
 * note for diagnostics rather than silently honored). When `accessMode` is
 * absent the previous `permissionMode`/`shouldWrite`/default path is used.
 */
export function resolveRunAccessFields(
  payload: RunStartRequestPayload | RunResumeRequestPayload,
  opts: {
    defaultAccessMode?: RunAccessMode;
    accessModeCeiling?: RunAccessMode;
    defaultBackgroundTasks?: BackgroundTaskPolicy;
    backgroundTasksCeiling?: BackgroundTaskPolicy;
    defaultPermissionMode?: PermissionMode;
    defaultShouldWrite?: boolean;
  },
): ResolvedRunAccess {
  const backgroundTasks =
    clampBackgroundTaskPolicy(
      opts.backgroundTasksCeiling,
      payload.backgroundTasks ?? opts.defaultBackgroundTasks,
    ) ?? "enabled";
  const backgroundTaskFields = {
    backgroundTasks,
    ...(payload.backgroundTasks !== undefined &&
    payload.backgroundTasks !== backgroundTasks
      ? { requestedBackgroundTasks: payload.backgroundTasks }
      : {}),
    ...(opts.backgroundTasksCeiling !== undefined
      ? { backgroundTasksCeiling: opts.backgroundTasksCeiling }
      : {}),
  };
  const requestedAccessMode = payload.accessMode ?? opts.defaultAccessMode;
  if (requestedAccessMode !== undefined) {
    const accessMode =
      clampAccessMode(opts.accessModeCeiling, requestedAccessMode) ??
      requestedAccessMode;
    const compiled = compileRunAccessMode(accessMode);
    const overriddenLegacyFields: string[] = [];
    if (
      payload.permissionMode !== undefined &&
      payload.permissionMode !== compiled.permissionMode
    ) {
      overriddenLegacyFields.push("permissionMode");
    }
    if (
      payload.shouldWrite !== undefined &&
      payload.shouldWrite !== compiled.shouldWrite
    ) {
      overriddenLegacyFields.push("shouldWrite");
    }
    return {
      ...compiled,
      ...backgroundTaskFields,
      accessMode,
      ...(requestedAccessMode !== accessMode ? { requestedAccessMode } : {}),
      ...(opts.accessModeCeiling !== undefined
        ? { accessModeCeiling: opts.accessModeCeiling }
        : {}),
      overriddenLegacyFields,
    };
  }
  const permissionMode =
    payload.permissionMode ?? opts.defaultPermissionMode ?? "default";
  const requestedFromLegacy = accessModeFromPermissionMode(permissionMode);
  if (
    requestedFromLegacy !== undefined &&
    opts.accessModeCeiling !== undefined
  ) {
    const accessMode =
      clampAccessMode(opts.accessModeCeiling, requestedFromLegacy) ??
      requestedFromLegacy;
    const compiled = compileRunAccessMode(accessMode);
    if (accessMode !== requestedFromLegacy) {
      return {
        ...compiled,
        ...backgroundTaskFields,
        accessMode,
        requestedAccessMode: requestedFromLegacy,
        accessModeCeiling: opts.accessModeCeiling,
        overriddenLegacyFields: ["permissionMode", "shouldWrite"],
      };
    }
  }
  const shouldWrite = payloadAllowsWorkspaceWrites(
    payload,
    permissionMode,
    opts.defaultShouldWrite,
  );
  return {
    permissionMode,
    shouldWrite,
    ...backgroundTaskFields,
    overriddenLegacyFields: [],
  };
}

function accessModeFromPermissionMode(
  mode: PermissionMode,
): RunAccessMode | undefined {
  switch (mode) {
    case "plan":
      return "read-only";
    case "default":
      return "ask";
    case "accept_edits":
      return "accept-edits";
    case "bypass_permissions":
      return "bypass";
    case "dont_ask":
      return undefined;
  }
}

/**
 * Build run metadata that records the resolved access mode and any legacy
 * fields the access mode overrode, so the decision is inspectable in trace /
 * session metadata rather than silently applied.
 */
export function buildAccessMetadata(
  resolved: ResolvedRunAccess,
): Record<string, unknown> {
  const backgroundMetadata =
    resolved.backgroundTasks !== "enabled" ||
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
      : {};
  if (resolved.accessMode === undefined) return backgroundMetadata;
  return {
    accessMode: resolved.accessMode,
    ...(resolved.requestedAccessMode !== undefined &&
    resolved.requestedAccessMode !== resolved.accessMode
      ? { requestedAccessMode: resolved.requestedAccessMode }
      : {}),
    ...(resolved.accessModeCeiling !== undefined
      ? { accessModeCeiling: resolved.accessModeCeiling }
      : {}),
    ...(resolved.overriddenLegacyFields.length > 0
      ? { accessModeOverrodeLegacyFields: resolved.overriddenLegacyFields }
      : {}),
    ...backgroundMetadata,
  };
}
