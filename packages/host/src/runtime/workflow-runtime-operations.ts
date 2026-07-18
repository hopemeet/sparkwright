import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { asSessionId, type RunId, type RunResult } from "@sparkwright/core";
import {
  FileWorkflowControlInbox,
  FileWorkflowNotificationOutbox,
  FileWorkflowStore,
  WorkflowControlCommandProcessor,
  advanceWorkflowState,
  assertSafeWorkflowRunId,
  workspaceWorkflowRunsDir,
  type ActorInbox,
  type WorkflowControlCommand,
  type WorkflowControlCommandEnvelope,
  type WorkflowControlSourceIdentity,
  type WorkflowEvidenceRef,
  type WorkflowExecutableDefinition,
  type WorkflowLeaseBoundWriter,
  type WorkflowNodeDefinition,
  type WorkflowNodeVerdictLogEntry,
  type WorkflowRunFailure,
  type WorkflowRunId,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowRuntimeState,
} from "@sparkwright/agent-runtime";
import { InFlightCommandDispatcher } from "@sparkwright/server-runtime";
import type {
  ProtocolError,
  WorkflowListRequestPayload,
  WorkflowResumeRequestPayload,
  WorkflowRunSnapshot,
} from "@sparkwright/protocol";
import type { WorkflowProjectionStateSnapshot } from "../workflow-projection.js";

const WORKFLOW_LEASE_TTL_MS = 30 * 60 * 1000;
const WORKFLOW_CONTROL_EXPIRY_MS = 24 * 60 * 60 * 1_000;

export type WorkflowResumeResult =
  | { ok: true; runId: string; workflowRunId: string; sessionId?: string }
  | { ok: false; error: ProtocolError };

export interface WorkflowControlExecutionPort {
  hasExecution(): boolean;
  processActiveControls(workflowRunId: WorkflowRunId): Promise<void>;
  resume(payload: WorkflowResumeRequestPayload): Promise<WorkflowResumeResult>;
}

export interface WorkflowRuntimeOperationsOptions {
  workspaceRoot: string;
  notifications: FileWorkflowNotificationOutbox;
  controls: FileWorkflowControlInbox;
  dispatcher: InFlightCommandDispatcher;
}

export interface WorkflowRecordLocation {
  record: WorkflowRunRecord;
  store: FileWorkflowStore;
  sessionId: string;
}

export interface WorkflowRecordState {
  record?: WorkflowRunRecord;
  lease?: WorkflowLeaseBoundWriter;
}

export function workspaceWorkflowRootDir(workspaceRoot: string): string {
  return workspaceWorkflowRunsDir({ workspaceRoot });
}

export function workspaceWorkflowNotificationRootDir(
  workspaceRoot: string,
): string {
  return join(workspaceRoot, ".sparkwright", "workflow-actors");
}

export type WorkflowControlResult =
  | {
      ok: true;
      status: string;
      commandId: string;
      code?: string;
      runId?: string;
    }
  | { ok: false; error: ProtocolError };

/** Host-owned durable Workflow storage, notification, and control operations. */
export class WorkflowRuntimeOperations {
  readonly rootDir: string;
  readonly notificationRootDir: string;
  private readonly workspaceRoot: string;
  private readonly notifications: FileWorkflowNotificationOutbox;
  private readonly controls: FileWorkflowControlInbox;
  private readonly dispatcher: InFlightCommandDispatcher;

  constructor(options: WorkflowRuntimeOperationsOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.rootDir = workspaceWorkflowRootDir(options.workspaceRoot);
    this.notificationRootDir = workspaceWorkflowNotificationRootDir(
      options.workspaceRoot,
    );
    this.notifications = options.notifications;
    this.controls = options.controls;
    this.dispatcher = options.dispatcher;
  }

  createStore(options: { createRoot?: boolean } = {}): FileWorkflowStore {
    return new FileWorkflowStore({
      rootDir: this.rootDir,
      ...(options.createRoot !== undefined
        ? { createRoot: options.createRoot }
        : {}),
    });
  }

  actorInbox(): ActorInbox {
    return this.notifications;
  }

  async list(payload: WorkflowListRequestPayload = {}): Promise<
    | {
        ok: true;
        workflows: WorkflowRunSnapshot[];
        invalidEntries?: Array<{ path: string; code: string; reason: string }>;
      }
    | { ok: false; error: ProtocolError }
  > {
    let requestedSessionId: string | undefined;
    try {
      requestedSessionId = payload.sessionId
        ? asSessionId(payload.sessionId)
        : undefined;
    } catch (error) {
      return invalidPayload(error);
    }
    const listed = this.createStore({ createRoot: false }).list();
    const workflows = listed.records
      .filter(
        (record) =>
          (!requestedSessionId || record.sessionId === requestedSessionId) &&
          (!payload.status || record.status === payload.status),
      )
      .map(workflowRunSnapshot)
      .sort((left, right) =>
        (right.updatedAt ?? right.createdAt).localeCompare(
          left.updatedAt ?? left.createdAt,
        ),
      );
    return {
      ok: true,
      workflows:
        payload.limit && payload.limit > 0
          ? workflows.slice(0, payload.limit)
          : workflows,
      ...(listed.invalidEntries.length > 0
        ? { invalidEntries: listed.invalidEntries }
        : {}),
    };
  }

