import {
  createFallbackModelAdapter,
  type FallbackModelAdapterOptions,
  type ModelAdapter,
  type ModelPricing,
  type NamedModelAdapter,
} from "@sparkwright/core";

export type { ModelPricing } from "@sparkwright/core";

export type ModelModality = "text" | "image" | "audio" | "video" | "tool";

export interface ModelCapabilities {
  /** @reserved Public model-capability field consumed by routing UIs. */
  completion?: boolean;
  /** @reserved Public model-capability field consumed by streaming runtimes. */
  streaming?: boolean;
  /** @reserved Public model-capability field consumed by tool-call runtimes. */
  toolCalling?: boolean;
  /** @reserved Public model-capability field consumed by structured-output runtimes. */
  structuredOutput?: boolean;
  /** @reserved Public model-capability field consumed by multimodal UIs. */
  vision?: boolean;
  /** @reserved Public model-capability field consumed by multimodal UIs. */
  audio?: boolean;
  /** @reserved Public model-capability field consumed by retrieval adapters. */
  embeddings?: boolean;
  [capability: string]: unknown;
}

export interface ModelInfo {
  id: string;
  providerId?: string;
  /** @reserved Public model metadata field consumed by provider/model pickers. */
  displayName?: string;
  description?: string;
  aliases?: string[];
  /** @reserved Public model metadata field consumed by provider/model pickers. */
  inputModalities?: ModelModality[];
  /** @reserved Public model metadata field consumed by provider/model pickers. */
  outputModalities?: ModelModality[];
  /** @reserved Public model metadata field consumed by context assemblers. */
  contextWindow?: number;
  /** @reserved Public model metadata field consumed by output-budget controls. */
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
  /**
   * Per-million-token pricing used by adapters to attach `costUsd` to
   * `ModelUsage`. Optional — adapters that do not implement pricing should
   * leave it unset.
   */
  pricing?: ModelPricing;
  metadata?: Record<string, unknown>;
}

export interface ProviderModelListContext<TConfig = unknown> {
  providerId: string;
  config: TConfig | undefined;
}

export interface ProviderAdapterFactoryInput<
  TConfig = unknown,
  TAdapterOptions = unknown,
> {
  providerId: string;
  provider: ProviderDefinition<TConfig, TAdapterOptions>;
  model: ModelInfo;
  config: TConfig | undefined;
  adapterOptions: TAdapterOptions | undefined;
}

export interface ProviderAdapterCacheKeyInput<TAdapterOptions = unknown> {
  providerId: string;
  model: ModelInfo;
  adapterOptions: TAdapterOptions | undefined;
}

export interface ProviderResolveModelInput<TConfig = unknown> {
  providerId: string;
  modelId: string | undefined;
  config: TConfig | undefined;
  models: ModelInfo[];
  allowAliases: boolean;
}

export interface ProviderDefinition<
  TConfig = unknown,
  TAdapterOptions = unknown,
> {
  id: string;
  /** @reserved Public provider metadata field consumed by provider pickers. */
  displayName?: string;
  description?: string;
  defaultModelId?: string;
  config?: TConfig;
  models:
    | ModelInfo[]
    | ((
        context: ProviderModelListContext<TConfig>,
      ) => ModelInfo[] | Promise<ModelInfo[]>);
  resolveModel?: (
    input: ProviderResolveModelInput<TConfig>,
  ) => ModelInfo | undefined | Promise<ModelInfo | undefined>;
  createAdapter: (
    input: ProviderAdapterFactoryInput<TConfig, TAdapterOptions>,
  ) => ModelAdapter | Promise<ModelAdapter>;
  getAdapterCacheKey?: (
    input: ProviderAdapterCacheKeyInput<TAdapterOptions>,
  ) => string | undefined;
}

export interface ModelReferenceObject {
  providerId?: string;
  provider?: string;
  modelId?: string;
  model?: string;
}

export type ModelReference = string | ModelReferenceObject;

export interface ResolvedModel<TConfig = unknown, TAdapterOptions = unknown> {
  providerId: string;
  provider: ProviderDefinition<TConfig, TAdapterOptions>;
  model: ModelInfo;
}

export interface ResolveModelOptions {
  providerId?: string;
  allowAliases?: boolean;
  requireCapabilities?: Partial<ModelCapabilities>;
}

export interface ListModelsOptions {
  providerId?: string;
  requireCapabilities?: Partial<ModelCapabilities>;
}

export interface AdapterResolutionOptions<TAdapterOptions = unknown> {
  adapterOptions?: TAdapterOptions;
  cache?: boolean;
  cacheKey?: string;
  resolve?: ResolveModelOptions;
}

