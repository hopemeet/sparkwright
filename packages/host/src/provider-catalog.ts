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

export const BUNDLED_PROVIDER_CATALOG_VERSION = 3;

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
  /** Optional code-owned authenticated metadata discovery. */
  modelDiscovery?: {
    kind: "openai_compatible";
    path: string;
    ttlMs: number;
  };
}

export interface BundledProviderCatalogEntry {
  id: string;
  displayName: string;
  models: readonly ModelInfo[];
}

export interface BundledProviderCatalogSnapshot {
  version: number;
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
      modelDiscovery: {
        kind: "openai_compatible",
        path: "models",
        ttlMs: 24 * 60 * 60 * 1_000,
      },
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
  catalog?: BundledProviderCatalogSnapshot;
  requestedModels?: Readonly<Record<string, readonly string[]>>;
  adapterFactories?: Readonly<
    Record<string, ProviderDefinition["createAdapter"]>
  >;
}): ProviderRegistry {
  const catalog = input.catalog ?? BUNDLED_PROVIDER_CATALOG;
  const catalogProviders = new Map(
    catalog.providers.map((provider) => [provider.id, provider]),
  );
  const providerIds = new Set<string>(input.providerIds ?? []);
  if (input.includeBundledProviders !== false) {
    for (const provider of catalog.providers) providerIds.add(provider.id);
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
          ? { displayName: catalogProviders.get(providerId)?.displayName }
          : {}),
        models: effectiveProviderModels({
          providerId,
          config,
          catalogProviders,
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
  catalogProviders: ReadonlyMap<string, BundledProviderCatalogEntry>;
  requestedModelIds: readonly string[] | undefined;
}): ModelInfo[] {
  const usesBundledCatalog = usesBundledProviderBinding(
    input.providerId,
    input.config,
  );
  const catalogModels = new Map(
    (usesBundledCatalog
      ? (input.catalogProviders.get(input.providerId)?.models ?? [])
      : []
    ).map((model) => [model.id, model]),
  );
  const configuredModels = input.config?.models ?? {};
  const legacyAllowlist = Object.keys(configuredModels);
  const policyAllowlist = input.config?.modelPolicy?.allow;
  const deniedModels = new Set(input.config?.modelPolicy?.deny ?? []);
  const modelIds = new Set<string>(
    legacyAllowlist.length > 0
      ? legacyAllowlist
      : policyAllowlist !== undefined
        ? policyAllowlist
        : catalogModels.keys(),
  );

  if (legacyAllowlist.length === 0 && policyAllowlist === undefined) {
    for (const modelId of input.requestedModelIds ?? []) {
      if (modelId.length > 0) modelIds.add(modelId);
    }
  }
  for (const modelId of deniedModels) modelIds.delete(modelId);

  return [...modelIds].sort().map((modelId) => {
    const catalogModel = catalogModels.get(modelId);
    const configuredModel =
      configuredModels[modelId] ?? input.config?.modelOverrides?.[modelId];
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

/**
 * Merge metadata-only catalog inventory. Connection descriptors, packages,
 * endpoints, authentication, and adapter factories remain code-owned.
 */
export function mergeProviderCatalogSnapshots(input: {
  base: BundledProviderCatalogSnapshot;
  providers: readonly BundledProviderCatalogEntry[];
  version?: number;
}): BundledProviderCatalogSnapshot {
  const providers = new Map(
    input.base.providers.map((provider) => [
      provider.id,
      cloneCatalogProvider(provider),
    ]),
  );
  for (const provider of input.providers) {
    if (!getProviderConnectionDescriptor(provider.id)) continue;
    providers.set(provider.id, cloneCatalogProvider(provider));
  }
  return {
    version: input.version ?? input.base.version + 1,
    providers: [...providers.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

/** Validate and bound data before it can become active catalog metadata. */
export function sanitizeProviderCatalogSnapshot(
  value: unknown,
): BundledProviderCatalogSnapshot {
  if (!isRecord(value)) throw new Error("Catalog snapshot must be an object.");
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    throw new Error("Catalog version must be a positive integer.");
  }
  if (!Array.isArray(value.providers) || value.providers.length > 100) {
    throw new Error("Catalog providers must be a bounded array.");
  }
  const seenProviders = new Set<string>();
  const providers = value.providers.map((candidate) => {
    if (!isRecord(candidate))
      throw new Error("Catalog provider must be an object.");
    requireOnlyKeys(candidate, ["id", "displayName", "models"]);
    const id = boundedIdentifier(candidate.id, "Catalog provider id", 128);
    if (!getProviderConnectionDescriptor(id)) {
      throw new Error(`Catalog provider "${id}" has no code-owned descriptor.`);
    }
    if (seenProviders.has(id))
      throw new Error(`Duplicate catalog provider "${id}".`);
    seenProviders.add(id);
    const displayName = boundedText(
      candidate.displayName,
      "Catalog provider displayName",
      256,
    );
    if (!displayName) {
      throw new Error(`Catalog provider "${id}" is missing displayName.`);
    }
    if (!Array.isArray(candidate.models) || candidate.models.length > 20_000) {
      throw new Error(`Catalog provider "${id}" has an invalid model array.`);
    }
    const seenModels = new Set<string>();
    const models = candidate.models.map((model) => {
      const sanitized = sanitizeCatalogModel(model, id);
      if (seenModels.has(sanitized.id)) {
        throw new Error(`Duplicate catalog model "${id}/${sanitized.id}".`);
      }
      seenModels.add(sanitized.id);
      return sanitized;
    });
    return {
      id,
      displayName,
      models: models.sort((left, right) => left.id.localeCompare(right.id)),
    };
  });
  return {
    version: value.version as number,
    providers: providers.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function sanitizeCatalogModel(value: unknown, providerId: string): ModelInfo {
  if (!isRecord(value)) throw new Error("Catalog model must be an object.");
  requireOnlyKeys(value, [
    "id",
    "providerId",
    "displayName",
    "description",
    "aliases",
    "inputModalities",
    "outputModalities",
    "contextWindow",
    "maxOutputTokens",
    "capabilities",
    "pricing",
  ]);
  const id = boundedIdentifier(value.id, "Catalog model id", 256);
  if (value.providerId !== undefined && value.providerId !== providerId) {
    throw new Error(`Catalog model "${id}" has a mismatched providerId.`);
  }
  const displayName = boundedText(
    value.displayName,
    "Catalog model displayName",
    512,
  );
  const description = boundedText(
    value.description,
    "Catalog model description",
    2_048,
  );
  const aliases = optionalStringArray(
    value.aliases,
    "Catalog model aliases",
    32,
    256,
  );
  const inputModalities = optionalModalities(
    value.inputModalities,
    "inputModalities",
  );
  const outputModalities = optionalModalities(
    value.outputModalities,
    "outputModalities",
  );
  const contextWindow = optionalPositiveInteger(
    value.contextWindow,
    "contextWindow",
  );
  const maxOutputTokens = optionalPositiveInteger(
    value.maxOutputTokens,
    "maxOutputTokens",
  );
  const capabilities = sanitizeCapabilities(value.capabilities);
  const pricing = sanitizePricing(value.pricing);
  return {
    id,
    providerId,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(aliases ? { aliases } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(pricing ? { pricing } : {}),
  };
}

function cloneCatalogProvider(
  provider: BundledProviderCatalogEntry,
): BundledProviderCatalogEntry {
  return {
    id: provider.id,
    displayName: provider.displayName,
    models: provider.models.map((model) => ({
      ...model,
      ...(model.aliases ? { aliases: [...model.aliases] } : {}),
      ...(model.inputModalities
        ? { inputModalities: [...model.inputModalities] }
        : {}),
      ...(model.outputModalities
        ? { outputModalities: [...model.outputModalities] }
        : {}),
      ...(model.capabilities
        ? { capabilities: { ...model.capabilities } }
        : {}),
      ...(model.pricing ? { pricing: { ...model.pricing } } : {}),
    })),
  };
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown)
    throw new Error(
      `Catalog metadata contains unsupported field "${unknown}".`,
    );
}

function boundedIdentifier(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    hasDisallowedMetadataControlCharacter(value, false) ||
    /\s/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedText(
  value: unknown,
  label: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    hasDisallowedMetadataControlCharacter(value, true)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function hasDisallowedMetadataControlCharacter(
  value: string,
  allowLineWhitespace: boolean,
): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 0x7f) return true;
    if (code >= 0x20) continue;
    if (
      allowLineWhitespace &&
      (code === 0x09 || code === 0x0a || code === 0x0d)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function optionalStringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxLength: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems)
    throw new Error(`${label} is invalid.`);
  return value.map((item) => boundedIdentifier(item, label, maxLength));
}

const MODEL_MODALITIES = new Set(["text", "image", "audio", "video", "tool"]);

function optionalModalities(
  value: unknown,
  label: string,
): ModelInfo["inputModalities"] {
  const values = optionalStringArray(value, `Catalog model ${label}`, 8, 16);
  if (!values) return undefined;
  if (values.some((entry) => !MODEL_MODALITIES.has(entry))) {
    throw new Error(`Catalog model ${label} is invalid.`);
  }
  return values as ModelInfo["inputModalities"];
}

function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Catalog model ${label} is invalid.`);
  }
  return value as number;
}

function sanitizeCapabilities(value: unknown): ModelInfo["capabilities"] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > 32) {
    throw new Error("Catalog model capabilities are invalid.");
  }
  const capabilities: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value)) {
    const id = boundedIdentifier(key, "Catalog capability id", 64);
    if (typeof enabled !== "boolean") {
      throw new Error(`Catalog capability "${id}" must be boolean.`);
    }
    capabilities[id] = enabled;
  }
  return capabilities;
}

function sanitizePricing(value: unknown): ModelInfo["pricing"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Catalog model pricing is invalid.");
  requireOnlyKeys(value, [
    "inputPerMTokUsd",
    "outputPerMTokUsd",
    "cacheReadPerMTokUsd",
    "cacheCreationPerMTokUsd",
  ]);
  const pricing: NonNullable<ModelInfo["pricing"]> = {};
  for (const key of [
    "inputPerMTokUsd",
    "outputPerMTokUsd",
    "cacheReadPerMTokUsd",
    "cacheCreationPerMTokUsd",
  ] as const) {
    const amount = value[key];
    if (amount === undefined) continue;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`Catalog pricing field "${key}" is invalid.`);
    }
    pricing[key] = amount;
  }
  return pricing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
