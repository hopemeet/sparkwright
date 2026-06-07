export interface CliIO {
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  stdinIsTTY?: boolean;
  question?: (prompt: string) => Promise<string>;
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
