#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const packages = new Map(
  [
    "packages/core/package.json",
    "packages/protocol/package.json",
    "packages/host/package.json",
    "packages/tui/package.json",
    "packages/sdk-core/package.json",
    "packages/sdk-browser/package.json",
  ].map((relativePath) => {
    const manifest = JSON.parse(
      readFileSync(path.join(root, relativePath), "utf8"),
    );
    return [manifest.name, { manifest, relativePath }];
  }),
);

const violations = [];

noWorkspaceDependencies(
  "@sparkwright/core",
  "core must stay below workspace runtime/client packages.",
);
noWorkspaceDependencies(
  "@sparkwright/protocol",
  "protocol must stay a leaf of shared wire contracts.",
);
mustNotDependOn(
  "@sparkwright/host",
  [
    "@sparkwright/cli",
    "@sparkwright/tui",
    "@sparkwright/sdk-node",
    "@sparkwright/sdk-browser",
  ],
  "host must not depend on entrypoints or clients.",
);
mustNotDependOn(
  "@sparkwright/tui",
  ["@sparkwright/core"],
  "TUI must stay a host/protocol client, not a direct core runner.",
);
mustNotDependOn(
  "@sparkwright/sdk-core",
  ["@sparkwright/core", "@sparkwright/host"],
  "sdk-core must stay transport/protocol-only.",
);
mustNotDependOn(
  "@sparkwright/sdk-browser",
  ["@sparkwright/core", "@sparkwright/host"],
  "sdk-browser must stay browser-safe and avoid runtime packages.",
);

if (violations.length > 0) {
  console.error("Package boundary violations:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Package dependency boundaries OK.");

function noWorkspaceDependencies(packageName, reason) {
  const entry = requirePackage(packageName);
  for (const dependency of workspaceDependencies(entry.manifest)) {
    violations.push(
      `${entry.relativePath}: ${packageName} depends on ${dependency.name} in ${dependency.field}; ${reason}`,
    );
  }
}

function mustNotDependOn(packageName, forbiddenNames, reason) {
  const entry = requirePackage(packageName);
  const forbidden = new Set(forbiddenNames);
  for (const dependency of dependencies(entry.manifest)) {
    if (!forbidden.has(dependency.name)) continue;
    violations.push(
      `${entry.relativePath}: ${packageName} depends on ${dependency.name} in ${dependency.field}; ${reason}`,
    );
  }
}

function requirePackage(packageName) {
  const entry = packages.get(packageName);
  if (!entry) {
    throw new Error(`Missing package boundary manifest for ${packageName}`);
  }
  return entry;
}

function workspaceDependencies(manifest) {
  return dependencies(manifest).filter((dependency) =>
    dependency.name.startsWith("@sparkwright/"),
  );
}

function dependencies(manifest) {
  const result = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      result.push({ field, name });
    }
  }
  return result;
}
