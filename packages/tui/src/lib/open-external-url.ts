import { spawn } from "node:child_process";

/** Open a bounded web URL without invoking a shell. */
export async function openExternalUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    (parsed.protocol === "http:" && !isLoopback(parsed.hostname))
  ) {
    return false;
  }
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [parsed.toString()] }
      : process.platform === "win32"
        ? {
            file: "rundll32",
            args: ["url.dll,FileProtocolHandler", parsed.toString()],
          }
        : { file: "xdg-open", args: [parsed.toString()] };
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => finish(false));
    child.once("spawn", () => {
      child.unref();
      finish(true);
    });
    function finish(opened: boolean): void {
      if (settled) return;
      settled = true;
      resolve(opened);
    }
  });
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}
