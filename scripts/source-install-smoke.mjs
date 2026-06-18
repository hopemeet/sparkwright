import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
const tempRoot = mkdtempSync(join(tmpdir(), "sparkwright-source-install-"));
const installRoot = join(tempRoot, "install");
const xdgConfigHome = join(tempRoot, "xdg-config");
const xdgStateHome = join(tempRoot, "xdg-state");
const installedBin = join(installRoot, "bin", "sparkwright");
const smokeEnv = {
  SPARKWRIGHT_INSTALL_ROOT: installRoot,
  SPARKWRIGHT_INSTALL_VERSION: "smoke",
  XDG_CONFIG_HOME: xdgConfigHome,
  XDG_STATE_HOME: xdgStateHome,
};

try {
  mkdirSync(xdgConfigHome, { recursive: true });
  mkdirSync(xdgStateHome, { recursive: true });

  run(process.execPath, ["scripts/install-from-source.mjs"], repoRoot, {
    env: smokeEnv,
  });

  assertExists(installedBin, "source install did not create bin/sparkwright");
  assertDoctorPaths();
  assertHelp("tui", ["Usage:", "sparkwright tui"]);
  assertHelp("acp", ["USAGE:", "sparkwright acp"]);
  assertDeterministicRun();
  assertUninstallKeepsUserData();

  console.log("Source install smoke passed.");
} finally {
  if (process.env.SPARKWRIGHT_KEEP_INSTALL_SMOKE === "1") {
    console.log(`Keeping source install smoke directory: ${tempRoot}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertDoctorPaths() {
  const result = run(
    installedBin,
    ["doctor", "paths", "--workspace", repoRoot, "--format", "json"],
    repoRoot,
    { env: smokeEnv, stdio: "pipe" },
  );
  const paths = JSON.parse(result.stdout);

  assertEqual(paths.install.root, installRoot, "install root mismatch");
  assertEqual(paths.install.version, "smoke", "install version mismatch");
  assertEqual(
    paths.install.currentTarget,
    "versions/smoke",
    "install current target mismatch",
  );
  assertEqual(
    paths.install.inferredFromExecutable,
    "sparkwright",
    "install source inference mismatch",
  );
  assertEqual(
    paths.install.entrypoints.cli,
    installedBin,
    "CLI entrypoint mismatch",
  );
  assertEqual(
    paths.install.entrypoints.tui,
    `${installedBin} tui`,
    "TUI entrypoint mismatch",
  );
  assertEqual(
    paths.install.entrypoints.acp,
    `${installedBin} acp`,
    "ACP entrypoint mismatch",
  );
  assertEqual(
    paths.state.cron.root,
    join(xdgStateHome, "sparkwright", "cron"),
    "cron state root mismatch",
  );
  assertEqual(
    paths.state.imGateway.dataDir,
    join(xdgStateHome, "sparkwright", "im-gateway"),
    "IM gateway state root mismatch",
  );
}

function assertHelp(command, expectedFragments) {
  const result = run(installedBin, [command, "--help"], repoRoot, {
    env: smokeEnv,
    stdio: "pipe",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  for (const fragment of expectedFragments) {
    if (!output.includes(fragment)) {
      throw new Error(
        `${command} --help output did not include ${JSON.stringify(fragment)}`,
      );
    }
  }
}

function assertDeterministicRun() {
  run(
    installedBin,
    [
      "run",
      "inspect this repo",
      "--workspace",
      join(repoRoot, "examples", "repo-pilot"),
      "--target",
      "README.md",
      "--trace-level",
      "standard",
      "--model",
      "deterministic",
    ],
    repoRoot,
    { env: smokeEnv },
  );
}

function assertUninstallKeepsUserData() {
  const configSentinel = join(xdgConfigHome, "sparkwright", "sentinel.txt");
  const stateSentinel = join(xdgStateHome, "sparkwright", "sentinel.txt");
  mkdirSync(dirname(configSentinel), { recursive: true });
  mkdirSync(dirname(stateSentinel), { recursive: true });
  writeFileSync(configSentinel, "keep config\n");
  writeFileSync(stateSentinel, "keep state\n");

  run("bash", ["uninstall.sh"], repoRoot, { env: smokeEnv });

  for (const programPath of ["bin", "current", "versions", "cache"]) {
    const fullPath = join(installRoot, programPath);
    if (existsSync(fullPath)) {
      throw new Error(`uninstall left program path behind: ${fullPath}`);
    }
  }
  assertEqual(readFileSync(configSentinel, "utf8"), "keep config\n");
  assertEqual(readFileSync(stateSentinel, "utf8"), "keep state\n");
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: process.platform === "win32",
    stdio: options.stdio ?? "inherit",
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(
      `Failed to run ${command} ${args.join(" ")}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
  return result;
}

function assertExists(path, message) {
  if (!existsSync(path)) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message = "values differ") {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}
