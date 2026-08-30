# Provider Edge

SparkWright core should stay provider-neutral. Real model providers live at the edge and adapt into the core `ModelAdapter` interface.

The first provider edge is `@sparkwright/provider-ai-sdk`, a thin bridge over
the Vercel AI SDK. Provider/model selection for product shells lives in the
optional `@sparkwright/provider-registry` package.

Provider selection is Host-resolved. A run references a model as
`"<provider>/<model>"`, and the `<provider>` key is looked up in the
bundled/provider catalog plus the optional `identity.providers` map of the
merged shared config (user → project → env). Config can select a custom AI SDK
package/endpoint and model policy, while interactive credentials normally come
from `provider connect` or TUI `/connect`:

```jsonc
{
  "identity": {
    "model": "openai/gpt-5.4-mini",
    "providers": {
      "openai": {
        "baseURL": "https://api.openai.com/v1",
      },
    },
  },
}
```

`npm` defaults to `@ai-sdk/openai` when omitted. The reserved provider key
`deterministic` selects the built-in offline model used for stable demos and
tests, and is also the default when no `identity.model` is configured.

The Host projects configured and catalog providers through `provider.list`.
Credential and connection ids are opaque; responses expose status, exact
non-secret binding, grants, and source categories but never credential values.
Stored credentials live behind the Host credential-store boundary; private
config/environment keys remain compatibility sources. Connection and catalog
metadata are separate mode-`0600` state under the XDG state directory.
The catalog base is a bundled snapshot optionally replaced by a newer signed
last-known-good artifact. Account-visible discovery is a separate overlay
scoped by workspace and exact connection, so one account cannot replace
another workspace's inventory. Remote catalog metadata cannot add provider
packages, endpoints, auth methods, drivers, or adapter factories. Explicit
refresh failures retain the active scoped overlay/LKG/bundled fallback and do
not affect user-defined provider entries.
On macOS, Host answers the system Keychain command's bounded password prompts
on a private PTY so they never compete with CLI/TUI raw input; the secret is not
placed in argv or environment values, and unexpected prompts fail closed.

A provider may have multiple connections. Product surfaces select one by its
exact opaque connection id and the Host revalidates the provider, driver,
authentication method, and stored immutable endpoint before changing the
workspace grant. Project `baseURL` cannot replace that selected endpoint; a
different endpoint requires a different connection and never inherits the old
secret. Disconnecting clears the selection/grant but keeps a stored credential
available for later reselection;
the trusted local management view keeps its opaque, non-secret entry visible
while ordinary and remote catalogs remain grant-filtered. Permanent credential
removal is a separate explicit action.

Provider credentials stay typed inside the Host model-construction boundary.
API keys, including durable keys issued by an authorization flow, use the
existing AI SDK adapter path. Short-lived bearer credentials retain their
authentication realm and expiration instead of being passed as API keys.
When an OAuth credential enters its expiration safety window, the Host refreshes
it through the existing cross-process connection lock and atomically publishes
the rotated credential generation. A bearer realm without a code-owned runtime
transport is rejected before adapter construction; the Host does not send it to
a generic endpoint or fall back to an ambient credential.

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
   new package, then select it via `identity.model`:

   ```jsonc
   {
     "identity": {
       "model": "mistral/mistral-large-latest",
       "providers": {
         "mistral": {
           "npm": "@ai-sdk/mistral",
           "baseURL": "https://api.mistral.ai/v1",
           "apiKey": "...",
         },
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

- credential persistence, catalog refresh, or protocol auth policy; the Host
  owns these boundaries
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
      toolName: "read",
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
