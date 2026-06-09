// AI maintenance note: Trace = JSONL serialization + redaction for
// SparkwrightEvent. FileRunStore supports legacy per-run traces and the newer
// session layout under `.sparkwright/sessions/<session-id>/`. Add new
// redaction rules here, not at the call site; embedders compose redactors.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { assertSafePathSegment } from "./ids.js";
import type { PromptMessage } from "./context.js";
import type { SparkwrightEvent } from "./events.js";
import type { RunStore, TraceSink } from "./storage.js";
import type {
  Artifact,
  RunCheckpointV1,
  RunRecord,
  RunResult,
} from "./types.js";
import { isPolicyOrApprovalFailure } from "./run-outcome.js";

export type TraceLevel = "minimal" | "standard" | "debug";
export type TraceRedactor = (event: SparkwrightEvent) => SparkwrightEvent;

export interface TraceRedactionOptions {
  replacement?: string;
  keyPatterns?: RegExp[];
  valuePatterns?: RegExp[];
  maxDepth?: number;
}

const DEFAULT_REDACTION_REPLACEMENT = "[redacted]";
const DEFAULT_REDACTION_MAX_DEPTH = 12;
const DEFAULT_REDACTED_KEY_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /bearer/i,
  /credential/i,
  /password/i,
  /secret/i,
  /^token$/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /client[_-]?secret/i,
  /auth[_-]?token/i,
  /refresh[_-]?token/i,
];
const DEFAULT_REDACTED_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\bghp_[A-Za-z0-9]{36,}\b/g,
  /\bgho_[A-Za-z0-9]{36,}\b/g,
  /\bghs_[A-Za-z0-9]{36,}\b/g,
  /\bghu_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{59,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
];

