import type { SignedProviderCatalogArtifact } from "./provider-catalog-store.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

export interface SignedProviderCatalogSourceRequest {
  etag?: string;
}

export type SignedProviderCatalogSourceResult =
  | {
      status: "modified";
      artifact: SignedProviderCatalogArtifact;
      etag?: string;
    }
  | {
      status: "not_modified";
      etag?: string;
    };

export type SignedProviderCatalogSource = (
  request?: SignedProviderCatalogSourceRequest,
) => Promise<SignedProviderCatalogSourceResult>;

export type SignedProviderCatalogSourceLike =
  | SignedProviderCatalogSource
  | (() => Promise<SignedProviderCatalogArtifact>);

export function createHttpSignedProviderCatalogSource(input: {
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): SignedProviderCatalogSource {
  const url = new URL(input.url);
  if (url.protocol !== "https:") {
    throw new Error("Signed provider catalog URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Signed provider catalog URL cannot contain credentials.");
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Signed provider catalog timeout is invalid.");
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES
  ) {
    throw new Error("Signed provider catalog response limit is invalid.");
  }
  const catalogFetch = input.fetch ?? fetch;

  return async (request = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await catalogFetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(request.etag
            ? { "if-none-match": boundedEtag(request.etag) }
            : {}),
        },
        redirect: "error",
        signal: controller.signal,
      });
      const etag = response.headers.get("etag");
      const boundedResponseEtag = etag ? boundedEtag(etag) : undefined;
      if (response.status === 304) {
        if (!request.etag) {
          throw new Error(
            "Signed provider catalog returned 304 without a cached ETag.",
          );
        }
        return {
          status: "not_modified" as const,
          ...(boundedResponseEtag ? { etag: boundedResponseEtag } : {}),
        };
      }
      if (!response.ok) {
        throw new Error(
          `Signed provider catalog returned HTTP ${response.status}.`,
        );
      }
      const contentType = response.headers.get("content-type");
      if (
        contentType &&
        !contentType.toLowerCase().includes("json") &&
        !contentType.toLowerCase().includes("octet-stream")
      ) {
        throw new Error("Signed provider catalog response is not JSON.");
      }
      const text = await readBoundedResponseText(response, maxResponseBytes);
      let artifact: unknown;
      try {
        artifact = JSON.parse(text);
      } catch {
        throw new Error("Signed provider catalog response is not valid JSON.");
      }
      if (!isSignedArtifact(artifact)) {
        throw new Error("Signed provider catalog response is invalid.");
      }
      return {
        status: "modified" as const,
        artifact,
        ...(boundedResponseEtag ? { etag: boundedResponseEtag } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function normalizeSignedProviderCatalogSourceResult(
  value: SignedProviderCatalogArtifact | SignedProviderCatalogSourceResult,
): SignedProviderCatalogSourceResult {
  return isSignedArtifact(value)
    ? { status: "modified", artifact: value }
    : value;
}

export async function readSignedProviderCatalogSource(
  source: SignedProviderCatalogSourceLike,
  request: SignedProviderCatalogSourceRequest,
): Promise<SignedProviderCatalogSourceResult> {
  const value = await (
    source as (
      request?: SignedProviderCatalogSourceRequest,
    ) => Promise<
      SignedProviderCatalogArtifact | SignedProviderCatalogSourceResult
    >
  )(request);
  return normalizeSignedProviderCatalogSourceResult(value);
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maxBytes
  ) {
    throw new Error("Signed provider catalog response is too large.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error("Signed provider catalog response is empty or too large.");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function boundedEtag(value: string): string {
  if (value.length === 0 || value.length > 512 || hasControlCharacter(value)) {
    throw new Error("Signed provider catalog ETag is invalid.");
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

function isSignedArtifact(
  value: unknown,
): value is SignedProviderCatalogArtifact {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 4 &&
    keys.every((key) =>
      ["artifactVersion", "keyId", "payload", "signature"].includes(key),
    ) &&
    (value.artifactVersion === 1 || value.artifactVersion === 2) &&
    typeof value.keyId === "string" &&
    typeof value.payload === "string" &&
    typeof value.signature === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
