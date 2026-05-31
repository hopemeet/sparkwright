#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stderr, stdin, stdout } from "node:process";
import { runCli } from "./cli.js";

const args = process.argv.slice(2);

if (args[0] === "tui") {
  // Lazy import so Ink/React are not loaded for non-interactive runs.
  const { runTui } = await import("@sparkwright/tui");
  const result = await runTui(args.slice(1), { workspaceRoot: process.cwd() });
  process.exitCode = result.exitCode;
  process.exit(process.exitCode ?? 0);
} else if (args[0] === "host") {
  // Lazy import: WS / heavy deps don't load for non-host paths.
  // runHostMain starts the chosen transport and keeps the event loop
  // alive via listening sockets (WS) or stdin (stdio).
  const { runHostMain } = await import("@sparkwright/host");
  await runHostMain(args.slice(1));
} else {
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    const result = await runCli(args, {
      cwd: process.cwd(),
      io: {
        stdout,
        stderr,
        stdinIsTTY: stdin.isTTY,
        question: (prompt) => rl.question(prompt),
      },
    });
    process.exitCode = result.exitCode;
  } finally {
    rl.close();
  }
}
