import type { Brand, RunId } from "@sparkwright/core";

export type WorkflowRunId = Brand<string, "WorkflowRunId">;

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

/**
 * Reserved durable workflow-run record shape. P0 defines the schema contract
 * only; no store or runtime writer exists yet.
 */
export interface WorkflowRunRecord extends WorkflowAssetPin {
  id: WorkflowRunId;
  parentRunId?: RunId;
  status: WorkflowRunStatus;
  /** @reserved Workflow runtime state field reserved for later workflow phases. */
  currentNodeId?: string;
  wait?: WorkflowWaitState;
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
