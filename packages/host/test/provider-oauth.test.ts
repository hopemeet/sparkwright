import { describe, expect, it, vi } from "vitest";
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
});
