import { createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GENERATED_PROVIDER_MODEL_CATALOG } from "../../packages/host/src/generated/provider-model-catalog.js";
import { providerCatalogDigest } from "../../packages/host/src/provider-catalog-store.js";

const args = parseArgs(process.argv.slice(2), process.env);
const issuedAt = args.issuedAt ?? new Date().toISOString();
const expiresAt = args.expiresAt;
if (!Number.isFinite(Date.parse(issuedAt))) {
  throw new Error("--issued-at must be a valid timestamp.");
}
if (
  !Number.isFinite(Date.parse(expiresAt)) ||
  Date.parse(expiresAt) <= Date.parse(issuedAt)
) {
  throw new Error("--expires-at must be later than --issued-at.");
}

const catalog = GENERATED_PROVIDER_MODEL_CATALOG;
const payload = {
  schemaVersion: 2 as const,
  issuedAt,
  expiresAt,
  sourceRevision: args.sourceRevision,
  catalogDigest: providerCatalogDigest(catalog),
  catalog,
};
const payloadBytes = Buffer.from(JSON.stringify(payload));
const privateKey = createPrivateKey(
  await readFile(resolve(args.privateKeyFile), "utf8"),
);
const artifact = {
  artifactVersion: 2 as const,
  keyId: args.keyId,
  payload: payloadBytes.toString("base64url"),
  signature: sign(null, payloadBytes, privateKey).toString("base64url"),
};

await writeFile(
  resolve(args.output),
  `${JSON.stringify(artifact, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `signed provider catalog ${catalog.version} -> ${args.output}\n`,
);

function parseArgs(
  values: readonly string[],
  env: Record<string, string | undefined>,
): {
  keyId: string;
  privateKeyFile: string;
  sourceRevision: string;
  issuedAt?: string;
  expiresAt: string;
  output: string;
} {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!option?.startsWith("--") || !value) {
      throw new Error("Provider catalog signing options require values.");
    }
    if (
      ![
        "--key-id",
        "--private-key-file",
        "--source-revision",
        "--issued-at",
        "--expires-at",
        "--output",
      ].includes(option)
    ) {
      throw new Error(`Unknown provider catalog signing option: ${option}`);
    }
    options.set(option, value);
  }
  const keyId = options.get("--key-id");
  const privateKeyFile =
    options.get("--private-key-file") ??
    env.SPARKWRIGHT_PROVIDER_CATALOG_SIGNING_KEY_FILE;
  const sourceRevision = options.get("--source-revision");
  const expiresAt = options.get("--expires-at");
  if (!keyId || keyId.length > 128) throw new Error("--key-id is required.");
  if (!privateKeyFile) {
    throw new Error(
      "--private-key-file or SPARKWRIGHT_PROVIDER_CATALOG_SIGNING_KEY_FILE is required.",
    );
  }
  if (!sourceRevision || sourceRevision.length > 512) {
    throw new Error("--source-revision is required.");
  }
  if (!expiresAt) throw new Error("--expires-at is required.");
  return {
    keyId,
    privateKeyFile,
    sourceRevision,
    ...(options.get("--issued-at")
      ? { issuedAt: options.get("--issued-at")! }
      : {}),
    expiresAt,
    output: options.get("--output") ?? "provider-catalog.artifact.json",
  };
}
