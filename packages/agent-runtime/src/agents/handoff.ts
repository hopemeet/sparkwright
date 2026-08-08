import type { AgentHandoffPayload } from "./types.js";

export const AGENT_HANDOFF_CONTEXT_MAX_CHARS = 8_000;
const LIVE_AGENT_HANDOFF_FIELDS = new Set(["goal", "context", "label"]);

/** Parse model-facing handoffs, which expose only the canonical fields. */
export function parseAgentHandoffPayload(value: unknown): AgentHandoffPayload {
  if (!isRecord(value)) throw new Error("Agent handoff must be an object.");
  const unknownFields = Object.keys(value).filter(
    (field) => !LIVE_AGENT_HANDOFF_FIELDS.has(field),
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `Agent handoff accepts only goal, context, and label; received ${unknownFields.join(", ")}.`,
    );
  }
  return normalizeAgentHandoffPayload(value);
}

/**
 * Normalize the canonical handoff fields while accepting persisted task
 * envelopes. Tool schemas reject unknown live model input; this parser only
 * extracts data and never turns legacy fields into authority.
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
