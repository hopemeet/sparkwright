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

interface PreparedToolSource {
  tools?: ToolDefinition[];
}

export function createReadOnlyChildTools(input: {
  workspaceRoot: string;
  toolConfig?: CapabilityToolsConfig;
}): ToolDefinition[] {
  return applyToolConfig(
    [
      createReadFileTool(),
      createGlobPathsTool(input.workspaceRoot),
      createGrepTextTool(input.workspaceRoot),
      createListDirTool(input.workspaceRoot),
    ],
    input.toolConfig,
  );
}

export function createMainHostTools(input: {
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
}): ToolDefinition[] {
  const tools = applyToolConfig(
    createMainHostToolList(input),
    input.toolConfig,
  );
  if (!tools.some((tool) => tool.deferLoading === true)) return tools;

  const deferredCatalog = [...tools];
  return [
    ...tools,
    createToolSearchTool({
      source: {
        listDescriptors: () => deferredCatalog.map(toolToDescriptor),
      },
    }),
  ];
}

function createMainHostToolList(input: {
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
}): ToolDefinition[] {
  return [
    createReadFileTool(),
    createGlobPathsTool(input.workspaceRoot),
    createGrepTextTool(input.workspaceRoot),
    createListDirTool(input.workspaceRoot),
    createReadAnchoredTextTool(),
    createEditAnchoredTextTool(),
    createApplyPatchTool(),
    createCronTool(),
    createSkillInspectorTool(input.workspaceRoot, input.skillRoots),
    createSkillManagerTool(input.workspaceRoot, input.skillRoots),
    createSkillUpdateTool(input.workspaceRoot, input.skillRoots),
    createAgentInspectorTool(input.workspaceRoot),
    createAgentManagerTool(input.workspaceRoot),
    createHostShellTool(input.workspaceRoot, {
      taskManager: input.taskManager,
      sandbox: input.shell?.sandbox,
      skillRoots: input.skillRoots.map((root) => root.root),
      extraForcedDenyWrite: input.configPaths,
    }),
    createTaskControl({
      manager: input.taskManager,
      getParentRunId: input.getParentRunId,
    }),
    ...createTodoTools({
      getTodoPath: () => input.todoPath,
      maxWritesPerRun: MAIN_TODO_MAX_WRITES_PER_RUN,
    }).all(),
    ...(input.preparedSkills?.tools ?? []),
    ...(input.preparedMcp?.tools ?? []),
    ...(input.delegateTools ?? []),
    ...(input.dynamicSpawnTool ? [input.dynamicSpawnTool] : []),
  ];
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
