import { join } from "node:path";
import {
  createRun,
  createBufferedEmitter,
  FileSessionStore,
  createSessionRunStoreFactory,
  resumeRunFromCheckpoint,
  type ContextItem,
  type InteractionChannel,
  type ModelAdapter,
  type RunBudget,
  type RunId,
  type RunResult,
  type SparkwrightEvent,
  type ToolDefinition,
  type WorkflowHook,
} from "@sparkwright/core";
import {
  createSessionFileRunStoreFactory,
  type LocalWorkspace,
  type MemoryTrace,
} from "@sparkwright/core/internal";
import {
  readTodoLedger,
  TODO_CONTINUATION_REQUIRED_TOOL,
  type AgentProfile,
  type FileWorkflowStore,
  type TodoSupervisedRunInput,
  type WorkflowExecutableDefinition,
  type WorkflowLeaseBoundWriter,
  type WorkflowNodeDefinition,
  type WorkflowRunId,
  type WorkflowRunRecord,
} from "@sparkwright/agent-runtime";
import type { SkillUsageRecorder } from "@sparkwright/skills";
import type {
  ProtocolError,
  HostEvent,
  RunFailureEnvelope,
  RunResumeRequestPayload,
  RunStartRequestPayload,
  TraceLevel,
  WorkflowResumeRequestPayload,
} from "@sparkwright/protocol";
import type {
  CapabilityEventHookConfig,
  CapabilityHooksConfig,
  ShellConfig,
  WriteGuardrailsConfig,
} from "../config-zod-schema.js";
import { nextMessageId, nowIso } from "../connection.js";
import { HostExecution } from "../host-execution.js";
import { createHostRunPolicy } from "../run-policy.js";
import { buildAgentPromptBuilder } from "@sparkwright/project-context";
import type { ResolvedModelConfig } from "../model-factory.js";
import { createModel } from "../model-factory.js";
import type { ResolvedRunAccess } from "../run-access.js";
import { observeSkillUsageEvent } from "../skill-usage.js";
import { bindConfiguredEventHooks } from "../workflow-hooks.js";
import { createWorkflowProjectionHooks } from "../workflow-projection.js";
import {
  loadLayeredWorkflowAssets,
  pinWorkflowAssetPackage,
  verifyWorkflowPackageSnapshot,
} from "../workflows.js";
import { DISCOVERY_TOOL_NAME } from "../tool-selectors.js";
import {
  isWorkflowScopedToolSearch,
  resolveRunToolSurface,
  type ResolvedToolSurface,
} from "../tool-surface.js";
import type { TaskRuntimeOperations } from "./task-runtime-operations.js";
import type { WorkflowRuntimeOperations } from "./workflow-runtime-operations.js";

const MAIN_TODO_MAX_CONTINUATIONS = 4;
const MAIN_TODO_MAX_STALLED_CONTINUATIONS = 1;
const MAIN_TODO_CONTINUATION_MAX_STEPS = 8;
const MAIN_TODO_CONTINUATION_MAX_MODEL_CALLS = 8;
const MAIN_TODO_CONTINUATION_MAX_TOOL_CALLS = 12;
const MAIN_AGENT_MAX_STEPS_BACKSTOP = 100;

export interface WorkflowEpisodeEnvironment {
  workspaceRoot: string;
  workspace: LocalWorkspace;
  sessionRootDir: string;
  trace: MemoryTrace;
  pendingExtensionEvents: ReturnType<typeof createBufferedEmitter>;
  skillUsageRecorder: SkillUsageRecorder | null;
  runIdHolder: { value: string | null };
  interactionChannel: InteractionChannel;
  model: ModelAdapter;
  modelRef: string;
  resolvedModel: ResolvedModelConfig;
  workflowModelAdapters: Map<
    string,
    { adapter: ModelAdapter; resolved: ResolvedModelConfig }
  >;
  preparedSkills: { context?: ContextItem[] } | null;
  preparedMcp: { close(): Promise<void> } | null;
  mainAgent: AgentProfile;
  tools: ToolDefinition[];
  workflowHooks: WorkflowHook[];
  workflowStore?: FileWorkflowStore;
  workflowRecord?: WorkflowRunRecord;
  workflowLease?: WorkflowLeaseBoundWriter;
  eventHookConfig?: CapabilityEventHookConfig[];
  hookSandbox?: ShellConfig["sandbox"];
  hookHttp?: CapabilityHooksConfig["http"];
  hookSkillRoots: string[];
  hookConfigPaths: string[];
  delegateAgentTool?: ToolDefinition;
  sessionStore: FileSessionStore;
  parentRunRef: { current?: ReturnType<typeof createRun> };
  traceLevel: TraceLevel;
  writeGuardrails?: WriteGuardrailsConfig;
  confidentialPaths?: readonly string[];
  confidentialDefaults?: boolean;
  runMetadata: Record<string, unknown>;
  runStoreMetadata: Record<string, unknown>;
}

export interface WorkflowEpisodeRuntimeOptions {
  workflows: WorkflowRuntimeOperations;
  tasks: TaskRuntimeOperations;
  emit(event: HostEvent): void;
  releaseExecution(execution: HostExecution): void;
}

export interface PreparedWorkflowEpisode {
  workflowModelAdapters: WorkflowEpisodeEnvironment["workflowModelAdapters"];
  workflowProjection?: ReturnType<typeof createWorkflowProjectionHooks>;
  workflowStore?: FileWorkflowStore;
  workflowRecord?: WorkflowRunRecord;
  workflowLease?: WorkflowLeaseBoundWriter;
}

export interface WorkflowActorEpisodePlan {
  model: ModelAdapter;
  modelRef: string;
  resolvedModel: ResolvedModelConfig;
  nodeId?: string;
  attempt?: number;
  runBudget?: RunBudget;
  budgetScope: "main_agent" | "todo_continuation";
  toolSurface: ResolvedToolSurface;
}

