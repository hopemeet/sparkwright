// AI maintenance note: tool_search is the lazy-loading discovery surface that
// keeps the per-turn tool prompt small when many tools (MCP servers, skills,
// hosted brokers) are wired up. The contract:
//
//   1. Tools declared with `deferLoading: true` are listed by name + short
//      description only in the initial prompt. Their full inputSchema is NOT
//      sent to the provider until the model invokes `tool_search`.
//   2. `tool_search` accepts a `query` keyword string (e.g. "notebook jupyter")
//      or a `select:` directive ("select:read_text,grep") to fetch
//      specific tools by name.
//   3. The tool emits a `tool.requested` event and returns a structured
//      payload with `matches: [{ name, description, inputSchema, ... }]`
//      that a downstream prompt builder is expected to splice into the next
//      turn's tool list.
//
// The factory is parameterized so hosts can plug their own `ToolRegistry`
// (or `CapabilityRegistry`) — this lets a server-runtime serve a unified
// search over core + extension + MCP tools without subclassing.
//
// See docs/EXTENSION_INTERFACES.md "Tool extensions" and docs/AI_TASK_INDEX.md.

import { defineTool } from "./tools.js";
import type { ToolDefinition, ToolDescriptor } from "./tools.js";

/**
 * Source of tools exposed through `tool_search`. Either a live `ToolRegistry`
 * (most common — the same registry that drives the run loop) or a fixed
 * snapshot of descriptors. Capability registries can adapt themselves by
 * mapping `CapabilityDescriptor` → `ToolDescriptor` upstream.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ToolSearchSource {
  /** Returns the descriptors that should participate in search. */
  listDescriptors(): ToolDescriptor[] | Promise<ToolDescriptor[]>;
}

export interface ToolSearchInput {
  /**
   * Query string. Two forms:
   *   - `"select:name1,name2,..."` — fetch exact tools by name.
   *   - free-text keywords (lowercased token intersection against name +
   *     description) — best-effort ranking, returns top `maxResults`.
   */
  query: string;
  /** Maximum results returned for keyword queries. Default 5. */
  maxResults?: number;
}

export interface ToolSearchMatch {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  canonicalName?: string;
  legacyNames?: string[];
  defaultExposureTier?: string;
  relatedTools?: string[];
  requiresTool?: string[];
  /**
   * Lowercased keyword overlap score (0..N). Always 0 for `select:` queries
   * (exact lookup). Higher is better.
   */
  score: number;
  /**
   * Whether the tool was eligible for deferred loading. Frontends can use
   * this to decide whether to actually inject the schema into the next turn
   * or just acknowledge the request.
   *
   * @reserved Public field consumed by prompt builders and tool loaders.
   */
  deferred: boolean;
}

export interface ToolSearchResult {
  query: string;
  mode: "select" | "keyword";
  /** @reserved Public field consumed by prompt builders and tool loaders. */
  matches: ToolSearchMatch[];
  /**
   * Total deferred tools available (regardless of match). Useful for UIs.
   *
   * @reserved Public field consumed by tool-discovery UIs.
   */
  deferredCatalogSize: number;
}

export interface CreateToolSearchToolOptions {
  source: ToolSearchSource;
  /** Override the tool name. Default `"tool_search"`. */
  name?: string;
  /** Override the description shown to the model. */
  description?: string;
  /**
   * When false, include eagerly-loaded tools in search too (rare — usually
   * a host only wants discovery for deferred tools). Default `true`.
   */
  deferredOnly?: boolean;
}

const DEFAULT_DESCRIPTION =
  "Fetch full schema definitions for deferred tools so they can be called. " +
  'Use "select:name1,name2" for exact lookup or free-text keywords for ranked ' +
  "discovery. Returned tools become callable on the next turn.";

const INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    query: {
      type: "string" as const,
    },
    maxResults: {
      type: "integer" as const,
    },
  },
  required: ["query"],
  additionalProperties: false,
};

/**
 * Build the `tool_search` ToolDefinition. The factory does not modify the
 * source registry; it only reads descriptors at execution time, so the set
 * of discoverable tools can grow during a run (e.g. when an MCP server
 * registers more tools).
 *
 * @public
 * @stability experimental v0.1
 */
