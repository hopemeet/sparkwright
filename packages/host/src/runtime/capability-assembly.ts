import type { EventEmitter, ToolOrigin } from "@sparkwright/core";
import { FileTaskStore, type AgentProfile } from "@sparkwright/agent-runtime";
import { CronStore } from "@sparkwright/cron";
import type { McpStatus, McpToolNameMapping } from "@sparkwright/mcp-adapter";
import { RECOMMENDED_FOREGROUND_TIMEOUT_MS } from "@sparkwright/shell-tool";
import type {
  LoadedSkill,
  SkillIndexEntry,
  SkillPreprocessOptions,
} from "@sparkwright/skills";
import type {
  CapabilityAutomationSummary,
  CapabilityEventRuleSummary,
  CapabilityModelSummary,
  CapabilitySkillInlineShellSummary,
  CapabilitySnapshot,
  CapabilityWorkflowAssetErrorSummary,
  CapabilityWorkflowAssetSummary,
  CapabilityWorkflowRuleSummary,
} from "@sparkwright/protocol";
import type {
  ResolvedShellSandboxConfig,
  ShellSandboxStatus,
} from "@sparkwright/shell-sandbox";
import type { DelegateCapabilityDescriptor } from "../delegate-capability.js";
import { MAIN_AGENT_ID } from "../agent-constants.js";
import type { ResolvedModelConfig } from "../model-factory.js";
import type { ResolvedRunAccess } from "../run-access.js";
import { createSkillInlineShellRunner } from "../skill-inline-shell.js";
import {
  catalogEntryOrigin,
  type HostToolCatalogEntry,
} from "../tool-catalog.js";
import type { loadLayeredWorkflowAssets } from "../workflows.js";

interface SkillInlineShellConfig {
  inlineShell?: {
    enabled?: boolean;
    timeoutMs?: number;
    maxOutputChars?: number;
  };
}

export interface CapabilitySnapshotBuildInput {
  model?: CapabilityModelSummary;
  access?: ResolvedRunAccess;
  toolCatalog: HostToolCatalogEntry[];
  indexedSkills: SkillIndexEntry[];
  loadedSkills: LoadedSkill[];
  skillInlineShell?: CapabilitySkillInlineShellSummary;
  mcpStatuses?: Record<string, McpStatus | { status: "configured" }>;
  mcpToolNameMap?: McpToolNameMapping[];
  agentProfiles?: AgentProfile[];
  delegateTools?: DelegateCapabilityDescriptor[];
  shellSandbox?: ShellSandboxStatus;
  shellForegroundTimeoutMs?: number;
  shellPromotionAvailable?: boolean;
  workflowRules?: CapabilityWorkflowRuleSummary[];
  eventRules?: CapabilityEventRuleSummary[];
  workflows?: {
    assets: CapabilityWorkflowAssetSummary[];
    errors?: CapabilityWorkflowAssetErrorSummary[];
  };
  automation?: CapabilityAutomationSummary;
}

