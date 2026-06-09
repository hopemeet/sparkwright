#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await tuiStartupCase();
  await acpStartupCase();
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
    name: "read-only direct-core",
    command: commandString(result.command),
    prompt,
    workspace,
    write: "no",
    expectedTrace:
      "run.completed, workspace.read, workspace.anchored_read; no workspace.write.*",
    failureRule:
      "Fails if the run does not complete, if README changes, or if any workspace.write.* event appears.",
    harness: true,
    ok:
      result.exitCode === 0 &&
      has(trace.events, "run.completed") &&
      has(trace.events, "workspace.read") &&
      has(trace.events, "workspace.anchored_read") &&
      !hasPrefix(trace.events, "workspace.write.") &&
      (await readFile(join(workspace, "README.md"), "utf8")) === "# Demo\n",
  });
}

async function writeApprovedCase() {
  const workspace = await workspaceWithReadme("sparkwright-reg-approved-");
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
    name: "write approved",
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
    name: "write denied",
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
    name: "invalid target",
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
  const prompt = "inspect README and tolerate missing MCP; do not modify files";
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
    id: "MCP",
    name: "MCP failure",
    command: commandString(result.command),
    prompt,
    workspace,
    write: "no",
    expectedTrace:
      "mcp.server.prepared failed MCP_SERVER_COMMAND_NOT_FOUND, run.completed",
    failureRule:
      "Fails if MCP prepare failure crashes the run or loses the specific error code.",
    harness: true,
    ok:
      result.exitCode === 0 &&
      eventWith(
        trace.events,
        "mcp.server.prepared",
        (event) =>
          event.payload?.status === "failed" &&
          event.payload?.errorCode === "MCP_SERVER_COMMAND_NOT_FOUND",
      ) &&
      has(trace.events, "run.completed"),
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
  }
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
      env: childEnv,
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

async function workspaceWithReadme(prefix) {
  const workspace = await tempDir(prefix);
  await writeFile(join(workspace, "README.md"), "# Demo\n", "utf8");
  return workspace;
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
