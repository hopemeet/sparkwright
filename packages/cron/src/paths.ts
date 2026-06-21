import { homedir } from "node:os";
import { join } from "node:path";

export function defaultCronRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(base, "sparkwright", "cron");
}
