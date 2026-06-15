#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CLI = ["node", "packages/cli/dist/index.js"];
const DEFAULT_MODEL = "openai/gpt-5.4-mini";
const requestedModel = process.env.SPARKWRIGHT_REAL_MODEL ?? DEFAULT_MODEL;
const keepWorkspaces = Boolean(process.env.SPARKWRIGHT_KEEP_REAL_REGRESSION);
const tempRoot = mkdtempSync(join(tmpdir(), "sparkwright-real-skill-caps-"));
const isolatedXdgConfigHome = join(tempRoot, "xdg-config");
const isolatedXdgStateHome = join(tempRoot, "xdg-state");
const cases = [];

try {
  await staticToolAllowlistCase();
  await scriptedShellManagedPackageGuardCase();

  const availability = configuredModelAvailability(requestedModel);
  if (!availability.available) {
    record({
      id: "SETUP_REAL_MODEL",
      name: "real model availability",
      status: "skipped",
      reason: availability.reason,
    });
  } else {
    await prepareIsolatedUserConfig(availability);
    await realCreateSkillCase();
    await realUpdateSkillProposalCase();
  }

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

async function staticToolAllowlistCase() {
  const workspace = await createWorkspace("static-allowlist");
  await writeProjectConfig(workspace, {
    capabilities: { tools: { enabled: ["shell"] } },
  });

  const result = await runCli([
    "capabilities",
    "inspect",
    "--workspace",
    workspace,
    "--format",
    "json",
  ]);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    report = { parseError: String(error), stdout: result.stdout };
  }

  const toolNames = (report.tools?.available ?? []).map((tool) => tool.name);
  const ok =
    result.exitCode === 0 &&
    includesAll(toolNames, [
      "shell",
      "list_skills",
      "create_skill",
      "update_skill",
    ]) &&
    !toolNames.includes("read_file");

  record({
    id: "SKILL_TOOLS_ALLOWLIST",
    name: "managed skill tools survive shell-only enabled config",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    evidence: `tools=${toolNames.join(",")}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          toolNames,
          stderr: result.stderr,
        }),
  });
}

async function scriptedShellManagedPackageGuardCase() {
  const workspace = await createWorkspace("scripted-shell-guard");
  const script = [
    {
      message: "attempt managed package shell write",
      toolCalls: [
        {
          toolName: "shell",
          arguments: {
            command:
              "mkdir -p .sparkwright/skills/bad-skill && printf bad > .sparkwright/skills/bad-skill/skill.md",
          },
        },
      ],
    },
    { message: "done" },
  ];
  const result = await runCli(
    [
      "run",
      "Attempt to create a skill through shell.",
      "--workspace",
      workspace,
      "--model",
      "scripted",
      "--write",
      "--yes",
      "--trace-level",
      "debug",
    ],
    {
      env: {
        SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify(script),
      },
    },
  );
  const trace = await traceFromOutput(result.stdout);
  const failedShell = trace.events.find(
    (event) =>
      event.type === "tool.failed" &&
      event.payload?.toolName === "shell" &&
      String(event.payload?.error?.message ?? "").includes(
        "dedicated SparkWright capability tools",
      ),
  );
  const lowerSkillFile = join(
    workspace,
    ".sparkwright",
    "skills",
    "bad-skill",
    "skill.md",
  );
  const ok = Boolean(failedShell) && !existsSync(lowerSkillFile);

  record({
    id: "SHELL_MANAGED_PACKAGE_GUARD",
    name: "shell cannot bypass managed skill package mutation",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence: `failedShell=${Boolean(failedShell)}; lowerSkillFile=${existsSync(lowerSkillFile)}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          failedShell: Boolean(failedShell),
          lowerSkillFile: existsSync(lowerSkillFile),
          failures: toolFailures(trace.events),
        }),
  });
}

