import {
  createApprovalPolicy,
  resolveApprovalByPolicy,
  type ApprovalId,
  type RunId,
} from "@sparkwright/core";
import type {
  ApprovalResolveRequestPayload,
  PermissionMode,
} from "@sparkwright/protocol";

export interface HostClientApprovalPolicyInput {
  approveAll?: boolean;
  approveEdits?: boolean;
  approveShellSafe?: boolean;
  permissionMode?: PermissionMode;
}

export interface HostClientApprovalRequestInput {
  approvalId: string;
  runId: string;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export function resolveHostClientApprovalByPolicy(
  policyInput: HostClientApprovalPolicyInput,
  requestInput: HostClientApprovalRequestInput,
): ApprovalResolveRequestPayload | undefined {
  const decision = resolveApprovalByPolicy(createApprovalPolicy(policyInput), {
    id: requestInput.approvalId as ApprovalId,
    runId: requestInput.runId as RunId,
    action: requestInput.action,
    summary: requestInput.summary,
    details: requestInput.details ?? {},
    createdAt: requestInput.createdAt,
    status: "pending",
  });

  if (!decision) return undefined;
  return {
    approvalId: requestInput.approvalId,
    decision: decision.decision,
    message: decision.message,
    autoApproved: decision.autoApproved,
  };
}
