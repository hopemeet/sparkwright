import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteText } from "@sparkwright/agent-runtime";
import {
  BUNDLED_PROVIDER_CATALOG,
  sanitizeProviderCatalogSnapshot,
  type BundledProviderCatalogEntry,
  type BundledProviderCatalogSnapshot,
} from "./provider-catalog.js";
import { withExclusiveFileLock } from "./provider-credential-store.js";

const PROVIDER_CATALOG_STATE_VERSION = 2;
const LEGACY_PROVIDER_CATALOG_STATE_VERSION = 1;
const PROVIDER_DISCOVERY_STATE_VERSION = 1;
const SIGNED_CATALOG_ARTIFACT_VERSION = 2;
const LEGACY_SIGNED_CATALOG_ARTIFACT_VERSION = 1;
const MAX_SIGNED_PAYLOAD_BYTES = 16 * 1024 * 1024;
const PROVIDER_CATALOG_REFRESH_LEASE_VERSION = 1;

interface ProviderCatalogRefreshLeaseFile {
  version: typeof PROVIDER_CATALOG_REFRESH_LEASE_VERSION;
  ownerId: string;
  expiresAt: string;
}

interface ProviderCatalogStateFile {
  version: typeof PROVIDER_CATALOG_STATE_VERSION;
  generation: number;
  source: "signed";
  fetchedAt: string;
  expiresAt: string;
  catalogDigest: string;
  sourceRevision?: string;
  etag?: string;
  catalog: BundledProviderCatalogSnapshot;
}

interface ProviderDiscoveryStateFile {
  version: typeof PROVIDER_DISCOVERY_STATE_VERSION;
  generation: number;
  source: "discovery";
  scopeDigest: string;
  providerId: string;
  fetchedAt: string;
  expiresAt: string;
  provider: BundledProviderCatalogEntry;
}

export interface ProviderCatalogStateSnapshot {
  generation: number;
  source: "bundled" | "signed";
  fetchedAt?: string;
  expiresAt?: string;
  stale: boolean;
  catalogDigest: string;
  sourceRevision?: string;
  etag?: string;
  catalog: BundledProviderCatalogSnapshot;
}

export interface ProviderDiscoveryStateSnapshot {
  generation: number;
  source: "discovery";
  fetchedAt: string;
  expiresAt: string;
  stale: boolean;
  provider: BundledProviderCatalogEntry;
}

export interface SignedProviderCatalogArtifact {
  artifactVersion:
    | typeof LEGACY_SIGNED_CATALOG_ARTIFACT_VERSION
    | typeof SIGNED_CATALOG_ARTIFACT_VERSION;
  keyId: string;
  payload: string;
  signature: string;
}