export interface ProviderRegistryOptions {
  defaultProviderId?: string;
  defaultModel?: ModelReference;
  cacheAdapters?: boolean;
}

export interface ProviderFallbackChainOptions<
  TAdapterOptions = unknown,
> extends FallbackModelAdapterOptions {
  adapterOptions?: TAdapterOptions;
  cache?: boolean;
  resolve?: ResolveModelOptions;
}

interface ParsedModelReference {
  providerId?: string;
  modelId?: string;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDefinition>();
  private readonly adapterCache = new Map<string, ModelAdapter>();
  private readonly defaultProviderId: string | undefined;
  private readonly defaultModel: ModelReference | undefined;
  private readonly cacheAdapters: boolean;

  constructor(
    providers: ProviderDefinition[] = [],
    options: ProviderRegistryOptions = {},
  ) {
    this.defaultProviderId = options.defaultProviderId;
    this.defaultModel = options.defaultModel;
    this.cacheAdapters = options.cacheAdapters ?? true;

    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: ProviderDefinition): this {
    if (!provider.id) {
      throw new Error("Provider definition requires an id.");
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider '${provider.id}' is already registered.`);
    }

    this.providers.set(provider.id, provider);
    return this;
  }

  getProvider(providerId: string): ProviderDefinition | undefined {
    return this.providers.get(providerId);
  }

  listProviders(): ProviderDefinition[] {
    return [...this.providers.values()];
  }

  async listModels(options: ListModelsOptions = {}): Promise<ModelInfo[]> {
    const providers = options.providerId
      ? [this.requireProvider(options.providerId)]
      : this.listProviders();
    const models = (
      await Promise.all(
        providers.map(async (provider) => this.modelsForProvider(provider)),
      )
    ).flat();

    if (!options.requireCapabilities) return models;
    return models.filter((model) =>
      matchesCapabilities(model, options.requireCapabilities),
    );
  }

  async resolveModel(
    reference?: ModelReference,
    options: ResolveModelOptions = {},
  ): Promise<ResolvedModel> {
    const parsed = parseModelReference(reference ?? this.defaultModel);
    const providerId =
      parsed.providerId ?? options.providerId ?? this.defaultProviderId;
    const allowAliases = options.allowAliases ?? true;

    if (providerId) {
      const provider = this.requireProvider(providerId);
      const model = await this.resolveProviderModel(provider, parsed.modelId, {
        ...options,
        allowAliases,
      });
      return { providerId: provider.id, provider, model };
    }

    if (!parsed.modelId) {
      throw new Error(
        "Model reference requires a provider id, model id, or registry default model.",
      );
    }

    const candidates = await this.findModelCandidates(
      parsed.modelId,
      allowAliases,
      options.requireCapabilities,
    );

    if (candidates.length === 0) {
      throw new Error(`No registered model matches '${parsed.modelId}'.`);
    }
    if (candidates.length > 1) {
      throw new Error(
        `Model reference '${parsed.modelId}' is ambiguous across providers: ${candidates
          .map((candidate) => candidate.providerId)
          .join(", ")}.`,
      );
    }

    return candidates[0];
  }

  async getAdapter<TAdapterOptions = unknown>(
    reference?: ModelReference,
    options: AdapterResolutionOptions<TAdapterOptions> = {},
  ): Promise<ModelAdapter> {
    const resolved = await this.resolveModel(reference, options.resolve);
    const cacheKey = this.adapterCacheKey(resolved, options);
    const useCache = (options.cache ?? this.cacheAdapters) && !!cacheKey;

    if (useCache) {
      const cached = this.adapterCache.get(cacheKey);
      if (cached) return cached;
    }

    const adapter = await resolved.provider.createAdapter({
      providerId: resolved.providerId,
      provider: resolved.provider,
      model: resolved.model,
      config: resolved.provider.config,
      adapterOptions: options.adapterOptions,
    });

    if (useCache) {
      this.adapterCache.set(cacheKey, adapter);
    }

    return adapter;
  }

  clearAdapterCache(cacheKey?: string): void {
    if (cacheKey) {
      this.adapterCache.delete(cacheKey);
      return;
    }

    this.adapterCache.clear();
  }

  get adapterCacheSize(): number {
    return this.adapterCache.size;
  }

  private async resolveProviderModel(
    provider: ProviderDefinition,
    modelId: string | undefined,
    options: ResolveModelOptions & { allowAliases: boolean },
  ): Promise<ModelInfo> {
    const models = await this.modelsForProvider(provider);
    const requestedModelId = modelId ?? provider.defaultModelId;

    const providerResolved = await provider.resolveModel?.({
      providerId: provider.id,
      modelId: requestedModelId,
      config: provider.config,
      models,
      allowAliases: options.allowAliases,
    });
    const model =
      providerResolved ??
      (requestedModelId
        ? models.find((candidate) =>
            modelMatches(candidate, requestedModelId, options.allowAliases),
          )
        : models.length === 1
          ? models[0]
          : undefined);

    if (!model) {
      const suffix = requestedModelId ? ` '${requestedModelId}'` : "";
      throw new Error(
        `Provider '${provider.id}' does not define model${suffix}.`,
      );
    }
    if (!matchesCapabilities(model, options.requireCapabilities)) {
      throw new Error(
        `Model '${provider.id}:${model.id}' does not satisfy required capabilities.`,
      );
    }

    return model;
  }

  private async findModelCandidates(
    modelId: string,
    allowAliases: boolean,
    requireCapabilities: Partial<ModelCapabilities> | undefined,
  ): Promise<ResolvedModel[]> {
    const candidates: ResolvedModel[] = [];

    for (const provider of this.providers.values()) {
      const models = await this.modelsForProvider(provider);
      const model = models.find(
        (candidate) =>
          modelMatches(candidate, modelId, allowAliases) &&
          matchesCapabilities(candidate, requireCapabilities),
      );

      if (model) {
        candidates.push({ providerId: provider.id, provider, model });
      }
    }

    return candidates;
  }

  private async modelsForProvider(
    provider: ProviderDefinition,
  ): Promise<ModelInfo[]> {
    const models =
      typeof provider.models === "function"
        ? await provider.models({
            providerId: provider.id,
            config: provider.config,
          })
        : provider.models;

    return models.map((model) => ({
      ...model,
      providerId: model.providerId ?? provider.id,
    }));
  }

  private requireProvider(providerId: string): ProviderDefinition {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider '${providerId}' is not registered.`);
    }

