import type { SparkwrightEvent } from "@sparkwright/core";

export interface WorkflowTraceObservedCommand {
  command: string;
  toolName: string;
  sequence: number;
}

export interface WorkflowTraceObservation {
  eventCount: number;
  goal?: string;
  terminalState?: string;
  tools: string[];
  readPaths: string[];
  writePaths: string[];
  verificationCommands: WorkflowTraceObservedCommand[];
  sawTodoWrite: boolean;
}

interface RequestedTool {
  toolName: string;
  command?: string;
}

export function observeWorkflowTraceEvents(
  inputEvents: readonly SparkwrightEvent[],
): WorkflowTraceObservation {
  const events = [...inputEvents].sort((left, right) => {
    const leftSeq = left.sequence ?? 0;
    const rightSeq = right.sequence ?? 0;
    return leftSeq - rightSeq;
  });
  const goal = events
    .map((event) => stringValue(recordValue(event.payload)?.goal))
    .find((value): value is string => value !== undefined);
  const terminalState = [...events]
    .reverse()
    .map((event) =>
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
        ? terminalStateFromEvent(event.type, recordValue(event.payload))
        : undefined,
    )
    .find((value): value is string => value !== undefined);
  const failedToolCallIds = failedToolCallIdSet(events);
  const tools = uniqueStrings(
    events
      .filter((event) => event.type === "tool.requested")
      .filter((event) => {
        const payload = recordValue(event.payload);
        const id = stringValue(payload?.id) ?? stringValue(payload?.toolCallId);
        return !id || !failedToolCallIds.has(id);
      })
      .map((event) => eventToolName(recordValue(event.payload)))
      .filter((value): value is string => value !== undefined)
      .map(normalizeWorkflowToolName)
      .filter((value): value is string => value !== undefined),
  );
  const readPaths = uniqueStrings(
    events
      .filter((event) => event.type === "workspace.read")
      .map((event) => stringValue(recordValue(event.payload)?.path))
      .filter((value): value is string => value !== undefined),
  );
  const writePaths = uniqueStrings(
    events
      .filter((event) => event.type === "workspace.write.completed")
      .map((event) => stringValue(recordValue(event.payload)?.path))
      .filter((value): value is string => value !== undefined),
  );
  const lastWriteSequence = events
    .filter((event) => event.type === "workspace.write.completed")
    .map((event) => event.sequence ?? 0)
    .at(-1);
  const requestedTools = requestedToolMap(events);
  const verificationCommands = collectVerificationCommands({
    events,
    requestedTools,
    afterSequence: lastWriteSequence,
  });
  const sawTodoWrite = events.some((event) => {
    const payload = recordValue(event.payload);
    const id = stringValue(payload?.id) ?? stringValue(payload?.toolCallId);
    return (
      event.type === "tool.requested" &&
      (!id || !failedToolCallIds.has(id)) &&
      eventToolName(payload) === "todo_write"
    );
  });

  return {
    eventCount: events.length,
    ...(goal ? { goal } : {}),
    ...(terminalState ? { terminalState } : {}),
    tools,
    readPaths,
    writePaths,
    verificationCommands,
    sawTodoWrite,
  };
}

function collectVerificationCommands(input: {
  events: readonly SparkwrightEvent[];
  requestedTools: ReadonlyMap<string, RequestedTool>;
  afterSequence: number | undefined;
}): WorkflowTraceObservedCommand[] {
  const commands: WorkflowTraceObservedCommand[] = [];
  const seen = new Set<string>();
  for (const event of input.events) {
    if (event.type !== "tool.completed") continue;
    if (
      input.afterSequence !== undefined &&
      (event.sequence ?? 0) <= input.afterSequence
    ) {
      continue;
    }
    const payload = recordValue(event.payload);
    const toolName = eventToolName(payload);
    if (!toolName || !isShellTool(toolName)) continue;
    if (stringValue(payload?.status) === "failed") continue;
    const callId =
      stringValue(payload?.toolCallId) ?? stringValue(payload?.id) ?? "";
    const requested = input.requestedTools.get(callId);
    const command =
      requested?.command ??
      commandFromRecord(payload) ??
      stringValue(payload?.command);
    if (!command || !isVerificationLikeCommand(command)) continue;
    if (seen.has(command)) continue;
    seen.add(command);
    commands.push({
      command,
      toolName: normalizeWorkflowToolName(toolName) ?? toolName,
      sequence: event.sequence ?? 0,
    });
  }
  return commands;
}

function failedToolCallIdSet(events: readonly SparkwrightEvent[]): Set<string> {
  const failed = new Set<string>();
  for (const event of events) {
    const payload = recordValue(event.payload);
    if (
      event.type !== "tool.failed" &&
      !(
        event.type === "tool.completed" &&
        stringValue(payload?.status) === "failed"
      )
    ) {
      continue;
    }
    const id = stringValue(payload?.toolCallId) ?? stringValue(payload?.id);
    if (id) failed.add(id);
  }
  return failed;
}

function requestedToolMap(
  events: readonly SparkwrightEvent[],
): Map<string, RequestedTool> {
  const requested = new Map<string, RequestedTool>();
  for (const event of events) {
    if (event.type !== "tool.requested") continue;
    const payload = recordValue(event.payload);
    const id = stringValue(payload?.id) ?? stringValue(payload?.toolCallId);
    const toolName = eventToolName(payload);
    if (!id || !toolName) continue;
    requested.set(id, {
      toolName,
      command: commandFromRecord(recordValue(payload?.arguments)),
    });
  }
  return requested;
}

function commandFromRecord(
  record: Record<string, unknown> | undefined,
): string | undefined {
  if (!record) return undefined;
  for (const key of ["command", "cmd", "script", "run"]) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function eventToolName(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  return stringValue(payload?.toolName) ?? stringValue(payload?.name);
}

export function normalizeWorkflowToolName(
  toolName: string,
): string | undefined {
  const normalized = toolName.trim();
  switch (normalized) {
    case "read_file":
    case "read":
      return "read";
    case "grep":
    case "search":
      return "grep";
    case "glob":
    case "list_dir":
      return "glob";
    case "write_file":
    case "write":
      return "write";
    case "edit_anchored_text":
    case "edit":
      return "edit";
    case "shell":
    case "bash":
      return "bash";
    case "todo_write":
      return "todo_write";
    case "delegate_agent":
    case "delegate_parallel":
    case "task_create":
      return normalized;
    default:
      return undefined;
  }
}

function isShellTool(toolName: string): boolean {
  const normalized = normalizeWorkflowToolName(toolName);
  return normalized === "bash";
}

function isVerificationLikeCommand(command: string): boolean {
  return /\b(test|tests|check|typecheck|lint|verify|build|release:check)\b/i.test(
    command,
  );
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.length > 0))];
}

function terminalStateFromEvent(
  type: SparkwrightEvent["type"],
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const explicit = stringValue(payload?.state);
  if (explicit) return explicit;
  switch (type) {
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
