import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { EnvHttpProxyAgent, request as undiciRequest } from "undici";

export const DEFAULT_WEB_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_WEB_FETCH_MAX_REDIRECTS = 5;
export const MAX_WEB_FETCH_URL_CHARS = 1_024;
export const WEB_FETCH_SECURITY_MODES = ["system", "hardened"] as const;
export type WebFetchSecurity = (typeof WEB_FETCH_SECURITY_MODES)[number];

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_QUERY_NAMES = new Set([
  "accesstoken",
  "apikey",
  "authtoken",
  "authorization",
  "clientsecret",
  "credential",
  "jwt",
  "key",
  "password",
  "passwd",
  "secret",
  "sig",
  "signature",
  "token",
  "xamzcredential",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
]);
const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data.ec2.internal",
]);

export interface ResolvedPublicAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeHttpResponse {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  body: Buffer;
  redirectCount: number;
}

export interface SafeHttpOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  security?: WebFetchSecurity;
  /** Test/config seam. Production callers inherit the process environment. */
  env?: Record<string, string | undefined>;
  /** Test seam. Production callers use the validating default resolver. */
  resolveAddresses?: (hostname: string) => Promise<ResolvedPublicAddress[]>;
  /** Test seam for the system-routed transport. */
  requestSystem?: SystemWebRequest;
}

export interface SingleResponse {
  status: number;
  contentType?: string;
  location?: string;
  body: Buffer;
}

export type SystemWebRequest = (
  url: URL,
  maxBytes: number,
  signal: AbortSignal,
) => Promise<SingleResponse>;

export interface SystemProxyOptions {
  /** @reserved Proxy option consumed structurally by undici's EnvHttpProxyAgent. */
  httpProxy: string;
  /** @reserved Proxy option consumed structurally by undici's EnvHttpProxyAgent. */
  httpsProxy: string;
  /** @reserved Proxy option consumed structurally by undici's EnvHttpProxyAgent. */
  noProxy: string;
}

export class WebFetchError extends Error {
  readonly code: string;
  readonly metadata?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    metadata?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebFetchError";
    this.code = code;
    this.metadata = metadata;
  }
}

