import type { TaskManager } from "@sparkwright/agent-runtime";
import type { EventEmitter, RunId, ToolDefinition } from "@sparkwright/core";
import type { SkillRoot } from "@sparkwright/skills";
import type { CapabilityToolsConfig, ShellConfig } from "./config.js";
import {
  catalogToolDefinitions,
  createMainHostToolCatalog,
  createReadOnlyChildToolCatalog,
} from "./tool-catalog.js";

interface PreparedToolSource {
  tools?: ToolDefinition[];
}

export function createReadOnlyChildTools(input: {
  workspaceRoot: string;
  toolConfig?: CapabilityToolsConfig;
}): ToolDefinition[] {
  return catalogToolDefinitions(createReadOnlyChildToolCatalog(input));
}

export function createMainHostTools(input: {
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
}): ToolDefinition[] {
  return catalogToolDefinitions(createMainHostToolCatalog(input));
}
