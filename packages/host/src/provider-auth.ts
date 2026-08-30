import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  ProviderAuthMethodsSnapshot,
  ProviderAuthAttemptSummary,
  ProviderAuthStatus,
  ProviderCatalogEntry,
  ProviderCatalogProjection,
  ProviderCatalogRefreshResult,
  ProviderCatalogSnapshot,
  ProviderConnectionBindingSummary,
  ProviderConnectionGrantScope,
  ProviderConnectionStatus,
  ProviderConnectionSummary,
  ProviderCredentialProfileSummary,
} from "@sparkwright/protocol";
import { atomicWriteText } from "@sparkwright/agent-runtime";
import type { ModelInfo } from "@sparkwright/provider-registry";
import {
  listChatGptModels,
  type ChatGptAppServerFactory,
} from "./chatgpt-app-server.js";
import type { ProviderConfig } from "./config-zod-schema.js";
import {
  loadHostConfig,
  resolveModelSelection,
} from "./config/config-implementation.js";
import {
  SUPPORTED_PROVIDER_NPMS,
  type ModelSelection,
} from "./config/contracts.js";
import {
  bundledProviderIds,
  createHostProviderRegistry,
  getProviderConnectionDescriptor,
  hasDisallowedMetadataControlCharacter,
  mergeProviderCatalogSnapshots,
  providerNpm,
  type BundledProviderCatalogEntry,
  type BundledProviderCatalogSnapshot,
  type ProviderConnectionAuthMethod,
} from "./provider-catalog.js";
import {
  ProviderCatalogStore,
  verifySignedProviderCatalogArtifact,
  type ProviderCatalogStateSnapshot,
  type ProviderDiscoveryStateSnapshot,
} from "./provider-catalog-store.js";
import {
  createHttpSignedProviderCatalogSource,
  readSignedProviderCatalogSource,
  type SignedProviderCatalogSourceLike,
} from "./provider-catalog-source.js";
import {
  createProviderCredentialStore,
  type ProviderCredentialStore,
  withExclusiveFileLock,
} from "./provider-credential-store.js";
import {
  createBuiltInProviderOAuthDrivers,
  createPkceChallenge,
  createPkceVerifier,
  oauthOpaqueValue,
  ProviderOAuthStartError,
  sameOpaqueValue,
  validateOAuthProof,
  type ProviderOAuthCredential,
  type ProviderOAuthDriver,
  type ProviderOAuthProof,
} from "./provider-oauth.js";

const PROVIDER_CONNECTION_STATE_VERSION = 2;
const LEGACY_PROVIDER_AUTH_STATE_VERSION = 1;
const MAX_SECRET_BYTES = 64 * 1024;
const REVISION_POLL_MS = 250;
const DEFAULT_OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1_000;
const OAUTH_TERMINAL_RETENTION_MS = 60 * 1_000;
const OAUTH_REFRESH_WINDOW_MS = 5 * 60 * 1_000;
const OAUTH_CREDENTIAL_PREFIX = "sparkwright.oauth.v1:";
const SIGNED_CATALOG_REFRESH_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const SIGNED_CATALOG_REFRESH_AHEAD_MS = 6 * 60 * 60 * 1_000;
const SIGNED_CATALOG_REFRESH_LEASE_TTL_MS = 60 * 1_000;
const MAX_OAUTH_IDENTITY_BYTES = 1_024;
const CHATGPT_MANAGED_AUTH_REALM = "https://chatgpt.com";
const CHATGPT_MANAGED_TRANSPORT = "chatgpt_app_server";
const CHATGPT_MANAGED_CREDENTIAL_MARKER = `${OAUTH_CREDENTIAL_PREFIX}${JSON.stringify(
  { managedTransport: CHATGPT_MANAGED_TRANSPORT },
)}`;
const LEGACY_CHATGPT_MANAGED_CREDENTIAL = `${OAUTH_CREDENTIAL_PREFIX}${JSON.stringify(
  {
    accessToken: "managed-by-openai-app-server",
    tokenType: "managed",
    authRealm: CHATGPT_MANAGED_AUTH_REALM,
    managedTransport: CHATGPT_MANAGED_TRANSPORT,
  },
)}`;
// macOS `security add-generic-password -w` truncates interactive password
// input at 128 bytes. The original verbose, non-secret managed marker hit that
// boundary. Accept only that exact historical truncation so affected accounts
// recover without another browser login; all new writes use the short marker.
const TRUNCATED_LEGACY_CHATGPT_MANAGED_CREDENTIAL =
  LEGACY_CHATGPT_MANAGED_CREDENTIAL.slice(0, 128);

interface LegacyProviderAuthStateRecord {
  providerId: string;
  state: "active" | "logged_out";
  generation: number;
  updatedAt: string;
}

interface ProviderConnectionBinding {
  providerId: string;
  driverId: string;
  normalizedEndpoint: string;
  /** Endpoint-only identity safe to expose to trusted local clients. */
  endpointFingerprint: string;
  /** Complete Host-private binding identity, including account and tenant. */
  bindingFingerprint?: string;
  authMethodId: string;
  authRealm?: string;
  accountSlot?: string;
  tenant?: string;
}

interface ProviderConnectionIdentity {
  authRealm?: string;
  accountSlot?: string;
  tenant?: string;
}

interface StoredProviderConnection {
  id: string;
  binding: ProviderConnectionBinding;
  status: ProviderConnectionStatus;
  generation: number;
  oauthRefreshGeneration?: number;
  oauthRefreshOutcome?: "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
}

interface ProviderOAuthAttempt {
  id: string;
  principalId: string;
  clientConnectionId: string;
  providerId: string;
  methodId: string;
  flow: "browser" | "device" | "code";
  driver: ProviderOAuthDriver;
  binding: ProviderConnectionBinding;
  workspaceId: string;
  grantScope: ProviderConnectionGrantScope;
  promptValues: Readonly<Record<string, string>>;
  state: string;
  nonce?: string;
  codeVerifier?: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "completed" | "failed" | "expired" | "cancelled";
  consuming: boolean;
  authorizationUrl?: string;
  verificationUrl?: string;
  userCode?: string;
  instructions?: string;
  connection?: ProviderConnectionSummary;
  message?: string;
  terminalAt?: number;
  cancel?: () => Promise<void> | void;
}

type ConnectionGrant =
  | { scope: "workspace"; workspaceId: string; connectionId: string }
  | { scope: "user"; connectionId: string };

interface ConnectionSuppression {
  workspaceId: string;
  bindingFingerprint: string;
  updatedAt: string;
}

interface ProviderConnectionStateFile {
  version: typeof PROVIDER_CONNECTION_STATE_VERSION;
  revision: number;
  /** Compatibility state for ambient environment/config credential profiles. */
  profiles: Record<string, LegacyProviderAuthStateRecord>;
  connections: Record<string, StoredProviderConnection>;
  grants: ConnectionGrant[];
  selections: Record<string, string>;
  suppressions: ConnectionSuppression[];
}

interface LegacyProviderAuthStateFile {
  version: typeof LEGACY_PROVIDER_AUTH_STATE_VERSION;
  profiles: Record<string, LegacyProviderAuthStateRecord>;
}

interface LoadedProviderContext {
  workspaceRoot: string;
  workspaceId: string;
  env: Record<string, string | undefined>;
  configuredProviders: Record<string, ProviderConfig>;
  catalogProviders: Record<string, ProviderConfig>;
  selectedModel?: string;
}

interface ActiveProviderCatalogState {
  generation: number;
  source: "bundled" | "signed" | "discovery";
  fetchedAt?: string;
  expiresAt?: string;
  stale: boolean;
  catalog: BundledProviderCatalogSnapshot;
}

interface ResolvedStoredCredential {
  connection: StoredProviderConnection;
  state: ProviderConnectionStateFile;
  runtimeCredential: ProviderRuntimeCredential;
}

interface AmbientCredential {
  apiKey: string;
  source: "environment" | "config";
  sourceLabel: string;
}

export type ProviderRuntimeCredential =
  | { kind: "api_key"; value: string }
  | {
      kind: "chatgpt_app_server";
      authRealm: string;
      accountSlot?: string;
    }
  | {
      kind: "bearer";
      value: string;
      authRealm: string;
      expiresAt?: string;
      accountSlot?: string;
      tenant?: string;
    };

export interface ProviderCredentialLease {
  credential: ProviderRuntimeCredential;
  profile: ProviderCredentialProfileSummary;
  connection?: ProviderConnectionSummary;
}

export interface ProviderResolvedModelConnection {
  selection: Extract<ModelSelection, { kind: "configured" }>;
  providerConfig: ProviderConfig;
  lease: ProviderCredentialLease;
}

export interface ProviderAuthManagerOptions {
  env?: Record<string, string | undefined>;
  statePath?: string;
  credentialStore?: ProviderCredentialStore;
  now?: () => Date;
  oauthAttemptTtlMs?: number;
  oauthDrivers?: Iterable<ProviderOAuthDriver>;
  oauthFetch?: typeof fetch;
  chatGptAppServerFactory?: ChatGptAppServerFactory;
  catalogStore?: ProviderCatalogStore;
  catalogPath?: string;
  catalogFetch?: typeof fetch;
  signedCatalogSource?: SignedProviderCatalogSourceLike;
  signedCatalogUrl?: string;
  catalogTrustedKeys?: Readonly<Record<string, string>>;
}

export type ProviderSignedCatalogRefreshStatus =
  | "disabled"
  | "fresh"
  | "busy"
  | "updated"
  | "unchanged"
  | "superseded"
  | "failed";

export interface ProviderAuthContext {
  workspaceRoot: string;
  env?: Record<string, string | undefined>;
  includeProjectConfig?: boolean;
  projection?: ProviderCatalogProjection;
  /** Include stored connections that this workspace can manage but has not granted. */
  connectionVisibility?: "granted" | "managed";
}

export interface ProviderAuthAttemptContext extends ProviderAuthContext {
  principalId: string;
  clientConnectionId: string;
}

export type ProviderAuthAction = "login" | "logout" | "refresh";
export type ProviderConnectionAction =
  | "select"
  | "disconnect"
  | "logout"
  | "remove"
  | "refresh";

/**
 * Host-owned provider connection state. Metadata is non-secret and
 * cross-process locked. Raw credentials live only behind CredentialStore.
 */
export class ProviderAuthManager {
  private readonly env: Record<string, string | undefined>;
  private readonly statePath: string;
  private readonly now: () => Date;
  private readonly oauthAttemptTtlMs: number;
  private readonly oauthDrivers: ReadonlyMap<string, ProviderOAuthDriver>;
  private readonly chatGptAppServerFactory: ChatGptAppServerFactory | undefined;
  private catalogStore: ProviderCatalogStore | undefined;
  private readonly catalogPath: string;
  private readonly catalogFetch: typeof fetch;
  private readonly signedCatalogSource:
    | SignedProviderCatalogSourceLike
    | undefined;
  private readonly catalogTrustedKeys: Readonly<Record<string, string>>;
  private credentialStore: ProviderCredentialStore | undefined;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly oauthAttempts = new Map<string, ProviderOAuthAttempt>();
  private readonly signedCatalogRefreshOwnerId =
    randomBytes(16).toString("hex");
  private signedCatalogRefreshPromise:
    | Promise<ProviderSignedCatalogRefreshStatus>
    | undefined;

  constructor(options: ProviderAuthManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.statePath = options.statePath ?? providerAuthStatePath(this.env);
    this.credentialStore = options.credentialStore;
    this.now = options.now ?? (() => new Date());
    this.oauthAttemptTtlMs =
      options.oauthAttemptTtlMs ?? DEFAULT_OAUTH_ATTEMPT_TTL_MS;
    this.chatGptAppServerFactory = options.chatGptAppServerFactory;
    const drivers = [
      ...createBuiltInProviderOAuthDrivers({
        fetch: options.oauthFetch,
        chatGptAppServerFactory: options.chatGptAppServerFactory,
      }).values(),
      ...(options.oauthDrivers ?? []),
    ];
    this.oauthDrivers = new Map(
      drivers.map((driver) => [driver.implementationId, driver]),
    );
    this.catalogStore = options.catalogStore;
    this.catalogPath =
      options.catalogPath ??
      join(dirname(this.statePath), "provider-catalog.json");
    this.catalogFetch = options.catalogFetch ?? fetch;
    const signedCatalogUrl =
      options.signedCatalogUrl ?? this.env.SPARKWRIGHT_PROVIDER_CATALOG_URL;
    this.signedCatalogSource =
      options.signedCatalogSource ??
      (signedCatalogUrl
        ? createHttpSignedProviderCatalogSource({
            url: signedCatalogUrl,
            fetch: this.catalogFetch,
          })
        : undefined);
    this.catalogTrustedKeys =
      options.catalogTrustedKeys ?? catalogTrustedKeysFromEnv(this.env);
  }

