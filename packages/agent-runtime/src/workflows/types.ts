import type { Brand, RunBudget, RunId } from "@sparkwright/core";
import type { TaskError } from "../tasks/types.js";

export type WorkflowRunId = Brand<string, "WorkflowRunId">;

export const WORKFLOW_RUN_RECORD_SCHEMA_VERSION =
  "sparkwright-workflow-run.v2" as const;

export type WorkflowRunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowWaitKind = "input" | "task" | "approval";

export interface WorkflowAssetPin {
  assetName: string;
  layer: "builtin" | "user" | "project";
  version?: string;
  packageHash: string;
  packageHashPolicyVersion: 2;
  packageSnapshotRef: string;
}

export interface WorkflowSourceIdentity {
  assetName: string;
  version?: string;
  contentHash: string;
}

export interface WorkflowWaitState {
  id?: string;
  kind: WorkflowWaitKind;
  reason?: string;
  taskId?: string;
  approvalId?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowEvidenceRef {
  kind: "trace_span" | "artifact" | "task_output" | "fact" | "run";
  ref: string;
  nodeId?: string;
  verifierId?: string;
  metadata?: Record<string, unknown>;
}

export type WorkflowRunFailureKind =
  | "verdict"
  | "runtime"
  | "cancelled"
  | "definition";

export interface WorkflowRunFailure extends TaskError {
  kind: WorkflowRunFailureKind;
  nodeId?: string;
}

export interface WorkflowResumePolicy {
  verifyOnResume: boolean;
}

export type WorkflowRunAccessMode =
  | "read-only"
  | "ask"
  | "accept-edits"
  | "bypass";

export type WorkflowBackgroundTaskPolicy =
  | "disabled"
  | "foreground-only"
  | "enabled";

export interface WorkflowRunAuthorizationSnapshot {
  targetPath?: string;
  confidentialPaths: string[];
  confidentialDefaults: boolean;
  accessMode: WorkflowRunAccessMode;
  backgroundTasks: WorkflowBackgroundTaskPolicy;
}

export interface WorkflowRunRecord extends WorkflowAssetPin {
  schemaVersion: typeof WORKFLOW_RUN_RECORD_SCHEMA_VERSION;
  id: WorkflowRunId;
  recordRevision: number;
  generation: number;
  parentRunId?: RunId;
  sessionId?: string;
  activeRunId?: RunId;
  runIds: RunId[];
  status: WorkflowRunStatus;
  /** @reserved Workflow runtime state field reserved for later workflow phases. */
  currentNodeId?: string;
  wait?: WorkflowWaitState;
  attempts: Record<string, number>;
  parallelBranches?: Record<string, WorkflowParallelBranchState>;
  evidenceRefs: WorkflowEvidenceRef[];
  verdictLog: WorkflowNodeVerdictLogEntry[];
  transitionLog: WorkflowTransitionLogEntry[];
  failure?: WorkflowRunFailure;
  resume: WorkflowResumePolicy;
  authorizationSnapshot?: WorkflowRunAuthorizationSnapshot;
  definitionSnapshot: PinnedWorkflowDefinition;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  metadata: Record<string, unknown>;
}

export type WorkflowNodeExecuteKind =
  | "model"
  | "command"
  | "delegate"
  | "task"
  | "human"
  | "script"
  | "parallel"
  | "join";

export type WorkflowVerifierExpectation = "zero" | "nonzero";

export interface WorkflowCommandNodeDefinition {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  expect?: WorkflowVerifierExpectation;
  /**
   * P3 trust declaration: command nodes are host-executed workflow asset code,
   * so instantiation must opt in before the projection may run them.
   */
  authorized?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkflowDelegateNodeDefinition {
  agentId: string;
  goal: string;
  metadata?: Record<string, unknown>;
}

export type WorkflowTaskNodeMode = "foreground" | "awaited" | "background";

export interface WorkflowTaskNodeDefinition {
  kind: string;
  title?: string;
  mode?: WorkflowTaskNodeMode;
  awaited?: boolean;
  payload?: unknown;
  metadata?: Record<string, unknown>;
}

export interface WorkflowHumanNodeDefinition {
  prompt?: string;
  wait?: WorkflowWaitState;
  metadata?: Record<string, unknown>;
}

export type WorkflowScriptNodeCapability =
  | "read"
  | "write"
  | "shell"
  | "network"
  | "mcp"
  | "agent"
  | "task";

export interface WorkflowScriptNodeDefinition {
  path: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  capabilities?: WorkflowScriptNodeCapability[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowParallelNodeDefinition {
  branches: string[];
  maxConcurrency?: number;
  metadata?: Record<string, unknown>;
}

export interface WorkflowJoinNodeDefinition {
  waitFor: string[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowCommandVerifierDefinition {
  id: string;
  kind: "command";
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  expect?: WorkflowVerifierExpectation;
  /**
   * P1 trust declaration: verifier commands run inside a non-interactive hook
   * gate, so the asset must declare they are authorized before instantiation.
   */
  authorized?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkflowDiffScopeVerifierDefinition {
  id: string;
  kind: "diff_scope";
  include?: string[];
  exclude?: string[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowTodoClearVerifierDefinition {
  id: string;
  kind: "todo_clear";
  metadata?: Record<string, unknown>;
}

export type WorkflowVerifierDefinition =
  | WorkflowCommandVerifierDefinition
  | WorkflowDiffScopeVerifierDefinition
  | WorkflowTodoClearVerifierDefinition;

export type WorkflowTransitionDefinition =
  | string
  | {
      goto: string;
    }
  | {
      retry: number;
      then?: WorkflowTransitionDefinition;
    }
  | {
      fail: true | string;
    };

export interface WorkflowNodeDefinition {
  id: string;
  title?: string;
  execute?: WorkflowNodeExecuteKind;
  model?: string;
  runBudget?: RunBudget;
  body: string;
  tools?: string[];
  command?: WorkflowCommandNodeDefinition;
  delegate?: WorkflowDelegateNodeDefinition;
  task?: WorkflowTaskNodeDefinition;
  human?: WorkflowHumanNodeDefinition;
  script?: WorkflowScriptNodeDefinition;
  parallel?: WorkflowParallelNodeDefinition;
  join?: WorkflowJoinNodeDefinition;
  verify?: WorkflowVerifierDefinition[];
  onPass?: WorkflowTransitionDefinition;
  onFail?: WorkflowTransitionDefinition;
  metadata?: Record<string, unknown>;
}

export interface WorkflowExecutableDefinition {
  assetName: string;
  version?: string;
  sourcePath?: string;
  sourceDir?: string;
  description?: string;
  nodes: WorkflowNodeDefinition[];
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface WorkflowDefinition
  extends WorkflowExecutableDefinition, WorkflowSourceIdentity {}

export interface PinnedWorkflowDefinition
  extends WorkflowExecutableDefinition, WorkflowAssetPin {
  sourceDir: string;
}

export type WorkflowRuntimeStatus = "running" | "completed" | "failed";

export interface WorkflowRuntimeFailure {
  reason: string;
  nodeId?: string;
  metadata?: Record<string, unknown>;
}

export type WorkflowParallelBranchStatus =
  | "passed"
  | "failed"
  | "runtime_error";

export interface WorkflowParallelBranchState {
  /** @reserved Public workflow branch provenance consumed by resume diagnostics and future workflow UIs. */
  sourceNodeId: string;
  nodeId: string;
  attempt: number;
  status: WorkflowParallelBranchStatus;
  verdict: WorkflowNodeVerdict;
  evidenceRefs?: WorkflowEvidenceRef[];
  completedAt: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowRuntimeState {
  status: WorkflowRuntimeStatus;
  currentNodeId?: string;
  attempts: Record<string, number>;
  parallelBranches?: Record<string, WorkflowParallelBranchState>;
  transitionLog: WorkflowTransitionLogEntry[];
  failure?: WorkflowRuntimeFailure;
}

export type WorkflowNodeVerdict =
  | {
      status: "passed";
      reason?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "failed";
      reason?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "runtime_error";
      reason: string;
      metadata?: Record<string, unknown>;
    };

export type WorkflowTransitionDecision =
  | {
      type: "goto";
      fromNodeId: string;
      toNodeId: string;
      reason: string;
    }
  | {
      type: "retry";
      nodeId: string;
      attempt: number;
      maxRetries: number;
      reason: string;
    }
  | {
      type: "fail";
      fromNodeId?: string;
      reason: string;
    }
  | {
      type: "complete";
      fromNodeId: string;
      reason: string;
    };

export interface WorkflowTransitionLogEntry {
  at: string;
  verdict: WorkflowNodeVerdict;
  decision: WorkflowTransitionDecision;
}

export interface WorkflowNodeVerdictLogEntry {
  at: string;
  nodeId: string;
  attempt: number;
  verdict: WorkflowNodeVerdict;
  evidenceRefs?: WorkflowEvidenceRef[];
}

export type WorkflowStoreEventType =
  | "created"
  | "updated"
  | "waiting"
  | "input"
  | "completed"
  | "failed"
  | "cancelled"
  | "adopted"
  | "released";

export interface WorkflowStoreEvent {
  at: string;
  type: WorkflowStoreEventType;
  workflowRunId: WorkflowRunId;
  parentRunId?: RunId;
  status: WorkflowRunStatus;
  metadata?: Record<string, unknown>;
}