export function serializeEventJsonl(event: SparkwrightEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** @internal Reference `TraceSink` backed by an in-memory array. */
export class MemoryTrace implements TraceSink {
  private readonly lines: string[] = [];

  append(event: SparkwrightEvent): void {
    this.lines.push(serializeEventJsonl(event));
  }

  /** TraceSink alias for `append`. */
  write(event: SparkwrightEvent): void {
    this.append(event);
  }

  toString(): string {
    return this.lines.join("");
  }
}

export interface TraceSummary {
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  eventCount: number;
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  runIds: string[];
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  sessionIds: string[];
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  agentIds: string[];
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  byType: Record<string, number>;
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  terminalStates: Record<string, number>;
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  toolCalls: Record<string, number>;
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  artifactCount: number;
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  errorCount: number;
  /** @reserved Public trace-summary field consumed by diagnostics UIs. */
  errorCodes: Record<string, number>;
  /** @reserved Public trace-summary field consumed by diagnostics UIs. */
  expectedDenialCount: number;
  /** @reserved Public trace-summary field consumed by diagnostics UIs. */
  expectedDenialCodes: Record<string, number>;
  /** @reserved Public trace-summary field consumed by analytics UIs. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    costStatus?: "estimated" | "unavailable" | "partial";
    costUnavailableReasons?: Record<string, number>;
  };
}

export async function summarizeTraceFile(path: string): Promise<TraceSummary> {
  return summarizeTraceJsonl(await readFile(path, "utf8"));
}

export interface TraceEventFilter {
  type?: string;
  runId?: string;
  contains?: string;
}

export type TraceTimelinePhaseCategory =
  | "run"
  | "model"
  | "tool"
  | "approval"
  | "workspace"
  | "validation"
  | "context"
  | "task"
  | "artifact"
  | "other";

export type TraceTimelinePhaseStatus =
  | "pending"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  | "instant";

export interface TraceTimelinePhase {
  /** @reserved Public timeline field consumed by trace viewers. */
  id: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  runId: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  agentId?: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  category: TraceTimelinePhaseCategory;
  /** @reserved Public timeline field consumed by trace viewers. */
  label: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  status: TraceTimelinePhaseStatus;
  /** @reserved Public timeline field consumed by trace viewers. */
  startedAt: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  endedAt?: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  durationMs?: number;
  /** @reserved Public timeline field consumed by trace viewers. */
  startSequence: number;
  /** @reserved Public timeline field consumed by trace viewers. */
  endSequence?: number;
  /** @reserved Public timeline field consumed by trace viewers. */
  eventTypes: string[];
  /** @reserved Public timeline field consumed by trace viewers. */
  metadata?: Record<string, unknown>;
}

export interface TraceTimeline {
  /** @reserved Public timeline field consumed by trace viewers. */
  eventCount: number;
  /** @reserved Public timeline field consumed by trace viewers. */
  runIds: string[];
  /** @reserved Public timeline field consumed by trace viewers. */
  sessionIds: string[];
  /** @reserved Public timeline field consumed by trace viewers. */
  agentIds: string[];
  /** @reserved Public timeline field consumed by trace viewers. */
  startedAt?: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  endedAt?: string;
  /** @reserved Public timeline field consumed by trace viewers. */
  durationMs?: number;
  /** @reserved Public timeline field consumed by trace viewers. */
  phases: TraceTimelinePhase[];
}

export async function loadTraceEventsFile(
  path: string,
  filter: TraceEventFilter = {},
): Promise<SparkwrightEvent[]> {
  return loadTraceEventsJsonl(await readFile(path, "utf8"), filter);
}

export function loadTraceEventsJsonl(
  jsonl: string,
  filter: TraceEventFilter = {},
): SparkwrightEvent[] {
  return parseTraceJsonl(jsonl, "trace.jsonl").filter((event) =>
    matchesTraceEventFilter(event, filter),
  );
}

export async function buildTraceTimelineFile(
  path: string,
  filter: TraceEventFilter = {},
): Promise<TraceTimeline> {
  return buildTraceTimelineJsonl(await readFile(path, "utf8"), filter);
}

export interface TraceVerificationFinding {
  severity: "error" | "warning";
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface TraceVerificationReport {
  ok: boolean;
  path?: string;
  eventCount: number;
  runIds: string[];
  sessionIds: string[];
  agentIds: string[];
  findings: TraceVerificationFinding[];
}

export async function verifyTraceFile(
  path: string,
): Promise<TraceVerificationReport> {
  return verifyTraceJsonl(await readFile(path, "utf8"), { path });
}

export function verifyTraceJsonl(
  jsonl: string,
  options: { path?: string } = {},
): TraceVerificationReport {
  const findings: TraceVerificationFinding[] = [];
  if (jsonl.length > 0 && !jsonl.endsWith("\n")) {
    findings.push({
      severity: "error",
      code: "TRACE_FINAL_NEWLINE_MISSING",
      message:
        "Trace JSONL does not end with a newline; the final event may be half-written.",
    });
  }

  let events: SparkwrightEvent[] = [];
  try {
    events = parseTraceJsonl(jsonl, options.path ?? "trace.jsonl");
  } catch (error) {
    findings.push({
      severity: "error",
      code: "TRACE_JSON_INVALID",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const runIds = new Set<string>();
  const sessionIds = new Set<string>();
  const agentIds = new Set<string>();
  const sequencesByRun = new Map<string, number>();
  const terminalCountByRun = new Map<string, number>();
  const writeCountsByRun = new Map<
    string,
    { requested: number; completed: number; denied: number; skipped: number }
  >();
  const approvalCountsByRun = new Map<
    string,
    { requested: number; resolved: number }
  >();
  const artifactIds = new Set<string>();
  let previousMonotonicUs: number | undefined;

  for (const [index, event] of events.entries()) {
    const line = index + 1;
    if (!event || typeof event !== "object") {
      findings.push({
        severity: "error",
        code: "TRACE_EVENT_INVALID",
        message: "Trace line is not an event object.",
        metadata: { line },
      });
      continue;
    }
    if (typeof event.runId !== "string" || event.runId.length === 0) {
      findings.push({
        severity: "error",
        code: "TRACE_RUN_ID_MISSING",
        message: "Trace event is missing runId.",
        metadata: { line },
      });
      continue;
    }
    runIds.add(event.runId);
    const sessionId = stringMetadata(event.metadata, "sessionId");
    const agentId = stringMetadata(event.metadata, "agentId");
    if (sessionId) sessionIds.add(sessionId);
    if (agentId) agentIds.add(agentId);

    if (typeof event.sequence !== "number") {
      findings.push({
        severity: "error",
        code: "TRACE_SEQUENCE_MISSING",
        message: "Trace event is missing numeric sequence.",
        metadata: { line, runId: event.runId },
      });
    } else {
      const expected = (sequencesByRun.get(event.runId) ?? 0) + 1;
      if (event.sequence !== expected) {
        findings.push({
          severity: "error",
          code: "TRACE_SEQUENCE_INVALID",
          message: "Run event sequence must increase by one.",
          metadata: {
            line,
            runId: event.runId,
            expected,
            actual: event.sequence,
          },
        });
      }
      sequencesByRun.set(event.runId, observedSequenceEnd(event));
    }

    if (typeof event.monotonicUs === "number") {
      if (
        previousMonotonicUs !== undefined &&
        event.monotonicUs < previousMonotonicUs
      ) {
        findings.push({
          severity: "error",
          code: "TRACE_MONOTONIC_ORDER_INVALID",
          message: "monotonicUs moved backward in file order.",
          metadata: {
            line,
            previous: previousMonotonicUs,
            actual: event.monotonicUs,
          },
        });
      }
      previousMonotonicUs = event.monotonicUs;
    }

    if (isTerminalRunEvent(event)) {
      terminalCountByRun.set(
        event.runId,
        (terminalCountByRun.get(event.runId) ?? 0) + 1,
      );
    }
    collectWriteVerificationCounts(writeCountsByRun, event);
    collectApprovalVerificationCounts(approvalCountsByRun, event);
    collectArtifactVerificationFindings(artifactIds, event, findings, line);
  }

  if (sessionIds.size > 1) {
    findings.push({
      severity: "error",
      code: "TRACE_SESSION_ID_CONFLICT",
      message: "Trace contains events for multiple session ids.",
      metadata: { sessionIds: [...sessionIds].sort() },
    });
  }

  for (const runId of runIds) {
    const terminalCount = terminalCountByRun.get(runId) ?? 0;
    if (terminalCount !== 1) {
      findings.push({
        severity: "error",
        code: "TRACE_TERMINAL_EVENT_COUNT_INVALID",
        message:
          "Each run in a completed trace must have exactly one terminal event.",
        metadata: { runId, terminalCount },
      });
    }
  }

  for (const [runId, counts] of writeCountsByRun) {
    const terminalWrites = counts.completed + counts.denied + counts.skipped;
    if (terminalWrites > counts.requested) {
      findings.push({
        severity: "error",
        code: "TRACE_WORKSPACE_WRITE_PAIR_INVALID",
        message: "Workspace write terminal events exceed write requests.",
        metadata: { runId, ...counts },
      });
    }
  }

  for (const [runId, counts] of approvalCountsByRun) {
    if (counts.resolved > counts.requested) {
      findings.push({
        severity: "error",
        code: "TRACE_APPROVAL_PAIR_INVALID",
        message: "Approval resolutions exceed approval requests.",
        metadata: { runId, ...counts },
      });
    }
  }

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    path: options.path,
    eventCount: events.length,
    runIds: [...runIds].sort(),
    sessionIds: [...sessionIds].sort(),
    agentIds: [...agentIds].sort(),
    findings,
  };
}

export function buildTraceTimelineJsonl(
  jsonl: string,
  filter: TraceEventFilter = {},
): TraceTimeline {
  return buildTraceTimeline(loadTraceEventsJsonl(jsonl, filter));
}

export function buildTraceTimeline(events: SparkwrightEvent[]): TraceTimeline {
  const sorted = [...events].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence,
  );
  const runIds = new Set<string>();
  const sessionIds = new Set<string>();
  const agentIds = new Set<string>();
  const open = new Map<string, TraceTimelinePhase>();
  const phases: TraceTimelinePhase[] = [];

  for (const event of sorted) {
    runIds.add(event.runId);
    const sessionId = stringMetadata(event.metadata, "sessionId");
    const agentId = stringMetadata(event.metadata, "agentId");
    if (sessionId) sessionIds.add(sessionId);
    if (agentId) agentIds.add(agentId);
    if (isTimelineDetailEvent(event)) continue;

    const key = timelinePhaseKey(event);
    const terminal = terminalTimelineStatus(event);
    if (key && terminal) {
      const phase = open.get(key);
      if (phase) {
        completeTimelinePhase(phase, event, terminal);
        open.delete(key);
        continue;
      }
    }
    if (terminal && event.type === "model.completed") {
      const fallbackKey = latestOpenModelPhaseKey(open, event.runId);
      if (fallbackKey) {
        const phase = open.get(fallbackKey);
        if (phase) {
          completeTimelinePhase(phase, event, terminal);
          open.delete(fallbackKey);
          continue;
        }
      }
    }

    const existing = key ? open.get(key) : undefined;
    if (existing) {
      existing.eventTypes = [...existing.eventTypes, event.type];
      continue;
    }

    const phase = createTimelinePhase(event, key !== undefined);
    phases.push(phase);
    if (key && phase.status === "pending") open.set(key, phase);
  }

  const startedAt = sorted.at(0)?.timestamp;
  const endedAt = sorted.at(-1)?.timestamp;
  return {
    eventCount: sorted.length,
    runIds: [...runIds].sort(),
    sessionIds: [...sessionIds].sort(),
    agentIds: [...agentIds].sort(),
    startedAt,
    endedAt,
    durationMs:
      startedAt && endedAt
        ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
        : undefined,
    phases,
  };
}

export function summarizeTraceJsonl(jsonl: string): TraceSummary {
  const runIds = new Set<string>();
  const sessionIds = new Set<string>();
  const agentIds = new Set<string>();
  const byType: Record<string, number> = {};
  const terminalStates: Record<string, number> = {};
  const toolCalls: Record<string, number> = {};
  const errorCodes: Record<string, number> = {};
  const expectedDenialCodes: Record<string, number> = {};
  const latestUsageByRun = new Map<string, Record<string, unknown>>();
  let modelUsageSeen = false;
  const summary: TraceSummary = {
    eventCount: 0,
    runIds: [],
    sessionIds: [],
    agentIds: [],
    byType,
    terminalStates,
    toolCalls,
    artifactCount: 0,
    errorCount: 0,
    errorCodes,
    expectedDenialCount: 0,
    expectedDenialCodes,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    },
  };

  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    let event: SparkwrightEvent;
    try {
      event = JSON.parse(line) as SparkwrightEvent;
    } catch (cause) {
      throw new Error(`Invalid trace event JSON at line ${index + 1}`, {
        cause,
      });
    }

    summary.eventCount += 1;
    runIds.add(String(event.runId));
    byType[event.type] = (byType[event.type] ?? 0) + 1;

    const sessionId = stringMetadata(event.metadata, "sessionId");
    const agentId = stringMetadata(event.metadata, "agentId");
    if (sessionId) sessionIds.add(sessionId);
    if (agentId) agentIds.add(agentId);
    if (event.type === "artifact.created") summary.artifactCount += 1;
    if (isExpectedDenialEvent(event)) {
      summary.expectedDenialCount += 1;
      collectExpectedDenialCode(summary, event);
    } else if (isTraceErrorEvent(event)) {
      summary.errorCount += 1;
      collectErrorCode(summary, event);
    }

    collectTerminalState(summary, event);
    collectToolCall(summary, event);
    if (event.type === "usage.updated") {
      const usage = usageFromEvent(event);
      if (usage)
        latestUsageByRun.set(String(event.runId), usageToSummary(usage));
    } else {
      modelUsageSeen = collectUsage(summary, event) || modelUsageSeen;
    }
  }

  if (!modelUsageSeen) {
    for (const usage of latestUsageByRun.values()) {
      addUsage(summary, usage);
    }
  }

  summary.runIds = [...runIds].sort();
  summary.sessionIds = [...sessionIds].sort();
  summary.agentIds = [...agentIds].sort();
  return summary;
}

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

export interface FileRunStoreOptions {
  rootDir?: string;
  sessionRootDir?: string;
  sessionId?: string;
  agentId?: string;
  traceLevel?: TraceLevel;
  redactor?: TraceRedactor;
  redact?: boolean;
  /**
   * When a disk append fails (ENOSPC / EROFS / permissions), keep the event
   * in an in-memory ring buffer instead of throwing. The runtime's own error
   * tolerance (see "tolerates runStore errors without breaking the run") will
   * still log; this buffer additionally lets a future successful append flush
   * the missed events so the on-disk trace is eventually consistent. Set to
   * `0` to disable buffering (legacy behavior: errors propagate).
   *
   * Default: 1000 events.
   */
  degradationBufferLimit?: number;
  /**
   * Invoked when an append fails and the event is buffered (or dropped due
   * to overflow). Embedders can use this to emit a `storage.degraded`
   * notification through their own event channel — the store itself never
   * synthesizes events.
   */
  onAppendError?: (info: {
    error: unknown;
    event: SparkwrightEvent;
    bufferedCount: number;
    droppedCount: number;
  }) => void;
  /**
   * Invoked exactly once each time the in-memory degradation buffer is
   * fully drained back to disk after a prior failure. Pairs with
   * `onAppendError` so embedders can emit a matching `storage.recovered`
   * follow-up to whatever `storage.degraded` they already emitted.
   */
  onDrainSuccess?: (info: {
    flushedCount: number;
    droppedCount: number;
  }) => void;
}

export interface SessionFileRunStoreFactoryOptions extends Omit<
  FileRunStoreOptions,
  "rootDir" | "sessionId"
> {
  /**
   * Session identity supplied by the embedder, gateway, or host protocol.
   * This is routing identity, not a trace/span id.
   */
  sessionId: string;
}

/**
 * Create the standard session-scoped file store factory for `createRun`.
 *
 * This keeps product shells from hand-rolling the session trace layout and
 * accidentally diverging on session/run/agent identity rules.
 */
export function createSessionFileRunStoreFactory(
  options: SessionFileRunStoreFactoryOptions,
): (run: RunRecord) => FileRunStore {
  return (run) =>
    new FileRunStore(run, {
      ...options,
      sessionId: options.sessionId,
    });
}

/**
 * Running state for collapsing one stream's `model.stream.chunk` events into a
 * single `model.stream.text` timing marker. Identity (id/sequence/traceId/span)
 * is taken from the FIRST chunk so the merged event sorts in place of the chunk
 * run; timing spans first → last chunk. The streamed *text* itself is NOT
 * accumulated here — it is already carried by the terminal `model.completed`
 * event, so this marker holds only telemetry (chunk count + TTFT/duration) to
 * avoid serializing the full answer twice.
 */
interface StreamTimingAccumulator {
  chunkCount: number;
  firstEventId: SparkwrightEvent["id"];
  firstSequence: number;
  firstTimestamp: string;
  firstMonotonicUs?: number;
  lastTimestamp: string;
  lastMonotonicUs?: number;
  traceId: SparkwrightEvent["traceId"];
  spanId: SparkwrightEvent["spanId"];
  parentSpanId: SparkwrightEvent["parentSpanId"];
  metadata: Record<string, unknown>;
}

/**
 * @internal Reference `RunStore` persisting JSONL traces + artifacts. Legacy
 * mode writes `.sparkwright/runs/<run-id>/`; session mode writes aggregate
 * traces plus per-agent traces under `.sparkwright/sessions/<session-id>/`.
 * Prefer the `RunStore` interface when extending.
 */
export class FileRunStore implements RunStore {
  readonly runDir: string;
  readonly artifactsDir: string;
  readonly tracePath: string;
  readonly resultPath: string;
  readonly traceLevel: TraceLevel;
  readonly sessionDir?: string;
  readonly sessionTracePath?: string;
  readonly transcriptPath?: string;
  readonly blobsDir?: string;
  readonly agentId?: string;
  readonly agentDir?: string;
  readonly agentTracePath?: string;
  readonly agentTranscriptPath?: string;
  private readonly rootDir: string;
  private readonly redactor?: TraceRedactor;
  private readonly redactArtifacts: boolean;
  private readonly sessionId?: string;
  private readonly degradationBufferLimit: number;
  private readonly onAppendError?: FileRunStoreOptions["onAppendError"];
  private readonly onDrainSuccess?: FileRunStoreOptions["onDrainSuccess"];
  private readonly degradedBuffer: SparkwrightEvent[] = [];
  private droppedDuringDegradation = 0;
  private hasBeenDegraded = false;
  // Hashes of leading system prefixes already written in full to the
  // transcript. The system prefix is regenerated identically on every model
  // call (and never read back to rebuild a prompt), so we store it once and
  // let later prompt entries reference it by hash instead of repeating it.
  private readonly seenSystemHashes = new Set<string>();
  // Per-run streaming-timing accumulation. At non-debug trace levels we
  // suppress the high-frequency `model.stream.chunk` events and emit one
  // `model.stream.text` timing marker per stream instead (see writeEventToDisk).
  // Keyed by runId because a run's steps stream sequentially (started → chunks →
  // completed); a new `model.stream.started` resets the slot.
  private readonly streamAccumulators = new Map<
    string,
    StreamTimingAccumulator
  >();

  constructor(run: RunRecord, options: FileRunStoreOptions = {}) {
    if (options.sessionId !== undefined) {
      assertSafePathSegment(options.sessionId, "session id");
    }
    const rootDir =
      options.sessionId !== undefined
        ? (options.sessionRootDir ?? ".sparkwright/sessions")
        : (options.rootDir ?? ".sparkwright/runs");
    this.rootDir = rootDir;
    this.traceLevel = options.traceLevel ?? "standard";
    this.redactor =
      options.redactor ??
      (options.redact === false ? undefined : createTraceRedactor());
    this.redactArtifacts = options.redact !== false;
    this.sessionId = options.sessionId;
    this.degradationBufferLimit = options.degradationBufferLimit ?? 1000;
    this.onAppendError = options.onAppendError;
    this.onDrainSuccess = options.onDrainSuccess;

    if (options.sessionId !== undefined) {
      const agentId =
        options.agentId ?? stringMetadata(run.metadata, "agentId") ?? "main";
      assertSafePathSegment(agentId, "agent id");
      this.agentId = agentId;
      this.sessionDir = join(rootDir, options.sessionId);
      this.sessionTracePath = join(this.sessionDir, "trace.jsonl");
      this.transcriptPath = join(this.sessionDir, "transcript.jsonl");
      this.blobsDir = join(this.sessionDir, "blobs");
      this.agentDir = join(this.sessionDir, "agents", agentId);
      this.agentTracePath = join(this.agentDir, "trace.jsonl");
      this.agentTranscriptPath = join(this.agentDir, "transcript.jsonl");
      this.runDir = join(this.agentDir, "runs", run.id);
      this.artifactsDir = join(this.sessionDir, "artifacts");
      this.tracePath = this.sessionTracePath;
    } else {
      this.runDir = join(rootDir, run.id);
      this.artifactsDir = join(this.runDir, "artifacts");
      this.tracePath = join(this.runDir, "trace.jsonl");
    }

    this.resultPath = join(this.runDir, "result.json");

    mkdirSync(this.artifactsDir, { recursive: true });
    if (this.sessionDir) {
      mkdirSync(this.blobsDir!, { recursive: true });
      mkdirSync(this.agentDir!, { recursive: true });
      writeIfMissing(this.sessionTracePath!, "");
      writeIfMissing(this.transcriptPath!, "");
      writeIfMissing(this.agentTracePath!, "");
      writeIfMissing(this.agentTranscriptPath!, "");
      this.writeSessionRecord(run);
      this.writeAgentRecord(run);
    } else {
      writeIfMissing(this.tracePath, "");
    }
    mkdirSync(this.runDir, { recursive: true });
    // Never overwrite an existing run.json: re-opening a `FileRunStore`
    // for replay/loadEvents/SessionRunStore's lazy inner-store path used
    // to clobber a finished `run.json` back to a stale `running` status,
    // leaving result.json and run.json on disk in conflicting states.
    // The state machine still rewrites run.json on `finish()` for the
    // legitimate completion path.
    writeIfMissing(
      join(this.runDir, "run.json"),
      `${JSON.stringify(run, null, 2)}\n`,
    );
  }

  append(event: SparkwrightEvent): void {
    try {
      // Best-effort flush of any events buffered during a prior outage.
      // If the disk is still down this will throw and the new event lands
      // in the buffer alongside them, preserving order.
      this.drainDegradedBufferIfAny();
      this.writeEventToDisk(event);
    } catch (cause) {
      if (this.degradationBufferLimit <= 0) {
        throw cause;
      }
      this.bufferDegradedEvent(event, cause);
      return;
    }

    if (event.type === "artifact.created") {
      this.materializeArtifact(event.payload as Artifact);
    }
  }

  private writeEventToDisk(event: SparkwrightEvent): void {
    // Collapse high-frequency stream chunks into a single synthesized
    // `model.stream.text` per stream at non-debug levels: buffer each
    // text_delta, suppress the individual chunk, and flush the merged event
    // when the stream terminates. `debug` keeps raw chunks for token-level
    // analysis.
    if (this.traceLevel !== "debug") {
      switch (event.type) {
        case "model.stream.started":
          // A fresh stream for this run — drop any orphaned accumulator (e.g.
          // a prior stream that crashed before terminating) and fall through
          // to persist the `started` event normally.
          this.streamAccumulators.delete(event.runId);
          break;
        case "model.stream.chunk":
          this.accumulateStreamChunk(event);
          return; // not persisted individually
        case "model.stream.completed":
        case "model.stream.failed":
        case "model.stream.timeout":
          // Write the merged text event (if any) just before the terminal
          // event so file order reads started → text → completed.
          this.flushStreamText(event);
          break;
        default:
          break;
      }
    }

    const traceEvent = this.prepareTraceEvent(event);
    appendFileSync(this.tracePath, serializeEventJsonl(traceEvent), "utf8");
    if (this.agentTracePath) {
      appendFileSync(
        this.agentTracePath,
        serializeEventJsonl(traceEvent),
        "utf8",
      );
    }
    this.appendTranscriptEvent(this.prepareTranscriptEvent(event));
  }

  private accumulateStreamChunk(event: SparkwrightEvent): void {
    // We no longer concatenate the streamed text here — the full answer is
    // already carried by the terminal `model.completed`. Every
    // chunk (text-delta, tool-call, usage, stop) still bumps the count and
    // extends the stream's time span so the marker reports TTFT/duration.
    const existing = this.streamAccumulators.get(event.runId);
    if (!existing) {
      this.streamAccumulators.set(event.runId, {
        chunkCount: 1,
        firstEventId: event.id,
        firstSequence: event.sequence,
        firstTimestamp: event.timestamp,
        firstMonotonicUs: event.monotonicUs,
        lastTimestamp: event.timestamp,
        lastMonotonicUs: event.monotonicUs,
        traceId: event.traceId,
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        metadata: event.metadata ?? {},
      });
      return;
    }
    existing.chunkCount += 1;
    existing.lastTimestamp = event.timestamp;
    existing.lastMonotonicUs = event.monotonicUs;
  }

  private flushStreamText(terminal: SparkwrightEvent): void {
    const acc = this.streamAccumulators.get(terminal.runId);
    if (!acc) return;
    // Clear before writing: if the append throws (disk outage) the terminal
    // event is buffered and replayed, but the timing marker must not be emitted
    // twice. The full output text still lands on `model.completed`, so the only
    // loss in that rare path is the TTFT/duration telemetry.
    this.streamAccumulators.delete(terminal.runId);
    const step =
      isRecord(terminal.payload) && typeof terminal.payload.step === "number"
        ? terminal.payload.step
        : undefined;
    const streamDurationUs =
      acc.firstMonotonicUs !== undefined && acc.lastMonotonicUs !== undefined
        ? acc.lastMonotonicUs - acc.firstMonotonicUs
        : undefined;
    const merged: SparkwrightEvent = {
      id: acc.firstEventId,
      runId: terminal.runId,
      type: "model.stream.text",
      timestamp: acc.lastTimestamp,
      sequence: acc.firstSequence,
      monotonicUs: acc.lastMonotonicUs,
      traceId: acc.traceId,
      spanId: acc.spanId,
      parentSpanId: acc.parentSpanId,
      payload: {
        step,
        chunkCount: acc.chunkCount,
        firstTokenAt: acc.firstTimestamp,
        lastTokenAt: acc.lastTimestamp,
        firstTokenMonotonicUs: acc.firstMonotonicUs,
        lastTokenMonotonicUs: acc.lastMonotonicUs,
        streamDurationUs,
      },
      metadata: acc.metadata,
    };
    const traceEvent = this.prepareTraceEvent(merged);
    appendFileSync(this.tracePath, serializeEventJsonl(traceEvent), "utf8");
    if (this.agentTracePath) {
      appendFileSync(
        this.agentTracePath,
        serializeEventJsonl(traceEvent),
        "utf8",
      );
    }
  }

  private bufferDegradedEvent(event: SparkwrightEvent, error: unknown): void {
    if (this.degradedBuffer.length >= this.degradationBufferLimit) {
      // Drop the oldest to make room — keep most recent context, which is
      // generally more useful for diagnosing the outage than the earliest
      // queued events.
      this.degradedBuffer.shift();
      this.droppedDuringDegradation += 1;
    }
    this.degradedBuffer.push(event);
    this.hasBeenDegraded = true;
    this.onAppendError?.({
      error,
      event,
      bufferedCount: this.degradedBuffer.length,
      droppedCount: this.droppedDuringDegradation,
    });
  }

  private drainDegradedBufferIfAny(): void {
    if (this.degradedBuffer.length === 0) return;
    // Move events out before writing so a mid-drain failure doesn't infinite-
    // loop us. Anything that fails goes back to the head of the buffer.
    const pending = this.degradedBuffer.splice(0, this.degradedBuffer.length);
    const initialCount = pending.length;
    for (let i = 0; i < pending.length; i += 1) {
      try {
        this.writeEventToDisk(pending[i]);
      } catch (cause) {
        // Re-queue the failed event plus everything after it, preserve order.
        this.degradedBuffer.unshift(...pending.slice(i));
        throw cause;
      }
    }
    // Drain succeeded fully. Notify exactly once per recovery (only if we
    // were previously degraded — first-ever drain of an empty buffer is
    // guarded by the length check at top).
    if (this.hasBeenDegraded) {
      this.hasBeenDegraded = false;
      const droppedCount = this.droppedDuringDegradation;
      this.droppedDuringDegradation = 0;
      this.onDrainSuccess?.({ flushedCount: initialCount, droppedCount });
    }
  }

  /**
   * Number of events currently held in the degradation buffer (i.e. trace
   * appends that failed and have not yet been flushed). Exposed for tests
   * and host diagnostics; production callers usually just consume the
   * `onAppendError` callback.
   */
  get degradedBufferSize(): number {
    return this.degradedBuffer.length;
  }

  finish(run: RunRecord, result: RunResult): void {
    atomicWriteFileSync(
      join(this.runDir, "run.json"),
      `${JSON.stringify(run, null, 2)}\n`,
    );
    atomicWriteFileSync(
      this.resultPath,
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }

  /**
   * Path to the latest persisted checkpoint, if any. Pair with
   * {@link loadCheckpointFromRunDir} to read back from disk.
   */
  get checkpointPath(): string {
    return join(this.runDir, "checkpoint.json");
  }

  /**
   * Atomically persist a {@link RunCheckpointV1} alongside the run's
   * trace/result. Called by the runtime through `RunHandle.persistCheckpoint`
   * (and the optional auto-checkpoint loop), but is safe to call directly
   * from host code as well — overwrites the previous snapshot.
   */
  saveCheckpoint(checkpoint: RunCheckpointV1): void {
    atomicWriteFileSync(
      this.checkpointPath,
      `${JSON.stringify(checkpoint, null, 2)}\n`,
    );
  }

  async *loadEvents(runId: RunRecord["id"]): AsyncIterable<SparkwrightEvent> {
    const trace = await readFile(
      this.sessionId
        ? join(this.rootDir, this.sessionId, "trace.jsonl")
        : join(this.rootDir, runId, "trace.jsonl"),
      "utf8",
    );

    for (const [index, line] of trace.split(/\r?\n/).entries()) {
      if (line.trim() === "") continue;

      try {
        const event = JSON.parse(line) as SparkwrightEvent;
        if (!this.sessionId || event.runId === runId) yield event;
      } catch (cause) {
        throw new Error(
          `Invalid trace event JSON in ${runId} at line ${index + 1}`,
          { cause },
        );
      }
    }
  }

  private prepareTraceEvent(event: SparkwrightEvent): SparkwrightEvent {
    const eventWithIdentity = this.addStoreIdentity(event);
    const filtered = filterTraceEvent(eventWithIdentity, this.traceLevel);
    return this.redactor ? this.redactor(filtered) : filtered;
  }

  private prepareTranscriptEvent(event: SparkwrightEvent): SparkwrightEvent {
    const eventWithIdentity = this.addStoreIdentity(event);
    return this.redactor ? this.redactor(eventWithIdentity) : eventWithIdentity;
  }

  private addStoreIdentity(event: SparkwrightEvent): SparkwrightEvent {
    const eventWithIdentity = this.sessionId
      ? {
          ...event,
          metadata: {
            ...event.metadata,
            sessionId: this.sessionId,
            agentId: this.agentId ?? "main",
          },
        }
      : event;
    return eventWithIdentity;
  }

  private materializeArtifact(artifact: Artifact): void {
    assertSafePathSegment(artifact.id, "artifact id");
    const prepared = this.redactArtifacts ? redactArtifact(artifact) : artifact;
    const extension = extensionForArtifact(artifact);
    const artifactPath = join(this.artifactsDir, `${artifact.id}${extension}`);
    const metadataPath = join(this.artifactsDir, `${artifact.id}.json`);

    atomicWriteFileSync(
      artifactPath,
      serializeArtifactContent(prepared.content),
    );
    atomicWriteFileSync(metadataPath, `${JSON.stringify(prepared, null, 2)}\n`);
  }

  private writeSessionRecord(run: RunRecord): void {
    if (!this.sessionDir || !this.sessionId) return;
    const sessionPath = join(this.sessionDir, "session.json");
    const now = new Date().toISOString();
    const existing = readJsonIfExists<Record<string, unknown>>(sessionPath);
    const existingRunIds = Array.isArray(existing?.runIds)
      ? existing.runIds.filter((id): id is string => typeof id === "string")
      : [];
    const existingAgents = Array.isArray(existing?.agents)
      ? existing.agents.filter((id): id is string => typeof id === "string")
      : [];
    const runIds = new Set(existingRunIds);
    runIds.add(run.id);
    const agents = new Set(existingAgents);
    agents.add(this.agentId ?? "main");

    // Spread `existing` first so unknown fields owned by another writer
    // (e.g. `FileSessionStore` maintaining `eventCount` + custom
    // metadata) survive a `FileRunStore` re-open. Only override the
    // fields this store actually owns. This is best-effort under
    // concurrent writers; truly safe coordination would need locking.
    const merged: Record<string, unknown> = {
      ...(existing ?? {}),
      id: this.sessionId,
      createdAt:
        typeof existing?.createdAt === "string"
          ? existing.createdAt
          : run.createdAt,
      updatedAt: now,
      runIds: [...runIds],
      agents: [...agents],
      metadata:
        existing?.metadata !== undefined ? existing.metadata : run.metadata,
    };
    atomicWriteFileSync(sessionPath, `${JSON.stringify(merged, null, 2)}\n`);
  }

  private writeAgentRecord(run: RunRecord): void {
    if (!this.agentDir) return;
    const agentPath = join(this.agentDir, "agent.json");
    const existing = readJsonIfExists<{
      id: string;
      sessionId?: string;
      createdAt: string;
      updatedAt: string;
      runIds: string[];
      metadata?: Record<string, unknown>;
    }>(agentPath);
    const runIds = new Set(existing?.runIds ?? []);
    runIds.add(run.id);
    atomicWriteFileSync(
      agentPath,
      `${JSON.stringify(
        {
          id: this.agentId ?? "main",
          sessionId: this.sessionId,
          createdAt: existing?.createdAt ?? run.createdAt,
          updatedAt: new Date().toISOString(),
          runIds: [...runIds],
          metadata: existing?.metadata ?? run.metadata,
        },
        null,
        2,
      )}\n`,
    );
  }

  private appendTranscriptEvent(event: SparkwrightEvent): void {
    if (!this.transcriptPath) return;
    let line = transcriptEntryForEvent(event, {
      sessionId: this.sessionId,
      agentId: this.agentId,
    });
    if (!line) return;
    if (line.type === "prompt") {
      line = this.dedupPromptSystemPrefix(line);
    }
    appendFileSync(this.transcriptPath, `${JSON.stringify(line)}\n`, "utf8");
    if (this.agentTranscriptPath) {
      appendFileSync(
        this.agentTranscriptPath,
        `${JSON.stringify(line)}\n`,
        "utf8",
      );
    }
  }

  /**
   * Collapse the leading `system` prefix of a transcript `prompt` entry into a
   * `systemRef`. The prefix itself is written once to `blobs/<hash>.json` and
   * every entry — including the first occurrence — only carries the reference,
   * so a prefix that repeats across runs, agents, and process restarts is
   * stored exactly once per session. Rehydrate with
   * {@link restoreTranscriptPrompts} passing the session `blobs/` dir.
   */
  private dedupPromptSystemPrefix(
    line: Record<string, unknown>,
  ): Record<string, unknown> {
    // Without a blob store there is nowhere to rehydrate a stripped prefix
    // from, so leave the entry self-contained.
    if (!this.blobsDir) return line;
    const messages = line.messages;
    if (!Array.isArray(messages) || messages.length === 0) return line;
    const prefix = leadingSystemPrefix(messages as PromptMessage[]);
    if (prefix.length === 0) return line;
    const hash = hashSystemPrefix(prefix);
    this.ensureSystemPrefixBlob(hash, prefix);
    return {
      ...line,
      systemRef: hash,
      systemPrefixLength: prefix.length,
      messages: (messages as PromptMessage[]).slice(prefix.length),
    };
  }

  /**
   * Persist a system prefix to `blobs/<hash>.json` if it isn't there yet. The
   * blob file's existence — not in-memory state — is the dedup signal, so this
   * stays correct across the per-run `FileRunStore` instances a session
   * creates. `seenSystemHashes` only memoizes the existence check to avoid a
   * repeated `stat` on every step within one instance.
   */
  private ensureSystemPrefixBlob(hash: string, prefix: PromptMessage[]): void {
    if (this.seenSystemHashes.has(hash)) return;
    const blobPath = join(this.blobsDir!, `${hash}.json`);
    if (!existsSync(blobPath)) {
      atomicWriteFileSync(blobPath, `${JSON.stringify(prefix, null, 2)}\n`);
    }
    this.seenSystemHashes.add(hash);
  }
}

/** The contiguous run of leading `system` messages at the head of a prompt. */
function leadingSystemPrefix(messages: PromptMessage[]): PromptMessage[] {
  const prefix: PromptMessage[] = [];
  for (const message of messages) {
    if (message.role !== "system") break;
    prefix.push(message);
  }
  return prefix;
}

function hashSystemPrefix(prefix: PromptMessage[]): string {
  return createHash("sha256")
    .update(JSON.stringify(prefix))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Read a system-prefix blob written by {@link FileRunStore.ensureSystemPrefixBlob}.
 * Returns `undefined` (not a throw) when the blob is absent or malformed so
 * rehydration degrades to "prefix unknown" rather than failing the whole load.
 */
function readSystemPrefixBlob(
  blobsDir: string,
  hash: string,
): PromptMessage[] | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(blobsDir, `${hash}.json`), "utf8"),
    );
    return Array.isArray(parsed) ? (parsed as PromptMessage[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rehydrate transcript entries produced by {@link FileRunStore}: any `prompt`
 * entry carrying a `systemRef` gets its system prefix prepended back onto
 * `messages`. The prefix is resolved (in order of preference) from an earlier
 * inline `systemHash` entry in the same list — the legacy self-contained form —
 * or from `blobs/<hash>.json` under `options.blobsDir`, which is where current
 * transcripts store every prefix. Entries are returned in input order; non
 * `prompt` entries pass through untouched.
 */
export function restoreTranscriptPrompts(
  entries: Record<string, unknown>[],
  options: { blobsDir?: string } = {},
): Record<string, unknown>[] {
  const prefixes = new Map<string, PromptMessage[]>();
  const resolvePrefix = (ref: string): PromptMessage[] => {
    const cached = prefixes.get(ref);
    if (cached) return cached;
    const prefix =
      (options.blobsDir
        ? readSystemPrefixBlob(options.blobsDir, ref)
        : undefined) ?? [];
    prefixes.set(ref, prefix);
    return prefix;
  };
  return entries.map((entry) => {
    if (entry.type !== "prompt") return entry;
    // Legacy self-contained form: the first occurrence stored the prefix inline
    // alongside its `systemHash`. Newer transcripts never do this.
    if (typeof entry.systemHash === "string" && Array.isArray(entry.messages)) {
      prefixes.set(
        entry.systemHash,
        leadingSystemPrefix(entry.messages as PromptMessage[]),
      );
      return entry;
    }
    if (typeof entry.systemRef === "string") {
      const prefix = resolvePrefix(entry.systemRef);
      const rest = Array.isArray(entry.messages)
        ? (entry.messages as PromptMessage[])
        : [];
      return { ...entry, messages: [...prefix, ...rest] };
    }
    return entry;
  });
}

function transcriptEntryForEvent(
  event: SparkwrightEvent,
  identity: { sessionId?: string; agentId?: string },
): Record<string, unknown> | undefined {
  if (!isRecord(event.payload)) return undefined;

  if (event.type === "prompt.built" && Array.isArray(event.payload.messages)) {
    return {
      type: "prompt",
      sessionId: identity.sessionId,
      agentId: identity.agentId ?? "main",
      runId: event.runId,
      step: event.payload.step,
      timestamp: event.timestamp,
      messages: event.payload.messages,
    };
  }

  if (event.type === "model.completed") {
    return {
      type: "assistant",
      sessionId: identity.sessionId,
      agentId: identity.agentId ?? "main",
      runId: event.runId,
      step: event.payload.step,
      timestamp: event.timestamp,
      message: event.payload.message,
      toolCalls: event.payload.toolCalls,
      usage: event.payload.usage,
      stopReason: event.payload.stopReason,
    };
  }

  if (event.type === "tool.completed" || event.type === "tool.failed") {
    return {
      type: "tool_result",
      sessionId: identity.sessionId,
      agentId: identity.agentId ?? "main",
      runId: event.runId,
      timestamp: event.timestamp,
      toolCallId: event.payload.toolCallId,
      status: event.payload.status,
      output: event.payload.output,
      error: event.payload.error,
      artifacts: event.payload.artifacts,
    };
  }

  return undefined;
}

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) atomicWriteFileSync(path, content);
}

function atomicWriteFileSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function readJsonIfExists<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export interface LoadCheckpointFromRunDirOptions {
  /**
   * When `checkpoint.json` is missing, attempt to reconstruct a minimal
   * `RunCheckpointV1` from `run.json` + `trace.jsonl`. The reconstructed
   * checkpoint is marked `resumability.complete = false` with a single
   * reason (`"reconstructed_from_trace"`) so {@link resumeRunFromCheckpoint}
   * refuses to use it unless the caller opts in with `force: true`.
   *
   * Tradeoff: trace replay only recovers append-only counters (model calls,
   * tool calls, tokens, cost) and a coarse step number. In-loop context is
   * lost; the resumed run starts with empty context. Use this as a
   * last-resort recovery path after a hard crash where no checkpoint was
   * persisted before the failure.
   */
  fallbackFromTrace?: boolean;
}

/**
 * Read back a previously-saved checkpoint from a run directory written by
 * {@link FileRunStore.saveCheckpoint}. Returns `undefined` when no checkpoint
 * file exists at that path (rather than throwing) so callers can fall back to
 * a cold start.
 *
 * With `{ fallbackFromTrace: true }`, missing `checkpoint.json` triggers a
 * best-effort reconstruction from `run.json` + `trace.jsonl`. The returned
 * checkpoint is marked non-fully-resumable; the caller must pass
 * `{ force: true }` to {@link resumeRunFromCheckpoint}.
 *
 * `runDir` accepts either an absolute or workspace-relative path; it matches
 * the layout used by both legacy `.sparkwright/runs/<id>/` and session-scoped
 * `.sparkwright/sessions/<sid>/agents/<aid>/runs/<id>/` directories.
 */
export function loadCheckpointFromRunDir(
  runDir: string,
  options: LoadCheckpointFromRunDirOptions = {},
): RunCheckpointV1 | undefined {
  const checkpointPath = join(runDir, "checkpoint.json");
  if (existsSync(checkpointPath)) {
    const raw = readFileSync(checkpointPath, "utf8");
    const parsed = JSON.parse(raw) as RunCheckpointV1;
    if (parsed.schemaVersion !== "run-checkpoint.v1") {
      throw new Error(
        `Unsupported checkpoint schema in ${checkpointPath}: ${(parsed as { schemaVersion?: string }).schemaVersion}`,
      );
    }
    return parsed;
  }
  if (!options.fallbackFromTrace) return undefined;
  return reconstructCheckpointFromTrace(runDir);
}

function reconstructCheckpointFromTrace(
  runDir: string,
): RunCheckpointV1 | undefined {
  const runJsonPath = join(runDir, "run.json");
  if (!existsSync(runJsonPath)) return undefined;
  const run = JSON.parse(readFileSync(runJsonPath, "utf8")) as RunRecord;

  // Session-scoped traces aggregate multiple runs; filter by runId.
  // For legacy per-run dirs the trace is at runDir/trace.jsonl. For session
  // layouts trace.jsonl lives at the agent or session level — we accept
  // either by trying the per-run path first, then walking up.
  const candidateTracePaths = [
    join(runDir, "trace.jsonl"),
    join(runDir, "..", "..", "trace.jsonl"), // agent-level
    join(runDir, "..", "..", "..", "..", "trace.jsonl"), // session-level
  ];
  const tracePath = candidateTracePaths.find((p) => existsSync(p));

  let stepSeen = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let tokens = 0;
  let costUsd = 0;
  let lastTimestampMs: number | undefined;
  let firstTimestampMs: number | undefined;

  if (tracePath) {
    const lines = readFileSync(tracePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (line.trim() === "") continue;
      let event: SparkwrightEvent;
      try {
        event = JSON.parse(line) as SparkwrightEvent;
      } catch {
        continue; // skip corrupt lines — best-effort
      }
      if (event.runId !== run.id) continue;
      const ts = Date.parse(event.timestamp);
      if (!Number.isNaN(ts)) {
        firstTimestampMs ??= ts;
        lastTimestampMs = ts;
      }
      const payload = (event.payload ?? {}) as {
        step?: number;
        usage?: { tokens?: number; costUsd?: number };
      };
      if (typeof payload.step === "number" && payload.step > stepSeen) {
        stepSeen = payload.step;
      }
      if (event.type === "model.completed") modelCalls += 1;
      if (event.type === "tool.completed" || event.type === "tool.failed") {
        toolCalls += 1;
      }
      if (event.type === "usage.updated" && payload.usage) {
        if (typeof payload.usage.tokens === "number")
          tokens = payload.usage.tokens;
        if (typeof payload.usage.costUsd === "number")
          costUsd = payload.usage.costUsd;
      }
    }
  }

  const elapsedMs =
    firstTimestampMs !== undefined && lastTimestampMs !== undefined
      ? lastTimestampMs - firstTimestampMs
      : 0;

  return {
    schemaVersion: "run-checkpoint.v1",
    run,
    loop: {
      // Resume on the step *after* the last one we saw evidence of, since
      // the loop iteration that emitted those events presumably completed.
      // When stepSeen is 0 (no model.completed found) start at 1.
      step: Math.max(1, stepSeen + 1),
      turnCount: stepSeen,
      context: [],
      repeatedToolCallCount: 0,
      transition: { reason: "next_turn" },
    },
    model: { activeIndex: 0, fallbackCount: 0 },
    recovery: { outputRecoveriesUsed: 0, maxOutputRecoveries: 3 },
    budget: {
      configured: undefined,
      usage: { elapsedMs, modelCalls, toolCalls, tokens, costUsd },
    },
    queues: {
      commandCount: 0,
      pendingPrefetch: false,
      pendingSummary: false,
    },
    resumability: {
      complete: false,
      reasons: ["reconstructed_from_trace"],
    },
    createdAt: new Date().toISOString(),
    metadata: {
      source: "reconstructed_from_trace",
      tracePath: tracePath ?? null,
      runJsonPath,
    },
  };
}

/**
 * Compose the two FileRunStore degradation callbacks into a pair of
 * `storage.degraded` / `storage.recovered` events on the supplied EventLog.
 *
 * Design notes:
 *  - `storage.degraded` is emitted at most once per degradation cycle (the
 *    first append failure after a clean state). Subsequent failures within
 *    the same cycle still call `onAppendError` directly but do NOT re-emit
 *    the event — that would flood the trace with the same signal.
 *  - The emitted event payload carries running `bufferedCount` / `droppedCount`
 *    so the host can render a progress indicator without subscribing to the
 *    raw callback.
 *  - `storage.recovered` is emitted exactly once per cycle when the buffer
 *    is fully flushed back to disk.
 *
 * Caller wires it like:
 *   const hooks = bindStorageDegradationEvents({ events: run.events });
 *   const store = new FileRunStore(run, { ...hooks });
 */
export function bindStorageDegradationEvents(input: {
  events: {
    emit: (type: SparkwrightEvent["type"], payload: unknown) => unknown;
  };
}): Pick<FileRunStoreOptions, "onAppendError" | "onDrainSuccess"> {
  let inDegradedCycle = false;
  let cycleStartedAtMs = 0;
  return {
    onAppendError: (info) => {
      if (!inDegradedCycle) {
        inDegradedCycle = true;
        cycleStartedAtMs = Date.now();
        input.events.emit("storage.degraded", {
          reason:
            info.error instanceof Error
              ? info.error.message
              : String(info.error),
          errorCode:
            info.error && typeof info.error === "object"
              ? (info.error as { code?: string }).code
              : undefined,
          bufferedCount: info.bufferedCount,
          droppedCount: info.droppedCount,
          firstFailedEventType: info.event.type,
        });
      }
    },
    onDrainSuccess: (info) => {
      if (inDegradedCycle) {
        inDegradedCycle = false;
        input.events.emit("storage.recovered", {
          flushedCount: info.flushedCount,
          droppedCount: info.droppedCount,
          degradedForMs: Date.now() - cycleStartedAtMs,
        });
      }
    },
  };
}

export function createTraceRedactor(
  options: TraceRedactionOptions = {},
): TraceRedactor {
  const replacement = options.replacement ?? DEFAULT_REDACTION_REPLACEMENT;
  const keyPatterns = options.keyPatterns ?? DEFAULT_REDACTED_KEY_PATTERNS;
  const valuePatterns =
    options.valuePatterns ?? DEFAULT_REDACTED_VALUE_PATTERNS;
  const maxDepth = options.maxDepth ?? DEFAULT_REDACTION_MAX_DEPTH;

  return (event) => ({
    ...event,
    payload: redactUnknown(event.payload, {
      replacement,
      keyPatterns,
      valuePatterns,
      maxDepth,
      depth: 0,
    }),
    metadata: redactUnknown(event.metadata, {
      replacement,
      keyPatterns,
      valuePatterns,
      maxDepth,
      depth: 0,
    }) as Record<string, unknown>,
  });
}

/**
 * True for high-frequency stream events that only carry value at `debug`
 * trace level. Callers that copy events to a UI / terminal SHOULD also
 * respect this so the persisted trace and the live event log stay aligned.
 */
export function isVerboseStreamEvent(event: SparkwrightEvent): boolean {
  return event.type === "model.stream.chunk";
}

export function filterTraceEvent(
  event: SparkwrightEvent,
  level: TraceLevel,
): SparkwrightEvent {
  if (level === "debug") return event;

  if (level === "minimal") {
    return {
      ...event,
      payload: minimalPayload(event),
    };
  }

  return {
    ...event,
    payload: standardPayload(event),
  };
}

function minimalPayload(event: SparkwrightEvent): unknown {
  if (isRecord(event.payload)) {
    switch (event.type) {
      case "model.requested":
        return pick(event.payload, ["step"]);
      case "model.completed":
        return {
          // Truthy on any populated message — providers may emit
          // either a string or a structured `{role, content}` object,
          // and "hasMessage" should reflect content presence, not
          // a specific schema shape.
          hasMessage:
            (typeof event.payload.message === "string" &&
              event.payload.message.length > 0) ||
            (isRecord(event.payload.message) &&
              Object.keys(event.payload.message).length > 0),
          toolCallCount: Array.isArray(event.payload.toolCalls)
            ? event.payload.toolCalls.length
            : 0,
          totalTokens: isRecord(event.payload.usage)
            ? event.payload.usage.totalTokens
            : undefined,
        };
      case "run.budget.checked":
        return pickNested(event.payload, ["stage"], {
          modelCalls: isRecord(event.payload.usage)
            ? event.payload.usage.modelCalls
            : undefined,
          toolCalls: isRecord(event.payload.usage)
            ? event.payload.usage.toolCalls
            : undefined,
        });
      case "context.compaction_requested":
        return pick(event.payload, ["step", "omittedCount", "reasons"]);
      case "validation.started":
      case "validation.completed":
      case "validation.failed":
        return pickNested(event.payload, ["hookName", "stage"], {
          status: isRecord(event.payload.result)
            ? event.payload.result.status
            : undefined,
          findingCount:
            isRecord(event.payload.result) &&
            Array.isArray(event.payload.result.findings)
              ? event.payload.result.findings.length
              : undefined,
        });
      case "tool.requested":
        return pick(event.payload, ["id", "toolName"]);
      case "tool.started":
        return pick(event.payload, ["toolCallId", "toolName"]);
      case "tool.completed":
      case "tool.failed":
        return pickNested(event.payload, ["toolCallId", "status"], {
          errorCode: isRecord(event.payload.error)
            ? event.payload.error.code
            : undefined,
          artifactCount: Array.isArray(event.payload.artifacts)
            ? event.payload.artifacts.length
            : 0,
        });
      case "approval.requested":
        return pick(event.payload, ["id", "action", "summary", "status"]);
      case "approval.resolved":
        return pick(event.payload, ["approvalId", "decision"]);
      case "artifact.created":
        return pick(event.payload, ["id", "type", "name", "path"]);
      case "workspace.read":
        return pick(event.payload, ["path"]);
      case "workspace.anchored_read":
        return pick(event.payload, ["path", "anchorSetId", "lineCount"]);
      case "workspace.anchored_edit.requested":
        return pickNested(event.payload, ["path", "reason"], {
          editCount: Array.isArray(event.payload.edits)
            ? event.payload.edits.length
            : undefined,
        });
      case "workspace.anchored_edit.verified":
        return pick(event.payload, ["path", "editCount"]);
      case "workspace.anchored_edit.rejected":
        return pickNested(event.payload, ["path", "reason"], {
          errorCode: isRecord(event.payload.error)
            ? event.payload.error.code
            : undefined,
        });
      case "workspace.write.requested":
        return pick(event.payload, ["id", "path", "reason"]);
      case "workspace.write.completed":
      case "workspace.write.denied":
      case "workspace.write.skipped":
        return pick(event.payload, ["proposalId", "path", "reason"]);
      case "run.failed":
        return pick(event.payload, ["code", "message"]);
      case "run.created":
      case "run.completed":
      case "run.cancelled":
      case "run.started":
      default:
        return {};
    }
  }

  return {};
}

function standardPayload(event: SparkwrightEvent): unknown {
  if (!isRecord(event.payload)) return event.payload;

  switch (event.type) {
    case "prompt.built":
      return summarizePromptBuilt(event.payload);
    case "model.requested":
      return pick(event.payload, ["goal", "step", "attempt"]);
    case "model.completed":
      return summarizeModelOutput(event.payload);
    case "run.budget.checked":
      return pick(event.payload, ["stage", "usage", "metadata"]);
    case "context.compaction_requested":
      return pick(event.payload, [
        "step",
        "selectedCount",
        "omittedCount",
        "reasons",
        "metadata",
      ]);
    case "validation.started":
      return pick(event.payload, ["hookName", "stage", "metadata"]);
    case "validation.completed":
    case "validation.failed":
      return summarizeValidationEvent(event.payload);
    case "tool.completed":
      return summarizeToolResult(event.payload);
    case "tool.failed":
      return summarizeToolResult(event.payload);
    case "artifact.created":
      return summarizeArtifact(event.payload);
    case "workspace.write.requested":
      return summarizeWorkspaceWrite(event.payload);
    case "workspace.anchored_read":
      return pick(event.payload, [
        "path",
        "anchorSetId",
        "lineCount",
        "metadata",
      ]);
    case "workspace.anchored_edit.requested":
      return summarizeAnchoredEditRequest(event.payload);
    case "workspace.anchored_edit.verified":
      return summarizeAnchoredEditVerified(event.payload);
    case "workspace.anchored_edit.rejected":
      return summarizeAnchoredEditRejected(event.payload);
    case "approval.requested":
      return summarizeApprovalRequest(event.payload);
    default:
      return event.payload;
  }
}

/**
 * Standard-level `prompt.built` payload. The stable system prefix
 * (identity/contracts/tool descriptors) is byte-identical on every step;
 * recording its full text inline on each event is what made traces look like
 * the system prompt was "loaded N times" per run. We replace that prefix with a
 * hash reference + size, and drop the rest of the raw `messages` array
 * entirely — the full, deduped prompt already lives in `transcript.jsonl`
 * (via `systemRef` blobs), and the content-free `cacheBlocks`/`sections`
 * summary already in this payload is what trace viewers actually consume.
 * Debug level (`filterTraceEvent` short-circuits) still keeps full `messages`.
 */
function summarizePromptBuilt(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { messages: rawMessages, ...rest } = payload as Record<
    string,
    unknown
  > & {
    messages?: unknown;
  };
  if (!Array.isArray(rawMessages)) return rest;
  const messages = rawMessages as PromptMessage[];
  const prefix = leadingSystemPrefix(messages);
  if (prefix.length === 0) return rest;
  return {
    ...rest,
    systemPrefixRef: hashSystemPrefix(prefix),
    systemPrefixMessages: prefix.length,
    systemPrefixChars: prefix.reduce((sum, m) => sum + m.content.length, 0),
  };
}

function summarizeAnchoredEditRequest(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    path: payload.path,
    edits: Array.isArray(payload.edits)
      ? payload.edits.map((edit) => summarizeValue(edit))
      : undefined,
    reason: payload.reason,
  };
}

