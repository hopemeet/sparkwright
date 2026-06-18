import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const rootPackage = readPackage(root);
const workspaceDirs = discoverWorkspaceDirs(rootPackage.workspaces ?? []);
const checked = [];
const failures = [];

for (const dir of workspaceDirs.sort()) {
  const packageJson = readPackage(join(root, dir));
  if (!packageJson.scripts?.build) continue;

  const packageRoot = join(root, dir);
  const srcRoot = join(packageRoot, "src");
  const distRoot = join(packageRoot, "dist");
  if (!existsSync(srcRoot)) continue;

  const newestSource = newestMtime([
    srcRoot,
    join(packageRoot, "package.json"),
    join(packageRoot, "tsconfig.json"),
  ]);
  const newestDist = existsSync(distRoot) ? newestMtime([distRoot]) : undefined;

  checked.push(`${packageJson.name ?? dir}`);
  if (newestSource === undefined) continue;
  if (newestDist === undefined) {
    failures.push(`${dir}: dist/ is missing`);
    continue;
  }
  if (newestSource.mtimeMs > newestDist.mtimeMs) {
    failures.push(
      `${dir}: dist is older than ${relative(newestSource.path)}; run npm run build`,
    );
  }
}

if (failures.length > 0) {
  console.error("Stale workspace dist output detected:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`dist output is fresh for ${checked.length} built workspaces.`);

function newestMtime(paths) {
  let newest;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of walk(path)) {
        const entryStat = statSync(entry);
        if (!entryStat.isFile()) continue;
        if (!shouldTrack(entry)) continue;
        if (!newest || entryStat.mtimeMs > newest.mtimeMs) {
          newest = { path: entry, mtimeMs: entryStat.mtimeMs };
        }
      }
      continue;
    }
    if (stat.isFile() && (!newest || stat.mtimeMs > newest.mtimeMs)) {
      newest = { path, mtimeMs: stat.mtimeMs };
    }
  }
  return newest;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}

function shouldTrack(path) {
  return /\.(ts|tsx|js|jsx|json)$/.test(path);
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

function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
