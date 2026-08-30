import { describe, expect, it, vi } from "vitest";
import type {
  ChatGptAppServerNotification,
  ChatGptAppServerSession,
} from "../src/chatgpt-app-server.js";
import {
  createBuiltInProviderOAuthDrivers,
  createPkceChallenge,
  createPkceVerifier,
} from "../src/provider-oauth.js";

describe("built-in provider OAuth drivers", () => {
  it("receives a loopback PKCE callback and exchanges the code without exposing the verifier", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ key: "issued-provider-key" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const driver = createBuiltInProviderOAuthDrivers({ fetch: request }).get(
      "openrouter.pkce-key.v1",
    )!;
    const verifier = createPkceVerifier();
    const state = "state-sentinel";
    const started = await driver.begin({
      attemptId: "oauth_test",
      state,
      codeChallenge: createPkceChallenge(verifier),
      expiresAt: "2026-08-09T00:10:00.000Z",
      promptValues: {},
    });
    const authorization = new URL(started.presentation.authorizationUrl!);
    const callbackUrl = authorization.searchParams.get("callback_url")!;
    expect(callbackUrl).toContain(`/oauth/callback/${state}`);
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );

    const callbackResponse = await fetch(
      `${callbackUrl}?code=authorization-code`,
    );
    expect(callbackResponse.status).toBe(200);
    const proof = await started.completion!;
    expect(proof).toEqual({ code: "authorization-code", state });

    const credential = await driver.complete({
      proof,
      codeVerifier: verifier,
      promptValues: {},
    });
    expect(credential).toEqual({
      accessToken: "issued-provider-key",
      tokenType: "api_key",
    });
    const body = JSON.parse(
      String((request.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    );
    expect(body).toMatchObject({
      code: "authorization-code",
      code_verifier: verifier,
      code_challenge_method: "S256",
    });
    expect(started.presentation.authorizationUrl).not.toContain(verifier);
  });

  it("delegates ChatGPT browser login and token storage to the bundled App Server", async () => {
    const notifications = new Set<
      (notification: ChatGptAppServerNotification) => void
    >();
    const close = vi.fn(async () => undefined);
    const request = vi.fn(async (method: string) => {
      if (method === "account/login/start") {
        return {
          type: "chatgpt",
          loginId: "login_1",
          authUrl: "https://auth.openai.com/authorize?attempt=1",
        };
      }
      if (method === "account/read") {
        return {
          account: { type: "chatgpt", email: "person@example.com" },
          requiresOpenaiAuth: true,
        };
      }
      return {};
    });
    const session: ChatGptAppServerSession = {
      request: request as ChatGptAppServerSession["request"],
      onNotification(listener) {
        notifications.add(listener);
        return () => notifications.delete(listener);
      },
      onRequest() {
        return () => undefined;
      },
      close,
    };
    const driver = createBuiltInProviderOAuthDrivers({
      chatGptAppServerFactory: async () => session,
    }).get("openai.app-server.chatgpt-browser.v1")!;

    const started = await driver.begin({
      attemptId: "oauth_chatgpt",
      state: "state_chatgpt",
      codeChallenge: "unused-by-managed-runtime",
      expiresAt: "2026-08-18T00:10:00.000Z",
      promptValues: {},
    });
    expect(started.presentation).toMatchObject({
      flow: "browser",
      authorizationUrl: "https://auth.openai.com/authorize?attempt=1",
    });
    for (const listener of notifications) {
      listener({
        method: "account/login/completed",
        params: { loginId: "login_1", success: true, error: null },
      });
    }
    const proof = await started.completion!;
    expect(proof).toEqual({
      code: "oauth_chatgpt",
      state: "state_chatgpt",
    });
    await expect(
      driver.complete({
        proof,
        codeVerifier: "unused-by-managed-runtime",
        promptValues: {},
      }),
    ).resolves.toEqual({
      accessToken: "managed-by-openai-app-server",
      tokenType: "managed",
      authRealm: "https://chatgpt.com",
      managedTransport: "chatgpt_app_server",
    });
    expect(request).toHaveBeenCalledWith("account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "chatgpt",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("presents and cancels the bundled ChatGPT device-code flow", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "account/login/start") {
        return {
          type: "chatgptDeviceCode",
          loginId: "login_device",
          verificationUrl: "https://auth.openai.com/device",
          userCode: "ABCD-EFGH",
        };
      }
      return {};
    });
    const close = vi.fn(async () => undefined);
    const session: ChatGptAppServerSession = {
      request: request as ChatGptAppServerSession["request"],
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      close,
    };
    const driver = createBuiltInProviderOAuthDrivers({
      chatGptAppServerFactory: async () => session,
    }).get("openai.app-server.chatgpt-device.v1")!;
    const started = await driver.begin({
      attemptId: "oauth_device",
      state: "state_device",
      codeChallenge: "unused",
      expiresAt: "2026-08-18T00:10:00.000Z",
      promptValues: {},
    });

    expect(started.presentation).toEqual({
      flow: "device",
      verificationUrl: "https://auth.openai.com/device",
      userCode: "ABCD-EFGH",
      instructions: "Open the verification page and enter the one-time code.",
    });
    await started.cancel?.();
    expect(request).toHaveBeenLastCalledWith("account/login/cancel", {
      loginId: "login_device",
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
