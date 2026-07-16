#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configuredModelAvailability,
  prepareIsolatedUserConfig as prepareIsolatedRealModelConfig,
} from "./lib/real-model-config.mjs";

const CLI = ["node", "packages/cli/dist/index.js"];
const DEFAULT_MODEL = "openai/gpt-5.4-mini";
const requestedModel = process.env.SPARKWRIGHT_REAL_MODEL ?? DEFAULT_MODEL;
const keepWorkspaces = Boolean(process.env.SPARKWRIGHT_KEEP_REAL_REGRESSION);
const tempRoot = mkdtempSync(join(tmpdir(), "sparkwright-real-skill-caps-"));
const isolatedXdgConfigHome = join(tempRoot, "xdg-config");
const isolatedXdgStateHome = join(tempRoot, "xdg-state");
const cases = [];

try {
  await staticToolDisabledCase();
  await scriptedShellManagedPackageGuardCase();

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

async function staticToolDisabledCase() {
  const workspace = await createWorkspace("static-disabled");
  await writeProjectConfig(workspace, {
    tools: { disabled: ["bash"] },
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
    includesAll(toolNames, ["list_skills", "create_skill", "update_skill"]) &&
    !toolNames.includes("bash") &&
    toolNames.includes("read");

  record({
    id: "SKILL_TOOLS_ALLOWLIST",
    name: "managed skill tools survive disabled shell config",
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
  const workspace = await createWorkspace("scripted-bash-guard");
  const script = [
    {
      message: "attempt managed package bash write",
      toolCalls: [
        {
          toolName: "bash",
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
      "Attempt to create a skill through bash.",
      "--workspace",
      workspace,
      "--model",
      "scripted",
      "--access-mode",
      "bypass",
      "--trace-level",
      "debug",
    ],
    {
      env: {
        SPARKWRIGHT_SCRIPTED_MODEL_JSON: JSON.stringify(script),
      },
    },
  );
  const trace = await traceFromOutput(result.stdout, { workspace });
  const failedBash = trace.events.find(
    (event) =>
      event.type === "tool.failed" &&
      event.payload?.toolName === "bash" &&
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
  const ok = Boolean(failedBash) && !existsSync(lowerSkillFile);

  record({
    id: "BASH_MANAGED_PACKAGE_GUARD",
    name: "bash cannot bypass managed skill package mutation",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence: `failedBash=${Boolean(failedBash)}; lowerSkillFile=${existsSync(lowerSkillFile)}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          failedBash: Boolean(failedBash),
          lowerSkillFile: existsSync(lowerSkillFile),
          failures: toolFailures(trace.events),
        }),
  });
}

async function realCreateSkillCase() {
  const workspace = await createWorkspace("real-create");
  await writeProjectConfig(workspace, {
    tools: { disabled: ["bash"] },
  });
  const prompt =
    "Create a new project skill named release-reviewer for release readiness checks. Use tool_search to find list_skills/create_skill as needed, call create_skill exactly once, omit the root argument so SparkWright uses the project skill root, then stop immediately and answer with the created path. Do not use bash. Do not modify files except creating the skill.";
  const result = await runCli([
    "run",
    prompt,
    "--workspace",
    workspace,
    "--model",
    requestedModel,
    "--access-mode",
    "bypass",
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout, { workspace });
  const requests = toolRequests(trace.events);
  const skillEntries = await skillDirEntries(workspace, "release-reviewer");
  const proposals = await listProposalIds(workspace);
  const proposedEntries =
    proposals.length === 1
      ? await proposalSkillEntries(workspace, proposals[0], "release-reviewer")
      : [];
  const proposalMetadata =
    proposals.length === 1
      ? await readJsonIfExists(
          join(
            workspace,
            ".sparkwright",
            "skill-evolution",
            "proposals",
            proposals[0],
            "metadata.json",
          ),
        )
      : undefined;
  const proposalPath =
    proposals.length === 1
      ? join(
          workspace,
          ".sparkwright",
          "skill-evolution",
          "proposals",
          proposals[0],
        )
      : undefined;
  const historyIds = await listHistoryIds(workspace, "release-reviewer");
  const failures = toolFailures(trace.events);
  const outcome = runOutcome(trace.events);
  const recoveredCreateSkillFailures =
    failures.length > 0 &&
    // This canary specifically asserts the runtime repeat-skip recovery path.
    // Keep the allowlist to REPEATED_TOOL_CALL_SKIPPED only: any other failure
    // code (e.g. TOOL_ARGUMENTS_INVALID) is a distinct mode that should fail
    // loudly here rather than be silently absorbed.
    failures.every(
      (failure) =>
        failure.toolName === "create_skill" &&
        failure.code === "REPEATED_TOOL_CALL_SKIPPED",
    ) &&
    outcome?.failing === false;
  const ok =
    result.exitCode === 0 &&
    requests.includes("tool_search") &&
    requests.includes("create_skill") &&
    !requests.includes("bash") &&
    (failures.length === 0 || recoveredCreateSkillFailures) &&
    skillEntries.includes("SKILL.md") &&
    proposals.length === 1 &&
    proposedEntries.includes("SKILL.md") &&
    !proposedEntries.includes("skill.md") &&
    proposalMetadata?.state === "applied" &&
    proposalMetadata?.preparedState === "applied" &&
    Boolean(proposalPath && existsSync(join(proposalPath, "approval.json"))) &&
    Boolean(
      proposalPath && existsSync(join(proposalPath, "mutation-receipt.json")),
    ) &&
    historyIds.length === 1 &&
    has(trace.events, "approval.requested") &&
    count(trace.events, "capability.mutation.completed") > 0 &&
    count(trace.events, "workspace.write.completed") === 0;

  record({
    id: "REAL_SKILL_CREATE",
    name: "real model safely creates and applies an authored skill",
    status: ok ? "passed" : "failed",
    command: commandString(result.command),
    trace: trace.path,
    session: trace.sessionId,
    evidence:
      `tools=${requests.join(",")}; appliedEntries=${skillEntries.join(",")}; ` +
      `proposals=${proposals.join(",")}; proposedEntries=${proposedEntries.join(",")}; ` +
      `proposalState=${proposalMetadata?.state}; history=${historyIds.join(",")}; ` +
      `capabilityMutations=${count(trace.events, "capability.mutation.completed")}; ` +
      `writes=${count(trace.events, "workspace.write.completed")}`,
    reason: ok
      ? undefined
      : failureDetails({
          exitCode: result.exitCode,
          requests,
          skillEntries,
          proposals,
          proposedEntries,
          proposalMetadata,
          historyIds,
          failures,
          outcome,
          capabilityMutations: count(
            trace.events,
            "capability.mutation.completed",
          ),
          writes: count(trace.events, "workspace.write.completed"),
        }),
  });
}

async function realUpdateSkillProposalCase() {
  const workspace = await createWorkspace("real-update");
  await writeProjectConfig(workspace, {
    tools: { disabled: ["bash"] },
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
    "Evolve the existing repo-reviewer skill to also check missing test coverage. Use tool_search to find the managed Skill tools, call list_skills exactly once to inspect the existing project skills, call update_skill exactly once to create one draft proposal, then stop immediately and answer with the proposal id. Do not apply it. Do not use bash.";
  const result = await runCli([
    "run",
    prompt,
    "--workspace",
    workspace,
    "--model",
    requestedModel,
    "--access-mode",
    "bypass",
    "--trace-level",
    "debug",
  ]);
  const trace = await traceFromOutput(result.stdout, { workspace });
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
    requests.includes("tool_search") &&
    includesAll(requests, ["list_skills", "update_skill"]) &&
    !requests.includes("bash") &&
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

async function proposalSkillEntries(workspace, proposalId, name) {
  try {
    return await readdir(
      join(
        workspace,
        ".sparkwright",
        "skill-evolution",
        "proposals",
        proposalId,
        "after",
        name,
      ),
    );
  } catch {
    return [];
  }
}

async function listHistoryIds(workspace, name) {
  try {
    return await readdir(
      join(workspace, ".sparkwright", "skill-evolution", "history", name),
    );
  } catch {
    return [];
  }
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function prepareIsolatedUserConfig(availability) {
  await prepareIsolatedRealModelConfig(availability, {
    isolatedXdgConfigHome,
    isolatedXdgStateHome,
    requestedModel,
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

async function traceFromOutput(stdout, options = {}) {
  const match =
    stdout.match(/Trace written to (.+)$/m) ??
    stdout.match(/Validation trace written to (.+)$/m);
  const path = match?.[1].trim() ?? (await newestWorkspaceTrace(options));
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

async function newestWorkspaceTrace(options) {
  if (!options.workspace) return undefined;
  const sessionRoot = join(options.workspace, ".sparkwright", "sessions");
  let entries;
  try {
    entries = await readdir(sessionRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const traces = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(sessionRoot, entry.name, "trace.jsonl");
          const info = await stat(path).catch(() => undefined);
          return info?.isFile() ? { path, mtimeMs: info.mtimeMs } : undefined;
        }),
    )
  ).filter(Boolean);
  traces.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return traces[0]?.path;
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

function runOutcome(events) {
  return events.findLast((event) => event.type === "run.completed")?.payload
    ?.outcome;
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
