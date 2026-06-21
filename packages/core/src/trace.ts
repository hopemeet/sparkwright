// AI maintenance note: stable named facade for trace APIs. Phase 1 keeps
// index.ts/internal.ts pointing here while implementation lives in endpoint modules.

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SparkwrightEvent } from "./events.js";
import { analyzeToolOutcomes } from "./run-outcome.js";
import {
  foldedSequenceSkipBefore,
  loadTraceEventsFile,
  observedSequenceEnd,
  parseTraceJsonl,
  summarizeTraceJsonl,
  type TraceSummary,
} from "./trace-diagnostics.js";

export {
  createTraceRedactor,
  filterTraceEvent,
  isVerboseStreamEvent,
  serializeEventJsonl,
} from "./trace-codec.js";
export type {
  TraceLevel,
  TraceRedactionOptions,
  TraceRedactor,
} from "./trace-codec.js";
export {
  buildTraceReport,
  buildTraceReportFile,
  buildTraceReportJsonl,
  buildTraceTimeline,
  buildTraceTimelineFile,
  buildTraceTimelineJsonl,
  loadTraceEventsFile,
  loadTraceEventsJsonl,
  summarizeTraceFile,
  summarizeTraceJsonl,
  verifyTraceFile,
  verifyTraceJsonl,
} from "./trace-diagnostics.js";
export type {
  TraceEventFilter,
  TraceReport,
  TraceReportFinding,
  TraceReportFindingSeverity,
  TraceReportVerdict,
  TraceSummary,
  TraceTimeline,
  TraceTimelinePhase,
  TraceTimelinePhaseCategory,
  TraceTimelinePhaseStatus,
  TraceVerificationFinding,
  TraceVerificationReport,
} from "./trace-diagnostics.js";
export {
  bindStorageDegradationEvents,
  createSessionFileRunStoreFactory,
  FileRunStore,
  loadCheckpointFromRunDir,
  MemoryTrace,
  restoreTranscriptPrompts,
} from "./trace-store.js";
export type {
  FileRunStoreOptions,
  LoadCheckpointFromRunDirOptions,
  SessionFileRunStoreFactoryOptions,
} from "./trace-store.js";

