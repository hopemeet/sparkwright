# Provider Edge

SparkWright core should stay provider-neutral. Real model providers live at the edge and adapt into the core `ModelAdapter` interface.

The first provider edge is `@sparkwright/provider-ai-sdk`, a thin bridge over
the Vercel AI SDK. Provider/model selection for product shells lives in the
optional `@sparkwright/provider-registry` package.

Provider selection is config-driven. A run references a model as
`"<provider>/<model>"`, and the `<provider>` key is looked up in the
`providers` map of the merged shared config (user → project → env). Each
provider entry names the AI SDK npm package that implements it, plus the
endpoint and credentials:

```jsonc
{
  "model": "openai/gpt-5.4-mini",
  "providers": {
    "openai": {
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "sk-...",
    },
  },
}
```

`npm` defaults to `@ai-sdk/openai` when omitted. The reserved provider key
`deterministic` selects the built-in offline model used for stable demos and
tests, and is also the default when no `model` is configured.

If `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, or `http_proxy` is set, the CLI
passes that proxy explicitly into the provider's `fetch`. This matters because
Node's built-in `fetch` does not consistently honor proxy environment variables
by itself.

## Adding a New Provider

The Vercel AI SDK ships each provider as its own npm package
(`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/mistral`,
…). Installing the core `ai` package does **not** pull these in — every
provider package is separate. SparkWright supports a curated allow-list of
these packages rather than installing any package a config names (the host does
not auto-install; see "Non-goals" below).

Adding support for a provider that SparkWright does not yet allow takes three
steps:

1. **Register the package metadata.** Add an entry to
   `SUPPORTED_PROVIDER_NPMS` in [`packages/host/src/config.ts`](../../packages/host/src/config.ts).
   The key is the npm package name; the value records its factory export and
   the default API-key environment variable. For example, to add Mistral:

   ```ts
   "@ai-sdk/mistral": { factory: "createMistral", apiKeyEnv: "MISTRAL_API_KEY" },
   ```

   The factory name is the `create*` function the package exports
   (`createOpenAI`, `createAnthropic`, `createGoogleGenerativeAI`, …); it must
   return a `(modelId) => LanguageModel` callable that accepts
   `{ apiKey, baseURL, fetch }`. All first-party `@ai-sdk/*` packages follow
   this shape, so no per-provider adapter code is needed — `model-builder.ts`
   builds them all through the same generic path.

2. **Install the package.** It is loaded lazily via `import(npm)` at run time,
   so it must be a real dependency:

   ```bash
   npm install --workspace=@sparkwright/host @ai-sdk/mistral
   ```

   If the package is named in a config but not installed, the run fails with a
   friendly `Install it: npm install <pkg>` message rather than a crash.

3. **Reference it in config.** Add a provider entry whose `npm` points at the
   new package, then select it via `model`:

   ```jsonc
   {
     "model": "mistral/mistral-large-latest",
     "providers": {
       "mistral": {
         "npm": "@ai-sdk/mistral",
         "baseURL": "https://api.mistral.ai/v1",
         "apiKey": "...",
       },
     },
   }
   ```

Currently allow-listed packages: `@ai-sdk/openai`, `@ai-sdk/anthropic`,
`@ai-sdk/google`. An OpenAI-compatible gateway needs no new package — keep
`npm` as the default `@ai-sdk/openai` and just point `baseURL` at the gateway.

## Design Goals

- keep `@sparkwright/core` free of provider SDK dependencies
- reuse mature provider ecosystems instead of rebuilding them
- normalize provider responses into `ModelOutput`
- expose tool schemas to models without letting provider SDKs execute tools
- preserve SparkWright as the owner of policy, approval, tool execution, trace, and workspace mutation

## Current Packages

```txt
packages/provider-ai-sdk
packages/provider-registry
```

Responsibilities:

- accept an AI SDK `LanguageModel`
- convert SparkWright `PromptMessage[]` into AI SDK model messages
- convert SparkWright `ToolDescriptor[]` into AI SDK tool definitions
- call `generateText`
- normalize generated text and tool calls into SparkWright `ModelOutput`
- leave provider retries disabled by default so SparkWright owns retry events and terminal failure metadata

`@sparkwright/provider-registry` responsibilities:

- register provider definitions without depending on provider SDKs
- list and filter model metadata by capability
- resolve provider-qualified or unique model references
- cache constructed `ModelAdapter` instances
- compose fallback chains through core's provider-neutral fallback helper

Non-goals for provider packages:

- auth store beyond reading provider environment variables at the CLI edge
- dynamic npm install
- model metadata sync
- production provider routing service
- production streaming service
- automatic tool execution

## Routing, Fallback, And Cancellation

Core exports small provider-neutral wrappers for service backends that need
routing without moving provider logic into the run loop:

- `createRoutingModelAdapter(routes, { fallback })` selects an adapter from
  structured `ModelInput`.
- `createFallbackModelAdapter([{ id, adapter }, ...])` tries adapters in order
  and reports failures through `onFailure`.
- `createAbortableModelAdapter(adapter, { signal })` gives hosted services a
  cancellation boundary around `complete` and `stream`.

These wrappers do not read auth, mutate policy, or execute tools. They are
composition helpers at the provider edge; product services can wrap them with
their own telemetry, budgets, and trace subscribers.

## Usage Sketch

```ts
import { createRun } from "@sparkwright/core";
import { createAiSdkModelAdapter } from "@sparkwright/provider-ai-sdk";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const model = createAiSdkModelAdapter({
  model: openai("<your-model>"),
});

const run = createRun({
  goal: "Inspect this repo and suggest a README improvement.",
  model,
  tools: [],
});
```

Registry-backed selection keeps provider metadata and adapter construction at
the edge:

```ts
import { ProviderRegistry } from "@sparkwright/provider-registry";

const registry = new ProviderRegistry([
  {
    id: "openai",
    defaultModelId: "gpt-4.1-mini",
    models: [
      {
        id: "gpt-4.1-mini",
        capabilities: { completion: true, streaming: true, toolCalling: true },
      },
    ],
    createAdapter({ model }) {
      return createAiSdkModelAdapter({ model: openai(model.id) });
    },
  },
]);

const model = await registry.getAdapter("openai:gpt-4.1-mini");
```

OpenRouter, LiteLLM, and other gateways work today through an OpenAI-compatible `baseURL` on an `@ai-sdk/openai` provider entry; native AI SDK provider packages are added via the allow-list (see "Adding a New Provider").

## Tool Execution Boundary

The AI SDK adapter exposes tool definitions to the model, but it does not execute them.

Tool calls come back as:

```ts
{
  toolCalls: [
    {
      toolName: "read_file",
      arguments: { path: "README.md" },
    },
  ];
}
```

The SparkWright run loop then performs:

```txt
validate arguments -> check policy -> request approval if needed -> execute tool -> emit events -> append observation
```

This keeps controlled tool calling inside the harness.

## Why AI SDK First

AI SDK already normalizes many provider differences and supports a wide range of hosted APIs, gateways, and OpenAI-compatible endpoints.

SparkWright should use this ecosystem early and only build deeper provider infrastructure when real usage demands it.

## Later Provider Service

A future provider service may add:

- environment/config activation
- small model selection for summaries
- request and chunk timeouts
- provider-specific custom loaders
- dynamic provider installation

Those are useful, but they should not block the first real model-backed repo-pilot.
