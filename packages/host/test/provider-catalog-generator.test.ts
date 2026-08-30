import { describe, expect, it } from "vitest";
import {
  applyOpenRouterCatalog,
  parseModelsDevCatalog,
  renderGeneratedCatalog,
  summarizeCatalogDiff,
  type GeneratedProviderCatalog,
} from "../../../scripts/provider-catalog/lib.js";

const FALLBACK: GeneratedProviderCatalog = {
  version: 7,
  providers: [
    {
      id: "chatgpt",
      displayName: "ChatGPT",
      models: [],
    },
    {
      id: "openai",
      displayName: "OpenAI",
      models: [{ id: "old-model", displayName: "Old Model" }],
    },
    {
      id: "google",
      displayName: "Google",
      models: [{ id: "fallback-model" }],
    },
    {
      id: "openrouter",
      displayName: "OpenRouter",
      models: [{ id: "fallback/vendor-model" }],
    },
  ],
};

describe("provider catalog generator", () => {
  it("imports only model identity and preserves a missing provider fallback", () => {
    const generated = parseModelsDevCatalog({
      fallback: FALLBACK,
      additions: {
        google: [{ id: "code-reviewed-model", displayName: "Reviewed" }],
      },
      source: {
        openai: {
          api: "https://ignored.example/v1",
          npm: "ignored-package",
          models: {
            "new-model": {
              id: "new-model",
              name: "New Model",
              reasoning: true,
              cost: { input: 1, output: 2 },
            },
          },
        },
      },
    });

    expect(generated.version).toBe(8);
    expect(
      generated.providers.find((provider) => provider.id === "openai"),
    ).toEqual({
      id: "openai",
      displayName: "OpenAI",
      models: [{ id: "new-model", displayName: "New Model" }],
    });
    expect(
      generated.providers.find((provider) => provider.id === "google")?.models,
    ).toEqual([
      { id: "code-reviewed-model", displayName: "Reviewed" },
      { id: "fallback-model" },
    ]);
    expect(JSON.stringify(generated)).not.toContain("ignored.example");
    expect(JSON.stringify(generated)).not.toContain("ignored-package");
    expect(JSON.stringify(generated)).not.toContain("cost");
  });

  it("rejects empty provider replacement and mismatched model ids", () => {
    expect(() =>
      parseModelsDevCatalog({
        fallback: FALLBACK,
        source: { openai: { models: {} } },
      }),
    ).toThrow("invalid model count");
    expect(() =>
      parseModelsDevCatalog({
        fallback: FALLBACK,
        source: {
          openai: {
            models: { alias: { id: "different-model", name: "Different" } },
          },
        },
      }),
    ).toThrow("does not match its key");
  });

  it("lets the direct OpenRouter shard replace only OpenRouter model identity", () => {
    const generated = applyOpenRouterCatalog({
      catalog: FALLBACK,
      source: {
        data: [
          {
            id: "vendor/new-model",
            name: "Vendor New Model",
            pricing: { prompt: "ignored" },
            architecture: { tokenizer: "ignored" },
          },
        ],
      },
    });

    expect(generated.version).toBe(FALLBACK.version);
    expect(
      generated.providers.find((provider) => provider.id === "openrouter"),
    ).toEqual({
      id: "openrouter",
      displayName: "OpenRouter",
      models: [{ id: "vendor/new-model", displayName: "Vendor New Model" }],
    });
    expect(
      generated.providers.find((provider) => provider.id === "openai"),
    ).toEqual(FALLBACK.providers.find((provider) => provider.id === "openai"));
    expect(JSON.stringify(generated)).not.toContain("pricing");
    expect(JSON.stringify(generated)).not.toContain("tokenizer");
  });

  it("rejects invalid or duplicate OpenRouter model lists", () => {
    expect(() =>
      applyOpenRouterCatalog({ catalog: FALLBACK, source: { data: [] } }),
    ).toThrow("invalid model count");
    expect(() =>
      applyOpenRouterCatalog({
        catalog: FALLBACK,
        source: { data: [{ id: "duplicate" }, { id: "duplicate" }] },
      }),
    ).toThrow("duplicated");
  });

  it("renders stable source evidence and an auditable diff", async () => {
    const generated = parseModelsDevCatalog({
      fallback: FALLBACK,
      source: {
        openai: { models: { current: { id: "current", name: "Current" } } },
      },
    });
    const rendered = await renderGeneratedCatalog({
      catalog: generated,
      sourceText: "{}",
    });
    expect(rendered).toContain(
      "// Source digest: sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
    expect(rendered).toContain("version: 8");
    expect(rendered).toContain('id: "current"');
    expect(rendered).toContain('displayName: "Current"');
    expect(rendered.endsWith("as const;\n")).toBe(true);
    expect(summarizeCatalogDiff(FALLBACK, generated)).toEqual(
      expect.arrayContaining([
        {
          providerId: "openai",
          before: 1,
          after: 1,
          added: ["current"],
          removed: ["old-model"],
          changed: [],
        },
      ]),
    );
  });

  it("renders independent evidence for every successful catalog shard", async () => {
    const rendered = await renderGeneratedCatalog({
      catalog: FALLBACK,
      sources: [
        { id: "models.dev", text: "{}" },
        { id: "openrouter", text: '{"data":[]}' },
      ],
    });
    expect(rendered).toContain("// Source digest (models.dev): sha256:");
    expect(rendered).toContain("// Source digest (openrouter): sha256:");
  });
});