  async catalog(
    context: ProviderAuthContext & { model?: string },
  ): Promise<ProviderCatalogSnapshot> {
    const loaded = await this.loadContext(context, context.model);
    const state = await this.readState();
    const catalogState = await this.activeCatalogState({ loaded, state });
    const selected = loaded.selectedModel
      ? splitSelectedModel(loaded.selectedModel)
      : undefined;
    const catalogProviders = { ...loaded.catalogProviders };
    const providerIds = new Set([
      ...bundledProviderIds(),
      ...Object.keys(catalogProviders),
    ]);
    for (const providerId of providerIds) {
      const connectionId =
        state.selections[selectionKey(loaded.workspaceId, providerId)];
      const connection = connectionId
        ? state.connections[connectionId]
        : undefined;
      if (!connection || connection.binding.providerId !== providerId) continue;
      catalogProviders[providerId] = {
        ...(catalogProviders[providerId] ?? {}),
        baseURL: connection.binding.normalizedEndpoint,
      };
    }
    const registry = createHostProviderRegistry({
      configuredProviders: catalogProviders,
      catalog: catalogState.catalog,
      ...(selected
        ? { requestedModels: { [selected.providerId]: [selected.modelId] } }
        : {}),
    });
    const registryModels = await registry.listModels();
    const modelsByProvider = new Map<string, typeof registryModels>();
    for (const model of registryModels) {
      if (!model.providerId) continue;
      const models = modelsByProvider.get(model.providerId) ?? [];
      models.push(model);
      modelsByProvider.set(model.providerId, models);
    }

    const providers: ProviderCatalogEntry[] = [];
    for (const definition of registry.listProviders()) {
      const providerId = definition.id;
      const config = loaded.configuredProviders[providerId];
      const configured = config !== undefined;
      const npm = providerNpm(providerId, config);
      const binding = this.connectionBinding(providerId, config, loaded.env);
      const connectionMethodBinding = this.explicitConnectionBinding(
        providerId,
        config,
      );
      const profileId = providerCredentialProfileId({
        workspaceRoot: loaded.workspaceRoot,
        providerId,
        npm,
      });
      const persistedProfile = state.profiles[profileId];
      const ambient = availableCredential({
        providerId,
        npm,
        configuredApiKey: config?.apiKey,
        env: loaded.env,
      });
      const suppressed = binding
        ? isSuppressed(state, loaded.workspaceId, binding)
        : false;
      const selectedConnectionId =
        state.selections[selectionKey(loaded.workspaceId, providerId)];
      const stored = selectedConnectionId
        ? state.connections[selectedConnectionId]
        : undefined;
      const storedExpectedBinding = stored
        ? this.storedConnectionBinding(stored, config)
        : undefined;
      const storedApplicable =
        stored !== undefined &&
        storedExpectedBinding !== undefined &&
        sameBinding(stored.binding, storedExpectedBinding) &&
        hasConnectionGrant(state, stored.id, loaded.workspaceId);
      const ambientStatus: ProviderAuthStatus = !ambient
        ? "missing"
        : suppressed || persistedProfile?.state === "logged_out"
          ? "logged_out"
          : "unverified";
      const credential = stored
        ? storedProfileSummary(
            stored,
            storedApplicable ? stored.status : "failed",
          )
        : ambientProfileSummary({
            profileId,
            providerId,
            status: ambientStatus,
            ambient,
            persisted: persistedProfile,
          });
      const connectionSummaries = this.connectionSummaries({
        state,
        providerId,
        workspaceId: loaded.workspaceId,
        config,
        visibility: context.connectionVisibility ?? "granted",
      });
      if (ambient && binding) {
        connectionSummaries.push(
          ambientConnectionSummary({
            id: profileId,
            providerId,
            binding,
            ambient,
            status:
              ambientStatus === "unverified"
                ? "unverified"
                : ambientStatus === "logged_out"
                  ? "suppressed"
                  : "unconfigured",
            selected: !stored,
            generation: persistedProfile?.generation ?? 0,
            updatedAt: persistedProfile?.updatedAt,
          }),
        );
      }
      const connected =
        (stored !== undefined &&
          storedApplicable &&
          isUsableConnectionStatus(stored.status)) ||
        (!stored && ambientStatus === "unverified");
      const models = (modelsByProvider.get(providerId) ?? []).map((model) => ({
        ref: `${providerId}/${model.id}`,
        providerId,
        modelId: model.id,
        selected: `${providerId}/${model.id}` === loaded.selectedModel,
        ...(model.displayName ? { displayName: model.displayName } : {}),
      }));
      const usable = connected && models.length > 0;
      const descriptor = getProviderConnectionDescriptor(providerId);
      const entry: ProviderCatalogEntry = {
        id: providerId,
        npm,
        ...(definition.displayName
          ? { displayName: definition.displayName }
          : {}),
        configured,
        connected,
        available: usable,
        ...(descriptor
          ? {
              authMethods: authMethodSummaries(
                this.availableAuthMethods(
                  descriptor.authMethods,
                  connectionMethodBinding,
                ),
              ),
            }
          : {}),
        connections: connectionSummaries.sort(compareConnections),
        models: models.map((model) => ({ ...model, available: usable })),
        credential,
      };
      if (matchesProjection(entry, context.projection)) providers.push(entry);
    }
    return {
      ...(loaded.selectedModel ? { selectedModel: loaded.selectedModel } : {}),
      catalogVersion: catalogState.catalog.version,
      revision: state.revision,
      catalogState: publicCatalogState(catalogState),
      ...(context.projection ? { projection: context.projection } : {}),
      providers: providers.sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  /**
   * Refresh only the deployment-signed base catalog when it is due. This path
   * never performs credentialed provider discovery, and failures leave the
   * signed last-known-good or bundled snapshot active.
   */
  async refreshSignedCatalogIfDue(): Promise<ProviderSignedCatalogRefreshStatus> {
    if (!this.signedCatalogAutoRefreshEnabled()) return "disabled";
    if (this.signedCatalogRefreshPromise) {
      return await this.signedCatalogRefreshPromise;
    }
    const refresh = this.refreshSignedCatalogWhenDue();
    this.signedCatalogRefreshPromise = refresh;
    try {
      return await refresh;
    } finally {
      if (this.signedCatalogRefreshPromise === refresh) {
        this.signedCatalogRefreshPromise = undefined;
      }
    }
  }

  async refreshCatalog(input: {
    providerId?: string;
    context: ProviderAuthContext;
  }): Promise<
    | { ok: true; result: ProviderCatalogRefreshResult }
    | { ok: false; message: string }
  > {
    const loaded = await this.loadContext(input.context);
    const store = this.getCatalogStore();
    const authState = await this.readState();
    if (enabledEnvironmentFlag(this.env.SPARKWRIGHT_OFFLINE)) {
      const catalogState = await this.activeCatalogState({
        loaded,
        state: authState,
      });
      return {
        ok: true,
        result: {
          status: "unchanged",
          refreshedProviders: [],
          catalogState: publicCatalogState(catalogState),
        },
      };
    }
    const refreshedProviders: string[] = [];
    let publishedAny = false;
    let supersededAny = false;
    let failedAny = false;
    let signedRefreshSucceeded = false;

    if (!input.providerId && this.signedCatalogSource) {
      try {
        const current = await store.current();
        const signed = await this.refreshSignedCatalogFromSource(
          store,
          current,
        );
        signedRefreshSucceeded = true;
        publishedAny ||= signed.published;
        supersededAny ||= signed.superseded;
      } catch {
        failedAny = true;
      }
    }

    const targetIds = input.providerId
      ? [input.providerId]
      : bundledProviderIds().filter(
          (providerId) =>
            getProviderConnectionDescriptor(providerId)?.modelDiscovery !==
            undefined,
        );
    for (const providerId of targetIds) {
      const descriptor = getProviderConnectionDescriptor(providerId);
      if (!descriptor) {
        if (input.providerId) {
          return {
            ok: false,
            message: `Provider "${providerId}" has no code-owned catalog descriptor.`,
          };
        }
        failedAny = true;
        continue;
      }
      if (!descriptor.modelDiscovery) {
        if (input.providerId) {
          return {
            ok: false,
            message: `Provider "${providerId}" does not support authenticated model discovery.`,
          };
        }
        continue;
      }
      const discovered = await this.discoverProviderModels({
        providerId,
        loaded,
      });
      if (!discovered.ok) {
        if (input.providerId) return discovered;
        failedAny = true;
        continue;
      }
      try {
        const current = await store.currentDiscovery({
          scopeKey: discovered.scopeKey,
          providerId,
        });
        const now = this.now();
        const expiresAt = new Date(
          now.getTime() + descriptor.modelDiscovery.ttlMs,
        ).toISOString();
        const published = await store.publishDiscovery({
          expectedGeneration: current?.generation ?? 0,
          scopeKey: discovered.scopeKey,
          providerId,
          fetchedAt: now.toISOString(),
          expiresAt,
          provider: discovered.provider,
        });
        publishedAny ||= published.published;
        supersededAny ||=
          !published.published &&
          published.snapshot.generation !== (current?.generation ?? 0);
        refreshedProviders.push(providerId);
      } catch {
        if (input.providerId) {
          return {
            ok: false,
            message:
              "Authenticated model discovery could not be published; the last-known-good catalog remains active.",
          };
        }
        failedAny = true;
      }
    }

    if (
      failedAny &&
      !publishedAny &&
      !signedRefreshSucceeded &&
      refreshedProviders.length === 0 &&
      Boolean(this.signedCatalogSource || input.providerId)
    ) {
      return {
        ok: false,
        message:
          "Provider catalog refresh failed; the last-known-good catalog remains active.",
      };
    }

    const catalogState = await this.activeCatalogState({
      loaded,
      state: authState,
    });
    return {
      ok: true,
      result: {
        status: publishedAny
          ? "updated"
          : supersededAny
            ? "superseded"
            : "unchanged",
        refreshedProviders,
        catalogState: publicCatalogState(catalogState),
      },
    };
  }

  async authMethods(
    providerId: string,
    context: ProviderAuthContext,
    endpoint?: string,
  ): Promise<
    | { ok: true; methods: ProviderAuthMethodsSnapshot }
    | { ok: false; message: string }
  > {
    const descriptor = getProviderConnectionDescriptor(providerId);
    if (!descriptor) {
      return {
        ok: false,
        message: `Provider "${providerId}" does not expose a built-in connection method.`,
      };
    }
    const loaded = await this.loadContext(context);
    let binding: ProviderConnectionBinding | undefined;
    let configuredBinding: ProviderConnectionBinding | undefined;
    try {
      binding = this.explicitConnectionBinding(
        providerId,
        loaded.configuredProviders[providerId],
        endpoint,
      );
      configuredBinding = this.connectionBinding(
        providerId,
        loaded.configuredProviders[providerId],
        loaded.env,
      );
    } catch (error) {
      return {
        ok: false,
        message: providerEndpointError(error),
      };
    }
    if (!binding) {
      return {
        ok: false,
        message: `Provider "${providerId}" has no endpoint.`,
      };
    }
    return {
      ok: true,
      methods: {
        providerId,
        displayName: descriptor.displayName,
        binding: publicBinding(binding),
        ...(configuredBinding &&
        configuredBinding.driverId === descriptor.driverId &&
        !sameEndpointBinding(configuredBinding, binding)
          ? { configuredBinding: publicBinding(configuredBinding) }
          : {}),
        methods: authMethodSummaries(
          this.availableAuthMethods(descriptor.authMethods, binding),
        ),
      },
    };
  }

  async beginOAuth(input: {
    providerId: string;
    methodId: string;
    promptValues?: Record<string, string>;
    grantScope?: ProviderConnectionGrantScope;
    context: ProviderAuthAttemptContext;
  }): Promise<
    | { ok: true; attempt: ProviderAuthAttemptSummary }
    | { ok: false; message: string }
  > {
    this.cleanupOAuthAttempts();
    const descriptor = getProviderConnectionDescriptor(input.providerId);
    const method = descriptor?.authMethods.find(
      (candidate) => candidate.id === input.methodId,
    );
    if (!descriptor || !method || method.kind !== "oauth") {
      return {
        ok: false,
        message: `Provider "${input.providerId}" does not support OAuth method "${input.methodId}".`,
      };
    }
    const driver = this.oauthDrivers.get(method.implementationId);
    if (!driver) {
      return {
        ok: false,
        message: `OAuth method "${input.methodId}" is unavailable in this Host build.`,
      };
    }
    const promptValues = input.promptValues ?? {};
    const promptError = validateOAuthPromptValues(method, promptValues);
    if (promptError) return { ok: false, message: promptError };
    const loaded = await this.loadContext(input.context);
    const binding = this.connectionBinding(
      input.providerId,
      loaded.configuredProviders[input.providerId],
      loaded.env,
      input.methodId,
      driver.issuer,
    );
    if (
      !binding ||
      binding.driverId !== descriptor.driverId ||
      binding.normalizedEndpoint !==
        normalizeProviderEndpoint(descriptor.officialEndpoint)
    ) {
      return {
        ok: false,
        message:
          "OAuth login is available only for the built-in official endpoint binding.",
      };
    }
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.oauthAttemptTtlMs);
    const attemptId = `oauth_${randomBytes(24).toString("base64url")}`;
    const state = oauthOpaqueValue();
    const codeVerifier = createPkceVerifier();
    let started;
    try {
      started = await driver.begin({
        attemptId,
        state,
        codeChallenge: createPkceChallenge(codeVerifier),
        expiresAt: expiresAt.toISOString(),
        promptValues,
      });
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof ProviderOAuthStartError
            ? error.message
            : "OAuth authorization could not be started.",
      };
    }
    if (started.presentation.flow !== method.flow) {
      await started.cancel?.();
      return {
        ok: false,
        message: "OAuth driver returned an incompatible authorization flow.",
      };
    }
    const attempt: ProviderOAuthAttempt = {
      id: attemptId,
      principalId: input.context.principalId,
      clientConnectionId: input.context.clientConnectionId,
      providerId: input.providerId,
      methodId: input.methodId,
      flow: method.flow,
      driver,
      binding,
      workspaceId: loaded.workspaceId,
      grantScope: input.grantScope ?? "workspace",
      promptValues: { ...promptValues },
      state,
      codeVerifier,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: "pending",
      consuming: false,
      ...(started.presentation.authorizationUrl
        ? { authorizationUrl: started.presentation.authorizationUrl }
        : {}),
      ...(started.presentation.verificationUrl
        ? { verificationUrl: started.presentation.verificationUrl }
        : {}),
      ...(started.presentation.userCode
        ? { userCode: started.presentation.userCode }
        : {}),
      ...(started.presentation.instructions
        ? { instructions: started.presentation.instructions }
        : {}),
      ...(started.cancel ? { cancel: started.cancel } : {}),
    };
    this.oauthAttempts.set(attempt.id, attempt);
    const expirationTimer = setTimeout(() => {
      void this.expireOAuthAttempt(attempt);
    }, this.oauthAttemptTtlMs);
    expirationTimer.unref?.();
    if (started.completion) {
      void started.completion.then(
        (proof) => this.consumeOAuthAttempt(attempt, proof),
        () => this.failOAuthAttempt(attempt, "OAuth authorization failed."),
      );
    }
    return { ok: true, attempt: publicOAuthAttempt(attempt) };
  }

  async oauthStatus(input: {
    attemptId: string;
    context: ProviderAuthAttemptContext;
  }): Promise<
    | { ok: true; attempt: ProviderAuthAttemptSummary }
    | { ok: false; message: string }
  > {
    this.cleanupOAuthAttempts();
    const attempt = this.oauthAttempts.get(input.attemptId);
    if (!attempt || !ownsOAuthAttempt(attempt, input.context)) {
      return { ok: false, message: "OAuth attempt is unavailable." };
    }
    if (isOAuthAttemptExpired(attempt, this.now())) {
      await this.expireOAuthAttempt(attempt);
    }
    return { ok: true, attempt: publicOAuthAttempt(attempt) };
  }

  async completeOAuth(input: {
    attemptId: string;
    proof: ProviderOAuthProof;
    context: ProviderAuthAttemptContext;
  }): Promise<
    | { ok: true; attempt: ProviderAuthAttemptSummary }
    | { ok: false; message: string }
  > {
    this.cleanupOAuthAttempts();
    const attempt = this.oauthAttempts.get(input.attemptId);
    if (!attempt || !ownsOAuthAttempt(attempt, input.context)) {
      return { ok: false, message: "OAuth attempt is unavailable." };
    }
    return await this.consumeOAuthAttempt(attempt, input.proof);
  }

  async cancelOAuth(input: {
    attemptId: string;
    context: ProviderAuthAttemptContext;
  }): Promise<
    | { ok: true; attempt: ProviderAuthAttemptSummary }
    | { ok: false; message: string }
  > {
    this.cleanupOAuthAttempts();
    const attempt = this.oauthAttempts.get(input.attemptId);
    if (!attempt || !ownsOAuthAttempt(attempt, input.context)) {
      return { ok: false, message: "OAuth attempt is unavailable." };
    }
    if (attempt.status !== "pending" || attempt.consuming) {
      return { ok: false, message: "OAuth attempt is already terminal." };
    }
    attempt.status = "cancelled";
    attempt.terminalAt = this.now().getTime();
    clearOAuthAttemptSecrets(attempt);
    await attempt.cancel?.();
    attempt.cancel = undefined;
    return { ok: true, attempt: publicOAuthAttempt(attempt) };
  }

  async cancelOAuthAttemptsForConnection(input: {
    principalId: string;
    clientConnectionId: string;
  }): Promise<void> {
    for (const attempt of this.oauthAttempts.values()) {
      if (attempt.status === "pending" && ownsOAuthAttempt(attempt, input)) {
        attempt.status = "cancelled";
        attempt.terminalAt = this.now().getTime();
        clearOAuthAttemptSecrets(attempt);
        await attempt.cancel?.();
        attempt.cancel = undefined;
      }
    }
  }

  async submitSecret(input: {
    providerId: string;
    methodId: string;
    endpoint?: string;
    secret: string;
    grantScope?: ProviderConnectionGrantScope;
    context: ProviderAuthContext;
  }): Promise<
    | { ok: true; connection: ProviderConnectionSummary; revision: number }
    | { ok: false; message: string }
  > {
    const secretError = validateSecret(input.secret);
    if (secretError) return { ok: false, message: secretError };
    const descriptor = getProviderConnectionDescriptor(input.providerId);
    const method = descriptor?.authMethods.find(
      (candidate) => candidate.id === input.methodId,
    );
    if (!descriptor || !method || method.kind !== "api_key") {
      return {
        ok: false,
        message: `Provider "${input.providerId}" does not support API-key method "${input.methodId}".`,
      };
    }
    const loaded = await this.loadContext(input.context);
    let binding: ProviderConnectionBinding | undefined;
    try {
      binding = this.explicitConnectionBinding(
        input.providerId,
        loaded.configuredProviders[input.providerId],
        input.endpoint,
        input.methodId,
      );
    } catch (error) {
      return { ok: false, message: providerEndpointError(error) };
    }
    if (!binding) {
      return {
        ok: false,
        message: `Provider "${input.providerId}" has no valid endpoint binding.`,
      };
    }
    return await this.persistStoredCredential({
      binding,
      secret: input.secret,
      status: descriptor.validation.kind === "none" ? "unverified" : "ready",
      workspaceId: loaded.workspaceId,
      grantScope: input.grantScope ?? "workspace",
    });
  }

