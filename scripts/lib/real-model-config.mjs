import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";

export async function configuredModelAvailability(model, options) {
  const [provider, modelId] = model.split("/", 2);
  if (!provider || !modelId) {
    return {
      available: false,
      reason: `model must be provider/model, got ${model}`,
    };
  }

  const result = await options.runCli(
    ["config", "inspect", "--workspace", ".", "--format", "json"],
    { isolateConfig: false },
  );
  if (result.exitCode !== 0) {
    return {
      available: false,
      reason: `config inspect failed with exitCode=${result.exitCode}: ${result.stderr || result.stdout}`,
    };
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    return {
      available: false,
      reason: `config inspect output was not JSON: ${String(error)}`,
    };
  }

  const configFiles = configFilesForProvider(report, provider);
  const providerConfig =
    providerConfigFromEffectiveReport(report, provider) ??
    (await providerConfigFromFiles(configFiles, provider));
  if (!providerConfig) {
    return {
      available: false,
      reason: `No effective config entry found for provider ${provider}; set SPARKWRIGHT_REAL_MODEL to a configured real model.`,
    };
  }

  const modelIds = Object.keys(providerConfig.models ?? {});
  const hasModel = modelIds.length === 0 || modelIds.includes(modelId);
  const envHasKey = Boolean(process.env[`${provider.toUpperCase()}_API_KEY`]);
  const configHasInlineKey =
    Boolean(providerConfig.apiKey) && providerConfig.apiKey !== "<redacted>";
  const configHasRecoverableRedactedKey =
    providerConfig.apiKey === "<redacted>" && configFiles.length > 0;
  const hasKey =
    envHasKey || configHasInlineKey || configHasRecoverableRedactedKey;
  if (!hasKey || !hasModel) {
    return {
      available: false,
      reason:
        `${model} was not fully available in the effective config ` +
        `(apiKey=${hasKey ? "present" : "missing"} model=${hasModel ? "present" : "missing"}; ` +
        `available models: ${modelIds.join(",") || "(unrestricted)"})`,
    };
  }

  return {
    available: true,
    provider,
    modelId,
    providerConfig,
    configFiles,
  };
}

export async function prepareIsolatedUserConfig(availability, options) {
  const targetDir = join(options.isolatedXdgConfigHome, "sparkwright");
  await mkdir(targetDir, { recursive: true });
  await mkdir(options.isolatedXdgStateHome, { recursive: true });

  const copied = new Set();
  for (const file of availability.configFiles ?? []) {
    if (!existsSync(file) || copied.has(file)) continue;
    copied.add(file);
    await writeFile(
      join(targetDir, basename(file)),
      await readFile(file, "utf8"),
      "utf8",
    );
  }
  if (copied.size > 0) return;

  const providerConfig = availability.providerConfig;
  if (!providerConfig) return;
  const providerForFixture = { ...providerConfig };
  if (providerForFixture.apiKey === "<redacted>") {
    delete providerForFixture.apiKey;
  }
  await writeFile(
    join(targetDir, "config.json"),
    `${JSON.stringify(
      {
        model: options.requestedModel,
        providers: {
          [availability.provider]: providerForFixture,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function providerConfigFromEffectiveReport(report, provider) {
  return (
    report.config?.providers?.[provider] ??
    report.config?.identity?.providers?.[provider]
  );
}

async function providerConfigFromFiles(files, provider) {
  for (const file of files) {
    if (!existsSync(file)) continue;
    const config = await readConfigFile(file).catch(() => undefined);
    const providerConfig =
      config?.providers?.[provider] ?? config?.identity?.providers?.[provider];
    if (providerConfig) return providerConfig;
  }
  return undefined;
}

async function readConfigFile(file) {
  const text = await readFile(file, "utf8");
  if (/\.ya?ml$/i.test(file)) return parseYaml(text);
  return JSON.parse(text);
}

function configFilesForProvider(report, provider) {
  const files = [];
  const providerSource = report.sources?.providers?.[provider];
  const identityProviderSource =
    report.sources?.identity?.providers?.[provider];
  const modelSource = report.sources?.model;
  const identityModelSource = report.sources?.identity?.model;
  for (const source of [
    providerSource,
    identityProviderSource,
    modelSource,
    identityModelSource,
  ]) {
    const file = fileFromSource(source);
    if (file) files.push(file);
  }
  for (const layer of report.layers ?? []) {
    if (layer?.loaded && typeof layer.path === "string") {
      files.push(layer.path);
    }
  }
  return [...new Set(files)];
}

function fileFromSource(source) {
  if (typeof source !== "string") return undefined;
  const index = source.indexOf(":");
  if (index < 0) return undefined;
  const value = source.slice(index + 1);
  return value.startsWith("/") ? value : undefined;
}
