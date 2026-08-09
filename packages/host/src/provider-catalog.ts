import type { ModelAdapter } from "@sparkwright/core";
import { OPENAI_MODEL_PRICING } from "@sparkwright/provider-ai-sdk";
import {
  ProviderRegistry,
  type ModelInfo,
  type ProviderDefinition,
} from "@sparkwright/provider-registry";
import type { ProviderConfig } from "./config-zod-schema.js";
import {
  DEFAULT_PROVIDER_NPM,
  SUPPORTED_PROVIDER_NPMS,
} from "./config/contracts.js";
import { costToPricing } from "./config/config-implementation.js";

export const BUNDLED_PROVIDER_CATALOG_VERSION = 2;

export type ProviderAuthPrompt =
  | {
      id: string;
      kind: "text" | "secret";
      label: string;
      required?: boolean;
    }
  | {
      id: string;
      kind: "select";
      label: string;
      required?: boolean;
      options: ReadonlyArray<{ value: string; label: string }>;
    };

export type ProviderConnectionAuthMethod =
  | {
      id: "api_key";
      kind: "api_key";
      label?: string;
      environmentVariables: readonly string[];
    }
  | {
      id: string;
      kind: "oauth";
      label: string;
      flow: "browser" | "device" | "code";
      implementationId: string;
      prompts?: readonly ProviderAuthPrompt[];
    };

export interface ProviderConnectionDescriptor {
  providerId: string;
  displayName: string;
  /** @reserved Code-owned immutable driver identity consumed by P6.2 connection bindings. */
  driverId: string;
  npm: string;
  officialEndpoint: string;
  baseUrlEnvironmentVariables?: readonly string[];
  /** Code-owned bounded login declarations. Remote catalog/config cannot add implementations. */
  authMethods: readonly ProviderConnectionAuthMethod[];
  /** @reserved Side-effect-free validation policy consumed by P6.2 connection status. */
  validation: { kind: "none" };
}

export interface BundledProviderCatalogEntry {
  id: string;
  displayName: string;
  models: readonly ModelInfo[];
}

export interface BundledProviderCatalogSnapshot {
  version: typeof BUNDLED_PROVIDER_CATALOG_VERSION;
  providers: readonly BundledProviderCatalogEntry[];
}

const OPENAI_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  ...Object.keys(OPENAI_MODEL_PRICING),
];

export const BUNDLED_PROVIDER_CONNECTION_DESCRIPTORS: readonly ProviderConnectionDescriptor[] =
  [
    {
      providerId: "openrouter",
      displayName: "OpenRouter",
      driverId: "ai-sdk-openrouter.v1",
      npm: "@ai-sdk/openai",
      officialEndpoint: "https://openrouter.ai/api/v1",
      baseUrlEnvironmentVariables: ["OPENROUTER_BASE_URL"],
      authMethods: [
        {
          id: "oauth_pkce",
          kind: "oauth",
          label: "Browser login",
          flow: "browser",
          implementationId: "openrouter.pkce-key.v1",
        },
        {
          id: "api_key",
          kind: "api_key",
          label: "API key",
          environmentVariables: ["OPENROUTER_API_KEY"],
        },
      ],
      validation: { kind: "none" },
    },
    {
      providerId: "openai",
      displayName: "OpenAI",
      driverId: "ai-sdk-openai.v1",
      npm: "@ai-sdk/openai",
      officialEndpoint: "https://api.openai.com/v1",
      baseUrlEnvironmentVariables: ["OPENAI_BASE_URL"],
      authMethods: [
        {
          id: "api_key",
          kind: "api_key",
          environmentVariables: [
            SUPPORTED_PROVIDER_NPMS["@ai-sdk/openai"]!.apiKeyEnv,
          ],
        },
      ],
      validation: { kind: "none" },
    },
    {
      providerId: "anthropic",
      displayName: "Anthropic",
      driverId: "ai-sdk-anthropic.v1",
      npm: "@ai-sdk/anthropic",
      officialEndpoint: "https://api.anthropic.com/v1",
      authMethods: [
        {
          id: "api_key",
          kind: "api_key",
          environmentVariables: [
            SUPPORTED_PROVIDER_NPMS["@ai-sdk/anthropic"]!.apiKeyEnv,
          ],
        },
      ],
      validation: { kind: "none" },
    },
    {
      providerId: "google",
      displayName: "Google",
      driverId: "ai-sdk-google.v1",
      npm: "@ai-sdk/google",
      officialEndpoint: "https://generativelanguage.googleapis.com/v1beta",
      authMethods: [
        {
          id: "api_key",
          kind: "api_key",
          environmentVariables: [
            SUPPORTED_PROVIDER_NPMS["@ai-sdk/google"]!.apiKeyEnv,
          ],
        },
      ],
      validation: { kind: "none" },
    },
  ];

