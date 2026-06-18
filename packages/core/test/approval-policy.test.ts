import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../src/types.js";
import {
  createApprovalPolicy,
  resolveApprovalByPolicy,
} from "../src/approval-policy.js";

describe("approval policy", () => {
  it("normalizes approval flags and permission modes", () => {
    expect(createApprovalPolicy({})).toEqual({
      enforcement: "ask",
      scopes: [],
    });
    expect(createApprovalPolicy({ approveShellSafe: true })).toEqual({
      enforcement: "auto",
      scopes: ["safe_shell"],
    });
    expect(createApprovalPolicy({ approveAll: true })).toEqual({
      enforcement: "auto",
      scopes: ["all"],
    });
    expect(
      createApprovalPolicy({ permissionMode: "bypass_permissions" }),
    ).toEqual({
      enforcement: "bypass",
      scopes: ["all"],
    });
    expect(createApprovalPolicy({ permissionMode: "dont_ask" })).toEqual({
      enforcement: "deny",
      scopes: [],
    });
  });

  it("auto-approves safe shell commands only when that scope is enabled", () => {
    const safeShell = request({
      action: "tool.execute",
      summary: "Run tool shell",
      details: { toolName: "shell", arguments: { command: "npm test" } },
    });
    const unsafeShell = request({
      action: "tool.execute",
      summary: "Run tool shell",
      details: {
        toolName: "shell",
        arguments: { command: "curl example.com" },
      },
    });
    const policy = createApprovalPolicy({ approveShellSafe: true });

    expect(resolveApprovalByPolicy(policy, safeShell)).toMatchObject({
      decision: "approved",
      message: "Auto-approved by --yes-shell-safe.",
    });
    expect(resolveApprovalByPolicy(policy, unsafeShell)).toBeUndefined();
  });

  it("bypasses approval prompts but dont_ask denies them", () => {
    const approval = request({
      action: "tool.execute",
      summary: "Run tool shell",
      details: { toolName: "shell", arguments: { command: "node -v" } },
    });

    expect(
      resolveApprovalByPolicy(
        createApprovalPolicy({ permissionMode: "bypass_permissions" }),
        approval,
      ),
    ).toMatchObject({
      decision: "approved",
      message: "Auto-approved by bypass_permissions.",
    });
    expect(
      resolveApprovalByPolicy(
        createApprovalPolicy({ permissionMode: "dont_ask" }),
        approval,
      ),
    ).toMatchObject({
      decision: "denied",
      message: "Approval denied by dont_ask mode.",
    });
  });
});

function request(input: {
  action: string;
  summary: string;
  details?: Record<string, unknown>;
}): ApprovalRequest {
  return {
    id: "approval_test" as ApprovalRequest["id"],
    runId: "run_test" as ApprovalRequest["runId"],
    action: input.action,
    summary: input.summary,
    details: input.details ?? {},
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "pending",
  };
}
