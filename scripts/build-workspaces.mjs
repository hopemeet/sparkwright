import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const rootPackage = readPackage(root);
const workspaceDirs = discoverWorkspaceDirs(rootPackage.workspaces ?? []);
const workspaces = workspaceDirs
  .map((dir) => ({ dir, packageJson: readPackage(join(root, dir)) }))
  .filter(({ packageJson }) => packageJson.scripts?.build)
  .sort((a, b) => a.dir.localeCompare(b.dir));
const byName = new Map(
  workspaces.map((workspace) => [workspace.packageJson.name, workspace]),
);
const ordered = [];
const state = new Map();

for (const workspace of workspaces) {
  visit(workspace, []);
}

for (const workspace of ordered) {
  const result = spawnSync(
    npmCommand(),
    ["run", "build", "--workspace", workspace.packageJson.name],
    {
      cwd: root,
      shell: process.platform === "win32",
      stdio: "inherit",
    },
  );
  if (result.error) {
    console.error(
      `Failed to run build for ${workspace.packageJson.name}: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  writeBuildStamp(workspace);
}

function visit(workspace, stack) {
  const name = workspace.packageJson.name;
  const current = state.get(name);
  if (current === "done") return;
  if (current === "visiting") {
    throw new Error(
      `Workspace dependency cycle: ${[...stack, name].join(" -> ")}`,
    );
  }

  state.set(name, "visiting");
  for (const depName of internalDependencyNames(workspace.packageJson)) {
    const dep = byName.get(depName);
    if (dep) visit(dep, [...stack, name]);
  }
  state.set(name, "done");
  ordered.push(workspace);
}

function internalDependencyNames(packageJson) {
  return Object.keys({
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.peerDependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  }).sort();
}

function discoverWorkspaceDirs(patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      if (existsSync(join(root, pattern, "package.json"))) dirs.push(pattern);
      continue;
    }

    const parent = pattern.slice(0, -2);
    for (const child of readdirSync(join(root, parent), {
      withFileTypes: true,
    })) {
      if (!child.isDirectory()) continue;
      const dir = join(parent, child.name);
      if (existsSync(join(root, dir, "package.json"))) dirs.push(dir);
    }
  }
  return [...new Set(dirs)];
}

function readPackage(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function writeBuildStamp(workspace) {
  const dist = join(root, workspace.dir, "dist");
  if (!existsSync(dist)) return;
  writeFileSync(
    join(root, workspace.dir, ".sparkwright-build-stamp.json"),
    `${JSON.stringify(
      {
        workspace: workspace.packageJson.name,
        dir: workspace.dir,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  rmSync(join(dist, ".sparkwright-build-stamp.json"), { force: true });
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
