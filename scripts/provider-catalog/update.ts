import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GENERATED_PROVIDER_MODEL_CATALOG } from "../../packages/host/src/generated/provider-model-catalog.js";
import {
  applyCatalogModelAdditions,
  applyOpenRouterCatalog,
  assertBoundedSourceText,
  parseModelsDevCatalog,
  renderGeneratedCatalog,
  summarizeCatalogDiff,
  type CatalogSourceEvidence,
  type GeneratedProviderCatalog,
} from "./lib.js";
import { CATALOG_MODEL_ADDITIONS } from "./overrides.js";

const DEFAULT_MODELS_DEV_SOURCE_URL = "https://models.dev/api.json";
const DEFAULT_OUTPUT = resolve(
  "packages/host/src/generated/provider-model-catalog.ts",
);
const args = parseArgs(process.argv.slice(2));
const current = GENERATED_PROVIDER_MODEL_CATALOG;
const nextVersion = args.version ?? current.version + 1;
if (!Number.isSafeInteger(nextVersion) || nextVersion <= current.version) {
  throw new Error("Generated provider catalog version must increase.");
}
const [modelsDev, openRouter] = await Promise.all([
  loadSource({
    id: "models.dev",
    file: args.modelsDevSourceFile,
    url: args.modelsDevSourceUrl,
  }),
  args.openRouterSourceFile || args.openRouterSourceUrl
    ? loadSource({
        id: "openrouter",
        file: args.openRouterSourceFile,
        url: args.openRouterSourceUrl,
      })
    : Promise.resolve(undefined),
]);

let next: GeneratedProviderCatalog = {
  version: nextVersion,
  providers: current.providers,
};
const evidence: CatalogSourceEvidence[] = [];
const failures: string[] = [];

if (modelsDev.ok) {
  try {
    next = parseModelsDevCatalog({
      source: parseSourceJson(modelsDev),
      fallback: current,
      nextVersion,
    });
    evidence.push({ id: modelsDev.id, text: modelsDev.text });
  } catch (error) {
    failures.push(sourceFailure(modelsDev.id, error));
  }
} else {
  failures.push(modelsDev.message);
}

if (openRouter?.ok) {
  try {
    next = applyOpenRouterCatalog({
      source: parseSourceJson(openRouter),
      catalog: next,
    });
    evidence.push({ id: openRouter.id, text: openRouter.text });
  } catch (error) {
    failures.push(sourceFailure(openRouter.id, error));
  }
} else if (openRouter) {
  failures.push(openRouter.message);
}

for (const failure of failures) process.stderr.write(`warning: ${failure}\n`);
if (evidence.length === 0) {
  throw new Error(
    "All external provider catalog sources failed; the committed snapshot was not changed.",
  );
}

next = applyCatalogModelAdditions(next, CATALOG_MODEL_ADDITIONS);
const summaries = summarizeCatalogDiff(current, next);
const hasCatalogChanges = summaries.some(
  (summary) =>
    summary.added.length > 0 ||
    summary.removed.length > 0 ||
    summary.changed.length > 0,
);

for (const summary of summaries) {
  process.stdout.write(
    `${summary.providerId}: ${summary.before} -> ${summary.after} ` +
      `(+${summary.added.length}/-${summary.removed.length}/~${summary.changed.length})\n`,
  );
}

if (args.write && hasCatalogChanges) {
  await writeFile(
    DEFAULT_OUTPUT,
    await renderGeneratedCatalog({ catalog: next, sources: evidence }),
    "utf8",
  );
  process.stdout.write(`updated ${DEFAULT_OUTPUT}\n`);
} else if (args.write) {
  process.stdout.write(
    "catalog unchanged: generated snapshot was not written\n",
  );
} else {
  process.stdout.write("shadow mode: generated snapshot was not written\n");
}

type LoadedSource =
  | { ok: true; id: string; text: string }
  | { ok: false; id: string; message: string };

async function loadSource(input: {
  id: string;
  file?: string;
  url?: string;
}): Promise<LoadedSource> {
  try {
    const text = input.file
      ? await readFile(resolve(input.file), "utf8")
      : input.url
        ? await fetchSource(input.url)
        : undefined;
    if (text === undefined) throw new Error("source location is missing");
    assertBoundedSourceText(text);
    return { ok: true, id: input.id, text };
  } catch (error) {
    return { ok: false, id: input.id, message: sourceFailure(input.id, error) };
  }
}

function parseSourceJson(source: Extract<LoadedSource, { ok: true }>): unknown {
  try {
    return JSON.parse(source.text);
  } catch {
    throw new Error("response is not valid JSON");
  }
}

async function fetchSource(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`returned HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function sourceFailure(id: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${id} catalog source failed: ${message}`;
}

function parseArgs(values: readonly string[]): {
  write: boolean;
  modelsDevSourceFile?: string;
  modelsDevSourceUrl: string;
  openRouterSourceFile?: string;
  openRouterSourceUrl?: string;
  version?: number;
} {
  let write = false;
  let modelsDevSourceFile: string | undefined;
  let modelsDevSourceUrl = DEFAULT_MODELS_DEV_SOURCE_URL;
  let openRouterSourceFile: string | undefined;
  let openRouterSourceUrl: string | undefined;
  let version: number | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--write") {
      write = true;
      continue;
    }
    if (value === "--shadow") continue;
    if (value === "--source-file" || value === "--models-dev-source-file") {
      modelsDevSourceFile = requiredValue(values, ++index, value);
      continue;
    }
    if (value === "--source-url" || value === "--models-dev-source-url") {
      modelsDevSourceUrl = requiredValue(values, ++index, value);
      continue;
    }
    if (value === "--openrouter-source-file") {
      openRouterSourceFile = requiredValue(values, ++index, value);
      continue;
    }
    if (value === "--openrouter-source-url") {
      openRouterSourceUrl = requiredValue(values, ++index, value);
      continue;
    }
    if (value === "--version") {
      const parsed = Number(requiredValue(values, ++index, value));
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error("--version must be a positive integer.");
      }
      version = parsed;
      continue;
    }
    throw new Error(`Unknown provider catalog option: ${value}`);
  }
  return {
    write,
    ...(modelsDevSourceFile ? { modelsDevSourceFile } : {}),
    modelsDevSourceUrl,
    ...(openRouterSourceFile ? { openRouterSourceFile } : {}),
    ...(openRouterSourceUrl ? { openRouterSourceUrl } : {}),
    ...(version ? { version } : {}),
  };
}

function requiredValue(
  values: readonly string[],
  index: number,
  option: string,
): string {
  const value = values[index];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}
