import type { SparkwrightEvent } from "@sparkwright/core";

export interface CliRunEventSummary {
  toolFailures: Array<{ code?: string }>;
  writeCompleted: number;
  writeSkipped: number;
  writeDenied: number;
  runFailure?: CliRunFailureSummary;
}

export interface CliRunFailureSummary {
  reason?: string;
  code?: string;
  message?: string;
  failure?: {
    category?: string;
    code?: string;
    message?: string;
    retryable?: boolean;
  };
  metadata?: Record<string, unknown>;
}

export function createCliRunEventSummary(): CliRunEventSummary {
  return {
    toolFailures: [],
    writeCompleted: 0,
    writeSkipped: 0,
    writeDenied: 0,
  };
}

export function updateCliRunEventSummary(
  summary: CliRunEventSummary,
  event: SparkwrightEvent,
): void {
  if (event.type === "tool.failed") {
    summary.toolFailures.push({ code: toolFailureCode(event) });
  } else if (event.type === "workspace.write.completed")
    summary.writeCompleted += 1;
  else if (event.type === "workspace.write.skipped") summary.writeSkipped += 1;
  else if (event.type === "workspace.write.denied") summary.writeDenied += 1;
  else if (event.type === "run.failed")
    summary.runFailure = runFailureSummary(event);
}

export function unhandledToolFailureCount(summary: CliRunEventSummary): number {
  const unhandled = summary.toolFailures.filter(
    (failure) => !isPolicyOrApprovalFailure(failure.code),
  ).length;
  return Math.max(0, unhandled - summary.writeDenied);
}

export function cliExitCodeForRun(input: {
  failedMessage?: string;
  runState?: string;
  events: CliRunEventSummary;
}): number {
  if (input.failedMessage) return 1;
  if (input.runState === "failed" || input.runState === "cancelled") return 1;
  return unhandledToolFailureCount(input.events) > 0 ? 1 : 0;
}

export function summarizeWorkspaceMutations(input: {
  shouldWrite: boolean;
  completed: number;
  skipped: number;
  denied: number;
}): string {
  const { shouldWrite, completed, skipped, denied } = input;
  if (completed === 0 && skipped === 0 && denied === 0) {
    return shouldWrite
      ? "No workspace changes were made (no write was attempted)."
      : "No workspace changes were made (read-only run).";
  }
  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} applied`);
  if (skipped > 0) parts.push(`${skipped} skipped (no-op)`);
  if (denied > 0) parts.push(`${denied} denied`);
  return `Workspace writes: ${parts.join(", ")}.`;
}

export function summarizeUnhandledToolFailures(
  summary: CliRunEventSummary,
): string | undefined {
  const count = unhandledToolFailureCount(summary);
  if (count === 0) return undefined;
  return `Run completed with ${count} unhandled tool failure${count === 1 ? "" : "s"}; see trace for details.`;
}

export function summarizeRunFailure(
  summary: CliRunEventSummary,
  fallback?: { state?: string; stopReason?: string },
): string | undefined {
  const failed = summary.runFailure;
  if (!failed) {
    if (fallback?.state === "failed") {
      return `Run failed${fallback.stopReason ? ` (${fallback.stopReason})` : ""}.`;
    }
    return undefined;
  }

  return summarizeCliRunFailureSummary(failed, fallback);
}

export function summarizeTerminalRunFailure(input: {
  state?: string;
  stopReason?: string;
  failure?: unknown;
}): string | undefined {
  const failure = isRecord(input.failure) ? input.failure : undefined;
  if (!failure) {
    return summarizeRunFailure(createCliRunEventSummary(), {
      state: input.state,
      stopReason: input.stopReason,
    });
  }

  return summarizeCliRunFailureSummary(
    {
      reason: input.stopReason,
      code: stringValue(failure.code),
      message: stringValue(failure.message),
      failure: {
        category: stringValue(failure.category),
        code: stringValue(failure.code),
        message: stringValue(failure.message),
        retryable: booleanValue(failure.retryable),
      },
      metadata: isRecord(failure.metadata) ? failure.metadata : undefined,
    },
    { state: input.state, stopReason: input.stopReason },
  );
}

function summarizeCliRunFailureSummary(
  failed: CliRunFailureSummary,
  fallback?: { state?: string; stopReason?: string },
): string | undefined {
  const message =
    failed.message ??
    failed.failure?.message ??
    (fallback?.state === "failed" ? "Run failed." : undefined);
  if (!message) return undefined;

  const modelError = isRecord(failed.metadata?.modelError)
    ? failed.metadata.modelError
    : undefined;
  const category = stringValue(failed.failure?.category);
  const modelCategory = stringValue(modelError?.category);
  const status = numberValue(modelError?.status);
  const retryable =
    typeof failed.failure?.retryable === "boolean"
      ? failed.failure.retryable
      : booleanValue(modelError?.retryable);
  const code = failed.code ?? failed.failure?.code;

  const details = [
    failed.reason ? `reason=${failed.reason}` : "",
    code ? `code=${code}` : "",
    category ? `category=${category}` : "",
    modelCategory ? `model=${modelCategory}` : "",
    status !== undefined ? `status=${status}` : "",
    retryable !== undefined ? `retryable=${retryable}` : "",
  ].filter(Boolean);

  const prefix =
    category === "model" || modelCategory ? "Model failed" : "Run failed";
  return `${prefix}: ${message}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

function toolFailureCode(event: SparkwrightEvent): string | undefined {
  const payload = event.payload as {
    error?: { code?: string };
  };
  return payload.error?.code;
}

function runFailureSummary(event: SparkwrightEvent): CliRunFailureSummary {
  const payload = event.payload as Record<string, unknown>;
  const failure = isRecord(payload.failure) ? payload.failure : undefined;
  return {
    reason: stringValue(payload.reason),
    code: stringValue(payload.code),
    message: stringValue(payload.message),
    ...(failure
      ? {
          failure: {
            category: stringValue(failure.category),
            code: stringValue(failure.code),
            message: stringValue(failure.message),
            retryable: booleanValue(failure.retryable),
          },
        }
      : {}),
    metadata: isRecord(payload.metadata) ? payload.metadata : undefined,
  };
}

function isPolicyOrApprovalFailure(code: string | undefined): boolean {
  if (!code) return false;
  const normalized = code.toLowerCase();
  return (
    normalized === "tool_denied" ||
    normalized === "untracked_workspace_mutation" ||
    normalized.endsWith("_denied") ||
    normalized.includes("safety")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
