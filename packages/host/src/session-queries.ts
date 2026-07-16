import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  FileSessionStore,
  SESSION_COMPACT_FILENAME,
  asSessionId,
  buildTraceTimelineFile,
  forkSessionFromEvent,
  loadSessionCompactArtifact,
  summarizeTraceFile,
  validateSessionTraceConsistency,
  type SessionCompactArtifact,
  type SessionCompactionMeasurement,
  type SessionEvent,
} from "@sparkwright/core";
import type {
  ProtocolError,
  SessionCompactionInspectArtifact,
  SessionCompactionInspectEvent,
  SessionCompactionInspectReport,
} from "@sparkwright/protocol";

export interface SessionQueryContext {
  workspaceRoot: string;
  sessionRootDir?: string;
}

export type SessionInspectOptions = {
  compaction?: boolean;
};

export function sessionRootDirFor(context: SessionQueryContext): string {
  return (
    context.sessionRootDir ??
    join(context.workspaceRoot, ".sparkwright", "sessions")
  );
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
  sourceSessionId: string,
  forkAtSequence?: number,
): Promise<
  | {
      ok: true;
      forkedSessionId: string;
      copiedEventCount: number;
      truncatedAtSequence: number | null;
    }
  | { ok: false; error: ProtocolError }
> {
  let safeSource: string;
  try {
    safeSource = asSessionId(sourceSessionId);
  } catch (error) {
    return protocolFailure("invalid_payload", error);
  }
  try {
    const store = new FileSessionStore({ rootDir: sessionRootDirFor(context) });
    const result = await forkSessionFromEvent({
      sourceSessionId: safeSource,
      forkAtSequence,
      store,
      metadata: { forkedVia: "tui" },
    });
    return {
      ok: true,
      forkedSessionId: result.forked.id,
      copiedEventCount: result.copiedEventCount,
      truncatedAtSequence: result.truncatedAtSequence,
    };
  } catch (error) {
    return protocolFailure("internal_error", error);
  }
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
