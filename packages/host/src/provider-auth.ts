import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ProviderAuthMethodsSnapshot,
  ProviderAuthStatus,
  ProviderCatalogEntry,
  ProviderCatalogProjection,
  ProviderCatalogSnapshot,
  ProviderConnectionBindingSummary,
  ProviderConnectionGrantScope,
  ProviderConnectionStatus,
  ProviderConnectionSummary,
  ProviderCredentialProfileSummary,
} from "@sparkwright/protocol";
import { atomicWriteText } from "@sparkwright/agent-runtime";
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
  BUNDLED_PROVIDER_CATALOG_VERSION,
  bundledProviderIds,
  createHostProviderRegistry,
  getProviderConnectionDescriptor,
  providerNpm,
} from "./provider-catalog.js";
import {
  createProviderCredentialStore,
  type ProviderCredentialStore,
  withExclusiveFileLock,
} from "./provider-credential-store.js";

const PROVIDER_CONNECTION_STATE_VERSION = 2;
const LEGACY_PROVIDER_AUTH_STATE_VERSION = 1;
const MAX_SECRET_BYTES = 64 * 1024;
const REVISION_POLL_MS = 250;

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
  endpointFingerprint: string;
  authMethodId: string;
  authRealm?: string;
  accountSlot?: string;
  tenant?: string;
}

interface StoredProviderConnection {
  id: string;
  binding: ProviderConnectionBinding;
  status: ProviderConnectionStatus;
  generation: number;
  createdAt: string;
  updatedAt: string;
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

interface AmbientCredential {
  apiKey: string;
  source: "environment" | "config";
  sourceLabel: string;
}

export interface ProviderCredentialLease {
  apiKey: string;
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
}

export interface ProviderAuthContext {
  workspaceRoot: string;
  env?: Record<string, string | undefined>;
  includeProjectConfig?: boolean;
  projection?: ProviderCatalogProjection;
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
  private credentialStore: ProviderCredentialStore | undefined;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(options: ProviderAuthManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.statePath = options.statePath ?? providerAuthStatePath(this.env);
    this.credentialStore = options.credentialStore;
    this.now = options.now ?? (() => new Date());
  }

