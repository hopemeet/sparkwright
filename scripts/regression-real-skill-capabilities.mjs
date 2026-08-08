#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = ["node", "packages/cli/dist/index.js"];
const keepWorkspaces = Boolean(process.env.SPARKWRIGHT_KEEP_REAL_REGRESSION);
const tempRoot = mkdtempSync(join(tmpdir(), "sparkwright-skill-caps-"));
const isolatedXdgConfigHome = join(tempRoot, "xdg-config");
const isolatedXdgStateHome = join(tempRoot, "xdg-state");
const cases = [];

try {
  await staticToolSurfaceCase();
  await deterministicCreateCase();
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

async function staticToolSurfaceCase() {
  const workspace = await createWorkspace("tool-surface");
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
    toolNames.includes("list_skills") &&
    !toolNames.includes("create_skill") &&
    !toolNames.includes("update_skill");

  record({
    id: "SKILL_TOOL_SURFACE",
    name: "model tool surface excludes Skill mutation tools",
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

async function deterministicCreateCase() {
  const workspace = await createWorkspace("deterministic-create");
  const args = [
    "skills",
    "create",
    "release-reviewer",
    "--description",
    "Review release readiness.",
    "--workspace",
    workspace,
    "--format",
    "json",
  ];
  const first = await runCli(args);
  const manifestPath = join(
    workspace,
    ".sparkwright",
    "skills",
    "release-reviewer",
    "SKILL.md",
  );
  const firstHash = fileHash(manifestPath);
  const second = await runCli(args);
  const secondHash = fileHash(manifestPath);
  const content = await readFile(manifestPath, "utf8").catch(() => "");
  const evolutionRoot = join(workspace, ".sparkwright", "skill-evolution");
  const ok =
    first.exitCode === 0 &&
    second.exitCode === 1 &&
    firstHash.length > 0 &&
    firstHash === secondHash &&
    content.includes("name: release-reviewer") &&
    !existsSync(evolutionRoot);

  record({
    id: "DETERMINISTIC_SKILL_CREATE",
    name: "CLI creates once without overwrite or evolution state",
    status: ok ? "passed" : "failed",
    command: commandString(first.command),
    evidence:
      `manifest=${existsSync(manifestPath)}; duplicateExit=${second.exitCode}; ` +
      `unchanged=${firstHash === secondHash}; evolutionState=${existsSync(evolutionRoot)}`,
    reason: ok
      ? undefined
      : failureDetails({
          firstExitCode: first.exitCode,
          secondExitCode: second.exitCode,
          firstStderr: first.stderr,
          secondStderr: second.stderr,
          content,
        }),
  });
}

async function createWorkspace(name) {
  const workspace = join(tempRoot, name);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "README.md"), "# Skill Regression\n", "utf8");
  return workspace;
}

async function runCli(args) {
  const command = [...CLI, ...args];
  const result = await runCommand(command);
  return { ...result, command };
}

async function runCommand(command) {
  const [bin, ...args] = command;
  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        XDG_CONFIG_HOME: isolatedXdgConfigHome,
        XDG_STATE_HOME: isolatedXdgStateHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      resolve({ exitCode: code ?? 1, signal, stdout, stderr });
    });
  });
}

function fileHash(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}

function commandString(command) {
  return command.map((part) => JSON.stringify(part)).join(" ");
}

function record(testCase) {
  cases.push(testCase);
}

function failureDetails(details) {
  return JSON.stringify(details);
}

function printReport() {
  for (const testCase of cases) {
    console.log(
      `${testCase.status.toUpperCase()} ${testCase.id}: ${testCase.name}`,
    );
    if (testCase.command) console.log(`  command: ${testCase.command}`);
    if (testCase.evidence) console.log(`  evidence: ${testCase.evidence}`);
    if (testCase.reason) console.log(`  reason: ${testCase.reason}`);
  }
}