export interface SessionTraceConsistencyFinding {
  severity: "error" | "warning";
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface SessionTraceConsistencyReport {
  ok: boolean;
  sessionDir: string;
  sessionId?: string;
  runIds: string[];
  /** @reserved Public consistency-report field consumed by diagnostics UIs. */
  traceSummary?: TraceSummary;
  findings: SessionTraceConsistencyFinding[];
}

export interface ValidateSessionTraceConsistencyOptions {
  sessionDir: string;
}

export interface SessionTraceRepairAction {
  kind: "update_session_json";
  path: string;
  /** @reserved Public repair-audit field consumed by diagnostics UIs. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string;
}

export interface SessionTraceRepairReport {
  applied: boolean;
  sessionDir: string;
  actions: SessionTraceRepairAction[];
  /** @reserved Public repair-audit field consumed by diagnostics UIs. */
  before: SessionTraceConsistencyReport;
  after?: SessionTraceConsistencyReport;
}

export interface RepairSessionTraceConsistencyOptions {
  sessionDir: string;
  apply?: boolean;
}

export async function validateSessionTraceConsistency({
  sessionDir,
}: ValidateSessionTraceConsistencyOptions): Promise<SessionTraceConsistencyReport> {
  const findings: SessionTraceConsistencyFinding[] = [];
  const session = await readJsonFile<{
    id?: string;
    runIds?: unknown;
    eventCount?: unknown;
    agents?: unknown;
    updatedAt?: unknown;
  }>(join(sessionDir, "session.json"), findings, "SESSION_JSON");
  const runIds = Array.isArray(session?.runIds)
    ? session.runIds.filter((id): id is string => typeof id === "string")
    : [];

  if (session && !Array.isArray(session.runIds)) {
    findings.push({
      severity: "error",
      code: "SESSION_RUN_IDS_INVALID",
      message: "session.json runIds must be an array.",
    });
  }

  const sessionEvents = await readJsonlFile<Record<string, unknown>>(
    join(sessionDir, "events.jsonl"),
    findings,
    "SESSION_EVENTS",
  );
  validateSequence(
    sessionEvents,
    "SESSION_EVENT_SEQUENCE_INVALID",
    "Session event sequence must increase by one.",
    findings,
  );
  if (
    typeof session?.eventCount === "number" &&
    session.eventCount !== sessionEvents.length
  ) {
    findings.push({
      severity: "error",
      code: "SESSION_EVENT_COUNT_MISMATCH",
      message: "session.json eventCount does not match events.jsonl length.",
      metadata: {
        eventCount: session.eventCount,
        actual: sessionEvents.length,
      },
    });
  }

  const tracePath = join(sessionDir, "trace.jsonl");
  let traceSummary: TraceSummary | undefined;
  let traceEvents: SparkwrightEvent[] = [];
  try {
    const traceJsonl = await readFile(tracePath, "utf8");
    traceSummary = summarizeTraceJsonl(traceJsonl);
    traceEvents = parseTraceJsonl(traceJsonl, tracePath);
  } catch (error) {
    findings.push({
      severity: "error",
      code: "TRACE_UNREADABLE",
      message: error instanceof Error ? error.message : String(error),
      metadata: { path: tracePath },
    });
  }

  if (session?.id && traceSummary) {
    const unexpected = traceSummary.sessionIds.filter(
      (id) => id !== session.id,
    );
    if (unexpected.length > 0) {
      findings.push({
        severity: "error",
        code: "TRACE_SESSION_ID_MISMATCH",
        message: "Trace contains events for a different session id.",
        metadata: { expected: session.id, actual: unexpected },
      });
    }
  }

  if (traceSummary) {
    const sessionRunIds = new Set(runIds);
    const traceRunIds = new Set(traceSummary.runIds);
    for (const runId of traceSummary.runIds) {
      if (!sessionRunIds.has(runId)) {
        findings.push({
          severity: "error",
          code: "TRACE_RUN_NOT_IN_SESSION",
          message: "Trace contains a run id not listed in session.json.",
          metadata: { runId },
        });
      }
    }
    for (const runId of runIds) {
      if (!traceRunIds.has(runId)) {
        findings.push({
          severity: "warning",
          code: "SESSION_RUN_NOT_IN_TRACE",
          message: "session.json lists a run id not present in trace.jsonl.",
          metadata: { runId },
        });
      }
    }
  }

  validateRunEventSequences(traceEvents, findings);
  validateSubagentLifecycles(traceEvents, findings);
  validateToolFailureSafety(traceEvents, findings);
  await validateRunFiles(sessionDir, runIds, findings);

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    sessionDir,
    sessionId: session?.id,
    runIds,
    traceSummary,
    findings,
  };
}

const WORKSPACE_ESCAPE_MESSAGE =
  /escapes workspace root|stay inside the workspace/i;

/**
 * Detects a `tool.failed` event that represents an attempt to read or write
 * outside the workspace root. These are surfaced regardless of run outcome so a
 * structurally-consistent session that nonetheless attempted a boundary escape
 * is not reported as clean.
 */
function isWorkspaceEscapeFailure(event: SparkwrightEvent): boolean {
  if (event.type !== "tool.failed" || !isRecord(event.payload)) return false;
  const code = traceErrorCode(event);
  if (code === "WORKSPACE_PATH_ESCAPED" || code?.endsWith("_PATH_ESCAPED")) {
    return true;
  }
  const message = isRecord(event.payload.error)
    ? stringValue(event.payload.error.message)
    : undefined;
  return Boolean(message && WORKSPACE_ESCAPE_MESSAGE.test(message));
}

/**
 * Surfaces safety-relevant tool failures as session-consistency findings.
 *
 * Workspace path-escape attempts are reported as errors (a structurally valid
 * session is still not "ok" if a tool tried to leave the workspace), while other
 * unresolved tool failures are reported as warnings so benign exploratory probes
 * (for example a single ENOENT on a guessed path) do not fail the check.
 */
