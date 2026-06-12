import {
  EventLog,
  analyzeCommandOutcomes,
  completedRunOutcomeFromEvents,
  createRunId,
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
});
