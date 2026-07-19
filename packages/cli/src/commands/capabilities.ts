import { compileRunAccessMode, createSessionId } from "@sparkwright/core";
import { defaultCronRoot } from "@sparkwright/cron";
import type {
  CapabilityDelegateToolSummary,
  CapabilitySnapshot,
} from "@sparkwright/protocol";
import {
  DEFAULT_DEFERRED_TOOLS,
  delegateToolName,
  filterDirectDelegatesForExposure,
  loadHostConfig,
  loadLayeredAgentReport,
  loadLayeredSkillReport,
  loadLayeredWorkflowAssets,
  resolveAgentDelegateTools,
  resolveAgentProfiles,
  resolveCapabilityDirs,
  resolveSkillRootsForRuntime,
  runConfiguredDelegate,
  validateRunInput,
  type AgentReport,
  type DelegateCapabilityDescriptor,
  type DelegateToolCollision,
  type HostService,
  type SkillReport,
  type WorkflowAssetReport,
} from "@sparkwright/host";
import { prepareMcpToolsForRun } from "@sparkwright/mcp-adapter";
import { resolveShellSandboxConfig } from "@sparkwright/shell-sandbox";
import { RECOMMENDED_FOREGROUND_TIMEOUT_MS } from "@sparkwright/shell-tool";
import { createCliInteractionChannel } from "../cli-approval.js";
import type { CliIO } from "../io.js";
import { writeLine } from "../io.js";
import type { CliRunAccess } from "../run-access.js";
import { isPlainObject, splitCliWords } from "../parser/values.js";
import type { CliRunResult, ParsedArgs } from "./contracts.js";

interface ToolsConfigShape {
  use?: string[];
  allowed?: string[];
  disabled?: string[];
  defer?: string[];
}

export function formatPatternList(
  values: string[] | undefined,
  emptyLabel: string,
): string {
  return values && values.length > 0 ? values.join(", ") : emptyLabel;
}

export function capabilitiesUsage(): string {
  return "Usage: sparkwright capabilities inspect [--workspace path] [--model provider/model] [--resolve-mcp] [--format json|text]";
}

export function delegatesUsage(): string {
  return [
    'Usage: sparkwright delegates run <external-delegate-tool> "goal" [--workspace path] [--goal text] [--access-mode read-only|ask|accept-edits|bypass] [--session-id id] [--trace-level standard|debug] [--format json|text]',
    "       Supports ACP and external-command delegate tools; internal profiles run through normal run-loop delegation.",
  ].join("\n");
}

interface CapabilityInspectReport {
  workspace: string;
  runtime?: CapabilitySnapshot;
  config: {
    errors: Array<{ file: string; field: string; message: string }>;
  };
  tools: ToolsConfigShape & {
    available: CapabilityToolInspectEntry[];
  };
  shell: {
    foregroundTimeoutMs: number;
    promotionAvailable: boolean;
    sandbox: {
      mode: string;
      failIfUnavailable: boolean;
      runtimeId: string;
      platform: string;
      available: boolean;
      networkMode: string;
      filesystemIsolation: string;
      effective: string;
    };
  };
  skills: SkillReport & {
    inlineShell: SkillInlineShellInspect;
  };
  agents: AgentReport & {
    delegateTools: Array<
      DelegateCapabilityDescriptor | CapabilityDelegateToolSummary
    >;
    delegateToolCollisions: DelegateToolCollision[];
  };
  mcp: {
    servers: Array<{
      name: string;
      type: string;
      enabled: boolean;
      startup?: "lazy" | "prepare" | "eager";
      toolSchemaLoad?: "eager" | "defer";
      status?: string;
      toolCount?: number;
      tools?: Array<{
        toolName: string;
        serverName: string;
        mcpToolName: string;
      }>;
      error?: {
        code?: string;
        phase?: string;
        message: string;
      };
    }>;
    defaultTimeoutMs?: number;
    namePrefix?: string;
    startup?: "lazy" | "prepare" | "eager";
    toolSchemaLoad?: "eager" | "defer";
    resolved?: boolean;
  };
  cron: {
    stateRoot: string;
  };
  command: {
    dirs: Array<{ layer: string; path: string; exists: boolean }>;
  };
  workflows: WorkflowAssetReport;
}

