import type {
  ToolDefinition,
  ToolRequestPreviewOptions,
  ToolSideEffect,
} from "@sparkwright/core";
import { canonicalToolName } from "./tool-identities.js";

export const AGENT_DEFAULT_READ_CHILD_TOOLS = ["read", "glob", "grep"] as const;

export const AGENT_READ_ONLY_CHILD_TOOLS = [
  "read",
  "glob",
  "grep",
  "list_dir",
] as const;

export const AGENT_WORKSPACE_WRITE_CHILD_TOOLS = [
  "write",
  "edit",
  "edit_anchored_text",
] as const;

export type AgentWorkspaceWriteGrant = {
  workspaceWrite: boolean;
  explicitWorkspaceWrite: boolean;
};

export interface AgentSpawnToolRequest {
  requestedTools: string[];
  workspaceWriteGrant: boolean;
}

export function parseAgentAllowedToolsFromRecord(
  record: Record<string, unknown>,
  toolName: string,
): string[] | undefined {
  if (record.allowedTools === undefined) return undefined;
  if (!Array.isArray(record.allowedTools)) {
    throw new Error(`${toolName} allowedTools must be an array.`);
  }
  const allowedTools = record.allowedTools.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${toolName} allowedTools must contain strings.`);
    }
    return canonicalToolName(value.trim());
  });
  if (new Set(allowedTools).size !== allowedTools.length) {
    throw new Error(`${toolName} allowedTools must not contain duplicates.`);
  }
  return allowedTools;
}

export function parseAgentWorkspaceWriteGrantFromRecord(
  record: Record<string, unknown>,
  toolName: string,
): AgentWorkspaceWriteGrant {
  if (record.grant === undefined) {
    return { workspaceWrite: false, explicitWorkspaceWrite: false };
  }
  if (
    typeof record.grant !== "object" ||
    record.grant === null ||
    Array.isArray(record.grant)
  ) {
    throw new Error(`${toolName} grant must be an object.`);
  }

  const grant = record.grant as Record<string, unknown>;
  const unknownKeys = Object.keys(grant).filter(
    (key) => key !== "workspaceWrite",
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `${toolName} grant contains unsupported fields: ${unknownKeys.join(
        ", ",
      )}.`,
    );
  }
  if (grant.workspaceWrite === undefined) {
    return { workspaceWrite: false, explicitWorkspaceWrite: false };
  }
  if (typeof grant.workspaceWrite !== "boolean") {
    throw new Error(`${toolName} grant.workspaceWrite must be a boolean.`);
  }
  return {
    workspaceWrite: grant.workspaceWrite,
    explicitWorkspaceWrite: true,
  };
}

export function resolveAgentSpawnToolRequest(input: {
  allowedTools?: readonly string[];
  grant: AgentWorkspaceWriteGrant;
  toolName: string;
}): AgentSpawnToolRequest {
  const requestedWorkspaceWriteTools = (input.allowedTools ?? []).filter(
    isAgentWorkspaceWriteChildTool,
  );
  if (
    input.grant.explicitWorkspaceWrite &&
    input.grant.workspaceWrite === false &&
    requestedWorkspaceWriteTools.length > 0
  ) {
    throw new Error(
      `${input.toolName} allowedTools includes workspace write tools but grant.workspaceWrite is false.`,
    );
  }
  if (
    input.grant.explicitWorkspaceWrite &&
    input.grant.workspaceWrite === true &&
    input.allowedTools !== undefined &&
    requestedWorkspaceWriteTools.length === 0
  ) {
    throw new Error(
      `${input.toolName} grant.workspaceWrite is true but allowedTools does not include workspace write tools.`,
    );
  }

  const workspaceWriteGrant =
    input.grant.workspaceWrite || requestedWorkspaceWriteTools.length > 0;
  const requestedTools =
    input.allowedTools === undefined
      ? [
          ...AGENT_DEFAULT_READ_CHILD_TOOLS,
          ...(workspaceWriteGrant ? AGENT_WORKSPACE_WRITE_CHILD_TOOLS : []),
        ]
      : [...input.allowedTools];

  return {
    requestedTools,
    workspaceWriteGrant,
  };
}

export function isAgentWorkspaceWriteChildTool(name: string): boolean {
  return (AGENT_WORKSPACE_WRITE_CHILD_TOOLS as readonly string[]).includes(
    canonicalToolName(name),
  );
}

export function agentWorkspaceWriteGrantPolicyForPayload(
  payload: unknown,
  source: string,
  extraSideEffects: readonly ToolSideEffect[] = [],
):
  | {
      policy?: ToolDefinition["policy"];
      governance?: ToolDefinition["governance"];
    }
  | undefined {
  const request = agentWorkspaceWriteGrantRequestFromPayload(payload, source);
  if (!request.workspaceWriteGrant) return undefined;
  return {
    policy: { risk: "risky", requiresApproval: true },
    governance: agentWorkspaceWriteGrantGovernance(source, extraSideEffects),
  };
}

/**
 * Classify a spawn-shaped agent request before Core forms concurrent tool
 * batches. Invalid requests fail closed to serial execution and are still
 * reported by the normal validation/policy path when executed.
 */
export function isAgentSpawnRequestConcurrencySafe(
  payload: unknown,
  source: string,
): boolean {
  try {
    return !agentWorkspaceWriteGrantRequestFromPayload(payload, source)
      .workspaceWriteGrant;
  } catch {
    return false;
  }
}

export function agentWorkspaceWriteGrantApprovalSummaryForPayload(
  payload: unknown,
  source: string,
  options: ToolRequestPreviewOptions,
): string | undefined {
  const request = agentWorkspaceWriteGrantRequestFromPayload(payload, source);
  if (!request.workspaceWriteGrant) return undefined;
  const record = payloadRecord(payload);
  const role = previewString(record.role);
  const goal = previewString(record.goal);
  const child =
    role && goal
      ? `"${role}" for ${goal}`
      : role
        ? `"${role}"`
        : goal || "child agent";
  const summary = `Grant workspace write to child ${child}`;
  return summary.length <= options.maxChars
    ? summary
    : `${summary.slice(0, Math.max(0, options.maxChars - 3))}...`;
}

export function agentWorkspaceWriteGrantGovernance(
  source: string,
  extraSideEffects: readonly ToolSideEffect[] = [],
): ToolDefinition["governance"] {
  return {
    origin: {
      kind: "local",
      name: "sparkwright",
      metadata: { capabilityGrant: "workspace.write", source },
    },
    sideEffects: [...new Set<ToolSideEffect>(["write", ...extraSideEffects])],
    idempotency: "conditional",
  };
}

function agentWorkspaceWriteGrantRequestFromPayload(
  payload: unknown,
  source: string,
): AgentSpawnToolRequest {
  const record = payloadRecord(payload);
  if (Object.keys(record).length === 0) {
    return {
      requestedTools: [...AGENT_DEFAULT_READ_CHILD_TOOLS],
      workspaceWriteGrant: false,
    };
  }
  return resolveAgentSpawnToolRequest({
    allowedTools: parseAgentAllowedToolsFromRecord(record, source),
    grant: parseAgentWorkspaceWriteGrantFromRecord(record, source),
    toolName: source,
  });
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function previewString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
