#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { createSparkwrightAcpAgentFactory } from "@sparkwright/acp-adapter";

const CLI = ["node", "packages/cli/dist/index.js"];
const cases = [];
const tempDirs = [];

const envRoot = await tempDir("sparkwright-regression-env-");
const childEnv = {
  ...process.env,
  XDG_CONFIG_HOME: join(envRoot, "xdg"),
  XDG_STATE_HOME: join(envRoot, "state"),
  SPARKWRIGHT_HOST_SOURCE: "1",
  SPARKWRIGHT_ENABLE_DIRECT_CORE: "1",
};
await mkdir(childEnv.XDG_CONFIG_HOME, { recursive: true });
await mkdir(childEnv.XDG_STATE_HOME, { recursive: true });

try {
  await readOnlyCase();
  const approved = await writeApprovedCase();
  await writeDeniedCase();
  await invalidConfigCase();
  await invalidTargetCase();
  await skillLoadingCase();
  await mcpFailureCase();
  await sessionCheckCase(approved);
  await delegateCwdCase();
  await shellPromotionCase();
  await delegateNoTaskManagerTimeoutCase();
  await spawnFinalityCase();
  await tuiStartupCase();
  await acpStartupCase();
  await entrypointConsistencyCase();
  printMatrix();
  const failed = cases.filter((testCase) => testCase.status === "failed");
  if (failed.length > 0) process.exitCode = 1;
} finally {
  if (!process.env.SPARKWRIGHT_KEEP_REGRESSION_WORKSPACES) {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  }
}

async function readOnlyCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-ro-");
  const prompt = "Inspect README.md without modifying files.";
  const result = await runCli([
    "run",
    "--direct-core",
    prompt,
    "--workspace",
    workspace,
    "--target",
    "README.md",
    "--model",
    "deterministic",
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout);
  record({
    id: "RO",
    name: "diagnostics: read-only direct-core",
    command: commandString(result.command),
    prompt,
    workspace,
    write: "no",
    expectedTrace: "run.completed, workspace.read; no workspace.write.*",
    failureRule:
      "Fails if the run does not complete, if README changes, or if any workspace.write.* event appears.",
    harness: true,
    ok:
      result.exitCode === 0 &&
      has(trace.events, "run.completed") &&
      has(trace.events, "workspace.read") &&
      !hasPrefix(trace.events, "workspace.write.") &&
      (await readFile(join(workspace, "README.md"), "utf8")) === "# Demo\n",
  });
}

async function writeApprovedCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-approved-");
  await prepareDirectCoreWorkspace(workspace);
  const prompt = "Append deterministic golden-path section.";
  const result = await runCli([
    "run",
    "--direct-core",
    prompt,
    "--workspace",
    workspace,
    "--target",
    "README.md",
    "--write",
    "--yes",
    "--model",
    "deterministic",
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout);
  const readme = await readFile(join(workspace, "README.md"), "utf8");
  record({
    id: "WA",
    name: "diagnostics: write approved direct-core",
    command: commandString(result.command),
    prompt,
    workspace,
    write: "yes, approved",
    expectedTrace:
      "approval.requested, approval.resolved approved, artifact.created, workspace.write.completed",
    failureRule:
      "Fails if the write is not applied, no diff artifact is created, or a denied write appears.",
    harness: true,
    ok:
      result.exitCode === 0 &&
      has(trace.events, "approval.requested") &&
      eventWith(
        trace.events,
        "approval.resolved",
        (event) => event.payload?.decision === "approved",
      ) &&
      has(trace.events, "artifact.created") &&
      has(trace.events, "workspace.write.completed") &&
      !has(trace.events, "workspace.write.denied") &&
      readme.includes("## Sparkwright CLI Golden Path"),
  });
  return { workspace, sessionId: trace.sessionId, tracePath: trace.path };
}

