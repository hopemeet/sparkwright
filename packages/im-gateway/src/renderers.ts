import type { HostEvent } from "@sparkwright/sdk-node";
import type { ApprovalPrompt } from "./types.js";

export function renderHostEvent(event: HostEvent): string | null {
  if (event.kind === "run.completed") {
    const reason = event.payload.stopReason
      ? ` (${event.payload.stopReason})`
      : "";
    return `Done: run ${event.payload.runId} ${event.payload.state}${reason}`;
  }
  if (event.kind === "run.failed") {
    return `Run failed: ${event.payload.error.message}`;
  }
  if (event.kind !== "run.event") return null;

  const inner = event.payload.event as
    | { type?: string; payload?: unknown; metadata?: unknown }
    | undefined;
  if (!inner?.type) return null;
  if (inner.type === "model.stream.chunk") {
    const chunk = extractText(inner.payload);
    return chunk ? chunk : null;
  }
  if (inner.type === "tool.progress") {
    const text = extractText(inner.payload);
    return text ? `Progress: ${text}` : null;
  }
  return null;
}

export function renderApprovalPrompt(prompt: ApprovalPrompt): string {
  const lines = [
    "Approval requested",
    prompt.summary,
    `Action: ${prompt.action}`,
  ];
  const path = prompt.details?.path;
  if (typeof path === "string") lines.push(`Path: ${path}`);
  return lines.join("\n");
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const key of ["text", "content", "message", "delta"]) {
    if (typeof obj[key] === "string") return obj[key] as string;
  }
  return null;
}
