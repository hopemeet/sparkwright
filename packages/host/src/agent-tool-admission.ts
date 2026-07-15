import type { AgentProfile } from "@sparkwright/agent-runtime";
import type { ToolDefinition } from "@sparkwright/core";
import { canonicalToolName } from "./tool-identities.js";
import { DISCOVERY_TOOL_NAME } from "./tool-selectors.js";
import { createScopedToolSearch } from "./scoped-tool-search.js";

const PROFILE_SCOPED_TOOL_SEARCH_ORIGIN =
  "@sparkwright/host.agent-profile-scoped-tool-search";

type AdmissionProfile = Pick<AgentProfile, "allowedTools" | "deniedTools">;
/**
 * Physically narrow an upstream tool set for an Agent Profile. Discovery is
 * retained only when it already exists upstream and an admitted deferred tool
 * needs it; an explicit deny still wins. This function never creates tools.
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
      canonicalToolName(tool.name) !== DISCOVERY_TOOL_NAME &&
      agentProfileAdmitsTool(tool.name, profile)
    );
  });
  const discovery = upstream.find(
    (item) => canonicalToolName(definition(item).name) === DISCOVERY_TOOL_NAME,
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
  const canonical = canonicalToolName(toolName);
  return patterns.some((rawPattern) => {
    const pattern = rawPattern.includes("*")
      ? rawPattern
      : canonicalToolName(rawPattern);
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return canonical === pattern;
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(canonical);
  });
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
    directlyAdmitted.some((item) => {
      const tool = definition(item);
      return tool.deferLoading === true && tool.alwaysLoad !== true;
    })
  );
}