export function createToolSearchTool(
  options: CreateToolSearchToolOptions,
): ToolDefinition<ToolSearchInput, ToolSearchResult> {
  const deferredOnly = options.deferredOnly !== false;

  return defineTool<ToolSearchInput, ToolSearchResult>({
    name: options.name ?? "tool_search",
    description: options.description ?? DEFAULT_DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    alwaysLoad: true,
    policy: { risk: "safe", requiresApproval: false },
    governance: {
      sideEffects: ["read"],
      idempotency: "idempotent",
      origin: { kind: "local", name: "@sparkwright/core" },
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async execute(input) {
      const descriptors = await options.source.listDescriptors();
      const pool = deferredOnly
        ? descriptors.filter((descriptor) => isDeferredDescriptor(descriptor))
        : descriptors;
      const poolByName = new Map(
        pool.map((descriptor) => [descriptor.name, descriptor]),
      );
      const deferredCatalogSize = descriptors.filter((descriptor) =>
        isDeferredDescriptor(descriptor),
      ).length;

      const trimmed = input.query.trim();
      if (trimmed.startsWith("select:")) {
        const names = trimmed
          .slice("select:".length)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const matches: ToolSearchMatch[] = [];
        for (const name of names) {
          const descriptor = pool.find(
            (entry) =>
              entry.name === name || (entry.legacyNames ?? []).includes(name),
          );
          if (descriptor) {
            matches.push(descriptorToMatch(descriptor, 0));
          }
        }
        return {
          query: input.query,
          mode: "select",
          matches: expandRelatedMatches(matches, poolByName),
          deferredCatalogSize,
        };
      }

      const tokens = tokenize(trimmed);
      const maxResults =
        input.maxResults && input.maxResults > 0 ? input.maxResults : 5;
      const ranked: Array<{ descriptor: ToolDescriptor; score: number }> = [];
      for (const descriptor of pool) {
        const score = scoreDescriptor(descriptor, tokens);
        if (score > 0) ranked.push({ descriptor, score });
      }
      ranked.sort((a, b) => b.score - a.score);
      return {
        query: input.query,
        mode: "keyword",
        matches: expandRelatedMatches(
          ranked
            .slice(0, maxResults)
            .map(({ descriptor, score }) =>
              descriptorToMatch(descriptor, score),
            ),
          poolByName,
        ),
        deferredCatalogSize,
      };
    },
  });
}

/**
 * Adapt a live `ToolRegistry` into a `ToolSearchSource`. Imported lazily
 * (the type is the only dependency) so this module stays cheap.
 *
 * @public
 * @stability experimental v0.1
 */
export function toolSearchSourceFromRegistry(registry: {
  listDescriptors(): ToolDescriptor[];
}): ToolSearchSource {
  return {
    listDescriptors() {
      return registry.listDescriptors();
    },
  };
}

function isDeferredDescriptor(descriptor: ToolDescriptor): boolean {
  return Boolean(descriptor.loading?.defer);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((token) => token.length > 0);
}

function scoreDescriptor(descriptor: ToolDescriptor, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const haystack =
    `${descriptor.name} ${(descriptor.legacyNames ?? []).join(" ")} ${descriptor.description}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (descriptor.name.toLowerCase().includes(token)) score += 2;
    else if (haystack.includes(token)) score += 1;
  }
  return score;
}

function descriptorToMatch(
  descriptor: ToolDescriptor,
  score: number,
): ToolSearchMatch {
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
    canonicalName: descriptor.canonicalName,
    legacyNames: descriptor.legacyNames,
    defaultExposureTier: descriptor.defaultExposureTier,
    relatedTools: descriptor.relatedTools,
    requiresTool: descriptor.requiresTool,
    score,
    deferred: isDeferredDescriptor(descriptor),
  };
}

function expandRelatedMatches(
  initialMatches: ToolSearchMatch[],
  poolByName: Map<string, ToolDescriptor>,
): ToolSearchMatch[] {
  const matchesByName = new Map(
    initialMatches.map((match) => [match.name, match]),
  );
  const queue = [...initialMatches];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const name of [
      ...(current.requiresTool ?? []),
      ...(current.relatedTools ?? []),
    ]) {
      if (matchesByName.has(name)) continue;
      const descriptor = poolByName.get(name);
      if (!descriptor) continue;
      const match = descriptorToMatch(descriptor, 0);
      matchesByName.set(name, match);
      queue.push(match);
    }
  }
  return [...matchesByName.values()];
}