export function buildCapabilitySnapshot(
  input: CapabilitySnapshotBuildInput,
): CapabilitySnapshot {
  return {
    ...(input.access ? { access: capabilityAccessSummary(input.access) } : {}),
    ...(input.model ? { model: input.model } : {}),
    tools: input.toolCatalog.map((entry) => ({
      name: entry.definition.name,
      canonicalName: entry.definition.canonicalName ?? entry.definition.name,
      ...(entry.definition.defaultExposureTier
        ? { defaultExposureTier: entry.definition.defaultExposureTier }
        : {}),
      source: entry.source,
      origin:
        formatToolOrigin(entry.definition.governance?.origin) ??
        catalogEntryOrigin(entry),
      risk: entry.definition.policy?.risk,
      ...(entry.definition.governance
        ? { governance: entry.definition.governance }
        : {}),
      effectiveLoading:
        entry.definition.deferLoading === true ? "deferred" : "eager",
      ...(entry.definition.deferLoading === true ? { deferred: true } : {}),
      ...(entry.definition.relatedTools &&
      entry.definition.relatedTools.length > 0
        ? { relatedTools: entry.definition.relatedTools }
        : {}),
      ...(entry.definition.requiresTool &&
      entry.definition.requiresTool.length > 0
        ? { requiresTool: entry.definition.requiresTool }
        : {}),
    })),
    skills: {
      indexed: input.indexedSkills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        sourcePath: skill.sourcePath,
        packageHash: skill.packageHash,
        packageHashPolicyVersion: skill.packageHashPolicyVersion,
        version: skill.version,
      })),
      loaded: input.loadedSkills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        sourcePath: skill.sourcePath,
        packageHash: skill.packageHash,
        packageHashPolicyVersion: skill.packageHashPolicyVersion,
        version: skill.version,
        selectionReason: skill.selectionReason,
      })),
      ...(input.skillInlineShell
        ? { inlineShell: input.skillInlineShell }
        : {}),
    },
    mcp: {
      statuses: Object.entries(input.mcpStatuses ?? {}).map(
        ([serverName, status]) => ({
          serverName,
          status: status.status,
          toolNames: (input.mcpToolNameMap ?? [])
            .filter((mapping) => mapping.serverName === serverName)
            .map((mapping) => mapping.toolName),
          ...(status.status === "failed"
            ? {
                errorCode: status.errorCode,
                errorPhase: status.phase,
                errorMessage: status.error,
              }
            : {}),
        }),
      ),
    },
    agents: {
      profiles: (
        input.agentProfiles ?? [{ id: MAIN_AGENT_ID, mode: "primary" }]
      ).map((profile) => ({
        id: profile.id,
        name: profile.name,
        mode: profile.mode,
      })),
      delegateTools: input.delegateTools ?? [],
    },
    ...(input.shellSandbox
      ? {
          shell: {
            foregroundTimeoutMs:
              input.shellForegroundTimeoutMs ??
              RECOMMENDED_FOREGROUND_TIMEOUT_MS,
            promotionAvailable: input.shellPromotionAvailable ?? true,
            sandbox: {
              mode: input.shellSandbox.mode,
              failIfUnavailable: input.shellSandbox.failIfUnavailable,
              runtimeId: input.shellSandbox.runtimeId,
              platform: input.shellSandbox.platform,
              available: input.shellSandbox.available,
              networkMode: input.shellSandbox.networkMode,
              filesystemIsolation: input.shellSandbox.filesystemIsolation,
            },
          },
        }
      : {}),
    ...(input.workflowRules || input.eventRules
      ? {
          rules: {
            workflow: input.workflowRules ?? [],
            ...(input.eventRules ? { events: input.eventRules } : {}),
          },
        }
      : {}),
    ...(input.workflows ? { workflows: input.workflows } : {}),
    automation: input.automation,
  };
}

function capabilityAccessSummary(
  access: ResolvedRunAccess,
): NonNullable<CapabilitySnapshot["access"]> {
  return {
    accessMode: access.accessMode,
    backgroundTasks: access.backgroundTasks,
    ...(access.requestedAccessMode
      ? { requestedAccessMode: access.requestedAccessMode }
      : {}),
    ...(access.accessModeCeiling
      ? { accessModeCeiling: access.accessModeCeiling }
      : {}),
    ...(access.requestedBackgroundTasks
      ? { requestedBackgroundTasks: access.requestedBackgroundTasks }
      : {}),
    ...(access.backgroundTasksCeiling
      ? { backgroundTasksCeiling: access.backgroundTasksCeiling }
      : {}),
  };
}

export function workflowCapabilitySummary(
  report: Awaited<ReturnType<typeof loadLayeredWorkflowAssets>>,
): {
  assets: CapabilityWorkflowAssetSummary[];
  errors?: CapabilityWorkflowAssetErrorSummary[];
} {
  return {
    assets: report.assets.map((asset) => ({
      assetName: asset.assetName,
      sourcePath: asset.sourcePath,
      layer: asset.layer,
      contentHash: asset.contentHash,
      ...(asset.version ? { version: asset.version } : {}),
      ...(asset.description ? { description: asset.description } : {}),
      nodeCount: asset.nodeCount,
      ...(asset.configPath ? { configPath: asset.configPath } : {}),
    })),
    ...(report.errors.length > 0
      ? {
          errors: report.errors.map((error) => ({
            sourcePath: error.sourcePath,
            layer: error.layer,
            message: error.message,
          })),
        }
      : {}),
  };
}

export function modelCapabilitySummary(
  resolved: ResolvedModelConfig,
): CapabilityModelSummary {
  return {
    modelRef: resolved.modelRef,
    providerKey: resolved.providerKey,
    modelId: resolved.modelId,
    adapterId: resolved.adapterId,
    pricing: resolved.pricing ?? {
      source: resolved.pricingSource ?? "not_applicable",
      costStatus:
        resolved.pricingSource === "unavailable"
          ? "unavailable"
          : resolved.pricingSource === "not_applicable"
            ? "not_applicable"
            : "estimated",
      ...(resolved.pricingSource === "unavailable"
        ? { costUnavailableReason: "missing_pricing" }
        : {}),
    },
  };
}

