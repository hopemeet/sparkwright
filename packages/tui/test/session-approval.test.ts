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
    expect(sessionApprovalRule(subject)).toMatchObject({
      principalScope: "main",
      subjectKey: "shell:exact-npm-test",
    });
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

  it("accepts revisioned workspace operations without a child grant subject", () => {
    const subject = approvalSubject({
      kind: "workspace_file",
      operation: "replace",
      path: "src/app.ts",
      key: "workspace_file:replace:src/app.ts",
      label: "Allow replacing src/app.ts for this session",
    });

    expect(subject).toMatchObject({
      kind: "workspace_file",
      operation: "replace",
      path: "src/app.ts",
    });
    expect(sessionApprovalRule(subject)).toMatchObject({
      subjectKey: "workspace_file:replace:src/app.ts",
    });
  });

  it("never reuses a remembered subject across approval principals", () => {
    const subject = approvalSubject({
      kind: "workspace_file",
      operation: "write",
      path: "src/app.ts",
      key: "workspace_file:write:src/app.ts",
      label: "Allow writing src/app.ts for this session",
    });

    const main = sessionApprovalRule(subject, "session:main");
    const firstChild = sessionApprovalRule(subject, "run:child-1");
    const secondChild = sessionApprovalRule(subject, "run:child-2");

    expect(main?.key).not.toBe(firstChild?.key);
    expect(firstChild?.key).not.toBe(secondChild?.key);
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
