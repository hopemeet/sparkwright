// AI maintenance note: RunAccessMode is the single user-facing run autonomy
// knob. It compiles to the lower-level runtime fields (`permissionMode` +
// `shouldWrite`). `permissionMode` is kept only as an internal compile target;
// it is not a user-facing surface. See
// docs/_internal/proposals/agent-access-config-redesign.md.
//
// The wire-facing copy of ACCESS_MODES/RunAccessMode lives in
// @sparkwright/protocol (mirrored, like PermissionMode). Keep both in sync.

import type { PermissionMode } from "./policy.js";

export const ACCESS_MODES = [
  "read-only",
  "ask",
  "accept-edits",
  "bypass",
] as const;

export type RunAccessMode = (typeof ACCESS_MODES)[number];

export const BACKGROUND_TASK_POLICIES = [
  "disabled",
  "foreground-only",
  "enabled",
] as const;

export type BackgroundTaskPolicy = (typeof BACKGROUND_TASK_POLICIES)[number];

export function isRunAccessMode(value: unknown): value is RunAccessMode {
  return (
    typeof value === "string" &&
    (ACCESS_MODES as readonly string[]).includes(value)
  );
}

/**
 * Autonomy rank (lower = more restrictive). Mirrors the relevant span of
 * `PERMISSION_MODE_RANK` so layered config can merge access modes conservatively
 * (a lower-trust layer may clamp down but never relax). The `dont_ask`
 * permission mode is intentionally not representable as a RunAccessMode.
 */
export const ACCESS_MODE_RANK: Record<RunAccessMode, number> = {
  "read-only": 0,
  ask: 1,
  "accept-edits": 2,
  bypass: 3,
};

export interface CompiledAccessMode {
  permissionMode: PermissionMode;
  shouldWrite: boolean;
  backgroundTasks: BackgroundTaskPolicy;
}

/**
 * Compile a RunAccessMode to the internal runtime fields. This is the single
 * source of truth for the mapping; host, CLI, and TUI all route through it
 * rather than hand-mapping access modes to permission modes.
 */
export function compileRunAccessMode(mode: RunAccessMode): CompiledAccessMode {
  switch (mode) {
    case "read-only":
      return {
        permissionMode: "plan",
        shouldWrite: false,
        backgroundTasks: "enabled",
      };
    case "ask":
      return {
        permissionMode: "default",
        shouldWrite: true,
        backgroundTasks: "enabled",
      };
    case "accept-edits":
      return {
        permissionMode: "accept_edits",
        shouldWrite: true,
        backgroundTasks: "enabled",
      };
    case "bypass":
      return {
        permissionMode: "bypass_permissions",
        shouldWrite: true,
        backgroundTasks: "enabled",
      };
  }
}

/**
 * Return the more restrictive of two access modes (the lower rank). Used to
 * clamp a requested mode down to a ceiling (e.g. project ceiling clamps a
 * user/runtime request). On equal rank the requested value is returned.
 */
export function clampAccessMode(
  ceiling: RunAccessMode | undefined,
  requested: RunAccessMode | undefined,
): RunAccessMode | undefined {
  if (ceiling === undefined) return requested;
  if (requested === undefined) return ceiling;
  return ACCESS_MODE_RANK[requested] <= ACCESS_MODE_RANK[ceiling]
    ? requested
    : ceiling;
}

export const BACKGROUND_TASK_POLICY_RANK: Record<BackgroundTaskPolicy, number> =
  {
    disabled: 0,
    "foreground-only": 1,
    enabled: 2,
  };

export function isBackgroundTaskPolicy(
  value: unknown,
): value is BackgroundTaskPolicy {
  return (
    typeof value === "string" &&
    (BACKGROUND_TASK_POLICIES as readonly string[]).includes(value)
  );
}

export function clampBackgroundTaskPolicy(
  ceiling: BackgroundTaskPolicy | undefined,
  requested: BackgroundTaskPolicy | undefined,
): BackgroundTaskPolicy | undefined {
  if (ceiling === undefined) return requested;
  if (requested === undefined) return ceiling;
  return BACKGROUND_TASK_POLICY_RANK[requested] <=
    BACKGROUND_TASK_POLICY_RANK[ceiling]
    ? requested
    : ceiling;
}
