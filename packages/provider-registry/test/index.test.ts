import { describe, expect, it, vi } from "vitest";
import type { ModelAdapter, ModelInput, ModelOutput } from "@sparkwright/core";
import {
  ProviderRegistry,
  createProviderFallbackChain,
  resolveModel,
  type ProviderDefinition,
} from "../src/index.js";

describe("ProviderRegistry", () => {
  it("resolves provider-qualified models and preserves metadata", async () => {
    const registry = new ProviderRegistry([
      provider("alpha", [
        {
          id: "fast",
          aliases: ["default"],
          contextWindow: 128_000,
          capabilities: { completion: true, streaming: true },
          metadata: { tier: "small" },
        },
      ]),
    ]);

    await expect(
      resolveModel(registry, "alpha:default"),
    ).resolves.toMatchObject({
      providerId: "alpha",
      model: {
        id: "fast",
        providerId: "alpha",
        contextWindow: 128_000,
        capabilities: { streaming: true },
        metadata: { tier: "small" },
      },
    });
  });

  it("resolves unqualified model ids only when they are unique", async () => {
    const registry = new ProviderRegistry([
      provider("alpha", [{ id: "shared" }]),
      provider("beta", [{ id: "shared" }]),
    ]);

    await expect(registry.resolveModel("shared")).rejects.toThrow(
      "ambiguous across providers",
    );
  });

  it("filters models by required capabilities", async () => {
    const registry = new ProviderRegistry([
      provider("alpha", [
        { id: "text", capabilities: { completion: true, vision: false } },
        { id: "vision", capabilities: { completion: true, vision: true } },
      ]),
    ]);

    await expect(
      registry.listModels({ requireCapabilities: { vision: true } }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "vision", providerId: "alpha" }),
    ]);
  });

  it("caches adapters by provider and model", async () => {
    const createAdapter = vi.fn(() => adapter("ok"));
    const registry = new ProviderRegistry([
      {
        ...provider("alpha", [{ id: "fast" }]),
        createAdapter,
      },
    ]);

    const first = await registry.getAdapter("alpha:fast");
    const second = await registry.getAdapter("alpha:fast");

    expect(first).toBe(second);
    expect(createAdapter).toHaveBeenCalledTimes(1);
    expect(registry.adapterCacheSize).toBe(1);
  });

  it("does not conflate custom adapter options without an explicit cache key", async () => {
    const createAdapter = vi.fn(({ adapterOptions }) =>
      adapter(String((adapterOptions as { label: string }).label)),
    );
    const registry = new ProviderRegistry([
      {
        ...provider("alpha", [{ id: "fast" }]),
        createAdapter,
      },
    ]);

    const first = await registry.getAdapter("alpha:fast", {
      adapterOptions: { label: "first" },
    });
    const second = await registry.getAdapter("alpha:fast", {
      adapterOptions: { label: "second" },
    });

    await expect(first.complete({} as ModelInput)).resolves.toEqual({
      message: "first",
    });
    await expect(second.complete({} as ModelInput)).resolves.toEqual({
      message: "second",
    });
    expect(createAdapter).toHaveBeenCalledTimes(2);
  });
});

describe("createProviderFallbackChain", () => {
  it("does not expose the retired fallback-chain alias", async () => {
    const exports = await import("../src/index.js");
    expect(exports).not.toHaveProperty("createFallbackChain");
  });

  it("builds a core fallback adapter from resolved providers", async () => {
    const registry = new ProviderRegistry([
      {
        ...provider("alpha", [{ id: "primary" }]),
        createAdapter: () => ({
          async complete(): Promise<ModelOutput> {
            throw new Error("primary failed");
          },
        }),
      },
      provider("beta", [{ id: "backup" }], adapter("backup ok")),
    ]);
    const onFailure = vi.fn();

    const fallback = await createProviderFallbackChain(
      registry,
      ["alpha:primary", "beta:backup"],
      { onFailure },
    );

    await expect(fallback.complete({} as ModelInput)).resolves.toEqual({
      message: "backup ok",
    });
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: "alpha:primary", attempt: 1 }),
    );
  });
});

function provider(
  id: string,
  models: ProviderDefinition["models"],
  modelAdapter: ModelAdapter = adapter(`${id} ok`),
): ProviderDefinition {
  return {
    id,
    models,
    createAdapter: () => modelAdapter,
  };
}

function adapter(message: string): ModelAdapter {
  return {
    async complete(): Promise<ModelOutput> {
      return { message };
    },
  };
}