  async catalog(
    context: ProviderAuthContext & { model?: string },
  ): Promise<ProviderCatalogSnapshot> {
    const loaded = await this.loadContext(context, context.model);
    const state = await this.readState();
    const selected = loaded.selectedModel
      ? splitSelectedModel(loaded.selectedModel)
      : undefined;
    const registry = createHostProviderRegistry({
      configuredProviders: loaded.catalogProviders,
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
      const profileId = providerCredentialProfileId({
        workspaceRoot: loaded.workspaceRoot,
        providerId,
        npm,
      });
      const persistedProfile = state.profiles[profileId];
      const ambient = availableCredential({
        npm,
        configuredApiKey: config?.apiKey,
        env: loaded.env,
      });
      const suppressed = binding
        ? isSuppressed(state, loaded.workspaceId, binding.endpointFingerprint)
        : false;
      const selectedConnectionId =
        state.selections[selectionKey(loaded.workspaceId, providerId)];
      const stored = selectedConnectionId
        ? state.connections[selectedConnectionId]
        : undefined;
      const storedApplicable =
        stored !== undefined &&
        binding !== undefined &&
        sameBinding(stored.binding, binding) &&
        hasConnectionGrant(state, stored.id, loaded.workspaceId);
      const ambientStatus: ProviderAuthStatus = !ambient
        ? "missing"
        : suppressed || persistedProfile?.state === "logged_out"
          ? "logged_out"
          : "ready";
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
        expectedBinding: binding,
      });
      if (ambient && binding) {
        connectionSummaries.push(
          ambientConnectionSummary({
            id: profileId,
            providerId,
            binding,
            ambient,
            status:
              ambientStatus === "ready"
                ? "ready"
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
        (!stored && ambientStatus === "ready");
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
          ? { authMethods: authMethodSummaries(descriptor.authMethods) }
          : {}),
        connections: connectionSummaries.sort(compareConnections),
        models: models.map((model) => ({ ...model, available: usable })),
        credential,
      };
      if (matchesProjection(entry, context.projection)) providers.push(entry);
    }
    return {
      ...(loaded.selectedModel ? { selectedModel: loaded.selectedModel } : {}),
      catalogVersion: BUNDLED_PROVIDER_CATALOG_VERSION,
      revision: state.revision,
      ...(context.projection ? { projection: context.projection } : {}),
      providers: providers.sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  async authMethods(
    providerId: string,
    context: ProviderAuthContext,
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
    const binding = this.connectionBinding(
      providerId,
      loaded.configuredProviders[providerId],
      loaded.env,
    );
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
        methods: authMethodSummaries(descriptor.authMethods),
      },
    };
  }

  async submitSecret(input: {
    providerId: string;
    methodId: string;
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
    const binding = this.connectionBinding(
      input.providerId,
      loaded.configuredProviders[input.providerId],
      loaded.env,
      input.methodId,
    );
    if (!binding) {
      return {
        ok: false,
        message: `Provider "${input.providerId}" has no valid endpoint binding.`,
      };
    }
    const connectionId = `connection_${randomBytes(24).toString("base64url")}`;
    const timestamp = this.now().toISOString();
    const connection: StoredProviderConnection = {
      id: connectionId,
      binding,
      status: descriptor.validation.kind === "none" ? "unverified" : "ready",
      generation: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const store = this.getCredentialStore();
    await store.put(connectionId, input.secret);
    let state: ProviderConnectionStateFile;
    try {
      state = await this.modifyState((current) => {
        const scope = input.grantScope ?? "workspace";
        const grant: ConnectionGrant =
          scope === "user"
            ? { scope, connectionId }
            : {
                scope,
                workspaceId: loaded.workspaceId,
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
            [selectionKey(loaded.workspaceId, input.providerId)]: connectionId,
          },
          suppressions: current.suppressions.filter(
            (entry) =>
              !(
                entry.workspaceId === loaded.workspaceId &&
                entry.bindingFingerprint === binding.endpointFingerprint
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
        workspaceId: loaded.workspaceId,
        expectedBinding: binding,
      }),
      revision: state.revision,
    };
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
    const submitted = await this.submitSecret({
      providerId: input.providerId,
      methodId: input.methodId ?? "api_key",
      secret: input.secret,
      ...(input.grantScope ? { grantScope: input.grantScope } : {}),
      context: input.context,
    });
    if (!submitted.ok) return submitted;

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
    const expectedBinding = this.connectionBinding(
      stored.binding.providerId,
      loaded.configuredProviders[stored.binding.providerId],
      loaded.env,
      stored.binding.authMethodId,
    );
    if (
      input.action === "select" &&
      (!expectedBinding || !sameBinding(stored.binding, expectedBinding))
    ) {
      return {
        ok: false,
        message:
          "This connection is bound to a different provider endpoint. Create a new connection for the current endpoint.",
      };
    }

    if (input.action === "logout" || input.action === "remove") {
      const store = this.getCredentialStore();
      const secret = await store.get(stored.id);
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
      providerConfig = { npm: descriptor.npm };
      selection = {
        kind: "configured",
        providerKey: parsed.providerId,
        modelId: parsed.modelId,
        npm: descriptor.npm,
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
    const state = await this.readState();
    const selectedConnectionId =
      state.selections[selectionKey(context.workspaceId, parsed.providerId)];
    if (selectedConnectionId) {
      const connection = state.connections[selectedConnectionId];
      if (!connection) {
        return {
          ok: false,
          message: `Selected provider connection "${selectedConnectionId}" is unavailable; select or create another connection.`,
        };
      }
      if (!sameBinding(connection.binding, binding)) {
        return {
          ok: false,
          message:
            "The selected provider connection is bound to a different endpoint; no ambient credential fallback was attempted.",
        };
      }
      if (!hasConnectionGrant(state, connection.id, context.workspaceId)) {
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
      const apiKey = await this.getCredentialStore().get(connection.id);
      if (!apiKey) {
        return {
          ok: false,
          message: `Selected provider connection "${connection.id}" has no stored credential; no ambient credential fallback was attempted.`,
        };
      }
      const summary = storedConnectionSummary({
        connection,
        state,
        workspaceId: context.workspaceId,
        expectedBinding: binding,
      });
      return {
        ok: true,
        resolved: {
          selection,
          providerConfig,
          lease: {
            apiKey,
            connection: summary,
            profile: storedProfileSummary(connection, connection.status),
          },
        },
      };
    }

    const ambient = availableCredential({
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
      isSuppressed(state, context.workspaceId, binding.endpointFingerprint)
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
          apiKey: ambient.apiKey,
          profile: ambientProfileSummary({
            profileId,
            providerId: parsed.providerId,
            status: "ready",
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
                bindingFingerprint: binding.endpointFingerprint,
                updatedAt: updated.updatedAt,
              })
            : state.suppressions.filter(
                (entry) =>
                  !(
                    entry.workspaceId === loaded.workspaceId &&
                    entry.bindingFingerprint === binding.endpointFingerprint
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
            bindingFingerprint: binding.endpointFingerprint,
            updatedAt: timestamp,
          })
        : state.suppressions.filter(
            (entry) =>
              !(
                entry.workspaceId === loaded.workspaceId &&
                entry.bindingFingerprint === binding.endpointFingerprint
              ),
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
        status: suppress ? "suppressed" : "ready",
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
  ): ProviderConnectionBinding | undefined {
    const descriptor = getProviderConnectionDescriptor(providerId);
    if (!descriptor) return undefined;
    const npm = providerNpm(providerId, config);
    const npmInfo = SUPPORTED_PROVIDER_NPMS[npm];
    const environmentBaseURL = npmInfo?.baseUrlEnv
      ? nonEmpty(env[npmInfo.baseUrlEnv])
      : undefined;
    const endpoint =
      environmentBaseURL ?? config?.baseURL ?? descriptor.officialEndpoint;
    const normalizedEndpoint = normalizeProviderEndpoint(endpoint);
    const driverId =
      npm === descriptor.npm
        ? descriptor.driverId
        : `ai-sdk-custom.${createHash("sha256").update(npm).digest("hex").slice(0, 16)}`;
    const fingerprintInput = JSON.stringify({
      providerId,
      driverId,
      normalizedEndpoint,
      authMethodId,
    });
    return {
      providerId,
      driverId,
      normalizedEndpoint,
      endpointFingerprint: createHash("sha256")
        .update(fingerprintInput)
        .digest("hex"),
      authMethodId,
    };
  }

  private connectionSummaries(input: {
    state: ProviderConnectionStateFile;
    providerId: string;
    workspaceId: string;
    expectedBinding: ProviderConnectionBinding | undefined;
  }): ProviderConnectionSummary[] {
    return Object.values(input.state.connections)
      .filter(
        (connection) =>
          connection.binding.providerId === input.providerId &&
          hasConnectionGrant(input.state, connection.id, input.workspaceId),
      )
      .map((connection) =>
        storedConnectionSummary({
          connection,
          state: input.state,
          workspaceId: input.workspaceId,
          expectedBinding: input.expectedBinding,
        }),
      );
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

export function normalizeProviderEndpoint(endpoint: string): string {
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
    const baseUrlEnv = SUPPORTED_PROVIDER_NPMS[npm]?.baseUrlEnv;
    const environmentBaseURL = baseUrlEnv
      ? nonEmpty(env[baseUrlEnv])
      : undefined;
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
  npm: string;
  configuredApiKey?: string;
  env: Record<string, string | undefined>;
}): AmbientCredential | undefined {
  const npmInfo = SUPPORTED_PROVIDER_NPMS[input.npm];
  const envValue = npmInfo ? nonEmpty(input.env[npmInfo.apiKeyEnv]) : undefined;
  if (envValue && npmInfo) {
    return {
      apiKey: envValue,
      source: "environment",
      sourceLabel: `env:${npmInfo.apiKeyEnv}`,
    };
  }
  const configured = nonEmpty(input.configuredApiKey);
  return configured
    ? { apiKey: configured, source: "config", sourceLabel: "config" }
    : undefined;
}

function authMethodSummaries(
  methods: readonly {
    id: "api_key";
    kind: "api_key";
    environmentVariables: readonly string[];
  }[],
) {
  return methods.map((method) => ({
    id: method.id,
    type: method.kind,
    label: "API key",
    environmentVariables: [...method.environmentVariables],
  }));
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
    sameBinding(input.connection.binding, input.expectedBinding);
  const granted = hasConnectionGrant(
    input.state,
    input.connection.id,
    input.workspaceId,
  );
  const grantScope = input.state.grants.find(
    (grant) =>
      grant.connectionId === input.connection.id &&
      (grant.scope === "user" || grant.workspaceId === input.workspaceId),
  )?.scope;
  return {
    id: input.connection.id,
    providerId: input.connection.binding.providerId,
    status:
      bindingMatches && granted ? input.connection.status : ("failed" as const),
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
  return {
    providerId: binding.providerId,
    driverId: binding.driverId,
    endpoint: binding.normalizedEndpoint,
    endpointFingerprint: binding.endpointFingerprint,
    authMethodId: binding.authMethodId,
  };
}

function selectionKey(workspaceId: string, providerId: string): string {
  return `${workspaceId}:${providerId}`;
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
  bindingFingerprint: string,
): boolean {
  return state.suppressions.some(
    (entry) =>
      entry.workspaceId === workspaceId &&
      entry.bindingFingerprint === bindingFingerprint,
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

function sameBinding(
  left: ProviderConnectionBinding,
  right: ProviderConnectionBinding,
): boolean {
  return (
    left.endpointFingerprint === right.endpointFingerprint &&
    left.providerId === right.providerId &&
    left.driverId === right.driverId &&
    left.authMethodId === right.authMethodId
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

function validateSecret(secret: string): string | undefined {
  if (secret.length === 0) return "API key must not be empty.";
  if (Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) {
    return `API key exceeds the ${MAX_SECRET_BYTES}-byte limit.`;
  }
  if (
    [...secret].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
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
    typeof value.authMethodId === "string" &&
    (value.authRealm === undefined || typeof value.authRealm === "string") &&
    (value.accountSlot === undefined ||
      typeof value.accountSlot === "string") &&
    (value.tenant === undefined || typeof value.tenant === "string")
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
