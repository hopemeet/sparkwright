import {
  createLayeredPolicy,
  createPermissionModePolicy,
  createWorkspaceMutationPolicy,
  createWorkspaceReadScopePolicy,
  resolveRunConfidentialPaths,
  type PermissionMode,
  type Policy,
} from "@sparkwright/core";
import type { WriteGuardrailsConfig } from "./config.js";

/**
 * Build one fresh, stateful policy for a Host-shaped run.
 *
 * The returned workspace mutation policy owns a per-run `writtenPaths` set and
 * must never be cached in the immutable security plan or shared across runs.
 * @internal
 */
export function createHostRunPolicy(input: {
  permissionMode: PermissionMode;
  shouldWrite: boolean;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  confidentialDefaults?: boolean;
  writeGuardrails?: WriteGuardrailsConfig;
}): Policy {
  // Explicit --target runs stay bounded to that single file. Untargeted write
  // runs get a small multi-file budget so real code+test changes can complete.
  // In-place edits need to remove the lines they replace, so deletions default
  // to permitted.
  return createLayeredPolicy([
    createPermissionModePolicy({ mode: input.permissionMode }),
    createWorkspaceMutationPolicy({
      allowWorkspaceWrites: input.shouldWrite,
      allowedPaths: input.targetPath ? [input.targetPath] : undefined,
      maxWriteFiles:
        input.writeGuardrails?.maxFiles ?? (input.targetPath ? 1 : 4),
      maxDiffLines: input.writeGuardrails?.maxDiffLines ?? 200,
      allowDeletions: input.writeGuardrails?.allowDeletions ?? true,
    }),
    createWorkspaceReadScopePolicy({
      confidentialPaths: resolveRunConfidentialPaths({
        confidentialDefaults: input.confidentialDefaults,
        confidentialPaths: input.confidentialPaths,
      }),
    }),
  ]);
}
