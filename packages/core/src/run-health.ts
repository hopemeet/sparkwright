// AI maintenance note: shared run-health heuristics. Keep thresholds here so
// trace reports and the live run loop do not drift into separate definitions.

import { createHash } from "node:crypto";
import type { SparkwrightEvent } from "./events.js";
import { isRecord } from "./record-utils.js";

const REPEATED_TOOL_REQUEST_THRESHOLD = 3;
const LOW_PROGRESS_DUPLICATE_READ_THRESHOLD = 3;
const LOW_PROGRESS_MODEL_CALL_THRESHOLD = 6;
const READ_FEEDBACK_MIN_COUNT = 2;

export interface RepeatedToolRequest {
  label: string;
  count: number;
}

export interface LowNetProgressInput {
  modelCalls: number;
  toolCalls: number;
  budgetCheckCount: number;
  workspaceWrites: number;
  uniqueWritePaths: number;
  topDuplicateReads: Record<string, number>;
  repeatedToolRequests: readonly RepeatedToolRequest[];
  verificationLag?: { modelCallsAfterLastWrite: number; command: string };
}

export interface LowNetProgressAnalysis {
  evidence: string[];
  /** @reserved Public run-health diagnostic detail consumed by reports/UIs. */
  duplicateReads: Record<string, number>;
}

export interface RunHealthFeedback {
  code: "UNCHANGED_READ_REPEAT";
  toolName: string;
  path: string;
  count: number;
  nextUnreadOffset?: number;
  currentToolCallId?: string;
  previousToolCallId?: string;
  message: string;
}

interface ReadSnapshot {
  toolName: string;
  path: string;
  fingerprint: string;
  count: number;
  lastToolCallId?: string;
}

interface ReadProgress {
  path: string;
  maxEndLine?: number;
  totalLines?: number;
  hasMore: boolean;
}

export function collectRepeatedToolRequests(
  events: readonly SparkwrightEvent[],
): RepeatedToolRequest[] {
  const counts = new Map<string, RepeatedToolRequest>();

  for (const event of events) {
    if (event.type !== "tool.requested" || !isRecord(event.payload)) continue;
    const toolName = stringValue(event.payload.toolName);
    if (!toolName) continue;
    const args = stableDiagnosticJson(event.payload.arguments ?? {});
    const key = `${toolName}:${args}`;
    const label = truncateDiagnostic(`${toolName} ${args}`, 180);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { label, count: 1 });
  }

  return [...counts.values()]
    .filter((item) => item.count >= REPEATED_TOOL_REQUEST_THRESHOLD)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function analyzeLowNetProgress(
  input: LowNetProgressInput,
): LowNetProgressAnalysis | undefined {
  const lowMutationWork =
    input.modelCalls >= 8 &&
    input.toolCalls >= 6 &&
    input.uniqueWritePaths <= 2;
  const noMutationWork =
    input.modelCalls >= LOW_PROGRESS_MODEL_CALL_THRESHOLD &&
    input.toolCalls >= 10 &&
    input.workspaceWrites === 0;
  const repeatedRead = Object.values(input.topDuplicateReads).some(
    (count) => count >= LOW_PROGRESS_DUPLICATE_READ_THRESHOLD,
  );
  const delayedVerification =
    (input.verificationLag?.modelCallsAfterLastWrite ?? 0) >= 2;

  if (
    !lowMutationWork &&
    !noMutationWork &&
    !(input.modelCalls >= LOW_PROGRESS_MODEL_CALL_THRESHOLD && repeatedRead) &&
    !(
      input.modelCalls >= LOW_PROGRESS_MODEL_CALL_THRESHOLD &&
      delayedVerification
    )
  ) {
    return undefined;
  }

  const duplicateReads = firstEntries(input.topDuplicateReads, 3);
  const evidence = [
    `${input.modelCalls} model call(s)`,
    `${input.toolCalls} tool call(s)`,
    `${input.uniqueWritePaths} unique written file(s)`,
    input.workspaceWrites !== input.uniqueWritePaths
      ? `${input.workspaceWrites} completed write event(s)`
      : undefined,
    input.budgetCheckCount > 0
      ? `${input.budgetCheckCount} budget check event(s)`
      : undefined,
    Object.keys(duplicateReads).length > 0
      ? `duplicate reads: ${formatCountRecord(duplicateReads)}`
      : undefined,
    input.repeatedToolRequests.length > 0
      ? `repeated tool requests: ${input.repeatedToolRequests
          .slice(0, 3)
          .map((item) => `${item.count}x ${item.label}`)
          .join("; ")}`
      : undefined,
    input.verificationLag && delayedVerification
      ? `verification ran ${input.verificationLag.modelCallsAfterLastWrite} model call(s) after the last write: ${input.verificationLag.command}`
      : undefined,
  ].filter((value): value is string => typeof value === "string");

  return { evidence, duplicateReads };
}

export class RunHealthAnalyzer {
  private readonly readSnapshots = new Map<string, ReadSnapshot>();
  private readonly readProgress = new Map<string, ReadProgress>();
  private readonly pendingFeedback: RunHealthFeedback[] = [];

  observeEvent(event: SparkwrightEvent): void {
    if (!isRecord(event.payload)) return;
    if (event.type === "workspace.write.completed") {
      const path = stringValue(event.payload.path);
      if (path) this.clearReadSnapshotsForPath(path);
      return;
    }
    if (event.type === "tool.completed") {
      this.observeCompletedTool(event.payload);
    }
  }

  consumeFeedback(): RunHealthFeedback[] {
    const out = [...this.pendingFeedback];
    this.pendingFeedback.length = 0;
    return out;
  }

