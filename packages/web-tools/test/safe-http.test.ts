import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyIpAddress,
  fetchPublicWebUrl,
  normalizeWebFetchUrl,
  resolvePublicAddresses,
  resolveSystemProxyOptions,
  type ResolvedPublicAddress,
} from "../src/safe-http.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }),
  );
});

describe("public web HTTP safety", () => {
  it("uses the system HTTPS route without pre-resolving domain names", async () => {
    let requested = "";
    const result = await fetchPublicWebUrl(
      "https://top.baidu.com/board?tab=realtime",
      {
        resolveAddresses: async () => {
          throw new Error("system mode must not pre-resolve DNS");
        },
        requestSystem: async (url) => {
          requested = url.href;
          return {
            status: 200,
            contentType: "text/plain",
            body: Buffer.from("reachable through the system route"),
          };
        },
      },
    );

    expect(requested).toBe("https://top.baidu.com/board?tab=realtime");
    expect(result.body.toString()).toBe("reachable through the system route");
  });

  it("requires HTTPS in system mode", async () => {
    await expect(
      fetchPublicWebUrl("http://example.com/", {
        requestSystem: async () => {
          throw new Error("request must not start");
        },
      }),
    ).rejects.toMatchObject({ code: "WEB_FETCH_HTTPS_REQUIRED" });
  });

  it("keeps Fake-IP addresses blocked in hardened mode", async () => {
    await expect(resolvePublicAddresses("198.18.14.133")).rejects.toMatchObject(
      { code: "WEB_FETCH_ADDRESS_BLOCKED" },
    );
  });

  it.each([
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://localhost/",
    "https://service.local/",
    "https://metadata.google.internal/",
  ])("blocks an explicit local system destination %s", async (url) => {
    await expect(
      fetchPublicWebUrl(url, {
        requestSystem: async () => {
          throw new Error("request must not start");
        },
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/WEB_FETCH_(ADDRESS_BLOCKED|HOST_BLOCKED)/),
    });
  });

  it("revalidates redirects in system mode", async () => {
    await expect(
      fetchPublicWebUrl("https://example.com/start", {
        requestSystem: async () => ({
          status: 302,
          location: "https://127.0.0.1/private",
          body: Buffer.alloc(0),
        }),
      }),
    ).rejects.toMatchObject({ code: "WEB_FETCH_ADDRESS_BLOCKED" });
  });

  it("resolves standard proxy variables with an optional explicit override", () => {
    expect(
      resolveSystemProxyOptions({
        http_proxy: "http://lower-http:8080",
        HTTP_PROXY: "http://upper-http:8080",
        HTTPS_PROXY: "http://secure:8443",
        NO_PROXY: "localhost,.example.test",
      }),
    ).toEqual({
      httpProxy: "http://lower-http:8080",
      httpsProxy: "http://secure:8443",
      noProxy: "localhost,.example.test",
    });
    expect(
      resolveSystemProxyOptions({
        SPARKWRIGHT_WEB_PROXY: "http://explicit:7890",
        HTTPS_PROXY: "http://ignored:8443",
      }),
    ).toEqual({
      httpProxy: "http://explicit:7890",
      httpsProxy: "http://explicit:7890",
      noProxy: "",
    });
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["10.0.0.1", "private"],
    ["100.64.0.1", "carrierGradeNat"],
    ["169.254.169.254", "linkLocal"],
    ["192.0.2.1", "reserved"],
    ["198.18.14.133", "reserved"],
    ["::1", "loopback"],
    ["fc00::1", "uniqueLocal"],
    ["fe80::1", "linkLocal"],
    ["::ffff:7f00:1", "ipv4Mapped"],
    ["64:ff9b::7f00:1", "rfc6052"],
  ])("blocks non-public address %s", (address, range) => {
    expect(classifyIpAddress(address)).toEqual({ allowed: false, range });
  });

  it.each(["93.184.216.34", "2606:4700:4700::1111"])(
    "allows global-unicast address %s",
    (address) => {
      expect(classifyIpAddress(address)).toEqual({
        allowed: true,
        range: "unicast",
      });
    },
  );

  it("normalizes fragments and rejects credentials and secret query fields", () => {
    expect(normalizeWebFetchUrl("https://EXAMPLE.com:443/a#section").href).toBe(
      "https://example.com/a",
    );
    expect(() =>
      normalizeWebFetchUrl("https://user:pass@example.com/a"),
    ).toThrow(/must not contain username or password/i);
    expect(() =>
      normalizeWebFetchUrl("https://example.com/a?api_key=secret"),
    ).toThrow(/sensitive query parameter/i);
  });

  it("follows validated redirects while pinning the approved hostname", async () => {
    const { origin } = await startServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/page" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("public page");
    });

    const result = await fetchPublicWebUrl(`${origin}/start`, {
      security: "hardened",
      timeoutMs: 1_000,
      resolveAddresses: localTestResolver,
    });

    expect(result).toMatchObject({
      requestedUrl: `${origin}/start`,
      finalUrl: `${origin}/page`,
      status: 200,
      contentType: "text/plain; charset=utf-8",
      redirectCount: 1,
    });
    expect(result.body.toString("utf8")).toBe("public page");
  });

  it("revalidates a redirect destination and blocks loopback literals", async () => {
    const { origin, port } = await startServer((_request, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${port}/private`,
      });
      response.end();
    });

    await expect(
      fetchPublicWebUrl(`${origin}/start`, {
        security: "hardened",
        timeoutMs: 1_000,
        resolveAddresses: localTestResolver,
      }),
    ).rejects.toMatchObject({ code: "WEB_FETCH_ADDRESS_BLOCKED" });
  });

  it("enforces the response byte cap", async () => {
    const { origin } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("0123456789");
    });

    await expect(
      fetchPublicWebUrl(origin, {
        security: "hardened",
        maxBytes: 5,
        timeoutMs: 1_000,
        resolveAddresses: localTestResolver,
      }),
    ).rejects.toMatchObject({ code: "WEB_FETCH_RESPONSE_TOO_LARGE" });
  });

  it("rejects compressed responses in the minimal transport", async () => {
    const { origin } = await startServer((_request, response) => {
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-type": "text/plain",
      });
      response.end("not actually compressed");
    });

    await expect(
      fetchPublicWebUrl(origin, {
        security: "hardened",
        timeoutMs: 1_000,
        resolveAddresses: localTestResolver,
      }),
    ).rejects.toMatchObject({ code: "WEB_FETCH_UNSUPPORTED_ENCODING" });
  });

  it("uses one total deadline and tears down a stalled response", async () => {
    const { origin } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
    });

    await expect(
      fetchPublicWebUrl(origin, {
        security: "hardened",
        timeoutMs: 25,
        resolveAddresses: localTestResolver,
      }),
    ).rejects.toMatchObject({ code: "WEB_FETCH_TIMEOUT" });
  });

  it("counts DNS resolution time against the same total deadline", async () => {
    await expect(
      fetchPublicWebUrl("https://example.test/", {
        security: "hardened",
        timeoutMs: 25,
        resolveAddresses: () => new Promise(() => undefined),
      }),
    ).rejects.toMatchObject({ code: "WEB_FETCH_TIMEOUT" });
  });
});

async function localTestResolver(
  hostname: string,
): Promise<ResolvedPublicAddress[]> {
  if (hostname === "example.test") {
    return [{ address: "127.0.0.1", family: 4 }];
  }
  return resolvePublicAddresses(hostname);
}

async function startServer(
  handler: RequestListener,
): Promise<{ origin: string; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address.");
  }
  return { origin: `http://example.test:${address.port}`, port: address.port };
}
