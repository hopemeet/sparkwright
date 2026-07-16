import type { ApprovalResolver } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import {
  createCliApprovalPolicy,
  createCliApprovalResolver,
} from "../src/cli-approval.js";
import type { CliIO } from "../src/io.js";

describe("CLI approval resolver", () => {
  it("derives one approval policy from accessMode", () => {
    expect(createCliApprovalPolicy("ask")).toEqual({
      enforcement: "ask",
      scopes: [],
    });
    expect(createCliApprovalPolicy("accept-edits")).toEqual({
      enforcement: "auto",
      scopes: ["workspace_edits"],
    });
    expect(createCliApprovalPolicy("bypass")).toEqual({
      enforcement: "bypass",
      scopes: ["all"],
    });
  });

  it("accept-edits auto-approves only workspace writes", async () => {
    const resolver = createCliApprovalResolver({
      accessMode: "accept-edits",
      io: captureIo(),
    });

    await expect(
      resolver(request({ action: "workspace.write", summary: "Write README" })),
    ).resolves.toMatchObject({
      decision: "approved",
      message: "Auto-approved by accept-edits access mode.",
    });
    await expect(
      resolver(request({ action: "tool.execute", summary: "Run bash" })),
    ).resolves.toMatchObject({
      decision: "denied",
      message: "Non-interactive stdin.",
    });
  });

  it("ask prompts interactively and denies without an interactive stdin", async () => {
    const interactive = createCliApprovalResolver({
      accessMode: "ask",
      io: captureIo({ stdinIsTTY: true, question: async () => "yes" }),
    });
    await expect(
      interactive(request({ action: "tool.execute", summary: "Run bash" })),
    ).resolves.toMatchObject({ decision: "approved" });

    const nonInteractive = createCliApprovalResolver({
      accessMode: "ask",
      io: captureIo(),
    });
    await expect(
      nonInteractive(request({ action: "tool.execute", summary: "Run bash" })),
    ).resolves.toMatchObject({
      decision: "denied",
      message: "Non-interactive stdin.",
    });
  });

  it("bypass auto-approves approval requests", async () => {
    const resolver = createCliApprovalResolver({
      accessMode: "bypass",
      io: captureIo(),
    });
    await expect(
      resolver(
        request({ action: "tool.execute", summary: "Run external shell" }),
      ),
    ).resolves.toMatchObject({
      decision: "approved",
      message: "Auto-approved by bypass access mode.",
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
