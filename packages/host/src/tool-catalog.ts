import { join } from "node:path";
import {
  createTaskCreate,
  createTaskControl,
  createTodoTools,
  InMemoryTaskStore,
  TaskManager,
  type TaskRunner,
} from "@sparkwright/agent-runtime";
import {
  createRunId,
  type BackgroundTaskPolicy,
  type EventEmitter,
  type RunId,
  type RuntimeContext,
  type ToolDefinition,
  type ToolOrigin,
} from "@sparkwright/core";
import type { SkillRoot } from "@sparkwright/skills";
import type {
  CapabilityToolsConfig,
  ShellConfig,
} from "./config-zod-schema.js";
import { createChildSafeHostShellTool, createHostShellTool } from "./shell.js";
import {
  applyToolConfig,
  createAgentInspectorTool,
  createMarkdownAgentManagerTool,
  createApplyPatchTool,
  createCreateFileTool,
  createCronTool,
  createEditAnchoredTextTool,
  createGlobPathsTool,
  createGrepTextTool,
  createListDirTool,
  createReadAnchoredTextTool,
  createReadFileTool,
  createReplaceFileTool,
  createSkillInspectorTool,
  createSkillManagerTool,
  createSkillUpdateTool,
  createWriteFileTool,
} from "./tools.js";
import {
  resolveSelectorAllowlist,
  shouldAppendDiscoveryTool,
  type ToolSelectorCatalogEntry,
} from "./tool-selectors.js";
import {
  applyBuiltinToolIdentity,
  normalizeToolNameList,
} from "./tool-identities.js";
import {
  withWorkspaceMutationLease,
  type WorkspaceLeaseCoordinator,
} from "./workspace-lease-coordinator.js";
import { createScopedToolSearch } from "./tool-surface.js";

export const AGENT_TASK_CREATE_PAYLOAD_DESCRIPTION =
  "required object with a self-contained goal; optional context and UI-only label. The child does not inherit parent conversation or tool results, so put relevant established facts and constraints in context.";
export const AGENT_HANDOFF_CONTEXT_MAX_CHARS = 8_000;

export function createAgentSpawnPayloadSchema(
  _enabledToolNames: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Provide a self-contained goal plus optional context and display label. The child receives no parent conversation or tool results. Runtime configuration determines model, tools, permissions, and budgets.",
    properties: {
      goal: {
        type: "string",
        description:
          "Self-contained child-agent assignment, including the concrete outcome and expected deliverable.",
      },
      label: {
        type: "string",
        description:
          "Optional short UI/trace label. It never changes the child prompt, tools, permissions, model, or budget.",
      },
      context: {
        type: "string",
        description:
          "Optional concise handoff of parent-established facts, constraints, decisions, and prior observations. This becomes working task context, not a system prompt.",
        maxLength: AGENT_HANDOFF_CONTEXT_MAX_CHARS,
      },
    },
    required: ["goal"],
    additionalProperties: false,
  };
}

export const AGENT_TASK_CREATE_PAYLOAD_SCHEMA = {
  ...createAgentSpawnPayloadSchema(),
  // Persisted v0 task payloads may still contain role/grant/tool fields.
  // The runner normalizer ignores their authority-bearing values.
  additionalProperties: true,
};

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
  return withDeferredToolSearch(
    applyToolConfigToCatalog(
      [
        catalogEntry(createReadFileTool(), "coding"),
        catalogEntry(createGlobPathsTool(input.workspaceRoot), "coding"),
        catalogEntry(createGrepTextTool(input.workspaceRoot), "coding"),
        catalogEntry(createListDirTool(input.workspaceRoot), "coding"),
      ],
      input.toolConfig,
    ),
    input.toolConfig,
  );
}

