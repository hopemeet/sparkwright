import type { SparkwrightEvent } from "@sparkwright/core";

export type AgentLifecycleType =
  | "subagent.requested"
  | "subagent.started"
  | "subagent.completed"
  | "subagent.failed";

export interface AgentLifecycleProjection {
  type: AgentLifecycleType;
  childRunId?: string;
  parentRunId?: string;
  childAgentId?: string;
  agentProfileId?: string;
  entrypoint?: string;
  taskId?: string;
  terminalState?: string;
  identityConsistent: boolean;
}

/**
 * Normalize parent-visible Agent lifecycle events for cross-entrypoint contract
 * assertions. This deliberately excludes timestamps, sequence numbers, spans,
 * messages, and adapter-specific result bodies.
 */
export function projectAgentLifecycle(
  events: readonly SparkwrightEvent[],
  childRunId?: string,
): AgentLifecycleProjection[] {
  return events
    .filter((event): event is SparkwrightEvent & { type: AgentLifecycleType } =>
      isAgentLifecycleType(event.type),
    )
    .filter((event) => {
      if (!childRunId) return true;
      const payload = record(event.payload);
      return (
        stringValue(payload.childRunId) === childRunId ||
        stringValue(event.metadata.childRunId) === childRunId
      );
    })
    .map((event) => {
      const payload = record(event.payload);
      const payloadChildRunId = stringValue(payload.childRunId);
      const metadataChildRunId = stringValue(event.metadata.childRunId);
      const payloadParentRunId = stringValue(payload.parentRunId);
      const metadataParentRunId = stringValue(event.metadata.parentRunId);
      return {
        type: event.type,
        ...((payloadChildRunId ?? metadataChildRunId)
          ? { childRunId: payloadChildRunId ?? metadataChildRunId }
          : {}),
        ...((payloadParentRunId ?? metadataParentRunId)
          ? { parentRunId: payloadParentRunId ?? metadataParentRunId }
          : {}),
        ...(stringValue(event.metadata.childAgentId)
          ? { childAgentId: stringValue(event.metadata.childAgentId) }
          : {}),
        ...(stringValue(event.metadata.agentProfileId)
          ? { agentProfileId: stringValue(event.metadata.agentProfileId) }
          : {}),
        ...(stringValue(event.metadata.entrypoint)
          ? { entrypoint: stringValue(event.metadata.entrypoint) }
          : {}),
        ...((stringValue(payload.taskId) ?? stringValue(event.metadata.taskId))
          ? {
              taskId:
                stringValue(payload.taskId) ??
                stringValue(event.metadata.taskId),
            }
          : {}),
        ...(stringValue(payload.terminalState)
          ? { terminalState: stringValue(payload.terminalState) }
          : {}),
        identityConsistent:
          compatible(payloadChildRunId, metadataChildRunId) &&
          compatible(payloadParentRunId, metadataParentRunId),
      };
    });
}

export function lifecycleTypes(
  events: readonly SparkwrightEvent[],
  childRunId?: string,
): AgentLifecycleType[] {
  return projectAgentLifecycle(events, childRunId).map((event) => event.type);
}

export function terminalLifecycleCount(
  events: readonly SparkwrightEvent[],
  childRunId?: string,
): number {
  return projectAgentLifecycle(events, childRunId).filter(
    (event) =>
      event.type === "subagent.completed" || event.type === "subagent.failed",
  ).length;
}

function isAgentLifecycleType(value: string): value is AgentLifecycleType {
  return (
    value === "subagent.requested" ||
    value === "subagent.started" ||
    value === "subagent.completed" ||
    value === "subagent.failed"
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compatible(left: string | undefined, right: string | undefined) {
  return left === undefined || right === undefined || left === right;
}
