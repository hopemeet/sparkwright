import { join, resolve } from "node:path";
import { createSessionId } from "@sparkwright/core";
import type {
  ImApprovalResolveRequestPayload,
  ImBindRequestPayload,
  ImCancelRequestPayload,
  ImDeliveryAckRequestPayload,
  ImInspectRequestPayload,
  ImMessageRequestPayload,
  ImSubscribeRequestPayload,
  RunResumeRequestPayload,
  RunStartRequestPayload,
} from "@sparkwright/protocol";
import {
  ExecutionLaneCoordinator,
  type ExecutionDriver,
} from "@sparkwright/server-runtime";
import {
  HostRuntime,
  type HostExecutionCoordinatorPort,
  type HostExecutionMessage,
  type RuntimeOptions,
} from "./runtime.js";
import { WorkspaceContext, workspaceContextKey } from "./workspace-context.js";
import { WorkspaceLeaseCoordinator } from "./workspace-agent-arbiter.js";
import {
  acknowledgeHostImDeliveries,
  associateHostImRuntime,
  authorizeHostImBinding,
  bindHostImSession,
  createHostImControlState,
  recordHostImEvent,
  pendingHostImDeliveryCount,
  reopenHostImApproval,
  resolveHostImApproval,
  shouldRetainHostImRuntime,
  subscribeHostImSession,
  type HostImControlPolicy,
  type HostImPrincipal,
} from "./im-control.js";

export type HostRuntimeFacadeOptions = Omit<
  RuntimeOptions,
  "workspaceContext" | "workspaceLeaseCoordinator"
>;

/** Process-scoped Host composition root. */
export class HostService {
  private readonly workspaceContexts = new Map<string, WorkspaceContext>();
  private readonly workspaceLeases = new Map<
    string,
    WorkspaceLeaseCoordinator
  >();
  private readonly runtimes = new Set<HostRuntime>();
  private draining = false;
  private readonly startOutcomes = new Map<string, HostLaneOutcome>();
  private readonly coordinator: ExecutionLaneCoordinator<
    HostLaneInput,
    HostExecutionMessage,
    unknown
  >;
  private readonly coordinatorPort: HostExecutionCoordinatorPort;
  private readonly imControl;

  constructor(options: { imControl?: Partial<HostImControlPolicy> } = {}) {
    this.imControl = createHostImControlState(options.imControl);
    const driver: ExecutionDriver<
      HostLaneInput,
      HostExecutionMessage,
      unknown
    > = {
      start: async (input, context) => {
        const outcome =
          input.kind === "start"
            ? await input.runtime.startRunDirect(
                input.payload,
                context.executionId,
              )
            : await input.runtime.resumeRunDirect(
                input.payload,
                context.executionId,
                context.sessionId,
              );
        this.startOutcomes.set(context.executionId, outcome);
        if (!outcome.ok) throw new Error(outcome.error.message);
        const handle = input.runtime.executionDriverHandle(context.executionId);
        if (!handle) throw new Error("Host execution handle was not attached.");
        if (context.signal.aborted) handle.cancel("lane start aborted");
        return handle;
      },
    };
    this.coordinator = new ExecutionLaneCoordinator(driver);
    this.coordinatorPort = {
      startRun: (runtime, payload) => this.coordinateStart(runtime, payload),
      resumeRun: (runtime, payload) => this.coordinateResume(runtime, payload),
      injectRunMessage: (runtime, runId, input) => {
        const identity = runtime.executionIdentity();
        if (!identity?.sessionId) return runNotFound(runId);
        const accepted = this.coordinator.tryInject({
          laneKey: runtime.executionLaneKey(identity.sessionId),
          message: { runId, ...input },
        });
        return accepted === "accepted" ? { ok: true } : runNotFound(runId);
      },
      cancelRun: (runtime, runId, reason) => {
        const identity = runtime.executionIdentity();
        if (!identity || !identity.runIds.includes(runId))
          return runNotFound(runId);
        return this.coordinator.cancelExecution(identity.executionId, reason)
          ? { ok: true }
          : runNotFound(runId);
      },
    };
  }

