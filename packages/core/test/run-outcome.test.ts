import {
  EventLog,
  analyzeCommandOutcomes,
  analyzeToolOutcomes,
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
