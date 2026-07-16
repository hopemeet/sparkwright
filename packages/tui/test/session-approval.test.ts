import { describe, expect, it } from "vitest";
import {
  approvalChoices,
  approvalSubject,
  sessionApprovalRule,
} from "../src/lib/session-approval.js";

const workspaceRoot = "/workspace/project";

describe("session approval subjects", () => {
  it("recognizes shell tools wrapped by tool.execute", () => {
    const subject = approvalSubject(
      {
        action: "tool.execute",
        details: {
          toolName: "bash",
          arguments: { command: "npm test", cwd: "/workspace/project" },
          governance: { origin: { kind: "local", name: "sparkwright" } },
        },
      },
      workspaceRoot,
    );

    expect(subject).toMatchObject({
      kind: "shell",
      command: "npm test",
      cwd: "/workspace/project",
    });
    expect(approvalChoices(subject)).toEqual([
      "allow-once",
      "allow-session",
      "deny",
    ]);
  });

  it("matches exact shell context, not command text alone", () => {
    const make = (cwd: string, command = "npm test") =>
      approvalSubject(
        {
          action: "tool.execute",
          details: { toolName: "bash", arguments: { command, cwd } },
        },
        workspaceRoot,
      );

    const first = sessionApprovalRule(make("/workspace/project"));
    const same = sessionApprovalRule(make("/workspace/project"));
    const otherCwd = sessionApprovalRule(make("/workspace/other"));
    const compound = sessionApprovalRule(
      make("/workspace/project", "npm test && rm -rf tmp"),
    );

    expect(first?.key).toBe(same?.key);
    expect(first?.key).not.toBe(otherCwd?.key);
    expect(first?.key).not.toBe(compound?.key);
  });

  it("canonicalizes tool argument object ordering", () => {
    const first = approvalSubject(
      {
        action: "tool.execute",
        details: { toolName: "deploy", arguments: { b: 2, a: 1 } },
      },
      workspaceRoot,
    );
    const second = approvalSubject(
      {
        action: "tool.execute",
        details: { toolName: "deploy", arguments: { a: 1, b: 2 } },
      },
      workspaceRoot,
    );

    expect(sessionApprovalRule(first)?.key).toBe(
      sessionApprovalRule(second)?.key,
    );
  });

  it("rejects workspace paths outside the workspace", () => {
    const subject = approvalSubject(
      { action: "workspace.write", details: { path: "../outside.txt" } },
      workspaceRoot,
    );

    expect(subject).toEqual({ kind: "unknown" });
    expect(approvalChoices(subject)).toEqual(["allow-once", "deny"]);
  });
});