export function inlineShellCapabilitySummary(
  inlineShell: SkillInlineShellConfig["inlineShell"] | undefined,
  shellSandbox: ShellSandboxStatus | undefined,
): CapabilitySkillInlineShellSummary {
  const enabled = inlineShell?.enabled === true;
  return {
    enabled,
    ...(inlineShell?.timeoutMs !== undefined
      ? { timeoutMs: inlineShell.timeoutMs }
      : {}),
    ...(inlineShell?.maxOutputChars !== undefined
      ? { maxOutputChars: inlineShell.maxOutputChars }
      : {}),
    sandboxMode: enabled ? "enforce" : (shellSandbox?.mode ?? "disabled"),
    writePolicy: enabled ? "no-write" : "disabled",
    failClosed: enabled,
  };
}

export function createSkillPreprocessOptions(input: {
  skillConfig?: SkillInlineShellConfig;
  emitter: EventEmitter;
  sandbox: ResolvedShellSandboxConfig;
  workspaceRoot: string;
}): SkillPreprocessOptions | undefined {
  const inlineShell = input.skillConfig?.inlineShell;
  if (inlineShell?.enabled !== true) return undefined;
  return {
    inlineShell: true,
    inlineShellTimeoutMs: inlineShell.timeoutMs,
    maxOutputChars: inlineShell.maxOutputChars,
    inlineShellRunner: createSkillInlineShellRunner({
      emitter: input.emitter,
      sandbox: input.sandbox,
      workspaceRoot: input.workspaceRoot,
    }),
  };
}

export async function readCronJobsForSnapshot(
  rootDir: string,
): Promise<CapabilityAutomationSummary["cron"]["jobs"]> {
  try {
    const store = new CronStore({ rootDir });
    const jobs = await store.listJobs();
    return jobs
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((job) => ({
        id: job.id,
        name: job.name,
        enabled: job.enabled,
        state: job.state,
        schedule: job.scheduleDisplay,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus,
        lastError: job.lastError,
        lastTracePath: job.lastTracePath ?? null,
      }));
  } catch {
    return [];
  }
}

export function readTasksForSnapshot(
  rootDir: string,
): CapabilityAutomationSummary["tasks"]["tasks"] {
  try {
    const store = new FileTaskStore({ rootDir, createRoot: false });
    return store
      .list()
      .sort((a, b) => {
        const aTime = a.completedAt ?? a.lastOutputAt ?? a.createdAt;
        const bTime = b.completedAt ?? b.lastOutputAt ?? b.createdAt;
        return bTime.localeCompare(aTime);
      })
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        status: task.status,
        title: task.title,
        awaited: task.awaited,
        parentRunId: task.parentRunId,
        createdAt: task.createdAt,
        completedAt: task.completedAt,
        outputChunks: task.outputChunks,
        lastOutputAt: task.lastOutputAt,
        error: task.error
          ? { code: task.error.code, message: task.error.message }
          : undefined,
      }));
  } catch {
    return [];
  }
}

export function mergeCapabilitySnapshots(
  configured: CapabilitySnapshot,
  last: CapabilitySnapshot | null,
): CapabilitySnapshot {
  if (!last) return configured;
  return {
    access: configured.access ?? last.access,
    model: configured.model ?? last.model,
    tools: mergeByName(configured.tools, last.tools),
    skills: {
      indexed: mergeByName(configured.skills.indexed, last.skills.indexed),
      loaded: last.skills.loaded,
      inlineShell: last.skills.inlineShell ?? configured.skills.inlineShell,
    },
    mcp: {
      statuses: last.mcp.statuses.length
        ? last.mcp.statuses
        : configured.mcp.statuses,
    },
    agents: {
      profiles: mergeById(configured.agents.profiles, last.agents.profiles),
      delegateTools: mergeByToolName(
        configured.agents.delegateTools,
        last.agents.delegateTools,
      ),
    },
    shell: configured.shell ?? last.shell,
    rules: {
      workflow: mergeWorkflowRules(
        configured.rules?.workflow ?? [],
        last.rules?.workflow ?? [],
      ),
      events: mergeEventRules(
        configured.rules?.events ?? [],
        last.rules?.events ?? [],
      ),
    },
    workflows: configured.workflows ?? last.workflows,
    automation: configured.automation ?? last.automation,
  };
}

export function capabilitySnapshotAgentProfiles(
  mainAgent: AgentProfile,
  profiles: readonly AgentProfile[],
): AgentProfile[] {
  const byId = new Map<string, AgentProfile>();
  byId.set(mainAgent.id, mainAgent);
  for (const profile of profiles) byId.set(profile.id, profile);
  return [...byId.values()];
}

