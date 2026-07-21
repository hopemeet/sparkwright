import type { RunEvent } from "./event-type.js";

const QUIET_SUCCESS_TOOLS = new Set([
  "skill_load",
  "tool_search",
  "todo_write",
]);

export interface ConversationProjection {
  /** Tool-call ids whose request is hidden as internal conversation plumbing. */
  quietToolCalls: Map<string, string>;
}

export function createConversationProjection(): ConversationProjection {
  return { quietToolCalls: new Map<string, string>() };
}

/**
 * Decide whether an event belongs in the default conversation transcript.
 *
 * This does not discard telemetry: Activity/Trace still receive the complete
 * event stream. The projection only removes successful orchestration details
 * that do not help a user understand the decision or outcome. Failures and
 * denials remain visible.
 */
export function shouldShowInConversation(
  event: RunEvent,
  projection: ConversationProjection,
): boolean {
  const payload = rec(event.payload);

  switch (event.type) {
    case "tool.batch.requested":
    case "tool.batch.completed":
    case "skill.loaded":
      return false;

    case "approval.resolved":
      return str(payload.decision) !== "approved";

    case "mcp.server.prepared":
      return !isSuccessfulMcpPreparation(payload);

    case "tool.requested": {
      const toolName = str(payload.toolName);
      if (!QUIET_SUCCESS_TOOLS.has(toolName)) return true;
      const toolCallId = requestedToolCallId(payload);
      if (toolCallId) projection.quietToolCalls.set(toolCallId, toolName);
      return false;
    }

    case "tool.completed": {
      const toolCallId = completedToolCallId(payload);
      const toolName =
        str(payload.toolName) ||
        projection.quietToolCalls.get(toolCallId) ||
        "";
      const isQuietTool = QUIET_SUCCESS_TOOLS.has(toolName);
      if (toolCallId) projection.quietToolCalls.delete(toolCallId);
      if (!isQuietTool) return true;

      // A missing skill is an actionable result even though the tool transport
      // completed normally. Keep it in the conversation; loaded skill bodies
      // and loaded reference resources are quiet successes.
      if (toolName === "skill_load") {
        const status = rec(payload.result ?? payload.output).status;
        return status !== "loaded" && status !== "resource";
      }
      return false;
    }

    case "tool.failed": {
      // Transport and semantic failures are always conversation-worthy.
      return true;
    }

    default:
      return true;
  }
}

function isSuccessfulMcpPreparation(payload: Record<string, unknown>): boolean {
  if (str(payload.errorCode) || Object.keys(rec(payload.error)).length > 0) {
    return false;
  }
  const status = str(payload.status).toLowerCase();
  return !status || status === "prepared" || status === "ready";
}

function requestedToolCallId(payload: Record<string, unknown>): string {
  return str(payload.id) || str(payload.toolCallId);
}

function completedToolCallId(payload: Record<string, unknown>): string {
  return str(payload.toolCallId) || str(payload.id);
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