async function writeDeniedCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-denied-");
  await prepareDirectCoreWorkspace(workspace);
  const prompt = "Attempt deterministic write and deny approval.";
  const result = await runCli(
    [
      "run",
      "--direct-core",
      prompt,
      "--workspace",
      workspace,
      "--target",
      "README.md",
      "--write",
      "--model",
      "deterministic",
      "--trace-level",
      "debug",
    ],
    { input: "n\n" },
  );
  const trace = await traceFromOutput(result.stdout);
  record({
    id: "WD",
    name: "diagnostics: write denied direct-core",
    command: `printf 'n\\n' | ${commandString(result.command)}`,
    prompt,
    workspace,
    write: "yes, denied",
    expectedTrace:
      "approval.requested, approval.resolved denied, workspace.write.denied, tool.failed APPROVAL_DENIED",
    failureRule:
      "Fails if README changes, the denial is missing, or workspace.write.completed appears.",
    harness: true,
    ok:
      result.exitCode === 0 &&
      has(trace.events, "approval.requested") &&
      eventWith(
        trace.events,
        "approval.resolved",
        (event) => event.payload?.decision === "denied",
      ) &&
      has(trace.events, "workspace.write.denied") &&
      eventWith(
        trace.events,
        "tool.failed",
        (event) => event.payload?.error?.code === "APPROVAL_DENIED",
      ) &&
      !has(trace.events, "workspace.write.completed") &&
      (await readFile(join(workspace, "README.md"), "utf8")) === "# Demo\n",
  });
}

async function invalidConfigCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-bad-config-");
  await mkdir(join(workspace, ".sparkwright"), { recursive: true });
  await writeFile(
    join(workspace, ".sparkwright", "config.json"),
    "{ bad json",
    "utf8",
  );
  const result = await runCli([
    "capabilities",
    "inspect",
    "--workspace",
    workspace,
    "--format",
    "text",
  ]);
  record({
    id: "CFG",
    name: "invalid config",
    command: commandString(result.command),
    prompt: "N/A",
    workspace,
    write: "no",
    expectedTrace: "startup/config diagnostic only; no run trace expected",
    failureRule:
      "Fails if exit code is not 1 or invalid JSON/config errors are not reported.",
    harness: true,
    ok:
      result.exitCode === 1 &&
      result.stderr.includes("invalid JSON") &&
      result.stdout.includes("config errors: 1"),
  });
}

