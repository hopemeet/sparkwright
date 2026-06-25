import type { PermissionMode } from "@sparkwright/protocol";

export const TUI_PERMISSION_MODES = [
  "read-only",
  "ask",
  "accept-edits",
  "bypass",
] as const;

export type TuiPermissionMode = (typeof TUI_PERMISSION_MODES)[number];

export interface CoreRunPermissionFields {
  permissionMode: PermissionMode;
  shouldWrite: boolean;
}

export function isTuiPermissionMode(
  value: unknown,
): value is TuiPermissionMode {
  return (
    typeof value === "string" &&
    (TUI_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

export function toCoreRunFields(
  mode: TuiPermissionMode,
): CoreRunPermissionFields {
  switch (mode) {
    case "read-only":
      return {
        permissionMode: "plan",
        shouldWrite: false,
      };
    case "ask":
      return {
        permissionMode: "default",
        shouldWrite: true,
      };
    case "accept-edits":
      return {
        permissionMode: "accept_edits",
        shouldWrite: true,
      };
    case "bypass":
      return {
        permissionMode: "bypass_permissions",
        shouldWrite: true,
      };
  }
}

export function nextTuiPermissionMode(
  mode: TuiPermissionMode,
): TuiPermissionMode {
  const index = TUI_PERMISSION_MODES.indexOf(mode);
  return TUI_PERMISSION_MODES[(index + 1) % TUI_PERMISSION_MODES.length]!;
}

export function tuiPermissionModeFromCorePermissionMode(
  mode: PermissionMode | undefined,
): TuiPermissionMode | undefined {
  switch (mode) {
    case undefined:
      return undefined;
    case "plan":
      return "read-only";
    case "default":
      return "ask";
    case "accept_edits":
      return "accept-edits";
    case "bypass_permissions":
      return "bypass";
    case "dont_ask":
      return "read-only";
  }
}
