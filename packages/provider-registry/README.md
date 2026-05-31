# @sparkwright/provider-registry

Small provider registry helpers for Sparkwright model adapters.

This package does not call provider APIs and does not depend on provider SDKs. A
provider definition owns adapter construction, so the registry can be composed
with `@sparkwright/provider-ai-sdk` or with a custom `ModelAdapter` directly.

## Install

```sh
npm install @sparkwright/provider-registry @sparkwright/core
```

## Usage

```ts
import { ProviderRegistry } from "@sparkwright/provider-registry";
import { createAiSdkModelAdapter } from "@sparkwright/provider-ai-sdk";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const registry = new ProviderRegistry([
  {
    id: "openai",
    defaultModelId: "gpt-4.1-mini",
    models: [
      {
        id: "gpt-4.1-mini",
        displayName: "GPT-4.1 mini",
        contextWindow: 1_000_000,
        capabilities: {
          completion: true,
          streaming: true,
          toolCalling: true,
          structuredOutput: true,
        },
      },
    ],
    createAdapter({ model }) {
      return createAiSdkModelAdapter({ model: openai(model.id) });
    },
  },
]);

const adapter = await registry.getAdapter("openai:gpt-4.1-mini");
```

## API

- `ProviderDefinition` describes a provider id, model metadata, optional config,
  and a `createAdapter` factory.
- `ModelInfo` describes model id, aliases, modalities, token windows,
  capabilities, and arbitrary metadata.
- `ProviderRegistry` registers providers, lists models, resolves model
  references, and caches adapters by provider/model.
- `resolveModel(registry, ref)` is a functional helper around
  `registry.resolveModel`.
- `createProviderFallbackChain(registry, refs)` resolves adapters and composes
  them through the core fallback adapter helper.

Model references can be provider-qualified (`"provider:model"`) or unqualified
when the model id is unique across registered providers. Object references are
also accepted:

```ts
await registry.resolveModel({ providerId: "openai", modelId: "gpt-4.1-mini" });
```

Adapter caching is on by default for provider/model references. When passing
custom adapter options, provide an explicit `cacheKey` or a provider
`getAdapterCacheKey` implementation if those options should participate in the
cache.
