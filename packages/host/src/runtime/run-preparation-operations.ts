import { isAbsolute, join, relative, resolve } from "node:path";
import {
  createRun,
  type EventEmitter,
  type InteractionChannel,
  type RunId,
  type WorkflowHook,
} from "@sparkwright/core";
import type {
  FileWorkflowStore,
  TaskManager,
  WorkflowLeaseBoundWriter,
  WorkflowRunId,
  WorkflowRunRecord,
} from "@sparkwright/agent-runtime";
import {
  createLazyMcpToolsForRun,
  prepareMcpToolsForRun,
  type McpServerConfig,
} from "@sparkwright/mcp-adapter";
import type { ProtocolError, TraceLevel } from "@sparkwright/protocol";
import { RECOMMENDED_FOREGROUND_TIMEOUT_MS } from "@sparkwright/shell-tool";
import type { ResolvedShellSandboxConfig } from "@sparkwright/shell-sandbox";
import { prepareSkillsForRun } from "@sparkwright/skills";
import { MAIN_AGENT_ID } from "../agent-constants.js";
import {
  describeActiveEventRules,
  describeActiveWorkflowRules,
} from "../active-rules.js";
import type {
  CapabilityVerificationConfig,
  CapabilityWorkflowHookConfig,
} from "../config-zod-schema.js";
import { loadHostConfig } from "../config/config-implementation.js";
import type { CapabilityMcpConfig } from "../config/contracts.js";
import { createDocumentedCommandWorkflowHooks } from "../documented-command-check.js";
import { createExecutionResources } from "../execution-resources.js";
import { resolveExecutionPlan } from "../execution-plan.js";
import { createModel } from "../model-factory.js";
import type { ResolvedRunAccess } from "../run-access.js";
import { createHostRunPolicy } from "../run-policy.js";
import { prepareHostRunSecurityPlan } from "../run-security-plan.js";
import { existingSkillRoots } from "../skill-roots.js";
import { createSkillUsageRecorder } from "../skill-usage.js";
import {
  catalogToolDefinitions,
  createMainHostToolCatalog,
  type HostToolCatalogEntry,
} from "../tool-catalog.js";
import { admitToolsForAgentProfile } from "../tool-surface.js";
import { createVerificationWorkflowHooks } from "../verification.js";
import {
  createConfiguredWorkflowHooks,
  createPartialSubagentFinalityDisclosureHook,
  type CreateConfiguredWorkflowHooksOptions,
} from "../workflow-hooks.js";
import { createWorkflowProjectionHooks } from "../workflow-projection.js";
import { loadLayeredWorkflowAssets } from "../workflows.js";
import type { WorkspaceLeaseCoordinator } from "../workspace-lease-coordinator.js";
import type { AgentRuntimeAssembly } from "./agent-runtime-assembly.js";
import {
  capabilitySnapshotAgentProfiles,
  createSkillPreprocessOptions,
  inlineShellCapabilitySummary,
  modelCapabilitySummary,
  workflowCapabilitySummary,
} from "./capability-assembly.js";
import type {
  CapabilityInspectionMcpPreparation,
  CapabilityRuntimeOperations,
} from "./capability-runtime-operations.js";
import type { WorkflowEpisodeRuntime } from "./workflow-episode-runtime.js";
import type { WorkflowEpisodeEnvironment } from "./workflow-episode-runtime.js";

/** Keep development-only Skill fixtures out of ordinary run preparation. */
export function devSkillsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.SPARKWRIGHT_DEV_SKILLS;
  return value === "1" || value === "true";
}

type RuntimeMcpConfig = Omit<CapabilityMcpConfig, "servers"> & {
  servers?: McpServerConfig[];
};

function mergeRuntimeMcpConfig(
  config: CapabilityMcpConfig | undefined,
  extraServers: readonly McpServerConfig[] | undefined,
): RuntimeMcpConfig | undefined {
  const hasExtraServers = (extraServers?.length ?? 0) > 0;
  const servers = [
    ...((config?.servers ?? []) as McpServerConfig[]),
    ...(extraServers ?? []),
  ];
  if (!config && servers.length === 0) return undefined;
  return {
    ...(config ?? {}),
    ...(config?.startup
      ? {}
      : hasExtraServers
        ? { startup: "prepare" as const }
        : {}),
    ...(servers.length > 0 ? { servers } : {}),
  };
}

