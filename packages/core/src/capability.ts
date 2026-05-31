// AI maintenance note: Capability descriptors are the read-only inventory
// shape used by product shells to explain what a run can use. They do not
// grant permission. Runtime execution still flows through tools, context,
// policy, approval, and trace.

import type { ToolDescriptor, ToolOrigin } from "./tools.js";

export type CapabilityKind =
  | "tool"
  | "context"
  | "skill"
  | "mcp_tool"
  | "mcp_resource"
  | "agent_profile"
  | "command"
  | "hosted";

export interface CapabilityOrigin {
  kind: "core" | "local" | "skill" | "mcp" | "agent" | "hosted" | "unknown";
  name?: string;
  uri?: string;
  metadata?: Record<string, unknown>;
}

export interface CapabilityDescriptor {
  id: string;
  kind: CapabilityKind;
  name: string;
  description?: string;
  origin: CapabilityOrigin;
  enabled?: boolean;
  agentId?: string;
  tags?: string[];
  tool?: ToolDescriptor;
  metadata?: Record<string, unknown>;
}

export interface CapabilityRegistryOptions {
  capabilities?: CapabilityDescriptor[];
}

/**
 * Small in-memory inventory used by embedders and optional runtime packages.
 * It intentionally has no execution methods, so capability discovery cannot
 * bypass policy or approval.
 */
export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityDescriptor>();

  constructor(options: CapabilityRegistryOptions = {}) {
    for (const capability of options.capabilities ?? []) {
      this.register(capability);
    }
  }

  register(capability: CapabilityDescriptor): void {
    if (this.capabilities.has(capability.id)) {
      throw new Error(`Capability already registered: ${capability.id}`);
    }
    this.capabilities.set(capability.id, cloneCapability(capability));
  }

  upsert(capability: CapabilityDescriptor): void {
    this.capabilities.set(capability.id, cloneCapability(capability));
  }

  get(id: string): CapabilityDescriptor | undefined {
    const capability = this.capabilities.get(id);
    return capability ? cloneCapability(capability) : undefined;
  }

  list(filter: CapabilityFilter = {}): CapabilityDescriptor[] {
    return [...this.capabilities.values()]
      .filter((capability) => matchesCapabilityFilter(capability, filter))
      .map(cloneCapability);
  }
}

export interface CapabilityFilter {
  kind?: CapabilityKind;
  enabled?: boolean;
  agentId?: string;
  originKind?: CapabilityOrigin["kind"];
}

export function capabilityFromTool(
  tool: ToolDescriptor,
  input: {
    id?: string;
    origin?: CapabilityOrigin;
    agentId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  } = {},
): CapabilityDescriptor {
  const origin =
    input.origin ??
    (tool.governance?.origin
      ? {
          kind: originKindFromToolOrigin(tool.governance.origin.kind),
          name: tool.governance.origin.name,
          metadata: tool.governance.origin.metadata,
        }
      : { kind: "local" as const });

  return {
    id: input.id ?? `tool:${tool.name}`,
    kind: origin.kind === "mcp" ? "mcp_tool" : "tool",
    name: tool.name,
    description: tool.description,
    origin,
    enabled: true,
    agentId: input.agentId,
    tags: input.tags,
    tool,
    metadata: input.metadata,
  };
}

export function capabilitiesFromTools(
  tools: readonly ToolDescriptor[],
  input: Omit<Parameters<typeof capabilityFromTool>[1], "id"> = {},
): CapabilityDescriptor[] {
  return tools.map((tool) => capabilityFromTool(tool, input));
}

function matchesCapabilityFilter(
  capability: CapabilityDescriptor,
  filter: CapabilityFilter,
): boolean {
  if (filter.kind && capability.kind !== filter.kind) return false;
  if (filter.enabled !== undefined && capability.enabled !== filter.enabled) {
    return false;
  }
  if (filter.agentId && capability.agentId !== filter.agentId) return false;
  if (filter.originKind && capability.origin.kind !== filter.originKind) {
    return false;
  }
  return true;
}

function originKindFromToolOrigin(
  kind: ToolOrigin["kind"],
): CapabilityOrigin["kind"] {
  if (kind === "mcp") return "mcp";
  if (kind === "hosted") return "hosted";
  if (kind === "local" || kind === "script") return "local";
  return "unknown";
}

function cloneCapability(
  capability: CapabilityDescriptor,
): CapabilityDescriptor {
  return {
    ...capability,
    origin: {
      ...capability.origin,
      metadata: capability.origin.metadata
        ? { ...capability.origin.metadata }
        : undefined,
    },
    tags: capability.tags ? [...capability.tags] : undefined,
    tool: capability.tool
      ? {
          ...capability.tool,
          governance: capability.tool.governance
            ? { ...capability.tool.governance }
            : undefined,
        }
      : undefined,
    metadata: capability.metadata ? { ...capability.metadata } : undefined,
  };
}