function appendReservedDelegateToolCollisions(input: {
  enabled?: boolean;
  delegates: Array<{ profileId: string; toolName?: string }>;
  collisions: DelegateToolCollision[];
}): void {
  if (input.enabled !== true) return;
  const conflicting = input.delegates.find(
    (delegate) => delegateToolName(delegate) === DELEGATE_PARALLEL_TOOL_NAME,
  );
  if (!conflicting) return;
  input.collisions.push({
    toolName: DELEGATE_PARALLEL_TOOL_NAME,
    profileId: `builtin:${DELEGATE_PARALLEL_TOOL_NAME}`,
    conflictsWith: conflicting.profileId,
    source: "builtin",
  });
}

interface SkillInlineShellInspect {
  enabled: boolean;
  timeoutMs?: number;
  maxOutputChars?: number;
  sandboxMode: string;
  writePolicy: "disabled" | "no-write";
  failClosed: boolean;
}

interface CapabilityToolInspectEntry {
  name: string;
  source: "builtin" | "mcp" | "delegate";
  risk?: "safe" | "risky" | "denied";
  origin?: string;
  canonicalName?: string;
  defaultExposureTier?: string;
  effectiveLoading?: "eager" | "deferred";
  deferred?: boolean;
  relatedTools?: string[];
  requiresTool?: string[];
}

const DELEGATE_PARALLEL_TOOL_NAME = "delegate_parallel";

export async function handleCapabilitiesCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
  hostService: Pick<HostService, "createRuntime">,
): Promise<CliRunResult> {
  if (parsed.subcommand !== "inspect") {
    writeLine(io.stderr, capabilitiesUsage());
    return { exitCode: 1 };
  }

  const validation = await validateRunInput({
    workspaceRoot: parsed.workspaceRoot,
    env,
  });
  for (const error of validation.errors) writeLine(io.stderr, error);
  if (!validation.ok) return { exitCode: 1 };

  try {
    const report = await loadCapabilityInspectReport(
      parsed.workspaceRoot,
      env,
      hostService,
      {
        resolveMcp: parsed.resolveMcp,
        modelName: parsed.modelName,
        runAccess: parsed.runAccess,
      },
    );
    writeLine(
      io.stdout,
      parsed.format === "json"
        ? JSON.stringify(report, null, 2)
        : formatCapabilityInspectReport(report),
    );
    return { exitCode: report.config.errors.length > 0 ? 1 : 0 };
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : String(error),
    );
    return { exitCode: 1 };
  }
}

export async function handleDelegatesCommand(
  parsed: ParsedArgs,
  io: CliIO,
  env: Record<string, string | undefined>,
): Promise<CliRunResult> {
  if (parsed.subcommand !== "run") {
    writeLine(io.stderr, delegatesUsage());
    return { exitCode: 1 };
  }

  const words = splitCliWords(parsed.goal);
  const toolName = words[0];
  const goal = parsed.delegateGoal ?? words.slice(1).join(" ").trim();
  if (!toolName || !goal) {
    writeLine(io.stderr, delegatesUsage());
    return { exitCode: 1 };
  }

  const result = await runConfiguredDelegate({
    workspaceRoot: parsed.workspaceRoot,
    toolName,
    goal,
    env,
    sessionId: parsed.sessionId ?? createSessionId(),
    traceLevel: parsed.traceLevel,
    interactionChannel: createCliInteractionChannel({
      accessMode: parsed.runAccess.accessMode,
      io,
    }),
    shouldWrite: compileRunAccessMode(parsed.runAccess.accessMode).shouldWrite,
  });

  if (!result.ok) {
    writeLine(io.stderr, result.message);
    if (parsed.format === "json") {
      writeLine(io.stdout, JSON.stringify(result, null, 2));
    }
    return { exitCode: 1 };
  }

  writeLine(
    io.stdout,
    parsed.format === "json"
      ? JSON.stringify(result, null, 2)
      : formatDelegateRunResult(result),
  );
  return {
    exitCode: 0,
    tracePath: result.tracePath,
    sessionId: result.sessionId,
  };
}

