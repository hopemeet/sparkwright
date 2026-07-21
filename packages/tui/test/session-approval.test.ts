import { describe, expect, it } from "vitest";
import {
  approvalChoices,
  approvalSubject,
  sessionApprovalRule,
} from "../src/lib/session-approval.js";

describe("session approval subjects", () => {
  it("uses a producer-authored exact shell scope", () => {
    const subject = approvalSubject({
      kind: "shell_command",
      command: "npm test",
      cwd: "/workspace/project",
      key: "shell:exact-npm-test",
      label: "Allow this exact command here for this session",
    });

    expect(subject).toMatchObject({
      kind: "shell_command",
      command: "npm test",
      cwd: "/workspace/project",
    });
    expect(approvalChoices(subject)).toEqual([
      "allow-once",
      "allow-session",
      "deny",
    ]);
    expect(sessionApprovalRule(subject)?.key).toBe("shell:exact-npm-test");
  });

  it("keeps workspace write and remove rules distinct", () => {
    const write = approvalSubject({
      kind: "workspace_file",
      operation: "write",
      path: "src/app.ts",
      key: "workspace_file:write:src/app.ts",
      label: "Allow writing src/app.ts for this session",
    });
    const remove = approvalSubject({
      kind: "workspace_file",
      operation: "remove",
      path: "src/app.ts",
      key: "workspace_file:remove:src/app.ts",
      label: "Allow removing src/app.ts for this session",
    });

    expect(sessionApprovalRule(write)?.key).not.toBe(
      sessionApprovalRule(remove)?.key,
    );
  });

  it("accepts a producer-authored child workspace grant", () => {
    const subject = approvalSubject({
      kind: "agent_workspace_write",
      role: "writer",
      tools: ["edit", "write"],
      key: "agent_workspace_write:writer",
      label: "Allow writer for this session",
    });

    expect(subject).toMatchObject({
      kind: "agent_workspace_write",
      role: "writer",
      tools: ["edit", "write"],
    });
    expect(sessionApprovalRule(subject)).toMatchObject({
      key: "agent_workspace_write:writer",
    });
  });

  it("fails malformed subjects closed to one-shot approval", () => {
    const subject = approvalSubject({
      kind: "workspace_file",
      operation: "write",
      path: "../outside.txt",
      label: "unsafe missing key",
    });

    expect(subject).toEqual({ kind: "one_shot", label: "unsafe missing key" });
    expect(approvalChoices(subject)).toEqual(["allow-once", "deny"]);
    expect(sessionApprovalRule(subject)).toBeUndefined();
  });
});
