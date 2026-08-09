import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  FileSessionStore,
  SESSION_COMPACT_FILENAME,
  asSessionId,
  buildTraceTimelineFile,
  createContextItemId,
  factLedgerSnapshotFromUnknown,
  forkSession,
  loadSessionCompactArtifact,
  loadTraceEventsFile,
  sessionCompactArtifactToContextItem,
  sessionTurnToContextItems,
  summarizeTraceFile,
  validateSessionTraceConsistency,
  type ContextItem,
  type FactLedgerSnapshot,
  type RunId,
  type SessionForkPoint,
  type SessionRecord,
  type SessionCompactArtifact,
  type SessionCompactionMeasurement,
  type SessionEvent,
  type SessionTraceFacts,
  type SparkwrightEvent,
} from "@sparkwright/core";
import type {
  ProtocolError,
  SessionForkRequestPayload,
  SessionCompactionInspectArtifact,
  SessionCompactionInspectEvent,
  SessionCompactionInspectReport,
} from "@sparkwright/protocol";
import {
  readTodoLedger,
  renderTodoLedgerContext,
} from "@sparkwright/agent-runtime";

export interface SessionQueryContext {
  workspaceRoot: string;
  sessionRootDir?: string;
}

export interface CompletedHostSessionTurn {
  runId: RunId;
  goal: string;
  message: string;
  traceFacts?: SessionTraceFacts;
  factLedger?: FactLedgerSnapshot;
}

export interface LoadHostSessionConversationOptions {
  evidenceRunId?: string;
}

interface HostSessionRunFacts {
  traceFacts: SessionTraceFacts;
  factLedger?: FactLedgerSnapshot;
}

export type LocatedHostRunDirectory = {
  runDir: string;
  sessionId?: string;
  agentId: string;
};

export type SessionInspectOptions = {
  compaction?: boolean;
};

export function sessionRootDirFor(context: SessionQueryContext): string {
  return (
    context.sessionRootDir ??
    join(context.workspaceRoot, ".sparkwright", "sessions")
  );
}

export async function findHostRunDirectory(
  context: SessionQueryContext,
  runId: string,
  sessionId?: string,
): Promise<
  ({ ok: true } & LocatedHostRunDirectory) | { ok: false; error: ProtocolError }
> {
  if (!isSafePathSegment(runId)) {
    return {
      ok: false,
      error: {
        code: "invalid_payload",
        message:
          "runId must contain only letters, numbers, dot, underscore, or hyphen",
      },
    };
  }
  const sessionRootDir = sessionRootDirFor(context);
  if (sessionId) {
    let safeSessionId: string;
    try {
      safeSessionId = asSessionId(sessionId);
    } catch (error) {
      return protocolFailure("invalid_payload", error);
    }
    const located = await findRunInSession(
      sessionRootDir,
      safeSessionId,
      runId,
    );
    return located
      ? { ok: true, ...located }
      : {
          ok: false,
          error: {
            code: "run_not_found",
            message: `run not found in session ${safeSessionId}: ${runId}`,
          },
        };
  }

  try {
    const sessions = await readdir(sessionRootDir, { withFileTypes: true });
    for (const session of sessions) {
      if (!session.isDirectory() || !isSafePathSegment(session.name)) continue;
      const located = await findRunInSession(
        sessionRootDir,
        session.name,
        runId,
      );
      if (located) return { ok: true, ...located };
    }
  } catch {
    // Report the canonical not-found result below.
  }

  return {
    ok: false,
    error: {
      code: "run_not_found",
      message: `Could not find run directory for ${runId} under ${sessionRootDir}.`,
    },
  };
}

