import type { ApprovalResolver } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import {
  createCliApprovalPolicy,
  createCliApprovalResolver,
} from "../src/cli-approval.js";
import type { CliIO } from "../src/io.js";

describe("CLI approval resolver", () => {
  it("normalizes legacy switches and permission modes into one policy", () => {
    expect(createCliApprovalPolicy({})).toEqual({
      enforcement: "ask",
      scopes: [],
    });
    expect(createCliApprovalPolicy({ approveShellSafe: true })).toEqual({
      enforcement: "auto",
      scopes: ["safe_shell"],
    });
    expect(createCliApprovalPolicy({ approveAll: true })).toEqual({
      enforcement: "auto",
      scopes: ["all"],
    });
    expect(
      createCliApprovalPolicy({ permissionMode: "bypass_permissions" }),
    ).toEqual({
      enforcement: "bypass",
      scopes: ["all"],
    });
    expect(createCliApprovalPolicy({ permissionMode: "dont_ask" })).toEqual({
      enforcement: "deny",
      scopes: [],
    });
  });

  it("auto-approves only workspace writes with --yes-edits", async () => {
    const resolver = createCliApprovalResolver({
      approveAll: false,
      approveEdits: true,
      io: captureIo(),
    });

    await expect(
      resolver(request({ action: "workspace.write", summary: "Write README" })),
    ).resolves.toMatchObject({
      decision: "approved",
      message: "Auto-approved by --yes-edits.",
    });

    await expect(
      resolver(
        request({
          action: "tool.execute",
          summary: "Run tool shell",
          details: {
            toolName: "shell",
            arguments: { command: "cat README.md" },
          },
        }),
      ),
    ).resolves.toMatchObject({
      decision: "denied",
      message: "Non-interactive stdin.",
    });
  });

  it("auto-approves safe shell commands but denies unsafe shell commands", async () => {
    const resolver = createCliApprovalResolver({
      approveAll: false,
      approveShellSafe: true,
      io: captureIo(),
    });

    await expect(
      resolver(
        request({
          action: "tool.execute",
          summary: "Run tool shell",
          details: { toolName: "shell", arguments: { command: "rg TODO src" } },
        }),
      ),
    ).resolves.toMatchObject({
      decision: "approved",
      message: "Auto-approved by --yes-shell-safe.",
    });

    await expect(
      resolver(
        request({
          action: "tool.execute",
          summary: "Run tool shell",
          details: {
            toolName: "shell",
            arguments: { command: "curl example.com" },
          },
        }),
      ),
    ).resolves.toMatchObject({
      decision: "denied",
      message: "Non-interactive stdin.",
    });
  });

  it("denies approval requests in dont_ask mode without prompting", async () => {
    const io = captureIo({
      stdinIsTTY: true,
      question: async () => {
        throw new Error("should not prompt");
      },
    });
    const resolver = createCliApprovalResolver({
      permissionMode: "dont_ask",
      io,
    });

    await expect(
      resolver(request({ action: "workspace.write", summary: "Write README" })),
    ).resolves.toMatchObject({
      decision: "denied",
      message: "Approval denied by dont_ask mode.",
    });
  });

  it("auto-approves approval requests in bypass_permissions mode", async () => {
    const resolver = createCliApprovalResolver({
      permissionMode: "bypass_permissions",
      io: captureIo(),
    });

    await expect(
      resolver(
        request({
          action: "tool.execute",
          summary: "Run external shell",
          details: {
            toolName: "shell",
            arguments: { command: "curl example.com" },
          },
        }),
      ),
    ).resolves.toMatchObject({
      decision: "approved",
      message: "Auto-approved by bypass_permissions.",
    });
  });
});

function request(input: {
  action: string;
  summary: string;
  details?: Record<string, unknown>;
}): Parameters<ApprovalResolver>[0] {
  return {
    id: "approval_test" as Parameters<ApprovalResolver>[0]["id"],
    runId: "run_test" as Parameters<ApprovalResolver>[0]["runId"],
    action: input.action,
    summary: input.summary,
    details: input.details ?? {},
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "pending",
  };
}

function captureIo(overrides: Partial<CliIO> = {}): CliIO {
  return {
    stdout: { write: () => true },
    stderr: { write: () => true },
    stdinIsTTY: false,
    ...overrides,
  };
}
