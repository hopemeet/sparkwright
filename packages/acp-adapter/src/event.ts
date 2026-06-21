import type {
  AgentSideConnection,
  PermissionOption,
  SessionNotification,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { HostEvent } from "@sparkwright/protocol";
import type { AcpSessionInfo } from "./session.js";

type AcpConnection = Pick<
  AgentSideConnection,
  "requestPermission" | "sessionUpdate"
>;

const permissionOptions: PermissionOption[] = [
  { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
];

interface AcpTextRoutingState {
  streamedMessageIds: Set<string>;
  streamedRunIds: Set<string>;
}

const textRoutingBySession = new WeakMap<AcpSessionInfo, AcpTextRoutingState>();

export async function routeHostEventToAcp(input: {
  session: AcpSessionInfo;
  connection: AcpConnection;
  event: HostEvent;
}): Promise<void> {
  const { session, connection, event } = input;
  if (event.kind === "approval.requested") {
    void requestApprovalThroughAcp({ session, connection, event });
    return;
  }

  const updates = hostEventToSessionUpdates(event, textRoutingState(session));
  for (const update of updates) {
    await connection.sessionUpdate({
      sessionId: session.sessionId,
      update,
    });
  }
}

export function hostEventToSessionUpdates(
  event: HostEvent,
  state?: AcpTextRoutingState,
): SessionNotification["update"][] {
  switch (event.kind) {
    case "run.event":
      return coreEventToSessionUpdates(event.payload.event, state);
    case "run.completed":
      return [];
    case "run.failed":
      return [
        agentText(
          `Run failed: ${event.payload.error.message}`,
          event.payload.runId || "run_failed",
        ),
      ];
    case "run.continuation":
      return [];
    case "host.log":
      return [];
    case "host.ready":
    case "approval.requested":
      return [];
  }
}

function coreEventToSessionUpdates(
  event: unknown,
  state?: AcpTextRoutingState,
): SessionNotification["update"][] {
  if (!isRecord(event)) return [];
  const type = stringValue(event.type);
  const payload = isRecord(event.payload) ? event.payload : {};
  const runId = stringValue(event.runId) ?? stringValue(payload.runId);
  const messageId =
    stringValue(payload.messageId) ??
    stringValue(payload.id) ??
    runId ??
    stringValue(event.id);

  switch (type) {
    case "model.stream.chunk": {
      const text = textFromAny(payload, ["text", "delta", "content"]);
      if (!text) return [];
      if (messageId) state?.streamedMessageIds.add(messageId);
      if (runId) state?.streamedRunIds.add(runId);
      return [agentText(text, messageId)];
    }
    case "model.assistant_text":
    case "model.completed": {
      const text = textFromAny(payload, ["message", "text", "content"]);
      if (hasStreamedText(state, { messageId, runId })) return [];
      return text ? [agentText(text, messageId)] : [];
    }
    case "tool.requested":
      return [
        {
          sessionUpdate: "tool_call",
          ...pendingToolCall({
            toolCallId: stringValue(payload.id) ?? messageId ?? "tool_call",
            toolName: stringValue(payload.toolName) ?? "tool",
            rawInput: payload.arguments,
          }),
        },
      ];
    case "tool.started":
      return [
        {
          sessionUpdate: "tool_call_update",
          ...toolUpdate({
            toolCallId:
              stringValue(payload.toolCallId) ?? messageId ?? "tool_call",
            toolName: stringValue(payload.toolName) ?? "tool",
            status: "in_progress",
          }),
        },
      ];
    case "tool.completed":
      return [
        {
          sessionUpdate: "tool_call_update",
          ...toolUpdate({
            toolCallId:
              stringValue(payload.toolCallId) ?? messageId ?? "tool_call",
            toolName: stringValue(payload.toolName) ?? "tool",
            status: "completed",
            rawOutput: payload.output ?? payload,
            contentText: summarizeToolOutput(payload),
          }),
        },
      ];
    case "tool.failed":
      return [
        {
          sessionUpdate: "tool_call_update",
          ...toolUpdate({
            toolCallId:
              stringValue(payload.toolCallId) ?? messageId ?? "tool_call",
            toolName: stringValue(payload.toolName) ?? "tool",
            status: "failed",
            rawOutput: payload.error ?? payload,
            contentText: errorMessage(payload.error) ?? "Tool failed.",
          }),
        },
      ];
    case "workspace.write.completed":
    case "workspace.write.denied":
    case "artifact.created":
      return [];
    default:
      return [];
  }
}

function textRoutingState(session: AcpSessionInfo): AcpTextRoutingState {
  const existing = textRoutingBySession.get(session);
  if (existing) return existing;
  const created = {
    streamedMessageIds: new Set<string>(),
    streamedRunIds: new Set<string>(),
  };
  textRoutingBySession.set(session, created);
  return created;
}

function hasStreamedText(
  state: AcpTextRoutingState | undefined,
  input: { messageId: string | undefined; runId: string | undefined },
): boolean {
  if (!state) return false;
  if (input.messageId) return state.streamedMessageIds.has(input.messageId);
  return Boolean(input.runId && state.streamedRunIds.has(input.runId));
}

async function requestApprovalThroughAcp(input: {
  session: AcpSessionInfo;
  connection: AcpConnection;
  event: Extract<HostEvent, { kind: "approval.requested" }>;
}): Promise<void> {
  const { session, connection, event } = input;
  const result = await connection
    .requestPermission({
      sessionId: session.sessionId,
      toolCall: {
        toolCallId: event.payload.approvalId,
        title: event.payload.summary,
        status: "pending",
        kind: kindForAction(event.payload.action),
        rawInput: event.payload.details ?? {},
        locations: locationsFromDetails(event.payload.details),
      },
      options: permissionOptions,
    })
    .catch(() => undefined);

  const approved =
    result?.outcome.outcome === "selected" &&
    result.outcome.optionId === "allow_once";
  session.runtime.resolveApproval(
    event.payload.approvalId,
    approved ? "approved" : "denied",
  );
}

function agentText(
  text: string,
  messageId: string | undefined,
): SessionNotification["update"] {
  return {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
  };
}

function pendingToolCall(input: {
  toolCallId: string;
  toolName: string;
  rawInput?: unknown;
}): ToolCall {
  return {
    toolCallId: input.toolCallId,
    title: input.toolName,
    status: "pending",
    kind: kindForAction(input.toolName),
    rawInput: input.rawInput ?? {},
    locations: [],
  };
}

function toolUpdate(input: {
  toolCallId: string;
  toolName: string;
  status: ToolCallUpdate["status"];
  rawOutput?: unknown;
  contentText?: string;
}): ToolCallUpdate {
  return {
    toolCallId: input.toolCallId,
    title: input.toolName,
    status: input.status,
    kind: kindForAction(input.toolName),
    rawOutput: input.rawOutput,
    ...(input.contentText
      ? { content: [textToolContent(input.contentText)] }
      : {}),
  };
}

function textToolContent(text: string): ToolCallContent {
  return {
    type: "content",
    content: { type: "text", text },
  };
}

function kindForAction(action: string): ToolKind {
  const normalized = action.toLowerCase();
  if (normalized.includes("write") || normalized.includes("edit"))
    return "edit";
  if (normalized.includes("read")) return "read";
  if (normalized.includes("grep") || normalized.includes("glob"))
    return "search";
  if (normalized.includes("shell") || normalized.includes("bash"))
    return "execute";
  return "other";
}

function locationsFromDetails(details: Record<string, unknown> | undefined) {
  const path = stringValue(details?.path);
  return path ? [{ path }] : [];
}

function summarizeToolOutput(payload: Record<string, unknown>): string {
  const output = payload.output;
  if (typeof output === "string") return output;
  if (output === undefined) return "Tool completed.";
  try {
    return JSON.stringify(output);
  } catch {
    return "Tool completed.";
  }
}

function textFromAny(
  payload: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = stringValue(payload[key]);
    if (value) return value;
  }
  return undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (isRecord(value)) return stringValue(value.message);
  return stringValue(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
