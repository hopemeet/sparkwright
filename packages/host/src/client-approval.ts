import {
  createApprovalPolicy,
  resolveApprovalByPolicy,
  type ApprovalId,
  type ApprovalPrincipal,
  type ApprovalSubject,
  type RunId,
  type RunAccessMode,
} from "@sparkwright/core";
import type { ApprovalResolveRequestPayload } from "@sparkwright/protocol";

export interface HostClientApprovalPolicyInput {
  accessMode: RunAccessMode;
}

export interface HostClientApprovalRequestInput {
  approvalId: string;
  runId: string;
  action: string;
  summary: string;
  subject: ApprovalSubject;
  principal?: ApprovalPrincipal;
  details?: Record<string, unknown>;
  createdAt: string;
}

export function resolveHostClientApprovalByPolicy(
  policyInput: HostClientApprovalPolicyInput,
  requestInput: HostClientApprovalRequestInput,
): ApprovalResolveRequestPayload | undefined {
  const decision = resolveApprovalByPolicy(
    createApprovalPolicy(policyInput.accessMode),
    {
      id: requestInput.approvalId as ApprovalId,
      runId: requestInput.runId as RunId,
      action: requestInput.action,
      summary: requestInput.summary,
      subject: requestInput.subject,
      principal: requestInput.principal ?? {
        kind: "main",
        principalScope: `run:${requestInput.runId}`,
      },
      details: requestInput.details ?? {},
      createdAt: requestInput.createdAt,
      status: "pending",
    },
  );

  if (!decision) return undefined;
  return {
    approvalId: requestInput.approvalId,
    decision: decision.decision,
    message: decision.message,
    autoApproved: decision.autoApproved,
  };
}
