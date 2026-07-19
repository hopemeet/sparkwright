import {
  commandExpectationSatisfied,
  createContextItemId,
  createRunId,
  type ContextItem,
  type FactLedgerSnapshot,
  type RuntimeContext,
  type ToolDefinition,
  type WorkflowHook,
  type WorkflowHookInput,
  type WorkflowHookName,
  type WorkflowHookResult,
} from "@sparkwright/core";
import {
  advanceWorkflowState,
  assertWorkflowRuntimeDefinition,
  createInitialWorkflowRuntimeState,
  type WorkflowCommandVerifierDefinition,
  type WorkflowDiffScopeVerifierDefinition,
  type WorkflowDefinition,
  type WorkflowExecutableDefinition,
  type WorkflowEvidenceRef,
  type WorkflowNodeDefinition,
  type WorkflowNodeVerdict,
  type WorkflowParallelBranchState,
  type PinnedWorkflowDefinition,
  type WorkflowRuntimeState,
  type WorkflowTransitionDecision,
  type WorkflowTransitionDefinition,
  type WorkflowVerifierDefinition,
  type WorkflowWaitState,
} from "@sparkwright/agent-runtime";
import type { CapabilityWorkflowHookConfig } from "./config-zod-schema.js";
import {
  createConfiguredWorkflowHooks,
  type CreateConfiguredWorkflowHooksOptions,
} from "./workflow-hooks.js";
import { runWorkflowScriptNode } from "./workflow-node-api.js";

const DEFAULT_STOP_RUNTIME_ERROR_THRESHOLD = 3;
const DEFAULT_PARALLEL_MAX_CONCURRENCY = 4;
const MAX_PARALLEL_BRANCHES = 8;

export interface CreateWorkflowProjectionHooksOptions extends Omit<
  CreateConfiguredWorkflowHooksOptions,
  "hooks" | "workflowActive"
> {
  definition: WorkflowDefinition | PinnedWorkflowDefinition;
  taskTool?: ToolDefinition;
  delegateParallelTool?: ToolDefinition;
  workflowRunId?: string;
  initialState?: WorkflowRuntimeState;
  resumeVerificationNodeIds?: readonly string[];
  stopRuntimeErrorThreshold?: number;
  builtinVerifiers?: Record<string, WorkflowBuiltinVerifierHandler>;
  onStateSnapshot?: (
    snapshot: WorkflowProjectionStateSnapshot,
  ) => void | Promise<void>;
  getEvidenceRefs?: (nodeId: string) => readonly WorkflowEvidenceRef[];
  allowScriptWrite?: boolean;
  isToolAvailable?: (toolName: string) => boolean;
  isScopedToolSearchAvailable?: () => boolean;
  /** Owner that persists cancellation/failure after a Core episode ends. */
  runEndTerminalOwner?: "projection" | "episode_chain";
  /** @internal Test-only fault injection for D23 fail-closed gate assertions. */
  faultInjection?: Partial<Record<WorkflowHookName, string>>;
}

export interface WorkflowProjectionHookSet {
  workflowRunId: string;
  hooks: WorkflowHook[];
  getState(): WorkflowRuntimeState;
}

