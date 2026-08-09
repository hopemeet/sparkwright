import type { ModelAdapter, ModelOutput } from "@sparkwright/core";
import { describe, expect, it, vi } from "vitest";
import {
  BUNDLED_PROVIDER_CATALOG_VERSION,
  BUNDLED_PROVIDER_CONNECTION_DESCRIPTORS,
  createHostProviderRegistry,
  toRegistryModelRef,
} from "../src/provider-catalog.js";

describe("Host provider catalog", () => {
  it("resolves a bundled model absent from YAML through ProviderRegistry", async () => {
    const createAdapter = vi.fn(() => adapter("catalog model"));
    const registry = createHostProviderRegistry({
      configuredProviders: { openai: {} },
      providerIds: ["openai"],
      includeBundledProviders: false,
      requestedModels: { openai: ["gpt-5.4-mini"] },
      adapterFactories: { openai: createAdapter },
    });

    await expect(
      registry.resolveModel(toRegistryModelRef("openai", "gpt-5.4-mini")),
    ).resolves.toMatchObject({
      providerId: "openai",
      model: { id: "gpt-5.4-mini", providerId: "openai" },
    });
    await expect(
      (
        await registry.getAdapter(toRegistryModelRef("openai", "gpt-5.4-mini"))
      ).complete({} as never),
    ).resolves.toEqual({ message: "catalog model" });
    expect(createAdapter).toHaveBeenCalledTimes(1);
  });

  it("keeps a non-empty legacy models map as an allowlist", async () => {
    const registry = createHostProviderRegistry({
      configuredProviders: {
        openai: { models: { "gpt-4o-mini": {} } },
      },
      providerIds: ["openai"],
      includeBundledProviders: false,
      requestedModels: { openai: ["gpt-5.4-mini"] },
    });

    await expect(
      registry.listModels({ providerId: "openai" }),
    ).resolves.toEqual([expect.objectContaining({ id: "gpt-4o-mini" })]);
    await expect(
      registry.resolveModel(toRegistryModelRef("openai", "gpt-5.4-mini")),
    ).rejects.toThrow("does not define model");
  });

  it("does not project the official model catalog onto a custom endpoint", async () => {
    const registry = createHostProviderRegistry({
      configuredProviders: {
        openai: { baseURL: "https://models.example.test/v1" },
      },
      providerIds: ["openai"],
      includeBundledProviders: false,
      requestedModels: { openai: ["custom-model"] },
    });

    await expect(
      registry.listModels({ providerId: "openai" }),
    ).resolves.toEqual([expect.objectContaining({ id: "custom-model" })]);
    expect(registry.getProvider("openai")?.displayName).toBeUndefined();
  });

  it("uses the bundled snapshot when no external catalog state exists", async () => {
    const registry = createHostProviderRegistry({});

    expect(BUNDLED_PROVIDER_CATALOG_VERSION).toBe(2);
    expect(registry.listProviders().map((provider) => provider.id)).toEqual([
      "anthropic",
      "google",
      "openai",
      "openrouter",
    ]);
    await expect(
      registry.listModels({ providerId: "google" }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gemini-3.1-pro" }),
      ]),
    );
  });

  it("keeps connection descriptors code-owned and model-free", () => {
    expect(BUNDLED_PROVIDER_CONNECTION_DESCRIPTORS).toHaveLength(4);
    for (const descriptor of BUNDLED_PROVIDER_CONNECTION_DESCRIPTORS) {
      expect(descriptor.driverId).toMatch(/\.v1$/);
      expect(descriptor).not.toHaveProperty("models");
      expect(descriptor.authMethods).toContainEqual(
        expect.objectContaining({ id: "api_key", kind: "api_key" }),
      );
    }
    expect(
      BUNDLED_PROVIDER_CONNECTION_DESCRIPTORS.find(
        (descriptor) => descriptor.providerId === "openrouter",
      )?.authMethods,
    ).toContainEqual(
      expect.objectContaining({
        id: "oauth_pkce",
        kind: "oauth",
        flow: "browser",
        implementationId: "openrouter.pkce-key.v1",
      }),
    );
  });
});

function adapter(message: string): ModelAdapter {
  return {
    async complete(): Promise<ModelOutput> {
      return { message };
    },
  };
}