function validateToolFailureSafety(
  events: readonly SparkwrightEvent[],
  findings: SessionTraceConsistencyFinding[],
): void {
  if (events.length === 0) return;

  const escapeFailures = events.filter(isWorkspaceEscapeFailure);
  const escapeCallIds = new Set(
    escapeFailures
      .map((event) =>
        isRecord(event.payload)
          ? stringValue(event.payload.toolCallId)
          : undefined,
      )
      .filter((id): id is string => Boolean(id)),
  );

  if (escapeFailures.length > 0) {
    const byTool: Record<string, number> = {};
    for (const event of escapeFailures) {
      const toolName = isRecord(event.payload)
        ? (stringValue(event.payload.toolName) ?? "unknown")
        : "unknown";
      byTool[toolName] = (byTool[toolName] ?? 0) + 1;
    }
    findings.push({
      severity: "error",
      code: "WORKSPACE_PATH_ESCAPE_ATTEMPT",
      message: `Trace contains ${escapeFailures.length} workspace path-escape tool failure(s); a tool attempted to read or write outside the workspace root.`,
      metadata: { count: escapeFailures.length, byTool },
    });
  }

  const unresolved = analyzeToolOutcomes(events).unresolvedFailures.filter(
    (failure) => !failure.toolCallId || !escapeCallIds.has(failure.toolCallId),
  );
  if (unresolved.length > 0) {
    const byCode: Record<string, number> = {};
    for (const failure of unresolved) {
      const code = failure.code ?? "unknown";
      byCode[code] = (byCode[code] ?? 0) + 1;
    }
    findings.push({
      severity: "warning",
      code: "UNRESOLVED_TOOL_FAILURE",
      message: `Trace contains ${unresolved.length} unresolved tool failure(s) not followed by a successful retry of the same target.`,
      metadata: { count: unresolved.length, byCode },
    });
  }
}

export async function repairSessionTraceConsistency({
  sessionDir,
  apply = false,
}: RepairSessionTraceConsistencyOptions): Promise<SessionTraceRepairReport> {
  const before = await validateSessionTraceConsistency({ sessionDir });
  const actions: SessionTraceRepairAction[] = [];
  const sessionPath = join(sessionDir, "session.json");
  const session = await readJsonFile<Record<string, unknown>>(
    sessionPath,
    [],
    "SESSION_JSON",
  );
  if (session) {
    const repaired = { ...session };
    let changed = false;
    const traceRunIds = before.traceSummary?.runIds ?? [];
    const currentRunIds = Array.isArray(session.runIds)
      ? session.runIds.filter((id): id is string => typeof id === "string")
      : [];
    if (
      traceRunIds.length > 0 &&
      JSON.stringify(currentRunIds) !== JSON.stringify(traceRunIds)
    ) {
      repaired.runIds = traceRunIds;
      changed = true;
    }

    const traceAgentIds = before.traceSummary?.agentIds ?? [];
    const currentAgentIds = Array.isArray(session.agents)
      ? session.agents.filter((id): id is string => typeof id === "string")
      : [];
    if (
      traceAgentIds.length > 0 &&
      JSON.stringify(currentAgentIds) !== JSON.stringify(traceAgentIds)
    ) {
      repaired.agents = traceAgentIds;
      changed = true;
    }

    const sessionEvents = await readJsonlFile<Record<string, unknown>>(
      join(sessionDir, "events.jsonl"),
      [],
      "SESSION_EVENTS",
    );
    if (
      sessionEvents.length > 0 &&
      session.eventCount !== sessionEvents.length
    ) {
      repaired.eventCount = sessionEvents.length;
      changed = true;
    }

    const traceEvents = await readTraceEventsForRepair(sessionDir);
    const latestTimestamp = latestIsoTimestamp([
      ...sessionEvents
        .map((event) =>
          typeof event.timestamp === "string" ? event.timestamp : undefined,
        )
        .filter((timestamp): timestamp is string => timestamp !== undefined),
      ...traceEvents.map((event) => event.timestamp),
    ]);
    if (
      latestTimestamp &&
      (typeof session.updatedAt !== "string" ||
        session.updatedAt < latestTimestamp)
    ) {
      repaired.updatedAt = latestTimestamp;
      changed = true;
    }

    if (changed) {
      actions.push({
        kind: "update_session_json",
        path: sessionPath,
        before: session,
        after: repaired,
        reason: "Repair derived session metadata from trace/events evidence.",
      });
    }
  }

  if (apply) {
    for (const action of actions) {
      await writeFile(
        action.path,
        `${JSON.stringify(action.after, null, 2)}\n`,
        "utf8",
      );
    }
  }

  return {
    applied: apply,
    sessionDir,
    actions,
    before,
    after: apply
      ? await validateSessionTraceConsistency({ sessionDir })
      : undefined,
  };
}

async function readTraceEventsForRepair(
  sessionDir: string,
): Promise<SparkwrightEvent[]> {
  try {
    return await loadTraceEventsFile(join(sessionDir, "trace.jsonl"));
  } catch {
    return [];
  }
}

