import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../src/types.js";
import {
  createApprovalPolicy,
  resolveApprovalByPolicy,
} from "../src/approval-policy.js";

describe("approval policy", () => {
  it("derives approval behavior from the canonical access mode", () => {
    expect(createApprovalPolicy("read-only")).toEqual({
      enforcement: "ask",
      scopes: [],
    });
    expect(createApprovalPolicy("ask")).toEqual({
      enforcement: "ask",
      scopes: [],
    });
    expect(createApprovalPolicy("accept-edits")).toEqual({
      enforcement: "auto",
      scopes: ["workspace_edits"],
    });
    expect(createApprovalPolicy("bypass")).toEqual({
      enforcement: "bypass",
      scopes: ["all"],
    });
  });

  it("accept-edits auto-approves workspace writes only", () => {
    const policy = createApprovalPolicy("accept-edits");
    expect(
      resolveApprovalByPolicy(
        policy,
        request({ action: "workspace.write", summary: "Write README" }),
      ),
    ).toMatchObject({
      decision: "approved",
      message: "Auto-approved by accept-edits access mode.",
    });
    expect(
      resolveApprovalByPolicy(
        policy,
        request({ action: "tool.execute", summary: "Run bash" }),
      ),
    ).toBeUndefined();
  });

  it("bypass auto-approves any approval request", () => {
    expect(
      resolveApprovalByPolicy(
        createApprovalPolicy("bypass"),
        request({ action: "tool.execute", summary: "Run bash" }),
      ),
    ).toMatchObject({
      decision: "approved",
      message: "Auto-approved by bypass access mode.",
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
