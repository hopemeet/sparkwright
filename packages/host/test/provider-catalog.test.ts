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

  it("applies modelPolicy before modelOverrides and requested models", async () => {
    const registry = createHostProviderRegistry({
      configuredProviders: {
        openai: {
          modelPolicy: {
            allow: ["gpt-5.4-mini", "gpt-5.4-nano"],
            deny: ["gpt-5.4-nano"],
          },
          modelOverrides: {
            "gpt-5.4-mini": {
              cost: { input: 2 },
              providerOptions: { openai: { reasoningEffort: "low" } },
            },
            unlisted: { cost: { input: 99 } },
          },
        },
      },
      providerIds: ["openai"],
      includeBundledProviders: false,
      requestedModels: { openai: ["unlisted"] },
    });

    await expect(
      registry.listModels({ providerId: "openai" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "gpt-5.4-mini",
        pricing: expect.objectContaining({ inputPerMTokUsd: 2 }),
        metadata: expect.objectContaining({
          providerOptions: { openai: { reasoningEffort: "low" } },
        }),
      }),
    ]);
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

  it("keeps a user-defined provider usable without any catalog entry", async () => {
    const registry = createHostProviderRegistry({
      configuredProviders: {
        private_gateway: {
          npm: "@ai-sdk/openai-compatible",
          baseURL: "https://models.example.test/v1",
        },
      },
      providerIds: ["private_gateway"],
      includeBundledProviders: false,
      requestedModels: { private_gateway: ["private-model"] },
    });

    expect(registry.listProviders().map((provider) => provider.id)).toEqual([
      "private_gateway",
    ]);
    await expect(
      registry.listModels({ providerId: "private_gateway" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "private-model",
        providerId: "private_gateway",
      }),
    ]);
  });

  it("uses the bundled snapshot when no external catalog state exists", async () => {
    const registry = createHostProviderRegistry({});

    expect(BUNDLED_PROVIDER_CATALOG_VERSION).toBe(6);
    expect(registry.listProviders().map((provider) => provider.id)).toEqual([
      "anthropic",
      "chatgpt",
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
    expect(BUNDLED_PROVIDER_CONNECTION_DESCRIPTORS).toHaveLength(5);
    for (const descriptor of BUNDLED_PROVIDER_CONNECTION_DESCRIPTORS) {
      expect(descriptor.driverId).toMatch(/\.v1$/);
      expect(descriptor).not.toHaveProperty("models");
      if (descriptor.providerId !== "chatgpt") {
        expect(descriptor.authMethods).toContainEqual(
          expect.objectContaining({ id: "api_key", kind: "api_key" }),
        );
      }
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
    expect(
      BUNDLED_PROVIDER_CONNECTION_DESCRIPTORS.find(
        (descriptor) => descriptor.providerId === "chatgpt",
      ),
    ).toMatchObject({
      displayName: "ChatGPT",
      npm: "@openai/codex",
      officialEndpoint: "https://chatgpt.com",
      modelDiscovery: { kind: "chatgpt_app_server" },
    });
  });
});

function adapter(message: string): ModelAdapter {
  return {
    async complete(): Promise<ModelOutput> {
      return { message };
    },
  };
}
