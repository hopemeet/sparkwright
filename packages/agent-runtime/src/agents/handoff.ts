import type { AgentHandoffPayload } from "./types.js";

export const AGENT_HANDOFF_CONTEXT_MAX_CHARS = 8_000;

/**
 * Normalize the current handoff shape while accepting persisted v0 task
 * payloads. Legacy role/allowedTools/grant/maxSteps/metadata values never
 * regain authority: role is reduced to a display label and the rest are
 * ignored.
 */
export function normalizeAgentHandoffPayload(
  value: unknown,
): AgentHandoffPayload {
  if (!isRecord(value)) throw new Error("Agent handoff must be an object.");
  const goal = requiredString(value.goal, "goal");
  const context = optionalString(value.context, "context");
  if (context && context.length > AGENT_HANDOFF_CONTEXT_MAX_CHARS) {
    throw new Error(
      `Agent handoff context must be at most ${AGENT_HANDOFF_CONTEXT_MAX_CHARS} characters.`,
    );
  }
  const label =
    optionalString(value.label, "label") ?? optionalString(value.role, "role");
  return {
    goal,
    ...(context ? { context } : {}),
    ...(label ? { label } : {}),
  };
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value, field);
  if (!normalized) throw new Error(`Agent handoff ${field} must be non-empty.`);
  return normalized;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Agent handoff ${field} must be a string.`);
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
