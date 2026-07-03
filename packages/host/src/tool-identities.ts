import type { ToolDefinition, ToolExposureTier } from "@sparkwright/core";
import type { HostToolCatalogSource } from "./tool-catalog.js";

export interface BuiltinToolIdentity {
  canonicalName: string;
  legacyNames?: readonly string[];
  defaultExposureTier: ToolExposureTier;
  relatedTools?: readonly string[];
  requiresTool?: readonly string[];
  description?: string;
}

const PUBLIC_IDENTITIES: Record<string, BuiltinToolIdentity> = {
  read_file: {
    canonicalName: "read",
    legacyNames: ["read_file"],
    defaultExposureTier: "public",
    description:
      "Read a UTF-8 text file from the workspace. Returns a paginated line window; pass `offset` to continue. Use `glob` first when you need to discover files from a pattern.",
  },
  write_file: {
    canonicalName: "write",
    legacyNames: ["write_file"],
    defaultExposureTier: "public",
    description:
      "Create or replace a UTF-8 text file in the workspace. Creates missing parent directories and reports whether content changed.",
  },
  apply_patch: {
    canonicalName: "edit",
    legacyNames: ["apply_patch"],
    defaultExposureTier: "public",
    description:
      "Edit one workspace file by applying a unified diff patch. File headers are optional; include hunks for the exact changes.",
  },
  shell: {
    canonicalName: "bash",
    legacyNames: ["shell"],
    defaultExposureTier: "public",
    description:
      "Run a Bash command after safety classification and policy approval. Use workspace file tools for reads and edits; reserve commands for verification, builds, tests, git, and scripts.",
  },
  glob: {
    canonicalName: "glob",
    defaultExposureTier: "public",
  },
  grep: {
    canonicalName: "grep",
    defaultExposureTier: "public",
  },
};

const ADVANCED_BY_NAME: Record<string, BuiltinToolIdentity> = {
  list_dir: {
    canonicalName: "list_dir",
    defaultExposureTier: "legacy",
    relatedTools: ["glob"],
  },
  read_anchored_text: {
    canonicalName: "read_anchored_text",
    defaultExposureTier: "advanced",
    relatedTools: ["edit_anchored_text"],
  },
  edit_anchored_text: {
    canonicalName: "edit_anchored_text",
    defaultExposureTier: "advanced",
    relatedTools: ["read_anchored_text"],
    requiresTool: ["read_anchored_text"],
    description:
      "Apply verified anchored edits to a workspace file. First call `read_anchored_text` for the same file and use the returned anchors in each edit.",
  },
  list_skills: {
    canonicalName: "list_skills",
    defaultExposureTier: "advanced",
  },
  create_skill: {
    canonicalName: "create_skill",
    defaultExposureTier: "advanced",
  },
  update_skill: {
    canonicalName: "update_skill",
    defaultExposureTier: "advanced",
  },
  list_agents: {
    canonicalName: "list_agents",
    defaultExposureTier: "advanced",
  },
  create_agent: {
    canonicalName: "create_agent",
    defaultExposureTier: "advanced",
  },
  spawn_agent: {
    canonicalName: "spawn_agent",
    defaultExposureTier: "advanced",
  },
  delegate_agent: {
    canonicalName: "delegate_agent",
    defaultExposureTier: "advanced",
  },
  delegate_parallel: {
    canonicalName: "delegate_parallel",
    defaultExposureTier: "advanced",
  },
  cron: {
    canonicalName: "cron",
    defaultExposureTier: "advanced",
  },
  task: {
    canonicalName: "task",
    defaultExposureTier: "advanced",
  },
  todo_write: {
    canonicalName: "todo_write",
    defaultExposureTier: "advanced",
  },
};

const INFRASTRUCTURE_BY_NAME: Record<string, BuiltinToolIdentity> = {
  skill_load: {
    canonicalName: "skill_load",
    defaultExposureTier: "infrastructure",
  },
  tool_search: {
    canonicalName: "tool_search",
    defaultExposureTier: "infrastructure",
  },
};

const CANONICAL_BY_LEGACY = new Map<string, string>();
for (const identity of Object.values(PUBLIC_IDENTITIES)) {
  for (const legacy of identity.legacyNames ?? []) {
    CANONICAL_BY_LEGACY.set(legacy, identity.canonicalName);
  }
}

export function canonicalToolName(name: string): string {
  return CANONICAL_BY_LEGACY.get(name) ?? name;
}

export function normalizeToolNameList(
  names: readonly string[] | undefined,
): string[] | undefined {
  if (names === undefined) return undefined;
  const out: string[] = [];
  for (const name of names) {
    const canonical = canonicalToolName(name);
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

export function applyBuiltinToolIdentity<T extends ToolDefinition>(
  tool: T,
  source: HostToolCatalogSource,
): T {
  const identity = identityForTool(tool.name, source);
  if (!identity) return tool;
  return {
    ...tool,
    name: identity.canonicalName,
    canonicalName: identity.canonicalName,
    legacyNames: identity.legacyNames
      ? [...identity.legacyNames]
      : tool.legacyNames,
    defaultExposureTier: identity.defaultExposureTier,
    relatedTools: identity.relatedTools
      ? [...identity.relatedTools]
      : tool.relatedTools,
    requiresTool: identity.requiresTool
      ? [...identity.requiresTool]
      : tool.requiresTool,
    description: identity.description ?? tool.description,
  };
}

export function shouldDeferToolByDefault(tool: ToolDefinition): boolean {
  return (
    tool.defaultExposureTier === "advanced" ||
    tool.defaultExposureTier === "legacy"
  );
}

export function identityForTool(
  name: string,
  source?: HostToolCatalogSource,
): BuiltinToolIdentity | undefined {
  const known =
    PUBLIC_IDENTITIES[name] ??
    ADVANCED_BY_NAME[name] ??
    INFRASTRUCTURE_BY_NAME[name];
  if (known) return known;
  if (source === "delegate") {
    return {
      canonicalName: name,
      defaultExposureTier: "advanced",
    };
  }
  if (source === "mcp") {
    return {
      canonicalName: name,
      defaultExposureTier: "advanced",
    };
  }
  return undefined;
}

export const DEFAULT_ADVANCED_TOOL_NAMES = Object.freeze([
  ...Object.keys(ADVANCED_BY_NAME).map(canonicalToolName),
]);
