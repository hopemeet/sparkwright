import type { ApprovalRequest, ApprovalResponse } from "./types.js";
import type { PermissionMode } from "./policy.js";
import { isRecord } from "./record-utils.js";

export type ApprovalEnforcementMode = "ask" | "auto" | "deny" | "bypass";

export type ApprovalScope =
  | "safe_shell"
  | "workspace_edits"
  | "external"
  | "mcp"
  | "all";

export interface ApprovalPolicy {
  enforcement: ApprovalEnforcementMode;
  scopes: readonly ApprovalScope[];
}

export interface ApprovalPolicyOptions {
  approveAll?: boolean;
  approveEdits?: boolean;
  approveShellSafe?: boolean;
  permissionMode?: PermissionMode;
}

export function createApprovalPolicy(
  options: ApprovalPolicyOptions,
): ApprovalPolicy {
  if (options.permissionMode === "bypass_permissions") {
    return { enforcement: "bypass", scopes: ["all"] };
  }

  if (options.permissionMode === "dont_ask") {
    return { enforcement: "deny", scopes: [] };
  }

  const scopes: ApprovalScope[] = [];
  if (options.approveAll) {
    scopes.push("all");
  } else {
    if (options.approveEdits || options.permissionMode === "accept_edits") {
      scopes.push("workspace_edits");
    }
    if (options.approveShellSafe) scopes.push("safe_shell");
  }

  return {
    enforcement: scopes.length > 0 ? "auto" : "ask",
    scopes,
  };
}

export function resolveApprovalByPolicy(
  policy: ApprovalPolicy,
  request: ApprovalRequest,
): ApprovalResponse | undefined {
  if (policy.enforcement === "bypass") {
    return {
      approvalId: request.id,
      decision: "approved",
      message: "Auto-approved by bypass_permissions.",
      autoApproved: true,
    };
  }

  if (policy.enforcement === "deny") {
    return {
      approvalId: request.id,
      decision: "denied",
      message: "Approval denied by dont_ask mode.",
    };
  }

  if (policy.enforcement !== "auto") return undefined;

  if (hasScope(policy, "all")) {
    return {
      approvalId: request.id,
      decision: "approved",
      message: "Auto-approved by --yes/--yes-all.",
      autoApproved: true,
    };
  }
  if (
    hasScope(policy, "workspace_edits") &&
    isWorkspaceWriteApproval(request)
  ) {
    return {
      approvalId: request.id,
      decision: "approved",
      message: "Auto-approved by --yes-edits.",
      autoApproved: true,
    };
  }
  if (hasScope(policy, "safe_shell") && isSafeShellApproval(request)) {
    return {
      approvalId: request.id,
      decision: "approved",
      message: "Auto-approved by --yes-shell-safe.",
      autoApproved: true,
    };
  }
  if (hasScope(policy, "mcp") && isMcpApproval(request)) {
    return {
      approvalId: request.id,
      decision: "approved",
      message: "Auto-approved by MCP approval scope.",
      autoApproved: true,
    };
  }
  if (hasScope(policy, "external") && isExternalApproval(request)) {
    return {
      approvalId: request.id,
      decision: "approved",
      message: "Auto-approved by external approval scope.",
      autoApproved: true,
    };
  }

  return undefined;
}

function hasScope(policy: ApprovalPolicy, scope: ApprovalScope): boolean {
  return policy.scopes.includes("all") || policy.scopes.includes(scope);
}

function isWorkspaceWriteApproval(request: ApprovalRequest): boolean {
  return request.action === "workspace.write";
}

function isSafeShellApproval(request: ApprovalRequest): boolean {
  if (request.action !== "tool.execute") return false;
  if (
    !isRecord(request.details) ||
    !isShellToolName(request.details.toolName)
  ) {
    return false;
  }
  const args = isRecord(request.details.arguments)
    ? request.details.arguments
    : undefined;
  const command = typeof args?.command === "string" ? args.command : undefined;
  return isSafeShellCommand(command);
}

function isMcpApproval(request: ApprovalRequest): boolean {
  if (request.action !== "tool.execute") return false;
  if (!isRecord(request.details)) return false;
  if (
    isRecord(request.details.governance) &&
    isRecord(request.details.governance.origin) &&
    request.details.governance.origin.kind === "mcp"
  ) {
    return true;
  }
  return (
    typeof request.details.toolName === "string" &&
    request.details.toolName.startsWith("mcp_")
  );
}

function isExternalApproval(request: ApprovalRequest): boolean {
  if (request.action !== "tool.execute") return false;
  if (!isRecord(request.details)) return false;
  if (isSafeShellApproval(request)) return false;
  if (isShellToolName(request.details.toolName)) return true;

  const sideEffects =
    isRecord(request.details.governance) &&
    Array.isArray(request.details.governance.sideEffects)
      ? request.details.governance.sideEffects
      : undefined;
  return (
    sideEffects?.some(
      (effect) => effect === "external" || effect === "network",
    ) ?? false
  );
}

function isShellToolName(value: unknown): boolean {
  return value === "bash" || value === "shell";
}

function isSafeShellCommand(command: string | undefined): boolean {
  if (!command) return false;
  const normalized = command.trim();
  if (/[|;&`$<>]/.test(normalized)) return false;
  if (
    /\b(curl|wget|ssh|scp|rsync|nc|netcat|rm|mv|cp|chmod|chown)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    /^(pwd|ls|find|rg|grep|cat|sed|head|tail|wc|stat)\b/.test(normalized) ||
    /^(which|command\s+-v)\b/.test(normalized) ||
    /\b(--version|-v)\b/.test(normalized) ||
    /^(cargo\s+(test|nextest\s+run)|go\s+test|pytest|py\.test)\b/.test(
      normalized,
    ) ||
    /^(npm|pnpm|yarn)\s+(run\s+)?test\b/.test(normalized) ||
    /^python(?:\d+(?:\.\d+)*)?\s+-m\s+(unittest|pytest)\b/.test(normalized)
  );
}
