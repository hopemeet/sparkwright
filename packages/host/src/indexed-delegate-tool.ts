import {
  defineTool,
  isToolConcurrencySafe,
  type ToolDefinition,
} from "@sparkwright/core";
import type {
  AgentProfile,
  DerivedChildAgentProfile,
} from "@sparkwright/agent-runtime";
import { markAgentInvocationEntrypoint } from "@sparkwright/agent-runtime";
import type { CapabilityDelegateToolConfig } from "./config.js";
import { delegateToolName } from "./delegate-capability.js";

export const DELEGATE_AGENT_TOOL_NAME = "delegate_agent";

interface DelegateAgentTask {
  toolName?: string;
  agentId?: string;
  goal: string;
  metadata?: Record<string, unknown>;
}

interface DelegateAgentTarget {
  delegate: CapabilityDelegateToolConfig;
  profile: AgentProfile;
  toolName: string;
  tool: ToolDefinition;
}

export function createDelegateAgentTool(input: {
  delegates: CapabilityDelegateToolConfig[];
  derivedAgents: DerivedChildAgentProfile[];
  delegateTools: ToolDefinition[];
}): ToolDefinition {
  const byProfile = new Map(
    input.derivedAgents.map((derived) => [
      derived.effectiveProfile.id,
      derived.effectiveProfile,
    ]),
  );
  const toolByName = new Map(
    input.delegateTools.map((tool) => [tool.name, tool]),
  );
  const targetByToolName = new Map<string, DelegateAgentTarget>();
  const targetByAgentId = new Map<string, DelegateAgentTarget>();
  for (const delegate of input.delegates) {
    const profile = byProfile.get(delegate.profileId);
    if (!profile) continue;
    const toolName = delegateToolName(delegate);
    const tool = toolByName.get(toolName);
    if (!tool) continue;
    const target = { delegate, profile, toolName, tool };
    targetByToolName.set(toolName, target);
    targetByAgentId.set(profile.id, target);
  }
  const availableAgentIds = [...targetByAgentId.keys()];
  const availableToolNames = [...targetByToolName.keys()];
  const availableHint =
    availableAgentIds.length > 0
      ? availableAgentIds
          .map((agentId) => {
            const target = targetByAgentId.get(agentId);
            return target ? `${agentId} (${target.toolName})` : agentId;
          })
          .join(", ")
      : "(none)";

  const resolveTarget = (task: DelegateAgentTask) => {
    const target = task.agentId
      ? targetByAgentId.get(task.agentId)
      : task.toolName
        ? targetByToolName.get(task.toolName)
        : undefined;
    if (target) return target;
    const targetName = task.agentId ?? task.toolName ?? "(missing)";
    throw new Error(
      `${DELEGATE_AGENT_TOOL_NAME} cannot find delegate target "${targetName}". Available agentId targets: ${availableHint}. Available toolName targets: ${availableToolNames.join(", ") || "(none)"}.`,
    );
  };

  return defineTool({
    name: DELEGATE_AGENT_TOOL_NAME,
    description:
      availableAgentIds.length > 0
        ? `Delegate one bounded sub-task to a configured agent by agentId. Use delegate_parallel instead when multiple read-only agents should run together. Available agents: ${availableHint}.`
        : "Delegate one bounded sub-task to a configured agent by agentId. No configured child agents are currently available.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description:
            "Configured agent profile id to run, for example reviewer. Prefer this and leave toolName unset.",
        },
        toolName: {
          type: "string",
          description:
            "Legacy delegate tool name to run. Prefer agentId unless the target is only known by tool name.",
        },
        goal: {
          type: "string",
          description: "Self-contained goal for that agent.",
        },
        metadata: {
          type: "object",
          description:
            "Optional structured metadata to attach to the child run.",
        },
      },
      required: ["goal"],
    },
    policy: { risk: "safe" },
    governance: {
      origin: { kind: "local", name: "sparkwright" },
      sideEffects: ["read"],
      idempotency: "conditional",
    },
    previewArgs(args) {
      const task = previewDelegateAgentArgs(args);
      if (!task) return undefined;
      const target = task.agentId ?? task.toolName;
      return target && task.goal ? `${target}: ${task.goal}` : undefined;
    },
    policyForArgs(args) {
      const task = parseDelegateAgentArgs(args);
      const target = resolveTarget(task);
      const delegatedArgs = delegateAgentToolArgs(task);
      const perTarget = target.tool.policyForArgs?.(delegatedArgs);
      return {
        policy: perTarget?.policy ?? target.tool.policy,
        governance: perTarget?.governance ?? target.tool.governance,
      };
    },
    isConcurrencySafe(args) {
      try {
        const task = parseDelegateAgentArgs(args);
        const target = resolveTarget(task);
        return isToolConcurrencySafe(target.tool, delegateAgentToolArgs(task));
      } catch {
        return false;
      }
    },
    isReplaySafe: false,
    async execute(args: unknown, ctx): Promise<unknown> {
      const task = parseDelegateAgentArgs(args);
      const target = resolveTarget(task);
      return target.tool.execute(delegateAgentToolArgs(task), ctx);
    },
  });
}

function parseDelegateAgentArgs(args: unknown): DelegateAgentTask {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${DELEGATE_AGENT_TOOL_NAME} expects an object argument.`);
  }
  const record = args as Record<string, unknown>;
  const agentId = optionalTargetStringField(record, "agentId");
  const toolName = optionalTargetStringField(record, "toolName");
  if (!agentId && !toolName) {
    throw new Error(
      `${DELEGATE_AGENT_TOOL_NAME} requires agentId or toolName.`,
    );
  }
  const metadata =
    record.metadata === undefined ? undefined : objectField(record, "metadata");
  return {
    ...(agentId ? { agentId } : {}),
    ...(toolName ? { toolName } : {}),
    goal: stringField(record, "goal"),
    ...(metadata ? { metadata } : {}),
  };
}

function previewDelegateAgentArgs(
  args: unknown,
): Pick<DelegateAgentTask, "agentId" | "toolName" | "goal"> | undefined {
  const record = previewRecord(args);
  const agentId = previewString(record.agentId).trim();
  const toolName = previewString(record.toolName).trim();
  const goal = previewString(record.goal).trim();
  return goal && (agentId || toolName)
    ? {
        ...(agentId ? { agentId } : {}),
        ...(toolName ? { toolName } : {}),
        goal,
      }
    : undefined;
}

function delegateAgentToolArgs(task: DelegateAgentTask): {
  goal: string;
  metadata?: Record<string, unknown>;
} {
  return markAgentInvocationEntrypoint(
    {
      goal: task.goal,
      ...(task.metadata ? { metadata: task.metadata } : {}),
    },
    "delegate_agent",
  );
}

function optionalTargetStringField(
  record: Record<string, unknown>,
  field: "agentId" | "toolName",
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${DELEGATE_AGENT_TOOL_NAME} ${field} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `${DELEGATE_AGENT_TOOL_NAME} ${field} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function objectField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = record[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${DELEGATE_AGENT_TOOL_NAME} ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function previewRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function previewString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