export async function loadHostSessionConversation(
  context: SessionQueryContext,
  sessionId: string,
  options: LoadHostSessionConversationOptions = {},
): Promise<ContextItem[]> {
  const turns = await loadCompletedHostSessionTurns(context, sessionId);
  const sessionRootDir = sessionRootDirFor(context);
  const compact = await loadSessionCompactArtifact({
    sessionRootDir,
    sessionId,
  });
  const todoLedger = await readTodoLedger(
    join(sessionRootDir, sessionId, "todo.md"),
  );
  const todoContext =
    todoLedger.items.length > 0
      ? [
          renderTodoLedgerContext(todoLedger, {
            sessionId,
            title:
              "Current session plan (advisory; it does not control execution)",
          }),
        ]
      : [];
  if (turns.length === 0) {
    const compactContext = compact
      ? [
          sessionCompactWarningContextItem(
            sessionId,
            `Session compact artifact ignored because no completed turns were available to anchor throughRunId ${compact.throughRunId}.`,
            { throughRunId: compact.throughRunId },
          ),
        ]
      : [];
    return [...compactContext, ...todoContext];
  }

  const items: ContextItem[] = [];
  let startAt = 0;
  if (compact) {
    const compactedThrough = turns.findIndex(
      (turn) => turn.runId === compact.throughRunId,
    );
    if (compactedThrough >= 0) {
      items.push(sessionCompactArtifactToContextItem(compact));
      startAt = compactedThrough + 1;
    } else {
      items.push(
        sessionCompactWarningContextItem(
          sessionId,
          `Session compact artifact ignored because throughRunId ${compact.throughRunId} was not found in completed session turns.`,
          { throughRunId: compact.throughRunId },
        ),
      );
    }
  }

  for (const turn of turns.slice(startAt)) {
    items.push(...sessionTurnToContextItems(turn));
  }
  if (options.evidenceRunId) {
    const evidenceTurn = turns.find(
      (turn) => turn.runId === options.evidenceRunId,
    );
    const evidence = evidenceTurn
      ? sessionTurnEvidenceContextItem(sessionId, evidenceTurn)
      : undefined;
    if (evidence) items.push(evidence);
  }
  return [...items, ...todoContext];
}

export async function loadCompletedHostSessionTurns(
  context: SessionQueryContext,
  sessionId: string,
): Promise<CompletedHostSessionTurn[]> {
  const sessionRootDir = sessionRootDirFor(context);
  let runIds: RunId[];
  try {
    const store = new FileSessionStore({ rootDir: sessionRootDir });
    const session = await store.get(sessionId);
    runIds = session?.runIds ?? [];
  } catch {
    return [];
  }
  if (runIds.length === 0) return [];

  const runFacts = await loadHostSessionTraceFacts(context, sessionId);
  const runsDir = join(sessionRootDir, sessionId, "agents", "main", "runs");
  const turns: CompletedHostSessionTurn[] = [];
  for (const runId of runIds) {
    const goal = await readJsonField(join(runsDir, runId, "run.json"), "goal");
    const message = await readJsonField(
      join(runsDir, runId, "result.json"),
      "message",
    );
    if (!goal || !message) continue;
    const facts = runFacts.get(runId);
    turns.push({
      runId,
      goal,
      message,
      traceFacts: facts?.traceFacts,
      factLedger: facts?.factLedger,
    });
  }
  return turns;
}

async function findRunInSession(
  sessionRootDir: string,
  sessionId: string,
  runId: string,
): Promise<LocatedHostRunDirectory | null> {
  const agentsDir = join(sessionRootDir, sessionId, "agents");
  try {
    const agents = await readdir(agentsDir, { withFileTypes: true });
    for (const agent of agents) {
      if (!agent.isDirectory() || !isSafePathSegment(agent.name)) continue;
      const runDir = join(agentsDir, agent.name, "runs", runId);
      if (await isDirectory(runDir)) {
        return { runDir, sessionId, agentId: agent.name };
      }
    }
  } catch {
    // The session has no canonical agent run tree.
  }
  return null;
}

async function loadHostSessionTraceFacts(
  context: SessionQueryContext,
  sessionId: string,
): Promise<Map<RunId, HostSessionRunFacts>> {
  let events: SparkwrightEvent[];
  try {
    events = await loadTraceEventsFile(
      join(sessionRootDirFor(context), sessionId, "trace.jsonl"),
    );
  } catch {
    return new Map();
  }
  const byRun = new Map<RunId, HostSessionRunFacts>();
  for (const event of events) {
    const runId = event.runId;
    if (!runId) continue;
    const facts = byRun.get(runId) ?? { traceFacts: {} };
    collectSessionTraceFact(facts, event);
    byRun.set(runId, facts);
  }
  return byRun;
}