  async findRecord(
    workflowRunId: WorkflowRunId,
    sessionId?: string,
  ): Promise<
    | { ok: true; location: WorkflowRecordLocation }
    | { ok: false; error: ProtocolError }
  > {
    let requestedSessionId: string | undefined;
    try {
      assertSafeWorkflowRunId(workflowRunId);
      requestedSessionId = sessionId ? asSessionId(sessionId) : undefined;
    } catch (error) {
      return invalidPayload(error);
    }
    const store = this.createStore({ createRoot: false });
    const record = store.get(workflowRunId);
    if (
      !record ||
      (requestedSessionId && record.sessionId !== requestedSessionId)
    ) {
      return {
        ok: false,
        error: {
          code: "run_not_found",
          message: `Workflow run not found: ${workflowRunId}`,
        },
      };
    }
    const locatedSessionId = record.sessionId ?? requestedSessionId;
    if (!locatedSessionId) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow run ${workflowRunId} does not record a sessionId.`,
        },
      };
    }
    return {
      ok: true,
      location: { record, store, sessionId: locatedSessionId },
    };
  }

  deliverNotification(record: WorkflowRunRecord): void {
    if (
      record.status !== "completed" &&
      record.status !== "failed" &&
      record.status !== "waiting"
    ) {
      return;
    }
    if (record.status === "waiting" && !record.wait) return;
    const wait = record.wait;
    const runId = record.activeRunId ?? record.parentRunId;
    const source = {
      kind: "workflow" as const,
      id: record.id,
      ...(runId ? { runId } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    };
    const routeHint = {
      ...(runId ? { parentRunId: String(runId) } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    };
    if (record.status === "waiting") {
      this.notifications.deliver({
        source,
        routeHint,
        type: "waiting",
        correlationId: [
          record.id,
          "waiting",
          record.currentNodeId ?? "unknown",
          wait?.id ?? wait?.approvalId ?? wait?.taskId ?? "unspecified",
        ].join(":"),
        payload: {
          workflowId: record.id,
          name: record.assetName,
          summary: `Workflow ${record.assetName} is waiting.`,
          wait: record.wait!,
          metadata: {
            assetName: record.assetName,
            version: record.version,
            packageHash: record.packageHash,
            packageHashPolicyVersion: record.packageHashPolicyVersion,
            currentNodeId: record.currentNodeId,
            generation: record.generation,
            status: record.status,
          },
        },
      });
      return;
    }
    if (record.status === "completed") {
      this.notifications.deliver({
        source,
        routeHint,
        type: "completed",
        correlationId: `${record.id}:completed`,
        payload: {
          workflowId: record.id,
          name: record.assetName,
          summary: `Workflow ${record.assetName} completed.`,
          metadata: {
            assetName: record.assetName,
            version: record.version,
            packageHash: record.packageHash,
            packageHashPolicyVersion: record.packageHashPolicyVersion,
          },
        },
      });
      return;
    }
    const failure: WorkflowRunFailure = record.failure ?? {
      kind: "runtime",
      code: "workflow.runtime",
      message: "Workflow failed.",
    };
    this.notifications.deliver({
      source,
      routeHint,
      type: "failed",
      correlationId: `${record.id}:failed`,
      payload: {
        workflowId: record.id,
        name: record.assetName,
        summary: `Workflow ${record.assetName} failed.`,
        error: {
          code: failure.code.startsWith("workflow.")
            ? failure.code
            : `workflow.${failure.kind}`,
          message: failure.message,
          metadata: {
            ...failure.metadata,
            kind: failure.kind,
            nodeId: failure.nodeId,
          },
        },
      },
    });
  }

  async finalizeAfterRun(
    state: WorkflowRecordState,
    runId: RunId,
    result: RunResult,
  ): Promise<WorkflowRecordState> {
    if (!state.lease || !state.record) return state;
    const latest = (await state.lease.readFresh()) ?? state.record;
    if (
      latest.status === "waiting" ||
      isTerminalWorkflowRunStatus(latest.status)
    ) {
      this.deliverNotification(latest);
      await state.lease.release();
      return { record: latest };
    }
    let record = latest;
    if (result.state === "cancelled") {
      record = await mutateWorkflowRecord(state.lease, latest, {
        status: "cancelled",
        activeRunId: runId,
        failure: {
          kind: "cancelled",
          code: "workflow.cancelled",
          message: result.stopReason ?? "manual_cancelled",
        },
        metadata: { finalizedFromRunEnd: true },
      });
    } else if (result.state === "failed") {
      record = await mutateWorkflowRecord(state.lease, latest, {
        status: "failed",
        activeRunId: runId,
        failure: {
          kind: "runtime",
          code: "workflow.runtime",
          message: result.stopReason
            ? `Run failed before workflow completed: ${result.stopReason}`
            : "Run failed before workflow completed.",
          metadata: {
            stopReason: result.stopReason,
            runFailure: result.failure,
          },
        },
        metadata: { finalizedFromRunEnd: true },
      });
    } else {
      record = await mutateWorkflowRecord(state.lease, latest, {
        status: "failed",
        activeRunId: runId,
        failure: {
          kind: "runtime",
          code: "workflow.runtime",
          message: "Run completed before workflow reached a terminal state.",
        },
        metadata: { finalizedFromRunEnd: true },
      });
    }
    this.deliverNotification(record);
    await state.lease.release();
    return { record };
  }

  async finalizeAfterSupervisorError(
    state: WorkflowRecordState,
    runId: RunId | undefined,
    cause: unknown,
  ): Promise<WorkflowRecordState> {
    if (!state.lease || !state.record) return state;
    const latest = (await state.lease.readFresh()) ?? state.record;
    if (
      latest.status === "waiting" ||
      isTerminalWorkflowRunStatus(latest.status)
    ) {
      this.deliverNotification(latest);
      await state.lease.release();
      return { record: latest };
    }
    const message =
      cause instanceof Error
        ? cause.message
        : cause
          ? String(cause)
          : "unknown";
    const record = await mutateWorkflowRecord(state.lease, latest, {
      status: "failed",
      ...(runId ? { activeRunId: runId } : {}),
      failure: {
        kind: "runtime",
        code: "workflow.runtime",
        message: `Run supervisor failed before workflow completed: ${message}`,
        metadata: { supervisorError: message },
      },
      metadata: { finalizedFromSupervisorError: true },
    });
    this.deliverNotification(record);
    await state.lease.release();
    return { record };
  }

  async control(
    input: {
      workflowRunId: string;
      sessionId?: string;
      commandId?: string;
      idempotencyKey: string;
      source: WorkflowControlSourceIdentity;
      expected?: {
        generation?: number;
        status?: WorkflowRunStatus;
        waitId?: string;
      };
      command: WorkflowControlCommand;
    },
    execution: WorkflowControlExecutionPort,
  ): Promise<WorkflowControlResult> {
    const located = await this.findRecord(
      input.workflowRunId as WorkflowRunId,
      input.sessionId,
    );
    if (!located.ok) return located;
    const { record, store, sessionId } = located.location;
    const accepted = await this.controls.accept(
      {
        workflowRunId: record.id,
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        source: input.source,
        authorization: {
          workspaceId: this.workspaceRoot,
          sessionId,
          workflowRunId: record.id,
          allowedCommandKinds: [input.command.kind],
        },
        expected: {
          generation:
            input.expected?.generation ?? store.canonicalGeneration(record.id),
          status: input.expected?.status ?? record.status,
          ...(input.expected?.waitId
            ? { waitId: input.expected.waitId }
            : record.wait?.id
              ? { waitId: record.wait.id }
              : {}),
        },
        command: input.command,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(
          Date.now() + WORKFLOW_CONTROL_EXPIRY_MS,
        ).toISOString(),
      },
      { trustedSystemSource: input.source.kind === "system" },
    );
    if (accepted.status === "conflict")
      return idempotencyConflict(accepted.commandId);
    return this.processAcceptedControl(accepted.envelope, execution);
  }

  async processAcceptedControl(
    envelope: WorkflowControlCommandEnvelope,
    execution: WorkflowControlExecutionPort,
  ): Promise<WorkflowControlResult> {
    const located = await this.findRecord(
      envelope.workflowRunId,
      envelope.authorization.sessionId,
    );
    if (!located.ok) return located;
    const { record, store, sessionId } = located.location;
    return this.dispatcher.dispatch(envelope.commandId, async () => {
      await execution.processActiveControls(record.id);
      const existingOutcome = await this.controls.outcome(
        record.id,
        envelope.commandId,
      );
      if (existingOutcome) {
        return {
          ok: true as const,
          status: existingOutcome.status,
          commandId: existingOutcome.commandId,
          code: existingOutcome.code,
        };
      }
      const processor = this.controlProcessor(store);
      const processed = await processor.processNext(
        record.id,
        envelope.commandId,
      );
      if (processed.status === "dispatch_required") {
        if (execution.hasExecution()) {
          return {
            ok: true as const,
            status: "accepted",
            commandId: processed.envelope.commandId,
            code: "dispatch_waiting",
          };
        }
        const resumed = await execution.resume({
          workflowRunId: record.id,
          sessionId,
        });
        await processor.completeDispatch(processed.envelope, {
          applied: resumed.ok,
          code: resumed.ok ? "resume_dispatched" : resumed.error.code,
          ...(!resumed.ok ? { message: resumed.error.message } : {}),
        });
        return resumed.ok
          ? {
              ok: true as const,
              status: "applied",
              commandId: processed.envelope.commandId,
              code: "resume_dispatched",
              runId: resumed.runId,
            }
          : resumed;
      }
      if (processed.status === "terminal") {
        return {
          ok: true as const,
          status: processed.outcome.status,
          commandId: processed.outcome.commandId,
          code: processed.outcome.code,
        };
      }
      return {
        ok: true as const,
        status: processed.status === "busy" ? "accepted" : processed.status,
        commandId: envelope.commandId,
        ...(processed.status === "busy" ? { code: "consumer_busy" } : {}),
      };
    });
  }

  async processControlCommand(
    input: { workflowRunId: string; sessionId?: string; commandId: string },
    execution: WorkflowControlExecutionPort,
  ): Promise<WorkflowControlResult> {
    const located = await this.findRecord(
      input.workflowRunId as WorkflowRunId,
      input.sessionId,
    );
    if (!located.ok) return located;
    const envelope = this.controls
      .snapshot(located.location.record.id)
      .commands.find((candidate) => candidate.commandId === input.commandId);
    if (!envelope) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Durable workflow control command was not found: ${input.commandId}`,
        },
      };
    }
    return this.processAcceptedControl(envelope, execution);
  }

  async resumeThroughControl(
    payload: WorkflowResumeRequestPayload,
    source: WorkflowControlSourceIdentity,
    resume: (
      payload: WorkflowResumeRequestPayload,
    ) => Promise<WorkflowResumeResult>,
  ): Promise<WorkflowResumeResult> {
    const located = await this.findRecord(
      payload.workflowRunId as WorkflowRunId,
      payload.sessionId,
    );
    if (!located.ok) return located;
    const { record, store, sessionId } = located.location;
    const idempotencyKey =
      typeof payload.metadata?.controlIdempotencyKey === "string"
        ? payload.metadata.controlIdempotencyKey
        : `workflow-resume-${randomUUID()}`;
    const accepted = await this.controls.accept({
      workflowRunId: record.id,
      idempotencyKey,
      source,
      authorization: {
        workspaceId: this.workspaceRoot,
        sessionId,
        workflowRunId: record.id,
        allowedCommandKinds: ["resume_request"],
      },
      expected: {
        generation: store.canonicalGeneration(record.id),
        status: record.status,
        ...(record.wait?.id ? { waitId: record.wait.id } : {}),
      },
      command: {
        kind: "resume_request",
        ...(record.wait?.id ? { waitId: record.wait.id } : {}),
      },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + WORKFLOW_CONTROL_EXPIRY_MS,
      ).toISOString(),
    });
    if (accepted.status === "conflict") {
      return idempotencyConflict(accepted.commandId);
    }
    const processor = this.controlProcessor(store);
    const processed = await processor.processNext(
      record.id,
      accepted.envelope.commandId,
    );
    if (processed.status === "terminal") {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message:
            processed.outcome.message ??
            `Workflow control command ${processed.outcome.code}.`,
        },
      };
    }
    if (processed.status !== "dispatch_required") {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: `Workflow control command is ${processed.status}.`,
        },
      };
    }
    const resumed = await resume({
      ...payload,
      workflowRunId: processed.envelope.workflowRunId,
      sessionId,
    });
    await processor.completeDispatch(processed.envelope, {
      applied: resumed.ok,
      code: resumed.ok ? "resume_dispatched" : resumed.error.code,
      ...(!resumed.ok ? { message: resumed.error.message } : {}),
    });
    return resumed;
  }

  validateClaimedWriter(
    payload: WorkflowResumeRequestPayload,
    writer: WorkflowLeaseBoundWriter,
  ): { ok: true } | { ok: false; error: ProtocolError } {
    if (writer.workflowRunId === payload.workflowRunId) return { ok: true };
    return {
      ok: false,
      error: {
        code: "invalid_payload",
        message:
          "Claimed workflow writer identity does not match the resume request.",
      },
    };
  }

  async processLiveControls(input: {
    store: FileWorkflowStore;
    writer: WorkflowLeaseBoundWriter;
    record: WorkflowRunRecord;
    cancel: () => void;
  }): Promise<WorkflowRunRecord> {
    const processor = new WorkflowControlCommandProcessor({
      inbox: this.controls,
      store: input.store,
      writer: input.writer,
      workspaceId: this.workspaceRoot,
    });
    const result = await processor.processNext(input.record.id);
    let record = input.record;
    if (
      result.status === "terminal" &&
      result.outcome.status === "applied" &&
      result.outcome.code === "applied" &&
      record.status !== "cancelled"
    ) {
      record = (await input.writer.readFresh()) ?? record;
    }
    if (record.status === "cancelled") input.cancel();
    return record;
  }

  async mutate(
    writer: WorkflowLeaseBoundWriter | undefined,
    record: WorkflowRunRecord,
    patch: Parameters<WorkflowLeaseBoundWriter["mutate"]>[0]["patch"],
    eventType?: Parameters<
      WorkflowLeaseBoundWriter["mutate"]
    >[0]["event"]["type"],
  ): Promise<WorkflowRunRecord> {
    return mutateWorkflowRecord(writer, record, patch, eventType);
  }

  compensate(
    writer: WorkflowLeaseBoundWriter | undefined,
    current: WorkflowRunRecord,
    prior: WorkflowRunRecord,
    reason: string,
  ): Promise<WorkflowRunRecord> {
    return compensateWorkflowRecord(writer, current, prior, reason);
  }

  consumeWaitingInput(
    writer: WorkflowLeaseBoundWriter | undefined,
    record: WorkflowRunRecord,
    metadata: Record<string, unknown> | undefined,
  ): Promise<WorkflowRunRecord> {
    return consumeWorkflowActorWaitingInput(writer, record, { metadata });
  }

  waitingInputMetadata(
    record: WorkflowRunRecord,
    fallback: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    return workflowWaitingInputMetadata(record, fallback);
  }

  runtimeState(record: WorkflowRunRecord): WorkflowRuntimeState {
    return runtimeStateFromWorkflowRecord(record);
  }

  completedNodeIds(
    record: WorkflowRunRecord,
    definition: WorkflowExecutableDefinition,
  ): string[] {
    return completedWorkflowNodeIds(record, definition);
  }

  appendEvidenceRef(
    refs: readonly WorkflowEvidenceRef[],
    ref: WorkflowEvidenceRef,
  ): WorkflowEvidenceRef[] {
    return appendWorkflowEvidenceRef(refs, ref);
  }

  persistProjectionSnapshot(
    writer: WorkflowLeaseBoundWriter,
    record: WorkflowRunRecord,
    snapshot: WorkflowProjectionStateSnapshot,
  ): Promise<WorkflowRunRecord> {
    return persistWorkflowProjectionSnapshot(writer, record, snapshot);
  }

  appendEpisodeUsage(
    metadata: Record<string, unknown>,
    entry: {
      runId: RunId;
      state: RunResult["state"];
      stopReason?: RunResult["stopReason"];
      episode?: Record<string, unknown>;
      usage: Record<string, unknown>;
    },
  ): Record<string, unknown> {
    return appendWorkflowEpisodeUsage(metadata, entry);
  }

  isTerminalStatus(status: WorkflowRunStatus): boolean {
    return isTerminalWorkflowRunStatus(status);
  }

  startLeaseRefresh(lease: WorkflowLeaseBoundWriter | undefined): () => void {
    if (!lease) return () => {};
    const refreshMs = Math.max(1_000, Math.floor(WORKFLOW_LEASE_TTL_MS / 2));
    const timer = setInterval(() => {
      void lease.refresh(WORKFLOW_LEASE_TTL_MS).catch(() => {});
    }, refreshMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  leaseOwner(): string {
    return `host:${process.pid}`;
  }

  leaseTtlMs(): number {
    return WORKFLOW_LEASE_TTL_MS;
  }

  private controlProcessor(
    store: FileWorkflowStore,
  ): WorkflowControlCommandProcessor {
    return new WorkflowControlCommandProcessor({
      inbox: this.controls,
      store,
      workspaceId: this.workspaceRoot,
      owner: this.leaseOwner(),
      leaseTtlMs: WORKFLOW_LEASE_TTL_MS,
    });
  }
}

function invalidPayload(error: unknown): { ok: false; error: ProtocolError } {
  return {
    ok: false,
    error: {
      code: "invalid_payload",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function idempotencyConflict(commandId: string): {
  ok: false;
  error: ProtocolError;
} {
  return {
    ok: false,
    error: {
      code: "invalid_payload",
      message: `Workflow control idempotency conflict: ${commandId}`,
    },
  };
}

function workflowWaitingInputMetadata(
  record: WorkflowRunRecord,
  fallback: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const staged = record.metadata.pendingWorkflowControlInput;
  if (!isPlainRecord(staged) || typeof staged.value !== "string") {
    return fallback ?? {};
  }
  return {
    ...(fallback ?? {}),
    workflowControlInput: {
      value: staged.value,
      commandId:
        typeof staged.commandId === "string" ? staged.commandId : undefined,
      waitId: typeof staged.waitId === "string" ? staged.waitId : undefined,
      source: isPlainRecord(staged.source) ? staged.source : undefined,
    },
  };
}

async function consumeWorkflowActorWaitingInput(
  writer: WorkflowLeaseBoundWriter | undefined,
  record: WorkflowRunRecord,
  input: { metadata?: Record<string, unknown> },
): Promise<WorkflowRunRecord> {
  if (!writer)
    throw new Error(`Workflow run ${record.id} has no lease-bound writer.`);
  if (record.status !== "waiting") return record;
  if (!record.wait) {
    throw new Error(`Workflow run ${record.id} is waiting without wait state.`);
  }
  if (record.wait.kind !== "input") {
    throw new Error(
      `Workflow run ${record.id} is waiting for ${record.wait.kind}; workflow.resume can only consume input waits in P3 Step 3.`,
    );
  }
  if (!record.currentNodeId) {
    throw new Error(
      `Workflow run ${record.id} is waiting without a current node.`,
    );
  }
  const node = record.definitionSnapshot.nodes.find(
    (candidate) => candidate.id === record.currentNodeId,
  );
  if (!node || node.execute !== "human") {
    throw new Error(
      `Workflow run ${record.id} input wait is not positioned on a human node.`,
    );
  }
  const attempt = record.attempts[node.id] ?? 1;
  const verdict = {
    status: "passed" as const,
    reason: "human_input_received",
    metadata: { wait: record.wait, resumeMetadata: input.metadata ?? {} },
  };
  const advanced = advanceWorkflowState({
    definition: record.definitionSnapshot,
    state: runtimeStateFromWorkflowRecord(record),
    verdict,
  });
  const at = new Date().toISOString();
  const evidenceRef = {
    kind: "fact" as const,
    ref: `workflow-input:${record.id}:${at}`,
    nodeId: node.id,
    metadata: { wait: record.wait, resumeMetadata: input.metadata ?? {} },
  };
  const status = workflowStatusFromRuntimeState(advanced.state);
  return writer.mutate({
    expectedRevision: record.recordRevision,
    patch: {
      status,
      clearWait: true,
      ...(advanced.state.currentNodeId
        ? { currentNodeId: advanced.state.currentNodeId }
        : {}),
      attempts: advanced.state.attempts,
      evidenceRefs: appendWorkflowEvidenceRef(record.evidenceRefs, evidenceRef),
      verdictLog: [
        ...record.verdictLog,
        { at, nodeId: node.id, attempt, verdict, evidenceRefs: [evidenceRef] },
      ],
      transitionLog: advanced.state.transitionLog,
      metadata: {
        resumedFromWait: true,
        consumedWaitKind: record.wait.kind,
        consumedWaitNodeId: node.id,
        pendingWorkflowControlInput: null,
      },
      ...(advanced.state.failure
        ? {
            failure: {
              kind: "verdict" as const,
              code: "workflow.verdict",
              message: advanced.state.failure.reason,
              ...(advanced.state.failure.nodeId
                ? { nodeId: advanced.state.failure.nodeId }
                : {}),
              ...(advanced.state.failure.metadata
                ? { metadata: advanced.state.failure.metadata }
                : {}),
            },
          }
        : {}),
    },
    event: {
      at,
      type: "input",
      workflowRunId: record.id,
      parentRunId: record.parentRunId,
      status,
      metadata: {
        wait: record.wait,
        nodeId: node.id,
        decision: advanced.decision,
        resumeMetadata: input.metadata ?? {},
      },
    },
  });
}

function runtimeStateFromWorkflowRecord(
  record: WorkflowRunRecord,
): WorkflowRuntimeState {
  return {
    status:
      record.status === "completed"
        ? "completed"
        : record.status === "failed"
          ? "failed"
          : "running",
    ...(record.currentNodeId ? { currentNodeId: record.currentNodeId } : {}),
    attempts: { ...record.attempts },
    transitionLog: record.transitionLog.map((entry) => ({
      ...entry,
      verdict: cloneJsonLike(entry.verdict),
      decision: cloneJsonLike(entry.decision),
    })),
    ...(record.parallelBranches
      ? { parallelBranches: cloneJsonLike(record.parallelBranches) }
      : {}),
    ...(record.failure
      ? {
          failure: {
            reason: record.failure.message,
            nodeId: record.failure.nodeId,
            metadata: record.failure.metadata,
          },
        }
      : {}),
  };
}

function workflowStatusFromRuntimeState(
  state: WorkflowRuntimeState,
): WorkflowRunStatus {
  if (state.status === "completed") return "completed";
  if (state.status === "failed") return "failed";
  return "running";
}

async function mutateWorkflowRecord(
  writer: WorkflowLeaseBoundWriter | undefined,
  record: WorkflowRunRecord,
  patch: Parameters<WorkflowLeaseBoundWriter["mutate"]>[0]["patch"],
  eventType?: Parameters<
    WorkflowLeaseBoundWriter["mutate"]
  >[0]["event"]["type"],
): Promise<WorkflowRunRecord> {
  if (!writer)
    throw new Error(`Workflow run ${record.id} has no lease-bound writer.`);
  const status = patch.status ?? record.status;
  const type =
    eventType ??
    (status === "completed"
      ? "completed"
      : status === "failed"
        ? "failed"
        : status === "cancelled"
          ? "cancelled"
          : status === "waiting"
            ? "waiting"
            : "updated");
  return writer.mutate({
    expectedRevision: record.recordRevision,
    patch,
    event: {
      at: patch.now?.() ?? new Date().toISOString(),
      type,
      workflowRunId: record.id,
      parentRunId: record.parentRunId,
      status,
      metadata: {
        currentNodeId: patch.currentNodeId,
        wait: patch.wait,
        failure: patch.failure,
      },
    },
  });
}

async function compensateWorkflowRecord(
  writer: WorkflowLeaseBoundWriter | undefined,
  current: WorkflowRunRecord,
  prior: WorkflowRunRecord,
  reason: string,
): Promise<WorkflowRunRecord> {
  if (!writer)
    throw new Error(`Workflow run ${prior.id} has no lease-bound writer.`);
  const at = new Date().toISOString();
  return writer.compensate({
    expectedRevision: current.recordRevision,
    patch: {
      status: prior.status,
      ...(prior.currentNodeId ? { currentNodeId: prior.currentNodeId } : {}),
      ...(prior.wait ? { wait: prior.wait } : { clearWait: true }),
      attempts: prior.attempts,
      parallelBranches: prior.parallelBranches,
      evidenceRefs: prior.evidenceRefs,
      verdictLog: prior.verdictLog,
      transitionLog: prior.transitionLog,
      ...(prior.failure ? { failure: prior.failure } : { clearFailure: true }),
      metadata: {
        compensationReason: reason,
        compensatesRevision: current.recordRevision,
      },
      now: () => at,
    },
    event: {
      at,
      type: prior.status === "waiting" ? "waiting" : "updated",
      workflowRunId: prior.id,
      parentRunId: prior.parentRunId,
      status: prior.status,
      metadata: {
        compensation: true,
        reason,
        compensatesRevision: current.recordRevision,
      },
    },
  });
}

function completedWorkflowNodeIds(
  record: WorkflowRunRecord,
  definition: WorkflowExecutableDefinition,
): string[] {
  const currentNodeId = record.currentNodeId;
  const verifierNodeIds = new Set(
    definition.nodes
      .filter((node) => (node.verify?.length ?? 0) > 0)
      .map((node) => node.id),
  );
  const latestVerifierVerdicts = new Map<string, WorkflowNodeVerdictLogEntry>();
  for (const entry of record.verdictLog) {
    if (entry.nodeId === currentNodeId) continue;
    if (!verifierNodeIds.has(entry.nodeId)) continue;
    latestVerifierVerdicts.set(entry.nodeId, entry);
  }
  return definition.nodes
    .map((node) => node.id)
    .filter(
      (nodeId) =>
        latestVerifierVerdicts.get(nodeId)?.verdict.status === "passed",
    );
}

function appendWorkflowEvidenceRef(
  refs: readonly WorkflowEvidenceRef[],
  ref: WorkflowEvidenceRef,
): WorkflowEvidenceRef[] {
  if (
    refs.some(
      (existing) =>
        existing.kind === ref.kind &&
        existing.ref === ref.ref &&
        existing.nodeId === ref.nodeId &&
        existing.verifierId === ref.verifierId,
    )
  ) {
    return refs.map((existing) => ({ ...existing }));
  }
  return [...refs.map((existing) => ({ ...existing })), { ...ref }];
}

function workflowRunSnapshot(record: WorkflowRunRecord): WorkflowRunSnapshot {
  return {
    id: record.id,
    generation: record.generation,
    recordRevision: record.recordRevision,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    status: record.status,
    assetName: record.assetName,
    layer: record.layer,
    ...(record.version ? { version: record.version } : {}),
    packageHash: record.packageHash,
    packageHashPolicyVersion: record.packageHashPolicyVersion,
    ...(record.activeRunId ? { activeRunId: record.activeRunId } : {}),
    runIds: record.runIds.map(String),
    ...(record.currentNodeId ? { currentNodeId: record.currentNodeId } : {}),
    attempts: { ...record.attempts },
    ...(record.verdictLog.length > 0
      ? {
          latestVerdict: (() => {
            const latest = record.verdictLog[record.verdictLog.length - 1]!;
            return {
              nodeId: latest.nodeId,
              attempt: latest.attempt,
              verdict: cloneJsonLike(latest.verdict) as Record<string, unknown>,
              ...(latest.at ? { at: latest.at } : {}),
            };
          })(),
        }
      : {}),
    ...(record.wait
      ? {
          wait: {
            ...record.wait,
            metadata: record.wait.metadata
              ? { ...record.wait.metadata }
              : undefined,
          },
        }
      : {}),
    ...(record.failure
      ? {
          failure: {
            ...record.failure,
            metadata: record.failure.metadata
              ? { ...record.failure.metadata }
              : undefined,
          },
        }
      : {}),
    resume: { ...record.resume },
    ...(record.authorizationSnapshot
      ? {
          authorizationSnapshot: {
            hasTargetPath: Boolean(record.authorizationSnapshot.targetPath),
            hasConfidentialPaths:
              record.authorizationSnapshot.confidentialPaths.length > 0,
            confidentialDefaults:
              record.authorizationSnapshot.confidentialDefaults,
            accessMode: record.authorizationSnapshot.accessMode,
            backgroundTasks: record.authorizationSnapshot.backgroundTasks,
          },
        }
      : {}),
    createdAt: record.createdAt,
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    metadata: { ...record.metadata },
  };
}

async function persistWorkflowProjectionSnapshot(
  writer: WorkflowLeaseBoundWriter,
  record: WorkflowRunRecord,
  snapshot: WorkflowProjectionStateSnapshot,
): Promise<WorkflowRunRecord> {
  if (isTerminalWorkflowRunStatus(record.status)) return record;
  const state = snapshot.state;
  const verdictLog =
    snapshot.verdict && snapshot.nodeId && snapshot.attempt !== undefined
      ? [
          ...record.verdictLog,
          {
            at: new Date().toISOString(),
            nodeId: snapshot.nodeId,
            attempt: snapshot.attempt,
            verdict: cloneJsonLike(snapshot.verdict),
            evidenceRefs: snapshot.evidenceRefs?.map((ref) => ({
              ...ref,
              metadata: ref.metadata ? { ...ref.metadata } : undefined,
            })),
          },
        ]
      : record.verdictLog;
  const evidenceRefs =
    snapshot.evidenceRefs && snapshot.evidenceRefs.length > 0
      ? snapshot.evidenceRefs.reduce(
          (refs, ref) => appendWorkflowEvidenceRef(refs, ref),
          record.evidenceRefs,
        )
      : record.evidenceRefs;
  const status =
    snapshot.phase === "waiting"
      ? "waiting"
      : (snapshot.terminalStatus ??
        (state.status === "completed"
          ? "completed"
          : state.status === "failed"
            ? "failed"
            : "running"));
  const failure = snapshot.failure
    ? ({
        kind: snapshot.failure.kind,
        code: snapshot.failure.code,
        message: snapshot.failure.message,
        nodeId: snapshot.nodeId,
        metadata: snapshot.failure.metadata,
      } satisfies WorkflowRunFailure)
    : undefined;
  const episodeMetadata = workflowProjectionEpisodeMetadata(record, snapshot);
  const allowedTools = workflowProjectionAllowedTools(snapshot);
  return mutateWorkflowRecord(writer, record, {
    status,
    currentNodeId: state.currentNodeId,
    ...(snapshot.phase === "waiting" && snapshot.wait
      ? { wait: snapshot.wait }
      : record.wait
        ? { clearWait: true }
        : {}),
    attempts: state.attempts,
    ...(state.parallelBranches
      ? { parallelBranches: cloneJsonLike(state.parallelBranches) }
      : {}),
    evidenceRefs,
    verdictLog,
    transitionLog: state.transitionLog,
    ...(failure ? { failure } : {}),
    metadata: {
      lastProjectionPhase: snapshot.phase,
      ...(episodeMetadata ? { workflowEpisode: episodeMetadata } : {}),
      ...(allowedTools ? { episodeAllowedTools: allowedTools.normalized } : {}),
      ...(snapshot.metadata ? { projectionMetadata: snapshot.metadata } : {}),
    },
  });
}

function workflowProjectionEpisodeMetadata(
  record: WorkflowRunRecord,
  snapshot: WorkflowProjectionStateSnapshot,
): Record<string, unknown> | undefined {
  const node = workflowProjectionModelNode(snapshot);
  if (!node) return undefined;
  const previous = isPlainRecord(record.metadata.workflowEpisode)
    ? cloneJsonLike(record.metadata.workflowEpisode)
    : {};
  const modelRef = workflowNodeModelRef(snapshot.definition, node);
  return {
    ...previous,
    ...(modelRef ? { modelRef } : {}),
    nodeId: node.id,
    attempt: snapshot.attempt ?? snapshot.state.attempts[node.id] ?? 1,
    ...(node.runBudget ? { runBudget: { ...node.runBudget } } : {}),
  };
}

function workflowProjectionAllowedTools(
  snapshot: WorkflowProjectionStateSnapshot,
): { nodeId: string; normalized: string[] } | undefined {
  const node = workflowProjectionModelNode(snapshot);
  if (!node?.tools || node.tools.length === 0) return undefined;
  return { nodeId: node.id, normalized: [...new Set(node.tools)] };
}

function workflowProjectionModelNode(
  snapshot: WorkflowProjectionStateSnapshot,
): WorkflowNodeDefinition | undefined {
  if (snapshot.phase !== "node_started" || !snapshot.nodeId) return undefined;
  const node = snapshot.definition.nodes.find(
    (candidate) => candidate.id === snapshot.nodeId,
  );
  if (!node || (node.execute !== undefined && node.execute !== "model")) {
    return undefined;
  }
  return node;
}

function workflowNodeModelRef(
  definition: WorkflowExecutableDefinition,
  node: WorkflowNodeDefinition,
): string | undefined {
  if (!node.model) return undefined;
  const config = definition.config;
  const tiers = isPlainRecord(config)
    ? isPlainRecord(config.modelTiers)
      ? config.modelTiers
      : isPlainRecord(config.model_tiers)
        ? config.model_tiers
        : {}
    : {};
  const resolved = tiers[node.model];
  return typeof resolved === "string" && resolved.trim() !== ""
    ? resolved.trim()
    : node.model;
}

function appendWorkflowEpisodeUsage(
  metadata: Record<string, unknown>,
  entry: {
    runId: RunId;
    state: RunResult["state"];
    stopReason?: RunResult["stopReason"];
    episode?: Record<string, unknown>;
    usage: Record<string, unknown>;
  },
): Record<string, unknown> {
  const entries = Array.isArray(metadata.workflowEpisodeUsage)
    ? metadata.workflowEpisodeUsage.filter(isPlainRecord).map(cloneJsonLike)
    : [];
  const next = [
    ...entries,
    {
      at: new Date().toISOString(),
      runId: entry.runId,
      state: entry.state,
      ...(entry.stopReason ? { stopReason: entry.stopReason } : {}),
      ...(entry.episode ? { episode: cloneJsonLike(entry.episode) } : {}),
      usage: cloneJsonLike(entry.usage),
    },
  ];
  return {
    ...metadata,
    workflowEpisodeUsage: next,
    workflowUsage: summarizeWorkflowEpisodeUsage(next),
  };
}

function summarizeWorkflowEpisodeUsage(
  entries: readonly Record<string, unknown>[],
): Record<string, unknown> {
  let modelCalls = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  for (const entry of entries) {
    const usage = isPlainRecord(entry.usage) ? entry.usage : {};
    modelCalls += numericField(usage, "modelCalls");
    toolCalls += numericField(usage, "toolCalls");
    costUsd += numericField(usage, "costUsd");
    const tokens = isPlainRecord(usage.tokens) ? usage.tokens : {};
    inputTokens += numericField(tokens, "input");
    outputTokens += numericField(tokens, "output");
    totalTokens += numericField(tokens, "total");
    cachedTokens += numericField(tokens, "cached");
  }
  return {
    episodes: entries.length,
    modelCalls,
    toolCalls,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: totalTokens,
      cached: cachedTokens,
    },
    costUsd,
  };
}

function numericField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isTerminalWorkflowRunStatus(status: WorkflowRunStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function cloneJsonLike<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
