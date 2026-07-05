import {
  commandExpectationSatisfied,
  createContextItemId,
  createRunId,
  type ContextItem,
  type FactLedgerSnapshot,
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
  type WorkflowDefinition,
  type WorkflowEvidenceRef,
  type WorkflowNodeDefinition,
  type WorkflowNodeVerdict,
  type WorkflowRuntimeState,
  type WorkflowTransitionDecision,
} from "@sparkwright/agent-runtime";
import type { CapabilityWorkflowHookConfig } from "./config.js";
import {
  createConfiguredWorkflowHooks,
  type CreateConfiguredWorkflowHooksOptions,
} from "./workflow-hooks.js";

const DEFAULT_STOP_RUNTIME_ERROR_THRESHOLD = 3;

export interface CreateWorkflowProjectionHooksOptions extends Omit<
  CreateConfiguredWorkflowHooksOptions,
  "hooks" | "workflowActive"
> {
  definition: WorkflowDefinition;
  workflowRunId?: string;
  initialState?: WorkflowRuntimeState;
  resumeVerificationNodeIds?: readonly string[];
  stopRuntimeErrorThreshold?: number;
  builtinVerifiers?: Record<string, WorkflowBuiltinVerifierHandler>;
  onStateSnapshot?: (
    snapshot: WorkflowProjectionStateSnapshot,
  ) => void | Promise<void>;
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
  definition: WorkflowDefinition;
  state: WorkflowRuntimeState;
  phase:
    | "started"
    | "node_started"
    | "node_completed"
    | "interrupted"
    | "terminal";
  nodeId?: string;
  attempt?: number;
  verdict?: WorkflowNodeVerdict;
  evidenceRefs?: WorkflowEvidenceRef[];
  decision?: WorkflowTransitionDecision;
  terminalStatus?: "completed" | "failed" | "cancelled";
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

export function createWorkflowProjectionHooks(
  options: CreateWorkflowProjectionHooksOptions,
): WorkflowProjectionHookSet {
  validateP1WorkflowDefinition(options.definition);
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
      contentHash: options.definition.contentHash,
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
    state = {
      status: "failed",
      attempts: { ...state.attempts },
      transitionLog: [...state.transitionLog],
      failure: {
        reason: "runtime",
        nodeId: state.currentNodeId,
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
        return {
          status: "block",
          reason: `Workflow node "${node.id}" does not allow tool "${toolName}".`,
          metadata: {
            workflowRunId,
            nodeId: node.id,
            toolName,
            allowedTools: allowed,
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
            const verdicts = resumeVerification.map((node) => {
              const evaluation = nodeVerdictFromLedger(
                snapshot,
                familyName,
                node,
              );
              return {
                node,
                attempt: state.attempts[node.id] ?? 1,
                verdict: evaluation.verdict,
                evidenceRefs: evaluation.evidenceRefs,
              };
            });
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
          const evaluation = nodeVerdictFromLedger(
            input.facts?.snapshot(),
            familyName,
            node,
          );
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
    if (nodeStartKeys.has(key)) return;
    nodeStartKeys.add(key);
    emit(input, "workflow.node.started", {
      nodeId: node.id,
      attempt,
      title: node.title,
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
    (node.verify ?? []).map((verifier) => {
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

function nodeVerdictFromLedger(
  snapshot: FactLedgerSnapshot | undefined,
  hookName: string,
  node: WorkflowNodeDefinition,
): WorkflowNodeVerdictEvaluation {
  const verifiers = node.verify ?? [];
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
  if (!snapshot) {
    return {
      verdict: {
        status: "runtime_error",
        reason: "FactLedger is unavailable to the workflow projection.",
      },
      evidenceRefs: [],
    };
  }
  const results = verifiers.map((verifier) => {
    const latest = snapshot.verificationResults
      .filter(
        (result) =>
          result.hookName === hookName &&
          result.nodeId === node.id &&
          result.verifierId === verifier.id,
      )
      .sort((left, right) => left.sequence - right.sequence)
      .at(-1);
    return {
      verifier,
      latest,
      satisfied: latest?.satisfied === true && latest.stale === false,
    };
  });
  const evidenceRefs = results.flatMap((result): WorkflowEvidenceRef[] => {
    if (!result.latest) return [];
    return [
      {
        kind: "fact",
        ref: result.latest.id,
        nodeId: node.id,
        verifierId: result.verifier.id,
        metadata: {
          commandFactId: result.latest.commandFactId,
          sequence: result.latest.sequence,
          writeEpoch: result.latest.writeEpoch,
          stale: result.latest.stale,
        },
      },
    ];
  });
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
        failures: failed.map((result) => ({
          verifierId: result.verifier.id,
          missing: result.latest === undefined,
          stale: result.latest?.stale === true,
          satisfied: result.latest?.satisfied,
          exitCode: result.latest?.exitCode,
          timedOut: result.latest?.timedOut,
          factRef: result.latest?.id,
        })),
      },
    },
    evidenceRefs,
  };
}

function validateP1WorkflowDefinition(definition: WorkflowDefinition): void {
  assertWorkflowRuntimeDefinition(definition);
  for (const node of definition.nodes) {
    if (node.execute !== undefined && node.execute !== "model") {
      throw new Error(
        `Workflow node "${node.id}" execute kind "${node.execute}" is not supported in P1; only model nodes can be projected.`,
      );
    }
    for (const verifier of node.verify ?? []) {
      assertVerifierAuthorized(verifier);
      assertStaticArgv(verifier);
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

function currentNode(
  definition: WorkflowDefinition,
  state: WorkflowRuntimeState,
): WorkflowNodeDefinition | undefined {
  return definition.nodes.find((node) => node.id === state.currentNodeId);
}

function resumeVerificationNodes(
  definition: WorkflowDefinition,
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

function cloneRuntimeState(state: WorkflowRuntimeState): WorkflowRuntimeState {
  return {
    ...state,
    attempts: { ...state.attempts },
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

function signalFromPayload(payload: unknown): string | undefined {
  return isRecord(payload) ? stringValue(payload.signal) : undefined;
}

function numberOrNullValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
