#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(root, "packages");
const failures = [];
const manifests = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = path.join(packagesRoot, entry.name);
    const manifestPath = path.join(directory, "package.json");
    if (!existsSync(manifestPath)) return undefined;
    return {
      directory,
      relativeDirectory: path.relative(root, directory),
      manifestPath,
      manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
    };
  })
  .filter(Boolean)
  .filter((entry) => entry.manifest.private === false)
  .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));

if (manifests.length === 0) failures.push("no public workspace packages found");

const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry]));
const releaseVersions = new Set(
  manifests.map((entry) => entry.manifest.version),
);
if (releaseVersions.size !== 1) {
  failures.push(
    `public workspace versions are not in lockstep: ${[...releaseVersions].sort().join(", ")}`,
  );
}
const releaseVersion = [...releaseVersions][0];
const lifecycleNames = ["preinstall", "install", "postinstall"];

for (const entry of manifests) {
  const manifest = entry.manifest;
  const label = manifest.name ?? entry.relativeDirectory;
  if (!label.startsWith("@sparkwright/")) {
    failures.push(`${label}: public package must use the @sparkwright scope`);
  }
  if (manifest.publishConfig?.access !== "public") {
    failures.push(`${label}: publishConfig.access must be public`);
  }
  if (!Array.isArray(manifest.files) || !manifest.files.includes("dist")) {
    failures.push(`${label}: files must include dist`);
  }
  for (const lifecycle of lifecycleNames) {
    if (manifest.scripts?.[lifecycle]) {
      failures.push(
        `${label}: first-party ${lifecycle} lifecycle scripts are not allowed`,
      );
    }
  }

  const entrypoints = [];
  addEntrypoint(entrypoints, "main", manifest.main);
  addEntrypoint(entrypoints, "types", manifest.types);
  collectEntrypoints(entrypoints, "exports", manifest.exports);
  collectEntrypoints(entrypoints, "bin", manifest.bin);
  if (entrypoints.length === 0)
    failures.push(`${label}: no entrypoints declared`);
  for (const { field, target } of entrypoints) {
    const normalized = target.replace(/^\.\//, "");
    if (!normalized.startsWith("dist/")) {
      failures.push(`${label}: ${field} must target dist, got ${target}`);
      continue;
    }
    const probe = normalized.includes("*")
      ? normalized.slice(0, normalized.indexOf("*"))
      : normalized;
    const absoluteProbe = path.join(entry.directory, probe);
    const exists = normalized.includes("*")
      ? existsSync(path.dirname(absoluteProbe))
      : existsSync(absoluteProbe);
    if (!exists) {
      failures.push(
        `${label}: ${field} target is missing after build: ${target}`,
      );
    }
  }

  for (const dependencyGroup of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    for (const [dependency, range] of Object.entries(
      manifest[dependencyGroup] ?? {},
    )) {
      if (!dependency.startsWith("@sparkwright/")) continue;
      if (!byName.has(dependency)) {
        failures.push(
          `${label}: ${dependencyGroup}.${dependency} is not a public workspace package`,
        );
      }
      if (range !== releaseVersion) {
        failures.push(
          `${label}: ${dependencyGroup}.${dependency} must be exact ${releaseVersion}, got ${range}`,
        );
      }
    }
  }
}

const lock = JSON.parse(
  readFileSync(path.join(root, "package-lock.json"), "utf8"),
);
for (const entry of manifests) {
  const locked = lock.packages?.[entry.relativeDirectory];
  if (!locked) {
    failures.push(
      `${entry.manifest.name}: package-lock.json is missing ${entry.relativeDirectory}`,
    );
    continue;
  }
  if (
    locked.name !== entry.manifest.name ||
    locked.version !== releaseVersion
  ) {
    failures.push(
      `${entry.manifest.name}: lockfile manifest mismatch (name=${locked.name}, version=${locked.version})`,
    );
  }
}

const publishOrder = topologicalPublishOrder(manifests, byName);
if (publishOrder.length !== manifests.length) {
  failures.push("public @sparkwright dependency graph contains a cycle");
}

if (failures.length > 0) {
  console.error("Release manifest gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Release manifests OK: ${manifests.length} public packages at ${releaseVersion}.`,
);
console.log(`Publish order: ${publishOrder.join(" -> ")}`);

function addEntrypoint(entries, field, target) {
  if (typeof target === "string") entries.push({ field, target });
}

function collectEntrypoints(entries, field, value) {
  if (typeof value === "string") {
    entries.push({ field, target: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectEntrypoints(entries, `${field}[${index}]`, entry),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    collectEntrypoints(entries, `${field}.${key}`, entry);
  }
}

function topologicalPublishOrder(entries, entriesByName) {
  const dependencies = new Map();
  const dependents = new Map(entries.map((entry) => [entry.manifest.name, []]));
  for (const entry of entries) {
    const internal = new Set();
    for (const group of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const dependency of Object.keys(entry.manifest[group] ?? {})) {
        if (entriesByName.has(dependency)) internal.add(dependency);
      }
    }
    dependencies.set(entry.manifest.name, internal);
    for (const dependency of internal) {
      dependents.get(dependency).push(entry.manifest.name);
    }
  }
  const ready = [...dependencies]
    .filter(([, values]) => values.size === 0)
    .map(([name]) => name)
    .sort();
  const ordered = [];
  while (ready.length > 0) {
    const name = ready.shift();
    ordered.push(name);
    for (const dependent of dependents.get(name) ?? []) {
      const remaining = dependencies.get(dependent);
      remaining.delete(name);
      if (remaining.size === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  return ordered;
}
