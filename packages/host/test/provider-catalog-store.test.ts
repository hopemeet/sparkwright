import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProviderCatalogStore,
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
        artifact: { ...artifact, payload: `${artifact.payload}a` },
        trustedKeys,
        now: new Date("2026-08-09T01:00:00.000Z"),
      }),
    ).toThrow(/signature|payload/i);
  });

  it("keeps last-known-good data and prevents a stale publisher from winning", async () => {
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
      source: "discovery",
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
      source: "discovery",
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
      source: "discovery",
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
    expect(recovered).toMatchObject({ generation: 1, source: "discovery" });
    expect(
      recovered.catalog.providers.find(
        (provider) => provider.id === "openrouter",
      )?.models,
    ).toEqual([expect.objectContaining({ id: "first/model" })]);

    now = new Date("2026-08-09T00:11:00.000Z");
    expect((await store.current()).stale).toBe(true);
  });
});
