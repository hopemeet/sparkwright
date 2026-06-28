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

const TUI_PERMISSION_MODE_RANK: Record<TuiPermissionMode, number> = {
  "read-only": 0,
  ask: 1,
  "accept-edits": 2,
  bypass: 3,
};

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

export function nextAllowedTuiPermissionMode(
  mode: TuiPermissionMode,
  ceiling: TuiPermissionMode | undefined,
): TuiPermissionMode {
  if (ceiling === undefined) return nextTuiPermissionMode(mode);
  const allowed = TUI_PERMISSION_MODES.filter(
    (candidate) =>
      TUI_PERMISSION_MODE_RANK[candidate] <= TUI_PERMISSION_MODE_RANK[ceiling],
  );
  const current = clampTuiPermissionMode(ceiling, mode);
  const index = allowed.indexOf(current);
  return allowed[(index + 1) % allowed.length]!;
}

export function clampTuiPermissionMode(
  ceiling: TuiPermissionMode | undefined,
  requested: TuiPermissionMode,
): TuiPermissionMode {
  if (ceiling === undefined) return requested;
  return TUI_PERMISSION_MODE_RANK[requested] <=
    TUI_PERMISSION_MODE_RANK[ceiling]
    ? requested
    : ceiling;
}
