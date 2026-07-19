import { createBufferedEmitter, FileSessionStore } from "@sparkwright/core";
import { LocalWorkspace, MemoryTrace } from "@sparkwright/core/internal";
import type { HostExecutionPlan } from "./execution-plan.js";

export interface HostExecutionResources {
  readonly workspace: LocalWorkspace;
  readonly trace: MemoryTrace;
  readonly pendingExtensionEvents: ReturnType<typeof createBufferedEmitter>;
  readonly sessionStore: FileSessionStore;
}

/** Create mutable/live resources that must never be shared across executions. */
export function createExecutionResources(
  plan: HostExecutionPlan,
): HostExecutionResources {
  return {
    workspace: new LocalWorkspace(plan.workspaceRoot),
    trace: new MemoryTrace(),
    pendingExtensionEvents: createBufferedEmitter(),
    sessionStore: new FileSessionStore({ rootDir: plan.sessionRootDir }),
  };
}
