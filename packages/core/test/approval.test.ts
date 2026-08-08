import { describe, expect, it } from "vitest";
import { createApprovalRequest, resolveApproval } from "../src/approval.js";
import { createRunId } from "../src/ids.js";

describe("approval", () => {
  it("creates pending approval requests", () => {
    const runId = createRunId();
    const request = createApprovalRequest({
      runId,
      action: "workspace.write",
      summary: "Write README.md",
    });

    expect(request.id).toMatch(/^approval_/);
    expect(request.runId).toBe(runId);
    expect(request.action).toBe("workspace.write");
    expect(request.summary).toBe("Write README.md");
    expect(request.details).toEqual({});
    expect(request.status).toBe("pending");
    expect(Number.isNaN(Date.parse(request.createdAt))).toBe(false);
  });

  it("resolves approval with the configured resolver", async () => {
    const request = createApprovalRequest({
      runId: createRunId(),
      action: "tool.execute",
      summary: "Run risky tool",
    });

    const response = await resolveApproval(request, (received) => {
      expect(received).toBe(request);
      return {
        approvalId: received.id,
        decision: "denied",
        message: "No.",
      };
    });

    expect(response).toEqual({
      approvalId: request.id,
      decision: "denied",
      message: "No.",
    });
  });

  it("denies mismatched approval responses", async () => {
    const request = createApprovalRequest({
      runId: createRunId(),
      action: "workspace.write",
      summary: "Write README.md",
    });

    const response = await resolveApproval(request, () => ({
      approvalId: "approval_stale" as typeof request.id,
      decision: "approved",
    }));

    expect(response).toEqual({
      approvalId: request.id,
      decision: "denied",
      message:
        "Invalid approval response: approvalId does not match the pending request.",
    });
  });

  it("denies malformed approval decisions", async () => {
    const request = createApprovalRequest({
      runId: createRunId(),
      action: "tool.execute",
      summary: "Run risky tool",
    });

    const response = await resolveApproval(
      request,
      () =>
        ({
          approvalId: request.id,
          decision: "maybe",
        }) as never,
    );

    expect(response).toEqual({
      approvalId: request.id,
      decision: "denied",
      message:
        "Invalid approval response: decision must be approved or denied.",
    });
  });

  it("denies approvals that exceed the configured timeout", async () => {
    const request = createApprovalRequest({
      runId: createRunId(),
      action: "tool.execute",
      summary: "Run slow approval",
    });

    const response = await resolveApproval(
      request,
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                approvalId: request.id,
                decision: "approved",
              }),
            20,
          );
        }),
      { timeoutMs: 1 },
    );

    expect(response).toEqual({
      approvalId: request.id,
      decision: "denied",
      message: "Approval timed out after 1ms.",
    });
  });

  it("denies invalid approval timeout values", async () => {
    const request = createApprovalRequest({
      runId: createRunId(),
      action: "workspace.write",
      summary: "Write README.md",
    });

    const response = await resolveApproval(
      request,
      () => ({
        approvalId: request.id,
        decision: "approved",
      }),
      { timeoutMs: 0 },
    );

    expect(response).toEqual({
      approvalId: request.id,
      decision: "denied",
      message: "Approval timeoutMs must be a positive integer.",
    });
  });
});
