import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const installRoot = resolve(
  process.env.SPARKWRIGHT_INSTALL_ROOT ?? join(homedir(), ".sparkwright"),
);
const version = sanitizeVersion(
  process.env.SPARKWRIGHT_INSTALL_VERSION ?? defaultVersion(),
);
const versionsRoot = join(installRoot, "versions");
const cacheRoot = join(installRoot, "cache");
const versionDir = join(versionsRoot, version);
const packDir = join(cacheRoot, "packs", version);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const installedBin = join(installRoot, "bin", "sparkwright");
const installedCommand = platformCommand(installedBin);
let tmpVersionDir;

try {
  mkdirSync(versionsRoot, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });
  tmpVersionDir = mkdtempSync(join(versionsRoot, `.install-${version}-`));
  const appDir = join(tmpVersionDir, "app");
  const binDir = join(tmpVersionDir, "bin");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const publicPackages = getPublicWorkspacePackages();
  if (publicPackages.length === 0) {
    throw new Error("No public workspace packages found to install.");
  }

  run(
    npm,
    [
      "pack",
      "--silent",
      "--pack-destination",
      packDir,
      ...publicPackages.flatMap((pkg) => ["--workspace", pkg.name]),
    ],
    repoRoot,
  );

  run(npm, ["init", "-y"], appDir);

  const tarballs = readdirSync(packDir)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(packDir, file));
  if (tarballs.length !== publicPackages.length) {
    throw new Error(
      `Expected ${publicPackages.length} package tarballs, found ${tarballs.length}.`,
    );
  }

  run(npm, ["install", "--omit=dev", ...tarballs], appDir);
  writeVersionBin(join(binDir, "sparkwright"));

  rmSync(versionDir, { recursive: true, force: true });
  renameSync(tmpVersionDir, versionDir);
  writeRootBin();
  switchCurrent(version);

  run(installedCommand, ["doctor", "paths", "--workspace", repoRoot], repoRoot);

  printResult();
} catch (error) {
  if (tmpVersionDir) rmSync(tmpVersionDir, { recursive: true, force: true });
  throw error;
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

function writeVersionBin(path) {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'exec node "$SCRIPT_DIR/../app/node_modules/@sparkwright/cli/dist/index.js" "$@"',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
  writeCmdShim(
    path,
    "%SCRIPT_DIR%..\\app\\node_modules\\@sparkwright\\cli\\dist\\index.js",
  );
}

function writeRootBin() {
  const rootBinDir = join(installRoot, "bin");
  mkdirSync(rootBinDir, { recursive: true });
  writeFileSync(
    installedBin,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'INSTALL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"',
      'exec "$INSTALL_ROOT/current/bin/sparkwright" "$@"',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(installedBin, 0o755);
  if (process.platform === "win32") {
    writeFileSync(
      `${installedBin}.cmd`,
      [
        "@echo off",
        "setlocal",
        'set "INSTALL_ROOT=%~dp0.."',
        'call "%INSTALL_ROOT%\\current\\bin\\sparkwright.cmd" %*',
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"),
      "utf8",
    );
  }
}

function switchCurrent(targetVersion) {
  const current = join(installRoot, "current");
  rmSync(current, { recursive: true, force: true });
  try {
    symlinkRelative(`versions/${targetVersion}`, current);
  } catch {
    const currentWrapper = join(current, "bin", "sparkwright");
    mkdirSync(dirname(currentWrapper), { recursive: true });
    writeFileSync(
      currentWrapper,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'INSTALL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"',
        `exec "$INSTALL_ROOT/versions/${targetVersion}/bin/sparkwright" "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(currentWrapper, 0o755);
    if (process.platform === "win32") {
      writeFileSync(
        `${currentWrapper}.cmd`,
        [
          "@echo off",
          "setlocal",
          'set "INSTALL_ROOT=%~dp0..\\.."',
          `call "%INSTALL_ROOT%\\versions\\${targetVersion}\\bin\\sparkwright.cmd" %*`,
          "exit /b %ERRORLEVEL%",
          "",
        ].join("\r\n"),
        "utf8",
      );
    }
  }
}

function symlinkRelative(target, path) {
  symlinkSync(target, path, "dir");
}

function printResult() {
  const pathEntries = (process.env.PATH ?? "").split(delimiter);
  const installBin = join(installRoot, "bin");
  console.log("");
  console.log("Sparkwright installed:");
  console.log(`  version: ${version}`);
  console.log(`  install root: ${installRoot}`);
  console.log(`  command: ${installedCommand}`);
  if (!pathEntries.includes(installBin)) {
    console.log("");
    console.log(
      "Add this to your shell profile if sparkwright is not on PATH:",
    );
    console.log(`  export PATH="${installBin}:$PATH"`);
  }
}

function platformCommand(basePath) {
  return process.platform === "win32" ? `${basePath}.cmd` : basePath;
}

function writeCmdShim(basePath, cliPathExpression) {
  if (process.platform !== "win32") return;
  writeFileSync(
    `${basePath}.cmd`,
    [
      "@echo off",
      "setlocal",
      'set "SCRIPT_DIR=%~dp0"',
      `node "${cliPathExpression}" %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

function defaultVersion() {
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const ref = git.status === 0 ? git.stdout.trim() : "unknown";
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "Z");
  return `dev-${ref}-${stamp}`;
}

function sanitizeVersion(input) {
  return input.replace(/[^A-Za-z0-9._-]/g, "-");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(
      `Failed to run ${command} ${args.join(" ")}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}