function summarizeAnchoredEditVerified(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    path: payload.path,
    editCount: payload.editCount,
    anchors: Array.isArray(payload.anchors)
      ? payload.anchors.map((anchor) => summarizeValue(anchor))
      : undefined,
  };
}

function summarizeAnchoredEditRejected(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    path: payload.path,
    reason: payload.reason,
    error: isRecord(payload.error)
      ? {
          code: payload.error.code,
          message: truncateString(payload.error.message, 500),
          metadata: summarizeValue(payload.error.metadata),
        }
      : undefined,
  };
}

function summarizeValidationEvent(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result = isRecord(payload.result)
    ? {
        status: payload.result.status,
        findings: Array.isArray(payload.result.findings)
          ? payload.result.findings.map((finding) =>
              isRecord(finding)
                ? {
                    code: finding.code,
                    message: truncateString(finding.message, 500),
                    severity: finding.severity,
                    metadata: summarizeValue(finding.metadata),
                  }
                : finding,
            )
          : undefined,
        metadata: summarizeValue(payload.result.metadata),
      }
    : undefined;

  return {
    hookName: payload.hookName,
    stage: payload.stage,
    result,
    metadata: payload.metadata,
  };
}

function summarizeModelOutput(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    // `payload.message` is typed as `string`, but providers occasionally
    // emit a structured `{role, content}` object. `truncateString` only
    // touches strings and would otherwise pass the whole object through
    // unchanged, defeating the "standard" trace-level size budget.
    message:
      typeof payload.message === "string"
        ? truncateString(payload.message, 500)
        : summarizeValue(payload.message),
    toolCalls: Array.isArray(payload.toolCalls)
      ? payload.toolCalls.map((toolCall) =>
          isRecord(toolCall)
            ? {
                toolName: toolCall.toolName,
                arguments: summarizeValue(toolCall.arguments),
              }
            : toolCall,
        )
      : undefined,
    usage: summarizeValue(payload.usage),
    trace: summarizeValue(payload.trace),
  };
}

