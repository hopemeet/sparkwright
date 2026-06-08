import { installCrashLog } from "./crash-log.js";
import { installLogPipe, attachLogSink } from "./log-pipe.js";
import { createStdioConnection } from "./transport-stdio.js";
import { startWsServer } from "./transport-ws.js";
import { serveConnection } from "./server.js";
import type { PermissionMode, TraceLevel } from "@sparkwright/core";
import { join } from "node:path";

interface ParsedArgs {
  mode: "stdio" | "ws";
  port: number;
  host: string;
  workspaceRoot: string;
  sessionRootDir: string;
  model?: string;
  permissionMode: PermissionMode;
  traceLevel: TraceLevel;
  shouldWrite: boolean;
  authToken?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let mode: "stdio" | "ws" = "ws";
  let port = 7320;
  let host = "127.0.0.1";
  let workspaceRoot = process.cwd();
  let sessionRootDir: string | undefined;
  let model: string | undefined;
  let permissionMode: PermissionMode = "default";
  let traceLevel: TraceLevel = "standard";
  let shouldWrite = false;
  let authToken = process.env.SPARKWRIGHT_HOST_TOKEN;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--stdio") mode = "stdio";
    else if (a === "--ws") mode = "ws";
    else if (a === "--port" && argv[i + 1]) port = Number(argv[++i]);
    else if (a === "--host" && argv[i + 1]) host = argv[++i];
    else if (a === "--workspace" && argv[i + 1]) workspaceRoot = argv[++i];
    else if (a === "--session-root" && argv[i + 1]) sessionRootDir = argv[++i];
    else if (a === "--model" && argv[i + 1]) model = argv[++i];
    else if (a === "--write") shouldWrite = true;
    else if (a === "--permission-mode" && argv[i + 1]) {
      const v = argv[++i];
      if (isPermissionMode(v)) permissionMode = v;
    } else if (a === "--trace-level" && argv[i + 1]) {
      const v = argv[++i];
      if (isTraceLevel(v)) traceLevel = v;
    } else if (a === "--auth-token" && argv[i + 1]) authToken = argv[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return {
    mode,
    port,
    host,
    workspaceRoot,
    sessionRootDir:
      sessionRootDir ?? join(workspaceRoot, ".sparkwright", "sessions"),
    model,
    permissionMode,
    traceLevel,
    shouldWrite,
    authToken,
  };
}

function printHelp(): void {
  process.stderr.write(
    [
      "sparkwright-host — agent runtime host",
      "",
      "USAGE:",
      "  sparkwright host [--ws] [--port 7320] [--host 127.0.0.1]",
      "  sparkwright host --stdio",
      "",
      "OPTIONS:",
      "  --workspace <path>         workspace root for runs (default: cwd)",
      "  --session-root <path>      session/trace storage root (default: <workspace>/.sparkwright/sessions)",
      '  --model <ref>              model reference "provider/model" (or "deterministic")',
      "  --write                    allow approval-gated workspace writes for requests that omit shouldWrite",
      "  --permission-mode <mode>   plan | default | accept_edits | dont_ask | bypass_permissions",
      "  --trace-level <level>      minimal | standard | debug",
      "  --auth-token <token>       require WS clients to provide Bearer token or ?token=...",
      "                             (also SPARKWRIGHT_HOST_TOKEN)",
      "",
      "See docs/HOST_PROTOCOL.md for the wire protocol.",
      "",
    ].join("\n"),
  );
}

/**
 * Entry point for the host. Called by the `sparkwright-host` bin and by
 * the `sparkwright host` CLI subcommand. Installs crash + log capture
 * before any business code runs, then starts the chosen transport.
 *
 * Returns a promise that resolves once the host has set up listeners.
 * The process stays alive afterwards because the transports keep the
 * event loop open (stdin or listening sockets).
 */
export async function runHostMain(argv: string[]): Promise<void> {
  installCrashLog();
  const args = parseArgs(argv);

  // Patch stderr in WS mode so library logs reach clients as host.log
  // events. In stdio mode we leave stderr alone — the parent process
  // reads stderr directly and turns it into host.log on its side.
  installLogPipe({ patchStderr: args.mode === "ws" });

  if (args.mode === "stdio") {
    const conn = createStdioConnection();
    const detach = attachLogSink((event) => {
      try {
        conn.send(event);
      } catch {
        /* ignore */
      }
    });
    conn.onClose(() => {
      detach();
      process.exit(0);
    });
    serveConnection(conn, {
      workspaceRoot: args.workspaceRoot,
      sessionRootDir: args.sessionRootDir,
      defaultModel: args.model,
      defaultPermissionMode: args.permissionMode,
      defaultTraceLevel: args.traceLevel,
      defaultShouldWrite: args.shouldWrite,
    });
    return;
  }

  // WS mode: accept many clients.
  process.stderr.write(
    `sparkwright-host listening on ws://${args.host}:${args.port}\n`,
  );
  if (!isLoopbackHost(args.host) && !args.authToken) {
    process.stderr.write(
      [
        "WARNING: sparkwright-host has no built-in WebSocket authentication.",
        "Bind to 127.0.0.1 for local use, or put this host behind trusted network/auth controls.",
        "",
      ].join("\n"),
    );
  }
  startWsServer({
    port: args.port,
    host: args.host,
    authToken: args.authToken,
    onConnection: (conn) => {
      const detach = attachLogSink((event) => {
        try {
          conn.send(event);
        } catch {
          /* ignore */
        }
      });
      conn.onClose(() => detach());
      serveConnection(conn, {
        workspaceRoot: args.workspaceRoot,
        sessionRootDir: args.sessionRootDir,
        defaultModel: args.model,
        defaultPermissionMode: args.permissionMode,
        defaultTraceLevel: args.traceLevel,
        defaultShouldWrite: args.shouldWrite,
      });
    },
  });
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

function isTraceLevel(value: string): value is TraceLevel {
  return value === "minimal" || value === "standard" || value === "debug";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}
