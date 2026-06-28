import type { SparkwrightEvent } from "@sparkwright/core";
import { isLiveDebugNoiseEventType } from "@sparkwright/protocol";

export interface LiveEventFormatOptions {
  verbose?: boolean;
}

export interface LiveEventFormatter {
  format(event: SparkwrightEvent): string[];
  flush(): string[];
}

export function shouldPrintLiveEvent(
  event: SparkwrightEvent,
  options: LiveEventFormatOptions = {},
): boolean {
  return Boolean(options.verbose) || !isLiveDebugNoiseEventType(event.type);
}

export function createLiveEventFormatter(
  options: LiveEventFormatOptions = {},
): LiveEventFormatter {
  const suppressed = new Map<string, number>();
  let lastSuppressedSequence: number | undefined;

  function flush(): string[] {
    if (suppressed.size === 0) return [];
    const total = [...suppressed.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
    const byType = [...suppressed.entries()]
      .map(([type, count]) => `${type}=${count}`)
      .join(" ");
    suppressed.clear();
    const sequence =
      typeof lastSuppressedSequence === "number"
        ? String(lastSuppressedSequence)
        : "-";
    lastSuppressedSequence = undefined;
    return [`[${sequence}] live.debug.suppressed ${total} event(s): ${byType}`];
  }

  return {
    format(event) {
      if (shouldPrintLiveEvent(event, options)) {
        return [...flush(), formatEvent(event)];
      }
      suppressed.set(event.type, (suppressed.get(event.type) ?? 0) + 1);
      lastSuppressedSequence = event.sequence;
      return [];
    },
    flush,
  };
}

export function formatEvent(event: SparkwrightEvent): string {
  const payload = event.payload;

  if (event.type === "run.completed" && isRecord(payload)) {
    return `[${event.sequence}] ${event.type} ${String(payload.reason ?? "")}`.trim();
  }

  if (event.type === "run.failed" && isRecord(payload)) {
    return `[${event.sequence}] ${event.type} ${String(payload.reason ?? "")} ${String(payload.code ?? "")}`.trim();
  }

  if (event.type === "model.completed" && isRecord(payload)) {
    const trace = isRecord(payload.trace) ? payload.trace : {};
    const usage = isRecord(payload.usage) ? payload.usage : {};
    const toolCallCount = Array.isArray(payload.toolCalls)
      ? payload.toolCalls.length
      : payload.toolCallCount;
    const message = typeof payload.message === "string" ? payload.message : "";
    return [
      `[${event.sequence}] ${event.type}`,
      `step=${String(payload.step ?? trace.step ?? "?")}`,
      `adapter=${String(trace.adapterId ?? "")}`,
      `tokens=${String(usage.totalTokens ?? payload.totalTokens ?? "")}`,
      `toolCalls=${String(toolCallCount ?? 0)}`,
      message ? `message=${previewText(message)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (event.type === "validation.failed" && isRecord(payload)) {
    const result = isRecord(payload.result) ? payload.result : {};
    const findings = Array.isArray(result.findings) ? result.findings : [];
    const firstFinding = findings.find(isRecord);
    return `[${event.sequence}] ${event.type} ${String(payload.stage ?? "")} ${String(payload.hookName ?? "")} ${String(firstFinding?.code ?? "")}`.trim();
  }

  if (event.type === "capability.index.failed" && isRecord(payload)) {
    const severity = stringField(payload, "severity");
    const kind = stringField(payload, "kind");
    const code = stringField(payload, "code");
    const profileId = stringField(payload, "profileId");
    const message = stringField(payload, "message");
    const source = stringField(payload, "source");
    return [
      `[${event.sequence}] ${event.type}`,
      severity ? `severity=${severity}` : "",
      kind,
      code,
      profileId,
      message
        ? `message=${previewText(message)}`
        : source
          ? `source=${source}`
          : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (event.type === "agent.routing.evaluated" && isRecord(payload)) {
    return [
      `[${event.sequence}] ${event.type}`,
      `mode=${String(payload.mode ?? "")}`,
      `delegates=${String(payload.delegateCount ?? "")}`,
      `relevant=${String(payload.relevantCount ?? "")}`,
      `low=${String(payload.lowCount ?? "")}`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (
    (event.type === "tool.requested" || event.type === "tool.started") &&
    isRecord(payload)
  ) {
    return `[${event.sequence}] ${event.type} ${String(payload.toolName ?? "")}`.trim();
  }

  if (
    (event.type === "tool.completed" || event.type === "tool.failed") &&
    isRecord(payload)
  ) {
    const output = isRecord(payload.output) ? payload.output : {};
    const error = isRecord(payload.error) ? payload.error : {};
    const errorMetadata = isRecord(error.metadata) ? error.metadata : {};
    const path = String(output.path ?? errorMetadata.path ?? "");
    return [
      `[${event.sequence}] ${event.type}`,
      String(payload.toolName ?? ""),
      `status=${String(payload.status ?? "")}`,
      path ? `path=${path}` : "",
      event.type === "tool.failed"
        ? `error=${String(payload.errorCode ?? error.code ?? "")}`
        : "",
      `artifacts=${String(
        Array.isArray(payload.artifacts)
          ? payload.artifacts.length
          : (payload.artifactCount ?? 0),
      )}`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (event.type === "approval.requested" && isRecord(payload)) {
    return `[${event.sequence}] ${event.type} ${String(payload.summary ?? "")}`.trim();
  }

  if (event.type === "workspace.write.requested" && isRecord(payload)) {
    return `[${event.sequence}] ${event.type} ${String(payload.path ?? "")}`.trim();
  }

  return `[${event.sequence}] ${event.type}`;
}

function previewText(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max
    ? `${normalized.slice(0, Math.max(0, max - 3))}...`
    : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
