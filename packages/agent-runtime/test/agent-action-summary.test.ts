import type { SparkwrightEvent } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import { summarizeAgentActions } from "../src/agents/action-summary.js";

function event(
  type: string,
  sequence: number,
  payload: unknown,
): SparkwrightEvent {
  return {
    id: `event_${sequence}`,
    runId: "run_child",
    type,
    sequence,
    timestamp: `2026-07-25T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    payload,
  } as SparkwrightEvent;
}

describe("summarizeAgentActions", () => {
  it("builds bounded terminal receipts without raw arguments or outputs", () => {
    const actions = summarizeAgentActions([
      event("tool.requested", 1, {
        id: "call_read",
        toolName: "read",
        arguments: { path: "src/app.ts", line: 10, limit: 20 },
      }),
      event("tool.completed", 2, {
        toolCallId: "call_read",
        toolName: "read",
        output: { content: "sensitive source", bytes: 100 },
      }),
      event("tool.requested", 3, {
        id: "call_bash",
        toolName: "bash",
        arguments: { command: "python3 -m py_compile print_numbers.py" },
      }),
      event("tool.completed", 4, {
        toolCallId: "call_bash",
        toolName: "bash",
        output: { stdout: "", stderr: "", exitCode: 0, timedOut: false },
      }),
      event("tool.requested", 5, {
        id: "call_terminal",
        toolName: "submit_agent_result",
        arguments: { summary: "done" },
      }),
    ]);

    expect(actions).toEqual([
      {
        toolCallId: "call_read",
        toolName: "read",
        preview: "src/app.ts:10 +20",
        status: "completed",
      },
      {
        toolCallId: "call_bash",
        toolName: "bash",
        preview: "$ python3 -m py_compile print_numbers.py",
        status: "completed",
        exitCode: 0,
      },
    ]);
    expect(JSON.stringify(actions)).not.toContain("sensitive source");
    expect(JSON.stringify(actions)).not.toContain("summary");
  });

  it("preserves idempotent skips as a non-success terminal action", () => {
    const actions = summarizeAgentActions([
      event("tool.requested", 1, {
        id: "call_bash",
        toolName: "bash",
        arguments: { command: "python3 -m py_compile print_numbers.py" },
      }),
      event("tool.completed", 2, {
        toolCallId: "call_bash",
        toolName: "bash",
        output: {
          changed: false,
          skipped: true,
          reason: "repeated_idempotent_noop",
        },
      }),
    ]);

    expect(actions).toEqual([
      {
        toolCallId: "call_bash",
        toolName: "bash",
        preview: "$ python3 -m py_compile print_numbers.py",
        status: "skipped",
        skipReason: "repeated_idempotent_noop",
      },
    ]);
  });

  it("keeps bounded semantic failure context in terminal receipts", () => {
    const actions = summarizeAgentActions([
      event("tool.requested", 1, {
        id: "call_create",
        toolName: "create",
        arguments: { path: "print_numbers.py", content: "sensitive content" },
      }),
      event("tool.failed", 2, {
        toolCallId: "call_create",
        toolName: "create",
        error: {
          code: "WORKSPACE_CREATE_CONFLICT",
          message: "Workspace create target already exists: print_numbers.py",
        },
      }),
    ]);

    expect(actions).toEqual([
      {
        toolCallId: "call_create",
        toolName: "create",
        preview: "print_numbers.py",
        status: "failed",
        errorCode: "WORKSPACE_CREATE_CONFLICT",
        errorMessage:
          "Workspace create target already exists: print_numbers.py",
      },
    ]);
    expect(JSON.stringify(actions)).not.toContain("sensitive content");
  });
});
