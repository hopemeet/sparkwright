#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(root, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const packages = lock.packages ?? {};
const failures = [];

for (const [entry, meta] of Object.entries(packages)) {
  if (!entry.startsWith("packages/") && !entry.startsWith("examples/")) {
    continue;
  }
  if (!meta || typeof meta !== "object" || !("name" in meta)) continue;
  const manifest = path.join(root, entry, "package.json");
  if (!existsSync(manifest)) {
    failures.push(`lockfile package entry has no manifest: ${entry}`);
  }
}

for (const [entry, meta] of Object.entries(packages)) {
  if (!entry.startsWith("node_modules/@sparkwright/")) continue;
  if (!meta || typeof meta !== "object" || meta.link !== true) continue;
  const resolved = meta.resolved;
  if (typeof resolved !== "string") {
    failures.push(`workspace link is missing resolved path: ${entry}`);
    continue;
  }
  const manifest = path.join(root, resolved, "package.json");
  if (!existsSync(manifest)) {
    failures.push(
      `workspace link target has no manifest: ${entry} -> ${resolved}`,
    );
  }
}

const ls = spawnSync(npmCommand(), ["ls", "--depth=0", "--json"], {
  cwd: root,
  encoding: "utf8",
  shell: process.platform === "win32",
});
const lsJson = parseJson(ls.stdout);
if (lsJson && typeof lsJson === "object") {
  for (const [name, dep] of Object.entries(lsJson.dependencies ?? {})) {
    if (
      name.startsWith("@sparkwright/") &&
      dep &&
      typeof dep === "object" &&
      dep.extraneous === true
    ) {
      failures.push(`extraneous workspace dependency: ${name}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Workspace lockfile consistency failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Workspace lockfile consistency OK.");

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
