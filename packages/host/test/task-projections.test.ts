import { describe, expect, it } from "vitest";
import type {
  TaskLifecycleUpdate,
  TaskRecord,
} from "@sparkwright/agent-runtime";
import {
  agentTaskCompletionOutput,
  taskUpdatedEventPayload,
} from "../src/runtime/task-projections.js";

describe("task lifecycle event projections", () => {
  it("projects an explicit bounded agent completion receipt with a result ref", () => {
    const report = "agent report ".repeat(500);
    const output = agentTaskCompletionOutput(
      {
        childRunId: "run_agent_task",
        status: "completed",
        report,
        workspace: { writes: 2, paths: ["a.ts", "b.ts"] },
        warnings: [],
        blockers: [],
      },
      "task_agent",
    );

    expect(output).toMatchObject({
      type: "agent.completed",
      taskId: "task_agent",
      childRunId: "run_agent_task",
      status: "completed",
      report: report.slice(0, 4_000),
      reportTruncated: true,
      reportChars: report.length,
      reportOmittedChars: report.length - 4_000,
      workspace: { writes: 2, paths: ["a.ts", "b.ts"] },
      resultRef: {
        tool: "task",
        action: "get",
        taskId: "task_agent",
      },
    });
  });

  it("projects a bounded terminal summary without result or metadata leakage", () => {
    const record = {
      id: "task_projection",
      parentRunId: "run_projection",
      kind: "agent",
      title: "x".repeat(400),
      completionPolicy: "detached",
      awaited: false,
      status: "completed",
      createdAt: "2026-05-24T00:00:00.000Z",
      startedAt: "2026-05-24T00:00:01.000Z",
      completedAt: "2026-05-24T00:00:02.000Z",
      result: {
        message: `Bearer private-token ${"result".repeat(300)}`,
        apiKey: "must-not-escape",
        nested: { accessToken: "also-private", safe: "visible" },
      },
      metadata: {
        recipient: "model-supplied-recipient",
        rawStdout: "full output must stay in TaskStore",
      },
    } as unknown as TaskRecord;
    const payload = taskUpdatedEventPayload(
      { transition: "terminal", record } satisfies TaskLifecycleUpdate,
      "session_projection",
    );

    expect(payload).toMatchObject({
      taskId: "task_projection",
      parentRunId: "run_projection",
      sessionId: "session_projection",
      transition: "terminal",
      completionPolicy: "detached",
      status: "completed",
      outputRef: { method: "task.output", taskId: "task_projection" },
    });
    expect(payload.title).toHaveLength(200);
    expect(payload.resultSummary!.length).toBeLessThanOrEqual(1_024);
    expect(payload.resultSummary).toContain("[REDACTED]");
    expect(JSON.stringify(payload)).not.toContain("must-not-escape");
    expect(JSON.stringify(payload)).not.toContain("also-private");
    expect(JSON.stringify(payload)).not.toContain("rawStdout");
    expect(payload).not.toHaveProperty("result");
    expect(payload).not.toHaveProperty("metadata");
  });

  it("bounds failed-task errors and omits error metadata", () => {
    const record = {
      id: "task_failed",
      parentRunId: "run_projection",
      kind: "shell.background",
      completionPolicy: "awaited",
      awaited: true,
      status: "failed",
      createdAt: "2026-05-24T00:00:00.000Z",
      completedAt: "2026-05-24T00:00:02.000Z",
      error: {
        code: "E".repeat(300),
        message: `password=private ${"failure".repeat(300)}`,
        metadata: { stdout: "full output" },
      },
      metadata: {},
    } as unknown as TaskRecord;

    const payload = taskUpdatedEventPayload({
      transition: "terminal",
      record,
    });

    expect(payload.error?.code).toHaveLength(128);
    expect(payload.error?.message.length).toBeLessThanOrEqual(1_024);
    expect(payload.error?.message).toContain("password=[REDACTED]");
    expect(payload.error).not.toHaveProperty("metadata");
    expect(payload.resultSummary).toBeUndefined();
  });
});
