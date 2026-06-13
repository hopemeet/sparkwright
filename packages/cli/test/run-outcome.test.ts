import { EventLog, createRunId } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import {
  cliExitCodeForRun,
  completedRunHasCliIssues,
  createCliRunEventSummary,
  summarizeUnsupportedFinalClaims,
  summarizeVerificationCommandFailures,
  summarizeVerificationProfileResults,
  updateCliRunEventSummary,
} from "../src/run-outcome.js";

describe("CLI run outcome", () => {
  it("fails the run when requested verification commands fail", () => {
    const summary = createCliRunEventSummary();
    const log = new EventLog(createRunId());
    for (const event of [
      log.emit("run.created", { goal: "Fix the CLI and verify by running it" }),
      log.emit("tool.requested", {
        id: "call_1",
        toolName: "shell",
        arguments: { command: "python3 -m greettool.cli --name Ada" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_1",
        toolName: "shell",
        status: "completed",
        output: { exitCode: 1, timedOut: false },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]) {
      updateCliRunEventSummary(summary, event);
    }

    expect(cliExitCodeForRun({ runState: "completed", events: summary })).toBe(
      1,
    );
    expect(summarizeVerificationCommandFailures(summary)).toContain(
      "failed verification",
    );
    expect(summarizeVerificationCommandFailures(summary)).toContain(
      "python3 -m greettool.cli --name Ada",
    );
  });

  it("does not fail the run for non-verification shell probes", () => {
    const summary = createCliRunEventSummary();
    const log = new EventLog(createRunId());
    for (const event of [
      log.emit("run.created", { goal: "Inspect the workspace" }),
      log.emit("tool.requested", {
        id: "call_1",
        toolName: "shell",
        arguments: { command: "grep missing README.md" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_1",
        toolName: "shell",
        status: "completed",
        output: { exitCode: 1, timedOut: false },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]) {
      updateCliRunEventSummary(summary, event);
    }

    expect(cliExitCodeForRun({ runState: "completed", events: summary })).toBe(
      0,
    );
    expect(summarizeVerificationCommandFailures(summary)).toBeUndefined();
  });

  it("summarizes configured verification profile results", () => {
    const summary = createCliRunEventSummary();
    const log = new EventLog(createRunId());
    for (const event of [
      log.emit("workflow_hook.completed", {
        hookName: "verification:fast:lint",
        result: {
          status: "continue",
          metadata: { exitCode: 0, timedOut: false },
        },
      }),
      log.emit("workflow_hook.completed", {
        hookName: "verification:fast:typecheck",
        result: {
          status: "continue",
          metadata: { exitCode: 2, timedOut: false },
        },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]) {
      updateCliRunEventSummary(summary, event);
    }

    expect(summarizeVerificationProfileResults(summary)).toBe(
      "Verification: 1 passed (lint); 1 failed (typecheck exitCode=2).",
    );
    expect(completedRunHasCliIssues(summary)).toBe(true);
    expect(cliExitCodeForRun({ runState: "completed", events: summary })).toBe(
      1,
    );
  });

  it("uses the latest configured verification result per command", () => {
    const summary = createCliRunEventSummary();
    const log = new EventLog(createRunId());
    for (const event of [
      log.emit("workflow_hook.completed", {
        hookName: "verification:fast:lint",
        result: {
          status: "continue",
          metadata: { exitCode: 1, timedOut: false },
        },
      }),
      log.emit("workflow_hook.completed", {
        hookName: "verification:fast:lint",
        result: {
          status: "continue",
          metadata: { exitCode: 0, timedOut: false },
        },
      }),
    ]) {
      updateCliRunEventSummary(summary, event);
    }

    expect(summarizeVerificationProfileResults(summary)).toBe(
      "Verification: 1 passed (lint).",
    );
    expect(completedRunHasCliIssues(summary)).toBe(false);
  });

  it("treats unsupported final-answer command success claims as advisory", () => {
    const summary = createCliRunEventSummary();
    const log = new EventLog(createRunId());
    for (const event of [
      log.emit("run.created", { goal: "Fix and verify" }),
      log.emit("tool.requested", {
        id: "call_1",
        toolName: "shell",
        arguments: { command: "npm run verify" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_1",
        toolName: "shell",
        status: "completed",
        output: { exitCode: 0, timedOut: false },
      }),
      log.emit("run.completed", {
        reason: "final_answer",
        outcome: {
          kind: "completed_with_unsupported_final_claims",
          failing: false,
          unsupportedFinalClaims: {
            count: 1,
            claims: [
              {
                kind: "command_success",
                command: "python -m unittest tests/test_config.py",
              },
            ],
          },
        },
      }),
    ]) {
      updateCliRunEventSummary(summary, event);
    }

    // The prose-based detector is unreliable, so it is advisory: surfaced in the
    // summary message but it does not fail the run.
    expect(summarizeUnsupportedFinalClaims(summary)).toContain(
      "python -m unittest tests/test_config.py",
    );
    expect(completedRunHasCliIssues(summary)).toBe(false);
    expect(cliExitCodeForRun({ runState: "completed", events: summary })).toBe(
      0,
    );
  });
});
