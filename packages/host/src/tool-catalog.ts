import {
  createTaskControl,
  createTodoTools,
  type TaskManager,
} from "@sparkwright/agent-runtime";
import {
  createToolSearchTool,
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

export type HostToolCatalogExposure = "main" | "child" | "diagnostic";

export interface HostToolCatalogEntry {
  definition: ToolDefinition;
  source: HostToolCatalogSource;
  exposure: HostToolCatalogExposure;
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
      catalogEntry(createReadFileTool(), "coding", "child"),
      catalogEntry(createGlobPathsTool(input.workspaceRoot), "coding", "child"),
      catalogEntry(createGrepTextTool(input.workspaceRoot), "coding", "child"),
      catalogEntry(createListDirTool(input.workspaceRoot), "coding", "child"),
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
      createCoreCodingToolCatalog(input.workspaceRoot, "diagnostic"),
      input.toolConfig,
    ),
    "diagnostic",
  );
}

export function createMainHostToolCatalog(input: {
  workspaceRoot: string;
  skillRoots: SkillRoot[];
  toolConfig?: CapabilityToolsConfig;
  taskManager: TaskManager;
  getParentRunId: () => RunId;
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
  return withDeferredToolSearch(entries, "main");
}

export function catalogToolDefinitions(
  entries: readonly HostToolCatalogEntry[],
): ToolDefinition[] {
  return entries.map((entry) => entry.definition);
}

function withDeferredToolSearch(
  entries: HostToolCatalogEntry[],
  exposure: HostToolCatalogExposure,
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
      exposure,
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
  todoPath: string;
  preparedSkills?: PreparedToolSource | null;
  preparedMcp?: PreparedToolSource | null;
  delegateTools?: ToolDefinition[];
  dynamicSpawnTool?: ToolDefinition;
  shell?: ShellConfig;
  configPaths?: readonly string[];
}): HostToolCatalogEntry[] {
  return [
    ...createCoreCodingToolCatalog(input.workspaceRoot, "main"),
    catalogEntry(createCronTool(), "cron", "main"),
    catalogEntry(
      createSkillInspectorTool(input.workspaceRoot, input.skillRoots),
      "skill",
      "main",
    ),
    catalogEntry(
      createSkillManagerTool(input.workspaceRoot, input.skillRoots),
      "skill",
      "main",
    ),
    catalogEntry(
      createSkillUpdateTool(input.workspaceRoot, input.skillRoots),
      "skill",
      "main",
    ),
    catalogEntry(
      createAgentInspectorTool(input.workspaceRoot),
      "agent",
      "main",
    ),
    catalogEntry(createAgentManagerTool(input.workspaceRoot), "agent", "main"),
    catalogEntry(
      createHostShellTool(input.workspaceRoot, {
        taskManager: input.taskManager,
        sandbox: input.shell?.sandbox,
        skillRoots: input.skillRoots.map((root) => root.root),
        extraForcedDenyWrite: input.configPaths,
      }),
      "shell",
      "main",
    ),
    catalogEntry(
      createTaskControl({
        manager: input.taskManager,
        getParentRunId: input.getParentRunId,
      }),
      "task",
      "main",
    ),
    ...createTodoTools({
      getTodoPath: () => input.todoPath,
      maxWritesPerRun: MAIN_TODO_MAX_WRITES_PER_RUN,
    })
      .all()
      .map((tool) => catalogEntry(tool, "todo", "main")),
    ...(input.preparedSkills?.tools ?? []).map((tool) =>
      catalogEntry(tool, "skill", "main"),
    ),
    ...(input.preparedMcp?.tools ?? []).map((tool) =>
      catalogEntry(tool, "mcp", "main"),
    ),
    ...(input.delegateTools ?? []).map((tool) =>
      catalogEntry(tool, "delegate", "main"),
    ),
    ...(input.dynamicSpawnTool
      ? [catalogEntry(input.dynamicSpawnTool, "agent", "main")]
      : []),
  ];
}

function createCoreCodingToolCatalog(
  workspaceRoot: string,
  exposure: HostToolCatalogExposure,
): HostToolCatalogEntry[] {
  return [
    catalogEntry(createReadFileTool(), "coding", exposure),
    catalogEntry(createGlobPathsTool(workspaceRoot), "coding", exposure),
    catalogEntry(createGrepTextTool(workspaceRoot), "coding", exposure),
    catalogEntry(createListDirTool(workspaceRoot), "coding", exposure),
    catalogEntry(createReadAnchoredTextTool(), "coding", exposure),
    catalogEntry(createEditAnchoredTextTool(), "coding", exposure),
    catalogEntry(createApplyPatchTool(), "coding", exposure),
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
      return catalogEntry(definition, "core", "main");
    }
    return { ...metadata, definition };
  });
}

function catalogEntry(
  definition: ToolDefinition,
  source: HostToolCatalogSource,
  exposure: HostToolCatalogExposure,
): HostToolCatalogEntry {
  return { definition, source, exposure };
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