export const BUNDLED_PROVIDER_CATALOG: BundledProviderCatalogSnapshot = {
  version: BUNDLED_PROVIDER_CATALOG_VERSION,
  providers: [
    {
      id: "openrouter",
      displayName: "OpenRouter",
      models: ["openrouter/auto"].map((id) => ({
        id,
        displayName: id,
      })),
    },
    {
      id: "openai",
      displayName: "OpenAI",
      models: [...new Set(OPENAI_MODELS)].sort().map((id) => ({
        id,
        displayName: id,
        pricing: OPENAI_MODEL_PRICING[id],
      })),
    },
    {
      id: "anthropic",
      displayName: "Anthropic",
      models: ["claude-haiku-4-5", "claude-sonnet-4-6"].map((id) => ({
        id,
        displayName: id,
      })),
    },
    {
      id: "google",
      displayName: "Google",
      models: ["gemini-3-flash", "gemini-3.1-pro"].map((id) => ({
        id,
        displayName: id,
      })),
    },
  ],
};

const CONNECTION_DESCRIPTORS = new Map(
  BUNDLED_PROVIDER_CONNECTION_DESCRIPTORS.map((descriptor) => [
    descriptor.providerId,
    descriptor,
  ]),
);

const CATALOG_PROVIDERS = new Map(
  BUNDLED_PROVIDER_CATALOG.providers.map((provider) => [provider.id, provider]),
);

export function getProviderConnectionDescriptor(
  providerId: string,
): ProviderConnectionDescriptor | undefined {
  return CONNECTION_DESCRIPTORS.get(providerId);
}

export function bundledProviderIds(): string[] {
  return BUNDLED_PROVIDER_CATALOG.providers.map((provider) => provider.id);
}

export function providerDisplayName(providerId: string): string | undefined {
  return CATALOG_PROVIDERS.get(providerId)?.displayName;
}

export function providerNpm(
  providerId: string,
  config: ProviderConfig | undefined,
): string {
  return (
    config?.npm ??
    getProviderConnectionDescriptor(providerId)?.npm ??
    DEFAULT_PROVIDER_NPM
  );
}

export function createHostProviderRegistry(input: {
  configuredProviders?: Record<string, ProviderConfig>;
  providerIds?: readonly string[];
  includeBundledProviders?: boolean;
  requestedModels?: Readonly<Record<string, readonly string[]>>;
  adapterFactories?: Readonly<
    Record<string, ProviderDefinition["createAdapter"]>
  >;
}): ProviderRegistry {
  const providerIds = new Set<string>(input.providerIds ?? []);
  if (input.includeBundledProviders !== false) {
    for (const providerId of bundledProviderIds()) providerIds.add(providerId);
  }
  for (const providerId of Object.keys(input.configuredProviders ?? {})) {
    providerIds.add(providerId);
  }

  const definitions = [...providerIds]
    .sort()
    .map<ProviderDefinition>((providerId) => {
      const config = input.configuredProviders?.[providerId];
      return {
        id: providerId,
        ...(usesBundledProviderBinding(providerId, config)
          ? { displayName: providerDisplayName(providerId) }
          : {}),
        models: effectiveProviderModels({
          providerId,
          config,
          requestedModelIds: input.requestedModels?.[providerId],
        }),
        createAdapter:
          input.adapterFactories?.[providerId] ?? unavailableAdapterFactory,
      };
    });

  return new ProviderRegistry(definitions);
}

export function toRegistryModelRef(
  providerId: string,
  modelId: string,
): string {
  return `${providerId}:${modelId}`;
}

function effectiveProviderModels(input: {
  providerId: string;
  config: ProviderConfig | undefined;
  requestedModelIds: readonly string[] | undefined;
}): ModelInfo[] {
  const usesBundledCatalog = usesBundledProviderBinding(
    input.providerId,
    input.config,
  );
  const catalogModels = new Map(
    (usesBundledCatalog
      ? (CATALOG_PROVIDERS.get(input.providerId)?.models ?? [])
      : []
    ).map((model) => [model.id, model]),
  );
  const configuredModels = input.config?.models ?? {};
  const legacyAllowlist = Object.keys(configuredModels);
  const modelIds = new Set<string>(
    legacyAllowlist.length > 0 ? legacyAllowlist : catalogModels.keys(),
  );

  if (legacyAllowlist.length === 0) {
    for (const modelId of input.requestedModelIds ?? []) {
      if (modelId.length > 0) modelIds.add(modelId);
    }
  }

  return [...modelIds].sort().map((modelId) => {
    const catalogModel = catalogModels.get(modelId);
    const configuredModel = configuredModels[modelId];
    const pricing =
      costToPricing(configuredModel?.cost) ?? catalogModel?.pricing;
    const providerOptions = configuredModel?.providerOptions;
    return {
      ...(catalogModel ?? { id: modelId }),
      id: modelId,
      providerId: input.providerId,
      ...(pricing ? { pricing } : {}),
      ...(providerOptions
        ? {
            metadata: {
              ...(catalogModel?.metadata ?? {}),
              providerOptions,
            },
          }
        : {}),
    };
  });
}

function usesBundledProviderBinding(
  providerId: string,
  config: ProviderConfig | undefined,
): boolean {
  const descriptor = getProviderConnectionDescriptor(providerId);
  return (
    descriptor !== undefined &&
    (config?.npm === undefined || config.npm === descriptor.npm) &&
    (config?.baseURL === undefined ||
      normalizeEndpoint(config.baseURL) ===
        normalizeEndpoint(descriptor.officialEndpoint))
  );
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function unavailableAdapterFactory(): ModelAdapter {
  throw new Error(
    "Provider catalog entries cannot construct adapters without a Host driver.",
  );
}
