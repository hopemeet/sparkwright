import type { AgentProfile } from "@sparkwright/agent-runtime";
import {
  createToolSearchTool,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolOrigin,
} from "@sparkwright/core";
import { DISCOVERY_TOOL_NAME } from "./tool-selectors.js";

const PROFILE_SCOPED_TOOL_SEARCH_ORIGIN =
  "@sparkwright/host.agent-profile-scoped-tool-search";
const WORKFLOW_SCOPED_TOOL_SEARCH_ORIGIN =
  "@sparkwright/host.workflow-scoped-tool-search";

type AdmissionProfile = Pick<AgentProfile, "allowedTools" | "deniedTools">;

export interface ResolvedToolSurface {
  tools: ToolDefinition[];
}

/**
 * Physically narrow an upstream tool set for an Agent Profile. Discovery is
 * retained only when it already exists upstream and is rebuilt over exactly
 * the retained definitions, so it cannot reveal a filtered tool.
 */
export function admitToolsForAgentProfile<T>(
  upstream: readonly T[],
  profile: AdmissionProfile,
  definition: (item: T) => ToolDefinition,
  replaceDefinition: (item: T, definition: ToolDefinition) => T = (
    _item,
    replacement,
  ) => replacement as T,
): T[] {
  const directlyAdmitted = upstream.filter((item) => {
    const tool = definition(item);
    return (
      tool.name !== DISCOVERY_TOOL_NAME &&
      agentProfileAdmitsTool(tool.name, profile)
    );
  });
  const discovery = upstream.find(
    (item) => definition(item).name === DISCOVERY_TOOL_NAME,
  );
  if (
    !discovery ||
    !agentProfileAdmitsDiscovery(profile, directlyAdmitted, definition)
  ) {
    return directlyAdmitted;
  }
  return [
    ...directlyAdmitted,
    replaceDefinition(
      discovery,
      createScopedToolSearch(directlyAdmitted.map(definition), {
        kind: "local",
        name: PROFILE_SCOPED_TOOL_SEARCH_ORIGIN,
        metadata: { profileScoped: true },
      }),
    ),
  ];
}

/**
 * Resolve the final tool surface for one model episode. Inputs have already
 * passed source/config/Profile admission; this step can only narrow Workflow
 * tools or rebuild admitted discovery. It never restores a missing tool.
 */
export function resolveRunToolSurface(input: {
  tools: readonly ToolDefinition[];
  workflowAllowedTools?: readonly string[];
}): ResolvedToolSurface {
  const workflowAllowed = input.workflowAllowedTools
    ? new Set(input.workflowAllowedTools)
    : undefined;
  const admittedDiscovery = input.tools.find(
    (tool) => tool.name === DISCOVERY_TOOL_NAME,
  );
  const tools = input.tools.filter((tool) => {
    if (!workflowAllowed) return true;
    if (tool.name === DISCOVERY_TOOL_NAME) return false;
    return workflowAllowed.has(tool.name);
  });

  if (workflowAllowed && admittedDiscovery) {
    const explicitlyAllowed = workflowAllowed.has(DISCOVERY_TOOL_NAME);
    if (explicitlyAllowed || tools.some(isDeferredOnly)) {
      tools.push(
        createScopedToolSearch(tools, {
          kind: "local",
          name: WORKFLOW_SCOPED_TOOL_SEARCH_ORIGIN,
          metadata: { workflowScoped: true },
        }),
      );
    }
  }

  return { tools };
}

export function agentProfileAdmitsTool(
  toolName: string,
  profile: AdmissionProfile,
): boolean {
  if (matchesAgentToolName(toolName, profile.deniedTools ?? [])) return false;
  return (
    profile.allowedTools === undefined ||
    matchesAgentToolName(toolName, profile.allowedTools)
  );
}

export function matchesAgentToolName(
  toolName: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((rawPattern) => {
    const pattern = rawPattern;
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return toolName === pattern;
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(toolName);
  });
}

/** Build discovery over exactly the definitions supplied by the caller. */
export function createScopedToolSearch(
  tools: readonly ToolDefinition[],
  origin?: ToolOrigin,
): ToolDefinition {
  const search = createToolSearchTool({
    source: { listDescriptors: () => tools.map(toolDescriptor) },
  });
  if (!origin) return search;
  return {
    ...search,
    governance: { ...search.governance, origin },
  };
}

export function isWorkflowScopedToolSearch(
  tool: ToolDefinition | undefined,
): boolean {
  return (
    tool?.governance?.origin?.kind === "local" &&
    tool.governance.origin.name === WORKFLOW_SCOPED_TOOL_SEARCH_ORIGIN
  );
}

function agentProfileAdmitsDiscovery<T>(
  profile: AdmissionProfile,
  directlyAdmitted: readonly T[],
  definition: (item: T) => ToolDefinition,
): boolean {
  if (matchesAgentToolName(DISCOVERY_TOOL_NAME, profile.deniedTools ?? [])) {
    return false;
  }
  return (
    profile.allowedTools === undefined ||
    matchesAgentToolName(DISCOVERY_TOOL_NAME, profile.allowedTools) ||
    directlyAdmitted.some((item) => isDeferredOnly(definition(item)))
  );
}

function isDeferredOnly(tool: ToolDefinition): boolean {
  return tool.deferLoading === true && tool.alwaysLoad !== true;
}

function toolDescriptor(tool: ToolDefinition): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined
      ? { outputSchema: tool.outputSchema }
      : {}),
    ...(tool.canonicalName ? { canonicalName: tool.canonicalName } : {}),
    ...(tool.defaultExposureTier
      ? { defaultExposureTier: tool.defaultExposureTier }
      : {}),
    ...(tool.relatedTools ? { relatedTools: [...tool.relatedTools] } : {}),
    ...(tool.requiresTool ? { requiresTool: [...tool.requiresTool] } : {}),
    ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
    loading: { defer: tool.deferLoading, alwaysLoad: tool.alwaysLoad },
    ...(tool.resultSize ? { resultSize: { ...tool.resultSize } } : {}),
    ...(tool.resultPresentation
      ? { resultPresentation: { ...tool.resultPresentation } }
      : {}),
    ...(tool.policy ? { policy: { ...tool.policy } } : {}),
    ...(tool.governance ? { governance: { ...tool.governance } } : {}),
  };
}