  createRuntime(options: HostRuntimeFacadeOptions): HostRuntime {
    if (this.draining) throw new Error("HostService is draining.");
    const workspaceRoot = resolve(options.workspaceRoot);
    const sessionRootDir = resolve(
      options.sessionRootDir ?? join(workspaceRoot, ".sparkwright", "sessions"),
    );
    const lease =
      this.workspaceLeases.get(workspaceRoot) ??
      new WorkspaceLeaseCoordinator();
    this.workspaceLeases.set(workspaceRoot, lease);
    const key = workspaceContextKey({ workspaceRoot, sessionRootDir });
    const context =
      this.workspaceContexts.get(key) ??
      new WorkspaceContext({ workspaceRoot, sessionRootDir }, lease);
    this.workspaceContexts.set(key, context);
    const downstreamEmit = options.emit;
    const runtime = new HostRuntime({
      ...options,
      workspaceRoot,
      sessionRootDir,
      workspaceContext: context,
      workspaceLeaseCoordinator: lease,
      executionCoordinator: this.coordinatorPort,
      emit: (event) => {
        recordHostImEvent(this.imControl, runtime, event);
        downstreamEmit(event);
      },
    });
    this.runtimes.add(runtime);
    return runtime;
  }

  releaseRuntime(runtime: HostRuntime): void {
    if (shouldRetainHostImRuntime(this.imControl, runtime)) return;
    runtime.cleanup();
    this.runtimes.delete(runtime);
  }

  bindImSession(
    principal: HostImPrincipal,
    payload: ImBindRequestPayload,
    runtime?: HostRuntime,
  ) {
    return bindHostImSession(
      this.imControl,
      principal,
      payload,
      runtime ? (sessionId) => runtime.executionLaneKey(sessionId) : undefined,
    );
  }

  async dispatchImMessage(
    principal: HostImPrincipal,
    requestingRuntime: HostRuntime,
    payload: ImMessageRequestPayload,
  ) {
    const authorized = authorizeHostImBinding(this.imControl, principal, {
      ...payload,
      permission: "message",
    });
    if (!authorized.ok) return authorized;
    const binding = authorized.binding;
    const active = [...this.runtimes].find(
      (runtime) => runtime.executionIdentity()?.sessionId === binding.sessionId,
    );
    const activeIdentity = active?.executionIdentity();
    if (active && activeIdentity?.currentRunId) {
      const injected = active.injectRunMessage(activeIdentity.currentRunId, {
        content: payload.text,
        metadata: {
          ...(payload.metadata ?? {}),
          imBindingId: binding.bindingId,
          imMessageId: payload.messageId,
        },
      });
      if (injected.ok) {
        return {
          ok: true as const,
          sessionId: binding.sessionId,
          status: "injected" as const,
          runId: activeIdentity.currentRunId,
        };
      }
    }
    associateHostImRuntime(this.imControl, requestingRuntime, binding);
    const started = await requestingRuntime.startRun({
      goal: payload.text,
      sessionId: binding.sessionId,
      ...(payload.model ? { model: payload.model } : {}),
      metadata: {
        ...(payload.metadata ?? {}),
        imBindingId: binding.bindingId,
        imMessageId: payload.messageId,
      },
    });
    if (!started.ok) return started;
    return {
      ok: true as const,
      sessionId: binding.sessionId,
      status: "started" as const,
      runId: started.runId,
    };
  }

  subscribeImSession(
    principal: HostImPrincipal,
    payload: ImSubscribeRequestPayload,
  ) {
    return subscribeHostImSession(this.imControl, principal, payload);
  }

  acknowledgeImDeliveries(
    principal: HostImPrincipal,
    payload: ImDeliveryAckRequestPayload,
  ) {
    return acknowledgeHostImDeliveries(this.imControl, principal, payload);
  }

  resolveImApproval(
    principal: HostImPrincipal,
    payload: ImApprovalResolveRequestPayload,
  ) {
    const routed = resolveHostImApproval(this.imControl, principal, payload);
    if (!routed.ok) return routed;
    const runtime = this.findExecutionById(routed.executionId);
    if (!runtime) {
      reopenHostImApproval(this.imControl, payload.approvalId);
      return runNotFound(payload.approvalId, "approval_not_found");
    }
    const resolved = runtime.resolveApproval(
      payload.approvalId,
      payload.decision,
      payload.message,
    );
    if (!resolved.ok) reopenHostImApproval(this.imControl, payload.approvalId);
    return resolved;
  }