function summarizeToolResult(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    toolCallId: payload.toolCallId,
    status: payload.status,
    output: summarizeValue(payload.output),
    error: isRecord(payload.error)
      ? {
          code: payload.error.code,
          message: truncateString(payload.error.message, 500),
          metadata: payload.error.metadata,
        }
      : undefined,
    artifacts: Array.isArray(payload.artifacts)
      ? payload.artifacts.map((artifact) =>
          isRecord(artifact) ? summarizeArtifact(artifact) : artifact,
        )
      : [],
  };
}

function summarizeArtifact(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: payload.id,
    runId: payload.runId,
    type: payload.type,
    name: payload.name,
    path: payload.path,
    contentSummary: summarizeValue(payload.content),
    metadata: payload.metadata,
  };
}

function summarizeWorkspaceWrite(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: payload.id,
    runId: payload.runId,
    path: payload.path,
    reason: payload.reason,
    diffSummary: summarizeValue(payload.diff),
    createdAt: payload.createdAt,
    metadata: payload.metadata,
  };
}

function summarizeApprovalRequest(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: payload.id,
    runId: payload.runId,
    action: payload.action,
    summary: payload.summary,
    details: summarizeValue(payload.details),
    createdAt: payload.createdAt,
    status: payload.status,
  };
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") return truncateString(value, 500);
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      preview: value.slice(0, 5).map(summarizeValue),
    };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return Object.fromEntries(
      entries
        .slice(0, 20)
        .map(([key, nested]) => [key, summarizeValue(nested)]),
    );
  }
  return value;
}

