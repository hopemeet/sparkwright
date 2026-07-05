import type { Brand, RunId } from "@sparkwright/core";
import type { TaskError } from "../tasks/types.js";

export type WorkflowRunId = Brand<string, "WorkflowRunId">;

export const WORKFLOW_RUN_RECORD_SCHEMA_VERSION =
  "sparkwright-workflow-run.v1" as const;

export type WorkflowRunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowWaitKind = "input" | "task" | "approval";

export interface WorkflowAssetPin {
  assetName: string;
  version?: string;
  contentHash: string;
}

export interface WorkflowWaitState {
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

export interface WorkflowRunRecord extends WorkflowAssetPin {
  schemaVersion: typeof WORKFLOW_RUN_RECORD_SCHEMA_VERSION;
  id: WorkflowRunId;
  parentRunId?: RunId;
  sessionId?: string;
  activeRunId?: RunId;
  runIds: RunId[];
  status: WorkflowRunStatus;
  /** @reserved Workflow runtime state field reserved for later workflow phases. */
  currentNodeId?: string;
  wait?: WorkflowWaitState;
  attempts: Record<string, number>;
  evidenceRefs: WorkflowEvidenceRef[];
  verdictLog: WorkflowNodeVerdictLogEntry[];
  transitionLog: WorkflowTransitionLogEntry[];
  failure?: WorkflowRunFailure;
  resume: WorkflowResumePolicy;
  definitionSnapshot?: WorkflowDefinition;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  metadata: Record<string, unknown>;
}

export type WorkflowNodeExecuteKind = "model" | "command" | "delegate" | "task";

export type WorkflowVerifierExpectation = "zero" | "nonzero";

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

export type WorkflowVerifierDefinition = WorkflowCommandVerifierDefinition;

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
  body: string;
  tools?: string[];
  verify?: WorkflowVerifierDefinition[];
  onPass?: WorkflowTransitionDefinition;
  onFail?: WorkflowTransitionDefinition;
  metadata?: Record<string, unknown>;
}

export interface WorkflowDefinition extends WorkflowAssetPin {
  description?: string;
  nodes: WorkflowNodeDefinition[];
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type WorkflowRuntimeStatus = "running" | "completed" | "failed";

export interface WorkflowRuntimeFailure {
  reason: string;
  nodeId?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowRuntimeState {
  status: WorkflowRuntimeStatus;
  currentNodeId?: string;
  attempts: Record<string, number>;
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
