import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteText } from "@sparkwright/agent-runtime";

const FILE_STORE_VERSION = 1;
const KEYCHAIN_SERVICE = "SparkWright Provider Credential";

export interface ProviderCredentialStore {
  get(connectionId: string): Promise<string | undefined>;
  put(connectionId: string, secret: string): Promise<void>;
  remove(connectionId: string): Promise<void>;
}

export interface ProviderCredentialStoreOptions {
  env?: Record<string, string | undefined>;
  statePath?: string;
  platform?: NodeJS.Platform;
}

interface FileCredentialState {
  version: typeof FILE_STORE_VERSION;
  revision: number;
  entries: Record<string, string>;
}

/**
 * Select the credential backend without silently weakening storage assurance.
 * macOS uses Keychain. Headless/non-macOS users must deliberately opt in to the
 * 0600 file backend with SPARKWRIGHT_CREDENTIAL_STORE=file or inject a backend.
 */
export function createProviderCredentialStore(
  options: ProviderCredentialStoreOptions = {},
): ProviderCredentialStore {
  const env = options.env ?? process.env;
  const requested = env.SPARKWRIGHT_CREDENTIAL_STORE?.trim().toLowerCase();
  if (requested === "file") {
    return new FileProviderCredentialStore(
      options.statePath ?? providerCredentialFilePath(env),
    );
  }
  if (requested && requested !== "keychain") {
    throw new Error(
      `Unsupported SPARKWRIGHT_CREDENTIAL_STORE value "${requested}". Use "keychain" or explicitly opt in to "file".`,
    );
  }
  if ((options.platform ?? process.platform) === "darwin") {
    return new MacOsKeychainCredentialStore();
  }
  throw new Error(
    "No operating-system credential backend is available on this platform. Configure a headless credential backend or explicitly set SPARKWRIGHT_CREDENTIAL_STORE=file to use the lower-assurance 0600 file store.",
  );
}

export function providerCredentialFilePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const stateBase =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(stateBase, "sparkwright", "provider-credentials.json");
}

export class MemoryProviderCredentialStore implements ProviderCredentialStore {
  private readonly entries = new Map<string, string>();

  async get(connectionId: string): Promise<string | undefined> {
    return this.entries.get(connectionId);
  }

  async put(connectionId: string, secret: string): Promise<void> {
    this.entries.set(connectionId, secret);
  }

  async remove(connectionId: string): Promise<void> {
    this.entries.delete(connectionId);
  }
}

export class FileProviderCredentialStore implements ProviderCredentialStore {
  constructor(private readonly path: string) {}

  async get(connectionId: string): Promise<string | undefined> {
    return (await this.read()).entries[connectionId];
  }

  async put(connectionId: string, secret: string): Promise<void> {
    await withExclusiveFileLock(`${this.path}.lock`, async () => {
      const current = await this.read();
      await this.write({
        ...current,
        revision: current.revision + 1,
        entries: { ...current.entries, [connectionId]: secret },
      });
    });
  }

  async remove(connectionId: string): Promise<void> {
    await withExclusiveFileLock(`${this.path}.lock`, async () => {
      const current = await this.read();
      if (!(connectionId in current.entries)) return;
      const entries = { ...current.entries };
      delete entries[connectionId];
      await this.write({
        ...current,
        revision: current.revision + 1,
        entries,
      });
    });
  }

  private async read(): Promise<FileCredentialState> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: FILE_STORE_VERSION, revision: 0, entries: {} };
      }
      throw new Error("Unable to read the provider credential store.");
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isFileCredentialState(parsed)) throw new Error("invalid shape");
      return parsed;
    } catch {
      throw new Error(
        "The provider credential store is invalid; no credential was read.",
      );
    }
  }

  private async write(state: FileCredentialState): Promise<void> {
    await atomicWriteText(this.path, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      durable: true,
    });
  }
}

export class MacOsKeychainCredentialStore implements ProviderCredentialStore {
  async get(connectionId: string): Promise<string | undefined> {
    const result = await runSecurity([
      "find-generic-password",
      "-a",
      connectionId,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
    return result.code === 0
      ? result.stdout.replace(/[\r\n]+$/, "")
      : undefined;
  }

  async put(connectionId: string, secret: string): Promise<void> {
    // `security ... -w` as the final argument reads the password from stdin,
    // keeping the secret out of argv and process listings.
    const result = await runSecurity(
      [
        "add-generic-password",
        "-U",
        "-a",
        connectionId,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ],
      `${secret}\n`,
    );
    if (result.code !== 0) {
      throw new Error(
        "The operating-system credential store rejected the key.",
      );
    }
  }

  async remove(connectionId: string): Promise<void> {
    await runSecurity([
      "delete-generic-password",
      "-a",
      connectionId,
      "-s",
      KEYCHAIN_SERVICE,
    ]);
  }
}

export async function withExclusiveFileLock<T>(
  lockPath: string,
  run: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, nonce: randomBytes(8).toString("hex"), createdAt: new Date().toISOString() })}\n`,
        );
        await handle.close();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true });
        throw error;
      }
      try {
        return await run();
      } finally {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > staleMs) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the provider state lock.");
      }
      await delay(20 + Math.floor(Math.random() * 30));
    }
  }
}

async function runSecurity(
  args: string[],
  stdinValue?: string,
): Promise<{ code: number; stdout: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn("/usr/bin/security", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 128 * 1024) stdout += chunk;
    });
    // Drain stderr without retaining provider- or secret-controlled text.
    child.stderr.resume();
    child.once("error", () => {
      rejectRun(
        new Error("The operating-system credential store is unavailable."),
      );
    });
    child.once("close", (code) => {
      resolveRun({ code: code ?? 1, stdout });
    });
    child.stdin.end(stdinValue ?? "");
  });
}

function isFileCredentialState(value: unknown): value is FileCredentialState {
  if (!isRecord(value)) return false;
  if (value.version !== FILE_STORE_VERSION) return false;
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
    return false;
  }
  return (
    isRecord(value.entries) &&
    Object.entries(value.entries).every(
      ([key, entry]) => key.length > 0 && typeof entry === "string",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}