function truncateString(value: unknown, maxLength: number): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= maxLength) return value;
  return {
    type: "string",
    length: value.length,
    preview: value.slice(0, maxLength),
  };
}

function pick(
  payload: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((key) => key in payload).map((key) => [key, payload[key]]),
  );
}

function pickNested(
  payload: Record<string, unknown>,
  keys: string[],
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...pick(payload, keys),
    ...Object.fromEntries(
      Object.entries(extra).filter(([, value]) => value !== undefined),
    ),
  };
}

function collectTerminalState(
  summary: TraceSummary,
  event: SparkwrightEvent,
): void {
  if (
    event.type !== "run.completed" &&
    event.type !== "run.failed" &&
    event.type !== "run.cancelled"
  ) {
    return;
  }
  const state = isRecord(event.payload)
    ? typeof event.payload.state === "string"
      ? event.payload.state
      : event.type.replace("run.", "")
    : event.type.replace("run.", "");
  summary.terminalStates[state] = (summary.terminalStates[state] ?? 0) + 1;
}

function matchesTraceEventFilter(
  event: SparkwrightEvent,
  filter: TraceEventFilter,
): boolean {
  if (filter.type && event.type !== filter.type) return false;
  if (filter.runId && event.runId !== filter.runId) return false;
  if (filter.contains) {
    const needle = filter.contains.toLowerCase();
    if (!JSON.stringify(event).toLowerCase().includes(needle)) return false;
  }
  return true;
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

function parseTraceJsonl(jsonl: string, path: string): SparkwrightEvent[] {
  return jsonl
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as SparkwrightEvent;
      } catch (cause) {
        throw new Error(
          `Invalid trace event JSON in ${path} at line ${index + 1}`,
          {
            cause,
          },
        );
      }
    });
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

