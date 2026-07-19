import { join } from "node:path";
import {
  assessRun,
  createDefaultPolicy,
  createRunId,
  createSessionRunStoreFactory,
  FileSessionStore,
  type RunId,
  type RunRecord,
  type RunResult,
  type SparkwrightEvent,
} from "@sparkwright/core";
import { type TaskManager } from "@sparkwright/agent-runtime";
import { defaultCronRoot } from "@sparkwright/cron";
import {
  type McpServerConfig,
  type PreparedMcpTools,
} from "@sparkwright/mcp-adapter";
import {
  type CapabilityInspectRequestPayload,
  type CapabilitySnapshot,
  type HostEvent,
  type ProtocolError,
  type TraceLevel,
} from "@sparkwright/protocol";
import { RECOMMENDED_FOREGROUND_TIMEOUT_MS } from "@sparkwright/shell-tool";
import type { ResolvedShellSandboxConfig } from "@sparkwright/shell-sandbox";
import { prepareSkillsForRun } from "@sparkwright/skills";
import {
  createSessionFileRunStoreFactory,
  EventLog,
} from "@sparkwright/core/internal";
import { loadHostConfig } from "../config/config-implementation.js";
import type { CapabilityMcpConfig } from "../config/contracts.js";
import { resolveAgentProfiles } from "../agent-profiles.js";
import { MAIN_AGENT_ID } from "../agent-constants.js";
import {
  delegateToolName,
  filterDirectDelegatesForExposure,
  resolveAgentDelegateTools,
} from "../delegate-capability.js";
import { createDelegateAgentTool } from "../indexed-delegate-tool.js";
import { nextMessageId, nowIso } from "../connection.js";
import { inspectResolvedModelConfig } from "../model-factory.js";
import {
  resolveRunAccessFields,
  type ResolvedRunAccess,
} from "../run-access.js";
import { prepareHostRunSecurityPlan } from "../run-security-plan.js";
import { existingSkillRoots } from "../skill-roots.js";
import {
  catalogToolDefinitions,
  createConfiguredDelegateChildToolCatalog,
  createDynamicChildToolCatalog,
  createMainHostToolCatalog,
} from "../tool-catalog.js";
import { admitToolsForAgentProfile } from "../tool-surface.js";
import { loadLayeredWorkflowAssets } from "../workflows.js";
import {
  describeActiveEventRules,
  describeActiveWorkflowRules,
} from "../active-rules.js";
import {
  applyMainAgentToolUse,
  createConfiguredDelegateTools,
  createDelegateParallelTool,
  createDynamicSpawnAgentTool,
  deriveConfiguredAgents,
  describeConfiguredDelegateTools,
  mainAgentProfile,
  shouldExposeDelegateParallelTool,
  snapshotOnlyChildRunStoreFactory,
} from "./agent-runtime-assembly.js";
import {
  buildCapabilitySnapshot,
  capabilitySnapshotAgentProfiles,
  inlineShellCapabilitySummary,
  mergeCapabilitySnapshots,
  modelCapabilitySummary,
  readCronJobsForSnapshot,
  readTasksForSnapshot,
  summarizeCapabilitySnapshot,
  workflowCapabilitySummary,
  type CapabilitySnapshotBuildInput,
} from "./capability-assembly.js";
import type { RuntimeOptions } from "./contracts.js";

export interface CapabilityInspectionMcpPreparation {
  servers: readonly McpServerConfig[];
  prepared: PreparedMcpTools | null;
}

export interface CapabilityRuntimeOperationsOptions extends Pick<
  RuntimeOptions,
  | "defaultModel"
  | "defaultAccessMode"
  | "accessModeCeiling"
  | "defaultBackgroundTasks"
  | "backgroundTasksCeiling"
  | "emit"
> {
  workspaceRoot: string;
  sessionRootDir: string;
  taskManager: TaskManager;
  taskRootDir: string;
  includeDevSkills?: () => boolean;
  prepareMcp(input: {
    config?: CapabilityMcpConfig;
    shellSandbox: ResolvedShellSandboxConfig;
  }): Promise<CapabilityInspectionMcpPreparation>;
}

export interface CapabilityIndexFailureInput {
  goal: string;
  sessionId: string;
  traceLevel: TraceLevel;
  message: string;
  source?: string;
  targetPath?: string;
  metadata: Record<string, unknown>;
}