  private observeCompletedTool(payload: Record<string, unknown>): void {
    const toolName = stringValue(payload.toolName);
    if (!toolName || !isFileReadLikeTool(toolName)) return;
    const output = isRecord(payload.output) ? payload.output : undefined;
    if (!output) return;
    const path = stringValue(output.path, output.filePath);
    if (!path) return;
    const fingerprint = readResultFingerprint(output);
    if (!fingerprint) return;

    const key = readWindowKey(toolName, path, output);
    const progressKey = readProgressKey(toolName, path);
    const previousProgress = this.readProgress.get(progressKey);
    this.updateReadProgress(progressKey, path, output);
    const currentToolCallId = stringValue(payload.toolCallId, payload.id);
    const previous = this.readSnapshots.get(key);
    if (!previous || previous.fingerprint !== fingerprint) {
      this.readSnapshots.set(key, {
        toolName,
        path,
        fingerprint,
        count: 1,
        lastToolCallId: currentToolCallId,
      });
      return;
    }

    const count = previous.count + 1;
    const nextUnreadOffset = repeatedReadNextUnreadOffset(
      previousProgress,
      output,
    );
    this.readSnapshots.set(key, {
      ...previous,
      count,
      lastToolCallId: currentToolCallId,
    });
    if (count < READ_FEEDBACK_MIN_COUNT) return;

    this.pendingFeedback.push({
      code: "UNCHANGED_READ_REPEAT",
      toolName,
      path,
      count,
      currentToolCallId,
      previousToolCallId: previous.lastToolCallId,
      ...(nextUnreadOffset !== undefined ? { nextUnreadOffset } : {}),
      message: repeatedReadFeedbackMessage({
        toolName,
        path,
        count,
        nextUnreadOffset,
      }),
    });
  }

  private clearReadSnapshotsForPath(path: string): void {
    for (const [key, snapshot] of this.readSnapshots) {
      if (snapshot.path === path) this.readSnapshots.delete(key);
    }
    for (const [key, progress] of this.readProgress) {
      if (progress.path === path) this.readProgress.delete(key);
    }
  }

  private updateReadProgress(
    key: string,
    path: string,
    output: Record<string, unknown>,
  ): void {
    const endLine = optionalNumberValue(output.endLine);
    const totalLines = optionalNumberValue(output.totalLines);
    const hasMore = output.hasMore === true;
    const previous = this.readProgress.get(key);
    this.readProgress.set(key, {
      path,
      maxEndLine:
        endLine === undefined
          ? previous?.maxEndLine
          : Math.max(previous?.maxEndLine ?? 0, endLine),
      totalLines: totalLines ?? previous?.totalLines,
      hasMore,
    });
  }
}

function repeatedReadFeedbackMessage(input: {
  toolName: string;
  path: string;
  count: number;
  nextUnreadOffset?: number;
}): string {
  const next =
    input.nextUnreadOffset !== undefined
      ? ` Lines after this window were already read; if you still need to page forward, continue from offset ${input.nextUnreadOffset}.`
      : "";
  return (
    `\`${input.toolName}\` returned the same unchanged content for ` +
    `\`${input.path}\` ${input.count} times. Use the earlier observation ` +
    `instead of reading this same file window again, unless a new write or ` +
    `external change gives you a concrete reason to re-check it.` +
    next
  );
}

function repeatedReadNextUnreadOffset(
  progress: ReadProgress | undefined,
  output: Record<string, unknown>,
): number | undefined {
  if (!progress?.maxEndLine) return undefined;
  if (output.hasMore !== true && progress.hasMore !== true) return undefined;
  const startLine = optionalNumberValue(output.startLine);
  if (startLine !== undefined && startLine > progress.maxEndLine) {
    return undefined;
  }
  return progress.maxEndLine + 1;
}

function readWindowKey(
  toolName: string,
  path: string,
  output: Record<string, unknown>,
): string {
  const startLine = optionalNumberValue(output.startLine);
  const endLine = optionalNumberValue(output.endLine);
  const totalLines = optionalNumberValue(output.totalLines);
  const truncated = output.truncated === true;
  const hasMore = output.hasMore === true;
  return stableDiagnosticJson({
    toolName,
    path,
    startLine,
    endLine,
    totalLines,
    truncated,
    hasMore,
  });
}

function readProgressKey(toolName: string, path: string): string {
  return `${toolName}\u0000${path}`;
}

function readResultFingerprint(
  output: Record<string, unknown>,
): string | undefined {
  const content =
    typeof output.content === "string"
      ? output.content
      : Array.isArray(output.lines)
        ? stableDiagnosticJson(output.lines)
        : undefined;
  if (content === undefined) return undefined;
  return createHash("sha256")
    .update(
      stableDiagnosticJson({
        content,
        bytes: optionalNumberValue(output.bytes),
        totalLines: optionalNumberValue(output.totalLines),
        startLine: optionalNumberValue(output.startLine),
        endLine: optionalNumberValue(output.endLine),
        truncated: output.truncated === true,
        hasMore: output.hasMore === true,
      }),
    )
    .digest("hex");
}

function isFileReadLikeTool(toolName: string): boolean {
  return (
    toolName === "read" ||
    toolName === "read_file" ||
    toolName === "read_text" ||
    toolName === "read_anchored_text"
  );
}

function firstEntries(
  counts: Record<string, number>,
  limit: number,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit),
  );
}

function formatCountRecord(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key}:${count}`)
    .join(", ");
}

function stableDiagnosticJson(value: unknown): string {
  try {
    return JSON.stringify(stableDiagnosticValue(value));
  } catch {
    return String(value);
  }
}

function stableDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.slice(0, 20).map(stableDiagnosticValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .slice(0, 20)
      .map((key) => [key, stableDiagnosticValue(value[key])]),
  );
}

function truncateDiagnostic(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
