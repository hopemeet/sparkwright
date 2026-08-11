import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileProviderCredentialStore,
  MacOsKeychainCredentialStore,
  normalizeProviderEndpoint,
} from "../src/index.js";

describe("provider credential storage", () => {
  it("serializes concurrent file-store mutations without losing a key", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-provider-secrets-"));
    const path = join(root, "credentials.json");
    const first = new FileProviderCredentialStore(path);
    const second = new FileProviderCredentialStore(path);

    await Promise.all([
      first.put("connection_first", "secret-first"),
      second.put("connection_second", "secret-second"),
    ]);

    expect(await first.get("connection_first")).toBe("secret-first");
    expect(await second.get("connection_second")).toBe("secret-second");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("fails closed on corrupt secret state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-provider-secrets-"));
    const path = join(root, "credentials.json");
    await writeFile(path, "not-json", { mode: 0o600 });

    await expect(
      new FileProviderCredentialStore(path).get("connection_missing"),
    ).rejects.toThrow("credential store is invalid");
    expect(await readFile(path, "utf8")).toBe("not-json");
  });

  it.skipIf(process.platform !== "darwin")(
    "writes Keychain secrets through an isolated password-prompt PTY",
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), "sparkwright-provider-keychain-pty-"),
      );
      const fakeSecurityPath = join(root, "security");
      const capturedSecretPath = join(root, "captured-secret");
      await writeFile(
        fakeSecurityPath,
        `#!/bin/sh
account=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-a" ]; then
    shift
    account="$1"
  fi
  shift
done
printf 'password data for new item:' > /dev/tty
IFS= read -r first < /dev/tty
printf 'retype password for new item:' > /dev/tty
IFS= read -r second < /dev/tty
[ -n "$first" ] || exit 41
[ "$first" = "$second" ] || exit 42
printf '%s' "$first" > "$account"
`,
        { mode: 0o700 },
      );
      const store = new MacOsKeychainCredentialStore({
        securityPath: fakeSecurityPath,
      });

      try {
        await expect(
          store.put(capturedSecretPath, "keychain-pty-secret-sentinel"),
        ).resolves.toBeUndefined();
        await expect(readFile(capturedSecretPath, "utf8")).resolves.toBe(
          "keychain-pty-secret-sentinel",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(process.platform !== "darwin")(
    "does not disclose a Keychain secret to an unexpected terminal prompt",
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), "sparkwright-provider-keychain-reject-prompt-"),
      );
      const fakeSecurityPath = join(root, "security");
      await writeFile(
        fakeSecurityPath,
        `#!/bin/sh
printf 'unexpected credential prompt:' > /dev/tty
exit 0
`,
        { mode: 0o700 },
      );
      const store = new MacOsKeychainCredentialStore({
        securityPath: fakeSecurityPath,
      });

      try {
        await expect(
          store.put(join(root, "unused"), "must-not-be-sent"),
        ).rejects.toThrow("credential store rejected the key");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("provider endpoint normalization", () => {
  it("normalizes default ports and trailing slashes", () => {
    expect(normalizeProviderEndpoint("https://EXAMPLE.com:443/v1///")).toBe(
      "https://example.com/v1",
    );
  });

  it.each([
    "https://user@example.com/v1",
    "https://example.com/v1?redirect=evil",
    "https://example.com/v1#fragment",
    "http://example.com/v1",
    "file:///tmp/provider",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => normalizeProviderEndpoint(endpoint)).toThrow();
  });

  it("allows loopback HTTP for local provider development", () => {
    expect(normalizeProviderEndpoint("http://127.0.0.1:8080/v1/")).toBe(
      "http://127.0.0.1:8080/v1",
    );
  });
});
