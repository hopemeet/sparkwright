import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, type SparkwrightEvent } from "../src/events.js";
import { createRunId } from "../src/ids.js";
import {
  createSessionRunStoreFactory,
  FileSessionStore,
} from "../src/session.js";
import {
  createSessionFileRunStoreFactory,
  validateSessionTraceConsistency,
} from "../src/trace.js";
import type { RunAssessment } from "../src/run-assessment.js";
import type { RunRecord, RunResult } from "../src/types.js";

const tempDirs: string[] = [];
const CLEAN_ASSESSMENT: RunAssessment = {
  schemaVersion: "run-assessment.v1",
  health: "clean",
  issues: [],
  verification: [],
};

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("session trace tool-failure consistency", () => {
  it.each([
    {
      name: "a sole run.cancelled terminal",
      terminalEvents: (log: EventLog) => [
        log.emit("run.cancelled", { reason: "manual_cancelled" }),
      ],
    },
    {
      name: "a legacy cancelled run.completed terminal before the abort",
      terminalEvents: (log: EventLog) => [
        log.emit("run.completed", {
          state: "cancelled",
          stopReason: "manual_cancelled",
        }),
      ],
      abortFirst: true,
    },
    {
      name: "the compatible run.cancelled plus run.completed pair",
      terminalEvents: (log: EventLog) => [
        log.emit("run.cancelled", { reason: "manual_cancelled" }),
        log.emit("run.completed", {
          state: "cancelled",
          stopReason: "manual_cancelled",
        }),
      ],
    },
  ])("does not warn about TOOL_ABORTED owned by $name", async (scenario) => {
    const session = await createSession("cancelled-abort");
    const run = createRunRecord();
    const log = new EventLog(run.id);
    const created = log.emit("run.created", { goal: run.goal });
    const orderedEvents = scenario.abortFirst
      ? [
          created,
          ...abortedToolEvents(log, "call_cancelled"),
          ...scenario.terminalEvents(log),
        ]
      : [
          created,
          ...scenario.terminalEvents(log),
          ...abortedToolEvents(log, "call_cancelled"),
        ];
    await session.writeRun(run, orderedEvents, cancelledResult());

    const report = await session.validate();

    expect(report.ok).toBe(true);
    expect(
      report.findings.filter(
        (finding) => finding.code === "UNRESOLVED_TOOL_FAILURE",
      ),
    ).toEqual([]);
  });

  it.each([
    {
      name: "a completed run",
      terminalEvents: (log: EventLog) => [
        log.emit("run.completed", { state: "completed" }),
      ],
    },
    {
      name: "a failed run",
      terminalEvents: (log: EventLog) => [
        log.emit("run.failed", {
          state: "failed",
          code: "MAX_STEPS_EXCEEDED",
          reason: "max_steps_exceeded",
        }),
      ],
    },
    {
      name: "conflicting cancelled and failed terminals",
      terminalEvents: (log: EventLog) => [
        log.emit("run.cancelled", { reason: "manual_cancelled" }),
        log.emit("run.failed", {
          state: "failed",
          code: "INTERNAL_ERROR",
          reason: "internal_error",
        }),
      ],
    },
  ])("keeps TOOL_ABORTED unresolved for $name", async (scenario) => {
    const session = await createSession("unowned-abort");
    const run = createRunRecord();
    const log = new EventLog(run.id);
    await session.writeRun(
      run,
      [
        log.emit("run.created", { goal: run.goal }),
        ...scenario.terminalEvents(log),
        ...abortedToolEvents(log, "call_unowned"),
      ],
      failedResult(),
    );

    const report = await session.validate();

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNRESOLVED_TOOL_FAILURE",
          metadata: expect.objectContaining({
            count: 1,
            byCode: { TOOL_ABORTED: 1 },
          }),
        }),
      ]),
    );
  });

  it("keeps cancellation ownership isolated per run", async () => {
    const session = await createSession("multi-run-abort");
    const cancelledRun = createRunRecord();
    const cancelledLog = new EventLog(cancelledRun.id);
    await session.writeRun(
      cancelledRun,
      [
        cancelledLog.emit("run.created", { goal: cancelledRun.goal }),
        cancelledLog.emit("run.cancelled", { reason: "manual_cancelled" }),
        ...abortedToolEvents(cancelledLog, "call_cancelled"),
      ],
      cancelledResult(),
    );

    const completedRun = createRunRecord();
    const completedLog = new EventLog(completedRun.id);
    await session.writeRun(
      completedRun,
      [
        completedLog.emit("run.created", { goal: completedRun.goal }),
        completedLog.emit("run.completed", { state: "completed" }),
        ...abortedToolEvents(completedLog, "call_completed"),
      ],
      failedResult(),
    );

    const report = await session.validate();
    const unresolved = report.findings.find(
      (finding) => finding.code === "UNRESOLVED_TOOL_FAILURE",
    );

    expect(unresolved?.metadata).toMatchObject({
      count: 1,
      byCode: { TOOL_ABORTED: 1 },
    });
  });

  it("still reports a workspace escape from a cancelled run as an error", async () => {
    const session = await createSession("cancelled-escape");
    const run = createRunRecord();
    const log = new EventLog(run.id);
    await session.writeRun(
      run,
      [
        log.emit("run.created", { goal: run.goal }),
        log.emit("run.cancelled", { reason: "manual_cancelled" }),
        ...failedToolEvents(log, "call_escape", {
          code: "WORKSPACE_PATH_ESCAPED",
          message: "Path escapes workspace root: ../secret.txt",
        }),
      ],
      cancelledResult(),
    );

    const report = await session.validate();

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "WORKSPACE_PATH_ESCAPE_ATTEMPT",
        }),
      ]),
    );
  });
});

