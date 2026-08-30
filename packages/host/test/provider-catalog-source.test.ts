import { describe, expect, it, vi } from "vitest";
import { createHttpSignedProviderCatalogSource } from "../src/provider-catalog-source.js";

describe("HTTP signed provider catalog source", () => {
  it("uses HTTPS, bounded responses, redirect denial, and ETag revalidation", async () => {
    const fetchStub = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"v1"');
      return new Response(
        JSON.stringify({
          artifactVersion: 2,
          keyId: "release-key",
          payload: "payload",
          signature: "signature",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: '"v2"',
          },
        },
      );
    });
    const source = createHttpSignedProviderCatalogSource({
      url: "https://catalog.example.test/provider-catalog.json",
      fetch: fetchStub,
      timeoutMs: 1_000,
      maxResponseBytes: 4_096,
    });

    await expect(source({ etag: '"v1"' })).resolves.toEqual({
      status: "modified",
      etag: '"v2"',
      artifact: {
        artifactVersion: 2,
        keyId: "release-key",
        payload: "payload",
        signature: "signature",
      },
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("accepts 304 only when a cached ETag was sent", async () => {
    const source = createHttpSignedProviderCatalogSource({
      url: "https://catalog.example.test/provider-catalog.json",
      fetch: async () => new Response(null, { status: 304 }),
    });
    await expect(source({ etag: '"v1"' })).resolves.toEqual({
      status: "not_modified",
    });
    await expect(source()).rejects.toThrow("without a cached ETag");
  });

  it("rejects insecure URLs, redirects, invalid media, and oversized responses", async () => {
    expect(() =>
      createHttpSignedProviderCatalogSource({
        url: "http://catalog.example.test/provider-catalog.json",
      }),
    ).toThrow("HTTPS");
    const invalidMedia = createHttpSignedProviderCatalogSource({
      url: "https://catalog.example.test/provider-catalog.json",
      fetch: async () =>
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    await expect(invalidMedia()).rejects.toThrow("not JSON");
    const oversized = createHttpSignedProviderCatalogSource({
      url: "https://catalog.example.test/provider-catalog.json",
      maxResponseBytes: 8,
      fetch: async () =>
        new Response("123456789", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(oversized()).rejects.toThrow("too large");
  });
});
