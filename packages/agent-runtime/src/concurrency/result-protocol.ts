// AI maintenance note: SubAgentResult is the structured contract a sub-agent
// emits as its final message so the Leader can update todo state
// programmatically (not via LLM re-parsing). The contract is intentionally
// minimal — four fields the Leader actually uses to make scheduling and
// retry decisions.
//
// Parsing is forgiving: a sub-agent that returns a bare object, a fenced
// ```json``` block, or trailing prose around a JSON object is all accepted.
// When parsing fails, the helper returns a structured `invalid` outcome
// rather than throwing — the Leader treats this as a retryable failure.

import { globsOverlap } from "./coordinator.js";

/**
 * Final status reported by a sub-agent.
 *
 * @public
 * @stability experimental v0.1
 */
export type SubAgentStatus = "ok" | "fail" | "partial";

/**
 * Structured result a sub-agent emits as its closing message. The Leader
 * parses this with {@link parseSubAgentResult} and updates the todo file
 * accordingly.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SubAgentResult {
  status: SubAgentStatus;
  /** Globs (or exact paths) the sub-agent actually wrote. */
  writes: string[];
  /** Short human-readable explanation for the Leader. */
  notes: string;
  /** Hint to the Leader: should the same task be retried on failure? */
  retryable: boolean;
}

/**
 * Parse outcome. Either a validated {@link SubAgentResult} or an `invalid`
 * marker explaining what was wrong with the input.
 *
 * @public
 * @stability experimental v0.1
 */
export type ParseSubAgentResultOutcome =
  | { kind: "ok"; value: SubAgentResult }
  | { kind: "invalid"; reason: string; raw: string };

/**
 * Prompt fragment to splice into a sub-agent's system prompt. Tells the model
 * that its final message must end with a JSON object matching
 * {@link SubAgentResult}. Hosts may translate or extend this; the only
 * machine-readable requirement is the JSON shape itself.
 *
 * @public
 * @stability experimental v0.1
 */
export const SUB_AGENT_RESULT_PROMPT = `
Your final message MUST end with a JSON object matching this shape:

{
  "status": "ok" | "fail" | "partial",
  "writes": ["src/auth/foo.ts", "src/auth/bar.ts"],
  "notes": "one-line explanation for the parent",
  "retryable": true | false
}

Rules:
- "writes" lists files you actually modified (relative to the workspace).
- "status": "ok" means the sub-task is complete; "partial" means progress
  was made but more work remains; "fail" means you could not proceed.
- "retryable": true if a retry has a reasonable chance of succeeding; false
  if the task needs human or Leader intervention.
- You MAY include prose before the JSON. The parent parses only the LAST
  JSON object in your message.
`.trim();

/**
 * Try to parse a sub-agent's terminal message into a {@link SubAgentResult}.
 * Accepts a bare JSON object, a fenced ```json``` block, or a JSON object
 * embedded at the end of free-form prose.
 *
 * @public
 * @stability experimental v0.1
 */
export function parseSubAgentResult(raw: string): ParseSubAgentResultOutcome {
  const text = raw.trim();
  if (text.length === 0) {
    return { kind: "invalid", reason: "empty output", raw };
  }
  const candidate = extractJson(text);
  if (!candidate) {
    return {
      kind: "invalid",
      reason: "no JSON object found",
      raw,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (cause) {
    return {
      kind: "invalid",
      reason: `JSON parse error: ${(cause as Error).message}`,
      raw,
    };
  }
  return validateShape(parsed, raw);
}

function extractJson(text: string): string | undefined {
  // 1. Fenced ```json ... ``` (or plain ```) — take the LAST one.
  const fenceMatches = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  if (fenceMatches.length > 0) {
    return fenceMatches[fenceMatches.length - 1]![1]!.trim();
  }
  // 2. Last balanced `{...}` object in the string.
  const end = text.lastIndexOf("}");
  if (end < 0) return undefined;
  let depth = 0;
  for (let i = end; i >= 0; i -= 1) {
    const ch = text[i]!;
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(i, end + 1);
      }
    }
  }
  return undefined;
}

function validateShape(
  parsed: unknown,
  raw: string,
): ParseSubAgentResultOutcome {
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "invalid", reason: "not an object", raw };
  }
  const r = parsed as Record<string, unknown>;
  const status = r.status;
  if (status !== "ok" && status !== "fail" && status !== "partial") {
    return {
      kind: "invalid",
      reason: `status must be "ok" | "fail" | "partial"`,
      raw,
    };
  }
  if (!Array.isArray(r.writes) || r.writes.some((w) => typeof w !== "string")) {
    return {
      kind: "invalid",
      reason: "writes must be an array of strings",
      raw,
    };
  }
  if (typeof r.notes !== "string") {
    return { kind: "invalid", reason: "notes must be a string", raw };
  }
  if (typeof r.retryable !== "boolean") {
    return { kind: "invalid", reason: "retryable must be a boolean", raw };
  }
  return {
    kind: "ok",
    value: {
      status,
      writes: r.writes as string[],
      notes: r.notes,
      retryable: r.retryable,
    },
  };
}

/**
 * Outcome of {@link validateDeclaredWrites}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface WritesAuditResult {
  /**
   * Actual writes that were not covered by any declared glob.
   * @reserved Public audit field consumed by orchestration UIs.
   */
  violations: string[];
  /**
   * Declared globs that were never used (informational).
   * @reserved Public audit field consumed by orchestration UIs.
   */
  unused: string[];
}

/**
 * Audit a sub-agent's reported writes against what it was authorized to
 * touch. A non-empty `violations` list means the sub-agent wrote outside
 * its declared partition — the Leader should treat the task as failed
 * even if the sub-agent claimed `status: "ok"`.
 *
 * @public
 * @stability experimental v0.1
 */
export function validateDeclaredWrites(
  declared: string[],
  actual: string[],
): WritesAuditResult {
  const violations: string[] = [];
  for (const path of actual) {
    if (!declared.some((decl) => globsOverlap(decl, path))) {
      violations.push(path);
    }
  }
  const usedDeclared = new Set<string>();
  for (const decl of declared) {
    if (actual.some((path) => globsOverlap(decl, path))) {
      usedDeclared.add(decl);
    }
  }
  const unused = declared.filter((d) => !usedDeclared.has(d));
  return { violations, unused };
}
