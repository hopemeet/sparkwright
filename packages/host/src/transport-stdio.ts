import { createInterface } from "node:readline";
import type { HostMessage } from "@sparkwright/protocol";
import type { Connection } from "./connection.js";
import { nextConnectionId } from "./connection.js";

/**
 * Newline-delimited JSON over stdio. Used when the host is spawned as a
 * child by a local client (e.g. the TUI).
 *
 * IMPORTANT: stderr must NEVER write protocol bytes. log-pipe.ts patches
 * console.* to route through stderr → host.log events.
 */
export function createStdioConnection(): Connection {
  const id = nextConnectionId("stdio");
  let onMessage: ((m: HostMessage) => void) | null = null;
  let onClose: ((reason?: string) => void) | null = null;

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: HostMessage;
    try {
      parsed = JSON.parse(trimmed) as HostMessage;
    } catch {
      // Drop malformed lines; can't safely send a response without an id.
      return;
    }
    onMessage?.(parsed);
  });
  rl.on("close", () => onClose?.("stdin closed"));
  process.stdin.on("end", () => onClose?.("stdin ended"));

  return {
    id,
    send(message) {
      // Single line, exactly one \n. Never write to stderr from this path.
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close(_reason) {
      // Letting the parent process detect EOF is the cleanest signal.
      try {
        process.stdout.end();
      } catch {
        // already closed
      }
    },
  };
}
