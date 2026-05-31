// AI maintenance note: Type-level contracts for context- and tool-producing
// extensions (skills, memory, retrieval, MCP). They feed core via
// ContextItem[] or ToolDefinition[]; no extra runtime entry point. See
// docs/EXTENSION_INTERFACES.md for the design rules.

import type { ContextItem } from "./types.js";
import type { ToolDefinition } from "./tools.js";

/**
 * Descriptor returned by `ContextExtension.describe()` so a product shell can
 * inspect available context sources before any expensive load.
 */
export interface ContextExtensionDescriptor {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextExtensionLoadInput {
  goal: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Adapter shape for sources that produce `ContextItem`s (skills, memory,
 * retrieval, MCP resources, etc.). Implementations should return items shaped
 * for `createRun({ context })`.
 */
export interface ContextExtension {
  name: string;
  describe():
    | Promise<ContextExtensionDescriptor[]>
    | ContextExtensionDescriptor[];
  load(
    input: ContextExtensionLoadInput,
  ): Promise<ContextItem[]> | ContextItem[];
}

/**
 * Adapter shape for sources that produce `ToolDefinition`s (MCP servers,
 * local scripts, hosted tool brokers, etc.).
 */
export interface ToolExtension {
  name: string;
  listTools(): Promise<ToolDefinition[]> | ToolDefinition[];
}