async function readJsonField(
  path: string,
  field: string,
): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    const value = parsed[field];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function listHostSessions(
  context: SessionQueryContext,
  limit = 20,
): Promise<Array<{ id: string; mtimeMs: number; preview: string }>> {
  const root = sessionRootDirFor(context);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const results = await Promise.all(
    entries.map(async (id) => {
      const dir = join(root, id);
      try {
        const entryStat = await stat(dir);
        if (!entryStat.isDirectory()) return null;
        let preview = "";
        try {
          const transcript = await readFile(
            join(dir, "transcript.jsonl"),
            "utf8",
          );
          const firstLine = transcript.split("\n").find((line) => line.trim());
          if (firstLine) preview = sessionPreviewFromTranscriptLine(firstLine);
        } catch {
          // A session can exist before its first transcript write.
        }
        return {
          id,
          mtimeMs: entryStat.mtimeMs,
          preview: preview.slice(0, 80),
        };
      } catch {
        return null;
      }
    }),
  );
  return results
    .filter((result): result is NonNullable<typeof result> => result !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit);
}

export async function inspectHostSession(
  context: SessionQueryContext,
  sessionId: string,
  options: SessionInspectOptions = {},
): Promise<
  | {
      ok: true;
      sessionId: string;
      summary: Record<string, unknown>;
      consistency: Record<string, unknown>;
      timeline: Record<string, unknown>;
      compaction?: SessionCompactionInspectReport;
    }
  | { ok: false; error: ProtocolError }
> {
  const resolved = await resolveExistingSession(context, sessionId);
  if (!resolved.ok) return resolved;
  try {
    const tracePath = join(resolved.sessionDir, "trace.jsonl");
    const [summary, consistency, timeline, compaction] = await Promise.all([
      summarizeTraceFile(tracePath),
      validateSessionTraceConsistency({ sessionDir: resolved.sessionDir }),
      buildTraceTimelineFile(tracePath),
      options.compaction
        ? buildSessionCompactionInspectReport(
            resolved.sessionRootDir,
            resolved.sessionId,
          )
        : Promise.resolve(undefined),
    ]);
    return {
      ok: true,
      sessionId: resolved.sessionId,
      summary: summary as unknown as Record<string, unknown>,
      consistency: consistency as unknown as Record<string, unknown>,
      timeline: timeline as unknown as Record<string, unknown>,
      ...(compaction ? { compaction } : {}),
    };
  } catch (error) {
    return protocolFailure("internal_error", error);
  }
}

export async function inspectHostSessionCompaction(
  context: SessionQueryContext,
  sessionId: string,
): Promise<
  | {
      ok: true;
      sessionId: string;
      compaction: SessionCompactionInspectReport;
    }
  | { ok: false; error: ProtocolError }
> {
  const resolved = await resolveExistingSession(context, sessionId);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    sessionId: resolved.sessionId,
    compaction: await buildSessionCompactionInspectReport(
      resolved.sessionRootDir,
      resolved.sessionId,
    ),
  };
}

export async function forkHostSession(
  context: SessionQueryContext,
  request: SessionForkRequestPayload,
): Promise<
  | {
      ok: true;
      forkedSessionId: string;
      copiedRunCount: number;
      forkPoint: SessionForkPoint | null;
      copiedEventCount: number;
      truncatedAtSequence: number | null;
    }
  | { ok: false; error: ProtocolError }
> {
  let safeSource: string;
  try {
    safeSource = asSessionId(request.sourceSessionId);
  } catch (error) {
    return protocolFailure("invalid_payload", error);
  }
  try {
    const store = new FileSessionStore({ rootDir: sessionRootDirFor(context) });
    const source = await store.get(safeSource);
    if (!source) return sessionNotFound(safeSource);
    const forkPoint = await resolveHostForkPoint(store, source, request);
    const result = await forkSession({
      sourceSessionId: safeSource,
      ...(forkPoint ? { forkPoint } : {}),
      store,
      metadata: { forkedVia: "host" },
    });
    return {
      ok: true,
      forkedSessionId: result.forked.id,
      copiedRunCount: result.copiedRunCount,
      forkPoint: result.forkPoint,
      copiedEventCount: result.copiedRunCount,
      truncatedAtSequence: request.forkAtSequence ?? null,
    };
  } catch (error) {
    return protocolFailure(
      error instanceof Error && /fork point run/i.test(error.message)
        ? "invalid_payload"
        : "internal_error",
      error,
    );
  }
}