function formatDelegateRunResult(
  result: Extract<
    Awaited<ReturnType<typeof runConfiguredDelegate>>,
    { ok: true }
  >,
): string {
  const lines = [
    `delegate.completed ${result.toolName} -> ${result.profileId} (${result.protocol})`,
  ];
  if (result.sessionId) {
    lines.push(`sessionId: ${result.sessionId}`);
  }
  if (result.tracePath) {
    lines.push(`trace: ${result.tracePath}`);
  }
  const output = result.output;
  if (isPlainObject(output)) {
    if (typeof output.exitCode === "number") {
      lines.push(`exitCode: ${output.exitCode}`);
    }
    if (typeof output.stopReason === "string") {
      lines.push(`stopReason: ${output.stopReason}`);
    }
    if (typeof output.stdout === "string" && output.stdout.length > 0) {
      lines.push("stdout:", output.stdout.trimEnd());
    }
    if (typeof output.stderr === "string" && output.stderr.length > 0) {
      lines.push("stderr:", output.stderr.trimEnd());
    }
    if (typeof output.message === "string" && output.message.length > 0) {
      lines.push("message:", output.message.trimEnd());
    }
  } else {
    lines.push(JSON.stringify(output, null, 2));
  }
  return lines.join("\n");
}

async function loadCapabilityInspectReport(
  workspaceRoot: string,
  env: Record<string, string | undefined>,
  hostService: Pick<HostService, "createRuntime">,
  options: {
    resolveMcp?: boolean;
    modelName?: string;
    runAccess?: CliRunAccess;
  } = {},
): Promise<CapabilityInspectReport> {
  const loaded = await loadHostConfig(workspaceRoot, env);
  const capabilities = loaded.config.capabilities;
  const skillRoots = resolveSkillRootsForRuntime(
    workspaceRoot,
    capabilities?.skills?.roots,
    env,
  );
  const shellSandboxConfig = resolveShellSandboxConfig({
    workspaceRoot,
    config: loaded.config.shell?.sandbox,
    skillRoots: skillRoots.map((root) => root.root),
    extraForcedDenyWrite: loaded.attempted.map((entry) => entry.path),
  });
  const skills = await loadLayeredSkillReport(skillRoots, {
    includeMissingRoots: "configured",
  });
  const agents = await loadLayeredAgentReport(
    workspaceRoot,
    capabilities?.agents?.profiles,
    env,
  );
  const profiles = await resolveAgentProfiles(
    workspaceRoot,
    capabilities?.agents?.profiles,
  );

  const commandDirs = await Promise.all(
    resolveCapabilityDirs("command", { cwd: workspaceRoot, env }).map(
      async (dir) => ({
        layer: dir.layer,
        path: dir.dir,
        exists: await pathExists(dir.dir),
      }),
    ),
  );
  const workflows = await loadLayeredWorkflowAssets(workspaceRoot, env);

  const mcpServers: CapabilityInspectReport["mcp"]["servers"] = (
    capabilities?.mcp?.servers ?? []
  ).map((server) => ({
    name: server.name,
    type: server.type,
    enabled: server.enabled !== false,
    startup: capabilities?.mcp?.startup ?? "lazy",
    toolSchemaLoad:
      server.toolSchemaLoad ?? capabilities?.mcp?.toolSchemaLoad ?? "defer",
  }));

  if (options.resolveMcp && capabilities?.mcp?.servers?.length) {
    const prepared = await prepareMcpToolsForRun({
      servers: capabilities.mcp.servers,
      defaultTimeoutMs: capabilities.mcp.defaultTimeoutMs,
      namePrefix: capabilities.mcp.namePrefix,
      toolSchemaLoad: capabilities.mcp.toolSchemaLoad,
      policy: capabilities.mcp.defaultPolicy,
      shellSandbox: shellSandboxConfig,
    });
    try {
      for (const server of mcpServers) {
        const status = prepared.statuses[server.name];
        if (!status) continue;
        const tools = prepared.toolNameMap.filter(
          (tool) => tool.serverName === server.name,
        );
        server.status = status.status;
        server.toolCount = tools.length;
        server.tools = tools;
        if (status.status === "failed") {
          server.error = {
            message: status.error,
            ...(status.errorCode ? { code: status.errorCode } : {}),
            ...(status.phase ? { phase: status.phase } : {}),
          };
        }
      }
    } finally {
      await prepared.close();
    }
  }

  const delegateToolCollisions: DelegateToolCollision[] = [];
  const delegationTargets = resolveAgentDelegateTools(
    profiles,
    capabilities?.agents?.delegateTools,
    {
      includeAllChildProfiles: true,
      onCollision: (collision) => delegateToolCollisions.push(collision),
    },
  );
  const directDelegates = filterDirectDelegatesForExposure(
    delegationTargets,
    capabilities?.agents,
    profiles,
  );
  appendReservedDelegateToolCollisions({
    enabled: capabilities?.agents?.enableParallelDelegates,
    delegates: directDelegates,
    collisions: delegateToolCollisions,
  });
  const runtime = await inspectRuntimeCapabilities(workspaceRoot, hostService, {
    modelName: options.modelName,
    runAccess: options.runAccess,
  });
  if (!runtime.shell) {
    throw new Error("Host capability inspection did not return shell status.");
  }
  const delegateDescriptors = runtime.agents.delegateTools;

  return {
    workspace: workspaceRoot,
    runtime,
    config: { errors: loaded.errors },
    tools: {
      ...(loaded.config.tools ?? {}),
      available: buildCapabilityToolInventory({
        runtime,
        delegateTools: delegateDescriptors,
      }),
    },
    shell: {
      foregroundTimeoutMs:
        runtime.shell.foregroundTimeoutMs ??
        loaded.config.shell?.foregroundTimeoutMs ??
        RECOMMENDED_FOREGROUND_TIMEOUT_MS,
      promotionAvailable: runtime.shell.promotionAvailable ?? true,
      sandbox: {
        ...runtime.shell.sandbox,
        effective: shellSandboxEffective(runtime.shell.sandbox),
      },
    },
    skills: {
      ...skills,
      inlineShell: buildSkillInlineShellInspect(
        capabilities?.skills?.inlineShell,
      ),
    },
    agents: {
      ...agents,
      delegateTools: delegateDescriptors,
      delegateToolCollisions,
    },
    mcp: {
      servers: mcpServers,
      defaultTimeoutMs: capabilities?.mcp?.defaultTimeoutMs,
      namePrefix: capabilities?.mcp?.namePrefix,
      startup: capabilities?.mcp?.startup,
      toolSchemaLoad: capabilities?.mcp?.toolSchemaLoad,
      resolved: options.resolveMcp || undefined,
    },
    cron: {
      stateRoot: defaultCronRoot(env),
    },
    command: { dirs: commandDirs },
    workflows,
  };
}