function latestIsoTimestamp(timestamps: string[]): string | undefined {
  return timestamps
    .filter((timestamp) => !Number.isNaN(Date.parse(timestamp)))
    .sort()
    .at(-1);
}

async function readJsonFile<T>(
  path: string,
  findings: SessionTraceConsistencyFinding[],
  codePrefix: string,
): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    findings.push({
      severity: "error",
      code: `${codePrefix}_UNREADABLE`,
      message: error instanceof Error ? error.message : String(error),
      metadata: { path },
    });
    return undefined;
  }
}

async function readJsonlFile<T>(
  path: string,
  findings: SessionTraceConsistencyFinding[],
  codePrefix: string,
): Promise<T[]> {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line, index) => {
        try {
          return JSON.parse(line) as T;
        } catch (cause) {
          throw new Error(`Invalid JSON at line ${index + 1}`, { cause });
        }
      });
  } catch (error) {
    // Distinguish "file absent" from "file corrupt": a missing JSONL
    // typically just means no writer of that file is configured (e.g.
    // a `FileRunStore` running without a paired `FileSessionStore`).
    // That is a legitimate setup, not a hard error. Only parse failures
    // and other I/O errors stay as errors.
    const missing =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT";
    findings.push({
      severity: missing ? "warning" : "error",
      code: missing ? `${codePrefix}_MISSING` : `${codePrefix}_UNREADABLE`,
      message: error instanceof Error ? error.message : String(error),
      metadata: { path },
    });
    return [];
  }
}

function validateSequence(
  events: Array<Record<string, unknown>>,
  code: string,
  message: string,
  findings: SessionTraceConsistencyFinding[],
): void {
  events.forEach((event, index) => {
    if (event.sequence !== index + 1) {
      findings.push({
        severity: "error",
        code,
        message,
        metadata: { expected: index + 1, actual: event.sequence },
      });
    }
  });
}

function validateSubagentLifecycles(
  events: SparkwrightEvent[],
  findings: SessionTraceConsistencyFinding[],
): void {
  interface ChildLifecycle {
    childRunId: string;
    parentRunId?: string;
    agentProfileId?: string;
    requested: boolean;
    terminated: boolean;
  }
  const children = new Map<string, ChildLifecycle>();
  const childState = (childRunId: string): ChildLifecycle => {
    let state = children.get(childRunId);
    if (!state) {
      state = { childRunId, requested: false, terminated: false };
      children.set(childRunId, state);
    }
    return state;
  };
  for (const event of events) {
    if (!event.type.startsWith("subagent.")) continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    const childRunId =
      typeof payload?.childRunId === "string" ? payload.childRunId : undefined;
    if (!childRunId) continue;
    const state = childState(childRunId);
    if (typeof payload?.parentRunId === "string") {
      state.parentRunId = payload.parentRunId;
    }
    const metadata = event.metadata as Record<string, unknown> | undefined;
    if (typeof metadata?.agentProfileId === "string") {
      state.agentProfileId = metadata.agentProfileId;
    }
    if (
      event.type === "subagent.requested" ||
      event.type === "subagent.started"
    ) {
      state.requested = true;
    } else if (
      event.type === "subagent.completed" ||
      event.type === "subagent.failed"
    ) {
      state.terminated = true;
    }
  }
  for (const state of children.values()) {
    if (state.requested && !state.terminated) {
      findings.push({
        severity: "warning",
        code: "SUBAGENT_NOT_TERMINATED",
        message:
          "A delegated sub-agent was requested but never produced a completed/failed result.",
        metadata: {
          childRunId: state.childRunId,
          parentRunId: state.parentRunId,
          agentProfileId: state.agentProfileId,
        },
      });
    }
  }
}

function validateRunEventSequences(
  events: SparkwrightEvent[],
  findings: SessionTraceConsistencyFinding[],
): void {
  const lastByRun = new Map<string, number>();
  for (const event of events) {
    const last = lastByRun.get(event.runId) ?? 0;
    const expected = last + 1;
    const foldedSkip = foldedSequenceSkipBefore(event);
    if (
      event.sequence !== expected &&
      event.sequence !== expected + foldedSkip
    ) {
      findings.push({
        severity: "error",
        code: "RUN_EVENT_SEQUENCE_INVALID",
        message: "Run event sequence must increase by one per run.",
        metadata: {
          runId: event.runId,
          expected,
          actual: event.sequence,
        },
      });
    }
    lastByRun.set(event.runId, observedSequenceEnd(event));
  }
}

