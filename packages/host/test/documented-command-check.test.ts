import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDocumentedCommands,
  createDocumentedCommandRulePack,
  createDocumentedCommandStopHook,
  DOCUMENTED_COMMAND_RULE_ID,
  DOCUMENTED_COMMAND_RULE_NAME,
  evaluateDocumentedCommandRule,
} from "../src/documented-command-check.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("documented command check", () => {
  it("describes the built-in documented-command rule pack", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sparkwright-host-doc-cmd-"));
    tempDirs.push(workspace);

    const active = createDocumentedCommandRulePack({
      workspaceRoot: workspace,
      goal: "Prepare this repo for handoff and make documented commands pass",
      shouldWrite: true,
    });

    expect(active).toMatchObject({
      name: DOCUMENTED_COMMAND_RULE_NAME,
      id: DOCUMENTED_COMMAND_RULE_ID,
      source: "builtin",
      lifecycle: "Stop",
      blockingPotential: true,
      activation: {
        enabled: true,
        active: true,
        hasRunContext: true,
        reason:
          "write-enabled goal requests verification/handoff/documented-command validation",
      },
    });
    expect(active.hooks).toEqual([
      expect.objectContaining({
        id: DOCUMENTED_COMMAND_RULE_ID,
        name: DOCUMENTED_COMMAND_RULE_NAME,
        hook: "Stop",
      }),
    ]);

    const inactive = createDocumentedCommandRulePack({
      workspaceRoot: workspace,
      goal: "Answer a read-only question",
      shouldWrite: false,
    });
    expect(inactive).toMatchObject({
      activation: {
        enabled: true,
        active: false,
        hasRunContext: true,
        reason: "workspace writes are disabled",
      },
      hooks: [],
    });

    expect(evaluateDocumentedCommandRule({})).toMatchObject({
      enabled: true,
      active: false,
      hasRunContext: false,
      reason: "workspace writes are disabled",
    });
  });

  it("detects stale README command paths", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sparkwright-host-doc-cmd-"));
    tempDirs.push(workspace);
    writeFileSync(
      join(workspace, "README.md"),
      [
        "# Demo",
        "",
        "```bash",
        "cargo test --manifest-path rust-utils/Cargo.toml",
        "cd missing-app && npm test",
        "npm --prefix missing-package test",
        "python scripts/release.py",
        "```",
        "",
      ].join("\n"),
    );

    expect(
      checkDocumentedCommands(workspace).map((issue) => issue.message),
    ).toEqual([
      "cargo --manifest-path points to missing file: rust-utils/Cargo.toml",
      "cd target points to missing directory: missing-app",
      "package-manager --prefix points to missing directory: missing-package",
      "python script path points to missing file: scripts/release.py",
    ]);
  });

  it("provides a Stop hook that blocks finalization until stale commands are fixed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "sparkwright-host-doc-cmd-"));
    tempDirs.push(workspace);
    writeFileSync(
      join(workspace, "README.md"),
      [
        "# Demo",
        "",
        "```bash",
        "cargo test --manifest-path rust-utils/Cargo.toml",
        "```",
        "",
      ].join("\n"),
    );

    const [hook] = createDocumentedCommandStopHook({
      workspaceRoot: workspace,
      goal: "Prepare this repo for handoff and make documented commands pass",
      shouldWrite: true,
    });
    if (!hook) throw new Error("expected documented command hook");

    const result = await hook.handle({
      hook: "Stop",
      run: {
        id: "run_test" as never,
        goal: "Prepare this repo for handoff and make documented commands pass",
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      },
      payload: { message: "done" },
      metadata: {},
    });

    expect(result).toMatchObject({
      status: "block",
      findings: [
        {
          code: "STALE_DOCUMENTED_COMMAND",
          severity: "error",
          message:
            "README.md: cargo --manifest-path points to missing file: rust-utils/Cargo.toml",
        },
      ],
      metadata: {
        source: "builtin",
        ruleName: DOCUMENTED_COMMAND_RULE_NAME,
        activationReason:
          "write-enabled goal requests verification/handoff/documented-command validation",
        issueCount: 1,
      },
    });

    expect(
      await hook.handle({
        hook: "Stop",
        run: {
          id: "run_test" as never,
          goal: "Prepare this repo for handoff and make documented commands pass",
          state: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        },
        payload: { message: "done again" },
        metadata: {},
      }),
    ).toMatchObject({
      status: "continue",
      metadata: {
        source: "builtin",
        ruleName: DOCUMENTED_COMMAND_RULE_NAME,
        issueCount: 1,
        repeatedIssueSignature: true,
      },
    });

    mkdirSync(join(workspace, "rust-utils"), { recursive: true });
    writeFileSync(join(workspace, "rust-utils", "Cargo.toml"), "[package]\n");
    expect(
      await hook.handle({
        hook: "Stop",
        run: {
          id: "run_test" as never,
          goal: "Prepare this repo for handoff and make documented commands pass",
          state: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        },
        payload: { message: "done" },
        metadata: {},
      }),
    ).toMatchObject({
      status: "continue",
      metadata: {
        source: "builtin",
        ruleName: DOCUMENTED_COMMAND_RULE_NAME,
        issueCount: 0,
        issues: [],
      },
    });
  });
});
