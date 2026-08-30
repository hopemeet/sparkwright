import { join, resolve } from "node:path";
import { createId, createSessionId } from "@sparkwright/core";
import type { TaskLifecycleUpdate } from "@sparkwright/agent-runtime";
import type {
  HostEvent,
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
  type ExecutionSubmission,
} from "@sparkwright/server-runtime";
import { HostRuntime } from "./runtime/host-runtime.js";
import type {
  HostExecutionCoordinatorPort,
  HostInjectMessageOutcome,
  HostExecutionMessage,
  HostExecutionMessageInput,
  HostExecutionCoordinatorRuntime,
  HostResumeRunOutcome,
  HostStartRunOutcome,
  RuntimeOptions,
} from "./runtime/contracts.js";
import { WorkspaceContext, workspaceContextKey } from "./workspace-context.js";
import { taskUpdatedEventPayload } from "./runtime/task-projections.js";
import { WorkspaceLeaseCoordinator } from "./workspace-lease-coordinator.js";
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
import {
  ProviderAuthManager,
  type ProviderAuthManagerOptions,
} from "./provider-auth.js";
import {
  ProjectTrustManager,
  type ProjectTrustManagerOptions,
} from "./project-trust.js";

const PROVIDER_CATALOG_REFRESH_POLL_MS = 6 * 60 * 60 * 1_000;

export type HostRuntimeFacadeOptions = RuntimeOptions;

/** Process-scoped Host composition root. */
export class HostService {
  private readonly workspaceContexts = new Map<string, WorkspaceContext>();
  private readonly workspaceLeases = new Map<
    string,
    WorkspaceLeaseCoordinator
  >();
  private readonly runtimes = new Set<HostRuntime>();
  private readonly runtimeEmits = new Map<
    HostRuntime,
    (event: HostEvent) => void
  >();
  private readonly runtimeContextKeys = new Map<HostRuntime, string>();
  private readonly taskRunRoutes = new Map<string, HostTaskEventRoute>();
  private readonly observedFollowUps = new Set<string>();
  private draining = false;
  private readonly startOutcomes = new Map<string, HostLaneOutcome>();
  private readonly coordinator: ExecutionLaneCoordinator<
    HostLaneInput,
    HostExecutionMessage,
    unknown
  >;
  private readonly coordinatorPort: HostExecutionCoordinatorPort;
  private readonly imControl;
  private readonly providerAuth: ProviderAuthManager;
  private readonly providerCatalogRefreshTimer: ReturnType<typeof setInterval>;
  private readonly projectTrust: ProjectTrustManager;

