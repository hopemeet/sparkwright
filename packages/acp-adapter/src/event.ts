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

  const updates = hostEventToSessionUpdates(event);
  for (const update of updates) {
    await connection.sessionUpdate({
      sessionId: session.sessionId,
      update,
    });
  }
}

export function hostEventToSessionUpdates(
  event: HostEvent,
): SessionNotification["update"][] {
  switch (event.kind) {
    case "run.event":
      return coreEventToSessionUpdates(event.payload.event);
    case "run.completed":
      return [
        agentText(
          event.payload.todoHandoff?.message ??
            `Run ${event.payload.state}: ${event.payload.stopReason ?? "complete"}`,
          event.payload.runId,
        ),
      ];
    case "run.failed":
      return [
        agentText(
          `Run failed: ${event.payload.error.message}`,
          event.payload.runId || "run_failed",
        ),
      ];
    case "run.continuation":
      return [
        agentText(
          `Continuing run (${event.payload.reason}, #${event.payload.continuationCount}).`,
          event.payload.runId,
        ),
      ];
    case "host.log":
      return [];
    case "host.ready":
    case "approval.requested":
      return [];
  }
}

function coreEventToSessionUpdates(
  event: unknown,
): SessionNotification["update"][] {
  if (!isRecord(event)) return [];
  const type = stringValue(event.type);
  const payload = isRecord(event.payload) ? event.payload : {};
  const messageId = stringValue(event.id) ?? stringValue(event.runId);

  switch (type) {
    case "model.stream.chunk":
      return textFromAny(payload, ["text", "delta", "content"])
        ? [
            agentText(
              textFromAny(payload, ["text", "delta", "content"])!,
              messageId,
            ),
          ]
        : [];
    case "model.assistant_text":
    case "model.completed": {
      const text = textFromAny(payload, ["message", "text", "content"]);
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
      return [
        agentText(
          `Workspace write completed${pathSuffix(payload)}.`,
          messageId,
        ),
      ];
    case "workspace.write.denied":
      return [
        agentText(`Workspace write denied${pathSuffix(payload)}.`, messageId),
      ];
    case "artifact.created":
      return [
        agentText(`Artifact created${artifactSuffix(payload)}.`, messageId),
      ];
    default:
      return [];
  }
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

function pathSuffix(payload: Record<string, unknown>): string {
  const path = stringValue(payload.path);
  return path ? ` for ${path}` : "";
}

function artifactSuffix(payload: Record<string, unknown>): string {
  const id = stringValue(payload.id);
  const type = stringValue(payload.type);
  if (type && id) return `: ${type} ${id}`;
  if (id) return `: ${id}`;
  return "";
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
