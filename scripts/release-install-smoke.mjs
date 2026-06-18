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
const smokeEnv = {
  XDG_CONFIG_HOME: join(tempRoot, "xdg-config"),
  XDG_STATE_HOME: join(tempRoot, "xdg-state"),
};
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(smokeEnv.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(smokeEnv.XDG_STATE_HOME, { recursive: true });

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
      "standard",
      "--model",
      "deterministic",
    ],
    installDir,
    { env: smokeEnv },
  );

  const writeSmokeWorkspace = join(tempRoot, "write-smoke-workspace");
  mkdirSync(writeSmokeWorkspace, { recursive: true });
  mkdirSync(join(writeSmokeWorkspace, ".sparkwright"), { recursive: true });
  writeFileSync(join(writeSmokeWorkspace, "README.md"), "# Write Smoke\n");
  writeFileSync(
    join(writeSmokeWorkspace, ".sparkwright", "config.json"),
    JSON.stringify({
      tools: { disabled: [] },
    }),
  );
  run(
    npx,
    [
      "sparkwright",
      "run",
      "--direct-core",
      "exercise approval-gated write path",
      "--workspace",
      writeSmokeWorkspace,
      "--target",
      "README.md",
      "--write",
      "--yes",
      "--trace-level",
      "standard",
      "--model",
      "deterministic",
    ],
    installDir,
    { env: { ...smokeEnv, SPARKWRIGHT_ENABLE_DIRECT_CORE: "1" } },
  );

  assertWriteSmokeResult(writeSmokeWorkspace);
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

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error) {
    console.error(
      `Failed to run ${command} ${args.join(" ")}: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Command failed: ${command} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

function assertWriteSmokeResult(workspace) {
  const readme = readFileSync(join(workspace, "README.md"), "utf8");
  if (!readme.includes("## Sparkwright CLI Golden Path")) {
    throw new Error("Release install write smoke did not update README.md.");
  }

  const sessionRoot = join(workspace, ".sparkwright", "sessions");
  const files = listFiles(sessionRoot);
  if (!files.some((file) => file.endsWith(".diff"))) {
    throw new Error(
      "Release install write smoke did not create a diff artifact.",
    );
  }

  const trace = files.find((file) => file.endsWith("trace.jsonl"));
  if (!trace) {
    throw new Error("Release install write smoke did not create a trace.");
  }
  const traceContent = readFileSync(trace, "utf8");
  if (!traceContent.includes('"workspace.write.completed"')) {
    throw new Error(
      "Release install write smoke trace did not record workspace.write.completed.",
    );
  }
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    if (entry.isFile()) return [full];
    return [];
  });
}
