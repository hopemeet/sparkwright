import type { ApprovalResolver } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import { createCliApprovalResolver } from "../src/cli-approval.js";
import type { CliIO } from "../src/io.js";

describe("CLI approval resolver", () => {
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

function captureIo(): CliIO {
  return {
    stdout: { write() {} },
    stderr: { write() {} },
    stdinIsTTY: false,
  };
}
