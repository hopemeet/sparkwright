import React from "react";
import { Box, Text, useInput } from "ink";
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
  useInput((_input, key) => {
    if (key.escape || key.return) props.onClose();
  });

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
        <>
          <CapabilityOverview
            tools={tools}
            indexedSkills={indexedSkills}
            loadedSkills={loadedSkills}
            agents={agents}
            delegateTools={delegateTools}
            mcp={mcpServers}
            cronTools={cronTools}
            automation={snapshot.automation}
          />
          {props.view === "all" || props.view === "tools" ? (
            <ToolsCapabilitySection tools={tools} />
          ) : null}
          {props.view === "all" || props.view === "skills" ? (
            <SkillsCapabilitySection
              indexed={indexedSkills}
              loaded={loadedSkills}
            />
          ) : null}
          {props.view === "all" || props.view === "agents" ? (
            <AgentsCapabilitySection
              agents={agents}
              delegateTools={delegateTools}
            />
          ) : null}
          {props.view === "all" || props.view === "mcp" ? (
            <McpCapabilitySection mcp={mcpServers} />
          ) : null}
          {props.view === "cron" ? (
            <CronCapabilitySection
              tools={cronTools}
              automation={snapshot.automation}
            />
          ) : null}
        </>
      ) : null}
    </Box>
  );
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

function CapabilityOverview(props: {
  tools: CapabilitySnapshot["tools"];
  indexedSkills: CapabilitySnapshot["skills"]["indexed"];
  loadedSkills: CapabilitySnapshot["skills"]["loaded"];
  agents: CapabilitySnapshot["agents"]["profiles"];
  delegateTools: CapabilitySnapshot["agents"]["delegateTools"];
  mcp: CapabilitySnapshot["mcp"]["statuses"];
  cronTools: CapabilitySnapshot["tools"];
  automation?: CapabilitySnapshot["automation"];
}): React.ReactElement {
  const theme = useTheme();
  const unloadedSkills = Math.max(
    0,
    props.indexedSkills.length - props.loadedSkills.length,
  );
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.success}>Available now: </Text>
        {props.tools.length} tools, {props.loadedSkills.length} loaded Skills,{" "}
        {props.agents.length} agents, {props.delegateTools.length} delegates,{" "}
        {props.mcp.length} MCP servers
      </Text>
      <Text color={theme.muted}>
        Indexed Skills are discoverable examples; loaded Skills were selected
        for the current run context.
      </Text>
      {unloadedSkills > 0 ? (
        <Text color={theme.muted}>
          {unloadedSkills} more Skill{unloadedSkills === 1 ? "" : "s"} can be
          loaded when relevant.
        </Text>
      ) : null}
      {props.cronTools.length > 0 ? (
        <Text color={theme.muted}>
          Cron support is present through {props.cronTools.length} prepared tool
          {props.cronTools.length === 1 ? "" : "s"}.
        </Text>
      ) : null}
      {props.automation ? (
        <Text color={theme.muted}>
          Automation state: {props.automation.cron.total} cron job
          {props.automation.cron.total === 1 ? "" : "s"},{" "}
          {props.automation.tasks.total} background task
          {props.automation.tasks.total === 1 ? "" : "s"}.
        </Text>
      ) : null}
    </Box>
  );
}

function ToolsCapabilitySection(props: {
  tools: CapabilitySnapshot["tools"];
}): React.ReactElement {
  const theme = useTheme();
  return (
    <CapabilitySection
      title={`tools (${props.tools.length})`}
      empty="no tools reported"
      count={props.tools.length}
    >
      {props.tools.slice(0, 24).map((tool) => (
        <Text key={tool.name}>
          <Text color={theme.success}>• </Text>
          {tool.name}
          {tool.risk ? <Text color={theme.muted}> · {tool.risk}</Text> : null}
          {tool.origin ? (
            <Text color={theme.muted}> · {tool.origin}</Text>
          ) : null}
        </Text>
      ))}
      {props.tools.length > 24 ? (
        <Text color={theme.muted}>… {props.tools.length - 24} more</Text>
      ) : null}
    </CapabilitySection>
  );
}

function SkillsCapabilitySection(props: {
  indexed: CapabilitySnapshot["skills"]["indexed"];
  loaded: CapabilitySnapshot["skills"]["loaded"];
}): React.ReactElement {
  const theme = useTheme();
  return (
    <CapabilitySection
      title={`skills (${props.loaded.length} loaded / ${props.indexed.length} indexed)`}
      empty="no skills reported"
      count={props.loaded.length + props.indexed.length}
    >
      {props.loaded.map((skill) => (
        <Text key={`loaded:${skill.name}`}>
          <Text color={theme.success}>loaded </Text>
          {skill.name}
          {skill.selectionReason ? (
            <Text color={theme.muted}> · {skill.selectionReason}</Text>
          ) : null}
        </Text>
      ))}
      {props.loaded.length === 0
        ? props.indexed.slice(0, 16).map((skill) => (
            <Text key={`indexed:${skill.name}`}>
              <Text color={theme.muted}>indexed </Text>
              {skill.name}
              {skill.sourcePath ? (
                <Text color={theme.muted}> · {skill.sourcePath}</Text>
              ) : null}
            </Text>
          ))
        : null}
      {props.loaded.length === 0 && props.indexed.length > 16 ? (
        <Text color={theme.muted}>… {props.indexed.length - 16} more</Text>
      ) : null}
    </CapabilitySection>
  );
}

