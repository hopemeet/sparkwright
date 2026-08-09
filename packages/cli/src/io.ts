export interface CliIO {
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  stdinIsTTY?: boolean;
  question?: (prompt: string) => Promise<string>;
  /** Read one line without echoing it; also used for --api-key-stdin pipes. */
  readSecret?: (prompt: string) => Promise<string>;
}

export function writeLine(
  stream: Pick<NodeJS.WriteStream, "write"> | undefined,
  message: string,
): void {
  write(stream, `${message}\n`);
}

export function write(
  stream: Pick<NodeJS.WriteStream, "write"> | undefined,
  message: string,
): void {
  stream?.write(message);
}