async function realCreateSkillCase() {
  const workspace = await createWorkspace("real-create");
  await writeProjectConfig(workspace, {
    capabilities: { tools: { enabled: ["shell"] } },
  });
  const prompt =
    "Create a new project skill named release-reviewer for release readiness checks. Use SparkWright skill tools, not shell. Do not modify files except creating the skill.";
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
  const skillEntries = await skillDirEntries(workspace, "release-reviewer");
  const ok =
    result.exitCode === 0 &&
    requests.includes("create_skill") &&
    !requests.includes("shell") &&
    !has(trace.events, "tool.failed") &&
    skillEntries.includes("SKILL.md") &&
    !skillEntries.includes("skill.md") &&
    count(trace.events, "workspace.write.completed") === 1;

  record({
    id: "REAL_SKILL_CREATE",
    name: "real model creates skill through create_skill",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence:
      `tools=${requests.join(",")}; entries=${skillEntries.join(",")}; ` +
      `writes=${count(trace.events, "workspace.write.completed")}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          requests,
          skillEntries,
          failures: toolFailures(trace.events),
          writes: count(trace.events, "workspace.write.completed"),
        }),
  });
}

async function realUpdateSkillProposalCase() {
  const workspace = await createWorkspace("real-update");
  await writeProjectConfig(workspace, {
    capabilities: { tools: { enabled: ["shell"] } },
  });
  await writeSkill(
    workspace,
    "repo-reviewer",
    [
      "---",
      "name: repo-reviewer",
      "description: Reviews repository structure.",
      "---",
      "",
      "Review repository structure and summarize risks.",
      "",
    ].join("\n"),
  );
  const beforeHash = fileHash(
    join(workspace, ".sparkwright", "skills", "repo-reviewer", "SKILL.md"),
  );
  const prompt =
    "Evolve the existing repo-reviewer skill to also check missing test coverage. Create a draft proposal only; do not apply it. Use SparkWright skill tools, not shell.";
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
  const proposals = await listProposalIds(workspace);
  const afterHash = fileHash(
    join(workspace, ".sparkwright", "skills", "repo-reviewer", "SKILL.md"),
  );
  const capabilityMutations = count(
    trace.events,
    "capability.mutation.completed",
  );
  const ok =
    result.exitCode === 0 &&
    includesAll(requests, ["list_skills", "update_skill"]) &&
    !requests.includes("shell") &&
    !has(trace.events, "tool.failed") &&
    proposals.length === 1 &&
    beforeHash === afterHash &&
    capabilityMutations > 0 &&
    count(trace.events, "workspace.write.completed") === 0;

  record({
    id: "REAL_SKILL_UPDATE_PROPOSAL",
    name: "real model drafts skill update proposal without applying",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence:
      `tools=${requests.join(",")}; proposals=${proposals.join(",")}; ` +
      `capabilityMutations=${capabilityMutations}; applied=${beforeHash !== afterHash}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          requests,
          proposals,
          capabilityMutations,
          skillChanged: beforeHash !== afterHash,
          failures: toolFailures(trace.events),
          writes: count(trace.events, "workspace.write.completed"),
        }),
  });
}

async function createWorkspace(name) {
  const workspace = join(tempRoot, name);
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, "README.md"),
    ["# Skill Capability Regression", "", "Temporary project.", ""].join("\n"),
    "utf8",
  );
  return workspace;
}

async function writeProjectConfig(workspace, config) {
  await mkdir(join(workspace, ".sparkwright"), { recursive: true });
  await writeFile(
    join(workspace, ".sparkwright", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

async function writeSkill(workspace, name, content) {
  const dir = join(workspace, ".sparkwright", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf8");
}

async function skillDirEntries(workspace, name) {
  try {
    return await readdir(join(workspace, ".sparkwright", "skills", name));
  } catch {
    return [];
  }
}

async function listProposalIds(workspace) {
  try {
    return await readdir(
      join(workspace, ".sparkwright", "skill-evolution", "proposals"),
    );
  } catch {
    return [];
  }
}

function configuredModelAvailability(model) {
  const [provider, modelId] = model.split("/", 2);
  if (!provider || !modelId) {
    return {
      available: false,
      reason: `model must be provider/model, got ${model}`,
    };
  }

  const mismatches = [];
  for (const file of candidateConfigFiles()) {
    if (!existsSync(file)) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const providerConfig = config.providers?.[provider];
    if (!providerConfig) continue;
    const hasKey =
      Boolean(providerConfig.apiKey) ||
      Boolean(process.env[`${provider.toUpperCase()}_API_KEY`]);
    const hasModel = Boolean(providerConfig.models?.[modelId]);
    if (hasKey && hasModel) {
      return { available: true, configFile: file, provider, modelId };
    }
    mismatches.push(
      `${file}: apiKey=${hasKey ? "present" : "missing"} model=${hasModel ? "present" : "missing"}`,
    );
  }

  return {
    available: false,
    reason:
      mismatches.length > 0
        ? `${model} was not fully available in matching provider configs (${mismatches.join("; ")}).`
        : `No config entry found for ${model}; set SPARKWRIGHT_REAL_MODEL to a configured real model.`,
  };
}

async function prepareIsolatedUserConfig(availability) {
  if (!availability.configFile || !availability.provider) return;
  const raw = JSON.parse(readFileSync(availability.configFile, "utf8"));
  const providerConfig = raw.providers?.[availability.provider];
  if (!providerConfig) return;
  const targetDir = join(isolatedXdgConfigHome, "sparkwright");
  await mkdir(targetDir, { recursive: true });
  await mkdir(isolatedXdgStateHome, { recursive: true });
  await writeFile(
    join(targetDir, "config.json"),
    `${JSON.stringify(
      {
        model: requestedModel,
        providers: {
          [availability.provider]: providerConfig,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function candidateConfigFiles() {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return [
    join(xdg, "sparkwright", "config.json"),
    join(homedir(), ".config", "sparkwright", "config.json"),
    join(homedir(), ".sparkwright", "config.json"),
  ];
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
      env: {
        ...process.env,
        XDG_CONFIG_HOME: isolatedXdgConfigHome,
        XDG_STATE_HOME: isolatedXdgStateHome,
        ...(options.env ?? {}),
      },
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

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function has(events, type) {
  return events.some((event) => event.type === type);
}

function count(events, type) {
  return events.filter((event) => event.type === type).length;
}

function includesAll(values, expected) {
  return expected.every((value) => values.includes(value));
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
