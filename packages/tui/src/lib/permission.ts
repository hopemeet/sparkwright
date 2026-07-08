import {
  clampHostClientAccessMode,
  nextHostClientAccessMode,
  resolveHostClientRunAccess,
} from "@sparkwright/host";
import {
  ACCESS_MODES,
  isRunAccessMode,
  type PermissionMode,
  type RunAccessMode,
} from "@sparkwright/protocol";

export const TUI_PERMISSION_MODES = ACCESS_MODES;

export type TuiPermissionMode = RunAccessMode;

export interface CoreRunPermissionFields {
  permissionMode: PermissionMode;
  shouldWrite: boolean;
}

export function isTuiPermissionMode(
  value: unknown,
): value is TuiPermissionMode {
  return isRunAccessMode(value);
}

export function toCoreRunFields(
  mode: TuiPermissionMode,
): CoreRunPermissionFields {
  const access = resolveHostClientRunAccess({ accessMode: mode });
  return {
    permissionMode: access.permissionMode,
    shouldWrite: access.shouldWrite,
  };
}

export function nextTuiPermissionMode(
  mode: TuiPermissionMode,
): TuiPermissionMode {
  return nextHostClientAccessMode(mode);
}

export function nextAllowedTuiPermissionMode(
  mode: TuiPermissionMode,
  ceiling: TuiPermissionMode | undefined,
): TuiPermissionMode {
  return nextHostClientAccessMode(mode, ceiling);
}

export function clampTuiPermissionMode(
  ceiling: TuiPermissionMode | undefined,
  requested: TuiPermissionMode,
): TuiPermissionMode {
  return clampHostClientAccessMode(ceiling, requested);
}
