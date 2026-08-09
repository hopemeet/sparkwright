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
} else if (args[0] === "acp") {
  // Lazy import so normal CLI/TUI paths do not load the ACP SDK.
  const { runAcpMain } = await import("@sparkwright/acp-adapter");
  await runAcpMain(args.slice(1), { cwd: process.cwd(), env: process.env });
} else {
  const result = await runCli(args, {
    cwd: process.cwd(),
    io: {
      stdout,
      stderr,
      stdinIsTTY: stdin.isTTY,
      question: askQuestion,
      readSecret: readSecret,
    },
  });
  process.exitCode = result.exitCode;
}

async function askQuestion(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, terminal: false });
    try {
      return await rl.question("");
    } finally {
      rl.close();
    }
  }

  stderr.write(prompt);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();
  return await new Promise<string>((resolveSecret, rejectSecret) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(Boolean(wasRaw));
      stderr.write("\n");
      if (error) rejectSecret(error);
      else resolveSecret(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(new Error("API key input cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    stdin.on("data", onData);
  });
}
