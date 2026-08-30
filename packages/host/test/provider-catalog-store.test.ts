import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProviderCatalogStore,
  providerCatalogDigest,
  verifySignedProviderCatalogArtifact,
  type SignedProviderCatalogArtifact,
} from "../src/provider-catalog-store.js";
import {
  BUNDLED_PROVIDER_CATALOG,
  mergeProviderCatalogSnapshots,
} from "../src/provider-catalog.js";

describe("ProviderCatalogStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("coordinates recoverable cross-process refresh leases", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-catalog-lease-"));
    roots.push(root);
    const path = join(root, "provider-catalog.json");
    let now = new Date("2026-08-09T00:00:00.000Z");
    const first = new ProviderCatalogStore({ path, now: () => now });
    const second = new ProviderCatalogStore({ path, now: () => now });

    await expect(
      first.claimRefreshLease({ ownerId: "host-a", ttlMs: 60_000 }),
    ).resolves.toBe(true);
    await expect(
      second.claimRefreshLease({ ownerId: "host-b", ttlMs: 60_000 }),
    ).resolves.toBe(false);

    await second.releaseRefreshLease("host-b");
    await expect(
      second.claimRefreshLease({ ownerId: "host-b", ttlMs: 60_000 }),
    ).resolves.toBe(false);

    now = new Date("2026-08-09T00:01:01.000Z");
    await expect(
      second.claimRefreshLease({ ownerId: "host-b", ttlMs: 60_000 }),
    ).resolves.toBe(true);
    await first.releaseRefreshLease("host-a");
    await expect(
      first.claimRefreshLease({ ownerId: "host-c", ttlMs: 60_000 }),
    ).resolves.toBe(false);

    await second.releaseRefreshLease("host-b");
    await expect(
      first.claimRefreshLease({ ownerId: "host-c", ttlMs: 60_000 }),
    ).resolves.toBe(true);
  });

  it("verifies signed bounded metadata and rejects tampering", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const payload = {
      schemaVersion: 1 as const,
      issuedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-10T00:00:00.000Z",
      catalog: mergeProviderCatalogSnapshots({
        base: BUNDLED_PROVIDER_CATALOG,
        providers: [
          {
            id: "openrouter",
            displayName: "OpenRouter",
            models: [{ id: "vendor/model-new", displayName: "Model New" }],
          },
        ],
      }),
    };
    const bytes = Buffer.from(JSON.stringify(payload));
    const artifact: SignedProviderCatalogArtifact = {
      artifactVersion: 1,
      keyId: "test-key",
      payload: bytes.toString("base64url"),
      signature: sign(null, bytes, privateKey).toString("base64url"),
    };
    const trustedKeys = {
      "test-key": publicKey.export({ type: "spki", format: "pem" }).toString(),
    };

    expect(
      verifySignedProviderCatalogArtifact({
        artifact,
        trustedKeys,
        now: new Date("2026-08-09T01:00:00.000Z"),
      }).catalog.providers.find((provider) => provider.id === "openrouter")
        ?.models,
    ).toEqual([
      expect.objectContaining({
        id: "vendor/model-new",
        providerId: "openrouter",
      }),
    ]);

    expect(() =>
      verifySignedProviderCatalogArtifact({
        artifact: {
          ...artifact,
          payload: `${artifact.payload[0] === "A" ? "B" : "A"}${artifact.payload.slice(1)}`,
        },
        trustedKeys,
        now: new Date("2026-08-09T01:00:00.000Z"),
      }),
    ).toThrow(/signature|payload/i);
  });

  it("verifies artifact v2 source revision and catalog digest", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const catalog = mergeProviderCatalogSnapshots({
      base: BUNDLED_PROVIDER_CATALOG,
      providers: [
        {
          id: "openrouter",
          displayName: "OpenRouter",
          models: [{ id: "artifact-v2/model" }],
        },
      ],
    });
    const payload = {
      schemaVersion: 2 as const,
      issuedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-10T00:00:00.000Z",
      sourceRevision: "catalog-build-42",
      catalogDigest: providerCatalogDigest(catalog),
      catalog,
    };
    const bytes = Buffer.from(JSON.stringify(payload));
    const trustedKeys = {
      "rotating-key": publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    };

    expect(
      verifySignedProviderCatalogArtifact({
        artifact: {
          artifactVersion: 2,
          keyId: "rotating-key",
          payload: bytes.toString("base64url"),
          signature: sign(null, bytes, privateKey).toString("base64url"),
        },
        trustedKeys,
        now: new Date("2026-08-09T01:00:00.000Z"),
      }),
    ).toMatchObject({
      schemaVersion: 2,
      sourceRevision: "catalog-build-42",
      catalogDigest: payload.catalogDigest,
    });

    const wrongDigestBytes = Buffer.from(
      JSON.stringify({ ...payload, catalogDigest: `sha256:${"0".repeat(64)}` }),
    );
    expect(() =>
      verifySignedProviderCatalogArtifact({
        artifact: {
          artifactVersion: 2,
          keyId: "rotating-key",
          payload: wrongDigestBytes.toString("base64url"),
          signature: sign(null, wrongDigestBytes, privateKey).toString(
            "base64url",
          ),
        },
        trustedKeys,
        now: new Date("2026-08-09T01:00:00.000Z"),
      }),
    ).toThrow("digest or source revision");
  });

  it("keeps signed last-known-good data and prevents a stale publisher from winning", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-catalog-store-"));
    roots.push(root);
    const path = join(root, "provider-catalog.json");
    let now = new Date("2026-08-09T00:00:00.000Z");
    const store = new ProviderCatalogStore({ path, now: () => now });
    const firstCatalog = mergeProviderCatalogSnapshots({
      base: BUNDLED_PROVIDER_CATALOG,
      providers: [
        {
          id: "openrouter",
          displayName: "OpenRouter",
          models: [{ id: "first/model" }],
        },
      ],
    });
    const first = await store.publish({
      expectedGeneration: 0,
      source: "signed",
      fetchedAt: now.toISOString(),
      expiresAt: "2026-08-09T00:10:00.000Z",
      catalog: firstCatalog,
    });
    expect(first).toMatchObject({
      published: true,
      snapshot: { generation: 1 },
    });

    const secondCatalog = mergeProviderCatalogSnapshots({
      base: firstCatalog,
      providers: [
        {
          id: "openrouter",
          displayName: "OpenRouter",
          models: [{ id: "second/model" }],
        },
      ],
    });
    const second = await store.publish({
      expectedGeneration: 1,
      source: "signed",
      fetchedAt: now.toISOString(),
      expiresAt: "2026-08-09T00:20:00.000Z",
      catalog: secondCatalog,
    });
    expect(second).toMatchObject({
      published: true,
      snapshot: { generation: 2 },
    });

    const stale = await store.publish({
      expectedGeneration: 1,
      source: "signed",
      fetchedAt: now.toISOString(),
      expiresAt: "2026-08-09T00:30:00.000Z",
      catalog: firstCatalog,
    });
    expect(stale).toMatchObject({
      published: false,
      snapshot: { generation: 2 },
    });

    await writeFile(path, "{corrupt", "utf8");
    const recovered = await store.current();
    expect(recovered).toMatchObject({ generation: 1, source: "signed" });
    expect(
      recovered.catalog.providers.find(
        (provider) => provider.id === "openrouter",
      )?.models,
    ).toEqual([expect.objectContaining({ id: "first/model" })]);

    now = new Date("2026-08-09T00:11:00.000Z");
    expect((await store.current()).stale).toBe(true);
  });

  it("rejects version rollback, same-version drift, and incomplete signed catalogs", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-catalog-version-"));
    roots.push(root);
    const store = new ProviderCatalogStore({
      path: join(root, "provider-catalog.json"),
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });
    const versionFive = mergeProviderCatalogSnapshots({
      base: BUNDLED_PROVIDER_CATALOG,
      providers: [
        {
          id: "openrouter",
          displayName: "OpenRouter",
          models: [{ id: "version-five" }],
        },
      ],
    });
    await store.publish({
      expectedGeneration: 0,
      source: "signed",
      fetchedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-10T00:00:00.000Z",
      catalog: versionFive,
    });

    await expect(
      store.publish({
        expectedGeneration: 1,
        source: "signed",
        fetchedAt: "2026-08-09T00:01:00.000Z",
        expiresAt: "2026-08-10T00:00:00.000Z",
        catalog: BUNDLED_PROVIDER_CATALOG,
      }),
    ).rejects.toThrow("backwards");
    await expect(
      store.publish({
        expectedGeneration: 1,
        source: "signed",
        fetchedAt: "2026-08-09T00:01:00.000Z",
        expiresAt: "2026-08-10T00:00:00.000Z",
        catalog: {
          ...versionFive,
          providers: versionFive.providers.map((provider) =>
            provider.id === "openrouter"
              ? { ...provider, models: [{ id: "same-version-drift" }] }
              : provider,
          ),
        },
      }),
    ).rejects.toThrow("without a version increase");
    await expect(
      store.publish({
        expectedGeneration: 1,
        source: "signed",
        fetchedAt: "2026-08-09T00:01:00.000Z",
        expiresAt: "2026-08-10T00:00:00.000Z",
        catalog: {
          version: versionFive.version + 1,
          providers: versionFive.providers.filter(
            (provider) => provider.id !== "google",
          ),
        },
      }),
    ).rejects.toThrow('missing provider "google"');
  });

  it("isolates authenticated discovery by workspace and connection scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-discovery-scope-"));
    roots.push(root);
    const store = new ProviderCatalogStore({
      path: join(root, "provider-catalog.json"),
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });
    await store.publishDiscovery({
      expectedGeneration: 0,
      scopeKey: "workspace-a:connection-a",
      providerId: "openrouter",
      fetchedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-10T00:00:00.000Z",
      provider: {
        id: "openrouter",
        displayName: "OpenRouter",
        models: [{ id: "account-a/model" }],
      },
    });
    await store.publishDiscovery({
      expectedGeneration: 0,
      scopeKey: "workspace-b:connection-b",
      providerId: "openrouter",
      fetchedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-10T00:00:00.000Z",
      provider: {
        id: "openrouter",
        displayName: "OpenRouter",
        models: [{ id: "account-b/model" }],
      },
    });

    await expect(
      store.currentDiscovery({
        scopeKey: "workspace-a:connection-a",
        providerId: "openrouter",
      }),
    ).resolves.toMatchObject({
      source: "discovery",
      provider: {
        models: [expect.objectContaining({ id: "account-a/model" })],
      },
    });
    await expect(
      store.currentDiscovery({
        scopeKey: "workspace-b:connection-b",
        providerId: "openrouter",
      }),
    ).resolves.toMatchObject({
      provider: {
        models: [expect.objectContaining({ id: "account-b/model" })],
      },
    });
    await expect(
      store.currentDiscovery({
        scopeKey: "workspace-c:connection-c",
        providerId: "openrouter",
      }),
    ).resolves.toBeUndefined();
    await expect(store.current()).resolves.toMatchObject({
      generation: 0,
      source: "bundled",
    });
  });

  it("migrates legacy signed state but discards unscoped legacy discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-catalog-migrate-"));
    roots.push(root);
    const signedPath = join(root, "signed.json");
    const discoveryPath = join(root, "discovery.json");
    const catalog = mergeProviderCatalogSnapshots({
      base: BUNDLED_PROVIDER_CATALOG,
      providers: [
        {
          id: "openrouter",
          displayName: "OpenRouter",
          models: [{ id: "legacy/model" }],
        },
      ],
    });
    const legacy = {
      version: 1,
      generation: 3,
      fetchedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-10T00:00:00.000Z",
      catalog,
    };
    await writeFile(
      signedPath,
      JSON.stringify({ ...legacy, source: "signed" }),
      "utf8",
    );
    await writeFile(
      discoveryPath,
      JSON.stringify({ ...legacy, source: "discovery" }),
      "utf8",
    );

    await expect(
      new ProviderCatalogStore({ path: signedPath }).current(),
    ).resolves.toMatchObject({ generation: 3, source: "signed" });
    await expect(
      new ProviderCatalogStore({ path: discoveryPath }).current(),
    ).resolves.toMatchObject({ generation: 0, source: "bundled" });

    const oldPath = join(root, "old-signed.json");
    await writeFile(
      oldPath,
      JSON.stringify({
        ...legacy,
        source: "signed",
        catalog: { ...BUNDLED_PROVIDER_CATALOG, version: 4 },
      }),
      "utf8",
    );
    await expect(
      new ProviderCatalogStore({ path: oldPath }).current(),
    ).resolves.toMatchObject({
      generation: 0,
      source: "bundled",
      catalog: { version: BUNDLED_PROVIDER_CATALOG.version },
    });
  });
});
