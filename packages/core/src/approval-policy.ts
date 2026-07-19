import type { RunAccessMode } from "./access-mode.js";
import type { ApprovalRequest, ApprovalResponse } from "./types.js";

export type ApprovalEnforcementMode = "ask" | "auto" | "bypass";

export type ApprovalScope = "workspace_edits" | "all";

export interface ApprovalPolicy {
  enforcement: ApprovalEnforcementMode;
  scopes: readonly ApprovalScope[];
}

export function createApprovalPolicy(
  accessMode: RunAccessMode,
): ApprovalPolicy {
  if (accessMode === "bypass") {
    return { enforcement: "bypass", scopes: ["all"] };
  }
  if (accessMode === "accept-edits") {
    return { enforcement: "auto", scopes: ["workspace_edits"] };
  }
  return { enforcement: "ask", scopes: [] };
}

export function resolveApprovalByPolicy(
  policy: ApprovalPolicy,
  request: ApprovalRequest,
): ApprovalResponse | undefined {
  if (policy.enforcement === "bypass") {
    return {
      approvalId: request.id,
      decision: "approved",
      message: "Auto-approved by bypass access mode.",
      autoApproved: true,
    };
  }

  if (
    policy.enforcement === "auto" &&
    policy.scopes.includes("workspace_edits") &&
    request.action === "workspace.write"
  ) {
    return {
      approvalId: request.id,
      decision: "approved",
      message: "Auto-approved by accept-edits access mode.",
      autoApproved: true,
    };
  }

  return undefined;
}