async function inspectRuntimeCapabilities(
  workspaceRoot: string,
  hostService: Pick<HostService, "createRuntime">,
  options: { modelName?: string; runAccess?: CliRunAccess } = {},
): Promise<CapabilitySnapshot> {
  const runtime = hostService.createRuntime({
    workspaceRoot,
    defaultModel: options.modelName,
    emit: () => {},
  });
  const inspected = await runtime.inspectCapabilities({
    model: options.modelName,
    accessMode: options.runAccess?.accessMode,
    backgroundTasks: options.runAccess?.backgroundTasks,
  });
  if (!inspected.ok) {
    throw new Error(
      `Host capability inspection failed: ${inspected.error.message}`,
    );
  }
  return inspected.snapshot;
}

function shellSandboxEffective(input: {
  mode: string;
  failIfUnavailable: boolean;
  available: boolean;
}): string {
  if (input.mode === "off") return "off";
  if (input.available) return "on";
  return input.failIfUnavailable ? "enforce-unavailable" : "fallback";
}

function buildSkillInlineShellInspect(
  inlineShell:
    | {
        enabled?: boolean;
        timeoutMs?: number;
        maxOutputChars?: number;
      }
    | undefined,
): SkillInlineShellInspect {
  const enabled = inlineShell?.enabled === true;
  return {
    enabled,
    ...(inlineShell?.timeoutMs !== undefined
      ? { timeoutMs: inlineShell.timeoutMs }
      : {}),
    ...(inlineShell?.maxOutputChars !== undefined
      ? { maxOutputChars: inlineShell.maxOutputChars }
      : {}),
    sandboxMode: enabled ? "enforce" : "disabled",
    writePolicy: enabled ? "no-write" : "disabled",
    failClosed: enabled,
  };
}