function validateRunEventSequences(
  events: SparkwrightEvent[],
  findings: SessionTraceConsistencyFinding[],
): void {
  const lastByRun = new Map<string, number>();
  for (const event of events) {
    const last = lastByRun.get(event.runId) ?? 0;
    if (event.sequence !== last + 1) {
      findings.push({
        severity: "error",
        code: "RUN_EVENT_SEQUENCE_INVALID",
        message: "Run event sequence must increase by one per run.",
        metadata: {
          runId: event.runId,
          expected: last + 1,
          actual: event.sequence,
        },
      });
    }
    lastByRun.set(event.runId, observedSequenceEnd(event));
  }
}

function observedSequenceEnd(event: SparkwrightEvent): number {
  if (
    event.type === "model.stream.text" &&
    isRecord(event.payload) &&
    typeof event.payload.chunkCount === "number" &&
    Number.isInteger(event.payload.chunkCount) &&
    event.payload.chunkCount > 1
  ) {
    return event.sequence + event.payload.chunkCount - 1;
  }
  return event.sequence;
}

function isTerminalRunEvent(event: SparkwrightEvent): boolean {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  );
}

function collectWriteVerificationCounts(
  countsByRun: Map<
    string,
    { requested: number; completed: number; denied: number; skipped: number }
  >,
  event: SparkwrightEvent,
): void {
  const counts = countsByRun.get(event.runId) ?? {
    requested: 0,
    completed: 0,
    denied: 0,
    skipped: 0,
  };
  if (event.type === "workspace.write.requested") counts.requested += 1;
  else if (event.type === "workspace.write.completed") counts.completed += 1;
  else if (event.type === "workspace.write.denied") counts.denied += 1;
  else if (event.type === "workspace.write.skipped") counts.skipped += 1;
  else return;
  countsByRun.set(event.runId, counts);
}