async function invalidTargetCase() {
  const workspace = await workspaceWithReadme(
    "sparkwright-reg-invalid-target-",
  );
  const sessionRoot = await tempDir("sparkwright-reg-invalid-target-sessions-");
  const prompt = "Try invalid target.";
  const result = await runCli([
    "run",
    "--direct-core",
    prompt,
    "--workspace",
    workspace,
    "--session-root",
    sessionRoot,
    "--target",
    "../outside.md",
    "--model",
    "deterministic",
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout);
  record({
    id: "TARGET",
    name: "diagnostics: invalid target direct-core",
    command: commandString(result.command),
    prompt,
    workspace,
    write: "no",
    expectedTrace:
      "validation.failed TARGET_OUTSIDE_WORKSPACE, run.failed validation_failed",
    failureRule:
      "Fails if validation does not stop before model/tool events or if exit code is not 1.",
    harness: true,
    ok:
      result.exitCode === 1 &&
      eventWith(trace.events, "validation.failed", (event) =>
        JSON.stringify(event.payload).includes("TARGET_OUTSIDE_WORKSPACE"),
      ) &&
      eventWith(
        trace.events,
        "run.failed",
        (event) => event.payload?.reason === "validation_failed",
      ) &&
      !has(trace.events, "model.requested") &&
      !has(trace.events, "tool.requested"),
  });
}

async function skillLoadingCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-skill-");
  await mkdir(join(workspace, ".sparkwright"), { recursive: true });
  await mkdir(join(workspace, "skills", "reviewer"), { recursive: true });
  await writeFile(
    join(workspace, ".sparkwright", "config.json"),
    JSON.stringify({
      model: "deterministic",
      capabilities: {
        skills: {
          roots: ["../skills"],
          loadSelectedSkills: true,
          maxSelectedSkills: 1,
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    join(workspace, "skills", "reviewer", "SKILL.md"),
    [
      "---",
      "name: reviewer",
      "description: Review code and explain risks.",
      "---",
      "# Reviewer",
      "",
      "Always call out concrete risks.",
      "",
    ].join("\n"),
    "utf8",
  );
  const prompt = "review code with reviewer skill; do not modify files";
  const result = await runCli([
    "run",
    prompt,
    "--workspace",
    workspace,
    "--target",
    "README.md",
    "--model",
    "deterministic",
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout);
  record({
    id: "SKILL",
    name: "skill loading",
    command: commandString(result.command),
    prompt,
    workspace,
    write: "no",
    expectedTrace: "skill.indexed, skill.loaded reviewer, run.completed",
    failureRule:
      "Fails if the matching skill is not loaded or skill prep prevents the run completing.",
    harness: true,
    ok:
      result.exitCode === 0 &&
      has(trace.events, "skill.indexed") &&
      eventWith(
        trace.events,
        "skill.loaded",
        (event) => event.payload?.name === "reviewer",
      ) &&
      has(trace.events, "run.completed") &&
      !hasPrefix(trace.events, "workspace.write."),
  });
}

async function mcpFailureCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-mcp-failure-");
  await mkdir(join(workspace, ".sparkwright"), { recursive: true });
  await writeFile(
    join(workspace, ".sparkwright", "config.json"),
    JSON.stringify({
      model: "deterministic",
      capabilities: {
        mcp: {
          servers: [
            {
              type: "stdio",
              name: "missing",
              command: "/tmp/no-such-sparkwright-mcp",
              enabled: true,
              timeoutMs: 100,
            },
          ],
        },
      },
    }),
    "utf8",
  );
  const idlePrompt =
    "inspect README and tolerate configured but unused MCP; do not modify files";
  const idleResult = await runCli([
    "run",
    idlePrompt,
    "--workspace",
    workspace,
    "--target",
    "README.md",
    "--model",
    "deterministic",
    "--trace-level",
    "debug",
  ]);
  const idleTrace = await traceFromOutput(idleResult.stdout);
  record({
    id: "MCP_IDLE",
    name: "MCP configured but unused",
    command: commandString(idleResult.command),
    prompt: idlePrompt,
    workspace,
    write: "no",
    expectedTrace:
      "run.completed, no mcp.server.prepared because MCP is lazy until selected",
    failureRule:
      "Fails if a configured MCP server is prepared before the model selects a lazy MCP tool.",
    harness: true,
    ok:
      idleResult.exitCode === 0 &&
      !has(idleTrace.events, "mcp.server.prepared") &&
      has(idleTrace.events, "run.completed"),
  });

  const lazyPrompt = "explicitly list tools from the missing MCP server";
  const lazyResult = await runCli(
    [
      "run",
      lazyPrompt,
      "--workspace",
      workspace,
      "--target",
      "README.md",
      "--model",
      "scripted",
      "--trace-level",
      "debug",
    ],
    {
      env: {
        SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
          {
            toolCalls: [{ toolName: "mcp_missing_list_tools", arguments: {} }],
          },
          { message: "missing MCP failed as expected" },
        ]),
      },
    },
  );
  const lazyTrace = await traceFromOutput(lazyResult.stdout);
  record({
    id: "MCP_LAZY_FAIL",
    name: "MCP lazy prepare failure",
    command: commandString(lazyResult.command),
    prompt: lazyPrompt,
    workspace,
    write: "no",
    expectedTrace:
      "mcp_missing_list_tools, mcp.server.prepared failed, run.completed",
    failureRule:
      "Fails if explicit lazy MCP selection does not prepare the server or loses the structured failure code.",
    harness: true,
    ok:
      lazyResult.exitCode === 0 &&
      eventWith(
        lazyTrace.events,
        "mcp.server.prepared",
        (event) =>
          event.payload?.status === "failed" &&
          /^MCP_SERVER_(COMMAND_NOT_FOUND|CONNECT_FAILED|PREPARE_TIMEOUT)$/.test(
            String(event.payload?.errorCode ?? ""),
          ),
      ) &&
      has(lazyTrace.events, "run.completed"),
  });
}

async function sessionCheckCase(approved) {
  const result = await runCli([
    "session",
    "check",
    approved.sessionId,
    "--workspace",
    approved.workspace,
    "--format",
    "text",
  ]);
  record({
    id: "SESSION",
    name: "session check",
    command: commandString(result.command),
    prompt: "N/A",
    workspace: approved.workspace,
    write: "no",
    expectedTrace:
      "checked session contains the approved write run; session check reports status ok/findings 0",
    failureRule:
      "Fails if session check exits non-zero, reports findings, or cannot read the run trace.",
    harness: true,
    ok:
      result.exitCode === 0 &&
      result.stdout.includes("status: ok") &&
      result.stdout.includes("findings: 0"),
  });
}

async function delegateCwdCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-delegate-cwd-");
  const sessionId = "session_reg_delegate_cwd";
  await writeProjectConfig(workspace, {
    shell: { foregroundTimeoutMs: 1_000, sandbox: { mode: "off" } },
    maxSteps: 20,
    capabilities: {
      agents: {
        profiles: [
          { id: "main", mode: "primary" },
          {
            id: "runner",
            name: "Runner",
            mode: "child",
            prompt: "Run the requested Bash command.",
            use: ["bash"],
            allowedTools: ["bash"],
          },
        ],
        delegateTools: [{ profileId: "runner", toolName: "delegate_runner" }],
      },
    },
  });
  const prompt = "Delegate a cwd check.";
  const result = await runCli(
    [
      "run",
      prompt,
      "--workspace",
      workspace,
      "--model",
      "scripted",
      "--trace-level",
      "debug",
      "--session-id",
      sessionId,
    ],
    {
      env: {
        SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
          {
            toolCalls: [
              {
                toolName: "tool_search",
                arguments: { query: "select:delegate_agent" },
              },
            ],
          },
          {
            toolCalls: [
              {
                toolName: "delegate_agent",
                arguments: {
                  agentId: "runner",
                  goal: "Print the child Bash cwd.",
                },
              },
            ],
          },
          {
            toolCalls: [
              { toolName: "bash", arguments: { command: "pwd", cwd: "." } },
            ],
          },
          { message: "child cwd checked" },
          { message: "parent observed delegate cwd" },
        ]),
      },
    },
  );
  const trace = await traceFromOutput(result.stdout);
  const childTrace = await readAgentTrace(workspace, sessionId, "runner");
  const expectedCwd = await realpath(workspace);
  record({
    id: "DELEGATE_CWD",
    name: "configured delegate Bash cwd",
    command: commandString(result.command),
    prompt,
    workspace,
    write: "no",
    expectedTrace:
      "tool_search -> delegate_agent(runner) -> child bash pwd with cwd='.' resolves inside workspace; subagent.completed",
    failureRule:
      "Fails if configured delegate child bash false-denies cwd='.', resolves outside the workspace, or loses subagent finality.",
    harness: true,
    ok:
      result.exitCode === 0 &&
      eventWith(
        trace.events,
        "subagent.completed",
        (event) => event.metadata?.delegateTool === "delegate_runner",
      ) &&
      !eventWith(
        childTrace,
        "tool.failed",
        (event) => event.payload?.toolName === "bash",
      ) &&
      JSON.stringify(childTrace).includes(expectedCwd),
  });
}