async function resolveHostForkPoint(
  store: FileSessionStore,
  source: SessionRecord,
  request: SessionForkRequestPayload,
): Promise<SessionForkPoint | undefined> {
  if (request.forkPoint && request.forkAtSequence !== undefined) {
    throw new Error("forkPoint and forkAtSequence are mutually exclusive");
  }
  if (request.forkPoint) {
    const runId = source.runIds.find(
      (candidate) => candidate === request.forkPoint?.runId,
    );
    if (!runId) {
      throw new Error(
        `Fork point run ${request.forkPoint.runId} is not part of session ${source.id}`,
      );
    }
    return {
      runId,
      position: request.forkPoint.position,
    };
  }
  if (request.forkAtSequence === undefined) return undefined;

  let lastRunId: RunId | undefined;
  for await (const event of store.loadEvents(source.id)) {
    if (event.sequence > request.forkAtSequence) break;
    if (
      event.type !== "session.run_appended" ||
      !isPlainRecord(event.payload)
    ) {
      continue;
    }
    const runId = recordString(event.payload, "runId");
    const member = source.runIds.find((candidate) => candidate === runId);
    if (member) lastRunId = member;
  }
  if (lastRunId) return { runId: lastRunId, position: "after" };
  const firstRunId = source.runIds[0];
  return firstRunId ? { runId: firstRunId, position: "before" } : undefined;
}

export function sessionPreviewFromTranscriptLine(firstLine: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return firstLine;
  }
  const object = parsed as {
    messages?: Array<{ role?: unknown; content?: unknown }>;
  };
  if (Array.isArray(object.messages)) {
    for (let index = object.messages.length - 1; index >= 0; index--) {
      const message = object.messages[index];
      if (
        !message ||
        message.role !== "user" ||
        typeof message.content !== "string"
      ) {
        continue;
      }
      const goal = stripGoalDecorations(message.content);
      if (goal) return goal;
    }
  }
  return firstLine;
}

async function resolveExistingSession(
  context: SessionQueryContext,
  sessionId: string,
): Promise<
  | {
      ok: true;
      sessionId: string;
      sessionRootDir: string;
      sessionDir: string;
    }
  | { ok: false; error: ProtocolError }
> {
  let safeSessionId: string;
  try {
    safeSessionId = asSessionId(sessionId);
  } catch (error) {
    return protocolFailure("invalid_payload", error);
  }
  const sessionRootDir = sessionRootDirFor(context);
  const sessionDir = join(sessionRootDir, safeSessionId);
  try {
    if (!(await stat(sessionDir)).isDirectory()) {
      return sessionNotFound(sessionId);
    }
  } catch {
    return sessionNotFound(sessionId);
  }
  return { ok: true, sessionId: safeSessionId, sessionRootDir, sessionDir };
}

async function buildSessionCompactionInspectReport(
  sessionRootDir: string,
  sessionId: string,
): Promise<SessionCompactionInspectReport> {
  const store = new FileSessionStore({ rootDir: sessionRootDir });
  const artifactPath = join(
    sessionRootDir,
    sessionId,
    SESSION_COMPACT_FILENAME,
  );
  const [artifact, events] = await Promise.all([
    loadSessionCompactArtifact({ sessionRootDir, sessionId }),
    loadSessionCompactionEvents(store, sessionId),
  ]);
  const artifactSummary = artifact
    ? sessionCompactionArtifactInspectSummary(artifact, artifactPath)
    : null;
  const latestEvent = events.at(-1) ?? null;
  const latestCompleted =
    [...events]
      .reverse()
      .find((event) => event.type === "session.compaction.completed") ?? null;
  const findings: string[] = [];
  const matches =
    artifactSummary && latestCompleted
      ? sessionCompactionArtifactMatchesEvent(artifactSummary, latestCompleted)
      : null;
  if (artifactSummary && latestCompleted && !matches) {
    findings.push(
      "compact.json does not match the latest completed session compaction event",
    );
  }
  if (artifactSummary && latestEvent?.type === "session.compaction.skipped") {
    findings.push(
      "latest compaction attempt was skipped; compact.json is from an earlier completed attempt",
    );
  }
  if (!artifactSummary && latestCompleted) {
    findings.push(
      "latest completed session compaction event references an artifact that is missing or invalid",
    );
  }
  return {
    status: sessionCompactionInspectStatus({
      artifact: artifactSummary,
      latestEvent,
      latestCompleted,
      artifactMatchesLatestCompletedEvent: matches,
    }),
    artifact: artifactSummary,
    events,
    latestEvent,
    consistency: {
      ok: matches !== false && !(latestCompleted && !artifactSummary),
      artifactMatchesLatestCompletedEvent: matches,
      findings,
    },
  };
}

