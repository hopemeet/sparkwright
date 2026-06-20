import type { ToolDefinition } from "@sparkwright/core";

type SelectorCatalogSource =
  | "coding"
  | "cron"
  | "skill"
  | "agent"
  | "shell"
  | "task"
  | "todo"
  | "mcp"
  | "delegate"
  | "core";

export interface ToolSelectorCatalogEntry {
  definition: Pick<ToolDefinition, "name" | "governance" | "deferLoading">;
  source: SelectorCatalogSource;
}

export const TOOL_USE_SELECTORS = [
  "workspace.read",
  "workspace.write",
  "shell",
  "planning",
  "skills",
  "agents",
  "tasks",
  "cron",
  "mcp",
] as const;

/**
 * `tool_search` is derived infrastructure, not a user-authorized tool. It is
 * appended only when the final tool set still contains deferred tools (so the
 * model can load their schemas) and its descriptor source lists only
 * already-filtered tools — so it is exempt from selector/allow filtering. There
 * is therefore no selector that maps to it; discovery is decided structurally
 * by {@link shouldAppendDiscoveryTool}.
 */
export const DISCOVERY_TOOL_NAME = "tool_search";

export const WORKSPACE_READ_TOOL_NAMES = [
  "read_file",
  "glob",
  "grep",
  "list_dir",
  "read_anchored_text",
] as const;

export const WORKSPACE_WRITE_TOOL_NAMES = [
  "write_file",
  "edit_anchored_text",
  "apply_patch",
] as const;

const BUILTIN_SELECTOR_SET = new Set<string>(TOOL_USE_SELECTORS);
const WORKSPACE_READ_TOOL_SET = new Set<string>(WORKSPACE_READ_TOOL_NAMES);
const WORKSPACE_WRITE_TOOL_SET = new Set<string>(WORKSPACE_WRITE_TOOL_NAMES);

export function isToolUseSelector(selector: string): boolean {
  return BUILTIN_SELECTOR_SET.has(selector) || isMcpServerSelector(selector);
}

export function formatToolUseSelectorList(): string {
  return `${TOOL_USE_SELECTORS.join(", ")}, mcp:<server>`;
}

export function isMcpServerSelector(selector: string): boolean {
  return (
    selector.startsWith("mcp:") && selector.slice("mcp:".length).length > 0
  );
}

export function intersectToolUseSelectors(
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined,
): string[] | undefined {
  if (previous === undefined)
    return next ? uniquePreservingOrder(next) : undefined;
  if (next === undefined) return uniquePreservingOrder(previous);

  const out: string[] = [];
  for (const left of previous) {
    for (const right of next) {
      for (const selector of intersectOneSelector(left, right)) {
        if (!out.includes(selector)) out.push(selector);
      }
    }
  }
  return out;
}

export function resolveSelectorAllowlist(
  entries: readonly ToolSelectorCatalogEntry[],
  selectors: readonly string[] | undefined,
): string[] | undefined {
  if (selectors === undefined) return undefined;

  const selected = new Set<string>();
  for (const selector of selectors) {
    for (const entry of entries) {
      if (entryMatchesSelector(entry, selector)) {
        selected.add(entry.definition.name);
      }
    }
  }

  return [...selected];
}

/**
 * Decide whether the discovery tool (`tool_search`) should be appended to a
 * filtered tool set. This is the single owner of that rule, shared by the host
 * catalog and the CLI capability inspector so both paths stay consistent: it is
 * derived from the presence of a deferred tool in the *already-filtered* set and
 * is never subject to `allowed`/selector filtering. An explicit `tools.disabled`
 * entry is the only way to opt out of discovery.
 */
export function shouldAppendDiscoveryTool(input: {
  hasDeferredTool: boolean;
  disabled?: readonly string[];
}): boolean {
  if (!input.hasDeferredTool) return false;
  return !(input.disabled?.includes(DISCOVERY_TOOL_NAME) ?? false);
}

export function assertCodingToolsCoveredByWorkspaceSelectors(
  entries: readonly ToolSelectorCatalogEntry[],
): void {
  const uncovered = entries
    .filter((entry) => entry.source === "coding")
    .filter((entry) => !codingToolSelector(entry.definition.name))
    .map((entry) => entry.definition.name);
  if (uncovered.length > 0) {
    throw new Error(
      `coding tools missing workspace selector classification: ${uncovered.join(", ")}`,
    );
  }
}

function intersectOneSelector(left: string, right: string): string[] {
  if (left === right) return [left];
  if (left === "mcp" && isMcpServerSelector(right)) return [right];
  if (right === "mcp" && isMcpServerSelector(left)) return [left];
  return [];
}

function entryMatchesSelector(
  entry: ToolSelectorCatalogEntry,
  selector: string,
): boolean {
  switch (selector) {
    case "workspace.read":
      return (
        entry.source === "coding" &&
        WORKSPACE_READ_TOOL_SET.has(entry.definition.name)
      );
    case "workspace.write":
      return (
        entry.source === "coding" &&
        WORKSPACE_WRITE_TOOL_SET.has(entry.definition.name)
      );
    case "shell":
      return entry.source === "shell";
    case "planning":
      return entry.source === "todo";
    case "skills":
      return entry.source === "skill";
    case "agents":
      return entry.source === "agent" || entry.source === "delegate";
    case "tasks":
      return entry.source === "task";
    case "cron":
      return entry.source === "cron";
    case "mcp":
      return entry.source === "mcp";
    default:
      return matchesMcpServerSelector(entry, selector);
  }
}

function matchesMcpServerSelector(
  entry: ToolSelectorCatalogEntry,
  selector: string,
): boolean {
  if (!isMcpServerSelector(selector) || entry.source !== "mcp") return false;
  const serverName = selector.slice("mcp:".length);
  const origin = entry.definition.governance?.origin;
  return origin?.kind === "mcp" && origin.name === serverName;
}

function codingToolSelector(toolName: string): "read" | "write" | undefined {
  if (WORKSPACE_READ_TOOL_SET.has(toolName)) return "read";
  if (WORKSPACE_WRITE_TOOL_SET.has(toolName)) return "write";
  return undefined;
}

function uniquePreservingOrder(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}
