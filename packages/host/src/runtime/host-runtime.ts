import { resolve } from "node:path";
import {
  asSessionId,
  createContextItemId,
  createSessionId,
  type ContentPart,
  type ContextItem,
  type RunId,
} from "@sparkwright/core";
import {
  type WorkflowControlCommand,
  type WorkflowControlSourceIdentity,
  type WorkflowLeaseBoundWriter,
  type ActorInbox,
  type WorkflowRunId,
  type WorkflowRunStatus,
} from "@sparkwright/agent-runtime";
import type { HostRuntimeOptions } from "./contracts.js";
import {
  contentPartsFromRunInput,
  ExecutionInteractionOperations,
} from "./execution-interaction-operations.js";
import { CapabilityRuntimeOperations } from "./capability-runtime-operations.js";
import {
  TaskRuntimeOperations,
  type JoinRuntimeTaskResult,
  type ListRuntimeTasksInput,
  type PromoteRuntimeTaskResult,
  type ReadRuntimeTaskOutputResult,
  type StopRuntimeTaskResult,
} from "./task-runtime-operations.js";
import {
  WorkflowRuntimeOperations,
  type WorkflowControlExecutionPort,
} from "./workflow-runtime-operations.js";
import { WorkflowEpisodeRuntime } from "./workflow-episode-runtime.js";
import { AgentRuntimeAssembly } from "./agent-runtime-assembly.js";
import {
  RunPreparationOperations,
  devSkillsEnabled,
  prepareRuntimeMcpInspection,
} from "./run-preparation-operations.js";
export type { RuntimeOptions } from "./contracts.js";
import { loadCheckpointFromRunDir } from "@sparkwright/core/internal";
import {
  isTraceLevel,
  type TraceLevel,
  type ProtocolError,
  type CapabilityInspectRequestPayload,
  type RunResumeRequestPayload,
  type RunStartRequestPayload,
  type WorkflowListRequestPayload,
  type WorkflowResumeRequestPayload,
  type WorkflowRunSnapshot,
  type RunInputPart,
  type SessionCompactionInspectReport,
  type TaskRecordSnapshot,
  type CapabilitySnapshot,
} from "@sparkwright/protocol";
import { buildAccessMetadata, resolveRunAccessFields } from "../run-access.js";
import { HostExecution } from "../host-execution.js";
import {
  findHostRunDirectory,
  forkHostSession,
  inspectHostSession,
  inspectHostSessionCompaction,
  listHostSessions,
  loadHostSessionConversation,
  sessionRootDirFor,
  type SessionInspectOptions,
} from "../session-queries.js";
import {
  compactHostSession,
  type SessionCompactResult,
} from "../session-compaction.js";
export { sessionPreviewFromTranscriptLine } from "../session-queries.js";
export { createDelegateAgentTool } from "../indexed-delegate-tool.js";

/** Project protocol input parts into the run's initial user context item. */
function userInputContextItem(input: {
  content: string;
  parts: ContentPart[];
  source: "run.start" | "run.inject_message";
  metadata?: Record<string, unknown>;
}): ContextItem | undefined {
  if (input.parts.length === 0) return undefined;
  const imageCount = input.parts.filter((part) => part.type === "image").length;
  return {
    id: createContextItemId(),
    type: "user",
    source: { kind: "user_input", uri: input.source },
    content: input.content,
    parts: input.parts,
    metadata: {
      layer: "runtime",
      stability: "turn",
      multimodal: true,
      attachmentCount: input.parts.length,
      ...(imageCount > 0 ? { imageCount } : {}),
      ...(input.metadata ?? {}),
    },
  };
}

/**
 * Derive a human-readable session-browser preview from the first transcript
 * line. That line is the opening `prompt` event whose `messages` carry the
 * `<env>` preamble (message 0) and the user goal as `User request:\n<goal>`
 * (last user message). We surface the goal. Falls back to a top-level `content`
 * string, then the raw line, for other/legacy shapes.
 */
function resolveTraceLevel(input: {
  traceLevel?: TraceLevel;
  metadata?: Record<string, unknown>;
  defaultTraceLevel?: TraceLevel;
}): TraceLevel {
  return (
    input.traceLevel ??
    (isTraceLevel(input.metadata?.traceLevel)
      ? input.metadata.traceLevel
      : (input.defaultTraceLevel ?? "standard"))
  );
}