function mcpStartupMode(
  config: RuntimeMcpConfig | undefined,
): "lazy" | "prepare" | "eager" {
  return config?.startup ?? "lazy";
}

function mcpToolSchemaLoad(
  config: RuntimeMcpConfig,
): NonNullable<RuntimeMcpConfig["toolSchemaLoad"]> {
  return (
    config.toolSchemaLoad ?? (config.startup === "eager" ? "eager" : "defer")
  );
}

type PreparedSkills = Awaited<ReturnType<typeof prepareSkillsForRun>>;
type PreparedMcp = Awaited<ReturnType<typeof prepareMcpToolsForRun>>;

async function createRuntimeMcpTools(input: {
  config: RuntimeMcpConfig | undefined;
  workspaceRoot: string;
  emitter?: EventEmitter;
  agentId?: string;
  shellSandbox?: ResolvedShellSandboxConfig;
}): Promise<PreparedMcp | null> {
  const config = input.config;
  if (!config?.servers?.length) return null;
  const common = {
    servers: config.servers,
    defaultTimeoutMs: config.defaultTimeoutMs,
    namePrefix: config.namePrefix,
    toolSchemaLoad: mcpToolSchemaLoad(config),
    policy: config.defaultPolicy,
    emitter: input.emitter,
    agentId: input.agentId,
    shellSandbox: input.shellSandbox,
  };
  return mcpStartupMode(config) === "lazy"
    ? createLazyMcpToolsForRun(common)
    : await prepareMcpToolsForRun(common);
}

export async function prepareRuntimeMcpInspection(input: {
  config?: CapabilityMcpConfig;
  extraServers?: readonly McpServerConfig[];
  workspaceRoot: string;
  shellSandbox: ResolvedShellSandboxConfig;
}): Promise<CapabilityInspectionMcpPreparation> {
  const runtimeConfig = mergeRuntimeMcpConfig(input.config, input.extraServers);
  return {
    servers: runtimeConfig?.servers ?? [],
    prepared: await createRuntimeMcpTools({
      config: runtimeConfig,
      workspaceRoot: input.workspaceRoot,
      shellSandbox: input.shellSandbox,
    }),
  };
}

function configuredMcpWorkspaceCwdServers(
  config: RuntimeMcpConfig | undefined,
  workspaceRoot: string,
): string[] {
  if (!config?.servers?.length) return [];
  return config.servers
    .filter((server) => {
      if (server.type !== "stdio" || server.enabled === false || !server.cwd) {
        return false;
      }
      const cwd = isAbsolute(server.cwd)
        ? server.cwd
        : resolve(workspaceRoot, server.cwd);
      return isSameOrInsidePath(workspaceRoot, cwd);
    })
    .map((server) => server.name);
}