export interface WorkflowProjectionStateSnapshot {
  workflowRunId: string;
  definition: WorkflowDefinition | PinnedWorkflowDefinition;
  state: WorkflowRuntimeState;
  phase:
    | "started"
    | "node_started"
    | "node_completed"
    | "waiting"
    | "interrupted"
    | "terminal";
  nodeId?: string;
  attempt?: number;
  verdict?: WorkflowNodeVerdict;
  evidenceRefs?: WorkflowEvidenceRef[];
  decision?: WorkflowTransitionDecision;
  terminalStatus?: "completed" | "failed" | "cancelled";
  wait?: WorkflowWaitState;
  failure?: {
    kind: "verdict" | "runtime" | "cancelled";
    code: string;
    message: string;
    metadata?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

export interface WorkflowBuiltinVerifierInput {
  workflowRunId: string;
  node: WorkflowNodeDefinition;
  verifier: WorkflowCommandVerifierDefinition;
  hookInput: WorkflowHookInput;
}

export type WorkflowBuiltinVerifierHandler = (
  input: WorkflowBuiltinVerifierInput,
) => WorkflowHookResult | void | Promise<WorkflowHookResult | void>;

interface WorkflowNodeVerdictEvaluation {
  verdict: WorkflowNodeVerdict;
  evidenceRefs: WorkflowEvidenceRef[];
}

interface WorkflowParallelBranchExecution {
  node: WorkflowNodeDefinition;
  state: WorkflowParallelBranchState;
}

export function createWorkflowProjectionHooks(
  options: CreateWorkflowProjectionHooksOptions,
): WorkflowProjectionHookSet {
  validateWorkflowProjectionDefinition(options.definition);
  const workflowRunId = options.workflowRunId ?? `workflow_${createRunId()}`;
  const familyName = `workflow:${workflowRunId}`;
  const stopRuntimeErrorThreshold =
    options.stopRuntimeErrorThreshold ?? DEFAULT_STOP_RUNTIME_ERROR_THRESHOLD;
  let state = options.initialState
    ? cloneRuntimeState(options.initialState)
    : createInitialWorkflowRuntimeState(options.definition);
  let workflowStarted = false;
  let terminalEmitted = false;
  let stopRuntimeErrors = 0;
  const nodeStartKeys = new Set<string>();
  const nodeEntryEpochs = new Map<string, number>();
  const pendingResumeVerificationNodeIds = new Set(
    options.resumeVerificationNodeIds ?? [],
  );

  const emit = (
    input: WorkflowHookInput,
    type: Parameters<NonNullable<WorkflowHookInput["events"]>["emit"]>[0],
    payload: Record<string, unknown>,
  ): void => {
    input.events?.emit(type, {
      workflowRunId,
      assetName: options.definition.assetName,
      ...(isPinnedWorkflowDefinition(options.definition)
        ? {
            packageHash: options.definition.packageHash,
            packageHashPolicyVersion:
              options.definition.packageHashPolicyVersion,
          }
        : {}),
      ...(options.definition.version
        ? { version: options.definition.version }
        : {}),
      ...payload,
    });
  };

  const emitInterrupted = (
    input: WorkflowHookInput,
    kind: string,
    metadata: Record<string, unknown> = {},
  ): void => {
    emit(input, "workflow.interrupted", {
      kind,
      ...metadata,
    });
  };

  const emitRuntimeFailure = (
    input: WorkflowHookInput,
    message: string,
    metadata: Record<string, unknown> = {},
  ): void => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    const previousState = cloneRuntimeState(state);
    state = {
      status: "failed",
      attempts: previousState.attempts,
      ...(previousState.parallelBranches
        ? { parallelBranches: previousState.parallelBranches }
        : {}),
      transitionLog: previousState.transitionLog,
      failure: {
        reason: "runtime",
        nodeId: previousState.currentNodeId,
        metadata: { message, ...metadata },
      },
    };
    emit(input, "workflow.failed", {
      reason: "runtime",
      failure: {
        kind: "runtime",
        code: "WORKFLOW_RUNTIME_FAILED",
        message,
        metadata,
      },
    });
  };

  const persistSnapshot = async (
    snapshot: Omit<
      WorkflowProjectionStateSnapshot,
      "workflowRunId" | "definition" | "state"
    >,
  ): Promise<void> => {
    await options.onStateSnapshot?.({
      workflowRunId,
      definition: options.definition,
      state: cloneRuntimeState(state),
      ...snapshot,
    });
  };

  const maybeThrowInjected = (hook: WorkflowHookName): void => {
    const message = options.faultInjection?.[hook];
    if (message) throw new Error(message);
  };

  const withStopRuntimeBound = async (
    input: WorkflowHookInput,
    run: () => WorkflowHookResult | void | Promise<WorkflowHookResult | void>,
  ): Promise<WorkflowHookResult | void> => {
    try {
      maybeThrowInjected("Stop");
      return await run();
    } catch (cause) {
      stopRuntimeErrors += 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (stopRuntimeErrors >= stopRuntimeErrorThreshold) {
        emitInterrupted(input, "runtime_error_threshold", {
          errors: stopRuntimeErrors,
          threshold: stopRuntimeErrorThreshold,
          message,
        });
        emitRuntimeFailure(input, message, {
          errors: stopRuntimeErrors,
          threshold: stopRuntimeErrorThreshold,
        });
        return {
          status: "continue",
          metadata: {
            workflowRunId,
            runtimeErrorThresholdReached: true,
            errors: stopRuntimeErrors,
            threshold: stopRuntimeErrorThreshold,
          },
        };
      }
      throw cause;
    }
  };

  const drainNonModelNodes = async (
    input: WorkflowHookInput,
    mode: "turn-start" | "stop",
  ): Promise<WorkflowHookResult | undefined> => {
    let drained = 0;
    while (state.status === "running" && state.currentNodeId) {
      if (drained >= 50) {
        emitRuntimeFailure(
          input,
          "Workflow non-model node drain exceeded 50 transitions.",
          {
            mode,
          },
        );
        return {
          status: "continue",
          metadata: { workflowRunId, nonModelDrainExceeded: true },
        };
      }
      const node = currentNode(options.definition, state);
      if (!node) {
        emitRuntimeFailure(
          input,
          `Workflow node "${state.currentNodeId}" does not exist.`,
        );
        return { status: "continue", metadata: { workflowRunId } };
      }
      if (nodeExecuteKind(node) === "model") return undefined;

      drained += 1;
      emitNodeStartedIfNeeded(input, node, state);
      await persistSnapshot({
        phase: "node_started",
        nodeId: node.id,
        attempt: state.attempts[node.id] ?? 1,
        metadata: { runner: "non_model", execute: nodeExecuteKind(node) },
      });

      if (nodeExecuteKind(node) === "human") {
        const wait = humanWaitState(node);
        emit(input, "workflow.waiting", {
          nodeId: node.id,
          attempt: state.attempts[node.id] ?? 1,
          wait,
        });
        await persistSnapshot({
          phase: "waiting",
          nodeId: node.id,
          attempt: state.attempts[node.id] ?? 1,
          wait,
          metadata: { runner: "non_model", execute: "human" },
        });
        return {
          status: "continue",
          context:
            mode === "turn-start"
              ? [humanWaitingContextItem(workflowRunId, node, wait)]
              : undefined,
          metadata: { workflowRunId, nodeId: node.id, waiting: true, wait },
        };
      }

      const completedAttempt = state.attempts[node.id] ?? 1;
      const execution = await executeNonModelNode(
        input,
        node,
        completedAttempt,
      );
      const advanced = advanceWorkflowState({
        definition: options.definition,
        state,
        verdict: execution.verdict,
      });
      state = advanced.state;
      emitNodeCompleted(
        input,
        node,
        completedAttempt,
        execution.verdict,
        execution.evidenceRefs,
        advanced.decision,
      );

      if (advanced.decision.type === "complete") {
        return hookResultForDecision(
          input,
          node,
          completedAttempt,
          execution.verdict,
          execution.evidenceRefs,
          advanced.decision,
        );
      }
      if (advanced.decision.type === "fail") {
        if (mode === "turn-start") {
          await hookResultForDecision(
            input,
            node,
            completedAttempt,
            execution.verdict,
            execution.evidenceRefs,
            advanced.decision,
          );
          return {
            status: "block",
            reason: advanced.decision.reason,
            metadata: { workflowRunId, decision: advanced.decision },
          };
        }
        return hookResultForDecision(
          input,
          node,
          completedAttempt,
          execution.verdict,
          execution.evidenceRefs,
          advanced.decision,
        );
      }

      const next = currentNode(options.definition, state);
      if (!next || nodeExecuteKind(next) !== "model") {
        await persistSnapshot({
          phase: "node_completed",
          nodeId: node.id,
          attempt: completedAttempt,
          verdict: execution.verdict,
          evidenceRefs: [...execution.evidenceRefs],
          decision: advanced.decision,
        });
        continue;
      }

      if (mode === "turn-start") {
        await persistSnapshot({
          phase: "node_completed",
          nodeId: node.id,
          attempt: completedAttempt,
          verdict: execution.verdict,
          evidenceRefs: [...execution.evidenceRefs],
          decision: advanced.decision,
        });
        return undefined;
      }

      return hookResultForDecision(
        input,
        node,
        completedAttempt,
        execution.verdict,
        execution.evidenceRefs,
        advanced.decision,
      );
    }
    return undefined;
  };

  const executeNonModelNode = async (
    input: WorkflowHookInput,
    node: WorkflowNodeDefinition,
    attempt: number,
  ): Promise<WorkflowNodeVerdictEvaluation> => {
    try {
      if (node.execute === "command") {
        return await executeCommandNode(input, node, attempt);
      }
      if (node.execute === "delegate") {
        return await executeDelegateNode(input, node, attempt);
      }
      if (node.execute === "task") {
        return await executeTaskNode(input, node, attempt);
      }
      if (node.execute === "script") {
        return await runWorkflowScriptNode({
          workflowRunId,
          assetName: options.definition.assetName,
          sourceDir: options.definition.sourceDir,
          node,
          attempt,
          hookInput: input,
          workspaceRoot: options.workspaceRoot,
          sandbox: options.sandbox,
          sandboxRuntime: options.sandboxRuntime,
          skillRoots: options.skillRoots,
          configPaths: options.configPaths,
          allowWrite: options.allowScriptWrite === true,
          getEvidence: (nodeId) => options.getEvidenceRefs?.(nodeId) ?? [],
          invokePrimitive: (action) =>
            runConfiguredNodeAction(input, node.id, action),
        });
      }
      if (node.execute === "parallel") {
        return await executeParallelNode(input, node, attempt);
      }
      if (node.execute === "join") {
        return executeJoinNode(node, attempt);
      }
      return {
        verdict: {
          status: "runtime_error",
          reason: `Workflow node "${node.id}" execute kind "${node.execute}" is not supported by the non-model runner.`,
        },
        evidenceRefs: [],
      };
    } catch (cause) {
      return {
        verdict: {
          status: "runtime_error",
          reason: cause instanceof Error ? cause.message : String(cause),
          metadata: {
            execute: nodeExecuteKind(node),
          },
        },
        evidenceRefs: [],
      };
    }
  };

  const executeCommandNode = async (
    input: WorkflowHookInput,
    node: WorkflowNodeDefinition,
    attempt: number,
  ): Promise<WorkflowNodeVerdictEvaluation> => {
    const command = node.command;
    if (!command) {
      return {
        verdict: {
          status: "runtime_error",
          reason: `Workflow command node "${node.id}" has no command definition.`,
        },
        evidenceRefs: [],
      };
    }
    const result = await runConfiguredNodeAction(input, node.id, {
      type: "command",
      command: command.command,
      args: command.args ?? [],
      ...(command.cwd ? { cwd: command.cwd } : {}),
      ...(command.timeoutMs !== undefined
        ? { timeoutMs: command.timeoutMs }
        : {}),
      ...(command.maxOutputBytes !== undefined
        ? { maxOutputBytes: command.maxOutputBytes }
        : {}),
      injectOutput: "never",
    });
    const metadata = isRecord(result.metadata) ? result.metadata : {};
    const exitCode = numberOrNullValue(metadata.exitCode);
    const timedOut = metadata.timedOut === true;
    const expect = command.expect ?? "zero";
    const passed = commandExpectationSatisfied(expect, { exitCode, timedOut });
    const evidenceRefs = [
      {
        kind: "run" as const,
        ref: input.run.id,
        nodeId: node.id,
        metadata: {
          attempt,
          execute: "command",
          command: command.command,
          args: command.args ?? [],
          exitCode,
          timedOut,
          expect,
        },
      },
    ];
    return {
      verdict: passed
        ? {
            status: "passed",
            reason: "command_passed",
            metadata: { execute: "command", exitCode, timedOut, expect },
          }
        : {
            status: "failed",
            reason: "command_failed",
            metadata: { execute: "command", exitCode, timedOut, expect },
          },
      evidenceRefs,
    };
  };

  const executeDelegateNode = async (
    input: WorkflowHookInput,
    node: WorkflowNodeDefinition,
    attempt: number,
  ): Promise<WorkflowNodeVerdictEvaluation> => {
    const delegate = node.delegate;
    if (!delegate) {
      return {
        verdict: {
          status: "runtime_error",
          reason: `Workflow delegate node "${node.id}" has no delegate definition.`,
        },
        evidenceRefs: [],
      };
    }
    const result = await runConfiguredNodeAction(input, node.id, {
      type: "agent",
      agentId: delegate.agentId,
      goal: delegate.goal,
      ...(delegate.metadata ? { metadata: delegate.metadata } : {}),
      injectOutput: "never",
    });
    return {
      verdict: {
        status: "passed",
        reason: "delegate_completed",
        metadata: {
          execute: "delegate",
          actionResult: result.metadata,
        },
      },
      evidenceRefs: [
        {
          kind: "run" as const,
          ref: input.run.id,
          nodeId: node.id,
          metadata: {
            attempt,
            execute: "delegate",
            agentId: delegate.agentId,
          },
        },
      ],
    };
  };

  const executeTaskNode = async (
    input: WorkflowHookInput,
    node: WorkflowNodeDefinition,
    attempt: number,
  ): Promise<WorkflowNodeVerdictEvaluation> => {
    const task = node.task;
    if (!task) {
      return {
        verdict: {
          status: "runtime_error",
          reason: `Workflow task node "${node.id}" has no task definition.`,
        },
        evidenceRefs: [],
      };
    }
    if (!options.taskTool) {
      return {
        verdict: {
          status: "runtime_error",
          reason: "Workflow task nodes require the host task_create tool.",
        },
        evidenceRefs: [],
      };
    }
    const parent = options.getRun?.();
    if (!parent) {
      return {
        verdict: {
          status: "runtime_error",
          reason: "Workflow task nodes require an active host run.",
        },
        evidenceRefs: [],
      };
    }
    const args = {
      kind: task.kind,
      ...(task.title ? { title: task.title } : {}),
      ...(task.mode ? { mode: task.mode } : {}),
      ...(task.awaited !== undefined ? { awaited: task.awaited } : {}),
      ...(task.payload !== undefined ? { payload: task.payload } : {}),
    };
    const output = await options.taskTool.execute(args, {
      run: parent.record,
      workspace: parent.getWorkspace?.(),
      abortSignal: parent.abortSignal,
    } satisfies RuntimeContext);
    const failed = taskNodeOutputFailed(output);
    return {
      verdict: failed
        ? {
            status: "failed",
            reason: "task_failed",
            metadata: { execute: "task", output },
          }
        : {
            status: "passed",
            reason: "task_started",
            metadata: { execute: "task", output },
          },
      evidenceRefs: [
        {
          kind: "task_output" as const,
          ref: taskNodeOutputRef(output) ?? `${input.run.id}:${node.id}`,
          nodeId: node.id,
          metadata: { attempt, execute: "task", output },
        },
      ],
    };
  };

  const executeParallelNode = async (
    input: WorkflowHookInput,
    node: WorkflowNodeDefinition,
    attempt: number,
  ): Promise<WorkflowNodeVerdictEvaluation> => {
    const parallel = node.parallel;
    if (!parallel) {
      return {
        verdict: {
          status: "runtime_error",
          reason: `Workflow parallel node "${node.id}" has no parallel definition.`,
        },
        evidenceRefs: [],
      };
    }
    const branches = parallel.branches.map((branchId) => {
      const branch = findWorkflowNode(options.definition, branchId);
      if (!branch) {
        throw new Error(
          `Workflow parallel node "${node.id}" references unknown branch "${branchId}".`,
        );
      }
      return branch;
    });
    const allDelegateBranches = branches.every(
      (branch) => nodeExecuteKind(branch) === "delegate",
    );
    const branchResults = allDelegateBranches
      ? await executeDelegateParallelBranches(
          input,
          node,
          branches,
          parallel.maxConcurrency ?? DEFAULT_PARALLEL_MAX_CONCURRENCY,
        )
      : await runBounded(
          branches,
          parallel.maxConcurrency ?? DEFAULT_PARALLEL_MAX_CONCURRENCY,
          async (branch) => executeParallelBranch(input, node, branch),
        );
    const branchStates = Object.fromEntries(
      branchResults.map((result) => [result.node.id, result.state]),
    );
    state = {
      ...state,
      parallelBranches: {
        ...(state.parallelBranches ?? {}),
        ...branchStates,
      },
    };
    const failed = branchResults.filter(
      (result) => result.state.status !== "passed",
    );
    const runtimeErrors = failed.filter(
      (result) => result.state.status === "runtime_error",
    );
    const evidenceRefs = branchResults.flatMap(
      (result) => result.state.evidenceRefs ?? [],
    );
    return {
      verdict:
        runtimeErrors.length > 0
          ? {
              status: "runtime_error",
              reason: "parallel_branch_runtime_error",
              metadata: {
                execute: "parallel",
                branches: branches.map((branch) => branch.id),
                runtimeErrorBranches: runtimeErrors.map(
                  (result) => result.node.id,
                ),
                branchStatuses: branchStatusMetadata(branchResults),
              },
            }
          : failed.length === 0
            ? {
                status: "passed",
                reason: "parallel_branches_passed",
                metadata: {
                  execute: "parallel",
                  branches: branches.map((branch) => branch.id),
                  branchStatuses: branchStatusMetadata(branchResults),
                },
              }
            : {
                status: "failed",
                reason: "parallel_branch_failed",
                metadata: {
                  execute: "parallel",
                  branches: branches.map((branch) => branch.id),
                  failedBranches: failed.map((result) => result.node.id),
                  branchStatuses: branchStatusMetadata(branchResults),
                },
              },
      evidenceRefs: [
        ...evidenceRefs,
        {
          kind: "fact" as const,
          ref: `workflow-parallel:${workflowRunId}:${node.id}:${attempt}`,
          nodeId: node.id,
          metadata: {
            execute: "parallel",
            branches: branches.map((branch) => branch.id),
            branchStatuses: branchStatusMetadata(branchResults),
          },
        },
      ],
    };
  };

  const executeJoinNode = (
    node: WorkflowNodeDefinition,
    attempt: number,
  ): WorkflowNodeVerdictEvaluation => {
    const join = node.join;
    if (!join) {
      return {
        verdict: {
          status: "runtime_error",
          reason: `Workflow join node "${node.id}" has no join definition.`,
        },
        evidenceRefs: [],
      };
    }
    const branchStates = join.waitFor.map((branchId) => ({
      branchId,
      expectedSourceNodeId: uniqueParallelProducerNodeId(
        options.definition,
        branchId,
      ),
      state: state.parallelBranches?.[branchId],
    }));
    const missing = branchStates.filter((entry) => !entry.state);
    if (missing.length > 0) {
      return {
        verdict: {
          status: "runtime_error",
          reason: `Workflow join node "${node.id}" is missing branch state for: ${missing.map((entry) => entry.branchId).join(", ")}.`,
          metadata: {
            execute: "join",
            waitFor: join.waitFor,
            missing: missing.map((entry) => entry.branchId),
          },
        },
        evidenceRefs: [],
      };
    }
    const stale = branchStates.filter(
      (entry) => entry.state!.sourceNodeId !== entry.expectedSourceNodeId,
    );
    if (stale.length > 0) {
      return {
        verdict: {
          status: "runtime_error",
          reason: `Workflow join node "${node.id}" has branch state from a different parallel node: ${stale.map((entry) => `${entry.branchId} from ${entry.state!.sourceNodeId}`).join(", ")}.`,
          metadata: {
            execute: "join",
            waitFor: join.waitFor,
            stale: stale.map((entry) => ({
              branchId: entry.branchId,
              expectedSourceNodeId: entry.expectedSourceNodeId,
              actualSourceNodeId: entry.state!.sourceNodeId,
            })),
          },
        },
        evidenceRefs: [],
      };
    }
    const failed = branchStates.filter(
      (entry) => entry.state?.status !== "passed",
    );
    const runtimeErrors = failed.filter(
      (entry) => entry.state?.status === "runtime_error",
    );
    const evidenceRefs = branchStates.flatMap(
      (entry) => entry.state?.evidenceRefs ?? [],
    );
    return {
      verdict:
        runtimeErrors.length > 0
          ? {
              status: "runtime_error",
              reason: "join_branch_runtime_error",
              metadata: {
                execute: "join",
                waitFor: join.waitFor,
                runtimeErrorBranches: runtimeErrors.map(
                  (entry) => entry.branchId,
                ),
                branchStatuses: Object.fromEntries(
                  branchStates.map((entry) => [
                    entry.branchId,
                    entry.state!.status,
                  ]),
                ),
              },
            }
          : failed.length === 0
            ? {
                status: "passed",
                reason: "join_branches_passed",
                metadata: {
                  execute: "join",
                  waitFor: join.waitFor,
                  branchStatuses: Object.fromEntries(
                    branchStates.map((entry) => [
                      entry.branchId,
                      entry.state!.status,
                    ]),
                  ),
                },
              }
            : {
                status: "failed",
                reason: "join_branch_failed",
                metadata: {
                  execute: "join",
                  waitFor: join.waitFor,
                  failedBranches: failed.map((entry) => entry.branchId),
                  branchStatuses: Object.fromEntries(
                    branchStates.map((entry) => [
                      entry.branchId,
                      entry.state!.status,
                    ]),
                  ),
                },
              },
      evidenceRefs: [
        ...evidenceRefs,
        {
          kind: "fact" as const,
          ref: `workflow-join:${workflowRunId}:${node.id}:${attempt}`,
          nodeId: node.id,
          metadata: { execute: "join", waitFor: join.waitFor },
        },
      ],
    };
  };

  const executeParallelBranch = async (
    input: WorkflowHookInput,
    parallelNode: WorkflowNodeDefinition,
    branch: WorkflowNodeDefinition,
  ): Promise<WorkflowParallelBranchExecution> => {
    const attempt = (state.parallelBranches?.[branch.id]?.attempt ?? 0) + 1;
    const execution = await executeNonModelNode(input, branch, attempt);
    return {
      node: branch,
      state: parallelBranchState({
        parallelNode,
        branch,
        attempt,
        verdict: execution.verdict,
        evidenceRefs: execution.evidenceRefs,
      }),
    };
  };

  const executeDelegateParallelBranches = async (
    input: WorkflowHookInput,
    parallelNode: WorkflowNodeDefinition,
    branches: readonly WorkflowNodeDefinition[],
    maxConcurrency: number,
  ): Promise<WorkflowParallelBranchExecution[]> => {
    const results: WorkflowParallelBranchExecution[] = [];
    const chunkSize = Math.max(1, maxConcurrency);
    for (let start = 0; start < branches.length; start += chunkSize) {
      results.push(
        ...(await executeDelegateParallelBranchBatch(
          input,
          parallelNode,
          branches.slice(start, start + chunkSize),
        )),
      );
    }
    return results;
  };

  const executeDelegateParallelBranchBatch = async (
    input: WorkflowHookInput,
    parallelNode: WorkflowNodeDefinition,
    branches: readonly WorkflowNodeDefinition[],
  ): Promise<WorkflowParallelBranchExecution[]> => {
    if (!options.delegateParallelTool) {
      throw new Error(
        `Workflow parallel node "${parallelNode.id}" requires delegate_parallel for all-delegate fan-out.`,
      );
    }
    let output: unknown;
    try {
      const parent = options.getRun?.();
      output = await options.delegateParallelTool.execute(
        {
          delegates: branches.map((branch) => ({
            agentId: branch.delegate?.agentId,
            goal: branch.delegate?.goal ?? branch.body,
            metadata: {
              ...(branch.delegate?.metadata ?? {}),
              workflowRunId,
              parallelNodeId: parallelNode.id,
              branchNodeId: branch.id,
            },
          })),
        },
        {
          run: parent?.record ?? input.run,
          ...(parent?.getWorkspace ? { workspace: parent.getWorkspace() } : {}),
          ...(parent?.abortSignal ? { abortSignal: parent.abortSignal } : {}),
        } satisfies RuntimeContext,
      );
    } catch (cause) {
      if (isDelegateParallelIncomplete(cause)) {
        output = cause.metadata;
      } else {
        const message = cause instanceof Error ? cause.message : String(cause);
        const code = stringValue(isRecord(cause) ? cause.code : undefined);
        return branches.map((branch) => {
          const attempt =
            (state.parallelBranches?.[branch.id]?.attempt ?? 0) + 1;
          const metadata = {
            execute: "delegate",
            delegateParallel: true,
            parallelNodeId: parallelNode.id,
            error: message,
            ...(code ? { code } : {}),
          };
          return {
            node: branch,
            state: parallelBranchState({
              parallelNode,
              branch,
              attempt,
              verdict: {
                status: "runtime_error",
                reason: "delegate_parallel_runtime_error",
                metadata,
              },
              evidenceRefs: [
                {
                  kind: "run",
                  ref: `${input.run.id}:${parallelNode.id}:${branch.id}`,
                  nodeId: branch.id,
                  metadata: { attempt, ...metadata },
                },
              ],
              metadata: { delegateParallel: true },
            }),
          };
        });
      }
    }
    const results = delegateParallelResults(output);
    return branches.map((branch, index) => {
      const result = results[index];
      const verdict =
        result?.signal === "completed"
          ? ({
              status: "passed" as const,
              reason: "delegate_parallel_branch_completed",
              metadata: { execute: "delegate", result },
            } satisfies WorkflowNodeVerdict)
          : ({
              status: "failed" as const,
              reason: "delegate_parallel_branch_failed",
              metadata: { execute: "delegate", result },
            } satisfies WorkflowNodeVerdict);
      const evidenceRefs: WorkflowEvidenceRef[] = [
        {
          kind: "run",
          ref:
            stringValue(isRecord(result) ? result.childRunId : undefined) ??
            `${input.run.id}:${parallelNode.id}:${branch.id}`,
          nodeId: branch.id,
          metadata: {
            attempt: (state.parallelBranches?.[branch.id]?.attempt ?? 0) + 1,
            execute: "delegate",
            parallelNodeId: parallelNode.id,
            delegateParallel: true,
            result,
          },
        },
      ];
      return {
        node: branch,
        state: parallelBranchState({
          parallelNode,
          branch,
          attempt: (state.parallelBranches?.[branch.id]?.attempt ?? 0) + 1,
          verdict,
          evidenceRefs,
          metadata: { delegateParallel: true },
        }),
      };
    });
  };

  const runConfiguredNodeAction = async (
    input: WorkflowHookInput,
    nodeId: string,
    action: CapabilityWorkflowHookConfig["action"],
  ): Promise<WorkflowHookResult> => {
    const [inner] = createConfiguredWorkflowHooks({
      ...options,
      workflowActive: true,
      hooks: [
        {
          name: familyName,
          hook: input.hook,
          action,
        } satisfies CapabilityWorkflowHookConfig,
      ],
    });
    if (!inner) {
      throw new Error(
        `Failed to compile workflow node action for "${nodeId}".`,
      );
    }
    const result = await inner.handle({
      ...input,
      metadata: {
        ...input.metadata,
        workflowRunId,
        nodeId,
        nodeAction: true,
      },
    });
    return result ?? { status: "continue" };
  };

  const lifecycleHooks: WorkflowHook[] = [
    {
      name: familyName,
      id: "workflow-run-start",
      hook: "RunStart",
      onError: "block",
      async handle(input) {
        maybeThrowInjected("RunStart");
        if (!workflowStarted) {
          workflowStarted = true;
          emit(input, "workflow.started", {
            status: "running",
            currentNodeId: state.currentNodeId,
          });
          await persistSnapshot({
            phase: "started",
            nodeId: state.currentNodeId,
          });
        }
        return { status: "continue", metadata: { workflowRunId } };
      },
    },
    {
      name: familyName,
      id: "workflow-turn-start",
      hook: "TurnStart",
      onError: "block",
      async handle(input) {
        maybeThrowInjected("TurnStart");
        if (state.status !== "running" || !state.currentNodeId) {
          return { status: "continue", metadata: { workflowRunId } };
        }
        const drained = await drainNonModelNodes(input, "turn-start");
        if (drained) return drained;
        if (state.status !== "running" || !state.currentNodeId) {
          return { status: "continue", metadata: { workflowRunId } };
        }
        const node = currentNode(options.definition, state);
        if (!node) {
          emitRuntimeFailure(
            input,
            `Workflow node "${state.currentNodeId}" does not exist.`,
          );
          return { status: "continue", metadata: { workflowRunId } };
        }
        emitNodeStartedIfNeeded(input, node, state);
        await persistSnapshot({
          phase: "node_started",
          nodeId: node.id,
          attempt: state.attempts[node.id] ?? 1,
        });
        return {
          status: "continue",
          context: [nodeContextItem(workflowRunId, node, state)],
          metadata: {
            workflowRunId,
            nodeId: node.id,
            attempt: state.attempts[node.id] ?? 1,
          },
        };
      },
    },
    {
      name: familyName,
      id: "workflow-tool-clamp",
      hook: "PreToolUse",
      preToolUseStage: "governance",
      onError: "block",
      async handle(input) {
        maybeThrowInjected("PreToolUse");
        if (state.status !== "running" || !state.currentNodeId) {
          return { status: "continue", metadata: { workflowRunId } };
        }
        const node = currentNode(options.definition, state);
        const allowed = node?.tools;
        if (!allowed || allowed.length === 0) {
          return { status: "continue", metadata: { workflowRunId } };
        }
        const toolName = toolNameFromPayload(input.payload);
        if (!toolName || allowed.includes(toolName)) {
          return { status: "continue", metadata: { workflowRunId } };
        }
        if (
          toolName === "tool_search" &&
          options.isScopedToolSearchAvailable?.() === true
        ) {
          return { status: "continue", metadata: { workflowRunId } };
        }
        if (options.isToolAvailable?.(toolName) === false) {
          return { status: "continue", metadata: { workflowRunId } };
        }
        const path = workflowPathFromPayload(input.payload, input.metadata);
        return {
          status: "block",
          reason: `Workflow node "${node.id}" does not allow tool "${toolName}".`,
          metadata: {
            workflowRunId,
            nodeId: node.id,
            toolName,
            allowedTools: allowed,
            ...(path ? { path } : {}),
          },
        };
      },
    },
    {
      name: familyName,
      id: "workflow-stop-gate",
      hook: "Stop",
      onError: "block",
      handle(input) {
        return withStopRuntimeBound(input, async () => {
          if (state.status !== "running" || !state.currentNodeId) {
            return { status: "continue", metadata: { workflowRunId } };
          }
          const resumeVerification = resumeVerificationNodes(
            options.definition,
            pendingResumeVerificationNodeIds,
          );
          if (resumeVerification.length > 0) {
            const snapshot = input.facts?.snapshot();
            const verdicts = await Promise.all(
              resumeVerification.map(async (node) => {
                const evaluation = await nodeVerdictFromLedger({
                  snapshot,
                  hookName: familyName,
                  node,
                  nodeEntryWriteEpoch: undefined,
                });
                return {
                  node,
                  attempt: state.attempts[node.id] ?? 1,
                  verdict: evaluation.verdict,
                  evidenceRefs: evaluation.evidenceRefs,
                };
              }),
            );
            const failed = verdicts.find(
              (entry) => entry.verdict.status !== "passed",
            );
            for (const entry of verdicts) {
              if (entry.verdict.status === "passed") {
                pendingResumeVerificationNodeIds.delete(entry.node.id);
                await persistSnapshot({
                  phase: "node_completed",
                  nodeId: entry.node.id,
                  attempt: entry.attempt,
                  verdict: entry.verdict,
                  evidenceRefs: entry.evidenceRefs,
                  metadata: { resumeVerification: true },
                });
              }
            }
            if (failed) {
              const advanced = advanceWorkflowState({
                definition: options.definition,
                state: {
                  ...state,
                  currentNodeId: failed.node.id,
                },
                verdict: failed.verdict,
              });
              state = advanced.state;
              pendingResumeVerificationNodeIds.clear();
              emitNodeCompleted(
                input,
                failed.node,
                failed.attempt,
                failed.verdict,
                failed.evidenceRefs,
                advanced.decision,
              );
              return hookResultForDecision(
                input,
                failed.node,
                failed.attempt,
                failed.verdict,
                failed.evidenceRefs,
                advanced.decision,
              );
            }
          }
          const node = currentNode(options.definition, state);
          if (!node) {
            throw new Error(
              `Workflow node "${state.currentNodeId}" does not exist.`,
            );
          }
          emitNodeStartedIfNeeded(input, node, state);
          const evaluation = await nodeVerdictFromLedger({
            snapshot: input.facts?.snapshot(),
            hookName: familyName,
            node,
            nodeEntryWriteEpoch: nodeEntryEpochs.get(
              `${node.id}:${state.attempts[node.id] ?? 1}`,
            ),
          });
          const completedAttempt = state.attempts[node.id] ?? 1;
          const advanced = advanceWorkflowState({
            definition: options.definition,
            state,
            verdict: evaluation.verdict,
          });
          state = advanced.state;
          emitNodeCompleted(
            input,
            node,
            completedAttempt,
            evaluation.verdict,
            evaluation.evidenceRefs,
            advanced.decision,
          );
          if (
            (advanced.decision.type === "goto" ||
              advanced.decision.type === "retry") &&
            nextNodeIsNonModel(options.definition, state)
          ) {
            await persistSnapshot({
              phase: "node_completed",
              nodeId: node.id,
              attempt: completedAttempt,
              verdict: evaluation.verdict,
              evidenceRefs: evaluation.evidenceRefs,
              decision: advanced.decision,
            });
            const drained = await drainNonModelNodes(input, "stop");
            if (drained) return drained;
          }
          return hookResultForDecision(
            input,
            node,
            completedAttempt,
            evaluation.verdict,
            evaluation.evidenceRefs,
            advanced.decision,
          );
        });
      },
    },
    {
      name: familyName,
      id: "workflow-runtime-signal",
      hook: "RuntimeSignal",
      onError: "continue",
      async handle(input) {
        const signal = signalFromPayload(input.payload);
        if (signal === "doom_loop") {
          emitInterrupted(input, "doom_loop", { signal });
          await persistSnapshot({
            phase: "interrupted",
            nodeId: state.currentNodeId,
            metadata: { kind: "doom_loop", signal },
          });
        }
        if (
          signal === "budget.exceeded" &&
          stringValue(
            isRecord(input.payload) ? input.payload.source : undefined,
          ) === "workflow" &&
          state.status === "running" &&
          !terminalEmitted
        ) {
          emitInterrupted(input, "budget", { signal, source: "workflow" });
          emitRuntimeFailure(
            input,
            "Workflow forced-continuation budget exhausted before the workflow reached a terminal state.",
            { signal, source: "workflow" },
          );
          await persistSnapshot({
            phase: "terminal",
            nodeId: state.currentNodeId,
            terminalStatus: "failed",
            failure: {
              kind: "runtime",
              code: "workflow.runtime",
              message:
                "Workflow forced-continuation budget exhausted before the workflow reached a terminal state.",
              metadata: { signal, source: "workflow" },
            },
          });
        }
        return { status: "continue", metadata: { workflowRunId } };
      },
    },
    {
      name: familyName,
      id: "workflow-run-end",
      hook: "RunEnd",
      onError: "continue",
      async handle(input) {
        if (options.runEndTerminalOwner === "episode_chain") {
          return { status: "continue", metadata: { workflowRunId } };
        }
        const payload = isRecord(input.payload) ? input.payload : {};
        const runState = stringValue(payload.state);
        const reason = stringValue(payload.reason);
        if (runState === "cancelled") {
          emitInterrupted(input, "cancelled", { reason });
          if (!terminalEmitted) {
            terminalEmitted = true;
            emit(input, "workflow.cancelled", {
              reason: reason ?? "manual_cancelled",
            });
            await persistSnapshot({
              phase: "terminal",
              terminalStatus: "cancelled",
              failure: {
                kind: "cancelled",
                code: "workflow.cancelled",
                message: reason ?? "manual_cancelled",
              },
            });
          }
          return { status: "continue", metadata: { workflowRunId } };
        }
        if (runState === "failed") {
          emitInterrupted(input, "run_failed", { reason });
          if (!terminalEmitted) {
            emitRuntimeFailure(
              input,
              `Run failed before workflow completed${reason ? `: ${reason}` : ""}.`,
              { reason },
            );
            await persistSnapshot({
              phase: "terminal",
              terminalStatus: "failed",
              failure: {
                kind: "runtime",
                code: "workflow.runtime",
                message: `Run failed before workflow completed${reason ? `: ${reason}` : ""}.`,
                metadata: { reason },
              },
            });
          }
          return { status: "continue", metadata: { workflowRunId } };
        }
        const workflowBudgetExceeded = input.facts
          ?.snapshot()
          .budgetExceeded.some((fact) => fact.source === "workflow");
        if (
          workflowBudgetExceeded &&
          state.status === "running" &&
          !terminalEmitted
        ) {
          emitInterrupted(input, "budget", {
            source: "workflow",
          });
          terminalEmitted = true;
        }
        return { status: "continue", metadata: { workflowRunId } };
      },
    },
  ];

  const verifierHooks = verifierStopHooks({
    ...options,
    definition: options.definition,
    familyName,
    workflowRunId,
    state: () => state,
    pendingResumeVerificationNodeIds,
    withStopRuntimeBound,
  });

  function emitNodeStartedIfNeeded(
    input: WorkflowHookInput,
    node: WorkflowNodeDefinition,
    runtimeState: WorkflowRuntimeState,
  ): void {
    const attempt = runtimeState.attempts[node.id] ?? 1;
    const key = `${node.id}:${attempt}`;
    if (!nodeEntryEpochs.has(key)) {
      nodeEntryEpochs.set(
        key,
        input.facts?.markEpoch().writeEpoch ?? input.facts?.currentEpoch() ?? 0,
      );
    }
    if (nodeStartKeys.has(key)) return;
    nodeStartKeys.add(key);
    emit(input, "workflow.node.started", {
      nodeId: node.id,
      attempt,
      title: node.title,
      writeEpoch: nodeEntryEpochs.get(key),
    });
  }

  function emitNodeCompleted(
    input: WorkflowHookInput,
    node: WorkflowNodeDefinition,
    attempt: number,
    verdict: WorkflowNodeVerdict,
    evidenceRefs: readonly WorkflowEvidenceRef[],
    decision: WorkflowTransitionDecision,
  ): void {
    emit(input, "workflow.node.completed", {
      nodeId: node.id,
      attempt,
      verdict,
      evidenceRefs,
      decision,
    });
  }

  function hookResultForDecision(
    input: WorkflowHookInput,
    node: WorkflowNodeDefinition,
    attempt: number,
    verdict: WorkflowNodeVerdict,
    evidenceRefs: readonly WorkflowEvidenceRef[],
    decision: WorkflowTransitionDecision,
  ): Promise<WorkflowHookResult> {
    if (decision.type === "complete") {
      if (!terminalEmitted) {
        terminalEmitted = true;
        emit(input, "workflow.completed", {
          reason: decision.reason,
          fromNodeId: decision.fromNodeId,
        });
      }
      return persistSnapshot({
        phase: "terminal",
        nodeId: node.id,
        attempt,
        verdict,
        evidenceRefs: [...evidenceRefs],
        decision,
        terminalStatus: "completed",
      }).then(() => ({
        status: "continue",
        metadata: { workflowRunId, decision },
      }));
    }
    if (decision.type === "fail") {
      if (!terminalEmitted) {
        terminalEmitted = true;
        emit(input, "workflow.failed", {
          reason: decision.reason,
          fromNodeId: decision.fromNodeId,
          failure: {
            kind: "verdict",
            code: "WORKFLOW_NODE_FAILED",
            message: decision.reason,
          },
        });
      }
      return persistSnapshot({
        phase: "terminal",
        nodeId: node.id,
        attempt,
        verdict,
        evidenceRefs: [...evidenceRefs],
        decision,
        terminalStatus: "failed",
        failure: {
          kind: "verdict",
          code: "workflow.verdict",
          message: decision.reason,
          metadata: { fromNodeId: decision.fromNodeId },
        },
      }).then(() => ({
        status: "continue",
        metadata: { workflowRunId, decision },
      }));
    }
    return persistSnapshot({
      phase: "node_completed",
      nodeId: node.id,
      attempt,
      verdict,
      evidenceRefs: [...evidenceRefs],
      decision,
    }).then(() => ({
      status: "advance",
      reason:
        decision.type === "retry"
          ? `Workflow retry for node "${decision.nodeId}".`
          : `Workflow advanced to node "${decision.toNodeId}".`,
      metadata: { workflowRunId, decision },
    }));
  }

  return {
    workflowRunId,
    hooks: [...verifierHooks, ...lifecycleHooks],
    getState: () => cloneRuntimeState(state),
  };
}

function isPinnedWorkflowDefinition(
  definition: WorkflowExecutableDefinition,
): definition is PinnedWorkflowDefinition {
  return (
    "packageHash" in definition &&
    typeof definition.packageHash === "string" &&
    "packageHashPolicyVersion" in definition &&
    definition.packageHashPolicyVersion === 2 &&
    "packageSnapshotRef" in definition &&
    typeof definition.packageSnapshotRef === "string"
  );
}

function verifierStopHooks(
  input: CreateWorkflowProjectionHooksOptions & {
    familyName: string;
    workflowRunId: string;
    state: () => WorkflowRuntimeState;
    pendingResumeVerificationNodeIds: ReadonlySet<string>;
    withStopRuntimeBound(
      hookInput: WorkflowHookInput,
      run: () => WorkflowHookResult | void | Promise<WorkflowHookResult | void>,
    ): Promise<WorkflowHookResult | void>;
  },
): WorkflowHook[] {
  return input.definition.nodes.flatMap((node) =>
    (node.verify ?? [])
      .filter(
        (verifier): verifier is WorkflowCommandVerifierDefinition =>
          verifier.kind === "command",
      )
      .map((verifier) => {
        const builtinVerifier = stringValue(verifier.metadata?.builtinVerifier);
        const builtinHandler = builtinVerifier
          ? input.builtinVerifiers?.[builtinVerifier]
          : undefined;
        if (builtinVerifier && !builtinHandler) {
          throw new Error(
            `Workflow verifier "${verifier.id}" references unknown built-in verifier "${builtinVerifier}".`,
          );
        }
        const inner = builtinHandler
          ? undefined
          : commandVerifierWorkflowHook(input, verifier);
        return {
          name: input.familyName,
          id: "workflow-command-verifier",
          hook: "Stop",
          onError: "block",
          handle(hookInput) {
            return input.withStopRuntimeBound(hookInput, async () => {
              const state = input.state();
              if (
                state.status !== "running" ||
                (state.currentNodeId !== node.id &&
                  !input.pendingResumeVerificationNodeIds.has(node.id))
              ) {
                return {
                  status: "skipped",
                  reason: "workflow verifier belongs to another node",
                  metadata: {
                    workflowRunId: input.workflowRunId,
                    nodeId: node.id,
                    verifierId: verifier.id,
                  },
                };
              }
              const expect = verifier.expect ?? "zero";
              const verifierInput = {
                ...hookInput,
                metadata: {
                  ...hookInput.metadata,
                  workflowRunId: input.workflowRunId,
                  nodeId: node.id,
                  verifierId: verifier.id,
                  expect,
                },
              };
              const result = builtinHandler
                ? await builtinHandler({
                    workflowRunId: input.workflowRunId,
                    node,
                    verifier,
                    hookInput: verifierInput,
                  })
                : await inner!.handle(verifierInput);
              return withVerifierMetadata(result, {
                workflowRunId: input.workflowRunId,
                nodeId: node.id,
                verifier,
                expect,
              });
            });
          },
        } satisfies WorkflowHook;
      }),
  );
}

function commandVerifierWorkflowHook(
  input: CreateWorkflowProjectionHooksOptions & { familyName: string },
  verifier: WorkflowCommandVerifierDefinition,
): WorkflowHook {
  const [inner] = createConfiguredWorkflowHooks({
    ...input,
    hooks: [
      {
        name: input.familyName,
        hook: "Stop",
        action: {
          type: "command",
          command: verifier.command,
          args: verifier.args ?? [],
          ...(verifier.cwd ? { cwd: verifier.cwd } : {}),
          ...(verifier.timeoutMs !== undefined
            ? { timeoutMs: verifier.timeoutMs }
            : {}),
          ...(verifier.maxOutputBytes !== undefined
            ? { maxOutputBytes: verifier.maxOutputBytes }
            : {}),
          injectOutput: "never",
        },
      } satisfies CapabilityWorkflowHookConfig,
    ],
  });
  if (!inner) {
    throw new Error(`Failed to compile verifier "${verifier.id}".`);
  }
  return inner;
}

function withVerifierMetadata(
  result: WorkflowHookResult | void,
  input: {
    workflowRunId: string;
    nodeId: string;
    verifier: WorkflowCommandVerifierDefinition;
    expect: "zero" | "nonzero";
  },
): WorkflowHookResult {
  const base = result ?? { status: "continue" };
  const metadata = isRecord(base.metadata) ? base.metadata : {};
  const exitCode = numberOrNullValue(metadata.exitCode);
  const timedOut = metadata.timedOut === true;
  const verifierMetadata = isRecord(input.verifier.metadata)
    ? input.verifier.metadata
    : {};
  const satisfied = commandExpectationSatisfied(input.expect, {
    exitCode,
    timedOut,
  });
  return {
    ...base,
    metadata: {
      ...verifierMetadata,
      ...metadata,
      workflowRunId: input.workflowRunId,
      nodeId: input.nodeId,
      verifierId: input.verifier.id,
      expect: input.expect,
      satisfied,
    },
  };
}

async function nodeVerdictFromLedger(input: {
  snapshot: FactLedgerSnapshot | undefined;
  hookName: string;
  node: WorkflowNodeDefinition;
  nodeEntryWriteEpoch: number | undefined;
}): Promise<WorkflowNodeVerdictEvaluation> {
  const verifiers = input.node.verify ?? [];
  if (verifiers.length === 0) {
    return {
      verdict: {
        status: "passed",
        reason: "node_unverified",
        metadata: { verified: false },
      },
      evidenceRefs: [],
    };
  }
  if (!input.snapshot) {
    return {
      verdict: {
        status: "runtime_error",
        reason: "FactLedger is unavailable to the workflow projection.",
      },
      evidenceRefs: [],
    };
  }
  const results = await Promise.all(
    verifiers.map((verifier) => {
      if (verifier.kind === "diff_scope") {
        return evaluateDiffScopeVerifier({
          snapshot: input.snapshot!,
          node: input.node,
          verifier,
          nodeEntryWriteEpoch: input.nodeEntryWriteEpoch ?? 0,
        });
      }
      return evaluateCommandVerifier({
        snapshot: input.snapshot!,
        hookName: input.hookName,
        node: input.node,
        verifier,
      });
    }),
  );
  const evidenceRefs = results.flatMap((result) => result.evidenceRefs);
  const runtimeError = results.find(
    (result) => result.runtimeError !== undefined,
  );
  if (runtimeError) {
    return {
      verdict: {
        status: "runtime_error",
        reason: runtimeError.runtimeError ?? "Workflow verifier failed.",
        metadata: {
          verified: true,
          factRefs: evidenceRefs.map((ref) => ref.ref),
          failures: results
            .filter((result) => !result.satisfied)
            .map((result) => result.failure),
        },
      },
      evidenceRefs,
    };
  }
  const failed = results.filter((result) => !result.satisfied);
  if (failed.length === 0) {
    return {
      verdict: {
        status: "passed",
        reason: "verification_passed",
        metadata: {
          verified: true,
          verifiers: results.map((result) => result.verifier.id),
          factRefs: evidenceRefs.map((ref) => ref.ref),
        },
      },
      evidenceRefs,
    };
  }
  return {
    verdict: {
      status: "failed",
      reason: "verification_failed",
      metadata: {
        verified: true,
        factRefs: evidenceRefs.map((ref) => ref.ref),
        failures: failed.map((result) => result.failure),
      },
    },
    evidenceRefs,
  };
}

interface WorkflowVerifierCheckResult {
  verifier: WorkflowVerifierDefinition;
  satisfied: boolean;
  evidenceRefs: WorkflowEvidenceRef[];
  failure: Record<string, unknown>;
  runtimeError?: string;
}

function evaluateCommandVerifier(input: {
  snapshot: FactLedgerSnapshot;
  hookName: string;
  node: WorkflowNodeDefinition;
  verifier: WorkflowCommandVerifierDefinition;
}): WorkflowVerifierCheckResult {
  const latest = input.snapshot.verificationResults
    .filter(
      (result) =>
        result.hookName === input.hookName &&
        result.nodeId === input.node.id &&
        result.verifierId === input.verifier.id,
    )
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
  const evidenceRefs: WorkflowEvidenceRef[] = latest
    ? [
        {
          kind: "fact",
          ref: latest.id,
          nodeId: input.node.id,
          verifierId: input.verifier.id,
          metadata: {
            commandFactId: latest.commandFactId,
            sequence: latest.sequence,
            writeEpoch: latest.writeEpoch,
            stale: latest.stale,
          },
        },
      ]
    : [];
  return {
    verifier: input.verifier,
    satisfied: latest?.satisfied === true && latest.stale === false,
    evidenceRefs,
    failure: {
      verifierId: input.verifier.id,
      kind: input.verifier.kind,
      missing: latest === undefined,
      stale: latest?.stale === true,
      satisfied: latest?.satisfied,
      exitCode: latest?.exitCode,
      timedOut: latest?.timedOut,
      factRef: latest?.id,
    },
  };
}

function evaluateDiffScopeVerifier(input: {
  snapshot: FactLedgerSnapshot;
  node: WorkflowNodeDefinition;
  verifier: WorkflowDiffScopeVerifierDefinition;
  nodeEntryWriteEpoch: number;
}): WorkflowVerifierCheckResult {
  const writes = input.snapshot.writes.filter(
    (write) => write.writeEpoch > input.nodeEntryWriteEpoch,
  );
  const outOfScope = writes.filter((write) => {
    const path = write.path;
    if (!path) return true;
    if (
      input.verifier.include &&
      input.verifier.include.length > 0 &&
      !matchesAnyGlob(input.verifier.include, path)
    ) {
      return true;
    }
    if (
      input.verifier.exclude &&
      input.verifier.exclude.length > 0 &&
      matchesAnyGlob(input.verifier.exclude, path)
    ) {
      return true;
    }
    return false;
  });
  return {
    verifier: input.verifier,
    satisfied: outOfScope.length === 0,
    evidenceRefs: writes.map((write) => ({
      kind: "fact" as const,
      ref: write.id,
      nodeId: input.node.id,
      verifierId: input.verifier.id,
      metadata: {
        kind: "diff_scope",
        path: write.path,
        writeEpoch: write.writeEpoch,
      },
    })),
    failure: {
      verifierId: input.verifier.id,
      kind: input.verifier.kind,
      nodeEntryWriteEpoch: input.nodeEntryWriteEpoch,
      include: input.verifier.include ?? [],
      exclude: input.verifier.exclude ?? [],
      outOfScope: outOfScope.map((write) => ({
        factRef: write.id,
        path: write.path,
        writeEpoch: write.writeEpoch,
      })),
    },
  };
}

function validateWorkflowProjectionDefinition(
  definition: WorkflowExecutableDefinition,
): void {
  assertWorkflowRuntimeDefinition(definition);
  for (const node of definition.nodes) {
    const execute = nodeExecuteKind(node);
    if (execute === "command") {
      assertCommandNodeRunnable(node);
    } else if (execute === "delegate") {
      assertDelegateNodeRunnable(node);
    } else if (execute === "task") {
      assertTaskNodeRunnable(node);
    } else if (execute === "human") {
      assertHumanNodeRunnable(node);
    } else if (execute === "parallel") {
      assertParallelNodeRunnable(definition, node);
    } else if (execute === "join") {
      assertJoinNodeRunnable(definition, node);
    }
    for (const verifier of node.verify ?? []) {
      if (verifier.kind === "command") {
        assertVerifierAuthorized(verifier);
        assertStaticArgv(verifier);
      }
    }
  }
}

function assertCommandNodeRunnable(node: WorkflowNodeDefinition): void {
  if (!node.command) {
    throw new Error(
      `Workflow command node "${node.id}" requires a command definition.`,
    );
  }
  if (node.command.authorized !== true) {
    throw new Error(
      `Workflow command node "${node.id}" is not authorized; command nodes require authorized: true (or authorization: trusted) at instantiation time.`,
    );
  }
  assertStaticArgv({
    id: `${node.id}:command`,
    kind: "command",
    command: node.command.command,
    args: node.command.args,
  });
}

function assertDelegateNodeRunnable(node: WorkflowNodeDefinition): void {
  if (!node.delegate) {
    throw new Error(
      `Workflow delegate node "${node.id}" requires a delegate definition.`,
    );
  }
  if (!node.delegate.agentId) {
    throw new Error(`Workflow delegate node "${node.id}" requires agentId.`);
  }
}

function assertTaskNodeRunnable(node: WorkflowNodeDefinition): void {
  if (!node.task) {
    throw new Error(
      `Workflow task node "${node.id}" requires a task definition.`,
    );
  }
}

function assertHumanNodeRunnable(node: WorkflowNodeDefinition): void {
  const wait = node.human?.wait;
  if (
    wait &&
    wait.kind !== "input" &&
    wait.kind !== "task" &&
    wait.kind !== "approval"
  ) {
    throw new Error(
      `Workflow human node "${node.id}" wait.kind must be input, task, or approval.`,
    );
  }
}

function assertParallelNodeRunnable(
  definition: WorkflowExecutableDefinition,
  node: WorkflowNodeDefinition,
): void {
  const parallel = node.parallel;
  if (!parallel || parallel.branches.length === 0) {
    throw new Error(`Workflow parallel node "${node.id}" requires branches.`);
  }
  if (!node.onPass) {
    throw new Error(
      `Workflow parallel node "${node.id}" requires explicit onPass; P5 forbids implicit fall-through from a parallel node.`,
    );
  }
  const onPassBranchTarget = workflowTransitionTargets(node.onPass).find(
    (target) => parallel.branches.includes(target),
  );
  if (onPassBranchTarget) {
    throw new Error(
      `Workflow parallel node "${node.id}" onPass must not target branch "${onPassBranchTarget}".`,
    );
  }
  if (parallel.branches.length > MAX_PARALLEL_BRANCHES) {
    throw new Error(
      `Workflow parallel node "${node.id}" accepts at most ${MAX_PARALLEL_BRANCHES} branches.`,
    );
  }
  if (
    parallel.maxConcurrency !== undefined &&
    (parallel.maxConcurrency < 1 ||
      parallel.maxConcurrency > MAX_PARALLEL_BRANCHES)
  ) {
    throw new Error(
      `Workflow parallel node "${node.id}" maxConcurrency must be between 1 and ${MAX_PARALLEL_BRANCHES}.`,
    );
  }
  for (const branchId of parallel.branches) {
    const branch = findWorkflowNode(definition, branchId);
    if (!branch) continue;
    if (branch.id === node.id) {
      throw new Error(
        `Workflow parallel node "${node.id}" cannot branch to itself.`,
      );
    }
    if ((branch.verify?.length ?? 0) > 0) {
      throw new Error(
        `Workflow parallel node "${node.id}" branch "${branch.id}" declares verify, but P5 branch verifiers are not executed.`,
      );
    }
    const execute = nodeExecuteKind(branch);
    if (
      execute !== "command" &&
      execute !== "delegate" &&
      execute !== "task" &&
      execute !== "script"
    ) {
      throw new Error(
        `Workflow parallel node "${node.id}" branch "${branch.id}" uses unsupported execute kind "${execute}". P5 supports command, delegate, task, and script branches only.`,
      );
    }
  }
}

function assertJoinNodeRunnable(
  definition: WorkflowExecutableDefinition,
  node: WorkflowNodeDefinition,
): void {
  const join = node.join;
  if (!join || join.waitFor.length === 0) {
    throw new Error(`Workflow join node "${node.id}" requires waitFor.`);
  }
  for (const branchId of join.waitFor) {
    const producers = parallelProducerNodeIds(definition, branchId);
    if (producers.length === 0) {
      throw new Error(
        `Workflow join node "${node.id}" waits for branch "${branchId}", but no parallel node produces it.`,
      );
    }
    if (producers.length > 1) {
      throw new Error(
        `Workflow join node "${node.id}" waits for branch "${branchId}", but it is produced by multiple parallel nodes: ${producers.join(", ")}.`,
      );
    }
  }
}

function assertVerifierAuthorized(
  verifier: WorkflowCommandVerifierDefinition,
): void {
  if (verifier.authorized === true) return;
  throw new Error(
    `Workflow verifier "${verifier.id}" is not authorized; command verifiers require authorized: true (or authorization: trusted) at instantiation time.`,
  );
}

function assertStaticArgv(verifier: WorkflowCommandVerifierDefinition): void {
  const tokens = [verifier.command, ...(verifier.args ?? [])];
  for (const token of tokens) {
    if (token.includes("{{") || token.includes("}}")) {
      throw new Error(
        `Workflow verifier "${verifier.id}" uses template bindings; P1 requires static command argv tokens.`,
      );
    }
  }
}

function workflowTransitionTargets(
  transition: WorkflowTransitionDefinition,
): string[] {
  if (typeof transition === "string") return [transition];
  if ("goto" in transition) return [transition.goto];
  if ("retry" in transition && transition.then) {
    return workflowTransitionTargets(transition.then);
  }
  return [];
}

function currentNode(
  definition: WorkflowExecutableDefinition,
  state: WorkflowRuntimeState,
): WorkflowNodeDefinition | undefined {
  return state.currentNodeId
    ? findWorkflowNode(definition, state.currentNodeId)
    : undefined;
}

function findWorkflowNode(
  definition: WorkflowExecutableDefinition,
  nodeId: string,
): WorkflowNodeDefinition | undefined {
  return definition.nodes.find((node) => node.id === nodeId);
}

function parallelProducerNodeIds(
  definition: WorkflowExecutableDefinition,
  branchId: string,
): string[] {
  return definition.nodes
    .filter((node) => nodeExecuteKind(node) === "parallel")
    .filter((node) => node.parallel?.branches.includes(branchId))
    .map((node) => node.id);
}

function uniqueParallelProducerNodeId(
  definition: WorkflowExecutableDefinition,
  branchId: string,
): string {
  const producers = parallelProducerNodeIds(definition, branchId);
  return producers[0] ?? "";
}

function nextNodeIsNonModel(
  definition: WorkflowExecutableDefinition,
  state: WorkflowRuntimeState,
): boolean {
  if (state.status !== "running" || !state.currentNodeId) return false;
  const node = currentNode(definition, state);
  return Boolean(node && nodeExecuteKind(node) !== "model");
}

function nodeExecuteKind(
  node: WorkflowNodeDefinition,
): NonNullable<WorkflowNodeDefinition["execute"]> {
  return node.execute ?? "model";
}

function resumeVerificationNodes(
  definition: WorkflowExecutableDefinition,
  pendingNodeIds: ReadonlySet<string>,
): WorkflowNodeDefinition[] {
  return definition.nodes.filter(
    (node) => pendingNodeIds.has(node.id) && (node.verify?.length ?? 0) > 0,
  );
}

function nodeContextItem(
  workflowRunId: string,
  node: WorkflowNodeDefinition,
  state: WorkflowRuntimeState,
): ContextItem {
  return {
    id: createContextItemId(),
    type: "system",
    source: { kind: "extension", uri: `workflow:${workflowRunId}:${node.id}` },
    content: [
      `Workflow node: ${node.id}`,
      `Attempt: ${state.attempts[node.id] ?? 1}`,
      node.body,
    ]
      .filter((line) => line.trim().length > 0)
      .join("\n\n"),
    metadata: {
      layer: "working",
      stability: "turn",
      workflowRunId,
      nodeId: node.id,
      attempt: state.attempts[node.id] ?? 1,
    },
  };
}

function humanWaitingContextItem(
  workflowRunId: string,
  node: WorkflowNodeDefinition,
  wait: WorkflowWaitState,
): ContextItem {
  return {
    id: createContextItemId(),
    type: "system",
    source: { kind: "extension", uri: `workflow:${workflowRunId}:${node.id}` },
    content: [
      `Workflow node "${node.id}" is waiting for ${wait.kind}.`,
      wait.reason,
      "A durable workflow.waiting notification has been emitted. Do not continue this workflow until it is resumed.",
    ]
      .filter(
        (line): line is string => typeof line === "string" && line.length > 0,
      )
      .join("\n\n"),
    metadata: {
      layer: "working",
      stability: "turn",
      workflowRunId,
      nodeId: node.id,
      wait,
    },
  };
}

function humanWaitState(node: WorkflowNodeDefinition): WorkflowWaitState {
  const wait = node.human?.wait;
  const reason =
    wait?.reason ??
    node.human?.prompt ??
    node.title ??
    (node.body.trim().length > 0 ? node.body.trim() : undefined);
  return {
    kind: wait?.kind ?? "input",
    ...(reason ? { reason } : {}),
    ...(wait?.taskId ? { taskId: wait.taskId } : {}),
    ...(wait?.approvalId ? { approvalId: wait.approvalId } : {}),
    metadata: {
      ...(wait?.metadata ?? {}),
      ...(node.human?.metadata ?? {}),
      nodeId: node.id,
    },
  };
}

function parallelBranchState(input: {
  parallelNode: WorkflowNodeDefinition;
  branch: WorkflowNodeDefinition;
  attempt: number;
  verdict: WorkflowNodeVerdict;
  evidenceRefs: readonly WorkflowEvidenceRef[];
  metadata?: Record<string, unknown>;
}): WorkflowParallelBranchState {
  return {
    sourceNodeId: input.parallelNode.id,
    nodeId: input.branch.id,
    attempt: input.attempt,
    status: input.verdict.status,
    verdict: cloneJsonLike(input.verdict),
    evidenceRefs: input.evidenceRefs.map((ref) => ({
      ...ref,
      metadata: ref.metadata ? { ...ref.metadata } : undefined,
    })),
    completedAt: new Date().toISOString(),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  };
}

function branchStatusMetadata(
  branches: readonly WorkflowParallelBranchExecution[],
): Record<string, string> {
  return Object.fromEntries(
    branches.map((branch) => [branch.node.id, branch.state.status]),
  );
}

async function runBounded<T, R>(
  items: readonly T[],
  maxConcurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= items.length) return;
    results[index] = await worker(items[index]!);
    await runNext();
  }
  const workers = Array.from(
    { length: Math.min(Math.max(1, maxConcurrency), items.length) },
    () => runNext(),
  );
  await Promise.all(workers);
  return results;
}