/** One HostExecution attachment composed by the process HostService. */
export class HostRuntime {
  private readonly opts: HostRuntimeOptions;
  private readonly tasks: TaskRuntimeOperations;
  private readonly workflows: WorkflowRuntimeOperations;
  private readonly workflowEpisodes: WorkflowEpisodeRuntime;
  private readonly capabilities: CapabilityRuntimeOperations;
  private readonly runPreparation: RunPreparationOperations;
  private readonly interactions: ExecutionInteractionOperations;
  private currentExecution: HostExecution | null = null;
  // One abort for the complete interactive execution, including assembly and
  // every todo/workflow episode. Core run cancellation remains run-scoped.

  /** @internal Construct through HostService.createRuntime(). */
  constructor(opts: HostRuntimeOptions) {
    this.opts = {
      ...opts,
      workspaceRoot: resolve(opts.workspaceRoot),
      ...(opts.sessionRootDir
        ? { sessionRootDir: resolve(opts.sessionRootDir) }
        : {}),
    };
    const context = opts.workspaceContext;
    this.tasks = new TaskRuntimeOperations({
      workspaceRoot: this.opts.workspaceRoot,
      manager: context.taskManager,
      notifications: context.taskNotifications,
    });
    this.workflows = new WorkflowRuntimeOperations({
      workspaceRoot: this.opts.workspaceRoot,
      notifications: context.workflowNotifications,
      controls: context.workflowControls,
      dispatcher: context.workflowControlDispatcher,
    });
    this.workflowEpisodes = new WorkflowEpisodeRuntime({
      workflows: this.workflows,
      tasks: this.tasks,
      emit: this.opts.emit,
      releaseExecution: (execution) => {
        if (this.currentExecution === execution) this.currentExecution = null;
      },
    });
    const agents = new AgentRuntimeAssembly({
      taskManager: this.tasks.manager,
      workspaceLeaseCoordinator: this.opts.workspaceLeaseCoordinator,
    });
    this.interactions = new ExecutionInteractionOperations({
      execution: { current: () => this.currentExecution },
      emit: this.opts.emit,
      approvalTimeoutMs: this.opts.approvalTimeoutMs,
    });
    this.capabilities = new CapabilityRuntimeOperations({
      workspaceRoot: this.opts.workspaceRoot,
      sessionRootDir: sessionRootDirFor(this.opts),
      taskManager: this.tasks.manager,
      taskRootDir: this.tasks.rootDir,
      defaultModel: this.opts.defaultModel,
      defaultAccessMode: this.opts.defaultAccessMode,
      accessModeCeiling: this.opts.accessModeCeiling,
      defaultBackgroundTasks: this.opts.defaultBackgroundTasks,
      backgroundTasksCeiling: this.opts.backgroundTasksCeiling,
      emit: this.opts.emit,
      includeDevSkills: devSkillsEnabled,
      prepareMcp: ({ config, shellSandbox }) =>
        prepareRuntimeMcpInspection({
          config,
          extraServers: this.opts.extraMcpServers,
          workspaceRoot: this.opts.workspaceRoot,
          shellSandbox,
        }),
    });
    this.runPreparation = new RunPreparationOperations({
      workspaceRoot: this.opts.workspaceRoot,
      sessionRootDir: this.opts.sessionRootDir,
      extraMcpServers: this.opts.extraMcpServers,
      workspaceLeaseCoordinator: this.opts.workspaceLeaseCoordinator,
      taskManager: this.tasks.manager,
      agents,
      capabilities: this.capabilities,
      workflowEpisodes: this.workflowEpisodes,
      createInteractionChannel: (runIdHolder) =>
        this.interactions.createInteractionChannel(runIdHolder),
    });
  }

  hasActiveRun(): boolean {
    return this.interactions.hasActiveRun();
  }

  /** @internal HostService lookup without mirroring execution truth. */
  executionIdentity():
    | {
        executionId: string;
        sessionId?: string;
        currentRunId?: string;
        runIds: readonly string[];
      }
    | undefined {
    return this.interactions.executionIdentity();
  }

  /** @internal Canonical lane scope used by the process HostService. */
  executionLaneKey(sessionId: string): string {
    return `${sessionRootDirFor(this.opts)}\0${sessionId}`;
  }

  executionDriverHandle(executionId: string) {
    return this.interactions.executionDriverHandle(executionId);
  }

