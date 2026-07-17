import {
  completedRunOutcomeFromEvents,
  createRunId,
  type SparkwrightEvent,
} from "@sparkwright/core";
import { EventLog } from "@sparkwright/core/internal";
import { describe, expect, it } from "vitest";
import {
  cliExitCodeForRun,
  completedRunHasCliIssues,
  createCliRunEventSummary,
  summarizeDeniedWorkspaceWrites,
  summarizeUnsupportedFinalClaims,
  updateCliRunEventSummary,
} from "../src/run-outcome.js";

/**
 * Consistency probe (characterization only — changes no production behavior).
 *
 * "Did this run have a problem?" is decided independently in two places that
 * both consume the same event stream:
 *
 *   - CLI:  cliExitCodeForRun(...)            -> process exit code (0/1)
 *   - core: completedRunOutcomeFromEvents(...) -> run.completed `outcome` object
 *
 * This test feeds identical event arrays into both and records where they
 * agree and where they diverge. It locks in the *current* behavior so that any
 * future "single source of truth" refactor has a regression net, and so the
 * divergence points are documented in code rather than re-discovered by hand.
 */

function verdicts(
  events: SparkwrightEvent[],
  opts: { runState?: string; finalMessage?: string } = {},
): {
  cliExit: number;
  cliIssue: boolean;
  coreKind: string;
  coreIssue: boolean;
} {
  const summary = createCliRunEventSummary();
  for (const event of events) updateCliRunEventSummary(summary, event);
  const cliExit = cliExitCodeForRun({
    runState: opts.runState ?? "completed",
    events: summary,
  });
  const coreOutcome = completedRunOutcomeFromEvents(events, opts.finalMessage);
  return {
    cliExit,
    cliIssue: cliExit !== 0,
    coreKind: coreOutcome?.kind ?? "none",
    coreIssue: coreOutcome !== undefined,
  };
}

