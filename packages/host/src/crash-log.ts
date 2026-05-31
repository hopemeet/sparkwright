import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CRASH_DIR = join(homedir(), ".sparkwright", "host-crashes");

let installed = false;

/**
 * Capture unhandled exceptions and promise rejections to a crash log under
 * ~/.sparkwright/host-crashes/. Critical because in stdio mode the parent
 * cannot read raw stack traces (stderr is the host.log pipe), and even in
 * WS mode the process may exit before the failed event reaches the wire.
 *
 * Addresses the same problem space as panic-hook patterns used by other
 * TUI gateways.
 */
export function installCrashLog(): void {
  if (installed) return;
  installed = true;
  try {
    mkdirSync(CRASH_DIR, { recursive: true });
  } catch {
    // best-effort
  }

  process.on("uncaughtException", (err) => {
    write("uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    write(
      "unhandledRejection",
      reason instanceof Error ? reason : new Error(String(reason)),
    );
  });
}

function write(label: string, err: Error): void {
  const ts = new Date().toISOString();
  const file = join(CRASH_DIR, `crash-${Date.now()}.log`);
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
