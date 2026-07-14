import { createServer } from "node:net";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { startWsServer } from "../src/transport-ws.js";
import type { HostConnectionAuthContext } from "../src/connection.js";

async function openPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate a TCP port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once("close", (code) => resolve(code));
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

describe("transport-ws", () => {
  it("requires the configured auth token before creating a connection", async () => {
    const port = await openPort();
    let accepted = 0;
    const contexts: HostConnectionAuthContext[] = [];
    const server = startWsServer({
      port,
      host: "127.0.0.1",
      authToken: "secret-token",
      onConnection: (_connection, authContext) => {
        accepted += 1;
        contexts.push(authContext);
      },
    });
    try {
      const unauthorized = new WebSocket(`ws://127.0.0.1:${port}`);
      expect(await waitForClose(unauthorized)).toBe(1008);
      expect(accepted).toBe(0);

      const authorized = new WebSocket(
        `ws://127.0.0.1:${port}?token=secret-token`,
      );
      await waitForOpen(authorized);
      expect(accepted).toBe(1);
      expect(contexts[0]).toEqual({
        state: "authenticated",
        principalId: "auth:ws-bearer:default",
        principalKind: "gateway",
        authenticatedBy: "ws-bearer",
      });
      expect(JSON.stringify(contexts[0])).not.toContain("secret-token");

      const reconnected = new WebSocket(
        `ws://127.0.0.1:${port}?token=secret-token`,
      );
      await waitForOpen(reconnected);
      expect(contexts[1]).toEqual(contexts[0]);
      reconnected.close();
      authorized.close();
    } finally {
      server.close();
    }
  });

  it("refuses to bind a non-loopback host without an auth token", async () => {
    expect(() =>
      startWsServer({
        port: 0,
        host: "0.0.0.0",
        onConnection: () => {},
      }),
    ).toThrow(/not loopback|authToken is required/);
  });

  it("allows non-loopback without a token when explicitly opted in", async () => {
    const port = await openPort();
    const server = startWsServer({
      port,
      host: "0.0.0.0",
      allowUnauthenticatedNonLoopback: true,
      onConnection: (_connection, authContext) => {
        expect(authContext).toEqual({
          state: "unauthenticated",
          authenticatedBy: "ws-no-auth",
        });
      },
    });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await waitForOpen(ws);
      ws.close();
    } finally {
      server.close();
    }
  });
});