function delegateParallelResults(
  output: unknown,
): Array<Record<string, unknown> | undefined> {
  if (!isRecord(output) || !Array.isArray(output.results)) return [];
  return output.results.map((result) =>
    isRecord(result) ? result : undefined,
  );
}

function isDelegateParallelIncomplete(
  cause: unknown,
): cause is Record<string, unknown> & { metadata: Record<string, unknown> } {
  return (
    isRecord(cause) &&
    stringValue(cause.code) === "DELEGATE_PARALLEL_INCOMPLETE" &&
    isRecord(cause.metadata)
  );
}

function cloneRuntimeState(state: WorkflowRuntimeState): WorkflowRuntimeState {
  return {
    ...state,
    attempts: { ...state.attempts },
    parallelBranches: state.parallelBranches
      ? Object.fromEntries(
          Object.entries(state.parallelBranches).map(([key, branch]) => [
            key,
            {
              ...branch,
              verdict: cloneJsonLike(branch.verdict),
              evidenceRefs: branch.evidenceRefs?.map((ref) => ({
                ...ref,
                metadata: ref.metadata ? { ...ref.metadata } : undefined,
              })),
              metadata: branch.metadata ? { ...branch.metadata } : undefined,
            },
          ]),
        )
      : undefined,
    transitionLog: state.transitionLog.map((entry) => ({
      ...entry,
      verdict: JSON.parse(
        JSON.stringify(entry.verdict),
      ) as typeof entry.verdict,
      decision: JSON.parse(
        JSON.stringify(entry.decision),
      ) as typeof entry.decision,
    })),
    failure: state.failure
      ? {
          ...state.failure,
          metadata: state.failure.metadata
            ? { ...state.failure.metadata }
            : undefined,
        }
      : undefined,
  };
}