export function createDynamicChildToolCatalog(input: {
  workspaceRoot: string;
  toolConfig?: CapabilityToolsConfig;
  shell?: ShellConfig;
  skillRoots?: readonly string[];
  configPaths?: readonly string[];
  workspaceLeaseCoordinator?: WorkspaceLeaseCoordinator;
}): HostToolCatalogEntry[] {
  return withDeferredToolSearch(
    applyWorkspaceMutationLeases(
      childDelegatableCatalog(
        applyToolConfigToCatalog(
          [
            catalogEntry(createReadFileTool(), "coding"),
            catalogEntry(createGlobPathsTool(input.workspaceRoot), "coding"),
            catalogEntry(createGrepTextTool(input.workspaceRoot), "coding"),
            catalogEntry(createListDirTool(input.workspaceRoot), "coding"),
            catalogEntry(createCreateFileTool(), "coding"),
            catalogEntry(createReplaceFileTool(), "coding"),
            catalogEntry(createEditAnchoredTextTool(), "coding"),
            catalogEntry(createApplyPatchTool(), "coding"),
            catalogEntry(
              createChildSafeHostShellTool(input.workspaceRoot, {
                foregroundTimeoutMs: input.shell?.foregroundTimeoutMs,
                sandbox: input.shell?.sandbox,
                skillRoots: input.skillRoots,
                extraForcedDenyWrite: input.configPaths,
              }),
              "shell",
            ),
          ],
          input.toolConfig,
        ),
      ),
      input,
    ),
    input.toolConfig,
  );
}

export function createConfiguredDelegateChildToolCatalog(input: {
  workspaceRoot: string;
  toolConfig?: CapabilityToolsConfig;
  shell?: ShellConfig;
  skillRoots?: readonly string[];
  configPaths?: readonly string[];
  workspaceLeaseCoordinator?: WorkspaceLeaseCoordinator;
}): HostToolCatalogEntry[] {
  return withDeferredToolSearch(
    applyWorkspaceMutationLeases(
      childDelegatableCatalog(
        applyToolConfigToCatalog(
          [
            ...createCoreCodingToolCatalog(input.workspaceRoot),
            catalogEntry(
              createChildSafeHostShellTool(input.workspaceRoot, {
                foregroundTimeoutMs: input.shell?.foregroundTimeoutMs,
                sandbox: input.shell?.sandbox,
                skillRoots: input.skillRoots,
                extraForcedDenyWrite: input.configPaths,
              }),
              "shell",
            ),
          ],
          input.toolConfig,
        ),
      ),
      input,
    ),
    input.toolConfig,
  );
}

function childDelegatableCatalog(
  entries: HostToolCatalogEntry[],
): HostToolCatalogEntry[] {
  return entries.filter((entry) => entry.definition.delegation === "child");
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
    input.toolConfig,
  );
}

export function createMainHostToolCatalog(input: {
  workspaceRoot: string;
  skillRoots: SkillRoot[];
  toolConfig?: CapabilityToolsConfig;
  taskManager: TaskManager;
  taskRunners?: Readonly<Record<string, TaskRunner>>;
  getParentRunId: (ctx?: RuntimeContext) => RunId;
  getRunEvents?: () => EventEmitter | undefined;
  todoPath: string;
  preparedSkills?: PreparedToolSource | null;
  preparedMcp?: PreparedToolSource | null;
  delegateTools?: ToolDefinition[];
  delegateAgentTool?: ToolDefinition;
  delegateParallelTool?: ToolDefinition;
  dynamicSpawnTool?: ToolDefinition;
  agentReportTool?: ToolDefinition;
  shell?: ShellConfig;
  backgroundTasks?: BackgroundTaskPolicy;
  configPaths?: readonly string[];
  workspaceLeaseCoordinator?: WorkspaceLeaseCoordinator;
}): HostToolCatalogEntry[] {
  const entries = applyWorkspaceMutationLeases(
    applyToolConfigToCatalog(
      createMainHostToolCatalogList(input),
      input.toolConfig,
    ),
    input,
  );
  return withDeferredToolSearch(entries, input.toolConfig);
}

export function catalogToolDefinitions(
  entries: readonly HostToolCatalogEntry[],
): ToolDefinition[] {
  return entries.map((entry) => entry.definition);
}

