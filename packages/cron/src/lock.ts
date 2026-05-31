import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileLockOptions {
  staleMs?: number;
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T | null> {
  const staleMs = options.staleMs ?? 10 * 60_000;
  const release = await tryAcquire(lockPath, staleMs);
  if (!release) return null;
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function tryAcquire(
  lockPath: string,
  staleMs: number,
): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.close();
    return async () => {
      await rm(lockPath, { force: true });
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  if (!(await isStale(lockPath, staleMs))) return null;
  await rm(lockPath, { force: true });
  try {
    await writeFile(lockPath, payload, { flag: "wx", mode: 0o600 });
    return async () => {
      await rm(lockPath, { force: true });
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const [st, raw] = await Promise.all([
      stat(lockPath),
      readFile(lockPath, "utf8").catch(() => ""),
    ]);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs <= staleMs) return false;
    const pid = readPid(raw);
    return pid === null || !processIsRunning(pid);
  } catch {
    return true;
  }
}

function readPid(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
