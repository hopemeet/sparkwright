import {
  createTaskGet,
  createTaskList,
  createTaskOutput,
  createTaskStop,
  createTodoTools,
  type TaskManager,
} from "@sparkwright/agent-runtime";
import type { RunId, ToolDefinition } from "@sparkwright/core";
import type { SkillRoot } from "@sparkwright/skills";
import type { CapabilityToolsConfig, ShellConfig } from "./config.js";
import { createHostShellTool } from "./shell.js";
import {
  applyToolConfig,
  createAgentInspectorTool,
  createAgentManagerTool,
  createAppendFileTool,
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
  return applyToolConfig(
    [
      createReadFileTool(),
      createGlobPathsTool(input.workspaceRoot),
      createGrepTextTool(input.workspaceRoot),
      createListDirTool(input.workspaceRoot),
      createReadAnchoredTextTool(),
      createEditAnchoredTextTool(),
      createApplyPatchTool(),
      createAppendFileTool(),
      createCronTool(),
      createSkillInspectorTool(input.workspaceRoot, input.skillRoots),
      createSkillManagerTool(input.workspaceRoot, input.skillRoots),
      createAgentInspectorTool(input.workspaceRoot),
      createAgentManagerTool(input.workspaceRoot),
      createHostShellTool(input.workspaceRoot, {
        taskManager: input.taskManager,
        sandbox: input.shell?.sandbox,
        skillRoots: input.skillRoots.map((root) => root.root),
        extraForcedDenyWrite: input.configPaths,
      }),
      ...createHostTaskPollingTools({
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
    ],
    input.toolConfig,
  );
}

function createHostTaskPollingTools(input: {
  manager: TaskManager;
  getParentRunId: () => RunId;
}): ToolDefinition[] {
  const options = {
    manager: input.manager,
    getParentRunId: input.getParentRunId,
  };
  return [
    createTaskList(options),
    createTaskGet(options),
    createTaskStop(options),
    createTaskOutput(options),
  ];
}
