import { render } from "ink";
import React from "react";
import { App, type AppProps } from "./app.js";
import { installTerminalRestore } from "./lib/terminal-restore.js";
import type { PermissionMode } from "./state/run-controller.js";

export interface RunTuiOptions {
  workspaceRoot?: string;
  sessionRootDir?: string;
}

interface CliOverrides {
  workspaceRoot?: string;
  sessionRootDir?: string;
  permissionMode?: PermissionMode;
  modelName?: string;
  sessionId?: string;
}

function parseArgs(argv: string[]): CliOverrides {
  const out: CliOverrides = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--workspace" && argv[i + 1]) out.workspaceRoot = argv[++i];
    else if (a === "--session-root" && argv[i + 1])
      out.sessionRootDir = argv[++i];
    else if (a === "--model" && argv[i + 1]) out.modelName = argv[++i];
    else if (a === "--permission-mode" && argv[i + 1]) {
      const v = argv[++i];
      if (isPermissionMode(v)) out.permissionMode = v;
    } else if (a === "--session-id" && argv[i + 1]) out.sessionId = argv[++i];
  }
  return out;
}

function isPermissionMode(value: string): value is PermissionMode {
  return (
    value === "plan" ||
    value === "default" ||
    value === "accept_edits" ||
    value === "dont_ask" ||
    value === "bypass_permissions"
  );
}

export async function runTui(
  argv: string[],
  options: RunTuiOptions = {},
): Promise<{ exitCode: number }> {
  const cli = parseArgs(argv);
  const initialCwd =
    cli.workspaceRoot ?? options.workspaceRoot ?? process.cwd();
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