function AgentsCapabilitySection(props: {
  agents: CapabilitySnapshot["agents"]["profiles"];
  delegateTools: CapabilitySnapshot["agents"]["delegateTools"];
}): React.ReactElement {
  const theme = useTheme();
  const count = props.agents.length + props.delegateTools.length;
  return (
    <CapabilitySection
      title={`agents (${props.agents.length} / ${props.delegateTools.length} delegates)`}
      empty="no agents reported"
      count={count}
    >
      {props.agents.map((agent) => (
        <Text key={agent.id}>
          <Text color={theme.success}>• </Text>
          {agent.name ?? agent.id}
          {agent.mode ? <Text color={theme.muted}> · {agent.mode}</Text> : null}
        </Text>
      ))}
      {props.delegateTools.map((tool) => (
        <Text key={tool.toolName}>
          <Text color={theme.success}>delegate </Text>
          {tool.toolName}
          <Text color={theme.muted}>
            {" "}
            → {tool.profileId} · {tool.protocol} ·{" "}
            {tool.requiresApproval ? "approval" : "no approval"} · workspace{" "}
            {tool.workspaceAccess}
          </Text>
        </Text>
      ))}
    </CapabilitySection>
  );
}

function McpCapabilitySection(props: {
  mcp: CapabilitySnapshot["mcp"]["statuses"];
}): React.ReactElement {
  const theme = useTheme();
  return (
    <CapabilitySection
      title={`mcp (${props.mcp.length})`}
      empty="no MCP servers reported"
      count={props.mcp.length}
    >
      {props.mcp.map((server) => (
        <Box key={server.serverName} flexDirection="column">
          <Text>
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
          </Text>
          {server.toolNames.length > 0 ? (
            <Text color={theme.muted}> {server.toolNames.join(", ")}</Text>
          ) : null}
          {server.errorMessage ? (
            <Text color={theme.muted}> {server.errorMessage}</Text>
          ) : null}
        </Box>
      ))}
    </CapabilitySection>
  );
}

function CronCapabilitySection(props: {
  tools: CapabilitySnapshot["tools"];
  automation?: CapabilitySnapshot["automation"];
}): React.ReactElement {
  const theme = useTheme();
  const cron = props.automation?.cron;
  const tasks = props.automation?.tasks;
  return (
    <>
      <CapabilitySection
        title={`cron jobs (${cron?.total ?? 0})`}
        empty="no cron jobs recorded"
        count={cron?.total ?? 0}
      >
        {cron?.jobs.map((job) => (
          <Box key={job.id} flexDirection="column">
            <Text>
              <Text color={job.enabled ? theme.success : theme.muted}>• </Text>
              {job.name}
              <Text color={theme.muted}>
                {" "}
                · {job.state} · {job.schedule}
              </Text>
              {job.lastStatus ? (
                <Text
                  color={job.lastStatus === "ok" ? theme.success : theme.error}
                >
                  {" "}
                  · last {job.lastStatus}
                </Text>
              ) : null}
            </Text>
            <Text color={theme.muted}>
              next {job.nextRunAt ?? "none"} · last {job.lastRunAt ?? "never"}
            </Text>
            {job.lastError ? (
              <Text color={theme.error}> {job.lastError}</Text>
            ) : null}
          </Box>
        ))}
        {cron && cron.total > cron.jobs.length ? (
          <Text color={theme.muted}>
            … {cron.total - cron.jobs.length} more
          </Text>
        ) : null}
        {cron ? <Text color={theme.muted}>state: {cron.rootDir}</Text> : null}
      </CapabilitySection>

      <CapabilitySection
        title={`background tasks (${tasks?.total ?? 0})`}
        empty="no durable background tasks recorded"
        count={tasks?.total ?? 0}
      >
        {tasks?.tasks.map((task) => (
          <Box key={task.id} flexDirection="column">
            <Text>
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
            </Text>
            <Text color={theme.muted}>
              {task.title ?? "untitled"} · output {task.outputChunks ?? 0}
            </Text>
            {task.error ? (
              <Text color={theme.error}>
                {task.error.code}: {task.error.message}
              </Text>
            ) : null}
          </Box>
        ))}
        {tasks && tasks.total > tasks.tasks.length ? (
          <Text color={theme.muted}>
            … {tasks.total - tasks.tasks.length} more
          </Text>
        ) : null}
        {tasks ? <Text color={theme.muted}>state: {tasks.rootDir}</Text> : null}
      </CapabilitySection>

      <CapabilitySection
        title={`cron tools (${props.tools.length})`}
        empty="cron tool is not prepared for this host"
        count={props.tools.length}
      >
        {props.tools.map((tool) => (
          <Text key={tool.name}>
            <Text color={theme.success}>• </Text>
            {tool.name}
            {tool.risk ? <Text color={theme.muted}> · {tool.risk}</Text> : null}
            {tool.origin ? (
              <Text color={theme.muted}> · {tool.origin}</Text>
            ) : null}
          </Text>
        ))}
      </CapabilitySection>
    </>
  );
}

function CapabilitySection(props: {
  title: string;
  empty: string;
  count: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{props.title}</Text>
      {props.count > 0 ? props.children : <Text dimColor>{props.empty}</Text>}
    </Box>
  );
}