/**
 * Number of sequence numbers consumed by events that were folded out of the
 * persisted trace immediately before `event`. At standard level the trace store
 * collapses each `extension.process.progress` event into the terminal
 * `extension.process.completed`/`.failed` event's `progressCount`, dropping the
 * progress events' own sequence numbers. Verify never sees those events, so the
 * terminal event's sequence legitimately jumps forward by the folded count.
 * Mirrors `observedSequenceEnd`'s handling of folded `model.stream.text` chunks.
 *
 * The written terminal event's `progressCount` equals the number of folded
 * progress events: the runner increments it only when a progress event is
 * actually emitted (dropped samples land in `progressDropped`, which never
 * consumes a sequence number). At debug level the progress events are persisted
 * with their own sequences, so the terminal event has no gap and the base
 * `expected` already matches — this skip is only consulted when a gap exists.
 */

async function validateRunFiles(
  sessionDir: string,
  runIds: string[],
  findings: SessionTraceConsistencyFinding[],
): Promise<void> {
  const runFiles = await listRunFiles(sessionDir, findings);
  for (const runId of runIds) {
    const paths = runFiles.get(runId);
    if (!paths?.runJson) {
      findings.push({
        severity: "error",
        code: "RUN_JSON_MISSING",
        message: "Session run is missing run.json.",
        metadata: { runId },
      });
    }
    if (!paths?.resultJson) {
      findings.push({
        severity: "warning",
        code: "RUN_RESULT_JSON_MISSING",
        message: "Session run is missing result.json.",
        metadata: { runId },
      });
    }
  }
}

async function listRunFiles(
  sessionDir: string,
  findings: SessionTraceConsistencyFinding[],
): Promise<Map<string, { runJson?: string; resultJson?: string }>> {
  const files = new Map<string, { runJson?: string; resultJson?: string }>();
  const agentsDir = join(sessionDir, "agents");
  let agents: string[];
  try {
    agents = await readdir(agentsDir);
  } catch (error) {
    findings.push({
      severity: "error",
      code: "AGENTS_DIR_UNREADABLE",
      message: error instanceof Error ? error.message : String(error),
      metadata: { path: agentsDir },
    });
    return files;
  }

  for (const agent of agents) {
    const runsDir = join(agentsDir, agent, "runs");
    let runIds: string[];
    try {
      runIds = await readdir(runsDir);
    } catch {
      continue;
    }
    for (const runId of runIds) {
      const runDir = join(runsDir, runId);
      const entry = files.get(runId) ?? {};
      if (existsSync(join(runDir, "run.json")))
        entry.runJson = join(runDir, "run.json");
      if (existsSync(join(runDir, "result.json"))) {
        entry.resultJson = join(runDir, "result.json");
      }
      files.set(runId, entry);
    }
  }
  return files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function traceErrorCode(event: SparkwrightEvent): string | undefined {
  if (!isRecord(event.payload)) return undefined;
  return stringValue(
    event.payload.errorCode,
    isRecord(event.payload.error) ? event.payload.error.code : undefined,
    // run.failed carries its code at the payload root (e.g. a target-boundary
    // rejection's TARGET_OUTSIDE_WORKSPACE), not under `error`.
    event.type === "run.failed" ? event.payload.code : undefined,
    // validation.failed (pre-flight rejections) carries codes on its findings.
    event.type === "validation.failed"
      ? validationFailureCode(event.payload)
      : undefined,
    event.type === "mcp.server.prepared" && event.payload.status === "failed"
      ? "MCP_SERVER_PREPARE_FAILED"
      : undefined,
    event.type.endsWith(".denied") ? event.type : undefined,
  );
}

function validationFailureCode(
  payload: Record<string, unknown>,
): string | undefined {
  const result = isRecord(payload.result) ? payload.result : undefined;
  const findings =
    result && Array.isArray(result.findings) ? result.findings : [];
  const errorFinding =
    findings.find(
      (finding) => isRecord(finding) && finding.severity === "error",
    ) ?? findings.find((finding) => isRecord(finding));
  return isRecord(errorFinding) ? stringValue(errorFinding.code) : undefined;
}