describe("run-outcome consistency (CLI exit vs core outcome)", () => {
  it("CONSISTENT: clean read-only run — both report no issue", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Inspect the workspace" }),
      log.emit("tool.requested", {
        id: "call_1",
        toolName: "read",
        arguments: { path: "README.md" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_1",
        toolName: "read",
        status: "completed",
        output: { path: "README.md", content: "# Demo\n" },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ];

    const v = verdicts(events);
    expect(v.cliIssue).toBe(false);
    expect(v.coreIssue).toBe(false);
    expect(v.coreKind).toBe("none");
  });

  it("CONSISTENT: failed verification command — both report an issue", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Fix the CLI and verify by running it" }),
      log.emit("tool.requested", {
        id: "call_1",
        toolName: "bash",
        arguments: { command: "python3 -m greettool.cli --name Ada" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_1",
        toolName: "bash",
        status: "completed",
        output: { exitCode: 1, timedOut: false },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ];

    const v = verdicts(events);
    expect(v.cliIssue).toBe(true);
    expect(v.coreIssue).toBe(true);
    expect(v.coreKind).toBe("completed_with_verification_failures");
  });

  it("CONSISTENT: approval-denied write — both treat it as expected (no issue)", () => {
    const runId = createRunId();
    const log = new EventLog(runId);
    const events = [
      log.emit("run.created", { goal: "Improve the README" }),
      log.emit("tool.requested", {
        id: "call_1",
        toolName: "edit_anchored_text",
        arguments: { path: "README.md", edits: [] },
      }),
      log.emit("approval.requested", {
        id: "approval_1",
        runId,
        action: "workspace.write",
        summary: "Edit README.md",
        details: { toolCallId: "call_1" },
        createdAt: "2026-07-16T00:00:00.000Z",
        status: "pending",
      }),
      log.emit("approval.resolved", {
        approvalId: "approval_1",
        decision: "denied",
      }),
      log.emit("tool.failed", {
        toolCallId: "call_1",
        toolName: "edit_anchored_text",
        status: "failed",
        error: { code: "TOOL_APPROVAL_DENIED", message: "approval denied" },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ];

    const v = verdicts(events);
    expect(v.cliIssue).toBe(false);
    expect(v.coreIssue).toBe(false);
    expect(v.coreKind).toBe("none");
  });

  // ---- Divergence points (the structural finding) ----

  it("CONSISTENT: verification-profile hook failure — both report an issue (superset fix)", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("workflow_hook.completed", {
        hookName: "workflow:verification_fast",
        result: {
          status: "continue",
          metadata: {
            verificationSource: "profile",
            profile: "fast",
            verifierId: "typecheck",
            expect: "zero",
            exitCode: 2,
            timedOut: false,
          },
        },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ];

    const v = verdicts(events);
    // CLI fails the run on the profile-hook exit code...
    expect(v.cliIssue).toBe(true);
    // ...and core's outcome now inspects workflow_hook events too, so a consumer
    // reading run.completed.outcome sees the same issue. Previously core was
    // blind here (outcome.kind === "none"), which is what made "exit code reads
    // outcome.kind" unsafe; core is now a superset.
    expect(v.coreIssue).toBe(true);
    expect(v.coreKind).toBe("completed_with_verification_failures");
    expect(v.cliIssue).toBe(v.coreIssue);
  });

  it("DIVERGENT: recovered not-found read — core annotates an issue, CLI exits 0", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Report VALUE from the config file" }),
      log.emit("tool.requested", {
        id: "call_miss",
        toolName: "read",
        arguments: { path: "config.conf" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_miss",
        toolName: "read",
        status: "failed",
        error: { code: "ENOENT", message: "ENOENT: no such file" },
      }),
      log.emit("tool.requested", {
        id: "call_read",
        toolName: "read",
        arguments: { path: "settings.conf" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_read",
        toolName: "read",
        status: "completed",
        output: { path: "settings.conf", content: "VALUE=42\n" },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ];

    const v = verdicts(events);
    // CLI correctly does not fail the run (the failure was recovered)...
    expect(v.cliIssue).toBe(false);
    // ...but core still emits a non-undefined outcome to *annotate* the
    // recovered hiccup. Same events, different notion of "issue".
    expect(v.coreIssue).toBe(true);
    expect(v.coreKind).toBe("completed_with_recovered_tool_failures");
    expect(v.cliIssue).not.toBe(v.coreIssue);
  });

  // ---- Step 3: exit code is a projection of the single attached outcome ----

  it("exit code reads the failing flag core attached to run.completed", () => {
    // No underlying failure events — only the outcome core stamped on the
    // event. The exit code must come from that single source's `failing` flag.
    const failing = new EventLog(createRunId());
    const failingSummary = createCliRunEventSummary();
    for (const event of [
      failing.emit("run.created", { goal: "Verify" }),
      failing.emit("run.completed", {
        reason: "final_answer",
        outcome: {
          kind: "completed_with_verification_failures",
          failing: true,
        },
      }),
    ]) {
      updateCliRunEventSummary(failingSummary, event);
    }
    expect(
      cliExitCodeForRun({ runState: "completed", events: failingSummary }),
    ).toBe(1);

    // A non-failing outcome (recovered tool failure / unsupported claim) is
    // annotated but must not fail the run, even read straight off the outcome.
    const recovered = new EventLog(createRunId());
    const recoveredSummary = createCliRunEventSummary();
    for (const event of [
      recovered.emit("run.created", { goal: "Verify" }),
      recovered.emit("run.completed", {
        reason: "final_answer",
        outcome: {
          kind: "completed_with_recovered_tool_failures",
          failing: false,
        },
      }),
    ]) {
      updateCliRunEventSummary(recoveredSummary, event);
    }
    expect(
      cliExitCodeForRun({ runState: "completed", events: recoveredSummary }),
    ).toBe(0);
  });

  it("treats a denied workspace write as advisory — label matches exit (0)", () => {
    const log = new EventLog(createRunId());
    const summary = createCliRunEventSummary();
    for (const event of [
      log.emit("run.created", { goal: "Improve the README" }),
      log.emit("workspace.write.denied", {
        proposalId: "p1",
        path: "README.md",
        reason: "blocked by validation hook",
      }),
      log.emit("tool.failed", {
        toolCallId: "call_1",
        toolName: "edit_anchored_text",
        status: "failed",
        error: { code: "WORKSPACE_WRITE_DENIED", message: "write denied" },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]) {
      updateCliRunEventSummary(summary, event);
    }
    // The denial is surfaced separately...
    expect(summarizeDeniedWorkspaceWrites(summary)).toContain("denied");
    // ...but it does not make the run an issue, and the label now agrees with
    // the exit code (both treat it as a non-failing, expected outcome).
    expect(completedRunHasCliIssues(summary)).toBe(false);
    expect(cliExitCodeForRun({ runState: "completed", events: summary })).toBe(
      0,
    );
  });

  it("treats unsupported final-answer claims as advisory (non-failing)", () => {
    const log = new EventLog(createRunId());
    const summary = createCliRunEventSummary();
    for (const event of [
      log.emit("run.created", { goal: "Fix and verify" }),
      log.emit("run.completed", {
        reason: "final_answer",
        outcome: {
          kind: "completed_with_unsupported_final_claims",
          failing: false,
          unsupportedFinalClaims: {
            count: 1,
            claims: [{ kind: "command_success", command: "npm run verify" }],
          },
        },
      }),
    ]) {
      updateCliRunEventSummary(summary, event);
    }
    // Advisory: surfaced in the summary message, but does not fail the run.
    expect(summarizeUnsupportedFinalClaims(summary)).toContain(
      "npm run verify",
    );
    expect(completedRunHasCliIssues(summary)).toBe(false);
    expect(cliExitCodeForRun({ runState: "completed", events: summary })).toBe(
      0,
    );
  });
});
