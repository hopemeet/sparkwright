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
  "core.discovery",
] as const;

export const WORKSPACE_READ_TOOL_NAMES = [
  "read_file",
  "glob",
  "grep",
  "list_dir",
  "read_anchored_text",
] as const;

export const WORKSPACE_WRITE_TOOL_NAMES = [
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
  let selectedHasDeferredTool = false;
  for (const selector of selectors) {
    for (const entry of entries) {
      if (entryMatchesSelector(entry, selector)) {
        selected.add(entry.definition.name);
        selectedHasDeferredTool =
          selectedHasDeferredTool || entry.definition.deferLoading === true;
      }
    }
  }

  if (selectedHasDeferredTool) {
    for (const entry of entries) {
      if (entry.source === "core" && entry.definition.name === "tool_search") {
        selected.add(entry.definition.name);
      }
    }
  }

  return [...selected];
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
    case "core.discovery":
      return entry.source === "core";
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
