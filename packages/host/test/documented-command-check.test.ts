import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunId,
  EventLog,
  FactLedger,
  runWorkflowHooks,
} from "@sparkwright/core";
import {
  checkDocumentedCommands,
  createDocumentedCommandRulePack,
  createDocumentedCommandWorkflowHooks,
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
      blockingPotential: false,
      activation: {
        enabled: true,
        active: true,
        hasRunContext: true,
        reason:
          "write-enabled goal requests verification/handoff/documented-command validation",
      },
    });
    expect(active.hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "invariant-command-verifier",
          name: "workflow:documented_command",
          hook: "Stop",
        }),
      ]),
    );

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

  it("skips documented-command verification when the run has no writes", async () => {
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

    const hooks = createDocumentedCommandWorkflowHooks({
      workspaceRoot: workspace,
      goal: "Prepare this repo for handoff and make documented commands pass",
      shouldWrite: true,
    });
    const run = runRecord(
      "Prepare this repo for handoff and make documented commands pass",
    );
    const events = new EventLog(run.id);
    const facts = new FactLedger();
    events.subscribe((event) => facts.observeEvent(event));

    const result = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: { message: "done" },
      events,
      facts,
    });

    expect(result.status).toBe("continued");
    expect(facts.snapshot().verificationResults).toHaveLength(0);
    expect(facts.snapshot().commands).toHaveLength(0);
  });

  it("compiles documented-command as an invariant verifier", async () => {
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

    const hooks = createDocumentedCommandWorkflowHooks({
      workspaceRoot: workspace,
      goal: "Prepare this repo for handoff and make documented commands pass",
      shouldWrite: true,
    });
    const run = runRecord(
      "Prepare this repo for handoff and make documented commands pass",
    );
    const events = new EventLog(run.id);
    const facts = new FactLedger();
    events.subscribe((event) => facts.observeEvent(event));
    events.emit("workspace.write.completed", { path: "README.md" });

    const result = await runWorkflowHooks({
      hooks,
      hook: "Stop",
      run,
      payload: { message: "done" },
      events,
      facts,
    });

    expect(result.status).toBe("advanced");
    expect(result.context[0]?.content).toContain(DOCUMENTED_COMMAND_RULE_NAME);
    expect(facts.snapshot().verificationResults[0]).toMatchObject({
      verificationSource: "documented_command",
      verifierId: DOCUMENTED_COMMAND_RULE_NAME,
      satisfied: false,
      exitCode: 1,
    });
    expect(facts.snapshot().commands[0]?.verificationSource).toBe(
      "documented_command",
    );
    expect(events.all().some((event) => event.type === "workflow.failed")).toBe(
      false,
    );
    expect(facts.snapshot().commands[0]?.command).toBe(
      DOCUMENTED_COMMAND_RULE_NAME,
    );

    const metadata = facts.snapshot().commands[0];
    expect(metadata).toMatchObject({
      exitCode: 1,
    });

    const failedHook = events
      .all()
      .find((event) => event.type === "workflow_hook.completed");
    expect(failedHook?.payload).toMatchObject({
      hookName: "workflow:documented_command",
      result: {
        metadata: {
          source: "builtin",
          ruleName: DOCUMENTED_COMMAND_RULE_NAME,
          activationReason:
            "write-enabled goal requests verification/handoff/documented-command validation",
          issueCount: 1,
        },
      },
    });

    mkdirSync(join(workspace, "rust-utils"), { recursive: true });
    writeFileSync(join(workspace, "rust-utils", "Cargo.toml"), "[package]\n");
    const passingHooks = createDocumentedCommandWorkflowHooks({
      workspaceRoot: workspace,
      goal: "Prepare this repo for handoff and make documented commands pass",
      shouldWrite: true,
    });
    const passingRun = runRecord(
      "Prepare this repo for handoff and make documented commands pass",
    );
    const passingEvents = new EventLog(passingRun.id);
    const passingFacts = new FactLedger();
    passingEvents.subscribe((event) => passingFacts.observeEvent(event));
    passingEvents.emit("workspace.write.completed", { path: "README.md" });
    expect(
      await runWorkflowHooks({
        hooks: passingHooks,
        hook: "Stop",
        run: passingRun,
        payload: { message: "done" },
        events: passingEvents,
        facts: passingFacts,
      }),
    ).toMatchObject({
      status: "continued",
    });
    expect(passingFacts.snapshot().verificationResults[0]).toMatchObject({
      verificationSource: "documented_command",
      satisfied: true,
      exitCode: 0,
    });
    await runWorkflowHooks({
      hooks: passingHooks,
      hook: "RunEnd",
      run: passingRun,
      payload: { state: "completed" },
      events: passingEvents,
      facts: passingFacts,
    });
    expect(
      passingEvents.all().some((event) => event.type === "workflow.completed"),
    ).toBe(true);
  });
});

function runRecord(goal: string) {
  const now = new Date().toISOString();
  return {
    id: createRunId(),
    goal,
    state: "running" as const,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
}