export interface SignedProviderCatalogPayload {
  schemaVersion: 1 | 2;
  issuedAt: string;
  expiresAt: string;
  sourceRevision?: string;
  catalogDigest: string;
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
    this.bundled = sanitizeProviderCatalogSnapshot(
      options.bundled ?? BUNDLED_PROVIDER_CATALOG,
    );
  }

  async current(): Promise<ProviderCatalogStateSnapshot> {
    const state = await this.readState();
    if (!state) return this.bundledState();
    return publicState(state, this.now());
  }

  /**
   * Claim a short-lived network-refresh lease without holding the catalog file
   * lock while an HTTP request is in flight. Expiry makes the lease recoverable
   * if another Host exits before releasing it.
   */
  async claimRefreshLease(input: {
    ownerId: string;
    ttlMs: number;
  }): Promise<boolean> {
    const ownerId = optionalBoundedText(input.ownerId, "lease owner", 256);
    if (
      !ownerId ||
      !Number.isSafeInteger(input.ttlMs) ||
      input.ttlMs < 1_000 ||
      input.ttlMs > 5 * 60_000
    ) {
      throw new Error("Provider catalog refresh lease is invalid.");
    }
    const path = `${this.path}.refresh-lease.json`;
    return await withExclusiveFileLock(`${path}.lock`, async () => {
      const current = await readRefreshLeaseFile(path);
      const nowMs = this.now().getTime();
      if (
        current &&
        current.ownerId !== ownerId &&
        Date.parse(current.expiresAt) > nowMs
      ) {
        return false;
      }
      const lease: ProviderCatalogRefreshLeaseFile = {
        version: PROVIDER_CATALOG_REFRESH_LEASE_VERSION,
        ownerId,
        expiresAt: new Date(nowMs + input.ttlMs).toISOString(),
      };
      await atomicWriteText(path, `${JSON.stringify(lease, null, 2)}\n`, {
        mode: 0o600,
        durable: true,
      });
      return true;
    });
  }

  async releaseRefreshLease(ownerIdValue: string): Promise<void> {
    const ownerId = optionalBoundedText(ownerIdValue, "lease owner", 256);
    if (!ownerId) return;
    const path = `${this.path}.refresh-lease.json`;
    await withExclusiveFileLock(`${path}.lock`, async () => {
      const current = await readRefreshLeaseFile(path);
      if (current?.ownerId !== ownerId) return;
      await rm(path, { force: true });
    });
  }

  async publish(input: {
    expectedGeneration: number;
    source: "signed";
    fetchedAt: string;
    expiresAt: string;
    catalog: BundledProviderCatalogSnapshot;
    sourceRevision?: string;
    etag?: string;
  }): Promise<
    | { published: true; snapshot: ProviderCatalogStateSnapshot }
    | { published: false; snapshot: ProviderCatalogStateSnapshot }
  > {
    const catalog = sanitizeProviderCatalogSnapshot(input.catalog);
    assertCompleteSignedCatalog(catalog, this.bundled);
    const catalogDigest = providerCatalogDigest(catalog);
    const sourceRevision = optionalBoundedText(
      input.sourceRevision,
      "sourceRevision",
      512,
    );
    const etag = optionalBoundedText(input.etag, "etag", 512);
    const fetchedAt = validTimestamp(input.fetchedAt, "fetchedAt");
    const expiresAt = validTimestamp(input.expiresAt, "expiresAt");

    return await withExclusiveFileLock(`${this.path}.lock`, async () => {
      const current = await this.readState();
      const generation = current?.generation ?? 0;
      const currentSnapshot = current
        ? publicState(current, this.now())
        : this.bundledState();
      if (generation !== input.expectedGeneration) {
        return { published: false as const, snapshot: currentSnapshot };
      }
      if (catalog.version < currentSnapshot.catalog.version) {
        throw new Error(
          "Signed provider catalog version cannot move backwards.",
        );
      }
      if (catalog.version === currentSnapshot.catalog.version) {
        if (catalogDigest !== currentSnapshot.catalogDigest) {
          throw new Error(
            "Signed provider catalog content changed without a version increase.",
          );
        }
        if (
          current &&
          current.expiresAt === expiresAt &&
          current.sourceRevision === sourceRevision &&
          current.etag === etag
        ) {
          return { published: false as const, snapshot: currentSnapshot };
        }
      }

      const next: ProviderCatalogStateFile = {
        version: PROVIDER_CATALOG_STATE_VERSION,
        generation: generation + 1,
        source: "signed",
        fetchedAt,
        expiresAt,
        catalogDigest,
        ...(sourceRevision ? { sourceRevision } : {}),
        ...(etag ? { etag } : {}),
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

  async currentDiscovery(input: {
    scopeKey: string;
    providerId: string;
  }): Promise<ProviderDiscoveryStateSnapshot | undefined> {
    const identity = discoveryIdentity({ ...input, basePath: this.path });
    const state = await this.readDiscoveryState(identity.path, identity.digest);
    return state ? publicDiscoveryState(state, this.now()) : undefined;
  }

  async publishDiscovery(input: {
    expectedGeneration: number;
    scopeKey: string;
    providerId: string;
    fetchedAt: string;
    expiresAt: string;
    provider: BundledProviderCatalogEntry;
  }): Promise<
    | { published: true; snapshot: ProviderDiscoveryStateSnapshot }
    | { published: false; snapshot: ProviderDiscoveryStateSnapshot }
  > {
    const provider = sanitizeDiscoveryProvider(
      input.providerId,
      input.provider,
    );
    if (provider.models.length === 0) {
      throw new Error(
        "Authenticated model discovery cannot publish an empty catalog.",
      );
    }
    const identity = discoveryIdentity({ ...input, basePath: this.path });
    const fetchedAt = validTimestamp(input.fetchedAt, "fetchedAt");
    const expiresAt = validTimestamp(input.expiresAt, "expiresAt");
    return await withExclusiveFileLock(`${identity.path}.lock`, async () => {
      const current = await this.readDiscoveryState(
        identity.path,
        identity.digest,
      );
      const generation = current?.generation ?? 0;
      if (generation !== input.expectedGeneration) {
        if (!current) {
          throw new Error(
            "Authenticated model discovery generation is invalid.",
          );
        }
        return {
          published: false as const,
          snapshot: publicDiscoveryState(current, this.now()),
        };
      }
      const next: ProviderDiscoveryStateFile = {
        version: PROVIDER_DISCOVERY_STATE_VERSION,
        generation: generation + 1,
        source: "discovery",
        scopeDigest: identity.digest,
        providerId: input.providerId,
        fetchedAt,
        expiresAt,
        provider,
      };
      if (current) {
        await atomicWriteText(
          `${identity.path}.bak`,
          `${JSON.stringify(current, null, 2)}\n`,
          { mode: 0o600, durable: true },
        );
      }
      await atomicWriteText(
        identity.path,
        `${JSON.stringify(next, null, 2)}\n`,
        { mode: 0o600, durable: true },
      );
      return {
        published: true as const,
        snapshot: publicDiscoveryState(next, this.now()),
      };
    });
  }

  private async readState(): Promise<ProviderCatalogStateFile | undefined> {
    const primary = await readCatalogStateFile(this.path);
    if (primary && this.isUsableState(primary)) return primary;
    const backup = await readCatalogStateFile(`${this.path}.bak`);
    return backup && this.isUsableState(backup) ? backup : undefined;
  }

  private async readDiscoveryState(
    path: string,
    expectedScopeDigest: string,
  ): Promise<ProviderDiscoveryStateFile | undefined> {
    const primary = await readDiscoveryStateFile(path, expectedScopeDigest);
    if (primary) return primary;
    return await readDiscoveryStateFile(`${path}.bak`, expectedScopeDigest);
  }

  private bundledState(): ProviderCatalogStateSnapshot {
    return {
      generation: 0,
      source: "bundled",
      stale: false,
      catalogDigest: providerCatalogDigest(this.bundled),
      catalog: this.bundled,
    };
  }

  private isUsableState(state: ProviderCatalogStateFile): boolean {
    if (state.catalog.version > this.bundled.version) return true;
    return (
      state.catalog.version === this.bundled.version &&
      state.catalogDigest === providerCatalogDigest(this.bundled)
    );
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

export function providerCatalogDigest(
  catalog: BundledProviderCatalogSnapshot,
): string {
  const normalized = sanitizeProviderCatalogSnapshot(catalog);
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")}`;
}

export function verifySignedProviderCatalogArtifact(input: {
  artifact: SignedProviderCatalogArtifact;
  trustedKeys: Readonly<Record<string, string>>;
  now?: Date;
}): SignedProviderCatalogPayload {
  const artifact = input.artifact;
  if (
    (artifact.artifactVersion !== LEGACY_SIGNED_CATALOG_ARTIFACT_VERSION &&
      artifact.artifactVersion !== SIGNED_CATALOG_ARTIFACT_VERSION) ||
    typeof artifact.keyId !== "string" ||
    typeof artifact.payload !== "string" ||
    typeof artifact.signature !== "string"
  ) {
    throw new Error("Signed provider catalog artifact is invalid.");
  }
  const publicKey = input.trustedKeys[artifact.keyId];
  if (!publicKey) {
    throw new Error("Signed provider catalog key is not trusted.");
  }
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
  if (!isRecord(parsed)) {
    throw new Error("Signed provider catalog payload is invalid.");
  }
  const legacy =
    artifact.artifactVersion === LEGACY_SIGNED_CATALOG_ARTIFACT_VERSION;
  requireOnlyKeys(
    parsed,
    legacy
      ? ["schemaVersion", "issuedAt", "expiresAt", "catalog"]
      : [
          "schemaVersion",
          "issuedAt",
          "expiresAt",
          "sourceRevision",
          "catalogDigest",
          "catalog",
        ],
  );
  if (parsed.schemaVersion !== (legacy ? 1 : 2)) {
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
  const catalog = sanitizeProviderCatalogSnapshot(parsed.catalog);
  const catalogDigest = providerCatalogDigest(catalog);
  const sourceRevision = legacy
    ? undefined
    : optionalBoundedText(parsed.sourceRevision, "sourceRevision", 512);
  if (!legacy) {
    if (!sourceRevision || parsed.catalogDigest !== catalogDigest) {
      throw new Error(
        "Signed provider catalog digest or source revision is invalid.",
      );
    }
  }
  return {
    schemaVersion: legacy ? 1 : 2,
    issuedAt,
    expiresAt,
    ...(sourceRevision ? { sourceRevision } : {}),
    catalogDigest,
    catalog,
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
  if (!isRecord(parsed)) return undefined;
  if (parsed.version === LEGACY_PROVIDER_CATALOG_STATE_VERSION) {
    return migrateLegacyCatalogState(parsed);
  }
  if (parsed.version !== PROVIDER_CATALOG_STATE_VERSION) return undefined;
  if (
    !Number.isSafeInteger(parsed.generation) ||
    (parsed.generation as number) < 1 ||
    parsed.source !== "signed" ||
    typeof parsed.fetchedAt !== "string" ||
    typeof parsed.expiresAt !== "string" ||
    typeof parsed.catalogDigest !== "string"
  ) {
    return undefined;
  }
  try {
    const catalog = sanitizeProviderCatalogSnapshot(parsed.catalog);
    const catalogDigest = providerCatalogDigest(catalog);
    if (parsed.catalogDigest !== catalogDigest) return undefined;
    const sourceRevision = optionalBoundedText(
      parsed.sourceRevision,
      "sourceRevision",
      512,
    );
    const etag = optionalBoundedText(parsed.etag, "etag", 512);
    return {
      version: PROVIDER_CATALOG_STATE_VERSION,
      generation: parsed.generation as number,
      source: "signed",
      fetchedAt: validTimestamp(parsed.fetchedAt, "fetchedAt"),
      expiresAt: validTimestamp(parsed.expiresAt, "expiresAt"),
      catalogDigest,
      ...(sourceRevision ? { sourceRevision } : {}),
      ...(etag ? { etag } : {}),
      catalog,
    };
  } catch {
    return undefined;
  }
}

async function readRefreshLeaseFile(
  path: string,
): Promise<ProviderCatalogRefreshLeaseFile | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== PROVIDER_CATALOG_REFRESH_LEASE_VERSION
  ) {
    return undefined;
  }
  try {
    const ownerId = optionalBoundedText(parsed.ownerId, "lease owner", 256);
    if (!ownerId) return undefined;
    return {
      version: PROVIDER_CATALOG_REFRESH_LEASE_VERSION,
      ownerId,
      expiresAt: validTimestamp(parsed.expiresAt, "lease expiresAt"),
    };
  } catch {
    return undefined;
  }
}

function migrateLegacyCatalogState(
  parsed: Record<string, unknown>,
): ProviderCatalogStateFile | undefined {
  if (parsed.source !== "signed") return undefined;
  if (
    !Number.isSafeInteger(parsed.generation) ||
    (parsed.generation as number) < 1 ||
    typeof parsed.fetchedAt !== "string" ||
    typeof parsed.expiresAt !== "string"
  ) {
    return undefined;
  }
  try {
    const catalog = sanitizeProviderCatalogSnapshot(parsed.catalog);
    return {
      version: PROVIDER_CATALOG_STATE_VERSION,
      generation: parsed.generation as number,
      source: "signed",
      fetchedAt: validTimestamp(parsed.fetchedAt, "fetchedAt"),
      expiresAt: validTimestamp(parsed.expiresAt, "expiresAt"),
      catalogDigest: providerCatalogDigest(catalog),
      catalog,
    };
  } catch {
    return undefined;
  }
}

async function readDiscoveryStateFile(
  path: string,
  expectedScopeDigest: string,
): Promise<ProviderDiscoveryStateFile | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== PROVIDER_DISCOVERY_STATE_VERSION ||
    parsed.source !== "discovery" ||
    parsed.scopeDigest !== expectedScopeDigest ||
    !Number.isSafeInteger(parsed.generation) ||
    (parsed.generation as number) < 1 ||
    typeof parsed.providerId !== "string"
  ) {
    return undefined;
  }
  try {
    return {
      version: PROVIDER_DISCOVERY_STATE_VERSION,
      generation: parsed.generation as number,
      source: "discovery",
      scopeDigest: expectedScopeDigest,
      providerId: parsed.providerId,
      fetchedAt: validTimestamp(parsed.fetchedAt, "fetchedAt"),
      expiresAt: validTimestamp(parsed.expiresAt, "expiresAt"),
      provider: sanitizeDiscoveryProvider(parsed.providerId, parsed.provider),
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
    catalogDigest: state.catalogDigest,
    ...(state.sourceRevision ? { sourceRevision: state.sourceRevision } : {}),
    ...(state.etag ? { etag: state.etag } : {}),
    catalog: state.catalog,
  };
}

function publicDiscoveryState(
  state: ProviderDiscoveryStateFile,
  now: Date,
): ProviderDiscoveryStateSnapshot {
  return {
    generation: state.generation,
    source: "discovery",
    fetchedAt: state.fetchedAt,
    expiresAt: state.expiresAt,
    stale: Date.parse(state.expiresAt) <= now.getTime(),
    provider: state.provider,
  };
}

function discoveryIdentity(input: {
  scopeKey: string;
  providerId: string;
  basePath: string;
}): { digest: string; path: string } {
  const scopeKey = optionalBoundedText(input.scopeKey, "scopeKey", 2_048);
  const providerId = optionalBoundedText(input.providerId, "providerId", 128);
  if (!scopeKey || !providerId) {
    throw new Error("Authenticated model discovery scope is invalid.");
  }
  const digest = createHash("sha256")
    .update(`${providerId}\0${scopeKey}`)
    .digest("hex");
  return {
    digest,
    path: join(
      dirname(input.basePath),
      "provider-catalog.discovery",
      `${digest}.json`,
    ),
  };
}

function sanitizeDiscoveryProvider(
  providerId: string,
  provider: unknown,
): BundledProviderCatalogEntry {
  const catalog = sanitizeProviderCatalogSnapshot({
    version: 1,
    providers: [provider],
  });
  const sanitized = catalog.providers[0];
  if (!sanitized || sanitized.id !== providerId) {
    throw new Error("Authenticated model discovery provider is invalid.");
  }
  return sanitized;
}

function assertCompleteSignedCatalog(
  catalog: BundledProviderCatalogSnapshot,
  bundled: BundledProviderCatalogSnapshot,
): void {
  const providers = new Map(
    catalog.providers.map((provider) => [provider.id, provider]),
  );
  for (const fallback of bundled.providers) {
    const provider = providers.get(fallback.id);
    if (!provider) {
      throw new Error(
        `Signed provider catalog is missing provider "${fallback.id}".`,
      );
    }
    if (fallback.models.length > 0 && provider.models.length === 0) {
      throw new Error(
        `Signed provider catalog provider "${fallback.id}" is empty.`,
      );
    }
  }
}

function validTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Provider catalog ${field} is invalid.`);
  }
  return value;
}

function optionalBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    throw new Error(`Provider catalog ${field} is invalid.`);
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
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