function collectApprovalVerificationCounts(
  countsByRun: Map<string, { requested: number; resolved: number }>,
  event: SparkwrightEvent,
): void {
  const counts = countsByRun.get(event.runId) ?? {
    requested: 0,
    resolved: 0,
  };
  if (event.type === "approval.requested") counts.requested += 1;
  else if (event.type === "approval.resolved") counts.resolved += 1;
  else return;
  countsByRun.set(event.runId, counts);
}

function collectArtifactVerificationFindings(
  artifactIds: Set<string>,
  event: SparkwrightEvent,
  findings: TraceVerificationFinding[],
  line: number,
): void {
  if (event.type !== "artifact.created") return;
  const payload = event.payload;
  if (!isRecord(payload) || typeof payload.id !== "string") return;
  if (artifactIds.has(payload.id)) {
    findings.push({
      severity: "error",
      code: "TRACE_ARTIFACT_ID_CONFLICT",
      message: "Trace contains duplicate artifact ids.",
      metadata: { line, artifactId: payload.id },
    });
  }
  artifactIds.add(payload.id);
}

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

function collectToolCall(summary: TraceSummary, event: SparkwrightEvent): void {
  // Count each call once at request time. `tool.started` carries the same
  // toolName, so counting both double-counts every invocation.
  if (event.type !== "tool.requested") return;
  if (!isRecord(event.payload)) return;
  const toolName =
    typeof event.payload.toolName === "string"
      ? event.payload.toolName
      : typeof event.payload.name === "string"
        ? event.payload.name
        : undefined;
  if (!toolName) return;
  summary.toolCalls[toolName] = (summary.toolCalls[toolName] ?? 0) + 1;
}

function latestOpenModelPhaseKey(
  open: Map<string, TraceTimelinePhase>,
  runId: string,
): string | undefined {
  const prefix = `${runId}:model:`;
  return [...open.keys()].reverse().find((key) => key.startsWith(prefix));
}

function collectErrorCode(
  summary: TraceSummary,
  event: SparkwrightEvent,
): void {
  if (!isRecord(event.payload)) return;
  const code = stringValue(
    event.payload.errorCode,
    isRecord(event.payload.error) ? event.payload.error.code : undefined,
    event.type === "mcp.server.prepared" && event.payload.status === "failed"
      ? "MCP_SERVER_PREPARE_FAILED"
      : undefined,
    event.type.endsWith(".denied") ? event.type : undefined,
  );
  if (!code) return;
  summary.errorCodes[code] = (summary.errorCodes[code] ?? 0) + 1;
}

function collectExpectedDenialCode(
  summary: TraceSummary,
  event: SparkwrightEvent,
): void {
  if (!isRecord(event.payload)) return;
  const code = stringValue(
    isRecord(event.payload.error) ? event.payload.error.code : undefined,
    event.type.endsWith(".denied") ? event.type : undefined,
  );
  if (!code) return;
  summary.expectedDenialCodes[code] =
    (summary.expectedDenialCodes[code] ?? 0) + 1;
}

function isExpectedDenialEvent(event: SparkwrightEvent): boolean {
  if (event.type.endsWith(".denied")) return true;
  if (!isRecord(event.payload)) return false;
  return (
    isRecord(event.payload.error) &&
    isPolicyOrApprovalFailure(stringValue(event.payload.error.code))
  );
}

function isTraceErrorEvent(event: SparkwrightEvent): boolean {
  if (event.type.endsWith(".failed") || event.type.endsWith(".denied")) {
    return true;
  }
  return (
    event.type === "mcp.server.prepared" &&
    isRecord(event.payload) &&
    event.payload.status === "failed"
  );
}

function isTimelineDetailEvent(event: SparkwrightEvent): boolean {
  return (
    event.type === "model.turn.started" ||
    event.type === "model.turn.completed" ||
    event.type === "model.stream.chunk" ||
    event.type.startsWith("model.stream.")
  );
}

function createTimelinePhase(
  event: SparkwrightEvent,
  hasPhaseKey: boolean,
): TraceTimelinePhase {
  const payload = isRecord(event.payload) ? event.payload : {};
  const category = timelineCategory(event.type);
  const status = initialTimelineStatus(event, hasPhaseKey);
  const metadata = timelinePhaseMetadata(event);
  return {
    id: timelinePhaseKey(event) ?? `${event.runId}:${event.sequence}`,
    runId: event.runId,
    agentId: stringMetadata(event.metadata, "agentId"),
    category,
    label: timelineLabel(event, payload, category),
    status,
    startedAt: event.timestamp,
    ...(status !== "pending"
      ? { endedAt: event.timestamp, durationMs: 0 }
      : {}),
    startSequence: event.sequence,
    ...(status !== "pending" ? { endSequence: event.sequence } : {}),
    eventTypes: [event.type],
    ...(metadata ? { metadata } : {}),
  };
}