function buildCapabilityToolInventory(input: {
  runtime: CapabilitySnapshot;
  delegateTools: Array<
    DelegateCapabilityDescriptor | CapabilityDelegateToolSummary
  >;
}): CapabilityToolInspectEntry[] {
  const delegateByName = new Map(
    input.delegateTools.map((tool) => [tool.toolName, tool]),
  );
  return input.runtime.tools
    .map((tool) =>
      runtimeToolToInspectEntry({
        tool,
        delegateByName,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

function runtimeToolToInspectEntry(input: {
  tool: CapabilitySnapshot["tools"][number];
  delegateByName: Map<
    string,
    DelegateCapabilityDescriptor | CapabilityDelegateToolSummary
  >;
}): CapabilityToolInspectEntry {
  const delegate = input.delegateByName.get(input.tool.name);
  if (delegate) {
    return {
      name: input.tool.name,
      source: "delegate",
      risk: delegate.risk,
      origin: `${delegate.protocol}:${delegate.profileId}`,
      ...(input.tool.canonicalName
        ? { canonicalName: input.tool.canonicalName }
        : {}),
      ...(input.tool.defaultExposureTier
        ? { defaultExposureTier: input.tool.defaultExposureTier }
        : {}),
      ...(input.tool.effectiveLoading
        ? { effectiveLoading: input.tool.effectiveLoading }
        : {}),
      ...(input.tool.deferred === true ? { deferred: true } : {}),
      ...(input.tool.relatedTools
        ? { relatedTools: input.tool.relatedTools }
        : {}),
      ...(input.tool.requiresTool
        ? { requiresTool: input.tool.requiresTool }
        : {}),
    };
  }

  const source =
    input.tool.source === "mcp" || input.tool.origin?.startsWith("mcp:")
      ? "mcp"
      : "builtin";
  return {
    name: input.tool.name,
    source,
    ...(input.tool.risk === "safe" ||
    input.tool.risk === "risky" ||
    input.tool.risk === "denied"
      ? { risk: input.tool.risk }
      : {}),
    ...(input.tool.origin ? { origin: input.tool.origin } : {}),
    ...(input.tool.canonicalName
      ? { canonicalName: input.tool.canonicalName }
      : {}),
    ...(input.tool.defaultExposureTier
      ? { defaultExposureTier: input.tool.defaultExposureTier }
      : {}),
    ...(input.tool.effectiveLoading
      ? { effectiveLoading: input.tool.effectiveLoading }
      : {}),
    ...(input.tool.deferred === true ? { deferred: true } : {}),
    ...(input.tool.relatedTools
      ? { relatedTools: input.tool.relatedTools }
      : {}),
    ...(input.tool.requiresTool
      ? { requiresTool: input.tool.requiresTool }
      : {}),
  };
}

export const PROJECT_CONFIG_DEFERRED_TOOLS = [...DEFAULT_DEFERRED_TOOLS];

async function pathExists(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function formatCapabilityInspectReport(
  report: CapabilityInspectReport,
): string {
  const lines = [
    `workspace: ${report.workspace}`,
    `model: ${formatCapabilityModelLine(report.runtime?.model)}`,
    `runtime access: ${formatCapabilityAccessLine(report.runtime?.access)}`,
    `tools: use=${formatPatternList(report.tools.use, "(all)")}; allowed=${formatPatternList(report.tools.allowed, "(all)")}; disabled=${formatPatternList(report.tools.disabled, "(none)")}; defer=${formatPatternList(report.tools.defer, "(none)")}`,
    `shell foreground: timeoutMs=${report.shell.foregroundTimeoutMs}; promotionAvailable=${String(report.shell.promotionAvailable)}`,
    `shell sandbox: mode=${report.shell.sandbox.mode}; effective=${report.shell.sandbox.effective}; runtime=${report.shell.sandbox.runtimeId}; available=${String(report.shell.sandbox.available)}; network=${report.shell.sandbox.networkMode}; fs=${report.shell.sandbox.filesystemIsolation}`,
    `runtime tools: ${report.runtime?.tools.length ?? "unavailable"}`,
    `diagnostic tools: ${report.tools.available.length}`,
    `skills: ${report.skills.skills.length} effective, ${report.skills.roots.length} roots, ${report.skills.shadows.length} shadows, ${report.skills.errors.length} errors`,
    `skill inline shell: enabled=${String(report.skills.inlineShell.enabled)}; writePolicy=${report.skills.inlineShell.writePolicy}; sandbox=${report.skills.inlineShell.sandboxMode}; failClosed=${String(report.skills.inlineShell.failClosed)}${report.skills.inlineShell.timeoutMs !== undefined ? `; timeoutMs=${report.skills.inlineShell.timeoutMs}` : ""}${report.skills.inlineShell.maxOutputChars !== undefined ? `; maxOutputChars=${report.skills.inlineShell.maxOutputChars}` : ""}`,
    `workflows: ${report.workflows.assets.length} assets, ${report.workflows.roots.length} roots, ${report.workflows.shadows.length} shadows, ${report.workflows.errors.length} errors`,
  ];
  for (const workflow of report.workflows.assets) {
    lines.push(
      `  workflow: ${workflow.assetName}${workflow.version ? ` version=${workflow.version}` : ""} nodes=${workflow.nodeCount} layer=${workflow.layer} source=${workflow.sourcePath}`,
    );
  }
  const workflowRules = report.runtime?.rules?.workflow ?? [];
  const eventRules = report.runtime?.rules?.events ?? [];
  lines.push(`workflow rules: ${workflowRules.length}`);
  for (const rule of workflowRules) {
    lines.push(
      `  rule: ${rule.name} [${rule.source}] ${rule.lifecycle} ${rule.status}; canBlock=${String(rule.blockingPotential)}; matcher=${rule.matcher}; action=${rule.action}`,
    );
    const hints = [rule.configurationHint, rule.disableHint].filter(
      (hint): hint is string => typeof hint === "string" && hint.length > 0,
    );
    if (hints.length > 0) {
      lines.push(`    hint: ${hints.join(" ")}`);
    }
  }
  lines.push(`event rules: ${eventRules.length}`);
  for (const rule of eventRules) {
    lines.push(
      `  event rule: ${rule.name} [${rule.source}] ${rule.trigger} ${rule.status}; canBlock=false; matcher=${rule.matcher}; action=${rule.action}`,
    );
    const hints = [rule.configurationHint, rule.disableHint].filter(
      (hint): hint is string => typeof hint === "string" && hint.length > 0,
    );
    if (hints.length > 0) {
      lines.push(`    hint: ${hints.join(" ")}`);
    }
  }
  for (const tool of report.runtime?.tools ?? []) {
    const loading =
      tool.effectiveLoading ?? (tool.deferred ? "deferred" : "eager");
    const tier = tool.defaultExposureTier
      ? `; tier=${tool.defaultExposureTier}`
      : "";
    lines.push(
      `  tool: ${tool.name}${tool.risk ? ` (${tool.risk}; loading=${loading}${tier})` : ` (loading=${loading}${tier})`}${tool.origin ? ` ${tool.origin}` : ""}`,
    );
  }
  for (const tool of report.tools.available) {
    const loading =
      tool.effectiveLoading ?? (tool.deferred ? "deferred" : "eager");
    const tier = tool.defaultExposureTier
      ? `; tier=${tool.defaultExposureTier}`
      : "";
    lines.push(
      `  diagnostic tool: ${tool.name}${tool.risk ? ` (${tool.risk}; loading=${loading}${tier})` : ` (loading=${loading}${tier})`}${tool.origin ? ` ${tool.origin}` : ""}`,
    );
  }
  for (const root of report.skills.roots) lines.push(`  root: ${root}`);
  for (const skill of report.skills.skills) {
    lines.push(`  - ${skill.name}${skill.layer ? ` (${skill.layer})` : ""}`);
  }
  if (report.skills.errors.length > 0) {
    lines.push(`skill errors: ${report.skills.errors.length}`);
    for (const error of report.skills.errors) {
      lines.push(`  - ${error.source}: ${error.message}`);
    }
  }
  const agentCollisionCount =
    report.agents.collisions.length +
    report.agents.delegateToolCollisions.length;
  lines.push(
    `agents: ${report.agents.profiles.length} effective, ${report.agents.roots.length} roots, ${report.agents.shadows.length} shadows, ${agentCollisionCount} collisions, ${report.agents.errors.length} errors, ${report.agents.delegateTools.length} delegate tools`,
  );
  for (const agent of report.agents.profiles) {
    lines.push(
      `  - ${agent.id}${agent.name ? ` (${agent.name})` : ""}: ${agent.layer}`,
    );
  }
  for (const tool of report.agents.delegateTools) {
    const writeGate = tool.gatedByRunWrite ? "; gated=write-access" : "";
    const model = tool.model ? `; model=${tool.model}` : "";
    const routing = formatDelegateRouting(tool.routing);
    lines.push(
      `  delegate: ${tool.toolName} -> ${tool.profileId} (${tool.protocol}${model}${routing}; approval=current-run:${tool.approvalRequiredUnderCurrentRun ? "required" : "not-required"}; workspace=${tool.workspaceAccess}${writeGate})`,
    );
  }
  if (report.agents.shadows.length > 0) {
    lines.push(`agent shadows: ${report.agents.shadows.length}`);
    for (const shadow of report.agents.shadows) {
      lines.push(
        `  - ${shadow.id}: ${formatAgentOrigin(
          shadow.shadowed,
        )} shadowed by ${formatAgentOrigin(shadow.shadowedBy)}`,
      );
    }
  }
  if (report.agents.collisions.length > 0) {
    lines.push(`agent id collisions: ${report.agents.collisions.length}`);
    for (const collision of report.agents.collisions) {
      lines.push(
        `  - ${collision.id}: kept ${formatAgentOrigin(
          collision.kept,
        )}, dropped ${formatAgentOrigin(collision.dropped)} (fail-closed)`,
      );
    }
  }
  if (report.agents.delegateToolCollisions.length > 0) {
    lines.push(
      `delegate tool collisions: ${report.agents.delegateToolCollisions.length}`,
    );
    for (const collision of report.agents.delegateToolCollisions) {
      lines.push(
        `  - ${collision.toolName}: ${collision.profileId} (${collision.source}) dropped; owned by ${collision.conflictsWith} (fail-closed)`,
      );
    }
  }
  lines.push(`mcp: ${report.mcp.servers.length} servers`);
  for (const server of report.mcp.servers) {
    lines.push(
      `  - ${server.name}: ${server.type}${server.enabled ? "" : " disabled"} startup=${server.startup ?? report.mcp.startup ?? "lazy"} schema=${server.toolSchemaLoad ?? report.mcp.toolSchemaLoad ?? "defer"}${server.status ? ` ${server.status}` : ""}${server.toolCount !== undefined ? ` tools=${server.toolCount}` : ""}`,
    );
    if (server.error) {
      const code = server.error.code ? `${server.error.code}: ` : "";
      const phase = server.error.phase ? ` (${server.error.phase})` : "";
      lines.push(`    error: ${code}${server.error.message}${phase}`);
    }
    for (const tool of server.tools ?? []) {
      lines.push(`    tool: ${tool.toolName} -> ${tool.mcpToolName}`);
    }
  }
  lines.push(`cron state: ${report.cron.stateRoot}`);
  lines.push("command dirs:");
  for (const dir of report.command.dirs) {
    lines.push(
      `  - ${dir.layer}: ${dir.path}${dir.exists ? "" : " (optional, missing)"}`,
    );
  }
  if (report.config.errors.length > 0) {
    lines.push(`config errors: ${report.config.errors.length}`);
    for (const error of report.config.errors) {
      lines.push(`  - ${error.file}: ${error.field}: ${error.message}`);
    }
  }
  return lines.join("\n");
}

function formatCapabilityAccessLine(
  access: CapabilitySnapshot["access"] | undefined,
): string {
  if (!access) return "unavailable";
  const parts = [
    `accessMode=${access.accessMode}`,
    `backgroundTasks=${access.backgroundTasks}`,
    access.requestedAccessMode
      ? `requestedAccessMode=${access.requestedAccessMode}`
      : undefined,
    access.accessModeCeiling
      ? `accessModeCeiling=${access.accessModeCeiling}`
      : undefined,
    access.requestedBackgroundTasks
      ? `requestedBackgroundTasks=${access.requestedBackgroundTasks}`
      : undefined,
    access.backgroundTasksCeiling
      ? `backgroundTasksCeiling=${access.backgroundTasksCeiling}`
      : undefined,
  ].filter((part): part is string => typeof part === "string");
  return parts.join("; ");
}

function formatCapabilityModelLine(
  model: CapabilitySnapshot["model"] | undefined,
): string {
  if (!model) return "unavailable";
  const pricing = model.pricing;
  const suffix =
    pricing.costStatus === "unavailable"
      ? `; pricing=unavailable:${pricing.costUnavailableReason ?? "unknown"}`
      : `; pricing=${pricing.source}`;
  return `${model.modelRef}${suffix}`;
}

function formatDelegateRouting(
  routing:
    | CapabilitySnapshot["agents"]["delegateTools"][number]["routing"]
    | undefined,
): string {
  if (!routing) return "";
  if (routing.relevance) {
    const score =
      typeof routing.score === "number" ? ` score=${routing.score}` : "";
    const matched =
      routing.matchedKeywords && routing.matchedKeywords.length > 0
        ? ` matched=${routing.matchedKeywords.join(",")}`
        : "";
    return `; routing=${routing.relevance}${score}${matched}`;
  }
  return routing.keywords.length > 0
    ? `; triggers=${routing.keywords.join(",")}`
    : "";
}

export function formatAgentOrigin(agent: {
  layer?: string;
  source?: string;
  root?: string;
}): string {
  return `${agent.layer ?? "unknown"}:${agent.source ?? agent.root ?? "config"}`;
}