  private releaseUnstartedExecution(execution: HostExecution): void {
    if (this.currentExecution !== execution || execution.activeRun) return;
    execution.finish(
      execution.abortController.signal.aborted ? "cancelled" : "failed",
    );
    this.currentExecution = null;
  }

  private async runInExecutionEnvelope<Result>(
    input: {
      busyMessage: string;
      abortController?: AbortController;
      executionId?: string;
    },
    run: (execution: HostExecution) => Promise<Result>,
  ): Promise<Result | { ok: false; error: ProtocolError }> {
    if (this.currentExecution) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: input.busyMessage,
        },
      };
    }
    const execution = new HostExecution({
      abortController: input.abortController,
      executionId: input.executionId,
    });
    this.currentExecution = execution;
    try {
      return await run(execution);
    } finally {
      this.releaseUnstartedExecution(execution);
    }
  }

  listTasks(input: ListRuntimeTasksInput): {
    ok: true;
    tasks: TaskRecordSnapshot[];
  } {
    return this.tasks.list(input);
  }

  getTask(
    taskId: string,
  ):
    | { ok: true; task: TaskRecordSnapshot }
    | { ok: false; error: ProtocolError } {
    return this.tasks.get(taskId);
  }

  async readTaskOutput(input: {
    taskId: string;
    fromSequence?: number;
    maxChunks?: number;
  }): Promise<ReadRuntimeTaskOutputResult> {
    return await this.tasks.readOutput(input);
  }

  async stopTask(taskId: string): Promise<StopRuntimeTaskResult> {
    return await this.tasks.stop(taskId);
  }

  async joinTask(taskId: string): Promise<JoinRuntimeTaskResult> {
    return await this.tasks.join(taskId);
  }

  async promoteTask(taskId: string): Promise<PromoteRuntimeTaskResult> {
    return await this.tasks.promote(taskId);
  }

  async inspectCapabilities(
    input: CapabilityInspectRequestPayload & { modelRef?: string } = {},
  ): Promise<
    | { ok: true; snapshot: CapabilitySnapshot }
    | { ok: false; error: ProtocolError }
  > {
    return await this.capabilities.inspect(input);
  }

  /**
   * Start a new run. Returns the runId synchronously (after createRun
   * resolves) and continues streaming events asynchronously.
   */
  async startRun(payload: RunStartRequestPayload): Promise<
    | {
        ok: true;
        runId: string;
        sessionId: string;
        workflowRunId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    return this.opts.executionCoordinator.startRun(this, payload);
  }

  /** @internal Driven only after HostService lane admission. */
  async startExecution(
    payload: RunStartRequestPayload,
    executionId?: string,
  ): Promise<
    | {
        ok: true;
        runId: string;
        sessionId: string;
        workflowRunId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    return await this.runInExecutionEnvelope(
      {
        busyMessage: "another run is already active on this connection",
        abortController: new AbortController(),
        executionId,
      },
      (execution) => this.startRunInner(execution, payload),
    );
  }

  /**
   * Service-owned fresh workflow start with a caller-fixed durable identity.
   * This is not exposed by the Host protocol: Package F derives the id from an
   * immutable handoff so crash recovery and competing carriers cannot create
   * two workflow records for one accepted request.
   */
  async startDetachedWorkflowRun(
    payload: RunStartRequestPayload,
    workflowRunId: WorkflowRunId,
  ): Promise<
    | {
        ok: true;
        runId: string;
        sessionId: string;
        workflowRunId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    if (!payload.workflow) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: "detached service start requires a workflow asset",
        },
      };
    }
    return await this.runInExecutionEnvelope(
      {
        busyMessage: "another run is already active on this service adapter",
      },
      (execution) => this.startRunInner(execution, payload, workflowRunId),
    );
  }

  async resumeRun(
    payload: RunResumeRequestPayload,
  ): Promise<
    | { ok: true; runId: string; resumedFromRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    return this.opts.executionCoordinator.resumeRun(this, payload);
  }

  /** @internal Resolve the persisted session before HostService chooses a lane. */
  async resolveResumeSession(
    payload: RunResumeRequestPayload,
  ): Promise<
    { ok: true; sessionId: string } | { ok: false; error: ProtocolError }
  > {
    const located = await findHostRunDirectory(
      this.opts,
      payload.runId,
      payload.sessionId,
    );
    if (!located.ok) return located;
    return { ok: true, sessionId: located.sessionId ?? createSessionId() };
  }

  /** @internal Driven only after HostService lane admission. */
  async resumeExecution(
    payload: RunResumeRequestPayload,
    executionId?: string,
    resolvedSessionId?: string,
  ): Promise<
    | { ok: true; runId: string; resumedFromRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    return await this.runInExecutionEnvelope(
      {
        busyMessage: "another run is already active on this connection",
        abortController: new AbortController(),
        executionId,
      },
      (execution) => this.resumeRunInner(execution, payload, resolvedSessionId),
    );
  }

  async listWorkflowRuns(payload: WorkflowListRequestPayload = {}): Promise<
    | {
        ok: true;
        workflows: WorkflowRunSnapshot[];
        invalidEntries?: Array<{ path: string; code: string; reason: string }>;
      }
    | { ok: false; error: ProtocolError }
  > {
    return this.workflows.list(payload);
  }

  private workflowControlExecutionPort(): WorkflowControlExecutionPort {
    return {
      hasExecution: () => this.currentExecution !== null,
      processActiveControls: async (workflowRunId) => {
        const active = this.currentExecution?.activeRun;
        if (
          active?.workflowRunId === workflowRunId &&
          active.processWorkflowControls
        ) {
          await active.processWorkflowControls();
        }
      },
      resume: async (payload) => {
        return await this.runInExecutionEnvelope(
          {
            busyMessage: "another run is already active on this connection",
          },
          (execution) => this.resumeWorkflowRunInner(execution, payload),
        );
      },
    };
  }

  workflowActorInbox(): ActorInbox {
    return this.workflows.actorInbox();
  }

  async controlWorkflow(input: {
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
  }): Promise<
    | {
        ok: true;
        status: string;
        commandId: string;
        code?: string;
        runId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    return this.workflows.control(input, this.workflowControlExecutionPort());
  }

  async processAcceptedWorkflowControl(
    envelope: Parameters<
      WorkflowRuntimeOperations["processAcceptedControl"]
    >[0],
  ): Promise<
    | {
        ok: true;
        status: string;
        commandId: string;
        code?: string;
        runId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    return this.workflows.processAcceptedControl(
      envelope,
      this.workflowControlExecutionPort(),
    );
  }

  async processWorkflowControlCommand(input: {
    workflowRunId: string;
    sessionId?: string;
    commandId: string;
  }): Promise<
    | {
        ok: true;
        status: string;
        commandId: string;
        code?: string;
        runId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    return this.workflows.processControlCommand(
      input,
      this.workflowControlExecutionPort(),
    );
  }

  async resumeWorkflowRun(
    payload: WorkflowResumeRequestPayload,
    source: WorkflowControlSourceIdentity,
  ): Promise<
    | { ok: true; runId: string; workflowRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    return await this.runInExecutionEnvelope(
      {
        busyMessage: "another run is already active on this connection",
      },
      (execution) =>
        this.workflows.resumeThroughControl(payload, source, (resumePayload) =>
          this.resumeWorkflowRunInner(execution, resumePayload),
        ),
    );
  }

  async resumeClaimedWorkflowRun(
    payload: WorkflowResumeRequestPayload,
    writer: WorkflowLeaseBoundWriter,
  ): Promise<
    | { ok: true; runId: string; workflowRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    const claimed = this.workflows.validateClaimedWriter(payload, writer);
    if (!claimed.ok) return claimed;
    return await this.runInExecutionEnvelope(
      {
        busyMessage: "another run is already active on this connection",
      },
      (execution) => this.resumeWorkflowRunInner(execution, payload, writer),
    );
  }

  private async resumeRunInner(
    execution: HostExecution,
    payload: RunResumeRequestPayload,
    resolvedSessionId?: string,
  ): Promise<
    | { ok: true; runId: string; resumedFromRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    const located = await findHostRunDirectory(
      this.opts,
      payload.runId,
      payload.sessionId,
    );
    if (!located.ok) return located;

    let checkpoint: ReturnType<typeof loadCheckpointFromRunDir>;
    try {
      checkpoint = loadCheckpointFromRunDir(located.runDir, {
        fallbackFromTrace: payload.fromTrace,
      });
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (!checkpoint) {
      return {
        ok: false,
        error: {
          code: "run_not_found",
          message:
            `No checkpoint.json under ${located.runDir}. ` +
            `Retry with fromTrace=true to reconstruct one from the trace.`,
        },
      };
    }
    if (!checkpoint.resumability.complete && payload.force !== true) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message:
            `Checkpoint is not fully resumable (reasons: ${checkpoint.resumability.reasons.join(", ") || "unspecified"}). ` +
            `Retry with force=true (CLI: --force) to attempt a best-effort resume.`,
        },
      };
    }
    await this.tasks.failOrphanedInProcessTasksForRun(payload.runId as RunId);

    const modelRef = payload.model ?? this.opts.defaultModel;
    const access = resolveRunAccessFields(
      payload as unknown as RunStartRequestPayload,
      {
        defaultAccessMode: this.opts.defaultAccessMode,
        accessModeCeiling: this.opts.accessModeCeiling,
        defaultBackgroundTasks: this.opts.defaultBackgroundTasks,
        backgroundTasksCeiling: this.opts.backgroundTasksCeiling,
      },
    );
    const { permissionMode, shouldWrite } = access;
    const accessMetadata = buildAccessMetadata(access);
    const resumeSessionId =
      located.sessionId ?? resolvedSessionId ?? createSessionId();
    const prepared = await this.runPreparation.prepare({
      goal: checkpoint.run.goal,
      modelRef,
      access,
      sessionId: resumeSessionId,
      targetPath: payload.targetPath,
      confidentialPaths: payload.confidentialPaths,
      confidentialDefaults: payload.confidentialDefaults,
      traceLevel: resolveTraceLevel({
        ...payload,
        defaultTraceLevel: this.opts.defaultTraceLevel,
      }),
      runMetadata: {
        resumedFromRunId: payload.runId,
        ...(payload.metadata ?? {}),
        ...accessMetadata,
      },
      runStoreMetadata: {
        resumedFromRunId: payload.runId,
        ...(payload.metadata ?? {}),
        ...accessMetadata,
        ...(payload.metadata ? { resumeMetadata: payload.metadata } : {}),
      },
    });
    if (!prepared.ok) return prepared;
    const env = prepared.env;

    const started = await this.workflowEpisodes.resumeCheckpoint({
      execution,
      env,
      payload,
      checkpoint,
      sessionId: resumeSessionId,
      agentId: located.agentId,
      permissionMode,
      shouldWrite,
    });
    if (!started.ok) return started;

    return {
      ok: true,
      runId: started.runId,
      resumedFromRunId: payload.runId,
      sessionId: resumeSessionId,
    };
  }

  private async resumeWorkflowRunInner(
    execution: HostExecution,
    payload: WorkflowResumeRequestPayload,
    claimedWriter?: WorkflowLeaseBoundWriter,
  ): Promise<
    | { ok: true; runId: string; workflowRunId: string; sessionId?: string }
    | { ok: false; error: ProtocolError }
  > {
    const located = await this.workflows.findRecord(
      payload.workflowRunId as WorkflowRunId,
      payload.sessionId,
    );
    if (!located.ok) return located;
    let { record } = located.location;
    const { store, sessionId } = located.location;
    if (this.workflows.isTerminalStatus(record.status)) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow run ${record.id} is already ${record.status}.`,
        },
      };
    }
    const lease =
      claimedWriter ??
      (await store.acquireWriter(record.id, {
        owner: this.workflows.leaseOwner(),
        ttlMs: this.workflows.leaseTtlMs(),
      }));
    if (!lease) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow run ${record.id} is already adopted by another writer.`,
        },
      };
    }
    record = (await lease.readFresh()) ?? record;
    const authorizationSnapshot = record.authorizationSnapshot;
    const effectiveResumePayload: WorkflowResumeRequestPayload = {
      ...payload,
      targetPath: payload.targetPath ?? authorizationSnapshot?.targetPath,
      confidentialPaths:
        payload.confidentialPaths ?? authorizationSnapshot?.confidentialPaths,
      confidentialDefaults:
        payload.confidentialDefaults ??
        authorizationSnapshot?.confidentialDefaults,
      accessMode: payload.accessMode ?? authorizationSnapshot?.accessMode,
      backgroundTasks:
        payload.backgroundTasks ?? authorizationSnapshot?.backgroundTasks,
    };
    const access = resolveRunAccessFields(
      effectiveResumePayload as unknown as RunStartRequestPayload,
      {
        defaultAccessMode: this.opts.defaultAccessMode,
        accessModeCeiling: this.opts.accessModeCeiling,
        defaultBackgroundTasks: this.opts.defaultBackgroundTasks,
        backgroundTasksCeiling: this.opts.backgroundTasksCeiling,
      },
    );
    const { permissionMode, shouldWrite } = access;
    const accessMetadata = buildAccessMetadata(access);
    const prepared = await this.runPreparation.prepare({
      goal:
        typeof record.metadata.goal === "string"
          ? record.metadata.goal
          : `Resume workflow ${record.assetName}`,
      modelRef: payload.model ?? this.opts.defaultModel,
      access,
      sessionId,
      targetPath: effectiveResumePayload.targetPath,
      confidentialPaths: effectiveResumePayload.confidentialPaths,
      confidentialDefaults: effectiveResumePayload.confidentialDefaults,
      traceLevel: resolveTraceLevel({
        ...effectiveResumePayload,
        defaultTraceLevel: this.opts.defaultTraceLevel,
      }),
      workflowStore: store,
      workflowRecord: record,
      workflowLease: lease,
      workflowWaitingInputMetadata:
        record.status === "waiting"
          ? this.workflows.waitingInputMetadata(record, payload.metadata)
          : undefined,
      runMetadata: {
        resumedWorkflowRunId: record.id,
        verifyOnResume: record.resume.verifyOnResume,
        ...(payload.metadata ?? {}),
        ...accessMetadata,
      },
      runStoreMetadata: {
        resumedWorkflowRunId: record.id,
        verifyOnResume: record.resume.verifyOnResume,
        ...(payload.metadata ?? {}),
        ...accessMetadata,
      },
    });
    if (!prepared.ok) {
      await lease.release();
      return prepared;
    }
    const env = prepared.env;
    const priorContext = await loadHostSessionConversation(
      { workspaceRoot: env.workspaceRoot, sessionRootDir: env.sessionRootDir },
      sessionId,
    );
    const started = await this.workflowEpisodes.resumeWorkflow({
      execution,
      env,
      record,
      payload: effectiveResumePayload,
      sessionId,
      permissionMode,
      shouldWrite,
      priorContext,
    });
    if (!started.ok) {
      if (record.status === "waiting") {
        const current = (await lease.readFresh()) ?? record;
        await this.workflows.compensate(
          lease,
          current,
          record,
          "workflow_resume_start_failed",
        );
      }
      await lease.release();
      return started;
    }
    return {
      ok: true,
      runId: started.runId,
      workflowRunId: record.id,
      sessionId,
    };
  }

  private async startRunInner(
    execution: HostExecution,
    payload: RunStartRequestPayload,
    workflowRunId?: WorkflowRunId,
  ): Promise<
    | {
        ok: true;
        runId: string;
        sessionId: string;
        workflowRunId?: string;
      }
    | { ok: false; error: ProtocolError }
  > {
    const modelRef = payload.model ?? this.opts.defaultModel;
    const access = resolveRunAccessFields(payload, {
      defaultAccessMode: this.opts.defaultAccessMode,
      accessModeCeiling: this.opts.accessModeCeiling,
      defaultBackgroundTasks: this.opts.defaultBackgroundTasks,
      backgroundTasksCeiling: this.opts.backgroundTasksCeiling,
    });
    const { permissionMode, shouldWrite } = access;
    const accessMetadata = buildAccessMetadata(access);
    let sessionId: string;
    let controlSessionId: string | undefined;
    try {
      sessionId = payload.sessionId
        ? asSessionId(payload.sessionId)
        : createSessionId();
      controlSessionId = payload.controlSessionId
        ? asSessionId(payload.controlSessionId)
        : undefined;
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (controlSessionId && !payload.workflow) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message:
            "controlSessionId is only valid when starting a workflow job",
        },
      };
    }
    if (controlSessionId === sessionId) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: "workflow job sessionId must differ from controlSessionId",
        },
      };
    }
    const prepared = await this.runPreparation.prepare({
      goal: payload.goal,
      modelRef,
      access,
      sessionId,
      targetPath: payload.targetPath,
      confidentialPaths: payload.confidentialPaths,
      confidentialDefaults: payload.confidentialDefaults,
      traceLevel: resolveTraceLevel({
        ...payload,
        defaultTraceLevel: this.opts.defaultTraceLevel,
      }),
      workflowName: payload.workflow,
      workflowRunId,
      controlSessionId,
      runMetadata: {
        ...(payload.metadata ?? {}),
        ...accessMetadata,
      },
      runStoreMetadata: {
        ...(payload.metadata ?? {}),
        ...accessMetadata,
      },
    });
    if (!prepared.ok) return prepared;
    const env = prepared.env;

    // Thread prior turns of this session into context so the model can see
    // the conversation history. Each completed prior run contributes a
    // user (goal) + assistant (final message) pair, tagged for the
    // "conversation" layer with session-stable cache policy.
    const priorContext = await loadHostSessionConversation(
      { workspaceRoot: env.workspaceRoot, sessionRootDir: env.sessionRootDir },
      sessionId,
    );
    const initialInputParts = contentPartsFromRunInput(payload.input?.parts);
    const initialInputContext = userInputContextItem({
      content:
        initialInputParts.length > 0
          ? `User request attachments for: ${payload.goal}`
          : payload.goal,
      parts: initialInputParts,
      source: "run.start",
      metadata: payload.input?.metadata,
    });

    const started = await this.workflowEpisodes.startFresh({
      execution,
      env,
      payload,
      sessionId,
      permissionMode,
      shouldWrite,
      priorContext,
      ...(initialInputContext ? { initialInputContext } : {}),
    });
    if (!started.ok) return started;
    return {
      ...started,
      sessionId,
      ...(env.workflowRecord
        ? { workflowRunId: String(env.workflowRecord.id) }
        : {}),
    };
  }

  cancelRun(
    runId: string,
    reason?: string,
  ): { ok: true } | { ok: false; error: ProtocolError } {
    return this.opts.executionCoordinator.cancelRun(this, runId, reason);
  }

  injectRunMessage(
    runId: string,
    input: {
      content: string;
      parts?: readonly RunInputPart[];
      metadata?: Record<string, unknown>;
    },
  ): { ok: true } | { ok: false; error: ProtocolError } {
    return this.opts.executionCoordinator.injectRunMessage(this, runId, input);
  }

  resolveApproval(
    approvalId: string,
    decision: "approved" | "denied",
    message?: string,
    autoApproved?: boolean,
  ): { ok: true } | { ok: false; error: ProtocolError } {
    return this.interactions.resolveApproval(
      approvalId,
      decision,
      message,
      autoApproved,
    );
  }

  /**
   * Called on disconnect: cancel active run + deny outstanding approvals so
   * core does not leak file handles or hang on never-arriving decisions.
   */
  cleanup(): void {
    this.interactions.cleanup();
  }

  async drain(): Promise<void> {
    await this.interactions.drain();
  }

  async listSessions(
    limit = 20,
  ): Promise<Array<{ id: string; mtimeMs: number; preview: string }>> {
    return await listHostSessions(this.opts, limit);
  }

  async inspectSession(
    sessionId: string,
    options: SessionInspectOptions = {},
  ): Promise<
    | {
        ok: true;
        sessionId: string;
        summary: Record<string, unknown>;
        consistency: Record<string, unknown>;
        timeline: Record<string, unknown>;
        compaction?: SessionCompactionInspectReport;
      }
    | { ok: false; error: ProtocolError }
  > {
    return await inspectHostSession(this.opts, sessionId, options);
  }

  async inspectSessionCompaction(sessionId: string): Promise<
    | {
        ok: true;
        sessionId: string;
        compaction: SessionCompactionInspectReport;
      }
    | { ok: false; error: ProtocolError }
  > {
    return await inspectHostSessionCompaction(this.opts, sessionId);
  }

  async compactSession(
    sessionId: string,
    reason?: string,
    options: {
      llm?: boolean;
    } = {},
  ): Promise<SessionCompactResult> {
    return await compactHostSession({
      context: this.opts,
      sessionId,
      reason,
      manualLlm: options.llm === true,
    });
  }

  /**
   * Fork a session at an optional event sequence into a brand-new session,
   * using core's forkSessionFromEvent over the file-backed session store.
   * The new session's run references are copied; subsequent runs extend the
   * fork rather than the original.
   */
  async forkSession(
    sourceSessionId: string,
    forkAtSequence?: number,
  ): Promise<
    | {
        ok: true;
        forkedSessionId: string;
        copiedEventCount: number;
        truncatedAtSequence: number | null;
      }
    | { ok: false; error: ProtocolError }
  > {
    return await forkHostSession(this.opts, sourceSessionId, forkAtSequence);
  }
}
