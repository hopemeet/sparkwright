import {
  EventLog,
  analyzeCommandOutcomes,
  analyzeToolOutcomes,
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
});
