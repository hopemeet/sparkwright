import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ChatGptAppServerNotification,
  ChatGptAppServerSession,
} from "../src/chatgpt-app-server.js";
import { ProviderAuthManager } from "../src/provider-auth.js";
import { MemoryProviderCredentialStore } from "../src/provider-credential-store.js";

describe("ChatGPT managed provider connection", () => {
  it("persists only a managed marker and discovers account-visible models", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "sparkwright-chatgpt-auth-"),
    );
    const notificationListeners = new Set<
      (notification: ChatGptAppServerNotification) => void
    >();
    const factory = async (): Promise<ChatGptAppServerSession> => {
      const request = async (method: string): Promise<unknown> => {
        if (method === "account/login/start") {
          return {
            type: "chatgpt",
            loginId: "login_managed",
            authUrl: "https://auth.openai.com/authorize?managed=1",
          };
        }
        if (method === "account/read") {
          return {
            account: { type: "chatgpt", email: null, planType: "plus" },
            requiresOpenaiAuth: true,
          };
        }
        if (method === "model/list") {
          return {
            data: [
              {
                id: "gpt-account-visible",
                displayName: "Account Visible",
                description: "Visible to this account",
                inputModalities: ["text"],
                hidden: false,
              },
            ],
            nextCursor: null,
          };
        }
        return {};
      };
      return {
        request: request as ChatGptAppServerSession["request"],
        onNotification(listener) {
          notificationListeners.add(listener);
          return () => notificationListeners.delete(listener);
        },
        onRequest() {
          return () => undefined;
        },
        async close() {},
      };
    };
    const credentialStore = new MemoryProviderCredentialStore();
    const manager = new ProviderAuthManager({
      statePath: join(workspace, "provider-auth.json"),
      catalogPath: join(workspace, "provider-catalog.json"),
      credentialStore,
      chatGptAppServerFactory: factory,
    });
    const context = {
      workspaceRoot: workspace,
      principalId: "test-user",
      clientConnectionId: "test-client",
    };
    try {
      const started = await manager.beginOAuth({
        providerId: "chatgpt",
        methodId: "browser",
        context,
      });
      expect(started).toMatchObject({
        ok: true,
        attempt: {
          flow: "browser",
          authorizationUrl: "https://auth.openai.com/authorize?managed=1",
        },
      });
      if (!started.ok) return;
      for (const listener of notificationListeners) {
        listener({
          method: "account/login/completed",
          params: { loginId: "login_managed", success: true, error: null },
        });
      }
      const completed = await waitForCompleted(
        manager,
        started.attempt.id,
        context,
      );
      expect(completed).toMatchObject({
        status: "completed",
        connection: { providerId: "chatgpt", selected: true },
      });
      const stored = await credentialStore.get(completed.connection!.id);
      expect(stored).toContain('"managedTransport":"chatgpt_app_server"');
      expect(stored?.length).toBeLessThan(128);
      expect(stored).not.toContain("access_token");
      expect(stored).not.toContain("refresh_token");

      await expect(
        manager.refreshCatalog({
          providerId: "chatgpt",
          context: { workspaceRoot: workspace },
        }),
      ).resolves.toMatchObject({
        ok: true,
        result: { status: "updated", refreshedProviders: ["chatgpt"] },
      });
      const catalog = await manager.catalog({
        workspaceRoot: workspace,
        projection: "all",
      });
      expect(
        catalog.providers.find((provider) => provider.id === "chatgpt")?.models,
      ).toContainEqual(
        expect.objectContaining({
          ref: "chatgpt/gpt-account-visible",
          available: true,
        }),
      );
      await expect(
        manager.resolveModelConnection({
          workspaceRoot: workspace,
          modelRef: "chatgpt/gpt-account-visible",
        }),
      ).resolves.toMatchObject({
        ok: true,
        resolved: {
          lease: { credential: { kind: "chatgpt_app_server" } },
        },
      });

      const legacyVerboseMarker = `sparkwright.oauth.v1:${JSON.stringify({
        accessToken: "managed-by-openai-app-server",
        tokenType: "managed",
        authRealm: "https://chatgpt.com",
        managedTransport: "chatgpt_app_server",
      })}`;
      await credentialStore.put(
        completed.connection!.id,
        legacyVerboseMarker.slice(0, 128),
      );
      await expect(
        manager.resolveModelConnection({
          workspaceRoot: workspace,
          modelRef: "chatgpt/gpt-account-visible",
        }),
      ).resolves.toMatchObject({
        ok: true,
        resolved: {
          lease: { credential: { kind: "chatgpt_app_server" } },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

async function waitForCompleted(
  manager: ProviderAuthManager,
  attemptId: string,
  context: {
    workspaceRoot: string;
    principalId: string;
    clientConnectionId: string;
  },
) {
  for (let index = 0; index < 50; index += 1) {
    const status = await manager.oauthStatus({ attemptId, context });
    if (status.ok && status.attempt.status !== "pending") {
      return status.attempt;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("ChatGPT OAuth attempt did not complete.");
}