function isSameOrInsidePath(parent: string, candidate: string): boolean {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  const rel = relative(parentPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function requireActiveRunId(value: string | null): RunId {
  if (!value) {
    throw new Error("Task tool invoked before a run id was assigned.");
  }
  return value as RunId;
}

function extractSkillSourcePath(message: string): string | undefined {
  return message.match(/(?:^|\s)(\/[^\n:]+SKILL\.md)\b/)?.[1];
}

export interface PreparedHostRunEnvironment extends WorkflowEpisodeEnvironment {
  preparedSkills: PreparedSkills | null;
  preparedMcp: PreparedMcp | null;
  toolCatalog: HostToolCatalogEntry[];
  workflowProjection?: ReturnType<typeof createWorkflowProjectionHooks>;
}

export interface RuntimeWorkflowHookAssemblyOptions extends Omit<
  CreateConfiguredWorkflowHooksOptions,
  "hooks"
> {
  workflowHooks?: CapabilityWorkflowHookConfig[];
  workflowActive?: boolean;
  projectionHooks?: WorkflowHook[];
  verification?: CapabilityVerificationConfig;
  documentedCommand: {
    goal: string;
    shouldWrite: boolean;
  };
}

export function assembleRuntimeWorkflowHooks(
  options: RuntimeWorkflowHookAssemblyOptions,
): WorkflowHook[] {
  const verificationHooks = createVerificationWorkflowHooks({
    ...options,
    verification: options.verification,
  });
  const documentedCommandHooks = createDocumentedCommandWorkflowHooks({
    ...options,
    workspaceRoot: options.workspaceRoot,
    goal: options.documentedCommand.goal,
    shouldWrite: options.documentedCommand.shouldWrite,
  });
  const projectionHooks = options.projectionHooks ?? [];
  const workflowActive =
    options.workflowActive === true || projectionHooks.length > 0;
  return [
    ...createConfiguredWorkflowHooks({
      ...options,
      hooks: options.workflowHooks,
      workflowActive,
    }),
    ...verificationHooks,
    ...documentedCommandHooks,
    ...projectionHooks,
    createPartialSubagentFinalityDisclosureHook(),
  ];
}

export interface RunPreparationInput {
  goal: string;
  modelRef?: string;
  access: ResolvedRunAccess;
  sessionId: string;
  targetPath?: string;
  confidentialPaths?: readonly string[];
  confidentialDefaults?: boolean;
  traceLevel?: TraceLevel;
  workflowName?: string;
  workflowRunId?: WorkflowRunId;
  controlSessionId?: string;
  workflowStore?: FileWorkflowStore;
  workflowRecord?: WorkflowRunRecord;
  workflowLease?: WorkflowLeaseBoundWriter;
  workflowWaitingInputMetadata?: Record<string, unknown>;
  runMetadata?: Record<string, unknown>;
  runStoreMetadata?: Record<string, unknown>;
}

export interface RunPreparationOperationsOptions {
  workspaceRoot: string;
  sessionRootDir?: string;
  extraMcpServers?: readonly McpServerConfig[];
  workspaceLeaseCoordinator: WorkspaceLeaseCoordinator;
  taskManager: TaskManager;
  agents: Pick<AgentRuntimeAssembly, "prepareRun">;
  capabilities: Pick<
    CapabilityRuntimeOperations,
    "captureRunSnapshot" | "recordIndexFailure" | "summarize"
  >;
  workflowEpisodes: Pick<WorkflowEpisodeRuntime, "prepare">;
  createInteractionChannel(runIdHolder: {
    value: string | null;
  }): InteractionChannel;
}

/** Owns Host model, capability, tool, hook, and policy preparation for a run. */
export class RunPreparationOperations {
  constructor(private readonly options: RunPreparationOperationsOptions) {}

  async prepare(
    input: RunPreparationInput,
  ): Promise<
    | { ok: true; env: PreparedHostRunEnvironment }
    | { ok: false; error: ProtocolError }
  > {
    const plan = resolveExecutionPlan({
      workspaceRoot: this.options.workspaceRoot,
      sessionRootDir: this.options.sessionRootDir,
      sessionId: input.sessionId,
      goal: input.goal,
      modelRef: input.modelRef,
      targetPath: input.targetPath,
      traceLevel: input.traceLevel,
      access: input.access,
    });
    const model = await createModel({
      modelRef: plan.modelRef,
      goal: plan.goal,
      workspaceRoot: plan.workspaceRoot,
      targetPath: plan.targetPath,
    });
    if (!model.ok) {
      return {
        ok: false,
        error: { code: "invalid_payload", message: model.message },
      };
    }

    const workspaceRoot = plan.workspaceRoot;
    const resources = createExecutionResources(plan);
    const { workspace, trace, pendingExtensionEvents } = resources;
    const sessionRootDir = plan.sessionRootDir;
    const skillUsageRecorder = createSkillUsageRecorder(workspaceRoot);
    const runIdHolder: { value: string | null } = { value: null };
    const interactionChannel =
      this.options.createInteractionChannel(runIdHolder);
    const loadedConfig = await loadHostConfig(workspaceRoot);
    const baseToolConfig = loadedConfig.config.tools;
    const shellConfig = loadedConfig.config.shell;
    const hookConfig = loadedConfig.config.capabilities?.hooks;
    const skillConfig = loadedConfig.config.capabilities?.skills;
    const mcpConfig = mergeRuntimeMcpConfig(
      loadedConfig.config.capabilities?.mcp,
      this.options.extraMcpServers,
    );
    const agentConfig = loadedConfig.config.capabilities?.agents;
    const writeGuardrails = loadedConfig.config.write;
    const securityPlan = await prepareHostRunSecurityPlan({
      workspaceRoot,
      access: input.access,
      loadedConfig,
      requestConfidentialPaths: input.confidentialPaths,
      requestConfidentialDefaults: input.confidentialDefaults,
    });
    const runAccess = securityPlan.access;
    const confidentialPaths = securityPlan.confidentialPaths;
    const confidentialDefaults = securityPlan.confidentialDefaults;
    const skillRoots = securityPlan.skillRoots;
    const shellSandbox = securityPlan.shellSandboxStatus;
    const mcpShellSandbox = securityPlan.shellSandbox;
    const skillPreprocess = createSkillPreprocessOptions({
      skillConfig,
      emitter: pendingExtensionEvents,
      sandbox: mcpShellSandbox,
      workspaceRoot,
    });
    const existingPreparedSkillRoots = await existingSkillRoots(skillRoots);
    let preparedSkills: PreparedSkills | null = null;
    try {
      preparedSkills = existingPreparedSkillRoots.length
        ? await prepareSkillsForRun({
            goal: input.goal,
            skillRoots: existingPreparedSkillRoots,
            agent: {
              allowedSkills: skillConfig?.allowedSkills,
              deniedSkills: skillConfig?.deniedSkills,
            },
            includeLoaderTool: skillConfig?.includeLoaderTool ?? true,
            loadSelectedSkills: skillConfig?.loadSelectedSkills ?? false,
            maxSelectedSkills: skillConfig?.maxSelectedSkills,
            resourceFileLimit: skillConfig?.resourceFileLimit,
            includeDevSkills: devSkillsEnabled(),
            emitter: pendingExtensionEvents,
            agentId: MAIN_AGENT_ID,
            preprocess: skillPreprocess,
          })
        : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.capabilities.recordIndexFailure({
        goal: input.goal,
        sessionId: input.sessionId,
        traceLevel: input.traceLevel ?? "standard",
        message,
        source: extractSkillSourcePath(message),
        targetPath: input.targetPath,
        metadata: input.runStoreMetadata ?? input.runMetadata ?? {},
      });
      return {
        ok: false,
        error: { code: "internal_error", message },
      };
    }
    const parentRunRef: { current?: ReturnType<typeof createRun> } = {};
    const mcpEventEmitter: EventEmitter = {
      emit<TPayload>(
        type: Parameters<EventEmitter["emit"]>[0],
        payload: TPayload,
        metadata?: Record<string, unknown>,
      ) {
        return (parentRunRef.current?.events ?? pendingExtensionEvents).emit(
          type,
          payload,
          metadata,
        );
      },
    };
    const preparedMcp = await createRuntimeMcpTools({
      config: mcpConfig,
      workspaceRoot,
      emitter: mcpEventEmitter,
      agentId: MAIN_AGENT_ID,
      shellSandbox: mcpShellSandbox,
    });
    const traceLevel =
      input.traceLevel ?? loadedConfig.config.traceLevel ?? "standard";
    const parentRunPolicy = createHostRunPolicy({
      permissionMode: runAccess.permissionMode,
      shouldWrite: runAccess.shouldWrite,
      targetPath: input.targetPath,
      confidentialPaths,
      confidentialDefaults,
      writeGuardrails,
    });
    const sessionStore = resources.sessionStore;
    const agentRuntime = await this.options.agents.prepareRun({
      goal: input.goal,
      workspaceRoot,
      ...(input.targetPath ? { targetPath: input.targetPath } : {}),
      sessionId: input.sessionId,
      sessionRootDir,
      sessionStore,
      traceLevel,
      baseToolConfig,
      ...(agentConfig ? { agentConfig } : {}),
      ...(loadedConfig.config.runBudget
        ? { runBudget: loadedConfig.config.runBudget }
        : {}),
      ...(loadedConfig.config.maxSteps !== undefined
        ? { maxSteps: loadedConfig.config.maxSteps }
        : {}),
      ...(shellConfig ? { shell: shellConfig } : {}),
      ...(hookConfig?.http ? { hookHttp: hookConfig.http } : {}),
      skillRoots: skillRoots.map((root) => root.root),
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
      pendingEvents: pendingExtensionEvents,
      parentRunRef,
      parentModel: model.adapter,
      parentModelRef: model.resolved.modelRef,
      parentRunPolicy,
      interactionChannel,
      allowReadWriteWorkspaceAccess: runAccess.shouldWrite,
      backgroundTasks: runAccess.backgroundTasks,
    });
    const {
      mainAgent,
      derivedAgents,
      toolConfig,
      delegateTools,
      delegateAgentTool,
      delegateParallelTool,
      dynamicSpawnTool,
    } = agentRuntime;
    const resolvedProfiles = agentRuntime.resolvedProfiles;
    const delegateDescriptors = agentRuntime.delegateDescriptors;
    const baseMainToolCatalog = createMainHostToolCatalog({
      workspaceRoot,
      skillRoots: [...skillRoots],
      toolConfig,
      taskManager: this.options.taskManager,
      taskRunners: { agent: agentRuntime.taskRunner },
      getParentRunId: () => requireActiveRunId(runIdHolder.value),
      getRunEvents: () => parentRunRef.current?.events,
      todoPath: join(sessionRootDir, input.sessionId, "todo.md"),
      preparedSkills,
      preparedMcp,
      delegateTools,
      delegateAgentTool,
      delegateParallelTool,
      dynamicSpawnTool,
      shell: shellConfig,
      backgroundTasks: runAccess.backgroundTasks,
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
      workspaceLeaseCoordinator: this.options.workspaceLeaseCoordinator,
    });
    const toolCatalog = admitToolsForAgentProfile(
      baseMainToolCatalog,
      mainAgent,
      (entry) => entry.definition,
      (entry, definition) => ({ ...entry, definition }),
    );
    const tools = catalogToolDefinitions(toolCatalog);
    const admittedDelegateParallelTool = delegateParallelTool
      ? tools.find((tool) => tool.name === delegateParallelTool.name)
      : undefined;
    const workflows = await loadLayeredWorkflowAssets(workspaceRoot);
    const workflowEpisode = await this.options.workflowEpisodes.prepare({
      goal: input.goal,
      sessionId: input.sessionId,
      sessionRootDir,
      workspaceRoot,
      workflows,
      parentModelRef: model.resolved.modelRef,
      ...(input.workflowName ? { workflowName: input.workflowName } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.controlSessionId
        ? { controlSessionId: input.controlSessionId }
        : {}),
      ...(input.workflowStore ? { workflowStore: input.workflowStore } : {}),
      ...(input.workflowRecord ? { workflowRecord: input.workflowRecord } : {}),
      ...(input.workflowLease ? { workflowLease: input.workflowLease } : {}),
      ...(input.workflowWaitingInputMetadata !== undefined
        ? { workflowWaitingInputMetadata: input.workflowWaitingInputMetadata }
        : {}),
      ...(input.targetPath ? { targetPath: input.targetPath } : {}),
      ...(confidentialPaths ? { confidentialPaths } : {}),
      ...(confidentialDefaults !== undefined ? { confidentialDefaults } : {}),
      access: runAccess,
      ...(input.runMetadata ? { runMetadata: input.runMetadata } : {}),
      ...(shellConfig?.sandbox ? { shellSandbox: shellConfig.sandbox } : {}),
      ...(hookConfig?.http ? { hookHttp: hookConfig.http } : {}),
      skillRoots: skillRoots.map((root) => root.root),
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
      parentRunRef,
      tools,
      ...(delegateAgentTool ? { delegateAgentTool } : {}),
      ...(admittedDelegateParallelTool
        ? { delegateParallelTool: admittedDelegateParallelTool }
        : {}),
    });
    if (!workflowEpisode.ok) return workflowEpisode;
    const workflowModelAdapters =
      workflowEpisode.prepared.workflowModelAdapters;
    const workflowProjection = workflowEpisode.prepared.workflowProjection;
    const workflowStore = workflowEpisode.prepared.workflowStore;
    const workflowRecord = workflowEpisode.prepared.workflowRecord;
    const workflowLease = workflowEpisode.prepared.workflowLease;
    const workflowHooks = assembleRuntimeWorkflowHooks({
      workflowHooks: hookConfig?.workflow,
      workflowActive: workflowProjection !== undefined,
      projectionHooks: workflowProjection?.hooks,
      verification: loadedConfig.config.capabilities?.verification,
      workspaceRoot,
      sandbox: shellConfig?.sandbox,
      http: hookConfig?.http,
      skillRoots: skillRoots.map((root) => root.root),
      configPaths: loadedConfig.attempted.map((entry) => entry.path),
      getRun: () => parentRunRef.current,
      agentTool: delegateAgentTool,
      documentedCommand: {
        goal: input.goal,
        shouldWrite: runAccess.shouldWrite,
      },
    });
    const workflowRules = describeActiveWorkflowRules({
      workflowHooks: hookConfig?.workflow,
      verification: loadedConfig.config.capabilities?.verification,
      documentedCommand: {
        goal: input.goal,
        shouldWrite: runAccess.shouldWrite,
      },
    });
    const eventRules = describeActiveEventRules({
      eventHooks: hookConfig?.events,
    });
    const capabilitySnapshot = this.options.capabilities.captureRunSnapshot({
      model: modelCapabilitySummary(model.resolved),
      access: input.access,
      toolCatalog,
      indexedSkills: preparedSkills?.indexedSkills ?? [],
      loadedSkills: preparedSkills?.loadedSkills ?? [],
      skillInlineShell: inlineShellCapabilitySummary(
        skillConfig?.inlineShell,
        shellSandbox,
      ),
      mcpStatuses: preparedMcp?.statuses ?? {},
      mcpToolNameMap: preparedMcp?.toolNameMap ?? [],
      agentProfiles: capabilitySnapshotAgentProfiles(
        mainAgent,
        resolvedProfiles,
      ),
      delegateTools: delegateDescriptors,
      shellSandbox,
      shellForegroundTimeoutMs:
        shellConfig?.foregroundTimeoutMs ?? RECOMMENDED_FOREGROUND_TIMEOUT_MS,
      shellPromotionAvailable: runAccess.backgroundTasks === "enabled",
      workflowRules,
      eventRules,
      workflows: workflowCapabilitySummary(workflows),
    });

    const mcpWorkspaceCwdServers = configuredMcpWorkspaceCwdServers(
      mcpConfig,
      workspaceRoot,
    );
    const runMetadata: Record<string, unknown> = {
      source: "host",
      ...(input.runMetadata ?? {}),
      sessionId: input.sessionId,
      workspaceRoot,
      permissionMode: runAccess.permissionMode,
      traceLevel,
      ...(mcpWorkspaceCwdServers.length > 0 ? { mcpWorkspaceCwdServers } : {}),
      ...(input.modelRef ? { requestedModel: input.modelRef } : {}),
      ...(workflowRecord && workflowProjection
        ? {
            workflow: {
              workflowRunId: workflowRecord.id,
              assetName: workflowRecord.assetName,
              version: workflowRecord.version,
              packageHash: workflowRecord.packageHash,
              packageHashPolicyVersion: workflowRecord.packageHashPolicyVersion,
              verifyOnResume: workflowRecord.resume.verifyOnResume,
            },
          }
        : {}),
      resolvedModel: model.resolved,
      capabilitySnapshot:
        this.options.capabilities.summarize(capabilitySnapshot),
    };
    const runStoreMetadata: Record<string, unknown> = {
      ...runMetadata,
      ...(input.runStoreMetadata ?? {}),
      ...(preparedSkills
        ? {
            indexedSkills: preparedSkills.indexedSkills,
            loadedSkills: preparedSkills.loadedSkills,
          }
        : {}),
      ...(preparedMcp
        ? {
            mcpStatuses: preparedMcp.statuses,
            mcpToolNameMap: preparedMcp.toolNameMap,
          }
        : {}),
      ...(resolvedProfiles.length
        ? {
            agentProfiles: [
              mainAgent,
              ...derivedAgents.map((agent) => agent.effectiveProfile),
            ],
          }
        : {}),
    };
    runStoreMetadata.traceLevel = traceLevel;

    return {
      ok: true,
      env: {
        workspaceRoot,
        workspace,
        sessionRootDir,
        trace,
        pendingExtensionEvents,
        skillUsageRecorder,
        runIdHolder,
        interactionChannel,
        model: model.adapter,
        modelRef: model.resolved.modelRef,
        resolvedModel: model.resolved,
        workflowModelAdapters,
        preparedSkills,
        preparedMcp,
        mainAgent,
        toolCatalog,
        tools,
        workflowHooks,
        workflowProjection,
        workflowStore,
        workflowRecord,
        workflowLease,
        eventHookConfig: hookConfig?.events,
        hookSandbox: shellConfig?.sandbox,
        hookHttp: hookConfig?.http,
        hookSkillRoots: skillRoots.map((root) => root.root),
        hookConfigPaths: loadedConfig.attempted.map((entry) => entry.path),
        delegateAgentTool,
        sessionStore,
        parentRunRef,
        traceLevel,
        writeGuardrails,
        confidentialPaths,
        confidentialDefaults,
        runMetadata,
        runStoreMetadata,
      },
    };
  }
}