  cancelImSession(principal: HostImPrincipal, payload: ImCancelRequestPayload) {
    const permission =
      payload.scope === "lane" ? "cancel_lane" : "cancel_execution";
    const authorized = authorizeHostImBinding(this.imControl, principal, {
      ...payload,
      permission,
    });
    if (!authorized.ok) return authorized;
    const binding = authorized.binding;
    if (payload.scope === "lane") {
      return {
        ok: true as const,
        cancelled: this.coordinator.cancelLane(binding.laneKey, payload.reason),
      };
    }
    const runtime = [...this.runtimes].find(
      (candidate) =>
        candidate.executionIdentity()?.sessionId === binding.sessionId,
    );
    const executionId = runtime?.executionIdentity()?.executionId;
    return {
      ok: true as const,
      cancelled:
        executionId &&
        this.coordinator.cancelExecution(executionId, payload.reason)
          ? 1
          : 0,
    };
  }

  inspectImSession(
    principal: HostImPrincipal,
    payload: ImInspectRequestPayload,
  ) {
    const authorized = authorizeHostImBinding(this.imControl, principal, {
      ...payload,
      permission: "inspect",
    });
    if (!authorized.ok) return authorized;
    const binding = authorized.binding;
    const runtime = [...this.runtimes].find(
      (candidate) =>
        candidate.executionIdentity()?.sessionId === binding.sessionId,
    );
    const identity = runtime?.executionIdentity();
    return {
      ok: true as const,
      sessionId: binding.sessionId,
      active: Boolean(identity),
      ...(identity?.executionId ? { executionId: identity.executionId } : {}),
      ...(identity?.currentRunId ? { runId: identity.currentRunId } : {}),
      queuedDeliveries: pendingHostImDeliveryCount(this.imControl, binding),
    };
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
    await Promise.all([...this.runtimes].map((runtime) => runtime.drain()));
    this.runtimes.clear();
  }

  private async coordinateStart(
    runtime: HostRuntime,
    payload: RunStartRequestPayload,
  ): ReturnType<HostRuntime["startRunDirect"]> {
    const sessionId = payload.sessionId ?? createSessionId();
    const normalized = { ...payload, sessionId };
    return (await this.submit(runtime, sessionId, {
      kind: "start",
      runtime,
      payload: normalized,
    })) as HostStartOutcome;
  }

  private async coordinateResume(
    runtime: HostRuntime,
    payload: RunResumeRequestPayload,
  ): ReturnType<HostRuntime["resumeRunDirect"]> {
    const resolved = await runtime.resolveResumeSession(payload);
    if (!resolved.ok) return resolved;
    return (await this.submit(runtime, resolved.sessionId, {
      kind: "resume",
      runtime,
      payload,
    })) as HostResumeOutcome;
  }

  private async submit(
    runtime: HostRuntime,
    sessionId: string,
    input: HostLaneInput,
  ): Promise<HostLaneOutcome> {
    const submission = this.coordinator.submit({
      laneKey: runtime.executionLaneKey(sessionId),
      sessionId,
      digest: JSON.stringify({ kind: input.kind, payload: input.payload }),
      input,
    });
    if (submission.status !== "accepted") {
      return {
        ok: false,
        error: { code: "internal_error", message: submission.message },
      };
    }
    const result = await submission.result;
    const outcome = this.startOutcomes.get(submission.executionId);
    this.startOutcomes.delete(submission.executionId);
    if (outcome && !outcome.ok) return outcome;
    if (result.status !== "started" || !outcome) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message:
            result.status === "started"
              ? "execution outcome was not recorded"
              : (result.message ?? "execution failed to start"),
        },
      };
    }
    return outcome;
  }
}

type HostLaneInput =
  | { kind: "start"; runtime: HostRuntime; payload: RunStartRequestPayload }
  | { kind: "resume"; runtime: HostRuntime; payload: RunResumeRequestPayload };

type HostStartOutcome = Awaited<ReturnType<HostRuntime["startRunDirect"]>>;
type HostResumeOutcome = Awaited<ReturnType<HostRuntime["resumeRunDirect"]>>;
type HostLaneOutcome = HostStartOutcome | HostResumeOutcome;

function runNotFound(
  runId: string,
  code: "run_not_found" | "approval_not_found" = "run_not_found",
) {
  return {
    ok: false as const,
    error: {
      code,
      message: `no active execution for run ${runId}`,
    },
  };
}

export function createHostService(
  options: { imControl?: Partial<HostImControlPolicy> } = {},
): HostService {
  return new HostService(options);
}