async function loadSessionCompactionEvents(
  store: FileSessionStore,
  sessionId: string,
): Promise<SessionCompactionInspectEvent[]> {
  const events: SessionCompactionInspectEvent[] = [];
  for await (const event of store.loadEvents(sessionId)) {
    const projected = sessionCompactionInspectEvent(event);
    if (projected) events.push(projected);
  }
  return events;
}

function sessionCompactionInspectEvent(
  event: SessionEvent,
): SessionCompactionInspectEvent | null {
  if (
    event.type !== "session.compaction.completed" &&
    event.type !== "session.compaction.skipped"
  ) {
    return null;
  }
  const payload = isPlainRecord(event.payload) ? event.payload : {};
  const measurement = measurementFromUnknown(payload.measurement);
  return {
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: event.type,
    compactedRunCount: recordNumber(payload, "compactedRunCount") ?? 0,
    throughRunId: recordNullableString(payload, "throughRunId"),
    originalCharCount: recordNumber(payload, "originalCharCount") ?? 0,
    summaryCharCount: recordNumber(payload, "summaryCharCount") ?? 0,
    freedChars: recordNumber(payload, "freedChars") ?? 0,
    ...(measurement ? { measurement } : {}),
    artifactPath: recordNullableString(payload, "artifactPath"),
    ...(recordString(payload, "skippedReason")
      ? { skippedReason: recordString(payload, "skippedReason") }
      : {}),
    ...(recordStringArray(payload, "warningCodes")
      ? { warningCodes: recordStringArray(payload, "warningCodes") }
      : {}),
    ...(recordString(event.metadata, "reason")
      ? { reason: recordString(event.metadata, "reason") }
      : {}),
    ...(recordString(event.metadata, "source")
      ? { source: recordString(event.metadata, "source") }
      : {}),
  };
}

function sessionCompactionArtifactInspectSummary(
  artifact: SessionCompactArtifact,
  path: string,
): SessionCompactionInspectArtifact {
  const metadata = artifact.metadata ?? {};
  const measurement = measurementFromUnknown(metadata.measurement);
  return {
    path,
    schemaVersion: artifact.schemaVersion,
    createdAt: artifact.createdAt,
    throughRunId: artifact.throughRunId,
    compactedRunCount: artifact.compactedRunCount,
    sourceRunIds: [...artifact.sourceRunIds],
    originalCharCount: artifact.originalCharCount,
    summaryCharCount: artifact.summaryCharCount,
    freedChars: artifact.freedChars,
    ...(measurement ? { measurement } : {}),
    ...(recordString(metadata, "mode")
      ? { mode: recordString(metadata, "mode") }
      : {}),
    ...(recordString(metadata, "reason")
      ? { reason: recordString(metadata, "reason") }
      : {}),
    ...(sessionCompactionWarningCodes(metadata)
      ? { warningCodes: sessionCompactionWarningCodes(metadata) }
      : {}),
    ...(isPlainRecord(metadata.summaryFingerprint)
      ? { summaryFingerprint: { ...metadata.summaryFingerprint } }
      : {}),
  };
}

function sessionCompactionArtifactMatchesEvent(
  artifact: SessionCompactionInspectArtifact,
  event: SessionCompactionInspectEvent,
): boolean {
  return (
    event.type === "session.compaction.completed" &&
    artifact.path === event.artifactPath &&
    artifact.throughRunId === event.throughRunId &&
    artifact.compactedRunCount === event.compactedRunCount &&
    artifact.originalCharCount === event.originalCharCount &&
    artifact.summaryCharCount === event.summaryCharCount &&
    artifact.freedChars === event.freedChars
  );
}

function sessionCompactionInspectStatus(input: {
  artifact: SessionCompactionInspectArtifact | null;
  latestEvent: SessionCompactionInspectEvent | null;
  latestCompleted: SessionCompactionInspectEvent | null;
  artifactMatchesLatestCompletedEvent: boolean | null;
}): SessionCompactionInspectReport["status"] {
  if (!input.artifact && !input.latestEvent) return "not_compacted";
  if (input.latestEvent?.type === "session.compaction.skipped")
    return "skipped";
  if (input.artifact && input.latestCompleted) {
    return input.artifactMatchesLatestCompletedEvent === false
      ? "stale_artifact"
      : "compacted";
  }
  if (input.artifact) return "artifact_only";
  return "event_only";
}