    return provider;
  }

  private adapterCacheKey<TAdapterOptions>(
    resolved: ResolvedModel,
    options: AdapterResolutionOptions<TAdapterOptions>,
  ): string | undefined {
    if (options.cacheKey) return options.cacheKey;

    const providerKey = resolved.provider.getAdapterCacheKey?.({
      providerId: resolved.providerId,
      model: resolved.model,
      adapterOptions: options.adapterOptions,
    });
    if (providerKey) return providerKey;

    if (options.adapterOptions !== undefined) return undefined;

    return `${resolved.providerId}:${resolved.model.id}`;
  }
}

export function resolveModel(
  registry: ProviderRegistry,
  reference?: ModelReference,
  options?: ResolveModelOptions,
): Promise<ResolvedModel> {
  return registry.resolveModel(reference, options);
}

export async function createProviderFallbackChain<TAdapterOptions = unknown>(
  registry: ProviderRegistry,
  references: ModelReference[],
  options: ProviderFallbackChainOptions<TAdapterOptions> = {},
): Promise<ModelAdapter> {
  const adapters: NamedModelAdapter[] = [];

  for (const reference of references) {
    const resolved = await registry.resolveModel(reference, options.resolve);
    const adapter = await registry.getAdapter(reference, {
      adapterOptions: options.adapterOptions,
      cache: options.cache,
      resolve: options.resolve,
    });

    adapters.push({
      id: `${resolved.providerId}:${resolved.model.id}`,
      adapter,
    });
  }

  return createFallbackModelAdapter(adapters, {
    onFailure: options.onFailure,
  });
}

export const createFallbackChain = createProviderFallbackChain;

function parseModelReference(
  reference: ModelReference | undefined,
): ParsedModelReference {
  if (!reference) return {};

  if (typeof reference === "string") {
    const separator = reference.indexOf(":");
    if (separator === -1) return { modelId: reference };

    return {
      providerId: reference.slice(0, separator),
      modelId: reference.slice(separator + 1),
    };
  }

  return {
    providerId: reference.providerId ?? reference.provider,
    modelId: reference.modelId ?? reference.model,
  };
}

function modelMatches(
  model: ModelInfo,
  modelId: string,
  allowAliases: boolean,
): boolean {
  if (model.id === modelId) return true;
  return allowAliases ? (model.aliases ?? []).includes(modelId) : false;
}

function matchesCapabilities(
  model: ModelInfo,
  required: Partial<ModelCapabilities> | undefined,
): boolean {
  if (!required) return true;

  for (const [capability, expected] of Object.entries(required)) {
    if (expected === undefined) continue;
    if (model.capabilities?.[capability] !== expected) return false;
  }

  return true;
}
