import type { ApprovalResolver, PermissionMode } from "@sparkwright/core";
import type { CliIO } from "./io.js";
import { write, writeLine } from "./io.js";

export type ApprovalEnforcementMode = "ask" | "auto" | "deny" | "bypass";

export type ApprovalScope =
  | "safe_shell"
  | "workspace_edits"
  | "external"
  | "mcp"
  | "all";

export interface CliApprovalPolicy {
  enforcement: ApprovalEnforcementMode;
  scopes: readonly ApprovalScope[];
}

export function createCliApprovalPolicy(options: {
  approveAll?: boolean;
  approveEdits?: boolean;
  approveShellSafe?: boolean;
  permissionMode?: PermissionMode;
}): CliApprovalPolicy {
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

export function createCliApprovalResolver(options: {
  approvalPolicy?: CliApprovalPolicy;
  approveAll?: boolean;
  approveEdits?: boolean;
  approveShellSafe?: boolean;
  permissionMode?: PermissionMode;
  io: CliIO;
}): ApprovalResolver {
  const policy =
    options.approvalPolicy ??
    createCliApprovalPolicy({
      approveAll: options.approveAll,
      approveEdits: options.approveEdits,
      approveShellSafe: options.approveShellSafe,
      permissionMode: options.permissionMode,
    });

  return async (request) => {
    if (policy.enforcement === "bypass") {
      writeLine(
        options.io.stderr,
        `Approval auto-approved: ${request.summary}`,
      );
      return {
        approvalId: request.id,
        decision: "approved",
        message: "Auto-approved by bypass_permissions.",
      };
    }

    if (policy.enforcement === "deny") {
      writeLine(
        options.io.stderr,
        `Approval denied by permission mode: ${request.summary}`,
      );
      return {
        approvalId: request.id,
        decision: "denied",
        message: "Approval denied by dont_ask mode.",
      };
    }

    if (policy.enforcement === "auto" && hasScope(policy, "all")) {
      writeLine(
        options.io.stderr,
        `Approval auto-approved: ${request.summary}`,
      );
      return {
        approvalId: request.id,
        decision: "approved",
        message: "Auto-approved by --yes/--yes-all.",
      };
    }
    if (
      policy.enforcement === "auto" &&
      hasScope(policy, "workspace_edits") &&
      isWorkspaceWriteApproval(request)
    ) {
      writeLine(
        options.io.stderr,
        `Approval auto-approved for workspace edit: ${request.summary}`,
      );
      return {
        approvalId: request.id,
        decision: "approved",
        message: "Auto-approved by --yes-edits.",
      };
    }
    if (
      policy.enforcement === "auto" &&
      hasScope(policy, "safe_shell") &&
      isSafeShellApproval(request)
    ) {
      writeLine(
        options.io.stderr,
        `Approval auto-approved for safe shell: ${request.summary}`,
      );
      return {
        approvalId: request.id,
        decision: "approved",
        message: "Auto-approved by --yes-shell-safe.",
      };
    }
    if (
      policy.enforcement === "auto" &&
      hasScope(policy, "mcp") &&
      isMcpApproval(request)
    ) {
      writeLine(
        options.io.stderr,
        `Approval auto-approved for MCP tool: ${request.summary}`,
      );
      return {
        approvalId: request.id,
        decision: "approved",
        message: "Auto-approved by MCP approval scope.",
      };
    }
    if (
      policy.enforcement === "auto" &&
      hasScope(policy, "external") &&
      isExternalApproval(request)
    ) {
      writeLine(
        options.io.stderr,
        `Approval auto-approved for external action: ${request.summary}`,
      );
      return {
        approvalId: request.id,
        decision: "approved",
        message: "Auto-approved by external approval scope.",
      };
    }

    if (options.io.stdinIsTTY !== true || !options.io.question) {
      writeLine(
        options.io.stderr,
        `Approval denied because stdin is not interactive: ${request.summary}`,
      );
      return {
        approvalId: request.id,
        decision: "denied",
        message: "Non-interactive stdin.",
      };
    }

    write(options.io.stderr, formatApprovalRequest(request));

    while (true) {
      const answer = normalizeApprovalAnswer(
        await options.io.question("Approve? [y/N] "),
      );

      if (answer) {
        return {
          approvalId: request.id,
          decision: answer,
        };
      }

      writeLine(options.io.stderr, "Please answer yes or no.");
    }
  };
}

function hasScope(policy: CliApprovalPolicy, scope: ApprovalScope): boolean {
  return policy.scopes.includes("all") || policy.scopes.includes(scope);
}

function formatApprovalRequest(
  request: Parameters<ApprovalResolver>[0],
): string {
  const lines = [
    "",
    "Approval required",
    `Action: ${request.action}`,
    `Summary: ${request.summary}`,
    `Approval ID: ${request.id}`,
  ];

  const path =
    isRecord(request.details) && typeof request.details.path === "string"
      ? request.details.path
      : undefined;
  const reason =
    isRecord(request.details) && typeof request.details.reason === "string"
      ? request.details.reason
      : undefined;
  const diff =
    isRecord(request.details) && typeof request.details.diff === "string"
      ? request.details.diff
      : undefined;

  if (path) lines.push(`Path: ${path}`);
  if (reason) lines.push(`Reason: ${reason}`);
  if (diff) lines.push("", diff);

  if (
    !diff &&
    isRecord(request.details) &&
    Object.keys(request.details).length > 0
  ) {
    lines.push("", JSON.stringify(request.details, null, 2));
  }
  return `${lines.join("\n")}\n`;
}

function isWorkspaceWriteApproval(
  request: Parameters<ApprovalResolver>[0],
): boolean {
  return request.action === "workspace.write";
}

function isSafeShellApproval(
  request: Parameters<ApprovalResolver>[0],
): boolean {
  if (request.action !== "tool.execute") return false;
  if (!isRecord(request.details) || request.details.toolName !== "shell") {
    return false;
  }
  const args = isRecord(request.details.arguments)
    ? request.details.arguments
    : undefined;
  const command = typeof args?.command === "string" ? args.command : undefined;
  return isSafeShellCommand(command);
}

function isMcpApproval(request: Parameters<ApprovalResolver>[0]): boolean {
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

function isExternalApproval(request: Parameters<ApprovalResolver>[0]): boolean {
  if (request.action !== "tool.execute") return false;
  if (!isRecord(request.details)) return false;
  if (isSafeShellApproval(request)) return false;
  if (request.details.toolName === "shell") return true;

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

function normalizeApprovalAnswer(
  value: string,
): "approved" | "denied" | undefined {
  const normalized = value.trim().toLowerCase();

  if (
    normalized === "" ||
    normalized === "n" ||
    normalized === "no" ||
    normalized === "deny" ||
    normalized === "denied"
  ) {
    return "denied";
  }

  if (
    normalized === "y" ||
    normalized === "yes" ||
    normalized === "approve" ||
    normalized === "approved"
  ) {
    return "approved";
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
