import { EventLog, createRunId } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import {
  cliExitCodeForRun,
  completedRunHasCliIssues,
  createCliRunEventSummary,
  summarizeSkillLoadFailures,
  summarizeUnsupportedFinalClaims,
  summarizeVerificationCommandFailures,
  summarizeVerificationProfileResults,
  summarizeWorkspaceMutations,
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

  it("summarizes tool-reported capability changes separately from workspace writes", () => {
    const summary = createCliRunEventSummary();
    const log = new EventLog(createRunId());
    updateCliRunEventSummary(
      summary,
      log.emit("tool.completed", {
        toolCallId: "call_1",
        toolName: "update_skill",
        status: "completed",
        output: { changed: true, proposalId: "skillprop_1" },
      }),
    );

    expect(summary.toolReportedChanges).toBe(1);
    expect(
      summarizeWorkspaceMutations({
        shouldWrite: true,
        completed: summary.writeCompleted,
        skipped: summary.writeSkipped,
        denied: summary.writeDenied,
        toolReportedChanges: summary.toolReportedChanges,
      }),
    ).toBe(
      "Capability changes: 1 tool-reported; no workspace write was applied.",
    );
  });

  it("summarizes capability mutation events before tool-output fallback", () => {
    const summary = createCliRunEventSummary();
    const log = new EventLog(createRunId());
    for (const event of [
      log.emit("capability.mutation.completed", {
        action: "replace_skill_package",
        path: ".sparkwright/skill-evolution/proposals/skillprop_1",
        fileCount: 2,
      }),
      log.emit("tool.completed", {
        toolCallId: "call_1",
        toolName: "update_skill",
        status: "completed",
        output: { changed: true, proposalId: "skillprop_1" },
      }),
    ]) {
      updateCliRunEventSummary(summary, event);
    }

    expect(summary.capabilityMutationCompleted).toBe(1);
    expect(
      summarizeWorkspaceMutations({
        shouldWrite: true,
        completed: summary.writeCompleted,
        skipped: summary.writeSkipped,
        denied: summary.writeDenied,
        capabilityMutations: summary.capabilityMutationCompleted,
        toolReportedChanges: summary.toolReportedChanges,
      }),
    ).toBe(
      "Capability mutations: 1 completed; no workspace write was applied.",
    );
  });

  it("adds static disclosure for MCP servers configured with workspace cwd", () => {
    const summary = createCliRunEventSummary();
    const log = new EventLog(createRunId());
    updateCliRunEventSummary(
      summary,
      log.emit("run.started", {
        mcpWorkspaceCwdServers: ["workspace"],
      }),
    );

    expect(summary.mcpWorkspaceCwdServers).toEqual(["workspace"]);
    expect(
      summarizeWorkspaceMutations({
        shouldWrite: false,
        completed: summary.writeCompleted,
        skipped: summary.writeSkipped,
        denied: summary.writeDenied,
        mcpWorkspaceCwdServers: summary.mcpWorkspaceCwdServers,
      }),
    ).toBe(
      "No workspace changes were made (read-only run). MCP servers configured with workspace cwd (workspace) are not counted as managed workspace writes.",
    );
  });

  it("summarizes sub-agent workspace writes rolled up from a child run", () => {
    const summary = createCliRunEventSummary();
    const log = new EventLog(createRunId());
    updateCliRunEventSummary(
      summary,
      log.emit("subagent.completed", {
        childRunId: "child",
        parentRunId: "parent",
        spanId: "span",
        goal: "write README",
        stopReason: "final_answer",
        workspaceWrites: 2,
      }),
    );

    expect(summary.subagentWriteCompleted).toBe(2);
    expect(
      summarizeWorkspaceMutations({
        shouldWrite: true,
        completed: summary.writeCompleted,
        skipped: summary.writeSkipped,
        denied: summary.writeDenied,
        subagentWrites: summary.subagentWriteCompleted,
      }),
    ).toBe("Workspace changes applied by sub-agent(s): 2 writes.");
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

  it("surfaces skill load failures without failing the run", () => {
    const summary = createCliRunEventSummary();
    const log = new EventLog(createRunId());
    for (const event of [
      log.emit("run.created", { goal: "Help me get release-ready" }),
      log.emit("skill.failed", {
        source: "/ws/.sparkwright/skills/release-readiness/SKILL.md",
        message:
          "Unsupported skill frontmatter line:   - release in /ws/.sparkwright/skills/release-readiness/SKILL.md",
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ]) {
      updateCliRunEventSummary(summary, event);
    }

    const message = summarizeSkillLoadFailures(summary);
    expect(message).toContain("1 skill load/preparation failure");
    expect(message).toContain("release-readiness");
    expect(message).toContain("Unsupported skill frontmatter line");
    expect(message).toContain("<skill path>");
    expect(message).not.toContain("/ws/");
    // A malformed skill is an authoring warning, not a run failure.
    expect(completedRunHasCliIssues(summary)).toBe(false);
    expect(cliExitCodeForRun({ runState: "completed", events: summary })).toBe(
      0,
    );
  });

  it("summarizes inline shell failures without leaking stderr payloads", () => {
    const summary = createCliRunEventSummary();
    const log = new EventLog(createRunId());
    updateCliRunEventSummary(
      summary,
      log.emit("skill.failed", {
        name: "probe",
        source: "/tmp/work/skills/probe/SKILL.md",
        status: "inline_shell_failed",
        errorCode: "PROCESS_FAILED",
        exitCode: 1,
        message:
          "Error: EPERM: operation not permitted, open '/tmp/work/secret-marker.txt'\n    at Object.writeFileSync",
      }),
    );

    const message = summarizeSkillLoadFailures(summary);
    expect(message).toContain("probe inline shell failed PROCESS_FAILED");
    expect(message).toContain("exitCode=1");
    expect(message).not.toContain("secret-marker");
    expect(message).not.toContain("writeFileSync");
  });

  it("returns no skill-failure summary for a clean run", () => {
    const summary = createCliRunEventSummary();
    const log = new EventLog(createRunId());
    updateCliRunEventSummary(
      summary,
      log.emit("run.completed", { reason: "final_answer" }),
    );
    expect(summarizeSkillLoadFailures(summary)).toBeUndefined();
  });
});
