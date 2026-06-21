import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import React from "react";
import {
  configResolutionOrder,
  loadHostConfig,
  validateRunInput,
} from "@sparkwright/host";
import {
  isPermissionMode,
  isTraceLevel,
  type PermissionMode,
  type TraceLevel,
} from "@sparkwright/protocol";
import { App, type AppProps } from "./app.js";
import { installTerminalRestore } from "./lib/terminal-restore.js";

export interface RunTuiOptions {
  workspaceRoot?: string;
  sessionRootDir?: string;
}

interface CliOverrides {
  workspaceRoot?: string;
  sessionRootDir?: string;
  permissionMode?: PermissionMode;
  traceLevel?: TraceLevel;
  shouldWrite?: boolean;
  approveAll?: boolean;
  approveEdits?: boolean;
  approveShellSafe?: boolean;
  modelName?: string;
  sessionId?: string;
  help?: boolean;
}

function parseArgs(
  argv: string[],
): { ok: true; value: CliOverrides } | { ok: false; errors: string[] } {
  const out: CliOverrides = {};
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--workspace") {
      if (!argv[i + 1]) errors.push("Usage: --workspace requires a path");
      else out.workspaceRoot = argv[++i];
    } else if (a === "--session-root") {
      if (!argv[i + 1]) errors.push("Usage: --session-root requires a path");
      else out.sessionRootDir = argv[++i];
    } else if (a === "--model") {
      if (!argv[i + 1]) errors.push("Usage: --model requires a model name");
      else out.modelName = argv[++i];
    } else if (a === "--write") {
      out.shouldWrite = true;
    } else if (a === "--yes" || a === "--yes-all") {
      out.approveAll = true;
    } else if (a === "--yes-edits") {
      out.approveEdits = true;
    } else if (a === "--yes-shell-safe") {
      out.approveShellSafe = true;
    } else if (a === "--permission-mode") {
      const v = argv[i + 1];
      if (!v) errors.push("Usage: --permission-mode requires a value");
      else if (isPermissionMode(v)) {
        out.permissionMode = v;
        i += 1;
      } else {
        errors.push(
          "Usage: --permission-mode must be one of: plan, default, accept_edits, dont_ask, bypass_permissions",
        );
        i += 1;
      }
    } else if (a === "--trace-level") {
      const v = argv[i + 1];
      if (!v) errors.push("Usage: --trace-level requires a value");
      else if (isTraceLevel(v)) {
        out.traceLevel = v;
        i += 1;
      } else {
        errors.push("Usage: --trace-level must be one of: standard, debug");
        i += 1;
      }
    } else if (a === "--session-id") {
      if (!argv[i + 1]) errors.push("Usage: --session-id requires an id");
      else out.sessionId = argv[++i];
    } else {
      errors.push(`Unknown option: ${a}`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}

export async function runTui(
  argv: string[],
  options: RunTuiOptions = {},
): Promise<{ exitCode: number }> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    for (const error of parsed.errors) process.stderr.write(`${error}\n`);
    return { exitCode: 1 };
  }
  const cli = parsed.value;
  if (cli.help) {
    process.stdout.write(`${tuiUsage()}\n`);
    return { exitCode: 0 };
  }
  const initialCwd =
    cli.workspaceRoot ?? options.workspaceRoot ?? process.cwd();
  const validation = await validateRunInput({
    workspaceRoot: initialCwd,
    modelName: cli.modelName,
    validateModel: Boolean(cli.modelName),
    env: process.env,
  });
  if (!validation.ok) {
    for (const error of validation.errors) process.stderr.write(`${error}\n`);
    return { exitCode: 1 };
  }
  await maybePrintFirstRunConfigHint(initialCwd);
  const props: AppProps = {
    initialCwd,
    cliOverrides: {
      ...cli,
      sessionRootDir: cli.sessionRootDir ?? options.sessionRootDir,
    },
  };

  // Render into the normal buffer (NOT the alternate screen). The transcript is
  // committed to terminal scrollback via Ink's <Static>; only the live frame
  // (status bar, in-flight stream, input) is redrawn in place. The alt buffer
  // has no scrollback, so it fundamentally can't host a scrollable history —
  // hence the normal buffer here.
  // exitOnCtrlC: false — Ink's built-in handler would quit on the first Ctrl+C,
  // pre-empting our cancel-then-confirm logic in app.tsx (first press cancels a
  // run / arms quit, second press exits). We own Ctrl+C entirely.
  // Safety net: restore terminal modes (bracketed paste, focus reporting,
  // mouse, cursor) on any hard exit path — SIGINT/SIGTERM/SIGHUP or an uncaught
  // exception skip React effect cleanup and would otherwise leave the shell in
  // a broken state. Installed before render so it covers a crash during mount.
  installTerminalRestore(process.stdout);

  const instance = render(React.createElement(App, props), {
    exitOnCtrlC: false,
  });
  await instance.waitUntilExit();
  return { exitCode: 0 };
}

async function maybePrintFirstRunConfigHint(initialCwd: string): Promise<void> {
  if (!process.stderr.isTTY) return;
  const loaded = await loadHostConfig(initialCwd, process.env);
  if (loaded.errors.length > 0) return;
  if (loaded.attempted.some((entry) => entry.loaded)) return;
  const order = configResolutionOrder(initialCwd, process.env);
  const user = order.find((entry) => entry.label === "user")?.path;
  const project = order.find((entry) => entry.label === "project")?.path;
  process.stderr.write(
    [
      "No Sparkwright config found yet.",
      ...(user ? [`User config: ${user}`] : []),
      ...(project ? [`Project config: ${project}`] : []),
      "Create one with `sparkwright init` or `sparkwright init --project`.",
      "Inspect config with `sparkwright config inspect --format text`.",
      "",
    ].join("\n"),
  );
}

function tuiUsage(): string {
  return [
    "Usage: sparkwright tui [--workspace path] [--session-root path] [--model provider/model] [--write] [--permission-mode mode] [--trace-level standard|debug] [--session-id id]",
    "       sparkwright tui [--yes-edits] [--yes-shell-safe] [--yes|--yes-all]",
    "       node packages/tui/dist/index.js [same options]",
  ].join("\n");
}

function isDirectEntry(): boolean {
  return (
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isDirectEntry()) {
  const result = await runTui(process.argv.slice(2));
  process.exitCode = result.exitCode;
}
