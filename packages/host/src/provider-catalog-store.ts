import { createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteText } from "@sparkwright/agent-runtime";
import {
  BUNDLED_PROVIDER_CATALOG,
  sanitizeProviderCatalogSnapshot,
  type BundledProviderCatalogSnapshot,
} from "./provider-catalog.js";
import { withExclusiveFileLock } from "./provider-credential-store.js";

const PROVIDER_CATALOG_STATE_VERSION = 1;
const SIGNED_CATALOG_ARTIFACT_VERSION = 1;
const MAX_SIGNED_PAYLOAD_BYTES = 16 * 1024 * 1024;

interface ProviderCatalogStateFile {
  version: typeof PROVIDER_CATALOG_STATE_VERSION;
  generation: number;
  source: "signed" | "discovery";
  fetchedAt: string;
  expiresAt: string;
  catalog: BundledProviderCatalogSnapshot;
}

export interface ProviderCatalogStateSnapshot {
  generation: number;
  source: "bundled" | "signed" | "discovery";
  fetchedAt?: string;
  expiresAt?: string;
  stale: boolean;
  catalog: BundledProviderCatalogSnapshot;
}

export interface SignedProviderCatalogArtifact {
  artifactVersion: typeof SIGNED_CATALOG_ARTIFACT_VERSION;
  keyId: string;
  payload: string;
  signature: string;
}

export interface SignedProviderCatalogPayload {
  schemaVersion: 1;
  issuedAt: string;
  expiresAt: string;
  catalog: BundledProviderCatalogSnapshot;
}

export interface ProviderCatalogStoreOptions {
  path?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  bundled?: BundledProviderCatalogSnapshot;
}

export class ProviderCatalogStore {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly bundled: BundledProviderCatalogSnapshot;

  constructor(options: ProviderCatalogStoreOptions = {}) {
    this.path = options.path ?? providerCatalogStatePath(options.env);
    this.now = options.now ?? (() => new Date());
    this.bundled = options.bundled ?? BUNDLED_PROVIDER_CATALOG;
  }

  async current(): Promise<ProviderCatalogStateSnapshot> {
    const state = await this.readState();
    if (!state) {
      return {
        generation: 0,
        source: "bundled",
        stale: false,
        catalog: this.bundled,
      };
    }
    return publicState(state, this.now());
  }

  async publish(input: {
    expectedGeneration: number;
    source: "signed" | "discovery";
    fetchedAt: string;
    expiresAt: string;
    catalog: BundledProviderCatalogSnapshot;
  }): Promise<
    | { published: true; snapshot: ProviderCatalogStateSnapshot }
    | { published: false; snapshot: ProviderCatalogStateSnapshot }
  > {
    const catalog = sanitizeProviderCatalogSnapshot(input.catalog);
    return await withExclusiveFileLock(`${this.path}.lock`, async () => {
      const current = await this.readState();
      const generation = current?.generation ?? 0;
      if (generation !== input.expectedGeneration) {
        return {
          published: false as const,
          snapshot: current
            ? publicState(current, this.now())
            : {
                generation: 0,
                source: "bundled" as const,
                stale: false,
                catalog: this.bundled,
              },
        };
      }
      const next: ProviderCatalogStateFile = {
        version: PROVIDER_CATALOG_STATE_VERSION,
        generation: generation + 1,
        source: input.source,
        fetchedAt: input.fetchedAt,
        expiresAt: input.expiresAt,
        catalog,
      };
      if (current) {
        await atomicWriteText(
          `${this.path}.bak`,
          `${JSON.stringify(current, null, 2)}\n`,
          { mode: 0o600, durable: true },
        );
      }
      await atomicWriteText(this.path, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
        durable: true,
      });
      return {
        published: true as const,
        snapshot: publicState(next, this.now()),
      };
    });
  }

  private async readState(): Promise<ProviderCatalogStateFile | undefined> {
    const primary = await readCatalogStateFile(this.path);
    if (primary) return primary;
    return await readCatalogStateFile(`${this.path}.bak`);
  }
}

