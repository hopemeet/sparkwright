import readline from "node:readline";

let nextId = 1;
const pending = new Map();
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const response = JSON.parse(line);
  const waiter = pending.get(response.id);
  if (!waiter) return;
  pending.delete(response.id);
  if (response.error) waiter.reject(new Error(response.error.message));
  else waiter.resolve(response.result);
});

function request(method, params) {
  const id = nextId++;
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
  );
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function runCommand(label, args) {
  await request("progress", { message: `running ${label}` });
  const result = await request("invoke", {
    type: "command",
    command: "npm",
    args,
    timeoutMs: 300000,
    maxOutputBytes: 64000,
  });
  if (result.exitCode !== 0 || result.timedOut === true) {
    throw new Error(`${label} failed`);
  }
  return result;
}

try {
  await request("initialize", { nodeId: "focused-gates" });
  await runCommand("host workflow parser tests", [
    "--workspace",
    "@sparkwright/host",
    "test",
    "--",
    "test/workflows.test.ts",
    "-t",
    "workflow assets",
  ]);
  await runCommand("host workflow hook script test", [
    "--workspace",
    "@sparkwright/host",
    "test",
    "--",
    "test/workflow-hooks.test.ts",
    "-t",
    "script nodes",
  ]);
  await request("complete", { result: { gates: 2 } });
  process.exit(0);
} catch (error) {
  await request("fail", {
    reason: error instanceof Error ? error.message : String(error),
  }).catch(() => undefined);
  process.exit(1);
}
