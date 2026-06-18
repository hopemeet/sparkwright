import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function crashDir(env: Record<string, string | undefined> = process.env) {
  const stateBase =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(stateBase, "sparkwright", "host-crashes");
}

let installed = false;

/**
 * Capture unhandled exceptions and promise rejections to a crash log under
 * the user state directory. Critical because in stdio mode the parent cannot
 * read raw stack traces (stderr is the host.log pipe), and even in WS mode the
 * process may exit before the failed event reaches the wire.
 *
 * Addresses the same problem space as panic-hook patterns used by other
 * TUI gateways.
 */
export function installCrashLog(): void {
  if (installed) return;
  installed = true;
  const dir = crashDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }

  process.on("uncaughtException", (err) => {
    write(dir, "uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    write(
      dir,
      "unhandledRejection",
      reason instanceof Error ? reason : new Error(String(reason)),
    );
  });
}

function write(dir: string, label: string, err: Error): void {
  const ts = new Date().toISOString();
  const file = join(dir, `crash-${Date.now()}.log`);
  const body = [
    `=== ${label} · ${ts} ===`,
    `${err.name}: ${err.message}`,
    err.stack ?? "(no stack)",
    "",
  ].join("\n");
  try {
    appendFileSync(file, body, "utf8");
  } catch {
    // last-resort: emit to stderr (the only sink left)
    process.stderr.write(`${label}: ${err.message}\n`);
  }
}
