import type { ModelAdapter, ModelPricing } from "@sparkwright/core";
import { OPENAI_MODEL_PRICING } from "@sparkwright/provider-ai-sdk";
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
  pricing: "configured" | "builtin" | "unavailable";
  costUnavailableReason?: "missing_pricing";
  pricingWarning?: string;
}

export interface ProviderPricingResolution {
  pricing?: ModelPricing;
  source: ProviderRuntimeSources["pricing"];
  costStatus: "estimated" | "unavailable";
  costUnavailableReason?: "missing_pricing";
  warning?: string;
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

  const [{ createOpenAiProvider }, { ProviderRegistry }] = await Promise.all([
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

  const pricingResolution = resolveConfiguredModelPricing(selection);
  const registry = new ProviderRegistry([
    createOpenAiProvider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai: client as any,
      id: selection.providerKey,
      models: [
        {
          id: selection.modelId,
          providerId: selection.providerKey,
          pricing: pricingResolution.pricing,
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
      pricing: pricingResolution.source,
      ...(pricingResolution.costUnavailableReason
        ? { costUnavailableReason: pricingResolution.costUnavailableReason }
        : {}),
      ...(pricingResolution.warning
        ? { pricingWarning: pricingResolution.warning }
        : {}),
      ...(baseURL
        ? {
            baseURL: baseUrlEnv ? `env:${npmInfo.baseUrlEnv}` : "config",
          }
        : {}),
    },
  };
}

/**
 * Pricing precedence: explicit config `cost` > built-in OpenAI table > none.
 * This is intentionally shared by adapter construction and capability
 * inspection so "cost unavailable" means the same thing before and after a run.
 */
export function resolveConfiguredModelPricing(
  selection: ConfiguredSelection,
): ProviderPricingResolution {
  const configuredPricing = costToPricing(selection.cost);
  if (configuredPricing) {
    return {
      pricing: configuredPricing,
      source: "configured",
      costStatus: "estimated",
    };
  }

  const builtinPricing = OPENAI_MODEL_PRICING[selection.modelId];
  if (builtinPricing) {
    return {
      pricing: builtinPricing,
      source: "builtin",
      costStatus: "estimated",
    };
  }

  return {
    source: "unavailable",
    costStatus: "unavailable",
    costUnavailableReason: "missing_pricing",
    warning: `No pricing configured for model "${selection.providerKey}/${selection.modelId}"; cost estimates will be unavailable. Add a provider model cost block to enable cost reporting.`,
  };
}

function nonEmptyEnv(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  return value && value.length > 0 ? value : undefined;
}
