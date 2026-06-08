import type { SparkwrightEvent } from "@sparkwright/core";

export interface CliRunEventSummary {
  toolFailures: Array<{ code?: string }>;
  writeCompleted: number;
  writeSkipped: number;
  writeDenied: number;
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

function toolFailureCode(event: SparkwrightEvent): string | undefined {
  const payload = event.payload as {
    error?: { code?: string };
  };
  return payload.error?.code;
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
