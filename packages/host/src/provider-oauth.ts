import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const MAX_OAUTH_CODE_BYTES = 16 * 1024;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

export type ProviderOAuthFlow = "browser" | "device" | "code";

export interface ProviderOAuthProof {
  code: string;
  state?: string;
  nonce?: string;
}

export interface ProviderOAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  authRealm?: string;
  accountSlot?: string;
  tenant?: string;
}

export interface ProviderOAuthPresentation {
  flow: ProviderOAuthFlow;
  authorizationUrl?: string;
  verificationUrl?: string;
  userCode?: string;
  instructions?: string;
}

export interface ProviderOAuthBeginResult {
  presentation: ProviderOAuthPresentation;
  /** Host-owned proof delivery for loopback browser or device polling flows. */
  completion?: Promise<ProviderOAuthProof>;
  cancel?: () => Promise<void> | void;
}

export interface ProviderOAuthDriver {
  readonly implementationId: string;
  readonly issuer: string;
  begin(input: {
    attemptId: string;
    state: string;
    nonce?: string;
    codeChallenge: string;
    expiresAt: string;
    promptValues: Readonly<Record<string, string>>;
  }): Promise<ProviderOAuthBeginResult>;
  complete(input: {
    proof: ProviderOAuthProof;
    codeVerifier: string;
    promptValues: Readonly<Record<string, string>>;
  }): Promise<ProviderOAuthCredential>;
  refresh?(input: {
    credential: ProviderOAuthCredential;
  }): Promise<ProviderOAuthCredential>;
  revoke?(input: { credential: ProviderOAuthCredential }): Promise<void>;
}

export function createBuiltInProviderOAuthDrivers(
  options: {
    fetch?: typeof fetch;
  } = {},
): ReadonlyMap<string, ProviderOAuthDriver> {
  const driver = new OpenRouterPkceKeyDriver(options.fetch ?? fetch);
  return new Map([[driver.implementationId, driver]]);
}

export function createPkceVerifier(): string {
  return randomBytes(48).toString("base64url");
}

export function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function oauthOpaqueValue(): string {
  return randomBytes(32).toString("base64url");
}

export function sameOpaqueValue(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function validateOAuthProof(
  proof: ProviderOAuthProof,
): string | undefined {
  if (!proof.code) return "OAuth authorization code is required.";
  if (Buffer.byteLength(proof.code, "utf8") > MAX_OAUTH_CODE_BYTES) {
    return `OAuth authorization code exceeds the ${MAX_OAUTH_CODE_BYTES}-byte limit.`;
  }
  for (const value of [proof.code, proof.state, proof.nonce]) {
    if (value && hasControlCharacter(value)) {
      return "OAuth completion proof contains an invalid control character.";
    }
  }
  return undefined;
}

class OpenRouterPkceKeyDriver implements ProviderOAuthDriver {
  readonly implementationId = "openrouter.pkce-key.v1";
  readonly issuer = "https://openrouter.ai";

  constructor(private readonly request: typeof fetch) {}

  async begin(input: {
    state: string;
    codeChallenge: string;
  }): Promise<ProviderOAuthBeginResult> {
    const callback = await startLoopbackCallback(input.state);
    const authorization = new URL("https://openrouter.ai/auth");
    authorization.searchParams.set("callback_url", callback.callbackUrl);
    authorization.searchParams.set("code_challenge", input.codeChallenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    return {
      presentation: {
        flow: "browser",
        authorizationUrl: authorization.toString(),
        instructions:
          "Open the authorization URL in a browser. The local Host will finish the connection after approval.",
      },
      completion: callback.completion,
      cancel: callback.cancel,
    };
  }

  async complete(input: {
    proof: ProviderOAuthProof;
    codeVerifier: string;
  }): Promise<ProviderOAuthCredential> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      OAUTH_REQUEST_TIMEOUT_MS,
    );
    timer.unref?.();
    let response: Response;
    try {
      response = await this.request("https://openrouter.ai/api/v1/auth/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: input.proof.code,
          code_verifier: input.codeVerifier,
          code_challenge_method: "S256",
        }),
        signal: controller.signal,
      });
    } catch {
      throw new Error("OAuth credential exchange failed.");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok)
      throw new Error("OAuth credential exchange was rejected.");
    const payload = await response.json().catch(() => undefined);
    if (!isRecord(payload) || typeof payload.key !== "string" || !payload.key) {
      throw new Error(
        "OAuth credential exchange returned an invalid response.",
      );
    }
    return { accessToken: payload.key, tokenType: "api_key" };
  }

  async refresh(input: {
    credential: ProviderOAuthCredential;
  }): Promise<ProviderOAuthCredential> {
    // This flow issues a durable user-controlled key rather than a refresh
    // token. Refresh is therefore a generation-checked credential revalidation.
    return input.credential;
  }
}

async function startLoopbackCallback(expectedState: string): Promise<{
  callbackUrl: string;
  completion: Promise<ProviderOAuthProof>;
  cancel: () => Promise<void>;
}> {
  let settled = false;
  let resolveProof!: (proof: ProviderOAuthProof) => void;
  let rejectProof!: (error: Error) => void;
  const completion = new Promise<ProviderOAuthProof>((resolve, reject) => {
    resolveProof = resolve;
    rejectProof = reject;
  });
  const callbackPath = `/oauth/callback/${expectedState}`;
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== callbackPath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const code = requestUrl.searchParams.get("code") ?? "";
    const error = requestUrl.searchParams.get("error");
    if (error || validateOAuthProof({ code })) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        "Authorization failed. Return to SparkWright and try again.",
      );
      finishServer(server, () =>
        rejectProof(new Error("OAuth authorization was rejected.")),
      );
      return;
    }
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      "Connected. You can close this window and return to SparkWright.",
    );
    finishServer(server, () => resolveProof({ code, state: expectedState }));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  const callbackUrl = `http://127.0.0.1:${address.port}${callbackPath}`;
  return {
    callbackUrl,
    completion,
    cancel: async () => {
      if (settled) return;
      settled = true;
      await closeServer(server);
      rejectProof(new Error("OAuth authorization was cancelled."));
    },
  };

  function finishServer(target: Server, complete: () => void): void {
    if (settled) return;
    settled = true;
    complete();
    void closeServer(target);
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
