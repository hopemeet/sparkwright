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
}

/**
 * Compile a RunAccessMode to the internal runtime fields. This is the single
 * source of truth for the mapping; host, CLI, and TUI all route through it
 * rather than hand-mapping access modes to permission modes.
 */
export function compileRunAccessMode(mode: RunAccessMode): CompiledAccessMode {
  switch (mode) {
    case "read-only":
      return { permissionMode: "plan", shouldWrite: false };
    case "ask":
      return { permissionMode: "default", shouldWrite: true };
    case "accept-edits":
      return { permissionMode: "accept_edits", shouldWrite: true };
    case "bypass":
      return { permissionMode: "bypass_permissions", shouldWrite: true };
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
