import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunId, type ModelInput } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import { createModel } from "../src/model-factory.js";
import { ProviderAuthManager } from "../src/provider-auth.js";
import { MemoryProviderCredentialStore } from "../src/provider-credential-store.js";
import type { ProviderOAuthDriver } from "../src/provider-oauth.js";

describe("ProviderAuthManager", () => {
  it("projects all, connected, and available providers without exposing secrets", async () => {
    const fixture = await providerFixture("sk-projection-secret");
    try {
      const manager = new ProviderAuthManager({
        env: fixture.env,
        statePath: fixture.statePath,
      });

      const legacy = await manager.catalog({
        workspaceRoot: fixture.workspace,
      });
      expect(legacy.providers.map((provider) => provider.id)).toEqual([
        "openai",
      ]);

      const all = await manager.catalog({
        workspaceRoot: fixture.workspace,
        projection: "all",
      });
      expect(all).toMatchObject({
        catalogVersion: 3,
        projection: "all",
        catalogState: { generation: 0, source: "bundled", stale: false },
      });
      expect(all.providers.map((provider) => provider.id)).toEqual([
        "anthropic",
        "google",
        "openai",
        "openrouter",
      ]);
      expect(
        all.providers.find((provider) => provider.id === "openai"),
      ).toMatchObject({ configured: true, connected: true, available: true });
      expect(
        all.providers.find((provider) => provider.id === "google"),
      ).toMatchObject({
        configured: false,
        connected: false,
        available: false,
      });

      const connected = await manager.catalog({
        workspaceRoot: fixture.workspace,
        projection: "connected",
      });
      expect(connected.providers.map((provider) => provider.id)).toEqual([
        "openai",
      ]);

      const available = await manager.catalog({
        workspaceRoot: fixture.workspace,
        projection: "available",
      });
      expect(available.providers.map((provider) => provider.id)).toEqual([
        "openai",
      ]);
      expect(JSON.stringify({ all, connected, available })).not.toContain(
        "sk-projection-secret",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("projects a non-secret catalog and persists login state by opaque profile", async () => {
    const fixture = await providerFixture("sk-catalog-secret");
    try {
      const manager = new ProviderAuthManager({
        env: fixture.env,
        statePath: fixture.statePath,
        now: () => new Date("2026-08-08T00:00:00.000Z"),
      });
      const initial = await manager.catalog({
        workspaceRoot: fixture.workspace,
      });
      expect(initial.selectedModel).toBe("openai/gpt-test");
      expect(initial.providers).toHaveLength(1);
      expect(initial.providers[0]).toMatchObject({
        id: "openai",
        models: [{ ref: "openai/gpt-test", selected: true }],
        credential: {
          id: expect.stringMatching(/^credential_[a-f0-9]{20}$/),
          providerId: "openai",
          status: "ready",
          source: "config",
          generation: 0,
        },
      });
      expect(JSON.stringify(initial)).not.toContain("sk-catalog-secret");

      const profileId = initial.providers[0]!.credential.id;
      const loggedOut = await manager.act("logout", profileId, {
        workspaceRoot: fixture.workspace,
      });
      expect(loggedOut).toMatchObject({
        ok: true,
        profile: { status: "logged_out", generation: 1 },
      });

      const restarted = new ProviderAuthManager({
        env: fixture.env,
        statePath: fixture.statePath,
      });
      const persisted = await restarted.catalog({
        workspaceRoot: fixture.workspace,
      });
      expect(persisted.providers[0]!.credential).toMatchObject({
        status: "logged_out",
        generation: 1,
      });
      expect(await readFile(fixture.statePath, "utf8")).not.toContain(
        "sk-catalog-secret",
      );

      const loggedIn = await restarted.act("login", profileId, {
        workspaceRoot: fixture.workspace,
      });
      expect(loggedIn).toMatchObject({
        ok: true,
        profile: { status: "ready", generation: 2 },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects login when the profile has no available credential", async () => {
    const fixture = await providerFixture(undefined);
    try {
      const manager = new ProviderAuthManager({
        env: fixture.env,
        statePath: fixture.statePath,
      });
      const catalog = await manager.catalog({
        workspaceRoot: fixture.workspace,
      });
      expect(catalog.providers[0]!.credential.status).toBe("missing");
      await expect(
        manager.act("login", catalog.providers[0]!.credential.id, {
          workspaceRoot: fixture.workspace,
        }),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining("no configured credential"),
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("wakes an active credential resolver and replaces its adapter generation", async () => {
    const fixture = await providerFixture("sk-old");
    const provider = await providerMock();
    try {
      await writeProviderConfig(fixture.workspace, "sk-old", provider.baseURL);
      const manager = new ProviderAuthManager({
        env: fixture.env,
        statePath: fixture.statePath,
      });
      const created = await createModel({
        workspaceRoot: fixture.workspace,
        goal: "refresh provider",
        env: fixture.env,
        providerAuth: manager,
        waitForCredentialRefresh: true,
      });
      expect(created.ok).toBe(true);
      if (!created.ok || !created.credentialResolver) return;

      await expect(
        created.adapter.complete(modelInput()),
      ).rejects.toBeDefined();
      expect(provider.authorizations).toEqual(["Bearer sk-old"]);

      const catalog = await manager.catalog({
        workspaceRoot: fixture.workspace,
      });
      const profileId = catalog.providers[0]!.credential.id;
      const waiting = created.credentialResolver({
        category: "auth",
        message: "invalid key",
        modelError: {
          category: "auth",
          message: "invalid key",
          retryable: false,
        },
        attempt: 1,
      });
      await writeProviderConfig(fixture.workspace, "sk-new", provider.baseURL);
      const refreshed = await manager.act("refresh", profileId, {
        workspaceRoot: fixture.workspace,
      });
      expect(refreshed).toMatchObject({
        ok: true,
        profile: { generation: 1, status: "ready" },
      });
      await expect(waiting).resolves.toMatchObject({
        refreshed: true,
        metadata: {
          credentialProfileId: profileId,
          credentialGeneration: 1,
        },
      });
      await expect(
        created.adapter.complete(modelInput()),
      ).rejects.toBeDefined();
      expect(provider.authorizations).toEqual([
        "Bearer sk-old",
        "Bearer sk-new",
      ]);
    } finally {
      await provider.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps non-interactive model construction fail-fast", async () => {
    const fixture = await providerFixture("sk-fail-fast");
    try {
      const created = await createModel({
        workspaceRoot: fixture.workspace,
        goal: "ordinary cli run",
        env: fixture.env,
        providerAuth: new ProviderAuthManager({
          env: fixture.env,
          statePath: fixture.statePath,
        }),
      });
      expect(created.ok).toBe(true);
      if (created.ok) expect(created.credentialResolver).toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("cancels a credential wait without changing auth state", async () => {
    const fixture = await providerFixture("sk-cancel");
    try {
      const manager = new ProviderAuthManager({
        env: fixture.env,
        statePath: fixture.statePath,
      });
      const catalog = await manager.catalog({
        workspaceRoot: fixture.workspace,
      });
      const controller = new AbortController();
      const waiting = manager.waitForGenerationChange({
        profileId: catalog.providers[0]!.credential.id,
        generation: 0,
        signal: controller.signal,
      });
      controller.abort();
      await expect(waiting).resolves.toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("connects a clean workspace without writing config and resolves a catalog model", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-provider-connect-"));
    const workspace = join(root, "workspace");
    const statePath = join(root, "state", "auth.json");
    const secret = "sentinel-clean-connect-key";
    await mkdir(workspace, { recursive: true });
    const credentialStore = new MemoryProviderCredentialStore();
    const manager = new ProviderAuthManager({
      env: { XDG_CONFIG_HOME: join(root, "config") },
      statePath,
      credentialStore,
    });
    try {
      const connected = await manager.submitSecret({
        providerId: "openai",
        methodId: "api_key",
        secret,
        context: { workspaceRoot: workspace },
      });
      expect(connected).toMatchObject({
        ok: true,
        connection: {
          providerId: "openai",
          status: "unverified",
          source: "stored",
          grantScope: "workspace",
          selected: true,
        },
        revision: 1,
      });
      const catalog = await manager.catalog({
        workspaceRoot: workspace,
        projection: "available",
        model: "openai/gpt-5.4-mini",
      });
      expect(catalog.providers).toMatchObject([
        {
          id: "openai",
          configured: false,
          connected: true,
          available: true,
          credential: { source: "stored", status: "unverified" },
        },
      ]);
      expect(JSON.stringify(catalog)).not.toContain(secret);
      expect(await readFile(statePath, "utf8")).not.toContain(secret);
      await expect(
        readFile(join(workspace, ".sparkwright", "config.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const created = await createModel({
        workspaceRoot: workspace,
        goal: "use stored provider connection",
        modelRef: "openai/gpt-5.4-mini",
        env: { XDG_CONFIG_HOME: join(root, "config") },
        providerAuth: manager,
      });
      expect(created).toMatchObject({
        ok: true,
        resolved: { authSource: expect.stringContaining("stored:") },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("observes cross-manager mutations and serializes concurrent connection writes", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sparkwright-provider-concurrent-"),
    );
    const workspace = join(root, "workspace");
    const statePath = join(root, "state", "auth.json");
    await mkdir(workspace, { recursive: true });
    const credentialStore = new MemoryProviderCredentialStore();
    const env = { XDG_CONFIG_HOME: join(root, "config") };
    const first = new ProviderAuthManager({ env, statePath, credentialStore });
    const second = new ProviderAuthManager({ env, statePath, credentialStore });
    try {
      const [one, two] = await Promise.all([
        first.submitSecret({
          providerId: "openai",
          methodId: "api_key",
          secret: "concurrent-key-one",
          context: { workspaceRoot: workspace },
        }),
        second.submitSecret({
          providerId: "openai",
          methodId: "api_key",
          secret: "concurrent-key-two",
          context: { workspaceRoot: workspace },
        }),
      ]);
      expect(one.ok && two.ok).toBe(true);
      if (!one.ok || !two.ok) return;

      const before = await first.catalog({
        workspaceRoot: workspace,
        projection: "all",
      });
      expect(before.revision).toBe(2);
      expect(
        before.providers.find((provider) => provider.id === "openai")
          ?.connections,
      ).toHaveLength(2);

      const waiting = first.waitForGenerationChange({
        profileId: one.connection.id,
        generation: one.connection.generation,
        timeoutMs: 2_000,
      });
      await second.manageConnection({
        action: "refresh",
        connectionId: one.connection.id,
        context: { workspaceRoot: workspace },
      });
      await expect(waiting).resolves.toBe(true);

      await Promise.all([
        first.manageConnection({
          action: "refresh",
          connectionId: one.connection.id,
          context: { workspaceRoot: workspace },
        }),
        second.manageConnection({
          action: "remove",
          connectionId: two.connection.id,
          context: { workspaceRoot: workspace },
        }),
      ]);
      const after = await second.catalog({
        workspaceRoot: workspace,
        projection: "all",
      });
      expect(after.revision).toBe(5);
      expect(
        after.providers.find((provider) => provider.id === "openai")
          ?.connections,
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes authenticated model discovery and keeps its last-known-good catalog on failure", async () => {
    const fixture = await cleanProviderFixture("catalog-discovery");
    const credentialStore = new MemoryProviderCredentialStore();
    const secret = "catalog-discovery-secret";
    const authorizations: string[] = [];
    const manager = new ProviderAuthManager({
      env: fixture.env,
      statePath: fixture.statePath,
      credentialStore,
      catalogFetch: async (_url, init) => {
        authorizations.push(
          new Headers(init?.headers).get("authorization") ?? "",
        );
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "vendor/new-model",
                name: "New Model",
                context_length: 128_000,
                pricing: { prompt: "0.000001", completion: "0.000002" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });
    try {
      await manager.submitSecret({
        providerId: "openrouter",
        methodId: "api_key",
        secret,
        context: { workspaceRoot: fixture.workspace },
      });
      const refreshed = await manager.refreshCatalog({
        providerId: "openrouter",
        context: { workspaceRoot: fixture.workspace },
      });
      expect(refreshed).toMatchObject({
        ok: true,
        result: {
          status: "updated",
          refreshedProviders: ["openrouter"],
          catalogState: { generation: 1, source: "discovery", stale: false },
        },
      });
      expect(authorizations).toEqual([`Bearer ${secret}`]);

      const catalog = await manager.catalog({
        workspaceRoot: fixture.workspace,
        projection: "available",
      });
      expect(catalog.catalogState).toMatchObject({
        generation: 1,
        source: "discovery",
      });
      expect(catalog.providers[0]?.models).toEqual([
        expect.objectContaining({
          ref: "openrouter/vendor/new-model",
          available: true,
        }),
      ]);
      expect(JSON.stringify({ refreshed, catalog })).not.toContain(secret);

      const failing = new ProviderAuthManager({
        env: fixture.env,
        statePath: fixture.statePath,
        credentialStore,
        catalogFetch: async () => {
          throw new Error(`network failed for ${secret}`);
        },
      });
      await expect(
        failing.refreshCatalog({
          providerId: "openrouter",
          context: { workspaceRoot: fixture.workspace },
        }),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining("last-known-good"),
      });
      const retained = await failing.catalog({
        workspaceRoot: fixture.workspace,
        projection: "available",
      });
      expect(retained.catalogState?.generation).toBe(1);
      expect(retained.providers[0]?.models[0]?.ref).toBe(
        "openrouter/vendor/new-model",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("binds stored credentials to the exact endpoint and never falls back to env", async () => {
    const fixture = await providerFixture(undefined);
    const credentialStore = new MemoryProviderCredentialStore();
    const env = {
      ...fixture.env,
      OPENAI_API_KEY: "ambient-key-must-not-be-used",
    };
    const manager = new ProviderAuthManager({
      env,
      statePath: fixture.statePath,
      credentialStore,
    });
    try {
      const connected = await manager.submitSecret({
        providerId: "openai",
        methodId: "api_key",
        secret: "stored-exact-binding-key",
        context: { workspaceRoot: fixture.workspace },
      });
      expect(connected.ok).toBe(true);
      if (!connected.ok) return;

      await writeProviderConfig(
        fixture.workspace,
        undefined,
        "https://malicious.example/v1",
      );
      const changedEndpoint = await manager.resolveModelConnection({
        workspaceRoot: fixture.workspace,
        modelRef: "openai/gpt-test",
        env,
      });
      expect(changedEndpoint).toMatchObject({
        ok: false,
        message: expect.stringContaining("different endpoint"),
      });
      expect(JSON.stringify(changedEndpoint)).not.toContain(
        "ambient-key-must-not-be-used",
      );

      await writeProviderConfig(fixture.workspace, undefined);
      await credentialStore.remove(connected.connection.id);
      const missingStoredSecret = await manager.resolveModelConnection({
        workspaceRoot: fixture.workspace,
        modelRef: "openai/gpt-test",
        env,
      });
      expect(missingStoredSecret).toMatchObject({
        ok: false,
        message: expect.stringContaining("no stored credential"),
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("suppresses an ambient binding without claiming the environment was deleted", async () => {
    const fixture = await providerFixture(undefined);
    const env = { ...fixture.env, OPENAI_API_KEY: "ambient-suppression-key" };
    const manager = new ProviderAuthManager({
      env,
      statePath: fixture.statePath,
    });
    try {
      const catalog = await manager.catalog({
        workspaceRoot: fixture.workspace,
      });
      const connection = catalog.providers[0]!.connections![0]!;
      const disconnected = await manager.manageConnection({
        action: "disconnect",
        connectionId: connection.id,
        context: { workspaceRoot: fixture.workspace },
      });
      expect(disconnected).toMatchObject({
        ok: true,
        connection: { status: "suppressed", source: "environment" },
      });
      expect(env.OPENAI_API_KEY).toBe("ambient-suppression-key");
      await expect(
        manager.resolveModelConnection({
          workspaceRoot: fixture.workspace,
          modelRef: "openai/gpt-test",
          env,
        }),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining("disconnected"),
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rolls back a migrated secret when legacy config publication fails", async () => {
    const secret = "legacy-migration-sentinel";
    const fixture = await providerFixture(secret);
    const manager = new ProviderAuthManager({
      env: fixture.env,
      statePath: fixture.statePath,
      credentialStore: new MemoryProviderCredentialStore(),
    });
    const configPath = join(fixture.workspace, ".sparkwright", "config.json");
    const originalConfig = await readFile(configPath, "utf8");
    try {
      const migrated = await manager.migrateLegacyApiKey({
        providerId: "openai",
        secret,
        context: { workspaceRoot: fixture.workspace },
        publishConfig: async () => {
          expect(await readFile(configPath, "utf8")).toBe(originalConfig);
          throw new Error(`publication failed for ${secret}`);
        },
      });

      expect(migrated).toMatchObject({
        ok: false,
        message: expect.stringContaining("rolled back"),
      });
      expect(JSON.stringify(migrated)).not.toContain(secret);
      expect(await readFile(configPath, "utf8")).toBe(originalConfig);
      const catalog = await manager.catalog({
        workspaceRoot: fixture.workspace,
        projection: "all",
      });
      expect(
        catalog.providers.find((provider) => provider.id === "openai")
          ?.connections,
      ).toHaveLength(1);
      expect(
        catalog.providers.find((provider) => provider.id === "openai")
          ?.connections?.[0],
      ).toMatchObject({ source: "config" });
      expect(await readFile(fixture.statePath, "utf8")).not.toContain(secret);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("binds OAuth attempts to the initiating principal and rejects state mismatch and replay", async () => {
    const fixture = await cleanProviderFixture("oauth-attempt");
    const credentialStore = new MemoryProviderCredentialStore();
    const driver = fakeOAuthDriver();
    const manager = new ProviderAuthManager({
      env: fixture.env,
      statePath: fixture.statePath,
      credentialStore,
      oauthDrivers: [driver],
    });
    const owner = oauthContext(
      fixture.workspace,
      "principal-one",
      "client-one",
    );
    try {
      const started = await manager.beginOAuth({
        providerId: "openrouter",
        methodId: "oauth_pkce",
        context: owner,
      });
      expect(started).toMatchObject({
        ok: true,
        attempt: {
          providerId: "openrouter",
          flow: "browser",
          status: "pending",
        },
      });
      if (!started.ok) return;
      const state = new URL(started.attempt.authorizationUrl!).searchParams.get(
        "state",
      )!;

      await expect(
        manager.oauthStatus({
          attemptId: started.attempt.id,
          context: oauthContext(
            fixture.workspace,
            "principal-two",
            "client-one",
          ),
        }),
      ).resolves.toMatchObject({ ok: false });
      await expect(
        manager.completeOAuth({
          attemptId: started.attempt.id,
          proof: { code: "valid-code", state: "wrong-state" },
          context: owner,
        }),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining("state"),
      });

      const completed = await manager.completeOAuth({
        attemptId: started.attempt.id,
        proof: { code: "valid-code", state },
        context: owner,
      });
      expect(completed).toMatchObject({
        ok: true,
        attempt: {
          status: "completed",
          connection: {
            providerId: "openrouter",
            binding: { authMethodId: "oauth_pkce" },
            selected: true,
          },
        },
      });
      await expect(
        manager.completeOAuth({
          attemptId: started.attempt.id,
          proof: { code: "valid-code", state },
          context: owner,
        }),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining("consumed"),
      });
      expect(await readFile(fixture.statePath, "utf8")).not.toContain(
        "oauth-access-token",
      );
      await expect(
        manager.resolveModelConnection({
          workspaceRoot: fixture.workspace,
          modelRef: "openrouter/openrouter/auto",
          env: fixture.env,
        }),
      ).resolves.toMatchObject({
        ok: true,
        resolved: { lease: { apiKey: "oauth-access-token" } },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("removes temporary OAuth state on cancellation and expiry", async () => {
    const fixture = await cleanProviderFixture("oauth-terminal");
    let now = new Date("2026-08-09T00:00:00.000Z");
    const manager = new ProviderAuthManager({
      env: fixture.env,
      statePath: fixture.statePath,
      credentialStore: new MemoryProviderCredentialStore(),
      oauthDrivers: [fakeOAuthDriver()],
      oauthAttemptTtlMs: 1_000,
      now: () => now,
    });
    const context = oauthContext(fixture.workspace, "principal", "client");
    try {
      const cancelled = await manager.beginOAuth({
        providerId: "openrouter",
        methodId: "oauth_pkce",
        context,
      });
      if (!cancelled.ok) return;
      const cancelledResult = await manager.cancelOAuth({
        attemptId: cancelled.attempt.id,
        context,
      });
      expect(cancelledResult).toMatchObject({
        ok: true,
        attempt: { status: "cancelled" },
      });
      if (cancelledResult.ok) {
        expect(cancelledResult.attempt).not.toHaveProperty("authorizationUrl");
      }

      const expiring = await manager.beginOAuth({
        providerId: "openrouter",
        methodId: "oauth_pkce",
        context,
      });
      if (!expiring.ok) return;
      now = new Date("2026-08-09T00:00:02.000Z");
      const expiredResult = await manager.oauthStatus({
        attemptId: expiring.attempt.id,
        context,
      });
      expect(expiredResult).toMatchObject({
        ok: true,
        attempt: { status: "expired" },
      });
      if (expiredResult.ok) {
        expect(expiredResult.attempt).not.toHaveProperty("authorizationUrl");
      }
      const catalog = await manager.catalog({
        workspaceRoot: fixture.workspace,
        projection: "all",
      });
      expect(
        catalog.providers.find((provider) => provider.id === "openrouter")
          ?.connections,
      ).toHaveLength(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("single-flights OAuth refresh and never falls back to an ambient key after failure", async () => {
    const fixture = await cleanProviderFixture("oauth-refresh");
    const credentialStore = new MemoryProviderCredentialStore();
    let refreshCount = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolveGate) => {
      releaseRefresh = resolveGate;
    });
    const driver = fakeOAuthDriver({
      refresh: async (credential) => {
        refreshCount += 1;
        await refreshGate;
        return { ...credential, accessToken: "oauth-refreshed-token" };
      },
    });
    const first = new ProviderAuthManager({
      env: fixture.env,
      statePath: fixture.statePath,
      credentialStore,
      oauthDrivers: [driver],
    });
    const second = new ProviderAuthManager({
      env: fixture.env,
      statePath: fixture.statePath,
      credentialStore,
      oauthDrivers: [driver],
    });
    const context = oauthContext(fixture.workspace, "principal", "client");
    try {
      const connection = await connectFakeOAuth(first, context);
      const one = first.manageConnection({
        action: "refresh",
        connectionId: connection.id,
        context: { workspaceRoot: fixture.workspace },
      });
      const two = second.manageConnection({
        action: "refresh",
        connectionId: connection.id,
        context: { workspaceRoot: fixture.workspace },
      });
      while (refreshCount === 0) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      releaseRefresh();
      const [firstResult, secondResult] = await Promise.all([one, two]);
      expect(refreshCount).toBe(1);
      expect(firstResult).toMatchObject({ ok: true });
      expect(secondResult).toMatchObject({ ok: true });
      if (firstResult.ok && secondResult.ok) {
        expect(firstResult.revision).toBe(secondResult.revision);
        expect(firstResult.connection?.generation).toBe(
          secondResult.connection?.generation,
        );
      }

      const failingDriver = fakeOAuthDriver({
        refresh: async () => {
          throw new Error("token refresh sentinel");
        },
      });
      const failing = new ProviderAuthManager({
        env: {
          ...fixture.env,
          OPENROUTER_API_KEY: "ambient-key-must-not-win",
        },
        statePath: fixture.statePath,
        credentialStore,
        oauthDrivers: [failingDriver],
      });
      await expect(
        failing.manageConnection({
          action: "refresh",
          connectionId: connection.id,
          context: { workspaceRoot: fixture.workspace },
        }),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining("no ambient credential"),
      });
      await expect(
        failing.resolveModelConnection({
          workspaceRoot: fixture.workspace,
          modelRef: "openrouter/openrouter/auto",
        }),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining("needs_refresh"),
      });
    } finally {
      releaseRefresh();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function cleanProviderFixture(label: string): Promise<{
  root: string;
  workspace: string;
  statePath: string;
  env: Record<string, string | undefined>;
}> {
  const root = await mkdtemp(join(tmpdir(), `sparkwright-${label}-`));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return {
    root,
    workspace,
    statePath: join(root, "state", "auth.json"),
    env: { XDG_CONFIG_HOME: join(root, "config") },
  };
}

function oauthContext(
  workspaceRoot: string,
  principalId: string,
  clientConnectionId: string,
) {
  return { workspaceRoot, principalId, clientConnectionId };
}

function fakeOAuthDriver(
  input: {
    refresh?: NonNullable<ProviderOAuthDriver["refresh"]>;
  } = {},
): ProviderOAuthDriver {
  return {
    implementationId: "openrouter.pkce-key.v1",
    issuer: "https://openrouter.ai",
    async begin(begin) {
      return {
        presentation: {
          flow: "browser",
          authorizationUrl: `https://auth.example/authorize?state=${begin.state}`,
        },
      };
    },
    async complete() {
      return {
        accessToken: "oauth-access-token",
        refreshToken: "oauth-refresh-token",
      };
    },
    refresh:
      input.refresh ??
      (async ({ credential }) => ({
        ...credential,
        accessToken: "oauth-refreshed-token",
      })),
  };
}

async function connectFakeOAuth(
  manager: ProviderAuthManager,
  context: ReturnType<typeof oauthContext>,
) {
  const started = await manager.beginOAuth({
    providerId: "openrouter",
    methodId: "oauth_pkce",
    context,
  });
  if (!started.ok) throw new Error(started.message);
  const state = new URL(started.attempt.authorizationUrl!).searchParams.get(
    "state",
  )!;
  const completed = await manager.completeOAuth({
    attemptId: started.attempt.id,
    proof: { code: "valid-code", state },
    context,
  });
  if (!completed.ok || !completed.attempt.connection) {
    throw new Error(completed.ok ? "missing connection" : completed.message);
  }
  return completed.attempt.connection;
}

async function providerFixture(apiKey: string | undefined): Promise<{
  root: string;
  workspace: string;
  statePath: string;
  env: Record<string, string | undefined>;
}> {
  const root = await mkdtemp(join(tmpdir(), "sparkwright-provider-auth-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".sparkwright"), { recursive: true });
  await writeProviderConfig(workspace, apiKey);
  return {
    root,
    workspace,
    statePath: join(root, "state", "auth.json"),
    env: { XDG_CONFIG_HOME: join(root, "config") },
  };
}

async function writeProviderConfig(
  workspace: string,
  apiKey: string | undefined,
  baseURL?: string,
): Promise<void> {
  await writeFile(
    join(workspace, ".sparkwright", "config.json"),
    JSON.stringify({
      identity: {
        model: "openai/gpt-test",
        providers: {
          openai: {
            ...(apiKey ? { apiKey } : {}),
            ...(baseURL ? { baseURL } : {}),
            models: { "gpt-test": {} },
          },
        },
      },
    }),
    "utf8",
  );
}

function modelInput(): ModelInput {
  const now = "2026-08-08T00:00:00.000Z";
  return {
    run: {
      id: createRunId(),
      goal: "refresh provider",
      state: "running",
      createdAt: now,
      updatedAt: now,
      metadata: {},
    },
    context: [],
    tools: [],
    events: [],
    step: 1,
  };
}

async function providerMock(): Promise<{
  baseURL: string;
  authorizations: string[];
  close(): Promise<void>;
}> {
  const authorizations: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      authorizations.push(
        typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : "",
      );
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "test credential rejected" } }),
      );
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    authorizations,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  };
}
