import {
  createTaskControl,
  createTodoTools,
  type TaskManager,
} from "@sparkwright/agent-runtime";
import {
  createToolSearchTool,
  type EventEmitter,
  type RunId,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolOrigin,
} from "@sparkwright/core";
import type { SkillRoot } from "@sparkwright/skills";
import type { CapabilityToolsConfig, ShellConfig } from "./config.js";
import { createHostShellTool } from "./shell.js";
import {
  applyToolConfig,
  createAgentInspectorTool,
  createAgentManagerTool,
  createApplyPatchTool,
  createCronTool,
  createEditAnchoredTextTool,
  createGlobPathsTool,
  createGrepTextTool,
  createListDirTool,
  createReadAnchoredTextTool,
  createReadFileTool,
  createSkillInspectorTool,
  createSkillManagerTool,
  createSkillUpdateTool,
} from "./tools.js";

const MAIN_TODO_MAX_WRITES_PER_RUN = 4;

export type HostToolCatalogSource =
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

export interface HostToolCatalogEntry {
  definition: ToolDefinition;
  source: HostToolCatalogSource;
}

interface PreparedToolSource {
  tools?: ToolDefinition[];
}

export function createReadOnlyChildToolCatalog(input: {
  workspaceRoot: string;
  toolConfig?: CapabilityToolsConfig;
}): HostToolCatalogEntry[] {
  return applyToolConfigToCatalog(
    [
      catalogEntry(createReadFileTool(), "coding"),
      catalogEntry(createGlobPathsTool(input.workspaceRoot), "coding"),
      catalogEntry(createGrepTextTool(input.workspaceRoot), "coding"),
      catalogEntry(createListDirTool(input.workspaceRoot), "coding"),
    ],
    input.toolConfig,
  );
}

export function createCliDiagnosticToolCatalog(input: {
  workspaceRoot: string;
  toolConfig?: CapabilityToolsConfig;
}): HostToolCatalogEntry[] {
  return withDeferredToolSearch(
    applyToolConfigToCatalog(
      createCoreCodingToolCatalog(input.workspaceRoot),
      input.toolConfig,
    ),
  );
}

export function createMainHostToolCatalog(input: {
  workspaceRoot: string;
  skillRoots: SkillRoot[];
  toolConfig?: CapabilityToolsConfig;
  taskManager: TaskManager;
  getParentRunId: () => RunId;
  getRunEvents?: () => EventEmitter | undefined;
  todoPath: string;
  preparedSkills?: PreparedToolSource | null;
  preparedMcp?: PreparedToolSource | null;
  delegateTools?: ToolDefinition[];
  dynamicSpawnTool?: ToolDefinition;
  shell?: ShellConfig;
  configPaths?: readonly string[];
}): HostToolCatalogEntry[] {
  const entries = applyToolConfigToCatalog(
    createMainHostToolCatalogList(input),
    input.toolConfig,
  );
  return withDeferredToolSearch(entries);
}

export function catalogToolDefinitions(
  entries: readonly HostToolCatalogEntry[],
): ToolDefinition[] {
  return entries.map((entry) => entry.definition);
}

function withDeferredToolSearch(
  entries: HostToolCatalogEntry[],
): HostToolCatalogEntry[] {
  if (!entries.some((entry) => entry.definition.deferLoading === true)) {
    return entries;
  }

  const deferredCatalog = entries.map((entry) => entry.definition);
  return [
    ...entries,
    catalogEntry(
      createToolSearchTool({
        source: {
          listDescriptors: () => deferredCatalog.map(toolToDescriptor),
        },
      }),
      "core",
    ),
  ];
}

export function catalogEntryOrigin(
  entry: HostToolCatalogEntry,
): string | undefined {
  const origin = entry.definition.governance?.origin;
  if (origin) return formatToolOrigin(origin);
  switch (entry.source) {
    case "coding":
      return "local:@sparkwright/coding-tools";
    case "cron":
      return "local:@sparkwright/cron";
    case "skill":
      return "local:@sparkwright/skills";
    case "agent":
    case "task":
    case "todo":
      return "local:@sparkwright/agent-runtime";
    case "shell":
      return "local:@sparkwright/shell-tool";
    case "core":
      return "local:@sparkwright/core";
    case "mcp":
    case "delegate":
      return undefined;
  }
}

