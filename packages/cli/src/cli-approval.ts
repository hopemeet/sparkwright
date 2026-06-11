import type { ApprovalResolver } from "@sparkwright/core";
import type { CliIO } from "./io.js";
import { write, writeLine } from "./io.js";

export function createCliApprovalResolver(options: {
  approveAll: boolean;
  approveEdits?: boolean;
  approveShellSafe?: boolean;
  io: CliIO;
}): ApprovalResolver {
  return async (request) => {
    if (options.approveAll) {
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
    if (options.approveEdits && isWorkspaceWriteApproval(request)) {
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
    if (options.approveShellSafe && isSafeShellApproval(request)) {
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