async function shellPromotionCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-promote-");
  await writeProjectConfig(workspace, {
    shell: { foregroundTimeoutMs: 20, sandbox: { mode: "off" } },
    maxSteps: 20,
  });
  const prompt = "Promote a long Bash command and inspect tasks.";
  const result = await runCli(
    [
      "run",
      prompt,
      "--workspace",
      workspace,
      "--model",
      "scripted",
      "--trace-level",
      "debug",
      "--write",
      "--yes",
    ],
    {
      env: {
        SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
          {
            toolCalls: [
              {
                toolName: "bash",
                arguments: {
                  command:
                    "node -e \"setTimeout(() => console.log('matrix promoted'), 80)\"",
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                toolName: "tool_search",
                arguments: { query: "select:task" },
              },
            ],
          },
          {
            toolCalls: [
              {
                toolName: "task",
                arguments: { action: "list", kind: "shell.background" },
              },
            ],
          },
          { message: "promotion checked" },
        ]),
      },
    },
  );
  const trace = await traceFromOutput(result.stdout);
  record({
    id: "PROMOTE",
    name: "bash foreground promotion",
    command: commandString(result.command),
    prompt,
    workspace,
    write: "yes, auto-approved bash",
    expectedTrace:
      "bash result has promoted=true/taskId; tool_search -> task(action=list, kind=shell.background) returns a parent task",
    failureRule:
      "Fails if the foreground timeout kills instead of promoting, or if promoted tasks are not visible to the main agent.",
    harness: true,
    ok:
      result.exitCode === 0 &&
      eventWith(
        trace.events,
        "tool.completed",
        (event) =>
          event.payload?.toolName === "bash" &&
          event.payload?.output?.promoted === true &&
          typeof event.payload?.output?.taskId === "string",
      ) &&
      eventWith(
        trace.events,
        "tool.completed",
        (event) =>
          event.payload?.toolName === "task" &&
          Array.isArray(event.payload?.output?.tasks) &&
          event.payload.output.tasks.length > 0,
      ),
  });
}

async function delegateNoTaskManagerTimeoutCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-no-taskmgr-");
  const sessionId = "session_reg_delegate_no_taskmgr";
  await writeProjectConfig(workspace, {
    shell: { foregroundTimeoutMs: 20, sandbox: { mode: "off" } },
    maxSteps: 20,
    capabilities: {
      agents: {
        profiles: [
          { id: "main", mode: "primary" },
          {
            id: "runner",
            name: "Runner",
            mode: "child",
            prompt: "Run the requested Bash command.",
            use: ["bash"],
            allowedTools: ["bash"],
          },
        ],
        delegateTools: [{ profileId: "runner", toolName: "delegate_runner" }],
      },
    },
  });
  const prompt = "Delegate a no-task-manager Bash timeout.";
  const result = await runCli(
    [
      "run",
      prompt,
      "--workspace",
      workspace,
      "--model",
      "scripted",
      "--trace-level",
      "debug",
      "--session-id",
      sessionId,
      "--write",
      "--yes",
    ],
    {
      env: {
        SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
          {
            toolCalls: [
              {
                toolName: "tool_search",
                arguments: { query: "select:delegate_agent" },
              },
            ],
          },
          {
            toolCalls: [
              {
                toolName: "delegate_agent",
                arguments: {
                  agentId: "runner",
                  goal: "Run a long child Bash command.",
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                toolName: "bash",
                arguments: {
                  command:
                    "node -e \"setTimeout(() => console.log('late'), 80)\"",
                },
              },
            ],
          },
          { message: "child observed bash timeout" },
          { message: "parent observed delegate timeout" },
        ]),
      },
    },
  );
  const childTrace = await readAgentTrace(workspace, sessionId, "runner");
  const childTraceText = JSON.stringify(childTrace);
  record({
    id: "NO_TASKMGR",
    name: "delegate bash foreground kill without task manager",
    command: commandString(result.command),
    prompt,
    workspace,
    write: "yes, auto-approved bash",
    expectedTrace:
      "child bash output reports foregroundTimeoutMs, promotionAvailable=false, timedOut=true, and clear kill reason",
    failureRule:
      "Fails if no-taskManager bash silently promotes, hides foreground-timeout/promotion metadata, or omits the kill reason.",
    harness: true,
    ok:
      result.exitCode === 0 &&
      childTraceText.includes('"promotionAvailable":false') &&
      childTraceText.includes('"timedOut":true') &&
      childTraceText.includes(
        "foreground timeout reached; process killed because promotion unavailable",
      ) &&
      !childTraceText.includes('"promoted":true'),
  });
}

async function spawnFinalityCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-spawn-");
  const prompt = "Spawn a read-only child and verify finality.";
  await writeProjectConfig(workspace, { maxSteps: 20 });
  const result = await runCli(
    [
      "run",
      prompt,
      "--workspace",
      workspace,
      "--model",
      "scripted",
      "--trace-level",
      "debug",
    ],
    {
      env: {
        SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify([
          {
            toolCalls: [
              {
                toolName: "tool_search",
                arguments: { query: "select:spawn_agent" },
              },
            ],
          },
          {
            toolCalls: [
              {
                toolName: "spawn_agent",
                arguments: {
                  goal: "Read README.md.",
                  role: "reader",
                  prompt: "Read README.md and summarize it.",
                  allowedTools: ["read"],
                },
              },
            ],
          },
          {
            toolCalls: [{ toolName: "read", arguments: { path: "README.md" } }],
          },
          { message: "child read README.md" },
          { message: "parent observed complete child" },
        ]),
      },
    },
  );
  const trace = await traceFromOutput(result.stdout);
  const traceText = JSON.stringify(trace.events);
  record({
    id: "SPAWN_FINAL",
    name: "dynamic spawn read-only finality",
    command: commandString(result.command),
    prompt,
    workspace,
    write: "no",
    expectedTrace:
      "tool_search -> spawn_agent output finality=complete, inherited maxSteps visible in promotionHint, child uses read only",
    failureRule:
      "Fails if dynamic spawn exposes bash/write tools, marks a complete child partial, or falls back to the old maxSteps default.",
    harness: true,
    ok:
      result.exitCode === 0 &&
      eventWith(
        trace.events,
        "tool.completed",
        (event) =>
          event.payload?.toolName === "spawn_agent" &&
          event.payload?.output?.finality === "complete" &&
          event.payload?.output?.truncated === false &&
          event.payload?.output?.promotionHint?.suggestedProfile?.maxSteps ===
            20,
      ) &&
      traceText.includes('"toolName":"read"') &&
      !traceText.includes('"toolName":"bash"') &&
      !traceText.includes('"toolName":"write"') &&
      !traceText.includes('"toolName":"edit"'),
  });
}

