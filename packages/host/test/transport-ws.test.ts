import { createServer } from "node:net";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { startWsServer } from "../src/transport-ws.js";

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
    const server = startWsServer({
      port,
      host: "127.0.0.1",
      authToken: "secret-token",
      onConnection: () => {
        accepted += 1;
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
      onConnection: () => {},
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