  /**
   * Transaction boundary for an explicit legacy API-key migration. The caller
   * owns atomic config publication: rejecting must mean the original config is
   * still readable. A failed publication removes the newly stored credential
   * and its connection metadata.
   */
  async migrateLegacyApiKey(input: {
    providerId: string;
    methodId?: string;
    secret: string;
    grantScope?: ProviderConnectionGrantScope;
    context: ProviderAuthContext;
    publishConfig: () => Promise<void>;
  }): Promise<
    | { ok: true; connection: ProviderConnectionSummary; revision: number }
    | {
        ok: false;
        message: string;
        recoverableConnectionId?: string;
      }
  > {
    const secretError = validateSecret(input.secret);
    if (secretError) return { ok: false, message: secretError };
    const methodId = input.methodId ?? "api_key";
    const descriptor = getProviderConnectionDescriptor(input.providerId);
    const method = descriptor?.authMethods.find(
      (candidate) => candidate.id === methodId,
    );
    if (!descriptor || !method || method.kind !== "api_key") {
      return {
        ok: false,
        message: `Provider "${input.providerId}" does not support API-key method "${methodId}".`,
      };
    }
    const loaded = await this.loadContext(input.context);
    const binding = this.connectionBinding(
      input.providerId,
      loaded.configuredProviders[input.providerId],
      loaded.env,
      methodId,
    );
    if (!binding) {
      return {
        ok: false,
        message: `Provider "${input.providerId}" has no valid endpoint binding.`,
      };
    }
    const current = await this.readState();
    const selectedId =
      current.selections[selectionKey(loaded.workspaceId, input.providerId)];
    const selected = selectedId ? current.connections[selectedId] : undefined;
    if (
      binding &&
      selected &&
      sameEndpointBinding(selected.binding, binding) &&
      hasConnectionGrant(current, selected.id, loaded.workspaceId) &&
      (await this.getCredentialStore()
        .get(selected.id)
        .catch(() => undefined)) === input.secret
    ) {
      try {
        await input.publishConfig();
        return {
          ok: true,
          connection: storedConnectionSummary({
            connection: selected,
            state: current,
            workspaceId: loaded.workspaceId,
            expectedBinding: binding,
          }),
          revision: current.revision,
        };
      } catch {
        return {
          ok: false,
          message:
            "Legacy config publication failed; the existing stored connection was retained and the original config remains active.",
        };
      }
    }
    const submitted = await this.persistStoredCredential({
      binding,
      secret: input.secret,
      status: descriptor.validation.kind === "none" ? "unverified" : "ready",
      workspaceId: loaded.workspaceId,
      grantScope: input.grantScope ?? "workspace",
    });

    const store = this.getCredentialStore();
    const credentialVerified = await store
      .get(submitted.connection.id)
      .then((storedSecret) => storedSecret === input.secret)
      .catch(() => false);
    if (!credentialVerified) {
      const rolledBack = await this.rollbackStoredConnection(
        submitted.connection.id,
      );
      return {
        ok: false,
        message: rolledBack
          ? "Legacy API-key migration failed credential verification; the new connection was rolled back."
          : "Legacy API-key migration failed credential verification; manual connection cleanup is required.",
        ...(!rolledBack
          ? { recoverableConnectionId: submitted.connection.id }
          : {}),
      };
    }

    try {
      await input.publishConfig();
      return submitted;
    } catch {
      const rolledBack = await this.rollbackStoredConnection(
        submitted.connection.id,
      );
      return {
        ok: false,
        message: rolledBack
          ? "Legacy config publication failed; the new connection was rolled back and the original config remains active."
          : "Legacy config publication failed; the original config remains active and manual connection cleanup is required.",
        ...(!rolledBack
          ? { recoverableConnectionId: submitted.connection.id }
          : {}),
      };
    }
  }

  async manageConnection(input: {
    action: ProviderConnectionAction;
    connectionId: string;
    grantScope?: ProviderConnectionGrantScope;
    context: ProviderAuthContext;
  }): Promise<
    | {
        ok: true;
        connection?: ProviderConnectionSummary;
        connectionId: string;
        revision: number;
      }
    | { ok: false; message: string }
  > {
    const loaded = await this.loadContext(input.context);
    const current = await this.readState();
    const stored = current.connections[input.connectionId];
    if (!stored) {
      return await this.manageAmbientConnection(input, loaded);
    }
    const expectedBinding = this.storedConnectionBinding(
      stored,
      loaded.configuredProviders[stored.binding.providerId],
    );
    if (
      input.action === "select" &&
      (!expectedBinding || !sameBinding(stored.binding, expectedBinding))
    ) {
      return {
        ok: false,
        message:
          "This connection is incompatible with the current provider driver or authentication method.",
      };
    }

    if (input.action === "refresh") {
      const method = getProviderConnectionDescriptor(
        stored.binding.providerId,
      )?.authMethods.find(
        (candidate) => candidate.id === stored.binding.authMethodId,
      );
      if (method?.kind === "oauth") {
        return await this.refreshOAuthConnection({
          stored,
          expectedBinding,
          workspaceId: loaded.workspaceId,
        });
      }
    }

    if (input.action === "logout" || input.action === "remove") {
      const method = getProviderConnectionDescriptor(
        stored.binding.providerId,
      )?.authMethods.find(
        (candidate) => candidate.id === stored.binding.authMethodId,
      );
      const destructiveAction = input.action === "logout" ? "logout" : "remove";
      const remove = () =>
        this.removeStoredCredential(destructiveAction, stored);
      return method?.kind === "oauth"
        ? await withExclusiveFileLock(
            oauthConnectionLockPath(this.statePath, stored.id),
            remove,
            { timeoutMs: 35_000, staleMs: 60_000 },
          )
        : await remove();
    }

    const state = await this.modifyState((state) => {
      const connection = state.connections[stored.id];
      if (!connection) return state;
      if (input.action === "select") {
        const scope = input.grantScope ?? "workspace";
        const grant: ConnectionGrant =
          scope === "user"
            ? { scope, connectionId: stored.id }
            : {
                scope,
                workspaceId: loaded.workspaceId,
                connectionId: stored.id,
              };
        return {
          ...state,
          grants: appendUniqueGrant(state.grants, grant),
          selections: {
            ...state.selections,
            [selectionKey(loaded.workspaceId, stored.binding.providerId)]:
              stored.id,
          },
        };
      }
      if (input.action === "disconnect") {
        return disconnectStoredConnection(state, stored.id, loaded.workspaceId);
      }
      const timestamp = this.now().toISOString();
      return {
        ...state,
        connections: {
          ...state.connections,
          [stored.id]: {
            ...connection,
            status: "unverified",
            generation: connection.generation + 1,
            updatedAt: timestamp,
          },
        },
      };
    });
    this.notify(stored.id);
    const updated = state.connections[stored.id];
    if (!updated) {
      return {
        ok: false,
        message: `Connection "${stored.id}" disappeared.`,
      };
    }
    return {
      ok: true,
      connectionId: stored.id,
      connection: storedConnectionSummary({
        connection: updated,
        state,
        workspaceId: loaded.workspaceId,
        expectedBinding,
      }),
      revision: state.revision,
    };
  }

  async resolveModelConnection(input: {
    workspaceRoot: string;
    modelRef: string;
    env?: Record<string, string | undefined>;
    includeProjectConfig?: boolean;
  }): Promise<
    | { ok: true; resolved: ProviderResolvedModelConnection }
    | { ok: false; message: string }
  > {
    const parsed = splitSelectedModel(input.modelRef);
    if (!parsed) {
      return {
        ok: false,
        message: `Model "${input.modelRef}" must be in the form "provider/model".`,
      };
    }
    const context = await this.loadContext(
      {
        workspaceRoot: input.workspaceRoot,
        env: input.env,
        includeProjectConfig: input.includeProjectConfig,
      },
      input.modelRef,
    );
    const configured = context.configuredProviders[parsed.providerId];
    let selection: ModelSelection;
    let providerConfig: ProviderConfig;
    if (configured) {
      selection = resolveModelSelection(
        { providers: context.configuredProviders },
        input.modelRef,
      );
      providerConfig = configured;
    } else {
      const descriptor = getProviderConnectionDescriptor(parsed.providerId);
      if (!descriptor) {
        return {
          ok: false,
          message: `Unknown provider "${parsed.providerId}" in model "${input.modelRef}".`,
        };
      }
      selection = {
        kind: "configured",
        providerKey: parsed.providerId,
        modelId: parsed.modelId,
        npm: descriptor.npm,
        baseURL: descriptor.officialEndpoint,
      };
      providerConfig = {
        npm: descriptor.npm,
        baseURL: descriptor.officialEndpoint,
      };
    }
    if (selection.kind !== "configured") {
      return {
        ok: false,
        message:
          selection.kind === "error"
            ? selection.message
            : `Model "${input.modelRef}" does not use a provider connection.`,
      };
    }
    const binding = this.connectionBinding(
      parsed.providerId,
      configured,
      context.env,
    );
    if (!binding) {
      return {
        ok: false,
        message: `Provider "${parsed.providerId}" has no valid endpoint binding.`,
      };
    }
    let state = await this.readState();
    const selectedConnectionId =
      state.selections[selectionKey(context.workspaceId, parsed.providerId)];
    if (selectedConnectionId) {
      let connection = state.connections[selectedConnectionId];
      if (!connection) {
        return {
          ok: false,
          message: `Selected provider connection "${selectedConnectionId}" is unavailable; select or create another connection.`,
        };
      }
      let selectedBinding = this.storedConnectionBinding(
        connection,
        configured,
      );
      if (
        !selectedBinding ||
        !sameBinding(connection.binding, selectedBinding)
      ) {
        return {
          ok: false,
          message:
            "The selected provider connection has an incompatible driver or authentication method; no ambient credential fallback was attempted.",
        };
      }
      const credential = await this.resolveStoredCredential({
        stored: connection,
        expectedBinding: selectedBinding,
        workspaceId: context.workspaceId,
      });
      if (!credential.ok) return credential;
      connection = credential.resolved.connection;
      state = credential.resolved.state;
      selectedBinding = canonicalProviderConnectionBinding(connection.binding);
      selection = {
        ...selection,
        baseURL: selectedBinding.normalizedEndpoint,
      };
      providerConfig = {
        ...providerConfig,
        baseURL: selectedBinding.normalizedEndpoint,
      };
      const summary = storedConnectionSummary({
        connection,
        state,
        workspaceId: context.workspaceId,
        expectedBinding: selectedBinding,
      });
      return {
        ok: true,
        resolved: {
          selection,
          providerConfig,
          lease: {
            credential: credential.resolved.runtimeCredential,
            connection: summary,
            profile: storedProfileSummary(connection, connection.status),
          },
        },
      };
    }

    const ambient = availableCredential({
      providerId: parsed.providerId,
      npm: selection.npm,
      configuredApiKey: selection.apiKey,
      env: context.env,
    });
    const profileId = providerCredentialProfileId({
      workspaceRoot: context.workspaceRoot,
      providerId: parsed.providerId,
      npm: selection.npm,
    });
    const profile = state.profiles[profileId];
    if (
      profile?.state === "logged_out" ||
      isSuppressed(state, context.workspaceId, binding)
    ) {
      return {
        ok: false,
        message: `Provider "${parsed.providerId}" ambient credential is disconnected. Connect it explicitly before starting a run.`,
      };
    }
    if (!ambient) {
      const npmInfo = SUPPORTED_PROVIDER_NPMS[selection.npm];
      return {
        ok: false,
        message: npmInfo
          ? `No API key for provider "${parsed.providerId}". Use /connect or sparkwright provider connect ${parsed.providerId}, or set ${npmInfo.apiKeyEnv}.`
          : `Provider "${parsed.providerId}" has no available credential.`,
      };
    }
    return {
      ok: true,
      resolved: {
        selection,
        providerConfig,
        lease: {
          credential: { kind: "api_key", value: ambient.apiKey },
          profile: ambientProfileSummary({
            profileId,
            providerId: parsed.providerId,
            status: "unverified",
            ambient,
            persisted: profile,
          }),
        },
      },
    };
  }

  async resolveCredential(input: {
    workspaceRoot: string;
    selection: Extract<ModelSelection, { kind: "configured" }>;
    env?: Record<string, string | undefined>;
    includeProjectConfig?: boolean;
  }): Promise<
    | { ok: true; lease: ProviderCredentialLease }
    | { ok: false; message: string }
  > {
    const resolved = await this.resolveModelConnection({
      workspaceRoot: input.workspaceRoot,
      modelRef: `${input.selection.providerKey}/${input.selection.modelId}`,
      env: input.env,
      includeProjectConfig: input.includeProjectConfig,
    });
    return resolved.ok
      ? { ok: true, lease: resolved.resolved.lease }
      : resolved;
  }

  async act(
    action: ProviderAuthAction,
    profileId: string,
    context: ProviderAuthContext,
  ): Promise<
    | { ok: true; profile: ProviderCredentialProfileSummary }
    | { ok: false; message: string }
  > {
    const catalog = await this.catalog({ ...context, projection: "all" });
    const provider = catalog.providers.find(
      (entry) => entry.credential.id === profileId,
    );
    if (!provider) {
      return {
        ok: false,
        message: `Unknown credential profile "${profileId}".`,
      };
    }
    if (provider.credential.source === "stored") {
      const result = await this.manageConnection({
        action:
          action === "login"
            ? "select"
            : action === "logout"
              ? "logout"
              : "refresh",
        connectionId: profileId,
        context,
      });
      if (!result.ok) return result;
      const refreshed = await this.catalog({ ...context, projection: "all" });
      const profile = refreshed.providers.find(
        (entry) => entry.id === provider.id,
      )?.credential;
      return profile
        ? { ok: true, profile }
        : { ok: false, message: `Provider "${provider.id}" disappeared.` };
    }
    if (action !== "logout" && provider.credential.status === "missing") {
      return {
        ok: false,
        message: `Provider "${provider.id}" has no configured credential to ${action}.`,
      };
    }
    const loaded = await this.loadContext(context);
    const binding = this.connectionBinding(
      provider.id,
      loaded.configuredProviders[provider.id],
      loaded.env,
    );
    if (!binding) {
      return {
        ok: false,
        message: `Provider "${provider.id}" has no endpoint.`,
      };
    }
    await this.modifyState((state) => {
      const previous = state.profiles[profileId];
      const updated: LegacyProviderAuthStateRecord = {
        providerId: provider.id,
        state: action === "logout" ? "logged_out" : "active",
        generation: (previous?.generation ?? 0) + 1,
        updatedAt: this.now().toISOString(),
      };
      return {
        ...state,
        profiles: { ...state.profiles, [profileId]: updated },
        suppressions:
          action === "logout"
            ? appendUniqueSuppression(state.suppressions, {
                workspaceId: loaded.workspaceId,
                bindingFingerprint: completeBindingFingerprint(binding),
                updatedAt: updated.updatedAt,
              })
            : state.suppressions.filter(
                (entry) =>
                  !suppressionMatchesBinding(
                    entry,
                    loaded.workspaceId,
                    binding,
                  ),
              ),
      };
    });
    this.notify(profileId);
    const refreshed = await this.catalog({ ...context, projection: "all" });
    const profile = refreshed.providers.find(
      (entry) => entry.id === provider.id,
    )?.credential;
    return profile
      ? { ok: true, profile }
      : {
          ok: false,
          message: `Credential profile "${profileId}" disappeared.`,
        };
  }

