import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type HostMessage } from "@sparkwright/protocol";
import { describe, expect, it } from "vitest";
import {
  authenticatedConnection,
  unauthenticatedConnection,
  type Connection,
} from "../src/connection.js";
import { createHostService } from "../src/host-service.js";
import { ProviderAuthManager } from "../src/provider-auth.js";
import {
  MemoryProviderCredentialStore,
  type ProviderCredentialStore,
} from "../src/provider-credential-store.js";
import { serveConnection } from "../src/server.js";
import type { ProviderOAuthDriver } from "../src/provider-oauth.js";

describe("provider protocol", () => {
  it("lists only non-secret profiles and lets a local client change auth state", async () => {
    const fixture = await protocolFixture();
    const pair = connectionPair();
    try {
      const service = createHostService({
        providerAuth: new ProviderAuthManager({
          env: fixture.env,
          statePath: fixture.statePath,
        }),
      });
      serveConnection(pair.hostSide, {
        hostService: service,
        workspaceRoot: fixture.workspace,
        authContext: unauthenticatedConnection("local-stdio", [
          "provider_auth.manage",
        ]),
      });
      await handshake(pair);

      pair.send(request("provider_list", "provider.list", {}));
      const listed = await pair.waitFor("provider_list");
      expect(listed).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          providers: [
            {
              id: "openai",
              credential: { status: "unverified", source: "config" },
            },
          ],
        },
      });
      expect(JSON.stringify(listed)).not.toContain("sk-protocol-secret");
      if (listed.envelope !== "response" || !listed.ok) return;

      pair.send(
        request("provider_list_all", "provider.list", { projection: "all" }),
      );
      await expect(pair.waitFor("provider_list_all")).resolves.toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          catalogVersion: 6,
          projection: "all",
          providers: [
            { id: "anthropic", configured: false },
            { id: "chatgpt", configured: false },
            { id: "google", configured: false },
            { id: "openai", configured: true },
            { id: "openrouter", configured: false },
          ],
        },
      });

      const providers = listed.result.providers as Array<{
        credential: { id: string };
      }>;
      const profileId = providers[0]!.credential.id;

      pair.send(
        request("provider_logout", "provider.auth.logout", { profileId }),
      );
      await expect(pair.waitFor("provider_logout")).resolves.toMatchObject({
        envelope: "response",
        ok: true,
        result: { profile: { status: "logged_out", generation: 1 } },
      });
    } finally {
      pair.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects provider auth mutation from a remote bearer connection", async () => {
    const fixture = await protocolFixture();
    const pair = connectionPair();
    try {
      const service = createHostService({
        providerAuth: new ProviderAuthManager({
          env: fixture.env,
          statePath: fixture.statePath,
        }),
      });
      serveConnection(pair.hostSide, {
        hostService: service,
        workspaceRoot: fixture.workspace,
        authContext: authenticatedConnection("remote", "ws-bearer"),
      });
      await handshake(pair);
      pair.send(
        request("provider_login", "provider.auth.login", {
          profileId: "credential_not_authorized",
        }),
      );
      await expect(pair.waitFor("provider_login")).resolves.toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "unauthorized" },
      });
    } finally {
      pair.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("refreshes catalog state for a trusted local client only", async () => {
    const fixture = await protocolFixture();
    const local = connectionPair();
    const remote = connectionPair();
    try {
      const service = createHostService({
        providerAuth: new ProviderAuthManager({
          env: fixture.env,
          statePath: fixture.statePath,
        }),
      });
      serveConnection(local.hostSide, {
        hostService: service,
        workspaceRoot: fixture.workspace,
        authContext: unauthenticatedConnection(
          "local-stdio",
          ["provider_connection.manage"],
          "local",
        ),
      });
      await handshake(local);
      local.send(request("catalog_refresh", "provider.catalog.refresh", {}));
      await expect(local.waitFor("catalog_refresh")).resolves.toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          status: "unchanged",
          refreshedProviders: [],
          catalogState: { generation: 0, source: "bundled", stale: false },
        },
      });

      serveConnection(remote.hostSide, {
        hostService: service,
        workspaceRoot: fixture.workspace,
        authContext: authenticatedConnection(
          "remote",
          "ws-bearer",
          "host_client",
          ["provider_connection.manage"],
          "remote",
        ),
      });
      await handshake(remote);
      remote.send(
        request("remote_catalog_refresh", "provider.catalog.refresh", {}),
      );
      await expect(
        remote.waitFor("remote_catalog_refresh"),
      ).resolves.toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "unauthorized" },
      });
    } finally {
      local.close();
      remote.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts a local secret without returning or persisting it as metadata", async () => {
    const fixture = await protocolFixture();
    const pair = connectionPair();
    const secret = "sk-protocol-submit-sentinel";
    try {
      const service = createHostService({
        providerAuth: new ProviderAuthManager({
          env: fixture.env,
          statePath: fixture.statePath,
          credentialStore: new MemoryProviderCredentialStore(),
        }),
      });
      serveConnection(pair.hostSide, {
        hostService: service,
        workspaceRoot: fixture.workspace,
        authContext: unauthenticatedConnection(
          "local-stdio",
          [
            "provider_catalog.read",
            "provider_connection.manage",
            "provider_secret.submit",
          ],
          "local",
        ),
      });
      await handshake(pair);

      pair.send(
        request("provider_methods", "provider.auth.methods", {
          providerId: "openai",
        }),
      );
      await expect(pair.waitFor("provider_methods")).resolves.toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          providerId: "openai",
          methods: [{ id: "api_key", type: "api_key" }],
        },
      });

      pair.send(
        request("provider_custom_methods", "provider.auth.methods", {
          providerId: "openai",
          endpoint: "https://gateway.example/v1/",
        }),
      );
      await expect(
        pair.waitFor("provider_custom_methods"),
      ).resolves.toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          binding: { endpoint: "https://gateway.example/v1" },
          methods: [{ id: "api_key", type: "api_key" }],
        },
      });

      pair.send(
        request("provider_submit", "provider.auth.submit_secret", {
          providerId: "openai",
          methodId: "api_key",
          endpoint: "https://gateway.example/v1",
          secret,
        }),
      );
      const submitted = await pair.waitFor("provider_submit");
      expect(submitted).toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          connection: {
            providerId: "openai",
            source: "stored",
            selected: true,
            binding: { endpoint: "https://gateway.example/v1" },
          },
        },
      });
      expect(JSON.stringify(pair.messages())).not.toContain(secret);
      expect(await readFile(fixture.statePath, "utf8")).not.toContain(secret);
    } finally {
      pair.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("shows disconnected stored connections only to trusted local managers", async () => {
    const fixture = await protocolFixture();
    const local = connectionPair();
    const remote = connectionPair();
    const credentialStore = new MemoryProviderCredentialStore();
    const service = createHostService({
      providerAuth: new ProviderAuthManager({
        env: fixture.env,
        statePath: fixture.statePath,
        credentialStore,
      }),
    });
    try {
      serveConnection(local.hostSide, {
        hostService: service,
        workspaceRoot: fixture.workspace,
        authContext: unauthenticatedConnection(
          "local-stdio",
          [
            "provider_catalog.read",
            "provider_connection.manage",
            "provider_secret.submit",
          ],
          "local",
        ),
      });
      await handshake(local);
      local.send(
        request("local_submit", "provider.auth.submit_secret", {
          providerId: "openai",
          methodId: "api_key",
          secret: "local-manager-visibility-sentinel",
        }),
      );
      const submitted = await local.waitFor("local_submit");
      expect(submitted).toMatchObject({
        envelope: "response",
        ok: true,
        result: { connection: { source: "stored", selected: true } },
      });
      if (submitted.envelope !== "response" || !submitted.ok) return;
      const connectionId = (submitted.result.connection as { id: string }).id;

      local.send(
        request("local_disconnect", "provider.connection.disconnect", {
          connectionId,
        }),
      );
      await expect(local.waitFor("local_disconnect")).resolves.toMatchObject({
        envelope: "response",
        ok: true,
      });
      local.send(
        request("local_list_disconnected", "provider.list", {
          projection: "all",
        }),
      );
      const localList = await local.waitFor("local_list_disconnected");
      expect(JSON.stringify(localList)).toContain(connectionId);
      expect(JSON.stringify(localList)).not.toContain(
        "local-manager-visibility-sentinel",
      );

      serveConnection(remote.hostSide, {
        hostService: service,
        workspaceRoot: fixture.workspace,
        authContext: authenticatedConnection(
          "remote",
          "ws-bearer",
          "host_client",
          ["provider_catalog.read", "provider_connection.manage"],
          "remote",
        ),
      });
      await handshake(remote);
      remote.send(
        request("remote_list_disconnected", "provider.list", {
          projection: "all",
        }),
      );
      const remoteList = await remote.waitFor("remote_list_disconnected");
      expect(JSON.stringify(remoteList)).not.toContain(connectionId);
      expect(await credentialStore.get(connectionId)).toBe(
        "local-manager-visibility-sentinel",
      );
    } finally {
      local.close();
      remote.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("completes a principal-bound OAuth attempt once without exposing credentials", async () => {
    const fixture = await protocolFixture();
    const pair = connectionPair();
    const token = "oauth-protocol-token-sentinel";
    const oauthDriver: ProviderOAuthDriver = {
      implementationId: "openrouter.pkce-key.v1",
      issuer: "https://openrouter.ai",
      async begin(input) {
        return {
          presentation: {
            flow: "browser",
            authorizationUrl: `https://auth.example/?state=${input.state}`,
          },
        };
      },
      async complete() {
        return { accessToken: token, refreshToken: "refresh-sentinel" };
      },
    };
    try {
      const service = createHostService({
        providerAuth: new ProviderAuthManager({
          env: fixture.env,
          statePath: fixture.statePath,
          credentialStore: new MemoryProviderCredentialStore(),
          oauthDrivers: [oauthDriver],
        }),
      });
      serveConnection(pair.hostSide, {
        hostService: service,
        workspaceRoot: fixture.workspace,
        authContext: unauthenticatedConnection(
          "local-stdio",
          ["provider_catalog.read", "provider_connection.manage"],
          "local",
        ),
      });
      await handshake(pair);
      pair.send(
        request("oauth_begin", "provider.auth.begin", {
          providerId: "openrouter",
          methodId: "oauth_pkce",
        }),
      );
      const begun = await pair.waitFor("oauth_begin");
      expect(begun).toMatchObject({
        envelope: "response",
        ok: true,
        result: { attempt: { status: "pending", flow: "browser" } },
      });
      if (begun.envelope !== "response" || !begun.ok) return;
      const attempt = begun.result.attempt as {
        id: string;
        authorizationUrl: string;
      };
      const state = new URL(attempt.authorizationUrl).searchParams.get("state");

      pair.send(
        request("oauth_wrong_state", "provider.auth.complete", {
          attemptId: attempt.id,
          code: "authorization-code",
          state: "wrong-state",
        }),
      );
      await expect(pair.waitFor("oauth_wrong_state")).resolves.toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "invalid_payload" },
      });

      pair.send(
        request("oauth_complete", "provider.auth.complete", {
          attemptId: attempt.id,
          code: "authorization-code",
          state,
        }),
      );
      await expect(pair.waitFor("oauth_complete")).resolves.toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          attempt: {
            status: "completed",
            connection: { providerId: "openrouter", selected: true },
          },
        },
      });

      pair.send(
        request("oauth_replay", "provider.auth.complete", {
          attemptId: attempt.id,
          code: "authorization-code",
          state,
        }),
      );
      await expect(pair.waitFor("oauth_replay")).resolves.toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "invalid_payload" },
      });
      expect(JSON.stringify(pair.messages())).not.toContain(token);
      expect(await readFile(fixture.statePath, "utf8")).not.toContain(token);
    } finally {
      pair.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("denies OAuth attempts on a remote transport even with mutation authority", async () => {
    const fixture = await protocolFixture();
    const pair = connectionPair();
    try {
      serveConnection(pair.hostSide, {
        hostService: createHostService(),
        workspaceRoot: fixture.workspace,
        authContext: authenticatedConnection(
          "remote",
          "ws-bearer",
          "host_client",
          ["provider_connection.manage"],
          "remote",
        ),
      });
      await handshake(pair);
      pair.send(
        request("remote_oauth", "provider.auth.begin", {
          providerId: "openrouter",
          methodId: "oauth_pkce",
        }),
      );
      await expect(pair.waitFor("remote_oauth")).resolves.toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "unauthorized" },
      });
    } finally {
      pair.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("denies secret submission on a remote transport even with an injected authority", async () => {
    const fixture = await protocolFixture();
    const pair = connectionPair();
    try {
      const service = createHostService({
        providerAuth: new ProviderAuthManager({
          env: fixture.env,
          statePath: fixture.statePath,
          credentialStore: new MemoryProviderCredentialStore(),
        }),
      });
      serveConnection(pair.hostSide, {
        hostService: service,
        workspaceRoot: fixture.workspace,
        authContext: authenticatedConnection(
          "remote",
          "ws-bearer",
          "host_client",
          ["provider_secret.submit"],
          "remote",
        ),
      });
      await handshake(pair);
      pair.send(
        request("remote_submit", "provider.auth.submit_secret", {
          providerId: "openai",
          methodId: "api_key",
          secret: "sk-must-not-cross-remote-boundary",
        }),
      );
      await expect(pair.waitFor("remote_submit")).resolves.toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "unauthorized" },
      });
    } finally {
      pair.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("redacts credential-store errors that contain the submitted secret", async () => {
    const fixture = await protocolFixture();
    const pair = connectionPair();
    const secret = "sk-store-error-sentinel";
    const failingStore: ProviderCredentialStore = {
      async get() {
        return undefined;
      },
      async put(_connectionId, value) {
        throw new Error(`cannot store ${value}`);
      },
      async remove() {},
    };
    try {
      const service = createHostService({
        providerAuth: new ProviderAuthManager({
          env: fixture.env,
          statePath: fixture.statePath,
          credentialStore: failingStore,
        }),
      });
      serveConnection(pair.hostSide, {
        hostService: service,
        workspaceRoot: fixture.workspace,
        authContext: unauthenticatedConnection(
          "local-stdio",
          ["provider_secret.submit"],
          "local",
        ),
      });
      await handshake(pair);
      pair.send(
        request("failed_submit", "provider.auth.submit_secret", {
          providerId: "openai",
          methodId: "api_key",
          secret,
        }),
      );
      const failed = await pair.waitFor("failed_submit");
      expect(failed).toMatchObject({
        envelope: "response",
        ok: false,
        error: {
          code: "internal_error",
          message: "Provider secret submission failed.",
        },
      });
      expect(JSON.stringify(pair.messages())).not.toContain(secret);
    } finally {
      pair.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

function request(
  id: string,
  kind: Exclude<
    Extract<HostMessage, { envelope: "request" }>["kind"],
    "handshake"
  >,
  payload: Record<string, unknown>,
): HostMessage {
  return {
    envelope: "request",
    id,
    kind,
    timestamp: "2026-08-08T00:00:00.000Z",
    payload,
  } as HostMessage;
}

async function handshake(
  pair: ReturnType<typeof connectionPair>,
): Promise<void> {
  pair.send({
    envelope: "request",
    id: "handshake",
    kind: "handshake",
    timestamp: "2026-08-08T00:00:00.000Z",
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      client: { name: "provider-test", version: "0.1.0" },
    },
  });
  await pair.waitFor("handshake");
}

function connectionPair(): {
  hostSide: Connection;
  send(message: HostMessage): void;
  waitFor(id: string): Promise<HostMessage>;
  messages(): readonly HostMessage[];
  close(): void;
} {
  let onMessage: ((message: HostMessage) => void) | undefined;
  let onClose: ((reason?: string) => void) | undefined;
  const messages: HostMessage[] = [];
  const waiters = new Map<string, (message: HostMessage) => void>();
  const hostSide: Connection = {
    id: `provider_protocol_${Math.random().toString(36).slice(2)}`,
    send(message) {
      messages.push(message);
      if (message.envelope === "response") {
        waiters.get(message.id)?.(message);
        waiters.delete(message.id);
      }
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close(reason) {
      onClose?.(reason);
    },
  };
  return {
    hostSide,
    send(message) {
      onMessage?.(message);
    },
    waitFor(id) {
      const found = messages.find(
        (message) => message.envelope === "response" && message.id === id,
      );
      if (found) return Promise.resolve(found);
      return new Promise((resolveWait) => waiters.set(id, resolveWait));
    },
    messages() {
      return messages;
    },
    close() {
      onClose?.("test complete");
    },
  };
}

async function protocolFixture(): Promise<{
  root: string;
  workspace: string;
  statePath: string;
  env: Record<string, string | undefined>;
}> {
  const root = await mkdtemp(join(tmpdir(), "sparkwright-provider-protocol-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".sparkwright"), { recursive: true });
  const configHome = join(root, "config");
  await mkdir(join(configHome, "sparkwright"), { recursive: true });
  await writeFile(
    join(configHome, "sparkwright", "config.json"),
    JSON.stringify({
      identity: {
        model: "openai/gpt-test",
        providers: {
          openai: {
            apiKey: "sk-protocol-secret",
            models: { "gpt-test": {} },
          },
        },
      },
    }),
    "utf8",
  );
  return {
    root,
    workspace,
    statePath: join(root, "state", "provider-auth.json"),
    env: { XDG_CONFIG_HOME: configHome },
  };
}
