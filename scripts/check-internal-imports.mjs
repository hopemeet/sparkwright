#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_CORE_INTERNAL_IMPORTS = new Map([
  [
    "packages/agent-runtime/src/index.ts",
    "Agent runtime composes the unstable reference prompt builder around public run contracts.",
  ],
  [
    "packages/cli/src/cli.ts",
    "CLI owns the current local reference harness and file-backed trace store.",
  ],
  [
    "packages/cli/src/runners/direct-core-runner.ts",
    "CLI direct-core runner owns the current local reference harness and file-backed trace store.",
  ],
  [
    "packages/cli/src/commands/trace-session.ts",
    "CLI trace/session commands own the direct-core resume reference harness and file-backed trace store.",
  ],
  [
    "packages/host/src/runtime/host-runtime.ts",
    "Host owns the current local reference harness and file-backed trace store.",
  ],
  [
    "packages/host/src/delegate-runner.ts",
    "Host delegate execution owns session-scoped reference trace persistence.",
  ],
  [
    "packages/host/src/execution-resources.ts",
    "Host execution assembly owns local workspace and in-memory trace reference implementations.",
  ],
  [
    "packages/host/src/failure-trace.ts",
    "Host start-failure recording owns EventLog and session-scoped reference trace persistence.",
  ],
  [
    "packages/host/src/host-execution.ts",
    "Host execution carries the internal in-memory trace implementation between episodes.",
  ],
  [
    "packages/host/src/workspace-snapshot.ts",
    "Host workspace snapshots use the local workspace reference implementation for guarded restoration.",
  ],
  [
    "packages/agent-runtime/src/doc-store/index.ts",
    "Agent-runtime doc-store is the public wrapper around core file-atomic helpers while core stays below runtime packages.",
  ],
  [
    "packages/streaming-runtime/src/index.ts",
    "Streaming runtime owns a sibling reference loop that currently constructs EventLog.",
  ],
  [
    "packages/cron/src/runner.ts",
    "Cron runner owns its local workspace and session-scoped reference trace persistence.",
  ],
  [
    "packages/project-context/src/index.ts",
    "Project context composes the unstable reference prompt-section implementation behind its public builder.",
  ],
  [
    "examples/custom-tool/register-tool.ts",
    "Example demonstrates the explicit opt-in internal LocalWorkspace reference implementation.",
  ],
]);

const CORE_INTERNAL_IMPORT_PATTERN =
  /\b(?:import|export)\b[\s\S]*?\bfrom\s+["']@sparkwright\/core\/internal["']|import\s*\(\s*["']@sparkwright\/core\/internal["']\s*\)/;
const CORE_IMPORT_PATTERN =
  /\b(?:import|export)\b[\s\S]*?\bfrom\s+["']@sparkwright\/core(?:\/internal)?["']|import\s*\(\s*["']@sparkwright\/core(?:\/internal)?["']\s*\)/;

const violations = [];
const tuiCoreViolations = [];

for (const file of walk(root)) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (
    relative.startsWith("node_modules/") ||
    relative.includes("/node_modules/") ||
    relative.includes("/dist/") ||
    relative.startsWith(".git/")
  ) {
    continue;
  }
  if (!/\.[cm]?[jt]sx?$/.test(relative)) continue;

  const source = readFileSync(file, "utf8");
  if (
    relative.startsWith("packages/tui/src/") &&
    CORE_IMPORT_PATTERN.test(source)
  ) {
    tuiCoreViolations.push(relative);
  }
  if (!CORE_INTERNAL_IMPORT_PATTERN.test(source)) continue;
  if (
    !ALLOWED_CORE_INTERNAL_IMPORTS.has(relative) &&
    !/^packages\/[^/]+\/test\//.test(relative)
  ) {
    violations.push(relative);
  }
}

if (tuiCoreViolations.length > 0) {
  console.error("Unexpected @sparkwright/core imports in TUI source:");
  for (const violation of tuiCoreViolations) {
    console.error(`- ${violation}`);
  }
  console.error(
    "\nTUI must stay a host/protocol client. Use @sparkwright/protocol, @sparkwright/sdk-node, or @sparkwright/host client helpers instead.",
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error("Unexpected @sparkwright/core/internal imports:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error("\nAllowed imports are:");
  for (const [file, reason] of ALLOWED_CORE_INTERNAL_IMPORTS) {
    console.error(`- ${file}: ${reason}`);
  }
  process.exit(1);
}

console.log("Core internal import allowlist OK.");

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === ".git" ||
      entry.name === "dist" ||
      entry.name === "node_modules"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}
