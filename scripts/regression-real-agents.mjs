#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configuredModelAvailability,
  prepareIsolatedUserConfig,
} from "./lib/real-model-config.mjs";

const CLI = ["node", "packages/cli/dist/index.js"];
const DEFAULT_MODEL = "openai/gpt-5.4-mini";
const requestedModel = process.env.SPARKWRIGHT_REAL_MODEL ?? DEFAULT_MODEL;
const keepWorkspaces = Boolean(process.env.SPARKWRIGHT_KEEP_REAL_REGRESSION);
const tempRoot = mkdtempSync(join(tmpdir(), "sparkwright-real-agents-"));
const workspace = join(tempRoot, "workspace");
const isolatedXdgConfigHome = join(tempRoot, "xdg-config");
const isolatedXdgStateHome = join(tempRoot, "xdg-state");
const cases = [];

try {
  const availability = await configuredModelAvailability(requestedModel, {
    runCli,
  });
  if (!availability.available) {
    record({
      id: "SETUP_REAL_MODEL",
      name: "real model availability",
      status: "skipped",
      reason: availability.reason,
    });
    printReport();
    process.exit(0);
  }

  await prepareIsolatedUserConfig(availability, {
    isolatedXdgConfigHome,
    isolatedXdgStateHome,
    requestedModel,
  });
  await createFixture();
  await realCreateAgentCase();
  await realDelegateAgentCase();

  printReport();
  if (cases.some((testCase) => testCase.status === "failed")) {
    process.exitCode = 1;
  }
} finally {
  if (!keepWorkspaces) {
    rmSync(tempRoot, { recursive: true, force: true });
  } else {
    console.log(`kept temp root: ${tempRoot}`);
  }
}

