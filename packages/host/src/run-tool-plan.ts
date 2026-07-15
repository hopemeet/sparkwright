import type { ToolDefinition } from "@sparkwright/core";
import { canonicalToolName } from "./tool-identities.js";
import { createScopedToolSearch } from "./scoped-tool-search.js";

export const WORKFLOW_SCOPED_TOOL_SEARCH_ORIGIN =
  "@sparkwright/host.workflow-scoped-tool-search";

export type RunEpisodePurpose = "main_agent" | "todo_continuation";

export type RunToolDecision =
  | { name: string; visibility: "exposed"; reason?: "prompt_required" }
  | { name: string; visibility: "deferred_discoverable" }
  | {
      name: string;
      visibility: "deferred_undiscoverable";
      reason: "discovery_unavailable";
    }
  | {
      name: string;
      visibility: "omitted";
      reason: "workflow_narrowed";
    };

export interface RunToolPlan {
  purpose: RunEpisodePurpose;
  tools: ToolDefinition[];
  decisions: RunToolDecision[];
  missingRequiredTools: string[];
}

/**
 * Final, monotonic tool planning for one model episode. The input catalog has
 * already passed configuration/profile admission. This function may narrow it,
 * scope an already-admitted discovery tool, or promote an admitted deferred
 * schema for a prompt requirement. It never recovers a missing tool.
 */
export function resolveRunToolPlan(input: {
  tools: readonly ToolDefinition[];
  workflowAllowedTools?: readonly string[];
  purpose: RunEpisodePurpose;
  requiredTools?: readonly string[];
}): RunToolPlan {
  const workflowAllowed = input.workflowAllowedTools
    ? new Set(input.workflowAllowedTools.map(canonicalToolName))
    : undefined;
  const admittedDiscovery = input.tools.find(
    (tool) => canonicalToolName(tool.name) === "tool_search",
  );
  const narrowed = input.tools.filter((tool) => {
    if (!workflowAllowed) return true;
    if (canonicalToolName(tool.name) === "tool_search") return false;
    return workflowAllowed.has(canonicalToolName(tool.name));
  });

  const tools = [...narrowed];
  if (workflowAllowed && admittedDiscovery) {
    const explicitlyAllowed = workflowAllowed.has("tool_search");
    const hasDeferred = narrowed.some(isDeferredOnly);
    if (explicitlyAllowed || hasDeferred) {
      tools.push(workflowScopedToolSearch(narrowed));
    }
  }

  const requiredTools = new Set(
    (input.requiredTools ?? []).map(canonicalToolName),
  );
  const missingRequiredTools: string[] = [];
  for (const requiredTool of requiredTools) {
    const index = tools.findIndex(
      (tool) => canonicalToolName(tool.name) === requiredTool,
    );
    if (index < 0) {
      missingRequiredTools.push(requiredTool);
    } else if (isDeferredOnly(tools[index]!)) {
      tools[index] = { ...tools[index]!, alwaysLoad: true };
    }
  }

  const finalNames = new Set(tools.map((tool) => canonicalToolName(tool.name)));
  const discoveryAvailable = finalNames.has("tool_search");
  const decisions = input.tools.map((tool) => {
    const name = canonicalToolName(tool.name);
    const finalTool = tools.find(
      (candidate) => canonicalToolName(candidate.name) === name,
    );
    if (!finalTool) {
      return {
        name,
        visibility: "omitted",
        reason: "workflow_narrowed",
      } as const;
    }
    const deferred = finalTool ? isDeferredOnly(finalTool) : false;
    if (deferred) {
      return discoveryAvailable
        ? ({ name, visibility: "deferred_discoverable" } as const)
        : ({
            name,
            visibility: "deferred_undiscoverable",
            reason: "discovery_unavailable",
          } as const);
    }
    return requiredTools.has(name) && isDeferredOnly(tool)
      ? ({ name, visibility: "exposed", reason: "prompt_required" } as const)
      : ({ name, visibility: "exposed" } as const);
  });

  return { purpose: input.purpose, tools, decisions, missingRequiredTools };
}

export function isWorkflowScopedToolSearch(
  tool: ToolDefinition | undefined,
): boolean {
  return (
    tool?.governance?.origin?.kind === "local" &&
    tool.governance.origin.name === WORKFLOW_SCOPED_TOOL_SEARCH_ORIGIN
  );
}

function isDeferredOnly(tool: ToolDefinition): boolean {
  return tool.deferLoading === true && tool.alwaysLoad !== true;
}

function workflowScopedToolSearch(
  tools: readonly ToolDefinition[],
): ToolDefinition {
  return createScopedToolSearch(tools, {
    kind: "local",
    name: WORKFLOW_SCOPED_TOOL_SEARCH_ORIGIN,
    metadata: { workflowScoped: true },
  });
}