function completeTimelinePhase(
  phase: TraceTimelinePhase,
  event: SparkwrightEvent,
  status: TraceTimelinePhaseStatus,
): void {
  phase.status = status;
  phase.endedAt = event.timestamp;
  phase.endSequence = event.sequence;
  phase.durationMs = Math.max(
    0,
    Date.parse(event.timestamp) - Date.parse(phase.startedAt),
  );
  phase.eventTypes = [...phase.eventTypes, event.type];
}

function timelinePhaseKey(event: SparkwrightEvent): string | undefined {
  const payload = isRecord(event.payload) ? event.payload : {};
  const toolCallId = stringValue(payload.toolCallId, payload.id);
  if (
    event.type === "tool.requested" ||
    event.type === "tool.started" ||
    event.type === "tool.completed" ||
    event.type === "tool.failed"
  ) {
    return toolCallId ? `${event.runId}:tool:${toolCallId}` : undefined;
  }

  const approvalId = stringValue(payload.approvalId, payload.id);
  if (
    event.type === "approval.requested" ||
    event.type === "approval.resolved"
  ) {
    return approvalId ? `${event.runId}:approval:${approvalId}` : undefined;
  }

  const writeId = stringValue(payload.proposalId, payload.id);
  if (event.type.startsWith("workspace.write.")) {
    return writeId ? `${event.runId}:workspace.write:${writeId}` : undefined;
  }

  if (
    event.type === "model.requested" ||
    event.type === "model.completed" ||
    event.type === "model.retrying"
  ) {
    const step = stringValue(payload.step) ?? String(numberValue(payload.step));
    return `${event.runId}:model:${step}`;
  }

  if (
    event.type === "run.created" ||
    event.type === "run.started" ||
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  ) {
    return `${event.runId}:run`;
  }

  if (event.spanId) return `span:${event.spanId}`;

  return undefined;
}

function initialTimelineStatus(
  event: SparkwrightEvent,
  hasPhaseKey: boolean,
): TraceTimelinePhaseStatus {
  if (terminalTimelineStatus(event)) return terminalTimelineStatus(event)!;
  if (!hasPhaseKey) return "instant";
  if (
    event.type.endsWith(".requested") ||
    event.type.endsWith(".started") ||
    event.type === "run.created" ||
    event.type === "model.requested"
  ) {
    return "pending";
  }
  return "instant";
}

function terminalTimelineStatus(
  event: SparkwrightEvent,
): TraceTimelinePhaseStatus | undefined {
  if (
    event.type.endsWith(".completed") ||
    event.type.endsWith(".verified") ||
    event.type.endsWith(".skipped") ||
    event.type === "approval.resolved"
  ) {
    return "completed";
  }
  if (event.type.endsWith(".failed") || event.type.endsWith(".rejected")) {
    return "failed";
  }
  if (event.type.endsWith(".denied")) return "denied";
  if (event.type.endsWith(".cancelled")) return "cancelled";
  return undefined;
}

function timelineCategory(
  type: SparkwrightEvent["type"],
): TraceTimelinePhaseCategory {
  if (type.startsWith("run.")) return "run";
  if (type.startsWith("model.") || type === "prompt.built") return "model";
  if (type.startsWith("tool.")) return "tool";
  if (type.startsWith("approval.")) return "approval";
  if (type.startsWith("workspace.")) return "workspace";
  if (type.startsWith("validation.")) return "validation";
  if (type.startsWith("context.")) return "context";
  if (type.startsWith("task.")) return "task";
  if (type.startsWith("artifact.")) return "artifact";
  return "other";
}

function timelineLabel(
  event: SparkwrightEvent,
  payload: Record<string, unknown>,
  category: TraceTimelinePhaseCategory,
): string {
  if (category === "tool") {
    return `tool ${String(payload.toolName ?? payload.name ?? event.type)}`;
  }
  if (category === "approval") {
    return `approval ${String(payload.summary ?? payload.action ?? event.type)}`;
  }
  if (category === "workspace") {
    return `workspace ${String(payload.path ?? event.type)}`;
  }
  if (category === "model") {
    return `model step ${String(payload.step ?? "?")}`;
  }
  if (category === "run") return "run";
  return event.type;
}

function timelinePhaseMetadata(
  event: SparkwrightEvent,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (event.traceId) metadata.traceId = event.traceId;
  if (event.spanId) metadata.spanId = event.spanId;
  if (event.parentSpanId) metadata.parentSpanId = event.parentSpanId;
  const sessionId = stringMetadata(event.metadata, "sessionId");
  if (sessionId) metadata.sessionId = sessionId;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function collectUsage(summary: TraceSummary, event: SparkwrightEvent): boolean {
  if (event.type !== "model.completed") return false;
  const usage = usageFromEvent(event);
  if (!usage) return false;
  addUsage(summary, usage);
  return true;
}

function usageFromEvent(
  event: SparkwrightEvent,
): Record<string, unknown> | undefined {
  if (!isRecord(event.payload)) return;
  if (isRecord(event.payload.usage)) return event.payload.usage;
  if (event.type === "usage.updated") return event.payload;
  if (event.type === "model.completed" && "totalTokens" in event.payload) {
    return { totalTokens: event.payload.totalTokens };
  }
  return undefined;
}

function addUsage(summary: TraceSummary, usage: Record<string, unknown>): void {
  summary.usage.inputTokens += numberValue(
    usage.inputTokens,
    usage.promptTokens,
  );
  summary.usage.outputTokens += numberValue(
    usage.outputTokens,
    usage.completionTokens,
  );
  summary.usage.cacheReadTokens += numberValue(usage.cacheReadTokens);
  summary.usage.cacheWriteTokens += numberValue(usage.cacheWriteTokens);
  summary.usage.reasoningTokens += numberValue(usage.reasoningTokens);
  summary.usage.totalTokens += numberValue(usage.totalTokens, usage.tokens);
  summary.usage.estimatedCostUsd += numberValue(
    usage.estimatedCostUsd,
    usage.costUsd,
  );
  addCostStatus(summary.usage, usage);
}

function usageToSummary(usage: Record<string, unknown>): TraceSummary["usage"] {
  const out: TraceSummary["usage"] = {
    inputTokens: numberValue(usage.inputTokens, usage.promptTokens),
    outputTokens: numberValue(usage.outputTokens, usage.completionTokens),
    cacheReadTokens: numberValue(usage.cacheReadTokens),
    cacheWriteTokens: numberValue(usage.cacheWriteTokens),
    reasoningTokens: numberValue(usage.reasoningTokens),
    totalTokens: numberValue(usage.totalTokens, usage.tokens),
    estimatedCostUsd: numberValue(usage.estimatedCostUsd, usage.costUsd),
  };
  addCostStatus(out, usage);
  return out;
}

function addCostStatus(
  target: TraceSummary["usage"],
  usage: Record<string, unknown>,
): void {
  const status = stringValue(usage.costStatus);
  if (
    status === "estimated" ||
    status === "unavailable" ||
    status === "partial"
  ) {
    target.costStatus = mergeCostStatus(target.costStatus, status);
  } else if (
    (positiveNumber(usage.estimatedCostUsd) || positiveNumber(usage.costUsd)) &&
    target.costStatus !== "partial" &&
    target.costStatus !== "unavailable"
  ) {
    target.costStatus = "estimated";
  }

  const reasons = isRecord(usage.costUnavailableReasons)
    ? usage.costUnavailableReasons
    : stringValue(usage.costUnavailableReason)
      ? { [stringValue(usage.costUnavailableReason)!]: 1 }
      : undefined;
  if (!reasons) return;

  const targetReasons = (target.costUnavailableReasons ??= {});
  for (const [reason, count] of Object.entries(reasons)) {
    const n = typeof count === "number" && Number.isFinite(count) ? count : 1;
    targetReasons[reason] = (targetReasons[reason] ?? 0) + n;
  }
  target.costStatus = mergeCostStatus(target.costStatus, "unavailable");
}

function mergeCostStatus(
  current: TraceSummary["usage"]["costStatus"],
  next: NonNullable<TraceSummary["usage"]["costStatus"]>,
): NonNullable<TraceSummary["usage"]["costStatus"]> {
  if (!current) return next;
  if (current === next) return current;
  return "partial";
}

function numberValue(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function extensionForArtifact(artifact: Artifact): string {
  switch (artifact.type) {
    case "diff":
    case "patch":
      return ".diff";
    case "json":
      return ".json";
    case "log":
      return ".log";
    case "file":
      return ".txt";
    case "text":
    default:
      return ".txt";
  }
}

function serializeArtifactContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined) return "";
  return `${JSON.stringify(content, null, 2)}\n`;
}

function redactArtifact(artifact: Artifact): Artifact {
  return redactUnknown(artifact, {
    replacement: DEFAULT_REDACTION_REPLACEMENT,
    keyPatterns: DEFAULT_REDACTED_KEY_PATTERNS,
    valuePatterns: DEFAULT_REDACTED_VALUE_PATTERNS,
    maxDepth: DEFAULT_REDACTION_MAX_DEPTH,
    depth: 0,
  }) as Artifact;
}

interface RedactionContext {
  replacement: string;
  keyPatterns: RegExp[];
  valuePatterns: RegExp[];
  maxDepth: number;
  depth: number;
}

function redactUnknown(value: unknown, ctx: RedactionContext): unknown {
  if (ctx.depth > ctx.maxDepth) return ctx.replacement;

  if (typeof value === "string") {
    return redactString(value, ctx);
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      redactUnknown(item, {
        ...ctx,
        depth: ctx.depth + 1,
      }),
    );
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        shouldRedactKey(key, ctx.keyPatterns)
          ? ctx.replacement
          : redactUnknown(nested, {
              ...ctx,
              depth: ctx.depth + 1,
            }),
      ]),
    );
  }

  return value;
}

function redactString(value: string, ctx: RedactionContext): string {
  return ctx.valuePatterns.reduce(
    (current, pattern) => current.replace(pattern, ctx.replacement),
    value,
  );
}

function shouldRedactKey(key: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(key));
}
