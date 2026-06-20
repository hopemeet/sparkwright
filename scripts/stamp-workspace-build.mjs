import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const workspaceRoot = process.cwd();
const packageJson = readPackage(workspaceRoot);
const repoRoot = findRepoRoot(workspaceRoot);
const dist = join(workspaceRoot, "dist");

if (!existsSync(dist)) process.exit(0);

writeFileSync(
  join(workspaceRoot, ".sparkwright-build-stamp.json"),
  `${JSON.stringify(
    {
      workspace: packageJson.name,
      dir: relative(repoRoot, workspaceRoot).split("\\").join("/"),
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);
rmSync(join(dist, ".sparkwright-build-stamp.json"), { force: true });

function findRepoRoot(start) {
  let dir = resolve(start);
  while (true) {
    const pkg = readPackage(dir, { optional: true });
    if (pkg && Array.isArray(pkg.workspaces)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function readPackage(dir, options = {}) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch (error) {
    if (options.optional) return undefined;
    throw error;
  }
}