export function normalizeWebFetchUrl(rawUrl: string): URL {
  const input = rawUrl.trim();
  if (!input || input.length > MAX_WEB_FETCH_URL_CHARS) {
    throw new WebFetchError(
      "WEB_FETCH_URL_INVALID",
      `url must contain between 1 and ${MAX_WEB_FETCH_URL_CHARS} characters.`,
    );
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new WebFetchError(
      "WEB_FETCH_URL_INVALID",
      "url must be a valid absolute HTTP or HTTPS URL.",
      undefined,
      { cause },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError(
      "WEB_FETCH_URL_INVALID",
      "url must use http or https.",
    );
  }
  if (!url.hostname) {
    throw new WebFetchError(
      "WEB_FETCH_URL_INVALID",
      "url must include a hostname.",
    );
  }
  if (url.username || url.password) {
    throw new WebFetchError(
      "WEB_FETCH_URL_CREDENTIALS_FORBIDDEN",
      "Public web URLs must not contain username or password credentials.",
    );
  }

  for (const name of url.searchParams.keys()) {
    if (isSensitiveQueryName(name)) {
      throw new WebFetchError(
        "WEB_FETCH_SENSITIVE_URL",
        `Public web URLs must not contain the sensitive query parameter "${name}".`,
        { parameter: name },
      );
    }
  }

  // Fragments are never sent over HTTP and must not split approval identity.
  url.hash = "";
  return url;
}

export function formatWebFetchUrlForDisplay(rawUrl: string): string {
  try {
    const url = new URL(rawUrl.trim());
    const queryNames = [...new Set(url.searchParams.keys())];
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    const base = url.toString();
    return queryNames.length > 0
      ? `${base}?${queryNames
          .map((name) => `${encodeURIComponent(name)}=…`)
          .join("&")}`
      : base;
  } catch {
    return rawUrl.trim();
  }
}

export async function fetchPublicWebUrl(
  rawUrl: string,
  options: SafeHttpOptions = {},
): Promise<SafeHttpResponse> {
  const security = options.security ?? "system";
  const requestedUrl = validateWebFetchUrlForSecurity(rawUrl, security);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEB_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_WEB_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_WEB_FETCH_MAX_REDIRECTS;
  const resolveAddresses = options.resolveAddresses ?? resolvePublicAddresses;
  const deadline = createDeadlineSignal(options.signal, timeoutMs);
  let systemTransport: ReturnType<typeof createSystemTransport> | undefined;
  let requestSystem = options.requestSystem;

  let currentUrl = requestedUrl;
  let redirectCount = 0;
  const visited = new Set<string>();

  try {
    if (security === "system" && requestSystem === undefined) {
      systemTransport = createSystemTransport(options.env ?? process.env);
      requestSystem = systemTransport.request.bind(systemTransport);
    }
    while (true) {
      if (visited.has(currentUrl.href)) {
        throw new WebFetchError(
          "WEB_FETCH_REDIRECT_LOOP",
          "The web request entered a redirect loop.",
          { redirectCount },
        );
      }
      visited.add(currentUrl.href);

      const response =
        security === "system"
          ? await requestSystemUrl(
              currentUrl,
              maxBytes,
              deadline.signal,
              requestSystem,
            )
          : await requestHardenedUrl(
              currentUrl,
              maxBytes,
              deadline.signal,
              resolveAddresses,
            );
      if (
        REDIRECT_STATUS_CODES.has(response.status) &&
        response.location !== undefined
      ) {
        if (redirectCount >= maxRedirects) {
          throw new WebFetchError(
            "WEB_FETCH_REDIRECT_LIMIT",
            `The web request exceeded ${maxRedirects} redirects.`,
            { maxRedirects },
          );
        }

        let nextUrl: URL;
        try {
          nextUrl = normalizeWebFetchUrl(
            new URL(response.location, currentUrl).toString(),
          );
        } catch (cause) {
          if (cause instanceof WebFetchError) throw cause;
          throw new WebFetchError(
            "WEB_FETCH_REDIRECT_INVALID",
            "The web server returned an invalid redirect URL.",
            undefined,
            { cause },
          );
        }
        if (currentUrl.protocol === "https:" && nextUrl.protocol === "http:") {
          throw new WebFetchError(
            "WEB_FETCH_REDIRECT_DOWNGRADE",
            "HTTPS to HTTP redirects are not allowed.",
          );
        }
        currentUrl = nextUrl;
        redirectCount += 1;
        continue;
      }

      return {
        requestedUrl: requestedUrl.href,
        finalUrl: currentUrl.href,
        status: response.status,
        contentType: response.contentType,
        body: response.body,
        redirectCount,
      };
    }
  } catch (cause) {
    if (options.signal?.aborted) throw createAbortError();
    if (deadline.timedOut()) {
      throw new WebFetchError(
        "WEB_FETCH_TIMEOUT",
        `The web request exceeded the ${timeoutMs}ms total deadline.`,
        { timeoutMs },
      );
    }
    if (cause instanceof WebFetchError) throw cause;
    if (isAbortError(cause)) throw cause;
    throw networkError(currentUrl.hostname, cause);
  } finally {
    deadline.dispose();
    try {
      await systemTransport?.close();
    } catch {
      // Transport cleanup must not replace the request result or primary error.
    }
  }
}

export function validateWebFetchUrlForSecurity(
  rawUrl: string,
  security: WebFetchSecurity,
): URL {
  const url = normalizeWebFetchUrl(rawUrl);
  if (security === "system") assertSystemDestination(url);
  return url;
}

export function resolveSystemProxyOptions(
  env: Record<string, string | undefined> = process.env,
): SystemProxyOptions {
  const override = nonEmptyEnv(env.SPARKWRIGHT_WEB_PROXY);
  const httpProxy =
    override ??
    nonEmptyEnv(env.http_proxy) ??
    nonEmptyEnv(env.HTTP_PROXY) ??
    "";
  const httpsProxy =
    override ??
    nonEmptyEnv(env.https_proxy) ??
    nonEmptyEnv(env.HTTPS_PROXY) ??
    "";
  validateProxyUrl(httpProxy, "HTTP_PROXY");
  validateProxyUrl(httpsProxy, "HTTPS_PROXY");
  return {
    httpProxy,
    httpsProxy,
    noProxy: nonEmptyEnv(env.no_proxy) ?? nonEmptyEnv(env.NO_PROXY) ?? "",
  };
}

function assertSystemDestination(url: URL): void {
  if (url.protocol !== "https:") {
    throw new WebFetchError(
      "WEB_FETCH_HTTPS_REQUIRED",
      "The default system web transport only permits HTTPS URLs. Use hardened mode only when plain HTTP is required.",
    );
  }

  const hostname = normalizeHostname(url.hostname);
  if (
    LOCAL_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new WebFetchError(
      "WEB_FETCH_HOST_BLOCKED",
      `The web hostname ${hostname} is local or reserved.`,
      { hostname },
    );
  }

  if (isIP(hostname) !== 0) assertGlobalUnicastAddress(hostname);
}

async function requestSystemUrl(
  url: URL,
  maxBytes: number,
  signal: AbortSignal,
  requestSystem: SystemWebRequest | undefined,
): Promise<SingleResponse> {
  assertSystemDestination(url);
  if (!requestSystem) {
    throw new WebFetchError(
      "WEB_FETCH_NETWORK_ERROR",
      "The system web transport is unavailable.",
      { hostname: url.hostname },
    );
  }
  return raceWithSignal(requestSystem(url, maxBytes, signal), signal);
}

async function requestHardenedUrl(
  url: URL,
  maxBytes: number,
  signal: AbortSignal,
  resolveAddresses: (hostname: string) => Promise<ResolvedPublicAddress[]>,
): Promise<SingleResponse> {
  const addresses = await raceWithSignal(
    resolveAddresses(normalizeHostname(url.hostname)),
    signal,
  );
  if (addresses.length === 0) {
    throw new WebFetchError(
      "WEB_FETCH_DNS_FAILED",
      `Hostname ${url.hostname} resolved to no addresses.`,
      { hostname: url.hostname },
    );
  }
  return requestOncePinned(url, addresses, maxBytes, signal);
}

export async function resolvePublicAddresses(
  hostname: string,
): Promise<ResolvedPublicAddress[]> {
  const normalized = normalizeHostname(hostname);
  const literalFamily = isIP(normalized);
  if (literalFamily === 4 || literalFamily === 6) {
    assertGlobalUnicastAddress(normalized);
    return [{ address: normalized, family: literalFamily }];
  }

  let results: Array<{ address: string; family: number }>;
  try {
    results = await dnsLookup(normalized, { all: true, verbatim: true });
  } catch (cause) {
    throw new WebFetchError(
      "WEB_FETCH_DNS_FAILED",
      `Hostname ${normalized} could not be resolved.`,
      {
        hostname: normalized,
        causeCode: errorCode(cause),
      },
      { cause },
    );
  }

  const unique = new Map<string, ResolvedPublicAddress>();
  for (const result of results) {
    const family = isIP(result.address);
    if (family !== 4 && family !== 6) {
      throw new WebFetchError(
        "WEB_FETCH_DNS_FAILED",
        `Hostname ${normalized} returned an invalid IP address.`,
        { hostname: normalized },
      );
    }
    assertGlobalUnicastAddress(result.address);
    unique.set(`${family}:${result.address}`, {
      address: result.address,
      family,
    });
  }
  return [...unique.values()];
}

export function classifyIpAddress(address: string): {
  allowed: boolean;
  range: string;
} {
  try {
    const parsed = ipaddr.parse(address);
    const range = parsed.range();
    return { allowed: range === "unicast", range };
  } catch {
    return { allowed: false, range: "invalid" };
  }
}

function assertGlobalUnicastAddress(address: string): void {
  const classification = classifyIpAddress(address);
  if (!classification.allowed) {
    throw new WebFetchError(
      "WEB_FETCH_ADDRESS_BLOCKED",
      `The web hostname resolves to a non-public address (${classification.range}).`,
      { address, range: classification.range },
    );
  }
}

function requestOncePinned(
  url: URL,
  addresses: readonly ResolvedPublicAddress[],
  maxBytes: number,
  signal: AbortSignal,
): Promise<SingleResponse> {
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  const lookup = createPinnedLookup(addresses);

  return new Promise<SingleResponse>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };

    const request = requestFn(
      url,
      {
        method: "GET",
        headers: {
          accept:
            "text/html, application/xhtml+xml, text/plain, application/json, application/xml, text/xml;q=0.9, text/*;q=0.8, */*;q=0.1",
          "accept-encoding": "identity",
          "user-agent": "SparkWright/0.1 web_fetch",
        },
        lookup,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        let head: ResponseHead;
        try {
          head = validateResponseHead(response.headers, maxBytes);
        } catch (cause) {
          settle(() => reject(cause));
          response.destroy(asError(cause));
          request.destroy(asError(cause));
          return;
        }

        if (REDIRECT_STATUS_CODES.has(status) && head.location !== undefined) {
          response.destroy();
          settle(() =>
            resolve({
              status,
              contentType: head.contentType,
              location: head.location,
              body: Buffer.alloc(0),
            }),
          );
          return;
        }

        void readBoundedBody(response, maxBytes).then(
          (body) => {
            settle(() =>
              resolve({ status, contentType: head.contentType, body }),
            );
          },
          (cause) => {
            settle(() => reject(cause));
            response.destroy(asError(cause));
            request.destroy(asError(cause));
          },
        );
      },
    );

    const onAbort = (): void => {
      request.destroy(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    request.on("error", (cause) => {
      settle(() =>
        reject(signal.aborted ? (signal.reason ?? createAbortError()) : cause),
      );
    });
    request.end();
  });
}