  async waitForGenerationChange(input: {
    profileId: string;
    generation: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<boolean> {
    if (await this.hasNewerGeneration(input.profileId, input.generation)) {
      return true;
    }
    if (input.signal?.aborted) return false;
    const timeoutMs = input.timeoutMs ?? 300_000;
    return await new Promise<boolean>((resolveWait) => {
      let settled = false;
      const listeners = this.listeners.get(input.profileId) ?? new Set();
      this.listeners.set(input.profileId, listeners);
      const finish = (changed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
        input.signal?.removeEventListener("abort", onAbort);
        listeners.delete(onChange);
        if (listeners.size === 0) this.listeners.delete(input.profileId);
        resolveWait(changed);
      };
      const check = () => {
        void this.hasNewerGeneration(input.profileId, input.generation).then(
          (changed) => {
            if (changed) finish(true);
          },
        );
      };
      const onChange = () => check();
      const onAbort = () => finish(false);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const poll = setInterval(check, REVISION_POLL_MS);
      timeout.unref?.();
      poll.unref?.();
      listeners.add(onChange);
      input.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async manageAmbientConnection(
    input: {
      action: ProviderConnectionAction;
      connectionId: string;
      grantScope?: ProviderConnectionGrantScope;
      context: ProviderAuthContext;
    },
    loaded: LoadedProviderContext,
  ): Promise<
    | {
        ok: true;
        connection?: ProviderConnectionSummary;
        connectionId: string;
        revision: number;
      }
    | { ok: false; message: string }
  > {
    const catalog = await this.catalog({ ...input.context, projection: "all" });
    const provider = catalog.providers.find(
      (entry) => entry.credential.id === input.connectionId,
    );
    if (!provider || provider.credential.source === "stored") {
      return {
        ok: false,
        message: `Unknown provider connection "${input.connectionId}".`,
      };
    }
    const config = loaded.configuredProviders[provider.id];
    const binding = this.connectionBinding(provider.id, config, loaded.env);
    const ambient = availableCredential({
      providerId: provider.id,
      npm: provider.npm,
      configuredApiKey: config?.apiKey,
      env: loaded.env,
    });
    if (!binding || !ambient) {
      return {
        ok: false,
        message: `Ambient provider connection "${input.connectionId}" is unavailable.`,
      };
    }
    const suppress =
      input.action === "disconnect" ||
      input.action === "logout" ||
      input.action === "remove";
    const timestamp = this.now().toISOString();
    const state = await this.modifyState((state) => ({
      ...state,
      profiles: {
        ...state.profiles,
        [input.connectionId]: {
          providerId: provider.id,
          state: suppress ? "logged_out" : "active",
          generation: (state.profiles[input.connectionId]?.generation ?? 0) + 1,
          updatedAt: timestamp,
        },
      },
      suppressions: suppress
        ? appendUniqueSuppression(state.suppressions, {
            workspaceId: loaded.workspaceId,
            bindingFingerprint: completeBindingFingerprint(binding),
            updatedAt: timestamp,
          })
        : state.suppressions.filter(
            (entry) =>
              !suppressionMatchesBinding(entry, loaded.workspaceId, binding),
          ),
    }));
    this.notify(input.connectionId);
    const profile = state.profiles[input.connectionId];
    return {
      ok: true,
      connectionId: input.connectionId,
      revision: state.revision,
      connection: ambientConnectionSummary({
        id: input.connectionId,
        providerId: provider.id,
        binding,
        ambient,
        status: suppress ? "suppressed" : "unverified",
        selected: !suppress,
        generation: profile?.generation ?? 0,
        updatedAt: profile?.updatedAt,
      }),
    };
  }

  private async loadContext(
    context: ProviderAuthContext,
    selectedModel?: string,
  ): Promise<LoadedProviderContext> {
    const env = context.env ?? this.env;
    const workspaceRoot = resolve(context.workspaceRoot);
    const loaded = await loadHostConfig(workspaceRoot, env, {
      projectMode:
        context.includeProjectConfig === false ? "restricted" : "trusted",
    });
    if (loaded.errors.length > 0) {
      throw new Error(
        `Cannot inspect providers while config is invalid: ${loaded.errors[0]!.message}`,
      );
    }
    const configuredProviders = loaded.config.providers ?? {};
    return {
      workspaceRoot,
      workspaceId: await providerWorkspaceId(workspaceRoot),
      env,
      configuredProviders,
      catalogProviders: providerCatalogConfigs(configuredProviders, env),
      selectedModel: selectedModel ?? loaded.config.model,
    };
  }

  private connectionBinding(
    providerId: string,
    config: ProviderConfig | undefined,
    env: Record<string, string | undefined>,
    authMethodId = "api_key",
    authRealm?: string,
    identity: Omit<ProviderConnectionIdentity, "authRealm"> = {},
  ): ProviderConnectionBinding | undefined {
    const descriptor = getProviderConnectionDescriptor(providerId);
    if (!descriptor) return undefined;
    const npm = providerNpm(providerId, config);
    const npmInfo = SUPPORTED_PROVIDER_NPMS[npm];
    const baseUrlEnvironmentNames =
      npm === descriptor.npm
        ? (descriptor.baseUrlEnvironmentVariables ?? [])
        : npmInfo?.baseUrlEnv
          ? [npmInfo.baseUrlEnv]
          : [];
    const environmentBaseURL = baseUrlEnvironmentNames
      .map((name) => nonEmpty(env[name]))
      .find((value) => value !== undefined);
    const endpoint =
      environmentBaseURL ?? config?.baseURL ?? descriptor.officialEndpoint;
    const normalizedEndpoint = normalizeProviderEndpoint(endpoint);
    const driverId =
      npm === descriptor.npm
        ? descriptor.driverId
        : `ai-sdk-custom.${createHash("sha256").update(npm).digest("hex").slice(0, 16)}`;
    const bindingIdentity = {
      ...(authRealm !== undefined ? { authRealm } : {}),
      ...(identity.accountSlot !== undefined
        ? { accountSlot: identity.accountSlot }
        : {}),
      ...(identity.tenant !== undefined ? { tenant: identity.tenant } : {}),
    };
    if (validateProviderConnectionIdentity(bindingIdentity)) return undefined;
    return createProviderConnectionBinding({
      providerId,
      driverId,
      normalizedEndpoint,
      authMethodId,
      ...bindingIdentity,
    });
  }

  private explicitConnectionBinding(
    providerId: string,
    config: ProviderConfig | undefined,
    endpoint?: string,
    authMethodId = "api_key",
  ): ProviderConnectionBinding | undefined {
    const descriptor = getProviderConnectionDescriptor(providerId);
    if (!descriptor) return undefined;
    const npm = providerNpm(providerId, config);
    const driverId =
      npm === descriptor.npm
        ? descriptor.driverId
        : `ai-sdk-custom.${createHash("sha256").update(npm).digest("hex").slice(0, 16)}`;
    return createProviderConnectionBinding({
      providerId,
      driverId,
      normalizedEndpoint: normalizeProviderEndpoint(
        endpoint ?? descriptor.officialEndpoint,
      ),
      authMethodId,
    });
  }

  private storedConnectionBinding(
    connection: StoredProviderConnection,
    config: ProviderConfig | undefined,
  ): ProviderConnectionBinding | undefined {
    const descriptor = getProviderConnectionDescriptor(
      connection.binding.providerId,
    );
    if (!descriptor) return undefined;
    const npm = providerNpm(connection.binding.providerId, config);
    const expectedDriverId =
      npm === descriptor.npm
        ? descriptor.driverId
        : `ai-sdk-custom.${createHash("sha256").update(npm).digest("hex").slice(0, 16)}`;
    const method = descriptor.authMethods.find(
      (candidate) => candidate.id === connection.binding.authMethodId,
    );
    if (!method || connection.binding.driverId !== expectedDriverId) {
      return undefined;
    }
    if (
      method.kind === "oauth" &&
      connection.binding.normalizedEndpoint !==
        normalizeProviderEndpoint(descriptor.officialEndpoint)
    ) {
      return undefined;
    }
    const canonical = canonicalProviderConnectionBinding(connection.binding);
    return validateProviderConnectionIdentity(canonical)
      ? undefined
      : canonical;
  }

  private connectionSummaries(input: {
    state: ProviderConnectionStateFile;
    providerId: string;
    workspaceId: string;
    config: ProviderConfig | undefined;
    visibility: "granted" | "managed";
  }): ProviderConnectionSummary[] {
    return Object.values(input.state.connections)
      .filter(
        (connection) =>
          connection.binding.providerId === input.providerId &&
          (input.visibility === "managed" ||
            hasConnectionGrant(input.state, connection.id, input.workspaceId)),
      )
      .map((connection) =>
        storedConnectionSummary({
          connection,
          state: input.state,
          workspaceId: input.workspaceId,
          expectedBinding: this.storedConnectionBinding(
            connection,
            input.config,
          ),
        }),
      );
  }

  private availableAuthMethods(
    methods: readonly ProviderConnectionAuthMethod[],
    binding: ProviderConnectionBinding | undefined,
  ): ProviderConnectionAuthMethod[] {
    return methods.filter((method) => {
      if (method.kind !== "oauth") return true;
      if (!binding || !this.oauthDrivers.has(method.implementationId)) {
        return false;
      }
      const descriptor = getProviderConnectionDescriptor(binding.providerId);
      return (
        descriptor !== undefined &&
        binding.driverId === descriptor.driverId &&
        binding.normalizedEndpoint ===
          normalizeProviderEndpoint(descriptor.officialEndpoint)
      );
    });
  }

  private async persistStoredCredential(input: {
    binding: ProviderConnectionBinding;
    secret: string;
    status: ProviderConnectionStatus;
    workspaceId: string;
    grantScope: ProviderConnectionGrantScope;
  }): Promise<{
    ok: true;
    connection: ProviderConnectionSummary;
    revision: number;
  }> {
    const connectionId = `connection_${randomBytes(24).toString("base64url")}`;
    const timestamp = this.now().toISOString();
    const connection: StoredProviderConnection = {
      id: connectionId,
      binding: input.binding,
      status: input.status,
      generation: 1,
      oauthRefreshGeneration: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const store = this.getCredentialStore();
    await store.put(connectionId, input.secret);
    let state: ProviderConnectionStateFile;
    try {
      state = await this.modifyState((current) => {
        const grant: ConnectionGrant =
          input.grantScope === "user"
            ? { scope: "user", connectionId }
            : {
                scope: "workspace",
                workspaceId: input.workspaceId,
                connectionId,
              };
        return {
          ...current,
          connections: {
            ...current.connections,
            [connectionId]: connection,
          },
          grants: appendUniqueGrant(current.grants, grant),
          selections: {
            ...current.selections,
            [selectionKey(input.workspaceId, input.binding.providerId)]:
              connectionId,
          },
          suppressions: current.suppressions.filter(
            (entry) =>
              !suppressionMatchesBinding(
                entry,
                input.workspaceId,
                input.binding,
              ),
          ),
        };
      });
    } catch (error) {
      await store.remove(connectionId).catch(() => undefined);
      throw error;
    }
    this.notify(connectionId);
    return {
      ok: true,
      connection: storedConnectionSummary({
        connection,
        state,
        workspaceId: input.workspaceId,
        expectedBinding: input.binding,
      }),
      revision: state.revision,
    };
  }

  private async consumeOAuthAttempt(
    attempt: ProviderOAuthAttempt,
    proof: ProviderOAuthProof,
  ): Promise<
    | { ok: true; attempt: ProviderAuthAttemptSummary }
    | { ok: false; message: string }
  > {
    if (isOAuthAttemptExpired(attempt, this.now())) {
      await this.expireOAuthAttempt(attempt);
      return { ok: false, message: "OAuth attempt has expired." };
    }
    if (attempt.status !== "pending" || attempt.consuming) {
      return { ok: false, message: "OAuth attempt has already been consumed." };
    }
    const proofError = validateOAuthProof(proof);
    if (proofError) return { ok: false, message: proofError };
    if (
      (attempt.flow === "browser" && !proof.state) ||
      (proof.state !== undefined &&
        !sameOpaqueValue(proof.state, attempt.state))
    ) {
      return {
        ok: false,
        message: "OAuth state did not match the active attempt.",
      };
    }
    if (
      attempt.nonce !== undefined &&
      (!proof.nonce || !sameOpaqueValue(proof.nonce, attempt.nonce))
    ) {
      return {
        ok: false,
        message: "OAuth nonce did not match the active attempt.",
      };
    }
    const codeVerifier = attempt.codeVerifier;
    if (!codeVerifier) {
      return {
        ok: false,
        message: "OAuth attempt no longer has completion state.",
      };
    }
    attempt.consuming = true;
    try {
      const credential = await attempt.driver.complete({
        proof,
        codeVerifier,
        promptValues: attempt.promptValues,
      });
      const credentialError = validateOAuthCredential(credential);
      if (credentialError) throw new Error(credentialError);
      const bound = bindOAuthCredentialToConnection(
        attempt.binding,
        credential,
      );
      const persisted = await this.persistStoredCredential({
        binding: bound.binding,
        secret: encodeOAuthCredential(bound.credential),
        status: "unverified",
        workspaceId: attempt.workspaceId,
        grantScope: attempt.grantScope,
      });
      attempt.binding = bound.binding;
      attempt.status = "completed";
      attempt.connection = persisted.connection;
      attempt.terminalAt = this.now().getTime();
      clearOAuthAttemptSecrets(attempt);
      await attempt.cancel?.();
      attempt.cancel = undefined;
      return { ok: true, attempt: publicOAuthAttempt(attempt) };
    } catch {
      await this.failOAuthAttempt(
        attempt,
        "OAuth authorization could not create a provider connection.",
      );
      return { ok: true, attempt: publicOAuthAttempt(attempt) };
    } finally {
      attempt.consuming = false;
    }
  }

  private async failOAuthAttempt(
    attempt: ProviderOAuthAttempt,
    message: string,
  ): Promise<void> {
    if (attempt.status !== "pending") return;
    attempt.status = "failed";
    attempt.message = message;
    attempt.terminalAt = this.now().getTime();
    clearOAuthAttemptSecrets(attempt);
    await Promise.resolve(attempt.cancel?.()).catch(() => undefined);
    attempt.cancel = undefined;
  }

  private async expireOAuthAttempt(
    attempt: ProviderOAuthAttempt,
  ): Promise<void> {
    if (attempt.status !== "pending" || attempt.consuming) return;
    attempt.status = "expired";
    attempt.terminalAt = this.now().getTime();
    clearOAuthAttemptSecrets(attempt);
    await Promise.resolve(attempt.cancel?.()).catch(() => undefined);
    attempt.cancel = undefined;
  }

  private cleanupOAuthAttempts(): void {
    const now = this.now();
    for (const [attemptId, attempt] of this.oauthAttempts) {
      if (isOAuthAttemptExpired(attempt, now)) {
        void this.expireOAuthAttempt(attempt);
      }
      if (
        attempt.terminalAt !== undefined &&
        now.getTime() - attempt.terminalAt > OAUTH_TERMINAL_RETENTION_MS
      ) {
        this.oauthAttempts.delete(attemptId);
      }
    }
  }

  private async refreshOAuthConnection(input: {
    stored: StoredProviderConnection;
    expectedBinding: ProviderConnectionBinding | undefined;
    workspaceId: string;
  }): Promise<
    | {
        ok: true;
        connection: ProviderConnectionSummary;
        connectionId: string;
        revision: number;
      }
    | { ok: false; message: string }
  > {
    const initialRefreshGeneration = input.stored.oauthRefreshGeneration ?? 0;
    return await withExclusiveFileLock(
      oauthConnectionLockPath(this.statePath, input.stored.id),
      async () => {
        const current = await this.readState();
        const stored = current.connections[input.stored.id];
        if (!stored) {
          return {
            ok: false as const,
            message: `Connection "${input.stored.id}" disappeared.`,
          };
        }
        if ((stored.oauthRefreshGeneration ?? 0) > initialRefreshGeneration) {
          if (
            stored.oauthRefreshOutcome === "succeeded" &&
            isUsableConnectionStatus(stored.status)
          ) {
            const encoded = await this.getCredentialStore().get(stored.id);
            const credential = encoded
              ? decodeOAuthCredential(encoded)
              : undefined;
            let bindingMatches = false;
            try {
              bindingMatches =
                credential !== undefined &&
                sameBinding(
                  stored.binding,
                  bindOAuthCredentialToConnection(stored.binding, credential)
                    .binding,
                );
            } catch {
              bindingMatches = false;
            }
            if (
              !credential ||
              !bindingMatches ||
              shouldRefreshOAuthCredential(credential, this.now())
            ) {
              return {
                ok: false as const,
                message:
                  "OAuth refresh in another Host did not publish a usable credential; no ambient credential was used.",
              };
            }
            return {
              ok: true as const,
              connectionId: stored.id,
              connection: storedConnectionSummary({
                connection: stored,
                state: current,
                workspaceId: input.workspaceId,
                expectedBinding: input.expectedBinding,
              }),
              revision: current.revision,
            };
          }
          return {
            ok: false as const,
            message:
              "OAuth refresh failed in another Host; the selected connection needs refresh and no ambient credential was used.",
          };
        }
        const method = getProviderConnectionDescriptor(
          stored.binding.providerId,
        )?.authMethods.find(
          (candidate) => candidate.id === stored.binding.authMethodId,
        );
        const driver =
          method?.kind === "oauth"
            ? this.oauthDrivers.get(method.implementationId)
            : undefined;
        const store = this.getCredentialStore();
        const encoded = await store.get(stored.id);
        const credential = encoded ? decodeOAuthCredential(encoded) : undefined;
        if (!driver?.refresh || !encoded || !credential) {
          await this.markOAuthRefreshFailed(stored.id);
          return {
            ok: false as const,
            message:
              "OAuth connection cannot be refreshed and was marked needs_refresh.",
          };
        }
        try {
          const currentBound = bindOAuthCredentialToConnection(
            stored.binding,
            credential,
          );
          const refreshed = await driver.refresh({
            credential: currentBound.credential,
          });
          const credentialError = validateOAuthCredential(refreshed);
          if (credentialError) throw new Error(credentialError);
          if (shouldRefreshOAuthCredential(refreshed, this.now())) {
            throw new Error(
              "OAuth refresh returned a credential inside the expiry safety window.",
            );
          }
          const refreshedBound = bindOAuthCredentialToConnection(
            currentBound.binding,
            refreshed,
          );
          await store.put(
            stored.id,
            encodeOAuthCredential(refreshedBound.credential),
          );
          let state: ProviderConnectionStateFile;
          try {
            state = await this.modifyState((latest) => {
              const connection = latest.connections[stored.id];
              if (!connection || connection.generation !== stored.generation) {
                return latest;
              }
              return {
                ...latest,
                connections: {
                  ...latest.connections,
                  [stored.id]: {
                    ...connection,
                    binding: refreshedBound.binding,
                    status: "unverified",
                    generation: connection.generation + 1,
                    oauthRefreshGeneration:
                      (connection.oauthRefreshGeneration ?? 0) + 1,
                    oauthRefreshOutcome: "succeeded",
                    updatedAt: this.now().toISOString(),
                  },
                },
              };
            });
          } catch (error) {
            await store.put(stored.id, encoded).catch(() => undefined);
            throw error;
          }
          const updated = state.connections[stored.id];
          if (
            !updated ||
            updated.generation !== stored.generation + 1 ||
            updated.oauthRefreshGeneration !==
              (stored.oauthRefreshGeneration ?? 0) + 1 ||
            updated.oauthRefreshOutcome !== "succeeded" ||
            !sameBinding(updated.binding, refreshedBound.binding)
          ) {
            await store.put(stored.id, encoded).catch(() => undefined);
            throw new Error("OAuth connection changed during refresh.");
          }
          this.notify(stored.id);
          return {
            ok: true as const,
            connectionId: stored.id,
            connection: storedConnectionSummary({
              connection: updated,
              state,
              workspaceId: input.workspaceId,
              expectedBinding: input.expectedBinding,
            }),
            revision: state.revision,
          };
        } catch {
          await this.markOAuthRefreshFailed(stored.id);
          return {
            ok: false as const,
            message:
              "OAuth refresh failed; the selected connection was marked needs_refresh and no ambient credential was used.",
          };
        }
      },
      { timeoutMs: 35_000, staleMs: 60_000 },
    );
  }

  private async reconcileOAuthConnectionIdentity(input: {
    stored: StoredProviderConnection;
  }): Promise<
    | {
        ok: true;
        connection: StoredProviderConnection;
        state: ProviderConnectionStateFile;
        secret: string;
        credential: ProviderOAuthCredential;
      }
    | { ok: false; message: string }
  > {
    return await withExclusiveFileLock(
      oauthConnectionLockPath(this.statePath, input.stored.id),
      async () => {
        const state = await this.readState();
        const connection = state.connections[input.stored.id];
        const store = this.getCredentialStore();
        const encoded = connection ? await store.get(connection.id) : undefined;
        const credential = encoded ? decodeOAuthCredential(encoded) : undefined;
        if (!connection || !encoded || !credential) {
          return {
            ok: false as const,
            message:
              "OAuth account binding could not be reconciled; no ambient credential fallback was attempted.",
          };
        }
        let bound: ReturnType<typeof bindOAuthCredentialToConnection>;
        try {
          bound = bindOAuthCredentialToConnection(
            connection.binding,
            credential,
          );
        } catch {
          await this.markOAuthRefreshFailed(connection.id);
          return {
            ok: false as const,
            message:
              "OAuth account binding changed unexpectedly; the connection was marked needs_refresh and no ambient credential was used.",
          };
        }
        if (sameBinding(connection.binding, bound.binding)) {
          return {
            ok: true as const,
            connection,
            state,
            secret: encoded,
            credential,
          };
        }
        const nextEncoded = encodeOAuthCredential(bound.credential);
        await store.put(connection.id, nextEncoded);
        let updatedState: ProviderConnectionStateFile;
        try {
          updatedState = await this.modifyState((latest) => {
            const latestConnection = latest.connections[connection.id];
            if (
              !latestConnection ||
              latestConnection.generation !== connection.generation
            ) {
              return latest;
            }
            return {
              ...latest,
              connections: {
                ...latest.connections,
                [connection.id]: {
                  ...latestConnection,
                  binding: bound.binding,
                  generation: latestConnection.generation + 1,
                  updatedAt: this.now().toISOString(),
                },
              },
            };
          });
        } catch (error) {
          await store.put(connection.id, encoded).catch(() => undefined);
          throw error;
        }
        const updated = updatedState.connections[connection.id];
        if (
          !updated ||
          updated.generation !== connection.generation + 1 ||
          !sameBinding(updated.binding, bound.binding)
        ) {
          await store.put(connection.id, encoded).catch(() => undefined);
          return {
            ok: false as const,
            message:
              "OAuth account binding changed during migration; no ambient credential fallback was attempted.",
          };
        }
        this.notify(connection.id);
        return {
          ok: true as const,
          connection: updated,
          state: updatedState,
          secret: nextEncoded,
          credential: bound.credential,
        };
      },
      { timeoutMs: 35_000, staleMs: 60_000 },
    );
  }

  private async markOAuthRefreshFailed(connectionId: string): Promise<void> {
    const state = await this.modifyState((current) => {
      const connection = current.connections[connectionId];
      if (!connection) return current;
      return {
        ...current,
        connections: {
          ...current.connections,
          [connectionId]: {
            ...connection,
            status: "needs_refresh",
            generation: connection.generation + 1,
            oauthRefreshGeneration:
              (connection.oauthRefreshGeneration ?? 0) + 1,
            oauthRefreshOutcome: "failed",
            updatedAt: this.now().toISOString(),
          },
        },
      };
    });
    if (state.connections[connectionId]) this.notify(connectionId);
  }

  private async removeStoredCredential(
    action: "logout" | "remove",
    stored: StoredProviderConnection,
  ): Promise<{
    ok: true;
    connectionId: string;
    revision: number;
  }> {
    const latest = (await this.readState()).connections[stored.id];
    if (!latest) {
      return {
        ok: true,
        connectionId: stored.id,
        revision: (await this.readState()).revision,
      };
    }
    const store = this.getCredentialStore();
    const secret = await store.get(stored.id);
    if (action === "logout" && secret) {
      const credential = decodeOAuthCredential(secret);
      const method = getProviderConnectionDescriptor(
        latest.binding.providerId,
      )?.authMethods.find(
        (candidate) => candidate.id === latest.binding.authMethodId,
      );
      const driver =
        method?.kind === "oauth"
          ? this.oauthDrivers.get(method.implementationId)
          : undefined;
      if (credential && driver?.revoke) {
        await driver.revoke({ credential }).catch(() => undefined);
      }
    }
    await store.remove(stored.id);
    try {
      const state = await this.modifyState((state) =>
        removeStoredConnection(state, stored.id),
      );
      this.notify(stored.id);
      return {
        ok: true,
        connectionId: stored.id,
        revision: state.revision,
      };
    } catch (error) {
      if (secret !== undefined) {
        await store.put(stored.id, secret).catch(() => undefined);
      }
      throw error;
    }
  }

  private async resolveStoredCredential(input: {
    stored: StoredProviderConnection;
    expectedBinding: ProviderConnectionBinding;
    workspaceId: string;
  }): Promise<
    | { ok: true; resolved: ResolvedStoredCredential }
    | { ok: false; message: string }
  > {
    let state = await this.readState();
    let connection = state.connections[input.stored.id];
    if (!connection) {
      return {
        ok: false,
        message: `Selected provider connection "${input.stored.id}" is unavailable; no ambient credential fallback was attempted.`,
      };
    }
    if (!sameBinding(connection.binding, input.expectedBinding)) {
      return {
        ok: false,
        message:
          "The selected provider connection is bound to a different endpoint; no ambient credential fallback was attempted.",
      };
    }
    if (!hasConnectionGrant(state, connection.id, input.workspaceId)) {
      return {
        ok: false,
        message:
          "The selected provider connection is not granted to this workspace; no ambient credential fallback was attempted.",
      };
    }
    if (!isUsableConnectionStatus(connection.status)) {
      return {
        ok: false,
        message: `Selected provider connection "${connection.id}" is ${connection.status}; no ambient credential fallback was attempted.`,
      };
    }
    const store = this.getCredentialStore();
    let secret = await store.get(connection.id);
    if (!secret) {
      return {
        ok: false,
        message: `Selected provider connection "${connection.id}" has no stored credential; no ambient credential fallback was attempted.`,
      };
    }
    let oauthCredential = decodeOAuthCredential(secret);
    if (secret.startsWith(OAUTH_CREDENTIAL_PREFIX) && !oauthCredential) {
      return {
        ok: false,
        message: `Selected provider connection "${connection.id}" contains an invalid OAuth credential; no ambient credential fallback was attempted.`,
      };
    }
    if (oauthCredential) {
      let preview:
        | ReturnType<typeof bindOAuthCredentialToConnection>
        | undefined;
      try {
        preview = bindOAuthCredentialToConnection(
          connection.binding,
          oauthCredential,
        );
      } catch {
        // Re-read under the per-connection lock before treating an apparent
        // identity mismatch as durable state.
      }
      if (!preview || !sameBinding(connection.binding, preview.binding)) {
        const reconciled = await this.reconcileOAuthConnectionIdentity({
          stored: connection,
        });
        if (!reconciled.ok) return reconciled;
        state = reconciled.state;
        connection = reconciled.connection;
        secret = reconciled.secret;
        oauthCredential = reconciled.credential;
      }
    }
    if (
      oauthCredential &&
      shouldRefreshOAuthCredential(oauthCredential, this.now())
    ) {
      const refreshed = await this.refreshOAuthConnection({
        stored: connection,
        expectedBinding: connection.binding,
        workspaceId: input.workspaceId,
      });
      if (!refreshed.ok) return refreshed;
      state = await this.readState();
      const refreshedConnection = state.connections[connection.id];
      if (
        !refreshedConnection ||
        !hasConnectionGrant(state, refreshedConnection.id, input.workspaceId) ||
        !isUsableConnectionStatus(refreshedConnection.status)
      ) {
        return {
          ok: false,
          message: `Selected provider connection "${connection.id}" could not be resolved after OAuth refresh; no ambient credential fallback was attempted.`,
        };
      }
      connection = refreshedConnection;
      secret = (await store.get(connection.id)) ?? "";
      oauthCredential = secret ? decodeOAuthCredential(secret) : undefined;
      if (!secret || !oauthCredential) {
        return {
          ok: false,
          message: `Selected provider connection "${connection.id}" has no valid OAuth credential after refresh; no ambient credential fallback was attempted.`,
        };
      }
    }
    const expected = canonicalProviderConnectionBinding(connection.binding);
    if (!sameBinding(connection.binding, expected)) {
      return {
        ok: false,
        message: `Selected provider connection "${connection.id}" has an invalid binding; no ambient credential fallback was attempted.`,
      };
    }
    const runtimeCredential = providerRuntimeCredential({
      secret,
      oauthCredential,
      binding: connection.binding,
    });
    if (!runtimeCredential.ok) return runtimeCredential;
    return {
      ok: true,
      resolved: {
        connection,
        state,
        runtimeCredential: runtimeCredential.credential,
      },
    };
  }

  private async discoverProviderModels(input: {
    providerId: string;
    loaded: LoadedProviderContext;
  }): Promise<
    | {
        ok: true;
        provider: BundledProviderCatalogEntry;
        scopeKey: string;
      }
    | { ok: false; message: string }
  > {
    const descriptor = getProviderConnectionDescriptor(input.providerId);
    const discovery = descriptor?.modelDiscovery;
    if (!descriptor || !discovery) {
      return {
        ok: false,
        message: `Provider "${input.providerId}" does not support authenticated model discovery.`,
      };
    }
    const configured = input.loaded.configuredProviders[input.providerId];
    const binding = this.connectionBinding(
      input.providerId,
      configured,
      input.loaded.env,
    );
    if (
      !binding ||
      binding.driverId !== descriptor.driverId ||
      binding.normalizedEndpoint !==
        normalizeProviderEndpoint(descriptor.officialEndpoint)
    ) {
      return {
        ok: false,
        message:
          "Authenticated model discovery is available only for the built-in official endpoint binding.",
      };
    }

    const state = await this.readState();
    const selectedId =
      state.selections[
        selectionKey(input.loaded.workspaceId, input.providerId)
      ];
    if (discovery.kind === "chatgpt_app_server") {
      if (!selectedId) {
        return {
          ok: false,
          message:
            "ChatGPT needs an active browser or device-code connection before model discovery.",
        };
      }
      const connection = state.connections[selectedId];
      if (
        !connection ||
        !sameEndpointBinding(connection.binding, binding) ||
        !hasConnectionGrant(state, connection.id, input.loaded.workspaceId) ||
        !isUsableConnectionStatus(connection.status)
      ) {
        return {
          ok: false,
          message:
            "The selected ChatGPT connection cannot be used for model discovery.",
        };
      }
      const expectedBinding = this.connectionBinding(
        input.providerId,
        configured,
        input.loaded.env,
        connection.binding.authMethodId,
        connection.binding.authRealm,
      );
      if (!expectedBinding) {
        return {
          ok: false,
          message: "The selected ChatGPT connection has no valid binding.",
        };
      }
      const resolved = await this.resolveStoredCredential({
        stored: connection,
        expectedBinding,
        workspaceId: input.loaded.workspaceId,
      });
      if (!resolved.ok) return resolved;
      if (resolved.resolved.runtimeCredential.kind !== "chatgpt_app_server") {
        return {
          ok: false,
          message:
            "The selected connection is not backed by the ChatGPT runtime.",
        };
      }
      try {
        const models = await listChatGptModels(this.chatGptAppServerFactory);
        return {
          ok: true,
          scopeKey: providerDiscoveryScopeKey({
            workspaceId: input.loaded.workspaceId,
            providerId: input.providerId,
            credentialScope: `connection:${connection.id}`,
          }),
          provider: {
            id: input.providerId,
            displayName: descriptor.displayName,
            models: models.map((model) => ({
              id: model.id,
              displayName: model.displayName,
              ...(model.description ? { description: model.description } : {}),
              ...(model.inputModalities
                ? {
                    inputModalities: model.inputModalities.filter(
                      isProviderModelModality,
                    ),
                  }
                : {}),
              capabilities: {
                completion: true,
                toolCalling: true,
                vision: model.inputModalities?.includes("image") === true,
              },
            })),
          },
        };
      } catch {
        return {
          ok: false,
          message:
            "ChatGPT model discovery failed. Reconnect the account and try again.",
        };
      }
    }
    let apiKey: string | undefined;
    let credentialScope: string | undefined;
    if (selectedId) {
      const connection = state.connections[selectedId];
      if (
        !connection ||
        !sameEndpointBinding(connection.binding, binding) ||
        !hasConnectionGrant(state, connection.id, input.loaded.workspaceId) ||
        !isUsableConnectionStatus(connection.status)
      ) {
        return {
          ok: false,
          message:
            "The selected provider connection cannot be used for catalog discovery.",
        };
      }
      const expectedBinding = this.connectionBinding(
        input.providerId,
        configured,
        input.loaded.env,
        connection.binding.authMethodId,
        connection.binding.authRealm,
        {
          accountSlot: connection.binding.accountSlot,
          tenant: connection.binding.tenant,
        },
      );
      if (!expectedBinding) {
        return {
          ok: false,
          message:
            "The selected provider connection has no valid catalog binding.",
        };
      }
      const resolved = await this.resolveStoredCredential({
        stored: connection,
        expectedBinding,
        workspaceId: input.loaded.workspaceId,
      });
      if (!resolved.ok) return resolved;
      if (!("value" in resolved.resolved.runtimeCredential)) {
        return {
          ok: false,
          message:
            "The selected provider connection does not expose an HTTP credential.",
        };
      }
      apiKey = resolved.resolved.runtimeCredential.value;
      credentialScope = `connection:${connection.id}`;
    } else {
      const npm = providerNpm(input.providerId, configured);
      const ambient = availableCredential({
        providerId: input.providerId,
        npm,
        configuredApiKey: configured?.apiKey,
        env: input.loaded.env,
      });
      if (ambient && !isSuppressed(state, input.loaded.workspaceId, binding)) {
        apiKey = ambient.apiKey;
        credentialScope = `ambient:${binding.bindingFingerprint ?? binding.endpointFingerprint}`;
      }
    }
    if (!apiKey || !credentialScope) {
      return {
        ok: false,
        message: `Provider "${input.providerId}" needs an active connection before catalog discovery.`,
      };
    }

    const endpoint = new URL(
      discovery.path,
      `${descriptor.officialEndpoint.replace(/\/+$/, "")}/`,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.catalogFetch(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      return {
        ok: false,
        message:
          "Authenticated model discovery failed; the last-known-good catalog remains active.",
      };
    } finally {
      clearTimeout(timer);
      apiKey = undefined;
    }
    if (!response.ok) {
      return {
        ok: false,
        message:
          "Authenticated model discovery was rejected; the last-known-good catalog remains active.",
      };
    }
    let text: string;
    try {
      text = await readBoundedResponseText(response, 16 * 1024 * 1024);
    } catch {
      return {
        ok: false,
        message:
          "Authenticated model discovery returned an unreadable response; the last-known-good catalog remains active.",
      };
    }
    try {
      return {
        ok: true,
        scopeKey: providerDiscoveryScopeKey({
          workspaceId: input.loaded.workspaceId,
          providerId: input.providerId,
          credentialScope,
        }),
        provider: {
          id: input.providerId,
          displayName: descriptor.displayName,
          models: parseOpenAICompatibleModelList(text, input.providerId),
        },
      };
    } catch {
      return {
        ok: false,
        message:
          "Authenticated model discovery returned invalid metadata; the last-known-good catalog remains active.",
      };
    }
  }

  private async activeCatalogState(input: {
    loaded: LoadedProviderContext;
    state: ProviderConnectionStateFile;
  }): Promise<ActiveProviderCatalogState> {
    const store = this.getCatalogStore();
    const base = await store.current();
    const overlays: ProviderDiscoveryStateSnapshot[] = [];
    let catalog = base.catalog;

    for (const providerId of bundledProviderIds()) {
      const scopeKey = this.activeDiscoveryScopeKey({
        providerId,
        loaded: input.loaded,
        state: input.state,
      });
      if (!scopeKey) continue;
      const overlay = await store.currentDiscovery({ scopeKey, providerId });
      if (!overlay) continue;
      overlays.push(overlay);
      catalog = mergeProviderCatalogSnapshots({
        base: catalog,
        providers: [overlay.provider],
      });
    }

    if (overlays.length === 0) return base;
    const fetchedAt = latestTimestamp([
      base.fetchedAt,
      ...overlays.map((overlay) => overlay.fetchedAt),
    ]);
    const expiresAt = earliestTimestamp([
      base.expiresAt,
      ...overlays.map((overlay) => overlay.expiresAt),
    ]);
    return {
      generation: Math.max(
        base.generation,
        ...overlays.map((overlay) => overlay.generation),
      ),
      source: "discovery",
      ...(fetchedAt ? { fetchedAt } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      stale: base.stale || overlays.some((overlay) => overlay.stale),
      catalog,
    };
  }

  private activeDiscoveryScopeKey(input: {
    providerId: string;
    loaded: LoadedProviderContext;
    state: ProviderConnectionStateFile;
  }): string | undefined {
    const descriptor = getProviderConnectionDescriptor(input.providerId);
    if (!descriptor?.modelDiscovery) return undefined;
    const configured = input.loaded.configuredProviders[input.providerId];
    const binding = this.connectionBinding(
      input.providerId,
      configured,
      input.loaded.env,
    );
    if (
      !binding ||
      binding.driverId !== descriptor.driverId ||
      binding.normalizedEndpoint !==
        normalizeProviderEndpoint(descriptor.officialEndpoint)
    ) {
      return undefined;
    }
    const selectedId =
      input.state.selections[
        selectionKey(input.loaded.workspaceId, input.providerId)
      ];
    if (selectedId) {
      const connection = input.state.connections[selectedId];
      if (
        !connection ||
        !sameEndpointBinding(connection.binding, binding) ||
        !hasConnectionGrant(
          input.state,
          connection.id,
          input.loaded.workspaceId,
        ) ||
        !isUsableConnectionStatus(connection.status)
      ) {
        return undefined;
      }
      return providerDiscoveryScopeKey({
        workspaceId: input.loaded.workspaceId,
        providerId: input.providerId,
        credentialScope: `connection:${connection.id}`,
      });
    }
    if (descriptor.modelDiscovery.kind === "chatgpt_app_server") {
      return undefined;
    }
    const ambient = availableCredential({
      providerId: input.providerId,
      npm: providerNpm(input.providerId, configured),
      configuredApiKey: configured?.apiKey,
      env: input.loaded.env,
    });
    if (
      !ambient ||
      isSuppressed(input.state, input.loaded.workspaceId, binding)
    ) {
      return undefined;
    }
    return providerDiscoveryScopeKey({
      workspaceId: input.loaded.workspaceId,
      providerId: input.providerId,
      credentialScope: `ambient:${binding.bindingFingerprint ?? binding.endpointFingerprint}`,
    });
  }

  private getCatalogStore(): ProviderCatalogStore {
    this.catalogStore ??= new ProviderCatalogStore({
      env: this.env,
      path: this.catalogPath,
      now: this.now,
    });
    return this.catalogStore;
  }

  private signedCatalogAutoRefreshEnabled(): boolean {
    if (
      !this.signedCatalogSource ||
      Object.keys(this.catalogTrustedKeys).length === 0 ||
      enabledEnvironmentFlag(this.env.SPARKWRIGHT_OFFLINE)
    ) {
      return false;
    }
    const configured =
      this.env.SPARKWRIGHT_PROVIDER_CATALOG_AUTO_REFRESH?.trim().toLowerCase();
    return !configured || !["0", "false", "no", "off"].includes(configured);
  }

  private async refreshSignedCatalogWhenDue(): Promise<ProviderSignedCatalogRefreshStatus> {
    if (!this.signedCatalogSource) return "disabled";
    const store = this.getCatalogStore();
    const current = await store.current();
    if (!signedCatalogRefreshDue(current, this.now())) return "fresh";
    const claimed = await store.claimRefreshLease({
      ownerId: this.signedCatalogRefreshOwnerId,
      ttlMs: SIGNED_CATALOG_REFRESH_LEASE_TTL_MS,
    });
    if (!claimed) return "busy";
    try {
      const latest = await store.current();
      if (!signedCatalogRefreshDue(latest, this.now())) return "fresh";
      try {
        const result = await this.refreshSignedCatalogFromSource(store, latest);
        return result.published
          ? "updated"
          : result.superseded
            ? "superseded"
            : "unchanged";
      } catch {
        return "failed";
      }
    } finally {
      await store.releaseRefreshLease(this.signedCatalogRefreshOwnerId);
    }
  }

  private async refreshSignedCatalogFromSource(
    store: ProviderCatalogStore,
    current: Awaited<ReturnType<ProviderCatalogStore["current"]>>,
  ): Promise<{ published: boolean; superseded: boolean }> {
    if (!this.signedCatalogSource) {
      return { published: false, superseded: false };
    }
    const fetched = await readSignedProviderCatalogSource(
      this.signedCatalogSource,
      { ...(current.etag ? { etag: current.etag } : {}) },
    );
    if (fetched.status === "not_modified") {
      return { published: false, superseded: false };
    }
    const verified = verifySignedProviderCatalogArtifact({
      artifact: fetched.artifact,
      trustedKeys: this.catalogTrustedKeys,
      now: this.now(),
    });
    const published = await store.publish({
      expectedGeneration: current.generation,
      source: "signed",
      fetchedAt: this.now().toISOString(),
      expiresAt: verified.expiresAt,
      catalog: verified.catalog,
      ...(verified.sourceRevision
        ? { sourceRevision: verified.sourceRevision }
        : {}),
      ...(fetched.etag ? { etag: fetched.etag } : {}),
    });
    return {
      published: published.published,
      superseded:
        !published.published &&
        published.snapshot.generation !== current.generation,
    };
  }

  private getCredentialStore(): ProviderCredentialStore {
    this.credentialStore ??= createProviderCredentialStore({
      env: this.env,
    });
    return this.credentialStore;
  }

  private async rollbackStoredConnection(
    connectionId: string,
  ): Promise<boolean> {
    const store = this.getCredentialStore();
    try {
      await store.remove(connectionId);
      await this.modifyState((state) =>
        removeStoredConnection(state, connectionId),
      );
      this.notify(connectionId);
      return true;
    } catch {
      return false;
    }
  }

  private async hasNewerGeneration(
    profileId: string,
    generation: number,
  ): Promise<boolean> {
    const state = await this.readState();
    return (
      (state.connections[profileId]?.generation ??
        state.profiles[profileId]?.generation ??
        0) > generation
    );
  }

  private notify(profileId: string): void {
    for (const listener of this.listeners.get(profileId) ?? []) listener();
  }

  private async modifyState(
    update: (state: ProviderConnectionStateFile) => ProviderConnectionStateFile,
  ): Promise<ProviderConnectionStateFile> {
    return await withExclusiveFileLock(`${this.statePath}.lock`, async () => {
      const current = await this.readState();
      const updated = update(current);
      const next: ProviderConnectionStateFile = {
        ...updated,
        version: PROVIDER_CONNECTION_STATE_VERSION,
        revision: current.revision + 1,
      };
      if (current.revision > 0) {
        await atomicWriteText(
          `${this.statePath}.bak`,
          `${JSON.stringify(current, null, 2)}\n`,
          { mode: 0o600, durable: true },
        );
      }
      await atomicWriteText(
        this.statePath,
        `${JSON.stringify(next, null, 2)}\n`,
        { mode: 0o600, durable: true },
      );
      return next;
    });
  }

  private async readState(): Promise<ProviderConnectionStateFile> {
    const primary = await readStateFile(this.statePath);
    if (primary.status === "valid") return primary.state;
    if (primary.status === "missing") return emptyProviderConnectionState();
    const backup = await readStateFile(`${this.statePath}.bak`);
    if (backup.status === "valid") return backup.state;
    throw new Error(
      `Invalid provider connection state at ${this.statePath}; restore or remove the corrupt state file before continuing.`,
    );
  }
}

export function providerAuthStatePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const stateBase =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(stateBase, "sparkwright", "provider-auth.json");
}

function publicCatalogState(state: ActiveProviderCatalogState) {
  return {
    generation: state.generation,
    source: state.source,
    stale: state.stale,
    ...(state.fetchedAt ? { fetchedAt: state.fetchedAt } : {}),
    ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}),
  };
}

function signedCatalogRefreshDue(
  state: ProviderCatalogStateSnapshot,
  now: Date,
): boolean {
  if (state.source === "bundled" || state.stale) return true;
  const nowMs = now.getTime();
  const fetchedAt = state.fetchedAt ? Date.parse(state.fetchedAt) : Number.NaN;
  const expiresAt = state.expiresAt ? Date.parse(state.expiresAt) : Number.NaN;
  return (
    !Number.isFinite(fetchedAt) ||
    nowMs - fetchedAt >= SIGNED_CATALOG_REFRESH_MAX_AGE_MS ||
    !Number.isFinite(expiresAt) ||
    expiresAt - nowMs <= SIGNED_CATALOG_REFRESH_AHEAD_MS
  );
}

function enabledEnvironmentFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function catalogTrustedKeysFromEnv(
  env: Record<string, string | undefined>,
): Readonly<Record<string, string>> {
  const raw = env.SPARKWRIGHT_PROVIDER_CATALOG_TRUSTED_KEYS;
  if (!raw || raw.length > 256 * 1024) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecordValue(parsed) || Object.keys(parsed).length > 32) return {};
  const keys: Record<string, string> = {};
  for (const [keyId, publicKey] of Object.entries(parsed)) {
    if (
      keyId.length === 0 ||
      keyId.length > 128 ||
      hasDisallowedMetadataControlCharacter(keyId, false) ||
      typeof publicKey !== "string" ||
      publicKey.length === 0 ||
      publicKey.length > 16 * 1024
    ) {
      return {};
    }
    keys[keyId] = publicKey;
  }
  return keys;
}

function providerDiscoveryScopeKey(input: {
  workspaceId: string;
  providerId: string;
  credentialScope: string;
}): string {
  return JSON.stringify([
    input.workspaceId,
    input.providerId,
    input.credentialScope,
  ]);
}

function latestTimestamp(
  values: readonly (string | undefined)[],
): string | undefined {
  return values
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function earliestTimestamp(
  values: readonly (string | undefined)[],
): string | undefined {
  return values
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

function parseOpenAICompatibleModelList(
  text: string,
  providerId: string,
): ModelInfo[] {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecordValue(parsed) || !Array.isArray(parsed.data)) {
    throw new Error("Model discovery response must contain a data array.");
  }
  if (parsed.data.length > 20_000) {
    throw new Error("Model discovery response contains too many models.");
  }
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const value of parsed.data) {
    if (!isRecordValue(value)) continue;
    const id = boundedDiscoveryText(value.id, 256, false);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = boundedDiscoveryText(value.name, 512, true);
    const description = boundedDiscoveryText(value.description, 2_048, true);
    const contextWindow = positiveDiscoveryInteger(value.context_length);
    const maxOutputTokens = positiveDiscoveryInteger(
      value.max_completion_tokens,
    );
    const pricing = discoveryPricing(value.pricing);
    models.push({
      id,
      providerId,
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(pricing ? { pricing } : {}),
    });
  }
  if (models.length === 0) {
    throw new Error("Model discovery response contains no usable models.");
  }
  return models.sort((left, right) => left.id.localeCompare(right.id));
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Model discovery response is too large.");
  }
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("Model discovery response is too large.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function discoveryPricing(value: unknown): ModelInfo["pricing"] {
  if (!isRecordValue(value)) return undefined;
  const prompt = perTokenPriceToPerMillion(value.prompt);
  const completion = perTokenPriceToPerMillion(value.completion);
  const cacheRead = perTokenPriceToPerMillion(value.input_cache_read);
  const cacheWrite = perTokenPriceToPerMillion(value.input_cache_write);
  if (
    prompt === undefined &&
    completion === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return {
    ...(prompt !== undefined ? { inputPerMTokUsd: prompt } : {}),
    ...(completion !== undefined ? { outputPerMTokUsd: completion } : {}),
    ...(cacheRead !== undefined ? { cacheReadPerMTokUsd: cacheRead } : {}),
    ...(cacheWrite !== undefined
      ? { cacheCreationPerMTokUsd: cacheWrite }
      : {}),
  };
}

function perTokenPriceToPerMillion(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const price = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(price) || price < 0) return undefined;
  return price * 1_000_000;
}

function positiveDiscoveryInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

function boundedDiscoveryText(
  value: unknown,
  maxLength: number,
  allowWhitespace: boolean,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    hasDisallowedMetadataControlCharacter(value, false) ||
    (!allowWhitespace && /\s/u.test(value))
  ) {
    return undefined;
  }
  return value;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeProviderEndpoint(endpoint: string): string {
  if (
    endpoint.length === 0 ||
    endpoint.length > 2_048 ||
    hasDisallowedMetadataControlCharacter(endpoint, false)
  ) {
    throw new Error(
      "Provider endpoint must be a non-empty URL of at most 2048 characters without control characters.",
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Provider endpoint must be an absolute URL.");
  }
  if (url.username || url.password) {
    throw new Error("Provider endpoint must not contain user information.");
  }
  if (url.hash)
    throw new Error("Provider endpoint must not contain a fragment.");
  if (url.search) {
    throw new Error("Provider endpoint must not contain a query string.");
  }
  if (url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("Provider endpoint must use HTTPS unless it is loopback.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Provider endpoint must use HTTP or HTTPS.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function providerEndpointError(error: unknown): string {
  return error instanceof Error && error.message.startsWith("Provider endpoint")
    ? error.message
    : "Provider endpoint is invalid.";
}

async function providerWorkspaceId(workspaceRoot: string): Promise<string> {
  const canonical = await realpath(workspaceRoot).catch(() =>
    resolve(workspaceRoot),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function providerCredentialProfileId(input: {
  workspaceRoot: string;
  providerId: string;
  npm: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `${resolve(input.workspaceRoot)}\0${input.providerId}\0${input.npm}`,
    )
    .digest("hex")
    .slice(0, 20);
  return `credential_${digest}`;
}

function providerCatalogConfigs(
  configuredProviders: Record<string, ProviderConfig>,
  env: Record<string, string | undefined>,
): Record<string, ProviderConfig> {
  const effective = { ...configuredProviders };
  const providerIds = new Set([
    ...bundledProviderIds(),
    ...Object.keys(configuredProviders),
  ]);
  for (const providerId of providerIds) {
    const config = configuredProviders[providerId];
    const npm = providerNpm(providerId, config);
    const descriptor = getProviderConnectionDescriptor(providerId);
    const npmBaseUrlEnv = SUPPORTED_PROVIDER_NPMS[npm]?.baseUrlEnv;
    const environmentBaseUrlNames =
      descriptor && npm === descriptor.npm
        ? (descriptor.baseUrlEnvironmentVariables ?? [])
        : npmBaseUrlEnv
          ? [npmBaseUrlEnv]
          : [];
    const environmentBaseURL = environmentBaseUrlNames
      .map((name) => nonEmpty(env[name]))
      .find((value) => value !== undefined);
    if (environmentBaseURL) {
      effective[providerId] = {
        ...(config ?? {}),
        npm,
        baseURL: environmentBaseURL,
      };
    }
  }
  return effective;
}

function availableCredential(input: {
  providerId: string;
  npm: string;
  configuredApiKey?: string;
  env: Record<string, string | undefined>;
}): AmbientCredential | undefined {
  const npmInfo = SUPPORTED_PROVIDER_NPMS[input.npm];
  const descriptor = getProviderConnectionDescriptor(input.providerId);
  const descriptorEnvironmentNames = descriptor?.authMethods.find(
    (method) => method.kind === "api_key",
  )?.environmentVariables;
  const environmentNames = descriptorEnvironmentNames
    ? [...descriptorEnvironmentNames]
    : npmInfo
      ? [npmInfo.apiKeyEnv]
      : [];
  const environmentName = environmentNames.find((name) =>
    nonEmpty(input.env[name]),
  );
  const envValue = environmentName
    ? nonEmpty(input.env[environmentName])
    : undefined;
  if (envValue && environmentName) {
    return {
      apiKey: envValue,
      source: "environment",
      sourceLabel: `env:${environmentName}`,
    };
  }
  const configured = nonEmpty(input.configuredApiKey);
  return configured
    ? { apiKey: configured, source: "config", sourceLabel: "config" }
    : undefined;
}

function authMethodSummaries(methods: readonly ProviderConnectionAuthMethod[]) {
  return methods.map((method) =>
    method.kind === "api_key"
      ? {
          id: method.id,
          type: method.kind,
          label: method.label ?? "API key",
          environmentVariables: [...method.environmentVariables],
        }
      : {
          id: method.id,
          type: method.kind,
          label: method.label,
          flow: method.flow,
          ...(method.prompts
            ? {
                prompts: method.prompts.map((prompt) =>
                  prompt.kind === "select"
                    ? {
                        ...prompt,
                        options: prompt.options.map((option) => ({
                          ...option,
                        })),
                      }
                    : { ...prompt },
                ),
              }
            : {}),
        },
  );
}

function storedProfileSummary(
  connection: StoredProviderConnection,
  status: ProviderAuthStatus,
): ProviderCredentialProfileSummary {
  return {
    id: connection.id,
    providerId: connection.binding.providerId,
    status,
    source: "stored",
    sourceLabel: `stored:${connection.id}`,
    generation: connection.generation,
    updatedAt: connection.updatedAt,
  };
}

function ambientProfileSummary(input: {
  profileId: string;
  providerId: string;
  status: ProviderAuthStatus;
  ambient: AmbientCredential | undefined;
  persisted: LegacyProviderAuthStateRecord | undefined;
}): ProviderCredentialProfileSummary {
  return {
    id: input.profileId,
    providerId: input.providerId,
    status: input.status,
    ...(input.ambient
      ? {
          source: input.ambient.source,
          sourceLabel: input.ambient.sourceLabel,
        }
      : {}),
    generation: input.persisted?.generation ?? 0,
    ...(input.persisted?.updatedAt
      ? { updatedAt: input.persisted.updatedAt }
      : {}),
  };
}

function storedConnectionSummary(input: {
  connection: StoredProviderConnection;
  state: ProviderConnectionStateFile;
  workspaceId: string;
  expectedBinding: ProviderConnectionBinding | undefined;
}): ProviderConnectionSummary {
  const selected =
    input.state.selections[
      selectionKey(input.workspaceId, input.connection.binding.providerId)
    ] === input.connection.id;
  const bindingMatches =
    input.expectedBinding !== undefined &&
    sameEndpointBinding(input.connection.binding, input.expectedBinding);
  const grantScope = input.state.grants.find(
    (grant) =>
      grant.connectionId === input.connection.id &&
      (grant.scope === "user" || grant.workspaceId === input.workspaceId),
  )?.scope;
  return {
    id: input.connection.id,
    providerId: input.connection.binding.providerId,
    status: bindingMatches ? input.connection.status : ("failed" as const),
    source: "stored",
    sourceLabel: `stored:${input.connection.id}`,
    binding: publicBinding(input.connection.binding),
    selected,
    ...(grantScope ? { grantScope } : {}),
    generation: input.connection.generation,
    createdAt: input.connection.createdAt,
    updatedAt: input.connection.updatedAt,
  };
}

function ambientConnectionSummary(input: {
  id: string;
  providerId: string;
  binding: ProviderConnectionBinding;
  ambient: AmbientCredential;
  status: ProviderConnectionStatus;
  selected: boolean;
  generation: number;
  updatedAt?: string;
}): ProviderConnectionSummary {
  return {
    id: input.id,
    providerId: input.providerId,
    status: input.status,
    source: input.ambient.source,
    sourceLabel: input.ambient.sourceLabel,
    binding: publicBinding(input.binding),
    selected: input.selected,
    grantScope: "workspace",
    generation: input.generation,
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
}

function publicBinding(
  binding: ProviderConnectionBinding,
): ProviderConnectionBindingSummary {
  const canonical = canonicalProviderConnectionBinding(binding);
  return {
    providerId: binding.providerId,
    driverId: binding.driverId,
    endpoint: binding.normalizedEndpoint,
    endpointFingerprint: canonical.endpointFingerprint,
    authMethodId: binding.authMethodId,
  };
}

function selectionKey(workspaceId: string, providerId: string): string {
  return `${workspaceId}:${providerId}`;
}

function oauthConnectionLockPath(
  statePath: string,
  connectionId: string,
): string {
  const digest = createHash("sha256")
    .update(connectionId)
    .digest("hex")
    .slice(0, 24);
  return `${statePath}.oauth.${digest}.lock`;
}

function hasConnectionGrant(
  state: ProviderConnectionStateFile,
  connectionId: string,
  workspaceId: string,
): boolean {
  return state.grants.some(
    (grant) =>
      grant.connectionId === connectionId &&
      (grant.scope === "user" || grant.workspaceId === workspaceId),
  );
}

function appendUniqueGrant(
  grants: ConnectionGrant[],
  grant: ConnectionGrant,
): ConnectionGrant[] {
  return grants.some(
    (entry) =>
      entry.connectionId === grant.connectionId &&
      entry.scope === grant.scope &&
      (entry.scope === "user" ||
        (grant.scope === "workspace" &&
          entry.workspaceId === grant.workspaceId)),
  )
    ? grants
    : [...grants, grant];
}

function appendUniqueSuppression(
  suppressions: ConnectionSuppression[],
  suppression: ConnectionSuppression,
): ConnectionSuppression[] {
  return [
    ...suppressions.filter(
      (entry) =>
        !(
          entry.workspaceId === suppression.workspaceId &&
          entry.bindingFingerprint === suppression.bindingFingerprint
        ),
    ),
    suppression,
  ];
}

function isSuppressed(
  state: ProviderConnectionStateFile,
  workspaceId: string,
  binding: ProviderConnectionBinding,
): boolean {
  return state.suppressions.some((entry) =>
    suppressionMatchesBinding(entry, workspaceId, binding),
  );
}

function suppressionMatchesBinding(
  suppression: ConnectionSuppression,
  workspaceId: string,
  binding: ProviderConnectionBinding,
): boolean {
  const canonical = canonicalProviderConnectionBinding(binding);
  return (
    suppression.workspaceId === workspaceId &&
    (suppression.bindingFingerprint === canonical.bindingFingerprint ||
      // Compatibility with state written before complete Host-private
      // binding fingerprints were separated from the public endpoint value.
      suppression.bindingFingerprint === binding.endpointFingerprint ||
      suppression.bindingFingerprint === canonical.endpointFingerprint)
  );
}

function disconnectStoredConnection(
  state: ProviderConnectionStateFile,
  connectionId: string,
  workspaceId: string,
): ProviderConnectionStateFile {
  const selections = { ...state.selections };
  for (const [key, selected] of Object.entries(selections)) {
    if (selected === connectionId && key.startsWith(`${workspaceId}:`)) {
      delete selections[key];
    }
  }
  return {
    ...state,
    selections,
    grants: state.grants.filter(
      (grant) =>
        !(
          grant.connectionId === connectionId &&
          grant.scope === "workspace" &&
          grant.workspaceId === workspaceId
        ),
    ),
  };
}

function removeStoredConnection(
  state: ProviderConnectionStateFile,
  connectionId: string,
): ProviderConnectionStateFile {
  const connections = { ...state.connections };
  delete connections[connectionId];
  const selections = { ...state.selections };
  for (const [key, selected] of Object.entries(selections)) {
    if (selected === connectionId) delete selections[key];
  }
  return {
    ...state,
    connections,
    selections,
    grants: state.grants.filter((grant) => grant.connectionId !== connectionId),
  };
}

function createProviderConnectionBinding(
  input: Omit<
    ProviderConnectionBinding,
    "endpointFingerprint" | "bindingFingerprint"
  >,
): ProviderConnectionBinding {
  const endpointFingerprintInput = JSON.stringify({
    providerId: input.providerId,
    driverId: input.driverId,
    normalizedEndpoint: input.normalizedEndpoint,
  });
  const bindingFingerprintInput = JSON.stringify({
    providerId: input.providerId,
    driverId: input.driverId,
    normalizedEndpoint: input.normalizedEndpoint,
    authMethodId: input.authMethodId,
    ...(input.authRealm !== undefined ? { authRealm: input.authRealm } : {}),
    ...(input.accountSlot !== undefined
      ? { accountSlot: input.accountSlot }
      : {}),
    ...(input.tenant !== undefined ? { tenant: input.tenant } : {}),
  });
  return {
    ...input,
    endpointFingerprint: createHash("sha256")
      .update(endpointFingerprintInput)
      .digest("hex"),
    bindingFingerprint: createHash("sha256")
      .update(bindingFingerprintInput)
      .digest("hex"),
  };
}

function canonicalProviderConnectionBinding(
  binding: ProviderConnectionBinding,
): ProviderConnectionBinding {
  return createProviderConnectionBinding({
    providerId: binding.providerId,
    driverId: binding.driverId,
    normalizedEndpoint: binding.normalizedEndpoint,
    authMethodId: binding.authMethodId,
    ...(binding.authRealm !== undefined
      ? { authRealm: binding.authRealm }
      : {}),
    ...(binding.accountSlot !== undefined
      ? { accountSlot: binding.accountSlot }
      : {}),
    ...(binding.tenant !== undefined ? { tenant: binding.tenant } : {}),
  });
}

function completeBindingFingerprint(
  binding: ProviderConnectionBinding,
): string {
  return canonicalProviderConnectionBinding(binding).bindingFingerprint!;
}

function bindOAuthCredentialToConnection(
  binding: ProviderConnectionBinding,
  credential: ProviderOAuthCredential,
): {
  binding: ProviderConnectionBinding;
  credential: ProviderOAuthCredential;
} {
  const credentialError = validateOAuthCredential(credential);
  if (credentialError) throw new Error(credentialError);
  const bindingError = validateProviderConnectionIdentity(binding);
  if (bindingError) throw new Error(bindingError);
  if (!binding.authRealm) {
    throw new Error("OAuth connection has no code-owned authentication realm.");
  }
  if (
    credential.authRealm !== undefined &&
    credential.authRealm !== binding.authRealm
  ) {
    throw new Error(
      "OAuth credential realm does not match its code-owned connection binding.",
    );
  }
  if (
    binding.accountSlot !== undefined &&
    credential.accountSlot !== undefined &&
    binding.accountSlot !== credential.accountSlot
  ) {
    throw new Error("OAuth credential account binding changed unexpectedly.");
  }
  if (
    binding.tenant !== undefined &&
    credential.tenant !== undefined &&
    binding.tenant !== credential.tenant
  ) {
    throw new Error("OAuth credential tenant binding changed unexpectedly.");
  }
  const accountSlot = binding.accountSlot ?? credential.accountSlot;
  const tenant = binding.tenant ?? credential.tenant;
  const nextBinding = createProviderConnectionBinding({
    providerId: binding.providerId,
    driverId: binding.driverId,
    normalizedEndpoint: binding.normalizedEndpoint,
    authMethodId: binding.authMethodId,
    authRealm: binding.authRealm,
    ...(accountSlot !== undefined ? { accountSlot } : {}),
    ...(tenant !== undefined ? { tenant } : {}),
  });
  const {
    authRealm: _authRealm,
    accountSlot: _accountSlot,
    tenant: _tenant,
    ...credentialPayload
  } = credential;
  return {
    binding: nextBinding,
    credential: {
      ...credentialPayload,
      authRealm: nextBinding.authRealm,
      ...(nextBinding.accountSlot !== undefined
        ? { accountSlot: nextBinding.accountSlot }
        : {}),
      ...(nextBinding.tenant !== undefined
        ? { tenant: nextBinding.tenant }
        : {}),
    },
  };
}

function sameBinding(
  left: ProviderConnectionBinding,
  right: ProviderConnectionBinding,
): boolean {
  const canonicalLeft = canonicalProviderConnectionBinding(left);
  const canonicalRight = canonicalProviderConnectionBinding(right);
  return (
    canonicalLeft.bindingFingerprint === canonicalRight.bindingFingerprint &&
    canonicalLeft.endpointFingerprint === canonicalRight.endpointFingerprint &&
    left.providerId === right.providerId &&
    left.driverId === right.driverId &&
    left.normalizedEndpoint === right.normalizedEndpoint &&
    left.authMethodId === right.authMethodId &&
    left.authRealm === right.authRealm &&
    left.accountSlot === right.accountSlot &&
    left.tenant === right.tenant
  );
}

function sameEndpointBinding(
  left: ProviderConnectionBinding,
  right: ProviderConnectionBinding,
): boolean {
  return (
    left.providerId === right.providerId &&
    left.driverId === right.driverId &&
    left.normalizedEndpoint === right.normalizedEndpoint
  );
}

function isUsableConnectionStatus(status: ProviderConnectionStatus): boolean {
  return status === "ready" || status === "unverified";
}

function splitSelectedModel(
  modelRef: string,
): { providerId: string; modelId: string } | undefined {
  const separator = modelRef.indexOf("/");
  if (separator <= 0 || separator === modelRef.length - 1) return undefined;
  return {
    providerId: modelRef.slice(0, separator),
    modelId: modelRef.slice(separator + 1),
  };
}

function matchesProjection(
  entry: ProviderCatalogEntry,
  projection: ProviderCatalogProjection | undefined,
): boolean {
  if (!projection) return entry.configured === true;
  if (projection === "all") return true;
  if (projection === "connected") return entry.connected === true;
  return entry.available === true;
}

function compareConnections(
  left: ProviderConnectionSummary,
  right: ProviderConnectionSummary,
): number {
  if (left.selected !== right.selected) return left.selected ? -1 : 1;
  return left.id.localeCompare(right.id);
}

function publicOAuthAttempt(
  attempt: ProviderOAuthAttempt,
): ProviderAuthAttemptSummary {
  return {
    id: attempt.id,
    providerId: attempt.providerId,
    methodId: attempt.methodId,
    flow: attempt.flow,
    status: attempt.status,
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
    ...(attempt.authorizationUrl
      ? { authorizationUrl: attempt.authorizationUrl }
      : {}),
    ...(attempt.verificationUrl
      ? { verificationUrl: attempt.verificationUrl }
      : {}),
    ...(attempt.userCode ? { userCode: attempt.userCode } : {}),
    ...(attempt.instructions ? { instructions: attempt.instructions } : {}),
    ...(attempt.connection ? { connection: attempt.connection } : {}),
    ...(attempt.message ? { message: attempt.message } : {}),
  };
}

function ownsOAuthAttempt(
  attempt: ProviderOAuthAttempt,
  context: { principalId: string; clientConnectionId: string },
): boolean {
  return (
    attempt.principalId === context.principalId &&
    attempt.clientConnectionId === context.clientConnectionId
  );
}

function isOAuthAttemptExpired(
  attempt: ProviderOAuthAttempt,
  now: Date,
): boolean {
  return (
    attempt.status === "pending" &&
    Date.parse(attempt.expiresAt) <= now.getTime()
  );
}

function clearOAuthAttemptSecrets(attempt: ProviderOAuthAttempt): void {
  attempt.state = "";
  attempt.nonce = undefined;
  attempt.codeVerifier = undefined;
  attempt.promptValues = {};
  if (attempt.authorizationUrl) {
    attempt.authorizationUrl = undefined;
  }
  attempt.userCode = undefined;
}

function validateOAuthPromptValues(
  method: Extract<ProviderConnectionAuthMethod, { kind: "oauth" }>,
  values: Readonly<Record<string, string>>,
): string | undefined {
  const prompts = method.prompts ?? [];
  if (prompts.length > 16) return "OAuth method declares too many prompts.";
  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  for (const [id, value] of Object.entries(values)) {
    const prompt = byId.get(id);
    if (!prompt) return `Unknown OAuth prompt "${id}".`;
    if (Buffer.byteLength(value, "utf8") > 4 * 1024) {
      return `OAuth prompt "${id}" exceeds the 4096-byte limit.`;
    }
    if (hasControlCharacters(value)) {
      return `OAuth prompt "${id}" contains a control character.`;
    }
    if (
      prompt.kind === "select" &&
      !prompt.options.some((option) => option.value === value)
    ) {
      return `OAuth prompt "${id}" has an invalid selection.`;
    }
  }
  for (const prompt of prompts) {
    if (prompt.required && !values[prompt.id]) {
      return `OAuth prompt "${prompt.id}" is required.`;
    }
  }
  return undefined;
}

function encodeOAuthCredential(credential: ProviderOAuthCredential): string {
  if (credential.managedTransport === CHATGPT_MANAGED_TRANSPORT) {
    return CHATGPT_MANAGED_CREDENTIAL_MARKER;
  }
  return `${OAUTH_CREDENTIAL_PREFIX}${JSON.stringify({
    accessToken: credential.accessToken,
    ...(credential.refreshToken
      ? { refreshToken: credential.refreshToken }
      : {}),
    ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
    ...(credential.tokenType ? { tokenType: credential.tokenType } : {}),
    ...(credential.authRealm ? { authRealm: credential.authRealm } : {}),
    ...(credential.accountSlot ? { accountSlot: credential.accountSlot } : {}),
    ...(credential.tenant ? { tenant: credential.tenant } : {}),
    ...(credential.managedTransport
      ? { managedTransport: credential.managedTransport }
      : {}),
  })}`;
}

function decodeOAuthCredential(
  encoded: string,
): ProviderOAuthCredential | undefined {
  if (!encoded.startsWith(OAUTH_CREDENTIAL_PREFIX)) return undefined;
  if (
    encoded === CHATGPT_MANAGED_CREDENTIAL_MARKER ||
    encoded === TRUNCATED_LEGACY_CHATGPT_MANAGED_CREDENTIAL
  ) {
    return {
      accessToken: "managed-by-openai-app-server",
      tokenType: "managed",
      authRealm: CHATGPT_MANAGED_AUTH_REALM,
      managedTransport: CHATGPT_MANAGED_TRANSPORT,
    };
  }
  try {
    const parsed = JSON.parse(encoded.slice(OAUTH_CREDENTIAL_PREFIX.length));
    if (!isRecord(parsed) || typeof parsed.accessToken !== "string") {
      return undefined;
    }
    const credential: ProviderOAuthCredential = {
      accessToken: parsed.accessToken,
      ...(typeof parsed.refreshToken === "string"
        ? { refreshToken: parsed.refreshToken }
        : {}),
      ...(typeof parsed.expiresAt === "string"
        ? { expiresAt: parsed.expiresAt }
        : {}),
      ...(typeof parsed.tokenType === "string"
        ? { tokenType: parsed.tokenType }
        : {}),
      ...(typeof parsed.authRealm === "string"
        ? { authRealm: parsed.authRealm }
        : {}),
      ...(typeof parsed.accountSlot === "string"
        ? { accountSlot: parsed.accountSlot }
        : {}),
      ...(typeof parsed.tenant === "string" ? { tenant: parsed.tenant } : {}),
      ...(parsed.managedTransport === "chatgpt_app_server"
        ? { managedTransport: parsed.managedTransport }
        : {}),
    };
    return validateOAuthCredential(credential) ? undefined : credential;
  } catch {
    return undefined;
  }
}

function shouldRefreshOAuthCredential(
  credential: ProviderOAuthCredential,
  now: Date,
): boolean {
  if (!credential.expiresAt) return false;
  return (
    Date.parse(credential.expiresAt) <= now.getTime() + OAUTH_REFRESH_WINDOW_MS
  );
}

function providerRuntimeCredential(input: {
  secret: string;
  oauthCredential: ProviderOAuthCredential | undefined;
  binding: ProviderConnectionBinding;
}):
  | { ok: true; credential: ProviderRuntimeCredential }
  | { ok: false; message: string } {
  if (!input.oauthCredential) {
    return {
      ok: true,
      credential: { kind: "api_key", value: input.secret },
    };
  }
  const credentialRealm = input.oauthCredential.authRealm;
  if (credentialRealm && credentialRealm !== input.binding.authRealm) {
    return {
      ok: false,
      message:
        "OAuth credential realm does not match its code-owned connection binding.",
    };
  }
  if (
    input.oauthCredential.accountSlot !== undefined &&
    input.oauthCredential.accountSlot !== input.binding.accountSlot
  ) {
    return {
      ok: false,
      message:
        "OAuth credential account does not match its connection binding.",
    };
  }
  if (
    input.oauthCredential.tenant !== undefined &&
    input.oauthCredential.tenant !== input.binding.tenant
  ) {
    return {
      ok: false,
      message: "OAuth credential tenant does not match its connection binding.",
    };
  }
  const tokenType = input.oauthCredential.tokenType?.toLowerCase();
  if (input.oauthCredential.managedTransport === "chatgpt_app_server") {
    if (!input.binding.authRealm) {
      return {
        ok: false,
        message: "Managed ChatGPT credential has no code-owned realm.",
      };
    }
    return {
      ok: true,
      credential: {
        kind: "chatgpt_app_server",
        authRealm: input.binding.authRealm,
        ...(input.binding.accountSlot
          ? { accountSlot: input.binding.accountSlot }
          : {}),
      },
    };
  }
  if (tokenType === "api_key") {
    return {
      ok: true,
      credential: {
        kind: "api_key",
        value: input.oauthCredential.accessToken,
      },
    };
  }
  if (tokenType !== undefined && tokenType !== "bearer") {
    return {
      ok: false,
      message: `OAuth credential token type "${tokenType}" is unsupported.`,
    };
  }
  if (!input.binding.authRealm) {
    return {
      ok: false,
      message:
        "OAuth bearer credential has no code-owned authentication realm.",
    };
  }
  return {
    ok: true,
    credential: {
      kind: "bearer",
      value: input.oauthCredential.accessToken,
      authRealm: input.binding.authRealm,
      ...(input.oauthCredential.expiresAt
        ? { expiresAt: input.oauthCredential.expiresAt }
        : {}),
      ...(input.binding.accountSlot
        ? { accountSlot: input.binding.accountSlot }
        : {}),
      ...(input.binding.tenant ? { tenant: input.binding.tenant } : {}),
    },
  };
}

function validateOAuthCredential(
  credential: ProviderOAuthCredential,
): string | undefined {
  if (!credential.accessToken) return "OAuth access token is missing.";
  for (const value of [credential.accessToken, credential.refreshToken]) {
    if (!value) continue;
    if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
      return "OAuth credential exceeds the secret-size limit.";
    }
    if (hasControlCharacters(value)) {
      return "OAuth credential contains a control character.";
    }
  }
  if (
    credential.expiresAt !== undefined &&
    !Number.isFinite(Date.parse(credential.expiresAt))
  ) {
    return "OAuth credential expiration is invalid.";
  }
  const identityError = validateProviderConnectionIdentity(credential);
  if (identityError) return identityError;
  if (credential.tokenType !== undefined) {
    if (Buffer.byteLength(credential.tokenType, "utf8") > 64) {
      return "OAuth credential token type exceeds the size limit.";
    }
    if (hasControlCharacters(credential.tokenType)) {
      return "OAuth credential token type contains a control character.";
    }
  }
  if (
    credential.managedTransport !== undefined &&
    credential.managedTransport !== "chatgpt_app_server"
  ) {
    return "OAuth managed transport is unsupported.";
  }
  return undefined;
}

function validateProviderConnectionIdentity(
  identity: ProviderConnectionIdentity,
): string | undefined {
  for (const [label, value] of [
    ["realm", identity.authRealm],
    ["account", identity.accountSlot],
    ["tenant", identity.tenant],
  ] as const) {
    if (value === undefined) continue;
    if (value.trim().length === 0) {
      return `OAuth ${label} identity must not be empty.`;
    }
    if (Buffer.byteLength(value, "utf8") > MAX_OAUTH_IDENTITY_BYTES) {
      return `OAuth ${label} identity exceeds the size limit.`;
    }
    if (hasControlCharacters(value)) {
      return `OAuth ${label} identity contains a control character.`;
    }
  }
  return undefined;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isProviderModelModality(
  value: string,
): value is NonNullable<ModelInfo["inputModalities"]>[number] {
  return ["text", "image", "audio", "video", "tool"].includes(value);
}

function validateSecret(secret: string): string | undefined {
  if (secret.length === 0) return "API key must not be empty.";
  if (Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) {
    return `API key exceeds the ${MAX_SECRET_BYTES}-byte limit.`;
  }
  if (hasControlCharacters(secret)) {
    return "API key must not contain control characters.";
  }
  return undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function emptyProviderConnectionState(): ProviderConnectionStateFile {
  return {
    version: PROVIDER_CONNECTION_STATE_VERSION,
    revision: 0,
    profiles: {},
    connections: {},
    grants: [],
    selections: {},
    suppressions: [],
  };
}

async function readStateFile(
  path: string,
): Promise<
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; state: ProviderConnectionStateFile }
> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid" };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isProviderConnectionStateFile(parsed)) {
      return { status: "valid", state: parsed };
    }
    if (isLegacyProviderAuthStateFile(parsed)) {
      return {
        status: "valid",
        state: {
          ...emptyProviderConnectionState(),
          profiles: parsed.profiles,
        },
      };
    }
    return { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

function isProviderConnectionStateFile(
  value: unknown,
): value is ProviderConnectionStateFile {
  if (!isRecord(value) || value.version !== PROVIDER_CONNECTION_STATE_VERSION) {
    return false;
  }
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
    return false;
  }
  if (!isLegacyProfiles(value.profiles)) return false;
  if (!isRecord(value.connections)) return false;
  if (!Object.values(value.connections).every(isStoredConnection)) return false;
  if (!Array.isArray(value.grants) || !value.grants.every(isConnectionGrant)) {
    return false;
  }
  if (
    !isRecord(value.selections) ||
    !Object.values(value.selections).every((entry) => typeof entry === "string")
  ) {
    return false;
  }
  return (
    Array.isArray(value.suppressions) &&
    value.suppressions.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.workspaceId === "string" &&
        typeof entry.bindingFingerprint === "string" &&
        typeof entry.updatedAt === "string",
    )
  );
}

function isLegacyProviderAuthStateFile(
  value: unknown,
): value is LegacyProviderAuthStateFile {
  return (
    isRecord(value) &&
    value.version === LEGACY_PROVIDER_AUTH_STATE_VERSION &&
    isLegacyProfiles(value.profiles)
  );
}

function isLegacyProfiles(
  value: unknown,
): value is Record<string, LegacyProviderAuthStateRecord> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.providerId === "string" &&
        (entry.state === "active" || entry.state === "logged_out") &&
        Number.isInteger(entry.generation) &&
        (entry.generation as number) >= 0 &&
        typeof entry.updatedAt === "string",
    )
  );
}

function isStoredConnection(value: unknown): value is StoredProviderConnection {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isConnectionBinding(value.binding) &&
    isConnectionStatus(value.status) &&
    Number.isInteger(value.generation) &&
    (value.generation as number) >= 0 &&
    Number.isInteger(value.oauthRefreshGeneration ?? 0) &&
    ((value.oauthRefreshGeneration as number | undefined) ?? 0) >= 0 &&
    (value.oauthRefreshOutcome === undefined ||
      value.oauthRefreshOutcome === "succeeded" ||
      value.oauthRefreshOutcome === "failed") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isConnectionBinding(
  value: unknown,
): value is ProviderConnectionBinding {
  return (
    isRecord(value) &&
    typeof value.providerId === "string" &&
    typeof value.driverId === "string" &&
    typeof value.normalizedEndpoint === "string" &&
    typeof value.endpointFingerprint === "string" &&
    (value.bindingFingerprint === undefined ||
      typeof value.bindingFingerprint === "string") &&
    typeof value.authMethodId === "string" &&
    (value.authRealm === undefined || typeof value.authRealm === "string") &&
    (value.accountSlot === undefined ||
      typeof value.accountSlot === "string") &&
    (value.tenant === undefined || typeof value.tenant === "string") &&
    validateProviderConnectionIdentity(value) === undefined
  );
}

function isConnectionGrant(value: unknown): value is ConnectionGrant {
  return (
    isRecord(value) &&
    typeof value.connectionId === "string" &&
    ((value.scope === "user" && value.workspaceId === undefined) ||
      (value.scope === "workspace" && typeof value.workspaceId === "string"))
  );
}

function isConnectionStatus(value: unknown): value is ProviderConnectionStatus {
  return (
    value === "unconfigured" ||
    value === "ready" ||
    value === "unverified" ||
    value === "needs_refresh" ||
    value === "failed" ||
    value === "suppressed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
