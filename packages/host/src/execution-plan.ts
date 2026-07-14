import { join, resolve } from "node:path";
import type { TraceLevel } from "@sparkwright/core";
import type { ResolvedRunAccess } from "./run-access.js";

export interface HostExecutionPlan {
  readonly workspaceRoot: string;
  readonly sessionRootDir: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly modelRef?: string;
  readonly targetPath?: string;
  readonly traceLevel?: TraceLevel;
  readonly access: ResolvedRunAccess;
}

/** Resolve immutable execution identity before any live resource is created. */
export function resolveExecutionPlan(input: {
  workspaceRoot: string;
  sessionRootDir?: string;
  sessionId: string;
  goal: string;
  modelRef?: string;
  targetPath?: string;
  traceLevel?: TraceLevel;
  access: ResolvedRunAccess;
}): HostExecutionPlan {
  const workspaceRoot = resolve(input.workspaceRoot);
  return Object.freeze({
    workspaceRoot,
    sessionRootDir: resolve(
      input.sessionRootDir ?? join(workspaceRoot, ".sparkwright", "sessions"),
    ),
    sessionId: input.sessionId,
    goal: input.goal,
    modelRef: input.modelRef,
    targetPath: input.targetPath,
    traceLevel: input.traceLevel,
    access: Object.freeze({ ...input.access }),
  });
}
