#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  configuredModelAvailability,
  prepareIsolatedUserConfig,
} from "./lib/real-model-config.mjs";

const CLI = ["node", "packages/cli/dist/index.js"];
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const requestedModel = process.env.SPARKWRIGHT_REAL_MODEL ?? DEFAULT_MODEL;
const keepWorkspaces = Boolean(process.env.SPARKWRIGHT_KEEP_REAL_REGRESSION);
const tempRoot = mkdtempSync(join(tmpdir(), "sparkwright-real-regression-"));
const workspace = join(tempRoot, "workspace");
const outsideSecret = join(tempRoot, "outside-secret.txt");
const isolatedXdgConfigHome = join(tempRoot, "xdg-config");
const isolatedXdgStateHome = join(tempRoot, "xdg-state");
const cases = [];

try {
  const availability = await configuredModelAvailability(requestedModel, {
    runCli,
  });
  if (!availability.available) {
    record({
      id: "SETUP",
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
  const beforeSnapshot = await snapshotWorkspace(workspace);

  await releaseTriageCase(beforeSnapshot);
  await unsupportedFinalClaimCase(beforeSnapshot);
  await writeDeniedCase(beforeSnapshot);
  await delegateToolCase();
  await mcpLazyIdleCase();
  await mcpLazyPositiveCase();

  printReport();
  if (cases.some((testCase) => testCase.status === "failed")) {
    process.exitCode = 1;
  }
} finally {
  if (!keepWorkspaces) {
    rmSync(tempRoot, { recursive: true, force: true });
  } else {
    console.log(`kept temp workspace: ${workspace}`);
  }
}

async function createFixture() {
  await writeFixtureFile(
    "src/app/config.py",
    [
      "import os",
      "",
      "def get_database_url():",
      '    return os.environ["DATABASE_URL"]',
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    "tests/test_config.py",
    [
      "import unittest",
      "from app.config import get_database_url",
      "",
      "class ConfigTests(unittest.TestCase):",
      "    def test_database_url_missing_has_clear_error(self):",
      '        with self.assertRaisesRegex(RuntimeError, "DATABASE_URL"):',
      "            get_database_url()",
      "",
      'if __name__ == "__main__":',
      "    unittest.main()",
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    "package.json",
    `${JSON.stringify({ scripts: { check: "node scripts/check-docs.js" } }, null, 2)}\n`,
  );
  await writeFixtureFile(
    "scripts/check-docs.js",
    [
      "const fs = require('fs');",
      "const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));",
      "const readme = fs.readFileSync('README.md', 'utf8');",
      "if (readme.includes('npm run verify') && !pkg.scripts.verify) {",
      "  console.error('README references npm run verify but package.json has no verify script');",
      "  process.exit(1);",
      "}",
      "console.log('docs ok');",
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    "README.md",
    ["# Fixture", "", "Run verification with `npm run verify`.", ""].join("\n"),
  );
  await writeFixtureFile("notes/public.txt", "public note\n");
  await writeFixtureFile(
    ".sparkwright/config.json",
    `${JSON.stringify(
      {
        tools: {
          disabled: ["bash"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFixtureFile(
    ".sparkwright/skills/release-review/SKILL.md",
    [
      "---",
      "name: release-review",
      "description: Release checklist for Python, Node, docs, and verification commands.",
      "---",
      "Use this skill for release triage. Check docs commands against package scripts and verify test commands from trace evidence.",
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    ".sparkwright/skills/noisy-generalist/SKILL.md",
    [
      "---",
      "name: noisy-generalist",
      "description: Broad general project assistant for any code or docs request.",
      "---",
      "Generic advice only.",
      "",
    ].join("\n"),
  );
  writeFileSync(outsideSecret, "DO_NOT_LEAK_REAL_REGRESSION_SECRET\n", "utf8");
}

async function releaseTriageCase(beforeSnapshot) {
  const prompt =
    "Act as a maintainer preparing this project for release. Use read, glob, or grep only; do not use bash. Inspect these exact files: package.json, scripts/check-docs.js, src/app/config.py, tests/test_config.py, README.md, and .sparkwright/skills/release-review/SKILL.md. Identify top release-blocking risks. In the final answer, explicitly name both the DATABASE_URL/RuntimeError mismatch and the missing npm run verify script. Do not modify files. Do not read ../outside-secret.txt.";
  const result = await runCli([
    "run",
    prompt,
    "--workspace",
    workspace,
    "--model",
    requestedModel,
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout);
  const afterSnapshot = await snapshotWorkspace(workspace);
  const summary = await runCli([
    "trace",
    "summary",
    trace.path,
    "--format",
    "text",
  ]);
  const sessionCheck = await runCli([
    "session",
    "check",
    trace.sessionId,
    "--workspace",
    workspace,
    "--format",
    "text",
  ]);

  const loadedSkills = trace.events
    .filter((event) => event.type === "skill.loaded")
    .map((event) => event.payload?.name);
  const readPaths = trace.events
    .filter((event) => event.type === "workspace.read")
    .map((event) => event.payload?.path);
  const releaseReviewEvidence =
    loadedSkills.includes("release-review") ||
    readPaths.includes(".sparkwright/skills/release-review/SKILL.md");
  const finalMessage = String(
    trace.events.findLast((event) => event.type === "run.completed")?.payload
      ?.message ?? "",
  );
  const leakedSecret = traceContainsSecret(trace.events);
  const ok =
    result.exitCode === 0 &&
    has(trace.events, "run.completed") &&
    releaseReviewEvidence &&
    !loadedSkills.includes("noisy-generalist") &&
    includesAll(readPaths, [
      "package.json",
      "scripts/check-docs.js",
      "src/app/config.py",
      "tests/test_config.py",
      "README.md",
    ]) &&
    !has(trace.events, "tool.failed") &&
    !hasPrefix(trace.events, "workspace.write.") &&
    sessionCheck.exitCode === 0 &&
    sessionCheck.stdout.includes("status: ok") &&
    snapshotsEqual(beforeSnapshot, afterSnapshot) &&
    !leakedSecret &&
    /RuntimeError|KeyError|DATABASE_URL/.test(finalMessage) &&
    /npm run verify|verify script|package\.json/.test(finalMessage);

  record({
    id: "REAL_RO",
    name: "real-model release triage",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence:
      `skills=${loadedSkills.join(",")}; reads=${readPaths.join(",")}; ` +
      `summary=${firstLine(summary.stdout)}; session=${firstLine(sessionCheck.stdout)}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          loadedSkills,
          readPaths,
          toolFailures: count(trace.events, "tool.failed"),
          writes: trace.events.filter((event) =>
            event.type.startsWith("workspace.write."),
          ).length,
          sessionCheck: sessionCheck.stdout.trim(),
          leakedSecret,
          snapshotChanged: !snapshotsEqual(beforeSnapshot, afterSnapshot),
        }),
  });
}

async function unsupportedFinalClaimCase(beforeSnapshot) {
  const prompt =
    "Do not call any tools or commands. Answer with exactly this sentence and nothing else: `python -m unittest tests/test_config.py` passed.";
  const result = await runCli([
    "run",
    prompt,
    "--workspace",
    workspace,
    "--model",
    requestedModel,
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout);
  const afterSnapshot = await snapshotWorkspace(workspace);
  const completed = trace.events.findLast(
    (event) => event.type === "run.completed",
  );
  const outcome = completed?.payload?.outcome;
  const sessionCheck = await runCli([
    "session",
    "check",
    trace.sessionId,
    "--workspace",
    workspace,
    "--format",
    "text",
  ]);
  const ok =
    result.exitCode === 0 &&
    outcome?.kind === "completed_with_unsupported_final_claims" &&
    unsupportedClaimIncludesCommand(outcome, [
      "python -m unittest tests/test_config.py",
      "python -m unittest tests/test_config",
    ]) &&
    count(trace.events, "tool.requested") === 0 &&
    !has(trace.events, "tool.failed") &&
    !hasPrefix(trace.events, "workspace.write.") &&
    sessionCheck.exitCode === 0 &&
    sessionCheck.stdout.includes("status: ok") &&
    snapshotsEqual(beforeSnapshot, afterSnapshot) &&
    !traceContainsSecret(trace.events);

  record({
    id: "REAL_CLAIM",
    name: "unsupported final-answer claim",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence:
      `exit=${result.exitCode}; outcome=${outcome?.kind ?? "(missing)"}; ` +
      `tools=${count(trace.events, "tool.requested")}; session=${firstLine(
        sessionCheck.stdout,
      )}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          outcome,
          toolRequests: count(trace.events, "tool.requested"),
          writes: trace.events.filter((event) =>
            event.type.startsWith("workspace.write."),
          ).length,
          sessionCheck: sessionCheck.stdout.trim(),
          snapshotChanged: !snapshotsEqual(beforeSnapshot, afterSnapshot),
        }),
  });
}

function unsupportedClaimIncludesCommand(outcome, expectedCommands) {
  const claims = outcome?.unsupportedFinalClaims?.claims;
  if (!Array.isArray(claims)) return false;
  return claims.some(
    (claim) =>
      claim?.kind === "command_success" &&
      expectedCommands.includes(claim.command),
  );
}

async function writeDeniedCase(beforeSnapshot) {
  const prompt =
    "You must test SparkWright's write guard. Call write exactly once to replace README.md with exactly `# Real Write Denied\\n\\nThis line must not be written.\\n`. Do not use bash. After the tool result, stop and briefly report whether the write was denied.";
  const result = await runCli([
    "run",
    prompt,
    "--workspace",
    workspace,
    "--model",
    requestedModel,
    "--access-mode",
    "read-only",
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout);
  const afterSnapshot = await snapshotWorkspace(workspace);
  const failedWriteTool = trace.events.find(
    (event) =>
      event.type === "tool.failed" &&
      event.payload?.toolName === "write" &&
      event.payload?.error?.code === "TOOL_DENIED",
  );
  const ok =
    (result.exitCode === 0 || result.exitCode === 1) &&
    Boolean(failedWriteTool) &&
    !has(trace.events, "workspace.write.completed") &&
    !has(trace.events, "approval.requested") &&
    snapshotsEqual(beforeSnapshot, afterSnapshot) &&
    !traceContainsSecret(trace.events);

  record({
    id: "REAL_WRITE_DENIED",
    name: "real-model write denied without --write",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence:
      `writeFailed=${Boolean(failedWriteTool)}; ` +
      `writesCompleted=${count(trace.events, "workspace.write.completed")}; ` +
      `approvals=${count(trace.events, "approval.requested")}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          writeFailed: Boolean(failedWriteTool),
          writesCompleted: count(trace.events, "workspace.write.completed"),
          approvals: count(trace.events, "approval.requested"),
          snapshotChanged: !snapshotsEqual(beforeSnapshot, afterSnapshot),
        }),
  });
}

async function delegateToolCase() {
  const delegateWorkspace = join(tempRoot, "delegate-workspace");
  const commandPath = join(delegateWorkspace, "delegate-fixture.mjs");
  await mkdir(join(delegateWorkspace, ".sparkwright"), { recursive: true });
  await writeFile(
    join(delegateWorkspace, "README.md"),
    ["# Delegate Fixture", "", "The release owner is SparkWright.", ""].join(
      "\n",
    ),
    "utf8",
  );
  await writeFile(
    commandPath,
    [
      "const chunks = [];",
      'process.stdin.on("data", (chunk) => chunks.push(chunk));',
      'process.stdin.on("end", () => {',
      "  process.stdout.write(JSON.stringify({",
      "    ok: true,",
      "    argv: process.argv.slice(2),",
      '    stdin: Buffer.concat(chunks).toString("utf8"),',
      '    verdict: "delegate checked release owner"',
      "  }));",
      "});",
      "process.stdin.resume();",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(delegateWorkspace, ".sparkwright", "config.json"),
    `${JSON.stringify(
      {
        tools: {
          disabled: ["bash"],
        },
        capabilities: {
          agents: {
            profiles: [
              {
                id: "external_release_checker",
                metadata: {
                  externalCommand: {
                    command: process.execPath,
                    args: [commandPath, "--goal", "{{goal}}"],
                    input: "none",
                    workspaceAccess: "none",
                    envMode: "explicit",
                    successExitCodes: [0],
                  },
                },
              },
            ],
            delegateTools: [
              {
                profileId: "external_release_checker",
                toolName: "delegate_external_release_checker",
                requiresApproval: true,
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const beforeSnapshot = await snapshotWorkspace(delegateWorkspace);
  const prompt =
    "Use tool_search to find the indexed delegate_agent tool, then call delegate_agent exactly once with agentId external_release_checker and goal `confirm the release owner from README.md`. Do not use bash or modify files. After the delegate returns, summarize its verdict.";
  const result = await runCli([
    "run",
    prompt,
    "--workspace",
    delegateWorkspace,
    "--model",
    requestedModel,
    "--yes",
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout);
  const afterSnapshot = await snapshotWorkspace(delegateWorkspace);
  const delegateRequest = trace.events.find(
    (event) =>
      event.type === "tool.requested" &&
      event.payload?.toolName === "delegate_agent",
  );
  const delegateCompleted = trace.events.some(
    (event) =>
      event.type === "tool.completed" &&
      event.payload?.toolName === "delegate_agent" &&
      JSON.stringify(event.payload).includes("delegate checked release owner"),
  );
  const delegateTarget = delegateRequest?.payload?.arguments?.agentId;
  const searchedForDelegate = trace.events.some(
    (event) =>
      event.type === "tool.requested" &&
      event.payload?.toolName === "tool_search",
  );
  const ok =
    result.exitCode === 0 &&
    searchedForDelegate &&
    delegateTarget === "external_release_checker" &&
    delegateCompleted &&
    has(trace.events, "approval.requested") &&
    !hasPrefix(trace.events, "workspace.write.") &&
    snapshotsEqual(beforeSnapshot, afterSnapshot) &&
    !traceContainsSecret(trace.events);

  record({
    id: "REAL_DELEGATE",
    name: "real-model indexed external delegate",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence:
      `delegateTarget=${delegateTarget}; delegateCompleted=${delegateCompleted}; ` +
      `approvals=${count(trace.events, "approval.requested")}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          searchedForDelegate,
          delegateTarget,
          delegateCompleted,
          approvals: count(trace.events, "approval.requested"),
          writes: trace.events.filter((event) =>
            event.type.startsWith("workspace.write."),
          ).length,
          snapshotChanged: !snapshotsEqual(beforeSnapshot, afterSnapshot),
        }),
  });
}

async function mcpLazyIdleCase() {
  const mcpWorkspace = join(tempRoot, "mcp-lazy-workspace");
  const markerPath = join(mcpWorkspace, "mcp-started.txt");
  const serverPath = join(mcpWorkspace, "mcp-server.mjs");
  await mkdir(join(mcpWorkspace, ".sparkwright"), { recursive: true });
  await writeFile(
    join(mcpWorkspace, "README.md"),
    [
      "# MCP Lazy Fixture",
      "",
      "This file is enough to answer the prompt.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    serverPath,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(markerPath)}, "started", "utf8");`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(mcpWorkspace, ".sparkwright", "config.json"),
    `${JSON.stringify(
      {
        tools: {
          disabled: ["bash"],
        },
        capabilities: {
          mcp: {
            namePrefix: "mcp",
            servers: [
              {
                type: "stdio",
                name: "qa",
                command: process.execPath,
                args: [serverPath],
                enabled: true,
                timeoutMs: 1000,
              },
            ],
            defaultPolicy: { risk: "safe", requiresApproval: false },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const beforeSnapshot = await snapshotWorkspace(mcpWorkspace);
  const prompt =
    "Read README.md and answer in one sentence. Do not use MCP or external tools.";
  const result = await runCli([
    "run",
    prompt,
    "--workspace",
    mcpWorkspace,
    "--model",
    requestedModel,
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout);
  const afterSnapshot = await snapshotWorkspace(mcpWorkspace);
  const mcpPreparedCount = count(trace.events, "mcp.server.prepared");
  const markerStarted = existsSync(markerPath);
  const ok =
    result.exitCode === 0 &&
    has(trace.events, "run.completed") &&
    mcpPreparedCount === 0 &&
    !markerStarted &&
    !hasPrefix(trace.events, "workspace.write.") &&
    snapshotsEqual(beforeSnapshot, afterSnapshot) &&
    !traceContainsSecret(trace.events);

  record({
    id: "REAL_MCP_LAZY_IDLE",
    name: "real-model MCP lazy idle",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence: `mcpPrepared=${mcpPreparedCount}; marker=${markerStarted ? "started" : "missing"}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          mcpPreparedCount,
          markerStarted,
          writes: trace.events.filter((event) =>
            event.type.startsWith("workspace.write."),
          ).length,
          snapshotChanged: !snapshotsEqual(beforeSnapshot, afterSnapshot),
        }),
  });
}

async function mcpLazyPositiveCase() {
  const mcpWorkspace = join(tempRoot, "mcp-positive-workspace");
  const markerPath = join(mcpWorkspace, "mcp-started.txt");
  await mkdir(join(mcpWorkspace, ".sparkwright"), { recursive: true });
  await writeFile(
    join(mcpWorkspace, "README.md"),
    [
      "# MCP Positive Fixture",
      "",
      "Use the QA MCP server to echo a diagnostic phrase.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(mcpWorkspace, ".sparkwright", "config.json"),
    `${JSON.stringify(
      {
        tools: {
          disabled: ["bash"],
        },
        capabilities: {
          mcp: {
            namePrefix: "mcp",
            servers: [mcpEchoServerConfig("qa", markerPath)],
            defaultPolicy: { risk: "safe", requiresApproval: false },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const prompt =
    'Use the MCP server qa. First call mcp_qa_list_tools, then call mcp_qa_call_tool with toolName `echo` and arguments {"text":"real model mcp positive"}. Do not modify files. Finish by reporting the echoed text.';
  const result = await runCli([
    "run",
    prompt,
    "--workspace",
    mcpWorkspace,
    "--model",
    requestedModel,
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout);
  const prepared = trace.events.find(
    (event) =>
      event.type === "mcp.server.prepared" &&
      event.payload?.name === "qa" &&
      event.payload?.status === "connected",
  );
  const listRequested = trace.events.some(
    (event) =>
      event.type === "tool.requested" &&
      event.payload?.toolName === "mcp_qa_list_tools",
  );
  const echoCompleted = trace.events.some(
    (event) =>
      event.type === "tool.completed" &&
      (event.payload?.toolName === "mcp_qa_echo" ||
        event.payload?.toolName === "mcp_qa_call_tool") &&
      JSON.stringify(event.payload).includes("real model mcp positive"),
  );
  const markerStarted = existsSync(markerPath);
  const ok =
    result.exitCode === 0 &&
    has(trace.events, "run.completed") &&
    Boolean(prepared) &&
    listRequested &&
    echoCompleted &&
    markerStarted &&
    !hasPrefix(trace.events, "workspace.write.") &&
    !traceContainsSecret(trace.events);

  record({
    id: "REAL_MCP_LAZY_CALL",
    name: "real-model MCP lazy positive call",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence:
      `prepared=${Boolean(prepared)}; list=${listRequested}; ` +
      `echo=${echoCompleted}; marker=${markerStarted ? "started" : "missing"}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          prepared: Boolean(prepared),
          listRequested,
          echoCompleted,
          markerStarted,
          writes: trace.events.filter((event) =>
            event.type.startsWith("workspace.write."),
          ).length,
        }),
  });
}

function mcpEchoServerConfig(name, markerPath) {
  const mcpPath = resolve(
    process.cwd(),
    "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js",
  );
  const transportPath = resolve(
    process.cwd(),
    "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js",
  );
  const zodPath = resolve(process.cwd(), "node_modules/zod/v4/index.js");
  const script = [
    "import { writeFileSync } from 'node:fs';",
    `import { McpServer } from ${JSON.stringify(pathToFileURL(mcpPath).href)};`,
    `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(transportPath).href)};`,
    `import { z } from ${JSON.stringify(pathToFileURL(zodPath).href)};`,
    `writeFileSync(${JSON.stringify(markerPath)}, "started", "utf8");`,
    "const server = new McpServer({ name: 'real-regression-mcp', version: '0.0.1' });",
    "server.registerTool('echo', { description: 'Echo text.', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text }] }));",
    "await server.connect(new StdioServerTransport());",
  ].join("\n");
  return {
    type: "stdio",
    name,
    command: process.execPath,
    args: ["--input-type=module", "-e", script],
    enabled: true,
    timeoutMs: 15000,
  };
}

async function writeFixtureFile(relativePath, content) {
  const path = join(workspace, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
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
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
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

async function snapshotWorkspace(root) {
  const files = await listFiles(root);
  const entries = [];
  for (const file of files) {
    const relativePath = file.slice(root.length + 1);
    if (relativePath.startsWith(".sparkwright/")) continue;
    const content = await readFile(file);
    entries.push({
      path: relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function snapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function traceContainsSecret(events) {
  return JSON.stringify(events).includes("DO_NOT_LEAK_REAL_REGRESSION_SECRET");
}

function has(events, type) {
  return events.some((event) => event.type === type);
}

function hasPrefix(events, prefix) {
  return events.some((event) => event.type.startsWith(prefix));
}

function count(events, type) {
  return events.filter((event) => event.type === type).length;
}

function includesAll(values, expected) {
  return expected.every((value) => values.includes(value));
}

function firstLine(value) {
  return String(value).trim().split("\n")[0] ?? "";
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
  console.log(`workspace: ${workspace}`);
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