async function tuiStartupCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-tui-");
  const result = await runCli(
    [
      "tui",
      "--workspace",
      workspace,
      "--model",
      "deterministic",
      "--trace-level",
      "debug",
      "--session-id",
      "session_reg_tui_start",
    ],
    { timeoutMs: 5_000 },
  );
  record({
    id: "TUI",
    name: "TUI startup",
    command: commandString(result.command),
    prompt: "N/A startup",
    workspace,
    write: "no",
    expectedTrace: "startup-only smoke; no run trace expected",
    failureRule:
      "Fails if the TUI entry crashes, hangs, or does not render the startup frame in non-TTY mode.",
    harness: true,
    ok:
      result.exitCode === 0 &&
      !result.timedOut &&
      result.stdout.includes("SparkWright") &&
      result.stdout.includes("session session_reg_tui_start") &&
      result.stdout.includes("stdin is not a TTY"),
  });
}

async function acpStartupCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-acp-");
  const restoreEnv = applyEnv({
    XDG_CONFIG_HOME: childEnv.XDG_CONFIG_HOME,
    XDG_STATE_HOME: childEnv.XDG_STATE_HOME,
  });
  const updates = [];
  const clientToAgent = new TransformStream();
  const agentToClient = new TransformStream();
  const client = {
    async requestPermission(params) {
      return {
        outcome: {
          outcome: "selected",
          optionId: params.options.at(-1)?.optionId ?? "reject",
        },
      };
    },
    async sessionUpdate(params) {
      updates.push(params);
    },
  };
  const agentConnection = new AgentSideConnection(
    createSparkwrightAcpAgentFactory({
      defaultWorkspaceRoot: workspace,
      defaultModel: "deterministic",
      defaultTraceLevel: "debug",
    }),
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  );
  const clientConnection = new ClientSideConnection(
    () => client,
    ndJsonStream(clientToAgent.writable, agentToClient.readable),
  );
  let sessionId = "";
  try {
    const initialized = await clientConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConnection.newSession({
      cwd: workspace,
      mcpServers: [],
    });
    sessionId = session.sessionId;
    await clientConnection.extMethod("sparkwright/capabilities", {
      sessionId,
    });
    const prompt = "inspect this repo";
    const response = await clientConnection.prompt({
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    const tracePath = join(
      workspace,
      ".sparkwright",
      "sessions",
      sessionId,
      "trace.jsonl",
    );
    const events = await readTrace(tracePath);
    const metadata = await readFirstRunMetadata(workspace, sessionId);
    record({
      id: "ACP",
      name: "ACP startup",
      command: "ACP SDK initialize -> newSession -> capabilities -> prompt",
      prompt,
      workspace,
      write: "no",
      expectedTrace:
        "run.created, skill.indexed, agent.profile.derived, workspace.read, run.completed; run metadata source acp",
      failureRule:
        "Fails if ACP init/session/prompt fails, stopReason is not end_turn, or trace metadata is not source=acp.",
      harness: true,
      ok:
        initialized.agentInfo?.name === "SparkWright" &&
        response.stopReason === "end_turn" &&
        metadata?.source === "acp" &&
        has(events, "run.created") &&
        has(events, "workspace.read") &&
        has(events, "run.completed") &&
        updates.some((update) => update.update?.sessionUpdate === "tool_call"),
    });
    await clientConnection.closeSession({ sessionId });
  } finally {
    agentConnection.signal.throwIfAborted?.();
    restoreEnv();
  }
}

// Host/runtime consistency: the same workspace + config must present the same
// capability surface (tools, skills, mcp, agents, workspace root) across the
// HostRuntime-backed entrypoints (CLI host runner and ACP). HostRuntime records
// a capabilitySnapshot in run metadata before the model runs, so this parity is
// deterministic and independent of what the model decides to do. direct-core is
// a distinct lightweight runner (createRun, no HostRuntime) and intentionally
// does not carry that snapshot, so it is only checked for completion.
async function entrypointConsistencyCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-consistency-");
  const prompt = "Inspect README.md without modifying files.";
  const fingerprints = {};
  const failures = [];

  // 1. CLI run via the host runner (spawned with the isolated child env).
  try {
    await runCli([
      "run",
      prompt,
      "--workspace",
      workspace,
      "--model",
      "deterministic",
      "--trace-level",
      "debug",
      "--session-id",
      "consistency_cli",
    ]);
    fingerprints.cli = snapshotFingerprint(
      await readFirstRunMetadata(workspace, "consistency_cli"),
    );
  } catch (error) {
    failures.push(`cli: ${error.message}`);
  }

  // 2. ACP runs in-process here, so apply the same isolated XDG env the spawned
  // CLI uses — otherwise the ACP HostRuntime would read the developer's real
  // user config and diverge for reasons unrelated to the entrypoint.
  const restoreEnv = applyEnv({
    XDG_CONFIG_HOME: childEnv.XDG_CONFIG_HOME,
    XDG_STATE_HOME: childEnv.XDG_STATE_HOME,
  });
  try {
    const clientToAgent = new TransformStream();
    const agentToClient = new TransformStream();
    const client = {
      async requestPermission(params) {
        return {
          outcome: {
            outcome: "selected",
            optionId: params.options.at(-1)?.optionId ?? "reject",
          },
        };
      },
      async sessionUpdate() {},
    };
    const agentConnection = new AgentSideConnection(
      createSparkwrightAcpAgentFactory({
        defaultWorkspaceRoot: workspace,
        defaultModel: "deterministic",
        defaultTraceLevel: "debug",
      }),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
    const clientConnection = new ClientSideConnection(
      () => client,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    try {
      await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await clientConnection.newSession({
        cwd: workspace,
        mcpServers: [],
      });
      await clientConnection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      fingerprints.acp = snapshotFingerprint(
        await readFirstRunMetadata(workspace, session.sessionId),
      );
      await clientConnection.closeSession({ sessionId: session.sessionId });
    } finally {
      agentConnection.signal.throwIfAborted?.();
    }
  } catch (error) {
    failures.push(`acp: ${error.message}`);
  } finally {
    restoreEnv();
  }

  // 3. diagnostics direct-core: a distinct runner — only assert it completes and persists a
  // trace (it is intentionally not capabilitySnapshot-comparable).
  let coreCompleted = false;
  try {
    const result = await runCli([
      "run",
      "--direct-core",
      prompt,
      "--workspace",
      workspace,
      "--model",
      "deterministic",
      "--trace-level",
      "debug",
      "--session-id",
      "consistency_core",
    ]);
    const { events } = await traceFromOutput(result.stdout);
    coreCompleted = has(events, "run.completed");
  } catch (error) {
    failures.push(`core: ${error.message}`);
  }

  const parity =
    Boolean(fingerprints.cli) && fingerprints.cli === fingerprints.acp;
  const ok = failures.length === 0 && parity && coreCompleted;
  if (!ok) {
    console.error(`  [consistency:cli] ${fingerprints.cli ?? "(missing)"}`);
    console.error(`  [consistency:acp] ${fingerprints.acp ?? "(missing)"}`);
    console.error(`  [consistency:core] completed=${coreCompleted}`);
    if (failures.length > 0) {
      console.error(`  [consistency] ${failures.join("; ")}`);
    }
  }

  record({
    id: "CONSIST",
    name: "entrypoint capability parity",
    command:
      "CLI host run vs ACP capabilitySnapshot; diagnostics direct-core completes",
    prompt,
    workspace,
    write: "no",
    expectedTrace:
      "CLI host runner and ACP report an identical capabilitySnapshot (workspaceRoot, tool names, skill names, mcp, agents); diagnostics direct-core run completes.",
    failureRule:
      "Fails if any entrypoint errors, if the CLI host and ACP capability surfaces differ, or if diagnostics direct-core does not complete.",
    harness: true,
    ok,
  });
}

// Temporarily override env vars on process.env; returns a restore function.
function applyEnv(overrides) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// Reduce a run's metadata to a stable, comparable capability surface. Based on
// the HostRuntime capabilitySnapshot so it does not depend on model behavior.
function snapshotFingerprint(metadata) {
  if (!metadata) return "";
  const snapshot = metadata.capabilitySnapshot ?? {};
  return JSON.stringify({
    workspaceRoot: metadata.workspaceRoot ?? null,
    tools: [...(snapshot.toolNames ?? [])].sort(),
    skills: [...(snapshot.skills?.indexedNames ?? [])].sort(),
    mcp: snapshot.mcp ?? {},
    agents: snapshot.agents ?? {},
  });
}

async function runCli(args, options = {}) {
  const command = [...CLI, ...args];
  const result = await runCommand(command, options);
  return { ...result, command };
}

async function runCommand(command, options = {}) {
  const [bin, ...args] = command;
  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      env: { ...childEnv, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        command,
        exitCode: timedOut ? 124 : (code ?? 1),
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

async function traceFromOutput(stdout) {
  const match =
    stdout.match(/Trace written to (.+)$/m) ??
    stdout.match(/Validation trace written to (.+)$/m);
  if (!match) throw new Error(`No trace path in output:\n${stdout}`);
  const path = match[1].trim();
  const events = await readTrace(path);
  return {
    path,
    events,
    sessionId:
      events.find((event) => event.metadata?.sessionId)?.metadata?.sessionId ??
      basename(path.split("/trace.jsonl")[0]),
  };
}

async function readTrace(path) {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readFirstRunMetadata(workspace, sessionId) {
  const sessionDir = join(workspace, ".sparkwright", "sessions", sessionId);
  const trace = await readTrace(join(sessionDir, "trace.jsonl"));
  const runId = trace.find((event) => event.runId)?.runId;
  if (!runId) return undefined;
  const runJson = JSON.parse(
    await readFile(
      join(sessionDir, "agents", "main", "runs", runId, "run.json"),
      "utf8",
    ),
  );
  return runJson.metadata;
}

async function readAgentTrace(workspace, sessionId, agentId) {
  return await readTrace(
    join(
      workspace,
      ".sparkwright",
      "sessions",
      sessionId,
      "agents",
      agentId,
      "trace.jsonl",
    ),
  );
}

async function workspaceWithReadme(prefix) {
  const workspace = await tempDir(prefix);
  await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
  return workspace;
}

async function writeProjectConfig(workspace, config) {
  await mkdir(join(workspace, ".sparkwright"), { recursive: true });
  await writeFile(
    join(workspace, ".sparkwright", "config.json"),
    JSON.stringify(config),
    "utf8",
  );
}

async function prepareDirectCoreWorkspace(workspace) {
  await mkdir(join(workspace, ".sparkwright"), { recursive: true });
}

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function record(testCase) {
  cases.push({
    ...testCase,
    status: testCase.ok ? "passed" : "failed",
  });
}

function has(events, type) {
  return events.some((event) => event.type === type);
}

function hasPrefix(events, prefix) {
  return events.some((event) => event.type.startsWith(prefix));
}

function eventWith(events, type, predicate) {
  return events.some((event) => event.type === type && predicate(event));
}

function commandString(command) {
  return command.map(shellQuote).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printMatrix() {
  const rows = [
    [
      "id",
      "status",
      "case",
      "command",
      "prompt",
      "workspace",
      "write",
      "expected trace events",
      "failure rule",
      "auto harness",
    ],
    ...cases.map((testCase) => [
      testCase.id,
      testCase.status,
      testCase.name,
      testCase.command,
      testCase.prompt,
      testCase.workspace,
      testCase.write,
      testCase.expectedTrace,
      testCase.failureRule,
      testCase.harness ? "yes" : "no",
    ]),
  ];
  const widths = rows[0].map((_, index) =>
    Math.min(72, Math.max(...rows.map((row) => String(row[index]).length))),
  );
  for (const row of rows) {
    console.log(
      row
        .map((cell, index) =>
          truncate(String(cell), widths[index]).padEnd(widths[index]),
        )
        .join(" | "),
    );
  }
}

function truncate(value, width) {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}