export function summarizeCapabilitySnapshot(
  snapshot: CapabilitySnapshot | null,
): Record<string, unknown> {
  if (!snapshot) {
    return {
      tools: 0,
      skills: { indexed: 0, loaded: 0 },
      mcp: { servers: 0, tools: 0 },
      agents: { profiles: 0, delegateTools: 0 },
      rules: { workflow: 0, events: 0 },
    };
  }
  return {
    ...(snapshot.model
      ? {
          model: {
            modelRef: snapshot.model.modelRef,
            providerKey: snapshot.model.providerKey,
            modelId: snapshot.model.modelId,
            pricing: snapshot.model.pricing,
          },
        }
      : {}),
    tools: snapshot.tools.length,
    toolNames: snapshot.tools.map((tool) => tool.name),
    skills: {
      indexed: snapshot.skills.indexed.length,
      loaded: snapshot.skills.loaded.length,
      indexedNames: snapshot.skills.indexed.map((skill) => skill.name),
      loadedNames: snapshot.skills.loaded.map((skill) => skill.name),
    },
    mcp: {
      servers: snapshot.mcp.statuses.length,
      tools: snapshot.mcp.statuses.reduce(
        (sum, status) => sum + status.toolNames.length,
        0,
      ),
      statuses: snapshot.mcp.statuses.map((status) => ({
        serverName: status.serverName,
        status: status.status,
        toolNames: status.toolNames,
      })),
    },
    agents: {
      profiles: snapshot.agents.profiles.length,
      profileIds: snapshot.agents.profiles.map((profile) => profile.id),
      delegateTools: snapshot.agents.delegateTools.length,
      delegateToolNames: snapshot.agents.delegateTools.map(
        (delegate) => delegate.toolName,
      ),
    },
    rules: {
      workflow: snapshot.rules?.workflow.length ?? 0,
      workflowNames: snapshot.rules?.workflow.map((rule) => rule.name) ?? [],
      events: snapshot.rules?.events?.length ?? 0,
      eventNames: snapshot.rules?.events?.map((rule) => rule.name) ?? [],
    },
    workflows: {
      assets: snapshot.workflows?.assets.length ?? 0,
      names: snapshot.workflows?.assets.map((asset) => asset.assetName) ?? [],
      errors: snapshot.workflows?.errors?.length ?? 0,
    },
    shell: snapshot.shell,
  };
}

function formatToolOrigin(origin: ToolOrigin | undefined): string | undefined {
  if (!origin) return undefined;
  const { kind, name } = origin;
  return typeof name === "string" && name ? `${kind}:${name}` : kind;
}

function mergeByName<T extends { name: string }>(base: T[], next: T[]): T[] {
  const byName = new Map<string, T>();
  for (const entry of base) byName.set(entry.name, entry);
  for (const entry of next) byName.set(entry.name, entry);
  return [...byName.values()];
}

function mergeById<T extends { id: string }>(base: T[], next: T[]): T[] {
  const byId = new Map<string, T>();
  for (const entry of base) byId.set(entry.id, entry);
  for (const entry of next) byId.set(entry.id, entry);
  return [...byId.values()];
}

function mergeByToolName<T extends { toolName: string }>(
  base: T[],
  next: T[],
): T[] {
  const byName = new Map<string, T>();
  for (const entry of base) byName.set(entry.toolName, entry);
  for (const entry of next) byName.set(entry.toolName, entry);
  return [...byName.values()];
}

function mergeWorkflowRules(
  base: CapabilityWorkflowRuleSummary[],
  next: CapabilityWorkflowRuleSummary[],
): CapabilityWorkflowRuleSummary[] {
  const byKey = new Map<string, CapabilityWorkflowRuleSummary>();
  for (const entry of base) byKey.set(workflowRuleKey(entry), entry);
  for (const entry of next) byKey.set(workflowRuleKey(entry), entry);
  return [...byKey.values()];
}

function workflowRuleKey(rule: CapabilityWorkflowRuleSummary): string {
  return `${rule.source}:${rule.lifecycle}:${rule.name}`;
}

function mergeEventRules(
  base: CapabilityEventRuleSummary[],
  next: CapabilityEventRuleSummary[],
): CapabilityEventRuleSummary[] {
  const byKey = new Map<string, CapabilityEventRuleSummary>();
  for (const entry of base) byKey.set(eventRuleKey(entry), entry);
  for (const entry of next) byKey.set(eventRuleKey(entry), entry);
  return [...byKey.values()];
}

function eventRuleKey(rule: CapabilityEventRuleSummary): string {
  return `${rule.source}:${rule.trigger}:${rule.name}`;
}