function sessionCompactionWarningCodes(
  metadata: Record<string, unknown>,
): string[] | undefined {
  const warnings = metadata.warnings;
  if (!Array.isArray(warnings)) return undefined;
  const codes = warnings
    .map((warning) => recordString(warning, "code"))
    .filter((code): code is string => Boolean(code));
  return codes.length > 0 ? codes : undefined;
}

function measurementFromUnknown(
  value: unknown,
): SessionCompactionMeasurement | undefined {
  return isPlainRecord(value)
    ? (value as unknown as SessionCompactionMeasurement)
    : undefined;
}

function stripGoalDecorations(content: string): string {
  return content
    .replace(/<env>[\s\S]*?<\/env>/g, "")
    .replace(/^\s*User request:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function collectSessionTraceFact(
  facts: HostSessionRunFacts,
  event: SparkwrightEvent,
): void {
  if (event.type === "run.completed" || event.type === "run.failed") {
    if (isPlainRecord(event.payload)) {
      facts.factLedger = factLedgerSnapshotFromUnknown(
        event.payload.factLedger,
      );
    }
    return;
  }
  const traceFacts = facts.traceFacts;
  if (event.type === "approval.requested") {
    traceFacts.approvals = {
      ...(traceFacts.approvals ?? {}),
      requested: (traceFacts.approvals?.requested ?? 0) + 1,
    };
    return;
  }
  if (event.type === "approval.resolved") {
    const decision = recordString(event.payload, "decision");
    traceFacts.approvals = {
      ...(traceFacts.approvals ?? {}),
      ...(decision === "approved"
        ? { approved: (traceFacts.approvals?.approved ?? 0) + 1 }
        : {}),
      ...(decision === "denied"
        ? { denied: (traceFacts.approvals?.denied ?? 0) + 1 }
        : {}),
    };
    return;
  }

  if (
    event.type === "workspace.write.completed" ||
    event.type === "workspace.write.denied" ||
    event.type === "workspace.write.skipped"
  ) {
    const key =
      event.type === "workspace.write.completed"
        ? "completed"
        : event.type === "workspace.write.denied"
          ? "denied"
          : "skipped";
    const path = recordString(event.payload, "path") ?? "(unknown)";
    const writes = traceFacts.workspaceWrites ?? {};
    const next = new Set(writes[key] ?? []);
    next.add(path);
    traceFacts.workspaceWrites = { ...writes, [key]: [...next] };
    return;
  }

  if (event.type === "subagent.completed" || event.type === "subagent.failed") {
    const childRunId =
      recordString(event.payload, "childRunId") ??
      recordString(event.metadata, "childRunId");
    if (!childRunId) return;
    addSessionSubagentFact(traceFacts, {
      childRunId,
      status: recordString(event.payload, "status"),
      summary: recordString(event.payload, "summary"),
      blockers: findNestedAgentBlockers(event.payload),
      role: recordString(event.payload, "role"),
      health: findNestedString(event.payload, "health"),
    });
    return;
  }
}

function sessionTurnEvidenceContextItem(
  sessionId: string,
  turn: CompletedHostSessionTurn,
): ContextItem | undefined {
  const ledger = turn.factLedger;
  if (!ledger) return undefined;

  const changed = new Map<string, string>();
  for (const changeSet of ledger.changeSets) {
    for (const entry of changeSet.entries) {
      changed.set(entry.path, entry.operation);
    }
  }
  if (changed.size === 0) {
    for (const write of ledger.writes) {
      if (write.path) changed.set(write.path, "write");
    }
  }
  const commands = ledger.commands
    .filter((command) => !command.stale && command.verificationRelevant)
    .slice(-8);
  const receipts = ledger.verificationReceipts
    .filter((receipt) => receipt.status !== "stale")
    .slice(-8);
  if (changed.size === 0 && commands.length === 0 && receipts.length === 0) {
    return undefined;
  }

  const lines = [
    `Authoritative runtime evidence from previous run ${turn.runId}:`,
  ];
  if (changed.size > 0) {
    lines.push("Changed paths:");
    for (const [path, operation] of [...changed].slice(0, 16)) {
      lines.push(`- ${operation}: ${path}`);
    }
  }
  if (commands.length > 0) {
    lines.push("Observed verification commands:");
    for (const command of commands) {
      lines.push(
        `- command=${boundedJsonString(command.command ?? "(unknown)", 500)} exitCode=${command.exitCode ?? "unknown"} timedOut=${command.timedOut}`,
      );
    }
  }
  if (receipts.length > 0) {
    lines.push("Verification receipts:");
    for (const receipt of receipts) {
      lines.push(
        `- level=${receipt.level} status=${receipt.status} exitCode=${receipt.exitCode ?? "unknown"}${receipt.command ? ` command=${boundedJsonString(receipt.command, 500)}` : ""}`,
      );
    }
  }
  lines.push(
    "Evidence scope: these facts establish changed paths and observed command/verifier outcomes only. They do not establish exact exported APIs, signatures, option shapes, parameter names, or parameter order. If the current request asks for any of those details, inspect the current source before answering.",
  );

  return {
    id: createContextItemId(),
    type: "summary",
    source: { kind: "session_turn_evidence", uri: String(turn.runId) },
    content: lines.join("\n"),
    metadata: {
      layer: "working",
      stability: "session",
      sessionId,
      runId: turn.runId,
      authoritativeRuntimeEvidence: true,
      exactImplementationClaimsRequireSource: true,
    },
  };
}

function boundedJsonString(value: string, maxChars: number): string {
  const bounded =
    value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
  return JSON.stringify(bounded);
}

function addSessionSubagentFact(
  facts: SessionTraceFacts,
  fact: NonNullable<SessionTraceFacts["subagents"]>[number],
): void {
  const existing = new Map(
    (facts.subagents ?? []).map((entry) => [entry.childRunId, entry]),
  );
  existing.set(fact.childRunId, { ...existing.get(fact.childRunId), ...fact });
  facts.subagents = [...existing.values()];
}

function sessionCompactWarningContextItem(
  sessionId: string,
  message: string,
  metadata: Record<string, unknown> = {},
): ContextItem {
  return {
    id: createContextItemId(),
    type: "summary",
    source: { kind: "session_compact_warning", uri: sessionId },
    content: message,
    metadata: {
      layer: "conversation",
      stability: "session",
      sessionId,
      compactionWarning: true,
      ...metadata,
    },
  };
}

function findNestedString(value: unknown, key: string): string | undefined {
  if (!isPlainRecord(value)) return undefined;
  const direct = recordString(value, key);
  if (direct) return direct;
  for (const nested of Object.values(value)) {
    const found = findNestedString(nested, key);
    if (found) return found;
  }
  return undefined;
}

function findNestedAgentBlockers(
  value: unknown,
):
  | NonNullable<NonNullable<SessionTraceFacts["subagents"]>[number]["blockers"]>
  | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (Array.isArray(value.blockers)) {
    const blockers = value.blockers
      .map(sessionAgentBlocker)
      .filter((blocker): blocker is NonNullable<typeof blocker> =>
        Boolean(blocker),
      )
      .slice(0, 16);
    return blockers.length > 0 ? blockers : undefined;
  }
  for (const nested of Object.values(value)) {
    const found = findNestedAgentBlockers(nested);
    if (found) return found;
  }
  return undefined;
}

function sessionAgentBlocker(value: unknown) {
  if (!isPlainRecord(value)) return undefined;
  const code = recordString(value, "code");
  if (!code) return undefined;
  const message = recordString(value, "message");
  return {
    code,
    ...(message ? { message } : {}),
  };
}

function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function sessionNotFound(sessionId: string): {
  ok: false;
  error: ProtocolError;
} {
  return {
    ok: false,
    error: {
      code: "session_not_found",
      message: `session not found: ${sessionId}`,
    },
  };
}

function protocolFailure(
  code: ProtocolError["code"],
  error: unknown,
): { ok: false; error: ProtocolError } {
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function recordString(value: unknown, key: string): string | undefined {
  return isPlainRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function recordNumber(value: unknown, key: string): number | undefined {
  return isPlainRecord(value) && typeof value[key] === "number"
    ? value[key]
    : undefined;
}

function recordNullableString(value: unknown, key: string): string | null {
  if (!isPlainRecord(value)) return null;
  return typeof value[key] === "string" ? value[key] : null;
}

function recordStringArray(value: unknown, key: string): string[] | undefined {
  if (!isPlainRecord(value) || !Array.isArray(value[key])) return undefined;
  const strings = value[key].filter(
    (entry): entry is string => typeof entry === "string",
  );
  return strings.length > 0 ? strings : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
