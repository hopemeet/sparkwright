import { createHash } from "node:crypto";
import { format } from "prettier";

export interface GeneratedCatalogModel {
  id: string;
  displayName?: string;
}

export interface GeneratedCatalogProvider {
  id: string;
  displayName: string;
  models: readonly GeneratedCatalogModel[];
}

export interface GeneratedProviderCatalog {
  version: number;
  providers: readonly GeneratedCatalogProvider[];
}

export interface CatalogDiffSummary {
  providerId: string;
  before: number;
  after: number;
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
}

export interface CatalogSourceEvidence {
  id: string;
  text: string;
}

const SOURCE_PROVIDER_IDS = [
  "anthropic",
  "google",
  "openai",
  "openrouter",
] as const;

const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  chatgpt: "ChatGPT",
  google: "Google",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_MODELS_PER_PROVIDER = 20_000;

export function parseModelsDevCatalog(input: {
  source: unknown;
  fallback: GeneratedProviderCatalog;
  nextVersion?: number;
  additions?: Readonly<Record<string, readonly GeneratedCatalogModel[]>>;
}): GeneratedProviderCatalog {
  if (!isRecord(input.source)) {
    throw new Error("External provider catalog must be an object.");
  }

  const fallbackProviders = new Map(
    input.fallback.providers.map((provider) => [
      provider.id,
      cloneProvider(provider),
    ]),
  );

  for (const providerId of SOURCE_PROVIDER_IDS) {
    const candidate = input.source[providerId];
    if (candidate === undefined) continue;
    if (!isRecord(candidate) || !isRecord(candidate.models)) {
      throw new Error(`External provider "${providerId}" has no model map.`);
    }
    const entries = Object.entries(candidate.models);
    if (entries.length === 0 || entries.length > MAX_MODELS_PER_PROVIDER) {
      throw new Error(
        `External provider "${providerId}" has an invalid model count.`,
      );
    }
    const models = entries.map(([sourceId, value]) =>
      normalizeModel(providerId, sourceId, value),
    );
    fallbackProviders.set(providerId, {
      id: providerId,
      displayName: PROVIDER_DISPLAY_NAMES[providerId]!,
      models: models.sort((left, right) => left.id.localeCompare(right.id)),
    });
  }

  for (const provider of input.fallback.providers) {
    if (!PROVIDER_DISPLAY_NAMES[provider.id]) {
      throw new Error(`Fallback provider "${provider.id}" is not code-owned.`);
    }
  }

  const version = input.nextVersion ?? input.fallback.version + 1;
  if (!Number.isSafeInteger(version) || version <= input.fallback.version) {
    throw new Error("Generated provider catalog version must increase.");
  }
  return applyCatalogModelAdditions(
    {
      version,
      providers: [...fallbackProviders.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    },
    input.additions,
  );
}

export function applyOpenRouterCatalog(input: {
  source: unknown;
  catalog: GeneratedProviderCatalog;
}): GeneratedProviderCatalog {
  if (!isRecord(input.source) || !Array.isArray(input.source.data)) {
    throw new Error("OpenRouter provider catalog must contain a model list.");
  }
  if (
    input.source.data.length === 0 ||
    input.source.data.length > MAX_MODELS_PER_PROVIDER
  ) {
    throw new Error("OpenRouter provider catalog has an invalid model count.");
  }
  const models = new Map<string, GeneratedCatalogModel>();
  for (const value of input.source.data) {
    if (!isRecord(value)) {
      throw new Error("OpenRouter provider catalog contains an invalid model.");
    }
    const id = boundedIdentifier(value.id, "OpenRouter external model id", 256);
    if (models.has(id)) {
      throw new Error(`OpenRouter external model "${id}" is duplicated.`);
    }
    const displayName = optionalText(value.name, 512);
    models.set(id, { id, ...(displayName ? { displayName } : {}) });
  }
  const providers = input.catalog.providers.map((provider) =>
    provider.id === "openrouter"
      ? {
          id: provider.id,
          displayName: PROVIDER_DISPLAY_NAMES.openrouter!,
          models: [...models.values()].sort((left, right) =>
            left.id.localeCompare(right.id),
          ),
        }
      : cloneProvider(provider),
  );
  if (!providers.some((provider) => provider.id === "openrouter")) {
    throw new Error('Fallback provider "openrouter" is not code-owned.');
  }
  return { version: input.catalog.version, providers };
}

export function applyCatalogModelAdditions(
  catalog: GeneratedProviderCatalog,
  additionsByProvider:
    | Readonly<Record<string, readonly GeneratedCatalogModel[]>>
    | undefined,
): GeneratedProviderCatalog {
  const providers = new Map(
    catalog.providers.map((provider) => [provider.id, cloneProvider(provider)]),
  );
  for (const [providerId, additions] of Object.entries(
    additionsByProvider ?? {},
  )) {
    if (!PROVIDER_DISPLAY_NAMES[providerId]) {
      throw new Error(
        `Catalog correction provider "${providerId}" is not code-owned.`,
      );
    }
    const provider = providers.get(providerId);
    if (!provider) {
      throw new Error(
        `Catalog correction provider "${providerId}" has no fallback.`,
      );
    }
    const models = new Map(provider.models.map((model) => [model.id, model]));
    for (const addition of additions) {
      const model = normalizeGeneratedModel(providerId, addition);
      models.set(model.id, model);
    }
    providers.set(providerId, {
      ...provider,
      models: [...models.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    });
  }

  return {
    version: catalog.version,
    providers: [...providers.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

export async function renderGeneratedCatalog(input: {
  catalog: GeneratedProviderCatalog;
  sourceText?: string;
  sources?: readonly CatalogSourceEvidence[];
}): Promise<string> {
  const sources =
    input.sources ??
    (input.sourceText === undefined
      ? []
      : [{ id: "source", text: input.sourceText }]);
  if (sources.length === 0) {
    throw new Error("Generated provider catalog requires source evidence.");
  }
  const evidence = sources.map((source) => {
    const id = boundedIdentifier(source.id, "Catalog source evidence id", 128);
    return sources.length === 1 && id === "source"
      ? `// Source digest: ${sourceDigest(source.text)}`
      : `// Source digest (${id}): ${sourceDigest(source.text)}`;
  });
  return await format(
    [
      "// Generated by scripts/provider-catalog/update.ts. Do not edit by hand.",
      ...evidence,
      "",
      `export const GENERATED_PROVIDER_MODEL_CATALOG = ${JSON.stringify(input.catalog, null, 2)} as const;`,
      "",
    ].join("\n"),
    { parser: "typescript" },
  );
}

export function summarizeCatalogDiff(
  before: GeneratedProviderCatalog,
  after: GeneratedProviderCatalog,
): CatalogDiffSummary[] {
  const beforeProviders = new Map(
    before.providers.map((provider) => [provider.id, provider]),
  );
  return after.providers.map((provider) => {
    const previous = beforeProviders.get(provider.id);
    const beforeModels = new Map(
      previous?.models.map((model) => [model.id, model]) ?? [],
    );
    const afterModels = new Map(
      provider.models.map((model) => [model.id, model]),
    );
    const beforeIds = new Set(beforeModels.keys());
    const afterIds = new Set(afterModels.keys());
    return {
      providerId: provider.id,
      before: beforeIds.size,
      after: afterIds.size,
      added: [...afterIds].filter((id) => !beforeIds.has(id)).sort(),
      removed: [...beforeIds].filter((id) => !afterIds.has(id)).sort(),
      changed: [...afterIds]
        .filter(
          (id) =>
            beforeModels.has(id) &&
            beforeModels.get(id)?.displayName !==
              afterModels.get(id)?.displayName,
        )
        .sort(),
    };
  });
}

export function assertBoundedSourceText(text: string): void {
  if (Buffer.byteLength(text, "utf8") === 0) {
    throw new Error("External provider catalog response is empty.");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error("External provider catalog response is too large.");
  }
}

function normalizeModel(
  providerId: string,
  sourceId: string,
  value: unknown,
): GeneratedCatalogModel {
  if (!isRecord(value)) {
    throw new Error(`External model "${providerId}/${sourceId}" is invalid.`);
  }
  const id = boundedIdentifier(
    typeof value.id === "string" ? value.id : sourceId,
    `External model "${providerId}/${sourceId}" id`,
    256,
  );
  if (id !== sourceId) {
    throw new Error(
      `External model "${providerId}/${sourceId}" id does not match its key.`,
    );
  }
  const displayName = optionalText(value.name, 512);
  return {
    id,
    ...(displayName ? { displayName } : {}),
  };
}

function normalizeGeneratedModel(
  providerId: string,
  model: GeneratedCatalogModel,
): GeneratedCatalogModel {
  const id = boundedIdentifier(
    model.id,
    `Catalog correction model "${providerId}/${model.id}" id`,
    256,
  );
  const displayName = optionalText(model.displayName, 512);
  return { id, ...(displayName ? { displayName } : {}) };
}

function cloneProvider(
  provider: GeneratedCatalogProvider,
): GeneratedCatalogProvider {
  return {
    id: provider.id,
    displayName: provider.displayName,
    models: provider.models.map((model) => ({ ...model })),
  };
}

function sourceDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function boundedIdentifier(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /\s/u.test(value) ||
    hasDisallowedControlCharacter(value, false)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    hasDisallowedControlCharacter(value, true)
  ) {
    throw new Error("External model display name is invalid.");
  }
  return value;
}

function hasDisallowedControlCharacter(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