function withDeferredToolSearch(
  entries: HostToolCatalogEntry[],
  config: CapabilityToolsConfig | undefined,
): HostToolCatalogEntry[] {
  // `entries` is already filtered (selectors/allowed/disabled applied). The
  // discovery tool is derived infrastructure, not a filtered tool: append it
  // when a deferred tool survived, exempt from allow/selector filtering, and
  // only honor an explicit `tools.disabled` opt-out. See shouldAppendDiscoveryTool.
  const hasDeferredTool = entries.some(
    (entry) => entry.definition.deferLoading === true,
  );
  if (
    !shouldAppendDiscoveryTool({
      hasDeferredTool,
      disabled: config?.disabled,
    })
  ) {
    return entries;
  }

  return [
    ...entries,
    catalogEntry(
      createScopedToolSearch(entries.map((entry) => entry.definition)),
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
  taskRunners?: Readonly<Record<string, TaskRunner>>;
  getParentRunId: (ctx?: RuntimeContext) => RunId;
  getRunEvents?: () => EventEmitter | undefined;
  todoPath: string;
  preparedSkills?: PreparedToolSource | null;
  preparedMcp?: PreparedToolSource | null;
  delegateTools?: ToolDefinition[];
  delegateAgentTool?: ToolDefinition;
  delegateParallelTool?: ToolDefinition;
  dynamicSpawnTool?: ToolDefinition;
  agentReportTool?: ToolDefinition;
  shell?: ShellConfig;
  backgroundTasks?: BackgroundTaskPolicy;
  configPaths?: readonly string[];
}): HostToolCatalogEntry[] {
  const agentSpawnValidator = input.dynamicSpawnTool?.validateInput;
  const agentTaskPayloadSchema = AGENT_TASK_CREATE_PAYLOAD_SCHEMA;
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
    catalogEntry(createMarkdownAgentManagerTool(input.workspaceRoot), "agent"),
    catalogEntry(
      createHostShellTool(input.workspaceRoot, {
        taskManager: input.taskManager,
        foregroundTimeoutMs: input.shell?.foregroundTimeoutMs,
        sandbox: input.shell?.sandbox,
        skillRoots: input.skillRoots.map((root) => root.root),
        extraForcedDenyWrite: input.configPaths,
        getRunEvents: input.getRunEvents,
        backgroundTasks: input.backgroundTasks,
      }),
      "shell",
    ),
    catalogEntry(
      createTaskCreate({
        manager: input.taskManager,
        taskRunners: input.taskRunners,
        getParentRunId: input.getParentRunId,
        foregroundTimeoutMs: input.shell?.foregroundTimeoutMs,
        backgroundTasks: input.backgroundTasks,
        taskCreateKinds: [
          {
            kind: "agent",
            description:
              "start a background child agent owned by the task lifecycle",
            payloadDescription: AGENT_TASK_CREATE_PAYLOAD_DESCRIPTION,
            payloadSchema: agentTaskPayloadSchema,
            requiresPayload: true,
            ...(agentSpawnValidator
              ? {
                  validatePayload: (
                    payload: Record<string, unknown> | undefined,
                    _call: unknown,
                    ctx: RuntimeContext,
                  ) => agentSpawnValidator(payload, ctx),
                }
              : {}),
          },
        ],
      }),
      "task",
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
    ...(input.delegateAgentTool
      ? [catalogEntry(input.delegateAgentTool, "agent")]
      : []),
    ...(input.delegateParallelTool
      ? [catalogEntry(input.delegateParallelTool, "agent")]
      : []),
    ...(input.dynamicSpawnTool
      ? [catalogEntry(input.dynamicSpawnTool, "agent")]
      : []),
    ...(input.agentReportTool
      ? [catalogEntry(input.agentReportTool, "agent")]
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
    catalogEntry(createCreateFileTool(), "coding"),
    catalogEntry(createReplaceFileTool(), "coding"),
    catalogEntry(createWriteFileTool(), "coding"),
    catalogEntry(createEditAnchoredTextTool(), "coding"),
    catalogEntry(createApplyPatchTool(), "coding"),
  ];
}

function applyWorkspaceMutationLeases(
  entries: HostToolCatalogEntry[],
  input: {
    workspaceRoot: string;
    workspaceLeaseCoordinator?: WorkspaceLeaseCoordinator;
    taskManager?: TaskManager;
  },
): HostToolCatalogEntry[] {
  if (!input.workspaceLeaseCoordinator) return entries;
  const eligibleSources = new Set<HostToolCatalogSource>([
    "coding",
    "shell",
    "skill",
  ]);
  return entries.map((entry) =>
    eligibleSources.has(entry.source) ||
    (entry.source === "agent" && entry.definition.name === "create_agent")
      ? {
          ...entry,
          definition: withWorkspaceMutationLease(entry.definition, {
            coordinator: input.workspaceLeaseCoordinator,
            workspaceRoot: input.workspaceRoot,
            ...(entry.source === "shell" && input.taskManager
              ? { backgroundTaskManager: input.taskManager }
              : {}),
          }),
        }
      : entry,
  );
}

function applyToolConfigToCatalog(
  entries: HostToolCatalogEntry[],
  config: CapabilityToolsConfig | undefined,
): HostToolCatalogEntry[] {
  const metadataByName = new Map(
    entries.map((entry) => [entry.definition.name, entry]),
  );
  const selectorAllowed = resolveSelectorAllowlist(entries, config?.use);
  const effectiveAllowed = intersectAllowlists(
    normalizeToolNameList(config?.allowed),
    selectorAllowed,
  );
  return applyToolConfig(
    entries.map((entry) => entry.definition),
    selectorAllowed === undefined
      ? config
      : { ...config, allowed: effectiveAllowed },
  ).map((definition) => {
    const metadata = metadataByName.get(definition.name);
    if (!metadata) {
      return catalogEntry(definition, "core");
    }
    return { ...metadata, definition };
  });
}

function intersectAllowlists(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] | undefined {
  if (left === undefined) return right ? [...right] : undefined;
  if (right === undefined) return [...left];
  const rightSet = new Set(right);
  const out: string[] = [];
  for (const entry of left) {
    if (rightSet.has(entry) && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * Resolve the effective concrete-tool allowlist implied by `tools.use`
 * selectors and `tools.allowed`, using the real main host catalog as the single
 * source of name→source truth. Returns `undefined` when neither is configured
 * (no restriction).
 *
 * Diagnostics that lack a live runtime snapshot (e.g. CLI `capabilities inspect`
 * when runtime inspection fails) call this so they apply the same selector
 * semantics as a real run instead of re-deriving tool sources from a hand-kept
 * list. The catalog is built with inert stubs (no I/O happens at construction).
 */
export function resolveConfiguredToolAllowlist(input: {
  workspaceRoot: string;
  toolConfig: CapabilityToolsConfig | undefined;
  mcpTools?: readonly { name: string; serverName: string }[];
}): string[] | undefined {
  const config = input.toolConfig;
  if (config?.use === undefined && config?.allowed === undefined) {
    return undefined;
  }
  const selectorEntries: ToolSelectorCatalogEntry[] = [
    ...createMainHostToolCatalogList({
      workspaceRoot: input.workspaceRoot,
      skillRoots: [],
      taskManager: new TaskManager({ store: new InMemoryTaskStore() }),
      getParentRunId: () => createRunId(),
      todoPath: join(input.workspaceRoot, ".sparkwright", "inspect-todo.md"),
    }).map((entry) => ({ definition: entry.definition, source: entry.source })),
    ...(input.mcpTools ?? []).map((tool) => ({
      definition: {
        name: tool.name,
        governance: { origin: { kind: "mcp" as const, name: tool.serverName } },
      },
      source: "mcp" as const,
    })),
  ];
  const selectorAllowed = resolveSelectorAllowlist(
    selectorEntries,
    config?.use,
  );
  return intersectAllowlists(
    normalizeToolNameList(config?.allowed),
    selectorAllowed,
  );
}

function catalogEntry(
  definition: ToolDefinition,
  source: HostToolCatalogSource,
): HostToolCatalogEntry {
  return { definition: applyBuiltinToolIdentity(definition, source), source };
}

function formatToolOrigin(origin: ToolOrigin): string {
  return `${origin.kind}:${origin.name ?? "unknown"}`;
}
