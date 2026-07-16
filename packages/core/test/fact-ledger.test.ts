import { describe, expect, it } from "vitest";
import {
  EventLog,
  FactLedger,
  createRunId,
  factLedgerSnapshotFromUnknown,
  verificationProfileResultsFromFactLedger,
} from "../src/index.js";

describe("FactLedger", () => {
  it("records shell command facts and marks old epochs stale after writes", () => {
    const log = new EventLog(createRunId());
    const ledger = new FactLedger();
    log.subscribe((event) => ledger.observeEvent(event));

    expect(ledger.markEpoch()).toEqual({ writeEpoch: 0 });
    log.emit("run.created", { goal: "Run verification" });
    log.emit("tool.requested", {
      id: "call_fail",
      toolName: "bash",
      arguments: { command: "npm test" },
    });
    log.emit("tool.completed", {
      toolCallId: "call_fail",
      toolName: "bash",
      output: { exitCode: 1, timedOut: false },
    });

    expect(ledger.snapshot().commands[0]).toMatchObject({
      initiator: "model-initiated",
      source: "shell_tool",
      command: "npm test",
      exitCode: 1,
      stale: false,
      verificationRelevant: true,
      writeEpoch: 0,
    });

    log.emit("workspace.write.completed", { path: "src/app.ts" });
    expect(ledger.currentEpoch()).toBe(1);
    expect(ledger.snapshot().commands[0]?.stale).toBe(true);

    log.emit("tool.requested", {
      id: "call_pass",
      toolName: "bash",
      arguments: { command: "npm test" },
    });
    log.emit("tool.completed", {
      toolCallId: "call_pass",
      toolName: "bash",
      output: { exitCode: 0, timedOut: false },
    });

    const snapshot = ledger.snapshot();
    expect(snapshot.commands[1]).toMatchObject({
      exitCode: 0,
      stale: false,
      writeEpoch: 1,
    });
  });

  it("treats untracked write-capable boundaries as epoch bumps", () => {
    const log = new EventLog(createRunId());
    const ledger = new FactLedger();
    log.subscribe((event) => ledger.observeEvent(event));

    log.emit("tool.requested", {
      id: "call_verify",
      toolName: "bash",
      arguments: { command: "npm test" },
    });
    log.emit("tool.completed", {
      toolCallId: "call_verify",
      toolName: "bash",
      output: { exitCode: 0, timedOut: false },
    });
    log.emit("workspace.write.untracked_access_granted", {
      protocol: "promoted_shell",
      marker: "untracked-write-capable",
      access: "granted",
    });

    const snapshot = ledger.snapshot();
    expect(snapshot.writeEpoch).toBe(1);
    expect(snapshot.commands[0]).toMatchObject({
      stale: true,
      writeEpoch: 0,
    });
    expect(snapshot.writes[0]).toMatchObject({
      sequence: expect.any(Number),
      writeEpoch: 1,
    });
  });

  it("records verifier-launched hook facts with expectation satisfaction", () => {
    const log = new EventLog(createRunId());
    const ledger = new FactLedger();
    log.subscribe((event) => ledger.observeEvent(event));

    log.emit("workflow_hook.completed", {
      hookName: "workflow:verification_fast",
      hook: "PostToolUse",
      result: {
        status: "continue",
        metadata: {
          verificationSource: "profile",
          profile: "fast",
          verifierId: "repro",
          command: "npm",
          args: ["test"],
          exitCode: 1,
          timedOut: false,
          nodeId: "reproduce",
          expect: "nonzero",
        },
      },
    });

    const snapshot = ledger.snapshot();
    expect(snapshot.commands[0]).toMatchObject({
      initiator: "verifier-launched",
      source: "workflow_hook",
      hookName: "workflow:verification_fast",
      nodeId: "reproduce",
      command: "npm",
      args: ["test"],
      exitCode: 1,
      timedOut: false,
    });
    expect(snapshot.verificationResults[0]).toMatchObject({
      hookName: "workflow:verification_fast",
      verificationSource: "profile",
      profile: "fast",
      nodeId: "reproduce",
      verifierId: "repro",
      expect: "nonzero",
      satisfied: true,
      exitCode: 1,
    });
    expect(verificationProfileResultsFromFactLedger(snapshot)).toEqual([
      {
        hookName: "workflow:verification_fast",
        profile: "fast",
        id: "repro",
        status: "passed",
        exitCode: 1,
        timedOut: false,
      },
    ]);
  });

  it("keeps expectations out of raw command facts", () => {
    const log = new EventLog(createRunId());
    const ledger = new FactLedger();
    log.subscribe((event) => ledger.observeEvent(event));

    log.emit("workspace.write.completed", { path: "src/app.ts" });
    log.emit("workflow_hook.completed", {
      hookName: "workflow:verification_fast",
      hook: "PostToolUse",
      result: {
        status: "continue",
        metadata: {
          verificationSource: "profile",
          profile: "fast",
          verifierId: "lint",
          expect: "zero",
          command: "npm",
          args: ["run", "lint"],
          exitCode: 1,
          timedOut: false,
        },
      },
    });

    const snapshot = ledger.snapshot();
    expect(snapshot.commands[0]).toMatchObject({
      initiator: "verifier-launched",
      source: "workflow_hook",
      stale: false,
      writeEpoch: 1,
      exitCode: 1,
    });
    expect(snapshot.commands[0]).not.toHaveProperty("expect");
    expect(snapshot.verificationResults[0]).toMatchObject({
      verifierId: "lint",
      expect: "zero",
      satisfied: false,
      stale: false,
      writeEpoch: 1,
      exitCode: 1,
    });
  });

  it("records forced-continuation budget exhaustion facts", () => {
    const log = new EventLog(createRunId());
    const ledger = new FactLedger();
    log.subscribe((event) => ledger.observeEvent(event));

    log.emit("workspace.write.completed", { path: "src/app.ts" });
    log.emit("run.budget.exceeded", {
      signal: "budget.exceeded",
      family: "forced_continuation",
      source: "revival",
      used: 0,
      limit: 0,
      step: 1,
      reason: "waiting_tasks",
    });

    expect(ledger.snapshot().budgetExceeded).toEqual([
      expect.objectContaining({
        source: "revival",
        used: 0,
        limit: 0,
        step: 1,
        reason: "waiting_tasks",
        writeEpoch: 1,
      }),
    ]);
  });

  it("defaults missing budget exhaustion facts to an empty list when parsing persisted ledgers", () => {
    const snapshot = factLedgerSnapshotFromUnknown({
      schemaVersion: "fact-ledger.v1",
      writeEpoch: 0,
      commands: [],
      verificationResults: [],
      writes: [],
    });

    expect(snapshot?.budgetExceeded).toEqual([]);
  });
});