function createSystemTransport(env: Record<string, string | undefined>): {
  request: SystemWebRequest;
  close(): Promise<void>;
} {
  const dispatcher = new EnvHttpProxyAgent(resolveSystemProxyOptions(env));
  return {
    async request(url, maxBytes, signal) {
      const response = await undiciRequest(url, {
        dispatcher,
        method: "GET",
        headers: {
          accept:
            "text/html, application/xhtml+xml, text/plain, application/json, application/xml, text/xml;q=0.9, text/*;q=0.8, */*;q=0.1",
          "accept-encoding": "identity",
          "user-agent": "SparkWright/0.1 web_fetch",
        },
        signal,
      });
      const status = response.statusCode;
      let head: ResponseHead;
      try {
        head = validateResponseHead(response.headers, maxBytes);
      } catch (cause) {
        response.body.destroy(asError(cause));
        throw cause;
      }

      if (REDIRECT_STATUS_CODES.has(status) && head.location !== undefined) {
        response.body.destroy();
        return {
          status,
          contentType: head.contentType,
          location: head.location,
          body: Buffer.alloc(0),
        };
      }

      try {
        return {
          status,
          contentType: head.contentType,
          body: await readBoundedBody(response.body, maxBytes),
        };
      } catch (cause) {
        response.body.destroy(asError(cause));
        throw cause;
      }
    },
    async close() {
      await dispatcher.close();
    },
  };
}

