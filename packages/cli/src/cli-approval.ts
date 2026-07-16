import {
  createApprovalPolicy,
  resolveApprovalByPolicy,
  type ApprovalPolicy,
  type ApprovalResolver,
  type RunAccessMode,
} from "@sparkwright/core";
import type { CliIO } from "./io.js";
import { write, writeLine } from "./io.js";

export type { ApprovalEnforcementMode, ApprovalScope } from "@sparkwright/core";
export type CliApprovalPolicy = ApprovalPolicy;

export function createCliApprovalPolicy(
  accessMode: RunAccessMode,
): CliApprovalPolicy {
  return createApprovalPolicy(accessMode);
}

export function createCliApprovalResolver(options: {
  approvalPolicy?: CliApprovalPolicy;
  accessMode: RunAccessMode;
  io: CliIO;
}): ApprovalResolver {
  const policy =
    options.approvalPolicy ?? createCliApprovalPolicy(options.accessMode);

  return async (request) => {
    const policyDecision = resolveApprovalByPolicy(policy, request);
    if (policyDecision) {
      writeLine(
        options.io.stderr,
        approvalPolicyLogLine(policyDecision.message, request.summary),
      );
      return policyDecision;
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

function approvalPolicyLogLine(
  message: string | undefined,
  summary: string,
): string {
  if (message === "Auto-approved by accept-edits access mode.") {
    return `Approval auto-approved for workspace edit: ${summary}`;
  }
  return `Approval auto-approved: ${summary}`;
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
