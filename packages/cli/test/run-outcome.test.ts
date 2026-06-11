import { EventLog, createRunId } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import {
  cliExitCodeForRun,
  createCliRunEventSummary,
  summarizeVerificationCommandFailures,
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
});
