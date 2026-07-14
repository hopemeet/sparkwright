import { join, resolve } from "node:path";
import { HostRuntime, type RuntimeOptions } from "./runtime.js";
import {
  WorkspaceContext,
  workspaceContextKey,
} from "./workspace-context.js";
import { WorkspaceLeaseCoordinator } from "./workspace-agent-arbiter.js";

export type HostRuntimeFacadeOptions = Omit<
  RuntimeOptions,
  "workspaceContext" | "workspaceLeaseCoordinator"
>;

/** Process-scoped Host composition root. */
export class HostService {
  private readonly workspaceContexts = new Map<string, WorkspaceContext>();
  private readonly workspaceLeases = new Map<string, WorkspaceLeaseCoordinator>();
  private readonly runtimes = new Set<HostRuntime>();
  private draining = false;

  createRuntime(options: HostRuntimeFacadeOptions): HostRuntime {
    if (this.draining) throw new Error("HostService is draining.");
    const workspaceRoot = resolve(options.workspaceRoot);
    const sessionRootDir = resolve(
      options.sessionRootDir ??
        join(workspaceRoot, ".sparkwright", "sessions"),
    );
    const lease =
      this.workspaceLeases.get(workspaceRoot) ?? new WorkspaceLeaseCoordinator();
    this.workspaceLeases.set(workspaceRoot, lease);
    const key = workspaceContextKey({ workspaceRoot, sessionRootDir });
    const context =
      this.workspaceContexts.get(key) ??
      new WorkspaceContext({ workspaceRoot, sessionRootDir }, lease);
    this.workspaceContexts.set(key, context);
    const runtime = new HostRuntime({
      ...options,
      workspaceRoot,
      sessionRootDir,
      workspaceContext: context,
      workspaceLeaseCoordinator: lease,
    });
    this.runtimes.add(runtime);
    return runtime;
  }

  releaseRuntime(runtime: HostRuntime): void {
    runtime.cleanup();
    this.runtimes.delete(runtime);
  }

  workspaceContextCount(): number {
    return this.workspaceContexts.size;
  }

  findExecutionById(executionId: string): HostRuntime | undefined {
    return [...this.runtimes].find(
      (runtime) => runtime.executionIdentity()?.executionId === executionId,
    );
  }

  findExecutionByRunId(runId: string): HostRuntime | undefined {
    return [...this.runtimes].find((runtime) =>
      runtime.executionIdentity()?.runIds.includes(runId),
    );
  }

  async shutdown(): Promise<void> {
    this.draining = true;
    for (const runtime of this.runtimes) runtime.cleanup();
    this.runtimes.clear();
  }
}

export function createHostService(): HostService {
  return new HostService();
}
