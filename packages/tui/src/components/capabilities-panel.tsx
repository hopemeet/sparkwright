import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { CapabilitySnapshot } from "@sparkwright/protocol";
import { useTheme } from "../lib/theme-context.js";
import type { CapabilityView } from "../lib/layer-payload.js";

export function CapabilitiesPanel(props: {
  snapshot: CapabilitySnapshot | null;
  loading: boolean;
  view: CapabilityView;
  onClose: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  const [scroll, setScroll] = useState(0);

  const snapshot = props.snapshot;
  const tools = snapshot?.tools ?? [];
  const indexedSkills = snapshot?.skills.indexed ?? [];
  const loadedSkills = snapshot?.skills.loaded ?? [];
  const mcpServers = snapshot?.mcp.statuses ?? [];
  const agents = snapshot?.agents.profiles ?? [];
  const delegateTools = snapshot?.agents.delegateTools ?? [];
  const cronTools = tools.filter((tool) =>
    tool.name.toLowerCase().includes("cron"),
  );
  const rows = snapshot
    ? capabilityRows({
        view: props.view,
        tools,
        indexedSkills,
        loadedSkills,
        agents,
        delegateTools,
        mcpServers,
        cronTools,
        automation: snapshot.automation,
        theme: {
          accent: theme.accent,
          error: theme.error,
          muted: theme.muted,
          success: theme.success,
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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
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
            <Text color={theme.muted}>esc close</Text>
            {maxScroll > 0 ? (
              <Text color={theme.muted}>
                {" · ↑/↓ j/k scroll · u/d page"}
                {more > 0 ? ` · ${more} more ↓` : " · end"}
              </Text>
            ) : null}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function capabilityRows(input: {
  view: CapabilityView;
  theme: CapabilityRowTheme;
  tools: CapabilitySnapshot["tools"];
  indexedSkills: CapabilitySnapshot["skills"]["indexed"];
  loadedSkills: CapabilitySnapshot["skills"]["loaded"];
  agents: CapabilitySnapshot["agents"]["profiles"];
  delegateTools: CapabilitySnapshot["agents"]["delegateTools"];
  mcpServers: CapabilitySnapshot["mcp"]["statuses"];
  cronTools: CapabilitySnapshot["tools"];
  automation?: CapabilitySnapshot["automation"];
}): React.ReactElement[] {
  const rows: React.ReactElement[] = [];
  addOverviewRows(rows, input);
  if (input.view === "all" || input.view === "tools") {
    addToolsRows(rows, input.tools, input.theme);
  }
  if (input.view === "all" || input.view === "skills") {
    addSkillsRows(rows, input.indexedSkills, input.loadedSkills, input.theme);
  }
  if (input.view === "all" || input.view === "agents") {
    addAgentsRows(rows, input.agents, input.delegateTools, input.theme);
  }
  if (input.view === "all" || input.view === "mcp") {
    addMcpRows(rows, input.mcpServers, input.theme);
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
    tools: CapabilitySnapshot["tools"];
    indexedSkills: CapabilitySnapshot["skills"]["indexed"];
    loadedSkills: CapabilitySnapshot["skills"]["loaded"];
    agents: CapabilitySnapshot["agents"]["profiles"];
    delegateTools: CapabilitySnapshot["agents"]["delegateTools"];
    mcpServers: CapabilitySnapshot["mcp"]["statuses"];
    cronTools: CapabilitySnapshot["tools"];
    automation?: CapabilitySnapshot["automation"];
  },
): void {
  const unloadedSkills = Math.max(
    0,
    props.indexedSkills.length - props.loadedSkills.length,
  );
  rows.push(
    <Text key="overview-available">
      <Text color={props.theme.success}>Available now: </Text>
      {props.tools.length} tools, {props.loadedSkills.length} loaded Skills,{" "}
      {props.agents.length} agents, {props.delegateTools.length} delegates,{" "}
      {props.mcpServers.length} MCP servers
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
  pushSectionHeader(rows, `tools (${tools.length})`, "no tools reported");
  for (const tool of tools.slice(0, 24)) {
    const hint = skillToolHint(tool.name);
    rows.push(
      <Text key={`tool:${tool.name}`}>
        <Text color={theme.success}>• </Text>
        {tool.name}
        {tool.risk ? <Text color={theme.muted}> · {tool.risk}</Text> : null}
        {tool.origin ? <Text color={theme.muted}> · {tool.origin}</Text> : null}
      </Text>,
    );
    if (hint) {
      rows.push(
        <Text key={`tool-hint:${tool.name}`} color={theme.muted}>
          {"  " + hint}
        </Text>,
      );
    }
  }
  if (tools.length > 24) {
    rows.push(
      <Text key="tools-more" color={theme.muted}>
        … {tools.length - 24} more
      </Text>,
    );
  }
}

function skillToolHint(name: string): string {
  switch (name) {
    case "list_skills":
      return "managed Skill inventory; shows built-in, user, and project packages";
    case "create_skill":
      return "managed Skill package create; writes SKILL.md through approval";
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
            <Text color={theme.muted}> · {skill.sourcePath}</Text>
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
          → {tool.profileId} · {tool.protocol} ·{" "}
          {tool.requiresApproval ? "approval" : "no approval"} · workspace{" "}
          {tool.workspaceAccess}
        </Text>
      </Text>,
    );
  }
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
