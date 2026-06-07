#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_CORE_INTERNAL_IMPORTS = new Map([
  [
    "packages/cli/src/cli.ts",
    "CLI owns the current local reference harness and file-backed trace store.",
  ],
  [
    "packages/cli/src/runners/direct-core-runner.ts",
    "CLI direct-core runner owns the current local reference harness and file-backed trace store.",
  ],
  [
    "packages/host/src/runtime.ts",
    "Host owns the current local reference harness and file-backed trace store.",
  ],
  [
    "packages/streaming-runtime/src/index.ts",
    "Streaming runtime owns a sibling reference loop that currently constructs EventLog.",
  ],
  [
    "examples/custom-tool/register-tool.ts",
    "Example demonstrates the explicit opt-in internal LocalWorkspace reference implementation.",
  ],
]);

const CORE_INTERNAL_IMPORT_PATTERN =
  /\b(?:import|export)\b[\s\S]*?\bfrom\s+["']@sparkwright\/core\/internal["']|import\s*\(\s*["']@sparkwright\/core\/internal["']\s*\)/;

const violations = [];

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
  if (!CORE_INTERNAL_IMPORT_PATTERN.test(source)) continue;
  if (!ALLOWED_CORE_INTERNAL_IMPORTS.has(relative)) {
    violations.push(relative);
  }
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