  constructor(
    options: {
      imControl?: Partial<HostImControlPolicy>;
      providerAuth?: ProviderAuthManager;
      providerAuthOptions?: ProviderAuthManagerOptions;
      projectTrust?: ProjectTrustManager;
      projectTrustOptions?: ProjectTrustManagerOptions;
    } = {},
  ) {
    this.imControl = createHostImControlState(options.imControl);
    this.providerAuth =
      options.providerAuth ??
      new ProviderAuthManager(options.providerAuthOptions);
    void this.providerAuth.refreshSignedCatalogIfDue().catch(() => {});
    this.providerCatalogRefreshTimer = setInterval(() => {
      void this.providerAuth.refreshSignedCatalogIfDue().catch(() => {});
    }, PROVIDER_CATALOG_REFRESH_POLL_MS);
    this.providerCatalogRefreshTimer.unref?.();
    this.projectTrust =
      options.projectTrust ??
      new ProjectTrustManager(options.projectTrustOptions);
    const driver: ExecutionDriver<
      HostLaneInput,
      HostExecutionMessage,
      unknown
    > = {
      start: async (input, context) => {
        const outcome =
          input.kind === "start"
            ? await input.runtime.startExecution(
                input.payload,
                context.executionId,
              )
            : await input.runtime.resumeExecution(
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
        if (!identity?.sessionId || !identity.runIds.includes(runId)) {
          return runNotFound(runId);
        }
        if (input.mode === "follow_up") {
          return this.queueFollowUp(runtime, runId, identity.sessionId, input);
        }
        const accepted = this.coordinator.tryInject({
          laneKey: runtime.executionLaneKey(identity.sessionId),
          message: { runId, ...input },
        });
        return accepted === "accepted"
          ? {
              ok: true,
              commandId: input.commandId,
              mode: input.mode,
              status: "queued",
            }
          : runNotFound(runId);
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
    let context = this.workspaceContexts.get(key);
    if (!context) {
      context = new WorkspaceContext({ workspaceRoot, sessionRootDir }, lease);
      context.taskLifecycle.subscribe((update) =>
        this.publishTaskLifecycleUpdate(key, update),
      );
      this.workspaceContexts.set(key, context);
    }
    const downstreamEmit = options.emit;
    const runtime = new HostRuntime({
      ...options,
      workspaceRoot,
      sessionRootDir,
      workspaceContext: context,
      workspaceLeaseCoordinator: lease,
      executionCoordinator: this.coordinatorPort,
      providerAuth: this.providerAuth,
      projectTrust: this.projectTrust,
      emit: (event) => {
        recordHostImEvent(this.imControl, runtime, event);
        downstreamEmit(event);
      },
    });
    this.runtimes.add(runtime);
    this.runtimeEmits.set(runtime, downstreamEmit);
    this.runtimeContextKeys.set(runtime, key);
    return runtime;
  }

  releaseRuntime(runtime: HostRuntime): void {
    if (shouldRetainHostImRuntime(this.imControl, runtime)) return;
    runtime.cleanup();
    this.runtimes.delete(runtime);
    this.runtimeEmits.delete(runtime);
    this.runtimeContextKeys.delete(runtime);
    for (const [runId, route] of this.taskRunRoutes) {
      if (route.runtime === runtime) this.taskRunRoutes.delete(runId);
    }
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
        commandId: createId("command") as string,
        mode: "steer",
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
    clearInterval(this.providerCatalogRefreshTimer);
    await Promise.all([...this.runtimes].map((runtime) => runtime.drain()));
    this.runtimes.clear();
    this.runtimeEmits.clear();
    this.runtimeContextKeys.clear();
    this.taskRunRoutes.clear();
    this.observedFollowUps.clear();
  }

  private async coordinateStart(
    runtime: HostExecutionCoordinatorRuntime,
    payload: RunStartRequestPayload,
  ): Promise<HostStartRunOutcome> {
    const sessionId = payload.sessionId ?? createSessionId();
    const normalized = { ...payload, sessionId };
    const outcome = (await this.submit(runtime, sessionId, {
      kind: "start",
      runtime,
      payload: normalized,
    })) as HostStartOutcome;
    if (outcome.ok && runtime instanceof HostRuntime) {
      this.rememberTaskRunRoute(runtime, outcome.runId, sessionId);
    }
    return outcome;
  }

  private async coordinateResume(
    runtime: HostExecutionCoordinatorRuntime,
    payload: RunResumeRequestPayload,
  ): Promise<HostResumeRunOutcome> {
    const resolved = await runtime.resolveResumeSession(payload);
    if (!resolved.ok) return resolved;
    const outcome = (await this.submit(runtime, resolved.sessionId, {
      kind: "resume",
      runtime,
      payload,
    })) as HostResumeOutcome;
    if (outcome.ok && runtime instanceof HostRuntime) {
      this.rememberTaskRunRoute(runtime, outcome.runId, resolved.sessionId);
    }
    return outcome;
  }

  private queueFollowUp(
    runtime: HostExecutionCoordinatorRuntime,
    previousRunId: string,
    sessionId: string,
    input: HostExecutionMessageInput,
  ): HostInjectMessageOutcome {
    const payload: RunStartRequestPayload = {
      ...runtime.followUpDefaults(previousRunId),
      goal: input.content,
      sessionId,
      ...(input.parts && input.parts.length > 0
        ? { input: { parts: [...input.parts] } }
        : {}),
      metadata: {
        ...(input.metadata ?? {}),
        interactionCommandId: input.commandId,
        interactionMode: "follow_up",
        previousRunId,
      },
    };
    const submission = this.coordinator.submit({
      laneKey: runtime.executionLaneKey(sessionId),
      sessionId,
      commandId: input.commandId,
      idempotencyKey: input.commandId,
      digest: JSON.stringify({ kind: "follow_up", payload }),
      input: { kind: "start", runtime, payload },
    });
    if (submission.status !== "accepted") {
      return {
        ok: false as const,
        error: {
          code: submission.status === "conflict" ? "conflict" : "capacity",
          message: submission.message,
        },
      };
    }
    this.observeFollowUpStart(runtime, previousRunId, sessionId, submission);
    return {
      ok: true as const,
      commandId: submission.commandId,
      mode: "follow_up" as const,
      status: "queued" as const,
    };
  }

  private observeFollowUpStart(
    runtime: HostExecutionCoordinatorRuntime,
    previousRunId: string,
    sessionId: string,
    submission: Extract<ExecutionSubmission, { status: "accepted" }>,
  ): void {
    if (this.observedFollowUps.has(submission.commandId)) return;
    this.observedFollowUps.add(submission.commandId);
    void submission.result.then((result) => {
      const outcome = this.startOutcomes.get(submission.executionId);
      this.startOutcomes.delete(submission.executionId);
      const started = result.status === "started" && outcome?.ok;
      const startFailureMessage =
        result.status === "started" ? undefined : result.message;
      if (started && runtime instanceof HostRuntime) {
        this.rememberTaskRunRoute(runtime, outcome.runId, sessionId);
      }
      this.publishFollowUpUpdate(runtime, {
        commandId: submission.commandId,
        previousRunId,
        sessionId,
        status: started ? "started" : "rejected",
        ...(started ? { runId: outcome.runId } : {}),
        ...(!started
          ? {
              message:
                (outcome && !outcome.ok
                  ? outcome.error.message
                  : startFailureMessage) ?? "follow-up run failed to start",
            }
          : {}),
      });
    });
  }

  private publishFollowUpUpdate(
    runtime: HostExecutionCoordinatorRuntime,
    payload: Extract<HostEvent, { kind: "run.follow_up.updated" }>["payload"],
  ): void {
    if (!(runtime instanceof HostRuntime)) return;
    const emit = this.runtimeEmits.get(runtime);
    if (!emit) return;
    const event: Extract<HostEvent, { kind: "run.follow_up.updated" }> = {
      envelope: "event",
      id: createId("evt"),
      kind: "run.follow_up.updated",
      timestamp: new Date().toISOString(),
      payload,
    };
    recordHostImEvent(this.imControl, runtime, event);
    try {
      emit(event);
    } catch {
      // The queued run remains authoritative even if live delivery is gone.
    }
  }

  private publishTaskLifecycleUpdate(
    contextKey: string,
    update: TaskLifecycleUpdate,
  ): void {
    let route = this.taskRunRoutes.get(update.record.parentRunId);
    if (!route) {
      for (const runtime of this.runtimes) {
        if (this.runtimeContextKeys.get(runtime) !== contextKey) continue;
        const identity = runtime.executionIdentity();
        if (!identity?.runIds.includes(update.record.parentRunId)) continue;
        route = {
          runtime,
          contextKey,
          ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
        };
        this.taskRunRoutes.set(update.record.parentRunId, route);
        break;
      }
    }
    if (!route || route.contextKey !== contextKey) return;
    const emit = this.runtimeEmits.get(route.runtime);
    if (!emit) return;
    const event: HostEvent = {
      envelope: "event",
      id: createId("evt"),
      kind: "task.updated",
      timestamp: new Date().toISOString(),
      payload: taskUpdatedEventPayload(update, route.sessionId),
    };
    recordHostImEvent(this.imControl, route.runtime, event);
    try {
      emit(event);
    } catch {
      // Live push is best-effort; task.list remains the reconciliation source.
    }
  }

  private rememberTaskRunRoute(
    runtime: HostRuntime,
    runId: string,
    sessionId: string,
  ): void {
    const contextKey = this.runtimeContextKeys.get(runtime);
    if (!contextKey) return;
    this.taskRunRoutes.set(runId, { runtime, contextKey, sessionId });
  }

  private async submit(
    runtime: HostExecutionCoordinatorRuntime,
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
  | {
      kind: "start";
      runtime: HostExecutionCoordinatorRuntime;
      payload: RunStartRequestPayload;
    }
  | {
      kind: "resume";
      runtime: HostExecutionCoordinatorRuntime;
      payload: RunResumeRequestPayload;
    };

type HostStartOutcome = HostStartRunOutcome;
type HostResumeOutcome = HostResumeRunOutcome;
type HostLaneOutcome = HostStartOutcome | HostResumeOutcome;

interface HostTaskEventRoute {
  runtime: HostRuntime;
  contextKey: string;
  sessionId?: string;
}

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
  options: {
    imControl?: Partial<HostImControlPolicy>;
    providerAuth?: ProviderAuthManager;
    providerAuthOptions?: ProviderAuthManagerOptions;
    projectTrust?: ProjectTrustManager;
    projectTrustOptions?: ProjectTrustManagerOptions;
  } = {},
): HostService {
  return new HostService(options);
}