/** Host owner for effective capability inspection, snapshots, and diagnostics. */
export class CapabilityRuntimeOperations {
  private lastRunSnapshot: CapabilitySnapshot | null = null;

  constructor(private readonly options: CapabilityRuntimeOperationsOptions) {}

  async inspect(
    input: CapabilityInspectRequestPayload & { modelRef?: string } = {},
  ): Promise<
    | { ok: true; snapshot: CapabilitySnapshot }
    | { ok: false; error: ProtocolError }
  > {
    try {
      const access = resolveRunAccessFields(input, {
        defaultAccessMode: this.options.defaultAccessMode,
        accessModeCeiling: this.options.accessModeCeiling,
        defaultBackgroundTasks: this.options.defaultBackgroundTasks,
        backgroundTasksCeiling: this.options.backgroundTasksCeiling,
      });
      const configured = await this.inspectConfigured({
        modelRef: input.model ?? input.modelRef,
        access,
      });
      return {
        ok: true,
        snapshot: mergeCapabilitySnapshots(configured, this.lastRunSnapshot),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  captureRunSnapshot(input: CapabilitySnapshotBuildInput): CapabilitySnapshot {
    const snapshot = buildCapabilitySnapshot(input);
    this.lastRunSnapshot = snapshot;
    return snapshot;
  }

  summarize(
    snapshot: CapabilitySnapshot | null = this.lastRunSnapshot,
  ): Record<string, unknown> {
    return summarizeCapabilitySnapshot(snapshot);
  }

  async recordIndexFailure(input: CapabilityIndexFailureInput): Promise<void> {
    const now = nowIso();
    const runId = createRunId();
    const run: RunRecord = {
      id: runId,
      goal: input.goal,
      state: "failed",
      stopReason: "model_completion_failed",
      createdAt: now,
      updatedAt: now,
      metadata: {
        source: "host",
        failurePhase: "capability_index",
        ...(input.targetPath ? { targetPath: input.targetPath } : {}),
        ...input.metadata,
      },
    };
    const result: RunResult = {
      signal: "failed",
      state: "failed",
      stopReason: "model_completion_failed",
      message: input.message,
      failure: {
        category: "runtime",
        code: "SKILL_INDEX_FAILED",
        message: input.message,
        retryable: false,
      },
      assessment: assessRun([], {
        terminal: {
          state: "failed",
          reason: "model_completion_failed",
          failure: { code: "SKILL_INDEX_FAILED" },
        },
      }),
      metadata: run.metadata,
    };
    const sessionStore = new FileSessionStore({
      rootDir: this.options.sessionRootDir,
    });
    const store = createSessionRunStoreFactory({
      sessionStore,
      sessionId: input.sessionId,
      runStoreFactory: createSessionFileRunStoreFactory({
        sessionRootDir: this.options.sessionRootDir,
        sessionId: input.sessionId,
        agentId: MAIN_AGENT_ID,
        traceLevel: input.traceLevel,
      }),
      metadata: { source: "host" },
    })(run);
    const events = new EventLog(runId);
    const append = async (event: SparkwrightEvent) => {
      await store.append(event);
      this.options.emit(this.hostEvent(runId, event));
    };
    await append(events.emit("run.created", { goal: input.goal }));
    await append(
      events.emit(
        "capability.index.failed",
        {
          kind: "skills",
          source: input.source,
          message: input.message,
          code: "SKILL_INDEX_FAILED",
        },
        {
          source: "host",
          failurePhase: "capability_index",
          agentId: MAIN_AGENT_ID,
        },
      ),
    );
    await append(
      events.emit("run.failed", {
        reason: "capability_index_failed",
        code: "SKILL_INDEX_FAILED",
        message: input.message,
        failure: result.failure,
        assessment: result.assessment,
        metadata: run.metadata,
      }),
    );
    await store.finish(run, result);
  }

  private hostEvent(runId: RunId, event: SparkwrightEvent): HostEvent {
    return {
      envelope: "event",
      id: nextMessageId("evt"),
      kind: "run.event",
      timestamp: nowIso(),
      payload: { runId, event },
    };
  }

  private async inspectConfigured(input: {
    modelRef?: string;
    access: ResolvedRunAccess;
  }): Promise<CapabilitySnapshot> {
    const loadedConfig = await loadHostConfig(this.options.workspaceRoot);
    const baseToolConfig = loadedConfig.config.tools;
    const shellConfig = loadedConfig.config.shell;
    const skillConfig = loadedConfig.config.capabilities?.skills;
    const agentConfig = loadedConfig.config.capabilities?.agents;
    const automation = await this.inspectAutomationSummary();
    const workflows = await loadLayeredWorkflowAssets(
      this.options.workspaceRoot,
    );
    const model = await inspectResolvedModelConfig({
      modelRef: input.modelRef ?? this.options.defaultModel,
      workspaceRoot: this.options.workspaceRoot,
    });
    const resolvedProfiles = await resolveAgentProfiles(
      this.options.workspaceRoot,
      agentConfig?.profiles,
    );
    const delegationTargets = resolveAgentDelegateTools(
      resolvedProfiles,
      agentConfig?.delegateTools,
      { includeAllChildProfiles: true },
    );
    const securityPlan = await prepareHostRunSecurityPlan({
      workspaceRoot: this.options.workspaceRoot,
      access: input.access,
      loadedConfig,
    });
    const skillRoots = securityPlan.skillRoots;
    const shellSandbox = securityPlan.shellSandboxStatus;
    const existingPreparedSkillRoots = await existingSkillRoots(skillRoots);
    const preparedSkills = existingPreparedSkillRoots.length
      ? await prepareSkillsForRun({
          goal: "",
          skillRoots: existingPreparedSkillRoots,
          agent: {
            allowedSkills: skillConfig?.allowedSkills,
            deniedSkills: skillConfig?.deniedSkills,
          },
          includeLoaderTool: skillConfig?.includeLoaderTool ?? true,
          loadSelectedSkills: false,
          resourceFileLimit: skillConfig?.resourceFileLimit,
          includeDevSkills: this.options.includeDevSkills?.() ?? false,
          agentId: MAIN_AGENT_ID,
        })
      : null;
    const mcp = await this.options.prepareMcp({
      config: loadedConfig.config.capabilities?.mcp,
      shellSandbox: securityPlan.shellSandbox,
    });
    try {
      const mainAgent = mainAgentProfile(resolvedProfiles);
      const toolConfig = applyMainAgentToolUse(baseToolConfig, mainAgent);
      const dynamicChildToolCatalog = createDynamicChildToolCatalog({
        workspaceRoot: this.options.workspaceRoot,
        toolConfig,
      });
      const delegateChildToolCatalog = createConfiguredDelegateChildToolCatalog(
        {
          workspaceRoot: this.options.workspaceRoot,
          toolConfig,
          shell: shellConfig,
          skillRoots: skillRoots.map((root) => root.root),
          configPaths: loadedConfig.attempted.map((entry) => entry.path),
        },
      );
      const derivedAgents = deriveConfiguredAgents(
        mainAgent,
        resolvedProfiles,
        delegateChildToolCatalog,
      );
      const dynamicChildTools = catalogToolDefinitions(dynamicChildToolCatalog);
      const delegateChildTools = catalogToolDefinitions(
        delegateChildToolCatalog,
      );
      const allDelegateTools = createConfiguredDelegateTools({
        getParent: () => undefined,
        delegates: delegationTargets,
        derivedAgents,
        model: {
          async complete() {
            return { message: "" };
          },
        },
        childTools: delegateChildTools,
        workspaceRoot: this.options.workspaceRoot,
        parentRunPolicy: createDefaultPolicy(),
        sandbox: shellConfig?.sandbox,
        skillRoots: skillRoots.map((root) => root.root),
        configPaths: loadedConfig.attempted.map((entry) => entry.path),
        allowReadWriteWorkspaceAccess: input.access.shouldWrite,
        maxDepth: agentConfig?.maxDepth,
        childRunStoreFactory: snapshotOnlyChildRunStoreFactory,
      });
      const directDelegates = filterDirectDelegatesForExposure(
        delegationTargets,
        agentConfig,
        resolvedProfiles,
      );
      const directDelegateNames = new Set(
        directDelegates.map((delegate) => delegateToolName(delegate)),
      );
      const delegateTools = allDelegateTools.filter((tool) =>
        directDelegateNames.has(tool.name),
      );
      const delegateAgentTool = createDelegateAgentTool({
        delegates: delegationTargets,
        derivedAgents,
        delegateTools: allDelegateTools,
      });
      const delegateParallelTool = shouldExposeDelegateParallelTool({
        enabled: agentConfig?.enableParallelDelegates,
        delegates: directDelegates,
      })
        ? createDelegateParallelTool({
            getParent: () => undefined,
            delegates: delegationTargets,
            derivedAgents,
            model: {
              async complete() {
                return { message: "" };
              },
            },
            childTools: delegateChildTools,
            parentRunPolicy: createDefaultPolicy(),
            childRunStoreFactory: snapshotOnlyChildRunStoreFactory,
            allowReadWriteWorkspaceAccess: input.access.shouldWrite,
            maxDepth: agentConfig?.maxDepth,
            workspaceRoot: this.options.workspaceRoot,
          })
        : undefined;
      const dynamicSpawnTool = createDynamicSpawnAgentTool({
        getParent: () => undefined,
        model: {
          async complete() {
            return { message: "" };
          },
        },
        childTools: dynamicChildTools,
        parentRunPolicy: createDefaultPolicy(),
        childRunStoreFactory: snapshotOnlyChildRunStoreFactory,
        maxDepth: agentConfig?.maxDepth,
        workspaceRoot: this.options.workspaceRoot,
      });
      const baseMainToolCatalog = createMainHostToolCatalog({
        workspaceRoot: this.options.workspaceRoot,
        skillRoots: [...skillRoots],
        toolConfig,
        taskManager: this.options.taskManager,
        getParentRunId: () => "run_capability_snapshot" as RunId,
        todoPath: join(
          this.options.sessionRootDir,
          "capability_snapshot",
          "todo.md",
        ),
        preparedSkills,
        preparedMcp: mcp.prepared,
        delegateTools,
        delegateAgentTool,
        delegateParallelTool,
        dynamicSpawnTool,
        shell: shellConfig,
        backgroundTasks: input.access.backgroundTasks,
        configPaths: loadedConfig.attempted.map((entry) => entry.path),
      });
      const toolCatalog = admitToolsForAgentProfile(
        baseMainToolCatalog,
        mainAgent,
        (entry) => entry.definition,
        (entry, definition) => ({ ...entry, definition }),
      );
      return buildCapabilitySnapshot({
        ...(model.ok ? { model: modelCapabilitySummary(model.resolved) } : {}),
        access: input.access,
        toolCatalog,
        indexedSkills: preparedSkills?.indexedSkills ?? [],
        loadedSkills: [],
        skillInlineShell: inlineShellCapabilitySummary(
          skillConfig?.inlineShell,
          shellSandbox,
        ),
        mcpStatuses:
          mcp.prepared?.statuses ??
          Object.fromEntries(
            mcp.servers.map((server) => [
              server.name,
              server.enabled === false
                ? ({ status: "disabled" } as const)
                : ({ status: "configured" } as const),
            ]),
          ),
        mcpToolNameMap: mcp.prepared?.toolNameMap ?? [],
        agentProfiles: capabilitySnapshotAgentProfiles(
          mainAgent,
          resolvedProfiles,
        ),
        delegateTools: describeConfiguredDelegateTools({
          delegates: delegationTargets,
          derivedAgents,
          delegateChildToolCatalog,
          allowReadWriteWorkspaceAccess: input.access.shouldWrite,
        }),
        shellSandbox,
        shellForegroundTimeoutMs:
          shellConfig?.foregroundTimeoutMs ?? RECOMMENDED_FOREGROUND_TIMEOUT_MS,
        shellPromotionAvailable: input.access.backgroundTasks === "enabled",
        workflowRules: describeActiveWorkflowRules({
          workflowHooks: loadedConfig.config.capabilities?.hooks?.workflow,
          verification: loadedConfig.config.capabilities?.verification,
        }),
        eventRules: describeActiveEventRules({
          eventHooks: loadedConfig.config.capabilities?.hooks?.events,
        }),
        workflows: workflowCapabilitySummary(workflows),
        automation,
      });
    } finally {
      await mcp.prepared?.close();
    }
  }

  private async inspectAutomationSummary() {
    const cronRoot = defaultCronRoot();
    const cronJobs = await readCronJobsForSnapshot(cronRoot);
    const tasks = readTasksForSnapshot(this.options.taskRootDir);
    return {
      cron: {
        rootDir: cronRoot,
        total: cronJobs.length,
        jobs: cronJobs.slice(0, 8),
      },
      tasks: {
        rootDir: this.options.taskRootDir,
        total: tasks.length,
        tasks: tasks.slice(0, 8),
      },
    };
  }
}