export function providerCatalogStatePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const stateBase =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(stateBase, "sparkwright", "provider-catalog.json");
}

export function verifySignedProviderCatalogArtifact(input: {
  artifact: SignedProviderCatalogArtifact;
  trustedKeys: Readonly<Record<string, string>>;
  now?: Date;
}): SignedProviderCatalogPayload {
  const artifact = input.artifact;
  if (
    artifact.artifactVersion !== SIGNED_CATALOG_ARTIFACT_VERSION ||
    typeof artifact.keyId !== "string" ||
    typeof artifact.payload !== "string" ||
    typeof artifact.signature !== "string"
  ) {
    throw new Error("Signed provider catalog artifact is invalid.");
  }
  const publicKey = input.trustedKeys[artifact.keyId];
  if (!publicKey)
    throw new Error("Signed provider catalog key is not trusted.");
  const payloadBytes = Buffer.from(artifact.payload, "base64url");
  if (
    payloadBytes.byteLength === 0 ||
    payloadBytes.byteLength > MAX_SIGNED_PAYLOAD_BYTES
  ) {
    throw new Error("Signed provider catalog payload is invalid.");
  }
  const signature = Buffer.from(artifact.signature, "base64url");
  if (
    signature.byteLength === 0 ||
    !verifySignature(null, payloadBytes, createPublicKey(publicKey), signature)
  ) {
    throw new Error("Signed provider catalog signature is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new Error("Signed provider catalog payload is not valid JSON.");
  }
  if (!isRecord(parsed))
    throw new Error("Signed provider catalog payload is invalid.");
  requireOnlyKeys(parsed, [
    "schemaVersion",
    "issuedAt",
    "expiresAt",
    "catalog",
  ]);
  if (parsed.schemaVersion !== 1) {
    throw new Error("Signed provider catalog schema version is unsupported.");
  }
  const issuedAt = validTimestamp(parsed.issuedAt, "issuedAt");
  const expiresAt = validTimestamp(parsed.expiresAt, "expiresAt");
  const now = input.now ?? new Date();
  if (Date.parse(expiresAt) <= now.getTime()) {
    throw new Error("Signed provider catalog artifact is expired.");
  }
  if (Date.parse(issuedAt) > now.getTime() + 5 * 60_000) {
    throw new Error(
      "Signed provider catalog artifact has a future issue time.",
    );
  }
  return {
    schemaVersion: 1,
    issuedAt,
    expiresAt,
    catalog: sanitizeProviderCatalogSnapshot(parsed.catalog),
  };
}

async function readCatalogStateFile(
  path: string,
): Promise<ProviderCatalogStateFile | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== PROVIDER_CATALOG_STATE_VERSION) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(parsed.generation) ||
    (parsed.generation as number) < 1 ||
    (parsed.source !== "signed" && parsed.source !== "discovery") ||
    typeof parsed.fetchedAt !== "string" ||
    typeof parsed.expiresAt !== "string"
  ) {
    return undefined;
  }
  try {
    return {
      version: PROVIDER_CATALOG_STATE_VERSION,
      generation: parsed.generation as number,
      source: parsed.source,
      fetchedAt: validTimestamp(parsed.fetchedAt, "fetchedAt"),
      expiresAt: validTimestamp(parsed.expiresAt, "expiresAt"),
      catalog: sanitizeProviderCatalogSnapshot(parsed.catalog),
    };
  } catch {
    return undefined;
  }
}

function publicState(
  state: ProviderCatalogStateFile,
  now: Date,
): ProviderCatalogStateSnapshot {
  return {
    generation: state.generation,
    source: state.source,
    fetchedAt: state.fetchedAt,
    expiresAt: state.expiresAt,
    stale: Date.parse(state.expiresAt) <= now.getTime(),
    catalog: state.catalog,
  };
}

function validTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Provider catalog ${field} is invalid.`);
  }
  return value;
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(
      "Signed provider catalog payload contains unsupported fields.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