async function createFixture() {
  await mkdir(join(workspace, ".sparkwright"), { recursive: true });
  await writeFile(
    join(workspace, "README.md"),
    [
      "# Agent Regression Fixture",
      "",
      "This project has a tiny API surface and no tests yet.",
      "Reviewers should report missing tests as the concrete risk.",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function realCreateAgentCase() {
  const prompt =
    "Use tool_search to find the create_agent tool, then call create_agent exactly once. Create a child agent with id mini_reviewer, name Mini Reviewer, prompt 'Review README.md and report one concrete project risk.', use ['workspace.read'], allowedTools ['read_file'], maxSteps 4, and delegateToolName delegate_mini_reviewer. After the first create_agent result, stop and answer only: created mini_reviewer. Do not call create_agent more than once. Do not use shell. Do not edit files directly.";
  const result = await runCli([
    "run",
    prompt,
    "--workspace",
    workspace,
    "--model",
    requestedModel,
    "--write",
    "--yes",
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout);
  const requests = toolRequests(trace.events);
  const failures = toolFailures(trace.events);
  const config = await readProjectConfig();
  const verify = await verifyTrace(trace.path);
  const createAgentCalls = requests.filter((name) => name === "create_agent");
  const shellCalls = requests.filter((name) => name === "shell");
  const toolSearchIndex = requests.indexOf("tool_search");
  const createAgentIndex = requests.indexOf("create_agent");
  const agents = config.capabilities?.agents ?? {};
  const profiles = agents.profiles ?? [];
  const delegates = agents.delegateTools ?? [];
  const ok =
    result.exitCode === 0 &&
    toolSearchIndex >= 0 &&
    createAgentIndex >= 0 &&
    toolSearchIndex < createAgentIndex &&
    createAgentCalls.length === 1 &&
    shellCalls.length === 0 &&
    failures.length === 0 &&
    count(trace.events, "workspace.write.completed") === 1 &&
    count(trace.events, "capability.mutation.completed") === 1 &&
    verify.ok === true &&
    profiles.some(
      (profile) =>
        profile.id === "mini_reviewer" &&
        profile.prompt ===
          "Review README.md and report one concrete project risk.",
    ) &&
    delegates.some(
      (delegate) =>
        delegate.profileId === "mini_reviewer" &&
        delegate.toolName === "delegate_mini_reviewer",
    );

  record({
    id: "REAL_AGENT_CREATE",
    name: "real model creates one callable agent profile",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence:
      `tools=${requests.join(",")}; writes=${count(trace.events, "workspace.write.completed")}; ` +
      `mutations=${count(trace.events, "capability.mutation.completed")}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          requests,
          toolSearchIndex,
          createAgentIndex,
          failures,
          verify,
          profiles,
          delegates,
          stderr: result.stderr,
        }),
  });
}

async function realDelegateAgentCase() {
  const prompt =
    "Call delegate_mini_reviewer exactly once to inspect README.md and report one concrete project risk. Do not call create_agent. Do not use shell. After the delegate returns, summarize the risk in one sentence.";
  const result = await runCli([
    "run",
    prompt,
    "--workspace",
    workspace,
    "--model",
    requestedModel,
    "--yes",
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout);
  const requests = toolRequests(trace.events);
  const failures = toolFailures(trace.events);
  const summary = await traceSummary(trace.path);
  const verify = await verifyTrace(trace.path);
  const sessionCheck = await runCli([
    "session",
    "check",
    trace.sessionId,
    "--workspace",
    workspace,
    "--format",
    "json",
  ]);
  const sessionReport = parseJson(sessionCheck.stdout);
  const subagent = trace.events.find(
    (event) => event.type === "subagent.completed",
  );
  const metadata = subagent?.metadata ?? {};
  const ok =
    result.exitCode === 0 &&
    requests.filter((name) => name === "delegate_mini_reviewer").length === 1 &&
    !requests.includes("create_agent") &&
    !requests.includes("shell") &&
    failures.length === 0 &&
    count(trace.events, "workspace.write.completed") === 0 &&
    verify.ok === true &&
    sessionReport.ok === true &&
    summary.agentIds.includes("main") &&
    summary.agentIds.includes("mini_reviewer") &&
    summary.subagentIds.includes("mini_reviewer") &&
    metadata.sessionId === trace.sessionId &&
    metadata.agentId === "main" &&
    metadata.childAgentId === "mini_reviewer" &&
    metadata.agentProfileId === "mini_reviewer" &&
    metadata.entrypoint === "delegate";

  record({
    id: "REAL_AGENT_DELEGATE",
    name: "real model calls created delegate with separated attribution",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence:
      `tools=${requests.join(",")}; agentIds=${summary.agentIds.join(",")}; ` +
      `subagentIds=${summary.subagentIds.join(",")}; child=${metadata.childAgentId}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          requests,
          failures,
          verify,
          sessionReport,
          summary,
          metadata,
          stderr: result.stderr,
        }),
  });
}

async function readProjectConfig() {
  return JSON.parse(
    await readFile(join(workspace, ".sparkwright", "config.json"), "utf8"),
  );
}

async function traceSummary(path) {
  const result = await runCli(["trace", "summary", path, "--format", "json"]);
  return parseJson(result.stdout);
}

async function verifyTrace(path) {
  const result = await runCli(["trace", "verify", path, "--format", "json"]);
  return parseJson(result.stdout);
}

async function runCli(args, options = {}) {
  const command = [...CLI, ...args];
  const result = await runCommand(command, options);
  return { ...result, command };
}

async function runCommand(command, options = {}) {
  const [bin, ...args] = command;
  return await new Promise((resolve) => {
    const env =
      options.isolateConfig === false
        ? {
            ...process.env,
            ...(options.env ?? {}),
          }
        : {
            ...process.env,
            XDG_CONFIG_HOME: isolatedXdgConfigHome,
            XDG_STATE_HOME: isolatedXdgStateHome,
            ...(options.env ?? {}),
          };
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 180_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end();
    child.on("close", (code, signal) => {
      clearTimeout(timer);
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
  const match = stdout.match(/Trace written to (.+)$/m);
  const path = match?.[1].trim();
  if (!path) throw new Error(`No trace path in output:\n${stdout}`);
  const events = await readTrace(path);
  return {
    path,
    events,
    sessionId:
      events.find((event) => event.metadata?.sessionId)?.metadata?.sessionId ??
      path.split("/").at(-2),
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return { parseError: String(error), text };
  }
}

function toolRequests(events) {
  return events
    .filter((event) => event.type === "tool.requested")
    .map((event) => event.payload?.toolName)
    .filter(Boolean);
}

function toolFailures(events) {
  return events
    .filter((event) => event.type === "tool.failed")
    .map((event) => ({
      toolName: event.payload?.toolName,
      code: event.payload?.error?.code,
      message: event.payload?.error?.message,
    }));
}

function count(events, type) {
  return events.filter((event) => event.type === type).length;
}

function failureDetails(value) {
  return JSON.stringify(value, null, 2);
}

function record(testCase) {
  cases.push(testCase);
}

function commandString(command) {
  return command.map(shellQuote).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printReport() {
  console.log(`model: ${requestedModel}`);
  console.log(`temp root: ${tempRoot}`);
  for (const testCase of cases) {
    console.log("");
    console.log(`${testCase.id}: ${testCase.status} - ${testCase.name}`);
    if (testCase.command) console.log(`command: ${testCase.command}`);
    if (testCase.trace) console.log(`trace: ${testCase.trace}`);
    if (testCase.session) console.log(`session: ${testCase.session}`);
    if (testCase.evidence) console.log(`evidence: ${testCase.evidence}`);
    if (testCase.reason) console.log(`reason: ${testCase.reason}`);
  }
}