function createMainHostToolCatalogList(input: {
  workspaceRoot: string;
  skillRoots: SkillRoot[];
  taskManager: TaskManager;
  getParentRunId: () => RunId;
  getRunEvents?: () => EventEmitter | undefined;
  todoPath: string;
  preparedSkills?: PreparedToolSource | null;
  preparedMcp?: PreparedToolSource | null;
  delegateTools?: ToolDefinition[];
  dynamicSpawnTool?: ToolDefinition;
  shell?: ShellConfig;
  configPaths?: readonly string[];
}): HostToolCatalogEntry[] {
  return [
    ...createCoreCodingToolCatalog(input.workspaceRoot),
    catalogEntry(createCronTool(), "cron"),
    catalogEntry(
      createSkillInspectorTool(input.workspaceRoot, input.skillRoots),
      "skill",
    ),
    catalogEntry(
      createSkillManagerTool(input.workspaceRoot, input.skillRoots),
      "skill",
    ),
    catalogEntry(
      createSkillUpdateTool(input.workspaceRoot, input.skillRoots),
      "skill",
    ),
    catalogEntry(createAgentInspectorTool(input.workspaceRoot), "agent"),
    catalogEntry(createAgentManagerTool(input.workspaceRoot), "agent"),
    catalogEntry(
      createHostShellTool(input.workspaceRoot, {
        taskManager: input.taskManager,
        sandbox: input.shell?.sandbox,
        skillRoots: input.skillRoots.map((root) => root.root),
        extraForcedDenyWrite: input.configPaths,
        getRunEvents: input.getRunEvents,
      }),
      "shell",
    ),
    catalogEntry(
      createTaskControl({
        manager: input.taskManager,
        getParentRunId: input.getParentRunId,
      }),
      "task",
    ),
    ...createTodoTools({
      getTodoPath: () => input.todoPath,
      maxWritesPerRun: MAIN_TODO_MAX_WRITES_PER_RUN,
    })
      .all()
      .map((tool) => catalogEntry(tool, "todo")),
    ...(input.preparedSkills?.tools ?? []).map((tool) =>
      catalogEntry(tool, "skill"),
    ),
    ...(input.preparedMcp?.tools ?? []).map((tool) =>
      catalogEntry(tool, "mcp"),
    ),
    ...(input.delegateTools ?? []).map((tool) =>
      catalogEntry(tool, "delegate"),
    ),
    ...(input.dynamicSpawnTool
      ? [catalogEntry(input.dynamicSpawnTool, "agent")]
      : []),
  ];
}

function createCoreCodingToolCatalog(
  workspaceRoot: string,
): HostToolCatalogEntry[] {
  return [
    catalogEntry(createReadFileTool(), "coding"),
    catalogEntry(createGlobPathsTool(workspaceRoot), "coding"),
    catalogEntry(createGrepTextTool(workspaceRoot), "coding"),
    catalogEntry(createListDirTool(workspaceRoot), "coding"),
    catalogEntry(createReadAnchoredTextTool(), "coding"),
    catalogEntry(createEditAnchoredTextTool(), "coding"),
    catalogEntry(createApplyPatchTool(), "coding"),
  ];
}

function applyToolConfigToCatalog(
  entries: HostToolCatalogEntry[],
  config: CapabilityToolsConfig | undefined,
): HostToolCatalogEntry[] {
  const metadataByName = new Map(
    entries.map((entry) => [entry.definition.name, entry]),
  );
  return applyToolConfig(
    entries.map((entry) => entry.definition),
    config,
  ).map((definition) => {
    const metadata = metadataByName.get(definition.name);
    if (!metadata) {
      return catalogEntry(definition, "core");
    }
    return { ...metadata, definition };
  });
}

function catalogEntry(
  definition: ToolDefinition,
  source: HostToolCatalogSource,
): HostToolCatalogEntry {
  return { definition, source };
}

function toolToDescriptor(tool: ToolDefinition): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    timeoutMs: tool.timeoutMs,
    loading: {
      defer: tool.deferLoading,
      alwaysLoad: tool.alwaysLoad,
    },
    resultSize: tool.resultSize,
    resultPresentation: tool.resultPresentation,
    policy: tool.policy,
    governance: tool.governance,
  };
}

function formatToolOrigin(origin: ToolOrigin): string {
  return `${origin.kind}:${origin.name ?? "unknown"}`;
}