async function createSession(label: string) {
  const root = await mkdtemp(join(tmpdir(), `sparkwright-${label}-`));
  tempDirs.push(root);
  const sessionId = `session_${label.replaceAll("-", "_")}`;
  const factory = createSessionRunStoreFactory({
    sessionStore: new FileSessionStore({ rootDir: root }),
    sessionId,
    runStoreFactory: createSessionFileRunStoreFactory({
      sessionRootDir: root,
      sessionId,
      agentId: "main",
      traceLevel: "debug",
    }),
  });
  return {
    async writeRun(
      run: RunRecord,
      events: SparkwrightEvent[],
      result: RunResult,
    ) {
      const store = factory(run);
      for (const event of events) await store.append(event);
      await store.finish({ ...run, state: result.state }, result);
    },
    validate: () =>
      validateSessionTraceConsistency({ sessionDir: join(root, sessionId) }),
  };
}

function abortedToolEvents(log: EventLog, toolCallId: string) {
  return failedToolEvents(log, toolCallId, {
    code: "TOOL_ABORTED",
    message: "Tool execution aborted.",
  });
}

function failedToolEvents(
  log: EventLog,
  toolCallId: string,
  error: { code: string; message: string },
) {
  return [
    log.emit("tool.requested", {
      id: toolCallId,
      toolName: "shell",
      arguments: { command: "sleep 10" },
    }),
    log.emit("tool.started", { toolCallId, toolName: "shell" }),
    log.emit("tool.failed", {
      toolCallId,
      toolName: "shell",
      status: "failed",
      error,
    }),
  ];
}

function createRunRecord(): RunRecord {
  const now = new Date().toISOString();
  return {
    id: createRunId(),
    goal: "test session consistency",
    state: "created",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
}

function cancelledResult(): RunResult {
  return {
    signal: "cancelled",
    state: "cancelled",
    stopReason: "manual_cancelled",
    assessment: CLEAN_ASSESSMENT,
    metadata: {},
  };
}

function failedResult(): RunResult {
  return {
    signal: "failed",
    state: "failed",
    stopReason: "max_steps_exceeded",
    assessment: CLEAN_ASSESSMENT,
    metadata: {},
  };
}