/** Owns live Core run construction and execution for Workflow-aware episodes. */
export class WorkflowEpisodeRuntime {
  private readonly workflows: WorkflowRuntimeOperations;
  private readonly tasks: TaskRuntimeOperations;
  private readonly emit: WorkflowEpisodeRuntimeOptions["emit"];
  private readonly releaseExecution: WorkflowEpisodeRuntimeOptions["releaseExecution"];

  constructor(options: WorkflowEpisodeRuntimeOptions) {
    this.workflows = options.workflows;
    this.tasks = options.tasks;
    this.emit = options.emit;
    this.releaseExecution = options.releaseExecution;
  }

  async prepare(input: {
    goal: string;
    sessionId: string;
    sessionRootDir: string;
    workspaceRoot: string;
    workflows: Awaited<ReturnType<typeof loadLayeredWorkflowAssets>>;
    parentModelRef: string;
    workflowName?: string;
    workflowRunId?: WorkflowRunId;
    controlSessionId?: string;
    workflowStore?: FileWorkflowStore;
    workflowRecord?: WorkflowRunRecord;
    workflowLease?: WorkflowLeaseBoundWriter;
    workflowWaitingInputMetadata?: Record<string, unknown>;
    targetPath?: string;
    confidentialPaths?: readonly string[];
    confidentialDefaults?: boolean;
    access: ResolvedRunAccess;
    runMetadata?: Record<string, unknown>;
    shellSandbox?: ShellConfig["sandbox"];
    hookHttp?: CapabilityHooksConfig["http"];
    skillRoots: string[];
    configPaths: string[];
    parentRunRef: { current?: ReturnType<typeof createRun> };
    tools: ToolDefinition[];
    delegateAgentTool?: ToolDefinition;
    delegateParallelTool?: ToolDefinition;
  }): Promise<
    | { ok: true; prepared: PreparedWorkflowEpisode }
    | { ok: false; error: ProtocolError }
  > {
    const selectedWorkflow = input.workflowRecord
      ? undefined
      : input.workflowName
        ? input.workflows.assets.find(
            (asset) => asset.assetName === input.workflowName,
          )
        : undefined;
    if (!input.workflowRecord && input.workflowName && !selectedWorkflow) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: `Workflow "${input.workflowName}" was not found.`,
        },
      };
    }
    const pinnedWorkflow = selectedWorkflow
      ? await pinWorkflowAssetPackage({
          asset: selectedWorkflow,
          snapshotRoot: join(this.workflows.rootDir, "package-snapshots"),
        })
      : undefined;
    const workflowDefinition = input.workflowRecord
      ? input.workflowRecord.definitionSnapshot
      : pinnedWorkflow?.asset.definition;
    if (input.workflowRecord) {
      try {
        await verifyWorkflowPackageSnapshot({
          packageSnapshotRef: input.workflowRecord.packageSnapshotRef,
          packageHash: input.workflowRecord.packageHash,
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "invalid_payload",
            message: `Workflow run "${input.workflowRecord.id}" executable package snapshot is invalid: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        };
      }
      if (
        input.workflowRecord.definitionSnapshot.sourceDir !==
        input.workflowRecord.packageSnapshotRef
      ) {
        return {
          ok: false,
          error: {
            code: "invalid_payload",
            message: `Workflow run "${input.workflowRecord.id}" definition does not execute from its package snapshot.`,
          },
        };
      }
    }
    const workflowModelAdapters = workflowDefinition
      ? await resolveWorkflowModelAdapters({
          definition: workflowDefinition,
          parentModelRef: input.parentModelRef,
          goal: input.goal,
          workspaceRoot: input.workspaceRoot,
          targetPath: input.targetPath,
        })
      : { ok: true as const, adapters: new Map() };
    if (!workflowModelAdapters.ok) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: workflowModelAdapters.message,
        },
      };
    }

    const workflowStore = workflowDefinition
      ? (input.workflowStore ?? this.workflows.createStore())
      : undefined;
    let workflowRecord = input.workflowRecord;
    let workflowLease = input.workflowLease;
    let acquiredWorkflowLease = false;
    let workflowRollbackRecord: WorkflowRunRecord | undefined;
    let workflowProjection:
      | ReturnType<typeof createWorkflowProjectionHooks>
      | undefined;
    try {
      if (
        workflowStore &&
        workflowRecord?.status === "waiting" &&
        input.workflowWaitingInputMetadata !== undefined
      ) {
        workflowRollbackRecord = workflowRecord;
        workflowRecord = await this.workflows.consumeWaitingInput(
          workflowLease,
          workflowRecord,
          input.workflowWaitingInputMetadata,
        );
        if (this.workflows.isTerminalStatus(workflowRecord.status)) {
          const terminalStatus = workflowRecord.status;
          const rollbackWorkflowRunId = workflowRollbackRecord.id;
          workflowRecord = await this.workflows.compensate(
            workflowLease,
            workflowRecord,
            workflowRollbackRecord,
            "workflow_resume_terminal_after_input",
          );
          workflowRollbackRecord = undefined;
          return {
            ok: false,
            error: {
              code: "invalid_payload",
              message: `Workflow run ${rollbackWorkflowRunId} would reach ${terminalStatus} while consuming waiting input.`,
            },
          };
        }
      }
      workflowProjection = workflowDefinition
        ? createWorkflowProjectionHooks({
            definition: workflowDefinition,
            workflowRunId: input.workflowRecord?.id ?? input.workflowRunId,
            initialState: input.workflowRecord
              ? this.workflows.runtimeState(input.workflowRecord)
              : undefined,
            resumeVerificationNodeIds:
              input.workflowRecord?.resume.verifyOnResume === true
                ? this.workflows.completedNodeIds(
                    input.workflowRecord,
                    workflowDefinition,
                  )
                : [],
            onStateSnapshot: async (snapshot) => {
              if (!workflowLease || !workflowRecord) return;
              const latestRecord =
                (await workflowLease.readFresh()) ?? workflowRecord;
              workflowRecord = await this.workflows.persistProjectionSnapshot(
                workflowLease,
                latestRecord,
                snapshot,
              );
              this.workflows.deliverNotification(workflowRecord);
            },
            workspaceRoot: input.workspaceRoot,
            sandbox: input.shellSandbox,
            http: input.hookHttp,
            skillRoots: input.skillRoots,
            configPaths: input.configPaths,
            getRun: () => input.parentRunRef.current,
            getEvidenceRefs: (nodeId) =>
              (workflowRecord?.evidenceRefs ?? []).filter(
                (ref) => ref.nodeId === nodeId,
              ),
            readTodoLedger: () =>
              readTodoLedger(
                join(input.sessionRootDir, input.sessionId, "todo.md"),
              ),
            runEndTerminalOwner: "episode_chain",
            allowScriptWrite: input.access.shouldWrite,
            agentTool: input.delegateAgentTool,
            delegateParallelTool: input.delegateParallelTool,
            taskTool: input.tools.find((tool) => tool.name === "task_create"),
            isToolAvailable: (toolName) =>
              input.parentRunRef.current?.tools.get(toolName) !== undefined,
            isScopedToolSearchAvailable: () =>
              isWorkflowScopedToolSearch(
                input.parentRunRef.current?.tools.get(DISCOVERY_TOOL_NAME),
              ),
          })
        : undefined;
      if (workflowProjection && workflowDefinition && workflowStore) {
        const projectedState = workflowProjection.getState();
        if (!workflowRecord) {
          const workflowRunId =
            workflowProjection.workflowRunId as WorkflowRunId;
          const acquiredLease = await workflowStore.acquireWriter(
            workflowRunId,
            {
              owner: this.workflows.leaseOwner(),
              ttlMs: this.workflows.leaseTtlMs(),
            },
          );
          if (!acquiredLease) {
            return {
              ok: false,
              error: {
                code: "invalid_payload",
                message: `Workflow run ${workflowRunId} is already adopted by another writer.`,
              },
            };
          }
          workflowLease = acquiredLease;
          acquiredWorkflowLease = true;
          workflowRecord = await acquiredLease.create({
            id: workflowRunId,
            assetName: workflowDefinition.assetName,
            layer: pinnedWorkflow!.asset.layer,
            ...(workflowDefinition.version
              ? { version: workflowDefinition.version }
              : {}),
            packageHash: pinnedWorkflow!.packageHash,
            packageHashPolicyVersion: pinnedWorkflow!.packageHashPolicyVersion,
            packageSnapshotRef: pinnedWorkflow!.packageSnapshotRef,
            sessionId: input.sessionId,
            currentNodeId: projectedState.currentNodeId,
            attempts: projectedState.attempts,
            transitionLog: projectedState.transitionLog,
            authorizationSnapshot: {
              ...(input.targetPath ? { targetPath: input.targetPath } : {}),
              confidentialPaths: [...(input.confidentialPaths ?? [])],
              confidentialDefaults: input.confidentialDefaults ?? true,
              accessMode: input.access.accessMode,
              backgroundTasks: input.access.backgroundTasks,
            },
            definitionSnapshot: workflowDefinition,
            metadata: {
              goal: input.goal,
              verifyOnResume: true,
              ...(input.workflowRunId &&
              typeof input.runMetadata?.serviceHandoffId === "string"
                ? { serviceHandoffId: input.runMetadata.serviceHandoffId }
                : {}),
              ...(input.controlSessionId
                ? { controlSessionId: input.controlSessionId }
                : {}),
            },
          });
        }
      }
    } catch (error) {
      if (workflowRollbackRecord && workflowStore) {
        workflowRecord = await this.workflows.compensate(
          workflowLease,
          workflowRecord ?? workflowRollbackRecord,
          workflowRollbackRecord,
          "workflow_resume_prepare_failed",
        );
      }
      if (acquiredWorkflowLease) {
        await workflowLease?.release().catch(() => {});
        workflowLease = undefined;
      }
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    return {
      ok: true,
      prepared: {
        workflowModelAdapters: workflowModelAdapters.adapters,
        ...(workflowProjection ? { workflowProjection } : {}),
        ...(workflowStore ? { workflowStore } : {}),
        ...(workflowRecord ? { workflowRecord } : {}),
        ...(workflowLease ? { workflowLease } : {}),
      },
    };
  }

  async startFresh(input: {
    execution: HostExecution;
    env: WorkflowEpisodeEnvironment;
    payload: RunStartRequestPayload;
    sessionId: string;
    permissionMode: Parameters<typeof createHostRunPolicy>[0]["permissionMode"];
    shouldWrite: boolean;
    priorContext: ContextItem[];
    initialInputContext?: ContextItem;
  }): Promise<
    { ok: true; runId: string } | { ok: false; error: ProtocolError }
  > {
    const { env, payload, sessionId } = input;
    const buildRun = (
      goal: string,
      extraContext: ContextItem[],
      overrides: { maxSteps?: number; runBudget?: RunBudget } = {},
    ) => {
      const episode = resolveWorkflowActorEpisodePlan(env, {
        fallbackRunBudget: overrides.runBudget ?? env.mainAgent.runBudget,
        purpose: overrides.runBudget ? "todo_continuation" : "main_agent",
      });
      const runRef: { current?: ReturnType<typeof createRun> } = {};
      const taskBridge = this.tasks.createRevivalBridge(
        () => runRef.current?.record.id,
      );
      const run = createRun({
        goal,
        context: [
          ...input.priorContext,
          ...(env.preparedSkills?.context ?? []),
          ...extraContext,
        ],
        workspace: env.workspace,
        interactionChannel: env.interactionChannel,
        policy: createHostRunPolicy({
          permissionMode: input.permissionMode,
          shouldWrite: input.shouldWrite,
          targetPath: payload.targetPath,
          confidentialPaths: env.confidentialPaths,
          confidentialDefaults: env.confidentialDefaults,
          writeGuardrails: env.writeGuardrails,
        }),
        promptBuilder: buildAgentPromptBuilder({
          cwd: env.workspaceRoot,
          sessionId,
        }),
        tools: episode.toolSurface.tools,
        workflowHooks: env.workflowHooks,
        model: episode.model,
        maxSteps:
          overrides.maxSteps ??
          resolveWorkflowEpisodeMaxSteps(env.mainAgent, episode.runBudget),
        ...(episode.runBudget !== undefined
          ? { runBudget: episode.runBudget }
          : {}),
        metadata: workflowActorEpisodeRunMetadata(env.runMetadata, episode),
        notificationSources: [taskBridge.notificationSource],
        taskRevivalSource: taskBridge.taskRevivalSource,
        runStore: episodeRunStore(env, sessionId, "main", episode),
      });
      runRef.current = run;
      return run;
    };

    const chainTurns: ContextItem[] = [];
    const started = await this.startChain({
      execution: input.execution,
      episodeKind: "run_start",
      env,
      todoPath: join(env.sessionRootDir, sessionId, "todo.md"),
      sessionId,
      buildRun: (supervisedInput) => {
        const goal = supervisedInput.continuation?.prompt ?? payload.goal;
        const extraContext = supervisedInput.continuation
          ? [
              ...(input.initialInputContext ? [input.initialInputContext] : []),
              ...chainTurns,
              supervisedInput.continuation.context,
            ]
          : input.initialInputContext
            ? [input.initialInputContext]
            : [];
        if (!supervisedInput.continuation) return buildRun(goal, extraContext);
        return buildRun(goal, extraContext, {
          maxSteps: resolveTodoContinuationMaxSteps(env.mainAgent),
          runBudget: resolveTodoContinuationRunBudget(env.mainAgent),
        });
      },
      afterRun: (_supervisedInput, run, result) => {
        const runId = run.record.id;
        if (chainTurns.length === 0) {
          chainTurns.push(
            chainTurn("ctx_chain", "user", payload.goal, `${runId}_goal`),
          );
        }
        if (result.message && result.message.trim().length > 0) {
          chainTurns.push(
            chainTurn(
              "ctx_chain",
              "assistant",
              result.message,
              `${runId}_answer`,
            ),
          );
        }
      },
    });
    return started;
  }

  async resumeCheckpoint(input: {
    execution: HostExecution;
    env: WorkflowEpisodeEnvironment;
    payload: RunResumeRequestPayload;
    checkpoint: NonNullable<
      ReturnType<
        typeof import("@sparkwright/core/internal").loadCheckpointFromRunDir
      >
    >;
    sessionId: string;
    agentId: string;
    permissionMode: Parameters<typeof createHostRunPolicy>[0]["permissionMode"];
    shouldWrite: boolean;
  }): Promise<
    { ok: true; runId: string } | { ok: false; error: ProtocolError }
  > {
    const { env, payload, sessionId, checkpoint } = input;
    const buildContinuationRun = (
      goal: string,
      extraContext: ContextItem[],
    ) => {
      const episode = resolveWorkflowActorEpisodePlan(env, {
        fallbackRunBudget: resolveTodoContinuationRunBudget(env.mainAgent),
        purpose: "todo_continuation",
      });
      const runRef: { current?: ReturnType<typeof createRun> } = {};
      const taskBridge = this.tasks.createRevivalBridge(
        () => runRef.current?.record.id,
      );
      const run = createRun({
        goal,
        context: [...(env.preparedSkills?.context ?? []), ...extraContext],
        workspace: env.workspace,
        interactionChannel: env.interactionChannel,
        policy: createHostRunPolicy({
          permissionMode: input.permissionMode,
          shouldWrite: input.shouldWrite,
          targetPath: payload.targetPath,
          confidentialPaths: env.confidentialPaths,
          confidentialDefaults: env.confidentialDefaults,
          writeGuardrails: env.writeGuardrails,
        }),
        promptBuilder: buildAgentPromptBuilder({
          cwd: env.workspaceRoot,
          sessionId,
        }),
        tools: episode.toolSurface.tools,
        workflowHooks: env.workflowHooks,
        model: episode.model,
        maxSteps: resolveTodoContinuationMaxSteps(env.mainAgent),
        runBudget: episode.runBudget,
        metadata: workflowActorEpisodeRunMetadata(env.runMetadata, episode),
        notificationSources: [taskBridge.notificationSource],
        taskRevivalSource: taskBridge.taskRevivalSource,
        runStore: episodeRunStore(env, sessionId, input.agentId, episode),
      });
      runRef.current = run;
      return run;
    };

    const chainTurns: ContextItem[] = [];
    return this.startChain({
      execution: input.execution,
      episodeKind: "run_resume",
      env,
      todoPath: join(env.sessionRootDir, sessionId, "todo.md"),
      sessionId,
      buildRun: (supervisedInput) =>
        supervisedInput.continuation
          ? buildContinuationRun(supervisedInput.continuation.prompt, [
              ...chainTurns,
              supervisedInput.continuation.context,
            ])
          : (() => {
              const episode = resolveWorkflowActorEpisodePlan(env, {
                fallbackRunBudget: env.mainAgent.runBudget,
                purpose: "main_agent",
              });
              const runRef: {
                current?: ReturnType<typeof resumeRunFromCheckpoint>;
              } = {};
              const taskBridge = this.tasks.createRevivalBridge(
                () => runRef.current?.record.id,
              );
              const run = resumeRunFromCheckpoint(checkpoint, {
                force: payload.force,
                workspace: env.workspace,
                interactionChannel: env.interactionChannel,
                policy: createHostRunPolicy({
                  permissionMode: input.permissionMode,
                  shouldWrite: input.shouldWrite,
                  targetPath: payload.targetPath,
                  confidentialPaths: env.confidentialPaths,
                  confidentialDefaults: env.confidentialDefaults,
                  writeGuardrails: env.writeGuardrails,
                }),
                promptBuilder: buildAgentPromptBuilder({
                  cwd: env.workspaceRoot,
                  sessionId,
                }),
                tools: episode.toolSurface.tools,
                model: episode.model,
                maxSteps: resolveWorkflowEpisodeMaxSteps(
                  env.mainAgent,
                  episode.runBudget,
                ),
                ...(episode.runBudget !== undefined
                  ? { runBudget: episode.runBudget }
                  : {}),
                metadata: workflowActorEpisodeRunMetadata(
                  env.runMetadata,
                  episode,
                ),
                notificationSources: [taskBridge.notificationSource],
                taskRevivalSource: taskBridge.taskRevivalSource,
                runStore: episodeRunStore(
                  env,
                  sessionId,
                  input.agentId,
                  episode,
                ),
              });
              runRef.current = run;
              return run;
            })(),
      afterRun: (_supervisedInput, run, result) => {
        const runId = run.record.id;
        if (chainTurns.length === 0) {
          chainTurns.push(
            chainTurn(
              "ctx_resume_chain",
              "user",
              checkpoint.run.goal,
              `${runId}_goal`,
            ),
          );
        }
        if (result.message && result.message.trim().length > 0) {
          chainTurns.push(
            chainTurn(
              "ctx_resume_chain",
              "assistant",
              result.message,
              `${runId}_answer`,
            ),
          );
        }
      },
    });
  }

  async resumeWorkflow(input: {
    execution: HostExecution;
    env: WorkflowEpisodeEnvironment;
    record: WorkflowRunRecord;
    payload: WorkflowResumeRequestPayload;
    sessionId: string;
    permissionMode: Parameters<typeof createHostRunPolicy>[0]["permissionMode"];
    shouldWrite: boolean;
    priorContext: ContextItem[];
  }): Promise<
    { ok: true; runId: string } | { ok: false; error: ProtocolError }
  > {
    const { env, record, payload, sessionId } = input;
    const buildRun = (
      goal: string,
      extraContext: ContextItem[],
      todoContinuation = false,
    ) => {
      const episode = resolveWorkflowActorEpisodePlan(env, {
        fallbackRunBudget: todoContinuation
          ? resolveTodoContinuationRunBudget(env.mainAgent)
          : env.mainAgent.runBudget,
        purpose: todoContinuation ? "todo_continuation" : "main_agent",
      });
      const runRef: { current?: ReturnType<typeof createRun> } = {};
      const taskBridge = this.tasks.createRevivalBridge(
        () => runRef.current?.record.id,
      );
      const run = createRun({
        goal,
        context: [
          ...input.priorContext,
          ...(env.preparedSkills?.context ?? []),
          ...extraContext,
        ],
        workspace: env.workspace,
        interactionChannel: env.interactionChannel,
        policy: createHostRunPolicy({
          permissionMode: input.permissionMode,
          shouldWrite: input.shouldWrite,
          targetPath: payload.targetPath,
          confidentialPaths: env.confidentialPaths,
          confidentialDefaults: env.confidentialDefaults,
          writeGuardrails: env.writeGuardrails,
        }),
        promptBuilder: buildAgentPromptBuilder({
          cwd: env.workspaceRoot,
          sessionId,
        }),
        tools: episode.toolSurface.tools,
        workflowHooks: env.workflowHooks,
        model: episode.model,
        maxSteps: resolveWorkflowEpisodeMaxSteps(
          env.mainAgent,
          episode.runBudget,
        ),
        ...(episode.runBudget !== undefined
          ? { runBudget: episode.runBudget }
          : {}),
        metadata: workflowActorEpisodeRunMetadata(env.runMetadata, episode),
        notificationSources: [taskBridge.notificationSource],
        taskRevivalSource: taskBridge.taskRevivalSource,
        runStore: episodeRunStore(env, sessionId, "main", episode),
      });
      runRef.current = run;
      return run;
    };

    return this.startChain({
      execution: input.execution,
      episodeKind: "workflow_resume",
      env,
      todoPath: join(env.sessionRootDir, sessionId, "todo.md"),
      sessionId,
      buildRun: (supervisedInput) =>
        supervisedInput.continuation
          ? buildRun(
              supervisedInput.continuation.prompt,
              [supervisedInput.continuation.context],
              true,
            )
          : buildRun(
              `Resume workflow ${record.assetName} at node ${record.currentNodeId ?? "(unknown)"}.`,
              [],
            ),
    });
  }

  private async startChain(input: {
    execution: HostExecution;
    episodeKind: "run_start" | "run_resume" | "workflow_resume";
    env: WorkflowEpisodeEnvironment;
    sessionId: string;
    todoPath: string;
    buildRun: (
      supervisedInput: TodoSupervisedRunInput,
    ) => ReturnType<typeof createRun>;
    afterRun?: (
      supervisedInput: TodoSupervisedRunInput,
      run: ReturnType<typeof createRun>,
      result: RunResult,
    ) => void | Promise<void>;
  }): Promise<
    { ok: true; runId: string } | { ok: false; error: ProtocolError }
  > {
    const { env, sessionId, execution } = input;
    const executionAbort = execution.abortController;
    execution.bindSession(sessionId);
    const runCleanups: Array<() => void> = [];
    const stopWorkflowLeaseRefresh = this.workflows.startLeaseRefresh(
      env.workflowLease,
    );
    execution.addCleanup(async () => {
      stopWorkflowLeaseRefresh();
      await env.workflowLease?.release().catch(() => {});
      env.workflowLease = undefined;
      for (const cleanup of runCleanups.splice(0)) cleanup();
      await env.preparedMcp?.close().catch(() => {});
    });
    if (executionAbort.signal.aborted) {
      await execution.disposeResources();
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: "interactive execution was cancelled during assembly",
        },
      };
    }

    const registerActiveRun = async (
      run: ReturnType<typeof createRun>,
      runId: string,
    ): Promise<SparkwrightEvent[]> => {
      env.parentRunRef.current = run;
      env.runIdHolder.value = runId;
      if (env.workflowLease && env.workflowRecord) {
        const episodeAllowedTools = workflowEpisodeAllowedTools(
          env.workflowRecord,
        );
        const episodeMetadata =
          workflowEpisodeMetadataFromRun(run) ??
          workflowActorEpisodeMetadata(
            resolveWorkflowActorEpisodePlan(env, { purpose: "main_agent" }),
          );
        env.workflowRecord = await this.workflows.mutate(
          env.workflowLease,
          env.workflowRecord,
          {
            activeRunId: runId as RunId,
            appendRunId: runId as RunId,
            parentRunId: env.workflowRecord.parentRunId ?? (runId as RunId),
            evidenceRefs: this.workflows.appendEvidenceRef(
              env.workflowRecord.evidenceRefs,
              { kind: "run", ref: runId },
            ),
            metadata: {
              activeRunId: runId,
              resumeRun: env.workflowRecord.runIds.length > 0,
              episodeDriver: "workflow_actor",
              episodeKind: input.episodeKind,
              workflowEpisode: episodeMetadata,
              ...(episodeAllowedTools
                ? { episodeAllowedTools: episodeAllowedTools.normalized }
                : {}),
            },
          },
        );
      }
      const closeEventHooks = bindConfiguredEventHooks({
        hooks: env.eventHookConfig,
        run,
        workspaceRoot: env.workspaceRoot,
        sandbox: env.hookSandbox,
        http: env.hookHttp,
        skillRoots: env.hookSkillRoots,
        configPaths: env.hookConfigPaths,
        getRun: () => env.parentRunRef.current,
        agentTool: env.delegateAgentTool,
      });
      runCleanups.push(closeEventHooks);
      execution.attachRun({
        runId,
        run,
        trace: env.trace,
        sessionId,
        ...(env.workflowRecord
          ? {
              workflowRunId: env.workflowRecord.id,
              processWorkflowControls: async () => {
                if (
                  !env.workflowStore ||
                  !env.workflowLease ||
                  !env.workflowRecord
                )
                  return;
                env.workflowRecord = await this.workflows.processLiveControls({
                  store: env.workflowStore,
                  writer: env.workflowLease,
                  record: env.workflowRecord,
                  cancel: () =>
                    run.cancel({ reason: "workflow_control_cancel" }),
                });
              },
            }
          : {}),
        closeCapabilities: async () => {
          closeEventHooks();
          await env.preparedMcp?.close();
        },
      });
      if (env.workflowRecord) {
        const controlTimer = setInterval(() => {
          void execution.activeRun?.processWorkflowControls?.().catch(() => {});
        }, 500);
        controlTimer.unref?.();
        runCleanups.push(() => clearInterval(controlTimer));
      }
      const collected: SparkwrightEvent[] = [];
      run.events.subscribe((event: SparkwrightEvent) => {
        env.trace.append(event);
        collected.push(event);
        this.emit({
          envelope: "event",
          id: nextMessageId("evt"),
          kind: "run.event",
          timestamp: nowIso(),
          payload: { runId, event },
        });
      });
      run.events.subscribe((event: SparkwrightEvent) => {
        observeSkillUsageEvent(env.skillUsageRecorder, event);
      });
      env.pendingExtensionEvents.flush(run.events);
      return collected;
    };

    let resolveFirstRunId!: (id: string) => void;
    let rejectFirstRunId!: (err: unknown) => void;
    const firstRunId = new Promise<string>((resolve, reject) => {
      resolveFirstRunId = resolve;
      rejectFirstRunId = reject;
    });
    let firstRunStarted = false;
    let previousRunId: string | undefined;
    let lastRunId = "";
    let executionTerminalState: "completed" | "failed" | "cancelled" = "failed";

    const supervised = execution.runEpisodeChain({
      todoPath: input.todoPath,
      sessionId,
      maxContinuations: MAIN_TODO_MAX_CONTINUATIONS,
      maxStalledContinuations: MAIN_TODO_MAX_STALLED_CONTINUATIONS,
      continuationToolAvailability: (requiredTool) => {
        const plan = resolveWorkflowActorEpisodePlan(env, {
          fallbackRunBudget: resolveTodoContinuationRunBudget(env.mainAgent),
          purpose: "todo_continuation",
        }).toolSurface;
        const toolName = plan.missingRequiredTools.find(
          (name) => name === requiredTool,
        );
        return toolName
          ? {
              available: false as const,
              toolName,
              reason: "not admitted for this run episode",
            }
          : { available: true as const };
      },
      runOnce: async (supervisedInput) => {
        const run = input.buildRun(supervisedInput);
        const runId = run.record.id;
        lastRunId = runId;
        const collected = await registerActiveRun(run, runId);
        if (!firstRunStarted) {
          firstRunStarted = true;
          resolveFirstRunId(runId);
        } else if (supervisedInput.continuation) {
          this.emit({
            envelope: "event",
            id: nextMessageId("evt"),
            kind: "run.continuation",
            timestamp: nowIso(),
            payload: {
              runId,
              previousRunId: previousRunId ?? runId,
              continuationCount:
                supervisedInput.continuation.metadata.continuationCount,
              reason: supervisedInput.continuation.metadata.reason,
            },
          });
        }
        const result = await run.start();
        previousRunId = runId;
        await input.afterRun?.(supervisedInput, run, result);
        await this.recordUsage(env, run, result);
        if (executionAbort.signal.aborted) {
          return {
            result: {
              ...result,
              state: "cancelled" as const,
              stopReason: "manual_cancelled",
            },
            events: collected,
          };
        }
        return { result, events: collected };
      },
    });

    supervised
      .then(async (outcome) => {
        executionTerminalState =
          outcome.result.state === "cancelled"
            ? "cancelled"
            : outcome.result.state === "failed"
              ? "failed"
              : "completed";
        const handoff =
          !executionAbort.signal.aborted && outcome.decision.kind === "handoff"
            ? {
                reason: outcome.decision.reason,
                message: outcome.decision.message,
              }
            : undefined;
        const finalized = await this.workflows.finalizeAfterRun(
          { record: env.workflowRecord, lease: env.workflowLease },
          lastRunId as RunId,
          outcome.result,
        );
        env.workflowRecord = finalized.record;
        env.workflowLease = finalized.lease;
        this.emit({
          envelope: "event",
          id: nextMessageId("evt"),
          kind: "run.completed",
          timestamp: nowIso(),
          payload: {
            runId: lastRunId,
            state: outcome.result.state,
            stopReason: outcome.result.stopReason,
            ...(outcome.result.metadata.outcome
              ? { outcome: outcome.result.metadata.outcome }
              : {}),
            ...(outcome.result.failure
              ? { failure: outcome.result.failure }
              : {}),
            ...(handoff ? { todoHandoff: handoff } : {}),
          },
        });
      })
      .catch((err: unknown) => {
        if (!firstRunStarted) rejectFirstRunId(err);
        const message = err instanceof Error ? err.message : String(err);
        const failure: RunFailureEnvelope = {
          category: "runtime",
          code: "internal_error",
          message,
        };
        return this.workflows
          .finalizeAfterSupervisorError(
            { record: env.workflowRecord, lease: env.workflowLease },
            lastRunId ? (lastRunId as RunId) : undefined,
            err,
          )
          .then((finalized) => {
            env.workflowRecord = finalized.record;
            env.workflowLease = finalized.lease;
          })
          .finally(() => {
            this.emit({
              envelope: "event",
              id: nextMessageId("evt"),
              kind: "run.failed",
              timestamp: nowIso(),
              payload: { runId: lastRunId, failure },
            });
          });
      })
      .finally(async () => {
        await execution.disposeResources();
        execution.detachRun();
        execution.finish(
          executionAbort.signal.aborted ? "cancelled" : executionTerminalState,
        );
        this.releaseExecution(execution);
        execution.denyPendingApprovals();
      });

    try {
      return { ok: true, runId: await firstRunId };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private async recordUsage(
    env: WorkflowEpisodeEnvironment,
    run: ReturnType<typeof createRun>,
    result: RunResult,
  ): Promise<void> {
    if (!env.workflowLease || !env.workflowRecord) return;
    const latest = await env.workflowLease.readFresh();
    if (!latest) return;
    const episode = workflowEpisodeMetadataFromRun(run);
    const usage = run.usage();
    env.workflowRecord = await this.workflows.mutate(
      env.workflowLease,
      latest,
      {
        metadata: this.workflows.appendEpisodeUsage(latest.metadata, {
          runId: run.record.id,
          stopReason: result.stopReason,
          state: result.state,
          ...(episode ? { episode } : {}),
          usage: usage as unknown as Record<string, unknown>,
        }),
      },
    );
  }
}

export async function resolveWorkflowModelAdapters(input: {
  definition: WorkflowExecutableDefinition;
  parentModelRef: string;
  goal: string;
  workspaceRoot: string;
  targetPath?: string;
}): Promise<
  | {
      ok: true;
      adapters: Map<
        string,
        { adapter: ModelAdapter; resolved: ResolvedModelConfig }
      >;
    }
  | { ok: false; message: string }
> {
  const adapters = new Map<
    string,
    { adapter: ModelAdapter; resolved: ResolvedModelConfig }
  >();
  const refs = new Set<string>();
  for (const node of input.definition.nodes) {
    const modelRef = workflowNodeModelRef(input.definition, node);
    if (modelRef && modelRef !== input.parentModelRef) refs.add(modelRef);
  }
  for (const modelRef of refs) {
    const built = await createModel({
      modelRef,
      goal: input.goal,
      workspaceRoot: input.workspaceRoot,
      ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    });
    if (!built.ok) {
      return {
        ok: false,
        message: `Workflow node model "${modelRef}": ${built.message}`,
      };
    }
    adapters.set(modelRef, {
      adapter: built.adapter,
      resolved: built.resolved,
    });
  }
  return { ok: true, adapters };
}

export function resolveWorkflowActorEpisodePlan(
  env: Pick<
    WorkflowEpisodeEnvironment,
    | "model"
    | "modelRef"
    | "resolvedModel"
    | "workflowModelAdapters"
    | "tools"
    | "workflowRecord"
  >,
  options: {
    fallbackRunBudget?: RunBudget;
    purpose: WorkflowActorEpisodePlan["budgetScope"];
  },
): WorkflowActorEpisodePlan {
  const node = currentWorkflowRecordNode(env.workflowRecord);
  const nodeModelRef =
    node && env.workflowRecord?.definitionSnapshot
      ? workflowNodeModelRef(env.workflowRecord.definitionSnapshot, node)
      : undefined;
  const modelRef = nodeModelRef ?? env.modelRef;
  const model =
    nodeModelRef && env.workflowModelAdapters.has(modelRef)
      ? env.workflowModelAdapters.get(modelRef)!
      : { adapter: env.model, resolved: env.resolvedModel };
  const workflowAllowedTools = workflowEpisodeAllowedTools(env.workflowRecord);
  const toolSurface = resolveRunToolSurface({
    tools: env.tools,
    workflowAllowedTools: workflowAllowedTools?.normalized,
    ...(options.purpose === "todo_continuation"
      ? { requiredTools: [TODO_CONTINUATION_REQUIRED_TOOL] }
      : {}),
  });
  const runBudget = narrowRunBudgets(
    options.fallbackRunBudget,
    node?.runBudget,
  );
  return {
    model: model.adapter,
    modelRef,
    resolvedModel: model.resolved,
    ...(node ? { nodeId: node.id } : {}),
    ...(node && env.workflowRecord
      ? { attempt: env.workflowRecord.attempts[node.id] ?? 1 }
      : {}),
    ...(runBudget ? { runBudget } : {}),
    budgetScope: options.purpose,
    toolSurface,
  };
}

function episodeRunStore(
  env: WorkflowEpisodeEnvironment,
  sessionId: string,
  agentId: string,
  episode: WorkflowActorEpisodePlan,
) {
  return createSessionRunStoreFactory({
    sessionStore: env.sessionStore,
    sessionId,
    runStoreFactory: createSessionFileRunStoreFactory({
      sessionRootDir: env.sessionRootDir,
      sessionId,
      agentId,
      traceLevel: env.traceLevel,
    }),
    metadata: workflowActorEpisodeRunMetadata(env.runStoreMetadata, episode),
  });
}

function chainTurn(
  prefix: string,
  role: "user" | "assistant",
  content: string,
  idSuffix: string,
): ContextItem {
  return {
    id: `${prefix}_${idSuffix}` as ContextItem["id"],
    type: role,
    content: content.trim(),
    metadata: { layer: "conversation", stability: "session" },
  };
}

function resolveMainAgentMaxSteps(profile: AgentProfile): number {
  if (profile.maxSteps !== undefined) return profile.maxSteps;
  const modelCallBudget = profile.runBudget?.maxModelCalls;
  if (modelCallBudget !== undefined && modelCallBudget >= 1) {
    return modelCallBudget;
  }
  return MAIN_AGENT_MAX_STEPS_BACKSTOP;
}

function resolveTodoContinuationMaxSteps(profile: AgentProfile): number {
  return Math.min(
    resolveMainAgentMaxSteps(profile),
    MAIN_TODO_CONTINUATION_MAX_STEPS,
  );
}

function resolveTodoContinuationRunBudget(profile: AgentProfile): RunBudget {
  return {
    ...(profile.runBudget ?? {}),
    maxModelCalls: minBudgetValue(
      profile.runBudget?.maxModelCalls,
      MAIN_TODO_CONTINUATION_MAX_MODEL_CALLS,
    ),
    maxToolCalls: minBudgetValue(
      profile.runBudget?.maxToolCalls,
      MAIN_TODO_CONTINUATION_MAX_TOOL_CALLS,
    ),
  };
}

function minBudgetValue(
  configured: number | undefined,
  continuationLimit: number,
): number {
  return configured === undefined
    ? continuationLimit
    : Math.min(configured, continuationLimit);
}

function resolveWorkflowEpisodeMaxSteps(
  profile: AgentProfile,
  runBudget: RunBudget | undefined,
): number {
  const base = resolveMainAgentMaxSteps(profile);
  return runBudget?.maxModelCalls !== undefined
    ? Math.min(base, runBudget.maxModelCalls)
    : base;
}

function narrowRunBudgets(
  upstream: RunBudget | undefined,
  downstream: RunBudget | undefined,
): RunBudget | undefined {
  if (!upstream) return downstream ? { ...downstream } : undefined;
  if (!downstream) return { ...upstream };
  const minimum = (
    left: number | undefined,
    right: number | undefined,
  ): number | undefined => {
    if (left === undefined) return right;
    if (right === undefined) return left;
    return Math.min(left, right);
  };
  return {
    maxDurationMs: minimum(upstream.maxDurationMs, downstream.maxDurationMs),
    maxModelCalls: minimum(upstream.maxModelCalls, downstream.maxModelCalls),
    maxToolCalls: minimum(upstream.maxToolCalls, downstream.maxToolCalls),
    maxTokens: minimum(upstream.maxTokens, downstream.maxTokens),
    maxCostUsd: minimum(upstream.maxCostUsd, downstream.maxCostUsd),
  };
}

function workflowActorEpisodeRunMetadata(
  base: Record<string, unknown>,
  episode: WorkflowActorEpisodePlan,
): Record<string, unknown> {
  return {
    ...base,
    resolvedModel: episode.resolvedModel,
    workflowEpisode: workflowActorEpisodeMetadata(episode),
  };
}

function workflowActorEpisodeMetadata(
  episode: WorkflowActorEpisodePlan,
): Record<string, unknown> {
  return {
    modelRef: episode.modelRef,
    budgetScope: episode.budgetScope,
    ...(episode.nodeId ? { nodeId: episode.nodeId } : {}),
    ...(episode.attempt !== undefined ? { attempt: episode.attempt } : {}),
    ...(episode.runBudget ? { runBudget: { ...episode.runBudget } } : {}),
  };
}

function workflowEpisodeMetadataFromRun(
  run: ReturnType<typeof createRun>,
): Record<string, unknown> | undefined {
  const raw = run.record.metadata.workflowEpisode;
  return isPlainRecord(raw) ? cloneJsonLike(raw) : undefined;
}

function currentWorkflowRecordNode(
  record: WorkflowRunRecord | undefined,
): WorkflowNodeDefinition | undefined {
  if (!record || !record.currentNodeId) return undefined;
  return record.definitionSnapshot.nodes.find(
    (candidate) => candidate.id === record.currentNodeId,
  );
}

function workflowNodeModelRef(
  definition: WorkflowExecutableDefinition,
  node: WorkflowNodeDefinition,
): string | undefined {
  if (!node.model) return undefined;
  const tiers = workflowModelTiers(definition);
  return tiers[node.model] ?? node.model;
}

function workflowModelTiers(
  definition: WorkflowExecutableDefinition,
): Record<string, string> {
  const config = definition.config;
  if (!isPlainRecord(config)) return {};
  const raw = isPlainRecord(config.modelTiers)
    ? config.modelTiers
    : isPlainRecord(config.model_tiers)
      ? config.model_tiers
      : undefined;
  if (!raw) return {};
  return Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) =>
      typeof value === "string" && value.trim() !== ""
        ? [[key, value.trim()]]
        : [],
    ),
  );
}

function workflowEpisodeAllowedTools(
  record: WorkflowRunRecord | undefined,
): { nodeId: string; normalized: string[] } | undefined {
  if (!record || !record.currentNodeId) return undefined;
  const node = record.definitionSnapshot.nodes.find(
    (candidate) => candidate.id === record.currentNodeId,
  );
  if (!node || (node.execute !== undefined && node.execute !== "model")) {
    return undefined;
  }
  if (!node.tools || node.tools.length === 0) return undefined;
  return {
    nodeId: node.id,
    normalized: [...new Set(node.tools)],
  };
}

function cloneJsonLike<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
