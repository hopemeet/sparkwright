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

export interface WorkflowNodeDefinition {
  id: string;
  title?: string;
  execute?: WorkflowNodeExecuteKind;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowDefinition extends WorkflowAssetPin {
  description?: string;
  nodes: WorkflowNodeDefinition[];
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
