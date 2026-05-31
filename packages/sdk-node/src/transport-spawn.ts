import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { HostMessage } from "@sparkwright/protocol";
import type { ClientTransport } from "@sparkwright/sdk-core";

export interface SpawnHostOptions {
  /** Command to execute. Defaults to `sparkwright-host`. */
  command?: string;
  /**
   * Full argument list. When omitted, defaults to `["--stdio"]`. Callers
   * that pass their own args MUST include `--stdio` themselves (otherwise
   * the SDK can't speak the protocol). This is intentional: when `command`
   * is something like `node` and args is `[script.js, ...]`, the SDK can't
   * know which position to inject the flag.
   */
  args?: string[];
  /** Working directory for the host child. Defaults to inherited. */
  cwd?: string;
  /** Override environment. Defaults to inherited. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn a child host process and talk newline-JSON over its stdio.
 *
 * Stderr lines from the child are forwarded as host.log events by injecting
 * synthetic messages into the inbound stream — the host itself does NOT
 * patch stderr in stdio mode (it leaves it alone), so the SDK does the lift
 * here. This matches docs/HOST_PROTOCOL.md.
 */
export function spawnHostTransport(opts: SpawnHostOptions = {}): {
  transport: ClientTransport;
  child: ChildProcess;
} {
  const command = opts.command ?? "sparkwright-host";
  const args = opts.args ?? ["--stdio"];
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let onMessage: ((m: HostMessage) => void) | null = null;
  let onClose: ((reason?: string) => void) | null = null;

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed) as HostMessage;
      onMessage?.(msg);
    } catch {
      // malformed line; drop
    }
  });

  // Forward stderr lines as synthetic host.log events so clients see them
  // through the same channel they'd see them via the WS transport.
  const stderrRl = createInterface({ input: child.stderr! });
  stderrRl.on("line", (line) => {
    if (!line) return;
    const msg: HostMessage = {
      envelope: "event",
      id: `evt_stderr_${Date.now()}`,
      kind: "host.log",
      timestamp: new Date().toISOString(),
      payload: { level: "stderr", line, source: "host" },
    };
    onMessage?.(msg);
  });

  child.on("exit", (code, signal) =>
    onClose?.(`child exit code=${code ?? "null"} signal=${signal ?? "null"}`),
  );
  child.on("error", (err) => onClose?.(`child error: ${err.message}`));

  return {
    child,
    transport: {
      send(message) {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.write(`${JSON.stringify(message)}\n`);
        }
      },
      onMessage(handler) {
        onMessage = handler;
      },
      onClose(handler) {
        onClose = handler;
      },
      close() {
        try {
          child.stdin?.end();
        } catch {
          /* ignore */
        }
      },
    },
  };
}
