import {
  createToolSearchTool,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolOrigin,
} from "@sparkwright/core";

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

export function toolDescriptor(tool: ToolDefinition): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined
      ? { outputSchema: tool.outputSchema }
      : {}),
    ...(tool.canonicalName ? { canonicalName: tool.canonicalName } : {}),
    ...(tool.legacyNames ? { legacyNames: [...tool.legacyNames] } : {}),
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
