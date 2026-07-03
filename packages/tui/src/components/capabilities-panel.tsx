import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { CapabilitySnapshot } from "@sparkwright/protocol";
import { useTheme } from "../lib/theme-context.js";
import type { CapabilityView } from "../lib/layer-payload.js";
import { formatWorkspaceDisplayPath } from "../lib/path-display.js";
import { DialogFrame } from "./dialog-frame.js";

type CapabilityRules = NonNullable<CapabilitySnapshot["rules"]>;

export function CapabilitiesPanel(props: {
  snapshot: CapabilitySnapshot | null;
  loading: boolean;
  view: CapabilityView;
  workspaceRoot?: string;
  onClose: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  const [scroll, setScroll] = useState(0);

  const snapshot = props.snapshot;
  const tools = snapshot?.tools ?? [];
  const model = snapshot?.model;
  const indexedSkills = snapshot?.skills.indexed ?? [];
  const loadedSkills = snapshot?.skills.loaded ?? [];
  const mcpServers = snapshot?.mcp.statuses ?? [];
  const agents = configuredAgentProfiles(snapshot?.agents.profiles ?? []);
  const delegateTools = snapshot?.agents.delegateTools ?? [];
  const workflowRules = snapshot?.rules?.workflow ?? [];
  const eventRules = snapshot?.rules?.events ?? [];
  const cronTools = tools.filter((tool) =>
    tool.name.toLowerCase().includes("cron"),
  );
  const rows = snapshot
    ? capabilityRows({
        view: props.view,
        model,
        tools,
        indexedSkills,
        loadedSkills,
        agents,
        delegateTools,
        mcpServers,
        cronTools,
        workflowRules,
        eventRules,
        automation: snapshot.automation,
        workspaceRoot: props.workspaceRoot,
        theme: {
          accent: theme.accent,
          error: theme.error,
          muted: theme.muted,
          success: theme.success,
          warning: theme.warning,
        },
      })
    : [];
  const viewport = Math.max(6, (stdout?.rows ?? 30) - 10);
  const maxScroll = Math.max(0, rows.length - viewport);
  const clamped = Math.min(scroll, maxScroll);
  const visible = rows.slice(clamped, clamped + viewport);
  const more = rows.length - (clamped + visible.length);

  useEffect(() => {
    setScroll(0);
  }, [props.view, snapshot]);

  useInput((input, key) => {
    if (key.escape || key.return) return props.onClose();
    if (key.downArrow || input === "j")
      setScroll((value) => Math.min(maxScroll, value + 1));
    else if (key.upArrow || input === "k")
      setScroll((value) => Math.max(0, value - 1));
    else if (key.pageDown || input === "d")
      setScroll((value) => Math.min(maxScroll, value + viewport));
    else if (key.pageUp || input === "u")
      setScroll((value) => Math.max(0, value - viewport));
    else if (input === "g") setScroll(0);
    else if (input === "G") setScroll(maxScroll);
  });

  return (
    <DialogFrame borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        {capabilityPanelTitle(props.view)}
        <Text color={theme.muted}>
          {" "}
          available to this run · esc/enter close
        </Text>
      </Text>
      {props.loading ? <Text color={theme.muted}>loading…</Text> : null}
      {!props.loading && !snapshot ? (
        <Text color={theme.muted}>no snapshot available</Text>
      ) : null}
      {snapshot ? (
        <Box flexDirection="column" marginTop={1}>
          {visible}
          <Box marginTop={1}>
            <Text color={theme.muted}>{footerText(maxScroll > 0, more)}</Text>
          </Box>
        </Box>
      ) : null}
    </DialogFrame>
  );
}

function configuredAgentProfiles(
  profiles: CapabilitySnapshot["agents"]["profiles"],
): CapabilitySnapshot["agents"]["profiles"] {
  return profiles.filter(
    (profile) => !(profile.id === "main" && profile.mode === "primary"),
  );
}

function footerText(scrollable: boolean, more: number): string {
  if (!scrollable) return "esc close";
  return `esc close · ↑/↓ j/k scroll · u/d page${
    more > 0 ? ` · ${more} more ↓` : " · end"
  }`;
}

function capabilityRows(input: {
  view: CapabilityView;
  model?: CapabilitySnapshot["model"];
  theme: CapabilityRowTheme;
  tools: CapabilitySnapshot["tools"];
  indexedSkills: CapabilitySnapshot["skills"]["indexed"];
  loadedSkills: CapabilitySnapshot["skills"]["loaded"];
  agents: CapabilitySnapshot["agents"]["profiles"];
  delegateTools: CapabilitySnapshot["agents"]["delegateTools"];
  mcpServers: CapabilitySnapshot["mcp"]["statuses"];
  cronTools: CapabilitySnapshot["tools"];
  workflowRules: CapabilityRules["workflow"];
  eventRules: NonNullable<CapabilityRules["events"]>;
  automation?: CapabilitySnapshot["automation"];
  workspaceRoot?: string;
}): React.ReactElement[] {
  const rows: React.ReactElement[] = [];
  addOverviewRows(rows, input);
  if (input.view === "all" || input.view === "tools") {
    addToolsRows(rows, input.tools, input.theme);
  }
  if (input.view === "all" || input.view === "skills") {
    addSkillsRows(
      rows,
      input.indexedSkills,
      input.loadedSkills,
      input.theme,
      input.workspaceRoot,
    );
  }
  if (input.view === "all" || input.view === "agents") {
    addAgentsRows(rows, input.agents, input.delegateTools, input.theme);
  }
  if (input.view === "all" || input.view === "mcp") {
    addMcpRows(rows, input.mcpServers, input.theme);
  }
  if (input.view === "all") {
    addWorkflowRuleRows(rows, input.workflowRules, input.theme);
    addEventRuleRows(rows, input.eventRules, input.theme);
  }
  if (input.view === "cron") {
    addCronRows(rows, input.cronTools, input.automation, input.theme);
  }
  return rows;
}

interface CapabilityRowTheme {
  accent: string;
  error: string;
  muted: string;
  success: string;
  warning: string;
}

function capabilityPanelTitle(view: CapabilityView): string {
  switch (view) {
    case "tools":
      return "tools";
    case "skills":
      return "skills";
    case "agents":
      return "agents";
    case "mcp":
      return "mcp";
    case "cron":
      return "cron";
    case "all":
    default:
      return "capabilities";
  }
}

function addOverviewRows(
  rows: React.ReactElement[],
  props: {
    theme: CapabilityRowTheme;
    model?: CapabilitySnapshot["model"];
    tools: CapabilitySnapshot["tools"];
    indexedSkills: CapabilitySnapshot["skills"]["indexed"];
    loadedSkills: CapabilitySnapshot["skills"]["loaded"];
    agents: CapabilitySnapshot["agents"]["profiles"];
    delegateTools: CapabilitySnapshot["agents"]["delegateTools"];
    mcpServers: CapabilitySnapshot["mcp"]["statuses"];
    cronTools: CapabilitySnapshot["tools"];
    workflowRules: CapabilityRules["workflow"];
    eventRules: NonNullable<CapabilityRules["events"]>;
    automation?: CapabilitySnapshot["automation"];
  },
): void {
  const unloadedSkills = Math.max(
    0,
    props.indexedSkills.length - props.loadedSkills.length,
  );
  const toolGroups = groupTools(props.tools);
  rows.push(
    <Text key="overview-available">
      <Text color={props.theme.success}>Available now: </Text>
      {props.tools.length} tools, {props.loadedSkills.length} loaded Skills,{" "}
      {props.agents.length} agents, {props.delegateTools.length} delegates,{" "}
      {props.mcpServers.length} MCP servers, {props.workflowRules.length}{" "}
      workflow rules, {props.eventRules.length} event rules
    </Text>,
    ...(props.model
      ? [
          <Text
            key="overview-model"
            color={
              props.model.pricing.costStatus === "unavailable"
                ? props.theme.warning
                : props.theme.muted
            }
          >
            Model: {props.model.modelRef}; pricing{" "}
            {props.model.pricing.costStatus === "unavailable"
              ? `unavailable (${props.model.pricing.costUnavailableReason ?? "unknown"})`
              : props.model.pricing.source}
          </Text>,
        ]
      : []),
    <Text key="overview-tool-map" color={props.theme.muted}>
      Tool map: {toolGroups.publicTools.length} public,{" "}
      {toolGroups.deferred.length} on demand, {toolGroups.infrastructure.length}{" "}
      infrastructure, {toolGroups.highRiskTotal} approval/high-risk.
    </Text>,
    <Text key="overview-skills" color={props.theme.muted}>
      Indexed Skills are discoverable examples; loaded Skills were selected for
      the current run context.
    </Text>,
  );
  if (unloadedSkills > 0) {
    rows.push(
      <Text key="overview-unloaded" color={props.theme.muted}>
        {unloadedSkills} more Skill{unloadedSkills === 1 ? "" : "s"} can be
        loaded when relevant.
      </Text>,
    );
  }
  if (props.cronTools.length > 0) {
    rows.push(
      <Text key="overview-cron" color={props.theme.muted}>
        Cron support is present through {props.cronTools.length} prepared tool
        {props.cronTools.length === 1 ? "" : "s"}.
      </Text>,
    );
  }
  if (props.automation) {
    rows.push(
      <Text key="overview-automation" color={props.theme.muted}>
        Automation state: {props.automation.cron.total} cron job
        {props.automation.cron.total === 1 ? "" : "s"},{" "}
        {props.automation.tasks.total} background task
        {props.automation.tasks.total === 1 ? "" : "s"}.
      </Text>,
    );
  }
}

function addToolsRows(
  rows: React.ReactElement[],
  tools: CapabilitySnapshot["tools"],
  theme: CapabilityRowTheme,
): void {
  const groups = groupTools(tools);
  addToolGroupRows(rows, "public tools", groups.publicTools, theme, {
    empty: "no public tools reported",
    limit: 16,
  });
  addToolGroupRows(rows, "deferred via tool_search", groups.deferred, theme, {
    empty: "no deferred tools reported",
    limit: 16,
    prefix: "deferred ",
  });
  addToolGroupRows(rows, "approval / high risk", groups.risky, theme, {
    empty: "no high-risk tools reported",
    limit: 16,
    prefix: "check ",
  });
  addToolGroupRows(
    rows,
    "discovery infrastructure",
    groups.infrastructure,
    theme,
    {
      empty: "no discovery infrastructure reported",
      limit: 8,
    },
  );
  addToolSourceRows(rows, groups.sourceCounts, theme);
}

function addToolGroupRows(
  rows: React.ReactElement[],
  title: string,
  tools: CapabilitySnapshot["tools"],
  theme: CapabilityRowTheme,
  options: { empty: string; limit: number; prefix?: string },
): void {
  pushSectionHeader(
    rows,
    `${title} (${tools.length})`,
    options.empty,
    tools.length,
  );
  for (const tool of tools.slice(0, options.limit)) {
    const hint = skillToolHint(tool.name);
    rows.push(
      <Text key={`${title}:tool:${tool.name}`}>
        <Text color={theme.success}>• </Text>
        {options.prefix ? (
          <Text color={theme.muted}>{options.prefix}</Text>
        ) : null}
        {tool.name}
        {tool.risk ? <Text color={theme.muted}> · {tool.risk}</Text> : null}
        {tool.defaultExposureTier ? (
          <Text color={theme.muted}> · {tool.defaultExposureTier}</Text>
        ) : null}
        {isDeferredTool(tool) ? (
          <Text color={theme.muted}> · load on demand</Text>
        ) : null}
        {tool.legacyNames && tool.legacyNames.length > 0 ? (
          <Text color={theme.muted}>
            {" "}
            · legacy {tool.legacyNames.join(",")}
          </Text>
        ) : null}
        {tool.origin ? <Text color={theme.muted}> · {tool.origin}</Text> : null}
      </Text>,
    );
    if (hint) {
      rows.push(
        <Text key={`${title}:tool-hint:${tool.name}`} color={theme.muted}>
          {"  " + hint}
        </Text>,
      );
    }
  }
  if (tools.length > options.limit) {
    rows.push(
      <Text key={`${title}:more`} color={theme.muted}>
        … {tools.length - options.limit} more
      </Text>,
    );
  }
}

function addToolSourceRows(
  rows: React.ReactElement[],
  sourceCounts: Array<{ source: string; count: number }>,
  theme: CapabilityRowTheme,
): void {
  pushSectionHeader(
    rows,
    `tool sources (${sourceCounts.length})`,
    "no tool sources reported",
    sourceCounts.length,
  );
  for (const source of sourceCounts) {
    rows.push(
      <Text key={`tool-source:${source.source}`}>
        <Text color={theme.success}>• </Text>
        {source.source}
        <Text color={theme.muted}> · {source.count} tools</Text>
      </Text>,
    );
  }
}

function groupTools(tools: CapabilitySnapshot["tools"]): {
  publicTools: CapabilitySnapshot["tools"];
  deferred: CapabilitySnapshot["tools"];
  risky: CapabilitySnapshot["tools"];
  infrastructure: CapabilitySnapshot["tools"];
  highRiskTotal: number;
  sourceCounts: Array<{ source: string; count: number }>;
} {
  const publicTools = tools.filter(
    (tool) => exposureTier(tool) === "public" && !isDeferredTool(tool),
  );
  const deferred = tools.filter(
    (tool) => isDeferredTool(tool) && exposureTier(tool) !== "infrastructure",
  );
  const risky = tools.filter(
    (tool) => tool.risk === "risky" && !isDeferredTool(tool),
  );
  const infrastructure = tools.filter(
    (tool) => exposureTier(tool) === "infrastructure",
  );
  const highRiskTotal = tools.filter((tool) => tool.risk === "risky").length;
  const sourceCounts = new Map<string, number>();
  for (const tool of tools) {
    const source = tool.source ?? toolSourceLabel(tool.origin);
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }
  return {
    publicTools,
    deferred,
    risky,
    infrastructure,
    highRiskTotal,
    sourceCounts: [...sourceCounts]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
  };
}

function isDeferredTool(tool: CapabilitySnapshot["tools"][number]): boolean {
  return tool.effectiveLoading === "deferred" || tool.deferred === true;
}

function exposureTier(
  tool: CapabilitySnapshot["tools"][number],
): NonNullable<CapabilitySnapshot["tools"][number]["defaultExposureTier"]> {
  if (tool.defaultExposureTier) return tool.defaultExposureTier;
  if (tool.name === "tool_search" || tool.name === "skill_load") {
    return "infrastructure";
  }
  return isDeferredTool(tool) ? "advanced" : "public";
}

function toolSourceLabel(origin: string | undefined): string {
  if (!origin) return "unspecified";
  if (origin.startsWith("mcp:")) return "MCP";
  if (origin.startsWith("local:@sparkwright/coding-tools")) {
    return "coding tools";
  }
  if (origin.startsWith("local:sparkwright")) return "SparkWright";
  if (origin.startsWith("local:@sparkwright/shell-tool")) return "shell";
  if (origin.startsWith("local:@sparkwright/core")) return "core";
  return origin;
}

function skillToolHint(name: string): string {
  switch (name) {
    case "list_skills":
      return "managed Skill inventory; shows built-in, user, and project packages";
    case "create_skill":
      return "managed Skill evolution; draft create proposal first, apply only when requested";
    case "update_skill":
      return "managed Skill evolution; draft proposal first, apply only when requested";
    default:
      return "";
  }
}

function addSkillsRows(
  rows: React.ReactElement[],
  indexed: CapabilitySnapshot["skills"]["indexed"],
  loaded: CapabilitySnapshot["skills"]["loaded"],
  theme: CapabilityRowTheme,
  workspaceRoot?: string,
): void {
  pushSectionHeader(
    rows,
    `skills (${loaded.length} loaded / ${indexed.length} indexed)`,
    "no skills reported",
    loaded.length + indexed.length,
  );
  for (const skill of loaded) {
    rows.push(
      <Text key={`loaded:${skill.name}`}>
        <Text color={theme.success}>loaded </Text>
        {skill.name}
        {skill.selectionReason ? (
          <Text color={theme.muted}> · {skill.selectionReason}</Text>
        ) : null}
      </Text>,
    );
  }
  if (loaded.length === 0) {
    for (const skill of indexed.slice(0, 16)) {
      rows.push(
        <Text key={`indexed:${skill.name}`}>
          <Text color={theme.muted}>indexed </Text>
          {skill.name}
          {skill.sourcePath ? (
            <Text color={theme.muted}>
              {" "}
              ·{" "}
              {formatWorkspaceDisplayPath(skill.sourcePath, {
                workspaceRoot,
                maxCols: 72,
              })}
            </Text>
          ) : null}
        </Text>,
      );
    }
    if (indexed.length > 16) {
      rows.push(
        <Text key="skills-more" color={theme.muted}>
          … {indexed.length - 16} more
        </Text>,
      );
    }
  }
}

function addAgentsRows(
  rows: React.ReactElement[],
  agents: CapabilitySnapshot["agents"]["profiles"],
  delegateTools: CapabilitySnapshot["agents"]["delegateTools"],
  theme: CapabilityRowTheme,
): void {
  pushSectionHeader(
    rows,
    `agents (${agents.length} / ${delegateTools.length} delegates)`,
    "no agents reported",
    agents.length + delegateTools.length,
  );
  for (const agent of agents) {
    rows.push(
      <Text key={`agent:${agent.id}`}>
        <Text color={theme.success}>• </Text>
        {agent.name ?? agent.id}
        {agent.mode ? <Text color={theme.muted}> · {agent.mode}</Text> : null}
      </Text>,
    );
  }
  for (const tool of delegateTools) {
    rows.push(
      <Text key={`delegate:${tool.toolName}`}>
        <Text color={theme.success}>delegate </Text>
        {tool.toolName}
        <Text color={theme.muted}>
          {" "}
          → {tool.profileId} · {tool.protocol}
          {tool.model ? ` · ${tool.model}` : ""}
          {formatDelegateRouting(tool.routing)} ·{" "}
          {tool.requiresApproval ? "approval" : "no approval"} · workspace{" "}
          {tool.workspaceAccess}
          {tool.gatedByRunWrite ? " · requires --write" : ""}
        </Text>
      </Text>,
    );
  }
}

function formatDelegateRouting(
  routing:
    | CapabilitySnapshot["agents"]["delegateTools"][number]["routing"]
    | undefined,
): string {
  if (!routing) return "";
  if (routing.relevance) return ` · ${routing.relevance}`;
  return routing.keywords.length > 0 ? " · triggers" : "";
}

function addMcpRows(
  rows: React.ReactElement[],
  mcp: CapabilitySnapshot["mcp"]["statuses"],
  theme: CapabilityRowTheme,
): void {
  pushSectionHeader(rows, `mcp (${mcp.length})`, "no MCP servers reported");
  for (const server of mcp) {
    rows.push(
      <Text key={`mcp:${server.serverName}`}>
        <Text color={theme.success}>• </Text>
        {server.serverName}
        <Text color={theme.muted}>
          {" "}
          · {server.status} · {server.toolNames.length} tools
        </Text>
        {server.errorCode ? (
          <Text color={theme.error}>
            {" "}
            · {server.errorCode}
            {server.errorPhase ? ` (${server.errorPhase})` : ""}
          </Text>
        ) : null}
      </Text>,
    );
    if (server.toolNames.length > 0) {
      rows.push(
        <Text key={`mcp-tools:${server.serverName}`} color={theme.muted}>
          {server.toolNames.join(", ")}
        </Text>,
      );
    }
    if (server.errorMessage) {
      rows.push(
        <Text key={`mcp-error:${server.serverName}`} color={theme.muted}>
          {server.errorMessage}
        </Text>,
      );
    }
  }
}

function addWorkflowRuleRows(
  rows: React.ReactElement[],
  rules: CapabilityRules["workflow"],
  theme: CapabilityRowTheme,
): void {
  pushSectionHeader(
    rows,
    `workflow rules (${rules.length})`,
    "no workflow rules reported",
    rules.length,
  );
  for (const rule of rules.slice(0, 12)) {
    const ruleKey = `${rule.source}:${rule.lifecycle}:${rule.name}`;
    rows.push(
      <Text key={`workflow-rule:${ruleKey}`}>
        <Text color={rule.active ? theme.success : theme.muted}>• </Text>
        {rule.name}
        <Text color={theme.muted}>
          {" "}
          · {rule.source} · {rule.lifecycle} · {rule.status} ·{" "}
          {rule.blockingPotential ? "can block" : "non-blocking"}
        </Text>
      </Text>,
      <Text key={`workflow-rule-detail:${ruleKey}`} color={theme.muted}>
        matcher {rule.matcher} · action {rule.action}
      </Text>,
    );
    if (rule.disableHint || rule.configurationHint) {
      rows.push(
        <Text key={`workflow-rule-hint:${ruleKey}`} color={theme.muted}>
          {rule.configurationHint ?? rule.disableHint}
        </Text>,
      );
    }
  }
  if (rules.length > 12) {
    rows.push(
      <Text key="workflow-rules-more" color={theme.muted}>
        … {rules.length - 12} more
      </Text>,
    );
  }
}

function addEventRuleRows(
  rows: React.ReactElement[],
  rules: NonNullable<CapabilityRules["events"]>,
  theme: CapabilityRowTheme,
): void {
  pushSectionHeader(
    rows,
    `event rules (${rules.length})`,
    "no event rules reported",
    rules.length,
  );
  for (const rule of rules.slice(0, 12)) {
    const ruleKey = `${rule.source}:${rule.trigger}:${rule.name}`;
    rows.push(
      <Text key={`event-rule:${ruleKey}`}>
        <Text color={rule.active ? theme.success : theme.muted}>• </Text>
        {rule.name}
        <Text color={theme.muted}>
          {" "}
          · {rule.source} · {rule.trigger} · {rule.status} · non-blocking
        </Text>
      </Text>,
      <Text key={`event-rule-detail:${ruleKey}`} color={theme.muted}>
        matcher {rule.matcher} · action {rule.action}
      </Text>,
    );
    if (rule.disableHint || rule.configurationHint) {
      rows.push(
        <Text key={`event-rule-hint:${ruleKey}`} color={theme.muted}>
          {rule.configurationHint ?? rule.disableHint}
        </Text>,
      );
    }
  }
  if (rules.length > 12) {
    rows.push(
      <Text key="event-rules-more" color={theme.muted}>
        … {rules.length - 12} more
      </Text>,
    );
  }
}

function addCronRows(
  rows: React.ReactElement[],
  tools: CapabilitySnapshot["tools"],
  automation: CapabilitySnapshot["automation"] | undefined,
  theme: CapabilityRowTheme,
): void {
  const cron = automation?.cron;
  const tasks = automation?.tasks;
  pushSectionHeader(
    rows,
    `cron jobs (${cron?.total ?? 0})`,
    "no cron jobs recorded",
    cron?.total ?? 0,
  );
  for (const job of cron?.jobs ?? []) {
    rows.push(
      <Text key={`cron:${job.id}`}>
        <Text color={job.enabled ? theme.success : theme.muted}>• </Text>
        {job.name}
        <Text color={theme.muted}>
          {" "}
          · {job.state} · {job.schedule}
        </Text>
        {job.lastStatus ? (
          <Text color={job.lastStatus === "ok" ? theme.success : theme.error}>
            {" "}
            · last {job.lastStatus}
          </Text>
        ) : null}
      </Text>,
      <Text key={`cron-time:${job.id}`} color={theme.muted}>
        next {job.nextRunAt ?? "none"} · last {job.lastRunAt ?? "never"}
      </Text>,
    );
    if (job.lastError) {
      rows.push(
        <Text key={`cron-error:${job.id}`} color={theme.error}>
          {job.lastError}
        </Text>,
      );
    }
  }
  if (cron && cron.total > cron.jobs.length) {
    rows.push(
      <Text key="cron-more" color={theme.muted}>
        … {cron.total - cron.jobs.length} more
      </Text>,
    );
  }
  if (cron) {
    rows.push(
      <Text key="cron-state" color={theme.muted}>
        state: {cron.rootDir}
      </Text>,
    );
  }

  pushSectionHeader(
    rows,
    `background tasks (${tasks?.total ?? 0})`,
    "no durable background tasks recorded",
    tasks?.total ?? 0,
  );
  for (const task of tasks?.tasks ?? []) {
    rows.push(
      <Text key={`task:${task.id}`}>
        <Text
          color={
            task.status === "failed"
              ? theme.error
              : task.status === "completed"
                ? theme.success
                : theme.accent
          }
        >
          •{" "}
        </Text>
        {task.kind}
        <Text color={theme.muted}>
          {" "}
          · {task.status} · {task.id}
        </Text>
      </Text>,
      <Text key={`task-title:${task.id}`} color={theme.muted}>
        {task.title ?? "untitled"} · output {task.outputChunks ?? 0}
      </Text>,
    );
    if (task.error) {
      rows.push(
        <Text key={`task-error:${task.id}`} color={theme.error}>
          {task.error.code}: {task.error.message}
        </Text>,
      );
    }
  }
  if (tasks && tasks.total > tasks.tasks.length) {
    rows.push(
      <Text key="tasks-more" color={theme.muted}>
        … {tasks.total - tasks.tasks.length} more
      </Text>,
    );
  }
  if (tasks) {
    rows.push(
      <Text key="tasks-state" color={theme.muted}>
        state: {tasks.rootDir}
      </Text>,
    );
  }

  pushSectionHeader(
    rows,
    `cron tools (${tools.length})`,
    "cron tool is not prepared for this host",
    tools.length,
  );
  for (const tool of tools) {
    rows.push(
      <Text key={`cron-tool:${tool.name}`}>
        <Text color={theme.success}>• </Text>
        {tool.name}
        {tool.risk ? <Text color={theme.muted}> · {tool.risk}</Text> : null}
        {tool.origin ? <Text color={theme.muted}> · {tool.origin}</Text> : null}
      </Text>,
    );
  }
}

function pushSectionHeader(
  rows: React.ReactElement[],
  title: string,
  empty: string,
  count = 1,
): void {
  rows.push(<Text key={`space:${title}`}> </Text>);
  rows.push(
    <Text key={`heading:${title}`} bold>
      {title}
    </Text>,
  );
  if (count === 0) {
    rows.push(
      <Text key={`empty:${title}`} dimColor>
        {empty}
      </Text>,
    );
  }
}
