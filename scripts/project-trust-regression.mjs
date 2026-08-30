#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@sparkwright/sdk-node";
import {
  projectTrustStatePath,
  resolveHostStdioSpawn,
} from "@sparkwright/host";

const root = mkdtempSync(join(tmpdir(), "sparkwright-trust-regression-"));
const workspaceRoot = join(root, "workspace");
const sessionRootDir = join(root, "sessions");
const commandPath = join(
  workspaceRoot,
  ".sparkwright",
  "command",
  "must-not-run.md",
);
const sentinelPath = join(workspaceRoot, "untrusted-process-ran");
const smokeEnv = {
  ...process.env,
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
};
let client;

try {
  mkdirSync(dirname(commandPath), { recursive: true });
  mkdirSync(smokeEnv.HOME, { recursive: true });
  mkdirSync(smokeEnv.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(smokeEnv.XDG_STATE_HOME, { recursive: true });
  writeFileSync(
    commandPath,
    `!\`touch ${JSON.stringify(sentinelPath)}\``,
    "utf8",
  );

  const spawn = resolveHostStdioSpawn({
    workspaceRoot,
    sessionRootDir,
    accessMode: "read-only",
    modelName: "deterministic",
    env: smokeEnv,
  });
  client = await createClient({
    spawn: { ...spawn, cwd: workspaceRoot, env: smokeEnv },
    client: { name: "project-trust-regression", version: "0.1.0" },
  });

  await expectTrustFailure(client, "project_trust_required");
  assert(!existsSync(sentinelPath), "untrusted command started a process");

  const inspected = await client.inspectProjectTrust();
  const granted = await client.grantProjectTrust({
    expectedManifestHash: inspected.manifestHash,
    scopes: ["commands"],
  });
  assert(
    granted.scopes.some(
      (scope) => scope.scope === "commands" && scope.status === "trusted",
    ),
    "commands scope was not trusted after a manifest-pinned grant",
  );

  writeFileSync(
    commandPath,
    `changed !\`touch ${JSON.stringify(sentinelPath)}\``,
    "utf8",
  );
  await expectTrustFailure(client, "project_trust_changed");
  assert(!existsSync(sentinelPath), "changed command started a process");

  const statePath = projectTrustStatePath(smokeEnv);
  assert(existsSync(statePath), "project trust state was not persisted");
  if (process.platform !== "win32") {
    assert(
      (statSync(statePath).mode & 0o777) === 0o600,
      "project trust state is not mode 0600",
    );
  }
  const state = readFileSync(statePath, "utf8");
  assert(!state.includes("must-not-run"), "state copied a command body/path");
  assert(!state.includes("touch"), "state copied executable command content");

  console.log("Project trust regression passed.");
} finally {
  client?.close();
  rmSync(root, { recursive: true, force: true });
}

async function expectTrustFailure(activeClient, expectedCode) {
  try {
    await activeClient.startRun({
      goal: "exercise project trust denial",
      projectCommand: { name: "must-not-run" },
      model: "deterministic",
      accessMode: "read-only",
    });
    throw new Error(`expected ${expectedCode}, but run.start succeeded`);
  } catch (error) {
    if (error?.code !== expectedCode) {
      throw new Error(
        `expected ${expectedCode}, got ${error?.code ?? String(error)}`,
      );
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
