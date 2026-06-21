// AI maintenance note: shared trace codec/filter/redaction leaf. Keep this
// module free of trace facade, diagnostics, and store imports.

import { createHash } from "node:crypto";
import type { SparkwrightEvent } from "./events.js";

interface PromptMessageLike {
  role: string;
  content: string;
}

export type TraceLevel = "standard" | "debug";
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

  return {
    ...event,
    payload: standardPayload(event),
  };
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
    case "extension.process.progress":
      return processProgressSnapshot(event);
    default:
      return event.payload;
  }
}

function processProgressSnapshot(event: SparkwrightEvent): unknown {
  if (!isRecord(event.payload)) return summarizeValue(event.payload);
  const out: Record<string, unknown> = {
    sequence: event.sequence,
    timestamp: event.timestamp,
    monotonicUs: event.monotonicUs,
  };
  for (const key of ["invocationId", "message", "channel", "data"]) {
    if (key in event.payload) out[key] = summarizeValue(event.payload[key]);
  }
  return out;
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
  const messages = rawMessages as PromptMessageLike[];
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
    toolName: payload.toolName,
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

function leadingSystemPrefix(
  messages: PromptMessageLike[],
): PromptMessageLike[] {
  const prefix: PromptMessageLike[] = [];
  for (const message of messages) {
    if (message.role !== "system") break;
    prefix.push(message);
  }
  return prefix;
}

function hashSystemPrefix(prefix: PromptMessageLike[]): string {
  return createHash("sha256")
    .update(JSON.stringify(prefix))
    .digest("hex")
    .slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
