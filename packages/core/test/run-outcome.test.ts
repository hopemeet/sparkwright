import {
  EventLog,
  analyzeCommandOutcomes,
  analyzeToolOutcomes,
  analyzeVerificationProfileResults,
  commandOutcomeSnapshot,
  completedRunOutcomeFromEvents,
  createRunId,
  toolOutcomeSnapshot,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("run outcome evidence", () => {
  it("uses shell EXIT markers as the effective command status", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Run verification" }),
      log.emit("tool.requested", {
        id: "call_test",
        toolName: "shell",
        arguments: {
          command:
            'cd /tmp/ws && python -m unittest tests/test_config.py 2>&1; echo "EXIT:$?"',
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_test",
        toolName: "shell",
        status: "completed",
        output: {
          exitCode: 0,
          timedOut: false,
          stdout: "python: command not found\nEXIT:127\n",
          stderr: "",
        },
      }),
    ];

    const summary = analyzeCommandOutcomes(events);

    expect(summary.unresolvedVerificationFailures).toMatchObject([
      {
        command:
          'cd /tmp/ws && python -m unittest tests/test_config.py 2>&1; echo "EXIT:$?"',
        commandKey: "python -m unittest tests/test_config.py",
        exitCode: 127,
      },
    ]);
  });

  it("does not resolve a failed verification command with a different successful command", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Run verification" }),
      log.emit("tool.requested", {
        id: "call_fail",
        toolName: "shell",
        arguments: {
          command:
            'cd /tmp/ws && python3 -m unittest tests/test_config.py 2>&1; echo "EXIT:$?"',
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_fail",
        toolName: "shell",
        status: "completed",
        output: {
          exitCode: 0,
          timedOut: false,
          stdout: "ModuleNotFoundError: No module named 'app'\nEXIT:1\n",
          stderr: "",
        },
      }),
      log.emit("tool.requested", {
        id: "call_pass",
        toolName: "shell",
        arguments: {
          command:
            'cd /tmp/ws && PYTHONPATH=src python3 -m unittest tests/test_config.py 2>&1; echo "EXIT:$?"',
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_pass",
        toolName: "shell",
        status: "completed",
        output: {
          exitCode: 0,
          timedOut: false,
          stdout: "OK\nEXIT:0\n",
          stderr: "",
        },
      }),
    ];

    const summary = analyzeCommandOutcomes(events);

    expect(summary.successes.map((success) => success.commandKey)).toContain(
      "PYTHONPATH=src python3 -m unittest tests/test_config.py",
    );
    expect(summary.unresolvedVerificationFailures).toMatchObject([
      {
        commandKey: "python3 -m unittest tests/test_config.py",
        exitCode: 1,
      },
    ]);
  });

  it("does not classify node -e probes as verification failures", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Fix and verify with npm test" }),
      log.emit("tool.requested", {
        id: "call_probe",
        toolName: "shell",
        arguments: {
          command:
            'node -e "console.error(\\"probe failed\\"); process.exit(7)"',
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_probe",
        toolName: "shell",
        status: "completed",
        output: {
          exitCode: 7,
          timedOut: false,
          stdout: "",
          stderr: "probe failed\n",
        },
      }),
      log.emit("tool.requested", {
        id: "call_fail",
        toolName: "shell",
        arguments: { command: "npm test" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_fail",
        toolName: "shell",
        status: "completed",
        output: { exitCode: 1, timedOut: false, stdout: "", stderr: "fail" },
      }),
      log.emit("tool.requested", {
        id: "call_pass",
        toolName: "shell",
        arguments: { command: "npm test" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_pass",
        toolName: "shell",
        status: "completed",
        output: { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" },
      }),
    ];

    const summary = analyzeCommandOutcomes(events);

    expect(summary.failures).toHaveLength(2);
    expect(
      summary.verificationFailures.map((failure) => failure.command),
    ).toEqual(["npm test"]);
    expect(summary.unresolvedVerificationFailures).toEqual([]);
  });

  it("treats a not-found read probe as recovered when a different file is read next", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Report VALUE from the config file" }),
      log.emit("tool.requested", {
        id: "call_miss",
        toolName: "read_file",
        arguments: { path: "config.conf" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_miss",
        toolName: "read_file",
        status: "failed",
        error: { code: "ENOENT", message: "ENOENT: no such file" },
      }),
      log.emit("tool.requested", {
        id: "call_glob",
        toolName: "glob",
        arguments: { pattern: "*.conf" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_glob",
        toolName: "glob",
        status: "completed",
        output: { matches: ["settings.conf"] },
      }),
      log.emit("tool.requested", {
        id: "call_read",
        toolName: "read_file",
        arguments: { path: "settings.conf" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_read",
        toolName: "read_file",
        status: "completed",
        output: { path: "settings.conf", content: "VALUE=42\n" },
      }),
    ];

    const summary = analyzeToolOutcomes(events);

    expect(summary.unresolvedFailures).toEqual([]);
    expect(summary.recoveredFailures.map((failure) => failure.code)).toEqual([
      "ENOENT",
    ]);
  });

  it("treats empty task monitor placeholders as recovered after concrete task monitoring succeeds", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Monitor a background task" }),
      log.emit("tool.requested", {
        id: "call_create",
        toolName: "task_create",
        arguments: { kind: "agent", mode: "awaited" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_create",
        toolName: "task_create",
        status: "completed",
        output: {
          taskId: "task_123",
          mode: "awaited",
          awaited: true,
        },
      }),
      log.emit("tool.requested", {
        id: "call_wait_empty",
        toolName: "task",
        arguments: {
          action: "wait",
          taskId: "",
          ids: [],
          mode: "all",
        },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_wait_empty",
        toolName: "task",
        status: "failed",
        error: {
          code: "TASK_ARGUMENTS_INVALID",
          message: "task wait requires at least one task id.",
        },
      }),
      log.emit("tool.requested", {
        id: "call_output_empty",
        toolName: "task",
        arguments: {
          action: "output",
          taskId: "",
        },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_output_empty",
        toolName: "task",
        status: "failed",
        error: {
          code: "TASK_ARGUMENTS_INVALID",
          message: "taskId must be a non-empty string.",
        },
      }),
      log.emit("tool.requested", {
        id: "call_wait_ok",
        toolName: "task",
        arguments: {
          action: "wait",
          taskId: "task_123",
          ids: ["task_123"],
          mode: "all",
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_wait_ok",
        toolName: "task",
        status: "completed",
        output: {
          mode: "all",
          complete: true,
          taskIds: ["task_123"],
          terminalTaskIds: ["task_123"],
          tasks: [{ id: "task_123", status: "completed" }],
        },
      }),
      log.emit("tool.requested", {
        id: "call_output_ok",
        toolName: "task",
        arguments: {
          action: "output",
          taskId: "task_123",
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_output_ok",
        toolName: "task",
        status: "completed",
        output: {
          chunks: [],
          complete: true,
          status: "completed",
        },
      }),
    ];

    const summary = analyzeToolOutcomes(events);

    expect(summary.unresolvedFailures).toEqual([]);
    expect(summary.recoveredFailures.map((failure) => failure.code)).toEqual([
      "TASK_ARGUMENTS_INVALID",
      "TASK_ARGUMENTS_INVALID",
    ]);
    expect(completedRunOutcomeFromEvents(events)).toMatchObject({
      kind: "completed_with_recovered_tool_failures",
      failing: false,
      toolFailures: {
        count: 2,
        codes: ["TASK_ARGUMENTS_INVALID"],
      },
    });
    expect(toolOutcomeSnapshot(events)).toEqual({
      unresolved: { total: 0, byCode: {} },
      recovered: { total: 2, byCode: { TASK_ARGUMENTS_INVALID: 2 } },
    });
  });

  it("treats repeated expected denials as expected denials", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Try denied shell twice" }),
      log.emit("tool.requested", {
        id: "call_denied",
        toolName: "bash",
        arguments: { command: "pwd && node -v" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_denied",
        toolName: "bash",
        status: "failed",
        error: {
          code: "TOOL_DENIED",
          message:
            "Tools with write side effects require an explicit write-enabled run.",
        },
      }),
      log.emit("tool.requested", {
        id: "call_repeated",
        toolName: "bash",
        arguments: { command: "pwd && node -v" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_repeated",
        toolName: "bash",
        status: "failed",
        error: {
          code: "REPEATED_TOOL_CALL_SKIPPED",
          message: "Skipped repeated denied action.",
        },
      }),
    ];

    const summary = analyzeToolOutcomes(events);

    expect(summary.unresolvedFailures).toEqual([]);
    expect(summary.recoveredFailures).toEqual([]);
    expect(summary.policyDenials.map((failure) => failure.code)).toEqual([
      "TOOL_DENIED",
      "REPEATED_TOOL_CALL_SKIPPED",
    ]);
    expect(completedRunOutcomeFromEvents(events)).toBeUndefined();
    expect(toolOutcomeSnapshot(events)).toBeUndefined();
  });

  it("does not recover empty task placeholders without later concrete task success", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Monitor a background task" }),
      log.emit("tool.requested", {
        id: "call_wait_empty",
        toolName: "task",
        arguments: {
          action: "wait",
          taskId: "",
          ids: [],
          mode: "all",
        },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_wait_empty",
        toolName: "task",
        status: "failed",
        error: {
          code: "TASK_ARGUMENTS_INVALID",
          message: "task wait requires at least one task id.",
        },
      }),
      log.emit("tool.requested", {
        id: "call_list_ok",
        toolName: "task",
        arguments: { action: "list" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_list_ok",
        toolName: "task",
        status: "completed",
        output: { tasks: [{ id: "task_123", status: "completed" }] },
      }),
    ];

    const summary = analyzeToolOutcomes(events);

    expect(summary.recoveredFailures).toEqual([]);
    expect(summary.unresolvedFailures.map((failure) => failure.code)).toEqual([
      "TASK_ARGUMENTS_INVALID",
    ]);
  });

  it("does not treat a workspace path-escape failure as recovered", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Append to the target" }),
      log.emit("tool.requested", {
        id: "call_escape",
        toolName: "read_file",
        arguments: { path: "link.txt" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_escape",
        toolName: "read_file",
        status: "failed",
        error: {
          code: "WORKSPACE_PATH_ESCAPED",
          message: "Path escapes workspace root: link.txt",
        },
      }),
      // A later successful read of a different file must NOT launder the escape.
      log.emit("tool.requested", {
        id: "call_ok",
        toolName: "read_file",
        arguments: { path: "README.md" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_ok",
        toolName: "read_file",
        status: "completed",
        output: { path: "README.md", content: "# Demo\n" },
      }),
    ];

    const summary = analyzeToolOutcomes(events);

    expect(summary.recoveredFailures).toEqual([]);
    expect(summary.unresolvedFailures.map((failure) => failure.code)).toEqual([
      "WORKSPACE_PATH_ESCAPED",
    ]);
  });

  it("annotates unsupported final-answer command success claims", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Fix and verify" }),
      log.emit("tool.requested", {
        id: "call_verify",
        toolName: "shell",
        arguments: { command: "npm run verify" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_verify",
        toolName: "shell",
        status: "completed",
        output: { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" },
      }),
    ];

    const outcome = completedRunOutcomeFromEvents(
      events,
      "| Command | Result |\n| `npm run verify` | ✅ Exit 0 |\n| `python -m unittest tests/test_config.py` | ✅ 2 tests passed |",
    );

    expect(outcome).toMatchObject({
      kind: "completed_with_unsupported_final_claims",
      unsupportedFinalClaims: {
        count: 1,
        claims: [
          {
            kind: "command_success",
            command: "python -m unittest tests/test_config.py",
          },
        ],
      },
    });
  });

  it("annotates unsupported unquoted verification command success claims", () => {
    const log = new EventLog(createRunId());
    const events = [log.emit("run.created", { goal: "Fix and verify" })];

    const outcome = completedRunOutcomeFromEvents(
      events,
      "python -m unittest tests/test_config.py passed.",
    );

    expect(outcome).toMatchObject({
      kind: "completed_with_unsupported_final_claims",
      unsupportedFinalClaims: {
        count: 1,
        claims: [
          {
            kind: "command_success",
            command: "python -m unittest tests/test_config.py",
          },
        ],
      },
    });
  });

  it("does not treat backticked successful output as a command success claim", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Fix and run tests" }),
      log.emit("tool.requested", {
        id: "call_test",
        toolName: "shell",
        arguments: { command: "npm test" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_test",
        toolName: "shell",
        status: "completed",
        output: {
          exitCode: 0,
          timedOut: false,
          stdout: "tests passed\n",
          stderr: "",
        },
      }),
    ];

    const outcome = completedRunOutcomeFromEvents(
      events,
      "`npm test` passed (`tests passed`).",
    );

    expect(outcome?.unsupportedFinalClaims).toBeUndefined();
  });

  it("marks a recovered + unsupported-claim run as non-failing despite the issues kind", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Fix and verify" }),
      // A tool failure that is recovered on the same target (not a real failure).
      log.emit("tool.requested", {
        id: "call_fail",
        toolName: "read_file",
        arguments: { path: "a.txt" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_fail",
        toolName: "read_file",
        status: "failed",
        error: { code: "EBUSY", message: "resource busy" },
      }),
      log.emit("tool.requested", {
        id: "call_ok",
        toolName: "read_file",
        arguments: { path: "a.txt" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_ok",
        toolName: "read_file",
        status: "completed",
        output: { path: "a.txt", content: "ok" },
      }),
    ];

    // An unsupported claim plus the recovered failure makes this two issue
    // categories (kind === completed_with_issues), yet neither is a real
    // failure, so the run must not be marked failing.
    const outcome = completedRunOutcomeFromEvents(
      events,
      "| Command | Result |\n| `npm run verify` | ✅ passed |",
    );

    expect(outcome).toMatchObject({
      kind: "completed_with_issues",
      failing: false,
    });
  });

  it("snapshots command outcomes for persistence (and is undefined when clean)", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.created", { goal: "Run verification" }),
      log.emit("tool.requested", {
        id: "call_test",
        toolName: "shell",
        arguments: {
          command:
            'cd /tmp/ws && python -m unittest tests/test_config.py 2>&1; echo "EXIT:$?"',
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_test",
        toolName: "shell",
        status: "completed",
        output: {
          exitCode: 0,
          timedOut: false,
          stdout: "python: command not found\nEXIT:127\n",
          stderr: "",
        },
      }),
    ];

    expect(commandOutcomeSnapshot(events)).toMatchObject({
      total: 1,
      byExitCode: { "127": 1 },
      verification: {
        total: 1,
        unresolved: 1,
        lastCommand:
          'cd /tmp/ws && python -m unittest tests/test_config.py 2>&1; echo "EXIT:$?"',
        lastExitCode: 127,
        lastFailureCommand:
          'cd /tmp/ws && python -m unittest tests/test_config.py 2>&1; echo "EXIT:$?"',
        lastFailureExitCode: 127,
      },
    });

    const cleanLog = new EventLog(createRunId());
    expect(
      commandOutcomeSnapshot([
        cleanLog.emit("run.created", { goal: "Inspect" }),
        cleanLog.emit("run.completed", { reason: "final_answer" }),
      ]),
    ).toBeUndefined();
  });

  it("snapshots recovered verification failures without legacy unresolved fields", () => {
    const log = new EventLog(createRunId());
    const command = "npm test";
    const events = [
      log.emit("run.created", { goal: "Fix and verify" }),
      log.emit("tool.requested", {
        id: "call_fail",
        toolName: "shell",
        arguments: { command },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_fail",
        toolName: "shell",
        status: "completed",
        output: { exitCode: 1, timedOut: false },
      }),
      log.emit("tool.requested", {
        id: "call_pass",
        toolName: "shell",
        arguments: { command },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_pass",
        toolName: "shell",
        status: "completed",
        output: { exitCode: 0, timedOut: false },
      }),
    ];

    const analyzed = analyzeCommandOutcomes(events);
    expect(analyzed.unresolvedVerificationFailures).toEqual([]);
    expect(commandOutcomeSnapshot(events)).toMatchObject({
      total: 1,
      verification: {
        total: 1,
        unresolved: 0,
        lastFailureCommand: command,
        lastFailureExitCode: 1,
        lastFailureTimedOut: false,
        lastSuccessfulVerificationCommand: command,
      },
    });
    expect(commandOutcomeSnapshot(events)?.verification.lastCommand).toBe(
      undefined,
    );
  });

  it("snapshots same-target tool recovery for persistence", () => {
    const log = new EventLog(createRunId());
    // EBUSY is neither a not-found nor a policy code, so recovery can ONLY be
    // detected via the same target — which needs tool.requested arguments.
    const events = [
      log.emit("run.created", { goal: "Read the config" }),
      log.emit("tool.requested", {
        id: "call_fail",
        toolName: "read_file",
        arguments: { path: "config.json" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_fail",
        toolName: "read_file",
        status: "failed",
        error: { code: "EBUSY", message: "resource busy" },
      }),
      log.emit("tool.requested", {
        id: "call_ok",
        toolName: "read_file",
        arguments: { path: "config.json" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_ok",
        toolName: "read_file",
        status: "completed",
        output: { path: "config.json", content: "{}" },
      }),
    ];

    expect(toolOutcomeSnapshot(events)).toEqual({
      unresolved: { total: 0, byCode: {} },
      recovered: { total: 1, byCode: { EBUSY: 1 } },
    });
  });

  it("treats a not-found after a successful same-ref destructive mutation as recovered", () => {
    const log = new EventLog(createRunId());
    // A cron remove succeeds (changed: true), then the model loops and re-issues
    // remove with cosmetically varied job/patch fields. The follow-up failures
    // are generic TOOL_EXECUTION_FAILED ("cron job not found" lives only in the
    // message), so recovery must key on the prior mutation of the same `ref`.
    const events = [
      log.emit("run.created", { goal: "Delete the testcron job" }),
      log.emit("tool.requested", {
        id: "call_remove_ok",
        toolName: "cron",
        arguments: {
          action: "remove",
          ref: "c26560f10002",
          job: { name: "testcron", prompt: "do a thing", schedule: "every 1h" },
        },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_remove_ok",
        toolName: "cron",
        status: "completed",
        output: { action: "remove", changed: true },
      }),
      log.emit("tool.requested", {
        id: "call_remove_again",
        toolName: "cron",
        arguments: {
          // Same ref, different cosmetic fields — must collapse to one target.
          action: "remove",
          ref: "c26560f10002",
          job: { name: "", prompt: "", schedule: "" },
        },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_remove_again",
        toolName: "cron",
        status: "failed",
        error: {
          code: "TOOL_EXECUTION_FAILED",
          message: "cron job not found: c26560f10002",
        },
      }),
    ];

    const summary = analyzeToolOutcomes(events);
    expect(summary.unresolvedFailures).toEqual([]);
    expect(
      summary.mutationFollowupFailures.map((failure) => failure.code),
    ).toEqual(["TOOL_EXECUTION_FAILED"]);

    // The whole run must not be marked failing on the post-deletion noise.
    expect(completedRunOutcomeFromEvents(events)).toMatchObject({
      failing: false,
    });

    // The snapshot carries the high-signal diagnostic for trace report.
    expect(toolOutcomeSnapshot(events)).toMatchObject({
      unresolved: { total: 0, byCode: {} },
      recovered: { total: 1, byCode: { TOOL_EXECUTION_FAILED: 1 } },
      mutationFollowups: { count: 1, targets: ["cron::ref::c26560f10002"] },
    });
  });

  it("does not flag a failure as destructive-mutation fallout when the mutation happened AFTER it", () => {
    const log = new EventLog(createRunId());
    // Ordering matters: a `changed: true` mutation that lands *after* the failure
    // must not reach back in time and mislabel the failure as idempotent
    // post-deletion fallout. (The later same-target completion still recovers the
    // failure through the orthogonal same-target rule — that is fine — but it
    // must NOT appear in the destructive-mutation diagnostic.)
    const events = [
      log.emit("run.created", { goal: "Inspect then edit a cron job" }),
      log.emit("tool.requested", {
        id: "call_status",
        toolName: "cron",
        arguments: { action: "status", ref: "c26560f10002" },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_status",
        toolName: "cron",
        status: "completed",
        output: { action: "status", changed: false },
      }),
      log.emit("tool.requested", {
        id: "call_remove_fail",
        toolName: "cron",
        arguments: { action: "remove", ref: "c26560f10002" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_remove_fail",
        toolName: "cron",
        status: "failed",
        error: { code: "TOOL_EXECUTION_FAILED", message: "transient error" },
      }),
      // Mutation happens AFTER the failure — must not reach back in time.
      log.emit("tool.requested", {
        id: "call_update",
        toolName: "cron",
        arguments: { action: "update", ref: "c26560f10002", patch: {} },
      }),
      log.emit("tool.completed", {
        toolCallId: "call_update",
        toolName: "cron",
        status: "completed",
        output: { action: "update", changed: true },
      }),
    ];

    const summary = analyzeToolOutcomes(events);
    // The failure must NOT be attributed to a prior destructive mutation.
    expect(summary.mutationFollowupFailures).toEqual([]);
    expect(toolOutcomeSnapshot(events)?.mutationFollowups).toBeUndefined();
  });

  it("does not treat a not-found as recovered without a prior same-target mutation", () => {
    const log = new EventLog(createRunId());
    // Same code/shape as above but the target was never successfully mutated, so
    // the failure must stay unresolved (no laundering of a genuine failure).
    const events = [
      log.emit("run.created", { goal: "Delete a cron job" }),
      log.emit("tool.requested", {
        id: "call_remove",
        toolName: "cron",
        arguments: { action: "remove", ref: "missing0001" },
      }),
      log.emit("tool.failed", {
        toolCallId: "call_remove",
        toolName: "cron",
        status: "failed",
        error: {
          code: "TOOL_EXECUTION_FAILED",
          message: "cron job not found: missing0001",
        },
      }),
    ];

    const summary = analyzeToolOutcomes(events);
    expect(summary.mutationFollowupFailures).toEqual([]);
    expect(summary.unresolvedFailures.map((failure) => failure.code)).toEqual([
      "TOOL_EXECUTION_FAILED",
    ]);
  });

  it("classifies a legacy compact tool failure (flat errorCode) like the full shape", () => {
    const log = new EventLog(createRunId());
    // Older compact traces flattened the code to `errorCode`; the analyzer must
    // read it so classification stays trace-shape invariant.
    const events = [
      log.emit("run.created", { goal: "Improve the README" }),
      log.emit("tool.failed", {
        toolCallId: "call_1",
        status: "failed",
        errorCode: "TOOL_APPROVAL_DENIED",
      }),
    ];

    const summary = analyzeToolOutcomes(events);

    expect(summary.unresolvedFailures).toEqual([]);
    expect(summary.policyDenials.map((failure) => failure.code)).toEqual([
      "TOOL_APPROVAL_DENIED",
    ]);
  });

  it("includes a failed verification profile in the run outcome", () => {
    const log = new EventLog(createRunId());
    const events = [
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
    ];

    const outcome = completedRunOutcomeFromEvents(events);

    expect(outcome).toMatchObject({
      kind: "completed_with_verification_failures",
      verificationProfileFailures: {
        count: 1,
        lastId: "typecheck",
        lastExitCode: 2,
      },
    });
  });

  it("reads verification profile failures from terminal FactLedger snapshots", () => {
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
      log.emit("run.completed", {
        reason: "final_answer",
        factLedger: {
          schemaVersion: "fact-ledger.v1",
          writeEpoch: 0,
          commands: [],
          verificationResults: [
            {
              id: "verify:1:typecheck",
              commandFactId: "cmd:1",
              sequence: 1,
              writeEpoch: 0,
              hookName: "workflow:verification_fast",
              verificationSource: "profile",
              profile: "fast",
              verifierId: "typecheck",
              expect: "zero",
              satisfied: false,
              exitCode: 2,
              timedOut: false,
            },
          ],
          writes: [],
          budgetExceeded: [],
        },
      }),
    ];

    expect(analyzeVerificationProfileResults(events)).toEqual([
      {
        hookName: "workflow:verification_fast",
        profile: "fast",
        id: "typecheck",
        status: "failed",
        exitCode: 2,
        timedOut: false,
      },
    ]);
    expect(completedRunOutcomeFromEvents(events)).toMatchObject({
      kind: "completed_with_verification_failures",
      failing: true,
      verificationProfileFailures: {
        count: 1,
        lastId: "typecheck",
        lastExitCode: 2,
      },
    });
  });

  it("treats stale satisfied verification profile facts as failures", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.completed", {
        reason: "final_answer",
        factLedger: {
          schemaVersion: "fact-ledger.v1",
          writeEpoch: 1,
          commands: [],
          verificationResults: [
            {
              id: "verify:1:lint",
              commandFactId: "cmd:1",
              sequence: 1,
              writeEpoch: 0,
              hookName: "workflow:verification_fast",
              verificationSource: "profile",
              profile: "fast",
              verifierId: "lint",
              expect: "zero",
              satisfied: true,
              exitCode: 0,
              timedOut: false,
              stale: true,
            },
          ],
          writes: [{ id: "write:2", sequence: 2, writeEpoch: 1 }],
          budgetExceeded: [],
        },
      }),
    ];

    expect(analyzeVerificationProfileResults(events)).toEqual([
      {
        hookName: "workflow:verification_fast",
        profile: "fast",
        id: "lint",
        status: "failed",
        exitCode: 0,
        timedOut: false,
      },
    ]);
    expect(completedRunOutcomeFromEvents(events)).toMatchObject({
      kind: "completed_with_verification_failures",
      failing: true,
      verificationProfileFailures: {
        count: 1,
        lastId: "lint",
        lastExitCode: 0,
      },
    });
  });

  it("keeps profile verifier ids distinct under one invariant hook name", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("run.completed", {
        reason: "final_answer",
        factLedger: {
          schemaVersion: "fact-ledger.v1",
          writeEpoch: 1,
          commands: [],
          verificationResults: [
            {
              id: "verify:1:typecheck",
              commandFactId: "cmd:1",
              sequence: 1,
              writeEpoch: 1,
              hookName: "workflow:verification_fast",
              verificationSource: "profile",
              profile: "fast",
              verifierId: "typecheck",
              expect: "zero",
              satisfied: false,
              exitCode: 2,
              timedOut: false,
            },
            {
              id: "verify:2:lint",
              commandFactId: "cmd:2",
              sequence: 2,
              writeEpoch: 1,
              hookName: "workflow:verification_fast",
              verificationSource: "profile",
              profile: "fast",
              verifierId: "lint",
              expect: "zero",
              satisfied: true,
              exitCode: 0,
              timedOut: false,
            },
          ],
          writes: [{ id: "write:1", sequence: 1, writeEpoch: 1 }],
          budgetExceeded: [],
        },
      }),
    ];

    expect(completedRunOutcomeFromEvents(events)).toMatchObject({
      kind: "completed_with_verification_failures",
      failing: true,
      verificationProfileFailures: {
        count: 1,
        lastId: "typecheck",
        lastExitCode: 2,
      },
    });
  });

  it("does not double count built-in invariant workflow failures", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("workflow.failed", {
        workflowRunId: "verification_fast",
        projectionKind: "invariant",
        verificationSource: "profile",
        reason: "verification failed",
        failure: {
          code: "VERIFICATION_PROFILE_FAILED",
          message: "Verification failed.",
        },
      }),
      log.emit("run.completed", {
        reason: "final_answer",
        factLedger: {
          schemaVersion: "fact-ledger.v1",
          writeEpoch: 1,
          commands: [],
          verificationResults: [
            {
              id: "verify:1:lint",
              commandFactId: "cmd:1",
              sequence: 1,
              writeEpoch: 1,
              hookName: "workflow:verification_fast",
              verificationSource: "profile",
              profile: "fast",
              verifierId: "lint",
              expect: "zero",
              satisfied: false,
              exitCode: 1,
              timedOut: false,
            },
          ],
          writes: [{ id: "write:1", sequence: 1, writeEpoch: 1 }],
          budgetExceeded: [],
        },
      }),
    ];

    expect(completedRunOutcomeFromEvents(events)).toMatchObject({
      kind: "completed_with_verification_failures",
      failing: true,
      verificationProfileFailures: {
        count: 1,
        lastId: "lint",
        lastExitCode: 1,
      },
    });
    expect(
      completedRunOutcomeFromEvents(events)?.workflowFailure,
    ).toBeUndefined();
  });

  it("classifies documented-command invariant failures", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("workflow.failed", {
        workflowRunId: "documented_command",
        projectionKind: "invariant",
        verificationSource: "documented_command",
        reason: "documented command failed",
        failure: {
          code: "DOCUMENTED_COMMAND_FAILED",
          message: "Documented-command failed.",
        },
      }),
      log.emit("run.completed", {
        reason: "final_answer",
        factLedger: {
          schemaVersion: "fact-ledger.v1",
          writeEpoch: 1,
          commands: [],
          verificationResults: [
            {
              id: "verify:1:documented-command-check",
              commandFactId: "cmd:1",
              sequence: 1,
              writeEpoch: 1,
              hookName: "workflow:documented_command",
              verificationSource: "documented_command",
              verifierId: "documented-command-check",
              expect: "zero",
              satisfied: false,
              exitCode: 1,
              timedOut: false,
            },
          ],
          writes: [{ id: "write:1", sequence: 1, writeEpoch: 1 }],
          budgetExceeded: [],
        },
      }),
    ];

    expect(completedRunOutcomeFromEvents(events)).toMatchObject({
      kind: "completed_with_verification_failures",
      failing: true,
      documentedCommandFailures: {
        count: 1,
        lastId: "documented-command-check",
        lastExitCode: 1,
      },
    });
    expect(
      completedRunOutcomeFromEvents(events)?.workflowFailure,
    ).toBeUndefined();
  });

  it("classifies documented-command invariant workflow failures without a ledger", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("workflow.failed", {
        workflowRunId: "documented_command",
        projectionKind: "invariant",
        verificationSource: "documented_command",
        reason: "documented command failed",
        failures: [
          {
            verifierId: "documented-command-check",
            exitCode: 1,
            timedOut: false,
          },
        ],
        failure: {
          code: "DOCUMENTED_COMMAND_FAILED",
          message: "Documented-command failed.",
        },
      }),
      log.emit("run.completed", {
        reason: "final_answer",
      }),
    ];

    expect(completedRunOutcomeFromEvents(events)).toMatchObject({
      kind: "completed_with_verification_failures",
      failing: true,
      documentedCommandFailures: {
        count: 1,
        lastId: "documented-command-check",
        lastExitCode: 1,
      },
    });
    expect(
      completedRunOutcomeFromEvents(events)?.workflowFailure,
    ).toBeUndefined();
  });

  it("includes workflow failures in the run outcome", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("workflow.failed", {
        workflowRunId: "workflow_test",
        reason: "runtime",
        failure: {
          code: "WORKFLOW_RUNTIME_FAILED",
          message: "Projection failed.",
        },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ];

    expect(completedRunOutcomeFromEvents(events)).toMatchObject({
      kind: "completed_with_issues",
      failing: true,
      workflowFailure: {
        count: 1,
        lastReason: "runtime",
        lastCode: "WORKFLOW_RUNTIME_FAILED",
      },
    });
  });

  it("emits no outcome when all verification profiles pass", () => {
    const log = new EventLog(createRunId());
    const events = [
      log.emit("workflow_hook.completed", {
        hookName: "verification:fast:lint",
        result: {
          status: "continue",
          metadata: { exitCode: 0, timedOut: false },
        },
      }),
      log.emit("run.completed", { reason: "final_answer" }),
    ];

    expect(completedRunOutcomeFromEvents(events)).toBeUndefined();
  });
});