function toolNameFromPayload(payload: unknown): string | undefined {
  return isRecord(payload) ? stringValue(payload.toolName) : undefined;
}

function workflowPathFromPayload(
  payload: unknown,
  metadata: Record<string, unknown>,
): string | undefined {
  const fromRecord = (record: Record<string, unknown>) => {
    const direct =
      stringValue(record.path) ??
      stringValue(record.workspacePath) ??
      stringValue(record.file) ??
      stringValue(record.targetPath);
    if (direct) return direct;
    const paths = record.paths;
    return Array.isArray(paths) ? stringValue(paths[0]) : undefined;
  };
  if (isRecord(payload)) {
    const direct = fromRecord(payload);
    if (direct) return direct;
    const args = payload.arguments;
    if (isRecord(args)) {
      const fromArgs = fromRecord(args);
      if (fromArgs) return fromArgs;
    }
  }
  return stringValue(metadata.path);
}

function signalFromPayload(payload: unknown): string | undefined {
  return isRecord(payload) ? stringValue(payload.signal) : undefined;
}

function numberOrNullValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function taskNodeOutputFailed(output: unknown): boolean {
  if (!isRecord(output)) return false;
  const status = stringValue(output.status);
  if (status === "failed" || status === "cancelled") return true;
  if (output.error !== undefined) return true;
  return false;
}

function taskNodeOutputRef(output: unknown): string | undefined {
  if (!isRecord(output)) return undefined;
  return stringValue(output.taskId);
}

function matchesAnyGlob(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cloneJsonLike<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