interface ResponseHead {
  contentType?: string;
  location?: string;
}

function validateResponseHead(
  headers: IncomingHttpHeaders,
  maxBytes: number,
): ResponseHead {
  const contentEncoding = firstHeader(headers, "content-encoding");
  if (
    contentEncoding !== undefined &&
    contentEncoding.trim().toLowerCase() !== "identity"
  ) {
    throw new WebFetchError(
      "WEB_FETCH_UNSUPPORTED_ENCODING",
      `Unsupported response content encoding: ${contentEncoding}.`,
      { contentEncoding },
    );
  }
  const declaredLength = parseContentLength(
    firstHeader(headers, "content-length"),
  );
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    throw responseTooLarge(maxBytes, declaredLength);
  }
  return {
    contentType: firstHeader(headers, "content-type"),
    location: firstHeader(headers, "location"),
  };
}

async function readBoundedBody(
  body: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw responseTooLarge(maxBytes, bytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function createPinnedLookup(
  addresses: readonly ResolvedPublicAddress[],
): LookupFunction {
  return ((
    _hostname: string,
    options: { all?: boolean; family?: number } | number,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    const requestedFamily =
      typeof options === "number" ? options : (options.family ?? 0);
    const candidates = addresses.filter(
      (entry) => requestedFamily === 0 || entry.family === requestedFamily,
    );
    if (candidates.length === 0) {
      const error = Object.assign(
        new Error("No validated address matches the requested family."),
        { code: "EAI_ADDRFAMILY" },
      );
      callback(error, "");
      return;
    }
    if (typeof options !== "number" && options.all === true) {
      callback(
        null,
        candidates.map((entry) => ({
          address: entry.address,
          family: entry.family,
        })),
      );
      return;
    }
    callback(null, candidates[0]!.address, candidates[0]!.family);
  }) as unknown as LookupFunction;
}

function createDeadlineSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let didTimeOut = false;
  const onParentAbort = (): void => controller.abort(createAbortError());
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });

  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(
      new WebFetchError(
        "WEB_FETCH_TIMEOUT",
        `The web request exceeded the ${timeoutMs}ms total deadline.`,
        { timeoutMs },
      ),
    );
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function raceWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

function firstHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function responseTooLarge(
  maxBytes: number,
  receivedBytes: number,
): WebFetchError {
  return new WebFetchError(
    "WEB_FETCH_RESPONSE_TOO_LARGE",
    `The web response exceeded the ${maxBytes}-byte limit.`,
    { maxBytes, receivedBytes },
  );
}

function networkError(hostname: string, cause: unknown): WebFetchError {
  return new WebFetchError(
    "WEB_FETCH_NETWORK_ERROR",
    `The web request to ${hostname} failed.`,
    { hostname, causeCode: errorCode(cause) },
    { cause },
  );
}

function errorCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function validateProxyUrl(value: string, field: string): void {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return;
  } catch {
    // Report a stable field-level error without reflecting proxy credentials.
  }
  throw new WebFetchError(
    "WEB_FETCH_PROXY_INVALID",
    `${field} must be an absolute HTTP or HTTPS proxy URL.`,
    { field },
  );
}

function isSensitiveQueryName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_QUERY_NAMES.has(normalized);
}

function isAbortError(cause: unknown): cause is Error {
  return cause instanceof Error && cause.name === "AbortError";
}

function createAbortError(): Error {
  const error = new Error("The web request was aborted.");
  error.name = "AbortError";
  return error;
}
