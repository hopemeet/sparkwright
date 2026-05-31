import type { HostEvent } from "@sparkwright/protocol";
import { nextMessageId, nowIso } from "./connection.js";

type Sink = (event: HostEvent) => void;

const sinks = new Set<Sink>();
let installed = false;

function emit(level: "stdout" | "stderr", line: string): void {
  if (!line) return;
  const event: HostEvent = {
    envelope: "event",
    id: nextMessageId("evt"),
    kind: "host.log",
    timestamp: nowIso(),
    payload: { level, line, source: "host" },
  };
  for (const sink of sinks) {
    try {
      sink(event);
    } catch {
      // sink threw; ignore to keep logging fault-tolerant
    }
  }
}

/**
 * Patch process.stderr.write so that any output (from console.error,
 * third-party libs, the runtime) is captured as a host.log event instead
 * of leaking to the actual terminal — critical for stdio transport where
 * stdout is the JSON-RPC pipe and the parent process is reading stderr.
 *
 * The original stderr stream is preserved and used as a fallback when no
 * sink is registered (so early-boot errors before any client connects are
 * still visible).
 *
 * In stdio mode the host is typically a child process; the parent (TUI/SDK)
 * reads its stderr and treats every line as a host.log event itself, so
 * we leave stderr alone there. In WS mode we patch so log lines reach
 * connected clients via host.log events.
 */
export function installLogPipe(options: { patchStderr: boolean }): void {
  if (installed) return;
  installed = true;
  if (!options.patchStderr) return;

  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  // Buffer partial lines until we see a newline; emit per line.
  let buffer = "";
  process.stderr.write = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(
            typeof encodingOrCb === "string" ? encodingOrCb : "utf8",
          );
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) emit("stderr", line);

    if (sinks.size === 0) {
      // Nobody listening — pass through so logs are not lost.
      return originalStderrWrite(chunk, encodingOrCb as BufferEncoding, cb);
    }
    if (typeof cb === "function") cb();
    else if (typeof encodingOrCb === "function") encodingOrCb();
    return true;
  }) as typeof process.stderr.write;
}

export function attachLogSink(sink: Sink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}
