import type { ModelAdapter } from "@sparkwright/core";
import {
  SUPPORTED_PROVIDER_NPMS,
  costToPricing,
  type ModelSelection,
} from "./config.js";

type ConfiguredSelection = Extract<ModelSelection, { kind: "configured" }>;

export interface BuildAdapterInput {
  /** @reserved Public provider-selection field consumed by host adapters. */
  selection: ConfiguredSelection;
  env: Record<string, string | undefined>;
  /** Optional fetch override (e.g. a proxy-aware fetch from the CLI). */
  fetch?: typeof fetch;
}

export interface ProviderRuntimeSources {
  apiKey: string;
  baseURL?: string;
}

/**
 * Construct a {@link ModelAdapter} for a resolved provider selection. The
 * provider's AI SDK package (`npm`) is loaded lazily so only the packages a
 * user actually configures need to be installed — a missing package surfaces
 * as a friendly "run npm install" message rather than a hard crash at import.
 *
 * All supported packages (`@ai-sdk/openai`, `@ai-sdk/anthropic`,
 * `@ai-sdk/google`) expose a `create*` factory returning a
 * `(modelId) => LanguageModel` callable, which is exactly what
 * `createOpenAiProvider` (provider-package-agnostic despite its name) expects.
 */
export async function buildConfiguredAdapter(
  input: BuildAdapterInput,
): Promise<
  | { ok: true; adapter: ModelAdapter; sources: ProviderRuntimeSources }
  | { ok: false; message: string }
> {
  const { selection, env } = input;
  const npmInfo = SUPPORTED_PROVIDER_NPMS[selection.npm];
  if (!npmInfo) {
    return {
      ok: false,
      message: `Provider "${selection.providerKey}" uses unsupported npm "${selection.npm}".`,
    };
  }

  const envApiKey = nonEmptyEnv(env, npmInfo.apiKeyEnv);
  const apiKey = envApiKey ?? selection.apiKey;
  if (!apiKey) {
    return {
      ok: false,
      message: `No API key for provider "${selection.providerKey}". Set ${npmInfo.apiKeyEnv}, or add an "apiKey" to that provider in your config.`,
    };
  }
  const baseUrlEnv = npmInfo.baseUrlEnv
    ? nonEmptyEnv(env, npmInfo.baseUrlEnv)
    : undefined;
  const baseURL = baseUrlEnv ?? selection.baseURL;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(selection.npm)) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      message: `Provider "${selection.providerKey}" needs "${selection.npm}". Install it: npm install ${selection.npm}`,
    };
  }
  const factory = mod[npmInfo.factory];
  if (typeof factory !== "function") {
    return {
      ok: false,
      message: `"${selection.npm}" does not export ${npmInfo.factory}().`,
    };
  }

  const [{ createOpenAiProvider, OPENAI_MODEL_PRICING }, { ProviderRegistry }] =
    await Promise.all([
      import("@sparkwright/provider-ai-sdk"),
      import("@sparkwright/provider-registry"),
    ]);

  const client = (
    factory as (opts: {
      apiKey: string;
      baseURL?: string;
      fetch?: typeof fetch;
    }) => (modelId: string) => unknown
  )({
    apiKey,
    baseURL,
    fetch: input.fetch,
  });

  // Pricing precedence: explicit config `cost` > built-in OpenAI table > none.
  const pricing =
    costToPricing(selection.cost) ?? OPENAI_MODEL_PRICING[selection.modelId];
  const registry = new ProviderRegistry([
    createOpenAiProvider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai: client as any,
      id: selection.providerKey,
      models: [
        {
          id: selection.modelId,
          providerId: selection.providerKey,
          pricing,
          metadata: selection.providerOptions
            ? { providerOptions: selection.providerOptions }
            : undefined,
        },
      ],
    }),
  ]);

  return {
    ok: true,
    adapter: await registry.getAdapter(
      `${selection.providerKey}:${selection.modelId}`,
    ),
    sources: {
      apiKey: envApiKey ? `env:${npmInfo.apiKeyEnv}` : "config",
      ...(baseURL
        ? {
            baseURL: baseUrlEnv ? `env:${npmInfo.baseUrlEnv}` : "config",
          }
        : {}),
    },
  };
}

function nonEmptyEnv(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  return value && value.length > 0 ? value : undefined;
}
