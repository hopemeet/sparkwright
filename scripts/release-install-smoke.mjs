import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const tempRoot = mkdtempSync(join(tmpdir(), "sparkwright-release-"));
const packDir = join(tempRoot, "packs");
const installDir = join(tempRoot, "install");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });

  const publicPackages = getPublicWorkspacePackages();
  if (publicPackages.length === 0) {
    throw new Error("No public packages found for release install smoke test.");
  }

  run(
    npm,
    [
      "pack",
      "--pack-destination",
      packDir,
      ...publicPackages.flatMap((pkg) => ["--workspace", pkg.name]),
    ],
    repoRoot,
  );

  run(npm, ["init", "-y"], installDir);

  const tarballs = readdirSync(packDir)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(packDir, file));
  if (tarballs.length !== publicPackages.length) {
    throw new Error(
      `Expected ${publicPackages.length} package tarballs, found ${tarballs.length}.`,
    );
  }

  run(npm, ["install", ...tarballs], installDir);
  writeFileSync(
    join(installDir, "import-smoke.mjs"),
    publicPackages
      .map((pkg) => `await import(${JSON.stringify(pkg.name)});`)
      .join("\n"),
  );
  run(process.execPath, ["import-smoke.mjs"], installDir);
  run(
    npx,
    [
      "sparkwright",
      "run",
      "inspect this repo",
      "--workspace",
      join(repoRoot, "examples", "repo-pilot"),
      "--target",
      "README.md",
      "--trace-level",
      "minimal",
      "--model",
      "deterministic",
    ],
    installDir,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function getPublicWorkspacePackages() {
  const packagesDir = join(repoRoot, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageJsonPath = join(packagesDir, entry.name, "package.json");
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      return {
        name: packageJson.name,
        private: packageJson.private,
      };
    })
    .filter((pkg) => pkg.name && pkg.private === false)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
